const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const {
  createRecoveryTargetEnvelope,
  verifyRecoveryTargetEnvelope
} = require('../../electron/services/modpack-lifecycle/recovery-target-envelope.cjs');

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    sequence: 0,
    jobId: 'job-0001',
    operationKind: 'install',
    target: {
      kind: 'existing',
      stableServerId: 'server-0001',
      path: 'C:\\Minecraft\\Servers\\Example'
    },
    candidatePath: 'C:\\Minecraft\\Servers\\.Example.candidate-job-0001',
    rollbackPath: 'C:\\Minecraft\\Servers\\.Example.rollback-job-0001',
    failedPath: 'C:\\Minecraft\\Servers\\.Example.failed-job-0001',
    restorePoint: {
      id: 'restore-0001',
      sha256: 'a'.repeat(64)
    },
    journalPath: 'C:\\Minecraft\\Servers\\Example\\.minecraft-core-state\\operations\\job-0001\\journal.json',
    priorRuntime: {
      running: false,
      autoRestart: true
    },
    phase: 'queued',
    swapStep: 'none',
    directoryIdentities: {
      target: null,
      candidate: null,
      rollback: null,
      failed: null
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    outcome: null,
    ...overrides
  };
}

function fixture(t, {
  failWriteNumber = null,
  failRenameNumber = null,
  failFlushNumber = null,
  uncertainWriteNumber = null,
  uncertainRenameNumber = null,
  replaceBeforeRenameNumber = null,
  replaceBeforeRename = null
} = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-recovery-registry-'));
  const calls = [];
  let token = 0;
  const nativeClient = {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    flushDirectory() {}
  };
  const base = createDurableFs({
    fsApi: fs,
    durableClient: nativeClient,
    allowedRoots: [userDataPath],
    tempNameFactory: () => `recovery-${++token}`
  });
  let writes = 0;
  let renames = 0;
  let flushes = 0;
  const durableFs = {
    ...base,
    flushDirectory(directoryPath) {
      calls.push({ kind: 'flush-directory', directoryPath });
      flushes += 1;
      if (flushes === failFlushNumber) throw Object.assign(new Error('injected directory flush failure'), { code: 'COMMIT_FAILED' });
      return base.flushDirectory(directoryPath);
    },
    writeJsonAtomic(filePath, value, options) {
      calls.push({ kind: 'write', filePath, value });
      writes += 1;
      if (writes === failWriteNumber) throw Object.assign(new Error('injected durable write failure'), { code: 'COMMIT_FAILED' });
      const result = base.writeJsonAtomic(filePath, value, options);
      if (writes === uncertainWriteNumber) {
        throw Object.assign(new Error('injected uncertain durable write failure'), {
          code: 'COMMIT_FAILED',
          commitPhase: 'post-publication-uncertain'
        });
      }
      return result;
    },
    renameDurable(sourcePath, destinationPath, options) {
      calls.push({ kind: 'rename', sourcePath, destinationPath });
      renames += 1;
      if (renames === failRenameNumber) throw Object.assign(new Error('injected durable rename failure'), { code: 'COMMIT_FAILED' });
      if (renames === replaceBeforeRenameNumber) replaceBeforeRename({ sourcePath, destinationPath });
      const result = base.renameDurable(sourcePath, destinationPath, options);
      if (renames === uncertainRenameNumber) {
        throw Object.assign(new Error('injected uncertain durable rename failure'), {
          code: 'COMMIT_FAILED',
          commitPhase: 'post-publication-uncertain'
        });
      }
      return result;
    }
  };
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const registry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs,
    clock: () => new Date(now += 1000),
    randomUUID: () => '00000000-0000-4000-8000-000000000001'
  });
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return { userDataPath, calls, durableFs, registry };
}

