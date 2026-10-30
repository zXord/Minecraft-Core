const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const AdmZip = require('adm-zip');

const MANAGER_PATH = path.resolve(__dirname, '../electron/services/minecraft-launcher/java-manager.cjs');
const { JavaManager } = require(MANAGER_PATH);
const { ServerJavaManager } = require('../electron/services/server-java-manager.cjs');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const EXECUTABLE = process.platform === 'win32' ? 'java.exe' : 'java';
const RUNTIME_ROOT = 'jdk-21.0.8+9-jre';
const EXECUTABLE_PARTS = Object.freeze([RUNTIME_ROOT, 'bin', EXECUTABLE]);

// Each layout returns the folder spelling the app stored and the real folder behind it.
const LAYOUTS = Object.freeze([
  {
    name: 'a plain folder',
    create(root) {
      const folder = path.join(root, 'Servers', 'Plain');
      fs.mkdirSync(folder, { recursive: true });
      return { folder, realFolder: folder };
    }
  },
  {
    name: 'a folder below a junction',
    create(root) {
      const realFolder = path.join(root, 'real', 'Servers', 'Ancestor');
      fs.mkdirSync(realFolder, { recursive: true });
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), LINK_TYPE);
      return { folder: path.join(root, 'linked', 'Servers', 'Ancestor'), realFolder };
    }
  },
  {
    name: 'a folder that is itself a junction',
    create(root) {
      const realFolder = path.join(root, 'real', 'SelfLinked');
      fs.mkdirSync(realFolder, { recursive: true });
      const folder = path.join(root, 'SelfLinkedServer');
      fs.symlinkSync(realFolder, folder, LINK_TYPE);
      return { folder, realFolder };
    }
  },
  {
    // A test cannot create a SUBST or mapped drive without changing the user's session. A junction
    // standing in for the drive root emulates one: like `subst X: D:\Games\Minecraft`, the stored
    // spelling is shallow and shares no folder with the deeper real path behind it.
    name: 'a junction-emulated SUBST drive',
    create(root) {
      const volume = path.join(root, 'volume', 'Games', 'Minecraft');
      const realFolder = path.join(volume, 'SubstServer');
      fs.mkdirSync(realFolder, { recursive: true });
      const drive = path.join(root, 'X');
      fs.symlinkSync(volume, drive, LINK_TYPE);
      return { folder: path.join(drive, 'SubstServer'), realFolder };
    }
  }
]);

const FLAVORS = Object.freeze([
  { name: 'client', create: (folder, options) => new JavaManager(folder, options) },
  { name: 'server', create: (folder, options) => new ServerJavaManager(folder, { ...options, onMutation: () => true }) }
]);

function tempRoot(t) {
  // Resolved so the real side of every layout is canonical even when TEMP itself is an alias.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-alias-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function runtimeArchive() {
  const zip = new AdmZip();
  zip.addFile(`${RUNTIME_ROOT}/bin/java.exe`, Buffer.from('java'));
  zip.addFile(`${RUNTIME_ROOT}/bin/java`, Buffer.from('java'));
  zip.addFile(`${RUNTIME_ROOT}/release`, Buffer.from('JAVA_VERSION="21"\n'));
  return zip.toBuffer();
}

function response(bytes) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: name => String(name).toLowerCase() === 'content-length' ? String(bytes.length) : null },
    body: Readable.from([bytes])
  };
}

function adoptiumFetch(archive) {
  const metadata = Buffer.from(JSON.stringify([{
    binary: {
      package: {
        checksum: sha256(archive),
        link: 'https://downloads.example.test/runtime.zip',
        name: 'runtime.zip',
        size: archive.length
      }
    }
  }]), 'utf8');
  const bodies = [metadata, archive];
  return async () => {
    const body = bodies.shift();
    if (!body) throw new Error('unexpected Java download request');
    return response(body);
  };
}

function loadJavaManagerWithWorker(runJavaArchiveWorker) {
  const originalLoad = Module._load;
  const cached = require.cache[MANAGER_PATH];
  delete require.cache[MANAGER_PATH];
  Module._load = function loadWithWorker(request, parent, isMain) {
    if (request === '../java-archive-worker-client.cjs' && parent?.filename === MANAGER_PATH) {
      return { runJavaArchiveWorker };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(MANAGER_PATH).JavaManager;
  } finally {
    Module._load = originalLoad;
    require.cache[MANAGER_PATH] = cached;
  }
}

function writeRuntime(extractPath) {
  const executable = path.join(extractPath, ...EXECUTABLE_PARTS);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'java');
  return { entryCount: 1, expandedBytes: '4', javaExecutableRelativePath: EXECUTABLE_PARTS.join('/') };
}

for (const layout of LAYOUTS) {
  for (const flavor of FLAVORS) {
    test(`${flavor.name} Java downloads into ${layout.name} and returns the executable in the stored spelling`, async t => {
      const { folder, realFolder } = layout.create(tempRoot(t));
      const manager = flavor.create(folder, { fetchImpl: adoptiumFetch(runtimeArchive()) });

      const result = await manager.downloadJava(21);

      assert.equal(result.success, true);
      assert.equal(result.javaPath, path.join(folder, 'java', 'java-21', ...EXECUTABLE_PARTS));
      assert.equal(fs.realpathSync.native(result.javaPath), path.join(realFolder, 'java', 'java-21', ...EXECUTABLE_PARTS));
      assert.equal(fs.readFileSync(result.javaPath, 'utf8'), 'java');
      assert.deepEqual(fs.readdirSync(realFolder), ['java']);
      assert.deepEqual(fs.readdirSync(path.join(realFolder, 'java')).sort(), ['java-21', 'temp']);
      assert.deepEqual(fs.readdirSync(path.join(realFolder, 'java', 'temp')), []);
    });
  }
}

