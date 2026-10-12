const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { captureServerDirectoryCopySource, identifyServerDirectory } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const { ClientPackStateStore } = require('../../electron/services/client-modpacks/client-pack-state.cjs');
const { ClientPackTransaction } = require('../../electron/services/client-modpacks/client-pack-transaction.cjs');
const reparseInspector = { async isReparsePoint() { return false; } };
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' };
const descriptor = { schemaVersion: 1, status: 'ready', serverFingerprint: 'a'.repeat(64), serverVersion: 'v1', source: { provider: 'modrinth', projectId: 'p', versionId: 'v' }, artifactSha256: 'b'.repeat(64), runtime };
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function write(root, relative, data) { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-client-tx-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^mc-client-tx-[A-Za-z0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const live = path.join(root, 'client'), staged = path.join(root, 'pack'), journalRoot = path.join(root, 'journal');
  for (const dir of [live, staged, journalRoot]) fs.mkdirSync(dir);
  write(live, 'saves/world.dat', 'save'); write(live, 'client-config.json', 'auth'); write(live, 'options.txt', 'mine'); write(live, 'mods/user.jar', 'user');
  write(staged, 'mods/new.jar', 'new'); write(staged, 'options.txt', 'pack');
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    async moveWriteThroughAsync(a, b) { fs.renameSync(a, b); }, async replaceFileWriteThroughAsync(a, b) { fs.renameSync(a, b); }, async flushDirectoryAsync() {}
  } });
  const stateStore = new ClientPackStateStore({ durableFs });
  const dependencies = { journalRoot, durableFs, stateStore, reparseInspector };
  const tx = new ClientPackTransaction(dependencies);
  const target = { clientId: 'client-one', clientPath: live };
  const prepared = { path: staged, manifest: { entries: ['mods/new.jar', 'options.txt'].map(p => ({ path: p, pathKey: p, sha256: hash(p.endsWith('.jar') ? 'new' : 'pack'), size: p.endsWith('.jar') ? '3' : '4', policy: p.endsWith('.jar') ? 'managed' : 'preserve-after-seed' })) } };
  return { root, live, tx, target, prepared, descriptor, durableFs, dependencies, stateStore };
}
async function stage(f, overrides = {}) {
  return f.tx.stage({ target: f.target, baseline: await captureServerDirectoryCopySource(f.live, { reparseInspector }), oldManifest: await f.stateStore.read(f.live), prepared: f.prepared, descriptor, optionalFileIds: [], conflictChoices: {}, ...overrides });
}

// Durable fixtures model abrupt exit, not stage()'s same-process catch/abandon.
async function interruptedIntent(f, boundary) {
  const operationId = '99999999-9999-4999-8999-999999999999';
  const baseline = await captureServerDirectoryCopySource(f.live, { reparseInspector });
  const paths = f.tx._paths(f.target, operationId);
  const record = { schemaVersion: 1, operationId, clientId: f.target.clientId, clientPath: f.live,
    parentIdentity: await identifyServerDirectory(path.dirname(f.live), { reparseInspector }),
    oldTree: { directoryIdentity: baseline.directoryIdentity, fingerprint: baseline.fingerprint },
    candidateIdentity: null, candidateTree: null, phase: 'preparing' };
  await f.durableFs.writeJsonAtomicAsync(paths.journalPath, record);
  if (boundary === 'before-proof-completion') write(f.dependencies.journalRoot, 'interrupted-proof.tmp', 'incomplete auxiliary write');
  if (boundary === 'before-mkdir') {
    const stat = fs.statSync(f.live, { bigint: true });
    const root = { path: '', pathKey: '', type: 'directory', size: '0', sha256: null,
      dev: stat.dev.toString(), ino: stat.ino.toString(), birthtime: stat.birthtimeNs.toString() };
    await f.durableFs.writeJsonAtomicAsync(f.tx._retainedPaths(f.target, operationId, 'previous').proofPath,
      { schemaVersion: 1, operationId, clientId: f.target.clientId, clientPath: f.live, role: 'previous',
        parentIdentity: record.parentIdentity, tree: record.oldTree, entries: [[...baseline.entries, root]] });
  }
  return { paths, record, baseline };
}

for (const boundary of ['after-intent', 'before-proof-completion', 'before-mkdir']) test(`reopened ${boundary} intent settles only proven no-side-effect state and admits next install`, async t => {
  const f = fixture(t); const { record, baseline, paths } = await interruptedIntent(f, boundary);
  const reopened = new ClientPackTransaction(f.dependencies);
  const { ClientProcessGuard } = require('../../electron/services/client-modpacks/client-process-guard.cjs');
  const { createClientPackIntegration } = require('../../electron/services/client-modpacks/client-pack-integration.cjs');
  const guardRoot = path.join(f.root, 'guard'); fs.mkdirSync(guardRoot);
  const guard = new ClientProcessGuard({ root: guardRoot, durableFs: f.durableFs, inspectProcesses: async () => ({ complete: true,
    processes: [{ pid: process.pid, parentPid: process.ppid, creationTime: 'inert-owner', executablePath: process.execPath, commandLine: 'node inert-owner' }] }) });
  const integration = createClientPackIntegration({ resolveClient: async () => f.target, resolveClientByPath: async () => f.target,
    processGuard: guard, transaction: reopened, stateStore: f.stateStore,
    managementClient: { readRequirement: async () => ({ descriptor: null, binding: null }) } });
  await assert.rejects(integration.beginManagedLaunch({ clientPath: f.live }), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(reopened.assertNoUnsettledAtPath(f.live), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(await reopened.recover(f.target, { quiescent: true }), { phase: 'abandoned', operationId: record.operationId });
  const after = await captureServerDirectoryCopySource(f.live, { reparseInspector });
  assert.equal(after.fingerprint, baseline.fingerprint); assert.deepEqual(after.directoryIdentity, baseline.directoryIdentity);
  assert.equal(fs.existsSync(paths.candidatePath), false); assert.equal(fs.existsSync(paths.previousPath), false);
  await reopened.assertNoUnsettledAtPath(f.live);
  const launch = await integration.beginManagedLaunch({ clientPath: f.live }); await launch.abortBeforeSpawn();
  assert.equal((await new ClientPackTransaction(f.dependencies).recover(f.target)).phase, 'abandoned');
  f.tx = reopened;
  const next = await stage(f); await reopened.seal(next); await reopened.publish(next);
  assert.equal((await reopened.status(f.target)).phase, 'committed');
});

for (const control of ['unbound-candidate', 'previous', 'changed-live', 'substituted-live', 'substituted-parent', 'inaccessible-path', 'uncertain-runtime']) {
  test(`reopened null-identity intent refuses ${control} without guessing ownership`, async t => {
    const f = fixture(t); const { paths } = await interruptedIntent(f, 'after-intent');
    if (control === 'unbound-candidate') fs.mkdirSync(paths.candidatePath);
    if (control === 'previous') fs.mkdirSync(paths.previousPath);
    if (control === 'changed-live') write(f.live, 'options.txt', 'latest personal bytes');
    if (control === 'substituted-live') { fs.renameSync(f.live, f.live + '-original'); fs.mkdirSync(f.live); }
    if (control === 'substituted-parent') {
      const record = JSON.parse(fs.readFileSync(paths.journalPath)); record.parentIdentity.fileId = '0'; fs.writeFileSync(paths.journalPath, JSON.stringify(record));
    }
    const inspector = control === 'inaccessible-path' ? { async isReparsePoint() { throw new Error('fixture access denied'); } } : reparseInspector;
    const reopened = new ClientPackTransaction({ ...f.dependencies, reparseInspector: inspector });
    const journalBefore = fs.readFileSync(paths.journalPath);
    await assert.rejects(reopened.recover(f.target, { quiescent: control !== 'uncertain-runtime' }));
    assert.deepEqual(fs.readFileSync(paths.journalPath), journalBefore);
    if (control === 'unbound-candidate') assert.equal(fs.existsSync(paths.candidatePath), true);
    if (control === 'previous') assert.equal(fs.existsSync(paths.previousPath), true);
  });
}

for (const phase of ['preparing', 'ready']) test(`${phase} pre-publication abandonment preserves changed personal bytes without relaxing publish`, async t => {
  const f = fixture(t); const context = await stage(f);
  if (phase === 'ready') await f.tx.seal(context);
  write(f.live, 'client-config.json', 'latest personal bytes');
  if (phase === 'ready') await assert.rejects(f.tx.publish(context));
  const reopened = new ClientPackTransaction(f.dependencies);
  await assert.rejects(reopened.recover(f.target, { quiescent: false }));
  assert.equal((await reopened.recover(f.target, { quiescent: true })).phase, 'abandoned');
  assert.equal(fs.readFileSync(path.join(f.live, 'client-config.json'), 'utf8'), 'latest personal bytes');
  assert.equal(fs.existsSync(context.previousPath), false); assert.equal(fs.existsSync(context.candidatePath), true);
  await reopened.assertNoUnsettledAtPath(f.live);
});

for (const control of ['previous', 'substituted-live', 'substituted-candidate']) test(`changed-live settlement refuses ${control} evidence`, async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context);
  write(f.live, 'client-config.json', 'latest personal bytes');
  if (control === 'previous') fs.mkdirSync(context.previousPath);
  if (control === 'substituted-live') { fs.renameSync(f.live, f.live + '-original'); fs.mkdirSync(f.live); }
  if (control === 'substituted-candidate') { fs.renameSync(context.candidatePath, context.candidatePath + '-original'); fs.mkdirSync(context.candidatePath); }
  const bytes = fs.readFileSync(context.journalPath);
  await assert.rejects(new ClientPackTransaction(f.dependencies).recover(f.target, { quiescent: true }));
  assert.deepEqual(fs.readFileSync(context.journalPath), bytes);
});
const githubDescriptor = { ...descriptor, source: { provider: 'github', repositoryId: '1', githubOwner: 'Example', githubRepo: 'Pack', releaseId: '2', assetId: '3' } };
const multimcPrepared = (f, lwjglVersion = '3.3.1') => ({ ...f.prepared, optionalFileIds: [], contentFormat: 'multimc', runtimeConstraints: { lwjglVersion } });

