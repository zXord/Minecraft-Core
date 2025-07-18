const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const EventEmitter = require('events');
const appStore = require('../utils/app-store.cjs');

class LoggerService extends EventEmitter {
  constructor() {
    super();
    
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
    
    // Get configuration from app store
    this.loadConfig();
    
    // Memory buffer for real-time display
    this.memoryLogs = [];
    this.logIdCounter = 0;
    
    // Initialize storage
    this.initializeStorage();
    
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
    
    this.setupLogRotation();

    // Close logger window when Electron app is quitting
    app.on('before-quit', () => {
      if (this.loggerWindow && !this.loggerWindow.isDestroyed()) {
        this.loggerWindow.destroy();
      }
    });
  }
  
  loadConfig() {
    try {
      const loggerSettings = appStore.get('loggerSettings') || {};
      
      // Set configuration with defaults fallback
      this.config = {
        maxMemoryLogs: 10000, // Keep this hardcoded for memory management
        maxFileSize: (loggerSettings.maxFileSize || 50) * 1024 * 1024, // Convert MB to bytes
        maxFiles: loggerSettings.maxFiles || 5,
        retentionDays: loggerSettings.retentionDays || 7
      };
    } catch (error) {
      // Fallback to defaults if settings can't be loaded
      this.config = {
        maxMemoryLogs: 10000,
        maxFileSize: 50 * 1024 * 1024, // 50MB
        maxFiles: 5,
        retentionDays: 7
      };
    }
  }
  
  initializeStorage() {
    try {
      this.logsDir = path.join(app.getPath('userData'), 'logs');
      
      // Ensure logs directory exists
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }
      
      this.currentLogFile = path.join(this.logsDir, 'app.log');
      this.crashReportsDir = path.join(this.logsDir, 'crash-reports');
      
      // Ensure crash reports directory exists
      if (!fs.existsSync(this.crashReportsDir)) {
        fs.mkdirSync(this.crashReportsDir, { recursive: true });
      }
      
      // Clean up old logs on startup
      this.cleanupOldLogs();
      
    } catch {
      // TODO: Add proper logging - Failed to initialize logger storage
    }
  }
  
  setupLogRotation() {
    // Check if current log file needs rotation
    if (fs.existsSync(this.currentLogFile)) {
      const stats = fs.statSync(this.currentLogFile);
      if (stats.size > this.config.maxFileSize) {
        this.rotateLogFile();
      }
    }
  }
  
  rotateLogFile() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedFile = path.join(this.logsDir, `app-${timestamp}.log`);
      
      // Move current log to rotated file
      if (fs.existsSync(this.currentLogFile)) {
        fs.renameSync(this.currentLogFile, rotatedFile);
      }
      
      // Clean up old rotated files
      this.cleanupRotatedFiles();
      
    } catch {
      // TODO: Add proper logging - Failed to rotate log file
    }
  }
  
  cleanupOldLogs() {
    try {
      const now = Date.now();
      const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
      
      const files = fs.readdirSync(this.logsDir);
      
      for (const file of files) {
        if (file.startsWith('app-') && file.endsWith('.log')) {
          const filePath = path.join(this.logsDir, file);
          const stats = fs.statSync(filePath);
          
          if (now - stats.mtime.getTime() > retentionMs) {
            fs.unlinkSync(filePath);
          }
        }
      }
    } catch {
      // TODO: Add proper logging - Failed to cleanup old logs
    }
  }
  
  cleanupRotatedFiles() {
    try {
      const files = fs.readdirSync(this.logsDir)
        .filter(file => file.startsWith('app-') && file.endsWith('.log'))
        .map(file => ({
          name: file,
          path: path.join(this.logsDir, file),
          stats: fs.statSync(path.join(this.logsDir, file))
        }))
        .sort((a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime());
      
      // Keep only the most recent files
      if (files.length > this.config.maxFiles) {
        const filesToDelete = files.slice(this.config.maxFiles);
        for (const file of filesToDelete) {
          fs.unlinkSync(file.path);
        }
      }
    } catch {
      // TODO: Add proper logging - Failed to cleanup rotated files
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
  
  createLogEntry(level, message, options = {}) {
    const timestamp = new Date();
    const logId = ++this.logIdCounter;
    
    // Default to System instance if not specified
    const instanceId = options.instanceId || 'system';
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
      
      // Append to current log file
      fs.appendFileSync(this.currentLogFile, logLine);
      
    } catch {
      // TODO: Add proper logging - Failed to write log to file
    }
  }
  
  addToMemoryBuffer(logEntry) {
    this.memoryLogs.push(logEntry);
    
    // Trim memory buffer if it exceeds limit
    if (this.memoryLogs.length > this.config.maxMemoryLogs) {
      this.memoryLogs = this.memoryLogs.slice(-this.config.maxMemoryLogs);
    }
  }
  
  log(level, message, options = {}) {
    // Validate log level
    if (!Object.prototype.hasOwnProperty.call(this.logLevels, level)) {
      level = 'info';
    }
    
    const logEntry = this.createLogEntry(level, message, options);
    
    // Add to memory buffer
    this.addToMemoryBuffer(logEntry);
    
    // Write to file
    this.writeToFile(logEntry);
    
    // Emit for real-time streaming
    this.emit('log', logEntry);
    
    return logEntry;
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
        }
      };
      
      fs.writeFileSync(crashFile, JSON.stringify(crashReport, null, 2));
      
      return crashFile;
    } catch {
      // TODO: Add proper logging - Failed to export crash report
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
    this.config = { ...this.config, ...newConfig };
    
    // Apply memory limit immediately
    if (this.memoryLogs.length > this.config.maxMemoryLogs) {
      this.memoryLogs = this.memoryLogs.slice(-this.config.maxMemoryLogs);
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
        webSecurity: true
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