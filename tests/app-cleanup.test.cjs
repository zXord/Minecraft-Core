const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function createProcessControlRecorder() {
  const calls = [];
  const childProcessModuleAccesses = [];
  const record = (method, args) => {
    calls.push({ method, args: Array.from(args) });
  };
  const childProcess = {
    exec(...args) {
      record('exec', args);
      args.findLast(value => typeof value === 'function')?.(null, '', '');
      return { pid: 91 };
    },
    execFile(...args) {
      record('execFile', args);
      args.findLast(value => typeof value === 'function')?.(null, '', '');
      return { pid: 92 };
    },
    spawn(...args) {
      record('spawn', args);
      return { pid: 93 };
    }
  };
  const processMock = {
    platform: 'win32',
    on() {},
    exit() {},
    kill(...args) {
      record('process.kill', args);
      return true;
    }
  };

  return {
    calls,
    childProcessModuleAccesses,
    intercept(request) {
      if (request === 'child_process' || request === 'node:child_process') {
        childProcessModuleAccesses.push(request);
        return childProcess;
      }
      if (request === 'process' || request === 'node:process') return processMock;
      return null;
    }
  };
}

async function withCleanupMocks({ processControls, ownedCleanupCalls }, run) {
  const modulePath = path.resolve(__dirname, '../electron/utils/app-cleanup.cjs');
  const originalLoad = Module._load;
  delete require.cache[modulePath];

  Module._load = function loadCleanupFixture(request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { on() {} } };
    if (request === './safe-send.cjs') return { safeSend() {} };
    const processBoundary = processControls.intercept(request);
    if (processBoundary) return processBoundary;
    if (request === '../services/system-metrics.cjs') {
      return { stopMetricsReporting() { ownedCleanupCalls.push('metrics'); } };
    }
    if (request === '../services/server-manager.cjs') {
      return {
        clearIntervals() { ownedCleanupCalls.push('server-intervals'); },
        getServerProcess() { return { pid: 41 }; },
        killMinecraftServer() { ownedCleanupCalls.push('minecraft-server'); }
      };
    }
    if (request === '../services/management-server.cjs') {
      return {
        getManagementServer() {
          return { stopClientCleanup() { ownedCleanupCalls.push('management-intervals'); } };
        }
      };
    }
    if (request === '../ipc/backup-handlers.cjs') {
      return { clearBackupIntervals() { ownedCleanupCalls.push('backup-intervals'); } };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const cleanup = require(modulePath);
    return await run(cleanup);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

test('application cleanup never enumerates or terminates unowned operating-system processes', async () => {
  const processControls = createProcessControlRecorder();
  const ownedCleanupCalls = [];
  const originalProcessKill = process.kill;
  process.kill = (...args) => {
    processControls.calls.push({ method: 'process.kill', args });
    return true;
  };

  try {
    await withCleanupMocks({ processControls, ownedCleanupCalls }, ({ performCompleteCleanup }) => performCompleteCleanup());
  } finally {
    process.kill = originalProcessKill;
  }

  assert.deepEqual(processControls.childProcessModuleAccesses, []);
  assert.deepEqual(processControls.calls, []);
});

test('application cleanup still stops resources owned by Minecraft Core', async () => {
  const processControls = createProcessControlRecorder();
  const ownedCleanupCalls = [];
  await withCleanupMocks({ processControls, ownedCleanupCalls }, ({ performCompleteCleanup }) => performCompleteCleanup());

  assert.deepEqual(ownedCleanupCalls, [
    'metrics',
    'server-intervals',
    'management-intervals',
    'backup-intervals',
    'minecraft-server'
  ]);
});
