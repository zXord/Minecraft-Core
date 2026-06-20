const { autoUpdater } = require('electron-updater');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');
const { app } = require('electron');
const { getAppCacheDir } = require('electron-updater/out/AppAdapter');
const {
  assertSafeRemoteUrl,
  resolveSafeRedirectUrl,
  safeBaseName,
  safeFilePath
} = require('../utils/security-boundaries.cjs');
let devConfig = {};
try {
  // Optional dev overrides for update behavior
  devConfig = require('../../config/dev-config.cjs');
} catch {
  devConfig = {};
}

// Guarded require so startup won't fail if electron-log is missing for any reason
/** @type {import('electron-log').MainLogger | Console} */
let log = console;

/**
 * @param {unknown} value
 * @returns {value is import('electron-log').MainLogger}
 */
function isElectronLog(value) {
  return Boolean(value && typeof value === 'object' && 'transports' in value);
}

try {
  const loadedLog = require('electron-log');
  log = loadedLog?.default || loadedLog || console;
} catch {
  // Fallback to console; we still emit update-log events downstream
  log = console;
}

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
    this.isDownloadingSpecificVersion = false; // Flag to prevent conflicts
    this.lastSpecificVersionProgress = 0; // Track progress to prevent backwards movement
    this.lastEmittedProgress = 0; // Track last emitted progress
    this.lastProgressTime = 0; // Track last progress emission time
    this.logFilePath = null;
    this.loggerHandlers = getLoggerHandlers(); // Central logger (main process)
    this.lastLoggedProgressPercent = -1;
    this.lastLoggedProgressTime = 0;
    this.lastUpdateInfo = null;
    this.isDownloadingUpdate = false;
    this.downloadAttemptId = 0;
    this.activeDownloadAttemptId = null;
    this.lastDownloadStart = 0;
    this.lastProgressTotal = null;
    this.lastProgressTransferred = null;
    this.lastProgressPercent = null;
    this.specificVersionDownloads = new Map();
    this.installAfterCurrentDownload = false;
    this.stagedSpecificVersionInstallTest = null;

    this.setupLogger();
    this.setupAutoUpdater();
    this.loadIgnoredVersion();
  }

  getUpdateConfigPath() {
    if (autoUpdater.updateConfigPath) {
      return autoUpdater.updateConfigPath;
    }
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'app-update.yml');
    }
    return path.join(app.getAppPath(), 'dev-app-update.yml');
  }

  readUpdateConfigValue(key) {
    try {
      const configPath = this.getUpdateConfigPath();
      const content = fs.readFileSync(configPath, 'utf8');
      const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      if (!match || !match[1]) return null;
      return match[1].trim().replace(/^['"]|['"]$/g, '');
    } catch {
      return null;
    }
  }

  getUpdaterCacheDirName() {
    return this.readUpdateConfigValue('updaterCacheDirName');
  }

  getUpdaterCacheDir() {
    const cacheBase = getAppCacheDir();
    const dirName = this.getUpdaterCacheDirName() || app.getName();
    return path.join(cacheBase, dirName);
  }

  getUpdaterCacheDirs() {
    const cacheBase = getAppCacheDir();
    const appName = app.getName();
    const dirs = new Set([
      path.join(cacheBase, appName),
      path.join(cacheBase, `${appName}-updater`)
    ]);
    const configDirName = this.getUpdaterCacheDirName();
    if (configDirName) {
      dirs.add(path.join(cacheBase, configDirName));
    }
    return Array.from(dirs);
  }

  clearUpdaterCache(reason) {
    try {
      const dirs = this.getUpdaterCacheDirs();
      dirs.forEach((dir) => {
        try {
          if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            this.logUpdate('warn', 'Updater cache cleared', {
              reason,
              dir
            });
          }
        } catch (err) {
          this.logUpdate('error', 'Failed to clear updater cache', {
            reason,
            dir,
            error: err?.message
          });
        }
      });
    } catch {
      // ignore
    }
  }

  setupLogger() {
    try {
      const electronLog = isElectronLog(log) ? log : null;
      if (electronLog?.transports?.file) {
        electronLog.transports.file.level = 'debug';
      }

      // Wrap autoUpdater logger so we can mirror everything into the central logger
      const self = this;
      const makeForwarder = (level) => (...args) => {
        try {
          if (log[level]) {
            log[level](...args);
          } else {
            log.info(...args);
          }
        } catch {
          // ignore
        }

        try {
          const message = args && args.length ? args[0] : '';
          self.loggerHandlers?.logFromMain?.(level, message || 'updater log', {
            category: 'update-upstream',
            instanceId: 'system',
            data: { args }
          });
        } catch {
          // ignore
        }
      };

      autoUpdater.logger = {
        info: makeForwarder('info'),
        warn: makeForwarder('warn'),
        error: makeForwarder('error'),
        debug: makeForwarder('debug')
      };

      if (electronLog?.transports?.file) {
        this.logFilePath = electronLog.transports.file.getFile().path;
      }

      // Mirror electron-updater scoped logs into the central logger for visibility (e.g., differential fallback reasons)
      if (electronLog && Array.isArray(electronLog.hooks)) {
        electronLog.hooks.push((message) => {
          try {
            const scopeName = typeof message?.scope === 'string' ? message.scope : '';
            const data = Array.isArray(message?.data) ? message.data : [];
            const text = data.length ? data.map((item) => String(item)).join(' ') : '';

            if (scopeName.toLowerCase().includes('electron-updater')) {
              const level = (message?.level || 'info').toLowerCase();
              if (this.loggerHandlers && this.loggerHandlers.logFromMain) {
                this.loggerHandlers.logFromMain(level, text || 'updater log', {
                  category: 'update-upstream',
                  instanceId: 'system',
                  data: {
                    scope: scopeName,
                    message
                  }
                });
              }
            }
          } catch {
            // ignore hook errors
          }
          return message;
        });
      }

      this.logUpdate('info', 'UpdateService initialized', {
        logFile: this.logFilePath
      });
    } catch {
      // Swallow logger setup errors; updates should still work
    }
  }

  logUpdate(level, message, data = {}) {
    try {
      if (log[level]) {
        log[level](message, data);
      } else {
        log.info(message, data);
      }
      // Persist to main logger so it shows in the in-app Logger UI
      if (this.loggerHandlers && this.loggerHandlers.logFromMain) {
        this.loggerHandlers.logFromMain(level, message, {
          category: 'update',
          instanceId: 'system',
          data: {
            ...data,
            forceLog: true // bypass background suppression
          }
        });
      }
      this.emit('update-log', {
        timestamp: new Date().toISOString(),
        level,
        message,
        data,
        logFile: this.logFilePath
      });
    } catch {
      // Do not throw from logging
    }
  }

  summarizeUpdateFiles(files) {
    if (!Array.isArray(files)) return [];
    return files.map((file) => {
      const url = typeof file?.url === 'string' ? file.url : '';
      const name = url ? url.split('/').pop() : null;
      const size = Number.isFinite(file?.size) ? file.size : null;
      const blockMapSize = Number.isFinite(file?.blockMapSize) ? file.blockMapSize : null;
      return {
        name,
        size,
        sizeMB: size === null ? null : Number((size / 1024 / 1024).toFixed(2)),
        blockMapSize,
        blockMapSizeMB: blockMapSize === null ? null : Number((blockMapSize / 1024 / 1024).toFixed(2))
      };
    });
  }

  getCachedInstallerInfo() {
    try {
      const cacheDir = this.getUpdaterCacheDir();
      const installerPath = path.join(cacheDir, 'installer.exe');
      if (!fs.existsSync(installerPath)) {
        return { exists: false, path: installerPath };
      }
      const stats = fs.statSync(installerPath);
      return {
        exists: true,
        path: installerPath,
        size: stats.size,
        sizeMB: Number((stats.size / 1024 / 1024).toFixed(2)),
        modified: stats.mtime
      };
    } catch {
      return { exists: false, path: null };
    }
  }

  getPublishInfo() {
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
      const publish = packageJson.build?.publish || {};
      return {
        owner: publish.owner || 'zXord',
        repo: publish.repo || 'Minecraft-Core'
      };
    } catch {
      return { owner: 'zXord', repo: 'Minecraft-Core' };
    }
  }

  getUpdateFileName(info) {
    const urlValue = info?.files?.[0]?.url || info?.path;
    if (!urlValue || typeof urlValue !== 'string') return null;
    try {
      const parsed = new URL(urlValue);
      return path.basename(parsed.pathname);
    } catch {
      return path.basename(urlValue);
    }
  }

  async headContentLength(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
      if (!response.ok) return null;
      const length = response.headers.get('content-length');
      return length ? Number.parseInt(length, 10) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getReleaseAssetSize(version, fileName) {
    if (!version || !fileName) return null;
    const { owner, repo } = this.getPublishInfo();
    const tags = [`v${version}`, version];
    for (const tag of tags) {
      const url = `https://github.com/${owner}/${repo}/releases/download/${tag}/${fileName}`;
      const size = await this.headContentLength(url);
      if (Number.isFinite(size)) {
        return { url, size };
      }
    }
    return null;
  }

  async shouldDisableDifferentialDownload() {
    const updateInfo = this.lastUpdateInfo;
    const newVersion = updateInfo?.version || this.latestVersion;
    const currentVersion = this.getCurrentVersion();
    const fileName = this.getUpdateFileName(updateInfo);

    if (!newVersion || !currentVersion || !fileName) {
      return false;
    }

    const oldFileName = fileName.includes(newVersion)
      ? fileName.replace(newVersion, currentVersion)
      : fileName;

    const cached = this.getCachedInstallerInfo();
    if (!cached.exists || !cached.size) {
      this.logUpdate('info', 'Cached installer missing; skipping differential download', {
        installerPath: cached.path,
        currentVersion
      });
      return true;
    }

    const remote = await this.getReleaseAssetSize(currentVersion, oldFileName);
    if (!remote || !Number.isFinite(remote.size)) {
      return false;
    }

    if (cached.size !== remote.size) {
      this.logUpdate('warn', 'Cached installer size mismatch; skipping differential download', {
        currentVersion,
        expectedSize: remote.size,
        expectedSizeMB: Number((remote.size / 1024 / 1024).toFixed(2)),
        actualSize: cached.size,
        actualSizeMB: cached.sizeMB,
        installerPath: cached.path,
        releaseUrl: remote.url
      });
      return true;
    }

    return false;
  }

  // Check if we're in development mode or have invalid config
  isDevelopmentMode() {
    try {
      // Allow forcing updates in development with environment variable
      if (process.env.FORCE_UPDATES === 'true') {
        return false;
      }

      // Allow updates in dev when explicitly enabled in config
      if (devConfig && devConfig.enableDevUpdates === true) {
        return false;
      }
      
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
    } catch {
      // If we can't determine, assume development for safety
      return true;
    }
  }

  setupAutoUpdater() {
    // Check if we're in development or have invalid repository config
    if (this.isDevelopmentMode()) {
      this.logUpdate('info', 'Auto-updater disabled (development mode)', {
        nodeEnv: process.env.NODE_ENV || null,
        forceUpdates: process.env.FORCE_UPDATES === 'true',
        isPackaged: app.isPackaged
      });
      return;
    }

    if (!app.isPackaged && (process.env.FORCE_UPDATES === 'true' || devConfig?.enableDevUpdates === true)) {
      this.logUpdate('info', 'Auto-updater enabled in development mode', {
        nodeEnv: process.env.NODE_ENV || null,
        forceUpdates: process.env.FORCE_UPDATES === 'true',
        enableDevUpdates: devConfig?.enableDevUpdates === true,
        isPackaged: app.isPackaged
      });
    }

    // Configure auto-updater
    autoUpdater.autoDownload = false; // We'll control when to download
    autoUpdater.autoInstallOnAppQuit = false; // We'll control when to install
    autoUpdater.disableDifferentialDownload = false; // Enable differential updates
    autoUpdater.disableWebInstaller = true; // Stick to full installer artifacts

    if (!app.isPackaged) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.updateConfigPath = path.join(app.getAppPath(), 'dev-app-update.yml');
    }

    // Set up event listeners
    autoUpdater.on('checking-for-update', () => {
      this.isCheckingForUpdates = true;
      this.logUpdate('info', 'Checking for update...');
      this.emit('checking-for-update');
    });

    autoUpdater.on('update-available', (info) => {
      this.isCheckingForUpdates = false;
      this.latestVersion = info.version;
      this.updateAvailable = true;
      this.lastUpdateInfo = info;
      this.logUpdate('info', 'Update available', {
        version: info.version,
        files: this.summarizeUpdateFiles(info.files)
      });
      
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
      this.logUpdate('info', 'No update available', {
        currentVersion: this.getCurrentVersion(),
        latestVersion: info?.version || null
      });
      this.emit('update-not-available', info);
    });

    autoUpdater.on('error', (error) => {
      this.isCheckingForUpdates = false;
      const wasDownloading = this.isDownloadingUpdate;
      const attemptId = this.activeDownloadAttemptId;
      this.isDownloadingUpdate = false;
      this.activeDownloadAttemptId = null;
      this.logUpdate('error', 'Auto-updater error', {
        message: error?.message,
        stack: error?.stack,
        wasDownloading,
        downloadAttemptId: attemptId
      });

      const errMsg = (error?.message || '').toLowerCase();
      if (errMsg.includes('cannot download differentially') || errMsg.includes('checksum mismatch')) {
        this.clearUpdaterCache('checksum-mismatch-differential');
      }
      
      // Create user-friendly error message
      const friendlyError = this.createFriendlyError(error);
      this.emit('update-error', friendlyError);
    });

    autoUpdater.on('download-progress', (progress) => {
      // Don't emit auto-updater progress if we're downloading a specific version
      if (this.isDownloadingSpecificVersion) {
        return;
      }
      
      this.downloadProgress = {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred
      };

      const previousTotal = this.lastProgressTotal;
      const previousPercent = this.lastProgressPercent;
      const previousTransferred = this.lastProgressTransferred;
      const hasPreviousTotal = Number.isFinite(previousTotal) && previousTotal > 0;
      const hasCurrentTotal = Number.isFinite(this.downloadProgress.total) && this.downloadProgress.total > 0;
      const totalChanged = hasPreviousTotal && hasCurrentTotal && this.downloadProgress.total !== previousTotal;
      const percentDropped = Number.isFinite(previousPercent) && this.downloadProgress.percent + 2 < previousPercent;
      const transferredDropped = Number.isFinite(previousTransferred) && this.downloadProgress.transferred + (1024 * 1024) < previousTransferred;

      if (totalChanged) {
        this.logUpdate('info', 'Download target size changed', {
          downloadAttemptId: this.activeDownloadAttemptId,
          previousTotal,
          previousTotalMB: Number((previousTotal / 1024 / 1024).toFixed(2)),
          newTotal: this.downloadProgress.total,
          newTotalMB: Number((this.downloadProgress.total / 1024 / 1024).toFixed(2)),
          previousPercent,
          newPercent: this.downloadProgress.percent
        });
      } else if (percentDropped || transferredDropped) {
        this.logUpdate('info', 'Download progress reset detected', {
          downloadAttemptId: this.activeDownloadAttemptId,
          previousPercent,
          newPercent: this.downloadProgress.percent,
          previousTransferred,
          newTransferred: this.downloadProgress.transferred
        });
      }

      // Throttle logging to avoid flooding the Logger UI
      const now = Date.now();
      const percentChanged = this.lastLoggedProgressPercent !== this.downloadProgress.percent;
      const percentJump = Math.abs(this.downloadProgress.percent - this.lastLoggedProgressPercent) >= 5;
      const timeElapsed = now - this.lastLoggedProgressTime >= 1500; // 1.5s
      const atEdge = this.downloadProgress.percent === 0 || this.downloadProgress.percent === 100;

      if (percentChanged && (percentJump || timeElapsed || atEdge)) {
        this.lastLoggedProgressPercent = this.downloadProgress.percent;
        this.lastLoggedProgressTime = now;
        this.logUpdate('debug', 'Download progress', this.downloadProgress);
      }

      this.lastProgressTotal = this.downloadProgress.total;
      this.lastProgressPercent = this.downloadProgress.percent;
      this.lastProgressTransferred = this.downloadProgress.transferred;
      this.emit('download-progress', this.downloadProgress);
    });

    autoUpdater.on('update-downloaded', (info) => {
      const elapsedMs = this.lastDownloadStart ? Date.now() - this.lastDownloadStart : null;
      this.logUpdate('info', 'Update downloaded', {
        version: info.version,
        downloadAttemptId: this.activeDownloadAttemptId,
        elapsedMs,
        totalBytes: this.downloadProgress.total,
        totalMB: Number((this.downloadProgress.total / 1024 / 1024).toFixed(2))
      });
      this.isDownloadingUpdate = false;
      this.activeDownloadAttemptId = null;
      this.emit('update-downloaded', info);
      
      // Auto-install user-started downloads with visible installer progress, unless a server is running.
      if (this.autoInstallEnabled || this.installAfterCurrentDownload) {
        const installCheck = this.canInstallUpdatesNow();
        if (!installCheck.success) {
          this.installAfterCurrentDownload = false;
          this.logUpdate('warn', 'Auto-install skipped because a Minecraft server is running', {
            version: info.version,
            runningServers: installCheck.runningServers || []
          });
          this.emit('update-error', {
            title: 'Cannot Install Update',
            message: installCheck.error,
            details: 'Stop the server and install the downloaded update again.'
          });
          return;
        }

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
      } catch {
        // TODO: Add proper logging - Failed to read current version
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
      this.logUpdate('debug', 'Skipped check: already checking');
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
      // TODO: Add proper logging - Update check failed
      const friendlyError = this.createFriendlyError(error);
      return { 
        success: false, 
        error: friendlyError.message,
        errorDetails: friendlyError
      };
    }
  }

  // Start downloading the update
  async downloadUpdate(options = {}) {
    const installAfterDownload = options?.installAfterDownload === true;
    const previousDisableDifferential = autoUpdater.disableDifferentialDownload;
    let appliedDifferentialOverride = false;
    try {
      const nextAttemptId = this.downloadAttemptId + 1;
      const alreadyDownloading = this.isDownloadingUpdate;
      if (alreadyDownloading) {
        this.logUpdate('warn', 'Download requested while another download is active', {
          activeDownloadAttemptId: this.activeDownloadAttemptId,
          newDownloadAttemptId: nextAttemptId
        });
      } else {
        this.downloadAttemptId = nextAttemptId;
        this.activeDownloadAttemptId = nextAttemptId;
        this.isDownloadingUpdate = true;
        this.lastDownloadStart = Date.now();
        this.lastProgressTotal = null;
        this.lastProgressPercent = null;
        this.lastProgressTransferred = null;
      }
      this.installAfterCurrentDownload = installAfterDownload;
      if (!autoUpdater.disableDifferentialDownload) {
        const shouldDisable = await this.shouldDisableDifferentialDownload();
        if (shouldDisable) {
          autoUpdater.disableDifferentialDownload = true;
          appliedDifferentialOverride = true;
        }
      }
      this.logUpdate('info', 'Starting download of available update', {
        downloadAttemptId: this.activeDownloadAttemptId || nextAttemptId,
        currentVersion: this.getCurrentVersion(),
        latestVersion: this.latestVersion,
        updateAvailable: this.updateAvailable,
        files: this.summarizeUpdateFiles(this.lastUpdateInfo?.files),
        alreadyDownloading,
        differentialDisabled: autoUpdater.disableDifferentialDownload,
        differentialOverride: appliedDifferentialOverride,
        installAfterDownload
      });
      await autoUpdater.downloadUpdate();
      return { success: true, message: 'Download started' };
    } catch (error) {
      const attemptId = this.activeDownloadAttemptId;
      this.isDownloadingUpdate = false;
      this.activeDownloadAttemptId = null;
      this.installAfterCurrentDownload = false;
      this.logUpdate('error', 'Download failed', {
        message: error.message,
        downloadAttemptId: attemptId
      });
      return { success: false, error: error.message };
    } finally {
      if (appliedDifferentialOverride) {
        autoUpdater.disableDifferentialDownload = previousDisableDifferential;
      }
    }
  }

  // Install the downloaded update
  quitAndInstall() {
    this.installAfterCurrentDownload = false;
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
    } catch {
      // TODO: Add proper logging - Failed to save ignored version
    }
  }

  // Load ignored version from storage
  loadIgnoredVersion() {
    try {
      const store = require('../utils/app-store.cjs');
      this.ignoredVersion = store.get('update.ignoredVersion') || null;
    } catch {
      // TODO: Add proper logging - Failed to load ignored version
      this.ignoredVersion = null;
    }
  }

  getSpecificVersionDownloadDir() {
    return path.join(app.getPath('temp'), 'minecraft-core-updates');
  }

  getUpdateInstallTestEnvConfig() {
    const sourceInstallerPath = process.env.MC_CORE_STAGE_UPDATE_INSTALLER || '';
    if (!sourceInstallerPath) return null;

    return {
      sourceInstallerPath,
      targetVersion: process.env.MC_CORE_STAGE_UPDATE_VERSION || null,
      clientVersion: process.env.MC_CORE_STAGE_UPDATE_CLIENT_VERSION || null
    };
  }

  parseVersionFromInstallerName(fileName) {
    const name = path.basename(String(fileName || ''));
    const match = name.match(/Minecraft-Core-Setup-(.+)\.exe$/i);
    return match ? match[1] : null;
  }

  getStagedSpecificVersionInstallTestResult(record) {
    if (!record) {
      return { success: true, staged: false };
    }

    return {
      success: true,
      staged: true,
      testMode: true,
      version: record.version,
      serverVersion: record.serverVersion || record.version,
      clientVersion: record.clientVersion || null,
      filePath: record.filePath,
      fileName: record.fileName,
      size: record.size,
      checksumVerified: record.checksumVerified === true,
      checksumAlgorithm: record.checksumAlgorithm || null,
      checksumSource: record.checksumSource || null
    };
  }

  async getStagedSpecificVersionInstallTest() {
    if (
      this.stagedSpecificVersionInstallTest?.filePath &&
      fs.existsSync(this.stagedSpecificVersionInstallTest.filePath)
    ) {
      return this.getStagedSpecificVersionInstallTestResult(this.stagedSpecificVersionInstallTest);
    }

    const envConfig = this.getUpdateInstallTestEnvConfig();
    if (!envConfig) {
      return { success: true, staged: false };
    }

    return this.stageSpecificVersionInstallTest(envConfig);
  }

  async stageSpecificVersionInstallTest(options = {}) {
    if (app.isPackaged) {
      return {
        success: false,
        staged: false,
        error: 'Update install test staging is only available while running from source.'
      };
    }

    const sourceInstallerPath = typeof options.sourceInstallerPath === 'string'
      ? options.sourceInstallerPath.trim()
      : '';
    if (!sourceInstallerPath) {
      return { success: false, staged: false, error: 'Installer path is required' };
    }

    if (!fs.existsSync(sourceInstallerPath)) {
      return {
        success: false,
        staged: false,
        error: `Installer file not found at ${sourceInstallerPath}`
      };
    }

    const realSourcePath = fs.realpathSync(sourceInstallerPath);
    if (!this.isWindowsInstallerName(realSourcePath)) {
      return {
        success: false,
        staged: false,
        error: 'Installer file name is not a recognized Windows installer'
      };
    }

    const sourceStats = fs.statSync(realSourcePath);
    if (!sourceStats.isFile() || sourceStats.size <= 0) {
      return { success: false, staged: false, error: 'Installer file is empty or corrupted' };
    }

    const fileName = safeBaseName(path.basename(realSourcePath), 'installer file name', {
      allowedExtensions: ['.exe']
    });
    const tempDir = this.getSpecificVersionDownloadDir();
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const stagedFilePath = safeFilePath(tempDir, fileName, 'installer file name', {
      allowedExtensions: ['.exe']
    });
    const realTargetPath = fs.existsSync(stagedFilePath)
      ? fs.realpathSync(stagedFilePath)
      : path.resolve(stagedFilePath);

    if (realSourcePath !== realTargetPath) {
      fs.copyFileSync(realSourcePath, stagedFilePath);
    }

    const targetVersion = options.targetVersion
      || this.parseVersionFromInstallerName(fileName)
      || this.getCurrentVersion();
    const hash = await this.calculateFileHash(stagedFilePath, 'sha256', 'hex');
    const verification = {
      checksumVerified: true,
      checksumAlgorithm: 'sha256',
      checksumSource: 'local-dev-update-install-test',
      checksumEncoding: 'hex',
      expectedHash: hash,
      actualHash: hash
    };

    const record = this.rememberSpecificVersionDownload(
      stagedFilePath,
      targetVersion,
      verification
    );
    record.testMode = true;
    record.serverVersion = targetVersion;
    record.clientVersion = options.clientVersion || null;
    this.stagedSpecificVersionInstallTest = record;

    this.emit('specific-version-download-complete', {
      version: targetVersion,
      filePath: stagedFilePath,
      success: true,
      installStarted: false,
      checksumVerified: true,
      checksumAlgorithm: 'sha256',
      checksumSource: 'local-dev-update-install-test',
      testMode: true
    });

    this.logUpdate('info', 'Specific version install test staged', {
      version: targetVersion,
      fileName,
      sourceInstallerPath: realSourcePath,
      stagedFilePath
    });

    return this.getStagedSpecificVersionInstallTestResult(record);
  }

  getDownloadRecordKey(filePath) {
    const resolvedPath = path.resolve(filePath);
    return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  }

  isWindowsInstallerName(fileName) {
    const name = path.basename(String(fileName || ''));
    return /\.exe$/i.test(name) && /(setup|installer)/i.test(name);
  }

  findWindowsInstallerAsset(assets) {
    if (!Array.isArray(assets)) return null;
    return assets.find((asset) => this.isWindowsInstallerName(asset?.name)) || null;
  }

  async calculateFileHash(filePath, algorithm, encoding = 'hex') {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algorithm);
      const stream = fs.createReadStream(filePath);

      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => {
        try {
          resolve(hash.digest(encoding));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  normalizeChecksumValue(value, encoding) {
    const normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    return encoding === 'hex' ? normalized.toLowerCase() : normalized;
  }

  parseAssetDigestChecksum(digest) {
    if (typeof digest !== 'string') return null;

    const match = digest.trim().match(/^(sha256|sha512):([a-fA-F0-9]+)$/i);
    if (!match) return null;

    const algorithm = match[1].toLowerCase();
    const expectedLength = algorithm === 'sha256' ? 64 : 128;
    const expectedHash = match[2].toLowerCase();
    if (expectedHash.length !== expectedLength) return null;

    return {
      algorithm,
      expectedHash,
      encoding: 'hex',
      source: 'github-asset-digest'
    };
  }

  parseYamlScalar(value) {
    let scalar = String(value || '').trim();
    if ((scalar.startsWith('"') && scalar.endsWith('"')) || (scalar.startsWith("'") && scalar.endsWith("'"))) {
      scalar = scalar.slice(1, -1);
    }
    return scalar;
  }

  getAssetFileName(value) {
    const text = String(value || '').replace(/\\/g, '/');
    try {
      return path.basename(new URL(text).pathname);
    } catch {
      return path.basename(text);
    }
  }

  parseLatestYmlSha512(ymlText, installerFileName) {
    const targetFileName = path.basename(installerFileName).toLowerCase();
    const lines = String(ymlText || '').split(/\r?\n/);
    let topLevelPath = null;
    let topLevelSha512 = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      const topPathMatch = line.match(/^path:\s*(.+)$/);
      if (topPathMatch) {
        topLevelPath = this.parseYamlScalar(topPathMatch[1]);
      }

      const topShaMatch = line.match(/^sha512:\s*(.+)$/);
      if (topShaMatch) {
        topLevelSha512 = this.parseYamlScalar(topShaMatch[1]);
      }

      const urlMatch = line.match(/^\s*(?:-\s*)?url:\s*(.+)$/);
      if (!urlMatch) continue;

      const urlValue = this.parseYamlScalar(urlMatch[1]);
      if (this.getAssetFileName(urlValue).toLowerCase() !== targetFileName) continue;

      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
        if (/^\s*-\s*url:\s*/.test(lines[blockIndex])) break;

        const shaMatch = lines[blockIndex].match(/^\s*sha512:\s*(.+)$/);
        if (shaMatch) {
          return {
            algorithm: 'sha512',
            expectedHash: this.parseYamlScalar(shaMatch[1]),
            encoding: 'base64',
            source: 'latest.yml'
          };
        }
      }
    }

    if (
      topLevelPath &&
      topLevelSha512 &&
      this.getAssetFileName(topLevelPath).toLowerCase() === targetFileName
    ) {
      return {
        algorithm: 'sha512',
        expectedHash: topLevelSha512,
        encoding: 'base64',
        source: 'latest.yml'
      };
    }

    return null;
  }

  findSpecificVersionMetadataAsset(assets) {
    if (!Array.isArray(assets)) return null;

    const ymlAssets = assets.filter((asset) => /\.ya?ml$/i.test(asset?.name || ''));
    return ymlAssets.find((asset) => /^latest\.ya?ml$/i.test(asset.name || '')) ||
      ymlAssets.find((asset) => /latest/i.test(asset.name || '') && !/(mac|linux)/i.test(asset.name || '')) ||
      null;
  }

  async fetchText(url) {
    if (typeof fetch !== 'function') {
      throw new Error('Fetch API is not available');
    }

    const safeUrl = assertSafeRemoteUrl(url, { allowedProtocols: ['https:'] });
    const response = await fetch(safeUrl);
    if (!response.ok) {
      throw new Error(`Metadata download failed: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  async resolveSpecificVersionChecksum(releaseInfo, windowsAsset) {
    const digestChecksum = this.parseAssetDigestChecksum(windowsAsset?.digest);
    if (digestChecksum) {
      return { checksum: digestChecksum, warning: null };
    }

    const metadataAsset = this.findSpecificVersionMetadataAsset(releaseInfo?.assets);
    if (!metadataAsset?.browser_download_url) {
      return {
        checksum: null,
        warning: 'No checksum metadata was published for this installer'
      };
    }

    try {
      const latestYml = await this.fetchText(metadataAsset.browser_download_url);
      const ymlChecksum = this.parseLatestYmlSha512(latestYml, windowsAsset.name);
      if (ymlChecksum) {
        return {
          checksum: {
            ...ymlChecksum,
            source: metadataAsset.name || ymlChecksum.source
          },
          warning: null
        };
      }

      return {
        checksum: null,
        warning: `Checksum metadata did not include ${windowsAsset.name}`
      };
    } catch (error) {
      return {
        checksum: null,
        warning: `Unable to read checksum metadata: ${error.message}`
      };
    }
  }

  async verifySpecificVersionInstallerChecksum(filePath, checksumInfo) {
    if (!checksumInfo) {
      return {
        success: false,
        checksumVerified: false,
        error: 'Installer checksum metadata is required before installing this version'
      };
    }

    const encoding = checksumInfo.encoding || 'hex';
    const actualHash = await this.calculateFileHash(filePath, checksumInfo.algorithm, encoding);
    const actual = this.normalizeChecksumValue(actualHash, encoding);
    const expected = this.normalizeChecksumValue(checksumInfo.expectedHash, encoding);

    if (!expected || actual !== expected) {
      return {
        success: false,
        checksumVerified: false,
        checksumAlgorithm: checksumInfo.algorithm,
        checksumSource: checksumInfo.source,
        expectedHash: expected,
        actualHash: actual,
        error: 'Downloaded installer checksum did not match the published checksum'
      };
    }

    return {
      success: true,
      checksumVerified: true,
      checksumAlgorithm: checksumInfo.algorithm,
      checksumSource: checksumInfo.source,
      expectedHash: expected,
      actualHash: actual,
      checksumEncoding: encoding
    };
  }

  rememberSpecificVersionDownload(filePath, targetVersion, verification, checksumWarning = null) {
    const stats = fs.statSync(filePath);
    const record = {
      filePath: path.resolve(filePath),
      fileName: path.basename(filePath),
      version: targetVersion,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      downloadedAt: Date.now(),
      checksumVerified: verification.checksumVerified === true,
      checksumAlgorithm: verification.checksumAlgorithm || null,
      checksumSource: verification.checksumSource || null,
      checksumEncoding: verification.checksumEncoding || 'hex',
      expectedHash: verification.expectedHash || null,
      actualHash: verification.actualHash || null,
      checksumWarning
    };

    this.specificVersionDownloads.set(this.getDownloadRecordKey(filePath), record);
    return record;
  }

  removeFileIfExists(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Non-fatal cleanup best effort.
    }
  }

  isPathInsideDirectory(childPath, parentDir) {
    const relativePath = path.relative(parentDir, childPath);
    return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
  }

  getRunningMinecraftServersForUpdateInstall() {
    try {
      const { getAllServerStates, getServerState } = require('./server-manager.cjs');
      const allStates = typeof getAllServerStates === 'function' ? getAllServerStates() : [];
      const states = Array.isArray(allStates) && allStates.length > 0
        ? allStates
        : [typeof getServerState === 'function' ? getServerState() : null];

      return states
        .filter((state) => state && state.isRunning)
        .map((state) => ({
          instanceId: state.instanceId || null,
          targetPath: state.targetPath || null,
          status: state.status || 'running'
        }));
    } catch {
      return [];
    }
  }

  canInstallUpdatesNow() {
    const runningServers = this.getRunningMinecraftServersForUpdateInstall();
    if (runningServers.length > 0) {
      return {
        success: false,
        error: 'Please stop the Minecraft server before installing the update to prevent data corruption.',
        runningServers
      };
    }

    return { success: true };
  }

  async validateSpecificVersionInstaller(filePath) {
    try {
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        return { success: false, error: 'Installer file path is required' };
      }

      const downloadDir = this.getSpecificVersionDownloadDir();
      if (!fs.existsSync(downloadDir)) {
        return { success: false, error: 'Installer download folder does not exist' };
      }

      if (!fs.existsSync(filePath)) {
        return { success: false, error: `Installer file not found at ${filePath}` };
      }

      const realDownloadDir = fs.realpathSync(downloadDir);
      const realFilePath = fs.realpathSync(filePath);
      if (!this.isPathInsideDirectory(realFilePath, realDownloadDir)) {
        return { success: false, error: 'Installer file is outside the updater download folder' };
      }

      if (!this.isWindowsInstallerName(realFilePath)) {
        return { success: false, error: 'Installer file name is not a recognized Windows installer' };
      }

      const stats = fs.statSync(realFilePath);
      if (!stats.isFile() || stats.size <= 0) {
        return { success: false, error: 'Installer file is empty or corrupted' };
      }

      const record = this.specificVersionDownloads.get(this.getDownloadRecordKey(filePath));
      if (!record) {
        return { success: false, error: 'Installer was not downloaded by the updater in this app session' };
      }

      if (stats.size !== record.size) {
        return { success: false, error: 'Installer file size changed after download' };
      }

      if (record.checksumVerified && record.expectedHash) {
        const verification = await this.verifySpecificVersionInstallerChecksum(realFilePath, {
          algorithm: record.checksumAlgorithm,
          expectedHash: record.expectedHash,
          encoding: record.checksumEncoding,
          source: record.checksumSource
        });

        if (!verification.success) {
          return {
            success: false,
            error: 'Installer checksum changed after download'
          };
        }
      } else if (stats.mtimeMs !== record.mtimeMs) {
        return { success: false, error: 'Installer file changed after download' };
      }

      return {
        success: true,
        filePath: realFilePath,
        version: record.version,
        checksumVerified: record.checksumVerified,
        checksumAlgorithm: record.checksumAlgorithm,
        checksumSource: record.checksumSource,
        checksumWarning: record.checksumWarning
      };
    } catch (error) {
      return { success: false, error: `Failed to validate installer: ${error.message}` };
    }
  }

  buildSpecificVersionInstallerArgs(options = {}) {
    const silent = options.silent === true;
    const forceRunAfter = options.forceRunAfter !== false;
    const args = ['--updated'];

    if (silent) {
      args.push('/S');
    }

    if (forceRunAfter) {
      args.push('--force-run');
    }

    return { args, silent, forceRunAfter };
  }

  spawnSpecificVersionInstaller(installerPath, args) {
    const child = spawn(installerPath, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return child;
  }

  requestAppQuitForSpecificVersionInstall() {
    setImmediate(() => {
      app.quit();
    });
  }

  async installSpecificVersionInstaller(filePath, options = {}) {
    const installCheck = this.canInstallUpdatesNow();
    if (!installCheck.success) {
      return installCheck;
    }

    const validation = await this.validateSpecificVersionInstaller(filePath);
    if (!validation.success) {
      return validation;
    }

    const { args, silent, forceRunAfter } = this.buildSpecificVersionInstallerArgs(options);

    try {
      this.spawnSpecificVersionInstaller(validation.filePath, args);
      this.logUpdate('info', 'Specific version installer launched', {
        version: validation.version,
        fileName: path.basename(validation.filePath),
        silent,
        forceRunAfter,
        checksumVerified: validation.checksumVerified
      });
      this.requestAppQuitForSpecificVersionInstall();

      return {
        success: true,
        message: silent
          ? 'Installing update silently. The app will close and reopen when the update finishes.'
          : 'Installing update. The installer will show progress and reopen the app when it finishes.',
        silent,
        forceRunAfter,
        version: validation.version
      };
    } catch (error) {
      this.logUpdate('error', 'Failed to launch specific version installer', {
        version: validation.version,
        error: error.message
      });
      return {
        success: false,
        error: `Failed to launch installer: ${error.message}`
      };
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
        // TODO: Add proper logging - Error checking specific version
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
  async downloadSpecificVersion(targetVersion, options = {}) {
    try {
      const installAfterDownload = options?.installAfterDownload === true;

      // Handle development mode
      if (this.isDevelopmentMode()) {
        return { 
          success: true, 
          message: 'Development mode - version download skipped',
          developmentMode: true
        };
      }

      // Set flag to prevent auto-updater progress conflicts
      this.isDownloadingSpecificVersion = true;
      
      // Reset progress tracking
      this.lastSpecificVersionProgress = 0;
      this.lastEmittedProgress = 0;
      this.lastProgressTime = 0;

      const currentVersion = this.getCurrentVersion();
      
      // If we already have the target version, no download needed
      if (currentVersion === targetVersion) {
        this.isDownloadingSpecificVersion = false; // Clear flag before returning
        return {
          success: true,
          message: `Already on version ${targetVersion}`,
          needsRestart: false
        };
      }

      // First check if the version exists
      const versionCheck = await this.checkForSpecificVersion(targetVersion);
      if (!versionCheck.success || !versionCheck.needsUpdate) {
        this.isDownloadingSpecificVersion = false; // Clear flag before returning
        return {
          success: false,
          error: versionCheck.error || `Version ${targetVersion} not available`
        };
      }

      // Get the release info
      const releaseInfo = versionCheck.releaseInfo;
      if (!releaseInfo || !releaseInfo.assets || releaseInfo.assets.length === 0) {
        this.isDownloadingSpecificVersion = false; // Clear flag before returning
        return {
          success: false,
          error: `No downloadable assets found for version ${targetVersion}`
        };
      }

      // Find the appropriate installer for Windows
      const windowsAsset = this.findWindowsInstallerAsset(releaseInfo.assets);

      if (!windowsAsset) {
        this.isDownloadingSpecificVersion = false; // Clear flag before returning
        return {
          success: false,
          error: `No Windows installer found for version ${targetVersion}`
        };
      }

      // Create temp directory for downloads
      const tempDir = this.getSpecificVersionDownloadDir();
      
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const fileName = safeBaseName(windowsAsset.name, 'installer asset name', {
        allowedExtensions: ['.exe']
      });
      const filePath = safeFilePath(tempDir, fileName, 'installer asset name', {
        allowedExtensions: ['.exe']
      });
      const safeDownloadUrl = assertSafeRemoteUrl(windowsAsset.browser_download_url, {
        allowedProtocols: ['https:']
      });
      
      // Check if file already exists and remove it to force fresh download
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // TODO: Add proper logging - Could not remove existing file
          // Non-fatal, as we'll overwrite it anyway.
        }
      }

      const checksumResolution = await this.resolveSpecificVersionChecksum(releaseInfo, windowsAsset);
      
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
        safeDownloadUrl,
        filePath, 
        targetVersion
      );
      
      if (downloadResult.success) {
        const verification = await this.verifySpecificVersionInstallerChecksum(filePath, checksumResolution.checksum);
        if (!verification.success) {
          this.removeFileIfExists(filePath);
          this.emit('specific-version-download-error', {
            version: targetVersion,
            error: verification.error || 'Installer checksum verification failed'
          });

          return {
            success: false,
            error: verification.error || 'Installer checksum verification failed',
            checksumVerified: false,
            checksumAlgorithm: verification.checksumAlgorithm || checksumResolution.checksum?.algorithm || null,
            checksumSource: verification.checksumSource || checksumResolution.checksum?.source || null
          };
        }

        this.rememberSpecificVersionDownload(
          filePath,
          targetVersion,
          verification,
          checksumResolution.warning
        );

        const completionInfo = {
          version: targetVersion,
          filePath: filePath,
          success: true,
          installStarted: installAfterDownload,
          checksumVerified: verification.checksumVerified === true,
          checksumAlgorithm: verification.checksumAlgorithm || null,
          checksumSource: verification.checksumSource || null,
          checksumWarning: checksumResolution.warning || null
        };

        this.emit('specific-version-download-complete', completionInfo);

        let installResult = null;
        if (installAfterDownload) {
          installResult = await this.installSpecificVersionInstaller(filePath, {
            silent: false,
            forceRunAfter: true
          });

          if (!installResult.success) {
            this.emit('specific-version-download-error', {
              version: targetVersion,
              error: installResult.error || 'Installer launch failed'
            });

            return {
              success: false,
              error: installResult.error || 'Installer launch failed',
              filePath: filePath,
              fileName: path.basename(filePath),
              version: targetVersion,
              downloadComplete: true,
              installStarted: false,
              checksumVerified: verification.checksumVerified === true,
              checksumAlgorithm: verification.checksumAlgorithm || null,
              checksumSource: verification.checksumSource || null,
              checksumWarning: checksumResolution.warning || null
            };
          }
        }

        return {
          success: true,
          message: installResult?.message || `Version ${targetVersion} downloaded successfully`,
          filePath: filePath,
          fileName: path.basename(filePath),
          version: targetVersion,
          downloadComplete: true,
          installStarted: installResult?.success === true,
          checksumVerified: verification.checksumVerified === true,
          checksumAlgorithm: verification.checksumAlgorithm || null,
          checksumSource: verification.checksumSource || null,
          checksumWarning: checksumResolution.warning || null
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
      // TODO: Add proper logging - Error downloading specific version
      return { 
        success: false, 
        error: `Failed to download version ${targetVersion}: ${error.message}` 
      };
    } finally {
      // Clear flag regardless of success or failure
      this.isDownloadingSpecificVersion = false;
    }
  }

  // Download a file with progress tracking
  async downloadFileWithProgress(url, filePath, version) {
    try {
      const https = require('https');
      const fs = require('fs');
      const safeUrl = assertSafeRemoteUrl(url, { allowedProtocols: ['https:'] });

      return new Promise((resolve, reject) => {
        const request = https.get(safeUrl, (response) => {
          // Handle redirects
          if (response.statusCode === 302 || response.statusCode === 301) {
            let redirectUrl;
            try {
              redirectUrl = resolveSafeRedirectUrl(response.headers.location, safeUrl, {
                allowedProtocols: ['https:']
              });
            } catch (error) {
              reject(error);
              return;
            }
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

            // Calculate progress - ensure it only increases, never decreases
            let progress = 0;
            if (totalSize > 0) {
              progress = Math.round((downloadedSize / totalSize) * 100);
              // Ensure progress never goes backwards
              progress = Math.max(progress, this.lastSpecificVersionProgress || 0);
            } else {
              // Indeterminate progress - show that download is happening
              progress = Math.min(99, Math.floor(downloadedSize / (1024 * 1024))); // 1% per MB downloaded, max 99%
              // For indeterminate, also ensure it doesn't go backwards
              progress = Math.max(progress, this.lastSpecificVersionProgress || 0);
            }
            
            // Store last progress to prevent backwards movement
            this.lastSpecificVersionProgress = progress;
            
            // Only emit progress if it actually increased or is significant
            if (!this.lastEmittedProgress || progress > this.lastEmittedProgress || (Date.now() - this.lastProgressTime) > 1000) {
              this.lastEmittedProgress = progress;
              this.lastProgressTime = Date.now();
              
              // Emit progress event
              this.emit('specific-version-download-progress', {
                version: version,
                progress: progress,
                downloadedSize: downloadedSize,
                totalSize: totalSize,
                downloadedMB: (downloadedSize / 1024 / 1024).toFixed(2),
                totalMB: totalSize > 0 ? (totalSize / 1024 / 1024).toFixed(2) : 'Unknown'
              });
            }
          });

          response.on('end', () => {
            fileStream.end();
            
            // Wait a moment for file system to sync
            setTimeout(() => {
              // Verify file exists and has content
              if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                if (stats.size > 0) {
                  resolve({ success: true, filePath: filePath });
                } else {
                  // File exists but is empty
                  const error = new Error('Downloaded file is empty');
                  this.emit('specific-version-download-error', {
                    version: version,
                    error: error.message
                  });
                  reject(error);
                }
              } else {
                // File doesn't exist after download
                const error = new Error('Downloaded file not found after completion');
                this.emit('specific-version-download-error', {
                  version: version,
                  error: error.message
                });
                reject(error);
              }
            }, 500); // Wait 500ms for file system sync
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
