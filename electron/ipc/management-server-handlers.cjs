// Management server IPC handlers
const { getManagementServer } = require('../services/management-server.cjs');

/**
 * Create management server IPC handlers
 * 
 * @param {object} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createManagementServerHandlers(win) {
  const managementServer = getManagementServer();
  
  return {
    // Start the management server
    'start-management-server': async (_event, { port = 8080, serverPath }) => {
      try {
        const result = await managementServer.start(port, serverPath);
        
        if (result.success) {
          
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
        return { success: false, error: error.message };
      }
    },
      // Stop the management server
    'stop-management-server': async () => {
      try {
        const result = await managementServer.stop();
        
        // Notify renderer about server status when stopped, even if forced/timeout
        if (win && win.webContents && (result.success || result.forced)) {
          win.webContents.send('management-server-status', {
            isRunning: false,
            port: null,
            serverPath: null,
            forced: !!result.forced,
            reason: result.reason || undefined
          });
        }
        
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
      // Get management server status
    'get-management-server-status': async () => {
      try {
        const status = managementServer.getStatus();
        return { success: true, status };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Update server path
    'update-management-server-path': async (_event, serverPath) => {
      try {
        managementServer.updateServerPath(serverPath);
        
        // Notify renderer about path update
        if (win && win.webContents) {
          win.webContents.send('management-server-path-updated', serverPath);
        }
        
        return { success: true, serverPath };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Set external host for mod downloads
    'set-management-server-external-host': async (_event, hostIP) => {
      try {
        managementServer.setExternalHost(hostIP);
        
        return { 
          success: true, 
          externalHost: hostIP,
          downloadHost: managementServer.getModDownloadHost()
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Get current external host info
    'get-management-server-host-info': async () => {
      try {
        return { 
          success: true, 
          downloadHost: managementServer.getModDownloadHost(),
          externalHost: managementServer.externalHost,
          configuredHost: managementServer.configuredHost,
          detectedPublicHost: managementServer.detectedPublicHost
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  };
}

module.exports = { createManagementServerHandlers };
