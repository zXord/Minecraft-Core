const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Module } = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const AdmZip = require('adm-zip');
const {
  ServerMutationCoordinator
} = require('../electron/services/server-mutation-coordinator.cjs');
const {
  runWithServerMutationLease,
  sharedServerMutationContext
} = require('../electron/services/server-mutation-context.cjs');

let fetchImplementation = async () => {
  throw new Error('unexpected Java download request');
};

function loadServerJavaManager() {
  const modulePath = path.resolve(__dirname, '../electron/services/server-java-manager.cjs');
  const javaManagerPath = path.resolve(__dirname, '../electron/services/minecraft-launcher/java-manager.cjs');
  const originalLoad = Module._load;

  delete require.cache[modulePath];
  delete require.cache[javaManagerPath];
  Module._load = function mockLoad(request, parent, isMain) {
    if (request.endsWith('../../utils/fetch.cjs')) {
      return { fetch: (...args) => fetchImplementation(...args) };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return require(modulePath).ServerJavaManager;
  } finally {
    Module._load = originalLoad;
  }
}

const ServerJavaManager = loadServerJavaManager();

function revisionFixture(serverPath, initialRevision = 7) {
  let revision = initialRevision;
  const bumps = [];
  const coordinator = new ServerMutationCoordinator({
    context: sharedServerMutationContext,
    readContentRevision: () => revision,
    bumpContentRevision(targetPath, options) {
      assert.equal(path.resolve(targetPath), path.resolve(serverPath));
      assert.equal(options.expectedRevision, revision);
      bumps.push({ ...options });
      revision += 1;
      return revision;
    }
  });
  coordinator.completeStartupRecovery([]);

  return {
    bumps,
    coordinator,
    getRevision: () => revision
  };
}

async function acquireStart(fixture, serverPath, operationId) {
  return fixture.coordinator.acquireStart(
    { instanceId: `java-${operationId}`, serverPath },
    { operation: 'server-start', operationId, parentMutationLease: null }
  );
}

function makeRuntimeArchive() {
  const zip = new AdmZip();
  zip.addFile('jdk/bin/java.exe', Buffer.from('java'));
  zip.addFile('jdk/bin/java', Buffer.from('java'));
  zip.addFile('jdk/bin/server/jvm.dll', Buffer.from('jvm'));
  return zip.toBuffer();
}

function downloadResponses(archiveBytes, checksum) {
  let requestNumber = 0;
  return async () => {
    requestNumber += 1;
    if (requestNumber === 1) {
      return {
        ok: true,
        async json() {
          return [{
            binary: {
              package: {
                checksum,
                link: 'https://downloads.example.test/runtime.zip',
                name: 'runtime.zip'
              }
            }
          }];
        }
      };
    }
    return {
      body: Readable.from([archiveBytes]),
      headers: { get: name => name === 'content-length' ? String(archiveBytes.length) : null },
      ok: true
    };
  };
}

test('an unchanged Java check is read-only and does not create or revise the server Java directory', async t => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-unchanged-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const fixture = revisionFixture(serverPath, 3);
  const lease = await acquireStart(fixture, serverPath, 'java-unchanged');

  await runWithServerMutationLease(lease, async () => {
    const manager = new ServerJavaManager(serverPath);
    assert.deepEqual(manager.getAvailableJavaVersions(), []);
    assert.equal(fs.existsSync(path.join(serverPath, 'java')), false);
  });
  lease.release();

  assert.equal(fixture.getRevision(), 3);
  assert.deepEqual(fixture.bumps, []);
});

test('creating a server Java runtime marks the start lease before extraction and revises once', async t => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-create-'));
  const archivePath = path.join(serverPath, 'runtime.zip');
  fs.writeFileSync(archivePath, makeRuntimeArchive());
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const fixture = revisionFixture(serverPath, 5);
  const lease = await acquireStart(fixture, serverPath, 'java-create');

  await runWithServerMutationLease(lease, async () => {
    const manager = new ServerJavaManager(serverPath);
    await manager.extractZip(archivePath, path.join(serverPath, 'java', 'java-17'));
  });
  lease.release();

  assert.equal(fixture.getRevision(), 6);
  assert.equal(fixture.bumps.length, 1);
  assert.ok(fs.existsSync(path.join(serverPath, 'java', 'java-17', 'bin')));
});

test('a completed server Java download revises exactly once despite multiple filesystem writes', async t => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-download-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const archiveBytes = makeRuntimeArchive();
  const checksum = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  fetchImplementation = downloadResponses(archiveBytes, checksum);
  const fixture = revisionFixture(serverPath, 11);
  const lease = await acquireStart(fixture, serverPath, 'java-download');

  let result;
  await runWithServerMutationLease(lease, async () => {
    result = await new ServerJavaManager(serverPath).downloadJava(17);
  });
  lease.release();

  assert.equal(result.success, true);
  assert.equal(fixture.getRevision(), 12);
  assert.equal(fixture.bumps.length, 1);
  assert.ok(fs.existsSync(result.javaPath));
});

test('a failed Java download after writing bytes still commits the dirty revision', async t => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-partial-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const archiveBytes = makeRuntimeArchive();
  fetchImplementation = downloadResponses(archiveBytes, '0'.repeat(64));
  const fixture = revisionFixture(serverPath, 19);
  const lease = await acquireStart(fixture, serverPath, 'java-partial-failure');

  await assert.rejects(
    runWithServerMutationLease(lease, async () => {
      await new ServerJavaManager(serverPath).downloadJava(17);
    }),
    /checksum verification failed/
  );
  lease.release();

  assert.equal(fixture.getRevision(), 20);
  assert.equal(fixture.bumps.length, 1);
});
