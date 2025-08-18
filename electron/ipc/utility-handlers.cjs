// Utility IPC handlers for small app-wide helpers
const { shell, dialog, BrowserWindow } = require('electron');

/**
 * Create utility IPC handlers
 * @param {Electron.BrowserWindow} win
 */
function createUtilityHandlers(win) {
  return {
    // Open a URL in the user's default browser
    'open-external-url': async (_e, url) => {
      try {
        if (!url || typeof url !== 'string') {
          return { success: false, error: 'Invalid URL' };
        }
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return { success: false, error: 'Malformed URL' };
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return { success: false, error: 'Unsupported protocol' };
        }
        await shell.openExternal(url);
        return { success: true };
      } catch (err) {
        return { success: false, error: err?.message || 'Failed to open URL' };
      }
    },

    // Show an error dialog from renderer requests
    'show-error-dialog': async (_e, options = {}) => {
      try {
        const bw = BrowserWindow.getFocusedWindow() || win || BrowserWindow.getAllWindows()[0];
        const { title = 'Error', message = 'An error occurred', detail } = options;
        await dialog.showMessageBox(bw, {
          type: 'error',
          title,
          message,
          detail: typeof detail === 'string' && detail ? detail : undefined,
          buttons: ['OK']
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err?.message || 'Failed to show dialog' };
      }
    }
  };
}

module.exports = { createUtilityHandlers };
