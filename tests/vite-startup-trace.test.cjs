const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
