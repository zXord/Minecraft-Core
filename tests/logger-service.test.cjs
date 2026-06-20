const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function loadLoggerServiceWithElectronMock(electronMock, fn) {
  const modulePath = path.resolve(__dirname, '../electron/services/logger-service.cjs');
  const originalLoad = Module._load;

  delete require.cache[modulePath];

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return electronMock;
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return fn(require(modulePath));
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

test('logger skips rotation filesystem checks when log file path is unavailable', () => {
  const originalExistsSync = fs.existsSync;
  const invalidExistsSyncArgs = [];

  fs.existsSync = function trackedExistsSync(target) {
    if (
      typeof target !== 'string'
      && !Buffer.isBuffer(target)
      && !(target instanceof URL)
    ) {
      invalidExistsSyncArgs.push(target);
    }
    return originalExistsSync.apply(this, arguments);
  };

  try {
    loadLoggerServiceWithElectronMock(
      {
        app: {
          on() {}
        },
        BrowserWindow: class {}
      },
      ({ LoggerService }) => {
        const logger = new LoggerService();
        assert.equal(logger.currentLogFile, undefined);
      }
    );
  } finally {
    fs.existsSync = originalExistsSync;
  }

  assert.deepEqual(invalidExistsSyncArgs, []);
});
