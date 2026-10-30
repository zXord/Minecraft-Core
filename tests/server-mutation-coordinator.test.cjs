const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ServerMutationCoordinator
} = require('../electron/services/server-mutation-coordinator.cjs');
const {
  createServerMutationContext
} = require('../electron/services/server-mutation-context.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');

const ALPHA_PATH = 'C:\\Minecraft\\Alpha';
const BETA_PATH = 'C:\\Minecraft\\Beta';
const GAMMA_PATH = 'C:\\Minecraft\\Gamma';

test('runtime uncertainty installs a persistent exact recovery block before mutation release', async () => {
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 0, bumpContentRevision: () => 1 });
  coordinator.completeStartupRecovery([]); let held;
  await coordinator.runMutation({ instanceId: 'alpha', serverPath: ALPHA_PATH }, {
    operation: 'runtime-prepare', operationId: 'runtime-job', revisionMode: 'none', quiesce: null
  }, async lease => { held = lease; assert.equal(coordinator.quarantineMutation(lease), true); });
  assert.throws(() => coordinator.quarantineMutation(held), { code: 'INVALID_REQUEST' });
  await assert.rejects(coordinator.runMutation({ instanceId: 'alpha', serverPath: ALPHA_PATH }, {
    operation: 'other-write', operationId: 'other-job', revisionMode: 'none', quiesce: null
  }, async () => assert.fail('writer admitted')), { code: 'RECOVERY_REQUIRED' });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function windowsKey(value) {
  return path.win32.normalize(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function selector(instanceId, serverPath) {
  return { instanceId, serverPath };
}

function mutationOptions(operationId, overrides = {}) {
  return {
    operation: 'test-write',
    operationId,
    revisionMode: 'none',
    quiesce: null,
    ...overrides
  };
}

function startOptions(operationId, overrides = {}) {
  return {
    operation: 'test-start',
    operationId,
    parentMutationLease: null,
    ...overrides
  };
}

function fixture(initialRevisions = {}) {
  const revisions = new Map();
  for (const [serverPath, revision] of Object.entries(initialRevisions)) {
    revisions.set(windowsKey(serverPath), revision);
  }
  const calls = [];
  const context = createServerMutationContext();
  const coordinator = new ServerMutationCoordinator({
    context,
    readContentRevision(serverPath) {
      const key = windowsKey(serverPath);
      calls.push({ kind: 'read', key });
      return revisions.get(key) || 0;
    },
    bumpContentRevision(serverPath, options) {
      const key = windowsKey(serverPath);
      const current = revisions.get(key) || 0;
      calls.push({ kind: 'bump', key, options: { ...options } });
      assert.equal(options.expectedRevision, current);
      revisions.set(key, current + 1);
      return current + 1;
    }
  });
  return { calls, context, coordinator, revisions };
}

function completeEmptyRecovery(coordinator) {
  coordinator.completeStartupRecovery([]);
}

function code(expected) {
  return error => error && error.code === expected;
}

test('coordinator is fail-closed until startup recovery is explicitly completed', async () => {
  const { coordinator } = fixture({ [ALPHA_PATH]: 2 });

  await assert.rejects(
    coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('start-before-recovery')),
    code('RECOVERY_REQUIRED')
  );
  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('write-before-recovery'),
      async () => {}
    ),
    code('RECOVERY_REQUIRED')
  );

  coordinator.completeStartupRecovery([]);
  const lease = await coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('start-after-recovery'));
  assert.equal(lease.baseRevision, 2);
  lease.release();
});

test('Windows case and slash aliases bind one stable instance/path record', async () => {
  const { coordinator } = fixture({ [ALPHA_PATH]: 4 });
  completeEmptyRecovery(coordinator);
  const gate = deferred();

  const mutation = coordinator.runMutation(
    selector('Server-Alpha', ALPHA_PATH),
    mutationOptions('writer-alpha'),
    async lease => {
      assert.equal(lease.baseRevision, 4);
      await gate.promise;
    }
  );

  await assert.rejects(
    coordinator.acquireStart(
      selector('server-alpha', 'c:/minecraft/ALPHA/'),
      startOptions('alias-start')
    ),
    code('OPERATION_IN_PROGRESS')
  );

  gate.resolve();
  await mutation;

  const byInstance = await coordinator.acquireStart({ instanceId: 'SERVER-ALPHA' }, startOptions('by-instance'));
  assert.equal(byInstance.serverPath, ALPHA_PATH);
  byInstance.release();
  const byPath = await coordinator.acquireStart({ serverPath: 'c:/MINECRAFT/alpha' }, startOptions('by-path'));
  assert.equal(byPath.instanceId, 'Server-Alpha');
  byPath.release();
});

test('ambiguous instance or path alias rebinding is rejected without corrupting the first binding', async () => {
  const { coordinator } = fixture();
  completeEmptyRecovery(coordinator);
  const first = await coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('bind-alpha'));
  first.release();

  await assert.rejects(
    coordinator.acquireStart(selector('alpha', BETA_PATH), startOptions('rebind-path')),
    code('INVALID_REQUEST')
  );
  await assert.rejects(
    coordinator.acquireStart(selector('beta', ALPHA_PATH), startOptions('rebind-instance')),
    code('INVALID_REQUEST')
  );

  const stable = await coordinator.acquireStart(selector('ALPHA', 'c:/minecraft/alpha'), startOptions('stable-alpha'));
  stable.release();
});

