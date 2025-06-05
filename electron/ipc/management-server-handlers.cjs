// Management server IPC handlers
const { getManagementServer } = require('../services/management-server.cjs');

/**
 * Create management server IPC handlers
 * 
 * @param {BrowserWindow} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createManagementServerHandlers(win) {
  const managementServer = getManagementServer();
  
  return {
    // Start the management server
    'start-management-server': async (_event, { port = 8080, serverPath }) => {
      try {
        console.log(`[IPC] Starting management server on port ${port} with server path: ${serverPath}`);
        const result = await managementServer.start(port, serverPath);
        
        if (result.success) {
          console.log(`[IPC] Management server started successfully on port ${result.port}`);
          
          // Notify renderer about server status
          if (win && win.webContents) {
            win.webContents.send('management-server-status', {
              isRunning: true,
              port: result.port,
              serverPath
            });
          }
        }
        
        return result;
      } catch (error) {
        console.error('[IPC] Error starting management server:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Stop the management server
    'stop-management-server': async (_event) => {
      try {
        console.log('[IPC] Stopping management server');
        const result = await managementServer.stop();
        
        if (result.success) {
          console.log('[IPC] Management server stopped successfully');
          
          // Notify renderer about server status
          if (win && win.webContents) {
            win.webContents.send('management-server-status', {
              isRunning: false,
              port: null,
              serverPath: null
            });
          }
        }
        
        return result;
      } catch (error) {
        console.error('[IPC] Error stopping management server:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Get management server status
    'get-management-server-status': async (_event) => {
      try {
        const status = managementServer.getStatus();
        console.log('[IPC] Management server status:', status);
        return { success: true, status };
      } catch (error) {
        console.error('[IPC] Error getting management server status:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Update server path
    'update-management-server-path': async (_event, serverPath) => {
      try {
        console.log(`[IPC] Updating management server path to: ${serverPath}`);
        managementServer.updateServerPath(serverPath);
        
        // Notify renderer about path update
        if (win && win.webContents) {
          win.webContents.send('management-server-path-updated', serverPath);
        }
        
        return { success: true, serverPath };
      } catch (error) {
        console.error('[IPC] Error updating management server path:', error);
        return { success: false, error: error.message };
      }
    }
  };
}

module.exports = { createManagementServerHandlers }; 
