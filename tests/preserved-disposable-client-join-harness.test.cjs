const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

let continuation = {};
try {
  continuation = require('./e2e/fixtures/preserved-disposable-client-join-harness.cjs');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
}

test('preserved disposable client continuation requires both the join opt-in and one explicit root', () => {
  const rootEnvironmentKey = 'MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_CONTINUATION_ROOT';
  const joinEnvironmentKey = 'MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E';
  const explicitRoot = 'C:\\Temp\\minecraft-core-real-modrinth-e2e-fixture';

  assert.equal(typeof continuation.isPreservedDisposableClientJoinEnabled, 'function');
  assert.equal(continuation.isPreservedDisposableClientJoinEnabled({}), false);
  assert.equal(continuation.isPreservedDisposableClientJoinEnabled({
    [joinEnvironmentKey]: '1'
  }), false);
  assert.equal(continuation.isPreservedDisposableClientJoinEnabled({
    [rootEnvironmentKey]: explicitRoot
  }), false);
  assert.equal(continuation.isPreservedDisposableClientJoinEnabled({
    [joinEnvironmentKey]: 'true',
    [rootEnvironmentKey]: explicitRoot
  }), true);
});

test('preserved client records bind the exact managed server and synthetic client to the validated scratch paths', () => {
  const root = path.resolve('C:\\Temp\\minecraft-core-real-modrinth-e2e-fixture');
  const lifecycle = {
    root,
    instanceId: 'server-fixture',
    serverPath: path.join(root, 'server'),
    clientPath: path.join(root, 'client')
  };
  const state = {
    modpackManaged: true,
    source: { provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF' },
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.15.10' }
  };
  const config = {
    lastServerPath: lifecycle.serverPath,
    instances: [
      { id: lifecycle.instanceId, type: 'server', path: lifecycle.serverPath },
      {
        id: 'disposable-client-join-e2e',
        type: 'client',
        path: lifecycle.clientPath,
        name: 'E2E_001122334455',
        serverIp: '127.0.0.1',
        serverPort: '49152'
      }
    ]
  };
  const auth = {
    access_token: 'enc:access',
    client_token: 'enc:client',
    uuid: '00000000-0000-0000-0000-000000000001',
    name: 'E2E_001122334455',
    xmcl_tokens: {
      microsoft: { access_token: 'enc:microsoft', refresh_token: 'enc:refresh' }
    }
  };

  assert.equal(typeof continuation.validatePreservedClientRecords, 'function');
  assert.deepEqual(continuation.validatePreservedClientRecords(lifecycle, { state, config, auth }), {
    priorUsername: 'E2E_001122334455',
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.15.10' }
  });
  const preFixClientName = 'E2E_aabbccddeeff';
  const preFixConfig = {
    ...config,
    instances: [config.instances[0], { ...config.instances[1], clientName: preFixClientName }]
  };
  const preFixAuth = { ...auth, name: preFixClientName };
  assert.deepEqual(continuation.validatePreservedClientRecords(lifecycle, {
    state,
    config: preFixConfig,
    auth: preFixAuth
  }), {
    priorUsername: preFixClientName,
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.15.10' }
  });
  assert.throws(
    () => continuation.validatePreservedClientRecords(lifecycle, {
      state,
      config: {
        ...preFixConfig,
        instances: [preFixConfig.instances[0], { ...preFixConfig.instances[1], clientName: 'ordinary-client' }]
      },
      auth: { ...preFixAuth, name: 'ordinary-client' }
    }),
    /synthetic identity|expected encrypted/iu
  );
  assert.throws(
    () => continuation.validatePreservedClientRecords(lifecycle, {
      state,
      config: preFixConfig,
      auth: { ...preFixAuth, name: 'E2E_ffeeddccbbaa' }
    }),
    /synthetic identity|expected encrypted/iu
  );
  assert.throws(
    () => continuation.validatePreservedClientRecords(lifecycle, {
      state,
      config: {
        ...config,
        instances: [config.instances[0], { ...config.instances[1], path: path.join(root, '..', 'user-client') }]
      },
      auth
    }),
    /validated scratch client|outside/iu
  );
});

test('pinned preserved MRPACK reads only the exact digest-addressed cache object', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-real-modrinth-e2e-cache-test-'));
  const clientPath = path.join(root, 'client');
  const sha256 = '6fd31d070496c1087250485d73216adfd3b4041dcbeab8c479f058a9bdd4888f';
  const sha512 = '46fbed1f25b0d777a354d2935f494377d49dafad565ad64ccf45b4e2f7904390af8514f79c55978bf87be3e19332a661451a4037510a7cfd7ff68da5e981d4d8';
  const cachePath = path.join(root, 'client-pack-cache', 'sha256', sha256.slice(0, 2), sha256);
  const lifecycle = { root, clientPath };
  try {
    await fs.mkdir(clientPath);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, 'cached-mrpack');

    assert.equal(typeof continuation.readPinnedCachedArchive, 'function');
    const archive = await continuation.readPinnedCachedArchive(lifecycle, {
      sha256,
      sha512,
      size: 13
    });
    assert.equal(archive.toString('utf8'), 'cached-mrpack');

    await fs.writeFile(cachePath, 'changed-cache');
    await assert.rejects(
      continuation.readPinnedCachedArchive(lifecycle, { sha256, sha512, size: 13 }),
      /digest|size|pinned/iu
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preserved client projection requires the exact immutable mod file set and hashes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-real-modrinth-e2e-pack-test-'));
  const clientPath = path.join(root, 'client');
  const modPath = path.join(clientPath, 'mods', 'preserved.jar');
  const lifecycle = { root, clientPath };
  const projection = {
    type: 'mrpack-client-projection',
    manifestVersionId: '1.20.1',
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.15.10' },
    downloads: [{
      targetPath: 'mods/preserved.jar',
      size: '20',
      hashes: {
        sha1: '2a76dcda90419f2b866d65e97f0ef7aef621d845',
        sha512: '03f21501bb8b61c88110d4d08c0220b5817b73c62f7b480edb11aeb42fa9f46b5509895f72d21b316a8fae3cb209646c1fb06c9868baeccf08e74d3eba0a1059'
      }
    }],
    overrideOperations: []
  };
  try {
    await fs.mkdir(path.dirname(modPath), { recursive: true });
    await fs.writeFile(modPath, 'preserved-client-mod');

    assert.equal(typeof continuation.verifyPreservedClientProjection, 'function');
    await assert.doesNotReject(continuation.verifyPreservedClientProjection(lifecycle, projection));

    await fs.writeFile(path.join(clientPath, 'mods', 'unreviewed.jar'), 'unreviewed');
    await assert.rejects(
      continuation.verifyPreservedClientProjection(lifecycle, projection),
      /exact.*mod|mod.*set/iu
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('asset audit reports corrupt and missing immutable objects without modifying the preserved client', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-real-modrinth-e2e-assets-test-'));
  const clientPath = path.join(root, 'client');
  const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.15.10' };
  const objects = {
    'fixture/valid': { hash: 'c48c0a71ff42c8fb1ff50828e13ed07e4512a881', size: 11 },
    'fixture/truncated': { hash: 'a25dea04658b08299febb4a25122473db26a3a31', size: 18 },
    'fixture/missing': { hash: '53be7a0a08a2bd4995c18ac432a92adf62c27acd', size: 16 },
    'fixture/empty': { hash: '79904204cb5e32a4e51baf8df23863a140c8f1a0', size: 21 }
  };
  const indexBytes = Buffer.from(JSON.stringify({ objects }));
  const indexSha1 = crypto.createHash('sha1').update(indexBytes).digest('hex');
  const versionPath = path.join(clientPath, 'versions', '1.20.1', '1.20.1.json');
  const indexPath = path.join(clientPath, 'assets', 'indexes', 'fixture.json');
  const indexCachePath = path.join(clientPath, 'assets', 'indexes', `${indexSha1}.json`);
  const objectPath = hash => path.join(clientPath, 'assets', 'objects', hash.slice(0, 2), hash);
  const lifecycle = { root, clientPath };
  try {
    await fs.mkdir(path.dirname(versionPath), { recursive: true });
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(versionPath, JSON.stringify({
      id: '1.20.1',
      assets: 'fixture',
      assetIndex: {
        id: 'fixture',
        sha1: indexSha1,
        size: indexBytes.length,
        totalSize: 66,
        url: `https://piston-meta.mojang.com/v1/packages/${indexSha1}/fixture.json`
      }
    }));
    await fs.writeFile(indexPath, indexBytes);
    await fs.writeFile(indexCachePath, 'partial-index');
    await fs.mkdir(path.dirname(objectPath(objects['fixture/valid'].hash)), { recursive: true });
    await fs.writeFile(objectPath(objects['fixture/valid'].hash), 'valid-asset');
    await fs.mkdir(path.dirname(objectPath(objects['fixture/truncated'].hash)), { recursive: true });
    await fs.writeFile(objectPath(objects['fixture/truncated'].hash), 'part');
    await fs.mkdir(path.dirname(objectPath(objects['fixture/empty'].hash)), { recursive: true });
    await fs.writeFile(objectPath(objects['fixture/empty'].hash), '');

    assert.equal(typeof continuation.auditClientAssets, 'function');
    const audit = await continuation.auditClientAssets(lifecycle, runtime);
    assert.deepEqual({
      indexEntryCount: audit.indexEntryCount,
      assetObjectCount: audit.assetObjectCount,
      validAssetObjectCount: audit.validAssetObjectCount,
      totalSize: audit.totalSize,
      indexCacheValid: audit.indexCacheValid,
      invalid: audit.invalid.map(entry => ({ hash: entry.hash, reason: entry.reason }))
    }, {
      indexEntryCount: 4,
      assetObjectCount: 4,
      validAssetObjectCount: 1,
      totalSize: 66,
      indexCacheValid: false,
      invalid: [
        { hash: '53be7a0a08a2bd4995c18ac432a92adf62c27acd', reason: 'missing' },
        { hash: '79904204cb5e32a4e51baf8df23863a140c8f1a0', reason: 'digest-or-size' },
        { hash: 'a25dea04658b08299febb4a25122473db26a3a31', reason: 'digest-or-size' }
      ]
    });
    assert.equal((await fs.readFile(objectPath(objects['fixture/truncated'].hash), 'utf8')), 'part');
    assert.equal((await fs.stat(objectPath(objects['fixture/empty'].hash))).size, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preserved retry accepts only the characterized partial, missing, or fully repaired prelaunch states', () => {
  const audit = {
    assetIndexId: '5',
    assetIndexSha1: '7c4533d4bec68552b39668ce65cdd5cabfe68351',
    indexEntryCount: 3598,
    assetObjectCount: 3575,
    validAssetObjectCount: 3571,
    totalSize: 650087741,
    indexCacheValid: false,
    indexCacheActualSize: 395077,
    indexCacheActualSha1: 'f34a1ef1623d09e3a3081ebcf1a23622349db6d3',
    invalid: [
      { hash: '8b2a57294e9f57a1e3ea28c1cc601762af2b63c4', reason: 'digest-or-size' },
      { hash: 'e12154ca862546b6f91db32596bfb587a1c1cf77', reason: 'digest-or-size' },
      { hash: '97b52210f12181c96547f94dda806a9a3ff838a5', reason: 'digest-or-size' },
      { hash: 'c1c3b7233b080ffc17389af8b68a46b2df798ef1', reason: 'digest-or-size' }
    ]
  };

  assert.equal(typeof continuation.assertExpectedPreservedPartialAssets, 'function');
  assert.equal(continuation.assertExpectedPreservedPartialAssets(audit), true);
  assert.throws(
    () => continuation.assertExpectedPreservedPartialAssets({
      ...audit,
      invalid: audit.invalid.slice(0, 3)
    }),
    /four|characterized|asset/iu
  );
  assert.throws(
    () => continuation.assertExpectedPreservedPartialAssets({ ...audit, indexCacheValid: true }),
    /characterized|asset|index/iu
  );

  const repairedCacheWithFourMissingObjects = {
    ...audit,
    indexCacheValid: true,
    indexCacheActualSize: 413067,
    indexCacheActualSha1: '7c4533d4bec68552b39668ce65cdd5cabfe68351',
    invalid: audit.invalid.map(entry => ({ ...entry, reason: 'missing' }))
  };
  assert.equal(typeof continuation.assertExpectedPreservedPrelaunchAssets, 'function');
  assert.equal(continuation.assertExpectedPreservedPrelaunchAssets(audit), true);
  assert.equal(continuation.assertExpectedPreservedPrelaunchAssets(repairedCacheWithFourMissingObjects), true);
  const truncatedCacheWithFourMissingObjects = {
    ...repairedCacheWithFourMissingObjects,
    indexCacheValid: false,
    indexCacheActualSize: 395077,
    indexCacheActualSha1: 'f34a1ef1623d09e3a3081ebcf1a23622349db6d3'
  };
  assert.equal(continuation.assertExpectedPreservedPrelaunchAssets(truncatedCacheWithFourMissingObjects), true);
  for (const unexpected of [
    {
      ...repairedCacheWithFourMissingObjects,
      invalid: repairedCacheWithFourMissingObjects.invalid.slice(0, 3)
    },
    {
      ...repairedCacheWithFourMissingObjects,
      invalid: repairedCacheWithFourMissingObjects.invalid.map((entry, index) => (
        index === 0 ? { ...entry, reason: 'digest-or-size' } : entry
      ))
    },
    {
      ...repairedCacheWithFourMissingObjects,
      invalid: repairedCacheWithFourMissingObjects.invalid.map((entry, index) => (
        index === 0 ? { ...entry, hash: '0'.repeat(40) } : entry
      ))
    },
    {
      ...repairedCacheWithFourMissingObjects,
      validAssetObjectCount: 3570
    }
  ]) {
    assert.throws(
      () => continuation.assertExpectedPreservedPrelaunchAssets(unexpected),
      /characterized|prelaunch|asset|index/iu
    );
  }

  const repaired = {
    ...audit,
    validAssetObjectCount: 3575,
    indexCacheValid: true,
    indexCacheActualSize: 413067,
    indexCacheActualSha1: '7c4533d4bec68552b39668ce65cdd5cabfe68351',
    invalid: []
  };
  assert.equal(continuation.assertExpectedPreservedPrelaunchAssets(repaired), true);
  assert.equal(continuation.assertExpectedPreservedPrelaunchAssets({
    ...repaired,
    indexCacheValid: false,
    indexCacheActualSize: 395077,
    indexCacheActualSha1: 'f34a1ef1623d09e3a3081ebcf1a23622349db6d3'
  }), true);
  assert.equal(typeof continuation.assertExpectedRepairedAssets, 'function');
  assert.equal(continuation.assertExpectedRepairedAssets(repaired), true);
  assert.equal(continuation.assertExpectedRepairedAssets({
    ...repaired,
    indexCacheValid: false,
    indexCacheActualSize: 395077,
    indexCacheActualSha1: 'f34a1ef1623d09e3a3081ebcf1a23622349db6d3'
  }), true);
  assert.throws(
    () => continuation.assertExpectedRepairedAssets({ ...repaired, validAssetObjectCount: 3574 }),
    /repaired|asset/iu
  );
  assert.throws(
    () => continuation.assertExpectedRepairedAssets({
      ...repaired,
      indexCacheValid: false,
      indexCacheActualSize: 395076,
      indexCacheActualSha1: 'f34a1ef1623d09e3a3081ebcf1a23622349db6d3'
    }),
    /repaired|asset|index/iu
  );
});

test('preserved lifecycle loading refuses a matching-looking scratch tree without the pinned client pack cache', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-real-modrinth-e2e-client-load-test-'));
  const userDataPath = path.join(root, 'user-data');
  const serverPath = path.join(root, 'server');
  const clientPath = path.join(root, 'client');
  const evidencePath = path.join(root, 'evidence');
  const instanceId = 'server-load-fixture';
  try {
    await Promise.all([
      fs.mkdir(path.join(userDataPath, 'config'), { recursive: true }),
      fs.mkdir(path.join(serverPath, '.minecraft-core-state'), { recursive: true }),
      fs.mkdir(clientPath),
      fs.mkdir(evidencePath)
    ]);
    await fs.writeFile(path.join(root, 'real-lifecycle-identity.json'), JSON.stringify({
      provider: 'modrinth',
      harness: 'real-modpack'
    }));
    await fs.writeFile(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), JSON.stringify({
      modpackManaged: true,
      source: { provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF' },
      runtime: { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.15.10' }
    }));
    await fs.writeFile(path.join(userDataPath, 'config', 'minecraft-core-config.json'), JSON.stringify({
      lastServerPath: serverPath,
      instances: [
        { id: instanceId, type: 'server', path: serverPath },
        {
          id: 'disposable-client-join-e2e',
          type: 'client',
          path: clientPath,
          name: 'E2E_001122334455',
          serverIp: '127.0.0.1',
          serverPort: '49152'
        }
      ]
    }));
    await fs.writeFile(path.join(clientPath, 'xmcl-auth.json'), JSON.stringify({
      access_token: 'enc:access',
      client_token: 'enc:client',
      uuid: '00000000-0000-0000-0000-000000000001',
      name: 'E2E_001122334455',
      xmcl_tokens: { microsoft: { access_token: 'enc:microsoft', refresh_token: 'enc:refresh' } }
    }));

    assert.equal(typeof continuation.loadPreservedDisposableClientJoinLifecycle, 'function');
    await assert.rejects(
      continuation.loadPreservedDisposableClientJoinLifecycle(root),
      /pinned MRPACK cache|cache object/iu
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