test('authenticated abandoned incarnation retirement waits for its exact mutation release', async () => {
  const { coordinator } = fixture(); completeEmptyRecovery(coordinator);
  const gate = deferred(); const entered = deferred();
  const first = coordinator.runMutation(selector('abandoned', ALPHA_PATH), mutationOptions('first-install', { operation: 'install-new' }), async () => {
    coordinator.retireAbandonedIncarnation(selector('abandoned', ALPHA_PATH), { operationId: 'first-install' });
    entered.resolve(); await gate.promise;
  });
  // Do not leave this test hanging when the new boundary is not implemented.
  const ready = await Promise.race([entered.promise.then(() => true), first.then(() => false, error => { throw error; })]);
  assert.equal(ready, true);
  await assert.rejects(coordinator.runMutation(selector('replacement', ALPHA_PATH), mutationOptions('too-early'), async () => {}), code('INVALID_REQUEST'));
  gate.resolve(); await first;
  let admitted = false;
  await coordinator.runMutation(selector('replacement', ALPHA_PATH), mutationOptions('second-install'), async () => { admitted = true; });
  assert.equal(admitted, true);
  assert.equal(coordinator.retireAbandonedIncarnation(selector('abandoned', ALPHA_PATH), { operationId: 'first-install' }), false,
    'late old closure must not retire the replacement');
});

test('abandoned incarnation retirement rejects wrong owner and retains ordinary alias guards', async () => {
  const { coordinator } = fixture(); completeEmptyRecovery(coordinator);
  await coordinator.runMutation(selector('abandoned', ALPHA_PATH), mutationOptions('first-install', { operation: 'install-new' }), async () => {});
  for (const [selected, operationId] of [[selector('abandoned', ALPHA_PATH), 'other-operation'],
    [selector('abandoned', BETA_PATH), 'first-install']]) {
    assert.throws(() => coordinator.retireAbandonedIncarnation(selected, { operationId }), code('INVALID_REQUEST'));
  }
  const start = await coordinator.acquireStart(selector('abandoned', ALPHA_PATH), startOptions('live-start'));
  assert.throws(() => coordinator.retireAbandonedIncarnation(selector('abandoned', ALPHA_PATH), { operationId: 'first-install' }), code('OPERATION_IN_PROGRESS'));
  start.release();
  coordinator.beginStartupRecovery();
  coordinator.installRecoveryBlocks([{ operationId: 'blocked-install', selector: selector('abandoned', ALPHA_PATH) }]);
  coordinator.completeStartupRecovery([{ resolved: false, selector: selector('abandoned', ALPHA_PATH) }]);
  assert.throws(() => coordinator.retireAbandonedIncarnation(selector('abandoned', ALPHA_PATH), { operationId: 'first-install' }), code('RECOVERY_REQUIRED'));
  await assert.rejects(coordinator.runMutation(selector('replacement', ALPHA_PATH), mutationOptions('second-install'), async () => {}), code('RECOVERY_REQUIRED'));
});

test('abandoned incarnation retirement accepts only its resolved recovery owner after restart', async () => {
  const { coordinator } = fixture();
  coordinator.installRecoveryBlocks([{ operationId: 'interrupted-install', selector: selector('abandoned', ALPHA_PATH) }]);
  coordinator.completeStartupRecovery([{ resolved: true, selector: selector('abandoned', ALPHA_PATH) }]);
  assert.throws(() => coordinator.retireAbandonedIncarnation(selector('abandoned', ALPHA_PATH), { operationId: 'unrelated' }), code('INVALID_REQUEST'));
  assert.equal(coordinator.retireAbandonedIncarnation(selector('abandoned', ALPHA_PATH), { operationId: 'interrupted-install' }), true);
  assert.equal(await coordinator.runMutation(selector('replacement', ALPHA_PATH), mutationOptions('replacement-install'), async () => 'admitted'), 'admitted');
});

test('a pending mutation reserves synchronously before quiesce awaits and blocks a second writer', async () => {
  const { coordinator } = fixture();
  completeEmptyRecovery(coordinator);
  const quiesceGate = deferred();
  let workStarted = false;

  const first = coordinator.runMutation(
    selector('alpha', ALPHA_PATH),
    mutationOptions('pending-writer', {
      quiesce: async () => quiesceGate.promise
    }),
    async () => {
      workStarted = true;
    }
  );

  await assert.rejects(
    coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('blocked-start')),
    code('OPERATION_IN_PROGRESS')
  );
  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('blocked-writer'),
      async () => {}
    ),
    code('OPERATION_IN_PROGRESS')
  );
  assert.equal(workStarted, false);

  quiesceGate.resolve();
  await first;
  assert.equal(workStarted, true);
});

test('a pending start blocks mutation and a running start requires quiescence', async () => {
  const { coordinator } = fixture();
  completeEmptyRecovery(coordinator);

  const pending = await coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('pending-start'));
  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('writer-vs-pending'),
      async () => {}
    ),
    code('OPERATION_IN_PROGRESS')
  );
  pending.markRunning({ pid: 42 });
  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('writer-vs-run'),
      async () => {}
    ),
    code('SERVER_RUNNING')
  );

  const order = [];
  await coordinator.runMutation(
    selector('alpha', ALPHA_PATH),
    mutationOptions('quiescing-writer', {
      quiesce: async () => {
        order.push('quiesce');
        pending.release();
      }
    }),
    async () => {
      order.push('work');
    }
  );
  assert.deepEqual(order, ['quiesce', 'work']);
});

test('auto revision mode bumps exactly once after dirty success and dirty failure', async () => {
  const { calls, coordinator, revisions } = fixture({ [ALPHA_PATH]: 7 });
  completeEmptyRecovery(coordinator);

  const result = await coordinator.runMutation(
    selector('alpha', ALPHA_PATH),
    mutationOptions('auto-success', { revisionMode: 'auto' }),
    async lease => {
      lease.markDirty();
      lease.markDirty();
      return 'result';
    }
  );
  assert.equal(result, 'result');
  assert.equal(revisions.get(windowsKey(ALPHA_PATH)), 8);

  const partial = new Error('partial write failed');
  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('auto-failure', { revisionMode: 'auto' }),
      async lease => {
        lease.markDirty();
        throw partial;
      }
    ),
    error => error === partial
  );
  assert.equal(revisions.get(windowsKey(ALPHA_PATH)), 9);
  assert.deepEqual(
    calls.filter(call => call.kind === 'bump').map(call => call.options.operationId),
    ['auto-success', 'auto-failure']
  );
});

