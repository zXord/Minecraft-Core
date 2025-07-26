// Download manager service
const fs = require('fs');
const path = require('path');
const progress = require('progress-stream');
const { safeSend } = require('../utils/safe-send.cjs');
const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');

// Initialize logger
const logger = getLoggerHandlers();

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn.apply(null, args));

// Performance tracking
let performanceMetrics = {
  downloadsStarted: 0,
  downloadsCompleted: 0,
  downloadsFailed: 0,
  totalBytesDownloaded: 0,
  averageDownloadSpeed: 0,
  fabricInstalls: 0,
  minecraftServerDownloads: 0
};

// Log service initialization
logger.info('Download manager service initialized', {
  category: 'network',
  data: {
    service: 'DownloadManager',
    progressStreamAvailable: !!progress,
    fetchAvailable: true
  }
});

/**
 * Download a file with progress reporting
 * 
 * @param {string} url - URL of the file to download
 * @param {string} destPath - Destination path where the file will be saved
 * @param {string} channel - IPC channel to report download progress on
 * @returns {Promise<void>} - Promise that resolves when download is complete
 */
async function downloadWithProgress(url, destPath, channel) {
  const downloadStartTime = Date.now();
  performanceMetrics.downloadsStarted++;
  
  logger.info('Starting file download', {
    category: 'network',
    data: {
      service: 'DownloadManager',
      operation: 'downloadWithProgress',
      url,
      destPath,
      channel,
      totalDownloadsStarted: performanceMetrics.downloadsStarted
    }
  });
  
  try {
    const res = await fetch(url);
    
    if (!res.ok) {
      performanceMetrics.downloadsFailed++;
      logger.error(`Download request failed: ${res.status} ${res.statusText}`, {
        category: 'network',
        data: {
          service: 'DownloadManager',
          operation: 'downloadWithProgress',
          url,
          statusCode: res.status,
          statusText: res.statusText,
          totalDownloadsFailed: performanceMetrics.downloadsFailed
        }
      });
      throw new Error(`Failed to download: ${res.status} ${res.statusText}`);
    }
    
    const total = parseInt(res.headers.get('content-length'), 10) || 0;
    
    logger.debug('Download response received', {
      category: 'network',
      data: {
        service: 'DownloadManager',
        operation: 'downloadWithProgress',
        url,
        statusCode: res.status,
        contentLength: total,
        contentType: res.headers.get('content-type'),
        hasContentLength: total > 0
      }
    });
    
    const prog = progress({ length: total, time: 100 });
    let lastProgressLog = 0;
    let bytesDownloaded = 0;
  
    prog.on('progress', p => {
      // Ensure percentage is always between 0-100 and rounded to nearest integer
      const percent = Math.min(100, Math.max(0, Math.round(p.percentage || 0)));
      
      // Calculate speed in MB/s with better formatting
      const mbps = p.speed > 0 ? 
        (p.speed / 1024 / 1024).toFixed(2) + ' MB/s' : 
        '0.00 MB/s';
      
      bytesDownloaded = p.transferred || 0;
      
      // Log progress every 25% to avoid spam
      if (percent >= lastProgressLog + 25) {
        logger.debug('Download progress update', {
          category: 'network',
          data: {
            service: 'DownloadManager',
            operation: 'downloadWithProgress',
            url,
            percent,
            bytesDownloaded,
            totalBytes: total,
            speed: p.speed,
            speedFormatted: mbps,
            channel
          }
        });
        lastProgressLog = percent;
      }
      
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
        logger.debug('Creating destination directory', {
          category: 'storage',
          data: {
            service: 'DownloadManager',
            operation: 'downloadWithProgress',
            destDir,
            url
          }
        });
        fs.mkdirSync(destDir, { recursive: true });
      }
      
      const fileStream = fs.createWriteStream(destPath);
      
      fileStream.on('error', err => {
        performanceMetrics.downloadsFailed++;
        logger.error(`File write error during download: ${err.message}`, {
          category: 'storage',
          data: {
            service: 'DownloadManager',
            operation: 'downloadWithProgress',
            destPath,
            url,
            errorType: err.constructor.name,
            totalDownloadsFailed: performanceMetrics.downloadsFailed
          }
        });
        reject(new Error(`File write error: ${err.message}`));
      });
      
      res.body
        .pipe(prog)
        .pipe(fileStream)
        .on('finish', () => {
          const downloadDuration = Date.now() - downloadStartTime;
          performanceMetrics.downloadsCompleted++;
          performanceMetrics.totalBytesDownloaded += bytesDownloaded;
          
          // Calculate average download speed
          if (downloadDuration > 0) {
            const speedBytesPerMs = bytesDownloaded / downloadDuration;
            performanceMetrics.averageDownloadSpeed = 
              (performanceMetrics.averageDownloadSpeed + speedBytesPerMs) / 2;
          }
          
          // Validate downloaded file
          let fileSize = 0;
          try {
            const stats = fs.statSync(destPath);
            fileSize = stats.size;
          } catch (error) {
            logger.warn('Could not validate downloaded file size', {
              category: 'storage',
              data: {
                service: 'DownloadManager',
                operation: 'downloadWithProgress',
                destPath,
                url,
                error: error.message
              }
            });
          }
          
          logger.info('Download completed successfully', {
            category: 'network',
            data: {
              service: 'DownloadManager',
              operation: 'downloadWithProgress',
              duration: downloadDuration,
              url,
              destPath,
              bytesDownloaded,
              fileSize,
              channel,
              totalDownloadsCompleted: performanceMetrics.downloadsCompleted,
              totalBytesDownloaded: performanceMetrics.totalBytesDownloaded
            }
          });
          
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
          const downloadDuration = Date.now() - downloadStartTime;
          performanceMetrics.downloadsFailed++;
          
          logger.error(`Download stream error: ${err.message}`, {
            category: 'network',
            data: {
              service: 'DownloadManager',
              operation: 'downloadWithProgress',
              duration: downloadDuration,
              url,
              destPath,
              errorType: err.constructor.name,
              bytesDownloaded,
              totalDownloadsFailed: performanceMetrics.downloadsFailed
            }
          });
          
          reject(new Error(`Download stream error: ${err.message}`));
        });
    });
  } catch (err) {
    const downloadDuration = Date.now() - downloadStartTime;
    performanceMetrics.downloadsFailed++;
    
    logger.error(`Download failed: ${err.message}`, {
      category: 'network',
      data: {
        service: 'DownloadManager',
        operation: 'downloadWithProgress',
        duration: downloadDuration,
        url,
        destPath,
        errorType: err.constructor.name,
        totalDownloadsFailed: performanceMetrics.downloadsFailed
      }
    });
    
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
  const installStartTime = Date.now();
  performanceMetrics.fabricInstalls++;
  
  logger.info('Starting Fabric installation', {
    category: 'mods',
    data: {
      service: 'DownloadManager',
      operation: 'installFabric',
      targetPath,
      mcVersion,
      fabricLoader,
      logChannel,
      progressChannel,
      totalFabricInstalls: performanceMetrics.fabricInstalls
    }
  });
  
  const { spawn, exec } = require('child_process');
  const installerUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/0.11.2/fabric-installer-0.11.2.jar';
  const installerJar = path.join(targetPath, 'fabric-installer.jar');
  // Check if Java is installed
  logger.debug('Checking Java installation for Fabric', {
    category: 'mods',
    data: {
      service: 'DownloadManager',
      operation: 'installFabric',
      stage: 'java_check'
    }
  });
  
  safeSend(logChannel, '🔍 Checking Java installation...');
  
  await new Promise((resolve, reject) => {
    exec('java -version', (error, stdout, stderr) => {
      if (error) {
        logger.error('Java not found for Fabric installation', {
          category: 'mods',
          data: {
            service: 'DownloadManager',
            operation: 'installFabric',
            stage: 'java_check',
            errorType: error.constructor.name,
            errorMessage: error.message
          }
        });
        
        safeSend(logChannel, '❌ Java not found. Please install Java to use Fabric.');
        reject(new Error('Java is not installed or not in PATH. Please install Java to use Fabric.'));
        return;
      }
      
      // Java outputs version to stderr by default
      const output = stderr || stdout;
      const javaVersion = output.split('\n')[0];
      
      logger.info('Java found for Fabric installation', {
        category: 'mods',
        data: {
          service: 'DownloadManager',
          operation: 'installFabric',
          stage: 'java_check',
          javaVersion
        }
      });
      
      safeSend(logChannel, '✓ Java found: ' + javaVersion);
      resolve();
    });
  });

  logger.info('Downloading Fabric installer', {
    category: 'network',
    data: {
      service: 'DownloadManager',
      operation: 'installFabric',
      stage: 'installer_download',
      installerUrl,
      installerJar
    }
  });
  
  safeSend(logChannel, '📥 Downloading Fabric installer...');
  await downloadWithProgress(installerUrl, installerJar, progressChannel);
  
  logger.info('Fabric installer downloaded successfully', {
    category: 'network',
    data: {
      service: 'DownloadManager',
      operation: 'installFabric',
      stage: 'installer_download',
      installerJar
    }
  });
  
  safeSend(logChannel, '✔ Fabric installer downloaded');

  await new Promise((resolve, reject) => {
    const installArgs = [
      '-jar', installerJar,
      'server',
      '-mcversion', mcVersion,
      '-loader', fabricLoader,
      '-dir', targetPath
    ];
    
    logger.info('Starting Fabric installer process', {
      category: 'mods',
      data: {
        service: 'DownloadManager',
        operation: 'installFabric',
        stage: 'installer_execution',
        args: installArgs,
        cwd: targetPath
      }
    });
    
    safeSend(logChannel, '🔧 Installing Fabric...');
    
    // Send progress update for starting installation
    safeSend(progressChannel, { percent: 50, speed: 'Installing...' });
    
    const proc = spawn('java', installArgs, { cwd: targetPath });

    proc.stdout.on('data', data => {
      const message = data.toString();
      logger.debug('Fabric installer stdout', {
        category: 'mods',
        data: {
          service: 'DownloadManager',
          operation: 'installFabric',
          stage: 'installer_execution',
          output: message.trim()
        }
      });
      safeSend(logChannel, message);
    });
    
    proc.stderr.on('data', data => {
      const message = data.toString();
      logger.debug('Fabric installer stderr', {
        category: 'mods',
        data: {
          service: 'DownloadManager',
          operation: 'installFabric',
          stage: 'installer_execution',
          error: message.trim()
        }
      });
      safeSend(logChannel, `[ERROR] ${message}`);
    });
    
    proc.on('close', code => {
      const installDuration = Date.now() - installStartTime;
      
      if (code === 0) {
        logger.info('Fabric installation completed successfully', {
          category: 'mods',
          data: {
            service: 'DownloadManager',
            operation: 'installFabric',
            duration: installDuration,
            exitCode: code,
            mcVersion,
            fabricLoader,
            targetPath
          }
        });
        
        safeSend(logChannel, '✔ Fabric install completed');
        
        // Send 100% progress on completion
        safeSend(progressChannel, { percent: 100, speed: 'Completed' });
        
        resolve();
      } else {
        logger.error('Fabric installation failed', {
          category: 'mods',
          data: {
            service: 'DownloadManager',
            operation: 'installFabric',
            duration: installDuration,
            exitCode: code,
            mcVersion,
            fabricLoader,
            targetPath
          }
        });
        
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
  const serverDownloadStartTime = Date.now();
  performanceMetrics.minecraftServerDownloads++;
  
  logger.info('Starting Minecraft server download', {
    category: 'network',
    data: {
      service: 'DownloadManager',
      operation: 'downloadMinecraftServer',
      mcVersion,
      targetPath,
      progressChannel,
      totalServerDownloads: performanceMetrics.minecraftServerDownloads
    }
  });
  
  try {
    // Send initial progress update
    safeSend(progressChannel, { percent: 0, speed: 'Starting...' });
    safeSend('install-log', `Downloading Minecraft server version ${mcVersion}...`);
    
    const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
    
    logger.debug('Fetching Minecraft version manifest', {
      category: 'network',
      data: {
        service: 'DownloadManager',
        operation: 'downloadMinecraftServer',
        stage: 'manifest_fetch',
        manifestUrl
      }
    });
    
    const manifestResponse = await fetch(manifestUrl);
    
    if (!manifestResponse.ok) {
      logger.error('Failed to fetch Minecraft version manifest', {
        category: 'network',
        data: {
          service: 'DownloadManager',
          operation: 'downloadMinecraftServer',
          stage: 'manifest_fetch',
          statusCode: manifestResponse.status,
          statusText: manifestResponse.statusText,
          manifestUrl
        }
      });
      throw new Error(`Failed to fetch manifest: ${manifestResponse.status} ${manifestResponse.statusText}`);
    }
    
    // Update progress - manifest fetched
    safeSend(progressChannel, { percent: 5, speed: 'Fetching version info...' });
    safeSend('install-log', 'Fetching version manifest...');
    
    const manifest = await manifestResponse.json();
    const versionMeta = manifest.versions.find(v => v.id === mcVersion);
    
    logger.debug('Minecraft version manifest processed', {
      category: 'network',
      data: {
        service: 'DownloadManager',
        operation: 'downloadMinecraftServer',
        stage: 'manifest_process',
        totalVersions: manifest.versions.length,
        versionFound: !!versionMeta,
        mcVersion
      }
    });
    
    if (!versionMeta) {
      logger.error('Minecraft version not found in manifest', {
        category: 'network',
        data: {
          service: 'DownloadManager',
          operation: 'downloadMinecraftServer',
          stage: 'manifest_process',
          mcVersion,
          availableVersions: manifest.versions.slice(0, 10).map(v => v.id)
        }
      });
      throw new Error(`Version ${mcVersion} not found in Minecraft version manifest`);
    }

    // Update progress - version found
    safeSend(progressChannel, { percent: 10, speed: 'Version found, getting details...' });
    safeSend('install-log', `Found version ${mcVersion} in manifest`);
    
    logger.debug('Fetching version details', {
      category: 'network',
      data: {
        service: 'DownloadManager',
        operation: 'downloadMinecraftServer',
        stage: 'version_details',
        versionUrl: versionMeta.url,
        versionType: versionMeta.type
      }
    });
    
    const detailResponse = await fetch(versionMeta.url);
    
    if (!detailResponse.ok) {
      logger.error('Failed to fetch version details', {
        category: 'network',
        data: {
          service: 'DownloadManager',
          operation: 'downloadMinecraftServer',
          stage: 'version_details',
          statusCode: detailResponse.status,
          statusText: detailResponse.statusText,
          versionUrl: versionMeta.url
        }
      });
      throw new Error(`Failed to fetch version details: ${detailResponse.status} ${detailResponse.statusText}`);
    }
    
    // Update progress - details fetched
    safeSend(progressChannel, { percent: 15, speed: 'Starting download...' });
    safeSend('install-log', 'Preparing to download server jar...');
    
    const detail = await detailResponse.json();
    
    if (!detail.downloads || !detail.downloads.server || !detail.downloads.server.url) {
      logger.error('Server download URL not found in version details', {
        category: 'network',
        data: {
          service: 'DownloadManager',
          operation: 'downloadMinecraftServer',
          stage: 'version_details',
          mcVersion,
          hasDownloads: !!detail.downloads,
          hasServer: !!(detail.downloads && detail.downloads.server),
          availableDownloads: detail.downloads ? Object.keys(detail.downloads) : []
        }
      });
      throw new Error(`Server download URL not found for Minecraft version ${mcVersion}`);
    }
    
    const serverUrl = detail.downloads.server.url;
    const serverSize = detail.downloads.server.size;
    const serverSha1 = detail.downloads.server.sha1;
    const dest = path.join(targetPath, 'server.jar');

    logger.info('Starting server jar download', {
      category: 'network',
      data: {
        service: 'DownloadManager',
        operation: 'downloadMinecraftServer',
        stage: 'server_download',
        serverUrl,
        serverSize,
        serverSha1,
        dest
      }
    });

    safeSend('install-log', `Downloading server.jar from: ${serverUrl}`);
    await downloadWithProgress(serverUrl, dest, progressChannel);
    
    // Validate downloaded file size if available
    if (serverSize) {
      try {
        const stats = fs.statSync(dest);
        if (stats.size !== serverSize) {
          logger.warn('Downloaded server jar size mismatch', {
            category: 'storage',
            data: {
              service: 'DownloadManager',
              operation: 'downloadMinecraftServer',
              stage: 'validation',
              expectedSize: serverSize,
              actualSize: stats.size,
              dest
            }
          });
        }
      } catch (error) {
        logger.warn('Could not validate server jar file', {
          category: 'storage',
          data: {
            service: 'DownloadManager',
            operation: 'downloadMinecraftServer',
            stage: 'validation',
            dest,
            error: error.message
          }
        });
      }
    }
    
    const serverDownloadDuration = Date.now() - serverDownloadStartTime;
    logger.info('Minecraft server download completed successfully', {
      category: 'network',
      data: {
        service: 'DownloadManager',
        operation: 'downloadMinecraftServer',
        duration: serverDownloadDuration,
        mcVersion,
        dest,
        serverUrl,
        totalServerDownloads: performanceMetrics.minecraftServerDownloads
      }
    });
    
    safeSend('install-log', 'Minecraft server.jar downloaded successfully');
    return true;
  } catch (err) {
    const serverDownloadDuration = Date.now() - serverDownloadStartTime;
    logger.error(`Minecraft server download failed: ${err.message}`, {
      category: 'network',
      data: {
        service: 'DownloadManager',
        operation: 'downloadMinecraftServer',
        duration: serverDownloadDuration,
        mcVersion,
        targetPath,
        errorType: err.constructor.name,
        errorMessage: err.message
      }
    });
    
    safeSend('install-log', `Error downloading server: ${err.message}`);
    return false;
  }
}

module.exports = {
  downloadWithProgress,
  installFabric,
  downloadMinecraftServer
};
