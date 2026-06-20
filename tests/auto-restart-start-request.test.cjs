const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

async function withServerManager(fn) {
  const modulePath = path.resolve(__dirname, '../electron/services/server-manager.cjs');
  const originalLoad = Module._load;
  const eventBus = new EventEmitter();
  const sentMessages = [];
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request.endsWith('utils/event-bus.cjs')) {
      return eventBus;
    }

    if (request.endsWith('utils/safe-send.cjs')) {
      return {
        safeSend(channel, payload) {
          sentMessages.push({ channel, payload });
        }
      };
    }

    if (request.endsWith('utils/app-store.cjs')) {
      return {
        get() {
          return null;
        },
        set() {}
      };
    }

    if (request.endsWith('ipc/logger-handlers.cjs')) {
      return {
        getLoggerHandlers() {
          return logger;
        }
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const serverManager = require(modulePath);
    return await fn({ eventBus, sentMessages, serverManager });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

test('server manager subscribes to auto-restart start requests', async () => {
  await withServerManager(async ({ eventBus }) => {
    assert.equal(eventBus.listenerCount('request-server-start'), 1);
    assert.equal(eventBus.emit('request-server-start', { targetPath: '' }), true);
  });
});
