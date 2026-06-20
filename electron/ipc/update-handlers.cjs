const { getUpdateService } = require('../services/update-service.cjs');

function getRunningServersForUpdateInstall() {
  try {
    const { getAllServerStates, getServerState } = require('../services/server-manager.cjs');
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

function canInstallUpdateNow() {
  const runningServers = getRunningServersForUpdateInstall();
  if (runningServers.length > 0) {
    return {
      success: false,
      error: 'Please stop the Minecraft server before installing the update to prevent data corruption.',
      runningServers
    };
  }

  return { success: true };
}

function createUpdateHandlers(win) {
  const updateService = getUpdateService();
  
  // Forward update events to renderer
  updateService.on('checking-for-update', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-checking-for-update');
    }
  });
  
  updateService.on('update-available', (info) => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-available', info);
    }
  });
  
  updateService.on('update-not-available', (info) => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-not-available', info);
    }
  });
  
  updateService.on('update-error', (error) => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-error', { message: error.message, stack: error.stack });
    }
  });
  
  updateService.on('download-progress', (progress) => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-download-progress', progress);
    }
  });
  
  updateService.on('update-downloaded', (info) => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-downloaded', info);
    }
  });
  
  updateService.on('update-ignored', (info) => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-ignored', info);
    }
  });

  // Forward specific version download events
  updateService.on('specific-version-download-progress', (progress) => {
    if (!win.isDestroyed()) {
      win.webContents.send('specific-version-download-progress', progress);
    }
  });

  updateService.on('specific-version-download-complete', (info) => {
    if (!win.isDestroyed()) {
      win.webContents.send('specific-version-download-complete', info);
    }
  });

  updateService.on('specific-version-download-error', (error) => {
    if (!win.isDestroyed()) {
      win.webContents.send('specific-version-download-error', error);
    }
  });

  // Forward update log events for user-visible diagnostics
  updateService.on('update-log', (entry) => {
    if (!win.isDestroyed()) {
      win.webContents.send('update-log', entry);
    }
  });

  return {
    // Check for updates manually
    'check-for-updates': async () => {
      try {
        const result = await updateService.checkForUpdates();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Download the available update
    'download-update': async (_event, options = {}) => {
      try {
        const result = await updateService.downloadUpdate(options);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Install the downloaded update
    'install-update': async () => {
      try {
        const installCheck = canInstallUpdateNow();
        if (!installCheck.success) {
          return installCheck;
        }

        updateService.quitAndInstall();
        return { success: true, message: 'Installing update...' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Ignore the current available version
    'ignore-update': async (_event, version) => {
      try {
        const result = updateService.ignoreVersion(version);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Clear ignored version (for "remind me later")
    'remind-later': async () => {
      try {
        const result = updateService.clearIgnoredVersion();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Set auto-install preference
    'set-auto-install': async (_event, enabled) => {
      try {
        const result = updateService.setAutoInstall(enabled);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Get current update status
    'get-update-status': async () => {
      try {
        const status = updateService.getUpdateStatus();
        return { success: true, ...status };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    'get-staged-specific-version-update': async () => {
      try {
        return await updateService.getStagedSpecificVersionInstallTest();
      } catch (error) {
        return { success: false, staged: false, error: error.message };
      }
    },

    // Start periodic update checks
    'start-periodic-checks': async () => {
      try {
        const result = updateService.startPeriodicChecks();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Stop periodic update checks
    'stop-periodic-checks': async () => {
      try {
        const result = updateService.stopPeriodicChecks();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Check for a specific version (for server compatibility)
    'check-for-specific-version': async (_event, targetVersion) => {
      try {
        const result = await updateService.checkForSpecificVersion(targetVersion);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Get current app version
    'get-current-version': async () => {
      try {
        const version = updateService.getCurrentVersion();
        return { success: true, version };
      } catch (error) {
        return { success: false, error: error.message, version: '1.0.0' };
      }
    },

    // Download a specific version (for server compatibility)
    'download-specific-version': async (_event, payload) => {
      try {
        const targetVersion = payload && typeof payload === 'object' ? payload.targetVersion : payload;
        const options = payload && typeof payload === 'object' ? {
          installAfterDownload: payload.installAfterDownload === true
        } : {};
        const result = await updateService.downloadSpecificVersion(targetVersion, options);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Install a downloaded specific version
    'install-specific-version': async (_event, filePath) => {
      try {
        // Wait a moment to ensure file system has synced
        await new Promise(resolve => setTimeout(resolve, 1000));

        const installCheck = canInstallUpdateNow();
        if (!installCheck.success) {
          return installCheck;
        }

        return await updateService.installSpecificVersionInstaller(filePath, {
          silent: false,
          forceRunAfter: true
        });
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Check if a file exists
    'check-file-exists': async (_event, filePath) => {
      try {
        const fs = require('fs');
        const exists = fs.existsSync(filePath);
        let size = 0;
        
        if (exists) {
          const stats = fs.statSync(filePath);
          size = stats.size;
        }
        
        return { 
          success: true, 
          exists: exists,
          size: size
        };
      } catch (error) {
        return { 
          success: false, 
          exists: false,
          error: error.message 
        };
      }
    }
  };
}

module.exports = { createUpdateHandlers }; 
