const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const tracePath = path.resolve(__dirname, '../electron/utils/startup-trace.cjs');
const prefix = '[Minecraft Core startup trace] ';
const markers = [
  'launcher:entry', 'launcher:runtime-prepare:start', 'launcher:runtime-prepare:complete',
  'launcher:runtime-lease:start', 'launcher:runtime-lease:complete', 'launcher:spawn-returned',
  'early:entry', 'early:imports:complete', 'early:when-ready:start', 'early:when-ready:complete',
  'early:icon:start', 'early:icon:complete', 'early:shortcut-attempt:start', 'early:shortcut-attempt:complete',
  'early:window:create:start', 'early:window:create:complete', 'early:document:start', 'early:document:complete',
  'early:main-load:start', 'early:main-load:complete', 'early:failed',
  'main:entry',
  'main:import:path:complete', 'main:import:electron:complete', 'main:import:fs:complete',
  'main:import:runtime-flags:complete', 'main:import:packaged-smoke-guard:complete',
  'main:import:main-bootstrap:complete', 'main:import:modpack-service-graph:complete',
  'main:import:test-modpack-factory:complete', 'main:import:app-cleanup:complete',
  'main:import:safe-send:complete', 'main:import:app-store:complete', 'main:import:navigation-policy:complete',
  'main:import:runtime-paths:complete', 'main:import:tls-utils:complete', 'main:import:runtime-mode:complete',
  'main:import:renderer-loader:complete', 'main:import:asset-resolver:complete',
  'main:import:orderly-quit-barrier:complete', 'main:import:startup-window:complete',
  'main:import:startup-entry:complete', 'main:import:update-service:complete',
  'main:import:server-mutation-context:complete', 'main:import:dev-config:complete',
  'main:imports:complete', 'main:graph:start', 'main:graph:complete',
  'main:before-ready:start', 'main:before-ready:complete', 'main:ipc:start',
  'main:ipc:listeners:complete', 'main:ipc:handler-module:complete', 'main:ipc:complete',
  'update-service:get:start', 'update-service:get:complete', 'recovery:start', 'recovery:complete',
  'recovery:factory:start', 'recovery:factory:complete',
  'recovery:release-tracking-init:start', 'recovery:release-tracking-init:complete',
  'recovery:runtime-verify:start', 'recovery:runtime-verify:complete',
  'recovery:registry-init:start', 'recovery:registry-init:complete',
  'composition:factory:start', 'composition:factory:complete',
  'composition:initialize:start', 'composition:initialize:complete',
  'composition:operation-store-init:start', 'composition:operation-store-init:complete',
  'composition:notification-store-init:start', 'composition:notification-store-init:complete',
  'composition:release-tracking-init:start', 'composition:release-tracking-init:complete',
  'composition:client-packs-init:start', 'composition:client-packs-init:complete',
  'client-packs:companion-store-init:start', 'client-packs:companion-store-init:complete',
  'client-packs:registered-cleanup:start', 'client-packs:registered-cleanup:complete',
  'composition:recovery-history-reconcile:start', 'composition:recovery-history-reconcile:complete',
  'vite:config-resolved', 'vite:configure-server', 'vite:http-listening',
  'server-config:start', 'server-config:complete', 'cleanup:start', 'cleanup:complete',
  'main-window:create:start', 'main-window:create:complete',
  'main-window:browser-window:create:start', 'main-window:browser-window:create:complete',
  'main-window:ready-to-show', 'main-window:navigation:start', 'main-window:navigation:complete',
  'main-window:navigation:failed', 'startup-window:close', 'app:when-ready', 'startup-window:create:complete'
];

function fixture(overrides = {}) {
  const { createStartupTrace } = require(tracePath);
  const lines = [];
  let time = 100;
  const mark = createStartupTrace({
    env: { MINECRAFT_CORE_STARTUP_TRACE: '1', PRIVATE: 'SECRET_ENV' },
    now: () => time,
    utcNow: () => '2026-10-09T00:00:00.000Z', pid: 123,
    sink: line => { lines.push(line); }, ...overrides
  });
  return { mark, lines, advance: value => { time = value; } };
}

