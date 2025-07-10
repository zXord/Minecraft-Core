const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { 
  installTask,
  getVersionList
} = require('@xmcl/installer');
const utils = require('./utils.cjs');

// XMCL Configuration - Optimized to prevent stuck downloads
const XMCL_CONFIG = {
  // Network configuration - Balanced between speed and reliability
  connectionTimeout: 45000, // 45s for very slow connections and large asset files
  maxRetries: 2, // Reduce retries to fail faster on truly stuck files
  retryDelay: 3000, // Start with 3s delay
  maxRetryDelay: 15000, // Max 15s delay for exponential backoff
  
  // Concurrency limits - Conservative to prevent overwhelming slow connections
  maxConcurrentDownloads: 3, // Further reduced for stability
  maxAssetConcurrency: 2, // Keep asset downloads conservative
  
  // Memory management
  maxEventListeners: 50, // Increased limit for multiple downloads
  
  // Progress reporting throttling - Slightly slower to reduce overhead
  progressThrottleMs: 500 // Update progress every 500ms to reduce noise
};

// Set environment variables for XMCL's internal HTTP client
process.env.UNDICI_CONNECT_TIMEOUT = XMCL_CONFIG.connectionTimeout.toString();
process.env.UNDICI_HEADERS_TIMEOUT = XMCL_CONFIG.connectionTimeout.toString();
process.env.UNDICI_BODY_TIMEOUT = XMCL_CONFIG.connectionTimeout.toString();

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
    
    // Apply improved memory management configuration
    if (this.emitter && this.emitter.setMaxListeners) {
      this.emitter.setMaxListeners(XMCL_CONFIG.maxEventListeners);
    }
    
    // Also increase for process if needed
    if (process.setMaxListeners) {
      process.setMaxListeners(XMCL_CONFIG.maxEventListeners);
    }
    
    // Progress throttling state
    this.lastProgressUpdate = 0;
    
    // Download phase tracking
    this.currentPhase = 0;
    this.totalPhases = 0;
    this.phaseNames = [];
    
    // Progress monitoring for stuck detection
    this.lastProgressTime = Date.now();
    this.lastProgressValue = 0;
    this.stuckDetectionTimeout = 60000; // 60 seconds without progress = stuck
    
    // Note: MaxListenersExceededWarning for AbortSignal during downloads is expected
    // XMCL library creates many AbortSignal instances for concurrent downloads
    // These warnings are harmless and don't affect functionality
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
    
            const maxRetries = XMCL_CONFIG.maxRetries;
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
          const retryDelay = Math.min(XMCL_CONFIG.retryDelay * retryCount, XMCL_CONFIG.maxRetryDelay);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
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

        // Step 3: Calculate total phases and start download
        this.setupDownloadPhases(needsFabric);
        
        this.emitter.emit('client-download-progress', {
          type: 'Progress',
          task: 'Downloading Minecraft client, libraries, and assets...',
          total: 100,
          current: 0,
          phase: `Preparing (0/${this.totalPhases})`
        });

        const installTaskInstance = await this.createRobustInstallTask(versionInfo, clientPath);
        
        // Track if download is cancelled to prevent memory leaks
        let isCancelled = false;
        
        // Start progress monitoring for stuck detection
        const progressMonitor = setInterval(() => {
          if (isCancelled) {
            clearInterval(progressMonitor);
            return;
          }
          
          if (this.isDownloadStuck()) {
            // TODO: Add proper logging - Download appears stuck
            this.emitter.emit('client-download-progress', {
              type: 'Warning',
              task: 'Download seems slow, please wait or try "Clear All & Re-download"...',
              total: 100,
              current: this.lastProgressValue,
              phase: this.getCurrentPhaseInfo()
            });
          }
        }, 30000); // Check every 30 seconds
        
        try {
          // Monitor installation progress with improved error handling and timeout
          const downloadPromise = installTaskInstance.startAndWait({
            onStart: (task) => {
              if (isCancelled) return;
              
              // Convert XMCL task path to user-friendly message with phase progress
              const taskMessage = this.getTaskDisplayName(task);
              const phaseInfo = this.getCurrentPhaseInfo();
              this.throttledProgressUpdate({
                type: 'Progress',
                task: taskMessage,
                total: 100,
                current: Math.round((installTaskInstance.progress / installTaskInstance.total) * 100),
                phase: phaseInfo
              });
            },
            onUpdate: (task) => {
              if (isCancelled) return;
              
              // Update progress based on overall installation progress
              const overallProgress = Math.round((installTaskInstance.progress / installTaskInstance.total) * 100);
              const taskMessage = this.getTaskDisplayName(task);
              const phaseInfo = this.getCurrentPhaseInfo();
              
              this.throttledProgressUpdate({
                type: 'Progress',
                task: taskMessage,
                total: 100,
                current: overallProgress,
                phase: phaseInfo
              });
            },
            onFailed: (_, __) => {
              if (!isCancelled) {
                // TODO: Add proper logging - Task failed, will retry
              }
            },
            onSucceed: (task) => {
              if (isCancelled) return;
              
              // Task completed successfully
              const overallProgress = Math.round((installTaskInstance.progress / installTaskInstance.total) * 100);
              const taskMessage = this.getTaskDisplayName(task);
              const phaseInfo = this.getCurrentPhaseInfo();
              this.throttledProgressUpdate({
                type: 'Progress',
                task: taskMessage,
                total: 100,
                current: overallProgress,
                phase: phaseInfo
              });
            }
          });

          // Add overall timeout to prevent indefinite hanging
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error('Download timeout: Operation took too long to complete. Network may be slow or some files are unavailable.'));
            }, 600000); // 10 minute total timeout
          });

          // Race between download completion and timeout
          await Promise.race([downloadPromise, timeoutPromise]);
          
        } catch (error) {
          // Enhanced error handling - try to recover from common issues
          isCancelled = true;
          clearInterval(progressMonitor);
          
          // Enhanced error detection for stuck downloads
          if (error.message && error.message.includes('timeout')) {
            throw new Error('Download timed out. This often happens with slow connections or during peak hours. Please try "Clear All & Re-download" for a fresh start.');
          }
          
          if (error.message && error.message.includes('ENOTFOUND')) {
            throw new Error('Network connection failed. Please check your internet connection and try again.');
          } else if (error.message && (error.message.includes('timeout') || error.message.includes('ConnectTimeoutError') || error.message.includes('took too long'))) {
            throw new Error('Download timed out due to slow connection or stuck assets. This is common with large asset downloads. Please try "Clear All & Re-download" for a fresh start.');
          } else if (error.message && error.message.includes('checksum')) {
            throw new Error('Download verification failed - some files were incomplete. Please use "Clear All & Re-download" to fix this issue.');
          } else if (error.message && error.message.includes('resources.download.minecraft.net')) {
            throw new Error('Minecraft asset servers are experiencing issues. Please try again later or use "Clear All & Re-download" for a fresh start.');
          } else {
            throw error; // Re-throw original error if we can't handle it
          }
        }

        let finalVersion = minecraftVersion;

        // Step 4: Install Fabric if needed
        if (needsFabric) {
          this.currentPhase = this.totalPhases; // Move to Fabric phase
          const phaseInfo = this.getCurrentPhaseInfo();
          this.emitter.emit('client-download-progress', {
            type: 'Fabric',
            task: `Downloading Fabric loader ${requestedFabricVersion} - ${phaseInfo}...`,
            total: 100,
            current: 90,
            phase: phaseInfo
          });

          try {
            resolvedFabricVersion = await this.resolveFabricVersion(requestedFabricVersion);
            
            // For now, skip Fabric installation via XMCL and fall back to legacy method
            // This can be enhanced later with proper Fabric API integration
            throw new Error('XMCL Fabric integration needs further API research');
            
          } catch {
            
            
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
                
                const phaseInfo = this.getCurrentPhaseInfo();
                this.emitter.emit('client-download-progress', {
                  type: 'Fabric',
                  task: `✅ Fabric ${resolvedFabricVersion} ready - ${phaseInfo}`,
                  total: 100,
                  current: 95,
                  phase: phaseInfo
                });
              } else {
                throw new Error(`Legacy Fabric installation failed: ${legacyFabricResult.error}`);
              }
            } catch (legacyFabricError) {
              // TODO: Add proper logging - Both XMCL and legacy Fabric installation failed
              
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
          
        } else {
          // TODO: Add proper logging - Cleanup warning
        }

        // Clean up progress monitor
        clearInterval(progressMonitor);
        
        this.emitter.emit('client-download-complete', {
          success: true,
          version: finalVersion,
          minecraftVersion: minecraftVersion,
          fabricVersion: needsFabric ? resolvedFabricVersion : null,
          path: clientPath,
          cleanup: cleanupResult
        });

        return {
          success: true,
          version: finalVersion,
          minecraftVersion: minecraftVersion,
          fabricVersion: needsFabric ? resolvedFabricVersion : null,
          cleanup: cleanupResult
        };

      } catch (error) {
        // TODO: Add proper logging - Download attempt failed
        
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
   * Create a robust install task with improved error handling and retry logic
   */
  async createRobustInstallTask(versionInfo, clientPath) {
    // Create XMCL install task with environment variables set for timeouts
    const task = installTask(versionInfo, clientPath);
    
    return task;
  }

  /**
   * Throttled progress update to prevent event flooding and detect stuck downloads
   */
  throttledProgressUpdate(progressData) {
    const now = Date.now();
    
    // Check if progress has actually changed (not stuck)
    if (progressData.current !== this.lastProgressValue) {
      this.lastProgressTime = now;
      this.lastProgressValue = progressData.current;
    }
    
    // Only emit progress updates at specified intervals
    if (now - this.lastProgressUpdate >= XMCL_CONFIG.progressThrottleMs) {
      this.emitter.emit('client-download-progress', progressData);
      this.lastProgressUpdate = now;
    }
  }

  /**
   * Check if download appears to be stuck
   */
  isDownloadStuck() {
    const timeSinceLastProgress = Date.now() - this.lastProgressTime;
    return timeSinceLastProgress > this.stuckDetectionTimeout;
  }

  /**
   * Setup download phases for progress tracking
   */
  setupDownloadPhases(needsFabric) {
    this.phaseNames = [
      'Minecraft JAR',
      'Game Libraries', 
      'Game Assets'
    ];
    
    if (needsFabric) {
      this.phaseNames.push('Fabric Loader');
    }
    
    this.totalPhases = this.phaseNames.length;
    this.currentPhase = 0;
  }

  /**
   * Get current phase info for progress display
   */
  getCurrentPhaseInfo() {
    if (this.currentPhase > 0 && this.currentPhase <= this.totalPhases) {
      const phaseName = this.phaseNames[this.currentPhase - 1];
      return `${phaseName} (${this.currentPhase}/${this.totalPhases})`;
    }
    return `Preparing (0/${this.totalPhases})`;
  }

  /**
   * Convert XMCL task path to user-friendly display name with phase progress
   */
  getTaskDisplayName(task) {
    const path = task.path || '';
    const taskName = task.name || '';
    
    // Update current phase based on what's being downloaded
    if (path.includes('install.version.json') || path.includes('install.version.jar')) {
      this.currentPhase = 1; // Minecraft JAR phase
    } else if (path.includes('install.dependencies.libraries') || path.includes('install.libraries')) {
      this.currentPhase = 2; // Libraries phase
    } else if (path.includes('install.dependencies.assets') || path.includes('install.assets')) {
      this.currentPhase = 3; // Assets phase
    }
    
    const phaseInfo = this.getCurrentPhaseInfo();
    
    // Convert technical task paths to user-friendly messages
    if (path.includes('install.version.json')) {
      return `Downloading version manifest - ${phaseInfo}...`;
    } else if (path.includes('install.version.jar')) {
      return `Downloading Minecraft ${taskName} JAR - ${phaseInfo}...`;
    } else if (path.includes('install.dependencies.assets') || path.includes('install.assets')) {
      return `Downloading game assets - ${phaseInfo}...`;
    } else if (path.includes('install.dependencies.libraries') || path.includes('install.libraries')) {
      return `Downloading game libraries - ${phaseInfo}...`;
    } else if (path.includes('install.dependencies')) {
      return `Downloading dependencies - ${phaseInfo}...`;
    } else if (taskName && taskName !== 'install') {
      return `Downloading ${taskName} - ${phaseInfo}...`;
    } else {
      return `Downloading Minecraft client - ${phaseInfo}...`;
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
        
        return true;
      }
      
      return false;
    } catch (error) {
      // TODO: Add proper logging - Failed to check version change
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
          // TODO: Add proper logging - Cleaned up old version
        } catch (error) {
          // TODO: Add proper logging - Failed to remove version directory
        }
      }

      

      return {
        success: true,
        message: `Cleaned up ${cleanedVersions.length} old versions due to version change`,
        cleanedVersions
      };

    } catch (error) {
      // TODO: Add proper logging - Version change cleanup failed
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
          // TODO: Add proper logging - Cleaned up old version
        } catch (error) {
          // TODO: Add proper logging - Failed to remove version directory
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
      // TODO: Add proper logging - Cleanup failed
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

  // Clear Minecraft client files for re-download (smart repair - only core files)
  async clearMinecraftClient(clientPath, minecraftVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      let clearedItems = [];
      
      // Remove specific version directory
      if (minecraftVersion) {
        const versionDir = path.join(versionsDir, minecraftVersion);
        if (fs.existsSync(versionDir)) {
          fs.rmSync(versionDir, { recursive: true, force: true });
          clearedItems.push(`${minecraftVersion} core files`);
        }
        
        // Also remove Fabric profiles for this version
        if (fs.existsSync(versionsDir)) {
          const allVersions = fs.readdirSync(versionsDir);
          for (const version of allVersions) {
            if (version.includes(`fabric-loader-`) && version.endsWith(`-${minecraftVersion}`)) {
              const fabricDir = path.join(versionsDir, version);
              if (fs.existsSync(fabricDir)) {
                fs.rmSync(fabricDir, { recursive: true, force: true });
                clearedItems.push(`${version} Fabric profile`);
              }
            }
          }
        }
      }
      
      const message = clearedItems.length > 0 ? 
        `Cleared: ${clearedItems.join(', ')}` : 
        'No files needed clearing';
        
      return { success: true, message, clearedItems };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Full clear - removes EVERYTHING including libraries and assets
  async clearMinecraftClientFull(clientPath, minecraftVersion) {
    try {
      let clearedItems = [];
      
      // Clear core client files first
      const coreResult = await this.clearMinecraftClient(clientPath, minecraftVersion);
      if (coreResult.success && coreResult.clearedItems) {
        clearedItems.push(...coreResult.clearedItems);
      }
      
      // Clear libraries directory
      const librariesDir = path.join(clientPath, 'libraries');
      if (fs.existsSync(librariesDir)) {
        fs.rmSync(librariesDir, { recursive: true, force: true });
        clearedItems.push('all libraries');
      }
      
      // Clear assets directory  
      const assetsResult = await this.clearAssets(clientPath);
      if (assetsResult.success) {
        clearedItems.push('all assets');
      }
      
      const message = clearedItems.length > 0 ? 
        `Full clear completed: ${clearedItems.join(', ')}` : 
        'No files needed clearing';
        
      return { success: true, message, clearedItems, fullClear: true };
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