test('uncertain publication failures quarantine without publishing a replacement revision', async t => {
  const recoveryCases = [
    ['PLAN_STALE', 'post-publication'],
    ['PLAN_STALE', 'post-publication-uncertain'],
    ['COMMIT_FAILED', 'post-publication'],
    ['COMMIT_FAILED', 'post-publication-uncertain']
  ];

  for (const [failureCode, commitPhase] of recoveryCases) {
    await t.test(`${failureCode} ${commitPhase}`, async () => {
      const { calls, coordinator, revisions } = fixture({ [ALPHA_PATH]: 7 });
      completeEmptyRecovery(coordinator);
      const failure = new ModpackError(failureCode, 'Publication outcome requires recovery');
      Object.defineProperty(failure, 'commitPhase', {
        configurable: false,
        enumerable: false,
        value: commitPhase,
        writable: false
      });

      await assert.rejects(
        coordinator.runMutation(
          selector('alpha', ALPHA_PATH),
          mutationOptions(`uncertain-${failureCode.toLowerCase()}-${commitPhase}`, { revisionMode: 'auto' }),
          async lease => {
            lease.markDirty();
            throw failure;
          }
        ),
        error => error === failure
      );

      assert.equal(revisions.get(windowsKey(ALPHA_PATH)), 7);
      assert.equal(calls.filter(call => call.kind === 'bump').length, 0);
      await assert.rejects(
        coordinator.acquireStart(
          selector('alpha', ALPHA_PATH),
          startOptions(`blocked-${failureCode.toLowerCase()}-${commitPhase}`)
        ),
        code('RECOVERY_REQUIRED')
      );
    });
  }

  await t.test('pre-publication failure keeps ordinary dirty revision behavior', async () => {
    const { calls, coordinator, revisions } = fixture({ [ALPHA_PATH]: 7 });
    completeEmptyRecovery(coordinator);
    const failure = new ModpackError('COMMIT_FAILED', 'Publication failed before becoming live');
    Object.defineProperty(failure, 'commitPhase', {
      configurable: false,
      enumerable: false,
      value: 'pre-publication',
      writable: false
    });

    await assert.rejects(
      coordinator.runMutation(
        selector('alpha', ALPHA_PATH),
        mutationOptions('pre-publication-failure', { revisionMode: 'auto' }),
        async lease => {
          lease.markDirty();
          throw failure;
        }
      ),
      error => error === failure
    );

    assert.equal(revisions.get(windowsKey(ALPHA_PATH)), 8);
    assert.equal(calls.filter(call => call.kind === 'bump').length, 1);
    const lease = await coordinator.acquireStart(
      selector('alpha', ALPHA_PATH),
      startOptions('allowed-after-pre-publication')
    );
    lease.release();
  });
});

test('lifecycle validates exact base plus one without bumping and none never changes revision', async () => {
  const { calls, coordinator, revisions } = fixture({ [ALPHA_PATH]: 10, [BETA_PATH]: 3 });
  completeEmptyRecovery(coordinator);

  await coordinator.runMutation(
    selector('alpha', ALPHA_PATH),
    mutationOptions('lifecycle-exact', { revisionMode: 'lifecycle' }),
    async lease => {
      lease.markDirty();
      revisions.set(windowsKey(ALPHA_PATH), 11);
    }
  );
  assert.equal(calls.filter(call => call.kind === 'bump').length, 0);

  await coordinator.runMutation(
    selector('beta', BETA_PATH),
    mutationOptions('none-dirty', { revisionMode: 'none' }),
    async lease => lease.markDirty()
  );
  assert.equal(revisions.get(windowsKey(BETA_PATH)), 3);

  const mismatch = fixture({ [GAMMA_PATH]: 20 });
  completeEmptyRecovery(mismatch.coordinator);
  await assert.rejects(
    mismatch.coordinator.runMutation(
      selector('gamma', GAMMA_PATH),
      mutationOptions('lifecycle-mismatch', { revisionMode: 'lifecycle' }),
      async lease => lease.markDirty()
    ),
    code('PLAN_STALE')
  );
  assert.equal(mismatch.calls.filter(call => call.kind === 'bump').length, 0);
  await assert.rejects(
    mismatch.coordinator.acquireStart(selector('gamma', GAMMA_PATH), startOptions('blocked-after-mismatch')),
    code('RECOVERY_REQUIRED')
  );
});

test('dirty lifecycle cleanup preserves a pre-publication failure when no revision was published', async () => {
  const { coordinator, revisions } = fixture({ [ALPHA_PATH]: 20 });
  completeEmptyRecovery(coordinator);
  const failure = new ModpackError('PLAN_STALE', 'The reviewed plan changed before publication');

  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('lifecycle-pre-publication-cleanup', { revisionMode: 'lifecycle' }),
      async lease => {
        // Candidate cleanup and policy restoration can perform app-owned I/O
        // after the primary failure without publishing a content revision.
        lease.markDirty();
        throw failure;
      }
    ),
    error => error === failure
  );

  assert.equal(revisions.get(windowsKey(ALPHA_PATH)), 20);
  const start = await coordinator.acquireStart(
    selector('alpha', ALPHA_PATH),
    startOptions('allowed-after-lifecycle-pre-publication-cleanup')
  );
  start.release();
});

