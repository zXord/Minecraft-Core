const { autoUpdater } = require('electron-updater');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

class UpdateService extends EventEmitter {
  constructor() {
    super();
    this.updateCheckInterval = null;
    this.isCheckingForUpdates = false;
    this.downloadProgress = {
      percent: 0,
      bytesPerSecond: 0,
      total: 0,
      transferred: 0
    };
    this.ignoredVersion = null;
    this.autoInstallEnabled = false;
    this.currentVersion = null;
    this.latestVersion = null;
    this.updateAvailable = false;

    this.setupAutoUpdater();
    this.loadIgnoredVersion();
  }

  // Check if we're in development mode or have invalid config
  isDevelopmentMode() {
    try {
      // First check if we're running from source (npm run dev)
      if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
        return true;
      }

      // Check if app is packaged - if not packaged, we're in development
      const { app } = require('electron');
      if (!app.isPackaged) {
        return true;
      }

      // For packaged apps, assume production mode
      return false;
    } catch (error) {
      // If we can't determine, assume development for safety
      return true;
    }
  }

  setupAutoUpdater() {
    // Check if we're in development or have invalid repository config
    if (this.isDevelopmentMode()) {
      return;
    }

    // Configure auto-updater
    autoUpdater.autoDownload = false; // We'll control when to download
    autoUpdater.autoInstallOnAppQuit = false; // We'll control when to install

    // Set up event listeners
    autoUpdater.on('checking-for-update', () => {
      this.isCheckingForUpdates = true;
      this.emit('checking-for-update');
    });

    autoUpdater.on('update-available', (info) => {
      this.isCheckingForUpdates = false;
      this.latestVersion = info.version;
      this.updateAvailable = true;
      
      // Check if this version is ignored
      if (this.ignoredVersion === info.version) {
        this.emit('update-ignored', info);
        return;
      }
      
      this.emit('update-available', info);
    });

    autoUpdater.on('update-not-available', (info) => {
      this.isCheckingForUpdates = false;
      this.updateAvailable = false;
      this.emit('update-not-available', info);
    });

    autoUpdater.on('error', (error) => {
      this.isCheckingForUpdates = false;
      
      // Create user-friendly error message
      const friendlyError = this.createFriendlyError(error);
      this.emit('update-error', friendlyError);
    });

    autoUpdater.on('download-progress', (progress) => {
      this.downloadProgress = {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred
      };
      this.emit('download-progress', this.downloadProgress);
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.emit('update-downloaded', info);
      
      // Auto-install if enabled
      if (this.autoInstallEnabled) {
        this.quitAndInstall();
      }
    });
  }

  // Get current app version
  getCurrentVersion() {
    if (!this.currentVersion) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
        this.currentVersion = packageJson.version;
      } catch (error) {
        console.error('Failed to read current version:', error);
        this.currentVersion = '1.0.0'; // Fallback
      }
    }
    return this.currentVersion;
  }

  // Create user-friendly error messages
  createFriendlyError(error) {
    const errorMessage = error.message || error.toString();
    
    // Check for common error patterns
    if (errorMessage.includes('404')) {
      return {
        type: 'repository_not_found',
        title: 'Repository Not Available',
        message: 'The update repository is not publicly accessible. This usually means the repository is private or doesn\'t exist.',
        details: 'Updates will be available once the repository is made public.',
        technical: errorMessage
      };
    }
    
    if (errorMessage.includes('403') || errorMessage.includes('authentication')) {
      return {
        type: 'authentication_error',
        title: 'Access Denied',
        message: 'Unable to access the update repository due to authentication issues.',
        details: 'Please check if the repository is public or contact the developer.',
        technical: errorMessage
      };
    }
    
    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('network')) {
      return {
        type: 'network_error',
        title: 'Network Connection Error',
        message: 'Unable to connect to the update server. Please check your internet connection.',
        details: 'Try again later or check your network settings.',
        technical: errorMessage
      };
    }
    
    if (errorMessage.includes('timeout')) {
      return {
        type: 'timeout_error',
        title: 'Request Timeout',
        message: 'The update check timed out. The server might be slow or unavailable.',
        details: 'Please try again in a few minutes.',
        technical: errorMessage
      };
    }
    
    // Generic error for unknown issues
    return {
      type: 'unknown_error',
      title: 'Update Check Failed',
      message: 'An unexpected error occurred while checking for updates.',
      details: 'Please try again later or contact support if the problem persists.',
      technical: errorMessage
    };
  }

  // Check for updates
  async checkForUpdates() {
    if (this.isCheckingForUpdates) {
      return { checking: true };
    }

    // Handle development mode
    if (this.isDevelopmentMode()) {
      return { 
        success: true, 
        currentVersion: this.getCurrentVersion(),
        updateAvailable: false,
        latestVersion: this.getCurrentVersion(),
        developmentMode: true
      };
    }

    try {
      await autoUpdater.checkForUpdates();
      return { 
        success: true, 
        currentVersion: this.getCurrentVersion(),
        updateAvailable: this.updateAvailable,
        latestVersion: this.latestVersion 
      };
    } catch (error) {
      console.error('Update check failed:', error);
      const friendlyError = this.createFriendlyError(error);
      return { 
        success: false, 
        error: friendlyError.message,
        errorDetails: friendlyError
      };
    }
  }

  // Start downloading the update
  async downloadUpdate() {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true, message: 'Download started' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Install the downloaded update
  quitAndInstall() {
    autoUpdater.quitAndInstall(false, true);
  }

  // Ignore current available version
  ignoreVersion(version) {
    this.ignoredVersion = version || this.latestVersion;
    this.saveIgnoredVersion();
    return { success: true, ignoredVersion: this.ignoredVersion };
  }

  // Clear ignored version (for "remind me later")
  clearIgnoredVersion() {
    this.ignoredVersion = null;
    this.saveIgnoredVersion();
    return { success: true };
  }

  // Set auto-install preference
  setAutoInstall(enabled) {
    this.autoInstallEnabled = enabled;
    return { success: true, autoInstallEnabled: this.autoInstallEnabled };
  }

  // Get current update status
  getUpdateStatus() {
    return {
      currentVersion: this.getCurrentVersion(),
      latestVersion: this.latestVersion,
      updateAvailable: this.updateAvailable,
      isCheckingForUpdates: this.isCheckingForUpdates,
      downloadProgress: this.downloadProgress,
      ignoredVersion: this.ignoredVersion,
      autoInstallEnabled: this.autoInstallEnabled,
      developmentMode: this.isDevelopmentMode()
    };
  }

  // Start periodic update checks (every 12 hours)
  startPeriodicChecks() {
    this.stopPeriodicChecks(); // Clear any existing interval
    
    // Handle development mode
    if (this.isDevelopmentMode()) {
      return { success: true, message: 'Periodic update checks disabled in development mode' };
    }
    
    // Check immediately on startup
    setTimeout(() => {
      this.checkForUpdates();
    }, 10000); // Wait 10 seconds after startup
    
    // Then check every 12 hours
    this.updateCheckInterval = setInterval(() => {
      this.checkForUpdates();
    }, 12 * 60 * 60 * 1000); // 12 hours in milliseconds

    return { success: true, message: 'Periodic update checks started' };
  }

  // Stop periodic update checks
  stopPeriodicChecks() {
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
    }
    return { success: true, message: 'Periodic update checks stopped' };
  }

  // Save ignored version to storage
  saveIgnoredVersion() {
    try {
      const store = require('../utils/app-store.cjs');
      if (this.ignoredVersion) {
        store.set('update.ignoredVersion', this.ignoredVersion);
      } else {
        store.delete('update.ignoredVersion');
      }
    } catch (error) {
      console.error('Failed to save ignored version:', error);
    }
  }

  // Load ignored version from storage
  loadIgnoredVersion() {
    try {
      const store = require('../utils/app-store.cjs');
      this.ignoredVersion = store.get('update.ignoredVersion') || null;
    } catch (error) {
      console.error('Failed to load ignored version:', error);
      this.ignoredVersion = null;
    }
  }

  // Check for a specific version (for server compatibility)
  async checkForSpecificVersion(targetVersion) {
    try {
      // Handle development mode
      if (this.isDevelopmentMode()) {
        return { 
          success: true, 
          currentVersion: this.getCurrentVersion(),
          targetVersion: targetVersion,
          needsUpdate: false,
          developmentMode: true
        };
      }

      const currentVersion = this.getCurrentVersion();
      
      // If we already have the target version, no update needed
      if (currentVersion === targetVersion) {
        return {
          success: true,
          currentVersion: currentVersion,
          targetVersion: targetVersion,
          needsUpdate: false,
          message: `Already on version ${targetVersion}`
        };
      }

      // Check if the specific version exists on GitHub releases
      try {
        const packageJson = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../../package.json'), 'utf8'));
        
        // Construct GitHub API URL for releases
        const owner = packageJson.build?.publish?.owner || 'zXord';
        const repo = packageJson.build?.publish?.repo || 'Minecraft-Core';
        const releasesUrl = `https://api.github.com/repos/${owner}/${repo}/releases`;
        
        const response = await fetch(releasesUrl);
        if (!response.ok) {
          throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }
        
        const releases = await response.json();
        const targetRelease = releases.find(release => 
          release.tag_name === `v${targetVersion}` || release.tag_name === targetVersion
        );
        
        if (targetRelease) {
          // Found the specific version, prepare to download it
          return {
            success: true,
            currentVersion: currentVersion,
            targetVersion: targetVersion,
            needsUpdate: true,
            releaseInfo: {
              name: targetRelease.name,
              tag_name: targetRelease.tag_name,
              published_at: targetRelease.published_at,
              body: targetRelease.body,
              assets: targetRelease.assets
            },
            message: `Version ${targetVersion} is available for download`
          };
        } else {
          return {
            success: false,
            currentVersion: currentVersion,
            targetVersion: targetVersion,
            needsUpdate: false,
            error: `Version ${targetVersion} not found in GitHub releases`
          };
        }
      } catch (error) {
        console.error('Error checking specific version:', error);
        return {
          success: false,
          currentVersion: currentVersion,
          targetVersion: targetVersion,
          needsUpdate: false,
          error: `Failed to check for version ${targetVersion}: ${error.message}`
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Download a specific version from GitHub releases
  async downloadSpecificVersion(targetVersion) {
    try {
      // Handle development mode
      if (this.isDevelopmentMode()) {
        return { 
          success: true, 
          message: 'Development mode - version download skipped',
          developmentMode: true
        };
      }

      const currentVersion = this.getCurrentVersion();
      
      // If we already have the target version, no download needed
      if (currentVersion === targetVersion) {
        return {
          success: true,
          message: `Already on version ${targetVersion}`,
          needsRestart: false
        };
      }

      // First check if the version exists
      const versionCheck = await this.checkForSpecificVersion(targetVersion);
      if (!versionCheck.success || !versionCheck.needsUpdate) {
        return {
          success: false,
          error: versionCheck.error || `Version ${targetVersion} not available`
        };
      }

      // Get the release info
      const releaseInfo = versionCheck.releaseInfo;
      if (!releaseInfo || !releaseInfo.assets || releaseInfo.assets.length === 0) {
        return {
          success: false,
          error: `No downloadable assets found for version ${targetVersion}`
        };
      }

      // Find the appropriate installer for Windows
      const windowsAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('.exe') && 
        (asset.name.includes('Setup') || asset.name.includes('setup') || asset.name.includes('installer'))
      );

      if (!windowsAsset) {
        return {
          success: false,
          error: `No Windows installer found for version ${targetVersion}`
        };
      }

      // Download the file locally with progress tracking
      const path = require('path');
      const fs = require('fs');
      const { app } = require('electron');
      
      // Create temp directory for downloads
      const tempDir = path.join(app.getPath('temp'), 'minecraft-core-updates');
      
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const fileName = windowsAsset.name;
      const filePath = path.join(tempDir, fileName);
      
      // Check if file already exists and remove it to force fresh download
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      // Emit initial progress to show download started
      this.emit('specific-version-download-progress', {
        version: targetVersion,
        progress: 0,
        downloadedSize: 0,
        totalSize: windowsAsset.size || 0,
        downloadedMB: '0.0',
        totalMB: windowsAsset.size ? (windowsAsset.size / 1024 / 1024).toFixed(2) : 'Unknown'
      });
      
      const downloadResult = await this.downloadFileWithProgress(
        windowsAsset.browser_download_url, 
        filePath, 
        targetVersion
      );
      
      if (downloadResult.success) {
        // Note: completion event is already emitted by downloadFileWithProgress
        return {
          success: true,
          message: `Version ${targetVersion} downloaded successfully`,
          filePath: filePath,
          fileName: fileName,
          version: targetVersion,
          downloadComplete: true
        };
              } else {
        this.emit('specific-version-download-error', {
          version: targetVersion,
          error: downloadResult.error || 'Download failed'
        });
        
        return {
          success: false,
          error: downloadResult.error || 'Download failed'
        };
      }
    } catch (error) {
      console.error('Error downloading specific version:', error);
      return { 
        success: false, 
        error: `Failed to download version ${targetVersion}: ${error.message}` 
      };
    }
  }

  // Download a file with progress tracking
  async downloadFileWithProgress(url, filePath, version) {
    try {
      const https = require('https');
      const fs = require('fs');

      return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
          // Handle redirects
          if (response.statusCode === 302 || response.statusCode === 301) {
            const redirectUrl = response.headers.location;
            return this.downloadFileWithProgress(redirectUrl, filePath, version)
              .then(resolve)
              .catch(reject);
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Download failed with status ${response.statusCode}`));
            return;
          }

          const totalSize = parseInt(response.headers['content-length'] || '0', 10);
          let downloadedSize = 0;

          // Create write stream
          const fileStream = fs.createWriteStream(filePath);
          
          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            fileStream.write(chunk);

            // Calculate progress - if no content-length, show indeterminate progress
            let progress = 0;
            if (totalSize > 0) {
              progress = Math.round((downloadedSize / totalSize) * 100);
            } else {
              // Indeterminate progress - show that download is happening
              progress = Math.min(99, Math.floor(downloadedSize / (1024 * 1024))); // 1% per MB downloaded, max 99%
            }
            
            // Emit progress event
            this.emit('specific-version-download-progress', {
              version: version,
              progress: progress,
              downloadedSize: downloadedSize,
              totalSize: totalSize,
              downloadedMB: (downloadedSize / 1024 / 1024).toFixed(2),
              totalMB: totalSize > 0 ? (totalSize / 1024 / 1024).toFixed(2) : 'Unknown'
            });
          });

          response.on('end', () => {
            fileStream.end();
            
            // Emit completion event
            this.emit('specific-version-download-complete', {
              version: version,
              filePath: filePath,
              success: true
            });
            
            resolve({ success: true, filePath: filePath });
          });

          response.on('error', (error) => {
            fileStream.destroy();
            // Clean up partial file
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            
            this.emit('specific-version-download-error', {
              version: version,
              error: error.message
            });
            
            reject(error);
          });
        });

        request.on('error', (error) => {
          // Clean up partial file
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          
          this.emit('specific-version-download-error', {
            version: version,
            error: error.message
          });
          
          reject(error);
        });

        request.setTimeout(30000, () => {
          request.destroy();
          reject(new Error('Download timeout'));
        });
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

// Singleton instance
let updateServiceInstance = null;

function getUpdateService() {
  if (!updateServiceInstance) {
    updateServiceInstance = new UpdateService();
  }
  return updateServiceInstance;
}

module.exports = { UpdateService, getUpdateService }; 