const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { acquireProcessBoundLocalEndpointLease } = require('../../electron/utils/process-bound-local-endpoint-lease.cjs');
const { ClientProcessGuard } = require('../../electron/services/client-modpacks/client-process-guard.cjs');
const { createClientProcessInspector } = require('../../electron/services/client-modpacks/client-process-inspector.cjs');

const owner = { pid: process.pid, parentPid: process.ppid, creationTime: '2026-10-08T10:00:00Z', executablePath: process.execPath, commandLine: 'node guard-test' };
const launchId = 'b09956c1-1daa-4fb9-a8fe-bf6d401c04bc';
const blocked = error => error.code === 'CLIENT_RUNNING' || error.code === 'RECOVERY_REQUIRED';

for (const recordState of ['missing', 'settled']) {
  for (const [name, command] of [
    ['all arguments file', () => 'javaw.exe @C:\\launch\\client-args.txt'],
    ['quoted arguments file', () => 'javaw.exe "@C:\\launch with spaces\\client-args.txt"'],
    ['Prism wrapper', () => 'javaw.exe org.prismlauncher.EntryPoint'],
    ['MultiMC wrapper', () => 'javaw.exe org.multimc.EntryPoint'],
    ['hidden root plus visible unrelated root', other => `javaw.exe @hidden.txt --gameDir "${other}"`],
    ['wrapper plus visible unrelated root', other => `javaw.exe org.prismlauncher.EntryPoint --gameDir "${other}"`]
  ]) test(`indirect ${recordState} ${name} refuses mutation and launch`, async t => {
    const f = fixture(t);
    if (recordState === 'settled') await (await f.makeGuard().beginLaunch(f.client)).abortBeforeSpawn();
    const other = path.join(f.root, 'unrelated'); fs.mkdirSync(other);
    f.setSnapshot({ complete: true, processes: [owner, { ...owner, pid: 9984, name: 'javaw.exe', commandLine: command(other) }] });
    const guard = f.makeGuard(); let entered = false;
    assert.equal(await guard.status(f.client), 'uncertain');
    await assert.rejects(guard.withMutation(f.client, () => { entered = true; }), { code: 'RECOVERY_REQUIRED' });
    await assert.rejects(guard.beginLaunch(f.client), { code: 'RECOVERY_REQUIRED' });
    assert.equal(entered, false);
  });
}

test('indirect server proof cannot override same-root conflicting roots or client markers', async t => {
  const f = fixture(t); const guard = f.makeGuard({ isCurrentUnrelatedServer: () => true });
  for (const commandLine of [`java @args --gameDir "${f.client.clientPath}"`,
    `java @args --gameDir "${f.client.clientPath}" --gameDir "${f.root}"`]) {
    f.setSnapshot({ complete: true, processes: [{ ...owner, pid: 9985, name: 'java.exe', commandLine }] });
    await assert.rejects(guard.withMutation(f.client, () => assert.fail('root authority overridden')), blocked);
  }
  f.setSnapshot({ complete: true, processes: [owner] });
  const launch = await guard.beginLaunch(f.client); await f.leases.at(-1).close();
  f.setSnapshot({ complete: true, processes: [{ ...owner, pid: 9986, name: 'java.exe', commandLine: `java @args ${launch.jvmArgument}` }] });
  assert.equal(await f.makeGuard({ isCurrentUnrelatedServer: () => true }).status(f.client), 'running');
});

test('indirect failed provider and copied server-looking marker never prove unrelated', async t => {
  const f = fixture(t);
  f.setSnapshot({ complete: true, processes: [{ ...owner, pid: 9987, name: 'java.exe',
    commandLine: 'java -Dminecraft.core.server.launch=b09956c1-1daa-4fb9-a8fe-bf6d401c04bc @win_args.txt nogui' }] });
  for (const isCurrentUnrelatedServer of [undefined, () => false, () => { throw new Error('unavailable'); }, async () => { throw new Error('unavailable'); }]) {
    assert.equal(await f.makeGuard({ ...(isCurrentUnrelatedServer ? { isCurrentUnrelatedServer } : {}) }).status(f.client), 'uncertain');
  }
});

test('indirect uncertainty gives actionable close-and-retry guidance', async t => {
  const f = fixture(t);
  f.setSnapshot({ complete: true, processes: [{ ...owner, pid: 9988, name: 'javaw.exe', commandLine: 'javaw @unknown.txt' }] });
  await assert.rejects(f.makeGuard().withMutation(f.client, () => assert.fail('unknown client admitted')), error => {
    assert.equal(error.code, 'RECOVERY_REQUIRED'); assert.match(error.message, /close.+retry/iu); return true;
  });
});

