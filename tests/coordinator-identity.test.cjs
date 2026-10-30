const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ServerMutationCoordinator
} = require('../electron/services/server-mutation-coordinator.cjs');
const {
  canonicalCoordinatorSelector
} = require('../electron/services/coordinator-identity.cjs');
const {
  createServerMutationContext
} = require('../electron/services/server-mutation-context.cjs');
const {
  createInstanceConfigFsFactory,
  createLegacyInstanceConfigFs
} = require('../electron/utils/instance-config-fs.cjs');
const { readContentRevision } = require('../electron/services/server-content-revision.cjs');

const SHARED_PATH = 'C:\\Servers\\Shared';
const OTHER_PATH = 'C:\\Servers\\Other';

function windowsKey(value) {
  return path.win32.normalize(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function selector(instanceId, serverPath) {
  return { instanceId, serverPath };
}

function startOptions(operationId, overrides = {}) {
  return { operation: 'server-start', operationId, parentMutationLease: null, ...overrides };
}

function ordinaryOptions(operationId, overrides = {}) {
  return { operation: 'test-ordinary-write', operationId, revisionMode: 'auto', quiesce: null, ordinary: true, ...overrides };
}

function lifecycleOptions(operationId) {
  return { operation: 'test-lifecycle', operationId, revisionMode: 'lifecycle', quiesce: async () => {} };
}

function code(expected) {
  return error => error?.code === expected;
}

function inProgressBy(operationId) {
  return error => error?.code === 'OPERATION_IN_PROGRESS' && error.details?.operationId === operationId;
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function holdRun(start) {
  const signal = deferred();
  const gate = deferred();
  const run = start(async lease => {
    signal.resolve(lease);
    await gate.promise;
    return 'held';
  });
  await Promise.race([
    signal.promise,
    run.then(() => {
      throw new Error('The run settled before its work started');
    })
  ]);
  return { gate, lease: await signal.promise, run };
}

function fixture({ capability } = {}) {
  const revisions = new Map();
  const control = { failure: null };
  const options = {
    context: createServerMutationContext(),
    readContentRevision: serverPath => revisions.get(windowsKey(serverPath)) || 0,
    bumpContentRevision(serverPath, { expectedRevision }) {
      if (control.failure) throw control.failure();
      const key = windowsKey(serverPath);
      const current = revisions.get(key) || 0;
      if (expectedRevision !== current) throw new Error('content revision compare-and-set mismatch');
      revisions.set(key, current + 1);
      return current + 1;
    }
  };
  if (capability) options.durableFsFactory = () => capability;
  const coordinator = new ServerMutationCoordinator(options);
  coordinator.completeStartupRecovery([]);
  return {
    control,
    coordinator,
    revision: serverPath => revisions.get(windowsKey(serverPath)) || 0,
    setRevision: (serverPath, value) => revisions.set(windowsKey(serverPath), value)
  };
}

// The policy and the server manager resolve every coordinator selector like this.
function canonicalFor(f, instances) {
  return requested => canonicalCoordinatorSelector({ instances, selector: requested, coordinator: f.coordinator });
}

function write(f, requested, operationId) {
  return f.coordinator.runMutation(requested, ordinaryOptions(operationId), async lease => {
    lease.markDirty();
    return lease.instanceId;
  });
}

async function startAndStop(f, requested, operationId) {
  const lease = await f.coordinator.acquireStart(requested, startOptions(operationId));
  const instanceId = lease.instanceId;
  lease.markRunning({ pid: 5000 });
  lease.release();
  return instanceId;
}

test('duplicate registrations of one folder share one coordinator identity in every order', async () => {
  const f = fixture();
  const instances = [
    { id: 'server-1', type: 'server', name: 'S1', path: SHARED_PATH },
    { id: 'server-2', type: 'server', name: 'S2', path: SHARED_PATH }
  ];
  const canonical = canonicalFor(f, instances);

  assert.deepEqual(canonical(selector('server-2', SHARED_PATH)), selector('server-1', SHARED_PATH));
  assert.equal(await write(f, canonical(selector('server-2', SHARED_PATH)), 'settings-through-s2'), 'server-1');
  instances.reverse(); // The user drags S2 above S1 in the sidebar.
  assert.equal(await write(f, canonical(selector('server-1', SHARED_PATH)), 'settings-through-s1'), 'server-1');
  // add-player resolves the folder's first registration by path.
  assert.equal(await write(f, canonical(selector(instances[0].id, SHARED_PATH)), 'add-player'), 'server-1');
  for (const id of ['server-1', 'server-2']) {
    assert.equal(await startAndStop(f, canonical(selector(id, SHARED_PATH)), `start-${id}`), 'server-1');
  }
  assert.equal(f.revision(SHARED_PATH), 3);

  // The raw second registration is still a different alias for that folder.
  await assert.rejects(
    f.coordinator.acquireStart(selector('server-2', SHARED_PATH), startOptions('raw-second-registration')),
    code('INVALID_REQUEST')
  );
});

test('a folder registered as a client and a server keeps the server identity in either order', async () => {
  const f = fixture();
  const instances = [
    { id: 'client-c', clientId: 'client-c', type: 'client', name: 'C', path: SHARED_PATH },
    { id: 'server-s', type: 'server', name: 'S', path: SHARED_PATH }
  ];
  const canonical = canonicalFor(f, instances);

  assert.equal(await write(f, canonical(selector('client-c', SHARED_PATH)), 'client-write'), 'server-s');
  assert.equal(await startAndStop(f, canonical(selector('server-s', SHARED_PATH)), 'server-start-first'), 'server-s');
  instances.reverse();
  assert.equal(await startAndStop(f, canonical(selector('server-s', SHARED_PATH)), 'server-start-after-reorder'), 'server-s');
  assert.equal(await write(f, canonical(selector('client-c', SHARED_PATH)), 'client-write-after-reorder'), 'server-s');
});

test('a server listed first keeps its identity after its client is moved above it', async () => {
  const f = fixture();
  const instances = [
    { id: 'server-s', type: 'server', name: 'S', path: SHARED_PATH },
    { id: 'client-c', clientId: 'client-c', type: 'client', name: 'C', path: SHARED_PATH }
  ];
  const canonical = canonicalFor(f, instances);

  assert.equal(await startAndStop(f, canonical(selector('server-s', SHARED_PATH)), 'server-start'), 'server-s');
  instances.reverse();
  assert.equal(await write(f, canonical(selector('server-s', SHARED_PATH)), 'server-settings'), 'server-s');
  assert.equal(await write(f, canonical(selector('client-c', SHARED_PATH)), 'client-preferences'), 'server-s');
});

test('ties prefer a server, then the lowest id in code-point order, never array position', () => {
  const f = fixture();
  const clientsOnly = [
    { id: 'client-b', type: 'client', path: SHARED_PATH },
    { id: 'client-a', type: 'client', path: 'c:/servers/shared/' }
  ];
  assert.deepEqual(canonicalFor(f, clientsOnly)(selector('client-b', SHARED_PATH)), selector('client-a', SHARED_PATH));
  const mixed = [
    { id: 'Zed', type: 'server', path: SHARED_PATH },
    { id: 'alpha', type: 'client', path: SHARED_PATH },
    { id: 'Bravo', type: 'server', path: SHARED_PATH }
  ];
  assert.deepEqual(canonicalFor(f, mixed)(selector('alpha', SHARED_PATH)), selector('Bravo', SHARED_PATH));
  assert.deepEqual(canonicalFor(f, [...mixed].reverse())(selector('Zed', SHARED_PATH)), selector('Bravo', SHARED_PATH));
});

test('a requested id with no registration gives a path-only selector; a known id is kept', () => {
  const f = fixture();
  const instances = [{ id: 'server-elsewhere', type: 'server', path: OTHER_PATH }];
  const canonical = canonicalFor(f, instances);
  assert.deepEqual(canonical(selector('unregistered', SHARED_PATH)), selector(null, SHARED_PATH));
  assert.deepEqual(canonical(selector(null, SHARED_PATH)), selector(null, SHARED_PATH));
  // A known id at another path is left for the coordinator to refuse.
  assert.deepEqual(canonical(selector('server-elsewhere', SHARED_PATH)), selector('server-elsewhere', SHARED_PATH));
  assert.deepEqual(canonical({ instanceId: 'server-elsewhere' }), { instanceId: 'server-elsewhere', serverPath: null });
  assert.equal(Object.isFrozen(canonical(selector(null, SHARED_PATH))), true);
});

test('a stale binding whose id is registered nowhere is retired before a new registration uses the folder', async () => {
  const f = fixture();
  assert.equal(await write(f, selector('old-server', SHARED_PATH), 'old-server-write'), 'old-server');
  const instances = [{ id: 'new-server', type: 'server', path: SHARED_PATH }];
  const canonical = canonicalFor(f, instances);

  await assert.rejects(
    f.coordinator.acquireStart(selector('new-server', SHARED_PATH), startOptions('before-self-heal')),
    code('INVALID_REQUEST')
  );
  const healed = canonical(selector('new-server', SHARED_PATH));
  assert.deepEqual(healed, selector('new-server', SHARED_PATH));
  assert.equal(f.coordinator.pathBinding(SHARED_PATH), null);
  assert.equal(await startAndStop(f, healed, 'after-self-heal'), 'new-server');
  assert.deepEqual(f.coordinator.pathBinding(SHARED_PATH), { instanceId: 'new-server' });

  // A stale record that is still in use keeps its alias (fail closed).
  const busy = await f.coordinator.acquireStart(selector('busy-old', OTHER_PATH), startOptions('busy-old-start'));
  try {
    const instancesForOther = [{ id: 'busy-new', type: 'server', path: OTHER_PATH }];
    assert.deepEqual(canonicalFor(f, instancesForOther)(selector('busy-new', OTHER_PATH)), selector('busy-new', OTHER_PATH));
    assert.deepEqual(f.coordinator.pathBinding(OTHER_PATH), { instanceId: 'busy-old' });
  } finally {
    busy.release();
  }
});

test('records reserved by a new-server install are never retired by registration cleanup', async () => {
  const f = fixture();
  await f.coordinator.runMutation(selector('fresh-install', SHARED_PATH), {
    operation: 'install-new', operationId: 'install-job', revisionMode: 'none', quiesce: null
  }, async () => {});
  const canonical = canonicalFor(f, [{ id: 'other-server', type: 'server', path: SHARED_PATH }]);

  assert.equal(f.coordinator.retireIdleRegistration(selector('fresh-install', SHARED_PATH)), false);
  assert.deepEqual(canonical(selector('other-server', SHARED_PATH)), selector('other-server', SHARED_PATH));
  assert.deepEqual(f.coordinator.pathBinding(SHARED_PATH), { instanceId: 'fresh-install' });
  await assert.rejects(
    f.coordinator.acquireStart(canonical(selector('other-server', SHARED_PATH)), startOptions('other-on-install')),
    code('INVALID_REQUEST')
  );
  // The lifecycle's own authenticated retirement still applies.
  assert.equal(f.coordinator.retireAbandonedIncarnation(selector('fresh-install', SHARED_PATH), { operationId: 'install-job' }), true);
  assert.equal(f.coordinator.pathBinding(SHARED_PATH), null);
});

test('idle registrations retire while starts, holders and recovery blocks keep their alias', async () => {
  const f = fixture({ capability: Object.freeze({ readFileBounded() {}, sha256File() {}, writeJsonAtomic() {} }) });
  const paths = {
    idle: 'C:\\Servers\\Idle',
    running: 'C:\\Servers\\Running',
    shared: 'C:\\Servers\\Shared-holder',
    blocked: 'C:\\Servers\\Blocked',
    failed: 'C:\\Servers\\Failed'
  };

  await write(f, selector('idle-server', paths.idle), 'idle-write');
  assert.equal(f.coordinator.retireIdleRegistration(selector('other-id', paths.idle)), false);
  assert.equal(f.coordinator.retireIdleRegistration(selector('idle-server', OTHER_PATH)), false);
  assert.equal(f.coordinator.retireIdleRegistration(selector('idle-server', 'c:/servers/IDLE/')), true);
  assert.equal(f.coordinator.pathBinding(paths.idle), null);
  assert.equal(await write(f, selector('replacement-server', paths.idle), 'replacement-write'), 'replacement-server');

  const start = await f.coordinator.acquireStart(selector('running-server', paths.running), startOptions('running-start'));
  assert.equal(f.coordinator.retireIdleRegistration(selector('running-server', paths.running)), false);
  start.release();
  assert.equal(f.coordinator.retireIdleRegistration(selector('running-server', paths.running)), true);

  const holder = await holdRun(work => f.coordinator.runMutation(selector('shared-server', paths.shared),
    ordinaryOptions('shared-holder', { revisionMode: 'none' }), work));
  try {
    assert.equal(f.coordinator.retireIdleRegistration(selector('shared-server', paths.shared)), false);
  } finally {
    holder.gate.resolve();
  }
  await holder.run;
  assert.equal(f.coordinator.retireIdleRegistration(selector('shared-server', paths.shared)), true);

  f.coordinator.beginStartupRecovery();
  f.coordinator.installRecoveryBlocks([{ operationId: 'blocked-job', selector: selector('blocked-server', paths.blocked) }]);
  assert.equal(f.coordinator.retireIdleRegistration(selector('blocked-server', paths.blocked)), false);
  f.coordinator.completeStartupRecovery([{ resolved: false, selector: selector('blocked-server', paths.blocked) }]);
  assert.equal(f.coordinator.retireIdleRegistration(selector('blocked-server', paths.blocked)), false);
  assert.deepEqual(f.coordinator.pathBinding(paths.blocked), { instanceId: 'blocked-server' });

  f.control.failure = () => new Error('disk uncertain');
  await assert.rejects(write(f, selector('failed-server', paths.failed), 'quarantined-write'), code('COMMIT_FAILED'));
  f.control.failure = null;
  assert.equal(f.coordinator.retireIdleRegistration(selector('failed-server', paths.failed)), false);
  assert.deepEqual(f.coordinator.pathBinding(paths.failed), { instanceId: 'failed-server' });

  assert.throws(() => f.coordinator.retireIdleRegistration({ instanceId: 'x', serverPath: paths.idle, extra: true }),
    code('INVALID_REQUEST'));
  assert.equal(f.coordinator.retireIdleRegistration(selector('x', 'relative\\path')), false);
});

test('an ordinary exclusive writer retires the registration it removed when it is released', async () => {
  const f = fixture();
  await f.coordinator.runMutation(selector('deleted-server', SHARED_PATH),
    ordinaryOptions('delete-instance', { revisionMode: 'none', stoppedOnly: true }), async lease => {
      assert.equal(f.coordinator.retireRegistrationOnRelease(lease), true);
      assert.deepEqual(f.coordinator.pathBinding(SHARED_PATH), { instanceId: 'deleted-server' });
    });
  assert.equal(f.coordinator.pathBinding(SHARED_PATH), null);
  // Re-adding the folder under a new id (or reusing 'default-server') works at once.
  assert.equal(await write(f, selector('re-added-server', SHARED_PATH), 're-added-write'), 're-added-server');
  assert.equal(await startAndStop(f, selector('re-added-server', SHARED_PATH), 're-added-start'), 're-added-server');

  await f.coordinator.runMutation(selector('re-added-server', SHARED_PATH),
    ordinaryOptions('shared-cannot-retire', { revisionMode: 'none' }), async lease => {
      assert.throws(() => f.coordinator.retireRegistrationOnRelease(lease), code('INVALID_REQUEST'));
    });
  await f.coordinator.runMutation(selector('re-added-server', SHARED_PATH), {
    operation: 'update-managed', operationId: 'lifecycle-cannot-retire', revisionMode: 'none', quiesce: null
  }, async lease => {
    assert.throws(() => f.coordinator.retireRegistrationOnRelease(lease), code('INVALID_REQUEST'));
  });
  assert.deepEqual(f.coordinator.pathBinding(SHARED_PATH), { instanceId: 're-added-server' });

  // A registry save retires each removed registration through its own lease.
  await f.coordinator.runManyMutations([selector('re-added-server', SHARED_PATH), selector('kept-server', OTHER_PATH)],
    ordinaryOptions('save-instances', { revisionMode: 'none', stoppedOnly: true }), async leases => {
      const removed = leases.find(lease => lease.instanceId === 're-added-server');
      assert.equal(f.coordinator.retireRegistrationOnRelease(removed), true);
    });
  assert.equal(f.coordinator.pathBinding(SHARED_PATH), null);
  assert.deepEqual(f.coordinator.pathBinding(OTHER_PATH), { instanceId: 'kept-server' });

  // A group that overlaps a running server keeps that alias.
  const running = await f.coordinator.acquireStart(selector('kept-server', OTHER_PATH), startOptions('kept-running'));
  running.markRunning({ pid: 5001 });
  await f.coordinator.runManyMutations([selector('kept-server', OTHER_PATH)],
    ordinaryOptions('group-beside-start', { revisionMode: 'none' }), async leases => {
      assert.equal(f.coordinator.retireRegistrationOnRelease(leases[0]), false);
    });
  running.release();
  assert.deepEqual(f.coordinator.pathBinding(OTHER_PATH), { instanceId: 'kept-server' });
  assert.throws(() => f.coordinator.retireRegistrationOnRelease(running), code('INVALID_REQUEST'));
});

test('a fresh modpack install into a deleted server folder reaches its mutation lease', async () => {
  const f = fixture();
  assert.equal(await startAndStop(f, selector('deleted-server', SHARED_PATH), 'before-delete'), 'deleted-server');
  await assert.rejects(
    f.coordinator.runMutation(selector('server-fresh', SHARED_PATH), {
      operation: 'install-new', operationId: 'too-early-install', revisionMode: 'none', quiesce: async () => {}
    }, async () => assert.fail('install admitted')),
    code('INVALID_REQUEST')
  );
  await f.coordinator.runMutation(selector('deleted-server', SHARED_PATH),
    ordinaryOptions('delete-instance', { revisionMode: 'none', stoppedOnly: true }), async lease => {
      assert.equal(f.coordinator.retireRegistrationOnRelease(lease), true);
    });
  assert.equal(await f.coordinator.runMutation(selector('server-fresh', SHARED_PATH), {
    operation: 'install-new', operationId: 'fresh-install-job', revisionMode: 'none', quiesce: async () => {}
  }, async lease => lease.instanceId), 'server-fresh');
});

test('a lifecycle fence survives retirement and re-binding of its folder', async () => {
  const f = fixture({ capability: createLegacyInstanceConfigFs() });
  f.control.failure = () => new Error('the server config is locked');
  await write(f, selector('fenced-server', SHARED_PATH), 'unrecorded-write');
  f.control.failure = null;
  assert.equal(f.coordinator.retireIdleRegistration(selector('fenced-server', SHARED_PATH)), true);
  assert.equal(f.coordinator.pathBinding(SHARED_PATH), null);

  await assert.rejects(
    f.coordinator.runMutation(selector('re-added-server', SHARED_PATH), lifecycleOptions('fenced-after-retirement'),
      async () => assert.fail('lifecycle admitted')),
    code('PLAN_STALE')
  );
  assert.equal(f.revision(SHARED_PATH), 1);
  assert.equal(await f.coordinator.runMutation(selector('re-added-server', SHARED_PATH), lifecycleOptions('reviewed-again'),
    async lease => {
      lease.markDirty();
      f.setRevision(SHARED_PATH, lease.baseRevision + 1);
      return 'published';
    }), 'published');
});

test('assertUnstartedMutation refuses every coordinator state that proves or may hide an acquisition', async () => {
  const launch = folder => selector('launch-server', folder);
  const options = { operationId: 'launch-job' };
  const f = fixture();

  assert.equal(f.coordinator.assertUnstartedMutation(launch('C:\\Servers\\Untouched'), options), true);
  const globallyBlocked = new ServerMutationCoordinator({
    context: createServerMutationContext(), readContentRevision: () => 0, bumpContentRevision: () => 1
  });
  assert.throws(() => globallyBlocked.assertUnstartedMutation(launch('C:\\Servers\\Untouched'), options),
    code('RECOVERY_REQUIRED'));

  f.coordinator.beginStartupRecovery();
  f.coordinator.installRecoveryBlocks([{ operationId: 'blocked-job', selector: selector('blocked-server', 'C:\\Servers\\Blocked') }]);
  f.coordinator.completeStartupRecovery([{ resolved: false, selector: selector('blocked-server', 'C:\\Servers\\Blocked') }]);
  assert.throws(() => f.coordinator.assertUnstartedMutation(launch('C:\\Servers\\Blocked'), options),
    error => error?.code === 'RECOVERY_REQUIRED' && error.details?.operationId === 'blocked-job');

  f.control.failure = () => new Error('disk uncertain');
  await assert.rejects(f.coordinator.runMutation(selector('failed-server', 'C:\\Servers\\Failed'), {
    operation: 'test-write', operationId: 'failed-write', revisionMode: 'auto', quiesce: null
  }, async lease => lease.markDirty()), code('COMMIT_FAILED'));
  f.control.failure = null;
  assert.throws(() => f.coordinator.assertUnstartedMutation(launch('C:\\Servers\\Failed'), options),
    error => error?.code === 'RECOVERY_REQUIRED' && error.details?.operationId === 'failed-write');

  const foreign = await holdRun(work => f.coordinator.runMutation(selector('foreign-server', 'C:\\Servers\\Foreign'), {
    operation: 'install-new', operationId: 'foreign-install', revisionMode: 'none', quiesce: null
  }, work));
  try {
    assert.throws(() => f.coordinator.assertUnstartedMutation(launch('C:\\Servers\\Foreign'), options),
      inProgressBy('foreign-install'));
  } finally {
    foreign.gate.resolve();
  }
  await foreign.run;
  assert.equal(f.coordinator.assertUnstartedMutation(launch('C:\\Servers\\Foreign'), options), true);

  const shared = await holdRun(work => f.coordinator.runMutation(selector('foreign-server', 'C:\\Servers\\Foreign'),
    ordinaryOptions('foreign-shared-writer', { revisionMode: 'none' }), work));
  try {
    assert.throws(() => f.coordinator.assertUnstartedMutation(launch('C:\\Servers\\Foreign'), options),
      inProgressBy('foreign-shared-writer'));
  } finally {
    shared.gate.resolve();
  }
  await shared.run;

  const start = await f.coordinator.acquireStart(selector('started-server', 'C:\\Servers\\Started'), startOptions('foreign-start'));
  assert.throws(() => f.coordinator.assertUnstartedMutation(launch('C:\\Servers\\Started'), options),
    inProgressBy('foreign-start'));
  start.release();

  await f.coordinator.runMutation(launch('C:\\Servers\\Own'), {
    operation: 'install-new', operationId: 'earlier-own-install', revisionMode: 'none', quiesce: null
  }, async () => {});
  assert.throws(() => f.coordinator.assertUnstartedMutation(launch('C:\\Servers\\Own'), options), code('INVALID_REQUEST'));

  // Another alias whose record was reserved by this launch's own operation.
  await f.coordinator.runMutation(selector('alias-server', 'C:\\Servers\\Own-operation'), {
    operation: 'install-new', operationId: 'launch-job', revisionMode: 'none', quiesce: null
  }, async () => {});
  assert.throws(() => f.coordinator.assertUnstartedMutation(selector('unbound-launch', 'C:\\Servers\\Own-operation'), options),
    code('INVALID_REQUEST'));
  assert.equal(f.coordinator.assertUnstartedMutation(selector('unbound-launch', 'C:\\Servers\\Own-operation'), {
    operationId: 'another-launch'
  }), true);

  // The launch id is bound to another folder: the aliases are split.
  assert.throws(() => f.coordinator.assertUnstartedMutation(launch('C:\\Servers\\Foreign'), options), code('INVALID_REQUEST'));
});

test('drive roots and share roots are server folders; device and relative paths are not', async () => {
  const f = fixture();
  const driveRoot = await f.coordinator.acquireStart(selector('drive-root', 'E:\\'), startOptions('drive-root-start'));
  assert.equal(driveRoot.serverPath, 'E:\\');
  assert.equal(driveRoot.assertOwnedPath('e:/world/level.dat'), 'E:\\world\\level.dat');
  assert.equal(driveRoot.assertOwnedPath('E:\\'), 'E:\\');
  assert.throws(() => driveRoot.assertOwnedPath('F:\\world'), code('INVALID_REQUEST'));
  driveRoot.release();
  assert.equal(await startAndStop(f, { serverPath: 'e:/' }, 'drive-root-alias'), 'drive-root');

  const shareRoot = await f.coordinator.acquireStart(selector('share-root', '\\\\nas\\share'), startOptions('share-root-start'));
  assert.equal(shareRoot.serverPath, '\\\\nas\\share\\');
  assert.equal(shareRoot.assertOwnedPath('\\\\NAS\\share\\world'), '\\\\NAS\\share\\world');
  assert.throws(() => shareRoot.assertOwnedPath('\\\\nas\\other\\world'), code('INVALID_REQUEST'));
  shareRoot.release();
  assert.equal(await startAndStop(f, { serverPath: '//NAS/Share/' }, 'share-root-alias'), 'share-root');
  assert.equal(await write(f, selector('share-child', '\\\\nas\\share\\server'), 'share-child-write'), 'share-child');

  for (const serverPath of [
    '\\\\?\\C:\\Minecraft', '\\\\.\\pipe\\minecraft', '\\\\?\\UNC\\nas\\share', '//?/C:/Minecraft', '\\\\nas', '\\\\nas\\',
    '\\\\\\nas\\share', '/', '\\', 'E:', 'relative\\server', 'C:\\Minecraft\\..\\Alpha'
  ]) {
    await assert.rejects(
      f.coordinator.acquireStart({ serverPath }, startOptions('invalid-root')),
      code('INVALID_REQUEST'),
      serverPath
    );
    assert.equal(f.coordinator.pathBinding(serverPath), null);
  }
});

test('an NFD-named folder keeps its on-disk spelling and an NFC selector finds the same record', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-identity-nfd-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const nfdName = 'Cafe\u0301 Server';
  const nfdPath = path.join(parent, nfdName);
  const nfcPath = path.join(parent, nfdName.normalize('NFC'));
  assert.notEqual(nfdPath, nfcPath);
  fs.mkdirSync(nfdPath);
  fs.writeFileSync(path.join(nfdPath, '.minecraft-core.json'), `${JSON.stringify({ contentRevision: 2 }, null, 2)}\n`);
  const strictCalls = [];
  const coordinator = new ServerMutationCoordinator({
    context: createServerMutationContext(),
    durableFsFactory: createInstanceConfigFsFactory({
      strictFactory(roots) {
        strictCalls.push(roots);
        throw new Error('The strict writer is never used for an unmanaged folder');
      }
    })
  });
  coordinator.completeStartupRecovery([]);

  const start = await coordinator.acquireStart(selector('nfd-server', nfdPath), startOptions('nfd-start'));
  assert.equal(start.serverPath, nfdPath);
  assert.equal(fs.existsSync(start.serverPath), true);
  assert.equal(start.baseRevision, 2);
  start.markDirty();
  start.markRunning({ pid: 5002 });
  start.release();
  assert.equal(readContentRevision(nfdPath), 3);
  assert.deepEqual(strictCalls, []);

  const byNfc = await coordinator.acquireStart({ serverPath: nfcPath }, startOptions('nfc-selector'));
  assert.equal(byNfc.instanceId, 'nfd-server');
  assert.equal(byNfc.serverPath, nfdPath);
  byNfc.release();
  assert.deepEqual(coordinator.pathBinding(nfcPath), { instanceId: 'nfd-server' });
});
