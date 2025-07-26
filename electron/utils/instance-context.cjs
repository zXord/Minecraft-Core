/**
 * Instance Context Manager
 * 
 * Provides a way for backend services to track and use the current instance context
 * for logging and other operations.
 */

class InstanceContextManager {
  constructor() {
    this.currentInstance = 'system';
    this.instanceMap = new Map(); // Map of instance paths to instance names
  }
  
  /**
   * Set the current instance context
   * @param {string} instanceName - The name of the current instance
   */
  setCurrentInstance(instanceName) {
    if (instanceName && typeof instanceName === 'string') {
      this.currentInstance = instanceName;
    } else {
      this.currentInstance = 'system';
    }
  }
  
  /**
   * Get the current instance context
   * @returns {string} The current instance name
   */
  getCurrentInstance() {
    return this.currentInstance;
  }
  
  /**
   * Register an instance with its path and name
   * @param {string} path - The instance path
   * @param {string} name - The instance name
   * @param {string} type - The instance type (server/client)
   */
  registerInstance(path, name, type = 'server') {
    if (path && name) {
      this.instanceMap.set(path, {
        name,
        type,
        path
      });
    }
  }
  
  /**
   * Get instance info by path
   * @param {string} path - The instance path
   * @returns {object|null} Instance info or null if not found
   */
  getInstanceByPath(path) {
    return this.instanceMap.get(path) || null;
  }
  
  /**
   * Get instance name by path, with fallback
   * @param {string} path - The instance path
   * @returns {string} Instance name or 'system' if not found
   */
  getInstanceNameByPath(path) {
    const instance = this.getInstanceByPath(path);
    return instance ? instance.name : 'system';
  }
  
  /**
   * Update instances from the app store
   * @param {Array} instances - Array of instance objects from app store
   */
  updateInstances(instances) {
    if (Array.isArray(instances)) {
      // Clear existing mappings
      this.instanceMap.clear();
      
      // Register all instances
      instances.forEach(instance => {
        if (instance.path && instance.name) {
          this.registerInstance(instance.path, instance.name, instance.type);
        }
      });
    }
  }
  
  /**
   * Get all registered instances
   * @returns {Array} Array of instance info objects
   */
  getAllInstances() {
    return Array.from(this.instanceMap.values());
  }
}

// Create singleton instance
const instanceContext = new InstanceContextManager();

module.exports = instanceContext;