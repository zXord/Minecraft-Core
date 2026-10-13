const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const {
  createDevElectronRuntimeLease,
  prepareBrandedDevElectronRuntime
} = require('../scripts/dev-electron-runtime.cjs');

async function makeFixture(t) {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-dev-runtime-test-'));
  const sourceDistributionPath = path.join(root, 'source');
  const cacheBasePath = path.join(root, 'local-app-data');
  const iconPath = path.join(root, 'icon.ico');
  await fsPromises.mkdir(path.join(sourceDistributionPath, 'resources'), { recursive: true });
  await fsPromises.mkdir(path.join(sourceDistributionPath, 'locales'), { recursive: true });
  await fsPromises.writeFile(path.join(sourceDistributionPath, 'electron.exe'), 'stock-electron');
  await fsPromises.writeFile(path.join(sourceDistributionPath, 'runtime.dll'), 'runtime-library');
  await fsPromises.writeFile(path.join(sourceDistributionPath, 'resources', 'default_app.asar'), 'default-app');
  await fsPromises.writeFile(path.join(sourceDistributionPath, 'locales', 'en-US.pak'), 'locale');
  await fsPromises.writeFile(iconPath, 'brand-one');
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  return {
    root,
    sourceDistributionPath,
    sourceExecutablePath: path.join(sourceDistributionPath, 'electron.exe'),
    cacheBasePath,
    iconPath
  };
}

test('default development branding gives notifications a product name distinct from the installed app', async t => {
  const fixture = await makeFixture(t);
  const edits = [];
  const originalLoad = Module._load;
  // Keep the real branding payload and cache publication; substitute only the
  // native resource editor, which cannot edit this small text executable fixture.
  t.mock.method(Module, '_load', function(request, parent, isMain) {
    if (request === 'rcedit') return async (executablePath, options) => {
      edits.push({ executablePath, options });
      await fsPromises.appendFile(executablePath, '|resource-edited');
    };
    return originalLoad.call(this, request, parent, isMain);
  });

  const prepared = await prepareBrandedDevElectronRuntime({
    ...fixture, electronVersion: '42.10.1', architecture: 'x64'
  }, { verifyExecutableIcon: async () => {} });

  assert.equal(edits.length, 1);
  assert.equal(path.basename(edits[0].executablePath), 'electron.exe');
  assert.notEqual(edits[0].executablePath, fixture.sourceExecutablePath);
  assert.deepEqual(edits[0].options, {
    icon: fixture.iconPath,
    'version-string': {
      CompanyName: 'zXord',
      FileDescription: 'Minecraft Core Development',
      ProductName: 'Minecraft Core Development',
      InternalName: 'Minecraft Core Development',
      OriginalFilename: 'electron.exe'
    },
    'file-version': '42.10.1',
    'product-version': '42.10.1'
  });
  assert.equal(await fsPromises.readFile(prepared.executablePath, 'utf8'), 'stock-electron|resource-edited');
  assert.equal(await fsPromises.readFile(fixture.sourceExecutablePath, 'utf8'), 'stock-electron');
});

for (const legacyIntegrity of ['valid', 'modified']) {
  test(`new branding uses a separate cache generation and preserves the leased ${legacyIntegrity} legacy runtime`, async t => {
    const fixture = await makeFixture(t);
    const digest = value => crypto.createHash('sha256').update(value).digest('hex');
    const sourceDigest = digest('stock-electron');
    const iconDigest = digest('brand-one');
    // This is the pre-generation cache format already issued to users, not an
    // expected path derived from the current implementation.
    const legacyKey = `42.10.1-x64-${sourceDigest.slice(0, 16)}-${iconDigest.slice(0, 16)}`;
    const legacyDirectory = path.join(fixture.cacheBasePath, 'Minecraft Core', 'dev-electron-runtime', `runtime-${legacyKey}`);
    const legacyExecutable = path.join(legacyDirectory, 'electron.exe');
    const legacyMarkerPath = path.join(legacyDirectory, '.minecraft-core-runtime.json');
    const legacyBytes = `stock-electron|old-product-name${legacyIntegrity === 'modified' ? '|modified' : ''}`;
    const legacyMarker = JSON.stringify({
      schemaVersion: 1, electronVersion: '42.10.1', architecture: 'x64', sourceDigest, iconDigest,
      patchedExecutableDigest: digest('stock-electron|old-product-name')
    });
    await fsPromises.mkdir(legacyDirectory, { recursive: true });
    await fsPromises.writeFile(legacyExecutable, legacyBytes);
    await fsPromises.writeFile(legacyMarkerPath, legacyMarker);
    const lease = await createDevElectronRuntimeLease(legacyDirectory, { heartbeatMs: 60 * 60 * 1000 });
    t.after(() => lease.dispose());
    const leaseBytes = await fsPromises.readFile(lease.leasePath, 'utf8');
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fsPromises.utimes(legacyMarkerPath, oldTime, oldTime);
    await fsPromises.utimes(lease.leasePath, oldTime, oldTime);
    let edits = 0;
    const dependencies = {
      async editExecutable({ executablePath }) {
        edits += 1;
        await fsPromises.appendFile(executablePath, '|development-product-name');
      },
      verifyExecutableIcon: async () => {}
    };
    const options = { ...fixture, electronVersion: '42.10.1', architecture: 'x64' };

    const prepared = await prepareBrandedDevElectronRuntime(options, dependencies);
    const reused = await prepareBrandedDevElectronRuntime(options, dependencies);

    assert.equal(await fsPromises.readFile(legacyExecutable, 'utf8'), legacyBytes);
    assert.equal(await fsPromises.readFile(legacyMarkerPath, 'utf8'), legacyMarker);
    assert.equal(await fsPromises.readFile(lease.leasePath, 'utf8'), leaseBytes);
    assert.notEqual(prepared.cacheDirectory, legacyDirectory);
    assert.equal(prepared.reused, false);
    assert.equal(reused.reused, true);
    assert.equal(reused.cacheDirectory, prepared.cacheDirectory);
    assert.equal(edits, 1);
    assert.equal(await fsPromises.readFile(prepared.executablePath, 'utf8'), 'stock-electron|development-product-name');
  });
}

