let mainWindow = null;

function setMainWindow(win) {
  mainWindow = win;
}

function safeSend(channel, data) {
  if (mainWindow && mainWindow.webContents && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

module.exports = { safeSend, setMainWindow };
