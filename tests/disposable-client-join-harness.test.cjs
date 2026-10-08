const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const realHarness = require('./e2e/fixtures/real-modpack-harness.cjs');
const {
  isDisposableClientJoinEnabled,
  assertDisposablePath,
  configureOfflineServerProperties,
  createDisposableUsername,
  createSyntheticAuthData,
  packSyntheticAuthData,
  writeSyntheticEncryptedAuth,
  registerDisposableClient,
  buildMrpackClientProjection,
  inspectMrpackClientArchive,
  installMrpackClientProjection,
  installExactModrinthClientPack,
  verifyInstalledClientPack,
  launchDisposableClient,
  finalizeDisposableClientJoin,
  captureLatestLogBoundary,
  waitForJoinLog,
  stopDisposableClient,
  stopDisposableServer
} = require('./e2e/fixtures/disposable-client-join-harness.cjs');

async function createDirectoryRedirect(targetPath, redirectPath) {
  await fs.symlink(targetPath, redirectPath, process.platform === 'win32' ? 'junction' : 'dir');
}

const REQUIRED_CLIENT_SHA1 = '15c04db8c6cff34fb05aca8efd573fdeca00cf63';
const REQUIRED_CLIENT_SHA512 = 'c5ada8246343f5a91823b31fbacf80ca30bb021a44d557245189f0c707c3658f294210004de8f0166b8ab423871d6d7b13e8e840c91b6289a9d1cfb0ba99ac81';
const OPTIONAL_CLIENT_SHA1 = '4d7bfeb914e8f5c03fb3d4217ce514f1e2f0390f';
const OPTIONAL_CLIENT_SHA512 = '385141cbd882854b2a6db9c5d0979bf68cf335edec299584d5aeed7a1f504e197435b0d2427b642b92b7e27ba0c1820396222f37e4c182087a7ecc5f0670619e';
const CLIENT_OVERRIDE_SHA1 = '3aabf8e8b3366312db057354bd361893345bdf1b';
const CLIENT_OVERRIDE_SHA512 = '69477def994338d7cf377876864faa82129e9735b61caac360a52a9e0835e24e1c8d6a1f6980c1bcef70f29b0f5917c301a3093f5b6a5f40809014d7bd4e3644';

function clientManifest() {
  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'immutable-client-fixture',
    name: 'Client projection fixture',
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.10' },
    files: [
      {
        path: 'mods/required.jar',
        hashes: { sha1: REQUIRED_CLIENT_SHA1, sha512: REQUIRED_CLIENT_SHA512 },
        env: { client: 'required', server: 'required' },
        downloads: ['https://cdn.modrinth.com/data/a/versions/b/required.jar'],
        fileSize: 21
      },
      {
        path: 'mods/optional.jar',
        hashes: { sha1: OPTIONAL_CLIENT_SHA1, sha512: OPTIONAL_CLIENT_SHA512 },
        env: { client: 'optional', server: 'unsupported' },
        downloads: ['https://cdn.modrinth.com/data/a/versions/b/optional.jar'],
        fileSize: 21
      },
      {
        path: 'mods/server-only.jar',
        hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
        env: { client: 'unsupported', server: 'required' },
        downloads: ['https://cdn.modrinth.com/data/a/versions/b/server-only.jar'],
        fileSize: 7
      }
    ]
  };
}

function clientArchiveEntries() {
  return [
    { path: 'modrinth.index.json', type: 'file', size: 1 },
    { path: 'overrides/config/shared.txt', type: 'file', size: 15 },
    { path: 'client-overrides/config/shared.txt', type: 'file', size: 15 },
    { path: 'server-overrides/server.properties', type: 'file', size: 20 }
  ];
}

function clientMrpackBuffer() {
  const archive = new AdmZip();
  archive.addFile('modrinth.index.json', Buffer.from(JSON.stringify(clientManifest())));
  archive.addFile('overrides/config/shared.txt', Buffer.from('common-override'));
  archive.addFile('client-overrides/config/shared.txt', Buffer.from('client-override'));
  archive.addFile('server-overrides/server.properties', Buffer.from('online-mode=true\n'));
  return archive.toBuffer();
}