test('indirect unreadable identity cannot be overridden by a positive provider', async t => {
  const f = fixture(t);
  f.setSnapshot({ complete: true, processes: [{ ...owner, pid: 9989, name: 'java.exe', commandLine: 'java @args.txt', creationTime: null }] });
  const guard = f.makeGuard({ isCurrentUnrelatedServer: () => true });
  assert.equal(await guard.status(f.client), 'uncertain');
  await assert.rejects(guard.withMutation(f.client, () => assert.fail('incomplete identity admitted')), { code: 'RECOVERY_REQUIRED' });
});

for (const recordState of ['missing', 'settled', 'stale']) {
  for (const form of ['separate', 'equals']) test(`${recordState} record does not admit an unowned same-root game with ${form} gameDir`, async t => {
    const f = fixture(t);
    const spacedPath = path.join(f.root, 'client with spaces'); fs.renameSync(f.client.clientPath, spacedPath); f.client.clientPath = spacedPath;
    if (recordState !== 'missing') {
      const launch = await f.makeGuard().beginLaunch(f.client);
      if (recordState === 'settled') await launch.abortBeforeSpawn();
      else await f.leases[0].close();
    }
    const game = { ...owner, pid: 9981, name: 'javaw.exe', executablePath: 'C:\\Java\\javaw.exe',
      commandLine: `java net.minecraft.client.main.Main --gameDir${form === 'equals' ? '=' : ' '}"${f.client.clientPath}"` };
    f.setSnapshot({ complete: true, processes: [game] });
    assert.equal(await f.makeGuard().status(f.client), 'running');
    await assert.rejects(f.makeGuard().withMutation(f.client, () => assert.fail('unowned game admitted')), { code: 'CLIENT_RUNNING' });
  });
}

for (const recordState of ['missing', 'settled']) test(`${recordState} record fails closed on unreadable relevant Java details but allows a canonical unrelated root`, async t => {
  const f = fixture(t);
  if (recordState === 'settled') await (await f.makeGuard().beginLaunch(f.client)).abortBeforeSpawn();
  const other = path.join(f.root, 'unrelated game'); fs.mkdirSync(other);
  const java = { ...owner, pid: 9982, name: 'java.exe', executablePath: 'C:\\Java\\java.exe' };
  for (const commandLine of [null, 'java net.minecraft.client.main.Main', 'java net.minecraft.client.main.Main --gameDir relative', 'java --gameDir "unterminated',
    `java --gameDir "${f.client.clientPath}" --gameDir "${other}"`, `java --gameDir "${path.join(f.root, 'unreadable-or-missing')}"`]) {
    f.setSnapshot({ complete: true, processes: [{ ...java, commandLine }] });
    assert.equal(await f.makeGuard().status(f.client), 'uncertain');
    await assert.rejects(f.makeGuard().withMutation(f.client, () => assert.fail('uncertain Java admitted')), { code: 'RECOVERY_REQUIRED' });
  }
  f.setSnapshot({ complete: true, processes: [{ ...java, creationTime: null, commandLine: `java --gameDir "${f.client.clientPath}"` }] });
  assert.equal(await f.makeGuard().status(f.client), 'uncertain');
  f.setSnapshot({ complete: true, processes: [{ ...java, commandLine: `java net.minecraft.client.main.Main --gameDir "${other}"` }] });
  assert.equal(await f.makeGuard().withMutation(f.client, () => 'unrelated root allowed'), 'unrelated root allowed');
  f.setSnapshot({ complete: true, processes: [{ ...java, creationTime: null, commandLine: `java --gameDir "${other}"` }] });
  assert.equal(await f.makeGuard().status(f.client), 'stopped'); // Visibility irrelevant to this proven different root.
  f.setSnapshot({ complete: true, processes: [{ ...java, commandLine: 'java -jar unrelated-server.jar' }] });
  assert.equal(await f.makeGuard().status(f.client), 'stopped');
});