test('Windows development runtime embeds the icon in a LocalAppData cache and reuses the published copy', async t => {
  const fixture = await makeFixture(t);
  let edits = 0;
  let verifications = 0;
  const dependencies = {
    async editExecutable({ executablePath, iconPath }) {
      edits += 1;
      assert.equal(iconPath, fixture.iconPath);
      await fsPromises.appendFile(executablePath, '|branded');
    },
    async verifyExecutableIcon({ executablePath, iconPath }) {
      verifications += 1;
      assert.equal(iconPath, fixture.iconPath);
      assert.equal(await fsPromises.readFile(executablePath, 'utf8'), 'stock-electron|branded');
    }
  };
  const options = {
    ...fixture,
    electronVersion: '42.10.1',
    architecture: 'x64'
  };

  const first = await prepareBrandedDevElectronRuntime(options, dependencies);
  const staleDirectory = path.join(
    fixture.cacheBasePath,
    'Minecraft Core',
    'dev-electron-runtime',
    'runtime-obsolete'
  );
  await fsPromises.mkdir(staleDirectory, { recursive: true });
  await fsPromises.writeFile(path.join(staleDirectory, 'electron.exe'), 'obsolete');
  const recentSibling = path.join(
    fixture.cacheBasePath,
    'Minecraft Core',
    'dev-electron-runtime',
    'runtime-new-concurrent-launch'
  );
  await fsPromises.mkdir(recentSibling, { recursive: true });
  await fsPromises.writeFile(path.join(recentSibling, 'electron.exe'), 'new-concurrent-launch');
  const oldActiveSibling = path.join(
    fixture.cacheBasePath,
    'Minecraft Core',
    'dev-electron-runtime',
    'runtime-old-but-active'
  );
  await fsPromises.mkdir(oldActiveSibling, { recursive: true });
  await fsPromises.writeFile(path.join(oldActiveSibling, 'electron.exe'), 'active-runtime');
  const activeLeasePath = path.join(oldActiveSibling, `.lease-${process.pid}-active`);
  await fsPromises.writeFile(activeLeasePath, JSON.stringify({ pid: process.pid }));
  const abandonedStaging = path.join(
    fixture.cacheBasePath,
    'Minecraft Core',
    'dev-electron-runtime',
    '.staging-abandoned'
  );
  await fsPromises.mkdir(abandonedStaging, { recursive: true });
  await fsPromises.writeFile(path.join(abandonedStaging, 'electron.exe'), 'abandoned');
  const oldTime = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000));
  await fsPromises.utimes(staleDirectory, oldTime, oldTime);
  await fsPromises.utimes(oldActiveSibling, oldTime, oldTime);
  await fsPromises.utimes(activeLeasePath, oldTime, oldTime);
  await fsPromises.utimes(abandonedStaging, oldTime, oldTime);
  const second = await prepareBrandedDevElectronRuntime(options, dependencies);

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.executablePath, first.executablePath);
  assert.equal(path.basename(first.executablePath), 'electron.exe');
  assert.equal(path.resolve(first.executablePath).startsWith(path.resolve(fixture.cacheBasePath) + path.sep), true);
  assert.equal(await fsPromises.readFile(fixture.sourceExecutablePath, 'utf8'), 'stock-electron');
  assert.equal(await fsPromises.readFile(path.join(first.cacheDirectory, 'runtime.dll'), 'utf8'), 'runtime-library');
  assert.equal(await fsPromises.readFile(path.join(first.cacheDirectory, 'resources', 'default_app.asar'), 'utf8'), 'default-app');
  assert.equal(edits, 1);
  assert.equal(verifications, 1);
  assert.equal(fs.existsSync(staleDirectory), false);
  assert.equal(fs.existsSync(abandonedStaging), false);
  assert.equal(fs.existsSync(recentSibling), true);
  assert.equal(fs.existsSync(oldActiveSibling), true);
  assert.equal(fs.existsSync(first.cacheDirectory), true);
});

