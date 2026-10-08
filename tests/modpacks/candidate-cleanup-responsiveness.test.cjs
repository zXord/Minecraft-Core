const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  defaultDirectoryAuthority
} = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
const {
  identifyServerDirectory
} = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');

const inspector = Object.freeze({ async isReparsePoint() { return false; } });

test('authorized candidate cleanup yields in bounded batches and awaits the async parent flush', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-cleanup-yield-'));
  const candidate = path.join(root, 'candidate');
  fs.mkdirSync(candidate);
  for (let index = 0; index < 160; index += 1) {
    fs.writeFileSync(path.join(candidate, `entry-${String(index).padStart(3, '0')}.dat`), String(index));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = await identifyServerDirectory(candidate, { fsApi: fs, reparseInspector: inspector });
  let yields = 0;
  const flushes = [];

  await defaultDirectoryAuthority().removeAuthorizedIdentity({
    directoryPath: candidate,
    directoryIdentity: identity,
    context: {
      fsApi: fs,
      reparseInspector: inspector,
      async yieldControl() {
        yields += 1;
        await new Promise(resolve => setImmediate(resolve));
      },
      durableFs: {
        flushDirectory() { throw new Error('cleanup must not use the blocking flush'); },
        async flushDirectoryAsync(directoryPath) {
          flushes.push(path.resolve(directoryPath));
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    }
  });

  assert.equal(fs.existsSync(candidate), false);
  assert.ok(yields >= 2, `expected at least two cooperative yields, received ${yields}`);
  assert.deepEqual(flushes, [path.resolve(root)]);
});

test('authorized candidate cleanup refuses a hard-linked entry without deleting it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-cleanup-link-'));
  const candidate = path.join(root, 'candidate');
  const outside = path.join(root, 'outside.dat');
  fs.mkdirSync(candidate);
  fs.writeFileSync(outside, 'outside');
  fs.linkSync(outside, path.join(candidate, 'linked.dat'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = await identifyServerDirectory(candidate, { fsApi: fs, reparseInspector: inspector });

  await assert.rejects(defaultDirectoryAuthority().removeAuthorizedIdentity({
    directoryPath: candidate,
    directoryIdentity: identity,
    context: {
      fsApi: fs,
      reparseInspector: inspector,
      durableFs: { flushDirectory() {}, async flushDirectoryAsync() {} }
    }
  }), error => error.code === 'RECOVERY_REQUIRED');

  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.equal(fs.existsSync(path.join(candidate, 'linked.dat')), true);
});

test('authorized cleanup yields on elapsed time before a flat directory reaches the count bound', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-cleanup-time-'));
  const candidate = path.join(root, 'candidate');
  fs.mkdirSync(candidate);
  for (let index = 0; index < 20; index += 1) {
    fs.writeFileSync(path.join(candidate, `slow-${String(index).padStart(2, '0')}.dat`), String(index));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = await identifyServerDirectory(candidate, { fsApi: fs, reparseInspector: inspector });
  let yields = 0;
  const slowFs = {
    ...fs,
    unlinkSync(target) {
      const deadline = Date.now() + 3;
      while (Date.now() < deadline) {
        // Simulate a slow filesystem entry without reaching the 64-entry checkpoint.
      }
      fs.unlinkSync(target);
    }
  };

  await defaultDirectoryAuthority().removeAuthorizedIdentity({
    directoryPath: candidate,
    directoryIdentity: identity,
    context: {
      fsApi: slowFs,
      reparseInspector: inspector,
      async yieldControl() { yields += 1; await new Promise(resolve => setImmediate(resolve)); },
      durableFs: { flushDirectory() {}, async flushDirectoryAsync() {} }
    }
  });

  assert.ok(yields >= 1, 'slow flat cleanup did not reach the elapsed-time yield');
  assert.equal(fs.existsSync(candidate), false);
});

test('authorized cleanup re-proves the current directory identity after every yield', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-candidate-cleanup-substitute-'));
  const candidate = path.join(root, 'candidate');
  const displaced = path.join(root, 'candidate-displaced');
  fs.mkdirSync(candidate);
  for (let index = 0; index < 80; index += 1) {
    fs.writeFileSync(path.join(candidate, `entry-${String(index).padStart(3, '0')}.dat`), String(index));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = await identifyServerDirectory(candidate, { fsApi: fs, reparseInspector: inspector });
  let substituted = false;

  await assert.rejects(defaultDirectoryAuthority().removeAuthorizedIdentity({
    directoryPath: candidate,
    directoryIdentity: identity,
    context: {
      fsApi: fs,
      reparseInspector: inspector,
      async yieldControl() {
        if (!substituted) {
          substituted = true;
          fs.renameSync(candidate, displaced);
          fs.mkdirSync(candidate);
        }
        await new Promise(resolve => setImmediate(resolve));
      },
      durableFs: { flushDirectory() {}, async flushDirectoryAsync() {} }
    }
  }), error => error.code === 'RECOVERY_REQUIRED');

  assert.equal(substituted, true);
  assert.deepEqual(fs.readdirSync(candidate), []);
  assert.equal(fs.existsSync(displaced), true);
});