test('canonical process root aliases cannot hide an unowned game behind a different path spelling', async t => {
  const f = fixture(t);
  for (const gameDir of [f.client.clientPath + '/', `${f.client.clientPath}${path.sep}..${path.sep}client`,
    ...(process.platform === 'win32' ? [f.client.clientPath.toUpperCase()] : [])]) {
    f.setSnapshot({ complete: true, processes: [{ ...owner, pid: 9983, name: 'javaw.exe', commandLine: `java --gameDir "${gameDir}"` }] });
    assert.equal(await f.makeGuard().status(f.client), 'running', gameDir);
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-client-guard-'));
  const clientPath = path.join(root, 'client');
  fs.mkdirSync(clientPath);
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {}
  } });
  let snapshot = { complete: true, processes: [owner] };
  const leases = [];
  const makeGuard = (overrides = {}) => new ClientProcessGuard({ root, durableFs, randomUUID: () => launchId,
    inspectProcesses: async () => { if (snapshot instanceof Error) throw snapshot; return snapshot; },
    acquireEndpointLease: async request => { const lease = await acquireProcessBoundLocalEndpointLease(request); leases.push(lease); return lease; }, ...overrides
  });
  t.after(async () => { await Promise.all(leases.map(lease => lease.close())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, durableFs, client: { clientId: 'client-a', clientPath }, makeGuard, leases, setSnapshot(value) { snapshot = value; },
    record() { return JSON.parse(fs.readFileSync(path.join(root, fs.readdirSync(root).find(name => name.endsWith('.json'))), 'utf8')); }
  };
}

function childFixture(pid = 8711) {
  const child = new EventEmitter();
  child.pid = pid;
  child.kill = () => { throw new Error('guard must never kill processes'); };
  return child;
}

// Removing the launch lease, or releasing on error/exit/IPC return, permits the forbidden callback.
test('reservation excludes mutation before spawn and retains exact child until close', async t => {
  const f = fixture(t); const guard = f.makeGuard();
  const launch = await guard.beginLaunch(f.client);
  assert.equal(launch.jvmArgument, `-Dminecraft.core.clientLaunchId=${launchId}`);
  assert.equal(f.record().launchId, launchId);
  await assert.rejects(guard.withMutation(f.client, () => assert.fail('mutated before spawn')), blocked);
  const child = childFixture();
  f.setSnapshot({ complete: true, processes: [owner, { ...owner, pid: child.pid, parentPid: process.pid, creationTime: 'child-start', commandLine: `java ${launch.jvmArgument} Main` }] });
  await launch.attach(child);
  assert.equal(f.record().child.pid, 8711);
  await launch.close(); // Caller cleanup/IPC completion must not release a live exact child.
  child.emit('error', new Error('stdio error'));
  child.emit('exit', 0);
  await assert.rejects(guard.withMutation(f.client, () => assert.fail('mutated before close')), blocked);
  child.emit('close', 0);
  await launch.close();
  assert.equal(await guard.withMutation(f.client, () => 'safe'), 'safe');
});

test('pre-spawn abort durably settles intent and releases reservation', async t => {
  const f = fixture(t); const guard = f.makeGuard();
  const launch = await guard.beginLaunch(f.client);
  await launch.abortBeforeSpawn();
  assert.equal(f.record().phase, 'settled');
  assert.equal(await guard.status(f.client), 'stopped');
  assert.equal(await guard.withMutation(f.client, () => 'safe'), 'safe');
});

test('another guard and client ID cannot mutate the same path while owner prepares', async t => {
  const f = fixture(t); const guard = f.makeGuard(); const launch = await guard.beginLaunch(f.client);
  await assert.rejects(f.makeGuard().withMutation({ ...f.client, clientId: 'alias' }, () => assert.fail('path alias bypass')), blocked);
  await f.leases[0].close(); // Model process death releasing only the OS endpoint; durable intent remains.
  assert.equal(await f.makeGuard().status(f.client), 'uncertain');
});

test('restart after spawn-before-PID-publication remains blocked by real marked child', async t => {
  const f = fixture(t); const launch = await f.makeGuard().beginLaunch(f.client);
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)', '--', launch.jvmArgument], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  await once(child.stdout, 'data');
  await f.leases[0].close();
  f.setSnapshot({ complete: true, processes: [{ ...owner, pid: child.pid, parentPid: process.pid, creationTime: 'fixture-child', commandLine: `node fixture ${launch.jvmArgument}` }] });
  assert.equal(f.record().child, null);
  assert.equal(await f.makeGuard().status(f.client), 'running');
  await assert.rejects(f.makeGuard().withMutation(f.client, () => assert.fail('orphan mutation')), blocked);
});

