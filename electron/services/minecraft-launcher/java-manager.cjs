const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const fetch = require('node-fetch'); // Changed from dynamic to top-level
const AdmZip = require('adm-zip'); // Changed from dynamic to top-level
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
      
      try {
        const items = fs.readdirSync(dir);
        
        // First, check if this directory directly contains bin/java
        const binDir = path.join(dir, 'bin');
        if (fs.existsSync(binDir)) {
          
          // On Windows, prefer javaw.exe (no console) over java.exe
          const possibleExecutables = this.platform === 'windows' ? 
            ['javaw.exe', 'java.exe'] : 
            ['java'];
          
          for (const exe of possibleExecutables) {
            const exePath = path.join(binDir, exe);
            if (fs.existsSync(exePath)) {
              return exePath;
            }
          }
        }
        
        // If not found directly, search in subdirectories
        for (const item of items) {
          const itemPath = path.join(dir, item);
          
          try {
            const stat = fs.statSync(itemPath);
            if (stat.isDirectory()) {
              const result = findJavaExecutableRecursively(itemPath, maxDepth, currentDepth + 1);
              if (result) {
                return result;
              }
            }
          } catch (statError) {
          }
        }
        
      } catch (readError) {
      }
      
      return null;
    };
    
    // Start the recursive search
    const foundExecutable = findJavaExecutableRecursively(javaDir);
    
    if (foundExecutable) {
      return foundExecutable;
    }
    
    // If recursive search failed, log what we actually have
    try {
      const listDirectoryStructure = (dir, indent = '') => {
        try {
          const items = fs.readdirSync(dir);
          for (const item of items.slice(0, 10)) { // Limit to first 10 items to avoid spam
            const itemPath = path.join(dir, item);
            const stat = fs.statSync(itemPath);
            if (stat.isDirectory()) {
              if (indent.length < 8) { // Limit depth to avoid excessive logging
                listDirectoryStructure(itemPath, indent + '  ');
              }
            } else {
            }
          }
        } catch (e) {
        }
      };
      
      listDirectoryStructure(javaDir);
    } catch (debugError) {
    }
    
    return null;
  }
  
  isJavaInstalled(javaVersion) {
    const javaExe = this.getJavaExecutablePath(javaVersion);
    return javaExe !== null && fs.existsSync(javaExe);
  }
  
  async downloadJava(javaVersion, progressCallback) {
    try {
      
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
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
      
      
      if (progressCallback) {
        progressCallback({ type: 'Extracting', task: 'Extracting Java runtime...', progress: 0 });
      }
      
      // Extract Java archive
      await this.extractJava(tempFile, javaVersion, progressCallback);
      
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
        
        // List what we actually have in the directory for debugging
        try {
          const extractedContents = fs.readdirSync(path.join(this.javaBaseDir, `java-${javaVersion}`));
          
          // Log the full directory structure for debugging
          const debugDir = path.join(this.javaBaseDir, `java-${javaVersion}`);
          const logDirectoryStructure = (dir, indent = '') => {
            try {
              const items = fs.readdirSync(dir);
              for (const item of items) {
                const itemPath = path.join(dir, item);
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) {
                  if (indent.length < 6) { // Limit depth
                    logDirectoryStructure(itemPath, indent + '  ');
                  }
                } else {
                }
              }
            } catch (e) {
            }
          };
          logDirectoryStructure(debugDir);
          
        } catch (debugError) {
        }
        
        throw new Error(`Java extraction verification failed - executable not found in expected locations. The Java archive may have an unexpected structure.`);
      }
      
      
      if (!fs.existsSync(javaExe)) {
        throw new Error(`Java executable path returned but file does not exist: ${javaExe}`);
      }
      
      const javaStats = fs.statSync(javaExe);
      
      // Test if Java actually works
      try {
        // const { exec } = require('child_process'); // Now top-level
        // const { promisify } = require('util'); // Now top-level
        const execAsync = promisify(exec);
        
        // Use javaw.exe for testing to avoid console window (Windows)
        let testJavaPath = javaExe;
        if (process.platform === 'win32' && javaExe.includes('java.exe')) {
          testJavaPath = javaExe.replace('java.exe', 'javaw.exe');
        }
        
        const { stdout } = await execAsync(`"${testJavaPath}" -version`, { 
          timeout: 5000,
          windowsHide: true // Hide console window on Windows
        });
      } catch (testError) {
      }
      
      if (progressCallback) {
        progressCallback({ type: 'Complete', task: `Java ${javaVersion} ready!`, progress: 100 });
      }
      
      return { success: true, javaPath: javaExe };
      
    } catch (error) {
      throw error;
    }
  }
  
  async extractJava(archivePath, javaVersion, progressCallback) {
    const extractPath = path.join(this.javaBaseDir, `java-${javaVersion}`);
    
    // Remove existing installation
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
    
    try {
      if (archivePath.endsWith('.tar.gz')) {
        await this.extractTarGz(archivePath, extractPath, progressCallback);
      } else if (archivePath.endsWith('.zip')) {
        await this.extractZip(archivePath, extractPath, progressCallback);
      } else {
        throw new Error('Unsupported archive format');
      }
    } catch (error) {
      throw error;
    }
  }
  
  async extractZip(zipPath, extractPath, progressCallback) {
    // const AdmZip = require('adm-zip'); // Now top-level
    
    try {
      
      // Remove existing installation with retry logic for Windows
      if (fs.existsSync(extractPath)) {
        await this.removeDirectoryWithRetry(extractPath, 3);
      }
      
      // Create the extract directory
      fs.mkdirSync(extractPath, { recursive: true });
      
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();
      
      
      // Extract all files
      zip.extractAllTo(extractPath, true);
      
      // Handle nested directory structure more reliably
      await this.flattenJavaDirectory(extractPath);
      
      
    } catch (error) {
      throw error;
    }
  }
  
  // Helper method to remove directory with retry logic for Windows
  async removeDirectoryWithRetry(dirPath, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        
        if (fs.existsSync(dirPath)) {
          // On Windows, sometimes we need to wait for file handles to be released
          if (attempt > 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          // Try to remove files first, then the directory
          const contents = fs.readdirSync(dirPath);
          for (const item of contents) {
            const itemPath = path.join(dirPath, item);
            const stat = fs.statSync(itemPath);
            
            if (stat.isDirectory()) {
              await this.removeDirectoryWithRetry(itemPath, 1); // Single attempt for subdirs
            } else {
              // Make file writable before deletion
              try {
                fs.chmodSync(itemPath, 0o666);
                fs.unlinkSync(itemPath);
              } catch (fileError) {
              }
            }
          }
          
          // Remove the directory itself
          fs.rmdirSync(dirPath);
        }
        
        return; // Success!
        
      } catch (error) {
        
        if (attempt === maxRetries) {
          if (error.code === 'EPERM' || error.code === 'EBUSY') {
            // Create a unique temp name and leave the old directory
            const timestamp = Date.now();
            const tempName = `${dirPath}_old_${timestamp}`;
            try {
              fs.renameSync(dirPath, tempName);
              return; // Consider this success
            } catch (renameError) {
              // Continue with extraction anyway
            }
          }
          
          return; // Don't throw error, just continue
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  
  // Helper method to flatten Java directory structure
  async flattenJavaDirectory(extractPath) {
    try {
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

      } else {
        if (nestedRoots.length > 1) {
        }
      }
    } catch (err) {
      // we continue — recursive search can still find it
    }
  }
  
  async extractTarGz(tarPath, extractPath, progressCallback) {
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
  
  async ensureJava(javaVersion, progressCallback) {
    
    const javaInstalled = this.isJavaInstalled(javaVersion);
    
    if (javaInstalled) {
      const javaPath = this.getJavaExecutablePath(javaVersion);
      return { success: true, javaPath: javaPath };
    }
    
    const result = await this.downloadJava(javaVersion, progressCallback);
    
    
    return result;
  }



  // Helper method to kill any running Java processes for this client
  async killClientJavaProcesses(clientPath) {
    try {
      
      if (process.platform === 'win32') {
        // const { exec } = require('child_process'); // Now top-level
        // const { promisify } = require('util'); // Now top-level
        const execAsync = promisify(exec);
        
        // CRITICAL FIX: Only kill Java processes that are specifically related to this client
        // DO NOT kill all Java processes as this would stop the Minecraft server!
        
        try {
          // Use WMIC to kill only processes with this client path in command line
          if (clientPath) {
            const clientPathEscaped = clientPath.replace(/\\/g, '\\\\');
            
            
            await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='java.exe'" call terminate`, { 
              timeout: 5000 
            }).catch(() => {
            });
            
            await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='javaw.exe'" call terminate`, { 
              timeout: 5000 
            }).catch(() => {
            });
            
          } else {
          }
        } catch (killError) {
        }
      }
    } catch (error) {
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
          try {
            const makeWritableRecursive = (dir) => {
              const items = fs.readdirSync(dir);
              for (const item of items) {
                const itemPath = path.join(dir, item);
                try {
                  const stat = fs.statSync(itemPath);
                  
                  // Make the item writable
                  fs.chmodSync(itemPath, 0o777);
                  
                  if (stat.isDirectory()) {
                    makeWritableRecursive(itemPath);
                  }
                } catch (chmodError) {
                }
              }
            };
            
            makeWritableRecursive(dirPath);
            fs.chmodSync(dirPath, 0o777);
          } catch (chmodError) {
          }
          
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
            const tempName = `${dirPath}_old_${timestamp}`;
            try {
              fs.renameSync(dirPath, tempName);
              return; // Consider this success
            } catch (renameError) {
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