test('lifecycle failure handling still quarantines publication uncertainty and impossible revisions', async t => {
  await t.test('explicit post-publication uncertainty remains recovery-required', async () => {
    const { coordinator } = fixture({ [ALPHA_PATH]: 20 });
    completeEmptyRecovery(coordinator);
    const failure = new ModpackError('COMMIT_FAILED', 'Publication outcome is uncertain');
    Object.defineProperty(failure, 'commitPhase', {
      configurable: false,
      enumerable: false,
      value: 'post-publication-uncertain',
      writable: false
    });

    await assert.rejects(
      coordinator.runMutation(
        selector('alpha', ALPHA_PATH),
        mutationOptions('lifecycle-post-publication-uncertain', { revisionMode: 'lifecycle' }),
        async lease => {
          lease.markDirty();
          throw failure;
        }
      ),
      error => error === failure
    );
    await assert.rejects(
      coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('blocked-after-uncertain-publication')),
      code('RECOVERY_REQUIRED')
    );
  });

  await t.test('an unexpected revision still overrides the primary failure and quarantines', async () => {
    const { coordinator, revisions } = fixture({ [BETA_PATH]: 8 });
    completeEmptyRecovery(coordinator);
    const failure = new Error('candidate cleanup failed');

    await assert.rejects(
      coordinator.runMutation(
        selector('beta', BETA_PATH),
        mutationOptions('lifecycle-impossible-revision', { revisionMode: 'lifecycle' }),
        async lease => {
          lease.markDirty();
          revisions.set(windowsKey(BETA_PATH), 10);
          throw failure;
        }
      ),
      error => error !== failure && error?.code === 'PLAN_STALE'
    );
    await assert.rejects(
      coordinator.acquireStart(selector('beta', BETA_PATH), startOptions('blocked-after-impossible-revision')),
      code('RECOVERY_REQUIRED')
    );
  });
});

test('revision write failure fails closed while releasing the mutation reservation', async () => {
  const context = createServerMutationContext();
  const coordinator = new ServerMutationCoordinator({
    context,
    readContentRevision: () => 2,
    bumpContentRevision() {
      throw new Error('disk uncertain');
    }
  });
  completeEmptyRecovery(coordinator);

  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('failed-bump', { revisionMode: 'auto' }),
      async lease => lease.markDirty()
    ),
    code('COMMIT_FAILED')
  );
  await assert.rejects(
    coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('blocked-after-bump')),
    code('RECOVERY_REQUIRED')
  );
});

test('production revision writes create durability scoped to the exact server root', async (t) => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-coordinator-durable-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const configPath = path.join(serverPath, '.minecraft-core.json');
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 3, preserved: true }));
  const requestedRoots = [];
  let sequence = 0;
  const coordinator = new ServerMutationCoordinator({
    durableFsFactory(allowedRoots) {
      requestedRoots.push([...allowedRoots]);
      return createDurableFs({
        fsApi: fs,
        durableClient: {
          flushDirectory() {},
          moveWriteThrough(sourcePath, destinationPath) {
            fs.renameSync(sourcePath, destinationPath);
          },
          replaceFileWriteThrough(sourcePath, destinationPath) {
            fs.renameSync(sourcePath, destinationPath);
          }
        },
        allowedRoots,
        tempNameFactory: () => `coordinator-revision-${++sequence}`
      });
    }
  });
  completeEmptyRecovery(coordinator);

  await coordinator.runMutation(
    selector('server-durable', serverPath),
    mutationOptions('durable-root-write', { revisionMode: 'auto' }),
    async lease => lease.markDirty()
  );

  assert.deepEqual(requestedRoots, [[serverPath]]);
  const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(persisted.contentRevision, 4);
  assert.equal(persisted.preserved, true);
});

test('coordinator rejects ambiguous durable filesystem injection', () => {
  assert.throws(
    () => new ServerMutationCoordinator({
      durableFs: Object.freeze({}),
      durableFsFactory() { return Object.freeze({}); }
    }),
    code('INVALID_REQUEST')
  );
});

test('durable filesystem factory failure leaves the exact server fail-closed', async () => {
  const { context } = fixture();
  const coordinator = new ServerMutationCoordinator({
    context,
    readContentRevision: () => 0,
    durableFsFactory() {
      throw new Error('durability unavailable');
    }
  });
  completeEmptyRecovery(coordinator);

  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('durable-factory-failure', { revisionMode: 'auto' }),
      async lease => lease.markDirty()
    ),
    code('COMMIT_FAILED')
  );
  await assert.rejects(
    coordinator.acquireStart(
      selector('alpha', ALPHA_PATH),
      startOptions('blocked-after-durable-factory-failure')
    ),
    code('RECOVERY_REQUIRED')
  );
});

test('nested starts require the live matching parent lease and remain serialized', async () => {
  const { coordinator } = fixture();
  completeEmptyRecovery(coordinator);
  let retainedLease;

  await coordinator.runMutation(
    selector('alpha', ALPHA_PATH),
    mutationOptions('parent-write'),
    async mutationLease => {
      retainedLease = mutationLease;
      await assert.rejects(
        coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('implicit-nested')),
        code('INVALID_REQUEST')
      );

      const first = await coordinator.acquireStart(
        selector('alpha', ALPHA_PATH),
        startOptions('candidate-start', { parentMutationLease: mutationLease })
      );
      first.markRunning({ pid: 101 });
      await assert.rejects(
        coordinator.acquireStart(
          selector('alpha', ALPHA_PATH),
          startOptions('parallel-final-start', { parentMutationLease: mutationLease })
        ),
        code('OPERATION_IN_PROGRESS')
      );
      first.release();

      const candidate = await coordinator.acquireStart(
        selector('alpha', 'C:\\Minecraft\\.Alpha.candidate-parent-write'),
        startOptions('candidate-sibling-start', { parentMutationLease: mutationLease })
      );
      assert.equal(candidate.serverPath, 'C:\\Minecraft\\.Alpha.candidate-parent-write');
      assert.equal(
        candidate.assertOwnedPath('C:\\Minecraft\\.Alpha.candidate-parent-write\\server.properties'),
        'C:\\Minecraft\\.Alpha.candidate-parent-write\\server.properties'
      );
      candidate.markDirty();
      candidate.release();

      const second = await coordinator.acquireStart(
        selector('alpha', ALPHA_PATH),
        startOptions('final-start', { parentMutationLease: mutationLease })
      );
      second.release();
    }
  );

  await assert.rejects(
    coordinator.acquireStart(
      selector('alpha', ALPHA_PATH),
      startOptions('stale-parent', { parentMutationLease: retainedLease })
    ),
    code('INVALID_REQUEST')
  );

  await assert.rejects(
    coordinator.acquireStart(
      selector('alpha', 'C:\\Minecraft\\.Alpha.candidate-parent-write'),
      startOptions('candidate-was-not-rebound')
    ),
    code('INVALID_REQUEST')
  );
});

