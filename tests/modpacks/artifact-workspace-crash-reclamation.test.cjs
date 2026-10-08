const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const FOURTH = '44444444-4444-4444-8444-444444444444';
const noReparse = Object.freeze({ async isReparsePoint() { return false; } });

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-workspace-reclaim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createWorkspace(root, name, body = 'orphaned') {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'artifact.bin'), body);
  return directory;
}

async function openRegistry(root, options = {}) {
  return ArtifactWorkspaceRegistry.open({
    root,
    reparseInspector: noReparse,
    reclaimIdFactory: (() => {
      const values = [THIRD, FOURTH];
      return () => values.shift() || FOURTH;
    })(),
    ...options
  });
}

test('startup reclaims exact orphan workspaces and an interrupted quarantine idempotently', async (t) => {
  const root = temporaryRoot(t);
  createWorkspace(root, `input-${FIRST}`);
  createWorkspace(root, `output-${SECOND}`);
  createWorkspace(root, `.input-${SECOND}.${FIRST}.partial`);
  createWorkspace(root, `.reclaim-${THIRD}.output-${FIRST}`);

  const registry = await openRegistry(root);
  t.after(() => registry.dispose());

  assert.deepEqual(fs.readdirSync(root), []);
});

test('an unknown root entry refuses startup before any recognized workspace is changed', async (t) => {
  const root = temporaryRoot(t);
  const known = createWorkspace(root, `input-${FIRST}`);
  const unknown = createWorkspace(root, 'operator-preserved');

  await assert.rejects(
    openRegistry(root),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(fs.readFileSync(path.join(known, 'artifact.bin'), 'utf8'), 'orphaned');
  assert.equal(fs.readFileSync(path.join(unknown, 'artifact.bin'), 'utf8'), 'orphaned');
});

test('a reparse-marked workspace refuses startup without touching it or its siblings', async (t) => {
  const root = temporaryRoot(t);
  const unsafe = createWorkspace(root, `input-${FIRST}`);
  const safe = createWorkspace(root, `output-${SECOND}`);

  await assert.rejects(
    openRegistry(root, {
      reparseInspector: {
        async isReparsePoint(candidate) {
          return path.resolve(candidate) === path.resolve(unsafe);
        }
      }
    }),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(fs.readFileSync(path.join(unsafe, 'artifact.bin'), 'utf8'), 'orphaned');
  assert.equal(fs.readFileSync(path.join(safe, 'artifact.bin'), 'utf8'), 'orphaned');
});

test('a workspace symlink or junction is refused without touching its external target', async (t) => {
  const root = temporaryRoot(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-workspace-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, 'sentinel.bin');
  fs.writeFileSync(sentinel, 'preserve');
  const link = path.join(root, `output-${FIRST}`);
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`workspace links are unavailable: ${error?.code || 'unknown'}`); return; }

  await assert.rejects(
    openRegistry(root),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('a cleanup failure leaves only a recognized quarantine for a later exact retry', async (t) => {
  const root = temporaryRoot(t);
  const orphan = createWorkspace(root, `output-${FIRST}`);
  let attempts = 0;

  await assert.rejects(
    openRegistry(root, {
      removeTree() {
        attempts += 1;
        const error = new Error('simulated sharing violation');
        error.code = 'EBUSY';
        throw error;
      }
    }),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(attempts, 1);
  assert.equal(fs.existsSync(orphan), false);
  assert.deepEqual(fs.readdirSync(root), [`.reclaim-${THIRD}.output-${FIRST}`]);

  const registry = await openRegistry(root);
  t.after(() => registry.dispose());
  assert.deepEqual(fs.readdirSync(root), []);
});

test('startup reconciles cleanup that completed before its acknowledgement was lost', async (t) => {
  const root = temporaryRoot(t);
  createWorkspace(root, `output-${FIRST}`);
  const registry = await openRegistry(root, {
    async removeTree(request) {
      await fs.promises.rm(request.path, { recursive: true, force: true });
      throw new Error('lost cleanup acknowledgement');
    }
  });
  t.after(() => registry.dispose());
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a runtime release failure leaves a recognized quarantine that the next process reclaims', async (t) => {
  const root = temporaryRoot(t);
  const first = await openRegistry(root, {
    removeTree() {
      const error = new Error('simulated runtime sharing violation');
      error.code = 'EBUSY';
      throw error;
    }
  });
  const outputId = first.createStagingOutput({ ownerId: 'live-owner' });
  fs.writeFileSync(path.join(root, outputId, 'live.bin'), 'live');

  await assert.rejects(first.releaseOwner('live-owner'), error => error?.code === 'EBUSY');
  const quarantines = fs.readdirSync(root);
  assert.equal(quarantines.length, 1);
  assert.match(quarantines[0], new RegExp(`^\\.reclaim-${'[a-f0-9-]{36}'}\\.${outputId}$`, 'i'));

  // Closing the process-bound lease models the only state a real crash persists.
  await first.rootLease.close();
  first.rootLease = null;
  first.disposed = true;
  const second = await openRegistry(root);
  t.after(() => second.dispose());
  assert.deepEqual(fs.readdirSync(root), []);
});

test('one opened registry excludes a second registry without mutating live workspaces', async (t) => {
  const root = temporaryRoot(t);
  const first = await openRegistry(root);
  t.after(() => first.dispose());
  const outputId = first.createStagingOutput({ ownerId: 'live-owner' });
  const output = path.join(root, outputId);
  fs.writeFileSync(path.join(output, 'live.bin'), 'live');

  assert.equal(await first.dispose(), false);
  await assert.rejects(
    openRegistry(root),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(fs.readFileSync(path.join(output, 'live.bin'), 'utf8'), 'live');

  await first.releaseOwner('live-owner');
  assert.equal(await first.dispose(), true);
});