test('target envelopes are closed checksummed records without the full path', () => {
  const envelope = createRecoveryTargetEnvelope(record());
  assert.equal(verifyRecoveryTargetEnvelope(envelope).jobId, 'job-0001');
  assert.equal(envelope.targetPathHash, crypto.createHash('sha256')
    .update('c:\\minecraft\\servers\\example', 'utf8').digest('hex'));
  assert.equal(envelope.targetLabel, 'Example');
  assert.equal(JSON.stringify(envelope).includes('Minecraft\\\\Servers'), false);
  assert.throws(() => verifyRecoveryTargetEnvelope({ ...envelope, targetLabel: 'changed' }));
  assert.throws(() => verifyRecoveryTargetEnvelope({ ...envelope, extra: true }));
  assert.throws(() => createRecoveryTargetEnvelope(record({
    target: { kind: 'existing', stableServerId: 'server-0001', path: 'C:\\Minecraft\\..\\Escape' }
  })));
  let getterCalls = 0;
  const unsafe = record();
  Object.defineProperty(unsafe.target, 'path', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'C:\\Unsafe';
    }
  });
  assert.throws(() => createRecoveryTargetEnvelope(unsafe));
  assert.equal(getterCalls, 0);
});

test('initialize durably creates only the registry directories', async (t) => {
  const { userDataPath, calls, registry } = fixture(t);
  await registry.initialize();
  const registryRoot = path.join(userDataPath, 'modpack-lifecycle');

  assert.deepEqual(calls.filter(call => call.kind === 'flush-directory').map(call => call.directoryPath), [
    userDataPath,
    registryRoot,
    registryRoot
  ]);
  assert.equal(fs.lstatSync(path.join(registryRoot, 'active')).isDirectory(), true);
  assert.equal(fs.lstatSync(path.join(registryRoot, 'history')).isDirectory(), true);
});

test('initialize retries directory flush failure without accepting replacement directories', async (t) => {
  const { userDataPath, durableFs, registry } = fixture(t, { failFlushNumber: 2 });
  await assert.rejects(registry.initialize(), error => error.code === 'COMMIT_FAILED');
  await registry.initialize();

  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const displaced = `${active}.displaced`;
  const replacement = `${active}.replacement`;
  fs.mkdirSync(replacement);
  fs.renameSync(active, displaced);
  fs.renameSync(replacement, active);
  await assert.rejects(registry.listActive(), error => ['RECOVERY_REQUIRED', 'COMMIT_FAILED'].includes(error.code));

  const fresh = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs,
    clock: () => new Date('2026-08-01T00:01:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  const scan = await fresh.initialize();
  assert.deepEqual(scan.records, []);
});

test('create publishes the target envelope before the full active record', async (t) => {
  const { calls, registry } = fixture(t);
  await registry.initialize();
  const created = await registry.create(record());

  assert.equal(created.sequence, 0);
  assert.deepEqual(calls.filter(call => call.kind === 'write').slice(0, 2).map(call => path.basename(call.filePath)), [
    'job-0001.target.json',
    'job-0001.json'
  ]);
  assert.equal((await registry.load('job-0001')).target.stableServerId, 'server-0001');
  await assert.rejects(registry.create(record()), error => error.code === 'TARGET_EXISTS');
});

test('transition compares phase, increments sequence, and preserves immutable identity', async (t) => {
  const { registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());

  const next = await registry.transition('job-0001', {
    expectedPhase: 'queued',
    nextPhase: 'resolving',
    patch: { swapStep: 'prepared' }
  });
  assert.equal(next.sequence, 1);
  assert.equal(next.phase, 'resolving');
  assert.equal(next.swapStep, 'prepared');
  await assert.rejects(
    registry.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'failed', patch: {} }),
    error => error.code === 'PLAN_STALE'
  );
  await assert.rejects(
    registry.transition('job-0001', {
      expectedPhase: 'resolving',
      nextPhase: 'failed',
      patch: { target: { kind: 'existing', stableServerId: 'other', path: 'C:\\Other' } }
    }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('a corrupt record with a valid envelope creates an exact target block and is retained', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());
  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const recordPath = path.join(active, 'job-0001.json');
  fs.writeFileSync(recordPath, '{bad');

  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.corrupt.length, 1);
  assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  assert.equal(fs.readFileSync(recordPath, 'utf8'), '{bad');
});

test('an unidentifiable corrupt record blocks every start', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  const activeRecordPath = path.join(userDataPath, 'modpack-lifecycle', 'active', 'job-bad.json');
  fs.writeFileSync(activeRecordPath, '{bad');

  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, true);
  assert.equal(fs.readFileSync(activeRecordPath, 'utf8'), '{bad');
});

