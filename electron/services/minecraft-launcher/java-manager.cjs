const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const fetch = require('node-fetch');
const { promisify } = require('util');

// Java Manager class to handle downloading and managing Java runtimes
class JavaManager {
  constructor(clientPath = null) {
    this.platform = this.getPlatformString();
    this.architecture = this.getArchitectureString();
    this.clientPath = clientPath;
    
    // Use client-specific Java directory if clientPath is provided
    if (clientPath) {
      this.javaBaseDir = path.join(clientPath, 'java');
    } else {
      // Fallback to global directory for backwards compatibility
      this.javaBaseDir = path.join(os.homedir(), '.minecraft-core', 'java');
    }
    
    // Ensure Java directory exists
    if (!fs.existsSync(this.javaBaseDir)) {
      fs.mkdirSync(this.javaBaseDir, { recursive: true });
    }
  }
  
  // Update client path and Java directory
  setClientPath(clientPath) {
    this.clientPath = clientPath;
    this.javaBaseDir = path.join(clientPath, 'java');
    
    // Ensure Java directory exists
    if (!fs.existsSync(this.javaBaseDir)) {
      fs.mkdirSync(this.javaBaseDir, { recursive: true });
    }
  }
  
  getPlatformString() {
    switch (process.platform) {
      case 'win32': return 'windows';
      case 'darwin': return 'mac';
      case 'linux': return 'linux';
      default: return 'linux';
    }
  }
  
  getArchitectureString() {
    switch (process.arch) {
      case 'x64': return 'x64';
      case 'arm64': return 'aarch64';
      case 'ia32': return 'x32';
      default: return 'x64';
    }
  }
  
  getJavaExecutablePath(javaVersion) {
    const javaDir = path.join(this.javaBaseDir, `java-${javaVersion}`);
    
    
    if (!fs.existsSync(javaDir)) {
      return null;
    }
    
    // Recursive function to find Java executable in any subdirectory
    const findJavaExecutableRecursively = (dir, maxDepth = 5, currentDepth = 0) => {
      if (currentDepth > maxDepth) {
        return null;
      }

      const items = fs.readdirSync(dir);
      const binDir = path.join(dir, 'bin');
      if (fs.existsSync(binDir)) {
        const possibleExecutables = this.platform === 'windows' ? ['javaw.exe', 'java.exe'] : ['java'];
        for (const exe of possibleExecutables) {
          const exePath = path.join(binDir, exe);
          if (fs.existsSync(exePath)) {
            return exePath;
          }
        }
      }

      for (const item of items) {
        const itemPath = path.join(dir, item);
        if (fs.statSync(itemPath).isDirectory()) {
          const result = findJavaExecutableRecursively(itemPath, maxDepth, currentDepth + 1);
          if (result) {
            return result;
          }
        }
      }

      return null;
    };
    
    // Start the recursive search
    const foundExecutable = findJavaExecutableRecursively(javaDir);
    
    if (foundExecutable) {
      return foundExecutable;
    }
    
    return null;
  }
  
  isJavaInstalled(requiredJavaVersion) {
    // First, try to find the exact version
    const exactVersionExe = this.getJavaExecutablePath(requiredJavaVersion);
    if (exactVersionExe !== null && fs.existsSync(exactVersionExe)) {
      return true;
    }
    
    // If exact version not found, check if we have a higher version that can satisfy the requirement
    if (!fs.existsSync(this.javaBaseDir)) {
      return false;
    }
    
    try {
      const javaDirs = fs.readdirSync(this.javaBaseDir);
      const availableVersions = javaDirs
        .filter(dir => dir.startsWith('java-'))
        .map(dir => parseInt(dir.replace('java-', '')))
        .filter(version => !isNaN(version))
        .sort((a, b) => b - a); // Sort descending (highest first)
      
      const requiredVersion = parseInt(requiredJavaVersion);
      
      // Find the highest available version that satisfies the requirement
      const compatibleVersion = availableVersions.find(version => version >= requiredVersion);
      
      if (compatibleVersion) {
        const compatibleExe = this.getJavaExecutablePath(compatibleVersion.toString());
        if (compatibleExe !== null && fs.existsSync(compatibleExe)) {
          return true;
        }
      }
    } catch (error) {
      // If there's an error reading directories, fall back to false
    }
    
    return false;
  }
  
