const { ipcMain } = require('electron');
const { getLogger } = require('../services/logger-service.cjs');
const appStore = require('../utils/app-store.cjs');

class LoggerHandlers {
  constructor() {
    this.logger = getLogger();
    this.setupHandlers();
    // Removed setupRealTimeStreaming() - using window-specific streaming instead
  }
  
  setupHandlers() {
    // Get logs with filtering
    ipcMain.handle('logger-get-logs', async (_, options = {}) => {
      try {
        const logs = this.logger.getLogs(options);
        return {
          success: true,
          logs,
          total: this.logger.memoryLogs.length
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Get logger statistics
    ipcMain.handle('logger-get-stats', async () => {
      try {
        const stats = this.logger.getStats();
        return {
          success: true,
          stats
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Clear memory logs
    ipcMain.handle('logger-clear-logs', async () => {
      try {
        this.logger.clearMemoryLogs();
        return {
          success: true
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Export logs
    ipcMain.handle('logger-export-logs', async (_, options = {}) => {
      try {
        const result = this.logger.exportLogs(options);
        return result;
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Update logger configuration
    ipcMain.handle('logger-update-config', async (_, config) => {
      try {
        this.logger.updateConfig(config);
        return {
          success: true,
          config: this.logger.config
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Get current configuration
    ipcMain.handle('logger-get-config', async () => {
      try {
        return {
          success: true,
          config: this.logger.config
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Export crash report manually
    ipcMain.handle('logger-export-crash-report', async () => {
      try {
        const crashFile = this.logger.exportCrashReport();
        return {
          success: true,
          crashFile
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Add a log entry manually (for testing)
    ipcMain.handle('logger-add-log', async (_, level, message, options = {}) => {
      try {
        const logEntry = this.logger.log(level, message, options);
        return {
          success: true,
          logEntry
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Search logs
    ipcMain.handle('logger-search-logs', async (_, searchOptions) => {
      try {
        const logs = this.logger.getLogs(searchOptions);
        return {
          success: true,
          logs,
          count: logs.length
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Get available instances for filtering
    ipcMain.handle('logger-get-instances', async () => {
      try {
        const stats = this.logger.getStats();
        const instances = Object.keys(stats.instances).sort();
        return {
          success: true,
          instances
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    // Get available categories for filtering
    ipcMain.handle('logger-get-categories', async () => {
      try {
        const stats = this.logger.getStats();
        const categories = Object.keys(stats.categories).sort();
        return {
          success: true,
          categories
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });

    // Open logger window
    ipcMain.handle('logger-open-window', async () => {
      try {
        const window = this.logger.openLoggerWindow();
        return {
          success: true,
          windowId: window ? window.id : null
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });

    // Save logger settings
    ipcMain.handle('logger-save-settings', async (_, settings) => {
      try {
        this.logger.log('debug', 'Saving logger settings', {
          instanceId: 'system',
          category: 'settings',
          data: { settings }
        });

        if (!settings || typeof settings !== 'object') {
          this.logger.log('error', 'Invalid logger settings data provided', {
            instanceId: 'system',
            category: 'settings'
          });
          return { success: false, error: 'Invalid settings data' };
        }

        // Get current settings
        const currentSettings = appStore.get('loggerSettings') || {};

        // Validate and merge settings
        const updatedSettings = {
          ...currentSettings,
          maxLogs: Math.max(100, parseInt(settings.maxLogs) || 1000),
          logLevel: settings.logLevel || 'all',
          exportFormat: settings.exportFormat || 'json',
          maxFileSize: Math.max(1, Math.min(1000, parseInt(settings.maxFileSize) || 50)),
          maxFiles: Math.max(1, Math.min(50, parseInt(settings.maxFiles) || 5)),
          retentionDays: Math.max(1, Math.min(365, parseInt(settings.retentionDays) || 7))
        };

        // Save settings to store
        appStore.set('loggerSettings', updatedSettings);
        
        // Reload logger service configuration
        this.logger.loadConfig();
        
        this.logger.log('info', 'Logger settings saved successfully', {
          instanceId: 'system',
          category: 'settings',
          data: { updatedSettings }
        });

        return { success: true, settings: updatedSettings };
      } catch (error) {
        this.logger.log('error', 'Failed to save logger settings', {
          instanceId: 'system',
          category: 'settings',
          data: { error: error.message }
        });
        return { success: false, error: error.message };
      }
    });

    // Get logger settings
    ipcMain.handle('logger-get-settings', async () => {
      try {
        const defaultSettings = {
          maxLogs: 1000,
          logLevel: 'all',
          exportFormat: 'json',
          maxFileSize: 50,
          maxFiles: 5,
          retentionDays: 7
        };

        const settings = appStore.get('loggerSettings') || defaultSettings;
        
        this.logger.log('debug', 'Loading logger settings', {
          instanceId: 'system',
          category: 'settings',
          data: { settings, isDefault: !appStore.get('loggerSettings') }
        });

        return { success: true, settings };
      } catch (error) {
        this.logger.log('error', 'Failed to load logger settings', {
          instanceId: 'system',
          category: 'settings',
          data: { error: error.message }
        });
        return { success: false, error: error.message };
      }
    });

    // Close logger window
    ipcMain.handle('logger-close-window', async () => {
      try {
        this.logger.closeLoggerWindow();
        return {
          success: true
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });

    // Test settings handlers are working
    this.logger.log('debug', 'Logger settings IPC handlers registered', {
      instanceId: 'system',
      category: 'settings'
    });
  }
  
  // Utility method to log from the main process
  logFromMain(level, message, options = {}) {
    return this.logger.log(level, message, {
      ...options,
      instanceId: options.instanceId || 'system',
      category: options.category || 'core'
    });
  }
  
  // Convenience methods for main process logging
  debug(message, options = {}) {
    return this.logFromMain('debug', message, options);
  }
  
  info(message, options = {}) {
    return this.logFromMain('info', message, options);
  }
  
  warn(message, options = {}) {
    return this.logFromMain('warn', message, options);
  }
  
  error(message, options = {}) {
    return this.logFromMain('error', message, options);
  }
  
  fatal(message, options = {}) {
    return this.logFromMain('fatal', message, options);
  }
}

// Singleton instance
let loggerHandlersInstance = null;

function getLoggerHandlers() {
  if (!loggerHandlersInstance) {
    loggerHandlersInstance = new LoggerHandlers();
  }
  return loggerHandlersInstance;
}

module.exports = {
  getLoggerHandlers,
  LoggerHandlers
}; 