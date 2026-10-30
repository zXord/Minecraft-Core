const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Identities as electron/utils/install-identity.cjs reports them. Unless a test
// says otherwise the harness runs as the NSIS-installed copy, which is the only
// copy allowed to install updates.
const INSTALLED_IDENTITY = Object.freeze({ installed: true, reason: 'uninstaller-present', platform: 'win32', isPackaged: true });
const NOT_INSTALLED_IDENTITY = Object.freeze({ installed: false, reason: 'not-installed-copy', platform: 'win32', isPackaged: true });
const QUIET_LOG = { info() {}, warn() {}, error() {}, debug() {} };

async function withUpdateService(fn, options = {}) {
  const modulePath = path.resolve(__dirname, '../electron/services/update-service.cjs');
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-update-hardening-'));
  const userDataPath = path.join(tempRoot, 'user-data');
  await fsp.mkdir(userDataPath, { recursive: true });
  const storeValues = { instances: [], ...(options.storeValues || {}) };
  const fetchCalls = [];

  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = async () => {};
  autoUpdater.downloadUpdateCalls = 0;
  autoUpdater.downloadUpdate = async () => {
    autoUpdater.downloadUpdateCalls += 1;
  };
  autoUpdater.quitAndInstallCalls = 0;
  autoUpdater.quitAndInstall = (...args) => {
    autoUpdater.quitAndInstallCalls += 1;
    autoUpdater.quitAndInstallArgs = args;
  };

  const fakeApp = {
    isPackaged: options.isPackaged !== undefined ? options.isPackaged : true,
    quitCalled: false,
    quit() {
      this.quitCalled = true;
    },
    getAppPath() {
      return path.resolve(__dirname, '..');
    },
    getName() {
      return 'Minecraft Core';
    },
    getPath(name) {
      if (name === 'userData') return userDataPath;
      return tempRoot;
    }
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron-updater') {
      return { autoUpdater };
    }

    if (request === 'electron-updater/out/AppAdapter') {
      return { getAppCacheDir: () => tempRoot };
    }

    if (request === 'electron') {
      return { app: fakeApp };
    }

    if (request.includes('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => ({ logFromMain() {} }) };
    }

    if (request.includes('app-store.cjs')) {
      return {
        get(key) { return Object.prototype.hasOwnProperty.call(storeValues, key) ? storeValues[key] : null; },
        set() {},
        delete() {}
      };
    }

    if (request.endsWith('install-identity.cjs')) {
      return { getInstallIdentity: () => options.installIdentity || INSTALLED_IDENTITY };
    }

    if (options.devConfig && request.endsWith('dev-config.cjs')) {
      return options.devConfig;
    }

    if (request === './server-manager.cjs' || request.endsWith('server-manager.cjs')) {
      return {
        getAllServerStates: () => options.serverStates || [],
        getServerState: () => options.serverState || { isRunning: false }
      };
    }

    if (request === 'electron-log') {
      return options.quietLog ? QUIET_LOG : console;
    }

    return originalLoad(request, parent, isMain);
  };

  // No test may reach GitHub: every fetch is recorded and answered only by the
  // test's own stand-in.
  global.fetch = async (url, ...rest) => {
    fetchCalls.push(String(url));
    if (typeof options.fetch === 'function') return options.fetch(url, ...rest);
    throw new Error(`Network access is disabled in update-service tests: ${url}`);
  };

  delete require.cache[modulePath];

  try {
    const updateModule = require(modulePath);
    const service = new updateModule.UpdateService();
    service.isDevelopmentMode = () => false;
    service.getCurrentVersion = () => options.currentVersion || '1.0.0';
    return await fn({ service, tempRoot, userDataPath, storeValues, fetchCalls, autoUpdater, fakeApp, updateModule });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
    global.fetch = originalFetch;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

// Records an installer as downloaded and verified by this updater session, so
// installSpecificVersionInstaller can reach its install decision.
async function recordDownloadedInstaller(service, version) {
  const downloadDir = service.getSpecificVersionDownloadDir();
  await fsp.mkdir(downloadDir, { recursive: true });
  const filePath = path.join(downloadDir, `Minecraft-Core-Setup-${version}.exe`);
  const payload = Buffer.from(`installer payload ${version}`);
  await fsp.writeFile(filePath, payload);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  service.rememberSpecificVersionDownload(filePath, version, {
    checksumVerified: true,
    checksumAlgorithm: 'sha256',
    checksumSource: 'github-asset-digest',
    checksumEncoding: 'hex',
    expectedHash: hash,
    actualHash: hash
  });
  return filePath;
}

async function withUpdateHandlers(updateService, shell, fn, options = {}) {
  const modulePath = path.resolve(__dirname, '../electron/ipc/update-handlers.cjs');
  const originalLoad = Module._load;

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === '../utils/startup-trace.cjs') {
      const { createStartupTrace } = originalLoad(request, parent, isMain);
      return { markStartupTrace: createStartupTrace({
        env: options.traceEnabled ? { MINECRAFT_CORE_STARTUP_TRACE: '1' } : {},
        now: () => 100, utcNow: () => '2026-10-09T00:00:00.000Z', pid: 123,
        sink(line) {
          if (options.brokenTraceSink) throw new Error('PRIVATE_SINK');
          options.traceEvents?.push(JSON.parse(line.slice('[Minecraft Core startup trace] '.length)).marker);
        }
      }) };
    }
    if (request === '../services/update-service.cjs' || request.endsWith('services/update-service.cjs')) {
      return { getUpdateService() {
        options.traceEvents?.push('getter');
        if (options.getterError) throw options.getterError;
        return updateService;
      } };
    }

    if (request === 'electron') {
      return { shell };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const { createUpdateHandlers } = require(modulePath);
    const win = {
      isDestroyed() {
        return false;
      },
      webContents: {
        send() {}
      }
    };
    return await fn(createUpdateHandlers(win, options.updatePolicy));
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

function makeReleaseInfo(asset) {
  return {
    name: 'v9.9.9',
    tag_name: 'v9.9.9',
    published_at: '2026-05-30T00:00:00.000Z',
    body: '',
    assets: [asset]
  };
}

test('startup trace actual update handlers bracket only the service getter before event setup', async () => {
  const events = [];
  const updateService = new EventEmitter();
  updateService.on('newListener', () => { events.push('event:setup'); });
  await withUpdateHandlers(updateService, {}, async handlers => {
    assert.equal(typeof handlers['install-update'], 'function');
    assert.deepEqual(events.slice(0, 4), ['update-service:get:start', 'getter', 'update-service:get:complete', 'event:setup']);
    assert.equal(events.filter(value => value === 'update-service:get:complete').length, 1);
  }, { traceEnabled: true, traceEvents: events });
});

test('startup trace getter failure preserves original error without completing even when diagnostics fail', async () => {
  for (const brokenTraceSink of [false, true]) {
    const error = new Error('PRIVATE_ORIGINAL_GETTER');
    const events = [];
    await assert.rejects(withUpdateHandlers(new EventEmitter(), {}, async () => {
      assert.fail('getter failure must prevent handler publication');
    }, { traceEnabled: true, brokenTraceSink, getterError: error, traceEvents: events }), actual => actual === error);
    assert.deepEqual(events, brokenTraceSink ? ['getter'] : ['update-service:get:start', 'getter']);
  }
});

test('quitAndInstall uses visible updater progress and relaunches after install', async () => {
  await withUpdateService(async ({ service, autoUpdater }) => {
    service.quitAndInstall();

    assert.deepEqual(autoUpdater.quitAndInstallArgs, [false, true]);
  });
});

test('downloadUpdate does not install after download by default', async () => {
  await withUpdateService(async ({ service, autoUpdater }) => {
    autoUpdater.disableDifferentialDownload = true;

    const result = await service.downloadUpdate();
    autoUpdater.emit('update-downloaded', { version: '2.0.0' });

    assert.equal(result.success, true);
    assert.equal(autoUpdater.quitAndInstallArgs, undefined);
  });
});

test('downloadUpdate can install with visible progress after download when explicitly requested', async () => {
  await withUpdateService(async ({ service, autoUpdater }) => {
    autoUpdater.disableDifferentialDownload = true;

    const result = await service.downloadUpdate({ installAfterDownload: true });
    autoUpdater.emit('update-downloaded', { version: '2.0.0' });

    assert.equal(result.success, true);
    assert.deepEqual(autoUpdater.quitAndInstallArgs, [false, true]);
  });
});

test('downloadSpecificVersion verifies a GitHub asset digest before allowing install', async () => {
  await withUpdateService(async ({ service }) => {
    const payload = Buffer.from('installer payload');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const asset = {
      name: 'Minecraft-Core-Setup-9.9.9.exe',
      size: payload.length,
      browser_download_url: 'https://example.test/installer.exe',
      digest: `sha256:${checksum}`
    };

    service.checkForSpecificVersion = async () => ({
      success: true,
      needsUpdate: true,
      releaseInfo: makeReleaseInfo(asset)
    });
    service.downloadFileWithProgress = async (_url, filePath) => {
      await fsp.writeFile(filePath, payload);
      return { success: true, filePath };
    };

    const result = await service.downloadSpecificVersion('9.9.9');

    assert.equal(result.success, true);
    assert.equal(result.checksumVerified, true);
    assert.equal(result.checksumAlgorithm, 'sha256');

    const validation = await service.validateSpecificVersionInstaller(result.filePath);
    assert.equal(validation.success, true);
    assert.equal(validation.checksumVerified, true);
  });
});

test('stageSpecificVersionInstallTest records a local dev installer for normal validation', async () => {
  await withUpdateService(async ({ service, tempRoot }) => {
    const sourceDir = path.join(tempRoot, 'source');
    const sourceInstaller = path.join(sourceDir, 'Minecraft-Core-Setup-9.9.9.exe');
    const payload = Buffer.from('local installer payload for update install test');

    await fsp.mkdir(sourceDir, { recursive: true });
    await fsp.writeFile(sourceInstaller, payload);

    const result = await service.stageSpecificVersionInstallTest({
      sourceInstallerPath: sourceInstaller,
      targetVersion: '9.9.9',
      clientVersion: '1.0.0'
    });

    assert.equal(result.success, true);
    assert.equal(result.staged, true);
    assert.equal(result.testMode, true);
    assert.equal(result.version, '9.9.9');
    assert.equal(result.clientVersion, '1.0.0');
    assert.equal(result.serverVersion, '9.9.9');
    assert.equal(path.dirname(result.filePath), service.getSpecificVersionDownloadDir());

    const validation = await service.validateSpecificVersionInstaller(result.filePath);
    assert.equal(validation.success, true);
    assert.equal(validation.checksumVerified, true);
    assert.equal(validation.checksumSource, 'local-dev-update-install-test');
  }, { isPackaged: false });
});

test('installSpecificVersionInstaller runs a verified installer with visible progress and quits the app', async () => {
  await withUpdateService(async ({ service, fakeApp }) => {
    const payload = Buffer.from('installer payload');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const asset = {
      name: 'Minecraft-Core-Setup-9.9.9.exe',
      size: payload.length,
      browser_download_url: 'https://example.test/installer.exe',
      digest: `sha256:${checksum}`
    };
    const spawned = [];

    service.checkForSpecificVersion = async () => ({
      success: true,
      needsUpdate: true,
      releaseInfo: makeReleaseInfo(asset)
    });
    service.downloadFileWithProgress = async (_url, filePath) => {
      await fsp.writeFile(filePath, payload);
      return { success: true, filePath };
    };
    service.spawnSpecificVersionInstaller = (installerPath, args) => {
      spawned.push({ installerPath, args });
    };

    const downloadResult = await service.downloadSpecificVersion('9.9.9');
    const installResult = await service.installSpecificVersionInstaller(downloadResult.filePath);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(installResult.success, true);
    assert.equal(installResult.silent, false);
    assert.equal(fakeApp.quitCalled, true);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, ['--updated', '--force-run']);
  });
});

test('downloadSpecificVersion can install with visible progress immediately after verified download', async () => {
  await withUpdateService(async ({ service, fakeApp }) => {
    const payload = Buffer.from('installer payload');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const asset = {
      name: 'Minecraft-Core-Setup-9.9.9.exe',
      size: payload.length,
      browser_download_url: 'https://example.test/installer.exe',
      digest: `sha256:${checksum}`
    };
    const spawned = [];

    service.checkForSpecificVersion = async () => ({
      success: true,
      needsUpdate: true,
      releaseInfo: makeReleaseInfo(asset)
    });
    service.downloadFileWithProgress = async (_url, filePath) => {
      await fsp.writeFile(filePath, payload);
      return { success: true, filePath };
    };
    service.spawnSpecificVersionInstaller = (installerPath, args) => {
      spawned.push({ installerPath, args });
    };

    const result = await service.downloadSpecificVersion('9.9.9', { installAfterDownload: true });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(result.success, true);
    assert.equal(result.installStarted, true);
    assert.equal(fakeApp.quitCalled, true);
    assert.deepEqual(spawned[0].args, ['--updated', '--force-run']);
  });
});

test('downloadSpecificVersion does not auto-install by default', async () => {
  await withUpdateService(async ({ service, fakeApp }) => {
    const payload = Buffer.from('installer payload');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const asset = {
      name: 'Minecraft-Core-Setup-9.9.9.exe',
      size: payload.length,
      browser_download_url: 'https://example.test/installer.exe',
      digest: `sha256:${checksum}`
    };
    const spawned = [];

    service.checkForSpecificVersion = async () => ({
      success: true,
      needsUpdate: true,
      releaseInfo: makeReleaseInfo(asset)
    });
    service.downloadFileWithProgress = async (_url, filePath) => {
      await fsp.writeFile(filePath, payload);
      return { success: true, filePath };
    };
    service.spawnSpecificVersionInstaller = (installerPath, args) => {
      spawned.push({ installerPath, args });
    };

    const result = await service.downloadSpecificVersion('9.9.9');

    assert.equal(result.success, true);
    assert.equal(result.installStarted, false);
    assert.equal(fakeApp.quitCalled, false);
    assert.equal(spawned.length, 0);
  });
});

test('server version download button does not opt into immediate install', () => {
  const playTabSource = fs.readFileSync(
    path.resolve(__dirname, '../src/components/client/PlayTab.svelte'),
    'utf8'
  );
  const callIndex = playTabSource.indexOf("'download-specific-version'");

  assert.notEqual(callIndex, -1);
  assert.doesNotMatch(playTabSource.slice(callIndex, callIndex + 400), /installAfterDownload\s*:\s*true/);
});

test('downloadSpecificVersion verifies a latest.yml sha512 when asset digest is missing', async () => {
  const originalFetch = global.fetch;

  try {
    await withUpdateService(async ({ service }) => {
      const payload = Buffer.from('installer payload from latest yml');
      const checksum = crypto.createHash('sha512').update(payload).digest('base64');
      const asset = {
        name: 'Minecraft-Core-Setup-9.9.9.exe',
        size: payload.length,
        browser_download_url: 'https://example.test/installer.exe'
      };
      const latestYmlAsset = {
        name: 'latest.yml',
        browser_download_url: 'https://example.test/latest.yml'
      };

      global.fetch = async () => ({
        ok: true,
        text: async () => [
          'version: 9.9.9',
          'files:',
          `  - url: ${asset.name}`,
          `    sha512: ${checksum}`,
          `    size: ${payload.length}`,
          `path: ${asset.name}`,
          `sha512: ${checksum}`
        ].join('\n')
      });

      service.checkForSpecificVersion = async () => ({
        success: true,
        needsUpdate: true,
        releaseInfo: {
          ...makeReleaseInfo(asset),
          assets: [asset, latestYmlAsset]
        }
      });
      service.downloadFileWithProgress = async (_url, filePath) => {
        await fsp.writeFile(filePath, payload);
        return { success: true, filePath };
      };

      const result = await service.downloadSpecificVersion('9.9.9');

      assert.equal(result.success, true);
      assert.equal(result.checksumVerified, true);
      assert.equal(result.checksumAlgorithm, 'sha512');
      assert.equal(result.checksumSource, 'latest.yml');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('downloadSpecificVersion rejects an installer when no checksum metadata is published', async () => {
  await withUpdateService(async ({ service }) => {
    const payload = Buffer.from('installer payload without checksum metadata');
    const asset = {
      name: 'Minecraft-Core-Setup-9.9.9.exe',
      size: payload.length,
      browser_download_url: 'https://example.test/installer.exe'
    };

    service.checkForSpecificVersion = async () => ({
      success: true,
      needsUpdate: true,
      releaseInfo: makeReleaseInfo(asset)
    });
    service.downloadFileWithProgress = async (_url, filePath) => {
      await fsp.writeFile(filePath, payload);
      return { success: true, filePath };
    };

    const result = await service.downloadSpecificVersion('9.9.9');

    assert.equal(result.success, false);
    assert.equal(result.checksumVerified, false);
    assert.match(result.error, /checksum metadata is required/i);

    const expectedPath = path.join(service.getSpecificVersionDownloadDir(), asset.name);
    assert.equal(fs.existsSync(expectedPath), false);
  });
});

test('downloadSpecificVersion rejects installer asset names that escape the updater folder', async () => {
  await withUpdateService(async ({ service }) => {
    const payload = Buffer.from('installer payload');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const asset = {
      name: '..\\Minecraft-Core-Setup-9.9.9.exe',
      size: payload.length,
      browser_download_url: 'https://example.test/installer.exe',
      digest: `sha256:${checksum}`
    };

    service.checkForSpecificVersion = async () => ({
      success: true,
      needsUpdate: true,
      releaseInfo: makeReleaseInfo(asset)
    });
    service.downloadFileWithProgress = async (_url, filePath) => {
      await fsp.writeFile(filePath, payload);
      return { success: true, filePath };
    };

    const result = await service.downloadSpecificVersion('9.9.9');

    assert.equal(result.success, false);
    assert.match(result.error, /installer asset name/i);
  });
});

test('downloadSpecificVersion rejects and removes an installer with a mismatched digest', async () => {
  await withUpdateService(async ({ service }) => {
    const payload = Buffer.from('installer payload');
    const asset = {
      name: 'Minecraft-Core-Setup-9.9.9.exe',
      size: payload.length,
      browser_download_url: 'https://example.test/installer.exe',
      digest: `sha256:${'0'.repeat(64)}`
    };

    service.checkForSpecificVersion = async () => ({
      success: true,
      needsUpdate: true,
      releaseInfo: makeReleaseInfo(asset)
    });
    service.downloadFileWithProgress = async (_url, filePath) => {
      await fsp.writeFile(filePath, payload);
      return { success: true, filePath };
    };

    const result = await service.downloadSpecificVersion('9.9.9');

    assert.equal(result.success, false);
    assert.match(result.error, /checksum/i);

    const expectedPath = path.join(service.getSpecificVersionDownloadDir(), asset.name);
    assert.equal(fs.existsSync(expectedPath), false);
  });
});

test('validateSpecificVersionInstaller rejects a verified installer changed after download', async () => {
  await withUpdateService(async ({ service }) => {
    const payload = Buffer.from('installer payload');
    const checksum = crypto.createHash('sha256').update(payload).digest('hex');
    const asset = {
      name: 'Minecraft-Core-Setup-9.9.9.exe',
      size: payload.length,
      browser_download_url: 'https://example.test/installer.exe',
      digest: `sha256:${checksum}`
    };

    service.checkForSpecificVersion = async () => ({
      success: true,
      needsUpdate: true,
      releaseInfo: makeReleaseInfo(asset)
    });
    service.downloadFileWithProgress = async (_url, filePath) => {
      await fsp.writeFile(filePath, payload);
      return { success: true, filePath };
    };

    const result = await service.downloadSpecificVersion('9.9.9');
    await fsp.writeFile(result.filePath, 'changed payload with the same path');

    const validation = await service.validateSpecificVersionInstaller(result.filePath);

    assert.equal(validation.success, false);
    assert.match(validation.error, /size changed|checksum changed/i);
  });
});

test('validateSpecificVersionInstaller rejects installer paths not downloaded by the updater', async () => {
  await withUpdateService(async ({ service }) => {
    const downloadDir = service.getSpecificVersionDownloadDir();
    await fsp.mkdir(downloadDir, { recursive: true });
    const arbitraryInstaller = path.join(downloadDir, 'Minecraft-Core-Setup-9.9.9.exe');
    await fsp.writeFile(arbitraryInstaller, 'not from updater');

    const validation = await service.validateSpecificVersionInstaller(arbitraryInstaller);

    assert.equal(validation.success, false);
    assert.match(validation.error, /downloaded by the updater/i);
  });
});

test('install-specific-version refuses paths that fail updater validation', async () => {
  const updateService = new EventEmitter();
  updateService.installSpecificVersionInstaller = async () => ({
    success: false,
    error: 'Installer was not downloaded by the updater'
  });
  const shell = {
    openPathCalled: false,
    async openPath() {
      this.openPathCalled = true;
      return '';
    }
  };

  await withUpdateHandlers(updateService, shell, async (handlers) => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-update-handler-'));
    try {
      const arbitraryInstaller = path.join(tempRoot, 'Minecraft-Core-Setup-9.9.9.exe');
      await fsp.writeFile(arbitraryInstaller, 'not from updater');

      const result = await handlers['install-specific-version']({}, arbitraryInstaller);

      assert.equal(result.success, false);
      assert.match(result.error, /not downloaded by the updater/i);
      assert.equal(shell.openPathCalled, false);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

test('install-specific-version delegates to the progress-visible installer service', async () => {
  let receivedPath = null;
  let receivedOptions = null;
  const updateService = new EventEmitter();
  updateService.installSpecificVersionInstaller = async (filePath, options) => {
    receivedPath = filePath;
    receivedOptions = options;
    return { success: true, silent: false };
  };
  const shell = {
    openPathCalled: false,
    async openPath() {
      this.openPathCalled = true;
      return '';
    }
  };

  await withUpdateHandlers(updateService, shell, async (handlers) => {
    const result = await handlers['install-specific-version']({}, 'C:\\Temp\\Minecraft-Core-Setup-9.9.9.exe');

    assert.equal(result.success, true);
    assert.equal(receivedPath, 'C:\\Temp\\Minecraft-Core-Setup-9.9.9.exe');
    assert.deepEqual(receivedOptions, { silent: false, forceRunAfter: true });
    assert.equal(shell.openPathCalled, false);
  });
});

test('NSIS include keeps update installs progress-only without finish or mode pages', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  const includePath = packageJson.build?.nsis?.include;
  const includeSource = fs.readFileSync(path.resolve(__dirname, '..', includePath), 'utf8');

  assert.equal(includePath, 'build-resources/uninstaller.nsh');
  assert.match(includeSource, /!macro\s+customInstallMode\b/i);
  assert.match(includeSource, /StrCpy\s+\$isForceCurrentInstall\s+"1"/);
  assert.match(includeSource, /StrCpy\s+\$isForceMachineInstall\s+"1"/);
  assert.match(includeSource, /!macro\s+customFinishPage\b/i);
  assert.match(includeSource, /Function\s+MinecraftCoreSkipFinishPageForUpdate/i);
  assert.match(includeSource, /\$\{isUpdated\}[\s\S]*Abort/);
  assert.match(includeSource, /!macro\s+customInstall\b/i);
  assert.match(includeSource, /\$\{StdUtils\.ExecShellAsUser\}/);
  assert.doesNotMatch(includeSource, /!insertmacro\s+StartApp/i);
});

test('install-update refuses to install while a Minecraft server is running', async () => {
  await withUpdateService(async ({ service, autoUpdater }) => {
    await withUpdateHandlers(service, {}, async (handlers) => {
      const result = await handlers['install-update']();

      assert.equal(result.success, false);
      assert.match(result.error, /stop the Minecraft server/i);
      assert.deepEqual(result.runningServers, [{ instanceId: 'server-1', targetPath: null, status: 'running' }]);
      assert.equal(autoUpdater.quitAndInstallCalls, 0);
    });
  }, { serverStates: [{ instanceId: 'server-1', isRunning: true }], quietLog: true });
});

test('install-update returns the update service decision and keeps no install guard of its own', async () => {
  const decision = { success: false, code: 'WORK_IN_PROGRESS', error: 'busy' };
  const updateService = new EventEmitter();
  let requests = 0;
  updateService.requestInstall = () => {
    requests += 1;
    return decision;
  };
  updateService.quitAndInstall = () => assert.fail('the handler must not install around the service guard');

  await withUpdateHandlers(updateService, {}, async (handlers) => {
    assert.equal(await handlers['install-update'](), decision);
    assert.equal(requests, 1);
  });

  const handlerSource = fs.readFileSync(path.resolve(__dirname, '../electron/ipc/update-handlers.cjs'), 'utf8');
  assert.doesNotMatch(handlerSource, /canInstallUpdateNow|getRunningServersForUpdateInstall|server-manager/u);
});

test('check-for-specific-version forwards only the release-lookup switch', async () => {
  const calls = [];
  const updateService = new EventEmitter();
  updateService.checkForSpecificVersion = async (...args) => {
    calls.push(args);
    return { success: true };
  };

  await withUpdateHandlers(updateService, {}, async (handlers) => {
    await handlers['check-for-specific-version']({}, '26.6.1');
    await handlers['check-for-specific-version']({}, '26.6.1', { lookupRelease: false, installAfterDownload: true });
    await handlers['check-for-specific-version']({}, '26.6.1', 'not-an-options-object');
  });

  assert.deepEqual(calls, [
    ['26.6.1', { lookupRelease: true }],
    ['26.6.1', { lookupRelease: false }],
    ['26.6.1', { lookupRelease: true }]
  ]);
});

test('updater IPC cannot start periodic checks when the startup policy disables the updater', async () => {
  const updateService = new EventEmitter();
  let starts = 0;
  updateService.startPeriodicChecks = () => { starts += 1; return { success: true }; };

  await withUpdateHandlers(updateService, {}, async handlers => {
    const result = await handlers['start-periodic-checks']();
    assert.deepEqual(result, { success: false, disabled: true, error: 'Automatic update checks are disabled' });
    assert.equal(starts, 0);
  }, { updatePolicy: { updaterEnabled: false } });
});

test('updater IPC preserves periodic checks in normal production policy', async () => {
  const updateService = new EventEmitter();
  let starts = 0;
  updateService.startPeriodicChecks = () => { starts += 1; return { success: true }; };

  await withUpdateHandlers(updateService, {}, async handlers => {
    assert.deepEqual(await handlers['start-periodic-checks'](), { success: true });
    assert.equal(starts, 1);
  }, { updatePolicy: { updaterEnabled: true } });
});

// A9: the installer kills the app seconds after it starts, so no install may
// begin while Minecraft Core is still finishing a change.
const ACTIVE_WORK_MESSAGE = 'Minecraft Core is still finishing a change (modpack install/update/repair or a server change). Wait for it to finish, then install the update.';
const NOT_INSTALLED_MESSAGE = 'This copy of Minecraft Core is not the installed app, so it cannot install updates. Install updates from the installed Minecraft Core, or download the installer from GitHub.';

// What the activity probe (startup.listActiveWork) reports for each kind of work.
const ACTIVE_WORK_REPORTS = [
  ['an active modpack operation', () => Object.freeze(['job-modpack-install-1'])],
  ['a coordinator exclusive holder', () => [{ operationId: 'op-coordinator-exclusive', kind: 'mutation' }]],
  ['a client-pack exclusive guard holder', () => new Set(['client-pack-recover-7'])]
];

for (const [label, probe] of ACTIVE_WORK_REPORTS) {
  test(`with no server running, ${label} blocks install-update, install-specific-version and auto-install`, async () => {
    await withUpdateService(async ({ service, autoUpdater, fakeApp, updateModule }) => {
      const spawned = [];
      service.spawnSpecificVersionInstaller = (installerPath, args) => { spawned.push({ installerPath, args }); };
      const installerPath = await recordDownloadedInstaller(service, '9.9.9');
      const updateErrors = [];
      service.on('update-error', error => updateErrors.push(error));
      updateModule.setInstallActivityProbe(probe);

      await withUpdateHandlers(service, {}, async (handlers) => {
        const install = await handlers['install-update']();
        assert.equal(install.success, false);
        assert.equal(install.code, 'WORK_IN_PROGRESS');
        assert.equal(install.error, ACTIVE_WORK_MESSAGE);
        assert.equal(install.activeOperations.length, 1);

        const specific = await handlers['install-specific-version']({}, installerPath);
        assert.equal(specific.success, false);
        assert.equal(specific.error, ACTIVE_WORK_MESSAGE);
      });

      autoUpdater.disableDifferentialDownload = true;
      assert.equal((await service.downloadUpdate({ installAfterDownload: true })).success, true);
      autoUpdater.emit('update-downloaded', { version: '9.9.9' });
      assert.equal(updateErrors.length, 1);
      assert.equal(updateErrors[0].message, ACTIVE_WORK_MESSAGE);

      await new Promise(resolve => setImmediate(resolve));
      assert.equal(autoUpdater.quitAndInstallCalls, 0);
      assert.deepEqual(spawned, []);
      assert.equal(fakeApp.quitCalled, false);

      // The refusals came from the reported work: once it ends, the same install runs.
      updateModule.setInstallActivityProbe(() => []);
      assert.equal((await service.installSpecificVersionInstaller(installerPath)).success, true);
      assert.equal(spawned.length, 1);
    }, { quietLog: true });
  });
}

test('a failing activity probe never blocks an update install, and the failure is logged', async () => {
  await withUpdateService(async ({ service, autoUpdater, updateModule }) => {
    const warnings = [];
    service.on('update-log', entry => {
      if (entry.level === 'warn') warnings.push(entry.message);
    });
    const brokenProbes = [
      () => { throw new Error('PROBE_FAILED'); },
      () => Promise.resolve(['job-1']),
      () => 42
    ];

    for (const brokenProbe of brokenProbes) {
      updateModule.setInstallActivityProbe(brokenProbe);
      assert.equal(service.requestInstall().success, true);
    }

    assert.equal(autoUpdater.quitAndInstallCalls, brokenProbes.length);
    assert.equal(warnings.filter(message => /activity check failed/i.test(message)).length, brokenProbes.length);
  }, { quietLog: true });
});

test('setInstallActivityProbe accepts a function, or null to clear it', async () => {
  await withUpdateService(async ({ service, updateModule }) => {
    for (const invalid of [undefined, 'probe', {}, ['job-1']]) {
      assert.throws(() => updateModule.setInstallActivityProbe(invalid), TypeError);
    }
    updateModule.setInstallActivityProbe(() => ['job-1']);
    assert.equal(service.canInstallUpdatesNow().code, 'WORK_IN_PROGRESS');
    updateModule.setInstallActivityProbe(null);
    assert.deepEqual(service.canInstallUpdatesNow(), { success: true });
  }, { quietLog: true });
});

test('the install guard checks the installed copy first, then running servers, then in-flight work', async () => {
  await withUpdateService(async ({ service, updateModule }) => {
    updateModule.setInstallActivityProbe(() => ['job-1']);
    const result = service.canInstallUpdatesNow();
    assert.equal(result.code, 'NOT_INSTALLED_COPY');
    assert.equal(result.error, NOT_INSTALLED_MESSAGE);
  }, { installIdentity: NOT_INSTALLED_IDENTITY, serverStates: [{ instanceId: 'server-1', isRunning: true }], quietLog: true });

  await withUpdateService(async ({ service, updateModule }) => {
    let probes = 0;
    updateModule.setInstallActivityProbe(() => {
      probes += 1;
      return ['job-1'];
    });
    const result = service.canInstallUpdatesNow();
    assert.equal(result.success, false);
    assert.match(result.error, /stop the Minecraft server/i);
    assert.equal(probes, 0);
  }, { serverStates: [{ instanceId: 'server-1', isRunning: true }], quietLog: true });
});

// A60: only the NSIS-installed copy may install. A QA, portable or development
// copy would otherwise run the installer over the real installation.
test('a packaged copy that is not the installed app cannot install, download or launch an installer', async () => {
  await withUpdateService(async ({ service, autoUpdater, fakeApp, fetchCalls }) => {
    const spawned = [];
    service.spawnSpecificVersionInstaller = (installerPath, args) => { spawned.push({ installerPath, args }); };
    let specificChecks = 0;
    service.checkForSpecificVersion = async () => {
      specificChecks += 1;
      return { success: true, needsUpdate: true, releaseInfo: makeReleaseInfo({ name: 'Minecraft-Core-Setup-9.9.9.exe' }) };
    };
    const installerPath = await recordDownloadedInstaller(service, '9.9.9');
    const updateErrors = [];
    service.on('update-error', error => updateErrors.push(error));

    assert.deepEqual(service.getInstallCapability(), {
      allowed: false,
      installed: false,
      reason: 'not-installed-copy',
      message: NOT_INSTALLED_MESSAGE
    });

    const quit = service.quitAndInstall();
    assert.equal(quit.success, false);
    assert.equal(quit.error, NOT_INSTALLED_MESSAGE);

    await withUpdateHandlers(service, {}, async (handlers) => {
      const install = await handlers['install-update']();
      assert.equal(install.success, false);
      assert.equal(install.code, 'NOT_INSTALLED_COPY');
      assert.equal(install.error, NOT_INSTALLED_MESSAGE);

      const specificInstall = await handlers['install-specific-version']({}, installerPath);
      assert.equal(specificInstall.success, false);
      assert.equal(specificInstall.error, NOT_INSTALLED_MESSAGE);
    });

    autoUpdater.disableDifferentialDownload = true;
    const download = await service.downloadUpdate({ installAfterDownload: true });
    assert.equal(download.success, false);
    assert.equal(download.error, NOT_INSTALLED_MESSAGE);
    assert.equal(autoUpdater.downloadUpdateCalls, 0);

    const specificDownload = await service.downloadSpecificVersion('9.9.9', { installAfterDownload: true });
    assert.equal(specificDownload.success, false);
    assert.equal(specificDownload.error, NOT_INSTALLED_MESSAGE);
    assert.equal(specificChecks, 0);

    service.setAutoInstall(true);
    autoUpdater.emit('update-downloaded', { version: '9.9.9' });
    assert.equal(updateErrors.length, 1);
    assert.equal(updateErrors[0].message, NOT_INSTALLED_MESSAGE);

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(autoUpdater.quitAndInstallCalls, 0);
    assert.deepEqual(spawned, []);
    assert.equal(fakeApp.quitCalled, false);
    assert.deepEqual(fetchCalls, []);
  }, { installIdentity: NOT_INSTALLED_IDENTITY, quietLog: true });
});

test('the installed copy reports that it may install updates', async () => {
  await withUpdateService(async ({ service }) => {
    assert.deepEqual(service.getInstallCapability(), {
      allowed: true,
      installed: true,
      reason: 'uninstaller-present',
      message: null
    });
  }, { quietLog: true });
});

test('FORCE_UPDATES lets a copy that is not installed download updates but never install them', async () => {
  const previous = process.env.FORCE_UPDATES;
  process.env.FORCE_UPDATES = 'true';
  try {
    await withUpdateService(async ({ service, autoUpdater, fakeApp }) => {
      const spawned = [];
      service.spawnSpecificVersionInstaller = (installerPath, args) => { spawned.push({ installerPath, args }); };
      const payload = Buffer.from('installer payload');
      const asset = {
        name: 'Minecraft-Core-Setup-9.9.9.exe',
        size: payload.length,
        browser_download_url: 'https://example.test/installer.exe',
        digest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`
      };
      service.checkForSpecificVersion = async () => ({ success: true, needsUpdate: true, releaseInfo: makeReleaseInfo(asset) });
      service.downloadFileWithProgress = async (_url, filePath) => {
        await fsp.writeFile(filePath, payload);
        return { success: true, filePath };
      };

      autoUpdater.disableDifferentialDownload = true;
      assert.equal((await service.downloadUpdate({ installAfterDownload: true })).success, true);
      assert.equal(autoUpdater.downloadUpdateCalls, 1);
      autoUpdater.emit('update-downloaded', { version: '9.9.9' });

      const specific = await service.downloadSpecificVersion('9.9.9', { installAfterDownload: true });
      assert.equal(specific.success, false);
      assert.equal(specific.downloadComplete, true);
      assert.equal(specific.installStarted, false);
      assert.equal(specific.error, NOT_INSTALLED_MESSAGE);

      await new Promise(resolve => setImmediate(resolve));
      assert.equal(autoUpdater.quitAndInstallCalls, 0);
      assert.deepEqual(spawned, []);
      assert.equal(fakeApp.quitCalled, false);
    }, {
      isPackaged: false,
      installIdentity: { installed: false, reason: 'unpackaged', platform: 'win32', isPackaged: false },
      quietLog: true
    });
  } finally {
    if (previous === undefined) delete process.env.FORCE_UPDATES;
    else process.env.FORCE_UPDATES = previous;
  }
});

function withProcessOverrides({ env = {}, argv = [] }, fn) {
  const keys = ['FORCE_UPDATES', 'NODE_ENV'];
  const previousEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const previousArgv = process.argv;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(env, key)) process.env[key] = env[key];
    else delete process.env[key];
  }
  process.argv = [...previousArgv, ...argv];
  return Promise.resolve().then(fn).finally(() => {
    process.argv = previousArgv;
    for (const key of keys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });
}

test('isDevelopmentMode: packaged builds are production, and source runs need an explicit opt-in', async () => {
  const cases = [
    { name: 'packaged with NODE_ENV=development', isPackaged: true, env: { NODE_ENV: 'development' }, devConfig: { enableDevUpdates: false }, expected: false },
    { name: 'packaged with --dev', isPackaged: true, argv: ['--dev'], devConfig: { enableDevUpdates: false }, expected: false },
    { name: 'packaged', isPackaged: true, devConfig: { enableDevUpdates: false }, expected: false },
    { name: 'packaged with the opt-in', isPackaged: true, devConfig: { enableDevUpdates: true }, expected: false },
    { name: 'source run with the shipped config', isPackaged: false, expected: true },
    { name: 'source run with NODE_ENV=production', isPackaged: false, env: { NODE_ENV: 'production' }, devConfig: { enableDevUpdates: false }, expected: true },
    { name: 'source run with the opt-in', isPackaged: false, devConfig: { enableDevUpdates: true }, expected: false },
    { name: 'source run with FORCE_UPDATES', isPackaged: false, env: { FORCE_UPDATES: 'true' }, devConfig: { enableDevUpdates: false }, expected: false }
  ];

  for (const testCase of cases) {
    await withProcessOverrides(testCase, () => withUpdateService(async ({ service, updateModule }) => {
      assert.equal(updateModule.UpdateService.prototype.isDevelopmentMode.call(service), testCase.expected, testCase.name);
    }, { isPackaged: testCase.isPackaged, devConfig: testCase.devConfig, quietLog: true }));
  }
});

test('the shipped dev config keeps source runs off the live updater', () => {
  assert.equal(require('../config/dev-config.cjs').enableDevUpdates, false);
});

// A6: a friend newer than the host may switch to the host's older version only
// when this PC has no modpack data that the older version cannot read.
const DOWNGRADE_REFUSED_MESSAGE = 'The host is on Minecraft Core 26.6.1, older than yours (26.11.1), and this PC has modpack data that version cannot read safely. Ask the host to update instead.';

function githubReleases(...releases) {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => releases.map(release => (typeof release === 'string'
      ? { name: `v${release}`, tag_name: `v${release}`, published_at: '2026-06-01T00:00:00.000Z', body: '', assets: [] }
      : release))
  });
}

// A profile as v26.6.1 leaves it, after a first start of the new version: a
// plain server and a paired client, and the empty modpack folders.
async function seedPlainProfile({ tempRoot, userDataPath, storeValues }) {
  const serverPath = path.join(tempRoot, 'instances', 'Survival');
  const clientPath = path.join(tempRoot, 'instances', 'Friend Client');
  await fsp.mkdir(path.join(serverPath, 'world'), { recursive: true });
  await fsp.writeFile(path.join(serverPath, 'server.properties'), 'server-port=25565\n');
  await fsp.writeFile(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({ version: '1.21.1', loader: 'fabric', contentRevision: 3 }));
  await fsp.mkdir(path.join(serverPath, '.minecraft-core-state'), { recursive: true });
  await fsp.writeFile(path.join(serverPath, '.minecraft-core-state', 'runtime.json'), '{}');
  await fsp.mkdir(path.join(clientPath, 'minecraft-core-state'), { recursive: true });
  await fsp.writeFile(path.join(clientPath, 'minecraft-core-state', 'expected-mods.json'), '[]');
  for (const directory of [['modpack-lifecycle', 'active'], ['modpack-lifecycle', 'history'], ['client-packs', 'transactions']]) {
    await fsp.mkdir(path.join(userDataPath, ...directory), { recursive: true });
  }
  storeValues.instances = [
    { id: 'server-1', name: 'Survival', type: 'server', path: serverPath },
    { id: 'client-1', name: 'Friend Client', type: 'client', path: clientPath }
  ];
  return { serverPath, clientPath };
}

const MODPACK_DATA_CASES = [
  ['an active modpack lifecycle record', async ({ userDataPath }) => {
    await fsp.writeFile(path.join(userDataPath, 'modpack-lifecycle', 'active', 'op-1.json'), '{}');
  }],
  ['a modpack lifecycle history record', async ({ userDataPath }) => {
    await fsp.writeFile(path.join(userDataPath, 'modpack-lifecycle', 'history', 'op-1.json'), '{}');
  }],
  ['a client-pack journal', async ({ userDataPath }) => {
    await fsp.writeFile(path.join(userDataPath, 'client-packs', 'transactions', 'client-1.json'), '{}');
  }],
  ['a server with modpack state', async ({ serverPath }) => {
    await fsp.writeFile(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{}');
  }],
  ['a server with modpack history', async ({ serverPath }) => {
    await fsp.mkdir(path.join(serverPath, '.minecraft-core-state', 'history'));
  }],
  ['a client with a matching-pack manifest', async ({ clientPath }) => {
    await fsp.writeFile(path.join(clientPath, '.minecraft-core-client-pack.json'), '{}');
  }],
  ['a registered folder that is missing', async ({ clientPath }) => {
    await fsp.rm(clientPath, { recursive: true, force: true });
  }],
  ['a lifecycle folder that cannot be listed', async ({ userDataPath }) => {
    await fsp.rm(path.join(userDataPath, 'modpack-lifecycle', 'active'), { recursive: true, force: true });
    await fsp.writeFile(path.join(userDataPath, 'modpack-lifecycle', 'active'), 'not a directory');
  }],
  ['an instance list that cannot be read', async ({ storeValues }) => {
    storeValues.instances = null;
  }]
];

function downgradeFields(result) {
  return {
    success: result.success,
    needsUpdate: result.needsUpdate,
    olderThanCurrent: result.olderThanCurrent,
    code: result.code,
    error: result.error
  };
}

test('checkForSpecificVersion offers an older host version with a warning on a PC without modpack data', async () => {
  await withUpdateService(async (context) => {
    const { service, fetchCalls } = context;
    // A fresh profile has no modpack folders at all.
    const fresh = await service.checkForSpecificVersion('26.6.1', { lookupRelease: false });
    assert.equal(fresh.isDowngrade, true);
    assert.deepEqual(fetchCalls, []);

    await seedPlainProfile(context);
    const result = await service.checkForSpecificVersion('26.6.1');
    assert.equal(result.success, true);
    assert.equal(result.needsUpdate, true);
    assert.equal(result.isDowngrade, true);
    assert.match(result.warning, /Minecraft Core 26\.6\.1 is older than this copy \(26\.11\.1\)/u);
    assert.equal(result.releaseInfo.tag_name, 'v26.6.1');
    assert.equal(fetchCalls.length, 1);

    // The Play tab asks the same question without the GitHub lookup.
    const offer = await service.checkForSpecificVersion('26.6.1', { lookupRelease: false });
    assert.equal(offer.success, true);
    assert.equal(offer.needsUpdate, true);
    assert.equal(offer.isDowngrade, true);
    assert.equal(offer.warning, result.warning);
    assert.equal(offer.releaseInfo, undefined);
    assert.equal(fetchCalls.length, 1);
  }, { currentVersion: '26.11.1', fetch: githubReleases('26.6.1', '26.12.0'), quietLog: true });
});

test('an older host version is refused without any network lookup when this PC has modpack data', async () => {
  for (const [label, seed] of MODPACK_DATA_CASES) {
    await withUpdateService(async (context) => {
      const folders = await seedPlainProfile(context);
      await seed({ ...context, ...folders });

      for (const options of [undefined, { lookupRelease: false }]) {
        const result = await context.service.checkForSpecificVersion('26.6.1', options);
        assert.deepEqual(downgradeFields(result), {
          success: false,
          needsUpdate: false,
          olderThanCurrent: true,
          code: 'DOWNGRADE_REFUSED',
          error: DOWNGRADE_REFUSED_MESSAGE
        }, label);
      }
      assert.deepEqual(context.fetchCalls, [], label);
    }, { currentVersion: '26.11.1', fetch: githubReleases('26.6.1'), quietLog: true });
  }
});

test('a newer host version is still offered as an update, even with modpack data', async () => {
  await withUpdateService(async (context) => {
    const { serverPath } = await seedPlainProfile(context);
    await fsp.writeFile(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{}');

    const result = await context.service.checkForSpecificVersion('26.12.0');
    assert.equal(result.success, true);
    assert.equal(result.needsUpdate, true);
    assert.equal(result.isDowngrade, undefined);
    assert.equal(result.releaseInfo.tag_name, 'v26.12.0');
    assert.equal(context.fetchCalls.length, 1);
  }, { currentVersion: '26.11.1', fetch: githubReleases('26.6.1', '26.12.0'), quietLog: true });
});

test('a version that cannot be compared is refused before any lookup, and the same version needs nothing', async () => {
  await withUpdateService(async ({ service, fetchCalls }) => {
    for (const target of ['v26.6.1', '26.6', '26.06.1', '', null]) {
      const result = await service.checkForSpecificVersion(target);
      assert.equal(result.success, false, String(target));
      assert.equal(result.needsUpdate, false, String(target));
      assert.equal(result.code, 'VERSION_UNCOMPARABLE', String(target));
    }

    const same = await service.checkForSpecificVersion('26.11.1');
    assert.equal(same.success, true);
    assert.equal(same.needsUpdate, false);
    assert.deepEqual(fetchCalls, []);
  }, { currentVersion: '26.11.1', fetch: githubReleases('26.6.1'), quietLog: true });
});

test('downloadSpecificVersion inherits the downgrade refusal and downloads nothing', async () => {
  await withUpdateService(async (context) => {
    const { serverPath } = await seedPlainProfile(context);
    await fsp.writeFile(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{}');
    let downloads = 0;
    context.service.downloadFileWithProgress = async () => {
      downloads += 1;
      return { success: false, error: 'must not download' };
    };

    const result = await context.service.downloadSpecificVersion('26.6.1', { installAfterDownload: true });
    assert.equal(result.success, false);
    assert.equal(result.code, 'DOWNGRADE_REFUSED');
    assert.equal(result.olderThanCurrent, true);
    assert.equal(result.error, DOWNGRADE_REFUSED_MESSAGE);
    assert.equal(downloads, 0);
    assert.deepEqual(context.fetchCalls, []);
  }, { currentVersion: '26.11.1', fetch: githubReleases('26.6.1'), quietLog: true });
});

test('installSpecificVersionInstaller re-checks the guard and refuses an older installer once modpack data exists', async () => {
  await withUpdateService(async (context) => {
    const { service, userDataPath, fakeApp } = context;
    await seedPlainProfile(context);
    const spawned = [];
    service.spawnSpecificVersionInstaller = (installerPath, args) => { spawned.push({ installerPath, args }); };
    const installerPath = await recordDownloadedInstaller(service, '26.6.1');
    const record = path.join(userDataPath, 'modpack-lifecycle', 'active', 'op-1.json');
    await fsp.writeFile(record, '{}');

    const refused = await service.installSpecificVersionInstaller(installerPath);
    assert.equal(refused.success, false);
    assert.equal(refused.code, 'DOWNGRADE_REFUSED');
    assert.equal(refused.error, DOWNGRADE_REFUSED_MESSAGE);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(spawned, []);
    assert.equal(fakeApp.quitCalled, false);

    // Without modpack data the same older installer may run.
    await fsp.rm(record);
    assert.equal((await service.installSpecificVersionInstaller(installerPath)).success, true);
    assert.equal(spawned.length, 1);
  }, { currentVersion: '26.11.1', quietLog: true });
});

test('a friend without modpack data can still switch to the host version end to end', async () => {
  const payload = Buffer.from('installer payload 26.6.1');
  const asset = {
    name: 'Minecraft-Core-Setup-26.6.1.exe',
    size: payload.length,
    browser_download_url: 'https://example.test/Minecraft-Core-Setup-26.6.1.exe',
    digest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`
  };

  await withUpdateService(async (context) => {
    const { service, fakeApp } = context;
    await seedPlainProfile(context);
    const spawned = [];
    service.spawnSpecificVersionInstaller = (installerPath, args) => { spawned.push({ installerPath, args }); };
    service.downloadFileWithProgress = async (_url, filePath) => {
      await fsp.writeFile(filePath, payload);
      return { success: true, filePath };
    };

    const downloaded = await service.downloadSpecificVersion('26.6.1');
    assert.equal(downloaded.success, true);
    assert.equal(downloaded.checksumVerified, true);

    const installed = await service.installSpecificVersionInstaller(downloaded.filePath);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(installed.success, true);
    assert.deepEqual(spawned.map(entry => entry.args), [['--updated', '--force-run']]);
    assert.equal(fakeApp.quitCalled, true);
  }, {
    currentVersion: '26.11.1',
    fetch: githubReleases({ name: 'v26.6.1', tag_name: 'v26.6.1', published_at: '2026-06-01T00:00:00.000Z', body: '', assets: [asset] }),
    quietLog: true
  });
});
