'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createServerProcessRunner } = require('../electron/services/server-process-runner.cjs');
const { ClientProcessGuard } = require('../electron/services/client-modpacks/client-process-guard.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const owner = { pid: process.pid, parentPid: process.ppid, name: 'node.exe', creationTime: 'main-start', executablePath: process.execPath, commandLine: 'node inert-test' };
const uuid = 'b09956c1-1daa-4fb9-a8fe-bf6d401c04bc';

function fixture(t, { loader = 'forge', inspection = 'ready', pendingSupervision = false, legacy = false,
  nativeRoot = false, initialRowChange, captureUnavailable = false } = {}) {
  assert.equal(typeof createServerProcessRunner().isCurrentUnrelatedServer, 'function', 'runner must expose positive process evidence');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-process-evidence-'));
  const serverPath = path.join(root, 'server'); const clientPath = path.join(root, 'client');
  fs.mkdirSync(serverPath); fs.mkdirSync(clientPath);
  const children = []; const rows = []; let nonce = 0; let inspectCalls = 0; let releaseInspect; let releaseSupervision;
  t.after(() => { children.forEach(child => child.emit('close', 0, null)); fs.rmSync(root, { recursive: true, force: true }); });
  let captureFailure = captureUnavailable; let captureAlias = false; let rootIdentity = 'server-object-1'; let duringCapture;
  const plan = { type: loader, loader, jar: null, cwd: serverPath, args: ['@user_jvm_args.txt', '@libraries/win_args.txt', 'nogui'],
    readyMarkers: ['SERVER READY'], fatalMarkers: ['SERVER FATAL'], runtime: { minecraftVersion: '1.20.1', loaderFamily: loader,
      loaderVersion: loader === 'forge' ? '47.3.12' : '20.1.1', javaMajor: 17, os: 'win32', architecture: 'x64' } };
  const eventBus = new EventEmitter();
  eventBus.on('server-process-owned', value => value.acknowledge({ ...value,
    ready: pendingSupervision ? new Promise(resolve => { releaseSupervision = resolve; }) : Promise.resolve() }));
  const dependencies = {
    eventBus, supervisionRequired: () => true, resolveLaunchPlan: () => plan,
    spawnProcess(file, args, options) {
      assert.equal(options.cwd, serverPath); assert.equal(options.windowsHide, true);
      const child = new EventEmitter(); child.pid = 4900; child.exitCode = null; child.signalCode = null; child.killed = false;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { assert.fail('evidence must not terminate a healthy server'); };
      rows.push({ pid: child.pid, parentPid: process.pid, name: 'java.exe', creationTime: `server-start-${children.length}`,
        executablePath: file, commandLine: `"${file}" ${args.join(' ')}` });
      if (initialRowChange) rows[rows.length - 1] = initialRowChange(rows.at(-1));
      children.push(child); return child;
    }
  };
  if (!legacy) Object.assign(dependencies, {
    randomUUID: () => `b09956c1-1daa-4fb9-a8fe-${String(++nonce).padStart(12, '0')}`,
    captureLaunchRoot(value) {
      if (captureFailure) throw new Error('root unavailable');
      if (duringCapture) { const action = duringCapture; duringCapture = null; action(); }
      return Object.freeze({ canonicalPath: captureAlias ? clientPath : value, identity: rootIdentity });
    },
    inspectProcesses() {
      inspectCalls++;
      if (inspection === 'failed') return Promise.reject(new Error('snapshot unavailable'));
      if (inspection === 'malformed') return Promise.resolve({ complete: false, processes: rows });
      if (inspection === 'pending') return new Promise(resolve => { releaseInspect = () => resolve({ complete: true, processes: [owner, rows.at(-1)] }); });
      return Promise.resolve({ complete: true, processes: [owner, rows.at(-1)] });
    }
  });
  if (nativeRoot) delete dependencies.captureLaunchRoot;
  const runner = createServerProcessRunner(dependencies);
  const launch = () => runner.launchServerProcess({ serverPath, instanceId: 'server-one', operationId: 'repeatable-operation',
    javaPath: path.join(root, 'java.exe'), maxRam: 4, runtime: plan.runtime, publishEvents: false, onLine() {} });
  const handle = launch();
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {}
  } });
  const guard = () => new ClientProcessGuard({ root, durableFs, inspectProcesses: async () => ({ complete: true, processes: [owner, rows.at(-1)] }),
    isCurrentUnrelatedServer: runner.isCurrentUnrelatedServer, randomUUID: () => uuid,
    acquireEndpointLease: async () => ({ assertHeld() {}, async close() {} }) });
  return { root, serverPath, clientPath, runner, handle, plan, children, rows, launch, guard,
    client: { clientId: 'client-one', clientPath },
    proof: (row = rows.at(-1), target = clientPath) => runner.isCurrentUnrelatedServer({ process: row, clientPath: target }),
    inspectCalls: () => inspectCalls, releaseInspect: () => releaseInspect(), releaseSupervision: () => releaseSupervision(),
    failRoot: () => { captureFailure = true; }, aliasRoot: () => { captureAlias = true; },
    changeRoot: () => { rootIdentity = 'server-object-2'; }, duringCapture: action => { duringCapture = action; }
  };
}