test('whole manifest transitions replace private evidence and preserve user state and conflict decisions', async t => {
  const f = fixture(t);
  for (const [schemaVersion, prepared] of [[1, f.prepared], [2, multimcPrepared(f)], [2, multimcPrepared(f, null)], [1, f.prepared]]) {
    const context = await stage(f, { prepared, descriptor: githubDescriptor }); await f.tx.seal(context); await f.tx.publish(context);
    const manifest = await f.stateStore.read(f.live);
    assert.equal(manifest.schemaVersion, schemaVersion);
    assert.deepEqual(manifest.descriptor, githubDescriptor);
    if (schemaVersion === 2) {
      assert.equal(manifest.contentFormat, 'multimc'); assert.deepEqual(manifest.runtimeConstraints, prepared.runtimeConstraints);
      assert.deepEqual(manifest.optionalFileIds, []);
    } else {
      assert.equal(Object.hasOwn(manifest, 'contentFormat'), false); assert.equal(Object.hasOwn(manifest, 'runtimeConstraints'), false);
    }
    for (const [file, bytes] of Object.entries({ 'options.txt': 'mine', 'saves/world.dat': 'save', 'client-config.json': 'auth', 'mods/user.jar': 'user' })) {
      assert.equal(fs.readFileSync(path.join(f.live, file), 'utf8'), bytes);
    }
  }
  write(f.live, 'mods/new.jar', 'modified');
  await assert.rejects(stage(f, { prepared: multimcPrepared(f), descriptor: githubDescriptor }), { code: 'INVALID_REQUEST' });
  const context = await stage(f, { prepared: multimcPrepared(f), descriptor: githubDescriptor, conflictChoices: { 'mods/new.jar': 'preserve' } });
  await f.tx.seal(context); await f.tx.publish(context);
  assert.equal((await f.stateStore.read(f.live)).entries.find(e => e.path === 'mods/new.jar').preserved, true);
  assert.equal(fs.readFileSync(path.join(f.live, 'mods/new.jar'), 'utf8'), 'modified');
});

