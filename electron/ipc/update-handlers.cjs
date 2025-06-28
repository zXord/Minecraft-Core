const { getUpdateService } = require('../services/update-service.cjs');

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
    'download-update': async () => {
      try {
        const result = await updateService.downloadUpdate();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Install the downloaded update
    'install-update': async () => {
      try {
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
    'download-specific-version': async (_event, targetVersion) => {
      try {
        const result = await updateService.downloadSpecificVersion(targetVersion);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Install a downloaded specific version
    'install-specific-version': async (_event, filePath) => {
      try {
        const { shell } = require('electron');
        const fs = require('fs');
        
        // Check if file exists
        if (!fs.existsSync(filePath)) {
          return { success: false, error: 'Installer file not found' };
        }
        
        // Launch the installer
        await shell.openPath(filePath);
        
        return { success: true, message: 'Installer launched. The app will close when installation begins.' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  };
}

module.exports = { createUpdateHandlers }; 