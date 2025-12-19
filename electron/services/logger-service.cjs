const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const EventEmitter = require('events');
const instanceContext = require('../utils/instance-context.cjs');
let devConfig = null;
try {
  devConfig = require('../../config/dev-config.cjs');
} catch {
  devConfig = { enableDevConsole: false, enableVerboseLogging: false };
}

// Lazy app-store initialization to avoid circular dependency
let appStore = null;
const getAppStore = () => {
  if (!appStore) {
    try {
      appStore = require('../utils/app-store.cjs');
      // Verify the store has the expected interface
      if (typeof appStore.get !== 'function') {
        throw new Error('App store does not have expected interface');
      }
    } catch {
      // Fallback if app-store not available
      appStore = {
        get: (key) => {
          if (key === 'loggerSettings') {
            return {
              maxFileSize: 50,
              maxFiles: 5,
              retentionDays: 7
            };
          }
          return {};
        },
        set: () => {},
        has: () => false
      };
    }
  }
  return appStore;
};

class LoggerService extends EventEmitter {
  constructor() {
    super();

    // Initialize performance tracking
    this.initStartTime = Date.now();
    this.performanceMetrics = {
      logsWritten: 0,
      filesRotated: 0,
      memoryUsage: 0,
      averageLogSize: 0,
      totalLogSize: 0,
      totalWriteTime: 0,
      averageWriteTime: 0
    };

    this.logLevels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
      fatal: 4
    };

    this.levelColors = {
      debug: '#6b7280',   // gray
      info: '#3b82f6',    // blue  
      warn: '#f59e0b',    // yellow
      error: '#ef4444',   // red
      fatal: '#7f1d1d'    // dark red
    };

    // Initialize with default config, load from store later
    this.config = {
      maxMemoryLogs: 10000,
      maxFileSize: 50 * 1024 * 1024, // 50MB
      maxFiles: 5,
  retentionDays: 7,
  suppressBackgroundLogs: true, // Suppress non-interactive logs by default
  burstDurationMs: 15000, // Logging window after explicit user action
  quietMods: true, // Backward flag – still honored
  quietCategories: ['mods','network'] // Suppress debug/info for these categories unless forceLog
    };
    
    // Config will be loaded on first use to avoid circular dependency issues
    this.configLoaded = false;

    // Memory buffer for real-time display
    this.memoryLogs = [];
    this.logIdCounter = 0;
  // Track temporary interactive logging window
  this.interactiveUntil = 0;