test('implicit mutation reentrancy is rejected without releasing the outer lease', async () => {
  const { coordinator } = fixture();
  completeEmptyRecovery(coordinator);

  await coordinator.runMutation(
    selector('alpha', ALPHA_PATH),
    mutationOptions('outer-write'),
    async () => {
      await assert.rejects(
        coordinator.runMutation(
          selector('alpha', ALPHA_PATH),
          mutationOptions('inner-write'),
          async () => {}
        ),
        code('INVALID_REQUEST')
      );
      await assert.rejects(
        coordinator.acquireStart(selector('beta', BETA_PATH), startOptions('implicit-cross-start')),
        code('INVALID_REQUEST')
      );
    }
  );
});

test('multi-server reservations are deterministic and all-or-nothing', async () => {
  const { calls, coordinator } = fixture({ [ALPHA_PATH]: 1, [BETA_PATH]: 2 });
  completeEmptyRecovery(coordinator);
  const gate = deferred();
  let leasePaths;

  const many = coordinator.runManyMutations(
    [selector('beta', BETA_PATH), selector('alpha', ALPHA_PATH)],
    mutationOptions('many-write'),
    async leases => {
      leasePaths = leases.map(lease => lease.serverPath);
      await gate.promise;
    }
  );

  await assert.rejects(
    coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('blocked-alpha')),
    code('OPERATION_IN_PROGRESS')
  );
  await assert.rejects(
    coordinator.acquireStart(selector('beta', BETA_PATH), startOptions('blocked-beta')),
    code('OPERATION_IN_PROGRESS')
  );
  gate.resolve();
  await many;
  assert.deepEqual(leasePaths, [ALPHA_PATH, BETA_PATH]);
  assert.deepEqual(calls.filter(call => call.kind === 'read').map(call => call.key), [
    windowsKey(ALPHA_PATH),
    windowsKey(BETA_PATH)
  ]);

  const occupied = deferred();
  const active = coordinator.runMutation(
    selector('beta', BETA_PATH),
    mutationOptions('occupied-beta'),
    async () => occupied.promise
  );
  await assert.rejects(
    coordinator.runManyMutations(
      [selector('alpha', ALPHA_PATH), selector('beta', BETA_PATH)],
      mutationOptions('failed-many'),
      async () => {}
    ),
    code('OPERATION_IN_PROGRESS')
  );
  const alphaStart = await coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('alpha-remains-free'));
  alphaStart.release();
  occupied.resolve();
  await active;
});

test('cancellation before work releases every reservation', async () => {
  const { coordinator } = fixture();
  completeEmptyRecovery(coordinator);
  const controller = new AbortController();
  controller.abort();
  let workCalled = false;

  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('cancelled-write', { signal: controller.signal }),
      async () => {
        workCalled = true;
      }
    ),
    code('CANCELLED')
  );
  assert.equal(workCalled, false);
  const start = await coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('after-cancel'));
  start.release();
});

test('cancellation is cooperative and retains reservations until quiesce confirms it settled', async () => {
  const { coordinator } = fixture();
  completeEmptyRecovery(coordinator);
  const controller = new AbortController();
  const quiesceEntered = deferred();
  const quiesceSettled = deferred();
  let quiesceContext = null;
  let workCalled = false;

  const mutation = coordinator.runMutation(
    selector('alpha', ALPHA_PATH),
    mutationOptions('cancelled-hung-quiesce', {
      signal: controller.signal,
      quiesce: async context => {
        quiesceContext = context;
        quiesceEntered.resolve();
        await quiesceSettled.promise;
      }
    }),
    async () => {
      workCalled = true;
    }
  );
  let mutationSettled = false;
  mutation.then(
    () => { mutationSettled = true; },
    () => { mutationSettled = true; }
  );

  await quiesceEntered.promise;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));

  try {
    assert.equal(mutationSettled, false);
    assert.equal(quiesceContext.signal, controller.signal);
    assert.equal(quiesceContext.signal.aborted, true);
    await assert.rejects(
      coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('blocked-during-cancelled-quiesce')),
      code('OPERATION_IN_PROGRESS')
    );
  } finally {
    quiesceSettled.resolve();
  }

  await assert.rejects(mutation, code('CANCELLED'));
  assert.equal(workCalled, false);
  const start = await coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('after-quiesce-cancel'));
  start.release();
});

test('cancellation during dirty work aborts before commit while preserving the revision audit', async () => {
  const { calls, coordinator, revisions } = fixture({ [ALPHA_PATH]: 12 });
  completeEmptyRecovery(coordinator);
  const controller = new AbortController();

  await assert.rejects(
    coordinator.runMutation(
      selector('alpha', ALPHA_PATH),
      mutationOptions('cancelled-dirty-write', {
        revisionMode: 'auto',
        signal: controller.signal
      }),
      async lease => {
        lease.markDirty();
        controller.abort();
      }
    ),
    code('CANCELLED')
  );
  assert.equal(revisions.get(windowsKey(ALPHA_PATH)), 13);
  assert.deepEqual(
    calls.filter(call => call.kind === 'bump').map(call => call.options.operationId),
    ['cancelled-dirty-write']
  );

  const start = await coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('after-dirty-cancel'));
  start.release();
});

