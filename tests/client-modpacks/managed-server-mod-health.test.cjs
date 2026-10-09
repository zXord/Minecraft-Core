const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const modulePath = '../../electron/services/client-modpacks/managed-server-mod-health.cjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-companion-health-'));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(path.join(serverPath, 'mods'), { recursive: true });
  const entry = (name, bytes, extra = {}) => ({ path: `mods/${name}`, pathKey: `mods/${name}`,
    origin: 'pack', managementPolicy: 'replaceable-managed', role: 'mod', size: String(Buffer.byteLength(bytes)),
    installedHash: crypto.createHash('sha256').update(bytes).digest('hex'), priorBaseline: null, ...extra });
  fs.writeFileSync(path.join(serverPath, 'mods/a.jar'), 'aaaa');
  fs.writeFileSync(path.join(serverPath, 'mods/b.jar'), 'bbbb');
  let record = { state: { modpackManaged: true, manifestId: 'install-one' }, manifest: {
    schemaVersion: 1, installationId: 'install-one', entries: [entry('a.jar', 'aaaa'), entry('b.jar', 'bbbb')] } };
  let reads = 0; let stats = 0; let hook;
  const fsApi = Object.create(fs);
  fsApi.lstatSync = (...args) => { stats++; return fs.lstatSync(...args); };
  const fsPromises = { async open(...args) {
    const handle = await fs.promises.open(...args);
    return { stat: (...values) => handle.stat(...values), close: () => handle.close(), async read(...values) {
      reads++; if (hook) await hook(); return handle.read(...values);
    } };
  } };
  const { ManagedServerModHealth } = require(modulePath);
  const health = new ManagedServerModHealth({ readRecord: async () => record, fsApi, fsPromises,
    reparseInspector: { async isReparsePoint() { return false; } } });
  t.after(async () => { await health.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, serverPath, health, entry, fsApi,
    check: options => health.assertHealthy({ serverId: 'server-one', serverPath, record, ...options }),
    get record() { return record; }, set record(value) { record = value; },
    get reads() { return reads; }, get stats() { return stats; }, set hook(value) { hook = value; } };
}

test('warm health checks inspect metadata but skip bytes; force always reads bytes', async t => {
  const f = await fixture(t); await f.check(); const reads = f.reads; const stats = f.stats;
  await f.check(); assert.equal(f.reads, reads); assert.ok(f.stats > stats);
  await f.check({ force: true }); assert.ok(f.reads > reads);
});

for (const change of ['delete', 'disable', 'same-size', 'wrong-size', 'directory', 'hardlink', 'ctime']) {
  test(`cached health refuses expected JAR ${change}`, async t => {
    const f = await fixture(t); await f.check(); const jar = path.join(f.serverPath, 'mods/a.jar');
    if (change === 'delete') fs.unlinkSync(jar);
    if (change === 'disable') fs.renameSync(jar, `${jar}.disabled`);
    if (change === 'same-size' || change === 'ctime') {
      const before = fs.statSync(jar); fs.writeFileSync(jar, 'evil');
      if (change === 'ctime') fs.utimesSync(jar, before.atime, before.mtime);
    }
    if (change === 'wrong-size') fs.writeFileSync(jar, 'wrong size');
    if (change === 'directory') { fs.unlinkSync(jar); fs.mkdirSync(jar); }
    if (change === 'hardlink') fs.linkSync(jar, path.join(f.serverPath, 'mods/alias.jar'));
    await assert.rejects(f.check(), { code: ['directory', 'hardlink'].includes(change) ? 'CLIENT_PACK_UNAVAILABLE' : 'CLIENT_PACK_SERVER_CHANGED' });
  });
}

