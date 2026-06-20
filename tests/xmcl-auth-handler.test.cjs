const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

function withElectronMock(fn) {
  const originalLoad = Module._load;
  const handlerPath = path.resolve(__dirname, '../electron/services/minecraft-launcher/xmcl-auth-handler.cjs');
  const secureStorePath = path.resolve(__dirname, '../electron/utils/secure-store.cjs');

  delete require.cache[handlerPath];
  delete require.cache[secureStorePath];

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (value) => Buffer.from(String(value), 'utf8'),
          decryptString: (buffer) => Buffer.from(buffer).toString('utf8')
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return fn(handlerPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[handlerPath];
    delete require.cache[secureStorePath];
  }
}

test('XMCL auth handler constructs Microsoft authenticator with fetch options', () => {
  withElectronMock((handlerPath) => {
    const { XMCLAuthHandler } = require(handlerPath);
    const handler = new XMCLAuthHandler(new EventEmitter());

    assert.ok(handler.authenticator);
    assert.equal(typeof handler.authenticator.fetch, 'function');
  });
});
