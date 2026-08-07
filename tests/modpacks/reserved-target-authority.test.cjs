const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  captureReservedTarget,
  consumeReservedTarget
} = require('../../electron/services/modpack-lifecycle/reserved-target-authority.cjs');

const reparseInspector = Object.freeze({ async isReparsePoint() { return false; } });

test('an exact pre-reserved empty setup target can be consumed for new publication', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-reserved-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Server');
  fs.mkdirSync(targetPath);
  const reservation = await captureReservedTarget({ targetPath, reparseInspector });
  const flushed = [];
  const result = await consumeReservedTarget({
    targetPath,
    reservation,
    reparseInspector,
    durableFs: { flushDirectory(value) { flushed.push(value); } },
    mutationLease: {
      kind: 'mutation',
      instanceId: 'alpha',
      serverPath: targetPath,
      assertOwnedPath(value) { assert.equal(value, targetPath); },
      markDirty() { return true; }
    }
  });
  assert.deepEqual(result, { consumed: true, removedEmptyReservation: true });
  assert.equal(fs.existsSync(targetPath), false);
  assert.deepEqual(flushed, [root]);
});

test('a pre-reserved nonempty unmanaged target is rejected before mutation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-reserved-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Server');
  fs.mkdirSync(targetPath);
  fs.writeFileSync(path.join(targetPath, 'server.properties'), 'motd=existing\n');

  await assert.rejects(
    captureReservedTarget({ targetPath, reparseInspector }),
    error => error?.code === 'TARGET_EXISTS' && /not empty/i.test(error.message)
  );
});

test('a reviewed empty reservation is stale if content appears before consumption', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-reserved-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Server');
  fs.mkdirSync(targetPath);
  const reservation = await captureReservedTarget({ targetPath, reparseInspector });
  fs.writeFileSync(path.join(targetPath, 'foreign.txt'), 'do not remove');
  let dirty = false;

  await assert.rejects(consumeReservedTarget({
    targetPath,
    reservation,
    reparseInspector,
    durableFs: { flushDirectory() {} },
    mutationLease: {
      kind: 'mutation', instanceId: 'alpha', serverPath: targetPath,
      markDirty() { dirty = true; }
    }
  }), error => error?.code === 'TARGET_EXISTS');
  assert.equal(dirty, false);
  assert.equal(fs.readFileSync(path.join(targetPath, 'foreign.txt'), 'utf8'), 'do not remove');
});