test('concurrent builders serialize one cache key and never remove the runtime returned by the winner', async t => {
  const fixture = await makeFixture(t);
  let edits = 0;
  let releaseFirstEdit;
  let firstEditStarted;
  const editStarted = new Promise(resolve => { firstEditStarted = resolve; });
  const editGate = new Promise(resolve => { releaseFirstEdit = resolve; });
  const options = {
    ...fixture,
    electronVersion: '42.10.1',
    architecture: 'x64'
  };
  const dependencies = {
    async editExecutable({ executablePath }) {
      edits += 1;
      if (edits === 1) firstEditStarted();
      await editGate;
      await fsPromises.appendFile(executablePath, '|branded');
    },
    verifyExecutableIcon: async () => {}
  };

  const firstPromise = prepareBrandedDevElectronRuntime(options, dependencies);
  await editStarted;
  const cacheRoot = path.join(fixture.cacheBasePath, 'Minecraft Core', 'dev-electron-runtime');
  const lockName = (await fsPromises.readdir(cacheRoot)).find(name => name.startsWith('.lock-'));
  assert.ok(lockName);
  const lockDirectory = path.join(cacheRoot, lockName);
  const oldTime = new Date(Date.now() - (60 * 60 * 1000));
  await fsPromises.utimes(path.join(lockDirectory, 'owner.json'), oldTime, oldTime);
  await fsPromises.utimes(lockDirectory, oldTime, oldTime);
  const secondPromise = prepareBrandedDevElectronRuntime(options, dependencies);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(edits, 1);

  releaseFirstEdit();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.executablePath, second.executablePath);
  assert.deepEqual([first.reused, second.reused], [false, true]);
  assert.equal(edits, 1);
  assert.equal(await fsPromises.readFile(first.executablePath, 'utf8'), 'stock-electron|branded');
  assert.deepEqual(
    (await fsPromises.readdir(path.dirname(first.cacheDirectory))).filter(name => name.startsWith('.lock-')),
    []
  );
});

test('lock acquisition retries when a collided owner releases before the contention check', async t => {
  const fixture = await makeFixture(t);
  const originalRename = fsPromises.rename.bind(fsPromises);
  let injectedCollision = false;
  t.mock.method(fsPromises, 'rename', async (sourcePath, destinationPath) => {
    if (
      !injectedCollision &&
      path.basename(sourcePath).startsWith('.lock-candidate-') &&
      path.basename(destinationPath).startsWith('.lock-')
    ) {
      injectedCollision = true;
      const collision = new Error('simulated lock owner released after collision');
      collision.code = 'EEXIST';
      throw collision;
    }
    return originalRename(sourcePath, destinationPath);
  });

  const prepared = await prepareBrandedDevElectronRuntime({
    ...fixture,
    electronVersion: '42.10.1',
    architecture: 'x64'
  }, {
    editExecutable: async ({ executablePath }) => fsPromises.appendFile(executablePath, '|branded'),
    verifyExecutableIcon: async () => {}
  });

  assert.equal(injectedCollision, true);
  assert.equal(prepared.reused, false);
  assert.equal(await fsPromises.readFile(prepared.executablePath, 'utf8'), 'stock-electron|branded');
  assert.deepEqual(
    (await fsPromises.readdir(path.dirname(prepared.cacheDirectory)))
      .filter(name => name.startsWith('.lock-')),
    []
  );
});