    // Sensitive data patterns for redaction
    this.sensitivePatterns = [
      /access_token['":\s]+([^'",\s]+)/gi,
      /refresh_token['":\s]+([^'",\s]+)/gi,
      /Bearer\s+([A-Za-z0-9\-_]+)/gi,
      /password['":\s]+([^'",\s]+)/gi,
      /token['":\s]+([^'",\s]+)/gi,
      /secret['":\s]+([^'",\s]+)/gi,
      /key['":\s]+([^'",\s]+)/gi
    ];

    // Initialize storage
    this.initializeStorage();

    this.setupLogRotation();

    // Close logger window when Electron app is quitting
    if (app && typeof app.on === 'function') {
      app.on('before-quit', () => {
        if (this.loggerWindow && !this.loggerWindow.isDestroyed()) {
          this.loggerWindow.destroy();
        }
      });
    }

    // Log service initialization completion
    const initDuration = Date.now() - this.initStartTime;
    this.logServiceEvent('Logger service initialized', {
      category: 'core',
      data: {
        service: 'LoggerService',
        initDuration,
        memoryBufferSize: this.config.maxMemoryLogs,
        maxFileSize: this.config.maxFileSize,
        maxFiles: this.config.maxFiles,
        retentionDays: this.config.retentionDays
      }
    });
  }

  ensureConfigLoaded() {
    if (this.configLoaded) {
      return;
    }
    
    try {
      this.loadConfig();
      this.configLoaded = true;
    } catch (error) {
      // Config loading failed, but we already have defaults
      console.warn('Logger config loading failed, using defaults:', error.message);
      this.configLoaded = true; // Mark as loaded to prevent retry loops
    }
  }

  loadConfig() {
    const configStartTime = Date.now();

    try {
      const store = getAppStore();
      let loggerSettings = {};
      
      // Safely get logger settings with additional error handling
      try {
        loggerSettings = store.get('loggerSettings') || {};
        if (typeof loggerSettings !== 'object' || loggerSettings === null) {
          loggerSettings = {};
        }
      } catch {
        // Don't log this error to avoid recursion, just use defaults
        loggerSettings = {};
      }

      // Update configuration with store values, keeping defaults as fallback
      this.config = {
        ...this.config, // Preserve new fields like suppressBackgroundLogs / burstDurationMs
        maxMemoryLogs: 10000, // Keep hardcoded cap
        maxFileSize: (loggerSettings.maxFileSize || 50) * 1024 * 1024,
        maxFiles: loggerSettings.maxFiles || 5,
        retentionDays: loggerSettings.retentionDays || 7
      };

      const configDuration = Date.now() - configStartTime;
      // Only log success if we have basic infrastructure ready
      if (this.memoryLogs && this.logServiceEvent) {
        this.logServiceEvent('Logger configuration loaded', {
          category: 'settings',
          data: {
            service: 'LoggerService',
            operation: 'loadConfig',
            duration: configDuration,
            configSource: 'appStore',
            maxMemoryLogs: this.config.maxMemoryLogs,
            maxFileSize: this.config.maxFileSize,
            maxFiles: this.config.maxFiles,
            retentionDays: this.config.retentionDays,
            hasCustomSettings: Object.keys(loggerSettings).length > 0
          }
        });
      }

    } catch (error) {
      // Keep existing defaults, don't overwrite
      const configDuration = Date.now() - configStartTime;
      
      // Only log error if we have basic infrastructure ready
      if (this.memoryLogs && this.logServiceEvent) {
        this.logServiceEvent(`Failed to load logger configuration: ${error.message}`, {
          category: 'settings',
          level: 'error',
          data: {
            service: 'LoggerService',
            operation: 'loadConfig',
            duration: configDuration,
            errorType: error.constructor.name,
            errorMessage: error.message,
            fallbackUsed: true,
            defaultConfig: this.config
          }
        });
      }
    }
  }

  initializeStorage() {
    const storageStartTime = Date.now();

    try {
      this.logsDir = path.join(app.getPath('userData'), 'logs');

      // Ensure logs directory exists
      const logsDirCreated = !fs.existsSync(this.logsDir);
      if (logsDirCreated) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }

      this.currentLogFile = path.join(this.logsDir, 'app.log');
      this.crashReportsDir = path.join(this.logsDir, 'crash-reports');

      // Ensure crash reports directory exists
      const crashDirCreated = !fs.existsSync(this.crashReportsDir);
      if (crashDirCreated) {
        fs.mkdirSync(this.crashReportsDir, { recursive: true });
      }

      // Get initial file stats
      let currentLogSize = 0;
      if (fs.existsSync(this.currentLogFile)) {
        const stats = fs.statSync(this.currentLogFile);
        currentLogSize = stats.size;
      }

      // Clean up old logs on startup
      const cleanupResult = this.cleanupOldLogs();

      const storageDuration = Date.now() - storageStartTime;
      this.logServiceEvent('Logger storage initialized', {
        category: 'storage',
        data: {
          service: 'LoggerService',
          operation: 'initializeStorage',
          duration: storageDuration,
          logsDir: this.logsDir,
          currentLogFile: this.currentLogFile,
          crashReportsDir: this.crashReportsDir,
          logsDirCreated,
          crashDirCreated,
          currentLogSize,
          cleanupResult
        }
      });

    } catch (error) {
      const storageDuration = Date.now() - storageStartTime;
      this.logServiceEvent(`Failed to initialize logger storage: ${error.message}`, {
        category: 'storage',
        level: 'error',
        data: {
          service: 'LoggerService',
          operation: 'initializeStorage',
          duration: storageDuration,
          errorType: error.constructor.name,
          logsDir: this.logsDir,
          stack: error.stack
        }
      });
    }
  }

  setupLogRotation() {
    const rotationStartTime = Date.now();

    try {
      // Check if current log file needs rotation
      if (fs.existsSync(this.currentLogFile)) {
        const stats = fs.statSync(this.currentLogFile);

        if (stats.size > this.config.maxFileSize) {
          this.logServiceEvent('Log file requires rotation', {
            category: 'storage',
            data: {
              service: 'LoggerService',
              operation: 'setupLogRotation',
              currentSize: stats.size,
              maxSize: this.config.maxFileSize,
              rotationRequired: true
            }
          });

          this.rotateLogFile();
        } else {
          const rotationDuration = Date.now() - rotationStartTime;
          this.logServiceEvent('Log rotation check completed', {
            category: 'storage',
            data: {
              service: 'LoggerService',
              operation: 'setupLogRotation',
              duration: rotationDuration,
              currentSize: stats.size,
              maxSize: this.config.maxFileSize,
              rotationRequired: false
            }
          });
        }
      } else {
        const rotationDuration = Date.now() - rotationStartTime;
        this.logServiceEvent('No existing log file found for rotation check', {
          category: 'storage',
          data: {
            service: 'LoggerService',
            operation: 'setupLogRotation',
            duration: rotationDuration,
            logFile: this.currentLogFile,
            fileExists: false
          }
        });
      }
    } catch (error) {
      const rotationDuration = Date.now() - rotationStartTime;
      this.logServiceEvent(`Log rotation setup failed: ${error.message}`, {
        category: 'storage',
        level: 'error',
        data: {
          service: 'LoggerService',
          operation: 'setupLogRotation',
          duration: rotationDuration,
          errorType: error.constructor.name,
          logFile: this.currentLogFile
        }
      });
    }
  }

  rotateLogFile() {
    const rotationStartTime = Date.now();

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedFile = path.join(this.logsDir, `app-${timestamp}.log`);

      let originalSize = 0;

      // Move current log to rotated file
      if (fs.existsSync(this.currentLogFile)) {
        const stats = fs.statSync(this.currentLogFile);
        originalSize = stats.size;
        fs.renameSync(this.currentLogFile, rotatedFile);
      }

      // Clean up old rotated files
      const cleanupResult = this.cleanupRotatedFiles();

      // Update performance metrics
      this.performanceMetrics.filesRotated++;

      const rotationDuration = Date.now() - rotationStartTime;
      this.logServiceEvent('Log file rotated successfully', {
        category: 'storage',
        data: {
          service: 'LoggerService',
          operation: 'rotateLogFile',
          duration: rotationDuration,
          originalFile: this.currentLogFile,
          rotatedFile,
          originalSize,
          timestamp,
          cleanupResult,
          totalRotations: this.performanceMetrics.filesRotated
        }
      });

    } catch (error) {
      const rotationDuration = Date.now() - rotationStartTime;
      this.logServiceEvent(`Failed to rotate log file: ${error.message}`, {
        category: 'storage',
        level: 'error',
        data: {
          service: 'LoggerService',
          operation: 'rotateLogFile',
          duration: rotationDuration,
          errorType: error.constructor.name,
          currentLogFile: this.currentLogFile,
          stack: error.stack
        }
      });
    }
  }

  cleanupOldLogs() {
    const cleanupStartTime = Date.now();

    try {
      const now = Date.now();
      const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;

      const files = fs.readdirSync(this.logsDir);
      let deletedFiles = 0;
      let totalSize = 0;
      let deletedSize = 0;

      for (const file of files) {
        if (file.startsWith('app-') && file.endsWith('.log')) {
          const filePath = path.join(this.logsDir, file);
          const stats = fs.statSync(filePath);
          totalSize += stats.size;

          if (now - stats.mtime.getTime() > retentionMs) {
            deletedSize += stats.size;
            fs.unlinkSync(filePath);
            deletedFiles++;
          }
        }
      }

      const cleanupDuration = Date.now() - cleanupStartTime;
      const result = {
        deletedFiles,
        deletedSize,
        totalSize,
        retentionDays: this.config.retentionDays
      };

      this.logServiceEvent('Old logs cleanup completed', {
        category: 'storage',
        data: {
          service: 'LoggerService',
          operation: 'cleanupOldLogs',
          duration: cleanupDuration,
          ...result
        }
      });

      return result;

    } catch (error) {
      const cleanupDuration = Date.now() - cleanupStartTime;
      this.logServiceEvent(`Failed to cleanup old logs: ${error.message}`, {
        category: 'storage',
        level: 'error',
        data: {
          service: 'LoggerService',
          operation: 'cleanupOldLogs',
          duration: cleanupDuration,
          errorType: error.constructor.name,
          logsDir: this.logsDir,
          retentionDays: this.config.retentionDays
        }
      });

      return { deletedFiles: 0, deletedSize: 0, totalSize: 0, error: error.message };
    }
  }

  cleanupRotatedFiles() {
    const cleanupStartTime = Date.now();

    try {
      const files = fs.readdirSync(this.logsDir)
        .filter(file => file.startsWith('app-') && file.endsWith('.log'))
        .map(file => ({
          name: file,
          path: path.join(this.logsDir, file),
          stats: fs.statSync(path.join(this.logsDir, file))
        }))
        .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());

      let deletedFiles = 0;
      let deletedSize = 0;

      // Keep only the most recent files
      if (files.length > this.config.maxFiles) {
        const filesToDelete = files.slice(this.config.maxFiles);
        for (const file of filesToDelete) {
          deletedSize += file.stats.size;
          fs.unlinkSync(file.path);
          deletedFiles++;
        }
      }

      const cleanupDuration = Date.now() - cleanupStartTime;
      const result = {
        totalFiles: files.length,
        deletedFiles,
        deletedSize,
        keptFiles: files.length - deletedFiles,
        maxFiles: this.config.maxFiles
      };

      this.logServiceEvent('Rotated files cleanup completed', {
        category: 'storage',
        data: {
          service: 'LoggerService',
          operation: 'cleanupRotatedFiles',
          duration: cleanupDuration,
          ...result
        }
      });

      return result;

    } catch (error) {
      const cleanupDuration = Date.now() - cleanupStartTime;
      this.logServiceEvent(`Failed to cleanup rotated files: ${error.message}`, {
        category: 'storage',
        level: 'error',
        data: {
          service: 'LoggerService',
          operation: 'cleanupRotatedFiles',
          duration: cleanupDuration,
          errorType: error.constructor.name,
          logsDir: this.logsDir,
          maxFiles: this.config.maxFiles
        }
      });

      return { totalFiles: 0, deletedFiles: 0, deletedSize: 0, error: error.message };
    }
  }

  redactSensitiveData(message) {
    let cleaned = String(message);

    for (const pattern of this.sensitivePatterns) {
      cleaned = cleaned.replace(pattern, (match, sensitiveValue) => {
        // Keep first 2 and last 2 characters, replace middle with asterisks
        if (sensitiveValue.length <= 4) {
          return match.replace(sensitiveValue, '*'.repeat(8));
        }
        const start = sensitiveValue.substring(0, 2);
        const end = sensitiveValue.substring(sensitiveValue.length - 2);
        const middle = '*'.repeat(Math.max(4, sensitiveValue.length - 4));
        return match.replace(sensitiveValue, `${start}${middle}${end}`);
      });
    }

    return cleaned;
  }

  // Helper method for internal service logging to avoid recursion
  logServiceEvent(message, options = {}) {
    // Only log if we have basic infrastructure ready
    if (!this.memoryLogs || !this.config) {
      return;
    }

    const level = options.level || 'info';
    const logEntry = this.createLogEntry(level, message, options);

    // Add to memory buffer
    this.memoryLogs.push(logEntry);

    // Trim memory buffer if needed (simple version to avoid recursion)
    if (this.memoryLogs.length > this.config.maxMemoryLogs) {
      this.memoryLogs = this.memoryLogs.slice(-this.config.maxMemoryLogs);
    }

    // Emit for real-time streaming
    this.emit('log', logEntry);

    // Write to file (but don't log the write operation to avoid recursion)
    if (this.currentLogFile) {
      try {
        const logLine = JSON.stringify(logEntry) + '\n';
        fs.appendFileSync(this.currentLogFile, logLine);
      } catch (error) {
        // Silent failure to avoid recursion
        console.error('Logger service internal write failed:', error.message);
      }
    }
  }

  createLogEntry(level, message, options = {}) {
    const timestamp = new Date();
    const logId = ++this.logIdCounter;

    // Default to current instance context if not specified
    const instanceId = options.instanceId || instanceContext.getCurrentInstance();
    const category = options.category || 'core';

    // Redact sensitive data for storage/display
    const cleanMessage = this.redactSensitiveData(message);

    const logEntry = {
      id: logId,
      timestamp: timestamp.toISOString(),
      level,
      instanceId,
      category,
      message: cleanMessage,
      rawData: options.data ? this.redactSensitiveData(JSON.stringify(options.data)) : null,
      stackTrace: options.stack || null
    };

    return logEntry;
  }

  writeToFile(logEntry) {
    const writeStartTime = Date.now();
    
    // Ensure config is loaded before using it
    this.ensureConfigLoaded();

    try {
      // Check if file needs rotation
      if (fs.existsSync(this.currentLogFile)) {
        const stats = fs.statSync(this.currentLogFile);
        if (stats.size > this.config.maxFileSize) {
          this.rotateLogFile();
        }
      }

      // Format log line for file
      const logLine = JSON.stringify(logEntry) + '\n';
      const logSize = Buffer.byteLength(logLine, 'utf8');

      // Append to current log file
      fs.appendFileSync(this.currentLogFile, logLine);

      // Update performance metrics
      this.performanceMetrics.logsWritten++;
      this.performanceMetrics.totalLogSize += logSize;
      this.performanceMetrics.averageLogSize =
        this.performanceMetrics.totalLogSize / this.performanceMetrics.logsWritten;

      const writeDuration = Date.now() - writeStartTime;
      this.performanceMetrics.totalWriteTime += writeDuration;
      this.performanceMetrics.averageWriteTime =
        this.performanceMetrics.totalWriteTime / this.performanceMetrics.logsWritten;

      // File write logging disabled to prevent recursion

    } catch (error) {
      const writeDuration = Date.now() - writeStartTime;
      // Use console.error to avoid recursion in logging system failure
      console.error(`Logger service failed to write to file: ${error.message}`, {
        service: 'LoggerService',
        operation: 'writeToFile',
        duration: writeDuration,
        errorType: error.constructor.name,
        currentLogFile: this.currentLogFile,
        logEntry: logEntry.id
      });
    }
  }

  addToMemoryBuffer(logEntry) {
    const memoryStartTime = Date.now();
    
    // Ensure config is loaded before using it
    this.ensureConfigLoaded();

    this.memoryLogs.push(logEntry);

    let trimmed = false;
    let trimmedCount = 0;

    // Trim memory buffer if it exceeds limit
    if (this.memoryLogs.length > this.config.maxMemoryLogs) {
      const originalLength = this.memoryLogs.length;
      this.memoryLogs = this.memoryLogs.slice(-this.config.maxMemoryLogs);
      trimmedCount = originalLength - this.memoryLogs.length;
      trimmed = true;
    }

    // Update memory usage metrics
    const memoryUsage = process.memoryUsage();
    this.performanceMetrics.memoryUsage = memoryUsage.heapUsed;

    const memoryDuration = Date.now() - memoryStartTime;

    // Only log memory operations for non-debug levels to avoid excessive logging
    if (logEntry.level !== 'debug' && (trimmed || this.memoryLogs.length % 1000 === 0)) {
      this.logServiceEvent('Memory buffer updated', {
        category: 'performance',
        level: 'debug',
        data: {
          service: 'LoggerService',
          operation: 'addToMemoryBuffer',
          duration: memoryDuration,
          currentBufferSize: this.memoryLogs.length,
          maxBufferSize: this.config.maxMemoryLogs,
          trimmed,
          trimmedCount,
          heapUsed: memoryUsage.heapUsed,
          heapTotal: memoryUsage.heapTotal,
          logLevel: logEntry.level
        }
      });
    }
  }

  log(level, message, options = {}) {
    // Validate log level
    if (!Object.prototype.hasOwnProperty.call(this.logLevels, level)) {
      level = 'info';
    }

    // Determine if we are in an interactive logging window
    const now = Date.now();
    const interactive = now < this.interactiveUntil;

    // Apply suppression: allow warnings/errors always; during suppression drop debug/info unless interactive or explicitly whitelisted
    const category = (options && options.category) || (options && options.data && options.data.category) || '';
    const forceLog = options && options.data && options.data.forceLog;

    // Unified quiet categories suppression (includes mods, network by default)
    if ((this.config.quietMods && category === 'mods') || (Array.isArray(this.config.quietCategories) && this.config.quietCategories.includes(category))) {
      if ((level === 'debug' || level === 'info') && !forceLog) {
        return; // Hard suppressed by quiet category
      }
    }

    if (this.config.suppressBackgroundLogs && !interactive && (level === 'debug' || level === 'info')) {
      const operation = (options && options.data && options.data.operation) || '';
      const whitelistOps = new Set(['installModToServer','installModToClient','installModToServerWithFallback']);
      const whitelistCats = new Set(['network']); // Removed 'mods' from default whitelist
      if (!whitelistOps.has(operation) && !whitelistCats.has(category) && !forceLog) {
        return; // Suppressed
      }
    }

    const logEntry = this.createLogEntry(level, message, options);

    // Add to memory buffer
    this.addToMemoryBuffer(logEntry);

    // Write to file
    this.writeToFile(logEntry);

    // Emit for real-time streaming
    this.emit('log', logEntry);

    // Development console mirroring so F11 DevTools sees backend logs
    try {
      const mirror = devConfig.enableDevConsole || process.env.MC_CORE_DEBUG;
      if (mirror) {
        // Basic level to console method mapping
        const payload = {
          cat: logEntry.category,
          msg: logEntry.message,
          data: options.data || undefined,
          id: logEntry.id
        };
        if (level === 'error' || level === 'fatal') {
          console.error(`[MC][${level}] ${logEntry.message}`, payload);
        } else if (level === 'warn') {
          console.warn(`[MC][${level}] ${logEntry.message}`, payload);
        } else if (level === 'info') {
          console.info(`[MC][${level}] ${logEntry.message}`, payload);
        } else {
          if (devConfig.enableVerboseLogging) {
            console.debug(`[MC][${level}] ${logEntry.message}`, payload);
          }
        }
      }
    } catch { /* swallow */ }

    return logEntry;
  }

  // Activate burst logging window
  allowBurstLogging(durationMs) {
    const d = typeof durationMs === 'number' && durationMs > 0 ? durationMs : this.config.burstDurationMs;
    this.interactiveUntil = Date.now() + d;
    this.log('debug','Burst logging window activated',{ category:'logger', data:{ durationMs:d, interactiveUntil:this.interactiveUntil }});
  }

  // Convenience methods
  debug(message, options = {}) {
  return this.log('debug', message, options);
  }

  info(message, options = {}) {
    return this.log('info', message, options);
  }

  warn(message, options = {}) {
    return this.log('warn', message, options);
  }

  error(message, options = {}) {
    return this.log('error', message, options);
  }

  fatal(message, options = {}) {
    const logEntry = this.log('fatal', message, options);

    // Auto-export crash report for fatal errors
    this.exportCrashReport(logEntry);

    return logEntry;
  }

  exportCrashReport(triggerLogEntry = null) {
    const exportStartTime = Date.now();

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const crashFile = path.join(this.crashReportsDir, `crash-${timestamp}.json`);

      // Get recent logs (last 100 entries)
      const recentLogs = this.memoryLogs.slice(-100);

      const crashReport = {
        timestamp: new Date().toISOString(),
        triggerLog: triggerLogEntry,
        recentLogs: recentLogs,
        systemInfo: {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          appVersion: app.getVersion()
        },
        performanceMetrics: { ...this.performanceMetrics },
        memoryUsage: process.memoryUsage(),
        config: { ...this.config }
      };

      const reportContent = JSON.stringify(crashReport, null, 2);
      const reportSize = Buffer.byteLength(reportContent, 'utf8');

      fs.writeFileSync(crashFile, reportContent);

      const exportDuration = Date.now() - exportStartTime;

      this.logServiceEvent('Crash report exported', {
        category: 'storage',
        data: {
          service: 'LoggerService',
          operation: 'exportCrashReport',
          duration: exportDuration,
          crashFile,
          reportSize,
          recentLogsCount: recentLogs.length,
          triggerLogId: triggerLogEntry?.id,
          triggerLogLevel: triggerLogEntry?.level
        }
      });

      return crashFile;

    } catch (error) {
      const exportDuration = Date.now() - exportStartTime;

      // Use console.error to avoid recursion in logging system failure
      console.error(`Failed to export crash report: ${error.message}`, {
        service: 'LoggerService',
        operation: 'exportCrashReport',
        duration: exportDuration,
        errorType: error.constructor.name,
        crashReportsDir: this.crashReportsDir,
        triggerLogId: triggerLogEntry?.id
      });

      return null;
    }
  }

  // Get logs with filtering
  getLogs(options = {}) {
    let logs = [...this.memoryLogs];

    // Filter by level
    if (options.level) {
      const minLevel = this.logLevels[options.level] || 0;
      logs = logs.filter(log => this.logLevels[log.level] >= minLevel);
    }

    // Filter by instance
    if (options.instanceId) {
      logs = logs.filter(log => log.instanceId === options.instanceId);
    }

    // Filter by category  
    if (options.category) {
      logs = logs.filter(log => log.category === options.category);
    }

    // Filter by search term
    if (options.search) {
      const searchTerm = options.search.toLowerCase();
      logs = logs.filter(log =>
        log.message.toLowerCase().includes(searchTerm) ||
        log.instanceId.toLowerCase().includes(searchTerm) ||
        log.category.toLowerCase().includes(searchTerm)
      );
    }

    // Filter by time range
    if (options.startTime || options.endTime) {
      logs = logs.filter(log => {
        const logTime = new Date(log.timestamp).getTime();
        const start = options.startTime ? new Date(options.startTime).getTime() : 0;
        const end = options.endTime ? new Date(options.endTime).getTime() : Date.now();
        return logTime >= start && logTime <= end;
      });
    }

    // Sort by timestamp (newest first by default)
    logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Pagination
    if (options.limit) {
      const offset = options.offset || 0;
      logs = logs.slice(offset, offset + options.limit);
    }

    return logs;
  }

  // Export logs to file (with sensitive data redaction)
  exportLogs(options = {}) {
    try {
      const logs = this.getLogs(options);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const format = options.format || 'json';

      let filename, content;

      if (format === 'txt') {
        filename = `logs-export-${timestamp}.txt`;
        content = logs.map(log =>
          `[${log.timestamp}] [${log.level.toUpperCase()}] [${log.instanceId}/${log.category}] ${log.message}`
        ).join('\n');
      } else {
        filename = `logs-export-${timestamp}.json`;
        content = JSON.stringify({
          exportTime: new Date().toISOString(),
          filters: options,
          logs: logs
        }, null, 2);
      }

      const exportPath = path.join(this.logsDir, filename);
      fs.writeFileSync(exportPath, content);

      return {
        success: true,
        path: exportPath,
        filename: filename,
        count: logs.length
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Clear logs from memory (file logs remain)
  clearMemoryLogs() {
    this.memoryLogs = [];
    this.logIdCounter = 0;
    this.emit('logsCleared');
  }

  // Get statistics
  getStats() {
    const stats = {
      totalLogs: this.memoryLogs.length,
      levels: {},
      instances: {},
      categories: {}
    };

    for (const log of this.memoryLogs) {
      // Count by level
      stats.levels[log.level] = (stats.levels[log.level] || 0) + 1;

      // Count by instance
      stats.instances[log.instanceId] = (stats.instances[log.instanceId] || 0) + 1;

      // Count by category
      stats.categories[log.category] = (stats.categories[log.category] || 0) + 1;
    }

    return stats;
  }

  // Update configuration
  updateConfig(newConfig) {
    const updateStartTime = Date.now();
    
    // Ensure config is loaded before updating it
    this.ensureConfigLoaded();
    
    const oldConfig = { ...this.config };

    try {
      this.config = { ...this.config, ...newConfig };

      let memoryTrimmed = false;
      let trimmedCount = 0;

      // Apply memory limit immediately
      if (this.memoryLogs.length > this.config.maxMemoryLogs) {
        const originalLength = this.memoryLogs.length;
        this.memoryLogs = this.memoryLogs.slice(-this.config.maxMemoryLogs);
        trimmedCount = originalLength - this.memoryLogs.length;
        memoryTrimmed = true;
      }

      const updateDuration = Date.now() - updateStartTime;

      this.logServiceEvent('Logger configuration updated', {
        category: 'settings',
        data: {
          service: 'LoggerService',
          operation: 'updateConfig',
          duration: updateDuration,
          oldConfig,
          newConfig,
          finalConfig: this.config,
          memoryTrimmed,
          trimmedCount,
          currentMemoryLogs: this.memoryLogs.length
        }
      });

    } catch (error) {
      const updateDuration = Date.now() - updateStartTime;

      this.logServiceEvent(`Failed to update logger configuration: ${error.message}`, {
        category: 'settings',
        level: 'error',
        data: {
          service: 'LoggerService',
          operation: 'updateConfig',
          duration: updateDuration,
          errorType: error.constructor.name,
          oldConfig,
          attemptedConfig: newConfig
        }
      });
    }
  }

  // Window Management
  openLoggerWindow() {
    // Don't open multiple logger windows
    if (this.loggerWindow && !this.loggerWindow.isDestroyed()) {
      this.loggerWindow.focus();
      return this.loggerWindow;
    }

    this.loggerWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      title: 'Application Logger',
      icon: path.join(__dirname, '../../icon.png'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload.cjs'),
        webSecurity: true,
        sandbox: true
      },
      show: false, // Don't show until ready
      backgroundColor: '#101a23',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default'
    });

    // Load the logger window HTML
    if (process.env.NODE_ENV === 'development') {
      // In development, load from the dev server
      this.loggerWindow.loadURL('http://localhost:5173/logger-window.html');
    } else {
      // In production, load from file
      const loggerHtmlPath = path.join(__dirname, '../logger-window.html');
      this.loggerWindow.loadFile(loggerHtmlPath);
    }

    // Show window when ready
    this.loggerWindow.once('ready-to-show', () => {
      this.loggerWindow.show();

      // Open DevTools in development
      if (process.env.NODE_ENV === 'development') {
        this.loggerWindow.webContents.openDevTools();
      }
    });

    // Handle window closed
    this.loggerWindow.on('closed', () => {
      this.loggerWindow = null;
    });

    // Setup real-time log streaming for this window
    this.setupWindowStreaming(this.loggerWindow);

    return this.loggerWindow;
  }

  setupWindowStreaming(window) {
    // Send new logs to the window in real-time
    const sendLogToWindow = (logEntry) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('logger-new-log', logEntry);
      }
    };

    const sendClearToWindow = () => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('logger-logs-cleared');
      }
    };

    // Listen for new logs
    this.on('log', sendLogToWindow);
    this.on('logsCleared', sendClearToWindow);

    // Clean up listeners when window is closed
    window.on('closed', () => {
      this.off('log', sendLogToWindow);
      this.off('logsCleared', sendClearToWindow);
    });
  }

  closeLoggerWindow() {
    if (this.loggerWindow && !this.loggerWindow.isDestroyed()) {
      this.loggerWindow.close();
    }
  }
}

// Singleton instance
let loggerInstance = null;

function getLogger() {
  if (!loggerInstance) {
    loggerInstance = new LoggerService();
  }
  return loggerInstance;
}

module.exports = {
  getLogger,
  LoggerService
}; 
