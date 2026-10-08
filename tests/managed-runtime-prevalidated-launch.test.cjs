const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function runtime(loaderFamily, loaderVersion = 'test-loader') {
  return {
    minecraftVersion: '1.20.1',
    loaderFamily,
    loaderVersion,
    javaMajor: 17,
    os: 'win32',
    architecture: 'x64'
  };
}

function artifact(relativePath) {
  return {
    relativePath,
    size: 7,
    sha256: 'a'.repeat(64),
    sha512: 'b'.repeat(128)
  };
}

function write(root, relativePath) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'fixture');
}

async function withNoSynchronousRuntimeInspection(work) {
  const launcherPath = require.resolve('../electron/services/server-launcher.cjs');
  const originalLoad = Module._load;
  let synchronousInspections = 0;
  Module._load = function prevalidatedLauncherLoad(request, parent, isMain) {
    if (parent?.filename === launcherPath && request === './loader-install-service.cjs') {
      return {
        validatePreparedRuntime() {
          synchronousInspections += 1;
          throw new Error('synchronous runtime validation must not run');
        }
      };
    }
    if (parent?.filename === launcherPath && request === '../utils/server-loader.cjs') {
      return {
        normalizeLoaderName(value) { return value; },
        resolveServerLoader() {
          synchronousInspections += 1;
          throw new Error('eager loader discovery must not run');
        }
      };
    }
    if (parent?.filename === launcherPath && request === '../utils/fabric-runtime.cjs') {
      return {
        FABRIC_LAUNCH_JAR: 'fabric-server-launch.jar',
        getFabricRuntimeStatus() {
          synchronousInspections += 1;
          throw new Error('synchronous Fabric inspection must not run');
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[launcherPath];
  try {
    await work(require(launcherPath), () => synchronousInspections);
  } finally {
    delete require.cache[launcherPath];
    Module._load = originalLoad;
  }
}

test('prevalidated plans cover every managed loader without synchronous inspect or rehash', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-prevalidated-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = [
    {
      family: 'vanilla',
      loaderVersion: '1.20.1',
      loader: { family: 'vanilla', serverJar: 'server.jar' },
      paths: ['server.jar'],
      expectedType: 'jar'
    },
    {
      family: 'fabric',
      loader: { family: 'fabric', launcherJar: 'fabric-server-launch.jar' },
      paths: ['fabric-server-launch.jar'],
      expectedType: 'jar'
    },
    {
      family: 'forge',
      loader: {
        family: 'forge',
        argsFile: 'libraries/net/minecraftforge/forge/1.20.1-test-loader/win_args.txt'
      },
      paths: [
        'libraries/net/minecraftforge/forge/1.20.1-test-loader/win_args.txt',
        'user_jvm_args.txt'
      ],
      expectedType: 'forge'
    },
    {
      family: 'neoforge',
      loader: {
        family: 'neoforge',
        argsFile: 'libraries/net/neoforged/neoforge/test-loader/win_args.txt',
        universalJar: 'libraries/net/neoforged/neoforge/test-loader/neoforge-test-loader-universal.jar'
      },
      paths: ['libraries/net/neoforged/neoforge/test-loader/win_args.txt'],
      expectedType: 'neoforge'
    },
    {
      family: 'quilt',
      loader: {
        family: 'quilt',
        launcherJar: 'quilt-server-launch.jar',
        properties: 'quilt-server-launcher.properties',
        libraries: [{
          coordinate: 'org.quiltmc:quilt-loader:test-loader',
          repository: 'https://maven.quiltmc.org/repository/release/',
          relativePath: 'libraries/org/quiltmc/quilt-loader/test-loader/quilt-loader-test-loader.jar'
        }]
      },
      paths: ['quilt-server-launch.jar'],
      expectedType: 'jar'
    }
  ];

  await withNoSynchronousRuntimeInspection(async (launcher, inspectionCount) => {
    assert.equal(typeof launcher.resolvePrevalidatedLaunchPlan, 'function');
    for (const fixture of fixtures) {
      const serverPath = path.join(root, fixture.family);
      fs.mkdirSync(serverPath);
      fixture.paths.forEach(relativePath => write(serverPath, relativePath));
      const exactRuntime = runtime(fixture.family, fixture.loaderVersion);
      const validation = {
        valid: true,
        runtime: exactRuntime,
        loader: fixture.loader,
        artifacts: fixture.paths.map(artifact)
      };
      const plan = launcher.resolvePrevalidatedLaunchPlan(serverPath, {
        loader: fixture.family,
        loaderVersion: exactRuntime.loaderVersion,
        maxRam: 4,
        minecraftVersion: exactRuntime.minecraftVersion,
        javaMajor: exactRuntime.javaMajor
      }, validation);
      assert.equal(plan.type, fixture.expectedType);
      assert.equal(plan.loader, fixture.family);
      assert.deepEqual(plan.runtime, exactRuntime);
    }
    assert.equal(inspectionCount(), 0);
  });
});

test('prevalidated plans fail closed on runtime identity mismatch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-prevalidated-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'server.jar');
  await withNoSynchronousRuntimeInspection(async launcher => {
    assert.throws(
      () => launcher.resolvePrevalidatedLaunchPlan(root, {
        loader: 'vanilla',
        loaderVersion: '1.20.2',
        maxRam: 4,
        minecraftVersion: '1.20.2',
        javaMajor: 17
      }, {
        valid: true,
        runtime: runtime('vanilla', '1.20.1'),
        loader: { family: 'vanilla', serverJar: 'server.jar' },
        artifacts: [artifact('server.jar')]
      }),
      error => error.code === 'RUNTIME_INCOMPLETE'
    );
  });
});

test('Windows response-file runtimes reject an overlong launch path with a retryable destination error', async t => {
  if (process.platform !== 'win32') {
    t.skip('Windows response-file path behavior');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-overlong-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'x'.repeat(130));
  const fixtures = [
    {
      family: 'forge',
      argsFile: 'libraries/net/minecraftforge/forge/1.20.1-test-loader/win_args.txt',
      loader: {
        family: 'forge',
        argsFile: 'libraries/net/minecraftforge/forge/1.20.1-test-loader/win_args.txt'
      }
    },
    {
      family: 'neoforge',
      argsFile: 'libraries/net/neoforged/neoforge/test-loader/win_args.txt',
      loader: {
        family: 'neoforge',
        argsFile: 'libraries/net/neoforged/neoforge/test-loader/win_args.txt',
        universalJar: 'libraries/net/neoforged/neoforge/test-loader/neoforge-test-loader-universal.jar'
      }
    }
  ];

  await withNoSynchronousRuntimeInspection(async launcher => {
    for (const fixture of fixtures) {
      const exactRuntime = runtime(fixture.family);
      write(serverPath, fixture.argsFile);
      assert.ok(serverPath.length < 260);
      assert.ok(path.join(serverPath, ...fixture.argsFile.split('/')).length >= 260);
      assert.throws(
        () => launcher.resolvePrevalidatedLaunchPlan(serverPath, {
          loader: fixture.family,
          loaderVersion: exactRuntime.loaderVersion,
          maxRam: 4,
          minecraftVersion: exactRuntime.minecraftVersion,
          javaMajor: exactRuntime.javaMajor
        }, {
          valid: true,
          runtime: exactRuntime,
          loader: fixture.loader,
          artifacts: [artifact(fixture.argsFile)]
        }),
        error => error.code === 'SERVER_PATH_TOO_LONG' && error.retryable === true &&
          error.details?.field === 'serverPath' && !String(error.message).includes(serverPath)
      );
    }
  });
});

test('cheap prelaunch checks reject hard-link aliases and directory containment replacement', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-prevalidated-toctou-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const exactRuntime = runtime('vanilla', '1.20.1');
  const options = {
    loader: 'vanilla',
    loaderVersion: '1.20.1',
    maxRam: 4,
    minecraftVersion: '1.20.1',
    javaMajor: 17
  };

  await withNoSynchronousRuntimeInspection(async launcher => {
    const hardLinkRoot = path.join(base, 'hard-link-server');
    fs.mkdirSync(hardLinkRoot);
    write(hardLinkRoot, 'server.jar');
    fs.linkSync(path.join(hardLinkRoot, 'server.jar'), path.join(base, 'outside-alias.jar'));
    assert.throws(
      () => launcher.resolvePrevalidatedLaunchPlan(hardLinkRoot, options, {
        valid: true,
        runtime: exactRuntime,
        loader: { family: 'vanilla', serverJar: 'server.jar' },
        artifacts: [artifact('server.jar')]
      }),
      error => error.code === 'RUNTIME_INCOMPLETE'
    );

    const junctionRoot = path.join(base, 'junction-server');
    const outside = path.join(base, 'outside-runtime');
    fs.mkdirSync(junctionRoot);
    fs.mkdirSync(outside);
    write(outside, 'escape.jar');
    try {
      fs.symlinkSync(outside, path.join(junctionRoot, 'libraries'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return;
      throw error;
    }
    assert.throws(
      () => launcher.resolvePrevalidatedLaunchPlan(junctionRoot, {
        ...options,
        loader: 'fabric',
        loaderVersion: 'test-loader'
      }, {
        valid: true,
        runtime: runtime('fabric'),
        loader: { family: 'fabric', launcherJar: 'libraries/escape.jar' },
        artifacts: [artifact('libraries/escape.jar')]
      }),
      error => error.code === 'RUNTIME_INCOMPLETE'
    );
  });
});
