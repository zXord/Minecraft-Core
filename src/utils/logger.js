/**
 * Frontend Logger Utility
 * 
 * Provides a clean interface for logging from Svelte components
 * with automatic instance detection and category support.
 */

class FrontendLogger {
  constructor() {
    this.currentInstance = 'system';
    this.setupInstanceDetection();
  }
  
  setupInstanceDetection() {
    // Try to detect current instance from various sources
    try {
      // Check localStorage for current instance
      const storedInstance = localStorage.getItem('currentInstance');
      if (storedInstance) {
        const instance = JSON.parse(storedInstance);
        if (instance && instance.path) {
          // Convert path to instance ID
          this.currentInstance = this.pathToInstanceId(instance.path, instance.type);
        }
      }
    } catch (error) {
      // Fallback to system
      this.currentInstance = 'system';
    }
  }
  
  pathToInstanceId(path, type = 'unknown') {
    // Extract instance name from path or use type-based naming
    try {
      if (typeof path === 'string') {
        const pathParts = path.split(/[/\\]/);
        const instanceName = pathParts[pathParts.length - 1] || pathParts[pathParts.length - 2];
        
        if (instanceName && instanceName !== '.') {
          return `${type}-${instanceName}`;
        }
      }
      
      // Fallback to type-based naming
      return type === 'server' ? 'server-1' : type === 'client' ? 'client-1' : 'system';
    } catch (error) {
      return 'system';
    }
  }
  
  setInstance(instanceId) {
    this.currentInstance = instanceId;
  }
  
  async log(level, message, options = {}) {
    try {
      // Prepare options with defaults
      const logOptions = {
        instanceId: options.instanceId || this.currentInstance,
        category: options.category || 'ui',
        data: options.data || null,
        stack: options.stack || (options.includeStack ? new Error().stack : null)
      };
      
      // Send to backend logger
      const result = await window.electron.invoke('logger-add-log', level, message, logOptions);
      
      return result;
    } catch (error) {
      // TODO: Add proper logging - Logger failed
      return { success: false, error: error.message };
    }
  }
  
  // Convenience methods with level-specific defaults
  debug(message, options = {}) {
    return this.log('debug', message, {
      category: 'ui',
      ...options
    });
  }
  
  info(message, options = {}) {
    return this.log('info', message, {
      category: 'ui',
      ...options
    });
  }
  
  warn(message, options = {}) {
    return this.log('warn', message, {
      category: 'ui',
      ...options
    });
  }
  
  error(message, options = {}) {
    return this.log('error', message, {
      category: 'ui',
      includeStack: true,
      ...options
    });
  }
  
  fatal(message, options = {}) {
    return this.log('fatal', message, {
      category: 'ui',
      includeStack: true,
      ...options
    });
  }
  
  // Category-specific logging methods
  network(level, message, options = {}) {
    return this.log(level, message, {
      category: 'network',
      ...options
    });
  }
  
  mods(level, message, options = {}) {
    return this.log(level, message, {
      category: 'mods',
      ...options
    });
  }
  
  auth(level, message, options = {}) {
    return this.log(level, message, {
      category: 'auth',
      ...options
    });
  }
  
  storage(level, message, options = {}) {
    return this.log(level, message, {
      category: 'storage',
      ...options
    });
  }
  
  performance(level, message, options = {}) {
    return this.log(level, message, {
      category: 'performance',
      ...options
    });
  }
  
  // Server instance logging
  server(level, message, options = {}) {
    return this.log(level, message, {
      instanceId: 'server-1', // TODO: Make this dynamic
      category: 'core',
      ...options
    });
  }
  
  // Client instance logging  
  client(level, message, options = {}) {
    return this.log(level, message, {
      instanceId: 'client-1', // TODO: Make this dynamic
      category: 'core',
      ...options
    });
  }
  
  // Get logs from backend
  async getLogs(options = {}) {
    try {
      const result = await window.electron.invoke('logger-get-logs', options);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        logs: []
      };
    }
  }
  
  // Search logs
  async searchLogs(searchOptions) {
    try {
      const result = await window.electron.invoke('logger-search-logs', searchOptions);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        logs: []
      };
    }
  }
  
  // Get logger statistics
  async getStats() {
    try {
      const result = await window.electron.invoke('logger-get-stats');
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        stats: {}
      };
    }
  }
  
  // Export logs
  async exportLogs(options = {}) {
    try {
      const result = await window.electron.invoke('logger-export-logs', options);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // Clear logs
  async clearLogs() {
    try {
      const result = await window.electron.invoke('logger-clear-logs');
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // Update logger configuration
  async updateConfig(config) {
    try {
      const result = await window.electron.invoke('logger-update-config', config);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  // Get current configuration
  async getConfig() {
    try {
      const result = await window.electron.invoke('logger-get-config');
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        config: {}
      };
    }
  }
  
  // Get available instances for filtering
  async getInstances() {
    try {
      const result = await window.electron.invoke('logger-get-instances');
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        instances: []
      };
    }
  }
  
  // Get available categories for filtering
  async getCategories() {
    try {
      const result = await window.electron.invoke('logger-get-categories');
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        categories: []
      };
    }
  }

  // Window Management
  async openWindow() {
    try {
      const result = await window.electron.invoke('logger-open-window');
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async closeWindow() {
    try {
      const result = await window.electron.invoke('logger-close-window');
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

// Create singleton instance
const logger = new FrontendLogger();

// Export both the instance and class
export default logger;
export { FrontendLogger }; 