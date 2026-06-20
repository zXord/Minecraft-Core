const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function withUpdateService(fn, options = {}) {
  const modulePath = path.resolve(__dirname, '../electron/services/update-service.cjs');
  const originalLoad = Module._load;
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-update-hardening-'));

  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = async () => {};
  autoUpdater.downloadUpdate = async () => {};
  autoUpdater.quitAndInstall = (...args) => {
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
      if (name === 'temp') return tempRoot;
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
      return { get() { return null; }, set() {}, delete() {} };
    }

    if (request === './server-manager.cjs' || request.endsWith('server-manager.cjs')) {
      return {
        getAllServerStates: () => options.serverStates || [],
        getServerState: () => options.serverState || { isRunning: false }
      };
    }

    if (request === 'electron-log') {
      return console;
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const { UpdateService } = require(modulePath);
    const service = new UpdateService();
    service.isDevelopmentMode = () => false;
    service.getCurrentVersion = () => '1.0.0';
    return await fn({ service, tempRoot, autoUpdater, fakeApp });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

async function withUpdateHandlers(updateService, shell, fn, options = {}) {
  const modulePath = path.resolve(__dirname, '../electron/ipc/update-handlers.cjs');
  const originalLoad = Module._load;

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === '../services/update-service.cjs' || request.endsWith('services/update-service.cjs')) {
      return { getUpdateService: () => updateService };
    }

    if (request === 'electron') {
      return { shell };
    }

    if (request.endsWith('server-manager.cjs')) {
      return {
        getAllServerStates: () => options.serverStates || [],
        getServerState: () => (options.serverState || { isRunning: false })
      };
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
    return await fn(createUpdateHandlers(win));
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
  const updateService = new EventEmitter();
  updateService.quitAndInstallCalled = false;
  updateService.quitAndInstall = () => {
    updateService.quitAndInstallCalled = true;
  };
  const shell = {
    async openPath() {
      return '';
    }
  };

  await withUpdateHandlers(
    updateService,
    shell,
    async (handlers) => {
      const result = await handlers['install-update']();

      assert.equal(result.success, false);
      assert.match(result.error, /stop the Minecraft server/i);
      assert.equal(updateService.quitAndInstallCalled, false);
    },
    { serverStates: [{ instanceId: 'server-1', isRunning: true }] }
  );
});
