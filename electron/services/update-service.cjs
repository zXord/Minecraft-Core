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
      // Check if running in development
      if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
        return true;
      }

      // Check if repository config is placeholder/invalid
      const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
      const publishConfig = packageJson?.build?.publish;
      
      if (!publishConfig || 
          publishConfig.owner === 'GITHUB_USERNAME' || 
          publishConfig.repo === 'GITHUB_REPO_NAME' ||
          !publishConfig.owner ||
          !publishConfig.repo) {
        return true;
      }

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
      this.emit('update-error', error);
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
      return { success: false, error: error.message };
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