test('trace is silent without exact string opt-in and never reads clocks or sink while disabled', () => {
  const { createStartupTrace } = require(tracePath);
  for (const value of [undefined, '0', 'true', true, 1, ' 1', '1 ']) {
    const reads = [];
    const mark = createStartupTrace({
      env: { MINECRAFT_CORE_STARTUP_TRACE: value },
      get now() { reads.push('clock'); return () => 100; },
      get utcNow() { reads.push('wall'); return () => '2026-10-09T00:00:00.000Z'; },
      get pid() { reads.push('pid'); return 123; },
      get sink() { reads.push('sink'); return () => {}; }
    });
    assert.equal(mark('main:entry'), false);
    assert.deepEqual(reads, []);
  }
});

test('trace captures one initial baseline and emits only the bounded four-field schema', () => {
  const { mark, lines, advance } = fixture();
  advance(112.5);
  assert.equal(mark('main:entry', { private: 'SECRET_DETAILS' }), true);
  advance(130);
  assert.equal(mark('main:imports:complete'), true);
  assert.deepEqual(lines, [
    prefix + '{"marker":"main:entry","pid":123,"utc":"2026-10-09T00:00:00.000Z","elapsedMs":12.5}\n',
    prefix + '{"marker":"main:imports:complete","pid":123,"utc":"2026-10-09T00:00:00.000Z","elapsedMs":30}\n'
  ]);
  assert.doesNotMatch(lines.join(''), /SECRET|PRIVATE/);
});

test('trace admits all 102 startup markers once and rejects unknown inputs without coercion', () => {
  const { mark, lines } = fixture();
  let coercions = 0;
  const privateMarker = { toString() { coercions += 1; return 'SECRET_PATH'; } };
  for (const unknown of [privateMarker, null, undefined, 42, 'SECRET_PATH', 'main:entry\nSECRET',
    'main:import:SECRET_PATH:complete', 'main:ipc:SECRET_HANDLER:complete',
    'recovery:SECRET_PATH:start', 'composition:SECRET_STORE:complete', 'vite:SECRET_PLUGIN']) {
    assert.equal(mark(unknown), false);
  }
  for (const marker of markers) assert.equal(mark(marker), true, marker);
  for (const marker of markers) assert.equal(mark(marker), false, marker);
  assert.equal(lines.length, 102);
  assert.equal(coercions, 0);
  assert.deepEqual(lines.map(line => JSON.parse(line.slice(prefix.length)).marker), markers);
  for (const line of lines) {
    assert.deepEqual(Object.keys(JSON.parse(line.slice(prefix.length))), ['marker', 'pid', 'utc', 'elapsedMs']);
  }
  assert.doesNotMatch(lines.join(''), /SECRET/);
});

test('trace guards environment and initialization failures without throwing', () => {
  const { createStartupTrace } = require(tracePath);
  for (const options of [null,
    { get env() { throw new Error('SECRET_ENV'); } },
    { env: new Proxy({}, { get() { throw new Error('SECRET_ENV'); } }) },
    { env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, get now() { throw new Error('SECRET_CLOCK'); } },
    { env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, now() { throw new Error('SECRET_BASELINE'); } },
    { env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, now: () => NaN },
    { env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, get sink() { throw new Error('SECRET_SINK_INIT'); } },
    { env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, get utcNow() { throw new Error('SECRET_WALL_INIT'); } },
    { env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, get pid() { throw new Error('SECRET_PID_INIT'); } },
    { env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, sink: null }
  ]) {
    let mark;
    assert.doesNotThrow(() => { mark = createStartupTrace(options); });
    assert.equal(mark('main:entry'), false);
  }
});

test('trace drops invalid PID UTC and monotonic values instead of serializing private data', () => {
  let coercions = 0;
  const privateValue = { toString() { coercions += 1; return 'SECRET_VALUE'; }, toJSON() { coercions += 1; return 'SECRET_JSON'; } };
  for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123', privateValue]) {
    const { mark, lines } = fixture({ pid });
    assert.equal(mark('main:entry'), false);
    assert.deepEqual(lines, []);
  }
  assert.equal(coercions, 0);
  for (const utc of [privateValue, 'SECRET_UTC', '2026-02-30T00:00:00.000Z', '2026-10-09T00:00:00Z', '2026-10-09T00:00:00.000+00:00']) {
    const { mark, lines } = fixture({ utcNow: () => utc });
    assert.equal(mark('main:entry'), false);
    assert.deepEqual(lines, []);
  }
  for (const time of [NaN, Infinity, -1, 99, privateValue]) {
    const { mark, lines, advance } = fixture();
    advance(time);
    assert.equal(mark('main:entry'), false);
    assert.deepEqual(lines, []);
  }
});

