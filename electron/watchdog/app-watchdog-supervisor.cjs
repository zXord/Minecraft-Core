'use strict';

const crypto = require('node:crypto');
const {
  encodePowerShellCommand,
  resolveSystemPowerShellRuntime
} = require('./app-watchdog.cjs');
const { enableServerProcessSupervisionRequirement } = require('./server-process-supervision-policy.cjs');

const OWNERSHIP_EVENT = 'server-process-owned';
const EXIT_EVENTS = Object.freeze(['server-process-released', 'server-normal-exit', 'server-crashed']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// A cold PowerShell and CIM start during a busy login can take many seconds.
const ACK_TIMEOUT_MS = 30000;
const MAX_ACK_BYTES = 512;

function normalizeOwnership(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.instanceId !== 'string' || !ID_PATTERN.test(value.instanceId) ||
      typeof value.operationId !== 'string' || !ID_PATTERN.test(value.operationId) ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  return Object.freeze({ instanceId: value.instanceId, operationId: value.operationId, pid: value.pid });
}

function ownershipKey(value) {
  return `${value.instanceId}\u0000${value.pid}\u0000${value.operationId}`;
}

function createAppWatchdogSupervisor({
  cryptoApi = crypto,
  env = process.env,
  eventBus,
  fsApi = require('node:fs'),
  spawnImpl = require('node:child_process').spawn,
  timers = { clearTimeout, setTimeout },
  warn = message => console.warn(message)
} = {}) {
  if (!eventBus || typeof eventBus.on !== 'function' || typeof eventBus.removeListener !== 'function' ||
      !cryptoApi || typeof cryptoApi.randomBytes !== 'function' || !fsApi ||
      typeof spawnImpl !== 'function' || typeof timers?.setTimeout !== 'function' ||
      typeof timers?.clearTimeout !== 'function' || typeof warn !== 'function') {
    throw new TypeError('App watchdog supervisor dependencies are invalid');
  }

  const powerShellRuntime = resolveSystemPowerShellRuntime({ env, fsApi });
  const encodedCommand = encodePowerShellCommand();
  const watchers = new Map();
  let started = false;

  const stopExpected = (key, entry) => {
    if (!entry || watchers.get(key) !== entry) return false;
    watchers.delete(key);
    timers.clearTimeout(entry.timer);
    entry.expectedStop = true;
    if (!entry.armed) entry.rejectReady(new Error('Server process closed before watchdog arm completed'));
    try { entry.child.kill(); } catch (error) {
      warn(`Failed to stop app watchdog for ${entry.instanceId}/${entry.pid}: ${error.message}`);
    }
    return true;
  };

  const handleOwnership = value => {
    const ownership = normalizeOwnership(value);
    if (!ownership || typeof value.acknowledge !== 'function' || typeof value.onSupervisionFailure !== 'function' ||
        (value.onSupervisionDeadline !== undefined && typeof value.onSupervisionDeadline !== 'function') ||
        !powerShellRuntime) return false;
    const reportsDeadline = typeof value.onSupervisionDeadline === 'function';
    const key = ownershipKey(ownership);
    const existing = watchers.get(key);
    if (existing) {
      value.acknowledge({ ...ownership, ready: existing.ready });
      return true;
    }

    const nonce = cryptoApi.randomBytes(32).toString('hex');
    if (!/^[a-f0-9]{64}$/u.test(nonce)) return false;
    const expectedAck = `MCWD1|${nonce}|${ownership.instanceId}|${ownership.pid}|${ownership.operationId}`;
    let child;
    try {
      child = spawnImpl(powerShellRuntime.executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodedCommand
      ], {
        detached: false,
        env: {
          MC_CORE_WATCHDOG_INSTANCE: ownership.instanceId,
          MC_CORE_WATCHDOG_NONCE: nonce,
          MC_CORE_WATCHDOG_OPERATION: ownership.operationId,
          MC_CORE_WATCHDOG_PID: String(ownership.pid),
          MC_CORE_WATCHDOG_CIM_MODULE: powerShellRuntime.cimModule,
          PSModulePath: powerShellRuntime.modulePath,
          SystemRoot: powerShellRuntime.systemRoot,
          WINDIR: powerShellRuntime.systemRoot
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      });
      if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 ||
          typeof child.kill !== 'function' || typeof child.once !== 'function' || typeof child.unref !== 'function' ||
          !child.stdin || typeof child.stdin.unref !== 'function' ||
          typeof child.stdin.on !== 'function' || typeof child.stdin.once !== 'function' ||
          !child.stdout || typeof child.stdout.on !== 'function' ||
          typeof child.stdout.once !== 'function' || typeof child.stdout.unref !== 'function') {
        throw new TypeError('Spawn did not return an armed watchdog process boundary');
      }
    } catch (error) {
      try { child?.kill?.(); } catch { /* exact invalid watcher cleanup only */ }
      warn(`Failed to spawn app watchdog: ${error.message}`);
      return false;
    }

    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const entry = {
      armed: false,
      buffer: '',
      child,
      expectedStop: false,
      failureDelivered: false,
      instanceId: ownership.instanceId,
      operationId: ownership.operationId,
      pid: ownership.pid,
      ready,
      rejectReady,
      resolveReady,
      timer: null
    };
    watchers.set(key, entry);

    const fail = error => {
      if (entry.expectedStop || entry.failureDelivered || watchers.get(key) !== entry) return;
      entry.failureDelivered = true;
      watchers.delete(key);
      timers.clearTimeout(entry.timer);
      entry.rejectReady(error);
      try { child.kill(); } catch { /* exact watcher cleanup only */ }
      warn(`App watchdog failed for ${ownership.instanceId}/${ownership.pid}: ${error.message}`);
      try { value.onSupervisionFailure(ownership, error); } catch { /* observer cannot widen authority */ }
    };
    // Best-effort requesters only hear about a missed deadline. The watcher keeps
    // running, so a late ACK still arms app-death protection.
    const reportDeadline = error => {
      if (entry.armed || entry.expectedStop || entry.failureDelivered || watchers.get(key) !== entry) return;
      warn(`App watchdog for ${ownership.instanceId}/${ownership.pid} is still waiting for its ACK: ${error.message}`);
      try { value.onSupervisionDeadline(ownership, error); } catch { /* observer cannot widen authority */ }
    };

    child.stdout.on('data', chunk => {
      if (entry.failureDelivered || entry.expectedStop) return;
      const text = chunk.toString('utf8');
      if (Buffer.byteLength(entry.buffer, 'utf8') + Buffer.byteLength(text, 'utf8') > MAX_ACK_BYTES) {
        return fail(new Error('Watchdog ACK exceeded its byte limit'));
      }
      entry.buffer += text;
      const newline = entry.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = entry.buffer.slice(0, newline).replace(/\r$/u, '');
      const remainder = entry.buffer.slice(newline + 1);
      if (entry.armed || line !== expectedAck || remainder.length !== 0) return fail(new Error('Watchdog ACK was malformed or duplicated'));
      entry.armed = true;
      timers.clearTimeout(entry.timer);
      entry.resolveReady(ownership);
    });
    child.stdout.once('error', error => fail(error));
    child.stdin.once('error', error => fail(error));
    child.once('error', error => fail(error));
    child.once('exit', (code, signal) => fail(new Error(`watchdog exited unexpectedly (${code ?? 'null'}/${signal ?? 'null'})`)));
    try {
      entry.timer = timers.setTimeout(() => {
        const error = new Error('Watchdog ACK deadline exceeded');
        if (reportsDeadline) reportDeadline(error);
        else fail(error);
      }, ACK_TIMEOUT_MS);
      entry.timer?.unref?.();
      child.stdin.unref();
      child.stdout.unref();
      child.unref();
      value.acknowledge({ ...ownership, ready });
    } catch (error) {
      fail(error);
      return false;
    }
    return true;
  };

  const handleExit = value => {
    const ownership = normalizeOwnership(value);
    if (!ownership) return false;
    const key = ownershipKey(ownership);
    return stopExpected(key, watchers.get(key));
  };

  return {
    start() {
      if (started) return false;
      eventBus.on(OWNERSHIP_EVENT, handleOwnership);
      for (const eventName of EXIT_EVENTS) eventBus.on(eventName, handleExit);
      enableServerProcessSupervisionRequirement({ available: Boolean(powerShellRuntime) });
      started = true;
      return true;
    },
    dispose() {
      if (!started) return;
      eventBus.removeListener(OWNERSHIP_EVENT, handleOwnership);
      for (const eventName of EXIT_EVENTS) eventBus.removeListener(eventName, handleExit);
      started = false;
      // Watchers and their stdin leases remain rooted and unref'd until main exit.
    }
  };
}

module.exports = { ACK_TIMEOUT_MS, MAX_ACK_BYTES, createAppWatchdogSupervisor };
