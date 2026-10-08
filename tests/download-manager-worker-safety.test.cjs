const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('download manager loads without Electron logger IPC inside a runtime worker', () => {
  const modulePath = require.resolve('../electron/services/download-manager.cjs');
  const cachedModule = require.cache[modulePath];
  const originalLoad = Module._load;
  let loaded;

  delete require.cache[modulePath];
  Module._load = function rejectElectronLoggerIpc(request, parent, isMain) {
    if (parent?.filename === modulePath && request === '../ipc/logger-handlers.cjs') {
      throw new Error('Electron logger IPC is unavailable in a runtime worker');
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    assert.doesNotThrow(() => {
      loaded = require(modulePath);
    });
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
    if (cachedModule) {
      require.cache[modulePath] = cachedModule;
    }
  }

  assert.equal(typeof loaded.installFabric, 'function');
});

test('download manager does not hide logger initialization failures in the Electron browser process', () => {
  const modulePath = require.resolve('../electron/services/download-manager.cjs');
  const cachedModule = require.cache[modulePath];
  const originalLoad = Module._load;
  const originalProcessType = Object.getOwnPropertyDescriptor(process, 'type');

  delete require.cache[modulePath];
  Object.defineProperty(process, 'type', { configurable: true, value: 'browser' });
  Module._load = function rejectElectronLoggerIpc(request, parent, isMain) {
    if (parent?.filename === modulePath && request === '../ipc/logger-handlers.cjs') {
      throw new Error('browser logger initialization failed');
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    assert.throws(
      () => require(modulePath),
      /browser logger initialization failed/
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
    if (cachedModule) require.cache[modulePath] = cachedModule;
    if (originalProcessType) Object.defineProperty(process, 'type', originalProcessType);
    else delete process.type;
  }
});
