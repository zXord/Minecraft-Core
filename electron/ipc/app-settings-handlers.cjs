// App-wide settings IPC handlers
const appStore = require('../utils/app-store.cjs');
const { app, BrowserWindow } = require('electron');
const { ensureEncryptionAvailable, packSecret, unpackSecret, ENCRYPTED_PREFIX } = require('../utils/secure-store.cjs');

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
        // TODO: Add proper logging - Error opening app settings
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

        if (settings.modWatch && typeof settings.modWatch === 'object') {
          const mw = settings.modWatch;
            updatedSettings.modWatch = {
              showWindowsNotifications: Boolean(mw.showWindowsNotifications),
              intervalHours: mw.intervalHours === 24 ? 24 : 12
            };
        } else if (!currentSettings.modWatch) {
          updatedSettings.modWatch = { showWindowsNotifications: false, intervalHours: 12 };
        }

        // Optional: browser control panel settings (served by management server)
        if (settings.browserPanel && typeof settings.browserPanel === 'object') {
          const bp = settings.browserPanel;
          const bpCurrent = currentSettings.browserPanel || {};
          const portNum = parseInt(bp.port);
          const safePort = !isNaN(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : (bpCurrent.port || 8080);
          let passwordValue = typeof bp.password === 'string' && bp.password.trim().length > 0
            ? bp.password.trim()
            : (bpCurrent.password || 'password');
          if (typeof passwordValue === 'string' && !passwordValue.startsWith(ENCRYPTED_PREFIX)) {
            ensureEncryptionAvailable();
            passwordValue = packSecret(passwordValue);
          }

          updatedSettings.browserPanel = {
            enabled: Boolean(bp.enabled),
            autoStart: Boolean(bp.autoStart),
            port: safePort,
            username: typeof bp.username === 'string' && bp.username.trim().length > 0 ? bp.username.trim() : (bpCurrent.username || 'user'),
            password: passwordValue,
            instanceVisibility: (bp.instanceVisibility && typeof bp.instanceVisibility === 'object') ? bp.instanceVisibility : (bpCurrent.instanceVisibility || {})
          };
        }



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
          } catch {
            // TODO: Add proper logging - Failed to update startup settings
            // Don't fail the entire operation for this
          }
        }

        // Save settings to store
        appStore.set('appSettings', updatedSettings);

        return { success: true, settings: updatedSettings };
      } catch (err) {
        // TODO: Add proper logging - Error saving app settings
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
          customHeight: 800,
          browserPanel: {
            enabled: false,
            autoStart: false,
            port: 8080,
            username: 'user',
            password: 'password',
            instanceVisibility: {}
          }
        };

        const stored = appStore.get('appSettings') || {};
        const settings = {
          ...defaultSettings,
          ...stored,
          browserPanel: { ...defaultSettings.browserPanel, ...(stored.browserPanel || {}) }
        };
        if (!settings.modWatch) {
          settings.modWatch = { showWindowsNotifications: false, intervalHours: 12 };
        }
        if (typeof settings.browserPanel.password === 'string' && settings.browserPanel.password.startsWith(ENCRYPTED_PREFIX)) {
          settings.browserPanel.password = unpackSecret(settings.browserPanel.password);
        }

        // Only verify startup setting with system if we don't have a stored value
        // This prevents overriding user changes that haven't been reflected by the system yet
        if (settings.startOnStartup === undefined || settings.startOnStartup === null) {
          try {
            const loginItemSettings = app.getLoginItemSettings();
            settings.startOnStartup = loginItemSettings.openAtLogin;
          } catch {
            // TODO: Add proper logging - Failed to get login item settings
            settings.startOnStartup = false; // Default to false if we can't check
          }
        }

        return { success: true, settings };
      } catch (err) {
        // TODO: Add proper logging - Error loading app settings
        return { success: false, error: err.message };
      }
    },

    'get-app-version': async () => {
      try {
        const version = app.getVersion();
        return { success: true, version };
      } catch (err) {
        // TODO: Add proper logging - Error getting app version
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
        // TODO: Add proper logging - Error setting window size
        return { success: false, error: err.message };
      }
    }
  };
}

module.exports = { createAppSettingsHandlers }; 
