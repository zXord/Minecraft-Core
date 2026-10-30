const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { captureReservedTarget } = require('../../electron/services/modpack-lifecycle/reserved-target-authority.cjs');
const { assertUnstartedLaunchTarget } = require('../../electron/services/modpack-lifecycle/unstarted-launch-authority.cjs');

const nativePaths = { skip: process.platform !== 'win32' };
const plainInspector = Object.freeze({ async isReparsePoint() { return false; } });
const jobId = 'op2-0123456789abcdef0123456789abcdef';

async function fixture(t, { absent = false, operationId = jobId } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-unstarted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, 'servers');
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, 'unrelated.txt'), 'retain unrelated bytes\n');
  const targetPath = path.join(parent, 'Server');
  if (!absent) fs.mkdirSync(targetPath);
  const capturedReservation = await captureReservedTarget({ targetPath, reparseInspector: plainInspector });
  return { root, parent, targetPath, launch: {
    job: { jobId: operationId }, binding: { targetPath, capturedReservation }
  } };
}

function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate, { bigint: true });
      const entry = { path: path.relative(root, candidate), dev: String(stat.dev), ino: String(stat.ino),
        birthtimeNs: String(stat.birthtimeNs), directory: stat.isDirectory(), symbolicLink: stat.isSymbolicLink() };
      if (stat.isSymbolicLink()) entry.link = fs.readlinkSync(candidate);
      else if (!stat.isDirectory()) entry.bytes = fs.readFileSync(candidate).toString('base64');
      entries.push(entry);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(candidate);
    }
  }
  visit(root);
  return entries;
}

async function refusesWithoutWrites(f, reparseInspector = plainInspector) {
  const before = snapshot(f.root);
  await assert.rejects(assertUnstartedLaunchTarget({ launch: f.launch, reparseInspector }), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(snapshot(f.root), before);
}

for (const absent of [false, true]) {
  test(`unstarted launch accepts unchanged ${absent ? 'absent' : 'empty'} target without filesystem writes`, nativePaths, async t => {
    const f = await fixture(t, { absent });
    const before = snapshot(f.root);
    assert.equal(await assertUnstartedLaunchTarget({ launch: f.launch, reparseInspector: plainInspector }), true);
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('unstarted launch rejects newly nonempty target without deleting its content', nativePaths, async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.targetPath, 'foreign.txt'), 'keep this content');
  await refusesWithoutWrites(f);
});

test('unstarted launch rejects replacement empty directory identity', nativePaths, async t => {
  const f = await fixture(t);
  fs.renameSync(f.targetPath, path.join(f.parent, 'original'));
  fs.mkdirSync(f.targetPath);
  await refusesWithoutWrites(f);
});

test('unstarted launch rejects disappeared originally empty directory', nativePaths, async t => {
  const f = await fixture(t);
  fs.rmdirSync(f.targetPath);
  await refusesWithoutWrites(f);
});

test('unstarted launch rejects a directory appearing at an originally absent target', nativePaths, async t => {
  const f = await fixture(t, { absent: true });
  fs.mkdirSync(f.targetPath);
  await refusesWithoutWrites(f);
});

for (const inspected of ['parent', 'target']) for (const answer of [true, null, 'error']) {
  test(`unstarted launch rejects ${inspected} reparse authority ${answer}`, nativePaths, async t => {
    const f = await fixture(t);
    await refusesWithoutWrites(f, { async isReparsePoint(candidate) {
      if (candidate !== f[inspected === 'parent' ? 'parent' : 'targetPath']) return false;
      if (answer === 'error') throw new Error('OS reparse inspection unavailable');
      return answer;
    } });
  });
}

for (const sibling of ['c', 'f']) {
  test(`unstarted launch rejects exact compact ${sibling} sibling without deleting it`, nativePaths, async t => {
    const f = await fixture(t);
    fs.mkdirSync(path.join(f.parent, `.op2-0123456789abcdef0123456789abcdef.${sibling}`));
    await refusesWithoutWrites(f);
  });
}

for (const sibling of ['candidate', 'failed']) {
  test(`unstarted launch rejects exact legacy ${sibling} sibling`, nativePaths, async t => {
    const f = await fixture(t, { operationId: 'legacy-job' });
    fs.writeFileSync(path.join(f.parent, `.Server.minecraft-core.legacy-job.${sibling}`), 'retain old job bytes');
    await refusesWithoutWrites(f);
  });
}

test('unstarted launch does not confuse another job sibling with its own', nativePaths, async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.parent, '.op2-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.c'));
  const before = snapshot(f.root);
  assert.equal(await assertUnstartedLaunchTarget({ launch: f.launch, reparseInspector: plainInspector }), true);
  assert.deepEqual(snapshot(f.root), before);
});