test('PID reuse with different exact identity is not adopted or killed', async t => {
  const f = fixture(t); const launch = await f.makeGuard().beginLaunch(f.client); const child = childFixture();
  f.setSnapshot({ complete: true, processes: [owner, { ...owner, pid: child.pid, creationTime: 'original', commandLine: `java ${launch.jvmArgument}` }] });
  await launch.attach(child); await f.leases[0].close();
  f.setSnapshot({ complete: true, processes: [{ ...owner, pid: child.pid, creationTime: 'reused', commandLine: 'unrelated process' }] });
  assert.equal(await f.makeGuard().status(f.client), 'stopped');
  assert.equal(await f.makeGuard().withMutation(f.client, () => 'safe'), 'safe');
});

for (const [name, value] of [
  ['denied', new Error('access denied')], ['partial', { complete: false, processes: [] }],
  ['malformed', { complete: true, processes: [{}] }],
  ['missing command visibility', { complete: true, processes: [{ ...owner, pid: 8881, name: 'javaw.exe', commandLine: null }] }]
]) test(`restart ${name} process inspection never proves stopped`, async t => {
  const f = fixture(t); await f.makeGuard().beginLaunch(f.client); await f.leases[0].close(); f.setSnapshot(value);
  assert.equal(await f.makeGuard().status(f.client), 'uncertain');
  await assert.rejects(f.makeGuard().withMutation(f.client, () => assert.fail('uncertain mutation')), blocked);
});

test('restart recovery requires both preparing owner and marker to be proven absent', async t => {
  const f = fixture(t); await f.makeGuard().beginLaunch(f.client); await f.leases[0].close();
  assert.equal(await f.makeGuard().status(f.client), 'uncertain');
  f.setSnapshot({ complete: true, processes: [] });
  assert.equal(await f.makeGuard().status(f.client), 'stopped');
  assert.equal(await f.makeGuard().withMutation(f.client, () => 'recovered'), 'recovered');
});

test('mutation reservation excludes simultaneous launch and releases after callback failure', async t => {
  const f = fixture(t); const guard = f.makeGuard(); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = guard.withMutation(f.client, async () => { entered(); await new Promise(resolve => { release = resolve; }); throw new Error('mutation failed'); });
  await started;
  await assert.rejects(guard.beginLaunch(f.client), blocked);
  release(); await assert.rejects(pending, /mutation failed/);
  const launch = await guard.beginLaunch(f.client); await launch.abortBeforeSpawn();
});

test('unreadable protected non-Java processes do not prevent exact owner and marker absence proof', async t => {
  const f = fixture(t); await f.makeGuard().beginLaunch(f.client); await f.leases[0].close();
  f.setSnapshot({ complete: true, processes: [{ pid: 640, parentPid: 4, name: 'services.exe', creationTime: null, executablePath: null, commandLine: null }] });
  assert.equal(await f.makeGuard().status(f.client), 'stopped');
});

test('unreadable potential Java process cannot be excluded by an empty command line', async t => {
  const f = fixture(t); await f.makeGuard().beginLaunch(f.client); await f.leases[0].close();
  f.setSnapshot({ complete: true, processes: [{ pid: 8744, parentPid: 88, name: 'javaw.exe', creationTime: 'java-start', executablePath: null, commandLine: null }] });
  assert.equal(await f.makeGuard().status(f.client), 'uncertain');
});

test('unreadable prior owner cannot be treated as PID reuse or absence', async t => {
  const f = fixture(t); await f.makeGuard().beginLaunch(f.client); await f.leases[0].close();
  f.setSnapshot({ complete: true, processes: [{ pid: process.pid, parentPid: process.ppid, name: 'electron.exe', creationTime: null, executablePath: null, commandLine: null }] });
  assert.equal(await f.makeGuard().status(f.client), 'uncertain');
});

