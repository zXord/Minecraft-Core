const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

// Exercise the real class in an isolated module context: timers are deterministic,
// and Electron/updater/storage/logging boundaries cannot touch a user profile.
function createHarness({ isPackaged = true } = {}) {
  const filename = path.resolve(__dirname, '../electron/services/update-service.cjs');
  const realRequire = createRequire(filename);
  const timers = new Map();
  let nextId = 1;
  let now = 0;
  const calls = [];
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = async () => { calls.push(now); };
  const schedule = (callback, delay, recurring) => {
    const id = nextId++;
    timers.set(id, { callback, at: now + delay, delay, recurring });
    return id;
  };
  const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, __dirname: path.dirname(filename),
    process: { env: {}, argv: [], platform: process.platform }, console: quietLog,
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    require(request) {
      if (request === 'electron-updater') return { autoUpdater };
      if (request === 'electron-updater/out/AppAdapter') return { getAppCacheDir: () => 'unused-cache' };
      if (request === 'electron') return { app: { isPackaged } };
      if (request === 'electron-log') return quietLog;
      if (request === '../../config/dev-config.cjs') return { enableDevUpdates: false };
      if (request === '../ipc/logger-handlers.cjs') return { getLoggerHandlers: () => ({ logFromMain() {} }) };
      if (request === '../utils/app-store.cjs') return { get: () => null };
      return realRequire(request);
    }
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const service = new module.exports.UpdateService();
  function advance(milliseconds) {
    const end = now + milliseconds;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.recurring) timer.at += timer.delay;
      else timers.delete(id);
      timer.callback();
    }
    now = end;
  }
  return { service, autoUpdater, calls, timers, advance };
}

// Removing startup timeout cancellation must reproduce both startup callers.
test('repeated starts replace the pending ten-second check', () => {
  const { service, calls, advance } = createHarness();
  service.startPeriodicChecks();
  advance(2000);
  service.startPeriodicChecks();
  advance(8000);
  assert.deepEqual(calls, []);
  advance(1999);
  assert.deepEqual(calls, []);
  advance(1);
  assert.deepEqual(calls, [12000]);
});

// Missing startup cancellation must not allow a check after shutdown/stop.
test('stop before startup cancels both initial and recurring checks', () => {
  const { service, calls, timers, advance } = createHarness();
  service.startPeriodicChecks();
  advance(5000);
  service.stopPeriodicChecks();
  service.stopPeriodicChecks();
  advance(12 * 60 * 60 * 1000);
  assert.deepEqual(calls, []);
  assert.equal(timers.size, 0);
  assert.equal(service.updateCheckInterval, null);
  assert.equal(service.updateCheckTimeout, null);
});

// A fired startup timer must release ownership before the check can restart it.
test('startup callback releases its handle before checking and can restart', () => {
  const { service, autoUpdater, calls, advance } = createHarness();
  let handleAtCheck;
  autoUpdater.checkForUpdates = async () => {
    handleAtCheck = service.updateCheckTimeout;
    calls.push('check');
  };
  service.startPeriodicChecks();
  advance(10000);
  assert.equal(handleAtCheck, null);
  service.stopPeriodicChecks();
  service.startPeriodicChecks();
  advance(9999);
  assert.equal(calls.length, 1);
  advance(1);
  assert.equal(calls.length, 2);
  assert.equal(service.updateCheckTimeout, null);
});

// Interval cancellation/replacement and the twelve-hour contract stay intact.
test('restarted recurring checks run once per twelve hours and stop completely', () => {
  const { service, calls, advance } = createHarness();
  const period = 12 * 60 * 60 * 1000;
  service.startPeriodicChecks();
  advance(2000);
  service.startPeriodicChecks();
  advance(period);
  assert.deepEqual(calls, [12000, period + 2000]);
  advance(period);
  assert.deepEqual(calls, [12000, period + 2000, 2 * period + 2000]);
  service.stopPeriodicChecks();
  advance(period);
  assert.equal(calls.length, 3);
});

test('development start and manual check retain their no-updater behavior', async () => {
  const { service, calls, timers, advance } = createHarness({ isPackaged: false });
  const start = service.startPeriodicChecks();
  assert.equal(start.success, true);
  assert.equal(start.message, 'Periodic update checks disabled in development mode');
  advance(12 * 60 * 60 * 1000);
  const manual = await service.checkForUpdates();
  assert.equal(manual.success, true);
  assert.equal(manual.developmentMode, true);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls, []);
});

test('manual production checks remain independent and real errors stay observable', async () => {
  const { service, autoUpdater, calls } = createHarness();
  service.startPeriodicChecks();
  service.stopPeriodicChecks();
  assert.equal((await service.checkForUpdates()).success, true);
  assert.deepEqual(calls, [0]);
  const errors = [];
  service.on('update-error', error => errors.push(error));
  autoUpdater.checkForUpdates = async () => {
    const error = new Error('ENOENT: missing resources/app-update.yml');
    autoUpdater.emit('error', error);
    throw error;
  };
  const result = await service.checkForUpdates();
  assert.equal(result.success, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].technical, 'ENOENT: missing resources/app-update.yml');
  assert.equal(result.errorDetails.technical, errors[0].technical);
});
