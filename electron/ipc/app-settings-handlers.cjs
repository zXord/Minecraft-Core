// App-wide settings IPC handlers
const appStore = require('../utils/app-store.cjs');
const { app, BrowserWindow } = require('electron');

/**
 * Create app settings IPC handlers
 */
function createAppSettingsHandlers() {
  return {
    'open-app-settings': async () => {
      try {
        // Send event to renderer to open the app settings modal
        const { BrowserWindow } = require('electron');
        const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        
        if (mainWindow) {
          mainWindow.webContents.send('open-app-settings-modal');
          return { success: true };
        } else {
          return { success: false, error: 'No main window found' };
        }
      } catch (error) {
        console.error('Error opening app settings:', error);
        return { success: false, error: error.message };
      }
    },

    'save-app-settings': async (_e, settings) => {
      try {
        if (!settings || typeof settings !== 'object') {
          return { success: false, error: 'Invalid settings data' };
        }

        // Get current app settings
        const currentSettings = appStore.get('appSettings') || {};

        // Validate and merge settings
        const updatedSettings = {
          ...currentSettings,
          minimizeToTray: Boolean(settings.minimizeToTray),
          startMinimized: Boolean(settings.startMinimized),
          startOnStartup: Boolean(settings.startOnStartup),
          windowSize: settings.windowSize || 'medium',
          customWidth: Math.max(800, parseInt(settings.customWidth) || 1200),
          customHeight: Math.max(600, parseInt(settings.customHeight) || 800)
        };



        // Handle startup setting
        if (settings.startOnStartup !== undefined) {
          try {
            if (settings.startOnStartup) {
              app.setLoginItemSettings({
                openAtLogin: true,
                name: 'Minecraft Core',
                args: updatedSettings.startMinimized ? ['--start-minimized'] : []
              });
            } else {
              app.setLoginItemSettings({
                openAtLogin: false
              });
            }
          } catch (err) {
            console.warn('Failed to update startup settings:', err.message);
            // Don't fail the entire operation for this
          }
        }

        // Save settings to store
        appStore.set('appSettings', updatedSettings);

        return { success: true, settings: updatedSettings };
      } catch (err) {
        console.error('Error saving app settings:', err);
        return { success: false, error: err.message };
      }
    },

    'get-app-settings': async () => {
      try {
        const defaultSettings = {
          minimizeToTray: false,
          startMinimized: false,
          startOnStartup: false,
          windowSize: 'medium',
          customWidth: 1200,
          customHeight: 800
        };

        const settings = appStore.get('appSettings') || defaultSettings;

        // Only verify startup setting with system if we don't have a stored value
        // This prevents overriding user changes that haven't been reflected by the system yet
        if (settings.startOnStartup === undefined || settings.startOnStartup === null) {
          try {
            const loginItemSettings = app.getLoginItemSettings();
            settings.startOnStartup = loginItemSettings.openAtLogin;
          } catch (err) {
            console.warn('Failed to get login item settings:', err.message);
            settings.startOnStartup = false; // Default to false if we can't check
          }
        }

        return { success: true, settings };
      } catch (err) {
        console.error('Error loading app settings:', err);
        return { success: false, error: err.message };
      }
    },

    'get-app-version': async () => {
      try {
        const version = app.getVersion();
        return { success: true, version };
      } catch (err) {
        console.error('Error getting app version:', err);
        return { success: false, error: err.message };
      }
    },

    'set-window-size': async (_e, sizeOptions) => {
      try {
        const mainWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        
        if (!mainWindow) {
          return { success: false, error: 'No main window found' };
        }

        const { width, height, resizable } = sizeOptions;
        
        // Validate dimensions
        const validWidth = Math.max(800, Math.min(2560, parseInt(width) || 1200));
        const validHeight = Math.max(600, Math.min(1440, parseInt(height) || 800));

        // PRESERVE WINDOW POSITION - Get current position before resizing
        const [currentX, currentY] = mainWindow.getPosition();

        // Set window size and resizable state
        // FORCE resize by setting min/max constraints temporarily
        mainWindow.setMinimumSize(validWidth, validHeight);
        mainWindow.setMaximumSize(validWidth, validHeight);
        mainWindow.setSize(validWidth, validHeight);
        mainWindow.setResizable(Boolean(resizable));
        
        // Reset constraints after a brief delay to allow the resize
        setTimeout(() => {
          mainWindow.setMinimumSize(800, 600); // Reset to minimum allowed
          mainWindow.setMaximumSize(2560, 1440); // Reset to maximum allowed
        }, 100);
        
        // RESTORE the original position (don't center!)
        mainWindow.setPosition(currentX, currentY);

        return { success: true, width: validWidth, height: validHeight, resizable };
      } catch (err) {
        console.error('Error setting window size:', err);
        return { success: false, error: err.message };
      }
    }
  };
}

module.exports = { createAppSettingsHandlers }; 