const { markStartupTrace } = require('../electron/utils/startup-trace.cjs');

// Vite has its own process baseline. Config loading/early CLI work precedes
// these checkpoints; their elapsed values cannot be compared with Electron's.
function createViteStartupTracePlugin(options = {}) {
  const env = options.env === undefined ? process.env : options.env;
  if (env?.MINECRAFT_CORE_STARTUP_TRACE !== '1') return null;
  const mark = options.markStartupTrace === undefined ? markStartupTrace : options.markStartupTrace;
  let configured = false;
  return {
    name: 'minecraft-core-startup-trace',
    apply: 'serve',
    configResolved() {
      mark('vite:config-resolved');
    },
    configureServer(server) {
      mark('vite:configure-server');
      if (configured) return;
      configured = true;
      server.httpServer?.once('listening', () => mark('vite:http-listening'));
    }
  };
}

module.exports = { createViteStartupTracePlugin };