for (const changed of ['target-identity', 'target-content', 'candidate', 'failed', 'parent-identity']) {
  test(`unstarted launch reproves ${changed} after awaited OS inspection`, nativePaths, async t => {
    const f = await fixture(t);
    let targetInspections = 0;
    let changedSnapshot;
    const reparseInspector = { async isReparsePoint(candidate) {
      if (candidate === f.targetPath && ++targetInspections === 2) {
        if (changed === 'target-identity') {
          fs.renameSync(f.targetPath, path.join(f.parent, 'original'));
          fs.mkdirSync(f.targetPath);
        } else if (changed === 'target-content') {
          fs.writeFileSync(path.join(f.targetPath, 'raced.txt'), 'retain raced content');
        } else if (changed === 'parent-identity') {
          const originalParent = path.join(f.root, 'original-parent');
          fs.renameSync(f.parent, originalParent);
          fs.mkdirSync(f.parent);
          fs.renameSync(path.join(originalParent, 'Server'), f.targetPath);
        } else {
          fs.mkdirSync(path.join(f.parent, `.op2-0123456789abcdef0123456789abcdef.${changed === 'candidate' ? 'c' : 'f'}`));
        }
        changedSnapshot = snapshot(f.root);
      }
      return false;
    } };
    await assert.rejects(assertUnstartedLaunchTarget({ launch: f.launch, reparseInspector }), { code: 'RECOVERY_REQUIRED' });
    assert.notEqual(changedSnapshot, undefined, 'the change occurs during the existing target capture authority');
    assert.deepEqual(snapshot(f.root), changedSnapshot);
  });
}

test('unstarted absent launch reproves target after awaited parent inspection', nativePaths, async t => {
  const f = await fixture(t, { absent: true });
  let changedSnapshot;
  const reparseInspector = { async isReparsePoint(candidate) {
    if (candidate === f.parent && changedSnapshot === undefined) {
      fs.mkdirSync(f.targetPath);
      changedSnapshot = snapshot(f.root);
    }
    return false;
  } };
  await assert.rejects(assertUnstartedLaunchTarget({ launch: f.launch, reparseInspector }), { code: 'RECOVERY_REQUIRED' });
  assert.notEqual(changedSnapshot, undefined);
  assert.deepEqual(snapshot(f.root), changedSnapshot);
});

for (const absent of [false, true]) {
  test(`unstarted ${absent ? 'absent' : 'empty'} launch rejects a real junction ancestor`, nativePaths, async t => {
    const f = await fixture(t, { absent });
    const displaced = path.join(f.root, 'real-parent');
    fs.renameSync(f.parent, displaced);
    try { fs.symlinkSync(displaced, f.parent, 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip(`junction unavailable: ${error.code}`); return; }
      throw error;
    }
    await refusesWithoutWrites(f);
  });
}

test('unstarted launch rejects missing canonical parent', nativePaths, async t => {
  const f = await fixture(t, { absent: true });
  fs.renameSync(f.parent, path.join(f.root, 'original-parent'));
  await refusesWithoutWrites(f);
});