test('trace isolates failed clock and sink attempts and still deduplicates attempted markers', async () => {
  let reads = 0;
  const clock = fixture({ now() { reads += 1; if (reads > 1) throw new Error('SECRET_CLOCK'); return 100; } });
  assert.equal(clock.mark('main:entry'), false);
  assert.equal(clock.mark('main:entry'), false);
  assert.equal(reads, 2);
  assert.deepEqual(clock.lines, []);
  const wallClock = fixture({ utcNow() { throw new Error('SECRET_WALL'); } });
  assert.equal(wallClock.mark('main:entry'), false);
  assert.deepEqual(wallClock.lines, []);
  let writes = 0;
  const sink = fixture({ sink() { writes += 1; throw new Error('SECRET_SINK'); } });
  assert.equal(sink.mark('main:entry'), false);
  assert.equal(sink.mark('main:entry'), false);
  assert.equal(writes, 1);
  const asyncSink = fixture({ sink: async () => { throw new Error('SECRET_ASYNC'); } });
  assert.equal(asyncSink.mark('main:entry'), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(asyncSink.lines, []);
});

test('default trace singleton takes its baseline before sink import and uses only guarded fd2 writes', () => {
  const source = fs.readFileSync(tracePath, 'utf8');
  const calls = [];
  let time = 100000000n;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    process: { env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, pid: 123, hrtime: { bigint() { calls.push('clock'); return time; } } },
    require(request) {
      assert.equal(request, 'node:fs');
      calls.push('sink:import');
      return { writeSync(fd, line) { assert.equal(fd, 2); calls.push(line); throw new Error('SECRET_FD2'); } };
    }
  });
  assert.equal(calls[0], 'clock');
  time = 125000000n;
  assert.equal(module.exports.markStartupTrace('main:entry'), false);
  assert.equal(module.exports.markStartupTrace('main:entry'), false);
  const line = calls.find(value => value.startsWith(prefix));
  assert.equal(JSON.parse(line.slice(prefix.length)).elapsedMs, 25);
  assert.equal(calls.filter(value => value.startsWith(prefix)).length, 1);
  const disabledModule = { exports: {} };
  const disabledReads = [];
  vm.runInNewContext(source, {
    module: disabledModule, exports: disabledModule.exports,
    process: { env: {}, get hrtime() { disabledReads.push('clock'); return { bigint: () => 100000000n }; }, get pid() { disabledReads.push('pid'); return 123; } },
    require() { disabledReads.push('sink'); return { writeSync() { disabledReads.push('write'); } }; },
    Date: function() { disabledReads.push('wall'); return { toISOString: () => '2026-10-09T00:00:00.000Z' }; },
    JSON: { stringify() { disabledReads.push('serialize'); return ''; } }
  });
  assert.equal(disabledModule.exports.markStartupTrace('main:entry'), false);
  assert.deepEqual(disabledReads, []);
});

test('default trace initialization clock and serialization failures stay contained', () => {
  const source = fs.readFileSync(tracePath, 'utf8');
  for (const initializationFailure of [true, false]) {
    const module = { exports: {} };
    let writes = 0;
    vm.runInNewContext(source, {
      module, exports: module.exports,
      process: {
        env: { MINECRAFT_CORE_STARTUP_TRACE: '1' }, pid: 123,
        hrtime: { bigint() { if (initializationFailure) throw new Error('PRIVATE_BASELINE'); return 100000000n; } }
      },
      JSON: { stringify() { throw new Error('PRIVATE_SERIALIZATION'); } },
      require() { writes += 1; return { writeSync() { writes += 1; } }; }
    });
    assert.equal(module.exports.markStartupTrace('main:entry'), false);
    assert.equal(writes, 0);
  }
});
