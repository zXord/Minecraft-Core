// Download manager service
const fs = require('fs');
const path = require('path');
const progress = require('progress-stream');
const { safeSend } = require('../utils/safe-send.cjs');

// Dynamic import for fetch
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

/**
 * Download a file with progress reporting
 * 
 * @param {string} url - URL of the file to download
 * @param {string} destPath - Destination path where the file will be saved
 * @param {string} channel - IPC channel to report download progress on
 * @returns {Promise<void>} - Promise that resolves when download is complete
 */
async function downloadWithProgress(url, destPath, channel) {
  
  try {
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Failed to download: ${res.status} ${res.statusText}`);
    }
    
    const total = parseInt(res.headers.get('content-length'), 10) || 0;
    
    const prog = progress({ length: total, time: 100 });
  
    prog.on('progress', p => {
      // Ensure percentage is always between 0-100 and rounded to nearest integer
      const percent = Math.min(100, Math.max(0, Math.round(p.percentage || 0)));
      
      // Calculate speed in MB/s with better formatting
      const mbps = p.speed > 0 ? 
        (p.speed / 1024 / 1024).toFixed(2) + ' MB/s' : 
        '0.00 MB/s';
      
      // Send progress update to the renderer process
      safeSend(channel, {
        percent,
        speed: mbps
      });

      // Also send to the generic minecraft-server-progress and fabric-install-progress channels
      // to ensure the setup wizard receives updates
      if (channel === 'minecraft-server-progress' || channel === 'repair-progress') {
        safeSend('minecraft-server-progress', {
          percent,
          speed: mbps
        });
      }
      
      if (channel === 'fabric-install-progress' || channel === 'repair-progress') {
        safeSend('fabric-install-progress', {
          percent,
          speed: mbps
        });
      }

      // For very small files, ensure we show at least some progress
      if (total < 1000000 && percent === 0) {
        setTimeout(() => {
          safeSend(channel, {
            percent: 50,
            speed: mbps
          });
          
          // Also send to setup wizard channels
          if (channel === 'minecraft-server-progress' || channel === 'repair-progress') {
            safeSend('minecraft-server-progress', {
              percent: 50,
              speed: mbps
            });
          }
          
          if (channel === 'fabric-install-progress' || channel === 'repair-progress') {
            safeSend('fabric-install-progress', {
              percent: 50,
              speed: mbps
            });
          }
        }, 200);
      }
    });
  
    await new Promise((resolve, reject) => {
      const destDir = path.dirname(destPath);
      
      // Ensure destination directory exists
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      
      const fileStream = fs.createWriteStream(destPath);
      
      fileStream.on('error', err => {
        reject(new Error(`File write error: ${err.message}`));
      });
      
      res.body
        .pipe(prog)
        .pipe(fileStream)
        .on('finish', () => {
          
          // Send 100% progress on completion
          safeSend(channel, { percent: 100, speed: '0.00 MB/s' });
          
          // Also send to generic channels for the setup wizard
          if (channel === 'minecraft-server-progress' || channel === 'repair-progress') {
            safeSend('minecraft-server-progress', { percent: 100, speed: '0.00 MB/s' });
          }
          
          if (channel === 'fabric-install-progress' || channel === 'repair-progress') {
            safeSend('fabric-install-progress', { percent: 100, speed: '0.00 MB/s' });
          }
          
          resolve();
        })
        .on('error', err => {
          reject(new Error(`Download stream error: ${err.message}`));
        });
    });
  } catch (err) {
    throw new Error(`Download failed: ${err.message}`);
  }
}

/**
 * Install Fabric server using the installer
 * 
 * @param {string} targetPath - Directory to install Fabric to
 * @param {string} mcVersion - Minecraft version
 * @param {string} fabricLoader - Fabric loader version
 * @param {string} logChannel - IPC channel for log messages
 * @param {string} progressChannel - IPC channel for progress reports
 * @returns {Promise<void>} - Promise that resolves when installation is complete
 */
async function installFabric(targetPath, mcVersion, fabricLoader, logChannel = 'install-log', progressChannel = 'fabric-install-progress') {
  const { spawn, exec } = require('child_process');
  const installerUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/0.11.2/fabric-installer-0.11.2.jar';
  const installerJar = path.join(targetPath, 'fabric-installer.jar');

  // Check if Java is installed
  try {
    safeSend(logChannel, '🔍 Checking Java installation...');
    
    await new Promise((resolve, reject) => {
      exec('java -version', (error, stdout, stderr) => {
        if (error) {
          safeSend(logChannel, '❌ Java not found. Please install Java to use Fabric.');
          reject(new Error('Java is not installed or not in PATH. Please install Java to use Fabric.'));
          return;
        }
        
        // Java outputs version to stderr by default
        const output = stderr || stdout;
        safeSend(logChannel, '✓ Java found: ' + output.split('\n')[0]);
        resolve();
      });
    });
  } catch (javaError) {
    throw javaError;
  }

  safeSend(logChannel, '📥 Downloading Fabric installer...');
  await downloadWithProgress(installerUrl, installerJar, progressChannel);
  safeSend(logChannel, '✔ Fabric installer downloaded');

  await new Promise((resolve, reject) => {
    safeSend(logChannel, '🔧 Installing Fabric...');
    
    // Send progress update for starting installation
    safeSend(progressChannel, { percent: 50, speed: 'Installing...' });
    
    const proc = spawn('java', [
      '-jar', installerJar,
      'server',
      '-mcversion', mcVersion,
      '-loader', fabricLoader,
      '-dir', targetPath
    ], { cwd: targetPath });

    proc.stdout.on('data', data => {
      const message = data.toString();
      safeSend(logChannel, message);
    });
    
    proc.stderr.on('data', data => {
      const message = data.toString();
      safeSend(logChannel, `[ERROR] ${message}`);
    });
    
    proc.on('close', code => {
      if (code === 0) {
        safeSend(logChannel, '✔ Fabric install completed');
        
        // Send 100% progress on completion
        safeSend(progressChannel, { percent: 100, speed: 'Completed' });
        
        resolve();
      } else {
        reject(new Error(`Fabric installer exited with code ${code}`));
      }
    });
  });
}

/**
 * Download Minecraft server jar
 * 
 * @param {string} mcVersion - Minecraft version
 * @param {string} targetPath - Directory to save the server jar
 * @param {string} progressChannel - IPC channel for progress reports
 * @returns {Promise<boolean>} - Promise that resolves when download is complete
 */
async function downloadMinecraftServer(mcVersion, targetPath, progressChannel = 'minecraft-server-progress') {
  try {
    // Send initial progress update
    safeSend(progressChannel, { percent: 0, speed: 'Starting...' });
    safeSend('install-log', `Downloading Minecraft server version ${mcVersion}...`);
    
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
    const manifestResponse = await fetch(manifestUrl);
    
    if (!manifestResponse.ok) {
      throw new Error(`Failed to fetch manifest: ${manifestResponse.status} ${manifestResponse.statusText}`);
    }
    
    // Update progress - manifest fetched
    safeSend(progressChannel, { percent: 5, speed: 'Fetching version info...' });
    safeSend('install-log', 'Fetching version manifest...');
    
    const manifest = await manifestResponse.json();
    const versionMeta = manifest.versions.find(v => v.id === mcVersion);
    
    if (!versionMeta) {
      throw new Error(`Version ${mcVersion} not found in Minecraft version manifest`);
    }

    // Update progress - version found
    safeSend(progressChannel, { percent: 10, speed: 'Version found, getting details...' });
    safeSend('install-log', `Found version ${mcVersion} in manifest`);
    
    const detailResponse = await fetch(versionMeta.url);
    
    if (!detailResponse.ok) {
      throw new Error(`Failed to fetch version details: ${detailResponse.status} ${detailResponse.statusText}`);
    }
    
    // Update progress - details fetched
    safeSend(progressChannel, { percent: 15, speed: 'Starting download...' });
    safeSend('install-log', 'Preparing to download server jar...');
    
    const detail = await detailResponse.json();
    
    if (!detail.downloads || !detail.downloads.server || !detail.downloads.server.url) {
      throw new Error(`Server download URL not found for Minecraft version ${mcVersion}`);
    }
    
    const serverUrl = detail.downloads.server.url;
    const dest = path.join(targetPath, 'server.jar');

    safeSend('install-log', `Downloading server.jar from: ${serverUrl}`);
    await downloadWithProgress(serverUrl, dest, progressChannel);
    safeSend('install-log', 'Minecraft server.jar downloaded successfully');
    return true;
  } catch (err) {
    safeSend('install-log', `Error downloading server: ${err.message}`);
    return false;
  }
}

module.exports = {
  downloadWithProgress,
  installFabric,
  downloadMinecraftServer
};
