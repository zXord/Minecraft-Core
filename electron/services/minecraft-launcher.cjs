// Minecraft launcher service for client launching with Microsoft authentication
console.log('🔥🔥🔥 MINECRAFT-LAUNCHER.CJS LOADED WITH NEW CHANGES - TIMESTAMP: ' + new Date().toISOString() + ' 🔥🔥🔥');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

// Console hiding removed - fixing the root cause instead (using javaw.exe)

// Add global error handling for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.warn('[MinecraftLauncher] Unhandled Promise Rejection:', reason);
  
  // Handle common authentication network errors gracefully
  if (reason && typeof reason === 'object' && reason.message) {
    if (reason.message.includes('ENOTFOUND') ||
        reason.message.includes('authserver.mojang.com') ||
        reason.message.includes('api.minecraftservices.com')) {
      console.log('[MinecraftLauncher] Authentication network error handled gracefully');
      return; // Don't crash the app for authentication network issues
    }
  }
  
  // For other critical errors, we might want to log them differently
  console.error('[MinecraftLauncher] Unhandled rejection details:', promise);
});

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
    
    console.log(`[JavaManager] Looking for Java ${javaVersion} in: ${javaDir}`);
    
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
      
      const fetch = require('node-fetch');
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
      console.log(`[JavaManager] Checking for Java executable...`);
      
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
        const { exec } = require('child_process');
        const { promisify } = require('util');
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
    const AdmZip = require('adm-zip');
    
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
    const { spawn } = require('child_process');
    
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
        const { exec } = require('child_process');
        const { promisify } = require('util');
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

  // Helper method to remove directory with retry logic for Windows
  async removeDirectoryWithRetry(dirPath, maxRetries = 5) {
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

class MinecraftLauncher extends EventEmitter {
  constructor() {
    super();
    this.isLaunching = false;
    this.client = null;
    this.authData = null;
    this.clientPath = null;
    this.javaManager = new JavaManager(); // Initialize without client path initially
    
    // Log system information for debugging
    this.logSystemInfo();
  }
  
  // Log system information to help with debugging
  logSystemInfo() {
    try {
      console.log(`[MinecraftLauncher] System Information:`);
      console.log(`[MinecraftLauncher] - Platform: ${process.platform}`);
      console.log(`[MinecraftLauncher] - Architecture: ${process.arch}`);
      console.log(`[MinecraftLauncher] - Total Memory: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`);
      console.log(`[MinecraftLauncher] - Free Memory: ${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`);
      console.log(`[MinecraftLauncher] - CPU Cores: ${os.cpus().length}`);
      
      // Check file handle limits on Unix systems
      if (process.platform !== 'win32') {
        try {
          const { exec } = require('child_process');
          exec('ulimit -n', (error, stdout) => {
            if (!error) {
              console.log(`[MinecraftLauncher] - File Handle Limit: ${stdout.trim()}`);
            }
          });
        } catch (e) {
          // Ignore errors getting file handle limit
        }
      }
    } catch (error) {
      console.warn(`[MinecraftLauncher] Could not get system information:`, error.message);
    }
  }
  
  // Log current memory usage for debugging
  logMemoryUsage() {
    try {
      const memUsage = process.memoryUsage();
      
      console.log(`[MinecraftLauncher] Memory Usage: RSS=${Math.round(memUsage.rss/1024/1024)}MB, ` +
                  `Heap=${Math.round(memUsage.heapUsed/1024/1024)}MB/${Math.round(memUsage.heapTotal/1024/1024)}MB, ` +
                  `External=${Math.round(memUsage.external/1024/1024)}MB, ` +
                  `Free System=${Math.round(os.freemem()/1024/1024/1024)}GB`);
    } catch (error) {
      // Ignore errors logging memory usage
    }
  }
  
  // Get the correct Java version for a Minecraft version
  getRequiredJavaVersion(minecraftVersion) {
    const version = minecraftVersion.split('.');
    const major = parseInt(version[0]);
    const minor = parseInt(version[1]);
    const patch = parseInt(version[2] || 0);
    
    // Minecraft version to Java version mapping
    if (major === 1) {
      if (minor <= 16) {
        return 8; // Java 8 for MC 1.16 and earlier
      } else if (minor <= 20 || (minor === 20 && patch <= 4)) {
        return 17; // Java 17 for MC 1.17-1.20.4
      } else {
        return 21; // Java 21 for MC 1.20.5+
      }
    }
    
    // Default to Java 17 for unknown versions
    return 17;
  }
  
  // Microsoft Authentication
  async authenticateWithMicrosoft() {
    try {
      console.log('[MinecraftLauncher] Starting Microsoft authentication...');
      
      // Create MSMC Auth instance
      const authManager = new Auth("select_account");
      
      // Launch authentication flow
      const xboxManager = await authManager.launch("electron", {
        /* You can add custom options here */
      });
      
      // Generate the Minecraft login token
      const token = await xboxManager.getMinecraft();
      
      if (token && token.profile) {
        this.authData = {
          access_token: token.mcToken,
          client_token: null, // MSMC doesn't use client_token
          uuid: token.profile.id,
          name: token.profile.name,
          user_properties: {},
          meta: token
        };
        
        console.log(`[MinecraftLauncher] Authentication successful for user: ${token.profile.name}`);
        this.emit('auth-success', { username: token.profile.name, uuid: token.profile.id });
        
        return { success: true, username: token.profile.name, uuid: token.profile.id };
      } else {
        throw new Error('Authentication failed: No token received');
      }
    } catch (error) {
      console.error('[MinecraftLauncher] Authentication error:', error);
      this.emit('auth-error', error.message);
      return { success: false, error: error.message };
    }
  }
  
  // Save authentication data to file
  async saveAuthData(clientPath) {
    if (!this.authData || !clientPath) {
      return { success: false, error: 'No auth data or client path' };
    }
    
    try {
      const authFile = path.join(clientPath, 'auth.json');
      const authDataToSave = {
        ...this.authData,
        savedAt: new Date().toISOString()
      };
      
      fs.writeFileSync(authFile, JSON.stringify(authDataToSave, null, 2));
      console.log('[MinecraftLauncher] Authentication data saved');
      return { success: true };
    } catch (error) {
      console.error('[MinecraftLauncher] Error saving auth data:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Load saved authentication data
  async loadAuthData(clientPath) {
    try {
      const authFile = path.join(clientPath, 'auth.json');
      
      if (!fs.existsSync(authFile)) {
        return { success: false, error: 'No saved authentication found' };
      }
      
      const authDataRaw = fs.readFileSync(authFile, 'utf8');
      const savedAuthData = JSON.parse(authDataRaw);
      
      // Check if auth data is still valid (basic check - tokens may need refresh)
      const savedDate = new Date(savedAuthData.savedAt);
      const now = new Date();
      const hoursSinceSaved = (now - savedDate) / (1000 * 60 * 60);
      
      if (hoursSinceSaved > 24) {
        console.log('[MinecraftLauncher] Saved auth data is old, will need re-authentication');
        return { success: false, error: 'Authentication expired' };
      }
      
      this.authData = savedAuthData;
      console.log(`[MinecraftLauncher] Loaded saved authentication for: ${savedAuthData.name}`);
      
      return { 
        success: true, 
        username: savedAuthData.name, 
        uuid: savedAuthData.uuid,
        needsRefresh: hoursSinceSaved > 1 // Suggest refresh if > 1 hour old
      };
    } catch (error) {
      console.error('[MinecraftLauncher] Error loading auth data:', error);
      return { success: false, error: error.message };
    }
  }
  
  // Reset launcher state - used when launcher gets stuck
  resetLauncherState() {
    console.log(`[MinecraftLauncher] Resetting launcher state...`);
    this.isLaunching = false;
    this.client = null;
    console.log(`[MinecraftLauncher] Launcher state reset complete`);
  }

  // Check if authentication is valid and refresh if needed
  async checkAndRefreshAuth() {
    if (!this.authData) {
      return { success: false, error: 'No authentication data' };
    }
    
    try {
      // Check if we have MSMC meta data for refreshing
      if (this.authData.meta && this.authData.meta.refresh) {
        console.log('[MinecraftLauncher] Attempting to refresh authentication token...');
        
        try {
          // Try to refresh the token using MSMC with timeout and error handling
          const refreshPromise = this.authData.meta.refresh();
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Token refresh timeout')), 10000);
          });
          
          const refreshedToken = await Promise.race([refreshPromise, timeoutPromise]);
          
          if (refreshedToken && refreshedToken.profile) {
            // Update our stored auth data
            this.authData = {
              access_token: refreshedToken.mcToken,
              client_token: null,
              uuid: refreshedToken.profile.id,
              name: refreshedToken.profile.name,
              user_properties: {},
              meta: refreshedToken,
              savedAt: new Date().toISOString()
            };
            
            console.log(`[MinecraftLauncher] Authentication refreshed successfully for: ${refreshedToken.profile.name}`);
            return { success: true, refreshed: true };
          }
        } catch (refreshError) {
          console.warn('[MinecraftLauncher] Token refresh failed (this is often normal):', refreshError.message);
          // Don't treat refresh failures as critical errors - the token might still be valid
          
          // Check if it's a network error and ignore it for downloads
          if (refreshError.message && (
            refreshError.message.includes('ENOTFOUND') ||
            refreshError.message.includes('authserver.mojang.com') ||
            refreshError.message.includes('timeout') ||
            refreshError.message.includes('network')
          )) {
            console.log('[MinecraftLauncher] Network error during token refresh - using existing token');
            return { success: true, refreshed: false, networkError: true };
          }
          
          // For other errors, check token age
        }
      }
      
      // If no refresh capability or refresh failed, check token age
      const savedDate = new Date(this.authData.savedAt);
      const now = new Date();
      const hoursSinceSaved = (now - savedDate) / (1000 * 60 * 60);
      
      if (hoursSinceSaved > 24) { // More lenient token age check
        console.log('[MinecraftLauncher] Authentication token is old, may need refresh');
        return { success: false, error: 'Authentication may be expired', needsReauth: true };
      }
      
      return { success: true, refreshed: false };
      
    } catch (error) {
      console.error('[MinecraftLauncher] Error checking authentication:', error);
      
      // Handle network errors gracefully
      if (error.message && (
        error.message.includes('ENOTFOUND') ||
        error.message.includes('authserver.mojang.com') ||
        error.message.includes('network') ||
        error.message.includes('timeout')
      )) {
        console.log('[MinecraftLauncher] Network error during auth check - proceeding with cached token');
        return { success: true, refreshed: false, networkError: true };
      }
      
      return { success: false, error: error.message, needsReauth: true };
    }
  }
  
  // Debug Java installation - Enhanced version
  // REMOVED: debugJavaInstallation method is no longer needed
  
  // Check Java installation
  async checkJavaInstallation() {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      console.log('[MinecraftLauncher] Checking for Java installation...');
      
      // Try different Java commands - prioritize javaw on Windows to avoid console
      const javaCommands = process.platform === 'win32' ? [
        'javaw', // Windows java without console - PREFERRED
        'java', // Standard java command
        path.join(process.env.JAVA_HOME || '', 'bin', 'javaw'), // JAVA_HOME javaw
        path.join(process.env.JAVA_HOME || '', 'bin', 'java') // JAVA_HOME java
      ] : [
        'java', // Standard java command
        path.join(process.env.JAVA_HOME || '', 'bin', 'java') // JAVA_HOME
      ];
      
      const validCommands = javaCommands.filter(cmd => cmd && cmd !== 'bin\\java' && cmd !== 'bin\\javaw'); // Filter out invalid paths
      
      for (const javaCommand of validCommands) {
        try {
          console.log(`[MinecraftLauncher] Trying Java command: ${javaCommand}`);
          const { stdout, stderr } = await execAsync(`"${javaCommand}" -version`, { timeout: 5000 });
          const output = stdout + stderr; // Java version info often goes to stderr
          
          if (output.includes('version')) {
            console.log(`[MinecraftLauncher] Java found with command: ${javaCommand}`);
            console.log(`[MinecraftLauncher] Java version output: ${output.split('\n')[0]}`);
            
            // Check Java architecture (32-bit vs 64-bit)
            let is64Bit = false;
            try {
              const { stdout: archOutput } = await execAsync(`"${javaCommand}" -d64 -version`, { timeout: 3000 });
              is64Bit = true;
              console.log(`[MinecraftLauncher] Java is 64-bit`);
            } catch (archError) {
              console.log(`[MinecraftLauncher] Java appears to be 32-bit (cannot use -d64 flag)`);
              is64Bit = false;
            }
            
            // Check if it's a reasonable Java version (8 or higher)
            const versionMatch = output.match(/version "?(\d+)\.?(\d*)/);
            if (versionMatch) {
              const majorVersion = parseInt(versionMatch[1]);
              const minorVersion = parseInt(versionMatch[2] || '0');
              
              // Java 8 is version 1.8, Java 9+ is version 9+
              const isValidVersion = majorVersion >= 9 || (majorVersion === 1 && minorVersion >= 8);
              
              if (isValidVersion) {
                return { 
                  success: true, 
                  javaPath: javaCommand,
                  version: versionMatch[0],
                  is64Bit: is64Bit,
                  architecture: is64Bit ? '64-bit' : '32-bit'
                };
              } else {
                console.warn(`[MinecraftLauncher] Java version ${versionMatch[0]} is too old, need Java 8 or higher`);
              }
            } else {
              return { 
                success: true, 
                javaPath: javaCommand,
                version: 'unknown',
                is64Bit: is64Bit,
                architecture: is64Bit ? '64-bit' : '32-bit'
              };
            }
          }
        } catch (cmdError) {
          console.log(`[MinecraftLauncher] Java command '${javaCommand}' failed: ${cmdError.message}`);
        }
      }
      
      // If no Java found, provide helpful error message
      return { 
        success: false, 
        error: 'Java not found. Please install Java 8 or higher from https://adoptopenjdk.net/ or https://www.oracle.com/java/technologies/downloads/'
      };
      
    } catch (error) {
      console.error('[MinecraftLauncher] Error checking Java installation:', error);
      return { 
        success: false, 
        error: `Failed to check Java installation: ${error.message}`
      };
    }
  }
  
  // Download Minecraft client files for a specific version (simplified approach)
  async downloadMinecraftClientSimple(clientPath, minecraftVersion, options = {}) {
    console.log('🎯 DOWNLOAD STARTED - Method called with params:', { clientPath, minecraftVersion, options });
    
    this.emit('client-download-start', { version: minecraftVersion });
    
    // Extract options
    const { 
      requiredMods = [], 
      serverInfo = null 
    } = options;
    
    // Determine if Fabric is needed
    const needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
    let fabricVersion = serverInfo?.loaderVersion || 'latest';
    
    console.log(`[MinecraftLauncher] Download with Fabric requirements: needsFabric=${needsFabric}, version=${fabricVersion}`);
    
    // More conservative retry mechanism for EMFILE errors
    const maxRetries = 2; // Reduced retries
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        console.log(`[MinecraftLauncher] Downloading Minecraft ${minecraftVersion} client files... (attempt ${retryCount + 1}/${maxRetries})`);
        
        // Add longer delay between retries to allow system cleanup
        if (retryCount > 0) {
          console.log(`[MinecraftLauncher] Waiting 10 seconds before retry for system cleanup...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
        
        // Force garbage collection and wait
        if (global.gc) {
          global.gc();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // First, ensure Java is available for this Minecraft version
        const requiredJavaVersion = this.getRequiredJavaVersion(minecraftVersion);
        console.log(`[MinecraftLauncher] Ensuring Java ${requiredJavaVersion} is available for Minecraft ${minecraftVersion}...`);
        
        this.emit('client-download-progress', {
          type: 'Java',
          task: `Checking Java ${requiredJavaVersion}...`,
          total: 1
        });
        
        const javaResult = await this.javaManager.ensureJava(requiredJavaVersion, (progress) => {
          this.emit('client-download-progress', {
            type: progress.type,
            task: progress.task,
            total: progress.totalMB || 0,
            current: progress.downloadedMB || 0
          });
        });
        
        if (!javaResult.success) {
          throw new Error(`Failed to obtain Java ${requiredJavaVersion}: ${javaResult.error}`);
        }
        
        console.log(`[MinecraftLauncher] Java ${requiredJavaVersion} is ready: ${javaResult.javaPath}`);
        
        // Create client directories if they don't exist
        const essentialDirs = ['versions', 'libraries', 'assets', 'mods'];
        for (const dir of essentialDirs) {
          const dirPath = path.join(clientPath, dir);
          if (!fs.existsSync(dirPath)) {
            console.log(`[MinecraftLauncher] Creating directory: ${dirPath}`);
            fs.mkdirSync(dirPath, { recursive: true });
          }
        }
        
        this.emit('client-download-progress', {
          type: 'Preparing',
          task: 'Setting up download process...',
          total: 1
        });
        
        // Use minecraft-launcher-core's built-in download capabilities with conservative settings
        const { Client } = require('minecraft-launcher-core');
        const downloadClient = new Client();
        
        // Set up event listeners for download progress with error handling
        downloadClient.on('debug', (e) => console.log(`[MCLC Download Debug] ${e}`));
        downloadClient.on('data', (e) => console.log(`[MCLC Download Data] ${e}`));
        downloadClient.on('progress', (e) => {
          console.log(`[MCLC Download Progress] ${e.type}: ${e.task} (${e.total})`);
          this.emit('client-download-progress', {
            type: e.type,
            task: e.task,
            total: e.total
          });
          
          // Log memory usage during download
          if (e.total && e.total % 10 === 0) { // Every 10th progress update
            this.logMemoryUsage();
          }
        });
        
        // Add error handling for the download client
        downloadClient.on('error', (error) => {
          console.error(`[MCLC Download Error] ${error.message}`);
        });
        
        console.log(`[MinecraftLauncher] Starting download process for ${minecraftVersion}...`);
        
        this.emit('client-download-progress', {
          type: 'Downloading',
          task: 'Downloading Minecraft version, libraries, and assets...',
          total: 3
        });
        
        // Try alternative download approach - use node-minecraft-protocol if available
        let downloadSuccess = false;
        
        console.log('⭐⭐⭐ ABOUT TO TRY MANUAL DOWNLOAD APPROACH ⭐⭐⭐');
        
        // First, try the manual download approach since MCLC might have network issues
        try {
          console.log(`[MinecraftLauncher] ========== ATTEMPTING MANUAL MINECRAFT DOWNLOAD ==========`);
          console.log(`[MinecraftLauncher] Client path: ${clientPath}`);
          console.log(`[MinecraftLauncher] Minecraft version: ${minecraftVersion}`);
          console.log(`[MinecraftLauncher] Java path: ${javaResult.javaPath}`);
          
          // Check JAR file BEFORE manual download
          const preDownloadJarPath = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.jar`);
          if (fs.existsSync(preDownloadJarPath)) {
            const preStats = fs.statSync(preDownloadJarPath);
            console.log(`[MinecraftLauncher] 🔍 PRE-DOWNLOAD: JAR exists with ${preStats.size} bytes`);
          } else {
            console.log(`[MinecraftLauncher] 🔍 PRE-DOWNLOAD: JAR does not exist yet`);
          }
          
          downloadSuccess = await this.downloadMinecraftManually(clientPath, minecraftVersion, javaResult.javaPath);
          console.log(`[MinecraftLauncher] ========== MANUAL DOWNLOAD COMPLETED: ${downloadSuccess} ==========`);
          
          // Check JAR file AFTER manual download
          if (fs.existsSync(preDownloadJarPath)) {
            const postStats = fs.statSync(preDownloadJarPath);
            console.log(`[MinecraftLauncher] 🔍 POST-DOWNLOAD: JAR exists with ${postStats.size} bytes`);
          } else {
            console.log(`[MinecraftLauncher] 🔍 POST-DOWNLOAD: JAR does not exist!`);
          }
        } catch (manualError) {
          console.error(`[MinecraftLauncher] Manual download failed with detailed error:`, manualError);
          console.error(`[MinecraftLauncher] Error stack:`, manualError.stack);
          console.log(`[MinecraftLauncher] Manual download failed, falling back to MCLC: ${manualError.message}`);
        }
        
                // If manual download failed, we need to throw an error instead of using MCLC
        // MCLC has been causing auto-launch issues during download
        if (!downloadSuccess) {
          throw new Error('Manual download failed. MCLC download is disabled to prevent auto-launch issues. Please check your internet connection and try again.');
        }
        
        this.emit('client-download-progress', {
          type: 'Verifying',
          task: 'Verifying downloaded files...',
          total: 4
        });
        
        // Wait longer for files to finish writing and all handles to be released
        console.log(`[MinecraftLauncher] Waiting for file operations to complete...`);
        await new Promise(resolve => setTimeout(resolve, 8000)); // Increased wait time
        
        // Force cleanup
        if (global.gc) {
          global.gc();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Verify that the vanilla download was successful
        console.log(`[MinecraftLauncher] Verifying vanilla Minecraft download...`);
        
        // First, let's check what files were actually created
        const versionsDir = path.join(clientPath, 'versions');
        const versionDir = path.join(versionsDir, minecraftVersion);
        const jarFile = path.join(versionDir, `${minecraftVersion}.jar`);
        
        console.log(`[MinecraftLauncher] Checking download results:`);
        console.log(`[MinecraftLauncher] - Versions dir exists: ${fs.existsSync(versionsDir)}`);
        console.log(`[MinecraftLauncher] - Version dir exists: ${fs.existsSync(versionDir)}`);
        console.log(`[MinecraftLauncher] - JAR file exists: ${fs.existsSync(jarFile)}`);
        
        if (fs.existsSync(jarFile)) {
          const jarStats = fs.statSync(jarFile);
          console.log(`[MinecraftLauncher] - JAR file size: ${jarStats.size} bytes`);
          
          if (jarStats.size === 0) {
            console.error(`[MinecraftLauncher] JAR file is empty! Download failed.`);
            
            // List what's actually in the versions directory
            try {
              if (fs.existsSync(versionsDir)) {
                const versionsList = fs.readdirSync(versionsDir);
                console.log(`[MinecraftLauncher] Versions directory contents: ${versionsList.join(', ')}`);
                
                if (fs.existsSync(versionDir)) {
                  const versionContents = fs.readdirSync(versionDir);
                  console.log(`[MinecraftLauncher] Version ${minecraftVersion} directory contents: ${versionContents.join(', ')}`);
                }
              }
            } catch (debugError) {
              console.error(`[MinecraftLauncher] Error debugging directory contents:`, debugError);
            }
            
            throw new Error(`Download failed: Minecraft JAR file is empty. This usually indicates a network connectivity issue or the download was interrupted.`);
          }
        } else {
          console.error(`[MinecraftLauncher] JAR file was not created at all!`);
        }
        
        const vanillaVerificationResult = await this.checkMinecraftClient(clientPath, minecraftVersion);
        
        if (!vanillaVerificationResult.synchronized) {
          console.error(`[MinecraftLauncher] Vanilla verification failed:`, vanillaVerificationResult);
          throw new Error(`Vanilla client download verification failed: ${vanillaVerificationResult.reason}`);
        }
        
        console.log(`[MinecraftLauncher] Successfully downloaded and verified vanilla Minecraft ${minecraftVersion}`);
        
        // Install Fabric if needed
        let finalVersion = minecraftVersion;
        let fabricProfileName = null;
        
        if (needsFabric) {
          console.log(`[MinecraftLauncher] Installing Fabric loader ${fabricVersion} for Minecraft ${minecraftVersion}...`);
          
          // Check JAR file BEFORE Fabric installation
          const vanillaJarPath = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.jar`);
          if (fs.existsSync(vanillaJarPath)) {
            const preFabricStats = fs.statSync(vanillaJarPath);
            console.log(`[MinecraftLauncher] 🔍 PRE-FABRIC: Vanilla JAR exists with ${preFabricStats.size} bytes`);
          } else {
            console.log(`[MinecraftLauncher] 🔍 PRE-FABRIC: Vanilla JAR does not exist!`);
          }
          
          this.emit('client-download-progress', {
            type: 'Fabric',
            task: `Installing Fabric loader ${fabricVersion}...`,
            total: 5
          });
          
          try {
            const fabricResult = await this.installFabricLoader(clientPath, minecraftVersion, fabricVersion);
            
            if (fabricResult.success) {
              fabricProfileName = fabricResult.profileName;
              finalVersion = fabricProfileName;
              console.log(`[MinecraftLauncher] Fabric installed successfully. Profile: ${fabricProfileName}`);
              
              // Check JAR file AFTER Fabric installation
              if (fs.existsSync(vanillaJarPath)) {
                const postFabricStats = fs.statSync(vanillaJarPath);
                console.log(`[MinecraftLauncher] 🔍 POST-FABRIC: Vanilla JAR exists with ${postFabricStats.size} bytes`);
              } else {
                console.log(`[MinecraftLauncher] 🔍 POST-FABRIC: Vanilla JAR does not exist!`);
              }
              
              this.emit('client-download-progress', {
                type: 'Fabric',
                task: `Fabric ${fabricVersion} installed successfully`,
                total: 5
              });
            } else {
              throw new Error(`Fabric installation failed: ${fabricResult.error}`);
            }
          } catch (fabricError) {
            console.error(`[MinecraftLauncher] Fabric installation failed:`, fabricError);
            throw new Error(`Cannot install Fabric for modded client: ${fabricError.message}`);
          }
        }
        
        // Final verification with the correct version (Fabric or vanilla)
        console.log(`[MinecraftLauncher] 🔍 STARTING FINAL VERIFICATION for ${minecraftVersion}...`);
        
        // Check JAR file RIGHT BEFORE final verification
        const finalVerificationJarPath = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.jar`);
        if (fs.existsSync(finalVerificationJarPath)) {
          const finalVerificationStats = fs.statSync(finalVerificationJarPath);
          console.log(`[MinecraftLauncher] 🔍 FINAL-VERIFICATION: Vanilla JAR exists with ${finalVerificationStats.size} bytes`);
        } else {
          console.log(`[MinecraftLauncher] 🔍 FINAL-VERIFICATION: Vanilla JAR does not exist!`);
        }
        
        const finalVerificationOptions = needsFabric ? { requiredMods, serverInfo } : {};
        const finalVerificationResult = await this.checkMinecraftClient(clientPath, minecraftVersion, finalVerificationOptions);
        
        console.log(`[MinecraftLauncher] 🔍 FINAL VERIFICATION RESULT:`, finalVerificationResult);
        
        if (finalVerificationResult.synchronized) {
          const clientType = needsFabric ? `Fabric ${fabricVersion}` : 'Vanilla';
          const finalMessage = `Successfully downloaded Minecraft ${minecraftVersion} (${clientType}) with Java ${requiredJavaVersion} and all required libraries and assets.`;
          
          console.log(`[MinecraftLauncher] ${finalMessage}`);
          
          this.emit('client-download-complete', { 
            success: true, 
            version: finalVersion,
            vanillaVersion: minecraftVersion,
            fabricVersion: needsFabric ? fabricVersion : null,
            fabricProfileName: fabricProfileName,
            message: finalMessage
          });
          
          return { 
            success: true, 
            version: finalVersion,
            vanillaVersion: minecraftVersion,
            fabricVersion: needsFabric ? fabricVersion : null,
            fabricProfileName: fabricProfileName,
            message: finalMessage
          };
        } else {
          console.log('💀💀💀 FINAL VERIFICATION FAILED - THIS DEBUG MESSAGE PROVES THE CODE IS RUNNING 💀💀💀');
          console.log(`💀 Verification result: ${JSON.stringify(finalVerificationResult, null, 2)}`);
          throw new Error(`Final verification failed: ${finalVerificationResult.reason}`);
        }
        
      } catch (error) {
        console.error(`[MinecraftLauncher] Failed to download Minecraft ${minecraftVersion} (attempt ${retryCount + 1}):`, error);
        
        // Check if this is an EMFILE error and we have retries left
        if ((error.code === 'EMFILE' || error.message.includes('too many open files')) && retryCount < maxRetries - 1) {
          console.log(`[MinecraftLauncher] EMFILE error detected, will retry after cleanup...`);
          
          // Force garbage collection and longer cleanup
          if (global.gc) {
            global.gc();
          }
          
          retryCount++;
          continue; // Try again
        }
        
        // If it's not an EMFILE error or we're out of retries, handle the error
        let errorMessage = error.message;
        if (error.code === 'EMFILE' || error.message.includes('too many open files')) {
          errorMessage = 'System file limit reached during download. Please close other applications, restart the application, and try again.';
        } else if (error.message && error.message.includes('ENOTFOUND')) {
          errorMessage = 'Cannot connect to Minecraft download servers. Please check your internet connection.';
        } else if (error.message && error.message.includes('timeout')) {
          errorMessage = 'Download timed out. Please try again with a better internet connection.';
        }
        
        this.emit('client-download-error', { 
          error: errorMessage, 
          version: minecraftVersion 
        });
        return { success: false, error: errorMessage };
      }
    }
  }
  
  // Manual download method as fallback when MCLC fails
  async downloadMinecraftManually(clientPath, minecraftVersion, javaPath) {
    console.log('💥💥💥 DOWNLOADMINECRAFTMANUALLY METHOD CALLED WITH NEW CODE 💥💥💥');
    console.log(`[MinecraftLauncher] ########## ENTERED downloadMinecraftManually METHOD ##########`);
    console.log(`[MinecraftLauncher] Starting manual download for Minecraft ${minecraftVersion}`);
    console.log(`[MinecraftLauncher] Client path: ${clientPath}`);
    console.log(`[MinecraftLauncher] Java path: ${javaPath}`);
    
    try {
      const https = require('https');
      const fs = require('fs');
      const path = require('path');
      
      // Create directories
      const versionsDir = path.join(clientPath, 'versions');
      const versionDir = path.join(versionsDir, minecraftVersion);
      const librariesDir = path.join(clientPath, 'libraries');
      const assetsDir = path.join(clientPath, 'assets');
      
      if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir, { recursive: true });
      if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });
      if (!fs.existsSync(librariesDir)) fs.mkdirSync(librariesDir, { recursive: true });
      if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
      
      // Download version manifest
      console.log(`[MinecraftLauncher] Manual download: Getting version manifest...`);
      const manifestUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
      const manifest = await this.downloadJson(manifestUrl);
      
      // Find version info
      const versionInfo = manifest.versions.find(v => v.id === minecraftVersion);
      if (!versionInfo) {
        throw new Error(`Version ${minecraftVersion} not found in manifest`);
      }
      
      // Download version details
      console.log(`[MinecraftLauncher] Manual download: Getting version details...`);
      const versionDetails = await this.downloadJson(versionInfo.url);
      
      // Save version JSON
      const versionJsonPath = path.join(versionDir, `${minecraftVersion}.json`);
      fs.writeFileSync(versionJsonPath, JSON.stringify(versionDetails, null, 2));
      
      // Download client JAR
      console.log(`[MinecraftLauncher] 🎯 CRITICAL JAR DOWNLOAD STARTING...`);
      const clientJarPath = path.join(versionDir, `${minecraftVersion}.jar`);
      console.log(`[MinecraftLauncher] 🎯 JAR URL: ${versionDetails.downloads.client.url}`);
      console.log(`[MinecraftLauncher] 🎯 JAR destination: ${clientJarPath}`);
      console.log(`[MinecraftLauncher] 🎯 Expected JAR size: ${versionDetails.downloads.client.size} bytes`);
      
      // Remove any existing empty JAR file
      if (fs.existsSync(clientJarPath)) {
        const existingStats = fs.statSync(clientJarPath);
        console.log(`[MinecraftLauncher] 🎯 Removing existing JAR file (${existingStats.size} bytes)...`);
        fs.unlinkSync(clientJarPath);
      }
      
      try {
        console.log(`[MinecraftLauncher] 🎯 Starting JAR download...`);
        await this.downloadFile(versionDetails.downloads.client.url, clientJarPath);
        console.log(`[MinecraftLauncher] 🎯 JAR download method completed, checking result...`);
        
        // Immediate verification
        if (fs.existsSync(clientJarPath)) {
          const downloadedStats = fs.statSync(clientJarPath);
          console.log(`[MinecraftLauncher] 🎯 JAR file created successfully: ${downloadedStats.size} bytes`);
          
          if (downloadedStats.size === 0) {
            console.error(`[MinecraftLauncher] 🚨 CRITICAL: JAR file is empty after download!`);
            throw new Error('JAR download created empty file');
          }
          
          if (downloadedStats.size < 1000000) { // Less than 1MB is suspicious for Minecraft JAR
            console.warn(`[MinecraftLauncher] ⚠️ WARNING: JAR file seems too small (${downloadedStats.size} bytes)`);
          }
          
        } else {
          console.error(`[MinecraftLauncher] 🚨 CRITICAL: JAR file was not created at all!`);
          throw new Error('JAR download failed - file not created');
        }
        
      } catch (jarDownloadError) {
        console.error(`[MinecraftLauncher] 🚨 JAR download failed:`, jarDownloadError);
        throw new Error(`Failed to download client JAR: ${jarDownloadError.message}`);
      }
      
      // Verify JAR was downloaded and has content
      if (!fs.existsSync(clientJarPath)) {
        console.error(`[MinecraftLauncher] JAR file does not exist at: ${clientJarPath}`);
        throw new Error('Client JAR was not downloaded');
      }
      
      const jarStats = fs.statSync(clientJarPath);
      console.log(`[MinecraftLauncher] JAR file size: ${jarStats.size} bytes`);
      
      if (jarStats.size === 0) {
        console.error(`[MinecraftLauncher] JAR file is empty! This indicates a download failure.`);
        
        // Try to get more information about what happened
        try {
          const versionDirContents = fs.readdirSync(versionDir);
          console.error(`[MinecraftLauncher] Version directory contents: ${versionDirContents.join(', ')}`);
        } catch (dirError) {
          console.error(`[MinecraftLauncher] Could not read version directory: ${dirError.message}`);
        }
        
        throw new Error('Client JAR is empty - download failed');
      }
      
      console.log(`[MinecraftLauncher] Manual download: Client JAR downloaded successfully (${jarStats.size} bytes)`);
      
      // Download ALL required libraries - this is essential for a complete installation
      console.log(`[MinecraftLauncher] Manual download: Downloading all required libraries...`);
      let librariesDownloaded = 0;
      let librariesFailed = 0;
      
      if (versionDetails.libraries && versionDetails.libraries.length > 0) {
        console.log(`[MinecraftLauncher] Total libraries to download: ${versionDetails.libraries.length}`);
        
        for (const library of versionDetails.libraries) {
          // Check if library is allowed for this OS
          if (library.rules) {
            console.log(`[MinecraftLauncher] Checking rules for library ${library.name}, process.platform=${process.platform}`);
            const isAllowed = library.rules.every(rule => {
              console.log(`[MinecraftLauncher] Rule: ${JSON.stringify(rule)}`);
              if (rule.action === 'allow') {
                if (rule.os) {
                  const allowed = rule.os.name === process.platform || 
                                 (rule.os.name === 'windows' && process.platform === 'win32') ||
                                 (rule.os.name === 'osx' && process.platform === 'darwin') ||
                                 (rule.os.name === 'linux' && process.platform === 'linux');
                  console.log(`[MinecraftLauncher] Allow rule: OS ${rule.os.name} vs platform ${process.platform} = ${allowed}`);
                  return allowed;
                }
                return true;
              } else if (rule.action === 'disallow') {
                if (rule.os) {
                  const disallowed = rule.os.name === process.platform || 
                                   (rule.os.name === 'windows' && process.platform === 'win32') ||
                                   (rule.os.name === 'osx' && process.platform === 'darwin') ||
                                   (rule.os.name === 'linux' && process.platform === 'linux');
                  console.log(`[MinecraftLauncher] Disallow rule: OS ${rule.os.name} vs platform ${process.platform} = ${!disallowed}`);
                  return !disallowed;
                }
                return false;
              }
              return true;
            });
            
            if (!isAllowed) {
              console.log(`[MinecraftLauncher] Skipping library ${library.name} (not allowed for this OS)`);
              continue;
            } else {
              console.log(`[MinecraftLauncher] Library ${library.name} is allowed for this OS`);
            }
          }
          
          if (library.downloads && library.downloads.artifact) {
            try {
              const libUrl = library.downloads.artifact.url;
              const libPath = path.join(librariesDir, library.downloads.artifact.path);
              
              // Create library directory structure
              const libDir = path.dirname(libPath);
              if (!fs.existsSync(libDir)) {
                fs.mkdirSync(libDir, { recursive: true });
              }
              
              await this.downloadFile(libUrl, libPath);
              librariesDownloaded++;
              console.log(`[MinecraftLauncher] Downloaded library: ${library.name}`);
            } catch (libError) {
              console.warn(`[MinecraftLauncher] Failed to download library ${library.name}: ${libError.message}`);
              librariesFailed++;
            }
          }
        }
      }
      
      console.log(`[MinecraftLauncher] Manual download: Downloaded ${librariesDownloaded} libraries (${librariesFailed} failed)`);
      
      // Create a complete assets structure
      console.log(`[MinecraftLauncher] Manual download: Setting up assets structure...`);
      const assetsIndexesDir = path.join(assetsDir, 'indexes');
      const assetsObjectsDir = path.join(assetsDir, 'objects');
      
      if (!fs.existsSync(assetsIndexesDir)) fs.mkdirSync(assetsIndexesDir, { recursive: true });
      if (!fs.existsSync(assetsObjectsDir)) fs.mkdirSync(assetsObjectsDir, { recursive: true });
      
      // Download and properly prepare asset index for MCLC
      if (versionDetails.assetIndex) {
        const assetIndexUrl = versionDetails.assetIndex.url;
        const assetIndexFile = path.join(assetsIndexesDir, `${versionDetails.assetIndex.id}.json`);
        
        try {
          console.log(`[MinecraftLauncher] 🎯 Downloading official asset index from: ${assetIndexUrl}`);
          await this.downloadFile(assetIndexUrl, assetIndexFile);
          console.log(`[MinecraftLauncher] Downloaded asset index: ${versionDetails.assetIndex.id}`);
          
          // Read and parse the downloaded asset index
          const rawIndexData = fs.readFileSync(assetIndexFile, 'utf8');
          const assetIndexData = JSON.parse(rawIndexData);
          
          // CRITICAL FIX: Augment each object with the URL that MCLC expects
          const baseUrl = 'https://resources.download.minecraft.net';
          const objects = assetIndexData.objects || {};
          console.log(`[MinecraftLauncher] 🎯 Asset index contains ${Object.keys(objects).length} entries`);
          
          // Inject proper URL into each entry so MCLC can read them
          for (const [relPath, info] of Object.entries(objects)) {
            // hashPrefix = first two hex chars of SHA1
            const prefix = info.hash.slice(0, 2);
            info.url = `${baseUrl}/${prefix}/${info.hash}`;
          }
          
          // Write back the augmented index with URLs in place
          const completeIndex = {
            _comment: "auto-generated index with url fields for MCLC compatibility",
            objects: objects
          };
          
          fs.writeFileSync(assetIndexFile, JSON.stringify(completeIndex, null, 2));
          console.log(`[MinecraftLauncher] 🎯 Augmented asset index written with URLs for ${Object.keys(objects).length} objects`);
          
          // Validate the index is well-formed before proceeding
          const validationObjects = Object.values(objects);
          const invalidEntries = validationObjects.filter(obj => !obj.url || !obj.hash);
          
          if (invalidEntries.length > 0) {
            throw new Error(`Asset index validation failed: ${invalidEntries.length} entries missing url or hash`);
          }
          
          console.log(`[MinecraftLauncher] ✅ Asset index validated: ${validationObjects.length} entries with proper URLs`);
          
          // Create basic object directory structure (MCLC will populate it)
          const hashDirs = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
          for (const hashDir of hashDirs) {
            const objectDir = path.join(assetsObjectsDir, hashDir);
            if (!fs.existsSync(objectDir)) {
              fs.mkdirSync(objectDir, { recursive: true });
            }
          }
          
          console.log(`[MinecraftLauncher] 🎯 Asset structure prepared - MCLC will handle actual downloads`);
          
        } catch (indexError) {
          console.error(`[MinecraftLauncher] ❌ Failed to download or process asset index: ${indexError.message}`);
          throw new Error(`Asset index preparation failed: ${indexError.message}. Cannot proceed without proper asset index.`);
        }
        
      } else {
        throw new Error('No asset index found in version details - cannot create proper asset structure');
      }
      
      // Final validation to ensure we have the minimum required files
      const finalJarPath = path.join(versionDir, `${minecraftVersion}.jar`);
      const finalJsonPath = path.join(versionDir, `${minecraftVersion}.json`);
      
      if (!fs.existsSync(finalJarPath) || fs.statSync(finalJarPath).size === 0) {
        throw new Error('Manual download failed: Client JAR file is missing or empty');
      }
      
      if (!fs.existsSync(finalJsonPath) || fs.statSync(finalJsonPath).size === 0) {
        throw new Error('Manual download failed: Version JSON file is missing or empty');
      }
      
      const librariesContents = fs.readdirSync(librariesDir);
      if (librariesContents.length === 0) {
        throw new Error('Manual download failed: No libraries were downloaded');
      }
      
      const assetsContents = fs.readdirSync(assetsDir);
      if (assetsContents.length === 0) {
        throw new Error('Manual download failed: No assets were downloaded');
      }
      
      console.log(`[MinecraftLauncher] Manual download completed successfully:`);
      console.log(`[MinecraftLauncher] - JAR: ${fs.statSync(finalJarPath).size} bytes`);
      console.log(`[MinecraftLauncher] - JSON: ${fs.statSync(finalJsonPath).size} bytes`);
      console.log(`[MinecraftLauncher] - Libraries: ${librariesDownloaded} downloaded, ${librariesFailed} failed`);
      console.log(`[MinecraftLauncher] - Assets: Structure created with ${assetsContents.length} items`);
      
      return true;
      
    } catch (error) {
      console.error(`[MinecraftLauncher] Manual download failed:`, error);
      throw error;
    }
  }
  
  // Helper method to download JSON with retry logic
  async downloadJson(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this._downloadJsonSingle(url);
      } catch (error) {
        console.warn(`[MinecraftLauncher] JSON download attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);
        
        if (attempt === maxRetries) {
          throw new Error(`Failed to download JSON from ${url} after ${maxRetries} attempts: ${error.message}`);
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  
  // Single JSON download attempt
  async _downloadJsonSingle(url) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const timeout = 15000; // 15 second timeout for JSON
      
      const request = https.get(url, { timeout }, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return this._downloadJsonSingle(response.headers.location).then(resolve, reject);
        }
        
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        }
        
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (parseError) {
            reject(new Error(`Invalid JSON response: ${parseError.message}`));
          }
        });
        response.on('error', reject);
      });
      
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('JSON download timeout'));
      });
      
      request.on('error', reject);
    });
  }
  
  // Helper method to download file with retry logic
  async downloadFile(url, filePath, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this._downloadFileSingle(url, filePath);
        return; // Success
      } catch (error) {
        console.warn(`[MinecraftLauncher] Download attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);
        
        if (attempt === maxRetries) {
          throw new Error(`Failed to download ${url} after ${maxRetries} attempts: ${error.message}`);
        }
        
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  
  // Single download attempt
  async _downloadFileSingle(url, filePath) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const fs = require('fs');
      
      console.log(`[MinecraftLauncher] 🎯 _downloadFileSingle STARTING: ${url} -> ${filePath}`);
      
      const file = fs.createWriteStream(filePath);
      const timeout = 60000; // Increased timeout to 60 seconds for large files
      
      let downloadedBytes = 0;
      let totalBytes = 0;
      
      const request = https.get(url, { timeout }, (response) => {
        console.log(`[MinecraftLauncher] Download response status: ${response.statusCode}`);
        
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          console.log(`[MinecraftLauncher] Following redirect to: ${response.headers.location}`);
          file.close();
          fs.unlink(filePath, () => {});
          return this._downloadFileSingle(response.headers.location, filePath).then(resolve, reject);
        }
        
        if (response.statusCode !== 200) {
          console.error(`[MinecraftLauncher] Download failed with status ${response.statusCode}: ${response.statusMessage}`);
          file.close();
          fs.unlink(filePath, () => {});
          return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        }
        
        // Get content length for progress tracking
        totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        console.log(`[MinecraftLauncher] Download content length: ${totalBytes} bytes (${Math.round(totalBytes / 1024 / 1024 * 100) / 100} MB)`);
        
        // Track download progress
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0 && downloadedBytes % (1024 * 1024) === 0) { // Log every MB
            const progress = Math.round((downloadedBytes / totalBytes) * 100);
            console.log(`[MinecraftLauncher] Download progress: ${progress}% (${Math.round(downloadedBytes / 1024 / 1024)} MB / ${Math.round(totalBytes / 1024 / 1024)} MB)`);
          }
        });
        
        response.pipe(file);
        
        file.on('finish', () => {
          console.log(`[MinecraftLauncher] 🎯 Download stream finished: ${downloadedBytes} bytes downloaded`);
          file.close();
          
          // Wait a moment for file system to flush
          setTimeout(() => {
            // Verify the file was actually written
            try {
              const stats = fs.statSync(filePath);
              console.log(`[MinecraftLauncher] 🎯 File verification: ${stats.size} bytes on disk (expected: ${downloadedBytes})`);
              
              if (stats.size === 0) {
                console.error(`[MinecraftLauncher] 🚨 File is empty on disk despite downloading ${downloadedBytes} bytes!`);
                reject(new Error('Downloaded file is empty on disk'));
                return;
              }
              
              if (stats.size !== downloadedBytes) {
                console.warn(`[MinecraftLauncher] ⚠️ Size mismatch: downloaded ${downloadedBytes} bytes but file is ${stats.size} bytes`);
              }
              
              console.log(`[MinecraftLauncher] 🎯 Download verification successful: ${filePath} (${stats.size} bytes)`);
              resolve();
              
            } catch (statError) {
              console.error(`[MinecraftLauncher] 🚨 File verification failed:`, statError);
              reject(new Error(`Could not verify downloaded file: ${statError.message}`));
              return;
            }
          }, 500); // Wait 500ms for file system
        });
        
        file.on('error', (error) => {
          console.error(`[MinecraftLauncher] File write error:`, error);
          fs.unlink(filePath, () => {}); // Delete partial file
          reject(error);
        });
        
        response.on('error', (error) => {
          console.error(`[MinecraftLauncher] Response error:`, error);
          fs.unlink(filePath, () => {}); // Delete partial file
          reject(error);
        });
      });
      
      request.on('timeout', () => {
        console.error(`[MinecraftLauncher] Download timeout after 60 seconds`);
        request.destroy();
        file.close();
        fs.unlink(filePath, () => {});
        reject(new Error('Download timeout'));
      });
      
      request.on('error', (error) => {
        console.error(`[MinecraftLauncher] Request error:`, error);
        file.close();
        fs.unlink(filePath, () => {}); // Delete partial file
        reject(error);
      });
    });
  }
  
  // Launch Minecraft client
  async launchMinecraft(options) {
    const {
      clientPath,
      minecraftVersion,
      serverIp,
      serverPort,
      requiredMods = [],
      serverInfo = null,
      maxMemory = null // Accept memory setting from client
    } = options;
    
    // CRITICAL: Check if this is a Fabric server and we need Fabric client
    const needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
    let fabricVersion = serverInfo?.loaderVersion || 'latest';
    
    console.log(`[MinecraftLauncher] Starting launch for Minecraft ${minecraftVersion} with ${maxMemory || 'auto'}MB RAM`);
    console.log(`[MinecraftLauncher] Needs Fabric: ${needsFabric}, Fabric version: ${fabricVersion}`);
    
    if (!this.authData) {
      throw new Error('Not authenticated. Please login first.');
    }
    
    if (this.isLaunching) {
      // Check if we're actually launching or just stuck in launching state
      let actuallyLaunching = false;
      
      if (this.client && this.client.child) {
        try {
          // Check if the process is still alive
          const pid = this.client.child.pid;
          if (pid) {
            process.kill(pid, 0); // Signal 0 just tests if process exists
            actuallyLaunching = true;
          }
        } catch (e) {
          // Process doesn't exist, we're stuck in launching state
          actuallyLaunching = false;
        }
      }
      
      if (actuallyLaunching) {
        throw new Error('Minecraft is already launching');
      } else {
        console.log(`[MinecraftLauncher] Launcher was stuck in launching state, resetting...`);
        this.resetLauncherState();
      }
    }
    
    this.isLaunching = true;
    this.clientPath = clientPath;
    
    // Update JavaManager to use client-specific directory
    this.javaManager.setClientPath(clientPath);
    
    try {
      console.log(`[MinecraftLauncher] Launching Minecraft ${minecraftVersion} for ${this.authData.name}`);
      console.log(`[MinecraftLauncher] Client path: ${clientPath}`);
      console.log(`[MinecraftLauncher] Java will be downloaded to: ${path.join(clientPath, 'java')}`);
      
      // Determine the launch version based on what's available
      let launchVersion = minecraftVersion; // Default to vanilla
      
      if (needsFabric) {
        // Get the Fabric profile name that should have been installed during client download
        if (fabricVersion === 'latest') {
          try {
            const fetch = require('node-fetch');
            const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
            const loaders = await response.json();
            fabricVersion = loaders[0].version;
          } catch (error) {
            fabricVersion = '0.14.21'; // Fallback version
          }
        }
        
        const fabricProfileName = `fabric-loader-${fabricVersion}-${minecraftVersion}`;
        const fabricProfileDir = path.join(clientPath, 'versions', fabricProfileName);
        
        if (fs.existsSync(fabricProfileDir)) {
          launchVersion = fabricProfileName;
          console.log(`[MinecraftLauncher] Using existing Fabric profile: ${fabricProfileName}`);
        } else {
          throw new Error(`Fabric profile ${fabricProfileName} not found. Please download the client files first.`);
        }
      }
      
      console.log(`[MinecraftLauncher] Launch version: ${launchVersion} (${needsFabric ? 'Fabric' : 'Vanilla'})`);
      
      // Fix Fabric asset index if needed
      if (needsFabric) {
        console.log(`[MinecraftLauncher] Fixing Fabric profile asset index for MCLC compatibility...`);
        await this.fixFabricAssetIndex(clientPath, launchVersion, minecraftVersion);
      }
      
      // Determine required Java version and ensure it's available
      const requiredJavaVersion = this.getRequiredJavaVersion(minecraftVersion);
      console.log(`[MinecraftLauncher] Minecraft ${minecraftVersion} requires Java ${requiredJavaVersion}`);
      
      let javaResult;
      try {
        // Try our client-specific downloaded Java first
        this.emit('launch-progress', {
          type: 'Java',
          task: `Ensuring Java ${requiredJavaVersion} is available...`,
          total: 0
        });
        
        console.log(`[MinecraftLauncher] Attempting to ensure Java ${requiredJavaVersion}...`);
        console.log(`[MinecraftLauncher] JavaManager base directory: ${this.javaManager.javaBaseDir}`);
        console.log(`[MinecraftLauncher] Checking if Java ${requiredJavaVersion} is already installed...`);
        
        // Check if Java is already installed first
        const isAlreadyInstalled = this.javaManager.isJavaInstalled(requiredJavaVersion);
        console.log(`[MinecraftLauncher] Java ${requiredJavaVersion} already installed: ${isAlreadyInstalled}`);
        
        if (isAlreadyInstalled) {
          const existingJavaPath = this.javaManager.getJavaExecutablePath(requiredJavaVersion);
          console.log(`[MinecraftLauncher] Existing Java path: ${existingJavaPath}`);
        }
        
        javaResult = await this.javaManager.ensureJava(requiredJavaVersion, (progress) => {
          console.log(`[MinecraftLauncher] Java progress: ${progress.type} - ${progress.task}`);
          this.emit('launch-progress', {
            type: progress.type,
            task: progress.task,
            total: progress.totalMB || 0,
            current: progress.downloadedMB || 0
          });
        });
        
        console.log(`[MinecraftLauncher] ensureJava result:`, {
          success: javaResult.success,
          javaPath: javaResult.javaPath,
          error: javaResult.error
        });
        
        if (!javaResult.success) {
          throw new Error(`Client-specific Java failed: ${javaResult.error}`);
        }
        
        console.log(`[MinecraftLauncher] Java ${requiredJavaVersion} available at: ${javaResult.javaPath}`);
        
        // Test our downloaded Java directly with very conservative settings
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        console.log(`[MinecraftLauncher] Testing client-specific Java: "${javaResult.javaPath}" -Xmx256M -Xms128M -version`);
        const testResult = await execAsync(`"${javaResult.javaPath}" -Xmx256M -Xms128M -version`, { timeout: 10000 });
        console.log(`[MinecraftLauncher] Client-specific Java test passed:`, testResult.stdout || testResult.stderr);
        
      } catch (downloadedJavaError) {
        console.error(`[MinecraftLauncher] ❌ CRITICAL: Client-specific Java failed:`, downloadedJavaError.message);
        
        // For now, let's throw an error instead of falling back to system Java
        // This will help us debug why the client-specific Java isn't working
        throw new Error(`Client-specific Java failed and we need to fix this root cause: ${downloadedJavaError.message}`);
      }
      
      // Log Java installation details
      console.log(`[MinecraftLauncher] Java installation details:`);
      console.log(`[MinecraftLauncher] - Java path: ${javaResult.javaPath}`);
      console.log(`[MinecraftLauncher] - Java base directory: ${this.javaManager.javaBaseDir}`);
      console.log(`[MinecraftLauncher] - Platform: ${this.javaManager.platform}`);
      console.log(`[MinecraftLauncher] - Architecture: ${this.javaManager.architecture}`);
      
      // Check if Java file actually exists
      if (!fs.existsSync(javaResult.javaPath)) {
        throw new Error(`Java executable not found at: ${javaResult.javaPath}`);
      }
      
      const javaStats = fs.statSync(javaResult.javaPath);
      console.log(`[MinecraftLauncher] - Java file size: ${javaStats.size} bytes`);
      console.log(`[MinecraftLauncher] - Java file permissions: ${javaStats.mode.toString(8)}`);
      
      // Check for path issues that might cause JVM problems
      if (javaResult.javaPath.includes(' ')) {
        console.log(`[MinecraftLauncher] - WARNING: Java path contains spaces: ${javaResult.javaPath}`);
      }
      
      // Convert to short path on Windows to avoid space issues
      let finalJavaPath = javaResult.javaPath;
      if (process.platform === 'win32' && javaResult.javaPath.includes(' ')) {
        try {
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);
          
          // Get short path equivalent (8.3 format) to avoid space issues
          const { stdout } = await execAsync(`for %I in ("${javaResult.javaPath}") do @echo %~sI`, { shell: 'cmd' });
          const shortPath = stdout.trim();
          if (shortPath && fs.existsSync(shortPath)) {
            finalJavaPath = shortPath;
            console.log(`[MinecraftLauncher] - Using short path: ${finalJavaPath}`);
          }
        } catch (pathError) {
          console.warn(`[MinecraftLauncher] - Could not get short path: ${pathError.message}`);
        }
      }
      
      console.log(`[MinecraftLauncher] Using Java: ${finalJavaPath}`);
      
      // Use memory settings from client UI or calculate automatically
      let finalMaxMemory, finalMinMemory;
      
      if (maxMemory && maxMemory > 0) {
        // Use memory setting provided by client UI
        finalMaxMemory = maxMemory; // Already in MB
        finalMinMemory = Math.min(Math.floor(maxMemory / 4), 512); // Min is 1/4 of max, capped at 512MB
        console.log(`[MinecraftLauncher] Using client-specified memory: ${finalMinMemory}MB to ${finalMaxMemory}MB`);
      } else {
        // Use extremely conservative memory settings to prevent JVM fatal exceptions
        finalMaxMemory = 256; // MB as number, not string
        finalMinMemory = 128; // MB as number, not string
        
        // Check system memory and adjust very conservatively
        const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
        console.log(`[MinecraftLauncher] System total memory: ${totalMemoryGB.toFixed(1)} GB`);
        
        if (totalMemoryGB >= 16) {
          finalMaxMemory = 1024; // 1GB
          finalMinMemory = 512;   // 512MB
        } else if (totalMemoryGB >= 8) {
          finalMaxMemory = 768;   // 768MB
          finalMinMemory = 384;   // 384MB
        } else if (totalMemoryGB >= 4) {
          finalMaxMemory = 512;   // 512MB
          finalMinMemory = 256;   // 256MB
        } else if (totalMemoryGB >= 2) {
          finalMaxMemory = 384;   // 384MB
          finalMinMemory = 192;   // 192MB
        } else {
          // Very limited memory systems - absolute minimum
          finalMaxMemory = 256;   // 256MB
          finalMinMemory = 128;   // 128MB
        }
        
        console.log(`[MinecraftLauncher] Auto-calculated memory settings: ${finalMinMemory}MB to ${finalMaxMemory}MB (based on ${totalMemoryGB.toFixed(1)}GB system memory)`);
      }
      
      // Test Java with progressively lower memory settings until one works
      console.log(`[MinecraftLauncher] Testing Java with memory settings to prevent JVM fatal exception...`);
      let workingMaxMemory = finalMaxMemory;
      let workingMinMemory = finalMinMemory;
      
      const memoryTests = [
        { max: finalMaxMemory, min: finalMinMemory },
        { max: 256, min: 128 },
        { max: 192, min: 96 },
        { max: 128, min: 64 }
      ];
      
      let javaTestPassed = false;
      
      for (const memTest of memoryTests) {
        try {
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);
          
          // Use javaw.exe for testing to avoid console window (Windows)
          let testJavaPath = finalJavaPath;
          if (process.platform === 'win32' && finalJavaPath.includes('java.exe')) {
            testJavaPath = finalJavaPath.replace('java.exe', 'javaw.exe');
          }
          
          const javaTestCommand = `"${testJavaPath}" -Xmx${memTest.max}M -Xms${memTest.min}M -version`;
          console.log(`[MinecraftLauncher] Testing memory settings: ${memTest.min}MB to ${memTest.max}MB`);
          
          const testResult = await execAsync(javaTestCommand, { 
            timeout: 15000,
            windowsHide: true // Hide console window on Windows
          });
          console.log(`[MinecraftLauncher] Java memory test PASSED with ${memTest.min}MB to ${memTest.max}MB`);
          
          workingMaxMemory = memTest.max;
          workingMinMemory = memTest.min;
          javaTestPassed = true;
          break;
          
        } catch (javaTestError) {
          console.error(`[MinecraftLauncher] Java memory test FAILED with ${memTest.min}MB to ${memTest.max}MB:`, javaTestError.message);
          
          if (javaTestError.message.includes('Could not create the Java Virtual Machine') || 
              javaTestError.message.includes('heap size') ||
              javaTestError.message.includes('Initial heap size')) {
            console.log(`[MinecraftLauncher] JVM error detected, trying lower memory settings...`);
            continue; // Try next lower memory setting
          } else {
            // Some other Java error that won't be fixed by lower memory
            throw new Error(`Java test failed with non-memory error: ${javaTestError.message}`);
          }
        }
      }
      
      if (!javaTestPassed) {
        throw new Error(`Java Virtual Machine error: All memory settings failed. Your system may have insufficient memory or Java installation issues. Please ensure you have Java properly installed and at least 512MB of free RAM.`);
      }
      
      console.log(`[MinecraftLauncher] Final memory settings: ${workingMinMemory}MB to ${workingMaxMemory}MB`);
      
      // Update the memory variables with working values
      finalMaxMemory = workingMaxMemory;
      finalMinMemory = workingMinMemory;
      
      // Check and refresh authentication if needed
      console.log('[MinecraftLauncher] Checking authentication status...');
      const authCheck = await this.checkAndRefreshAuth();
      
      if (!authCheck.success) {
        if (authCheck.needsReauth) {
          throw new Error('Authentication expired. Please re-authenticate with Microsoft and try again.');
        } else {
          throw new Error(`Authentication error: ${authCheck.error}`);
        }
      }
      
      if (authCheck.refreshed) {
        console.log('[MinecraftLauncher] Authentication token was refreshed');
        // Save the refreshed auth data
        await this.saveAuthData(clientPath);
      } else if (authCheck.networkError) {
        console.log('[MinecraftLauncher] Proceeding with cached authentication due to network issues');
      }
      
      // Validate client path
      if (!fs.existsSync(clientPath)) {
        console.log('[MinecraftLauncher] Creating client directory:', clientPath);
        fs.mkdirSync(clientPath, { recursive: true });
      }
      
      console.log('[MinecraftLauncher] Client path exists:', clientPath);
      
      // Create essential directories if they don't exist
      const essentialDirs = ['versions', 'libraries', 'assets', 'mods'];
      for (const dir of essentialDirs) {
        const dirPath = path.join(clientPath, dir);
        if (!fs.existsSync(dirPath)) {
          console.log(`[MinecraftLauncher] Creating directory: ${dirPath}`);
          fs.mkdirSync(dirPath, { recursive: true });
        } else {
          console.log(`[MinecraftLauncher] Found directory: ${dirPath}`);
        }
      }
      
      // Check if authentication might need refresh (try to refresh if token seems old)
      let authorization;
      try {
        if (this.authData.meta && this.authData.meta.mclc) {
          console.log('[MinecraftLauncher] Using MSMC mclc() method for authorization');
          authorization = this.authData.meta.mclc();
        } else {
          console.log('[MinecraftLauncher] Using stored auth data for authorization');
          authorization = {
            access_token: this.authData.access_token,
            client_token: this.authData.client_token,
            uuid: this.authData.uuid,
            name: this.authData.name,
            user_properties: this.authData.user_properties || {}
          };
        }
        
        console.log('[MinecraftLauncher] Authorization prepared:', {
          name: authorization.name || 'unknown',
          uuid: authorization.uuid || 'unknown',
          hasAccessToken: !!authorization.access_token,
          tokenLength: authorization.access_token ? authorization.access_token.length : 0
        });
        
      } catch (authError) {
        console.error('[MinecraftLauncher] Auth preparation error:', authError);
        throw new Error('Authentication error: Please re-authenticate with Microsoft');
      }
      
      const launchOptions = {
        authorization: authorization,
        root: clientPath,
        version: {
          number: launchVersion, // Use Fabric profile name if Fabric, otherwise vanilla
          type: "release"
        },
        // Use MCLC's built-in memory handling
        memory: {
          min: `${finalMinMemory}M`,
          max: `${finalMaxMemory}M`
        },
        // Java configuration
        java: {
          path: finalJavaPath,
          args: [
            // Modern JVM flags for better performance
            "-XX:+UseG1GC",
            "-XX:+UnlockExperimentalVMOptions",
            "-XX:G1NewSizePercent=20",
            "-XX:G1ReservePercent=20",
            "-XX:MaxGCPauseMillis=50",
            "-XX:G1HeapRegionSize=32M"
          ]
        },
        // Server connection (MCLC will handle automatically)
        server: {
          ip: serverIp,
          port: parseInt(serverPort)
        },
        // CRITICAL: Configure MCLC to handle asset downloads properly
        download: true,              // Force MCLC to download any missing assets
        downloadAssets: true,        // Explicitly enable asset downloading
        forge: false,                // We're using Fabric, not Forge
        // Basic options
        clientPackage: null,
        removePackage: false,
        cwd: clientPath,
        overrides: {
          gameDirectory: clientPath
        }
      };
      
      console.log(`[MinecraftLauncher] Launch configuration ready`);
      
      // Add server to the multiplayer server list so it appears automatically
      await this.addServerToList(clientPath, {
        name: serverInfo?.serverInfo?.name || serverInfo?.name || 'Game Server',
        ip: serverIp,
        port: parseInt(serverPort)
      });
      
      console.log('[MinecraftLauncher] Launch options prepared:', {
        root: launchOptions.root,
        version: launchOptions.version,
        serverConnection: `${serverIp}:${parseInt(serverPort)}`,
        hasAuth: !!launchOptions.authorization,
        javaPath: launchOptions.java.path,
        javaArgs: launchOptions.java.args,
        maxMemoryInput: maxMemory,
        finalMaxMemory: finalMaxMemory,
        finalMinMemory: finalMinMemory
      });
      
      // Log the complete launch options for debugging
      console.log('[MinecraftLauncher] Complete launch options:');
      console.log(JSON.stringify(launchOptions, null, 2));
      
      // Create Minecraft Launcher Core client
      this.client = new Client();
      
      // Set up event listeners for detailed logging
      this.client.on('debug', (e) => console.log(`[MCLC Debug] ${e}`));
      this.client.on('data', (e) => console.log(`[MCLC Data] ${e}`));
      this.client.on('progress', (e) => {
        console.log(`[MCLC Progress] ${e.type}: ${e.task} (${e.total})`);
        this.emit('launch-progress', {
          type: e.type,
          task: e.task,
          total: e.total
        });
      });
      
      // Log MCLC arguments for debugging
      this.client.on('arguments', (args) => {
        console.log(`[MCLC] Launching with Java: ${args[0]}`);
        const memoryFlags = args.filter(arg => arg.startsWith('-Xm'));
        if (memoryFlags.length > 0) {
          console.log(`[MCLC] Memory settings: ${memoryFlags.join(', ')}`);
        }
      });
      
      this.client.on('close', (code) => {
        console.log(`[MinecraftLauncher] Minecraft closed with code: ${code}`);
        this.isLaunching = false;
        this.client = null;
        this.emit('minecraft-closed', { code });
      });
      
      // Add error handler for the client
      this.client.on('error', (error) => {
        console.error('[MCLC Error]', error);
        this.isLaunching = false;
        this.client = null;
        this.emit('launch-error', error.message);
      });
      
      // Validate asset index before launch to prevent MCLC errors
      console.log('[MinecraftLauncher] Validating asset index before launch...');
      try {
        const versionsDir = path.join(clientPath, 'versions');
        const assetsIndexesDir = path.join(clientPath, 'assets', 'indexes');
        
        // Find the asset index file for this version
        let assetIndexFile = null;
        
                 if (needsFabric) {
           // For Fabric, check the vanilla version's asset index  
           const vanillaJsonPath = path.join(versionsDir, minecraftVersion, `${minecraftVersion}.json`);
          if (fs.existsSync(vanillaJsonPath)) {
            const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
            if (vanillaJson.assetIndex && vanillaJson.assetIndex.id) {
              assetIndexFile = path.join(assetsIndexesDir, `${vanillaJson.assetIndex.id}.json`);
            }
          }
                 } else {
           // For vanilla, check the version's asset index
           const versionJsonPath = path.join(versionsDir, minecraftVersion, `${minecraftVersion}.json`);
          if (fs.existsSync(versionJsonPath)) {
            const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
            if (versionJson.assetIndex && versionJson.assetIndex.id) {
              assetIndexFile = path.join(assetsIndexesDir, `${versionJson.assetIndex.id}.json`);
            }
          }
        }
        
        if (assetIndexFile && fs.existsSync(assetIndexFile)) {
          const assetIndex = JSON.parse(fs.readFileSync(assetIndexFile, 'utf8'));
          
          if (!assetIndex.objects || typeof assetIndex.objects !== 'object') {
            throw new Error('Asset index missing or invalid objects property');
          }
          
          const objectEntries = Object.values(assetIndex.objects);
          const invalidEntries = objectEntries.filter(obj => !obj.url || !obj.hash);
          
          if (invalidEntries.length > 0) {
            throw new Error(`Asset index malformed: ${invalidEntries.length} entries missing url or hash properties`);
          }
          
          console.log(`[MinecraftLauncher] ✅ Asset index validated: ${objectEntries.length} entries with proper URLs`);
        } else {
          console.warn(`[MinecraftLauncher] ⚠️ Asset index file not found, MCLC will handle downloads`);
        }
      } catch (validationError) {
        console.error(`[MinecraftLauncher] Asset index validation failed: ${validationError.message}`);
        throw new Error(`Cannot launch: Asset index validation failed - ${validationError.message}`);
      }
      
      // Set JAVA_HOME to ensure MCLC uses our downloaded Java
      const originalJavaHome = process.env.JAVA_HOME;
      const clientJavaHome = path.dirname(path.dirname(finalJavaPath));
      process.env.JAVA_HOME = clientJavaHome;
      
      // Launch Minecraft
      console.log('[MinecraftLauncher] Starting Minecraft launch...');
      this.emit('launch-start');
      
      console.log(`[MinecraftLauncher] Starting ${needsFabric ? 'Fabric' : 'Vanilla'} Minecraft ${launchVersion}...`);
      
      // Standard MCLC launch
      let launchResult; // Declare outside try block for proper scoping
      try {
        console.log('[MinecraftLauncher] Launching with configuration:');
        console.log('[MinecraftLauncher] - Version:', launchOptions.version);
        console.log('[MinecraftLauncher] - Java path:', launchOptions.java.path);
        console.log('[MinecraftLauncher] - Memory:', launchOptions.memory);
        console.log('[MinecraftLauncher] - Server:', `${launchOptions.server.ip}:${launchOptions.server.port}`);
        console.log('[MinecraftLauncher] - User:', launchOptions.authorization.name);
        
        launchResult = await this.client.launch(launchOptions);
        console.log('[MinecraftLauncher] client.launch() returned:', launchResult);
        
        // Add more detailed information about what was returned
        if (launchResult) {
          console.log('[MinecraftLauncher] Launch result details:', {
            pid: launchResult.pid || 'none',
            killed: launchResult.killed || 'unknown',
            exitCode: launchResult.exitCode || 'none',
            signalCode: launchResult.signalCode || 'none',
            hasStdout: !!launchResult.stdout,
            hasStderr: !!launchResult.stderr
          });
          
          // Set up monitoring for the returned process if it exists
          if (launchResult.stdout) {
            launchResult.stdout.on('data', (data) => {
              console.log(`[Minecraft stdout] ${data.toString()}`);
            });
          }
          
          if (launchResult.stderr) {
            launchResult.stderr.on('data', (data) => {
              console.log(`[Minecraft stderr] ${data.toString()}`);
            });
          }
          
          if (launchResult.on) {
            launchResult.on('exit', (code, signal) => {
              console.log(`[MinecraftLauncher] Launch result process exited with code: ${code}, signal: ${signal}`);
            });
          }
        }
      } catch (launchError) {
        console.error('[MinecraftLauncher] Launch error details:', launchError);
        
        // Check for specific error types and provide helpful messages
        if (launchError.message && (
          launchError.message.includes('authserver.mojang.com') ||
          launchError.message.includes('ENOTFOUND') ||
          launchError.message.includes('authentication') ||
          launchError.message.includes('Invalid credentials')
        )) {
          throw new Error('Authentication expired. Please re-authenticate with Microsoft and try again.');
        } else if (launchError.message && launchError.message.includes('EMFILE')) {
          throw new Error('Too many files open. Please close other applications and try again.');
        } else if (launchError.message && (
          launchError.message.includes('Could not create the Java Virtual Machine') ||
          launchError.message.includes('java.lang.OutOfMemoryError') ||
          launchError.message.includes('Initial heap size') ||
          launchError.message.includes('Maximum heap size')
        )) {
          throw new Error('Java Virtual Machine error. Try freeing up system memory by closing other applications. If the problem persists, try restarting your computer.');
        } else if (launchError.message && launchError.message.includes('java')) {
          throw new Error(`Java error: ${launchError.message}. Please ensure you have Java 8 or higher installed.`);
        } else {
          throw launchError;
        }
      }
      
      // Wait and check if the process actually started
      console.log('[MinecraftLauncher] Checking if Minecraft process started...');
      
      // Wait a moment for the process to actually start
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check if we have a running process
      let processStarted = false;
      let minecraftPid = null;
      
      if (this.client && this.client.child) {
        minecraftPid = this.client.child.pid;
        console.log(`[MinecraftLauncher] Minecraft process detected with PID: ${minecraftPid}`);
        processStarted = true;
        
        // Set up process monitoring
        this.client.child.on('exit', (code, signal) => {
          console.log(`[MinecraftLauncher] Minecraft process exited with code: ${code}, signal: ${signal}`);
          this.isLaunching = false;
          this.client = null;
          this.emit('minecraft-closed', { code, signal });
        });
        
        this.client.child.on('error', (error) => {
          console.error('[MinecraftLauncher] Minecraft process error:', error);
          this.isLaunching = false;
          this.client = null;
          this.emit('launch-error', `Process error: ${error.message}`);
        });
        
        // Monitor stdout/stderr for Minecraft startup messages
        if (this.client.child.stdout) {
          this.client.child.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`[Minecraft stdout] ${output}`);
            
            // Look for success indicators
            if (output.includes('Minecraft') || output.includes('Starting Minecraft')) {
              console.log('[MinecraftLauncher] Minecraft startup detected in output');
            }
          });
        }
        
        if (this.client.child.stderr) {
          this.client.child.stderr.on('data', (data) => {
            const output = data.toString();
            console.log(`[Minecraft stderr] ${output}`);
            
            // Look for error indicators
            if (output.includes('Could not find or load main class') || 
                output.includes('UnsupportedClassVersionError') ||
                output.includes('Exception')) {
              console.error('[MinecraftLauncher] Critical error detected in Minecraft output:', output);
            }
          });
        }
        
      } else {
        console.warn('[MinecraftLauncher] No direct process access from MCLC');
        
        // Try to find the Minecraft process manually
        if (process.platform === 'win32') {
          try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq javaw.exe" /FO CSV', { timeout: 5000 });
            const lines = stdout.split('\n');
            
            if (lines.length > 1) { // Header + at least one process
              console.log(`[MinecraftLauncher] Found ${lines.length - 1} javaw.exe processes running`);
              processStarted = true;
            }
          } catch (processCheckError) {
            console.warn('[MinecraftLauncher] Could not check for running Java processes:', processCheckError.message);
          }
        }
      }
      
      if (processStarted) {
        console.log('[MinecraftLauncher] Minecraft process started successfully');
        this.emit('launch-success');
        
        // Restore original JAVA_HOME
        if (originalJavaHome) {
          process.env.JAVA_HOME = originalJavaHome;
        } else {
          delete process.env.JAVA_HOME;
        }
        
        return { success: true, pid: minecraftPid };
      } else {
        console.error('[MinecraftLauncher] Minecraft process did not start or could not be detected');
        
        // Restore original JAVA_HOME
        if (originalJavaHome) {
          process.env.JAVA_HOME = originalJavaHome;
        } else {
          delete process.env.JAVA_HOME;
        }
        
        throw new Error('Minecraft process failed to start. Check the console for error details.');
      }
      
    } catch (error) {
      console.error('[MinecraftLauncher] Launch error:', error);
      this.isLaunching = false;
      this.client = null;
      this.emit('launch-error', error.message);
      throw error;
    }
  }
  
  // Stop Minecraft if running
  async stopMinecraft() {
    try {
      console.log('[MinecraftLauncher] Stopping Minecraft...');
      
      let stopped = false;
      
      // Method 1: Stop via MCLC client if available
      if (this.client && this.client.child) {
        console.log('[MinecraftLauncher] Stopping via MCLC client process...');
        try {
          // minecraft-launcher-core provides access to the child process
          this.client.child.kill('SIGTERM');
          
          // Wait a moment, then force kill if necessary
          setTimeout(() => {
            if (this.client && this.client.child && !this.client.child.killed) {
              console.log('[MinecraftLauncher] Force killing Minecraft process...');
              this.client.child.kill('SIGKILL');
            }
          }, 3000);
          
          stopped = true;
          console.log('[MinecraftLauncher] MCLC client process terminated');
        } catch (error) {
          console.warn('[MinecraftLauncher] Error stopping MCLC client process:', error.message);
        }
      }
      
      // Method 2: Targeted Java process killing (Windows-specific fallback)
      if (process.platform === 'win32') {
        try {
          console.log('[MinecraftLauncher] Attempting to stop client Java processes on Windows...');
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);
          
          // CRITICAL FIX: Only kill Java processes that are specifically related to this client
          // DO NOT kill all Java processes as this would stop the Minecraft server!
          
          // Try to kill only processes running from our client directory
          if (this.clientPath) {
            const clientPathEscaped = this.clientPath.replace(/\\/g, '\\\\');
            
            try {
              // Kill only Java processes with our client path in the command line
              await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='java.exe'" call terminate`, { 
                windowsHide: true,
                timeout: 5000 
              }).catch(() => {
                console.log('[MinecraftLauncher] No client-specific java.exe processes to kill');
              });
              
              await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='javaw.exe'" call terminate`, { 
                windowsHide: true,
                timeout: 5000 
              }).catch(() => {
                console.log('[MinecraftLauncher] No client-specific javaw.exe processes to kill');
              });
              
              console.log('[MinecraftLauncher] Targeted client Java process termination completed');
              stopped = true;
              
            } catch (wmicError) {
              console.warn('[MinecraftLauncher] WMIC targeted kill failed, trying PID-based approach:', wmicError.message);
              
              // Fallback: Try to use the stored client PID if we have it
              if (this.client && this.client.child && this.client.child.pid) {
                try {
                  await execAsync(`taskkill /F /PID ${this.client.child.pid}`, { windowsHide: true });
                  console.log(`[MinecraftLauncher] Killed client process by PID: ${this.client.child.pid}`);
                  stopped = true;
                } catch (pidError) {
                  console.warn('[MinecraftLauncher] PID-based kill also failed:', pidError.message);
                }
              }
            }
          } else {
            console.log('[MinecraftLauncher] No client path available for targeted killing, skipping Windows process cleanup');
          }
          
        } catch (error) {
          console.warn('[MinecraftLauncher] Error with Windows process termination:', error.message);
        }
      }
      
      // Reset launcher state
      this.isLaunching = false;
      this.client = null;
      this.emit('minecraft-stopped');
      
      if (stopped) {
        return { success: true, message: 'Minecraft stopped successfully' };
      } else {
        return { success: true, message: 'Minecraft process cleanup completed (no active process found)' };
      }
      
    } catch (error) {
      console.error('[MinecraftLauncher] Error stopping Minecraft:', error);
      // Reset state even on error
      this.isLaunching = false;
      this.client = null;
      this.emit('minecraft-stopped');
      return { success: false, error: error.message };
    }
  }
  
  // Calculate file checksum for mod verification
  calculateFileChecksum(filePath) {
    try {
      const { createHash } = require('crypto');
      const fileContent = fs.readFileSync(filePath);
      return createHash('md5').update(fileContent).digest('hex');
    } catch (error) {
      console.warn('[MinecraftLauncher] Could not calculate checksum for:', filePath);
      return null;
    }
  }
  
  // Get launcher status
  getStatus() {
    let isRunning = false;
    
    // Check if we actually have a running process
    if (this.client && this.client.child) {
      try {
        // Check if the process is still alive
        const pid = this.client.child.pid;
        if (pid) {
          // On Windows, we can check if the process exists
          try {
            process.kill(pid, 0); // Signal 0 just tests if process exists
            isRunning = true;
          } catch (e) {
            // Process doesn't exist anymore
            console.log(`[MinecraftLauncher] Process ${pid} no longer exists, cleaning up...`);
            this.isLaunching = false;
            this.client = null;
            isRunning = false;
          }
        }
      } catch (error) {
        console.warn('[MinecraftLauncher] Error checking process status:', error);
        isRunning = false;
      }
    }
    
    return {
      isAuthenticated: !!this.authData,
      isLaunching: this.isLaunching,
      isRunning: isRunning,
      username: this.authData?.name || null,
      clientPath: this.clientPath
    };
  }
  
  // Check if Minecraft client files are present and up to date
  async checkMinecraftClient(clientPath, requiredVersion, options = {}) {
    console.log('💡 ENTERED MinecraftLauncher.checkMinecraftClient');
    try {
      console.log(`[MinecraftLauncher] Checking client files for ${requiredVersion} in: ${clientPath}`);
      
      if (!fs.existsSync(clientPath)) {
        console.log(`[MinecraftLauncher] Client path does not exist: ${clientPath}`);
        return { synchronized: false, reason: 'Client path does not exist' };
      }

      // Extract options
      const { 
        requiredMods = [], 
        serverInfo = null 
      } = options;
      
      // Determine if Fabric is needed
      const needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
      let fabricVersion = serverInfo?.loaderVersion || 'latest';
      
      console.log(`[MinecraftLauncher] Fabric requirements: needsFabric=${needsFabric}, version=${fabricVersion}`);
      
      // Determine the target version (Fabric profile or vanilla)
      let targetVersion = requiredVersion;
      let fabricProfileName = null;
      
      if (needsFabric) {
        // Get the Fabric loader version
        if (fabricVersion === 'latest') {
          try {
            const fetch = require('node-fetch');
            const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
            const loaders = await response.json();
            fabricVersion = loaders[0].version;
            console.log(`[MinecraftLauncher] Using latest Fabric loader: ${fabricVersion}`);
          } catch (error) {
            console.warn(`[MinecraftLauncher] Could not fetch latest Fabric version, using 0.14.21:`, error.message);
            fabricVersion = '0.14.21'; // Fallback version
          }
        }
        
        fabricProfileName = `fabric-loader-${fabricVersion}-${requiredVersion}`;
        targetVersion = fabricProfileName;
        console.log(`[MinecraftLauncher] Target Fabric profile: ${fabricProfileName}`);
      }

      // First check if Java is available for this Minecraft version
      const requiredJavaVersion = this.getRequiredJavaVersion(requiredVersion);
      console.log(`[MinecraftLauncher] Minecraft ${requiredVersion} requires Java ${requiredJavaVersion}`);
      
      if (!this.javaManager.isJavaInstalled(requiredJavaVersion)) {
        console.log(`[MinecraftLauncher] Java ${requiredJavaVersion} is not installed`);
        return { 
          synchronized: false, 
          reason: `Java ${requiredJavaVersion} is required for Minecraft ${requiredVersion} but is not installed`,
          needsJava: true,
          requiredJavaVersion: requiredJavaVersion
        };
      }
      
      console.log(`[MinecraftLauncher] Java ${requiredJavaVersion} is available`);

      const versionsDir = path.join(clientPath, 'versions');
      const librariesDir = path.join(clientPath, 'libraries');
      const assetsDir = path.join(clientPath, 'assets');
      
      // For Fabric profiles, we need to check both the Fabric profile AND the vanilla JAR
      // Fabric doesn't create a separate JAR file - it creates a profile that references the vanilla JAR
      let jarFile, jsonFile, versionDir;
      
      if (needsFabric) {
        // Check Fabric profile directory and JSON
        versionDir = path.join(versionsDir, targetVersion);
        jsonFile = path.join(versionDir, `${targetVersion}.json`);
        
        // For Fabric, the JAR file is actually the VANILLA JAR, not a Fabric JAR
        const vanillaVersionDir = path.join(versionsDir, requiredVersion);
        jarFile = path.join(vanillaVersionDir, `${requiredVersion}.jar`);
        
        console.log(`[MinecraftLauncher] Checking Fabric profile directory: ${versionDir}`);
        console.log(`[MinecraftLauncher] Checking Fabric JSON: ${jsonFile}`);
        console.log(`[MinecraftLauncher] Checking vanilla JAR for Fabric: ${jarFile}`);
      } else {
        // For vanilla, check the normal version directory
        versionDir = path.join(versionsDir, targetVersion);
        jarFile = path.join(versionDir, `${targetVersion}.jar`);
        jsonFile = path.join(versionDir, `${targetVersion}.json`);
        
        console.log(`[MinecraftLauncher] Checking vanilla version directory: ${versionDir}`);
        console.log(`[MinecraftLauncher] Checking vanilla JAR: ${jarFile}`);
        console.log(`[MinecraftLauncher] Checking vanilla JSON: ${jsonFile}`);
      }
      
      // Check if version folder exists
      if (!fs.existsSync(versionDir)) {
        console.log(`[MinecraftLauncher] Version directory missing: ${versionDir}`);
        if (needsFabric) {
          return { 
            synchronized: false, 
            reason: `Fabric profile ${fabricProfileName} not installed`,
            needsFabric: true,
            fabricVersion: fabricVersion,
            vanillaVersion: requiredVersion
          };
        } else {
          return { synchronized: false, reason: `Version ${requiredVersion} not downloaded` };
        }
      }
      
      // Check if required files exist
      if (!fs.existsSync(jarFile)) {
        console.log(`[MinecraftLauncher] JAR file missing: ${jarFile}`);
        if (needsFabric) {
          return { synchronized: false, reason: `Vanilla JAR missing for Fabric profile (${requiredVersion})` };
        } else {
          return { synchronized: false, reason: `Client JAR missing for ${requiredVersion}` };
        }
      }
      
      if (!fs.existsSync(jsonFile)) {
        console.log(`[MinecraftLauncher] JSON file missing: ${jsonFile}`);
        if (needsFabric) {
          return { synchronized: false, reason: `Fabric profile manifest missing (${fabricProfileName})` };
        } else {
          return { synchronized: false, reason: `Version manifest missing for ${requiredVersion}` };
        }
      }
      
      // Verify the files are not empty
      const jarStats = fs.statSync(jarFile);
      const jsonStats = fs.statSync(jsonFile);
      
      console.log(`[MinecraftLauncher] 🔍 checkMinecraftClient: JAR file ${jarFile} exists with ${jarStats.size} bytes`);
      console.log(`[MinecraftLauncher] 🔍 checkMinecraftClient: JSON file ${jsonFile} exists with ${jsonStats.size} bytes`);
      
      if (jarStats.size === 0) {
        console.log(`[MinecraftLauncher] ❌ JAR file is empty: ${jarFile}`);
        console.log(`[MinecraftLauncher] ❌ This indicates the download process failed to write content to the JAR file`);
        if (needsFabric) {
          return { synchronized: false, reason: `Vanilla JAR file is corrupted (empty) - required for Fabric` };
        } else {
          return { synchronized: false, reason: `Client JAR file is corrupted (empty)` };
        }
      }
      
      if (jsonStats.size === 0) {
        console.log(`[MinecraftLauncher] JSON file is empty: ${jsonFile}`);
        if (needsFabric) {
          return { synchronized: false, reason: `Fabric profile manifest is corrupted (empty)` };
        } else {
          return { synchronized: false, reason: `Version manifest is corrupted (empty)` };
        }
      }
      
      // Check for libraries and assets directories and their content
      console.log(`[MinecraftLauncher] Checking libraries directory: ${librariesDir}`);
      if (!fs.existsSync(librariesDir)) {
        console.log(`[MinecraftLauncher] Libraries directory missing: ${librariesDir}`);
        return { synchronized: false, reason: 'Client libraries not downloaded' };
      }
      
      console.log(`[MinecraftLauncher] Checking assets directory: ${assetsDir}`);
      if (!fs.existsSync(assetsDir)) {
        console.log(`[MinecraftLauncher] Assets directory missing: ${assetsDir}`);
        return { synchronized: false, reason: 'Client assets not downloaded' };
      }
      
      // Check if libraries directory has content
      try {
        const librariesContent = fs.readdirSync(librariesDir);
        console.log(`[MinecraftLauncher] Libraries directory contains ${librariesContent.length} items`);
        if (librariesContent.length === 0) {
          console.log(`[MinecraftLauncher] Libraries directory is empty: ${librariesDir}`);
          return { synchronized: false, reason: 'Client libraries directory is empty' };
        }
      } catch (error) {
        console.log(`[MinecraftLauncher] Error reading libraries directory: ${error.message}`);
        return { synchronized: false, reason: 'Cannot read libraries directory' };
      }
      
      // Check if assets directory has content
      try {
        const assetsContent = fs.readdirSync(assetsDir);
        console.log(`[MinecraftLauncher] Assets directory contains ${assetsContent.length} items`);
        if (assetsContent.length === 0) {
          console.log(`[MinecraftLauncher] Assets directory is empty: ${assetsDir}`);
          return { synchronized: false, reason: 'Client assets directory is empty' };
        }
        
        // Check for assets/indexes which is essential
        const assetsIndexesDir = path.join(assetsDir, 'indexes');
        if (!fs.existsSync(assetsIndexesDir)) {
          console.log(`[MinecraftLauncher] Assets indexes directory missing: ${assetsIndexesDir}`);
          return { synchronized: false, reason: 'Client assets indexes missing' };
        }
        
        const indexesContent = fs.readdirSync(assetsIndexesDir);
        if (indexesContent.length === 0) {
          console.log(`[MinecraftLauncher] Assets indexes directory is empty: ${assetsIndexesDir}`);
          return { synchronized: false, reason: 'Client assets indexes are empty' };
        }
        
      } catch (error) {
        console.log(`[MinecraftLauncher] Error reading assets directory: ${error.message}`);
        return { synchronized: false, reason: 'Cannot read assets directory' };
      }
      
      // All essential files and directories exist and have content
      console.log(`[MinecraftLauncher] Client files verified for ${targetVersion}:`);
      if (needsFabric) {
        console.log(`[MinecraftLauncher] - Vanilla JAR: ${jarStats.size} bytes (${path.basename(jarFile)})`);
        console.log(`[MinecraftLauncher] - Fabric profile JSON: ${jsonStats.size} bytes (${path.basename(jsonFile)})`);
        console.log(`[MinecraftLauncher] - Fabric ${fabricVersion}: installed`);
      } else {
        console.log(`[MinecraftLauncher] - JAR: ${jarStats.size} bytes`);
        console.log(`[MinecraftLauncher] - JSON: ${jsonStats.size} bytes`);
      }
      console.log(`[MinecraftLauncher] - Libraries: present with content`);
      console.log(`[MinecraftLauncher] - Assets: present with content`);
      console.log(`[MinecraftLauncher] - Java ${requiredJavaVersion}: available`);
      
      const resultMessage = needsFabric 
        ? `All client files, Fabric ${fabricVersion}, and Java ${requiredJavaVersion} are present and verified`
        : `All client files and Java ${requiredJavaVersion} are present and verified`;
      
      return { 
        synchronized: true, 
        reason: resultMessage,
        javaVersion: requiredJavaVersion,
        needsFabric: needsFabric,
        fabricVersion: needsFabric ? fabricVersion : null,
        fabricProfileName: fabricProfileName,
        targetVersion: targetVersion
      };
      
    } catch (error) {
      console.error('[MinecraftLauncher] Error checking client files:', error);
      return { synchronized: false, reason: 'Error checking client files: ' + error.message };
    }
  }
  
  // Clear Minecraft client files for re-download
  async clearMinecraftClient(clientPath, minecraftVersion) {
    try {
      console.log(`[MinecraftLauncher] Clearing Minecraft ${minecraftVersion} client files...`);
      
      if (!fs.existsSync(clientPath)) {
        return { success: true, message: 'Client path does not exist, nothing to clear' };
      }
      
      // Clear version-specific files
      const versionDir = path.join(clientPath, 'versions', minecraftVersion);
      if (fs.existsSync(versionDir)) {
        console.log(`[MinecraftLauncher] Removing version directory: ${versionDir}`);
        fs.rmSync(versionDir, { recursive: true, force: true });
      }
      
      // Clear libraries (they will be re-downloaded)
      const librariesDir = path.join(clientPath, 'libraries');
      if (fs.existsSync(librariesDir)) {
        console.log(`[MinecraftLauncher] Removing libraries directory: ${librariesDir}`);
        fs.rmSync(librariesDir, { recursive: true, force: true });
      }
      
      // Clear assets (they will be re-downloaded)
      const assetsDir = path.join(clientPath, 'assets');
      if (fs.existsSync(assetsDir)) {
        console.log(`[MinecraftLauncher] Removing assets directory: ${assetsDir}`);
        fs.rmSync(assetsDir, { recursive: true, force: true });
      }
      
      // Keep the mods directory intact
      console.log(`[MinecraftLauncher] Successfully cleared client files for ${minecraftVersion}`);
      
      return { 
        success: true, 
        message: `Cleared Minecraft ${minecraftVersion} client files. Ready for fresh download.` 
      };
      
    } catch (error) {
      console.error(`[MinecraftLauncher] Failed to clear client files:`, error);
      return { 
        success: false, 
        error: `Failed to clear client files: ${error.message}` 
      };
    }
  }

  // Force clear just assets directory - useful when assets are corrupted
  async clearAssets(clientPath) {
    try {
      console.log(`[MinecraftLauncher] Force clearing corrupted assets...`);
      
      const assetsDir = path.join(clientPath, 'assets');
      if (fs.existsSync(assetsDir)) {
        console.log(`[MinecraftLauncher] Removing assets directory: ${assetsDir}`);
        fs.rmSync(assetsDir, { recursive: true, force: true });
        console.log(`[MinecraftLauncher] Assets directory cleared - will be re-downloaded with proper structure`);
        return { success: true, message: 'Assets cleared successfully' };
      } else {
        return { success: true, message: 'Assets directory does not exist' };
      }
    } catch (error) {
      console.error(`[MinecraftLauncher] Failed to clear assets:`, error);
      return { success: false, error: error.message };
    }
  }
  
  // Install Fabric loader for the client
  async installFabricLoader(clientPath, minecraftVersion, fabricVersion = 'latest') {
    try {
      console.log(`[MinecraftLauncher] Installing Fabric loader ${fabricVersion} for Minecraft ${minecraftVersion}...`);
      
      // Download Fabric installer
      const fabricInstallerUrl = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/0.11.2/fabric-installer-0.11.2.jar';
      const installerPath = path.join(clientPath, 'fabric-installer.jar');
      
      // Download installer if not exists
      if (!fs.existsSync(installerPath)) {
        console.log(`[MinecraftLauncher] Downloading Fabric installer...`);
        const fetch = require('node-fetch');
        const response = await fetch(fabricInstallerUrl);
        
        if (!response.ok) {
          throw new Error(`Failed to download Fabric installer: ${response.status}`);
        }
        
        const fileStream = fs.createWriteStream(installerPath);
        response.body.pipe(fileStream);
        
        await new Promise((resolve, reject) => {
          fileStream.on('finish', resolve);
          fileStream.on('error', reject);
        });
        
        console.log(`[MinecraftLauncher] Fabric installer downloaded`);
      }
      
      // Get latest Fabric loader version if not specified
      let loaderVersion = fabricVersion;
      if (fabricVersion === 'latest') {
        try {
          const fetch = require('node-fetch');
          const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
          const loaders = await response.json();
          loaderVersion = loaders[0].version;
          console.log(`[MinecraftLauncher] Using latest Fabric loader: ${loaderVersion}`);
        } catch (error) {
          console.warn(`[MinecraftLauncher] Could not fetch latest Fabric version, using 0.14.21:`, error.message);
          loaderVersion = '0.14.21'; // Fallback version
        }
      }
      
      // Check if Fabric profile already exists
      const fabricProfileName = `fabric-loader-${loaderVersion}-${minecraftVersion}`;
      const versionsDir = path.join(clientPath, 'versions');
      const fabricProfileDir = path.join(versionsDir, fabricProfileName);
      
      if (fs.existsSync(fabricProfileDir)) {
        console.log(`[MinecraftLauncher] Fabric profile already exists: ${fabricProfileName}`);
        return { success: true, profileName: fabricProfileName };
      }
      
      // Ensure Java is available for running installer
      const requiredJavaVersion = this.getRequiredJavaVersion(minecraftVersion);
      console.log(`[MinecraftLauncher] Fabric installation requires Java ${requiredJavaVersion}`);
      
      let javaResult;
      try {
        javaResult = await this.javaManager.ensureJava(requiredJavaVersion, (progress) => {
          console.log(`[MinecraftLauncher] Fabric Java progress: ${progress.type} - ${progress.task}`);
        });
        
        if (!javaResult.success) {
          throw new Error(`Failed to obtain Java ${requiredJavaVersion} for Fabric installation: ${javaResult.error}`);
        }
        
        console.log(`[MinecraftLauncher] Java ${requiredJavaVersion} available for Fabric installation: ${javaResult.javaPath}`);
      } catch (javaError) {
        throw new Error(`Java not available for Fabric installation: ${javaError.message}`);
      }
      
      const javaExe = javaResult.javaPath;
      
      // Run Fabric installer
      console.log(`[MinecraftLauncher] Running Fabric installer...`);
      const { spawn } = require('child_process');
      
      const installerArgs = [
        '-jar', installerPath,
        'client',
        '-mcversion', minecraftVersion,
        '-loader', loaderVersion,
        '-dir', clientPath,
        '-noprofile' // Don't create launcher profile, we handle that
      ];
      
      const installer = spawn(javaExe, installerArgs, {
        cwd: clientPath,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let installerOutput = '';
      installer.stdout.on('data', (data) => {
        const output = data.toString();
        installerOutput += output;
        console.log(`[Fabric Installer] ${output.trim()}`);
      });
      
      installer.stderr.on('data', (data) => {
        const output = data.toString();
        installerOutput += output;
        console.log(`[Fabric Installer Error] ${output.trim()}`);
      });
      
      const exitCode = await new Promise((resolve) => {
        installer.on('close', resolve);
      });
      
      if (exitCode !== 0) {
        throw new Error(`Fabric installer failed with exit code ${exitCode}: ${installerOutput}`);
      }
      
      // Verify installation
      if (!fs.existsSync(fabricProfileDir)) {
        throw new Error(`Fabric profile directory not created: ${fabricProfileDir}`);
      }
      
      const fabricJsonPath = path.join(fabricProfileDir, `${fabricProfileName}.json`);
      if (!fs.existsSync(fabricJsonPath)) {
        throw new Error(`Fabric profile JSON not created: ${fabricJsonPath}`);
      }
      
      console.log(`[MinecraftLauncher] Fabric ${loaderVersion} installed successfully for Minecraft ${minecraftVersion}`);
      
      // CRITICAL FIX: Ensure Fabric profile includes asset index for MCLC
      try {
        const fabricJson = JSON.parse(fs.readFileSync(fabricJsonPath, 'utf8'));
        
        // If Fabric profile doesn't have assetIndex, inherit it from vanilla
        if (!fabricJson.assetIndex) {
          const vanillaJsonPath = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.json`);
          if (fs.existsSync(vanillaJsonPath)) {
            const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
            if (vanillaJson.assetIndex) {
              fabricJson.assetIndex = vanillaJson.assetIndex;
              fs.writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2));
              console.log(`[MinecraftLauncher] Added asset index to Fabric profile: ${vanillaJson.assetIndex.id}`);
            }
          }
        }
      } catch (fabricFixError) {
        console.warn(`[MinecraftLauncher] Could not fix Fabric asset index: ${fabricFixError.message}`);
      }
      
      // Clean up installer
      try {
        fs.unlinkSync(installerPath);
      } catch (cleanupError) {
        console.warn(`[MinecraftLauncher] Could not cleanup installer: ${cleanupError.message}`);
      }
      
      return { 
        success: true, 
        profileName: fabricProfileName,
        loaderVersion: loaderVersion 
      };
      
    } catch (error) {
      console.error(`[MinecraftLauncher] Fabric installation failed:`, error);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  // Fix Fabric profile to include asset index for MCLC compatibility
  async fixFabricAssetIndex(clientPath, fabricProfileName, vanillaVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      const fabricJsonPath = path.join(versionsDir, fabricProfileName, `${fabricProfileName}.json`);
      const vanillaJsonPath = path.join(versionsDir, vanillaVersion, `${vanillaVersion}.json`);
      
      if (!fs.existsSync(fabricJsonPath) || !fs.existsSync(vanillaJsonPath)) {
        console.warn(`[MinecraftLauncher] Cannot fix Fabric asset index - missing files`);
        return false;
      }
      
      const fabricJson = JSON.parse(fs.readFileSync(fabricJsonPath, 'utf8'));
      const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
      
      // If Fabric profile doesn't have assetIndex, inherit it from vanilla
      if (!fabricJson.assetIndex && vanillaJson.assetIndex) {
        fabricJson.assetIndex = vanillaJson.assetIndex;
        fs.writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2));
        console.log(`[MinecraftLauncher] 🔧 Fixed Fabric profile with asset index: ${vanillaJson.assetIndex.id}`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.warn(`[MinecraftLauncher] Could not fix Fabric asset index: ${error.message}`);
      return false;
    }
  }

  // Add server to Minecraft's server list
  async addServerToList(clientPath, serverInfo) {
    try {
      console.log(`[MinecraftLauncher] Adding server to list: ${serverInfo.name} (${serverInfo.ip}:${serverInfo.port})`);
      
      const serversFile = path.join(clientPath, 'servers.dat');
      
      // For modern Minecraft, we'll create a simple servers.dat NBT file
      // This is a basic implementation that works with most Minecraft versions
      
      // Server entry data
      const serverEntry = {
        ip: `${serverInfo.ip}:${serverInfo.port}`,
        name: serverInfo.name,
        acceptTextures: true,
        icon: ""
      };
      
      // Create a simple NBT-like structure
      // This is a simplified approach that Minecraft can read
      const nbtData = {
        "": {
          servers: [serverEntry]
        }
      };
      
      // Try to create a basic NBT file structure
      // Since we don't have a full NBT library, we'll use a workaround
      try {
        // Create the directory if it doesn't exist
        const serversDir = path.dirname(serversFile);
        if (!fs.existsSync(serversDir)) {
          fs.mkdirSync(serversDir, { recursive: true });
        }
        
        // Write a minimal NBT-compatible file
        // This uses a simple binary format that Minecraft can recognize
        const buffer = Buffer.alloc(256);
        let offset = 0;
        
        // NBT compound tag start
        buffer.writeUInt8(10, offset++); // TAG_Compound
        buffer.writeUInt16BE(0, offset); offset += 2; // Name length (0)
        
        // servers list
        buffer.writeUInt8(9, offset++); // TAG_List
        buffer.writeUInt16BE(7, offset); offset += 2; // Name length
        buffer.write('servers', offset); offset += 7; // Name
        buffer.writeUInt8(10, offset++); // List type (TAG_Compound)
        buffer.writeUInt32BE(1, offset); offset += 4; // List length (1 server)
        
        // Server compound
        buffer.writeUInt8(8, offset++); // TAG_String for ip
        buffer.writeUInt16BE(2, offset); offset += 2; // Name length
        buffer.write('ip', offset); offset += 2; // Name
        const ipStr = `${serverInfo.ip}:${serverInfo.port}`;
        buffer.writeUInt16BE(ipStr.length, offset); offset += 2;
        buffer.write(ipStr, offset); offset += ipStr.length;
        
        buffer.writeUInt8(8, offset++); // TAG_String for name
        buffer.writeUInt16BE(4, offset); offset += 2; // Name length
        buffer.write('name', offset); offset += 4; // Name
        buffer.writeUInt16BE(serverInfo.name.length, offset); offset += 2;
        buffer.write(serverInfo.name, offset); offset += serverInfo.name.length;
        
        buffer.writeUInt8(0, offset++); // TAG_End for server compound
        buffer.writeUInt8(0, offset++); // TAG_End for root compound
        
        // Write the buffer to file
        fs.writeFileSync(serversFile, buffer.slice(0, offset));
        console.log(`[MinecraftLauncher] Created servers.dat with ${serverInfo.name}`);
        
      } catch (nbtError) {
        console.warn('[MinecraftLauncher] Could not create NBT servers.dat, using fallback method:', nbtError.message);
        
        // Fallback: Create a simple text file that some clients can read
        const serverText = `${serverInfo.name}\n${serverInfo.ip}:${serverInfo.port}\n`;
        const serversTextFile = path.join(clientPath, 'servers.txt');
        fs.writeFileSync(serversTextFile, serverText);
        console.log(`[MinecraftLauncher] Created servers.txt as fallback`);
      }
      
      return { success: true };
      
    } catch (error) {
      console.error('[MinecraftLauncher] Error adding server to list:', error);
      return { success: false, error: error.message };
    }
  }
}

// Singleton instance
let launcherInstance = null;

function getMinecraftLauncher() {
  console.log('💡 getMinecraftLauncher() CALLED - launcherInstance exists:', !!launcherInstance);
  if (!launcherInstance) {
    console.log('💡 Creating new MinecraftLauncher instance...');
    launcherInstance = new MinecraftLauncher();
    // Redirect all calls to the new "Simple" downloader:
    launcherInstance.downloadMinecraftClient = launcherInstance.downloadMinecraftClientSimple;
    console.log('🔧 LAUNCHER INSTANCE CREATED - downloadMinecraftClient now aliases to downloadMinecraftClientSimple');
    console.log('💡 Available methods on instance:', Object.getOwnPropertyNames(Object.getPrototypeOf(launcherInstance)).filter(name => name.startsWith('download')));
  } else {
    console.log('💡 Returning existing launcher instance');
  }
  return launcherInstance;
}

module.exports = {
  MinecraftLauncher,
  getMinecraftLauncher
}; 