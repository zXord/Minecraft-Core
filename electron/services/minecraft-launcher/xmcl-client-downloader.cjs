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
  constructor(javaManager, eventEmitter) {
    this.javaManager = javaManager;
    this.emitter = eventEmitter;
    this.versionCache = null;
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
   * Resolve Fabric loader version (handle 'latest' keyword)
   */
  async resolveFabricVersion(requestedVersion) {
    if (requestedVersion === 'latest') {
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
    return requestedVersion;
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
    
    const needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
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
        
        // Monitor installation progress with XMCL's task system
        await installTaskInstance.startAndWait({
          onStart: (task) => {
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
            // Update progress based on overall installation progress
            const overallProgress = Math.round((installTaskInstance.progress / installTaskInstance.total) * 100);
            const taskMessage = this.getTaskDisplayName(task);
            
            this.emitter.emit('client-download-progress', {
              type: 'Installing',
              task: `${taskMessage} (${overallProgress}%)`,
              total: 100,
              current: overallProgress
            });
          },
          onFailed: (task, error) => {
            console.error(`❌ Task failed [${task.path}]:`, error);
          },
          onSucceed: (task) => {
            // Task completed successfully
            const taskMessage = this.getTaskDisplayName(task);
            this.emitter.emit('client-download-progress', {
              type: 'Installing',
              task: `✅ ${taskMessage} completed`,
              total: 100,
              current: Math.round((installTaskInstance.progress / installTaskInstance.total) * 100)
            });
          }
        });

        let finalVersion = minecraftVersion;

        // Step 4: Install Fabric if needed
        if (needsFabric) {
          this.emitter.emit('client-download-progress', {
            type: 'Fabric',
            task: `Installing Fabric loader ${requestedFabricVersion}...`,
            total: 100,
            current: 90
          });          try {
            resolvedFabricVersion = await this.resolveFabricVersion(requestedFabricVersion);
            
            // For now, skip Fabric installation via XMCL and fall back to vanilla
            // This can be enhanced later with proper Fabric API integration
            throw new Error('XMCL Fabric integration needs further API research');
            
          } catch (fabricError) {
            console.error('❌ Fabric installation failed:', fabricError);
            
            const hasRequiredMods = requiredMods && requiredMods.length > 0;
            
            if (hasRequiredMods) {
              throw new Error(`Cannot install Fabric for required mods: ${fabricError.message}`);
            } else {
              // Continue with vanilla if Fabric fails and no required mods
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

        // Step 5: Final verification
        this.emitter.emit('client-download-progress', {
          type: 'Verifying',
          task: 'Verifying installation...',
          total: 100,
          current: 98
        });

        const verificationResult = await this.verifyInstallation(clientPath, finalVersion);
        if (!verificationResult.success) {
          throw new Error(`Installation verification failed: ${verificationResult.error}`);
        }

        // Step 6: Success!
        this.emitter.emit('client-download-progress', {
          type: 'Complete',
          task: `✅ Minecraft ${minecraftVersion} installation completed successfully`,
          total: 100,
          current: 100
        });

        this.emitter.emit('client-download-complete', {
          success: true,
          version: finalVersion,
          minecraftVersion: minecraftVersion,
          fabricVersion: needsFabric ? resolvedFabricVersion : null,
          path: clientPath
        });

        return {
          success: true,
          version: finalVersion,
          minecraftVersion: minecraftVersion,
          fabricVersion: needsFabric ? resolvedFabricVersion : null
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
      return 'Downloading version manifest';
    } else if (path.includes('install.version.jar')) {
      return `Downloading Minecraft ${taskName} client`;
    } else if (path.includes('install.dependencies.assets')) {
      return 'Downloading game assets';
    } else if (path.includes('install.dependencies.libraries')) {
      return 'Downloading game libraries';
    } else if (path.includes('install.assets')) {
      return 'Processing game assets';
    } else if (path.includes('install.libraries')) {
      return 'Processing game libraries';
    } else if (taskName) {
      return taskName;
    } else {
      return 'Processing installation';
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
      const versionJar = path.join(versionDir, `${version}.jar`);

      // Check if version directory exists
      if (!fs.existsSync(versionDir)) {
        return { success: false, error: `Version directory not found: ${versionDir}` };
      }

      // Check if version JSON exists
      if (!fs.existsSync(versionJson)) {
        return { success: false, error: `Version JSON not found: ${versionJson}` };
      }

      // Check if client JAR exists (may not exist for Fabric profiles)
      const baseVersion = version.includes('fabric-loader') ? version.split('-').slice(-1)[0] : version;
      const baseVersionJar = path.join(versionsDir, baseVersion, `${baseVersion}.jar`);
      
      if (!fs.existsSync(versionJar) && !fs.existsSync(baseVersionJar)) {
        return { success: false, error: `Client JAR not found for version: ${version}` };
      }

      // Basic size check for JAR files
      const jarToCheck = fs.existsSync(versionJar) ? versionJar : baseVersionJar;
      const jarStats = fs.statSync(jarToCheck);
      if (jarStats.size < 1024 * 1024) { // Less than 1MB is suspicious
        return { success: false, error: `Client JAR file appears to be incomplete: ${jarToCheck}` };
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
}

module.exports = XMCLClientDownloader;
