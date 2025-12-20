// IPC handlers for Browser Panel Server
const { getBrowserPanel } = require('../services/browser-panel-server.cjs');

function createBrowserPanelHandlers(win) {
  const panel = getBrowserPanel();
  return {
    'browser-panel:start': async (_e, { port }) => {
      try {
        const res = await panel.start(port);
        if (win && win.webContents) {
          const protocol = res && res.protocol ? res.protocol : panel.getStatus().protocol;
          win.webContents.send('browser-panel-status', { isRunning: !!res.success, port: res.port || port, protocol });
        }
        return res;
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    'browser-panel:stop': async () => {
      try {
        const res = await panel.stop();
        if (win && win.webContents) {
          win.webContents.send('browser-panel-status', { isRunning: false, port: null, protocol: panel.getStatus().protocol });
        }
        return res;
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    'browser-panel:status': async () => {
      try {
        return { success: true, status: panel.getStatus() };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  };
}

module.exports = { createBrowserPanelHandlers };
