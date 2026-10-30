const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs, MAX_JSON_BYTES } = require('../electron/utils/durable-fs.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
const {
  LEGACY_INSTANCE_CONFIG_ADVISORY,
  createInstanceConfigFsFactory,
  createLegacyInstanceConfigFs,
  isLegacyInstanceConfigAdvisory,
  isLegacyInstanceConfigFs
} = require('../electron/utils/instance-config-fs.cjs');

const CONFIG = '.minecraft-core.json';

function folder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-instance-config-fs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function tempLeftovers(directory) {
  return fs.readdirSync(directory).filter(name => name.includes('.minecraft-core-tmp-'));
}

function serialized(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fsWith(overrides) {
  return { ...fs, ...overrides };
}

function codeError(code) {
  return Object.assign(new Error(`injected ${code}`), { code });
}

function legacyFailure(code, phase = 'pre-publication') {
  return error => {
    assert.ok(error instanceof ModpackError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.commitPhase, phase);
    assert.equal(isLegacyInstanceConfigAdvisory(error), true);
    assert.equal(error[LEGACY_INSTANCE_CONFIG_ADVISORY], true);
    return true;
  };
}

test('compare-and-set refusals are pre-publication PLAN_STALE and leave the bytes and no temp file', (t) => {
  const directory = folder(t);
  const target = path.join(directory, CONFIG);
  const original = Buffer.from('{"maxRam":4}', 'utf8');
  fs.writeFileSync(target, original);
  const legacy = createLegacyInstanceConfigFs();

  assert.throws(() => legacy.writeJsonAtomic(target, { maxRam: 6 }, { expectedTargetSha256: null }),
    legacyFailure('PLAN_STALE'));
  assert.throws(() => legacy.writeJsonAtomic(target, { maxRam: 6 }, { expectedTargetSha256: 'f'.repeat(64) }),
    legacyFailure('PLAN_STALE'));
  assert.throws(() => legacy.writeJsonAtomic(path.join(directory, 'absent.json'), { maxRam: 6 }, {
    expectedTargetSha256: sha256(original)
  }), legacyFailure('PLAN_STALE'));
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(fs.existsSync(path.join(directory, 'absent.json')), false);

  // A change after staging is caught by the second check just before publication.
  const external = Buffer.from('{"maxRam":12}', 'utf8');
  let raced = false;
  const racing = createLegacyInstanceConfigFs({
    fsApi: fsWith({
      fsyncSync(descriptor) {
        fs.fsyncSync(descriptor);
        if (!raced) {
          raced = true;
          fs.writeFileSync(target, external);
        }
      }
    })
  });
  assert.throws(() => racing.writeJsonAtomic(target, { maxRam: 6 }, { expectedTargetSha256: sha256(original) }),
    legacyFailure('PLAN_STALE'));
  assert.equal(raced, true);
  assert.deepEqual(fs.readFileSync(target), external);
  assert.deepEqual(tempLeftovers(directory), []);
});

test('legacy output is byte-identical to the durable writer serialisation', (t) => {
  const legacyFolder = folder(t);
  const durableFolder = folder(t);
  const value = {
    contentRevision: 3,
    name: 'Café ☕ 🧱',
    nested: { list: [1, 2.5, true, null, 'x'], empty: {}, none: [] },
    managementInviteSecret: 'secret'
  };
  let token = 0;
  const durable = createDurableFs({
    fsApi: fs,
    allowedRoots: [durableFolder],
    tempNameFactory: () => `serialisation-${++token}`,
    durableClient: {
      moveWriteThrough: (source, destination) => fs.renameSync(source, destination),
      replaceFileWriteThrough: (source, destination) => fs.renameSync(source, destination),
      flushDirectory() {}
    }
  });
  const legacy = createLegacyInstanceConfigFs();
  const legacyTarget = path.join(legacyFolder, CONFIG);
  const durableTarget = path.join(durableFolder, CONFIG);

  assert.equal(legacy.writeJsonAtomic(legacyTarget, value, { expectedTargetSha256: null }), legacyTarget);
  durable.writeJsonAtomic(durableTarget, value, { expectedTargetSha256: null });
  assert.deepEqual(fs.readFileSync(legacyTarget), fs.readFileSync(durableTarget));
  assert.deepEqual(fs.readFileSync(legacyTarget), serialized(value));

  const next = { ...value, contentRevision: 4 };
  legacy.writeJsonAtomic(legacyTarget, next, { expectedTargetSha256: legacy.sha256File(legacyTarget) });
  durable.writeJsonAtomic(durableTarget, next, { expectedTargetSha256: durable.sha256File(durableTarget) });
  assert.deepEqual(fs.readFileSync(legacyTarget), fs.readFileSync(durableTarget));
  assert.deepEqual(tempLeftovers(legacyFolder), []);
});

test('a refused rename falls back to an in-place write that still compare-and-sets', (t) => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const directory = folder(t);
    const target = path.join(directory, CONFIG);
    const original = serialized({ maxRam: 4, padding: 'x'.repeat(64) });
    fs.writeFileSync(target, original);
    const renameRefused = createLegacyInstanceConfigFs({
      fsApi: fsWith({ renameSync() { throw codeError(code); } })
    });

    renameRefused.writeJsonAtomic(target, { maxRam: 6 }, { expectedTargetSha256: sha256(original) });

    assert.deepEqual(fs.readFileSync(target), serialized({ maxRam: 6 }), code);
    assert.deepEqual(tempLeftovers(directory), [], code);
  }

  const directory = folder(t);
  const target = path.join(directory, CONFIG);
  const original = serialized({ maxRam: 4 });
  const external = serialized({ maxRam: 16 });
  fs.writeFileSync(target, original);
  const racing = createLegacyInstanceConfigFs({
    fsApi: fsWith({
      renameSync() {
        fs.writeFileSync(target, external);
        throw codeError('EPERM');
      }
    })
  });
  assert.throws(() => racing.writeJsonAtomic(target, { maxRam: 6 }, { expectedTargetSha256: sha256(original) }),
    legacyFailure('PLAN_STALE'));
  assert.deepEqual(fs.readFileSync(target), external);
  assert.deepEqual(tempLeftovers(directory), []);

  const created = path.join(directory, 'client-config.json');
  const createRefused = createLegacyInstanceConfigFs({ fsApi: fsWith({ renameSync() { throw codeError('EBUSY'); } }) });
  createRefused.writeJsonAtomic(created, { clientId: 'one' }, { expectedTargetSha256: null });
  assert.deepEqual(fs.readFileSync(created), serialized({ clientId: 'one' }));
  assert.throws(() => createRefused.writeJsonAtomic(created, { clientId: 'two' }, { expectedTargetSha256: null }),
    legacyFailure('PLAN_STALE'));
  assert.deepEqual(tempLeftovers(directory), []);
});