test('disposable client join is opt-in and confines writable paths to its fresh root', async () => {
  assert.equal(isDisposableClientJoinEnabled({}), false);
  assert.equal(isDisposableClientJoinEnabled({ MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E: '1' }), true);
  assert.equal(isDisposableClientJoinEnabled({ MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E: 'true' }), true);
  assert.equal(isDisposableClientJoinEnabled({ MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E: 'yes' }), false);

  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-outside-'));
  const redirectPath = path.join(lifecycle.root, 'redirect');
  try {
    assert.equal(assertDisposablePath(lifecycle, lifecycle.clientPath), path.resolve(lifecycle.clientPath));
    assert.throws(
      () => assertDisposablePath(lifecycle, path.join(lifecycle.root, '..', 'not-disposable')),
      /outside the disposable lifecycle root/u
    );
    await createDirectoryRedirect(outsideRoot, redirectPath);
    assert.throws(
      () => assertDisposablePath(lifecycle, path.join(redirectPath, 'escaped.txt')),
      /symbolic link|junction|reparse/iu
    );
  } finally {
    await fs.unlink(redirectPath).catch(() => {});
    await lifecycle.dispose({ preserveRoot: false });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});

test('offline server property preparation preserves unrelated settings and limits writes to the disposable server', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const propertiesPath = path.join(lifecycle.serverPath, 'server.properties');
  try {
    await fs.writeFile(propertiesPath, 'motd=Disposable proof\nonline-mode=true\nmax-players=7\n', 'utf8');
    await configureOfflineServerProperties(lifecycle);
    const properties = await fs.readFile(propertiesPath, 'utf8');
    assert.match(properties, /^motd=Disposable proof$/mu);
    assert.match(properties, /^max-players=7$/mu);
    assert.match(properties, /^online-mode=false$/mu);
    assert.match(properties, /^enforce-secure-profile=false$/mu);
    assert.match(properties, /^server-ip=127\.0\.0\.1$/mu);

    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-outside-'));
    try {
      await assert.rejects(
        configureOfflineServerProperties({ ...lifecycle, serverPath: outsideRoot }),
        /outside the disposable lifecycle root/u
      );
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('offline server property preparation rechecks confinement immediately before writing', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-outside-'));
  const propertiesPath = path.join(lifecycle.serverPath, 'server.properties');
  const outsidePropertiesPath = path.join(outsideRoot, 'server.properties');
  const originalReadFile = fs.readFile;
  let redirected = false;
  try {
    await fs.writeFile(propertiesPath, 'online-mode=true\n', 'utf8');
    fs.readFile = async (...args) => {
      const contents = await originalReadFile(...args);
      if (!redirected && path.resolve(String(args[0])) === path.resolve(propertiesPath)) {
        await fs.rm(lifecycle.serverPath, { recursive: true, force: true });
        await createDirectoryRedirect(outsideRoot, lifecycle.serverPath);
        redirected = true;
      }
      return contents;
    };

    await assert.rejects(
      configureOfflineServerProperties(lifecycle),
      /symbolic link|junction|reparse/iu
    );
    await assert.rejects(fs.access(outsidePropertiesPath));
  } finally {
    fs.readFile = originalReadFile;
    if (redirected) {
      await fs.unlink(lifecycle.serverPath).catch(() => {});
      await fs.mkdir(lifecycle.serverPath).catch(() => {});
    }
    await lifecycle.dispose({ preserveRoot: false });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});

test('disposable usernames are derived from cryptographic bytes and satisfy Minecraft syntax', () => {
  const requestedSizes = [];
  const username = createDisposableUsername({
    randomBytes(size) {
      requestedSizes.push(size);
      return Buffer.from('001122334455', 'hex');
    }
  });

  assert.deepEqual(requestedSizes, [6]);
  assert.equal(username, 'E2E_001122334455');
  assert.match(username, /^[A-Za-z0-9_]{3,16}$/u);
});

test('synthetic auth uses only disposable values and encrypts every sensitive token field', () => {
  const auth = createSyntheticAuthData({
    username: 'E2EJoiner',
    now: new Date('2026-08-28T00:00:00.000Z')
  });
  const packed = packSyntheticAuthData(auth, value => `cipher(${value})`);

  assert.equal(auth.name, 'E2EJoiner');
  assert.match(auth.access_token, /^disposable-/u);
  assert.equal(auth.xmcl_tokens.microsoft.refresh_token, 'disposable-refresh-token');
  assert.equal(Object.hasOwn(auth, 'microsoft_refresh_token'), false);
  assert.equal(packed.name, 'E2EJoiner');
  assert.equal(packed.access_token, `enc:cipher(${auth.access_token})`);
  assert.equal(packed.client_token, `enc:cipher(${auth.client_token})`);
  assert.equal(packed.xmcl_tokens.microsoft.access_token, `enc:cipher(${auth.xmcl_tokens.microsoft.access_token})`);
  assert.equal(packed.xmcl_tokens.microsoft.refresh_token, `enc:cipher(${auth.xmcl_tokens.microsoft.refresh_token})`);
});

test('synthetic encrypted auth is written only inside the disposable client through safeStorage', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const fakeElectronApp = {
    evaluate: async (callback, payload) => callback({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(`safe:${value}`, 'utf8')
      }
    }, payload)
  };
  try {
    const authPath = await writeSyntheticEncryptedAuth(fakeElectronApp, lifecycle, { username: 'E2EJoiner' });
    assert.equal(authPath, path.join(lifecycle.clientPath, 'xmcl-auth.json'));
    const saved = JSON.parse(await fs.readFile(authPath, 'utf8'));
    assert.equal(saved.name, 'E2EJoiner');
    assert.match(saved.access_token, /^enc:/u);
    assert.match(saved.xmcl_tokens.microsoft.refresh_token, /^enc:/u);
    assert.equal(await fs.readdir(lifecycle.userDataPath).then(entries => entries.includes('xmcl-auth.json')), false);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('synthetic encrypted auth rechecks confinement after safeStorage and immediately before writing', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-outside-'));
  const outsideAuthPath = path.join(outsideRoot, 'xmcl-auth.json');
  let redirected = false;
  const fakeElectronApp = {
    evaluate: async (callback, payload) => {
      await fs.rm(lifecycle.clientPath, { recursive: true, force: true });
      await createDirectoryRedirect(outsideRoot, lifecycle.clientPath);
      redirected = true;
      return callback({
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: value => Buffer.from(`safe:${value}`, 'utf8')
        }
      }, payload);
    }
  };
  try {
    await assert.rejects(
      writeSyntheticEncryptedAuth(fakeElectronApp, lifecycle, { username: 'E2EJoiner' }),
      /symbolic link|junction|reparse/iu
    );
    await assert.rejects(fs.access(outsideAuthPath));
  } finally {
    if (redirected) {
      await fs.unlink(lifecycle.clientPath).catch(() => {});
      await fs.mkdir(lifecycle.clientPath).catch(() => {});
    }
    await lifecycle.dispose({ preserveRoot: false });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});

test('client MRPACK projection includes every client-supported file and applies client overrides after common overrides', () => {
  const projection = buildMrpackClientProjection({
    manifest: clientManifest(),
    archiveEntries: clientArchiveEntries()
  });

  assert.deepEqual(projection.runtime, {
    minecraftVersion: '1.20.1',
    loaderFamily: 'fabric',
    loaderVersion: '0.15.10'
  });
  assert.deepEqual(projection.downloads.map(file => ({ path: file.targetPath, client: file.client })), [
    { path: 'mods/required.jar', client: 'required' },
    { path: 'mods/optional.jar', client: 'optional' }
  ]);
  assert.deepEqual(projection.finalOverrides, [{
    layer: 'client-overrides',
    archivePath: 'client-overrides/config/shared.txt',
    targetPath: 'config/shared.txt',
    size: '15'
  }]);
  assert.equal(projection.overrideOperations.some(operation => operation.layer === 'server-overrides'), false);
});

test('verified MRPACK archive inspection validates its manifest and exposes only exact reviewed entries', async () => {
  const inspected = await inspectMrpackClientArchive(clientMrpackBuffer());
  assert.equal(inspected.manifest.versionId, 'immutable-client-fixture');
  assert.deepEqual(inspected.projection.downloads.map(download => download.targetPath), [
    'mods/required.jar',
    'mods/optional.jar'
  ]);
  assert.equal(
    (await inspected.readArchiveEntry('client-overrides/config/shared.txt')).toString('utf8'),
    'client-override'
  );
  await assert.rejects(
    inspected.readArchiveEntry('server-overrides/server.properties'),
    /not part of the reviewed client projection/iu
  );
});

test('exact Modrinth client install binds provider identity and archive digest to the verified projection receipt', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const archiveBuffer = clientMrpackBuffer();
  const mrpackSha1 = crypto.createHash('sha1').update(archiveBuffer).digest('hex');
  const mrpackSha512 = crypto.createHash('sha512').update(archiveBuffer).digest('hex');
  const bytesByTarget = new Map([
    ['mods/required.jar', Buffer.from('required-client-bytes')],
    ['mods/optional.jar', Buffer.from('optional-client-bytes')]
  ]);
  try {
    const receipt = await installExactModrinthClientPack(lifecycle, {
      projectId: 'immutable-project',
      versionId: 'immutable-release',
      expectedMrpackSha512: mrpackSha512,
      async acquireVerifiedMrpack() {
        return {
          projectId: 'immutable-project',
          versionId: 'immutable-release',
          fileName: 'fixture.mrpack',
          size: String(archiveBuffer.length),
          sha1: mrpackSha1,
          sha512: mrpackSha512,
          archiveBuffer,
          async materializeDownload(download, destination) {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, bytesByTarget.get(download.targetPath));
          }
        };
      }
    });

    assert.equal(receipt.projectId, 'immutable-project');
    assert.equal(receipt.versionId, 'immutable-release');
    assert.equal(receipt.mrpackSha512, mrpackSha512);
    assert.equal(receipt.files.length, 3);
    assert.equal(await verifyInstalledClientPack(lifecycle, receipt), true);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('exact Modrinth client install rejects a provider archive outside the pinned immutable digest', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const archiveBuffer = clientMrpackBuffer();
  try {
    await assert.rejects(
      installExactModrinthClientPack(lifecycle, {
        projectId: 'immutable-project',
        versionId: 'immutable-release',
        expectedMrpackSha512: 'f'.repeat(128),
        async acquireVerifiedMrpack() {
          return {
            projectId: 'immutable-project',
            versionId: 'immutable-release',
            fileName: 'fixture.mrpack',
            size: String(archiveBuffer.length),
            sha1: crypto.createHash('sha1').update(archiveBuffer).digest('hex'),
            sha512: crypto.createHash('sha512').update(archiveBuffer).digest('hex'),
            archiveBuffer,
            async materializeDownload() {
              throw new Error('Downloads must not start for a mismatched immutable archive');
            }
          };
        }
      }),
      /immutable.*digest|digest.*immutable/iu
    );
    assert.deepEqual(await fs.readdir(lifecycle.clientPath), []);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('client MRPACK installation verifies declared hashes and the exact final file set', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const projection = buildMrpackClientProjection({
    manifest: clientManifest(),
    archiveEntries: clientArchiveEntries()
  });
  const bytesByTarget = new Map([
    ['mods/required.jar', Buffer.from('required-client-bytes')],
    ['mods/optional.jar', Buffer.from('optional-client-bytes')]
  ]);
  const overrides = new Map([
    ['overrides/config/shared.txt', Buffer.from('common-override')],
    ['client-overrides/config/shared.txt', Buffer.from('client-override')]
  ]);

  try {
    const receipt = await installMrpackClientProjection(lifecycle, {
      projection,
      async materializeDownload(download, destination) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytesByTarget.get(download.targetPath));
      },
      async readArchiveEntry(archivePath) {
        return overrides.get(archivePath);
      }
    });

    assert.deepEqual(receipt.files.map(file => ({
      path: file.path,
      source: file.source,
      sha1: file.sha1,
      sha512: file.sha512,
      size: file.size
    })), [
      {
        path: 'config/shared.txt', source: 'client-overrides', sha1: CLIENT_OVERRIDE_SHA1,
        sha512: CLIENT_OVERRIDE_SHA512, size: '15'
      },
      {
        path: 'mods/optional.jar', source: 'download', sha1: OPTIONAL_CLIENT_SHA1,
        sha512: OPTIONAL_CLIENT_SHA512, size: '21'
      },
      {
        path: 'mods/required.jar', source: 'download', sha1: REQUIRED_CLIENT_SHA1,
        sha512: REQUIRED_CLIENT_SHA512, size: '21'
      }
    ]);
    assert.equal(await verifyInstalledClientPack(lifecycle, receipt), true);
    assert.equal(await fs.readFile(path.join(lifecycle.clientPath, 'config', 'shared.txt'), 'utf8'), 'client-override');

    await fs.writeFile(path.join(lifecycle.clientPath, 'mods', 'required.jar'), 'changed');
    await assert.rejects(verifyInstalledClientPack(lifecycle, receipt), /hash|exact client pack/iu);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('client MRPACK installation rejects downloaded bytes that do not match the immutable manifest', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const projection = buildMrpackClientProjection({ manifest: clientManifest(), archiveEntries: [] });
  try {
    await assert.rejects(
      installMrpackClientProjection(lifecycle, {
        projection,
        async materializeDownload(_download, destination) {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.writeFile(destination, 'tampered');
        },
        async readArchiveEntry() {
          throw new Error('No archive entry should be read');
        }
      }),
      /hash|immutable manifest/iu
    );
    assert.deepEqual(await fs.readdir(lifecycle.clientPath), []);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('disposable registration keeps the management and Minecraft ports separate', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const calls = [];
  const initialized = path.join(lifecycle.clientPath, '.servers-initialized');
  const page = {
    evaluate: async (_callback, payload) => {
      calls.push(payload);
      return { success: true };
    }
  };
  try {
    await fs.writeFile(initialized, 'stale');
    await registerDisposableClient(page, lifecycle, { username: 'E2EJoiner' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, 'save-client-config');
    assert.equal(calls[0].request.serverPort, String(lifecycle.managementPort));
    await assert.rejects(fs.access(initialized));
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('disposable launch requires a strict proper-launch result and passes the game and management ports explicitly', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.15.10' };
  const calls = [];
  const page = {
    evaluate: async (_callback, payload) => {
      calls.push(payload);
      return { success: true, launcherKind: 'proper', fallbackAttempted: false };
    }
  };
  try {
    await launchDisposableClient(page, lifecycle, runtime);
    assert.equal(calls[0].request.serverPort, lifecycle.serverPort);
    assert.equal(calls[0].request.managementPort, lifecycle.managementPort);
    assert.equal(calls[0].request.useProperLauncher, true);
    assert.equal(calls[0].request.strictProperLauncher, true);

    const legacyPage = {
      evaluate: async () => ({ success: true, launcherKind: 'legacy', fallbackAttempted: true })
    };
    await assert.rejects(
      launchDisposableClient(legacyPage, lifecycle, runtime),
      /strict proper launcher/iu
    );
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('join proof ignores a complete matching line that predates the captured log boundary', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const logsPath = path.join(lifecycle.serverPath, 'logs');
  try {
    await fs.mkdir(logsPath);
    await fs.writeFile(path.join(logsPath, 'latest.log'), '[12:00:00] [Server thread/INFO]: E2EJoiner joined the game\n', 'utf8');
    const boundary = await captureLatestLogBoundary(lifecycle);
    await assert.rejects(
      waitForJoinLog(lifecycle, 'E2EJoiner', { boundary, timeoutMs: 20, pollMs: 1 }),
      /did not record/iu
    );
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('join proof accepts only an exact complete join line appended after the captured boundary', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const logsPath = path.join(lifecycle.serverPath, 'logs');
  const latestLogPath = path.join(logsPath, 'latest.log');
  try {
    await fs.mkdir(logsPath);
    await fs.writeFile(latestLogPath, '[12:00:00] [Server thread/INFO]: Server ready\n', 'utf8');
    const boundary = await captureLatestLogBoundary(lifecycle);
    await fs.appendFile(
      latestLogPath,
      '[12:00:01] [Server thread/INFO]: OtherE2EJoiner joined the game\n' +
        '[12:00:02] [Server thread/INFO]: E2EJoiner joined the game',
      'utf8'
    );
    await assert.rejects(
      waitForJoinLog(lifecycle, 'E2EJoiner', { boundary, timeoutMs: 20, pollMs: 1 }),
      /did not record/iu
    );

    await fs.appendFile(latestLogPath, '\r\n', 'utf8');
    const evidence = await waitForJoinLog(lifecycle, 'E2EJoiner', { boundary, timeoutMs: 50, pollMs: 1 });
    assert.equal(evidence.joinLine, '[12:00:02] [Server thread/INFO]: E2EJoiner joined the game');
    assert.doesNotMatch(evidence.latestLog, /Server ready/u);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('disposable teardown waits for both launcher and server status to become stopped', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  const channels = [];
  const page = {
    evaluate: async (_callback, payload) => {
      channels.push(payload.channel);
      if (payload.channel === 'minecraft-stop' || payload.channel === 'stop-server') return { success: true };
      if (payload.channel === 'minecraft-launcher-status') return { success: true, status: { isRunning: false } };
      if (payload.channel === 'get-server-status') return { isRunning: false, status: 'stopped' };
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };
  try {
    await stopDisposableClient(page, { timeoutMs: 50, pollMs: 1 });
    await stopDisposableServer(page, lifecycle, 'disposable-server', { timeoutMs: 50, pollMs: 1 });
    assert.deepEqual(channels, ['minecraft-stop', 'minecraft-launcher-status', 'stop-server', 'get-server-status']);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

for (const [stage, channel] of [
  ['client stop', 'minecraft-stop'],
  ['client status', 'minecraft-launcher-status']
]) {
  test(`disposable client teardown expires its external deadline when ${stage} IPC never settles`, async () => {
    let finalized = false;
    const page = {
      async evaluate(_callback, payload) {
        if (payload.channel === channel) return new Promise(() => {});
        if (payload.channel === 'minecraft-stop') return { success: true };
        if (payload.channel === 'minecraft-launcher-status') return { success: true, status: { isRunning: true } };
        throw new Error(`Unexpected IPC channel ${payload.channel}`);
      }
    };

    await assert.rejects(
      Promise.race([
        stopDisposableClient(page, { timeoutMs: 30, pollMs: 1 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('test watchdog: teardown IPC remained unbounded')), 200))
      ]),
      error => error?.code === 'E2E_TEARDOWN_IPC_TIMEOUT' && error?.stage === stage
    );
    finalized = true;

    assert.equal(finalized, true);
  });
}

test('a disposable client IPC timeout still reaches finalization', async () => {
  const events = [];
  const page = {
    async evaluate() {
      return new Promise(() => {});
    }
  };

  await assert.rejects(
    Promise.race([
      stopDisposableClient(page, { timeoutMs: 30, pollMs: 1 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('test watchdog: finalization was blocked by IPC')), 200))
    ]),
    error => error?.code === 'E2E_TEARDOWN_IPC_TIMEOUT' && error?.stage === 'client stop'
  );

  await finalizeDisposableClientJoin({
    completed: false,
    async close() {
      events.push('close');
    },
    async collectEvidence() {
      events.push('collect-evidence');
      return { fixture: 'timeout' };
    },
    async attachEvidence(evidence) {
      events.push(`attach-evidence:${evidence.fixture}`);
    },
    async dispose({ preserveRoot }) {
      events.push(`dispose:${preserveRoot}`);
    },
    environment: {}
  });

  assert.deepEqual(events, [
    'close',
    'collect-evidence',
    'attach-evidence:timeout',
    'dispose:false'
  ]);
});

test('a disposable client failure honors explicit debug preservation', async () => {
  const events = [];

  await finalizeDisposableClientJoin({
    completed: false,
    async close() { events.push('close'); },
    async collectEvidence() { events.push('collect'); return { fixture: 'debug' }; },
    async attachEvidence() { events.push('attach'); },
    async dispose({ preserveRoot }) { events.push(`dispose:${preserveRoot}`); },
    environment: { MINECRAFT_CORE_PRESERVE_FAILED_REAL_E2E: '1' }
  });

  assert.deepEqual(events, ['close', 'collect', 'attach', 'dispose:true']);
});

test('a disposable client failure preserves its root when evidence attachment fails', async () => {
  const attachmentFailure = new Error('test reporter unavailable');
  const events = [];

  await assert.rejects(finalizeDisposableClientJoin({
    completed: false,
    async close() { events.push('close'); },
    async collectEvidence() { events.push('collect'); return { fixture: 'attachment-failure' }; },
    async attachEvidence() { events.push('attach'); throw attachmentFailure; },
    async dispose({ preserveRoot }) { events.push(`dispose:${preserveRoot}`); },
    environment: {}
  }), error => error === attachmentFailure);

  assert.deepEqual(events, ['close', 'collect', 'attach', 'dispose:true']);
});

test('a disposable client failure preserves its root when evidence collection fails', async () => {
  const collectionFailure = new Error('evidence filesystem unavailable');
  const events = [];

  await assert.rejects(finalizeDisposableClientJoin({
    completed: false,
    async close() { events.push('close'); },
    async collectEvidence() { events.push('collect'); throw collectionFailure; },
    async attachEvidence() { events.push('attach'); },
    async dispose({ preserveRoot }) { events.push(`dispose:${preserveRoot}`); },
    environment: {}
  }), error => error === collectionFailure);

  assert.deepEqual(events, ['close', 'collect', 'dispose:true']);
});

test('disposable join server teardown force-kills the exact isolated instance after graceful rejection', async () => {
  const lifecycle = await realHarness.createIsolatedRealLifecycle({ scratchLabel: 'client-join-force-stop' });
  const channels = [];
  const page = {
    evaluate: async (_callback, payload) => {
      channels.push(payload.channel);
      if (payload.channel === 'stop-server') return { success: false };
      if (payload.channel === 'kill-server') return { success: true };
      if (payload.channel === 'get-server-status') return { isRunning: false, status: 'stopped' };
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };
  try {
    await stopDisposableServer(page, lifecycle, 'disposable-server', { timeoutMs: 50, pollMs: 1 });
    assert.deepEqual(channels, ['stop-server', 'kill-server', 'get-server-status']);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('failed disposable join preserves evidence even when the Electron close audit fails', async () => {
  const closeFailure = new Error('isolated Electron descendant remains');
  const evidence = { scratchRoot: 'C:\\Temp\\minecraft-core-real-modrinth-e2e-proof' };
  const events = [];

  await assert.rejects(
    finalizeDisposableClientJoin({
      completed: false,
      async close() {
        events.push('close');
        throw closeFailure;
      },
      async collectEvidence() {
        events.push('collect-evidence');
        return evidence;
      },
      async attachEvidence(received) {
        events.push('attach-evidence');
        assert.equal(received, evidence);
      },
      async dispose({ preserveRoot }) {
        events.push(`dispose:${preserveRoot}`);
      }
    }),
    error => error === closeFailure
  );

  assert.deepEqual(events, [
    'close',
    'collect-evidence',
    'attach-evidence',
    'dispose:true'
  ]);
});

test('disposable finalization keeps close failure primary when attachment and disposal also fail', async () => {
  const closeFailure = new Error('isolated Electron descendant remains');
  const events = [];

  await assert.rejects(finalizeDisposableClientJoin({
    completed: false,
    async close() { events.push('close'); throw closeFailure; },
    async collectEvidence() { events.push('collect'); return { fixture: 'close-primary' }; },
    async attachEvidence() { events.push('attach'); throw new Error('reporter unavailable'); },
    async dispose({ preserveRoot }) { events.push(`dispose:${preserveRoot}`); throw new Error('dispose failed'); }
  }), error => error === closeFailure);

  assert.deepEqual(events, ['close', 'collect', 'attach', 'dispose:true']);
});

test('disposable finalization reports disposal failure when close and evidence succeed', async () => {
  const disposeFailure = new Error('dispose failed');
  const events = [];

  await assert.rejects(finalizeDisposableClientJoin({
    completed: true,
    async close() { events.push('close'); },
    async collectEvidence() { events.push('collect'); return null; },
    async attachEvidence() { events.push('attach'); },
    async dispose({ preserveRoot }) { events.push(`dispose:${preserveRoot}`); throw disposeFailure; }
  }), error => error === disposeFailure);

  assert.deepEqual(events, ['close', 'dispose:false']);
});