test('inspector emits read-only fixed code with bounded query and validates returned visibility', async () => {
  const inspect = createClientProcessInspector({ platform: 'win32', resolveRuntime: () => ({ executable: 'C:\\Windows\\powershell.exe', modulePath: 'C:\\Windows\\Modules', cimModule: 'C:\\Windows\\CimCmdlets.psd1', systemRoot: 'C:\\Windows' }),
    execFileFn(executable, args, options, callback) {
      assert.equal(executable, 'C:\\Windows\\powershell.exe');
      assert.equal(options.windowsHide, true); assert.equal(options.timeout, 10000); assert.equal(options.maxBuffer, 16 * 1024 * 1024);
      assert.equal(args.includes('-NonInteractive'), true);
      const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.equal(/Kill\(|Stop-Process|Invoke-Expression/u.test(source), false);
      callback(null, JSON.stringify({ complete: true, processes: [owner, { pid: 640, parentPid: 4, name: 'services.exe', creationTime: null, executablePath: null, commandLine: null }] }));
    }
  });
  const snapshot = await inspect();
  assert.equal(snapshot.complete, true); assert.equal(snapshot.processes.length, 2);
  assert.equal(snapshot.processes[1].name, 'services.exe');
});

test('durable process identities hash command lines without persisting synthetic authentication secrets', async t => {
  const f = fixture(t); const launch = await f.makeGuard().beginLaunch(f.client); const child = childFixture();
  const childIdentity = { ...owner, pid: child.pid, creationTime: 'credential-fixture-start', commandLine: `java ${launch.jvmArgument} fixture.Main --accessToken SYNTHETIC_NEVER_PERSIST_SENTINEL` };
  f.setSnapshot({ complete: true, processes: [owner, childIdentity] });
  await launch.attach(child);
  const serialized = JSON.stringify(f.record());
  assert.equal(serialized.includes('SYNTHETIC_NEVER_PERSIST_SENTINEL'), false);
  assert.equal(serialized.includes('--accessToken'), false);
  assert.equal(Object.hasOwn(f.record().child, 'commandLine'), false);
  assert.match(f.record().child.commandLineSha256, /^[a-f0-9]{64}$/);
  await f.leases[0].close();
  f.setSnapshot({ complete: true, processes: [childIdentity] });
  assert.equal(await f.makeGuard().status(f.client), 'running');
  f.setSnapshot({ complete: true, processes: [] });
  assert.equal(await f.makeGuard().status(f.client), 'stopped');
});

test('missing live leaf keeps the original launch key and permits only proven-stopped recovery', async t => {
  const f = fixture(t); await f.makeGuard().beginLaunch(f.client);
  const originalKey = f.record().key;
  const previousPath = path.join(f.root, 'owned-previous');
  fs.renameSync(f.client.clientPath, previousPath);
  await f.leases[0].close(); // Simulated owner crash in live -> previous publication gap.
  const restarted = f.makeGuard();
  assert.equal(await restarted.status(f.client), 'uncertain');
  await assert.rejects(restarted.withMutation(f.client, () => assert.fail('preparing owner bypassed for missing leaf')), blocked);
  await assert.rejects(restarted.beginLaunch(f.client));
  f.setSnapshot({ complete: true, processes: [] });
  assert.equal(await restarted.status(f.client), 'stopped');
  assert.equal(await restarted.withMutation(f.client, () => { fs.renameSync(previousPath, f.client.clientPath); return 'recovered'; }), 'recovered');
  assert.equal(f.record().key, originalKey);
  assert.equal(fs.existsSync(f.client.clientPath), true);
});

test('missing leaf recovery cannot bypass a live endpoint reservation', async t => {
  const f = fixture(t); await f.makeGuard().beginLaunch(f.client);
  fs.renameSync(f.client.clientPath, path.join(f.root, 'owned-previous'));
  await assert.rejects(f.makeGuard().withMutation(f.client, () => assert.fail('missing leaf bypassed endpoint')), blocked);
});

test('malformed durable intent never becomes stopped merely because processes are absent', async t => {
  const f = fixture(t); await f.makeGuard().beginLaunch(f.client); await f.leases[0].close();
  const record = { ...f.record(), phase: 'running', child: null };
  fs.writeFileSync(path.join(f.root, fs.readdirSync(f.root).find(name => name.endsWith('.json'))), JSON.stringify(record));
  f.setSnapshot({ complete: true, processes: [] });
  assert.equal(await f.makeGuard().status(f.client), 'uncertain');
});

test('failed child identity persistence cannot poison later exact-close settlement', async t => {
  const f = fixture(t);
  const guard = f.makeGuard({ durableFs: { ...f.durableFs, async writeJsonAtomicAsync(file, record) {
    if (record.phase === 'running') throw new Error('fixture identity persistence failed');
    return f.durableFs.writeJsonAtomicAsync(file, record);
  } } });
  const launch = await guard.beginLaunch(f.client); const child = childFixture();
  f.setSnapshot({ complete: true, processes: [owner, { ...owner, pid: child.pid, creationTime: 'fixture-child', commandLine: `java ${launch.jvmArgument}` }] });
  await assert.rejects(launch.attach(child), /fixture identity persistence failed/);
  await assert.rejects(guard.withMutation(f.client, () => assert.fail('failed persistence released live child')), blocked);
  child.emit('close', 0);
  await launch.close();
  assert.equal(f.record().phase, 'settled');
  assert.equal(await guard.withMutation(f.client, () => 'safe'), 'safe');
});
