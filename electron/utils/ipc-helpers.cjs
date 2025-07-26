const { ipcMain } = require('electron');

// Track registered handlers
const registeredHandlers = new Set();

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
    } catch {
      // TODO: Add proper logging - IPC handler removal error
    }
    
    // Register handler
    ipcMain.handle(channel, handler);
    registeredHandlers.add(channel);
    return true;
  } catch {
    // TODO: Add proper logging - IPC handler registration error
    return false;
  }
}

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
