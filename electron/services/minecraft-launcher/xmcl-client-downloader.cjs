const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { 
  installTask,
  getVersionList
} = require('@xmcl/installer');
const utils = require('./utils.cjs');

/**
 * XMCL-based Minecraft Client Downloader
 * Replaces the complex manual implementation with the professional @xmcl/installer library
 * Maintains compatibility with existing UI events and progress system
 */
class XMCLClientDownloader {
  constructor(javaManager, eventEmitter, legacyClientDownloader = null) {
    this.javaManager = javaManager;
    this.emitter = eventEmitter;
    this.legacyClientDownloader = legacyClientDownloader;
    this.versionCache = null;
    
    // Increase max listeners to prevent memory leak warnings
    if (this.emitter && this.emitter.setMaxListeners) {
      this.emitter.setMaxListeners(20);
    }
    
    // Also increase for process if needed
    if (process.setMaxListeners) {
      process.setMaxListeners(20);
    }
  }

  /**
   * Get cached version list or fetch if not available
   */
  async getVersionList() {
    if (!this.versionCache) {
      try {
        this.versionCache = await getVersionList();
      } catch (error) {
        throw new Error(`Failed to fetch Minecraft version list: ${error.message}`);
      }
    }
    return this.versionCache;
  }

  /**
   * Extract clean version from fabric profile name if needed
   */
  extractVersionFromProfileName(versionString) {
    if (!versionString) return 'latest';
    
    // If already a clean version (just numbers and dots), return as-is
    if (/^\d+\.\d+\.\d+$/.test(versionString)) {
      return versionString;
    }
    
    // If it's a fabric profile name like "fabric-loader-0.16.14-1.21.1", extract just the loader version
    if (versionString.startsWith('fabric-loader-')) {
      const parts = versionString.split('-');
      // fabric-loader-X.Y.Z-MC_VERSION -> extract X.Y.Z
      if (parts.length >= 3) {
        return parts[2]; // The loader version part
      }
    }
    
    // Otherwise return as-is
    return versionString;
  }

  /**
   * Resolve Fabric loader version (handle 'latest' keyword)
   */
  async resolveFabricVersion(requestedVersion) {
    // First clean the version in case it's a profile name
    const cleanVersion = this.extractVersionFromProfileName(requestedVersion);
    
    if (cleanVersion === 'latest') {
      try {
        // Fetch from Fabric Meta API directly
        const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
        const loaders = await response.json();
        if (loaders && loaders.length > 0 && loaders[0].version) {
          return loaders[0].version;
        }
        return '0.15.11'; // Fallback to known stable version
      } catch {
        return '0.15.11'; // Fallback
      }
    }
    return cleanVersion;
  }

