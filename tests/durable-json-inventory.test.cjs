const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-json-inventory-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^mc-json-inventory-[A-Za-z0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const durableFs = createDurableFs({ ...options, allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename,
    async flushDirectoryAsync() {}
  } });
  const target = path.join(root, 'inventory.json');
  return { root, target, durableFs };
}

for (const method of ['writeJsonAtomic', 'writeJsonAtomicAsync']) {
  // A missing per-write budget must fail for a real large inventory, while the
  // ordinary writer must still reject the same structure without explicit opt-in.
  test(`${method} publishes a bounded large inventory without changing default limits`, async t => {
    const { root, target, durableFs } = fixture(t);
    const value = { entries: Array.from({ length: 12926 }, (_, i) => ({ path: `mods/${i}.jar`, size: '3' })) };
    await assert.rejects(async () => durableFs[method](target, value), { code: 'COMMIT_FAILED' });
    assert.deepEqual(fs.readdirSync(root), []);
    await durableFs[method](target, value, { maxJsonValues: 100000, expectedTargetSha256: null });
    const written = fs.readFileSync(target);
    assert.deepEqual(JSON.parse(written), value);
    await assert.rejects(async () => durableFs[method](target, { replaced: true },
      { maxJsonValues: 100000, expectedTargetSha256: '0'.repeat(64) }), { code: 'PLAN_STALE' });
    assert.deepEqual(fs.readFileSync(target), written);
    const priorHash = crypto.createHash('sha256').update(written).digest('hex');
    await durableFs[method](target, { replaced: true }, { maxJsonValues: 100000, expectedTargetSha256: priorHash });
    assert.deepEqual(JSON.parse(fs.readFileSync(target)), { replaced: true });
    await assert.rejects(async () => durableFs[method](target, value), { code: 'COMMIT_FAILED' });
    assert.deepEqual(JSON.parse(fs.readFileSync(target)), { replaced: true });
  });

  test(`${method} rejects invalid or exhausted inventory budgets before publication`, async t => {
    const { root, target, durableFs } = fixture(t);
    for (const maxJsonValues of [0, -1, 1.5, NaN, Infinity, 1000001, '100000', null]) {
      await assert.rejects(async () => durableFs[method](target, {}, { maxJsonValues }), { code: 'COMMIT_FAILED' });
      assert.deepEqual(fs.readdirSync(root), []);
    }
    await assert.rejects(async () => durableFs[method](target, { a: { b: 1 } }, { maxJsonValues: 2 }), { code: 'COMMIT_FAILED' });
    assert.deepEqual(fs.readdirSync(root), []);
    await durableFs[method](target, { a: { b: 1 } }, { maxJsonValues: 3 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target)), { a: { b: 1 } });
  });

  test(`${method} retains strict JSON and byte limits with inventory opt-in`, async t => {
    const { root, target, durableFs } = fixture(t, { maxJsonBytes: 1024 });
    let getterReads = 0;
    const accessor = { get secret() { getterReads++; return 'not evaluated'; } };
    const cyclic = {}; cyclic.self = cyclic;
    let deep = {}; for (let i = 0; i < 66; i++) deep = { nested: deep };
    for (const value of [accessor, cyclic, deep, { number: Infinity }, { bytes: 'x'.repeat(1025) },
      { first: 'a'.repeat(600), second: 'b'.repeat(600) }, Object.create({ inherited: true })]) {
      await assert.rejects(async () => durableFs[method](target, value, { maxJsonValues: 1000000 }), { code: 'COMMIT_FAILED' });
      assert.deepEqual(fs.readdirSync(root), []);
    }
    assert.equal(getterReads, 0);
  });
}
