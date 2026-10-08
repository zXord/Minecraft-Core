const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let marker;
try {
  marker = require('./e2e/fixtures/real-modpack-crash-marker.cjs');
} catch {
  marker = {};
}

test('Playwright crash arming uses the Electron main process built-in module authority', () => {
  const source = fs.readFileSync(path.join(__dirname, 'e2e', 'real-modpack-crash-recovery.spec.js'), 'utf8');
  const start = source.indexOf('async function armHardCrashAfterCanonicalMove');
  const end = source.indexOf('\ntest.describe(', start);
  assert.ok(start >= 0 && end > start);
  const boundary = source.slice(start, end);
  assert.match(boundary, /process\.getBuiltinModule\(['"]node:module['"]\)/u);
  assert.match(boundary, /createRequire\(/u);
  assert.doesNotMatch(boundary, /\brequire\s*\(/u);
});

test('pinned crash marker writes and syncs the exact file opened while arming', async () => {
  assert.equal(typeof marker.openPinnedCrashMarker, 'function');
  assert.equal(typeof marker.writePinnedCrashMarker, 'function');
  assert.equal(typeof marker.closePinnedCrashMarker, 'function');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-crash-marker-tests-'));
  const markerPath = path.join(root, 'hard-crash-fired.json');
  await fsp.writeFile(markerPath, JSON.stringify({ fired: false, rollbackName: null }), 'utf8');
  const pin = marker.openPinnedCrashMarker(markerPath);
  try {
    marker.writePinnedCrashMarker(pin, {
      fired: true,
      rollbackName: '.server.minecraft-core.job-test.rollback'
    });
  } finally {
    marker.closePinnedCrashMarker(pin);
  }
  assert.deepEqual(JSON.parse(await fsp.readFile(markerPath, 'utf8')), {
    fired: true,
    rollbackName: '.server.minecraft-core.job-test.rollback'
  });
  await fsp.rm(root, { recursive: true, force: true });
});

test('pinned crash marker fails closed if its pathname is rebound before the crash boundary', async () => {
  assert.equal(typeof marker.openPinnedCrashMarker, 'function');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-crash-marker-tests-'));
  const markerPath = path.join(root, 'hard-crash-fired.json');
  const movedPath = path.join(root, 'original-marker.json');
  const redirectTarget = path.join(root, 'unrelated.json');
  await fsp.writeFile(markerPath, JSON.stringify({ fired: false, rollbackName: null }), 'utf8');
  await fsp.writeFile(redirectTarget, 'do-not-touch', 'utf8');
  const pin = marker.openPinnedCrashMarker(markerPath);
  try {
    await fsp.rename(markerPath, movedPath);
    await fsp.link(redirectTarget, markerPath);
    assert.throws(
      () => marker.writePinnedCrashMarker(pin, {
        fired: true,
        rollbackName: '.server.minecraft-core.job-test.rollback'
      }),
      /changed after it was armed/iu
    );
    assert.equal(await fsp.readFile(redirectTarget, 'utf8'), 'do-not-touch');
  } finally {
    marker.closePinnedCrashMarker(pin);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('crash marker refuses malformed or multiply-linked marker files before arming', async () => {
  assert.equal(typeof marker.openPinnedCrashMarker, 'function');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-crash-marker-tests-'));
  const malformedPath = path.join(root, 'malformed.json');
  const linkedPath = path.join(root, 'linked.json');
  await fsp.writeFile(malformedPath, JSON.stringify({ fired: true, rollbackName: null }), 'utf8');
  assert.throws(() => marker.openPinnedCrashMarker(malformedPath), /not armed/iu);
  await fsp.writeFile(linkedPath, JSON.stringify({ fired: false, rollbackName: null }), 'utf8');
  await fsp.link(linkedPath, path.join(root, 'second-link.json'));
  assert.throws(() => marker.openPinnedCrashMarker(linkedPath), /linked or redirected/iu);
  await fsp.rm(root, { recursive: true, force: true });
});

test('marker write failure closes the pin and terminates the disposable process without waiting', () => {
  assert.equal(typeof marker.firePinnedCrashMarkerAndTerminate, 'function');
  const failure = new Error('fsync failed');
  const calls = [];
  assert.throws(
    () => marker.firePinnedCrashMarkerAndTerminate({ descriptor: 1 }, {
      fired: true,
      rollbackName: '.server.minecraft-core.job-test.rollback'
    }, {
      writePinnedCrashMarker() { calls.push('write'); throw failure; },
      closePinnedCrashMarker() { calls.push('close'); },
      terminateProcess() { calls.push('terminate'); }
    }),
    error => error === failure
  );
  assert.deepEqual(calls, ['write', 'close', 'terminate']);
});