test('a valid full record identifies its target when the envelope is corrupt', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());
  fs.writeFileSync(path.join(userDataPath, 'modpack-lifecycle', 'active', 'job-0001.target.json'), '{}');

  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false);
  assert.equal(scan.records.length, 1);
  assert.equal(scan.blocks[0].targetPathHash.length, 64);
});

test('record identity is bound to its filename and a conflicting valid envelope blocks both targets', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const recordForOtherJob = record({
    jobId: 'job-other',
    target: { kind: 'existing', stableServerId: 'record-server', path: 'C:\\Minecraft\\Servers\\RecordTarget' },
    candidatePath: null,
    rollbackPath: null,
    failedPath: null,
    journalPath: null
  });
  const envelopeForFilename = createRecoveryTargetEnvelope(record({
    target: { kind: 'existing', stableServerId: 'envelope-server', path: 'C:\\Minecraft\\Servers\\EnvelopeTarget' },
    candidatePath: null,
    rollbackPath: null,
    failedPath: null,
    journalPath: null
  }));
  fs.writeFileSync(path.join(active, 'job-0001.json'), `${JSON.stringify(recordForOtherJob)}\n`);
  fs.writeFileSync(path.join(active, 'job-0001.target.json'), `${JSON.stringify(envelopeForFilename)}\n`);

  const scan = await registry.initialize();
  assert.deepEqual(scan.records, []);
  assert.equal(scan.globalBlock, false);
  assert.deepEqual(new Set(scan.blocks.map(block => block.stableServerId)), new Set(['record-server', 'envelope-server']));
  assert.deepEqual(scan.corrupt, [{ jobId: 'job-0001', recordValid: false, envelopeValid: true, mismatched: true }]);
  await assert.rejects(registry.load('job-0001'), error => error.code === 'RECOVERY_REQUIRED');
});

test('two valid but conflicting record and envelope identities are both retained as target blocks', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());
  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const conflictingEnvelope = createRecoveryTargetEnvelope(record({
    target: { kind: 'existing', stableServerId: 'other-server', path: 'C:\\Minecraft\\Servers\\OtherTarget' },
    candidatePath: null,
    rollbackPath: null,
    failedPath: null,
    journalPath: null
  }));
  fs.writeFileSync(path.join(active, 'job-0001.target.json'), `${JSON.stringify(conflictingEnvelope)}\n`);

  const scan = await registry.initialize();
  assert.equal(scan.records.length, 1);
  assert.equal(scan.globalBlock, false);
  assert.deepEqual(new Set(scan.blocks.map(block => block.stableServerId)), new Set(['server-0001', 'other-server']));
  assert.deepEqual(scan.corrupt, [{ jobId: 'job-0001', recordValid: true, envelopeValid: true, mismatched: true }]);
});

test('an envelope retained after record publication failure remains discoverable', async (t) => {
  const { registry } = fixture(t, { failWriteNumber: 2 });
  await registry.initialize();
  await assert.rejects(registry.create(record()), error => error.code === 'COMMIT_FAILED');

  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false);
  assert.equal(scan.records.length, 0);
  assert.equal(scan.blocks[0].stableServerId, 'server-0001');
});

test('uncertain create publications remain discoverable and blocking', async (t) => {
  await t.test('uncertain envelope publication retains an exact target block', async (st) => {
    const { registry } = fixture(st, { uncertainWriteNumber: 1 });
    await registry.initialize();
    await assert.rejects(registry.create(record()), error => error.code === 'COMMIT_FAILED');
    const scan = await registry.initialize();
    assert.equal(scan.records.length, 0);
    assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  });

  await t.test('uncertain record publication retains the full record and envelope', async (st) => {
    const { registry } = fixture(st, { uncertainWriteNumber: 2 });
    await registry.initialize();
    await assert.rejects(registry.create(record()), error => error.code === 'COMMIT_FAILED');
    const scan = await registry.initialize();
    assert.equal(scan.records[0].jobId, 'job-0001');
    assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  });
});

