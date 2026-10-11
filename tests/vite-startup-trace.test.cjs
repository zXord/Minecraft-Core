const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createStartupTrace } = require('../electron/utils/startup-trace.cjs');

const prefix = '[Minecraft Core startup trace] ';
function plugin(options) {
  return require('../scripts/vite-startup-trace.cjs').createViteStartupTracePlugin(options);
}

test('Vite startup attribution is opt-in only and disabled mode reads no diagnostic dependencies', () => {
  for (const value of [undefined, '0', 'true', 1, true, ' 1', '1 ']) {
    const reads = [];
    assert.equal(plugin({ env: { MINECRAFT_CORE_STARTUP_TRACE: value },
      get markStartupTrace() { reads.push('trace'); throw new Error('must remain disabled'); } }), null);
    assert.deepEqual(reads, []);
  }
});

test('Vite startup attribution emits three fixed serve-only markers with one bounded listening registration', () => {
  const lines = [];
  const markStartupTrace = createStartupTrace({ env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, now: () => 0,
    utcNow: () => '2026-10-11T00:00:00.000Z', pid: 456, sink: line => { lines.push(line); } });
  const trace = plugin({ env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, markStartupTrace });
  assert.ok(trace, 'exact opt-in must create the diagnostic plugin');
  assert.equal(trace.apply, 'serve');
  const httpServer = new EventEmitter();
  trace.configResolved({ get privateConfig() { assert.fail('no config inventory'); } });
  trace.configureServer({ httpServer, get privateServer() { assert.fail('no server inventory'); } });
  trace.configureServer({ httpServer });
  assert.equal(httpServer.listenerCount('listening'), 1);
  assert.equal(httpServer.listenerCount('close'), 0);
  httpServer.emit('listening');
  httpServer.emit('listening');
  assert.equal(httpServer.listenerCount('listening'), 0);
  trace.configResolved({});
  assert.deepEqual(lines.map(line => JSON.parse(line.slice(prefix.length)).marker),
    ['vite:config-resolved', 'vite:configure-server', 'vite:http-listening']);
  for (const line of lines) assert.deepEqual(Object.keys(JSON.parse(line.slice(prefix.length))), ['marker', 'pid', 'utc', 'elapsedMs']);
  assert.doesNotMatch(lines.join(''), /private|root|plugin|httpServer/);
});

test('Vite startup attribution tolerates middleware-mode null HTTP server without registration', () => {
  const lines = [];
  const markStartupTrace = createStartupTrace({ env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, now: () => 0,
    utcNow: () => '2026-10-11T00:00:00.000Z', pid: 456, sink: line => { lines.push(line); } });
  const trace = plugin({ env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, markStartupTrace });
  assert.ok(trace, 'exact opt-in must create the diagnostic plugin');
  trace.configResolved({});
  assert.doesNotThrow(() => trace.configureServer({ httpServer: null }));
  assert.deepEqual(lines.map(line => JSON.parse(line.slice(prefix.length)).marker), ['vite:config-resolved', 'vite:configure-server']);
});

test('Vite startup attribution contains failed sink attempts and still releases its one-shot listener', () => {
  let attempts = 0;
  const markStartupTrace = createStartupTrace({ env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, now: () => 0,
    utcNow: () => '2026-10-11T00:00:00.000Z', pid: 456,
    sink() { attempts += 1; throw new Error('SECRET_SINK'); } });
  const trace = plugin({ env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, markStartupTrace });
  assert.ok(trace, 'exact opt-in must create the diagnostic plugin');
  const httpServer = new EventEmitter();
  assert.doesNotThrow(() => { trace.configResolved({}); trace.configureServer({ httpServer }); httpServer.emit('listening'); });
  assert.equal(attempts, 3);
  assert.equal(httpServer.listenerCount('listening'), 0);
});

// Exercise Vite's default bundled-config loader in fresh ESM processes: native
// CJS unit imports or injected sinks would hide a bundled dynamic-require bug.
function loadBundledConfig(traceFlag) {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  delete env.MINECRAFT_CORE_STARTUP_TRACE;
  if (traceFlag !== undefined) env.MINECRAFT_CORE_STARTUP_TRACE = traceFlag;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadConfigFromFile } from 'vite';
    import { EventEmitter } from 'node:events';
    const startedAt = Date.now();
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'development' }, './vite.config.js'
    );
    if (!loaded) throw new Error('Real Vite config did not load');
    const traces = loaded.config.plugins.flat(Infinity).filter(
      entry => entry && entry.name === 'minecraft-core-startup-trace'
    );
    const httpServer = new EventEmitter();
    const trace = traces[0];
    if (trace) {
      trace.configResolved({});
      trace.configResolved({});
      trace.configureServer({ httpServer });
      trace.configureServer({ httpServer });
    }
    const listenersBefore = httpServer.listenerCount('listening');
    httpServer.emit('listening');
    httpServer.emit('listening');
    if (trace) {
      trace.configResolved({});
      trace.configureServer({ httpServer });
    }
    console.log(JSON.stringify({
      requireType: typeof require, pluginCount: traces.length, apply: trace?.apply,
      pid: process.pid, startedAt, finishedAt: Date.now(), listenersBefore,
      listenersAfter: httpServer.listenerCount('listening'),
      closeListeners: httpServer.listenerCount('close')
    }));
  `], {
    cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.requireType, 'undefined', 'the regression must run in real ESM without global require');
  return { result, stderr: child.stderr };
}

test('default bundled ESM Vite config emits real stderr trace records once', () => {
  const { result, stderr } = loadBundledConfig('1');
  assert.equal(result.pluginCount, 1);
  assert.equal(result.apply, 'serve');
  assert.equal(result.listenersBefore, 1);
  assert.equal(result.listenersAfter, 0);
  assert.equal(result.closeListeners, 0);
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 3, 'the real default sink must emit all three Vite markers');
  const records = lines.map(line => {
    assert.ok(line.startsWith(prefix), 'stderr must contain only trace records');
    return JSON.parse(line.slice(prefix.length));
  });
  assert.deepEqual(records.map(record => record.marker), [
    'vite:config-resolved', 'vite:configure-server', 'vite:http-listening'
  ]);
  for (const record of records) {
    assert.deepEqual(Object.keys(record), ['marker', 'pid', 'utc', 'elapsedMs']);
    assert.equal(record.pid, result.pid);
    assert.match(record.utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(record.utc).toISOString(), record.utc);
    assert.ok(Date.parse(record.utc) >= result.startedAt && Date.parse(record.utc) <= result.finishedAt);
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs <= 30000);
  }
  assert.ok(records[0].elapsedMs <= records[1].elapsedMs && records[1].elapsedMs <= records[2].elapsedMs);
});

test('default bundled ESM Vite config stays silent without exact trace opt-in in fresh processes', () => {
  for (const flag of [undefined, 'true']) {
    const { result, stderr } = loadBundledConfig(flag);
    assert.equal(result.pluginCount, 0);
    assert.equal(result.listenersBefore, 0);
    assert.equal(result.listenersAfter, 0);
    assert.equal(result.closeListeners, 0);
    assert.equal(stderr, '');
  }
});