test('a crashed cache-key lock is quarantined so preparation can recover', async t => {
  const fixture = await makeFixture(t);
  let edits = 0;
  const options = {
    ...fixture,
    electronVersion: '42.10.1',
    architecture: 'x64'
  };
  const dependencies = {
    async editExecutable({ executablePath }) {
      edits += 1;
      await fsPromises.appendFile(executablePath, '|branded');
    },
    verifyExecutableIcon: async () => {}
  };
  const first = await prepareBrandedDevElectronRuntime(options, dependencies);
  await fsPromises.appendFile(first.executablePath, '|invalid');
  const lockDirectory = path.join(path.dirname(first.cacheDirectory), `.lock-${first.cacheKey}`);
  await fsPromises.mkdir(lockDirectory);
  await fsPromises.writeFile(path.join(lockDirectory, 'owner.json'), JSON.stringify({
    pid: 2147483646,
    token: 'crashed-owner'
  }));
  const oldTime = new Date(Date.now() - (60 * 60 * 1000));
  await fsPromises.utimes(path.join(lockDirectory, 'owner.json'), oldTime, oldTime);
  await fsPromises.utimes(lockDirectory, oldTime, oldTime);

  const recovered = await prepareBrandedDevElectronRuntime(options, dependencies);

  assert.equal(recovered.reused, false);
  assert.equal(edits, 2);
  assert.equal(fs.existsSync(lockDirectory), false);
  assert.equal(await fsPromises.readFile(recovered.executablePath, 'utf8'), 'stock-electron|branded');
});

test('a modified cached executable is rebuilt instead of being trusted from its marker', async t => {
  const fixture = await makeFixture(t);
  let edits = 0;
  const options = {
    ...fixture,
    electronVersion: '42.10.1',
    architecture: 'x64'
  };
  const dependencies = {
    async editExecutable({ executablePath }) {
      edits += 1;
      await fsPromises.appendFile(executablePath, '|branded');
    },
    verifyExecutableIcon: async () => {}
  };

  const first = await prepareBrandedDevElectronRuntime(options, dependencies);
  await fsPromises.appendFile(first.executablePath, '|tampered');
  const rebuilt = await prepareBrandedDevElectronRuntime(options, dependencies);

  assert.equal(rebuilt.cacheDirectory, first.cacheDirectory);
  assert.equal(rebuilt.reused, false);
  assert.equal(edits, 2);
  assert.equal(await fsPromises.readFile(rebuilt.executablePath, 'utf8'), 'stock-electron|branded');
});

test('development runtime cache key changes when the source executable or icon content changes', async t => {
  const fixture = await makeFixture(t);
  const options = {
    ...fixture,
    electronVersion: '42.10.1',
    architecture: 'x64'
  };
  const dependencies = {
    editExecutable: async ({ executablePath }) => fsPromises.appendFile(executablePath, '|branded'),
    verifyExecutableIcon: async () => {}
  };

  const first = await prepareBrandedDevElectronRuntime(options, dependencies);
  await fsPromises.writeFile(fixture.iconPath, 'brand-two');
  const iconChanged = await prepareBrandedDevElectronRuntime(options, dependencies);
  await fsPromises.writeFile(fixture.sourceExecutablePath, 'stock-electron-two');
  const executableChanged = await prepareBrandedDevElectronRuntime(options, dependencies);

  assert.notEqual(iconChanged.cacheDirectory, first.cacheDirectory);
  assert.notEqual(executableChanged.cacheDirectory, iconChanged.cacheDirectory);
});

test('a failed icon verification never publishes a partially prepared development runtime', async t => {
  const fixture = await makeFixture(t);
  const failure = new Error('icon mismatch');

  await assert.rejects(prepareBrandedDevElectronRuntime({
    ...fixture,
    electronVersion: '42.10.1',
    architecture: 'x64'
  }, {
    editExecutable: async ({ executablePath }) => fsPromises.appendFile(executablePath, '|broken'),
    verifyExecutableIcon: async () => { throw failure; }
  }), failure);

  const cacheRoot = path.join(fixture.cacheBasePath, 'Minecraft Core', 'dev-electron-runtime');
  const entries = fs.existsSync(cacheRoot) ? await fsPromises.readdir(cacheRoot) : [];
  assert.deepEqual(entries, []);
});

test('Windows runtime preparation never falls back to a shared temporary directory without LocalAppData', async t => {
  const fixture = await makeFixture(t);
  const originalLocalAppData = process.env.LOCALAPPDATA;
  delete process.env.LOCALAPPDATA;
  t.after(() => {
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
  });
  const optionsWithoutCache = {
    sourceDistributionPath: fixture.sourceDistributionPath,
    sourceExecutablePath: fixture.sourceExecutablePath,
    iconPath: fixture.iconPath
  };

  await assert.rejects(prepareBrandedDevElectronRuntime({
    ...optionsWithoutCache,
    electronVersion: '42.10.1',
    architecture: 'x64'
  }), /runtime cache path must be absolute/u);
});