for (const loader of ['forge', 'neoforge']) test(`evidence exact ${loader} server admits matching client mutation and launch`, async t => {
  const f = fixture(t, { loader }); await tick();
  assert.equal(await f.proof(), true); assert.equal(f.inspectCalls(), 1);
  assert.equal(await f.guard().withMutation(f.client, () => 'admitted'), 'admitted');
  const launch = await f.guard().beginLaunch(f.client); await launch.abortBeforeSpawn();
  assert.equal(f.handle.isLive(), true);
  assert.equal(f.inspectCalls(), 1); // Current proofs consume the guard row, never issue more process probes.
});

for (const inspection of ['pending', 'failed', 'malformed']) test(`evidence ${inspection} capture refuses exemption without interrupting server`, async t => {
  const f = fixture(t, { inspection }); await tick(); await f.handle.supervisionReady;
  assert.equal(await f.proof(), false); assert.equal(f.handle.isLive(), true);
  await assert.rejects(f.guard().withMutation(f.client, () => assert.fail('uncertain capture admitted')), { code: 'RECOVERY_REQUIRED' });
  if (inspection === 'pending') { f.children[0].emit('exit', 0, null); f.releaseInspect(); await tick(); assert.equal(await f.proof(), false); }
});

test('evidence pending supervision never qualifies before acknowledgement completes', async t => {
  const f = fixture(t, { pendingSupervision: true }); await tick();
  assert.equal(await f.proof(), false); f.releaseSupervision(); await tick(); assert.equal(await f.proof(), true);
});

for (const [field, value] of [['pid', 4901], ['parentPid', 123], ['creationTime', 'reused'], ['executablePath', 'C:\\other\\java.exe'],
  ['commandLine', 'java @copied.txt'], ['commandLine', null], ['creationTime', null], ['executablePath', null]]) {
  test(`evidence changed ${field} ${String(value)} cannot reuse original identity`, async t => {
    const f = fixture(t); await tick(); assert.equal(await f.proof(), true);
    assert.equal(await f.proof({ ...f.rows[0], [field]: value }), false);
  });
}

for (const event of ['exit', 'close', 'error', 'fatal', 'killed', 'stop']) test(`evidence ${event} invalidates a previously proven child`, async t => {
  const f = fixture(t); await tick(); assert.equal(await f.proof(), true); const child = f.children[0];
  let stopping;
  if (event === 'fatal') child.stdout.write('SERVER FATAL\n');
  else if (event === 'killed') child.killed = true;
  else if (event === 'stop') stopping = f.handle.stopFully({ gracefulTimeoutMs: 100, killTimeoutMs: 100 });
  else child.emit(event, ...(event === 'error' ? [new Error('fixture process error')] : [0, null]));
  assert.equal(await f.proof(), false);
  if (stopping) { child.emit('close', 0, null); await stopping; }
});

test('evidence repeated operation PID reuse and late old close cannot remove new incarnation', async t => {
  const f = fixture(t); await tick(); const oldRow = { ...f.rows[0] };
  f.children[0].emit('exit', 0, null); f.launch(); await tick();
  assert.notEqual(f.rows[1].commandLine, oldRow.commandLine);
  assert.equal(await f.proof(oldRow), false); assert.equal(await f.proof(), true);
  f.children[0].emit('close', 0, null); assert.equal(await f.proof(), true);
});

