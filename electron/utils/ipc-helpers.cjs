const { ipcMain } = require('electron');

// Track registered handlers
const registeredHandlers = new Set();

/**
 * Register a single IPC handler with error handling and duplicate prevention
 * 
 * @param {string} channel - The IPC channel name
 * @param {Function} handler - The handler function
 * @returns {boolean} Success status
 */
function safeIpcHandle(channel, handler) {
  try {
    if (!channel || typeof channel !== 'string') {
      return false;
    }
    
    if (typeof handler !== 'function') {
      return false;
    }
    
    // Check if we've already registered this handler
    if (registeredHandlers.has(channel)) {
      return false;
    }
    
    // Remove any existing handlers with the same name
    try {
      ipcMain.removeHandler(channel);
    } catch (e) {
      // Ignore errors if no handler exists
    }
    
    // Register handler
    ipcMain.handle(channel, handler);
    registeredHandlers.add(channel);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Register multiple IPC handlers at once
 * 
 * @param {Object.<string, Function>} handlers - Object with channel names as keys and handler functions as values
 * @returns {Object} Object with success status for each handler
 */
function registerIpcHandlers(handlers) {
  const results = {};
  
  for (const [channel, handler] of Object.entries(handlers)) {
    results[channel] = safeIpcHandle(channel, handler);
  }
  
  return results;
}

module.exports = { 
  safeIpcHandle,
  registerIpcHandlers,
  registeredHandlers
};
