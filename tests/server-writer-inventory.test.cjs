const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SERVER_WRITER_HANDLER_FILES,
  SERVER_WRITER_WRITE_SITE_DIGESTS,
  computeWriteSiteDigest,
  scanUnaccountedWriteSites,
  scanUnaccountedWriterChannels
} = require('../electron/services/server-writer-inventory.cjs');
const {
  SERVER_WRITER_POLICIES
} = require('../electron/services/server-mutation-policy.cjs');

const repositoryRoot = path.resolve(__dirname, '..');

test('registered filesystem writers are inventoried or explicitly ancillary', () => {
  assert.deepEqual(scanUnaccountedWriteSites({
    repositoryRoot,
    readFile: filePath => fs.readFileSync(filePath, 'utf8'),
    expectedDigests: SERVER_WRITER_WRITE_SITE_DIGESTS
  }), []);
});

test('registered mutating channels have a closed policy or reviewed ancillary classification', () => {
  assert.deepEqual(scanUnaccountedWriterChannels({
    repositoryRoot,
    readFile: filePath => fs.readFileSync(filePath, 'utf8'),
    handlerFiles: SERVER_WRITER_HANDLER_FILES,
    policies: SERVER_WRITER_POLICIES
  }), []);
});

test('the inventory scanner reports a newly introduced write site', () => {
  const result = scanUnaccountedWriteSites({
    repositoryRoot,
    expectedDigests: { 'fixture.cjs': 'reviewed' },
    readFile: () => "async function mutate() { await fs.writeFile('new.txt', 'x'); }"
  });
  assert.deepEqual(result, ['fixture.cjs']);
});

test('the inventory scanner covers descriptor and file-handle writes', () => {
  const fixture = 'fixture.cjs';
  const reviewedSource = 'async function readOnly() { return true; }';
  const reviewedDigest = computeWriteSiteDigest(reviewedSource);
  const mutations = [
    "const fileHandle = await fs.promises.open('artifact.part', 'wx');",
    "const descriptor = fs.openSync('artifact.part', 'r+');",
    "const joinedDescriptor = fs.openSync(path.join(root, 'artifact.part'), 'wx');",
    "fsApi.mkdirSync('staging', { recursive: false });",
    "await fileHandle.write(Buffer.from('x'));",
    "await fileHandle?.write(Buffer.from('x'));",
    "await fileHandle.writeFile(Buffer.from('x'));",
    'await fileHandle.truncate(0);',
    'fs.writeSync(descriptor, Buffer.from(\'x\'));'
  ];

  for (const mutation of mutations) {
    const result = scanUnaccountedWriteSites({
      repositoryRoot,
      expectedDigests: { [fixture]: reviewedDigest },
      readFile: () => `${reviewedSource}\n${mutation}\n`
    });

    assert.deepEqual(result, [fixture], mutation);
  }
});

test('the inventory scanner covers computed open flags, durable publication, revision restores and zip writes', () => {
  const fixture = 'fixture.cjs';
  const reviewedSource = 'async function readOnly() { return true; }';
  const reviewedDigest = computeWriteSiteDigest(reviewedSource);
  const mutations = [
    'descriptor = fsApi.openSync(filePath, flag);',
    'const handle = await fs.promises.open(path.join(root, name), flags);',
    'fsApi.ftruncateSync(descriptor, bytes.length);',
    'durableFs.writeJsonAtomic(configPath, planned.normalized, { expectedTargetSha256 });',
    'await this.durableFs.writeJsonAtomicAsync(target, value);',
    'durableFs?.writeFileAtomic(target, bytes);',
    'const preservedPath = durableFs.preserveUnreadable(configPath, bytes);',
    'await durable.renameDurableAsync(source, destination);',
    'restoreContentRevision(serverPath, preRestoreRevision);',
    'zip.extractAllTo(serverPath, true);',
    'archive.writeZip(fabricJarPath);'
  ];

  for (const mutation of mutations) {
    const result = scanUnaccountedWriteSites({
      repositoryRoot,
      expectedDigests: { [fixture]: reviewedDigest },
      readFile: () => `${reviewedSource}\n${mutation}\n`
    });

    assert.deepEqual(result, [fixture], mutation);
  }
});