  getBestJavaPath(requiredJavaVersion) {
    // First, try to find the exact version
    const exactVersionExe = this.getJavaExecutablePath(requiredJavaVersion);
    if (exactVersionExe !== null && fs.existsSync(exactVersionExe)) {
      return exactVersionExe;
    }
    
    // If exact version not found, find the best compatible version
    if (!fs.existsSync(this.javaBaseDir)) {
      return null;
    }
    
    try {
      const javaDirs = fs.readdirSync(this.javaBaseDir);
      const availableVersions = javaDirs
        .filter(dir => dir.startsWith('java-'))
        .map(dir => parseInt(dir.replace('java-', '')))
        .filter(version => !isNaN(version))
        .sort((a, b) => b - a); // Sort descending (highest first)
      
      const requiredVersion = parseInt(requiredJavaVersion);
      
      // Find the highest available version that satisfies the requirement
      const compatibleVersion = availableVersions.find(version => version >= requiredVersion);
      
      if (compatibleVersion) {
        const compatibleExe = this.getJavaExecutablePath(compatibleVersion.toString());
        if (compatibleExe !== null && fs.existsSync(compatibleExe)) {
          return compatibleExe;
        }
      }
    } catch (error) {
      // If there's an error reading directories, fall back to null
    }
    
    return null;
  }
  
