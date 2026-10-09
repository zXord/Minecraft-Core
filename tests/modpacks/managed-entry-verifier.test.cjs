const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyManagedEntry } = require('../../electron/services/modpacks/state/managed-entry-verifier.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-managed-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jar = path.join(root, 'pack.jar'); fs.writeFileSync(jar, 'pack');
  const entry = { path: 'pack.jar', size: '4', installedHash: '4862f447f2c7f272fa2f4aaf89dadb3b1ac09105bd5864f8d1a0c9452bb0a226' };
  return { root, jar, entry };
}

test('shared verifier hashes real bytes and distinguishes missing, modified and unsafe entries', async t => {
  const f = fixture(t);
  assert.equal((await verifyManagedEntry(f.root, f.entry)).status, 'matched');
  fs.writeFileSync(f.jar, 'evil'); assert.equal((await verifyManagedEntry(f.root, f.entry)).status, 'modified');
  fs.unlinkSync(f.jar); assert.equal((await verifyManagedEntry(f.root, f.entry)).status, 'missing');
  fs.mkdirSync(f.jar); assert.equal((await verifyManagedEntry(f.root, f.entry)).status, 'unsafe');
});

test('shared verifier refuses an actual same-size edit between pre-path and open evidence', async t => {
  const f = fixture(t);
  const fsPromises = { async open(...args) { fs.writeFileSync(f.jar, 'evil'); return fs.promises.open(...args); } };
  await assert.rejects(verifyManagedEntry(f.root, f.entry, { fsPromises }), { code: 'PLAN_STALE' });
});

test('shared verifier refuses an actual edit after read before final path evidence', async t => {
  const f = fixture(t);
  const fsPromises = { async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: (...values) => handle.stat(...values), read: (...values) => handle.read(...values),
      async close() { await handle.close(); fs.writeFileSync(f.jar, 'evil'); } };
  } };
  await assert.rejects(verifyManagedEntry(f.root, f.entry, { fsPromises }), { code: 'PLAN_STALE' });
});