test('recovery completion clears resolved blocks and retains exact unresolved aliases', async () => {
  const { coordinator } = fixture();
  coordinator.installRecoveryBlocks([
    {
      selector: selector('alpha', ALPHA_PATH),
      operationId: 'recovery-alpha'
    },
    {
      selector: selector('beta', BETA_PATH),
      operationId: 'recovery-beta'
    }
  ]);

  await assert.rejects(
    coordinator.acquireStart(selector('unrelated', GAMMA_PATH), startOptions('global-block')),
    code('RECOVERY_REQUIRED')
  );

  coordinator.completeStartupRecovery([
    {
      selector: selector('alpha', ALPHA_PATH),
      resolved: true
    },
    {
      selector: selector('beta', BETA_PATH),
      resolved: false
    }
  ]);

  const alpha = await coordinator.acquireStart({ serverPath: 'c:/minecraft/ALPHA' }, startOptions('resolved-alpha'));
  alpha.release();
  const unrelated = await coordinator.acquireStart(selector('gamma', GAMMA_PATH), startOptions('unrelated-after-recovery'));
  unrelated.release();
  await assert.rejects(
    coordinator.acquireStart({ instanceId: 'BETA' }, startOptions('unresolved-beta')),
    error => error.code === 'RECOVERY_REQUIRED' && error.details?.operationId === 'recovery-beta'
  );

  assert.throws(
    () => coordinator.installRecoveryBlocks([]),
    code('INVALID_REQUEST')
  );
});

test('a fresh reservation for an unresolved recovery path reports recovery instead of an invalid request', async () => {
  const { coordinator } = fixture();
  let workCalled = false;
  coordinator.installRecoveryBlocks([{
    selector: selector('previous-reservation', ALPHA_PATH),
    operationId: 'unfinished-new-server'
  }]);
  coordinator.completeStartupRecovery([{
    selector: selector('previous-reservation', ALPHA_PATH),
    resolved: false
  }]);

  await assert.rejects(
    coordinator.runMutation(
      selector('replacement-reservation', ALPHA_PATH),
      mutationOptions('replacement-install'),
      async () => { workCalled = true; }
    ),
    error => error?.code === 'RECOVERY_REQUIRED' &&
      error.details?.operationId === 'unfinished-new-server'
  );
  assert.equal(workCalled, false);
});

test('privileged exact-record recovery runs while every ordinary start and writer stays fail-closed', async () => {
  const { calls, coordinator, revisions } = fixture({ [ALPHA_PATH]: 11 });
  coordinator.installRecoveryBlocks([{
    selector: selector('alpha', ALPHA_PATH),
    operationId: 'recovery-alpha'
  }]);
  const entered = deferred();
  const release = deferred();

  const recovering = coordinator.runRecoveryMutation(
    selector('alpha', ALPHA_PATH),
    { operationId: 'recovery-alpha' },
    async mutationLease => {
      assert.equal(mutationLease.operation, 'modpack-recovery');
      assert.equal(mutationLease.operationId, 'recovery-alpha');
      mutationLease.markDirty();
      const healthStart = await coordinator.acquireStart(
        selector('alpha', ALPHA_PATH),
        startOptions('recovery-health', { parentMutationLease: mutationLease })
      );
      healthStart.release();
      entered.resolve();
      await release.promise;
      return 'recovered';
    }
  );
  await entered.promise;

  await assert.rejects(
    coordinator.acquireStart(selector('beta', BETA_PATH), startOptions('ordinary-start-during-recovery')),
    code('RECOVERY_REQUIRED')
  );
  await assert.rejects(
    coordinator.runMutation(
      selector('beta', BETA_PATH),
      mutationOptions('ordinary-write-during-recovery'),
      async () => {}
    ),
    code('RECOVERY_REQUIRED')
  );
  await assert.rejects(
    coordinator.runRecoveryMutation(
      selector('alpha', ALPHA_PATH),
      { operationId: 'recovery-alpha' },
      async () => {}
    ),
    code('OPERATION_IN_PROGRESS')
  );

  release.resolve();
  assert.equal(await recovering, 'recovered');
  assert.equal(revisions.get(windowsKey(ALPHA_PATH)), 11);
  assert.equal(calls.filter(call => call.kind === 'bump').length, 0);
});

test('recovery privilege is bound to the installed operation and cannot be forged or used after completion', async () => {
  const { context, coordinator } = fixture({ [ALPHA_PATH]: 2 });
  coordinator.installRecoveryBlocks([{
    selector: selector('alpha', ALPHA_PATH),
    operationId: 'recovery-alpha'
  }]);

  await assert.rejects(
    coordinator.runRecoveryMutation(
      selector('alpha', ALPHA_PATH),
      { operationId: 'wrong-operation' },
      async () => {}
    ),
    code('RECOVERY_REQUIRED')
  );
  await assert.rejects(
    coordinator.runRecoveryMutation(
      selector('beta', BETA_PATH),
      { operationId: 'recovery-alpha' },
      async () => {}
    ),
    code('RECOVERY_REQUIRED')
  );
  const forged = Object.freeze({
    kind: 'mutation',
    operation: 'modpack-recovery',
    operationId: 'recovery-alpha',
    instanceId: 'alpha',
    serverPath: ALPHA_PATH,
    assertOwnedPath: value => value,
    markDirty() {}
  });
  await context.runWithLease(forged, async () => {
    await assert.rejects(
      coordinator.acquireStart(
        selector('alpha', ALPHA_PATH),
        startOptions('forged-recovery-health', { parentMutationLease: forged })
      ),
      code('INVALID_REQUEST')
    );
  });

  await coordinator.runRecoveryMutation(
    selector('alpha', ALPHA_PATH),
    { operationId: 'recovery-alpha' },
    async () => {}
  );
  coordinator.completeStartupRecovery([{
    selector: selector('alpha', ALPHA_PATH),
    resolved: true
  }], { globalBlock: false });
  await assert.rejects(
    coordinator.runRecoveryMutation(
      selector('alpha', ALPHA_PATH),
      { operationId: 'recovery-alpha' },
      async () => {}
    ),
    code('RECOVERY_REQUIRED')
  );
});