test('a read-only target fails before publication and keeps its bytes', {
  skip: process.platform !== 'win32' && 'outside Windows a rename replaces a read-only file'
}, (t) => {
  const directory = folder(t);
  const target = path.join(directory, CONFIG);
  const original = serialized({ maxRam: 4 });
  fs.writeFileSync(target, original);
  fs.chmodSync(target, 0o444);

  assert.throws(
    () => createLegacyInstanceConfigFs().writeJsonAtomic(target, { maxRam: 6 }, { expectedTargetSha256: sha256(original) }),
    legacyFailure('COMMIT_FAILED')
  );
  assert.deepEqual(fs.readFileSync(target), original);
  assert.deepEqual(tempLeftovers(directory), []);
});

test('a failed in-place write is legacy-unverified and never post-publication', (t) => {
  const directory = folder(t);
  const target = path.join(directory, CONFIG);
  const original = serialized({ maxRam: 4 });
  fs.writeFileSync(target, original);
  let inPlaceDescriptor = null;
  const failing = createLegacyInstanceConfigFs({
    fsApi: fsWith({
      renameSync() { throw codeError('EBUSY'); },
      openSync(filePath, flags, mode) {
        const descriptor = fs.openSync(filePath, flags, mode);
        if (filePath === target && flags === 'r+') inPlaceDescriptor = descriptor;
        return descriptor;
      },
      writeSync(descriptor, ...args) {
        if (descriptor === inPlaceDescriptor) throw codeError('EIO');
        return fs.writeSync(descriptor, ...args);
      }
    })
  });

  assert.throws(() => failing.writeJsonAtomic(target, { maxRam: 6 }, { expectedTargetSha256: sha256(original) }),
    legacyFailure('COMMIT_FAILED', 'legacy-unverified'));
  assert.notEqual(inPlaceDescriptor, null);
  assert.deepEqual(tempLeftovers(directory), []);
});