test('only metadata-changed JAR rehashes; restored bytes recover', async t => {
  const f = await fixture(t); await f.check(); const reads = f.reads;
  const jar = path.join(f.serverPath, 'mods/a.jar');
  const before = fs.statSync(jar); fs.utimesSync(jar, before.atime, new Date(before.mtimeMs + 10000));
  await f.check(); assert.equal(f.reads - reads, 2);
  fs.writeFileSync(jar, 'evil'); await assert.rejects(f.check(), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  fs.writeFileSync(jar, 'aaaa'); await f.check();
});

test('configuration, world, user JAR and preserved addon changes are outside this proof', async t => {
  const f = await fixture(t);
  f.record.manifest.entries.push(f.entry('user.jar', 'user', { origin: 'user' }),
    f.entry('addon.jar', 'seed', { managementPolicy: 'preserve-after-seed' }),
    f.entry('config.jar', 'conf', { role: 'configuration' }), f.entry('world.jar', 'world', { role: 'world' }));
  await f.check(); const reads = f.reads;
  fs.writeFileSync(path.join(f.serverPath, 'mods/extra.jar'), 'extra');
  fs.writeFileSync(path.join(f.serverPath, 'server.properties'), 'changed');
  await f.check(); assert.equal(f.reads, reads);
});

test('root replacement and manifest switches discard cached proofs', async t => {
  const f = await fixture(t); await f.check(); const reads = f.reads;
  fs.renameSync(f.serverPath, `${f.serverPath}-old`);
  fs.mkdirSync(path.join(f.serverPath, 'mods'), { recursive: true });
  fs.copyFileSync(path.join(`${f.serverPath}-old`, 'mods/a.jar'), path.join(f.serverPath, 'mods/a.jar'));
  fs.copyFileSync(path.join(`${f.serverPath}-old`, 'mods/b.jar'), path.join(f.serverPath, 'mods/b.jar'));
  await f.check(); assert.ok(f.reads > reads);
  const reads2 = f.reads;
  f.record = { ...f.record, manifest: { ...f.record.manifest, installationId: 'install-two' }, state: { ...f.record.state, manifestId: 'install-two' } };
  await f.check(); assert.ok(f.reads > reads2);
});

test('reparse evidence on a warm path refuses without claiming proven changed bytes', async t => {
  const f = await fixture(t); await f.check();
  f.health.reparseInspector = { async isReparsePoint(target) { return target.endsWith('a.jar'); } };
  await assert.rejects(f.check(), { code: 'CLIENT_PACK_UNAVAILABLE' });
});

test('authoritative record changing during a hash does not warm the cache', async t => {
  const f = await fixture(t); const original = f.record;
  f.hook = async () => { f.record = { ...original, state: { ...original.state, manifestId: 'other' } }; };
  await assert.rejects(f.check(), { code: 'PLAN_STALE' });
  f.record = original; f.hook = null; const reads = f.reads;
  await f.check(); assert.ok(f.reads > reads);
});

test('aborted hash does not warm cache and disposal refuses future work', async t => {
  const f = await fixture(t); const controller = new AbortController();
  f.hook = async () => controller.abort();
  await assert.rejects(f.check({ signal: controller.signal }), { code: 'CANCELLED' });
  f.hook = null; const reads = f.reads; await f.check(); assert.ok(f.reads > reads);
  await f.health.dispose(); await assert.rejects(f.check(), { code: 'CLIENT_PACK_UNAVAILABLE' });
});

test('overlapping status calls share bytes, cancellation is caller-local, force never joins status proof', async t => {
  const f = await fixture(t); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.hook = async () => { entered(); await gate; };
  const controller = new AbortController();
  const first = f.check({ signal: controller.signal });
  const cancelled = assert.rejects(first, { code: 'CANCELLED' });
  let secondSettled = false;
  const second = f.check().then(() => { secondSettled = true; });
  await started; controller.abort(); await cancelled;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(secondSettled, false);
  release();
  await cancelled; await second; assert.equal(f.reads, 4);
  f.hook = null; const reads = f.reads;
  await Promise.all([f.check(), f.check({ force: true })]); assert.equal(f.reads - reads, 4);
});

test('junction ancestor is refused even when its target bytes match', async t => {
  const f = await fixture(t); await f.check();
  const mods = path.join(f.serverPath, 'mods'); const target = path.join(f.root, 'real-mods');
  fs.renameSync(mods, target); fs.symlinkSync(target, mods, 'junction');
  await assert.rejects(f.check(), { code: 'CLIENT_PACK_UNAVAILABLE' });
});

test('root replaced after hashing cannot publish a healthy proof', async t => {
  const f = await fixture(t); let replaced = false;
  f.health.readRecord = async () => {
    if (!replaced) {
      replaced = true; fs.renameSync(f.serverPath, `${f.serverPath}-old`);
      fs.mkdirSync(path.join(f.serverPath, 'mods'), { recursive: true });
      fs.writeFileSync(path.join(f.serverPath, 'mods/a.jar'), 'aaaa'); fs.writeFileSync(path.join(f.serverPath, 'mods/b.jar'), 'bbbb');
    }
    return f.record;
  };
  await assert.rejects(f.check(), { code: 'PLAN_STALE' });
  f.hook = null; const reads = f.reads; await f.check(); assert.ok(f.reads > reads);
});

test('an earlier expected JAR changed while hashing a later one refuses final publication', async t => {
  const f = await fixture(t); let count = 0;
  f.hook = async () => { if (++count === 3) fs.writeFileSync(path.join(f.serverPath, 'mods/a.jar'), 'evil'); };
  await assert.rejects(f.check(), { code: 'PLAN_STALE' });
});

test('all coalesced callers aborting cannot warm cache', async t => {
  const f = await fixture(t); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.hook = async () => { entered(); await gate; };
  const a = new AbortController(); const b = new AbortController();
  const first = assert.rejects(f.check({ signal: a.signal }), { code: 'CANCELLED' });
  const second = assert.rejects(f.check({ signal: b.signal }), { code: 'CANCELLED' });
  await started; a.abort(); b.abort(); await Promise.all([first, second]); release();
  await new Promise(resolve => setImmediate(resolve)); f.hook = null; const reads = f.reads;
  await f.check(); assert.ok(f.reads > reads);
});

test('cache evicts the least recently used server after 32 identities', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 33; index++) await f.check({ serverId: `server-${index}` });
  const reads = f.reads; await f.check({ serverId: 'server-32' }); assert.equal(f.reads, reads);
  await f.check({ serverId: 'server-0' }); assert.ok(f.reads > reads);
});