test('failed recovery preserves its exact block and a retained global block keeps every selector closed', async () => {
  const { coordinator } = fixture({ [ALPHA_PATH]: 4 });
  coordinator.installRecoveryBlocks([{
    selector: selector('alpha', ALPHA_PATH),
    operationId: 'recovery-alpha'
  }]);
  const failure = new Error('recovery boundary failed');
  await assert.rejects(
    coordinator.runRecoveryMutation(
      selector('alpha', ALPHA_PATH),
      { operationId: 'recovery-alpha' },
      async () => { throw failure; }
    ),
    error => error === failure
  );

  const completion = coordinator.completeStartupRecovery([{
    selector: selector('alpha', ALPHA_PATH),
    resolved: false
  }], { globalBlock: true });
  assert.equal(completion.globalBlocked, true);
  await assert.rejects(
    coordinator.acquireStart(selector('beta', BETA_PATH), startOptions('global-retained-start')),
    code('RECOVERY_REQUIRED')
  );
  await assert.rejects(
    coordinator.runMutation(
      selector('beta', BETA_PATH),
      mutationOptions('global-retained-write'),
      async () => {}
    ),
    code('RECOVERY_REQUIRED')
  );
});

test('opening the global gate leaves only unresolved exact selectors blocked', async () => {
  const { coordinator } = fixture({ [ALPHA_PATH]: 1, [BETA_PATH]: 1, [GAMMA_PATH]: 1 });
  coordinator.installRecoveryBlocks([
    { selector: selector('alpha', ALPHA_PATH), operationId: 'recovery-alpha' },
    { selector: selector('beta', BETA_PATH), operationId: 'recovery-beta' }
  ]);
  const completion = coordinator.completeStartupRecovery([
    { selector: selector('alpha', ALPHA_PATH), resolved: true },
    { selector: selector('beta', BETA_PATH), resolved: false }
  ], { globalBlock: false });
  assert.equal(completion.globalBlocked, false);

  const alpha = await coordinator.acquireStart(selector('alpha', ALPHA_PATH), startOptions('resolved-alpha-start'));
  alpha.release();
  const gamma = await coordinator.acquireStart(selector('gamma', GAMMA_PATH), startOptions('unrelated-gamma-start'));
  gamma.release();
  await assert.rejects(
    coordinator.acquireStart(selector('beta', BETA_PATH), startOptions('unresolved-beta-start')),
    error => error.code === 'RECOVERY_REQUIRED' && error.details?.operationId === 'recovery-beta'
  );
});

test('reviewed exact-record recovery remains available after startup and clears only a verified resolution', async () => {
  const { coordinator } = fixture({ [ALPHA_PATH]: 1, [BETA_PATH]: 1 });
  coordinator.installRecoveryBlocks([{
    selector: selector('beta', BETA_PATH),
    operationId: 'recovery-beta'
  }]);
  coordinator.completeStartupRecovery([{
    selector: selector('beta', BETA_PATH),
    resolved: false
  }], { globalBlock: false });

  const unrelated = await coordinator.acquireStart(
    selector('alpha', ALPHA_PATH),
    startOptions('unrelated-before-reviewed-recovery')
  );
  unrelated.release();
  await assert.rejects(
    coordinator.runMutation(
      selector('beta', BETA_PATH),
      mutationOptions('ordinary-write-before-reviewed-recovery'),
      async () => {}
    ),
    error => error.code === 'RECOVERY_REQUIRED' && error.details?.operationId === 'recovery-beta'
  );

  await assert.rejects(
    coordinator.runRecoveryMutation(
      selector('beta', BETA_PATH),
      { operationId: 'wrong-recovery' },
      async () => ({ resolved: true })
    ),
    code('RECOVERY_REQUIRED')
  );
  const pending = await coordinator.runRecoveryMutation(
    selector('beta', BETA_PATH),
    { operationId: 'recovery-beta' },
    async () => ({ resolved: false })
  );
  assert.deepEqual(pending, { resolved: false });
  await assert.rejects(
    coordinator.acquireStart(selector('beta', BETA_PATH), startOptions('still-blocked-after-pending-recovery')),
    error => error.code === 'RECOVERY_REQUIRED' && error.details?.operationId === 'recovery-beta'
  );

  const result = await coordinator.runRecoveryMutation(
    selector('beta', BETA_PATH),
    { operationId: 'recovery-beta' },
    async mutationLease => {
      const validation = await coordinator.acquireStart(
        selector('beta', BETA_PATH),
        startOptions('reviewed-recovery-health', { parentMutationLease: mutationLease })
      );
      validation.release();
      return { resolved: true };
    }
  );
  assert.deepEqual(result, { resolved: true });

  const recovered = await coordinator.acquireStart(
    selector('beta', BETA_PATH),
    startOptions('recovered-without-relaunch')
  );
  recovered.release();
});

test('reviewed recovery clears a same-operation revision quarantine created by failed startup recovery', async () => {
  const { coordinator } = fixture({ [BETA_PATH]: 1 });
  coordinator.installRecoveryBlocks([{
    selector: selector('beta', BETA_PATH),
    operationId: 'recovery-beta'
  }]);
  const publicationFailure = new ModpackError('COMMIT_FAILED', 'Recovery publication outcome is uncertain');
  Object.defineProperty(publicationFailure, 'commitPhase', {
    configurable: false,
    enumerable: false,
    value: 'post-publication-uncertain',
    writable: false
  });
  await assert.rejects(
    coordinator.runRecoveryMutation(
      selector('beta', BETA_PATH),
      { operationId: 'recovery-beta' },
      async mutationLease => {
        mutationLease.markDirty();
        throw publicationFailure;
      }
    ),
    error => error === publicationFailure
  );
  coordinator.completeStartupRecovery([{
    selector: selector('beta', BETA_PATH),
    resolved: false
  }], { globalBlock: false });

  await coordinator.runRecoveryMutation(
    selector('beta', BETA_PATH),
    { operationId: 'recovery-beta' },
    async () => ({ resolved: true })
  );

  const recovered = await coordinator.acquireStart(
    selector('beta', BETA_PATH),
    startOptions('recovered-from-revision-quarantine')
  );
  recovered.release();
});

