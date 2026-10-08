const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PersistentCandidateHashService,
  fileIdentityFromStat
} = require('../../electron/services/modpacks/planning/candidate-hash-service.cjs');

function fixture(t, prefix = 'minecraft-core-candidate-hash-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function identity(filePath) {
  return fileIdentityFromStat(fs.lstatSync(filePath, { bigint: true }));
}

test('persistent hash worker returns the exact SHA-256, size, and opened-file identity evidence', async t => {
  const root = fixture(t);
  const filePath = path.join(root, 'candidate.jar');
  const bytes = Buffer.from('immutable candidate bytes');
  fs.writeFileSync(filePath, bytes);
  const expectedIdentity = identity(filePath);
  const service = new PersistentCandidateHashService({ idleTimeoutMs: 25 });
  t.after(() => service.dispose());

  const measured = await service.hashFile(filePath, { expectedIdentity });

  assert.deepEqual(measured, {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: String(bytes.length),
    identity: expectedIdentity
  });
});

test('hash worker rejects path substitution when the expected identity belongs to another regular file', async t => {
  const root = fixture(t);
  const expectedPath = path.join(root, 'expected.jar');
  const substitutedPath = path.join(root, 'substituted.jar');
  fs.writeFileSync(expectedPath, 'same-size-content');
  fs.writeFileSync(substitutedPath, 'same-size-content');
  const service = new PersistentCandidateHashService({ idleTimeoutMs: 25 });
  t.after(() => service.dispose());

  await assert.rejects(
    service.hashFile(substitutedPath, { expectedIdentity: identity(expectedPath) }),
    error => error?.code === 'CANDIDATE_HASH_FAILED'
  );
});

test('large candidate hashing leaves the main event loop responsive', async t => {
  const root = fixture(t, 'minecraft-core-candidate-hash-heartbeat-');
  const filePath = path.join(root, 'large-candidate.bin');
  fs.closeSync(fs.openSync(filePath, 'w'));
  fs.truncateSync(filePath, 128 * 1024 * 1024);
  const service = new PersistentCandidateHashService({ idleTimeoutMs: 25 });
  t.after(() => service.dispose());
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 1);

  try {
    const measured = await service.hashFile(filePath, { expectedIdentity: identity(filePath) });
    assert.equal(measured.size, String(128 * 1024 * 1024));
    assert.ok(ticks >= 2, `expected event-loop heartbeats during hashing, received ${ticks}`);
  } finally {
    clearInterval(heartbeat);
  }
});

test('aborting a hash request terminates its worker and rejects with AbortError', async t => {
  const root = fixture(t, 'minecraft-core-candidate-hash-abort-');
  const filePath = path.join(root, 'large-candidate.bin');
  fs.closeSync(fs.openSync(filePath, 'w'));
  fs.truncateSync(filePath, 512 * 1024 * 1024);
  const service = new PersistentCandidateHashService({ idleTimeoutMs: 25 });
  t.after(() => service.dispose());
  const controller = new AbortController();
  const pending = service.hashFile(filePath, {
    expectedIdentity: identity(filePath),
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(pending, error => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
});

test('a worker crash fails closed without returning a digest', async t => {
  const root = fixture(t, 'minecraft-core-candidate-hash-crash-');
  const filePath = path.join(root, 'candidate.jar');
  fs.writeFileSync(filePath, 'candidate');
  const service = new PersistentCandidateHashService({
    workerPath: path.join(__dirname, 'fixtures', 'crashing-candidate-hash-worker.cjs'),
    idleTimeoutMs: 25
  });
  t.after(() => service.dispose());

  await assert.rejects(
    service.hashFile(filePath, { expectedIdentity: identity(filePath) }),
    error => error?.code === 'CANDIDATE_HASH_WORKER_UNAVAILABLE'
  );
});

test('worker startup failure fails closed and never invokes a local hashing fallback', async t => {
  const root = fixture(t, 'minecraft-core-candidate-hash-no-fallback-');
  const filePath = path.join(root, 'candidate.jar');
  fs.writeFileSync(filePath, 'candidate');
  let factoryCalls = 0;
  const service = new PersistentCandidateHashService({
    workerFactory() {
      factoryCalls += 1;
      throw new Error('worker unavailable');
    },
    idleTimeoutMs: 25
  });
  t.after(() => service.dispose());

  await assert.rejects(
    service.hashFile(filePath, { expectedIdentity: identity(filePath) }),
    error => error?.code === 'CANDIDATE_HASH_WORKER_UNAVAILABLE'
  );
  assert.equal(factoryCalls, 1);
});

test('candidate preparer delegates hashing and contains no main-process digest fallback', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    '..',
    'electron',
    'services',
    'modpacks',
    'planning',
    'production-candidate-preparer.cjs'
  ), 'utf8');
  assert.match(source, /candidate-hash-service\.cjs/u);
  assert.doesNotMatch(source, /node:crypto|createHash\s*\(/u);
});
