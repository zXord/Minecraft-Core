let mainWindow = null;

function setMainWindow(win) {
  mainWindow = win;
}

function safeSend(channel, data) {
  try {
    if (mainWindow && 
        !mainWindow.isDestroyed() && 
        mainWindow.webContents && 
        !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  } catch (error) {
    // Silently ignore errors when trying to send to destroyed windows
    // This can happen during app shutdown or window transitions
    // TODO: Add proper logging - Failed to send message to channel
  }
}

module.exports = { safeSend, setMainWindow };
