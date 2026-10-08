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

test('the inventory scanner ignores read-only opens and unrelated write methods', () => {
  const fixture = 'fixture.cjs';
  const reviewedSource = 'async function readOnly() { return true; }';
  const reviewedDigest = computeWriteSiteDigest(reviewedSource);
  const nonMutations = [
    "await fs.promises.open('artifact.bin', 'r');",
    "fs.openSync('artifact.bin', 'rs');",
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
