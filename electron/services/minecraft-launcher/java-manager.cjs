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
      console.log(`[JavaManager] Using client-specific Java directory: ${this.javaBaseDir}`);
    } else {
      // Fallback to global directory for backwards compatibility
      this.javaBaseDir = path.join(os.homedir(), '.minecraft-core', 'java');
      console.log(`[JavaManager] Using global Java directory: ${this.javaBaseDir}`);
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
    console.log(`[JavaManager] Updated Java directory to: ${this.javaBaseDir}`);
    
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
    
    // console.log(`[JavaManager] Looking for Java ${javaVersion} in: ${javaDir}`);
    
    if (!fs.existsSync(javaDir)) {
      console.log(`[JavaManager] Java directory does not exist: ${javaDir}`);
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
          console.log(`[JavaManager] Found bin directory at: ${binDir}`);
          
          // On Windows, prefer javaw.exe (no console) over java.exe
          const possibleExecutables = this.platform === 'windows' ? 
            ['javaw.exe', 'java.exe'] : 
            ['java'];
          
          for (const exe of possibleExecutables) {
            const exePath = path.join(binDir, exe);
            if (fs.existsSync(exePath)) {
              console.log(`[JavaManager] Found Java executable: ${exePath}`);
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
              console.log(`[JavaManager] Searching subdirectory: ${itemPath}`);
              const result = findJavaExecutableRecursively(itemPath, maxDepth, currentDepth + 1);
              if (result) {
                return result;
              }
            }
          } catch (statError) {
            console.warn(`[JavaManager] Could not stat ${itemPath}: ${statError.message}`);
          }
        }
        
      } catch (readError) {
        console.warn(`[JavaManager] Could not read directory ${dir}: ${readError.message}`);
      }
      
      return null;
    };
    
    // Start the recursive search
    const foundExecutable = findJavaExecutableRecursively(javaDir);
    
    if (foundExecutable) {
      console.log(`[JavaManager] Successfully found Java executable: ${foundExecutable}`);
      return foundExecutable;
    }
    
    // If recursive search failed, log what we actually have
    try {
      console.log(`[JavaManager] Could not find Java executable. Directory structure:`);
      const listDirectoryStructure = (dir, indent = '') => {
        try {
          const items = fs.readdirSync(dir);
          for (const item of items.slice(0, 10)) { // Limit to first 10 items to avoid spam
            const itemPath = path.join(dir, item);
            const stat = fs.statSync(itemPath);
            if (stat.isDirectory()) {
              console.log(`${indent}📁 ${item}/`);
              if (indent.length < 8) { // Limit depth to avoid excessive logging
                listDirectoryStructure(itemPath, indent + '  ');
              }
            } else {
              console.log(`${indent}📄 ${item}`);
            }
          }
        } catch (e) {
          console.log(`${indent}❌ Error reading directory: ${e.message}`);
        }
      };
      
      listDirectoryStructure(javaDir);
    } catch (debugError) {
      console.warn(`[JavaManager] Could not debug directory structure: ${debugError.message}`);
    }
    
    console.warn(`[JavaManager] No Java executable found in ${javaDir} or its subdirectories`);
    return null;
  }
  
  isJavaInstalled(javaVersion) {
    const javaExe = this.getJavaExecutablePath(javaVersion);
    return javaExe !== null && fs.existsSync(javaExe);
  }
  
  async downloadJava(javaVersion, progressCallback) {
    try {
      console.log(`[JavaManager] Downloading Java ${javaVersion} for ${this.platform} ${this.architecture}...`);
      
      if (progressCallback) {
        progressCallback({ type: 'Preparing', task: `Preparing to download Java ${javaVersion}...`, progress: 0 });
      }
      
      // Get download URL from Adoptium API
      const apiUrl = `https://api.adoptium.net/v3/assets/latest/${javaVersion}/hotspot?architecture=${this.architecture}&image_type=jre&os=${this.platform}&vendor=eclipse`;
      
      console.log(`[JavaManager] Fetching Java download info from: ${apiUrl}`);
      
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
      
      console.log(`[JavaManager] Downloading Java from: ${downloadUrl}`);
      
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
      
      console.log(`[JavaManager] Java downloaded to: ${tempFile}`);
      
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
      console.log(`[JavaManager] Post-extraction verification passed: Java found at ${javaExeCheck}`);
      
      if (progressCallback) {
        progressCallback({ type: 'Verifying', task: 'Verifying Java installation...', progress: 90 });
      }
      
      // Verify installation using the robust path detection
      const javaExe = this.getJavaExecutablePath(javaVersion);
      // console.log(`[JavaManager] Checking for Java executable...`);
      
      if (!javaExe) {
        console.error(`[JavaManager] Java executable not found after extraction`);
        
        // List what we actually have in the directory for debugging
        try {
          const extractedContents = fs.readdirSync(path.join(this.javaBaseDir, `java-${javaVersion}`));
          console.error(`[JavaManager] Directory contents: ${extractedContents.join(', ')}`);
          
          // Log the full directory structure for debugging
          console.error(`[JavaManager] Full directory structure:`);
          const debugDir = path.join(this.javaBaseDir, `java-${javaVersion}`);
          const logDirectoryStructure = (dir, indent = '') => {
            try {
              const items = fs.readdirSync(dir);
              for (const item of items) {
                const itemPath = path.join(dir, item);
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory()) {
                  console.error(`${indent}📁 ${item}/`);
                  if (indent.length < 6) { // Limit depth
                    logDirectoryStructure(itemPath, indent + '  ');
                  }
                } else {
                  console.error(`${indent}📄 ${item}`);
                }
              }
            } catch (e) {
              console.error(`${indent}❌ Error: ${e.message}`);
            }
          };
          logDirectoryStructure(debugDir);
          
        } catch (debugError) {
          console.error(`[JavaManager] Error debugging extraction: ${debugError.message}`);
        }
        
        throw new Error(`Java extraction verification failed - executable not found in expected locations. The Java archive may have an unexpected structure.`);
      }
      
      console.log(`[JavaManager] Found Java executable at: ${javaExe}`);
      
      if (!fs.existsSync(javaExe)) {
        throw new Error(`Java executable path returned but file does not exist: ${javaExe}`);
      }
      
      const javaStats = fs.statSync(javaExe);
      console.log(`[MinecraftLauncher] - Java file size: ${javaStats.size} bytes`);
      console.log(`[MinecraftLauncher] - Java file permissions: ${javaStats.mode.toString(8)}`);
      
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
        console.log(`[JavaManager] - Java ${javaVersion} test: SUCCESS`);
        console.log(`[JavaManager] - Version output: ${stdout.split('\n')[0]}`);
      } catch (testError) {
        console.log(`[JavaManager] - Java ${javaVersion} test: FAILED - ${testError.message}`);
      }
      
      if (progressCallback) {
        progressCallback({ type: 'Complete', task: `Java ${javaVersion} ready!`, progress: 100 });
      }
      
      return { success: true, javaPath: javaExe };
      
    } catch (error) {
      console.error(`[JavaManager] Failed to download Java ${javaVersion}:`, error);
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
      console.error(`[JavaManager] Extraction failed:`, error);
      throw error;
    }
  }
  
  async extractZip(zipPath, extractPath, progressCallback) {
    // const AdmZip = require('adm-zip'); // Now top-level
    
    try {
      console.log(`[JavaManager] Starting ZIP extraction from ${zipPath} to ${extractPath}`);
      
      // Remove existing installation with retry logic for Windows
      if (fs.existsSync(extractPath)) {
        console.log(`[JavaManager] Removing existing directory: ${extractPath}`);
        await this.removeDirectoryWithRetry(extractPath, 3);
      }
      
      // Create the extract directory
      fs.mkdirSync(extractPath, { recursive: true });
      
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();
      
      console.log(`[JavaManager] Extracting ${entries.length} files from ZIP...`);
      
      // Extract all files
      zip.extractAllTo(extractPath, true);
      
      // Handle nested directory structure more reliably
      await this.flattenJavaDirectory(extractPath);
      
      console.log(`[JavaManager] ZIP extraction complete`);
      
    } catch (error) {
      console.error(`[JavaManager] ZIP extraction error:`, error);
      throw error;
    }
  }
  
  // Helper method to remove directory with retry logic for Windows
  async removeDirectoryWithRetry(dirPath, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[JavaManager] Removing directory attempt ${attempt}/${maxRetries}: ${dirPath}`);
        
        if (fs.existsSync(dirPath)) {
          // On Windows, sometimes we need to wait for file handles to be released
          if (attempt > 1) {
            console.log(`[JavaManager] Waiting 2 seconds for file handles to be released...`);
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
                console.warn(`[JavaManager] Could not remove file ${itemPath}:`, fileError.message);
              }
            }
          }
          
          // Remove the directory itself
          fs.rmdirSync(dirPath);
        }
        
        console.log(`[JavaManager] Successfully removed directory: ${dirPath}`);
        return; // Success!
        
      } catch (error) {
        console.warn(`[JavaManager] Remove attempt ${attempt} failed:`, error.message);
        
        if (attempt === maxRetries) {
          if (error.code === 'EPERM' || error.code === 'EBUSY') {
            // Create a unique temp name and leave the old directory
            const timestamp = Date.now();
            const tempName = `${dirPath}_old_${timestamp}`;
            try {
              fs.renameSync(dirPath, tempName);
              console.log(`[JavaManager] Could not remove directory, renamed to: ${tempName}`);
              return; // Consider this success
            } catch (renameError) {
              console.warn(`[JavaManager] Could not rename directory either:`, renameError.message);
              // Continue with extraction anyway
            }
          }
          
          console.warn(`[JavaManager] Failed to remove directory after ${maxRetries} attempts, continuing anyway...`);
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
      console.log(`[JavaManager] After extraction, entries: ${entries.join(', ')}`);

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
        console.log(`[JavaManager] Flattening nested Java folder: ${nestedRoots[0]}`);

        const tmp = extractPath + `_tmp_${Date.now()}`;
        fs.renameSync(nested, tmp);
        // wipe out the original extractPath (it should now be empty)
        fs.rmSync(extractPath, { recursive: true, force: true });
        // move temp back to extractPath
        fs.renameSync(tmp, extractPath);

        console.log(`[JavaManager] Directory flattened successfully`);
      } else {
        console.log(`[JavaManager] No single nested JRE/JDK folder to flatten (found ${nestedRoots.length} candidates)`);
        if (nestedRoots.length > 1) {
          console.log(`[JavaManager] Multiple nested roots found: ${nestedRoots.join(', ')}`);
        }
      }
    } catch (err) {
      console.warn(`[JavaManager] flattenJavaDirectory error: ${err.message}`);
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
          console.log(`[JavaManager] TAR.GZ extraction complete`);
          
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
    console.log(`[JavaManager] ===== ENSURING JAVA ${javaVersion} =====`);
    console.log(`[JavaManager] Java base directory: ${this.javaBaseDir}`);
    console.log(`[JavaManager] Client path: ${this.clientPath}`);
    
    const javaInstalled = this.isJavaInstalled(javaVersion);
    console.log(`[JavaManager] Java ${javaVersion} installed check: ${javaInstalled}`);
    
    if (javaInstalled) {
      const javaPath = this.getJavaExecutablePath(javaVersion);
      console.log(`[JavaManager] Java ${javaVersion} is already installed at: ${javaPath}`);
      return { success: true, javaPath: javaPath };
    }
    
    console.log(`[JavaManager] Java ${javaVersion} not found, downloading...`);
    const result = await this.downloadJava(javaVersion, progressCallback);
    
    console.log(`[JavaManager] Download result:`, result);
    console.log(`[JavaManager] Final Java path: ${result.javaPath}`);
    console.log(`[JavaManager] Java path includes client directory: ${result.javaPath.includes(this.javaBaseDir) ? 'YES (GOOD)' : 'NO (BAD)'}`);
    console.log(`[JavaManager] Java path includes Program Files: ${result.javaPath.includes('Program Files') ? 'YES (BAD)' : 'NO (GOOD)'}`);
    console.log(`[JavaManager] ==========================================`);
    
    return result;
  }



  // Helper method to kill any running Java processes for this client
  async killClientJavaProcesses(clientPath) {
    try {
      console.log(`[JavaManager] Attempting to kill Java processes for client: ${clientPath}`);
      
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
            
            console.log(`[JavaManager] Looking for Java processes with client path: ${clientPath}`);
            
            await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='java.exe'" call terminate`, { 
              timeout: 5000 
            }).catch(() => {
              console.log(`[JavaManager] No client-specific java.exe processes found`);
            });
            
            await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='javaw.exe'" call terminate`, { 
              timeout: 5000 
            }).catch(() => {
              console.log(`[JavaManager] No client-specific javaw.exe processes found`);
            });
            
            console.log(`[JavaManager] Targeted client Java process cleanup completed`);
          } else {
            console.log(`[JavaManager] No client path provided, skipping Java process cleanup`);
          }
        } catch (killError) {
          console.warn(`[JavaManager] Could not kill client-specific Java processes: ${killError.message}`);
        }
      }
    } catch (error) {
      console.warn(`[JavaManager] Error in killClientJavaProcesses: ${error.message}`);
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
        console.log(`[JavaManager] Removing directory attempt ${attempt}/${maxRetries}: ${dirPath}`);
        
        if (fs.existsSync(dirPath)) {
          // On Windows, sometimes we need to wait for file handles to be released
          if (attempt > 1) {
            console.log(`[JavaManager] Waiting ${2 * attempt} seconds for file handles to be released...`);
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
                  console.warn(`[JavaManager] Could not chmod ${itemPath}: ${chmodError.message}`);
                }
              }
            };
            
            makeWritableRecursive(dirPath);
            fs.chmodSync(dirPath, 0o777);
          } catch (chmodError) {
            console.warn(`[JavaManager] Could not make directory writable: ${chmodError.message}`);
          }
          
          // Try to remove the directory
          fs.rmSync(dirPath, { 
            recursive: true, 
            force: true,
            maxRetries: 3,
            retryDelay: 1000
          });
        }
        
        console.log(`[JavaManager] Successfully removed directory: ${dirPath}`);
        return; // Success!
        
      } catch (error) {
        console.warn(`[JavaManager] Remove attempt ${attempt} failed:`, error.message);
        
        if (attempt === maxRetries) {
          if (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'ENOTEMPTY') {
            // Create a unique temp name and leave the old directory
            const timestamp = Date.now();
            const tempName = `${dirPath}_old_${timestamp}`;
            try {
              fs.renameSync(dirPath, tempName);
              console.log(`[JavaManager] Could not remove directory, renamed to: ${tempName}`);
              console.log(`[JavaManager] You may need to manually delete this folder after restarting your computer`);
              return; // Consider this success
            } catch (renameError) {
              console.warn(`[JavaManager] Could not rename directory either:`, renameError.message);
              // Continue with extraction anyway
            }
          }
          
          console.warn(`[JavaManager] Failed to remove directory after ${maxRetries} attempts, continuing anyway...`);
          return; // Don't throw error, just continue
        }
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt * attempt));
      }
    }
  }
}

module.exports = { JavaManager };