for (const [label, evidence] of [
  ['unknown format', { contentFormat: 'other' }], ['explicit mrpack', { contentFormat: 'mrpack' }],
  ['constraints without format', { runtimeConstraints: { lwjglVersion: null } }],
  ['missing constraints', { contentFormat: 'multimc' }],
  ['malformed constraints', { contentFormat: 'multimc', runtimeConstraints: {} }],
  ['explicit undefined fields', { contentFormat: undefined, runtimeConstraints: undefined }]
]) test(`staging refuses ${label} instead of silently writing legacy ownership`, async t => {
  const f = fixture(t); await assert.rejects(stage(f, { prepared: { ...f.prepared, ...evidence }, descriptor: githubDescriptor }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(await f.stateStore.read(f.live), null);
  assert.equal(fs.existsSync(path.join(f.live, 'mods/new.jar')), false);
});

test('staging MultiMC refuses non-GitHub descriptor and optional choices', async t => {
  const f = fixture(t);
  await assert.rejects(stage(f, { prepared: multimcPrepared(f), descriptor }), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(stage(f, { prepared: multimcPrepared(f), descriptor: githubDescriptor, optionalFileIds: ['optional-one'] }), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(stage(f, { prepared: { ...multimcPrepared(f), optionalFileIds: ['optional-one'] }, descriptor: githubDescriptor }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(await f.stateStore.read(f.live), null);
});

test('staging refuses accessor or inherited private format evidence without invoking it', async t => {
  const f = fixture(t); let reads = 0;
  const accessor = { ...multimcPrepared(f), get contentFormat() { reads++; return 'multimc'; } };
  await assert.rejects(stage(f, { prepared: accessor, descriptor: githubDescriptor }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(reads, 0);
  const inherited = Object.assign(Object.create({ contentFormat: 'multimc', runtimeConstraints: { lwjglVersion: '3.3.1' } }), f.prepared);
  await assert.rejects(stage(f, { prepared: inherited, descriptor: githubDescriptor }), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(fs.readdirSync(f.dependencies.journalRoot), []);
});
test('publication preserves user files and atomically publishes matching ownership', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  for (const [p, bytes] of Object.entries({ 'saves/world.dat': 'save', 'client-config.json': 'auth', 'options.txt': 'mine', 'mods/user.jar': 'user', 'mods/new.jar': 'new' })) assert.equal(fs.readFileSync(path.join(f.live, p), 'utf8'), bytes);
  assert.equal((await f.stateStore.read(f.live)).descriptor.artifactSha256, 'b'.repeat(64));
  assert.equal((await f.tx.status(f.target)).phase, 'committed');
  assert.equal(fs.existsSync(context.previousPath), true);
});
test('stale reviewed baseline rejects before candidate or journal writes', async t => {
  const f = fixture(t); const baseline = await captureServerDirectoryCopySource(f.live, { reparseInspector });
  write(f.live, 'options.txt', 'changed');
  await assert.rejects(stage(f, { baseline }), { code: 'PLAN_STALE' });
  assert.deepEqual(fs.readdirSync(f.dependencies.journalRoot), []);
});
test('invalid copy progress observer rejects before candidate or journal writes', async t => {
  const f = fixture(t);
  await assert.rejects(stage(f, { onProgress: 'not-a-function' }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(fs.readdirSync(f.dependencies.journalRoot), []);
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'mine');
});
test('modified config preserve is recorded but preserved divergent JAR is not verified', async t => {
  const f = fixture(t); write(f.live, 'mods/new.jar', 'modified');
  const context = await stage(f, { conflictChoices: { 'mods/new.jar': 'preserve' } });
  await f.tx.seal(context); await f.tx.publish(context);
  const manifest = await f.stateStore.read(f.live);
  assert.equal(manifest.entries.find(e => e.path === 'mods/new.jar').preserved, true);
  assert.equal(fs.readFileSync(path.join(f.live, 'mods/new.jar'), 'utf8'), 'modified');
});
test('unknown choices cannot replace protected or unreviewed paths', async t => {
  const f = fixture(t);
  await assert.rejects(stage(f, { conflictChoices: { 'client-config.json': 'replace' } }), { code: 'INVALID_REQUEST' });
  assert.equal(fs.readFileSync(path.join(f.live, 'client-config.json'), 'utf8'), 'auth');
});
for (const format of ['mrpack', 'multimc']) for (const boundary of ['before-first-rename', 'after-first-rename', 'before-second-rename', 'after-second-rename', 'before-completion', 'after-completion']) {
  test(`${format} recovery yields exact new directory after ${boundary}`, async t => {
    const f = fixture(t); const context = await stage(f, format === 'multimc' ? { prepared: multimcPrepared(f), descriptor: githubDescriptor } : {}); await f.tx.seal(context);
    let moves = 0;
    const broken = { ...f.durableFs,
      async renameDurableAsync(a, b) {
        moves++; const which = moves === 1 ? 'first' : 'second';
        if (boundary === `before-${which}-rename`) throw new Error('injected boundary');
        await f.durableFs.renameDurableAsync(a, b);
        if (boundary === `after-${which}-rename`) throw new Error('injected boundary');
      },
      async writeJsonAtomicAsync(p, value, opts) {
        if (value.phase === 'committed' && boundary === 'before-completion') throw new Error('injected boundary');
        await f.durableFs.writeJsonAtomicAsync(p, value, opts);
        if (value.phase === 'committed' && boundary === 'after-completion') throw new Error('injected boundary');
      }
    };
    f.tx.durableFs = broken;
    await assert.rejects(f.tx.publish(context));
    const reopened = new ClientPackTransaction(f.dependencies);
    const recovered = await reopened.recover(f.target);
    assert.equal(recovered.phase, 'committed');
    assert.equal(fs.readFileSync(path.join(f.live, 'mods/new.jar'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
    assert.equal((await f.stateStore.read(f.live)).descriptor.serverFingerprint, 'a'.repeat(64));
    if (format === 'multimc') {
      const manifest = await new ClientPackStateStore({ durableFs: f.durableFs }).read(f.live);
      assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.contentFormat, 'multimc');
      assert.deepEqual(manifest.runtimeConstraints, { lwjglVersion: '3.3.1' });
    }
  });
}
test('substituted directory identity blocks recovery without deleting evidence', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context);
  fs.renameSync(context.candidatePath, context.candidatePath + '-retained'); fs.mkdirSync(context.candidatePath);
  await assert.rejects(new ClientPackTransaction(f.dependencies).recover(f.target), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(context.candidatePath + '-retained'), true);
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
});
test('unknown writer quiescence retains candidate and durable preparing evidence', async t => {
  const f = fixture(t); const context = await stage(f);
  await assert.rejects(f.tx.abandon(context, { quiescent: false }), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(new ClientPackTransaction(f.dependencies).recover(f.target), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(context.candidatePath), true);
  assert.equal((await f.tx.status(f.target)).phase, 'preparing');
});
for (const settlement of ['abandon', 'recover']) test(`large candidate inventory survives ${settlement} with unchanged old live files`, async t => {
  const f = fixture(t);
  const packPaths = Array.from({ length: 1200 }, (_, index) => `config/large/file-${String(index).padStart(4, '0')}.cfg`);
  for (const file of packPaths) {
    write(f.prepared.path, file, 'x');
    f.prepared.manifest.entries.push({ path: file, pathKey: file, sha256: hash('x'), size: '1', policy: 'managed' });
  }
  const baseline = await captureServerDirectoryCopySource(f.live, { reparseInspector });
  const context = await stage(f, { baseline });
  assert.equal((await f.tx.status(f.target)).phase, 'preparing');
  const result = settlement === 'abandon'
    ? await f.tx.abandon(context, { quiescent: true })
    : await new ClientPackTransaction(f.dependencies).recover(f.target, { quiescent: true });
  assert.deepEqual(result, { phase: 'abandoned', operationId: context.operationId });
  assert.deepEqual(await new ClientPackTransaction(f.dependencies).recover(f.target), result);
  const after = await captureServerDirectoryCopySource(f.live, { reparseInspector });
  assert.deepEqual(after.directoryIdentity, baseline.directoryIdentity); assert.equal(after.fingerprint, baseline.fingerprint);
  for (const [file, bytes] of Object.entries({ 'options.txt': 'mine', 'saves/world.dat': 'save', 'client-config.json': 'auth', 'mods/user.jar': 'user' })) {
    assert.equal(fs.readFileSync(path.join(f.live, file), 'utf8'), bytes);
  }
  assert.equal(await f.stateStore.read(f.live), null);
  assert.equal(fs.existsSync(path.join(f.live, 'mods/new.jar')), false);
  assert.equal(fs.existsSync(path.join(f.live, 'config')), false);

  const proofName = fs.readdirSync(f.dependencies.journalRoot).find(name => name.endsWith(`.retained-proof-${context.operationId}-candidate.json`));
  assert.ok(proofName, 'abandonment must durably retain the full candidate inventory');
  const proof = JSON.parse(fs.readFileSync(path.join(f.dependencies.journalRoot, proofName), 'utf8'));
  assert.equal(proof.operationId, context.operationId); assert.equal(proof.role, 'candidate');
  assert.equal(Object.hasOwn(proof, 'retentionReason'), false);
  const inventory = proof.entries.flat();
  assert.equal(inventory.length, 1211); assert.equal(inventory.filter(item => item.type === 'file').length, 1206);
  assert.deepEqual(inventory.filter(item => item.path.startsWith('config/large/file-')).map(item => item.path).sort(), packPaths);
  for (const item of inventory.filter(item => item.path.startsWith('config/large/file-'))) {
    assert.equal(item.size, '1'); assert.equal(item.sha256, hash('x'));
  }
  assert.equal(fs.readFileSync(path.join(context.candidatePath, 'config/large/file-0000.cfg'), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(context.candidatePath, 'config/large/file-1199.cfg'), 'utf8'), 'x');
  const record = JSON.parse(fs.readFileSync(context.journalPath, 'utf8'));
  assert.equal(record.phase, 'abandoned'); assert.deepEqual(record.candidateTree, proof.tree);
  assert.deepEqual(record.candidateIdentity, proof.tree.directoryIdentity);
});
test('committed recovery accepts later user save edits while checking native live identity', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  write(f.live, 'saves/world.dat', 'later user save');
  assert.equal((await new ClientPackTransaction(f.dependencies).recover(f.target)).phase, 'committed');
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'later user save');
});
test('committed status rejects replacement live directory identity', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  fs.renameSync(f.live, f.live + '-retained'); fs.mkdirSync(f.live);
  await assert.rejects(f.tx.status(f.target), { code: 'RECOVERY_REQUIRED' });
});
test('runtime operation ID is durable before candidate writers start', async t => {
  const f = fixture(t); const operationId = '33333333-3333-4333-8333-333333333333';
  const context = await stage(f, { operationId });
  assert.equal((await f.tx.status(f.target)).operationId, operationId);
  assert.equal(context.operationId, operationId);
});
test('unchanged owned removal preserves unrelated additions through a second transaction', async t => {
  const f = fixture(t); let context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  const firstOperation = context.operationId;
  f.prepared.manifest.entries = f.prepared.manifest.entries.filter(e => e.path !== 'mods/new.jar');
  context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  assert.equal(fs.existsSync(path.join(f.live, 'mods/new.jar')), false);
  assert.equal(fs.readFileSync(path.join(f.live, 'mods/user.jar'), 'utf8'), 'user');
  const records = fs.readdirSync(f.dependencies.journalRoot).map(name => JSON.parse(fs.readFileSync(path.join(f.dependencies.journalRoot, name), 'utf8')));
  assert.equal(records.some(record => record.operationId === firstOperation && record.phase === 'committed'), true);
  assert.equal(records.some(record => record.operationId === context.operationId && record.phase === 'committed'), true);
});
for (const decision of ['preserve', 'replace']) test(`explicit ${decision} decision controls modified configuration`, async t => {
  const f = fixture(t); const file = 'config/settings.txt';
  write(f.live, file, 'user'); write(f.prepared.path, file, 'pack');
  f.prepared.manifest.entries.push({ path: file, pathKey: file, sha256: hash('pack'), size: '4', policy: 'managed' });
  const context = await stage(f, { conflictChoices: { [file]: decision } });
  await f.tx.seal(context); await f.tx.publish(context);
  assert.equal(fs.readFileSync(path.join(f.live, file), 'utf8'), decision === 'preserve' ? 'user' : 'pack');
  assert.equal((await f.stateStore.read(f.live)).entries.find(e => e.path === file).preserved === true, decision === 'preserve');
});
for (const after of [false, true]) test(`failure ${after ? 'after' : 'before'} ownership manifest publication retains old live`, async t => {
  const f = fixture(t); const writeManifest = f.stateStore.write.bind(f.stateStore);
  f.stateStore.write = async (...args) => { if (after) await writeManifest(...args); throw new Error('injected manifest publication failure'); };
  await assert.rejects(stage(f));
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(path.join(f.live, 'mods/new.jar')), false);
  assert.equal((await f.tx.status(f.target)).phase, 'abandoned');
  assert.equal((await new ClientPackTransaction(f.dependencies).recover(f.target)).phase, 'abandoned');
  const retained = JSON.parse(fs.readFileSync(path.join(f.dependencies.journalRoot, fs.readdirSync(f.dependencies.journalRoot)[0]), 'utf8'));
  assert.match(retained.candidateTree?.fingerprint || '', /^[a-f0-9]{64}$/);
  assert.deepEqual(retained.candidateTree.directoryIdentity, retained.candidateIdentity);
});
function cleanupOptions(overrides = {}) { return { isQuiescent: async () => true, ...overrides }; }
function insideFixture(f, value) { const relative = path.relative(f.root, path.resolve(value)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); return value; }
async function cleanupBatchFixture(t, { role = 'candidate', files = 0 } = {}) {
  const f = fixture(t);
  for (let index = 0; index < files; index++) write(f.live, `bulk/${String(index).padStart(4, '0')}.txt`, 'owned');
  const context = await stage(f);
  if (role === 'previous') { await f.tx.seal(context); await f.tx.publish(context); }
  else await f.tx.abandon(context, { quiescent: true });
  const paths = f.tx._retainedPaths(f.target, context.operationId, role);
  const record = JSON.parse(fs.readFileSync(f.tx._paths(f.target).journalPath));
  const proofBytes = fs.readFileSync(paths.proofPath); const proof = JSON.parse(proofBytes);
  const entries = proof.entries.flat();
  const intent = { schemaVersion: 2, operationId: context.operationId, clientId: record.clientId, clientPath: record.clientPath, role,
    sourceRecordSha256: hash(JSON.stringify(record)), proofSha256: hash(proofBytes), rootIdentity: proof.tree.directoryIdentity,
    parentIdentity: record.parentIdentity, entryCount: entries.length, cursor: 0, pending: null, phase: 'cleaning' };
  return { ...f, context, paths, record, proofBytes, entries, intent };
}
function persistCleanupFixture(f, intent) { fs.writeFileSync(f.paths.cleanupPath, JSON.stringify(intent)); }
function removeCleanupEntries(f, indexes) {
  for (const index of indexes) {
    const entry = f.entries[index]; const absolute = entry.path ? path.join(f.paths.retainedPath, ...entry.path.split('/')) : f.paths.retainedPath;
    if (entry.type === 'file') fs.unlinkSync(absolute); else fs.rmdirSync(absolute);
  }
}
function assertCleanupLive(f) {
  for (const [file, value] of [['saves/world.dat', 'save'], ['client-config.json', 'auth'], ['options.txt', 'mine']]) assert.equal(fs.readFileSync(path.join(f.live, file), 'utf8'), value);
}
for (const role of ['candidate', 'previous']) test(`cleanup batch amortizes 520 files for ${role} without changing live state`, async t => {
  const f = await cleanupBatchFixture(t, { role, files: 520 }); const writes = [], flushes = [];
  f.tx.durableFs = { ...f.durableFs,
    async writeJsonAtomicAsync(file, value, options) { if (file === f.paths.cleanupPath) writes.push(structuredClone(value)); return f.durableFs.writeJsonAtomicAsync(file, value, options); },
    async flushDirectoriesAsync(directories) { flushes.push([...directories]); return f.durableFs.flushDirectoriesAsync(directories); }
  };
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).completed, [f.context.operationId]);
  const pending = writes.filter(value => value.pending !== null);
  assert.deepEqual(pending.map(value => [value.schemaVersion, value.cursor, value.pending]), [[2, 0, { endExclusive: 256 }], [2, 256, { endExclusive: 512 }], [2, 512, { endExclusive: f.entries.length }]]);
  assert.equal(writes.length, 8); assert.equal(flushes.length, 3);
  assert.deepEqual(flushes[0], [path.join(f.paths.retainedPath, 'bulk')]);
  assert.deepEqual(flushes[1], [path.join(f.paths.retainedPath, 'bulk')]); assert.deepEqual(flushes[2], [f.root]);
  assert.equal(fs.existsSync(f.paths.retainedPath), false); assertCleanupLive(f);
});
for (const pending of [null, 85]) test(`cleanup v1 literal cursor 85 pending ${pending} settles before v2 ranges`, async t => {
  const f = await cleanupBatchFixture(t, { files: 100 }); removeCleanupEntries(f, Array.from({ length: pending === 85 ? 86 : 85 }, (_, index) => index));
  persistCleanupFixture(f, { ...f.intent, schemaVersion: 1, cursor: 85, pending }); const writes = [];
  f.tx.durableFs = { ...f.durableFs, async writeJsonAtomicAsync(file, value, options) { if (file === f.paths.cleanupPath) writes.push(structuredClone(value)); return f.durableFs.writeJsonAtomicAsync(file, value, options); } };
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).completed, [f.context.operationId]);
  if (pending === 85) { assert.equal(writes[0].cursor, 86); assert.equal(writes[0].pending, null); }
  const batch = writes.find(value => value.pending !== null); assert.equal(batch.schemaVersion, 2);
  assert.deepEqual(batch.pending, { endExclusive: f.entries.length }); assert.equal(batch.cursor, pending === 85 ? 86 : 85);
  for (const value of writes) for (const key of ['sourceRecordSha256', 'proofSha256', 'rootIdentity', 'parentIdentity']) assert.deepEqual(value[key], f.intent[key]);
  assertCleanupLive(f);
});
test('cleanup v1 numeric 85 never authorizes absence at 86', async t => {
  const f = await cleanupBatchFixture(t, { files: 100 }); removeCleanupEntries(f, Array.from({ length: 87 }, (_, index) => index));
  persistCleanupFixture(f, { ...f.intent, schemaVersion: 1, cursor: 85, pending: 85 }); const before = fs.readFileSync(f.paths.cleanupPath);
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).retained, [f.context.operationId]);
  assert.deepEqual(fs.readFileSync(f.paths.cleanupPath), before); assertCleanupLive(f);
});
test('cleanup v1 complete compacted marker is accepted without rewriting its proof or marker', async t => {
  const f = await cleanupBatchFixture(t); assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).completed, [f.context.operationId]);
  const terminal = JSON.parse(fs.readFileSync(f.paths.cleanupPath)); persistCleanupFixture(f, { ...terminal, schemaVersion: 1 });
  const markerBytes = fs.readFileSync(f.paths.cleanupPath), proofBytes = fs.readFileSync(f.paths.proofPath);
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions({ isQuiescent: async () => false }))).completed, [f.context.operationId]);
  assert.deepEqual(fs.readFileSync(f.paths.cleanupPath), markerBytes); assert.deepEqual(fs.readFileSync(f.paths.proofPath), proofBytes); assertCleanupLive(f);
});
for (const role of ['candidate', 'previous']) test(`cleanup v1 final cursor crash publishes a new v2 terminal for ${role}`, async t => {
  const f = await cleanupBatchFixture(t, { role }); removeCleanupEntries(f, Array.from({ length: f.entries.length }, (_, index) => index));
  persistCleanupFixture(f, { ...f.intent, schemaVersion: 1, cursor: f.entries.length, pending: null, phase: 'cleaning' }); const writes = [];
  const reopened = new ClientPackTransaction({ ...f.dependencies, durableFs: { ...f.durableFs,
    async writeJsonAtomicAsync(file, value, options) { if (file === f.paths.cleanupPath) writes.push(structuredClone(value)); return f.durableFs.writeJsonAtomicAsync(file, value, options); }
  } });
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions())).completed, [f.context.operationId]);
  assert.deepEqual(writes.map(value => [value.schemaVersion, value.cursor, value.pending, value.phase]), [[2, f.entries.length, null, 'complete']]);
  for (const key of ['sourceRecordSha256', 'proofSha256', 'rootIdentity', 'parentIdentity']) assert.deepEqual(writes[0][key], f.intent[key]);
  assert.equal(fs.existsSync(f.paths.retainedPath), false); assertCleanupLive(f);
});
for (const [label, change] of [
  ['zero', { pending: { endExclusive: 0 } }], ['negative', { pending: { endExclusive: -1 } }],
  ['reversed', { cursor: 2, pending: { endExclusive: 1 } }], ['fraction', { pending: { endExclusive: 1.5 } }],
  ['unsafe', { pending: { endExclusive: Number.MAX_SAFE_INTEGER + 1 } }], ['past count', { pending: { endExclusive: 999 } }],
  ['257 wide', { pending: { endExclusive: 257 } }], ['extra key', { pending: { endExclusive: 1, extra: true } }],
  ['numeric', { pending: 0 }], ['array', { pending: [1] }], ['unknown schema', { schemaVersion: 3, pending: null }],
  ['v1 object', { schemaVersion: 1, pending: { endExclusive: 1 } }]
]) test(`cleanup range refuses invalid ${label} without checkpoint or deletion`, async t => {
  const f = await cleanupBatchFixture(t, { files: label === '257 wide' ? 260 : 0 }); const invalid = { ...f.intent, ...change };
  assert.throws(() => f.tx._cleanupIntent(invalid, f.record, 'candidate', f.intent.sourceRecordSha256)); persistCleanupFixture(f, invalid);
  const before = fs.readFileSync(f.paths.cleanupPath); const names = fs.readdirSync(f.paths.retainedPath);
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).retained, [f.context.operationId]);
  assert.deepEqual(fs.readFileSync(f.paths.cleanupPath), before); assert.deepEqual(fs.readdirSync(f.paths.retainedPath), names); assertCleanupLive(f);
});
test('cleanup range validator refuses nonfinite endpoints and malformed JSON retains authority', async t => {
  const f = await cleanupBatchFixture(t);
  for (const endExclusive of [NaN, Infinity, -Infinity]) assert.throws(() => f.tx._cleanupIntent({ ...f.intent, pending: { endExclusive } }, f.record, 'candidate', f.intent.sourceRecordSha256));
  fs.writeFileSync(f.paths.cleanupPath, '{invalid');
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [f.context.operationId]); assert.equal(fs.readFileSync(f.paths.cleanupPath, 'utf8'), '{invalid'); assertCleanupLive(f);
});
for (const absent of [[0, 1, 2], [0, 2]]) test(`cleanup range nonprefix replay ${absent} flushes whole persisted boundary`, async t => {
  const f = await cleanupBatchFixture(t); assert.deepEqual(f.entries.slice(0, 3).map(entry => entry.path), ['mods/new.jar', 'mods/user.jar', 'saves/world.dat']);
  persistCleanupFixture(f, { ...f.intent, pending: { endExclusive: 3 } }); removeCleanupEntries(f, absent); const flushes = [];
  const reopened = new ClientPackTransaction({ ...f.dependencies, durableFs: { ...f.durableFs, async flushDirectoriesAsync(directories) { flushes.push([...directories]); return f.durableFs.flushDirectoriesAsync(directories); } } });
  const result = await reopened.cleanup(f.target, cleanupOptions({ maxDeletes: 1 })); assert.deepEqual(result.pending, [f.context.operationId]);
  assert.deepEqual(flushes[0], [path.join(f.paths.retainedPath, 'mods'), path.join(f.paths.retainedPath, 'saves')]);
  assert.equal(JSON.parse(fs.readFileSync(f.paths.cleanupPath)).cursor >= 3, true); assertCleanupLive(f);
});
test('cleanup range larger pending resumes with one actual deletion and trailing absences cost no budget', async t => {
  const f = await cleanupBatchFixture(t); persistCleanupFixture(f, { ...f.intent, pending: { endExclusive: 3 } }); removeCleanupEntries(f, [2]);
  for (const cursor of [0, 3]) {
    let deletes = 0; const unlink = fs.unlinkSync; t.mock.method(fs, 'unlinkSync', function(file) { if (file.startsWith(f.paths.retainedPath + path.sep)) deletes++; return unlink(file); });
    const result = await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions({ maxDeletes: 1 }));
    assert.deepEqual(result.pending, [f.context.operationId]); assert.equal(deletes, 1); assert.equal(JSON.parse(fs.readFileSync(f.paths.cleanupPath)).cursor, cursor); t.mock.restoreAll();
  }
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).completed, [f.context.operationId]); assertCleanupLive(f);
});
for (const mode of ['whole suffix', 'root only']) test(`cleanup range ${mode} absence flushes outer parent`, async t => {
  const f = await cleanupBatchFixture(t); const cursor = mode === 'root only' ? f.entries.length - 1 : 0;
  removeCleanupEntries(f, Array.from({ length: f.entries.length }, (_, index) => index)); persistCleanupFixture(f, { ...f.intent, cursor, pending: { endExclusive: f.entries.length } }); const flushes = [];
  const reopened = new ClientPackTransaction({ ...f.dependencies, durableFs: { ...f.durableFs, async flushDirectoriesAsync(directories) { flushes.push([...directories]); return f.durableFs.flushDirectoriesAsync(directories); } } });
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions())).completed, [f.context.operationId]); assert.deepEqual(flushes, [[f.root]]); assertCleanupLive(f);
});
test('cleanup range cross-depth absent ancestor is tolerated only inside its pending range', async t => {
  const f = await cleanupBatchFixture(t); const modsIndex = f.entries.findIndex(entry => entry.path === 'mods');
  persistCleanupFixture(f, { ...f.intent, pending: { endExclusive: modsIndex + 1 } }); removeCleanupEntries(f, [0, 1, modsIndex]);
  const lstat = fs.promises.lstat; let traversedMissingAncestor = false;
  t.mock.method(fs.promises, 'lstat', async function(file, ...args) { if (file.startsWith(path.join(f.paths.retainedPath, 'mods') + path.sep)) traversedMissingAncestor = true; return lstat(file, ...args); });
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).completed, [f.context.operationId]);
  assert.equal(traversedMissingAncestor, false); assertCleanupLive(f);
});
test('cleanup range unexpected ancestor stat error is not interpreted as an authorized absence', async t => {
  const f = await cleanupBatchFixture(t); const modsIndex = f.entries.findIndex(entry => entry.path === 'mods');
  persistCleanupFixture(f, { ...f.intent, pending: { endExclusive: modsIndex + 1 } }); removeCleanupEntries(f, [0, 1, modsIndex]);
  const before = fs.readFileSync(f.paths.cleanupPath); const lstat = fs.promises.lstat; let injected = false;
  t.mock.method(fs.promises, 'lstat', async function(file, ...args) { if (file === path.join(f.paths.retainedPath, 'mods')) { injected = true; throw Object.assign(new Error('access denied'), { code: 'EACCES' }); } return lstat(file, ...args); });
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).retained, [f.context.operationId]);
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(f.paths.cleanupPath), before); assert.equal(fs.readFileSync(path.join(f.paths.retainedPath, 'saves/world.dat'), 'utf8'), 'save'); assertCleanupLive(f);
});
for (const mutation of ['missing outside', 'missing ancestor outside', 'resurrected', 'unexpected', 'changed', 'substituted', 'hard link', 'junction']) test(`cleanup range retains ${mutation} without changing authority`, async t => {
  const f = await cleanupBatchFixture(t); let intent = { ...f.intent, pending: { endExclusive: 2 } };
  if (mutation === 'missing outside') removeCleanupEntries(f, [2]);
  if (mutation === 'missing ancestor outside') removeCleanupEntries(f, [0, 1, f.entries.findIndex(entry => entry.path === 'mods')]);
  if (mutation === 'resurrected') { removeCleanupEntries(f, [0]); write(f.paths.retainedPath, 'mods/new.jar', 'new'); intent = { ...f.intent, cursor: 1, pending: { endExclusive: 2 } }; }
  if (mutation === 'unexpected') write(f.paths.retainedPath, 'foreign.txt', 'foreign');
  const victim = path.join(f.paths.retainedPath, 'mods/new.jar');
  if (mutation === 'changed') fs.writeFileSync(victim, 'changed');
  if (mutation === 'substituted') { fs.renameSync(victim, path.join(f.root, 'original')); fs.writeFileSync(victim, 'new'); }
  if (mutation === 'hard link') fs.linkSync(victim, path.join(f.root, 'linked'));
  if (mutation === 'junction') fs.symlinkSync(f.live, path.join(f.paths.retainedPath, 'foreign-link'), 'junction');
  persistCleanupFixture(f, intent); const before = fs.readFileSync(f.paths.cleanupPath);
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).retained, [f.context.operationId]);
  assert.deepEqual(fs.readFileSync(f.paths.cleanupPath), before); assert.equal(fs.existsSync(f.paths.retainedPath), true); assertCleanupLive(f);
});
for (const boundary of ['pending before', 'pending after', 'delete', 'flush partial', 'cursor before', 'cursor after', 'terminal', 'compaction']) test(`cleanup batch resumes interruption at ${boundary}`, async t => {
  const f = await cleanupBatchFixture(t); let injected = false;
  if (boundary === 'flush partial') persistCleanupFixture(f, { ...f.intent, pending: { endExclusive: 3 } });
  f.tx.durableFs = { ...f.durableFs,
    async writeJsonAtomicAsync(file, value, options) {
      const hit = file === f.paths.cleanupPath && (boundary.startsWith('pending') ? value.pending !== null : boundary.startsWith('cursor') ? value.pending === null && value.cursor > 0 && value.phase === 'cleaning' : boundary === 'terminal' && value.phase === 'complete') || boundary === 'compaction' && file === f.paths.proofPath;
      if (hit && !injected) { injected = true; if (boundary.endsWith('after')) await f.durableFs.writeJsonAtomicAsync(file, value, options); throw new Error(`injected ${boundary}`); }
      return f.durableFs.writeJsonAtomicAsync(file, value, options);
    },
    async flushDirectoriesAsync(directories) { if (boundary === 'flush partial' && !injected) { injected = true; assert.deepEqual(directories, [path.join(f.paths.retainedPath, 'mods'), path.join(f.paths.retainedPath, 'saves')]); await f.durableFs.flushDirectoryAsync(directories[0]); throw new Error('partial flush'); } return f.durableFs.flushDirectoriesAsync(directories); }
  };
  if (boundary === 'delete') { const unlink = fs.unlinkSync; t.mock.method(fs, 'unlinkSync', function(file) { const result = unlink(file); if (file.startsWith(f.paths.retainedPath + path.sep) && !injected) { injected = true; throw new Error('interrupted after unlink'); } return result; }); }
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [f.context.operationId]); assert.equal(injected, true); t.mock.restoreAll();
  const persisted = JSON.parse(fs.readFileSync(f.paths.cleanupPath));
  if (['pending after', 'delete', 'flush partial', 'cursor before'].includes(boundary)) { assert.equal(persisted.cursor, 0); assert.deepEqual(persisted.pending, { endExclusive: boundary === 'flush partial' ? 3 : f.entries.length }); }
  if (boundary === 'pending before') { assert.equal(persisted.cursor, 0); assert.equal(persisted.pending, null); assert.equal(fs.existsSync(path.join(f.paths.retainedPath, 'mods/new.jar')), true); }
  assertCleanupLive(f);
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).completed, [f.context.operationId]); assertCleanupLive(f);
});
test('cleanup range preserves nested surviving boundaries rather than collapsing them', async t => {
  const f = fixture(t); write(f.live, 'nest/child/deep.txt', 'deep'); write(f.live, 'nest/shallow.txt', 'shallow');
  const context = await stage(f); await f.tx.abandon(context, { quiescent: true }); const paths = f.tx._retainedPaths(f.target, context.operationId, 'candidate'); const proofBytes = fs.readFileSync(paths.proofPath); const entries = JSON.parse(proofBytes).entries.flat();
  assert.deepEqual(entries.slice(0, 5).map(entry => entry.path), ['nest/child/deep.txt', 'mods/new.jar', 'mods/user.jar', 'nest/shallow.txt', 'saves/world.dat']);
  const flushes = []; f.tx.durableFs = { ...f.durableFs, async flushDirectoriesAsync(directories) { flushes.push([...directories]); return f.durableFs.flushDirectoriesAsync(directories); } };
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions({ maxDeletes: 5 }))).pending, [context.operationId]);
  assert.deepEqual(flushes, [[path.join(paths.retainedPath, 'nest/child'), path.join(paths.retainedPath, 'mods'), path.join(paths.retainedPath, 'nest'), path.join(paths.retainedPath, 'saves')]]); assertCleanupLive(f);
});
for (const when of ['before', 'after']) test(`cleanup range substituted boundary ${when} flush cannot advance cursor`, async t => {
  const f = await cleanupBatchFixture(t); persistCleanupFixture(f, { ...f.intent, pending: { endExclusive: 2 } }); let substituted = false;
  const replace = () => { if (!substituted) { substituted = true; fs.renameSync(path.join(f.paths.retainedPath, 'mods'), path.join(f.root, 'moved-mods')); fs.mkdirSync(path.join(f.paths.retainedPath, 'mods')); } };
  if (when === 'before') { const unlink = fs.unlinkSync; t.mock.method(fs, 'unlinkSync', function(file) { const result = unlink(file); if (file === path.join(f.paths.retainedPath, 'mods/user.jar')) replace(); return result; }); }
  f.tx.durableFs = { ...f.durableFs, async flushDirectoriesAsync(directories) { await f.durableFs.flushDirectoriesAsync(directories); if (when === 'after') replace(); } };
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [f.context.operationId]); assert.equal(substituted, true);
  assert.equal(JSON.parse(fs.readFileSync(f.paths.cleanupPath)).cursor, 0); assert.equal(fs.existsSync(path.join(f.paths.retainedPath, 'mods')), true); assertCleanupLive(f);
});
test('settled cleanup deletes only exact committed previous tree and keeps live saves', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  const result = await f.tx.cleanup(f.target, cleanupOptions());
  assert.deepEqual(result.completed, [context.operationId]); assert.deepEqual(result.retained, []);
  assert.equal(fs.existsSync(context.previousPath), false);
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
  assert.equal((await f.tx.status(f.target)).phase, 'committed');
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions({ isQuiescent: async () => false }))).completed, [context.operationId]);
});
test('settled cleanup deletes exact quiescent abandoned candidate only', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.abandon(context, { quiescent: true });
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).completed, [context.operationId]);
  assert.equal(fs.existsSync(context.candidatePath), false);
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'mine');
  for (const name of fs.readdirSync(f.dependencies.journalRoot).filter(name => name.includes('.retained-proof-'))) {
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(f.dependencies.journalRoot, name))), 'entries'), false);
  }
});
test('cleanup handles immutable historical ownership across a second update', async t => {
  const f = fixture(t); const first = await stage(f); await f.tx.seal(first); await f.tx.publish(first);
  const second = await stage(f); await f.tx.seal(second); await f.tx.publish(second);
  const result = await f.tx.cleanup(f.target, cleanupOptions());
  assert.deepEqual(new Set(result.completed), new Set([first.operationId, second.operationId]));
  assert.equal(fs.existsSync(first.previousPath), false); assert.equal(fs.existsSync(second.previousPath), false);
  assert.equal(fs.readFileSync(path.join(f.live, 'mods/new.jar'), 'utf8'), 'new');
});
test('preparing and ready records never authorize cleanup and missing quiescence retains settled trees', async t => {
  const f = fixture(t); const context = await stage(f);
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [context.operationId]);
  await f.tx.seal(context);
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [context.operationId]);
  await f.tx.publish(context);
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions({ isQuiescent: async () => false }))).retained, [context.operationId]);
  assert.equal(fs.existsSync(context.previousPath), true);
});
for (const mutation of ['root-substitution', 'file-substitution', 'modified-content', 'junction']) test(`cleanup retains ${mutation} without following or deleting it`, async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  const victim = insideFixture(f, path.join(context.previousPath, 'options.txt'));
  if (mutation === 'root-substitution') { fs.renameSync(insideFixture(f, context.previousPath), insideFixture(f, context.previousPath + '-retained')); fs.mkdirSync(context.previousPath); }
  if (mutation === 'file-substitution') { fs.renameSync(victim, insideFixture(f, path.join(f.root, 'original-options'))); fs.writeFileSync(victim, 'mine'); }
  if (mutation === 'modified-content') fs.writeFileSync(victim, 'changed');
  if (mutation === 'junction') fs.symlinkSync(f.live, insideFixture(f, path.join(context.previousPath, 'linked-live')), 'junction');
  const result = await f.tx.cleanup(f.target, cleanupOptions());
  assert.deepEqual(result.retained, [context.operationId]); assert.equal(fs.existsSync(context.previousPath), true);
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
});
test('interruption after exact deletion before progress commit resumes the single pending absence', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  let failed = false;
  f.tx.durableFs = { ...f.durableFs, async writeJsonAtomicAsync(file, record, options) {
    if (file.includes('.cleanup-') && record.cursor === 1 && record.pending === null && !failed) { failed = true; throw new Error('injected progress commit failure'); }
    return f.durableFs.writeJsonAtomicAsync(file, record, options);
  } };
  const first = await f.tx.cleanup(f.target, cleanupOptions({ maxDeletes: 1 })); assert.equal(failed, true); assert.deepEqual(first.retained, [context.operationId]);
  const reopened = new ClientPackTransaction(f.dependencies);
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions())).completed, [context.operationId]);
  assert.equal(fs.existsSync(context.previousPath), false);
});
test('bounded cleanup persists progress and completes after reopening', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  const first = await f.tx.cleanup(f.target, cleanupOptions({ maxDeletes: 1 }));
  assert.deepEqual(first.pending, [context.operationId]); assert.equal(fs.existsSync(context.previousPath), true);
  const reopened = new ClientPackTransaction(f.dependencies);
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions())).completed, [context.operationId]);
});
test('completed operation does not starve older pending history at the operation budget', async t => {
  const f = fixture(t); const first = await stage(f); await f.tx.seal(first); await f.tx.publish(first);
  const second = await stage(f); await f.tx.seal(second); await f.tx.publish(second);
  const initial = await f.tx.cleanup(f.target, cleanupOptions({ maxOperations: 1 }));
  assert.deepEqual(initial.completed, [second.operationId]); assert.deepEqual(initial.pending, [first.operationId]);
  const resumed = await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions({ maxOperations: 1 }));
  assert.ok(resumed.completed.includes(first.operationId));
  assert.equal(fs.existsSync(first.previousPath), false);
});
test('oversized native cleanup inventory retains previous but does not block valid publication', async t => {
  const f = fixture(t);
  const bulk = path.join(f.live, 'bulk'); fs.mkdirSync(bulk);
  for (let index = 0; index < 20000; index++) fs.writeFileSync(path.join(bulk, `${index}.txt`), '');
  const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  assert.equal((await f.tx.status(f.target)).phase, 'committed');
  const result = await f.tx.cleanup(f.target, cleanupOptions());
  assert.deepEqual(result.retained, [context.operationId]); assert.equal(fs.existsSync(context.previousPath), true);
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
  const proofName = fs.readdirSync(f.dependencies.journalRoot).find(name => name.includes(`retained-proof-${context.operationId}-previous`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dependencies.journalRoot, proofName))).retentionReason, 'inventory-entry-limit');
});
test('missing retained root with exact proof records durable completion without touching live', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  fs.renameSync(insideFixture(f, context.previousPath), insideFixture(f, path.join(f.root, 'moved-previous')));
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).completed, [context.operationId]);
  assert.equal(fs.readFileSync(path.join(f.root, 'moved-previous/options.txt'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
});
for (const mutation of ['missing-entry', 'changed-entry']) test(`partial cleanup refuses unexpected ${mutation} on retry`, async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions({ maxDeletes: 1 }))).pending, [context.operationId]);
  const victim = insideFixture(f, path.join(context.previousPath, 'options.txt'));
  if (mutation === 'missing-entry') fs.unlinkSync(victim); else fs.writeFileSync(victim, 'edit');
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).retained, [context.operationId]);
  assert.equal(fs.existsSync(context.previousPath), true);
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'mine');
});
test('interrupted root deletion reconciles only exact pending final root', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  let failed = false;
  f.tx.durableFs = { ...f.durableFs, async writeJsonAtomicAsync(file, record, options) {
    if (file.includes('.cleanup-') && record.cursor === record.entryCount && record.phase === 'cleaning' && !failed) { failed = true; throw new Error('injected root progress commit failure'); }
    return f.durableFs.writeJsonAtomicAsync(file, record, options);
  } };
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [context.operationId]);
  assert.equal(failed, true); assert.equal(fs.existsSync(context.previousPath), false);
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).completed, [context.operationId]);
});
test('missing legacy proof and corrupt cleanup intent retain contents without changing live classification', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  const proofName = fs.readdirSync(f.dependencies.journalRoot).find(name => name.includes(`retained-proof-${context.operationId}-previous`));
  const proofPath = insideFixture(f, path.join(f.dependencies.journalRoot, proofName));
  const proofBytes = fs.readFileSync(proofPath); fs.unlinkSync(proofPath);
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [context.operationId]);
  fs.writeFileSync(proofPath, proofBytes);
  await f.tx.cleanup(f.target, cleanupOptions({ maxDeletes: 1 }));
  const cleanupName = fs.readdirSync(f.dependencies.journalRoot).find(name => name.includes(`.cleanup-${context.operationId}`));
  const cleanupPath = insideFixture(f, path.join(f.dependencies.journalRoot, cleanupName));
  const intent = JSON.parse(fs.readFileSync(cleanupPath)); intent.path = f.live;
  fs.writeFileSync(cleanupPath, JSON.stringify(intent));
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).retained, [context.operationId]);
  assert.equal((await f.tx.status(f.target)).phase, 'committed');
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'mine');
});
test('abandoned before candidate mkdir completes only with positive quiescence and proven absence', async t => {
  const f = fixture(t); const operationId = '77777777-7777-4777-8777-777777777777';
  f.tx.durableFs = { ...f.durableFs, async writeJsonAtomicAsync(file, record, options) {
    if (file.includes('.retained-proof-')) throw new Error('proof write failed before mkdir');
    return f.durableFs.writeJsonAtomicAsync(file, record, options);
  } };
  await assert.rejects(stage(f, { operationId }));
  assert.equal((await f.tx.status(f.target)).phase, 'abandoned');
  const reopened = new ClientPackTransaction(f.dependencies);
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions({ isQuiescent: async () => false }))).retained, [operationId]);
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions())).completed, [operationId]);
  const cleanupPath = reopened._retainedPaths(f.target, operationId, 'candidate').cleanupPath;
  const terminal = JSON.parse(fs.readFileSync(cleanupPath)); fs.writeFileSync(cleanupPath, JSON.stringify({ ...terminal, schemaVersion: 1 }));
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions({ isQuiescent: async () => false }))).completed, [operationId]);
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
});
test('unknown retained membership is rejected before opening unowned bytes for hashing', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  const unexpected = path.join(context.previousPath, 'aaaa-unowned'); fs.writeFileSync(unexpected, 'not owned');
  const open = fs.promises.open; let openedUnowned = false;
  t.mock.method(fs.promises, 'open', async (file, ...args) => { if (file === unexpected) openedUnowned = true; return open(file, ...args); });
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [context.operationId]);
  assert.equal(openedUnowned, false);
  assert.equal(fs.readFileSync(unexpected, 'utf8'), 'not owned');
});
test('cleanup reports incomplete metadata enumeration instead of false completion', async t => {
  const f = fixture(t);
  for (let index = 0; index < 10001; index++) fs.writeFileSync(path.join(f.dependencies.journalRoot, `unrelated-${index}.json`), '');
  const result = await f.tx.cleanup(f.target, cleanupOptions());
  assert.equal(result.incomplete, true);
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
});
test('completed history records do not exhaust unsettled history collection budget', async t => {
  const f = fixture(t);
  const first = await stage(f, { operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }); await f.tx.seal(first); await f.tx.publish(first);
  const second = await stage(f); await f.tx.seal(second); await f.tx.publish(second);
  await f.tx.cleanup(f.target, cleanupOptions({ maxOperations: 1 }));
  const names = fs.readdirSync(f.dependencies.journalRoot);
  const activeName = names.find(name => /^[a-f0-9]{64}\.json$/.test(name)); const base = activeName.slice(0, -5);
  const record = JSON.parse(fs.readFileSync(path.join(f.dependencies.journalRoot, activeName)));
  const terminal = JSON.parse(fs.readFileSync(path.join(f.dependencies.journalRoot, `${base}.cleanup-${second.operationId}.json`)));
  for (let index = 0; index < 256; index++) {
    const operationId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
    const history = { ...record, operationId };
    fs.writeFileSync(path.join(f.dependencies.journalRoot, `${base}.history-${operationId}.json`), JSON.stringify(history));
    fs.writeFileSync(path.join(f.dependencies.journalRoot, `${base}.cleanup-${operationId}.json`), JSON.stringify({ ...terminal, operationId, sourceRecordSha256: hash(JSON.stringify(history)) }));
  }
  const result = await f.tx.cleanup(f.target, cleanupOptions());
  assert.ok(result.completed.includes(first.operationId)); assert.equal(fs.existsSync(first.previousPath), false);
});
for (const role of ['previous', 'candidate']) for (const boundary of ['final-flush', 'complete-write']) test(`cleanup resumes ${role} after final cursor commit interrupted at ${boundary}`, async t => {
  const f = fixture(t); const context = await stage(f);
  if (role === 'previous') { await f.tx.seal(context); await f.tx.publish(context); }
  else await f.tx.abandon(context, { quiescent: true });
  let finalCursor = false; let failed = false;
  f.tx.durableFs = { ...f.durableFs,
    async writeJsonAtomicAsync(file, record, options) {
      if (file.includes('.cleanup-') && record.phase === 'complete' && boundary === 'complete-write') { failed = true; throw new Error('complete marker failure'); }
      const result = await f.durableFs.writeJsonAtomicAsync(file, record, options);
      if (file.includes('.cleanup-') && record.phase === 'cleaning' && record.cursor === record.entryCount && record.pending === null) finalCursor = true;
      return result;
    },
    async flushDirectoryAsync(directory) {
      if (finalCursor && boundary === 'final-flush') { failed = true; throw new Error('final flush failure'); }
      return f.durableFs.flushDirectoryAsync(directory);
    }
  };
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [context.operationId]); assert.equal(failed, true);
  assert.equal(fs.existsSync(role === 'previous' ? context.previousPath : context.candidatePath), false);
  const cleanupName = fs.readdirSync(f.dependencies.journalRoot).find(name => name.includes(`.cleanup-${context.operationId}`));
  const persisted = JSON.parse(fs.readFileSync(path.join(f.dependencies.journalRoot, cleanupName)));
  assert.equal(persisted.cursor, persisted.entryCount); assert.equal(persisted.pending, null); assert.equal(persisted.phase, 'cleaning');
  const reopened = new ClientPackTransaction(f.dependencies);
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions({ isQuiescent: async () => false }))).retained, [context.operationId]);
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions())).completed, [context.operationId]);
  assert.deepEqual((await reopened.cleanup(f.target, cleanupOptions({ isQuiescent: async () => false }))).completed, [context.operationId]);
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
});
test('fully advanced cleanup cursor never authorizes a recreated retained root', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  f.tx.durableFs = { ...f.durableFs, async writeJsonAtomicAsync(file, record, options) {
    if (file.includes('.cleanup-') && record.phase === 'complete') throw new Error('complete marker failure');
    return f.durableFs.writeJsonAtomicAsync(file, record, options);
  } };
  assert.deepEqual((await f.tx.cleanup(f.target, cleanupOptions())).retained, [context.operationId]);
  assert.equal(fs.existsSync(context.previousPath), false);
  fs.mkdirSync(insideFixture(f, context.previousPath)); write(context.previousPath, 'foreign.txt', 'not owned');
  assert.deepEqual((await new ClientPackTransaction(f.dependencies).cleanup(f.target, cleanupOptions())).retained, [context.operationId]);
  assert.equal(fs.readFileSync(path.join(context.previousPath, 'foreign.txt'), 'utf8'), 'not owned');
  assert.equal(fs.readFileSync(path.join(f.live, 'saves/world.dat'), 'utf8'), 'save');
});
test('path guard allows absent exact-path journal without writing metadata', async t => {
  const f = fixture(t);
  assert.equal(await f.tx.assertNoUnsettledAtPath(f.live), undefined);
  assert.deepEqual(fs.readdirSync(f.dependencies.journalRoot), []);
});
for (const phase of ['preparing', 'ready']) test(`path guard refuses ${phase} independently of registered client ID`, async t => {
  const f = fixture(t); const context = await stage(f);
  if (phase === 'ready') await f.tx.seal(context);
  await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(context.candidatePath), true);
  assert.equal((await f.tx.status(f.target)).phase, phase);
});
for (const phase of ['committed', 'abandoned']) test(`path guard allows strictly valid ${phase} despite explicitly recreated live root`, async t => {
  const f = fixture(t); const context = await stage(f);
  if (phase === 'committed') { await f.tx.seal(context); await f.tx.publish(context); } else await f.tx.abandon(context, { quiescent: true });
  fs.renameSync(insideFixture(f, f.live), insideFixture(f, path.join(f.root, 'retained-old-live'))); fs.mkdirSync(f.live);
  const journalName = fs.readdirSync(f.dependencies.journalRoot).find(name => /^[a-f0-9]{64}\.json$/.test(name));
  const journalPath = path.join(f.dependencies.journalRoot, journalName); const record = JSON.parse(fs.readFileSync(journalPath));
  record.clientId = 'former-client-registration'; fs.writeFileSync(journalPath, JSON.stringify(record));
  const before = fs.readFileSync(journalPath);
  assert.equal(await f.tx.assertNoUnsettledAtPath(f.live), undefined);
  assert.deepEqual(fs.readFileSync(journalPath), before); assert.deepEqual(fs.readdirSync(f.live), []);
  assert.equal(fs.readFileSync(path.join(f.root, 'retained-old-live/options.txt'), 'utf8'), 'mine');
});
test('path guard does not confuse another roots pending journal with requested path', async t => {
  const f = fixture(t); await stage(f);
  const other = path.join(f.root, 'other-client'); fs.mkdirSync(other);
  assert.equal(await f.tx.assertNoUnsettledAtPath(other), undefined);
  await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live), { code: 'RECOVERY_REQUIRED' });
});
for (const corruption of ['invalid-json', 'phase-only', 'wrong-path', 'invalid-client-id', 'invalid-operation-id', 'native-identity-type', 'mismatched-tree']) test(`path guard rejects ${corruption} settled journal instead of trusting phase`, async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  const journalName = fs.readdirSync(f.dependencies.journalRoot).find(name => /^[a-f0-9]{64}\.json$/.test(name));
  const journalPath = path.join(f.dependencies.journalRoot, journalName); let record = JSON.parse(fs.readFileSync(journalPath));
  if (corruption === 'phase-only') record = { phase: 'committed' };
  if (corruption === 'wrong-path') record.clientPath = path.join(f.root, 'other-client');
  if (corruption === 'invalid-client-id') record.clientId = 'invalid/client';
  if (corruption === 'invalid-operation-id') record.operationId = 'not-a-uuid';
  if (corruption === 'native-identity-type') record.parentIdentity.volumeSerial = 123;
  if (corruption === 'mismatched-tree') record.candidateTree.directoryIdentity.fileId = '0';
  const bytes = corruption === 'invalid-json' ? '{invalid' : JSON.stringify(record); fs.writeFileSync(journalPath, bytes);
  await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(journalPath, 'utf8'), bytes);
});
test('path guard recognizes Windows case aliases without old live identity inspection', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); const context = await stage(f);
  await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live.toUpperCase().replaceAll('\\', '/')), { code: 'RECOVERY_REQUIRED' });
  await f.tx.abandon(context, { quiescent: true });
  assert.equal(await f.tx.assertNoUnsettledAtPath(f.live.toUpperCase().replaceAll('\\', '/')), undefined);
});
test('path guard fails closed on journal read errors', async t => {
  const f = fixture(t);
  f.tx.durableFs = { ...f.durableFs, async readFileBoundedAsync() { throw new Error('injected read failure'); } };
  await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live), { code: 'RECOVERY_REQUIRED' });
});
for (const phase of ['preparing', 'ready']) for (const suffix of ['\\', '/']) test(`path guard refuses ${phase} through trailing ${JSON.stringify(suffix)} alias`, async t => {
  const f = fixture(t); const context = await stage(f); if (phase === 'ready') await f.tx.seal(context);
  await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live + suffix), { code: 'RECOVERY_REQUIRED' });
});
for (const phase of ['preparing', 'ready']) test(`path guard canonical query sees legacy trailing-key ${phase} journal`, async t => {
  const f = fixture(t); const context = await stage(f); if (phase === 'ready') await f.tx.seal(context);
  const journalName = fs.readdirSync(f.dependencies.journalRoot).find(name => /^[a-f0-9]{64}\.json$/.test(name));
  const originalPath = insideFixture(f, path.join(f.dependencies.journalRoot, journalName));
  const record = JSON.parse(fs.readFileSync(originalPath)); record.clientPath = f.live + path.sep;
  const legacyPath = insideFixture(f, path.join(f.dependencies.journalRoot, `${hash(process.platform === 'win32' ? record.clientPath.toLowerCase() : record.clientPath)}.json`));
  fs.renameSync(originalPath, legacyPath); const bytes = JSON.stringify(record); fs.writeFileSync(legacyPath, bytes);
  await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), bytes); assert.equal(fs.existsSync(originalPath), false);
});
test('path guard trailing aliases allow absent and settled journals without migration', async t => {
  const f = fixture(t);
  for (const suffix of ['\\', '/']) assert.equal(await f.tx.assertNoUnsettledAtPath(f.live + suffix), undefined);
  const context = await stage(f); await f.tx.abandon(context, { quiescent: true });
  const names = fs.readdirSync(f.dependencies.journalRoot); const journalName = names.find(name => /^[a-f0-9]{64}\.json$/.test(name));
  const before = fs.readFileSync(path.join(f.dependencies.journalRoot, journalName));
  for (const suffix of ['\\', '/']) assert.equal(await f.tx.assertNoUnsettledAtPath(f.live + suffix), undefined);
  assert.deepEqual(fs.readdirSync(f.dependencies.journalRoot), names); assert.deepEqual(fs.readFileSync(path.join(f.dependencies.journalRoot, journalName)), before);
});
test('path guard settled canonical journal cannot hide corrupt legacy trailing key', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.abandon(context, { quiescent: true });
  const alias = f.live + path.sep;
  const legacyPath = path.join(f.dependencies.journalRoot, `${hash(process.platform === 'win32' ? alias.toLowerCase() : alias)}.json`);
  fs.writeFileSync(legacyPath, '{invalid');
  await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), '{invalid');
});
test('path guard rejects nonprimitive authority scalar fields in settled records', async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  const journalName = fs.readdirSync(f.dependencies.journalRoot).find(name => /^[a-f0-9]{64}\.json$/.test(name));
  const journalPath = path.join(f.dependencies.journalRoot, journalName); const good = JSON.parse(fs.readFileSync(journalPath));
  const fields = ['schemaVersion', 'operationId', 'clientId', 'clientPath', 'phase', 'parentIdentity.volumeSerial', 'parentIdentity.fileId',
    'oldTree.fingerprint', 'oldTree.directoryIdentity.volumeSerial', 'oldTree.directoryIdentity.fileId',
    'candidateIdentity.volumeSerial', 'candidateIdentity.fileId', 'candidateTree.fingerprint',
    'candidateTree.directoryIdentity.volumeSerial', 'candidateTree.directoryIdentity.fileId'];
  for (const field of fields) {
    const segments = field.split('.');
    for (const kind of ['array', 'object', 'null', 'number', 'boolean']) {
      const record = structuredClone(good); let parent = record;
      for (const segment of segments.slice(0, -1)) parent = parent[segment];
      const key = segments.at(-1); const value = parent[key];
      parent[key] = kind === 'array' ? [value] : kind === 'object' ? { value } : kind === 'null' ? null : kind === 'number' ? 123 : true;
      fs.writeFileSync(journalPath, JSON.stringify(record));
      await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live), { code: 'RECOVERY_REQUIRED' }, `${field}: ${kind}`);
      await assert.rejects(f.tx.status(f.target), { code: 'RECOVERY_REQUIRED' }, `reader ${field}: ${kind}`);
    }
  }
  fs.writeFileSync(journalPath, JSON.stringify(good)); assert.equal(await f.tx.assertNoUnsettledAtPath(f.live), undefined);
});
for (const field of ['operationId', 'oldTree.fingerprint', 'candidateTree.fingerprint']) test(`persisted transaction reader rejects array ${field}`, async t => {
  const f = fixture(t); const context = await stage(f); await f.tx.seal(context); await f.tx.publish(context);
  const journalName = fs.readdirSync(f.dependencies.journalRoot).find(name => /^[a-f0-9]{64}\.json$/.test(name));
  const journalPath = path.join(f.dependencies.journalRoot, journalName); const record = JSON.parse(fs.readFileSync(journalPath));
  if (field === 'operationId') record.operationId = [record.operationId]; else { const tree = field.split('.')[0]; record[tree].fingerprint = [record[tree].fingerprint]; }
  fs.writeFileSync(journalPath, JSON.stringify(record));
  await assert.rejects(f.tx.status(f.target), { code: 'RECOVERY_REQUIRED' });
});
for (const phase of ['committed', 'abandoned']) test(`path guard allows legacy trailing-key ${phase} without migration`, async t => {
  const f = fixture(t); const context = await stage(f);
  if (phase === 'committed') { await f.tx.seal(context); await f.tx.publish(context); } else await f.tx.abandon(context, { quiescent: true });
  const journalName = fs.readdirSync(f.dependencies.journalRoot).find(name => /^[a-f0-9]{64}\.json$/.test(name));
  const originalPath = insideFixture(f, path.join(f.dependencies.journalRoot, journalName)); const record = JSON.parse(fs.readFileSync(originalPath));
  record.clientPath = f.live + path.sep;
  const legacyPath = insideFixture(f, path.join(f.dependencies.journalRoot, `${hash(process.platform === 'win32' ? record.clientPath.toLowerCase() : record.clientPath)}.json`));
  fs.renameSync(originalPath, legacyPath); const bytes = JSON.stringify(record); fs.writeFileSync(legacyPath, bytes);
  for (const suffix of ['', '\\', '/']) assert.equal(await f.tx.assertNoUnsettledAtPath(f.live + suffix), undefined);
  assert.equal(fs.existsSync(originalPath), false); assert.equal(fs.readFileSync(legacyPath, 'utf8'), bytes);
});
test('path guard uses at most two exact-key bounded reads and fails closed if legacy read is unknown', async t => {
  const f = fixture(t); const reads = [];
  f.tx.durableFs = { ...f.durableFs, async readFileBoundedAsync(file, options) {
    reads.push(file); assert.equal(options.maxBytes, 1024 * 1024); assert.equal(options.allowMissing, true);
    return f.durableFs.readFileBoundedAsync(file, options);
  } };
  assert.equal(await f.tx.assertNoUnsettledAtPath(f.live + '\\\\'), undefined); assert.equal(new Set(reads).size, 2); assert.equal(reads.length, 2);
  assert.deepEqual(fs.readdirSync(f.dependencies.journalRoot), []);
  let count = 0;
  f.tx.durableFs = { ...f.durableFs, async readFileBoundedAsync(file, options) {
    if (++count === 2) throw new Error('legacy key unreadable');
    return f.durableFs.readFileBoundedAsync(file, options);
  } };
  await assert.rejects(f.tx.assertNoUnsettledAtPath(f.live), { code: 'RECOVERY_REQUIRED' });
});


