// App-wide settings IPC handlers
const appStore = require('../utils/app-store.cjs');
const { app } = require('electron');

/**
 * Create app settings IPC handlers
 */
function createAppSettingsHandlers() {
  return {
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
          startOnStartup: Boolean(settings.startOnStartup)
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
          startOnStartup: false
        };

        const settings = appStore.get('appSettings') || defaultSettings;

        // Verify startup setting with system
        try {
          const loginItemSettings = app.getLoginItemSettings();
          settings.startOnStartup = loginItemSettings.openAtLogin;
        } catch (err) {
          console.warn('Failed to get login item settings:', err.message);
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

    'check-for-updates': async () => {
      try {
        const currentVersion = app.getVersion();
        
        // For now, this is a placeholder implementation
        // In a real app, you'd check against a remote server or GitHub releases
        
        // Simulate checking for updates
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // For demonstration, let's say we're up to date
        // In real implementation, you'd:
        // 1. Fetch latest version from GitHub releases API or your update server
        // 2. Compare version numbers
        // 3. Return appropriate response
        
        const mockLatestVersion = currentVersion; // Simulating up-to-date
        const hasUpdate = false; // Would be determined by version comparison
        
        return {
          success: true,
          currentVersion,
          latestVersion: mockLatestVersion,
          hasUpdate,
          // You could also include download URL, release notes, etc.
          releaseNotes: hasUpdate ? 'Bug fixes and improvements' : null,
          downloadUrl: hasUpdate ? 'https://example.com/download' : null
        };
      } catch (err) {
        console.error('Error checking for updates:', err);
        return { success: false, error: err.message };
      }
    }
  };
}

module.exports = { createAppSettingsHandlers }; 