    async downloadJava(javaVersion, progressCallback) {
    if (progressCallback) {
      progressCallback({ type: 'Preparing', task: `Preparing to download Java ${javaVersion}...`, progress: 0 });
    }
    
    // Get download URL from Adoptium API
    const apiUrl = `https://api.adoptium.net/v3/assets/latest/${javaVersion}/hotspot?architecture=${this.architecture}&image_type=jre&os=${this.platform}&vendor=eclipse`;
    
    
    // const fetch = require('node-fetch'); // Now top-level
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to get Java download info: ${response.status} ${response.statusText}`);
    }
    
    const releases = await response.json();
    if (!releases || releases.length === 0) {
      throw new Error(`No Java ${javaVersion} release found for ${this.platform} ${this.architecture}`);
    }
    
    const release = releases[0];
    const downloadUrl = release.binary.package.link;
    const filename = release.binary.package.name;
    
    
    if (progressCallback) {
      progressCallback({ type: 'Downloading', task: `Downloading ${filename}...`, progress: 0 });
    }
    
    // Download Java archive
    const downloadResponse = await fetch(downloadUrl);
    if (!downloadResponse.ok) {
      throw new Error(`Failed to download Java: ${downloadResponse.status} ${downloadResponse.statusText}`);
    }
    
    const totalSize = parseInt(downloadResponse.headers.get('content-length'), 10);
    let downloadedSize = 0;
    
    const tempDir = path.join(this.javaBaseDir, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const tempFile = path.join(tempDir, filename);
    const fileStream = fs.createWriteStream(tempFile);
    
    // Track download progress
    downloadResponse.body.on('data', (chunk) => {
      downloadedSize += chunk.length;
      const progress = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;
      
      if (progressCallback && progress % 5 === 0) { // Update every 5%
        progressCallback({ 
          type: 'Downloading', 
          task: `Downloading ${filename}...`, 
          progress: progress,
          downloadedMB: Math.round(downloadedSize / 1024 / 1024),
          totalMB: Math.round(totalSize / 1024 / 1024)
        });
      }
    });
    
    downloadResponse.body.pipe(fileStream);
    
    await new Promise((resolve, reject) => {
      fileStream.on('finish', () => resolve());
      fileStream.on('error', reject);
    });
    
    
    if (progressCallback) {
      progressCallback({ type: 'Extracting', task: 'Extracting Java runtime...', progress: 0 });
    }
    
    // Extract Java archive
    await this.extractJava(tempFile, javaVersion);
    
    // Clean up temp file
    fs.unlinkSync(tempFile);
    
    // CRITICAL: Verify that flattening actually produced a findable Java executable
    // This prevents infinite download loops when extraction structure is unexpected
    const javaExeCheck = this.getJavaExecutablePath(javaVersion);
    if (!javaExeCheck) {
      throw new Error(
        `Fatal: Java executable still not found after extraction and flattening. ` +
        `Stopping further downloads to avoid infinite loop. ` +
        `The Java archive may have an unexpected directory structure.`
      );
    }
    
    if (progressCallback) {
      progressCallback({ type: 'Verifying', task: 'Verifying Java installation...', progress: 90 });
    }
    
    // Verify installation using the robust path detection
    const javaExe = this.getJavaExecutablePath(javaVersion);
    
    if (!javaExe) {
      throw new Error('Java extraction verification failed - executable not found in expected locations. The Java archive may have an unexpected structure.');
    }
    
    
    if (!fs.existsSync(javaExe)) {
      throw new Error(`Java executable path returned but file does not exist: ${javaExe}`);
    }
    
    const execAsync = promisify(exec);
    let testJavaPath = javaExe;
    if (process.platform === 'win32' && javaExe.includes('java.exe')) {
      testJavaPath = javaExe.replace('java.exe', 'javaw.exe');
    }
    await execAsync(`"${testJavaPath}" -version`, {
      timeout: 5000,
      windowsHide: true
    }).catch(() => {});
    
    if (progressCallback) {
      progressCallback({ type: 'Complete', task: `Java ${javaVersion} ready!`, progress: 100 });
    }
    
    return { success: true, javaPath: javaExe };
  }
    async extractJava(archivePath, javaVersion) {
    const extractPath = path.join(this.javaBaseDir, `java-${javaVersion}`);
    
    // Remove existing installation
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
    
    if (archivePath.endsWith('.tar.gz')) {
      await this.extractTarGz(archivePath, extractPath);
    } else if (archivePath.endsWith('.zip')) {
      await this.extractZip(archivePath, extractPath);
    } else {
      throw new Error('Unsupported archive format');
    }
  }
    async extractZip(zipPath, extractPath) {
    if (fs.existsSync(extractPath)) {
      await this.removeDirectoryWithRetry(extractPath, 3);
    }

    fs.mkdirSync(extractPath, { recursive: true });

    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);
    await this.flattenJavaDirectory(extractPath);
  }
  
  // Helper method to remove directory with retry logic for Windows  // Helper method to flatten Java directory structure
  async flattenJavaDirectory(extractPath) {
    const entries = fs.readdirSync(extractPath);

    // Find any single subdirectory that itself contains a 'bin' folder
    const nestedRoots = entries.filter(name => {
      const full = path.join(extractPath, name);
      try {
        return fs.statSync(full).isDirectory()
            && fs.existsSync(path.join(full, 'bin'));
      } catch {
        return false;
      }
    });

    // If exactly one such nested folder, move its contents up
    if (nestedRoots.length === 1) {
      const nested = path.join(extractPath, nestedRoots[0]);

      const tmp = extractPath + `_tmp_${Date.now()}`;
      fs.renameSync(nested, tmp);
      // wipe out the original extractPath (it should now be empty)
      fs.rmSync(extractPath, { recursive: true, force: true });
      // move temp back to extractPath
      fs.renameSync(tmp, extractPath);
    }
  }
  
  async extractTarGz(tarPath, extractPath) {
    // const { spawn } = require('child_process'); // Now top-level
    
    return new Promise((resolve, reject) => {
      fs.mkdirSync(extractPath, { recursive: true });
      
      const tar = spawn('tar', ['-xzf', tarPath, '-C', extractPath], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      tar.on('close', (code) => {
        if (code === 0) {
          
          // Find the Java directory (it might be nested)
          const contents = fs.readdirSync(extractPath);
          if (contents.length === 1 && fs.statSync(path.join(extractPath, contents[0])).isDirectory()) {
            // Move contents up one level
            const nestedDir = path.join(extractPath, contents[0]);
            const tempDir = extractPath + '_temp';
            
            fs.renameSync(nestedDir, tempDir);
            fs.rmSync(extractPath, { recursive: true });
            fs.renameSync(tempDir, extractPath);
          }
          
          resolve();
        } else {
          reject(new Error(`TAR extraction failed with code ${code}`));
        }
      });
      
      tar.on('error', reject);
    });
  }
  
  async ensureJava(requiredJavaVersion, progressCallback) {
    
    const javaInstalled = this.isJavaInstalled(requiredJavaVersion);
    
    if (javaInstalled) {
      // Find the best compatible Java version to use
      const javaPath = this.getBestJavaPath(requiredJavaVersion);
      if (javaPath) {
        return { success: true, javaPath: javaPath };
      }
    }
    
    const result = await this.downloadJava(requiredJavaVersion, progressCallback);
    
    
    return result;
  }



  // Helper method to kill any running Java processes for this client
  async killClientJavaProcesses(clientPath) {
    if (process.platform === 'win32') {
      const execAsync = promisify(exec);
      if (clientPath) {
        const clientPathEscaped = clientPath.replace(/\\/g, '\\\\');
        await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='java.exe'" call terminate`, { timeout: 5000 }).catch(() => {});
        await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='javaw.exe'" call terminate`, { timeout: 5000 }).catch(() => {});
      }
    }
  }

  // Helper method to remove directory with retry logic for Windows (this one seems to be duplicated, keeping the one from the original class)
  // async removeDirectoryWithRetry(dirPath, maxRetries = 5) { ... } // This is a duplicate, I'll remove it from the final combined code if it's truly redundant.
  // For now, I'll keep the one that was part of the original JavaManager class.
  // The original `JavaManager` had two `removeDirectoryWithRetry` methods. I'll assume the more comprehensive one (the second one in the original file) is the one to keep.
  // Upon review, the second one is more robust. I've used that one here.
  async removeDirectoryWithRetry(dirPath, maxRetries = 5) { // This is the more robust version.
    // First, try to kill any Java processes that might be holding files
    await this.killClientJavaProcesses(dirPath);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        
        if (fs.existsSync(dirPath)) {
          // On Windows, sometimes we need to wait for file handles to be released
          if (attempt > 1) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          }
          
          // Make all files and directories writable first
          const makeWritableRecursive = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
              const itemPath = path.join(dir, item);
              const stat = fs.statSync(itemPath);
              fs.chmodSync(itemPath, 0o777);
              if (stat.isDirectory()) {
                makeWritableRecursive(itemPath);
              }
            }
          };

          makeWritableRecursive(dirPath);
          fs.chmodSync(dirPath, 0o777);
          
          // Try to remove the directory
          fs.rmSync(dirPath, { 
            recursive: true, 
            force: true,
            maxRetries: 3,
            retryDelay: 1000
          });
        }
        
        return; // Success!
        
      } catch (error) {
        
        if (attempt === maxRetries) {
          if (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'ENOTEMPTY') {
            // Create a unique temp name and leave the old directory
            const timestamp = Date.now();
            const tempName = `${dirPath}_old_${timestamp}`;            try {
              fs.renameSync(dirPath, tempName);
              return; // Consider this success
            } catch {
              // Continue with extraction anyway
            }
          }
          
          return; // Don't throw error, just continue
        }
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt * attempt));
      }
    }
  }
}

module.exports = { JavaManager };