test('the inventory scanner ignores read-only opens and unrelated write methods', () => {
  const fixture = 'fixture.cjs';
  const reviewedSource = 'async function readOnly() { return true; }';
  const reviewedDigest = computeWriteSiteDigest(reviewedSource);
  const nonMutations = [
    "await fs.promises.open('artifact.bin', 'r');",
    "fs.openSync('artifact.bin', 'rs');",
    "fs.openSync(path.join(root, name), 'r');",
    'await fs.promises.open(filePath);',
    'descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);',
    'descriptor = fsApi.openSync(resolved, fsApi.constants.O_RDONLY);',
    "res.write('x');",
    "socket.write('x');",
    "buffer.write('x');"
  ];

  for (const nonMutation of nonMutations) {
    const result = scanUnaccountedWriteSites({
      repositoryRoot,
      expectedDigests: { [fixture]: reviewedDigest },
      readFile: () => `${reviewedSource}\n${nonMutation}\n`
    });

    assert.deepEqual(result, [], nonMutation);
  }
});

test('the inventory scanner covers writes introduced in the Electron main entry point', () => {
  const mainEntry = 'electron/main.cjs';
  const result = scanUnaccountedWriteSites({
    repositoryRoot,
    expectedDigests: SERVER_WRITER_WRITE_SITE_DIGESTS,
    readFile: filePath => {
      const source = fs.readFileSync(filePath, 'utf8');
      return path.relative(repositoryRoot, filePath).replaceAll('\\', '/') === mainEntry
        ? `${source}\nfs.writeFileSync('uncoordinated-startup-write', 'x');\n`
        : source;
    }
  });

  assert.deepEqual(result, [mainEntry]);
});

test('instance configuration writers added in the 26.11 fix wave are closed by the write-site inventory', () => {
  for (const relativePath of [
    'electron/utils/instance-config-fs.cjs',
    'electron/bootstrap/create-degraded-modpack-fallbacks.cjs',
    'electron/services/modpacks/instance-ownership.cjs',
    'electron/services/modpack-lifecycle/live-server-folder-probe.cjs',
    'electron/services/server-launcher.cjs'
  ]) {
    assert.equal(typeof SERVER_WRITER_WRITE_SITE_DIGESTS[relativePath], 'string', relativePath);
  }

  // Each edit changes only a write site the earlier patterns could not see.
  const changedWrites = new Map([
    [
      'electron/utils/instance-config-fs.cjs',
      ['descriptor = fsApi.openSync(filePath, flag);', 'descriptor = fsApi.openSync(filePath, flag, 0o666);']
    ],
    [
      'electron/services/backup-service.cjs',
      ['restoreContentRevision(serverPath, preRestoreRevision);', 'restoreContentRevision(serverPath, preRestoreRevision + 1);']
    ],
    [
      'electron/utils/config-manager.cjs',
      ['const preservedPath = durableFs.preserveUnreadable(configPath, bytes);', 'const preservedPath = durableFs.preserveUnreadable(configPath, Buffer.from(bytes));']
    ]
  ]);

  for (const [relativePath, [reviewed, changed]] of changedWrites) {
    const result = scanUnaccountedWriteSites({
      repositoryRoot,
      expectedDigests: SERVER_WRITER_WRITE_SITE_DIGESTS,
      readFile: filePath => {
        const source = fs.readFileSync(filePath, 'utf8');
        if (path.relative(repositoryRoot, filePath).replaceAll('\\', '/') !== relativePath) return source;
        assert.ok(source.includes(reviewed), `${relativePath} no longer contains: ${reviewed}`);
        return source.replace(reviewed, changed);
      }
    });

    assert.deepEqual(result, [relativePath], relativePath);
  }
});

test('loader-mediated child server writers remain closed by the write-site inventory', () => {
  const mediatedMutations = new Map([
    [
      'electron/services/forge-runtime-finalizer-worker.cjs',
      "require('./loader-install-service.cjs').__testUtils.finalizeForgeRuntimeMetadata(targetPath, runtime);"
    ],
    [
      'electron/services/managed-runtime-worker.cjs',
      "require('./loader-install-service.cjs').__testUtils.prepareManagedServerRuntimeInProcess({ targetPath, runtime, javaPath });"
    ]
  ]);

  for (const [entrypoint, mutation] of mediatedMutations) {
    const result = scanUnaccountedWriteSites({
      repositoryRoot,
      expectedDigests: SERVER_WRITER_WRITE_SITE_DIGESTS,
      readFile: filePath => {
        const source = fs.readFileSync(filePath, 'utf8');
        return path.relative(repositoryRoot, filePath).replaceAll('\\', '/') === entrypoint
          ? `${source}\n${mutation}\n`
          : source;
      }
    });

    assert.deepEqual(result, [entrypoint], entrypoint);
  }
});

test('the channel scanner reports an unclassified mutating registration', () => {
  const result = scanUnaccountedWriterChannels({
    repositoryRoot,
    handlerFiles: ['fixture.cjs'],
    policies: {},
    readFile: () => "function createHandlers() { return { 'new-writer': async () => fs.writeFile('x', 'y') }; }"
  });
  assert.deepEqual(result, ['new-writer']);
});