test('durable failures before create, transition, terminal write, and first history move remain safe', async (t) => {
  await t.test('first envelope publication failure creates no active operation', async (st) => {
    const { registry } = fixture(st, { failWriteNumber: 1 });
    await registry.initialize();
    await assert.rejects(registry.create(record()), error => error.code === 'COMMIT_FAILED');
    const scan = await registry.initialize();
    assert.equal(scan.globalBlock, false);
    assert.deepEqual(scan.records, []);
    assert.deepEqual(scan.blocks, []);
  });

  await t.test('transition write failure preserves the prior active record', async (st) => {
    const { registry } = fixture(st, { failWriteNumber: 3 });
    await registry.initialize();
    await registry.create(record());
    await assert.rejects(
      registry.transition('job-0001', { expectedPhase: 'queued', nextPhase: 'resolving', patch: {} }),
      error => error.code === 'COMMIT_FAILED'
    );
    assert.equal((await registry.load('job-0001')).phase, 'queued');
  });

  await t.test('terminal write failure preserves the nonterminal active record', async (st) => {
    const { registry } = fixture(st, { failWriteNumber: 3 });
    await registry.initialize();
    await registry.create(record());
    await assert.rejects(
      registry.finish('job-0001', { terminalPhase: 'failed', outcome: { code: 'FAILED' } }),
      error => error.code === 'COMMIT_FAILED'
    );
    assert.equal((await registry.load('job-0001')).phase, 'queued');
  });

  await t.test('first history move failure retains a terminal active record and envelope', async (st) => {
    const { registry } = fixture(st, { failRenameNumber: 1 });
    await registry.initialize();
    await registry.create(record());
    await assert.rejects(
      registry.finish('job-0001', { terminalPhase: 'failed', outcome: { code: 'FAILED' } }),
      error => error.code === 'COMMIT_FAILED'
    );
    const scan = await registry.initialize();
    assert.equal(scan.records[0].phase, 'failed');
    assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  });
});

test('offline targets remain active and history never appears in listActive', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record({
    target: { kind: 'existing', stableServerId: 'offline-server', path: 'C:\\Definitely-Missing\\Server' },
    candidatePath: null,
    rollbackPath: null,
    failedPath: null,
    journalPath: null
  }));
  assert.equal((await registry.listActive()).length, 1);

  const finished = await registry.finish('job-0001', {
    terminalPhase: 'failed',
    outcome: { code: 'RECOVERY_REQUIRED', message: 'Manual recovery required' }
  });
  assert.equal(finished.phase, 'failed');
  assert.equal(finished.sequence, 1);
  assert.equal((await registry.listActive()).length, 0);
  assert.deepEqual(await registry.loadHistory('job-0001'), finished);
  assert.equal(await registry.loadHistory('job-missing'), null);
  assert.equal(fs.existsSync(path.join(userDataPath, 'modpack-lifecycle', 'history', 'job-0001.json')), true);
  assert.equal(fs.existsSync(path.join(userDataPath, 'modpack-lifecycle', 'history', 'job-0001.target.json')), true);
});

test('finish is recoverable and retry-safe after failure between history moves', async (t) => {
  const { userDataPath, registry } = fixture(t, { failRenameNumber: 2 });
  await registry.initialize();
  await registry.create(record());

  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
    error => error.code === 'COMMIT_FAILED'
  );
  const active = path.join(userDataPath, 'modpack-lifecycle', 'active');
  const history = path.join(userDataPath, 'modpack-lifecycle', 'history');
  assert.equal(fs.existsSync(path.join(history, 'job-0001.json')), true);
  assert.equal(fs.existsSync(path.join(active, 'job-0001.target.json')), true);
  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, false);
  assert.equal(scan.blocks[0].stableServerId, 'server-0001');

  const retry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs: fixtureDurableFs(userDataPath),
    clock: () => new Date('2026-08-01T00:01:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  await retry.initialize();
  await retry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } });
  assert.equal(fs.existsSync(path.join(history, 'job-0001.target.json')), true);
  assert.equal((await retry.listActive()).length, 0);
});

test('an uncertain first history move remains exactly blocked and retryable', async (t) => {
  const { userDataPath, registry } = fixture(t, { uncertainRenameNumber: 1 });
  await registry.initialize();
  await registry.create(record());
  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
    error => error.code === 'COMMIT_FAILED'
  );
  const scan = await registry.initialize();
  assert.equal(scan.records.length, 0);
  assert.equal(scan.blocks[0].stableServerId, 'server-0001');

  const retry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs: fixtureDurableFs(userDataPath),
    clock: () => new Date('2026-08-01T00:01:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  await retry.initialize();
  await retry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } });
  assert.equal((await retry.listActive()).length, 0);
});

