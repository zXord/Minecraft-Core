// Utils for safely sending IPC messages to renderer
const { app } = require('electron');

// Store a reference to the main window
let mainWindow = null;

/**
 * Set the main window reference
 * 
 * @param {BrowserWindow} win - The main window
 */
function setMainWindow(win) {
  mainWindow = win;
}

/**
 * Safely send IPC messages to renderer
 * Checks if window exists and isn't destroyed before sending
 * 
 * @param {string} channel - The IPC channel name
 * @param {any} payload - The data to send
 */
function safeSend(channel, data) {
  if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, data);
    } catch (err) {
      console.error(`Failed to send message on ${channel}:`, err);
    }
  } else {
    console.warn(`Cannot send message on channel ${channel}: No valid main window reference`);
  }
}

module.exports = {
  safeSend,
  setMainWindow
};
