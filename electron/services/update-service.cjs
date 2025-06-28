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
        console.log('Update service: Development mode - NODE_ENV or --dev detected');
        return true;
      }

      // Check if app is packaged - if not packaged, we're in development
      const { app } = require('electron');
      console.log('Update service: app.isPackaged =', app.isPackaged);
      if (!app.isPackaged) {
        console.log('Update service: Development mode - app not packaged');
        return true;
      }

      // For packaged apps, force production mode regardless of GitHub config
      // Since we know this is a production build if it's packaged
      console.log('Update service: Production mode - app is packaged');
      return false;
    } catch (error) {
      console.log('Update service: Error checking development mode, assuming development');
      return true;
    }
  }

  setupAutoUpdater() {
    // Check if we're in development or have invalid repository config
    if (this.isDevelopmentMode()) {
      console.log('Update service: Development mode detected, skipping update checks');
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
      console.log('Update service: Skipping update check in development mode');
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
      console.log('Update service: Skipping periodic checks in development mode');
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
      // This would need to be implemented with GitHub API
      // For now, return current update info
      const currentStatus = this.getUpdateStatus();
      return {
        success: true,
        currentVersion: currentStatus.currentVersion,
        targetVersion: targetVersion,
        needsUpdate: currentStatus.currentVersion !== targetVersion,
        isNewerAvailable: this.updateAvailable && this.latestVersion === targetVersion
      };
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