for (const layout of LAYOUTS) {
  test(`the extracted executable is verified under the real Java folder for ${layout.name}`, async t => {
    const { folder, realFolder } = layout.create(tempRoot(t));
    const manager = new JavaManager(folder, { fetchImpl: adoptiumFetch(runtimeArchive()) });
    manager.extractJava = async (_archivePath, version) => writeRuntime(path.join(manager.javaBaseDir, `java-${version}`));

    const result = await manager.downloadJava(21);

    assert.equal(result.javaPath, path.join(folder, 'java', 'java-21', ...EXECUTABLE_PARTS));
    assert.equal(fs.realpathSync.native(result.javaPath), path.join(realFolder, 'java', 'java-21', ...EXECUTABLE_PARTS));
  });
}

test('ensureJava below a junction still recognises the new runtime when it removes older ones', async t => {
  const { folder, realFolder } = LAYOUTS[1].create(tempRoot(t));
  fs.mkdirSync(path.join(realFolder, 'java', 'java-17', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(realFolder, 'java', 'java-17', 'bin', EXECUTABLE), 'old');
  const manager = new JavaManager(folder, { fetchImpl: adoptiumFetch(runtimeArchive()) });

  const result = await manager.ensureJava(21);

  assert.equal(result.success, true);
  assert.equal(result.javaPath, path.join(folder, 'java', 'java-21', ...EXECUTABLE_PARTS));
  assert.equal(result.cleanup.activeJavaVersion, '21');
  assert.deepEqual(result.cleanup.cleanedVersions, ['17']);
  assert.equal(fs.existsSync(path.join(realFolder, 'java', 'java-17')), false);
  assert.equal(fs.readFileSync(path.join(realFolder, 'java', 'java-21', ...EXECUTABLE_PARTS), 'utf8'), 'java');
});

test('a canonical folder sends the same worker request and returns the same executable as before', async t => {
  const folder = path.join(tempRoot(t), 'Servers', 'Plain');
  fs.mkdirSync(folder, { recursive: true });
  const requests = [];
  const CapturingJavaManager = loadJavaManagerWithWorker(async request => {
    requests.push(request);
    return writeRuntime(request.destinationPath);
  });
  const archive = runtimeArchive();
  const manager = new CapturingJavaManager(folder, { fetchImpl: adoptiumFetch(archive) });

  const result = await manager.downloadJava(21);

  const javaBaseDir = path.join(folder, 'java');
  assert.equal(requests.length, 1);
  const { archivePath, ...request } = requests[0];
  assert.deepEqual(request, {
    rootPath: javaBaseDir,
    destinationPath: path.resolve(javaBaseDir, 'java-21'),
    maxArchiveBytes: 256 * 1024 * 1024,
    expectedArchiveSize: archive.length,
    expectedSha256: sha256(archive)
  });
  assert.equal(path.dirname(archivePath), path.join(javaBaseDir, 'temp'));
  assert.match(path.basename(archivePath), /-runtime\.zip$/u);
  assert.equal(result.javaPath, path.join(javaBaseDir, 'java-21', ...EXECUTABLE_PARTS));
});

test('a destination that is not directly inside the Java folder is still refused', async t => {
  const root = tempRoot(t);
  for (const layout of LAYOUTS) {
    const { folder, realFolder } = layout.create(root);
    const manager = new JavaManager(folder);
    const archive = runtimeArchive();
    const archivePath = path.join(manager.javaBaseDir, 'temp', 'runtime.zip');
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, archive);
    const evidence = { expectedArchiveSize: archive.length, expectedSha256: sha256(archive) };

    for (const destination of [
      path.join(manager.javaBaseDir, '..', 'java-21'),
      path.join(manager.javaBaseDir, 'temp', 'java-21'),
      path.join(root, 'elsewhere', 'java-21')
    ]) {
      await assert.rejects(
        manager.extractZip(archivePath, destination, evidence),
        error => error?.code === 'JAVA_EXTRACTION_FAILED',
        `${layout.name}: ${destination}`
      );
    }
    assert.deepEqual(fs.readdirSync(realFolder), ['java'], layout.name);
    assert.deepEqual(fs.readdirSync(path.join(realFolder, 'java')), ['temp'], layout.name);
    assert.deepEqual(fs.readdirSync(path.join(realFolder, 'java', 'temp')), ['runtime.zip'], layout.name);
  }
  assert.equal(fs.existsSync(path.join(root, 'elsewhere')), false);
});

for (const layout of [LAYOUTS[0], LAYOUTS[1]]) {
  test(`a link below the Java folder is still refused for ${layout.name}`, async t => {
    const { folder, realFolder } = layout.create(tempRoot(t));
    const outside = path.join(realFolder, 'outside-bin');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, EXECUTABLE), 'java');
    const manager = new JavaManager(folder, { fetchImpl: adoptiumFetch(runtimeArchive()) });
    manager.extractJava = async (_archivePath, version) => {
      const runtimeRoot = path.join(manager.javaBaseDir, `java-${version}`, RUNTIME_ROOT);
      fs.mkdirSync(runtimeRoot, { recursive: true });
      fs.symlinkSync(outside, path.join(runtimeRoot, 'bin'), LINK_TYPE);
      return { entryCount: 1, expandedBytes: '4', javaExecutableRelativePath: EXECUTABLE_PARTS.join('/') };
    };

    await assert.rejects(manager.downloadJava(21), error => error?.code === 'JAVA_EXTRACTION_FAILED');
  });
}