test('evidence new runner and external copied marker receive no authority', async t => {
  const f = fixture(t); await tick();
  const fresh = createServerProcessRunner();
  assert.equal(await fresh.isCurrentUnrelatedServer({ process: f.rows[0], clientPath: f.clientPath }), false);
  assert.equal(await f.proof({ ...f.rows[0], pid: 4999 }), false);
});

test('evidence legacy factory does not enable system capture', async t => {
  const f = fixture(t, { legacy: true }); await tick();
  assert.equal(await f.proof(), false); assert.equal(f.handle.isLive(), true); assert.equal(f.inspectCalls(), 0);
});

for (const kind of ['equal', 'ancestor', 'descendant', 'changed', 'aliased', 'missing', 'prefix-sibling']) {
  test(`evidence root ${kind} requires positive segment-disjoint stable authority`, async t => {
    const f = fixture(t); await tick(); let target = f.clientPath;
    if (kind === 'equal') target = f.serverPath;
    if (kind === 'ancestor') target = f.root;
    if (kind === 'descendant') target = path.join(f.serverPath, 'client');
    if (kind === 'changed') f.changeRoot();
    if (kind === 'aliased') f.aliasRoot();
    if (kind === 'missing') f.failRoot();
    if (kind === 'prefix-sibling') target = f.serverPath + '-client';
    assert.equal(await f.proof(undefined, target), kind === 'prefix-sibling');
  });
}

test('evidence root recheck cannot race an exact child exit or mutable plan substitution', async t => {
  const f = fixture(t); await tick();
  f.plan.cwd = f.clientPath; f.plan.args.push('--gameDir', f.clientPath);
  assert.equal(await f.proof(), true); // Public mutable metadata cannot rewrite original authority.
  f.duringCapture(() => f.children[0].emit('exit', 0, null)); assert.equal(await f.proof(), false);
});

test('evidence indirect external client still blocks with a healthy app-owned server', async t => {
  const f = fixture(t); await tick();
  f.rows.push({ ...f.rows[0], pid: 4999, commandLine: 'java org.prismlauncher.EntryPoint' });
  await assert.rejects(f.guard().withMutation(f.client, () => assert.fail('external client admitted')), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(f.guard().beginLaunch(f.client), { code: 'RECOVERY_REQUIRED' });
});

for (const [name, change] of [
  ['wrong parent', row => ({ ...row, parentPid: 123 })],
  ['wrong executable', row => ({ ...row, executablePath: 'C:\\different\\java.exe' })],
  ['missing creation', row => ({ ...row, creationTime: null })],
  ['missing nonce', row => ({ ...row, commandLine: 'java @args.txt nogui' })],
  ['duplicate nonce', row => ({ ...row, commandLine: row.commandLine + ' -Dminecraft.core.server.launch=b09956c1-1daa-4fb9-a8fe-000000000001' })]
]) test(`evidence initial ${name} cannot mint server authority`, async t => {
  const f = fixture(t, { initialRowChange: change }); await tick();
  assert.equal(await f.proof(), false); assert.equal(f.handle.isLive(), true);
});

test('evidence unavailable initial root does not change healthy server supervision', async t => {
  const f = fixture(t, { captureUnavailable: true }); await tick(); await f.handle.supervisionReady;
  assert.equal(await f.proof(), false); assert.equal(f.inspectCalls(), 0); assert.equal(f.handle.isLive(), true);
});

test('evidence default synchronous root capture detects replacement without a system probe', async t => {
  const f = fixture(t, { nativeRoot: true }); await tick(); assert.equal(await f.proof(), true);
  fs.renameSync(f.serverPath, path.join(f.root, 'previous-server')); fs.mkdirSync(f.serverPath);
  assert.equal(await f.proof(), false); assert.equal(f.inspectCalls(), 1);
});

test('evidence direct stdin stop stays exact live server only until actual exit', async t => {
  const f = fixture(t); await tick(); f.children[0].stdin.write('stop\n');
  assert.equal(await f.proof(), true); assert.equal(f.handle.isLive(), true);
  f.children[0].emit('exit', 0, null); assert.equal(await f.proof(), false);
});

test('evidence conflicting live handles at one PID do not receive an exemption', async t => {
  const f = fixture(t); await tick(); const old = { ...f.rows[0] }; f.launch(); await tick();
  assert.equal(await f.proof(old), false); assert.equal(await f.proof(), false);
});