  /**
   * Main download method - replaces the complex downloadMinecraftClientSimple
   */
  async downloadMinecraftClientSimple(clientPath, minecraftVersion, options = {}) {
    this.emitter.emit('client-download-start', { version: minecraftVersion });
    
    const { 
      requiredMods = [], 
      serverInfo = null 
    } = options;
    
    let needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
    let requestedFabricVersion = serverInfo?.loaderVersion || 'latest';
    let resolvedFabricVersion = requestedFabricVersion;
    
    const maxRetries = 2;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        if (retryCount > 0) {
          this.emitter.emit('client-download-progress', {
            type: 'Retrying',
            task: `Retry attempt ${retryCount + 1}/${maxRetries}...`,
            total: 1,
            current: 0
          });
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // Step 1: Ensure Java is available
        const requiredJavaVersion = utils.getRequiredJavaVersion(minecraftVersion);
        
        this.emitter.emit('client-download-progress', {
          type: 'Java',
          task: `Checking Java ${requiredJavaVersion}...`,
          total: 1
        });
        
        const javaResult = await this.javaManager.ensureJava(requiredJavaVersion, (progress) => {
          this.emitter.emit('client-download-progress', {
            type: progress.type,
            task: progress.task,
            total: progress.totalMB || 0,
            current: progress.downloadedMB || 0
          });
        });
        
        if (!javaResult.success) {
          throw new Error(`Failed to obtain Java ${requiredJavaVersion}: ${javaResult.error}`);
        }

        // Step 2: Get version info
        this.emitter.emit('client-download-progress', {
          type: 'Preparing',
          task: 'Fetching version information...',
          total: 1
        });

        const versionList = await this.getVersionList();
        const versionInfo = versionList.versions.find(v => v.id === minecraftVersion);
        
        if (!versionInfo) {
          throw new Error(`Minecraft version ${minecraftVersion} not found`);
        }

        // Step 3: Install Minecraft using XMCL
        this.emitter.emit('client-download-progress', {
          type: 'Installing',
          task: 'Installing Minecraft client, libraries, and assets...',
          total: 100,
          current: 0
        });

        const installTaskInstance = installTask(versionInfo, clientPath);
        
        // Track if download is cancelled to prevent memory leaks
        let isCancelled = false;
        
        try {
          // Monitor installation progress with XMCL's task system
          await installTaskInstance.startAndWait({
            onStart: (task) => {
              if (isCancelled) return;
              
              // Convert XMCL task path to user-friendly message
              const taskMessage = this.getTaskDisplayName(task);
              this.emitter.emit('client-download-progress', {
                type: 'Installing',
                task: taskMessage,
                total: 100,
                current: Math.round((installTaskInstance.progress / installTaskInstance.total) * 100)
              });
            },
            onUpdate: (task) => {
              if (isCancelled) return;
              
              // Update progress based on overall installation progress
              const overallProgress = Math.round((installTaskInstance.progress / installTaskInstance.total) * 100);
              const taskMessage = this.getTaskDisplayName(task);
              
              this.emitter.emit('client-download-progress', {
                type: 'Installing',
                task: taskMessage,
                total: 100,
                current: overallProgress
              });
            },
            onFailed: (task, error) => {
              if (!isCancelled) {
                console.error(`❌ Task failed [${task.path}]:`, error);
              }
            },
            onSucceed: (task) => {
              if (isCancelled) return;
              
              // Task completed successfully - emit a simpler message
              const overallProgress = Math.round((installTaskInstance.progress / installTaskInstance.total) * 100);
              this.emitter.emit('client-download-progress', {
                type: 'Installing',
                task: 'Installing Minecraft client...',
                total: 100,
                current: overallProgress
              });
            }
          });
        } catch (error) {
          // Mark as cancelled to stop further event emissions
          isCancelled = true;
          throw error;
        }

        let finalVersion = minecraftVersion;

        // Step 4: Install Fabric if needed
        if (needsFabric) {
          this.emitter.emit('client-download-progress', {
            type: 'Fabric',
            task: `Installing Fabric loader ${requestedFabricVersion}...`,
            total: 100,
            current: 90
          });

          try {
            resolvedFabricVersion = await this.resolveFabricVersion(requestedFabricVersion);
            
            // For now, skip Fabric installation via XMCL and fall back to legacy method
            // This can be enhanced later with proper Fabric API integration
            throw new Error('XMCL Fabric integration needs further API research');
            
          } catch (fabricError) {
            console.log('⚠️ XMCL Fabric installation failed, attempting legacy method...');
            
            // Fall back to legacy Fabric installation
            try {
              if (!this.legacyClientDownloader) {
                throw new Error('Legacy downloader not available for Fabric fallback');
              }
              
              // Pass only the resolved version, not a profile name
              const cleanFabricVersion = this.extractVersionFromProfileName(requestedFabricVersion);
              const legacyFabricResult = await this.legacyClientDownloader.installFabricLoader(clientPath, minecraftVersion, cleanFabricVersion);
              
              if (legacyFabricResult.success) {
                resolvedFabricVersion = legacyFabricResult.loaderVersion;
                finalVersion = legacyFabricResult.profileName;
                
                this.emitter.emit('client-download-progress', {
                  type: 'Fabric',
                  task: `✅ Fabric ${resolvedFabricVersion} installed successfully (legacy method)`,
                  total: 100,
                  current: 95
                });
              } else {
                throw new Error(`Legacy Fabric installation failed: ${legacyFabricResult.error}`);
              }
            } catch (legacyFabricError) {
              console.error('❌ Both XMCL and legacy Fabric installation failed:', legacyFabricError);
              
              const hasRequiredMods = requiredMods && requiredMods.length > 0;
              
              if (hasRequiredMods) {
                throw new Error(`Cannot install Fabric for required mods: ${legacyFabricError.message}`);
              } else {
                // Continue with vanilla if Fabric fails and no required mods
                needsFabric = false;
                finalVersion = minecraftVersion;
                this.emitter.emit('client-download-progress', {
                  type: 'Warning',
                  task: '⚠️ Fabric installation failed, using vanilla Minecraft',
                  total: 100,
                  current: 95
                });
              }
            }
          }
        }

        // Step 5: Final verification (now with correct finalVersion)
        this.emitter.emit('client-download-progress', {
          type: 'Verifying',
          task: 'Verifying installation...',
          total: 100,
          current: 98
        });

        // Use the XMCL verifier directly to avoid any legacy version resolution issues
        const verificationResult = await this.verifyInstallation(clientPath, finalVersion);
        
        if (!verificationResult.success) {
          throw new Error(`Installation verification failed: ${verificationResult.error}`);
        }

        // Step 6: Success!
        const clientType = needsFabric ? `Fabric ${resolvedFabricVersion}` : 'Vanilla';
        const successMessage = needsFabric ? 
          `✅ Minecraft ${minecraftVersion} with ${clientType} installation completed successfully` :
          `✅ Minecraft ${minecraftVersion} (${clientType}) installation completed successfully`;
          
        this.emitter.emit('client-download-progress', {
          type: 'Complete',
          task: successMessage,
          total: 100,
          current: 100
        });

        // Step 7: Automatic cleanup of old versions
        this.emitter.emit('client-download-progress', {
          type: 'Cleanup',
          task: '🗑️ Cleaning up old versions...',
          total: 100,
          current: 100
        });

        const cleanupResult = await this.cleanupOldVersions(clientPath, minecraftVersion, needsFabric ? finalVersion : null);
        if (cleanupResult.success) {
          console.log(`✅ Cleanup completed: ${cleanupResult.message}`);
        } else {
          console.warn(`⚠️ Cleanup warning: ${cleanupResult.error}`);
        }

        this.emitter.emit('client-download-complete', {
          success: true,
          version: finalVersion,
          minecraftVersion: minecraftVersion,
          fabricVersion: needsFabric ? resolvedFabricVersion : null,
          path: clientPath,          cleanup: cleanupResult
        });

        return {
          success: true,
          version: finalVersion,
          minecraftVersion: minecraftVersion,
          fabricVersion: needsFabric ? resolvedFabricVersion : null,
          cleanup: cleanupResult
        };

      } catch (error) {
        console.error(`❌ Download attempt ${retryCount + 1} failed:`, error);
        
        retryCount++;
        if (retryCount >= maxRetries) {
          this.emitter.emit('client-download-error', {
            error: error.message,
            version: minecraftVersion,
            attempt: retryCount
          });
          
          throw new Error(`Download failed after ${maxRetries} attempts: ${error.message}`);
        }
      }
    }
  }

  /**
   * Convert XMCL task path to user-friendly display name
   */
  getTaskDisplayName(task) {
    const path = task.path || '';
    const taskName = task.name || '';
    
    // Convert technical task paths to user-friendly messages
    if (path.includes('install.version.json')) {
      return 'Downloading version manifest...';
    } else if (path.includes('install.version.jar')) {
      return `Downloading Minecraft ${taskName} client...`;
    } else if (path.includes('install.dependencies.assets')) {
      return 'Downloading game assets...';
    } else if (path.includes('install.dependencies.libraries')) {
      return 'Downloading game libraries...';
    } else if (path.includes('install.assets')) {
      return 'Installing game assets...';
    } else if (path.includes('install.libraries')) {
      return 'Installing game libraries...';
    } else if (taskName && taskName !== 'install') {
      return `Installing ${taskName}...`;
    } else {
      return 'Installing Minecraft client...';
    }
  }

  /**
   * Verify the completed installation
   */
  async verifyInstallation(clientPath, version) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      const versionDir = path.join(versionsDir, version);
      const versionJson = path.join(versionDir, `${version}.json`);

      // Check if version directory exists
      if (!fs.existsSync(versionDir)) {
        return { success: false, error: `Version directory not found: ${versionDir}` };
      }

      // Check if version JSON exists
      if (!fs.existsSync(versionJson)) {
        return { success: false, error: `Version JSON not found: ${versionJson}` };
      }

      // For Fabric profiles, we need to check the base Minecraft JAR, not the Fabric profile JAR
      const isFabricProfile = version.includes('fabric-loader');
      
      if (isFabricProfile) {
        // Extract base version from Fabric profile name (e.g., fabric-loader-0.16.14-1.21.2 -> 1.21.2)
        const baseVersion = version.split('-').pop();
        const baseVersionDir = path.join(versionsDir, baseVersion);
        const baseVersionJar = path.join(baseVersionDir, `${baseVersion}.jar`);
        
        // Check if base Minecraft JAR exists
        if (!fs.existsSync(baseVersionJar)) {
          return { success: false, error: `Base Minecraft JAR not found for Fabric profile: ${baseVersionJar}` };
        }
        
        // Basic size check for base JAR
        const jarStats = fs.statSync(baseVersionJar);
        if (jarStats.size < 1024 * 1024) { // Less than 1MB is suspicious
          return { success: false, error: `Base Minecraft JAR appears to be incomplete: ${baseVersionJar}` };
        }
        
        // For Fabric profiles, we also need to check if the profile JSON is properly set up
        try {
          const profileJson = JSON.parse(fs.readFileSync(versionJson, 'utf8'));
          if (!profileJson.inheritsFrom && !profileJson.jar) {
            return { success: false, error: `Fabric profile appears to be incomplete: missing inheritsFrom or jar reference` };
          }
        } catch (jsonError) {
          return { success: false, error: `Fabric profile JSON is corrupted: ${jsonError.message}` };
        }
        
      } else {
        // For vanilla versions, check the version's own JAR
        const versionJar = path.join(versionDir, `${version}.jar`);
        
        if (!fs.existsSync(versionJar)) {
          return { success: false, error: `Client JAR not found for version: ${versionJar}` };
        }
        
        // Basic size check for JAR files
        const jarStats = fs.statSync(versionJar);
        if (jarStats.size < 1024 * 1024) { // Less than 1MB is suspicious
          return { success: false, error: `Client JAR file appears to be incomplete: ${versionJar}` };
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: `Verification failed: ${error.message}` };
    }
  }

  /**
   * Legacy method compatibility - check if client is synchronized
   */
  async checkMinecraftClient(clientPath, version) {
    try {
      // Check if version has changed since last check
      const versionChangeDetected = await this._checkForVersionChange(clientPath, version);
      if (versionChangeDetected) {
        // Clean up old versions when server version changes
        await this._cleanupOldVersionsOnChange(clientPath, version);
      }
      
      const verification = await this.verifyInstallation(clientPath, version);
      return {
        synchronized: verification.success,
        reason: verification.error || 'Client is properly installed'
      };
    } catch (error) {
      return {
        synchronized: false,
        reason: `Check failed: ${error.message}`
      };
    }
  }

  /**
   * Check if the server version has changed since the last client check
   */
  async _checkForVersionChange(clientPath, requiredVersion) {
    try {
      const lastVersionFile = path.join(clientPath, '.last-server-version');
      
      if (!fs.existsSync(lastVersionFile)) {
        // First time check - save the version and no cleanup needed
        fs.writeFileSync(lastVersionFile, requiredVersion, 'utf8');
        return false;
      }
      
      const lastVersion = fs.readFileSync(lastVersionFile, 'utf8').trim();
      
      if (lastVersion !== requiredVersion) {
        // Version changed - update the file
        fs.writeFileSync(lastVersionFile, requiredVersion, 'utf8');
        console.log(`🔄 Server version changed: ${lastVersion} → ${requiredVersion}`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Failed to check version change:', error);
      return false;
    }
  }

  /**
   * Clean up old versions when server version changes
   */
  async _cleanupOldVersionsOnChange(clientPath, currentVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      if (!fs.existsSync(versionsDir)) {
        return { success: true, message: 'No versions directory to clean up' };
      }

      const versionDirs = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      let cleanedVersions = [];

      for (const versionDir of versionDirs) {
        // Keep only the current version - remove all others
        if (versionDir === currentVersion) {
          continue; // Keep current vanilla version
        }
        
        // For Fabric profiles, keep only those matching the current version
        if (versionDir.startsWith('fabric-loader-') && versionDir.endsWith(`-${currentVersion}`)) {
          continue; // Keep current Fabric profile
        }

        // Remove everything else
        const versionPath = path.join(versionsDir, versionDir);
        try {
          fs.rmSync(versionPath, { recursive: true, force: true });
          cleanedVersions.push(versionDir);
          console.log(`🗑️ Cleaned up old version: ${versionDir}`);
        } catch (error) {
          console.error(`❌ Failed to remove ${versionDir}:`, error.message);
        }
      }

      console.log(`🔄 Version change cleanup: removed ${cleanedVersions.length} old versions`);

      return {
        success: true,
        message: `Cleaned up ${cleanedVersions.length} old versions due to version change`,
        cleanedVersions
      };

    } catch (error) {
      console.error('❌ Version change cleanup failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Clean up old Minecraft versions after successful download
   */
  async cleanupOldVersions(clientPath, currentVersion, currentFabricVersion = null) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      if (!fs.existsSync(versionsDir)) {
        return { success: true, message: 'No versions directory to clean up' };
      }

      const versionDirs = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      let cleanedVersions = [];
      let protectedVersions = [];

      for (const versionDir of versionDirs) {
        const shouldKeep = this.shouldKeepVersion(versionDir, currentVersion, currentFabricVersion);
        
        if (shouldKeep.keep) {
          protectedVersions.push(versionDir);
          continue;
        }

        // Remove old version directory
        const versionPath = path.join(versionsDir, versionDir);
        try {
          fs.rmSync(versionPath, { recursive: true, force: true });
          cleanedVersions.push(versionDir);
          console.log(`🗑️ Cleaned up old version: ${versionDir}`);
        } catch (error) {
          console.error(`❌ Failed to remove ${versionDir}:`, error.message);
        }
      }

      this.emitter.emit('client-download-progress', {
        type: 'Cleanup',
        task: `🗑️ Cleaned up ${cleanedVersions.length} old versions`,
        total: 100,
        current: 100
      });

      return {
        success: true,
        message: `Cleaned up ${cleanedVersions.length} old versions`,
        cleanedVersions,
        protectedVersions
      };

    } catch (error) {
      console.error('❌ Cleanup failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  /**
   * Determine if a version should be kept or cleaned up
   */
  shouldKeepVersion(versionDir, currentVersion, currentFabricVersion) {
    // Only keep the current vanilla version
    if (versionDir === currentVersion) {
      return { keep: true, reason: 'Current vanilla version' };
    }

    // Only keep the current Fabric version
    if (currentFabricVersion && versionDir === currentFabricVersion) {
      return { keep: true, reason: 'Current Fabric version' };
    }

    // Remove everything else - no exceptions
    return { keep: false, reason: 'Old version - cleaning up' };
  }

  // Clear Minecraft client files for re-download
  async clearMinecraftClient(clientPath, minecraftVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      
      // Remove specific version directory
      if (minecraftVersion) {
        const versionDir = path.join(versionsDir, minecraftVersion);
        if (fs.existsSync(versionDir)) {
          fs.rmSync(versionDir, { recursive: true, force: true });
        }
        
        // Also remove Fabric profiles for this version
        if (fs.existsSync(versionsDir)) {
          const allVersions = fs.readdirSync(versionsDir);
          for (const version of allVersions) {
            if (version.includes(`fabric-loader-`) && version.endsWith(`-${minecraftVersion}`)) {
              const fabricDir = path.join(versionsDir, version);
              if (fs.existsSync(fabricDir)) {
                fs.rmSync(fabricDir, { recursive: true, force: true });
                console.log(`🗑️ Removed Fabric profile: ${version}`);
              }
            }
          }
        }
      }
      
      return { success: true, message: `Cleared client files for ${minecraftVersion}` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Clear assets directory
  async clearAssets(clientPath) {
    try {
      const assetsDir = path.join(clientPath, 'assets');
      if (fs.existsSync(assetsDir)) {
        fs.rmSync(assetsDir, { recursive: true, force: true });
      }
      return { success: true, message: 'Cleared assets directory' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = XMCLClientDownloader;