test('recovery rejects a conflicting revision quarantine before privileged work begins', async () => {
  const { coordinator } = fixture({ [BETA_PATH]: 1 });
  completeEmptyRecovery(coordinator);
  const publicationFailure = new ModpackError('COMMIT_FAILED', 'An earlier publication remains uncertain');
  Object.defineProperty(publicationFailure, 'commitPhase', {
    configurable: false,
    enumerable: false,
    value: 'post-publication-uncertain',
    writable: false
  });
  await assert.rejects(
    coordinator.runMutation(
      selector('beta', BETA_PATH),
      mutationOptions('earlier-quarantine'),
      async lease => {
        lease.markDirty();
        throw publicationFailure;
      }
    ),
    error => error === publicationFailure
  );
  coordinator.beginStartupRecovery();
  coordinator.installRecoveryBlocks([{
    selector: selector('beta', BETA_PATH),
    operationId: 'recovery-beta'
  }]);
  let workCalled = false;

  await assert.rejects(
    coordinator.runRecoveryMutation(
      selector('beta', BETA_PATH),
      { operationId: 'recovery-beta' },
      async () => {
        workCalled = true;
        return { resolved: true };
      }
    ),
    error => error.code === 'RECOVERY_REQUIRED' && error.details?.operationId === 'earlier-quarantine'
  );
  assert.equal(workCalled, false);
});

test('leases expose immutable identity, owned-path checks, safe PIDs, and idempotent release', async () => {
  const { coordinator } = fixture({ [ALPHA_PATH]: 5 });
  completeEmptyRecovery(coordinator);
  let retainedMutation;

  await coordinator.runMutation(
    selector('Alpha-ID', ALPHA_PATH),
    mutationOptions('lease-shape'),
    async lease => {
      retainedMutation = lease;
      assert.equal(Object.isFrozen(lease), true);
      assert.equal(lease.operationId, 'lease-shape');
      assert.equal(lease.baseRevision, 5);
      assert.equal(lease.assertOwnedPath('c:/minecraft/alpha/world/level.dat'), 'C:\\minecraft\\alpha\\world\\level.dat');
      assert.throws(() => lease.assertOwnedPath(BETA_PATH), code('INVALID_REQUEST'));
    }
  );
  retainedMutation.release();
  retainedMutation.release();

  const start = await coordinator.acquireStart(selector('alpha-id', ALPHA_PATH), startOptions('pid-check'));
  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42']) {
    assert.throws(() => start.markRunning({ pid }), code('INVALID_REQUEST'));
  }
  start.markRunning({ pid: 42 });
  start.markRunning({ pid: 42 });
  assert.throws(() => start.markRunning({ pid: 43 }), code('INVALID_REQUEST'));
  start.release();
  start.release();
});

test('selectors and options are closed and safe operation IDs are mandatory', async () => {
  const { coordinator } = fixture();
  completeEmptyRecovery(coordinator);

  const invalidSelectors = [
    {},
    { serverPath: 'relative\\server' },
    { serverPath: 'C:\\' },
    { serverPath: 'C:\\Minecraft\\safe\\..\\Alpha' },
    { serverPath: 'C:/Minecraft/./Alpha' },
    { serverPath: ALPHA_PATH, path: BETA_PATH },
    { instanceId: '' },
    { instanceId: 'alpha', serverPath: ALPHA_PATH, extra: true }
  ];
  for (const invalidSelector of invalidSelectors) {
    await assert.rejects(
      coordinator.acquireStart(invalidSelector, startOptions('invalid-selector')),
      code('INVALID_REQUEST')
    );
  }

  const invalidMutationOptions = [
    { operationId: '../unsafe' },
    { operation: '' },
    { revisionMode: 'sometimes' },
    { quiesce: true },
    { signal: {} },
    { arbitrary: true }
  ];
  for (const change of invalidMutationOptions) {
    await assert.rejects(
      coordinator.runMutation(
        selector('alpha', ALPHA_PATH),
        mutationOptions('valid-id', change),
        async () => {}
      ),
      code('INVALID_REQUEST')
    );
  }

  const invalidStartOptions = [
    { arbitrary: true },
    { parentMutationLease: 0 },
    { parentMutationLease: false },
    { parentMutationLease: '' }
  ];
  for (const change of invalidStartOptions) {
    await assert.rejects(
      coordinator.acquireStart(
        selector('alpha', ALPHA_PATH),
        { ...startOptions('valid-start'), ...change }
      ),
      code('INVALID_REQUEST')
    );
  }

  let getterCalls = 0;
  const accessorSelector = { instanceId: 'alpha' };
  Object.defineProperty(accessorSelector, 'serverPath', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return ALPHA_PATH;
    }
  });
  await assert.rejects(
    coordinator.acquireStart(accessorSelector, startOptions('accessor-selector')),
    code('INVALID_REQUEST')
  );
  assert.equal(getterCalls, 0);
});

test('server mutation context installs once and carries leases only through the owned async chain', async () => {
  const context = createServerMutationContext();
  const fakeCoordinator = {
    acquireStart() {},
    beginStartupRecovery() {},
    completeStartupRecovery() {},
    installRecoveryBlocks() {},
    runManyMutations() {},
    runMutation() {},
    runRecoveryMutation() {}
  };

  assert.throws(() => context.getCoordinator(), code('RECOVERY_REQUIRED'));
  assert.equal(context.installCoordinator(fakeCoordinator), fakeCoordinator);
  assert.equal(context.installCoordinator(fakeCoordinator), fakeCoordinator);
  assert.equal(context.getCoordinator(), fakeCoordinator);
  assert.throws(
    () => context.installCoordinator({ ...fakeCoordinator }),
    code('INVALID_REQUEST')
  );

  const lease = {
    assertOwnedPath(value) {
      assert.equal(value, ALPHA_PATH);
      return value;
    },
    markDirty() {
      return true;
    }
  };
  assert.equal(context.getCurrentLease(), null);
  await context.runWithLease(lease, async () => {
    assert.equal(context.getCurrentLease(), lease);
    assert.equal(context.markCurrentDirty(ALPHA_PATH), true);
    await Promise.resolve();
    assert.equal(context.getCurrentLease(), lease);
  });
  assert.equal(context.getCurrentLease(), null);
  assert.equal(context.markCurrentDirty(ALPHA_PATH), false);
});