test('invalid manifest and preaborted requests cannot return a cached proof', async t => {
  const f = await fixture(t); await f.check(); const original = f.record;
  f.record = { ...original, manifest: { ...original.manifest, entries: [{ ...original.manifest.entries[0], path: '../escape.jar' }] } };
  await assert.rejects(f.check(), { code: 'INVALID_REQUEST' });
  f.record = original;
  await assert.rejects(f.check({ signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  const reads = f.reads; await f.check(); assert.ok(f.reads > reads);
});

test('overlapping manifest generations cannot publish the old proof after the new one succeeds', async t => {
  const f = await fixture(t); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.hook = async () => { f.hook = null; entered(); await gate; };
  const old = f.check(); const rejected = assert.rejects(old, { code: 'PLAN_STALE' }); await started;
  f.record = { ...f.record, state: { ...f.record.state, manifestId: 'install-new' }, manifest: { ...f.record.manifest, installationId: 'install-new' } };
  await f.check(); release(); await rejected;
  await f.check();
});

test('final root probe cannot publish a superseded manifest or evict its newer cached proof', async t => {
  const f = await fixture(t); let release; let entered; let gateFinal = false; let firstReread = true;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.health.readRecord = async () => { if (firstReread) { firstReread = false; gateFinal = true; } return f.record; };
  f.health.reparseInspector = { async isReparsePoint(target) {
    if (target === f.serverPath && gateFinal) { gateFinal = false; entered(); await gate; }
    return false;
  } };
  const old = f.check(); const rejection = assert.rejects(old, { code: 'PLAN_STALE' }); await started;
  f.record = { ...f.record, state: { ...f.record.state, manifestId: 'install-new' }, manifest: { ...f.record.manifest, installationId: 'install-new' } };
  try { await f.check(); } finally { release(); }
  const reads = f.reads; await rejection;
  await f.check(); assert.equal(f.reads, reads, 'Superseded work must neither overwrite nor evict the current proof');
});

test('same-authority force and status remain compatible across a gated final root probe', async t => {
  const f = await fixture(t); let release; let entered; let gateFinal = false; let firstReread = true;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.health.readRecord = async () => { if (firstReread) { firstReread = false; gateFinal = true; } return f.record; };
  f.health.reparseInspector = { async isReparsePoint(target) {
    if (target === f.serverPath && gateFinal) { gateFinal = false; entered(); await gate; }
    return false;
  } };
  const status = f.check(); await started; const reads = f.reads;
  try { await f.check({ force: true }); assert.ok(f.reads > reads); } finally { release(); }
  await status;
});

test('new root identity supersedes a request paused in its final root probe', async t => {
  const f = await fixture(t); let release; let entered; let gateFinal = false; let firstReread = true;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  f.health.readRecord = async () => { if (firstReread) { firstReread = false; gateFinal = true; } return f.record; };
  f.health.reparseInspector = { async isReparsePoint(target) {
    if (target === f.serverPath && gateFinal) { gateFinal = false; entered(); await gate; }
    return false;
  } };
  const old = f.check(); const rejection = assert.rejects(old, { code: 'PLAN_STALE' }); await started;
  fs.renameSync(f.serverPath, `${f.serverPath}-old`);
  fs.mkdirSync(path.join(f.serverPath, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(f.serverPath, 'mods/a.jar'), 'aaaa'); fs.writeFileSync(path.join(f.serverPath, 'mods/b.jar'), 'bbbb');
  try { await f.check(); } finally { release(); }
  const reads = f.reads; await rejection; await f.check(); assert.equal(f.reads, reads);
});

test('authority eviction fences paused work while readmission retains independent cancellation and disposal', { timeout: 10000 }, async t => {
  const f = await fixture(t); let entered; let firstReread = true; let gateFinal = false;
  const started = new Promise(resolve => { entered = resolve; });
  f.health.readRecord = async () => { if (firstReread) { firstReread = false; gateFinal = true; } return f.record; };
  f.health.reparseInspector = { async isReparsePoint(target, { signal }) {
    if (target === f.serverPath && gateFinal) {
      gateFinal = false; entered();
      await new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('probe cancelled'), { name: 'AbortError' }));
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
    }
    return false;
  } };
  const old = f.check({ serverId: 'server-0' });
  const cancelled = assert.rejects(old, { code: 'CANCELLED' }); await started;
  for (let index = 1; index <= 32; index++) await f.check({ serverId: `server-${index}` });
  await f.check({ serverId: 'server-0' });
  await f.health.dispose(); await cancelled;
});

test('unreadable expected JAR is unavailable, not a definite changed-files claim', async t => {
  const f = await fixture(t); const original = f.fsApi.lstatSync;
  f.fsApi.lstatSync = (target, ...args) => {
    if (target.endsWith('a.jar')) throw Object.assign(new Error('private read failure'), { code: 'EACCES' });
    return original(target, ...args);
  };
  await assert.rejects(f.check(), { code: 'CLIENT_PACK_UNAVAILABLE' });
});

test('unreadable evidence refuses safely and failures evict all cached entries', async t => {
  const f = await fixture(t); await f.check(); const original = f.fsApi.lstatSync;
  f.fsApi.lstatSync = () => { throw Object.assign(new Error('C:\\private token=secret'), { code: 'EACCES' }); };
  await assert.rejects(f.check(), error => error.code === 'CLIENT_PACK_UNAVAILABLE' && !error.message.includes('secret'));
  f.fsApi.lstatSync = original; const reads = f.reads; await f.check(); assert.ok(f.reads > reads);
});

test('each warm sweep deduplicates unchanged native ancestor probes but not across status calls', async t => {
  const f = await fixture(t); await f.check(); const probes = [];
  f.health.reparseInspector = { async isReparsePoint(target) { probes.push(target); return false; } };
  await f.check();
  assert.equal(probes.filter(target => target === path.join(f.serverPath, 'mods')).length, 2);
  probes.length = 0; await f.check();
  assert.equal(probes.filter(target => target === path.join(f.serverPath, 'mods')).length, 2);
});