test('invalid values and options fail before publication without staging a file', (t) => {
  const directory = folder(t);
  const target = path.join(directory, CONFIG);
  const legacy = createLegacyInstanceConfigFs();
  const cyclic = {};
  cyclic.self = cyclic;
  const oversized = { a: 'a'.repeat(3 * 1024 * 1024), b: 'b'.repeat(3 * 1024 * 1024), c: 'c'.repeat(3 * 1024 * 1024) };
  assert.ok(serialized(oversized).length > MAX_JSON_BYTES);

  for (const value of [undefined, { run() {} }, { value: Number.NaN }, cyclic, oversized]) {
    assert.throws(() => legacy.writeJsonAtomic(target, value, { expectedTargetSha256: null }), legacyFailure('COMMIT_FAILED'));
  }
  for (const options of [{ expectedTargetSha256: 'not-a-digest' }, { fsyncParent: true }, null, []]) {
    assert.throws(() => legacy.writeJsonAtomic(target, { maxRam: 6 }, options), legacyFailure('COMMIT_FAILED'));
  }
  assert.throws(() => legacy.writeJsonAtomic('relative.json', { maxRam: 6 }), legacyFailure('COMMIT_FAILED'));
  const badToken = createLegacyInstanceConfigFs({ tempNameFactory: () => '../escape' });
  assert.throws(() => badToken.writeJsonAtomic(target, { maxRam: 6 }), legacyFailure('COMMIT_FAILED'));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('bounded reads and hashes report missing, oversized and non-file targets', (t) => {
  const directory = folder(t);
  const target = path.join(directory, CONFIG);
  const bytes = Buffer.from('{"maxRam":4}', 'utf8');
  fs.writeFileSync(target, bytes);
  const legacy = createLegacyInstanceConfigFs();

  assert.deepEqual(legacy.readFileBounded(target, { allowMissing: false, maxBytes: 1024 }), bytes);
  assert.equal(legacy.readFileBounded(path.join(directory, 'absent.json'), { allowMissing: true }), null);
  assert.throws(() => legacy.readFileBounded(path.join(directory, 'absent.json'), { allowMissing: false }),
    legacyFailure('COMMIT_FAILED'));
  assert.throws(() => legacy.readFileBounded(target, { maxBytes: bytes.length - 1 }), legacyFailure('COMMIT_FAILED'));
  assert.throws(() => legacy.readFileBounded(directory, { allowMissing: true }), legacyFailure('COMMIT_FAILED'));
  assert.throws(() => legacy.readFileBounded(target, { unknown: true }), legacyFailure('COMMIT_FAILED'));
  assert.equal(legacy.sha256File(target), sha256(bytes));
  assert.throws(() => legacy.sha256File(path.join(directory, 'absent.json')), legacyFailure('PLAN_STALE'));
});

test('preserveUnreadable is create-only and idempotent', (t) => {
  const directory = folder(t);
  const target = path.join(directory, CONFIG);
  const damaged = Buffer.from('{"port": 25570,', 'utf8');
  const legacy = createLegacyInstanceConfigFs();
  const expectedPath = `${target}.unreadable-${sha256(damaged).slice(0, 12)}`;

  assert.equal(legacy.preserveUnreadable(target, damaged), expectedPath);
  assert.deepEqual(fs.readFileSync(expectedPath), damaged);
  assert.equal(legacy.preserveUnreadable(target, damaged), expectedPath);
  assert.deepEqual(fs.readFileSync(expectedPath), damaged);

  fs.writeFileSync(expectedPath, 'an unrelated file under the same name');
  assert.throws(() => legacy.preserveUnreadable(target, damaged), legacyFailure('COMMIT_FAILED'));
  assert.equal(fs.readFileSync(expectedPath, 'utf8'), 'an unrelated file under the same name');

  assert.equal(legacy.preserveUnreadable(path.join(directory, 'client-config.json'), Buffer.alloc(0)), null);
  assert.deepEqual(fs.readdirSync(directory).sort(), [path.basename(expectedPath)]);
});

test('a failed preservation removes its partial copy', (t) => {
  const directory = folder(t);
  const target = path.join(directory, CONFIG);
  const damaged = Buffer.alloc(400, 0);
  const failing = createLegacyInstanceConfigFs({
    fsApi: fsWith({ fsyncSync() { throw codeError('EIO'); } })
  });

  assert.throws(() => failing.preserveUnreadable(target, damaged), legacyFailure('COMMIT_FAILED'));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('the factory selects the legacy writer only for unmanaged single roots, on every call', (t) => {
  const calls = [];
  const strictMarker = Object.freeze({ strict: true });
  const factory = createInstanceConfigFsFactory({
    strictFactory(roots) {
      calls.push(roots);
      return strictMarker;
    }
  });
  const unmanagedLayouts = [
    ['an empty folder', () => {}],
    ['runtime.json only', root => {
      fs.mkdirSync(path.join(root, '.minecraft-core-state'));
      fs.writeFileSync(path.join(root, '.minecraft-core-state', 'runtime.json'), '{}');
    }],
    ['runtime-staging only', root => fs.mkdirSync(path.join(root, '.minecraft-core-state', 'runtime-staging'), { recursive: true })],
    ['an empty state folder', root => fs.mkdirSync(path.join(root, '.minecraft-core-state'))],
    ['the v26.6.1 client folder', root => {
      fs.mkdirSync(path.join(root, 'minecraft-core-state'));
      fs.writeFileSync(path.join(root, 'minecraft-core-state', 'expected-mods.json'), '[]');
    }]
  ];
  for (const [label, arrange] of unmanagedLayouts) {
    const root = folder(t);
    arrange(root);
    assert.equal(isLegacyInstanceConfigFs(factory(Object.freeze([root]))), true, label);
  }
  assert.deepEqual(calls, []);

  const evidenceLayouts = [
    ['modpack.json', root => {
      fs.mkdirSync(path.join(root, '.minecraft-core-state'));
      fs.writeFileSync(path.join(root, '.minecraft-core-state', 'modpack.json'), '{}');
    }],
    ['manifests', root => fs.mkdirSync(path.join(root, '.minecraft-core-state', 'manifests'), { recursive: true })],
    ['operations', root => fs.mkdirSync(path.join(root, '.minecraft-core-state', 'operations'), { recursive: true })],
    ['history', root => fs.mkdirSync(path.join(root, '.minecraft-core-state', 'history'), { recursive: true })],
    ['a client pack manifest', root => fs.writeFileSync(path.join(root, '.minecraft-core-client-pack.json'), '{}')]
  ];
  for (const [label, arrange] of evidenceLayouts) {
    const root = folder(t);
    arrange(root);
    const roots = Object.freeze([root]);
    assert.equal(factory(roots), strictMarker, label);
    assert.equal(calls.at(-1), roots, label);
    const failure = new Error(`strict writer unavailable for ${label}`);
    const throwing = createInstanceConfigFsFactory({ strictFactory() { throw failure; } });
    assert.throws(() => throwing(roots), error => error === failure, label);
  }

  const missingRoot = path.join(folder(t), 'missing');
  assert.equal(factory([missingRoot]), strictMarker);
  const unmanagedRoot = folder(t);
  assert.equal(factory([unmanagedRoot, folder(t)]), strictMarker);
  assert.equal(calls.length, evidenceLayouts.length + 2);

  // Never cached: evidence that appears later switches the same root to strict.
  assert.equal(isLegacyInstanceConfigFs(factory([unmanagedRoot])), true);
  fs.mkdirSync(path.join(unmanagedRoot, '.minecraft-core-state', 'history'), { recursive: true });
  assert.equal(factory([unmanagedRoot]), strictMarker);
});

test('only the module itself can mark a legacy capability or an advisory failure', () => {
  const legacy = createLegacyInstanceConfigFs();
  assert.equal(isLegacyInstanceConfigFs(legacy), true);
  assert.equal(Object.isFrozen(legacy), true);
  assert.equal(Object.getPrototypeOf(legacy), Object.prototype);
  assert.deepEqual(Object.keys(legacy).sort(), ['preserveUnreadable', 'readFileBounded', 'sha256File', 'writeJsonAtomic']);
  assert.equal(isLegacyInstanceConfigFs({ ...legacy }), false);
  assert.equal(isLegacyInstanceConfigFs(Object.create(legacy)), false);
  assert.equal(isLegacyInstanceConfigFs(null), false);
  assert.equal(isLegacyInstanceConfigAdvisory(new ModpackError('COMMIT_FAILED', 'Unrelated failure')), false);
  assert.throws(() => createInstanceConfigFsFactory({ strictFactory: null }), TypeError);
  assert.throws(() => createInstanceConfigFsFactory({ strictFactory: () => null, legacyFs: { ...legacy } }), TypeError);
});