// Task 7: actual progress remains observation, never publication authority.
const phaseOf = event => event.phase ?? event.activity;
const phases = events => events.map(phaseOf).filter((phase, i, values) => i === 0 || phase !== values[i - 1]);
const measurements = (events, phase) => events.filter(event => phaseOf(event) === phase).map(event => ({
  completedItems: String(event.completedItems), totalItems: String(event.totalItems),
  ...(event.completedBytes === undefined ? {} : { completedBytes: String(event.completedBytes), totalBytes: String(event.totalBytes) })
}));
function assertSubsequence(actual, expected) {
  let previous = -1;
  for (const value of expected) { const index = actual.indexOf(value, previous + 1); assert.ok(index > previous, `Missing ordered phase ${value}: ${actual}`); previous = index; }
}
function addPayload(f) {
  for (const [relative, bytes] of [['config/a.cfg', 'aaa'], ['config/b.cfg', 'bbbbb']]) {
    const file = path.join(f.prepared.path, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    f.prepared.manifest.entries.push({ path: relative, pathKey: relative, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: String(bytes.length), policy: 'managed' });
  }
}

test('task7: selected pack progress counts only verified copies and clears counts before settlement', async t => {
  const f = fixture(t); addPayload(f); const events = [], observations = [];
  const operationId = crypto.randomUUID(); const candidate = f.tx.candidatePathFor(f.target, operationId);
  const context = await stage(f, { operationId, onProgress: event => {
    events.push(event);
    if (event.phase !== 'copying-pack-files') return;
    // Record instead of asserting in the observer: producer MUST swallow observer errors.
    const copies = f.prepared.manifest.entries.filter(entry => entry.policy === 'managed' && fs.existsSync(path.join(candidate, entry.path)));
    observations.push({ completed: Number(event.completedItems), valid: copies.filter(entry => {
      const bytes = fs.readFileSync(path.join(candidate, entry.path));
      return crypto.createHash('sha256').update(bytes).digest('hex') === entry.sha256 && String(bytes.length) === entry.size;
    }).length });
  } });
  const copy = measurements(events, 'copying-pack-files');
  assert.deepEqual(copy.map(e => e.completedItems), ['0', '1', '2', '3']);
  assert.ok(copy.every(e => e.totalItems === '3' && e.totalBytes === '11'));
  assert.equal(copy[0].completedBytes, '0'); assert.equal(copy.at(-1).completedBytes, '11');
  assert.deepEqual(observations, [0, 1, 2, 3].map(n => ({ completed: n, valid: n })));
  assertSubsequence(phases(events), ['checking-client-files', 'checking-client-copy', 'checking-prepared-pack', 'copying-pack-files', 'finishing-pack-copy', 'writing-client-manifest']);
  for (const event of events.filter(e => ['checking-prepared-pack', 'finishing-pack-copy', 'writing-client-manifest'].includes(e.phase))) {
    assert.equal(event.completedItems, undefined); assert.equal(event.completedBytes, undefined);
  }
  assert.equal(JSON.stringify(events).includes(f.root), false);
  assert.equal(fs.readFileSync(path.join(context.candidatePath, 'options.txt'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'mine');
  assert.equal((await f.tx.status(f.target)).phase, 'preparing', 'stage counters do not commit installation');
});

for (const mode of ['abort', 'changed-next-source']) test(`task7: ${mode} cannot advance a selected-copy count past completed work`, async t => {
  const f = fixture(t); addPayload(f); const controller = new AbortController(); const events = [];
  const operationId = crypto.randomUUID(), candidate = f.tx.candidatePathFor(f.target, operationId); let injected = false;
  await assert.rejects(stage(f, { operationId, signal: controller.signal, onProgress: event => {
    events.push(event);
    if (event.phase !== 'copying-pack-files' || String(event.completedItems) !== '1' || injected) return;
    injected = true;
    if (mode === 'abort') controller.abort();
    else {
      fs.writeFileSync(path.join(f.prepared.path, 'config/b.cfg'), 'changed after captured plan');
    }
  } }), error => mode === 'abort' ? error.name === 'AbortError' || error.code === 'CANCELLED' : error.code === 'PLAN_STALE');
  assert.equal(injected, true); assert.deepEqual(measurements(events, 'copying-pack-files').map(e => e.completedItems), ['0', '1']);
  assert.equal(events.some(e => e.phase === 'writing-client-manifest'), false);
  assert.equal((await f.tx.status(f.target)).phase, 'abandoned');
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(path.join(f.live, 'mods/new.jar')), false);
});

for (const rejection of ['sync', 'async']) test(`task7: ${rejection} selected-copy observer failure cannot alter staging`, async t => {
  const f = fixture(t); let calls = 0;
  const context = await stage(f, { onProgress: event => {
    if (event.phase !== 'copying-pack-files') return;
    calls++;
    if (rejection === 'sync') throw new Error('inert observer failure');
    return Promise.reject(new Error('inert rejected observer'));
  } });
  assert.ok(calls >= 2); assert.equal(fs.readFileSync(path.join(context.candidatePath, 'mods/new.jar'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'mine');
  assert.equal((await f.tx.status(f.target)).phase, 'preparing');
});

for (const selection of ['empty', 'preserved-only']) test(`task7: ${selection} has a zero selected-copy denominator, never a fabricated completion`, async t => {
  const f = fixture(t); const events = [];
  f.prepared.manifest.entries = selection === 'empty' ? [] : f.prepared.manifest.entries.filter(entry => entry.path === 'options.txt');
  await stage(f, { onProgress: event => events.push(event) });
  assert.deepEqual(measurements(events, 'copying-pack-files'), [{ completedItems: '0', totalItems: '0', completedBytes: '0', totalBytes: '0' }]);
  assert.equal(events.some(e => e.phase === 'finishing-pack-copy'), false, 'no hash service was created');
  assert.equal(fs.readFileSync(path.join(f.live, 'options.txt'), 'utf8'), 'mine');
});

test('task7: explicitly preserved managed conflict is excluded from selected-copy totals', async t => {
  const f = fixture(t); addPayload(f); write(f.live, 'mods/new.jar', 'personal'); const events = [];
  const context = await stage(f, { conflictChoices: { 'mods/new.jar': 'preserve' }, onProgress: event => events.push(event) });
  assert.deepEqual(measurements(events, 'copying-pack-files'), [
    { completedItems: '0', totalItems: '2', completedBytes: '0', totalBytes: '8' },
    { completedItems: '1', totalItems: '2', completedBytes: '3', totalBytes: '8' },
    { completedItems: '2', totalItems: '2', completedBytes: '8', totalBytes: '8' }
  ]);
  assert.equal(fs.readFileSync(path.join(context.candidatePath, 'mods/new.jar'), 'utf8'), 'personal');
  assert.equal(fs.readFileSync(path.join(f.live, 'mods/new.jar'), 'utf8'), 'personal');
});
test('task7: selected-copy progress has bounded stride emissions without losing measured totals', async t => {
  const f = fixture(t); const events = [];
  for (let index = 0; index < 400; index++) {
    const relative = `config/bulk-${String(index).padStart(3, '0')}.cfg`;
    write(f.prepared.path, relative, 'x');
    f.prepared.manifest.entries.push({ path: relative, pathKey: relative, sha256: hash('x'), size: '1', policy: 'managed' });
  }
  const context = await stage(f, { onProgress: event => events.push(event) });
  const copies = measurements(events, 'copying-pack-files');
  assert.equal(copies.length, 135); assert.deepEqual(copies.slice(0, 3).map(e => e.completedItems), ['0', '3', '6']);
  assert.deepEqual(copies.at(-1), { completedItems: '401', totalItems: '401', completedBytes: '403', totalBytes: '403' });
  assert.equal(fs.readdirSync(path.join(context.candidatePath, 'config')).length, 400);
});
test('task7: pending observer promise is never awaited by staging', async t => {
  const f = fixture(t); let release; const gate = new Promise(resolve => { release = resolve; }); let observed = 0, timer;
  const outcome = stage(f, { onProgress: event => { if (event.phase === 'copying-pack-files') { observed++; return gate; } } });
  try {
    const context = await Promise.race([outcome, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Staging awaited observer')), 5000); })]);
    assert.equal(observed, 2); assert.equal(fs.readFileSync(path.join(context.candidatePath, 'mods/new.jar'), 'utf8'), 'new');
  } finally { clearTimeout(timer); release(); await outcome; }
});
