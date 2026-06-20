const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function withServerModHandlers({ installed, disabled = [], versionsByProject = {} }, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-compat-progress-'));
  const originalLoad = Module._load;
  const modulePath = path.resolve(__dirname, '../electron/ipc/mod-handlers/server-mod-handlers.cjs');
  const sent = [];

  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    trace() {}
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (typeof request === 'string' && request.includes('services/mod-api-service.cjs')) {
      return {
        getModrinthDownloadUrl() {},
        getCurseForgeDownloadUrl() {},
        clearVersionCache() {},
        async getModrinthVersions(projectId) {
          return versionsByProject[projectId] || [];
        }
      };
    }

    if (typeof request === 'string' && request.includes('mod-utils/mod-file-manager.cjs')) {
      return {
        async getInstalledModInfo() {
          return installed;
        },
        async getDisabledMods() {
          return disabled;
        }
      };
    }

    if (typeof request === 'string' && request.includes('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => logger };
    }

    if (typeof request === 'string' && request.includes('error-monitoring-handlers.cjs')) {
      return { serverErrorMonitor: {} };
    }

    if (typeof request === 'string' && request.includes('utils/app-store.cjs')) {
      return { get: () => null, set: () => true };
    }

    if (typeof request === 'string' && request.includes('utils/server-loader.cjs')) {
      return {
        resolveServerLoader() {
          return { loader: 'fabric', loaderVersion: '0.16.0' };
        }
      };
    }

    if (typeof request === 'string' && request.includes('services/download-manager.cjs')) {
      return { downloadWithProgress() {} };
    }

    if (typeof request === 'string' && request.includes('mod-utils/mod-installation-service.cjs')) {
      return {};
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const { createServerModHandlers } = require(modulePath);
    const win = {
      isDestroyed: () => false,
      webContents: {
        send(channel, payload) {
          sent.push({ channel, payload });
        }
      }
    };
    return await fn(createServerModHandlers(win), root, sent);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('check-mod-compatibility emits determinate progress for enabled mods', async () => {
  const installed = [
    { fileName: 'alpha.jar', name: 'Alpha', projectId: 'alpha', versionNumber: '1.0.0' },
    { fileName: 'beta.jar', name: 'Beta', projectId: 'beta', versionNumber: '1.0.0' },
    { fileName: 'disabled.jar', name: 'Disabled', projectId: 'disabled', versionNumber: '1.0.0' }
  ];

  await withServerModHandlers({
    installed,
    disabled: ['disabled.jar'],
    versionsByProject: {
      alpha: [{ versionNumber: '1.0.0', gameVersions: ['1.21.1'], dependencies: [] }],
      beta: [{ versionNumber: '2.0.0', gameVersions: ['1.21.1'], dependencies: [] }]
    }
  }, async (handlers, serverPath, sent) => {
    const results = await handlers['check-mod-compatibility']({}, {
      serverPath,
      mcVersion: '1.21.1',
      fabricVersion: '0.16.0'
    });

    assert.equal(results.length, 2);

    const progress = sent
      .filter((event) => event.channel === 'mod-compatibility-progress')
      .map((event) => event.payload);

    assert.ok(progress.length >= 5, 'expected start, per-mod, and complete progress events');
    assert.deepEqual(
      progress.map((event) => event.phase),
      ['loading', 'ready', 'checking', 'checked', 'checking', 'checked', 'complete']
    );
    assert.equal(progress[1].total, 2);
    assert.equal(progress[2].modName, 'Alpha');
    assert.equal(progress[2].current, 0);
    assert.equal(progress[3].current, 1);
    assert.equal(progress[3].percent, 50);
    assert.equal(progress[5].current, 2);
    assert.equal(progress[5].percent, 100);
    assert.equal(progress[6].total, 2);
    assert.equal(progress[6].percent, 100);
  });
});
