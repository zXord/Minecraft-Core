// Minecraft launcher service for client launching with Microsoft authentication
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

// BULLET-PROOF CONSOLE HIDING: Monkey-patch child_process.spawn BEFORE requiring MCLC
// This ensures ALL spawn calls (including MCLC's internal ones) get windowsHide: true
const childProcess = require('child_process');
const originalSpawn = childProcess.spawn;

childProcess.spawn = function(command, args, options = {}) {
  // Force windowsHide: true on Windows for ALL spawned processes
  if (process.platform === 'win32') {
    options.windowsHide = true;
    console.log(`[SpawnPatch] Forcing windowsHide: true for: ${command}`);
  }
  
  return originalSpawn.call(this, command, args, options);
};

console.log('[MinecraftLauncher] Applied bullet-proof spawn patch for console hiding');

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
    console.log(`[JavaManager] Ensuring Java ${javaVersion} is available...`);
    console.log(`[JavaManager] Java base directory: ${this.javaBaseDir}`);
    
    const javaInstalled = this.isJavaInstalled(javaVersion);
    console.log(`[JavaManager] Java ${javaVersion} installed check: ${javaInstalled}`);
    
    if (javaInstalled) {
      const javaPath = this.getJavaExecutablePath(javaVersion);
      console.log(`[JavaManager] Java ${javaVersion} is already installed at: ${javaPath}`);
      return { success: true, javaPath: javaPath };
    }
    
    console.log(`[JavaManager] Java ${javaVersion} not found, downloading...`);
    return await this.downloadJava(javaVersion, progressCallback);
  }

  // Helper method to kill any running Java processes for this client
  async killClientJavaProcesses(clientPath) {
    try {
      console.log(`[JavaManager] Attempting to kill Java processes for client: ${clientPath}`);
      
      if (process.platform === 'win32') {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        // Kill any Java processes that might be using files in this client directory
        try {
          const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq java.exe" /FO CSV', { timeout: 5000 });
          const { stdout2 } = await execAsync('tasklist /FI "IMAGENAME eq javaw.exe" /FO CSV', { timeout: 5000 });
          
          // Parse and kill relevant Java processes
          const allOutput = (stdout || '') + (stdout2 || '');
          if (allOutput.includes('java')) {
            console.log(`[JavaManager] Found Java processes, attempting to kill...`);
            
            // Force kill all Java processes (brutal but necessary for cleanup)
            await execAsync('taskkill /F /IM java.exe', { timeout: 5000 }).catch(() => {});
            await execAsync('taskkill /F /IM javaw.exe', { timeout: 5000 }).catch(() => {});
            
            // Wait for processes to actually die
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } catch (killError) {
          console.warn(`[JavaManager] Could not kill Java processes: ${killError.message}`);
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
  async downloadMinecraftClientSimple(clientPath, minecraftVersion) {
    this.emit('client-download-start', { version: minecraftVersion });
    
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
        
        // Use the Authenticator from MCLC to create a valid offline auth for downloading
        const { Authenticator } = require('minecraft-launcher-core');
        const offlineAuth = Authenticator.getAuth('OfflinePlayer', '12345'); // Offline authentication for download
        
        // More conservative download options to reduce file handle usage
        const downloadOptions = {
          authorization: offlineAuth,
          root: clientPath,
          version: {
            number: minecraftVersion,
            type: "release"
          },
          memory: {
            max: "1G", // Reduced memory usage
            min: "512M"
          },
          // Conservative settings to prevent EMFILE errors
          clientPackage: null,
          removePackage: false,
          forge: false,
          timeout: 600000, // 10 minute timeout
          detached: false,
          // Add options to limit concurrent operations
          overrides: {
            maxSockets: 4, // Limit concurrent downloads
            timeout: 30000 // 30 second timeout per operation
          }
        };
        
        console.log(`[MinecraftLauncher] Download options prepared, starting MCLC download...`);
        
        // Start the download process with proper error handling
        let downloadProcess;
        
        try {
          downloadProcess = await downloadClient.launch(downloadOptions);
          console.log(`[MinecraftLauncher] MCLC download process started`);
          
          // Wait for the process to complete or exit with timeout
          if (downloadProcess && downloadProcess.pid) {
            console.log(`[MinecraftLauncher] Download process running with PID: ${downloadProcess.pid}`);
            
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                console.log(`[MinecraftLauncher] Download process timeout, considering it completed`);
                resolve();
              }, 600000); // 10 minute timeout
              
              downloadProcess.on('exit', (code) => {
                clearTimeout(timeout);
                console.log(`[MinecraftLauncher] Download process exited with code: ${code}`);
                resolve();
              });
              
              downloadProcess.on('error', (error) => {
                clearTimeout(timeout);
                console.error(`[MinecraftLauncher] Download process error:`, error);
                // Don't reject immediately, let verification determine success
                resolve();
              });
            });
          } else {
            console.log(`[MinecraftLauncher] Download completed without persistent process`);
          }
          
        } catch (launchError) {
          console.log(`[MinecraftLauncher] Launch error (expected with offline auth): ${launchError.message}`);
          // This is expected when using offline auth - the files should still be downloaded
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
        
        // Verify that the download was successful
        const verificationResult = await this.checkMinecraftClient(clientPath, minecraftVersion);
        
        if (verificationResult.synchronized) {
          console.log(`[MinecraftLauncher] Successfully downloaded and verified Minecraft ${minecraftVersion}`);
          
          this.emit('client-download-complete', { 
            success: true, 
            version: minecraftVersion,
            message: `Successfully downloaded Minecraft ${minecraftVersion} with Java ${requiredJavaVersion} and all required libraries and assets.`
          });
          
          return { 
            success: true, 
            version: minecraftVersion,
            message: `Successfully downloaded Minecraft ${minecraftVersion} with Java ${requiredJavaVersion} and all required libraries and assets.`
          };
        } else {
          throw new Error(`Download verification failed: ${verificationResult.reason}`);
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
    
    if (!this.authData) {
      throw new Error('Not authenticated. Please login first.');
    }
    
    if (this.isLaunching) {
      throw new Error('Minecraft is already launching');
    }
    
    this.isLaunching = true;
    this.clientPath = clientPath;
    
    // Update JavaManager to use client-specific directory
    this.javaManager.setClientPath(clientPath);
    
    try {
      console.log(`[MinecraftLauncher] Launching Minecraft ${minecraftVersion} for ${this.authData.name}`);
      console.log(`[MinecraftLauncher] Client path: ${clientPath}`);
      console.log(`[MinecraftLauncher] Java will be downloaded to: ${path.join(clientPath, 'java')}`);
      
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
        
        javaResult = await this.javaManager.ensureJava(requiredJavaVersion, (progress) => {
          this.emit('launch-progress', {
            type: progress.type,
            task: progress.task,
            total: progress.totalMB || 0,
            current: progress.downloadedMB || 0
          });
        });
        
        if (!javaResult.success) {
          throw new Error(`Client-specific Java failed: ${javaResult.error}`);
        }
        
        console.log(`[MinecraftLauncher] Client-specific Java available: ${javaResult.javaPath}`);
        
        // Test our downloaded Java directly with very conservative settings
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        const testResult = await execAsync(`"${javaResult.javaPath}" -Xmx256M -Xms128M -version`, { timeout: 10000 });
        console.log(`[MinecraftLauncher] Client-specific Java test passed`);
        
      } catch (downloadedJavaError) {
        console.error(`[MinecraftLauncher] Client-specific Java failed:`, downloadedJavaError);
        
        // Fall back to system Java
        console.log(`[MinecraftLauncher] Falling back to system Java...`);
        const systemJavaResult = await this.checkJavaInstallation();
        
        if (systemJavaResult.success) {
          javaResult = { success: true, javaPath: systemJavaResult.javaPath };
          console.log(`[MinecraftLauncher] Using system Java: ${javaResult.javaPath}`);
        } else {
          throw new Error(`Both client-specific and system Java failed. Client-specific: ${downloadedJavaError.message}, System: ${systemJavaResult.error}`);
        }
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
      
      // CRITICAL: Ensure we use javaw.exe (no console) instead of java.exe on Windows
      if (process.platform === 'win32' && finalJavaPath.includes('java.exe')) {
        const javawPath = finalJavaPath.replace('java.exe', 'javaw.exe');
        if (fs.existsSync(javawPath)) {
          finalJavaPath = javawPath;
          console.log(`[MinecraftLauncher] - Using javaw.exe to prevent console window: ${finalJavaPath}`);
        } else {
          console.warn(`[MinecraftLauncher] - javaw.exe not found, using java.exe (console will be visible)`);
        }
      }
      
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
      
      // Prepare launch options with modern MCLC structure
      const launchOptions = {
        authorization: authorization,
        root: clientPath,
        version: {
          number: minecraftVersion,
          type: "release"
        },
        // Modern MCLC v3: all JVM settings go in the java block
        java: {
          path: finalJavaPath,        // full path to javaw.exe
          args: [
            `-Xms${finalMinMemory}M`,
            `-Xmx${finalMaxMemory}M`,
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
        // Basic options
        clientPackage: null,
        removePackage: false,
        cwd: clientPath,
        overrides: {
          gameDirectory: clientPath
        },
        // CRITICAL: Top-level spawn options that MCLC v3 actually reads
        spawn: {
          windowsHide: true,                      // prevents the console window on Windows
          detached: false,                        // keep child tied to app (prevents new console session)
          stdio: ['ignore', 'ignore', 'ignore']  // silence stdin/stdout/stderr
        }
      };
      
      // Add server to the multiplayer server list so it appears automatically
      await this.addServerToList(clientPath, {
        name: serverInfo?.serverInfo?.name || serverInfo?.name || 'Game Server',
        ip: serverIp,
        port: parseInt(serverPort)
      });
      
      console.log('[MinecraftLauncher] Launch options prepared:', {
        root: launchOptions.root,
        version: launchOptions.version,
        memory: launchOptions.memory,
        serverConnection: `${serverIp}:${parseInt(serverPort)}`,
        hasAuth: !!launchOptions.authorization,
        javaPath: launchOptions.java.path
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
      
      // CRITICAL: Log the exact JVM command being generated
      this.client.on('arguments', (args) => {
        console.log(`[MCLC Arguments] JVM Command: ${args.join(' ')}`);
        console.log(`[MCLC Arguments] Using javaw.exe: ${args[0].includes('javaw.exe') ? 'YES' : 'NO'}`);
        console.log(`[MCLC Arguments] Spawn patch will force windowsHide: true`);
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
      
      // Launch with standard MCLC approach + monkey-patch console hiding
      console.log('[MinecraftLauncher] Starting Minecraft launch with monkey-patched spawn...');
      this.emit('launch-start');
      
      console.log('[MinecraftLauncher] Calling client.launch() with spawn patch active...');
      
      // Standard MCLC launch - the monkey-patch will force windowsHide on all spawns
      let launchResult; // Declare outside try block for proper scoping
      try {
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
      
      // Simple check: if we got a result and no immediate error, consider it successful
      if (launchResult || launchResult === null) {
        console.log('[MinecraftLauncher] Launch appears successful, monitoring for process...');
        
        // Set up monitoring for process if available
        if (this.client && this.client.child) {
          console.log(`[MinecraftLauncher] Minecraft process detected with PID: ${this.client.child.pid}`);
          
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
        } else {
          console.log('[MinecraftLauncher] No direct process access, but launch completed successfully');
          // Even without direct process access, we can assume success if no error was thrown
        }
        
        console.log('[MinecraftLauncher] Minecraft launch completed successfully with spawn patch');
        this.emit('launch-success');
        
        return { success: true };
      } else {
        throw new Error('Launch failed - minecraft-launcher-core returned no result');
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
      
      // Method 2: Kill Java processes (Windows-specific fallback)
      if (process.platform === 'win32') {
        try {
          console.log('[MinecraftLauncher] Attempting to stop Java processes on Windows...');
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);
          
          // Kill Java processes that might be Minecraft
          await execAsync('taskkill /F /IM javaw.exe /T', { windowsHide: true }).catch(() => {
            console.log('[MinecraftLauncher] No javaw.exe processes to kill');
          });
          
          await execAsync('taskkill /F /IM java.exe /T', { windowsHide: true }).catch(() => {
            console.log('[MinecraftLauncher] No java.exe processes to kill');
          });
          
          stopped = true;
          console.log('[MinecraftLauncher] Windows process termination completed');
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
  async checkMinecraftClient(clientPath, requiredVersion) {
    try {
      console.log(`[MinecraftLauncher] Checking client files for ${requiredVersion} in: ${clientPath}`);
      
      if (!fs.existsSync(clientPath)) {
        console.log(`[MinecraftLauncher] Client path does not exist: ${clientPath}`);
        return { synchronized: false, reason: 'Client path does not exist' };
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
      const versionDir = path.join(versionsDir, requiredVersion);
      const jarFile = path.join(versionDir, `${requiredVersion}.jar`);
      const jsonFile = path.join(versionDir, `${requiredVersion}.json`);
      const librariesDir = path.join(clientPath, 'libraries');
      const assetsDir = path.join(clientPath, 'assets');
      
      console.log(`[MinecraftLauncher] Checking for version directory: ${versionDir}`);
      
      // Check if version folder exists
      if (!fs.existsSync(versionDir)) {
        console.log(`[MinecraftLauncher] Version directory missing: ${versionDir}`);
        return { synchronized: false, reason: `Version ${requiredVersion} not downloaded` };
      }
      
      console.log(`[MinecraftLauncher] Checking for JAR file: ${jarFile}`);
      
      // Check if required files exist
      if (!fs.existsSync(jarFile)) {
        console.log(`[MinecraftLauncher] JAR file missing: ${jarFile}`);
        return { synchronized: false, reason: `Client JAR missing for ${requiredVersion}` };
      }
      
      console.log(`[MinecraftLauncher] Checking for JSON file: ${jsonFile}`);
      
      if (!fs.existsSync(jsonFile)) {
        console.log(`[MinecraftLauncher] JSON file missing: ${jsonFile}`);
        return { synchronized: false, reason: `Version manifest missing for ${requiredVersion}` };
      }
      
      // Verify the files are not empty
      const jarStats = fs.statSync(jarFile);
      const jsonStats = fs.statSync(jsonFile);
      
      if (jarStats.size === 0) {
        console.log(`[MinecraftLauncher] JAR file is empty: ${jarFile}`);
        return { synchronized: false, reason: `Client JAR file is corrupted (empty)` };
      }
      
      if (jsonStats.size === 0) {
        console.log(`[MinecraftLauncher] JSON file is empty: ${jsonFile}`);
        return { synchronized: false, reason: `Version manifest is corrupted (empty)` };
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
      console.log(`[MinecraftLauncher] Client files verified for ${requiredVersion}:`);
      console.log(`[MinecraftLauncher] - JAR: ${jarStats.size} bytes`);
      console.log(`[MinecraftLauncher] - JSON: ${jsonStats.size} bytes`);
      console.log(`[MinecraftLauncher] - Libraries: present with content`);
      console.log(`[MinecraftLauncher] - Assets: present with content`);
      console.log(`[MinecraftLauncher] - Java ${requiredJavaVersion}: available`);
      
      return { 
        synchronized: true, 
        reason: `All client files and Java ${requiredJavaVersion} are present and verified`,
        javaVersion: requiredJavaVersion
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
  if (!launcherInstance) {
    launcherInstance = new MinecraftLauncher();
  }
  return launcherInstance;
}

module.exports = {
  MinecraftLauncher,
  getMinecraftLauncher
}; 