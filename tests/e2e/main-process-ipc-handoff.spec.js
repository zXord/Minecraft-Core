import { _electron as electron, expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PROBE_CHANNEL = 'modpacks:get-job';
const READY_CHANNEL = 'modpacks:job-progress';
const BLOCK_COUNT = 6;
const BLOCK_MS = 150;

function isolatedElectronEnvironment(userDataPath) {
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    MINECRAFT_CORE_TEST_MODE: '1',
    MINECRAFT_CORE_USER_DATA_DIR: userDataPath,
    npm_lifecycle_event: 'test:e2e:main-process-ipc-handoff',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  };
  delete environment.MINECRAFT_CORE_TEST_MODPACK_FACTORY;
  delete environment.MINECRAFT_CORE_E2E_SCENARIO_FILE;
  delete environment.MINECRAFT_CORE_TEST_RECOVERY_FACTORY;
  delete environment.MINECRAFT_CORE_USE_DEV_SERVER;
  return environment;
}

async function installMainProcessProbe(electronApp) {
  await electronApp.evaluate(async ({ ipcMain }, options) => {
    await new Promise(resolve => setImmediate(resolve));
    const childProcess = process.getBuiltinModule('node:child_process');
    if (!childProcess || typeof childProcess.spawnSync !== 'function') {
      throw new Error('The Electron main process child-process authority is unavailable');
    }

    const childEnvironment = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['SystemRoot', 'TEMP', 'TMP']) {
      if (typeof process.env[key] === 'string') childEnvironment[key] = process.env[key];
    }
    const childScript = [
      'const signal = new Int32Array(new SharedArrayBuffer(4));',
      `Atomics.wait(signal, 0, 0, ${options.blockMs});`
    ].join('');
    let currentRound = null;

    ipcMain.removeHandler(options.probeChannel);
    ipcMain.handle(options.probeChannel, async (event, request = {}) => {
      const jobId = request?.jobId;
      if (typeof jobId !== 'string') throw new TypeError('Probe request is invalid');
      if (jobId.startsWith('handoff-probe-ping-')) {
        const requestedMode = jobId.slice('handoff-probe-ping-'.length);
        return {
          requestedMode,
          active: currentRound?.active === true,
          activeMode: currentRound?.mode ?? null,
          completedBlocks: currentRound?.completedBlocks ?? 0,
          totalBlocks: options.blockCount
        };
      }
      if (!jobId.startsWith('handoff-probe-work-')) throw new TypeError('Probe request is invalid');

      const mode = jobId.slice('handoff-probe-work-'.length);
      if (!['immediate', 'timer-immediate'].includes(mode) || currentRound?.active === true) {
        throw new TypeError('Probe mode is invalid');
      }
      currentRound = { mode, active: true, completedBlocks: 0 };
      event.sender.send(options.readyChannel, { type: 'main-process-handoff-probe-ready', mode });

      try {
        for (let index = 0; index < options.blockCount; index += 1) {
          const result = childProcess.spawnSync(process.execPath, ['-e', childScript], {
            encoding: null,
            env: childEnvironment,
            shell: false,
            stdio: 'ignore',
            timeout: 5_000,
            windowsHide: true
          });
          if (result.error || result.signal || result.status !== 0) {
            throw result.error || new Error(`Probe child failed with status ${result.status ?? 'unknown'}`);
          }
          currentRound.completedBlocks = index + 1;
          if (currentRound.completedBlocks === options.blockCount) continue;
          if (mode === 'immediate') {
            await new Promise(resolve => setImmediate(resolve));
          } else {
            await new Promise(resolve => setTimeout(() => setImmediate(resolve), 0));
          }
        }
        return { mode, completedBlocks: currentRound.completedBlocks };
      } finally {
        currentRound.active = false;
      }
    });
  }, {
    blockCount: BLOCK_COUNT,
    blockMs: BLOCK_MS,
    probeChannel: PROBE_CHANNEL,
    readyChannel: READY_CHANNEL
  });
}

async function runHandoffRound(page, mode) {
  return page.evaluate(async ({ mode, probeChannel, readyChannel }) => {
    let readyTimer;
    let readyListener;
    const ready = new Promise((resolve, reject) => {
      readyListener = payload => {
        if (payload?.type !== 'main-process-handoff-probe-ready' || payload.mode !== mode) return;
        clearTimeout(readyTimer);
        window.electron.removeListener(readyChannel, readyListener);
        resolve();
      };
      window.electron.on(readyChannel, readyListener);
      readyTimer = setTimeout(() => {
        window.electron.removeListener(readyChannel, readyListener);
        reject(new Error(`Main-process ${mode} probe did not start`));
      }, 5_000);
    });

    const work = window.electron.invoke(probeChannel, { jobId: `handoff-probe-work-${mode}` });
    await Promise.race([
      ready,
      work.then(() => { throw new Error(`Main-process ${mode} probe finished before renderer readiness`); })
    ]);
    const pingStartedAt = performance.now();
    const ping = await window.electron.invoke(probeChannel, { jobId: `handoff-probe-ping-${mode}` });
    const pingLatencyMs = performance.now() - pingStartedAt;
    const completedWork = await work;
    return { completedWork, ping, pingLatencyMs };
  }, { mode, probeChannel: PROBE_CHANNEL, readyChannel: READY_CHANNEL });
}

test('main-process handoffs service renderer IPC between synchronous child-process blocks', async () => {
  test.setTimeout(90_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ipc-handoff-'));
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(userDataPath);
  let electronApp = null;

  try {
    electronApp = await electron.launch({
      args: ['.'],
      cwd: PROJECT_ROOT,
      env: isolatedElectronEnvironment(userDataPath)
    });
    const page = await electronApp.firstWindow();
    await page.waitForFunction(() => Boolean(window.electron && typeof window.electron.invoke === 'function'));
    await installMainProcessProbe(electronApp);

    const immediate = await runHandoffRound(page, 'immediate');
    const timerImmediate = await runHandoffRound(page, 'timer-immediate');

    expect(immediate.completedWork).toEqual({ mode: 'immediate', completedBlocks: BLOCK_COUNT });
    expect(immediate.ping).toMatchObject({
      requestedMode: 'immediate',
      active: true,
      activeMode: 'immediate',
      totalBlocks: BLOCK_COUNT
    });
    expect(immediate.ping.completedBlocks).toBeGreaterThan(0);
    expect(immediate.ping.completedBlocks).toBeLessThan(BLOCK_COUNT);
    expect(timerImmediate.completedWork).toEqual({ mode: 'timer-immediate', completedBlocks: BLOCK_COUNT });
    expect(timerImmediate.ping).toMatchObject({
      requestedMode: 'timer-immediate',
      active: true,
      activeMode: 'timer-immediate',
      totalBlocks: BLOCK_COUNT
    });
    expect(timerImmediate.ping.completedBlocks).toBeGreaterThan(0);
    expect(timerImmediate.ping.completedBlocks).toBeLessThan(BLOCK_COUNT);
    expect(immediate.pingLatencyMs).toBeGreaterThan(0);
    expect(timerImmediate.pingLatencyMs).toBeGreaterThan(0);
  } finally {
    await electronApp?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
