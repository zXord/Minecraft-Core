const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { captureServerDirectoryCopySource } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
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
  const first = await f.tx.cleanup(f.target, cleanupOptions()); assert.equal(failed, true); assert.deepEqual(first.retained, [context.operationId]);
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