test('finish binds both history moves to the bytes that were validated', async (t) => {
  await t.test('record substitution before the first move is rejected and remains active', async (st) => {
    const environment = fixture(st, {
      replaceBeforeRenameNumber: 1,
      replaceBeforeRename({ sourcePath }) {
        const substituted = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        substituted.outcome = { code: 'SUBSTITUTED' };
        fs.writeFileSync(sourcePath, `${JSON.stringify(substituted, null, 2)}\n`);
      }
    });
    await environment.registry.initialize();
    await environment.registry.create(record());
    await assert.rejects(
      environment.registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
      error => ['PLAN_STALE', 'COMMIT_FAILED'].includes(error.code)
    );
    const scan = await environment.registry.initialize();
    assert.equal(scan.records[0].outcome.code, 'SUBSTITUTED');
    assert.equal(scan.blocks[0].stableServerId, 'server-0001');
  });

  await t.test('envelope substitution before the second move retains both target blocks', async (st) => {
    const environment = fixture(st, {
      replaceBeforeRenameNumber: 2,
      replaceBeforeRename({ sourcePath }) {
        const conflicting = createRecoveryTargetEnvelope(record({
          target: { kind: 'existing', stableServerId: 'substituted-server', path: 'C:\\Minecraft\\Servers\\Substituted' },
          candidatePath: null,
          rollbackPath: null,
          failedPath: null,
          journalPath: null
        }));
        fs.writeFileSync(sourcePath, `${JSON.stringify(conflicting, null, 2)}\n`);
      }
    });
    await environment.registry.initialize();
    await environment.registry.create(record());
    await assert.rejects(
      environment.registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
      error => ['PLAN_STALE', 'COMMIT_FAILED'].includes(error.code)
    );
    const scan = await environment.registry.initialize();
    assert.equal(scan.records.length, 0);
    assert.deepEqual(new Set(scan.blocks.map(block => block.stableServerId)),
      new Set(['server-0001', 'substituted-server']));
  });
});

test('finish refuses corrupt target evidence and cannot rewrite a terminal outcome', async (t) => {
  const { userDataPath, registry } = fixture(t);
  await registry.initialize();
  await registry.create(record());
  const envelopePath = path.join(userDataPath, 'modpack-lifecycle', 'active', 'job-0001.target.json');
  fs.writeFileSync(envelopePath, '{}');
  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'OK' } }),
    error => error.code === 'RECOVERY_REQUIRED'
  );

  fs.rmSync(envelopePath);
  const normalizedEnvelope = createRecoveryTargetEnvelope(await registry.load('job-0001'));
  fs.writeFileSync(envelopePath, `${JSON.stringify(normalizedEnvelope, null, 2)}\n`);
  await registry.transition('job-0001', {
    expectedPhase: 'queued',
    nextPhase: 'failed',
    patch: { outcome: { code: 'FIRST' } }
  });
  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'completed', outcome: { code: 'SECOND' } }),
    error => error.code === 'PLAN_STALE'
  );
});

test('invalid schemas and terminal transitions fail without publication', async (t) => {
  const { registry } = fixture(t);
  await registry.initialize();
  await assert.rejects(registry.create({ ...record(), schemaVersion: 2 }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(registry.create({ ...record(), jobId: '../escape' }), error => error.code === 'INVALID_REQUEST');
  await registry.create(record());
  await assert.rejects(
    registry.finish('job-0001', { terminalPhase: 'committing', outcome: {} }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('job IDs are type checked without executing coercion hooks', async (t) => {
  const { registry } = fixture(t);
  await registry.initialize();
  let coercionCalls = 0;
  const hostileJobId = {
    toString() {
      coercionCalls += 1;
      return 'job-0001';
    }
  };
  await assert.rejects(registry.create(record({ jobId: hostileJobId })), error => error.code === 'INVALID_REQUEST');
  assert.equal(coercionCalls, 0);
});

function fixtureDurableFs(root) {
  let token = 0;
  return createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => `retry-${++token}`
  });
}
