const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');
const { spawn } = require('child_process');
const pidusage = require('pidusage');
const { safeSend } = require('../utils/safe-send.cjs');
const eventBus = require('../utils/event-bus.cjs');
const appStore = require('../utils/app-store.cjs');
const { ServerJavaManager } = require('./server-java-manager.cjs');
const { readServerConfig, getDefaultServerConfig, detectMinecraftVersion } = require('../utils/config-manager.cjs');
const { resolveServerLoader } = require('../utils/server-loader.cjs');
const { resolveLaunchPlan, syncServerPort } = require('./server-launcher.cjs');
const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');

const logger = getLoggerHandlers();

const serverStates = new Map();
const METRICS_INTERVAL_MS = 2000;
const LIST_COMMAND_THROTTLE = 30000;

function createDefaultState(instanceId, targetPath = null) {
  return {
    instanceId,
    targetPath,
    process: null,
    status: 'stopped',
    startMs: null,
    maxRam: 4,
    port: 25565,
    loader: 'vanilla',
    playersInfo: { count: 0, names: [] },
    stdoutBuffer: '',
    lastLine: '',
    lastListCommandTime: 0,
    expectingListResponse: false,
    responseTimeout: null,
    listInterval: null,
    intensivePlayerCheckMode: false,
    intensiveCheckTimer: null,
    intensiveCheckTimeouts: [],
    metricsInterval: null,
    lastMetricsUpdateAt: 0,
    cloudSyncWarningSent: false,
    shutdownRequest: null
  };
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function findInstanceByPath(targetPath) {
  const instances = appStore.get('instances') || [];
  return instances.find((instance) => instance && instance.type === 'server' && instance.path === targetPath) || null;
}

function resolveInstanceId(input = {}) {
  if (typeof input === 'string' && input.trim()) {
    const trimmed = input.trim();
    if (serverStates.has(trimmed)) {
      return trimmed;
    }
    const matchedByPath = Array.from(serverStates.values()).find((state) => state.targetPath === trimmed);
    if (matchedByPath) {
      return matchedByPath.instanceId;
    }
    const instance = findInstanceByPath(trimmed);
    if (instance && instance.id) {
      return instance.id;
    }
    return trimmed;
  }

  const { instanceId = null, targetPath = null } = input || {};
  if (instanceId && typeof instanceId === 'string') {
    return instanceId;
  }

  if (targetPath && typeof targetPath === 'string') {
    const instance = findInstanceByPath(targetPath);
    if (instance && instance.id) {
      return instance.id;
    }
    return targetPath;
  }

  const lastServerPath = appStore.get('lastServerPath');
  if (lastServerPath) {
    const runningMatch = Array.from(serverStates.values()).find((state) => state.targetPath === lastServerPath);
    if (runningMatch) {
      return runningMatch.instanceId;
    }
  }

  const firstRunning = Array.from(serverStates.values()).find((state) => !!state.process);
  if (firstRunning) {
    return firstRunning.instanceId;
  }

  const firstState = serverStates.keys().next();
  return firstState.done ? 'server-default' : firstState.value;
}

function getOrCreateState(selector = {}) {
  const instanceId = resolveInstanceId(selector);
  const targetPath = selector && typeof selector === 'object' && selector.targetPath ? selector.targetPath : null;
  if (!serverStates.has(instanceId)) {
    serverStates.set(instanceId, createDefaultState(instanceId, targetPath));
  }
  const state = serverStates.get(instanceId);
  if (targetPath && !state.targetPath) {
    state.targetPath = targetPath;
  }
  return state;
}

function getState(selector = {}) {
  const instanceId = resolveInstanceId(selector);
  return serverStates.get(instanceId) || null;
}

function getRunningStates() {
  return Array.from(serverStates.values()).filter((state) => !!state.process);
}

function getMatchingStates(selector = {}) {
  const instanceId = selector && typeof selector === 'object' ? selector.instanceId : null;
  const targetPath = selector && typeof selector === 'object' ? selector.targetPath : null;

  const matches = Array.from(serverStates.values()).filter((state) => {
    if (instanceId && state.instanceId === instanceId) {
      return true;
    }
    if (targetPath && state.targetPath === targetPath) {
      return true;
    }
    return false;
  });

  if (matches.length > 0) {
    return matches;
  }

  const fallback = getState(selector);
  return fallback ? [fallback] : [];
}

function buildStatusPayload(state) {
  return {
    instanceId: state.instanceId,
    status: state.status,
    isRunning: !!state.process,
    targetPath: state.targetPath,
    port: state.port,
    maxRam: state.maxRam,
    loader: state.loader,
    serverStartMs: state.startMs,
    playersInfo: {
      count: state.playersInfo.count,
      names: [...state.playersInfo.names]
    }
  };
}

function emitServerStatus(state) {
  safeSend('server-status', buildStatusPayload(state));
}

function emitServerLog(state, line) {
  safeSend('server-log', {
    instanceId: state.instanceId,
    line,
    targetPath: state.targetPath
  });
}

function formatUptime(startMs) {
  if (!startMs) {
    return '0h 0m 0s';
  }
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function clearIntensiveChecking(state) {
  if (state.intensiveCheckTimer) {
    clearTimeout(state.intensiveCheckTimer);
    state.intensiveCheckTimer = null;
  }

  if (state.intensiveCheckTimeouts.length > 0) {
    state.intensiveCheckTimeouts.forEach(clearTimeout);
    state.intensiveCheckTimeouts = [];
  }

  state.intensivePlayerCheckMode = false;
}

function clearMetricsInterval(state) {
  if (state.metricsInterval) {
    clearInterval(state.metricsInterval);
    state.metricsInterval = null;
  }
}

function clearListInterval(state) {
  if (state.listInterval) {
    clearInterval(state.listInterval);
    state.listInterval = null;
  }
}

function clearResponseTimeout(state) {
  if (state.responseTimeout) {
    clearTimeout(state.responseTimeout);
    state.responseTimeout = null;
  }
}

function clearStateTimers(state) {
  clearMetricsInterval(state);
  clearListInterval(state);
  clearResponseTimeout(state);
  clearIntensiveChecking(state);
}

function sendMetricsUpdate(metrics, selector = {}) {
  const state = getState(selector) || getOrCreateState(selector);
  state.lastMetricsUpdateAt = Date.now();
  safeSend('metrics-update', {
    instanceId: state.instanceId,
    ...metrics
  });
}

async function updateMetrics(state) {
  const currentProcess = state.process;
  if (!currentProcess || !currentProcess.pid) {
    clearMetricsInterval(state);
    return;
  }

  try {
    const stats = await pidusage(currentProcess.pid);
    sendMetricsUpdate({
      cpuPct: Number(stats.cpu?.toFixed?.(1) || stats.cpu || 0),
      memUsedMB: Number(((stats.memory || 0) / 1024 / 1024).toFixed(1)),
      systemTotalRamMB: Number((os.totalmem() / 1024 / 1024).toFixed(1)),
      maxRamMB: state.maxRam * 1024,
      uptime: formatUptime(state.startMs),
      players: state.playersInfo.count,
      names: [...state.playersInfo.names]
    }, { instanceId: state.instanceId });
  } catch {
    sendMetricsUpdate({
      cpuPct: 0,
      memUsedMB: 0,
      systemTotalRamMB: Number((os.totalmem() / 1024 / 1024).toFixed(1)),
      maxRamMB: state.maxRam * 1024,
      uptime: formatUptime(state.startMs),
      players: state.playersInfo.count,
      names: [...state.playersInfo.names]
    }, { instanceId: state.instanceId });
  }
}

function startMetricsReporting(state) {
  clearMetricsInterval(state);
  state.metricsInterval = setInterval(() => {
    updateMetrics(state).catch(() => {});
  }, METRICS_INTERVAL_MS);
  updateMetrics(state).catch(() => {});
}

function maybeSendCloudSyncWarning(state, text) {
  if (state.cloudSyncWarningSent || typeof text !== 'string' || !text.trim()) {
    return;
  }

  const normalized = text.toLowerCase();
  if (
    !normalized.includes('incompatible hardlinks')
    && !normalized.includes('error_cloud_files_incompatible_hardlinks')
  ) {
    return;
  }

  state.cloudSyncWarningSent = true;
  safeSend('server-cloud-sync-warning', {
    instanceId: state.instanceId,
    title: 'Cloud-synced folder blocked the world upgrade',
    summary: 'Minecraft could not finish the world upgrade because Windows blocked hardlinks inside this synced folder.',
    serverPath: state.targetPath,
    guidance: [
      'Copy the live server to a plain local folder such as C:\\Minecraft\\Server.',
      'Start it there once so the world upgrade can finish.',
      'Stop the server, then copy the upgraded server back if you still want it stored in your cloud-sync folder.'
    ],
    rawMessage: text.trim()
  });
}

function sendListCommand(state) {
  if (!state.process || state.process.killed) {
    return;
  }

  const now = Date.now();
  if (now - state.lastListCommandTime < LIST_COMMAND_THROTTLE && !state.intensivePlayerCheckMode) {
    return;
  }

  try {
    state.expectingListResponse = true;
    state.process.stdin.write('list\n');
    state.lastListCommandTime = now;
    clearResponseTimeout(state);
    state.responseTimeout = setTimeout(() => {
      state.expectingListResponse = false;
    }, 2000);
  } catch {
    state.expectingListResponse = false;
  }
}

function enableIntensiveChecking(state) {
  clearIntensiveChecking(state);
  state.intensivePlayerCheckMode = true;
  sendListCommand(state);

  [2000, 5000].forEach((delay) => {
    const timeout = setTimeout(() => sendListCommand(state), delay);
    state.intensiveCheckTimeouts.push(timeout);
  });

  state.intensiveCheckTimer = setTimeout(() => {
    clearIntensiveChecking(state);
  }, 6000);
}

function parsePlayerList(state, text) {
  const fullPattern = /There are (\d+) of a max of \d+ players online: (.+)/;
  const fullMatch = text.match(fullPattern);
  if (fullMatch) {
    state.expectingListResponse = false;
    state.playersInfo = {
      count: parseInt(fullMatch[1], 10),
      names: fullMatch[2].split(', ').filter(Boolean)
    };
    return true;
  }

  const countPattern = /There are (\d+) of a max of \d+ players online/;
  const countMatch = text.match(countPattern);
  if (countMatch) {
    state.expectingListResponse = false;
    const count = parseInt(countMatch[1], 10);
    const names = state.playersInfo.names.length === count ? state.playersInfo.names : [];
    state.playersInfo = { count, names };
    return true;
  }

  const joinMatch = text.match(/(\w+) joined the game/);
  if (joinMatch) {
    const playerName = joinMatch[1];
    if (!state.playersInfo.names.includes(playerName)) {
      state.playersInfo = {
        count: state.playersInfo.count + 1,
        names: [...state.playersInfo.names, playerName]
      };
      sendListCommand(state);
      return true;
    }
  }

  const leaveMatch = text.match(/(\w+) left the game/);
  if (leaveMatch) {
    const playerName = leaveMatch[1];
    state.playersInfo = {
      count: Math.max(0, state.playersInfo.count - 1),
      names: state.playersInfo.names.filter((name) => name !== playerName)
    };
    enableIntensiveChecking(state);
    return true;
  }

  return false;
}

function handleLogLine(state, text) {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return;
  }

  maybeSendCloudSyncWarning(state, trimmed);
  const isListResponse = /There are \d+ of a max of \d+ players online/.test(trimmed);

  if (trimmed !== state.lastLine) {
    state.lastLine = trimmed;
    if (!isListResponse || !state.expectingListResponse) {
      emitServerLog(state, trimmed);
    }
  }

  if (parsePlayerList(state, trimmed)) {
    updateMetrics(state).catch(() => {});
  }
}

function normalizeStartArguments(targetPathOrOptions, port, maxRam) {
  if (targetPathOrOptions && typeof targetPathOrOptions === 'object') {
    return {
      instanceId: targetPathOrOptions.instanceId || null,
      targetPath: targetPathOrOptions.targetPath,
      port: toNumber(targetPathOrOptions.port, 25565),
      maxRam: toNumber(targetPathOrOptions.maxRam, 4)
    };
  }

  return {
    instanceId: null,
    targetPath: targetPathOrOptions,
    port: toNumber(port, 25565),
    maxRam: toNumber(maxRam, 4)
  };
}

function buildConfigDefaultsFromStore() {
  return getDefaultServerConfig({
    port: 25565,
    maxRam: 4,
    managementPort: 8080,
    autoStartMinecraft: false,
    autoStartManagement: false,
    autoRestart: {
      enabled: false,
      delay: 10,
      maxCrashes: 3
    }
  });
}

async function ensureJavaReadyForServer(targetPath, minecraftVersion) {
  const manager = new ServerJavaManager(targetPath);
  let requirements = await manager.getJavaRequirementsForMinecraft(minecraftVersion);

  if (requirements.needsDownload) {
    const javaResult = await manager.ensureJavaForMinecraft(minecraftVersion, (progress) => {
      safeSend('server-java-download-progress', {
        minecraftVersion,
        serverPath: targetPath,
        ...progress
      });
    });

    if (!javaResult.success) {
      throw new Error(javaResult.error || 'Java installation failed');
    }

    requirements = await manager.getJavaRequirementsForMinecraft(minecraftVersion);
  }

  if (!requirements.isAvailable || !requirements.javaPath) {
    throw new Error(
      requirements.validationMessage
        || `Java ${requirements.requiredJavaVersion} is not available for Minecraft ${minecraftVersion}`
    );
  }

  return requirements;
}

async function startMinecraftServer(targetPathOrOptions, port, maxRam) {
  const args = normalizeStartArguments(targetPathOrOptions, port, maxRam);
  const { targetPath, instanceId: requestedInstanceId } = args;

  if (!targetPath || !fs.existsSync(targetPath)) {
    return {
      success: false,
      error: 'Invalid server path',
      code: 'INVALID_SERVER_PATH'
    };
  }

  const instanceId = resolveInstanceId({ instanceId: requestedInstanceId, targetPath });
  const state = getOrCreateState({ instanceId, targetPath });

  if (state.process) {
    return {
      success: true,
      alreadyRunning: true,
      instanceId: state.instanceId,
      status: state.status,
      pid: state.process.pid
    };
  }

  const defaults = buildConfigDefaultsFromStore();
  const config = readServerConfig(targetPath, defaults) || defaults;
  const minecraftVersion = config.version || detectMinecraftVersion(targetPath) || '1.20.1';
  const loaderInfo = resolveServerLoader(targetPath);
  const loader = config.loader || loaderInfo.loader || 'vanilla';
  const loaderVersion = config.loaderVersion || config.fabric || loaderInfo.loaderVersion || null;

  state.targetPath = targetPath;
  state.port = args.port || toNumber(config.port, 25565);
  state.maxRam = args.maxRam || toNumber(config.maxRam, 4);
  state.loader = loader;
  state.status = 'starting';
  state.startMs = null;
  state.shutdownRequest = null;
  state.playersInfo = { count: 0, names: [] };
  state.cloudSyncWarningSent = false;
  state.stdoutBuffer = '';
  state.lastLine = '';

  emitServerStatus(state);
  emitServerLog(state, `[INFO] Preparing ${loader} server startup...`);

  try {
    syncServerPort(targetPath, state.port);

    const javaRequirements = await ensureJavaReadyForServer(targetPath, minecraftVersion);
    const launchPlan = resolveLaunchPlan(targetPath, {
      loader,
      maxRam: state.maxRam,
      minecraftVersion,
      loaderVersion
    });

    const javaPath = javaRequirements.javaPath;
    const serverIdentifier = `minecraft-core-server-${state.instanceId}-${Date.now()}`;
    const spawnArgs = [`-Dminecraft.core.server.id=${serverIdentifier}`, ...launchPlan.args];

    logger.info('Spawning Minecraft server process', {
      category: 'server',
      instanceId: state.instanceId,
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        targetPath,
        loader,
        loaderVersion,
        minecraftVersion,
        port: state.port,
        maxRam: state.maxRam,
        javaPath,
        spawnArgs
      }
    });

    emitServerLog(state, `[INFO] Starting server with Java: ${javaPath}`);

    const child = spawn(javaPath, spawnArgs, {
      cwd: targetPath,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    state.process = child;
    state.startMs = Date.now();
    child.serverInfo = {
      id: serverIdentifier,
      instanceId: state.instanceId,
      port: state.port,
      maxRam: state.maxRam,
      startTime: state.startMs,
      targetPath,
      loader,
      loaderVersion,
      minecraftVersion,
      jar: launchPlan.jar || null,
      launchType: launchPlan.type
    };

    child.stdout.on('data', (chunk) => {
      state.stdoutBuffer += chunk.toString();
      const lines = state.stdoutBuffer.split(/\r?\n/);
      state.stdoutBuffer = lines.pop() || '';
      lines.forEach((line) => handleLogLine(state, line));
    });

    child.stdout.on('end', () => {
      if (state.stdoutBuffer.trim()) {
        handleLogLine(state, state.stdoutBuffer);
      }
      state.stdoutBuffer = '';
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      maybeSendCloudSyncWarning(state, text);
      emitServerLog(state, `[STDERR] ${text.trimEnd()}`);
    });

    child.on('error', (error) => {
      logger.error(`Server process error: ${error.message}`, {
        category: 'server',
        instanceId: state.instanceId,
        data: {
          service: 'ServerManager',
          operation: 'serverProcess.error',
          errorType: error.constructor.name,
          targetPath
        }
      });
      emitServerLog(state, `[ERROR] Server process error: ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      const wasManualShutdown = state.shutdownRequest === 'stop' || state.shutdownRequest === 'kill';
      const isNormalExit = wasManualShutdown || code === 0 || signal === 'SIGTERM' || signal === 'SIGINT';

      clearStateTimers(state);
      state.process = null;
      state.status = 'stopped';
      state.startMs = null;
      state.shutdownRequest = null;
      state.playersInfo = { count: 0, names: [] };
      emitServerStatus(state);
      sendMetricsUpdate({
        cpuPct: 0,
        memUsedMB: 0,
        systemTotalRamMB: Number((os.totalmem() / 1024 / 1024).toFixed(1)),
        maxRamMB: state.maxRam * 1024,
        uptime: '0h 0m 0s',
        players: 0,
        names: []
      }, { instanceId: state.instanceId });

      if (!isNormalExit) {
        eventBus.emit('server-crashed', {
          instanceId: state.instanceId,
          serverInfo: {
            targetPath,
            port: state.port,
            maxRam: state.maxRam,
            loader
          },
          exitCode: code,
          signal
        });
      } else {
        eventBus.emit('server-normal-exit', { instanceId: state.instanceId });
      }
    });

    clearListInterval(state);
    state.listInterval = setInterval(() => {
      if (state.process && !state.process.killed && !state.intensivePlayerCheckMode) {
        sendListCommand(state);
      }
    }, 120000);

    state.status = 'running';
    emitServerStatus(state);
    startMetricsReporting(state);
    eventBus.emit('server-started', {
      instanceId: state.instanceId,
      targetPath,
      port: state.port,
      maxRam: state.maxRam,
      loader
    });

    return {
      success: true,
      instanceId: state.instanceId,
      pid: child.pid,
      javaPath,
      jar: launchPlan.jar || null,
      loader
    };
  } catch (error) {
    clearStateTimers(state);
    state.process = null;
    state.status = 'error';
    state.startMs = null;
    emitServerStatus(state);
    emitServerLog(state, `[ERROR] ${error.message}`);

    logger.error(`Server start failed: ${error.message}`, {
      category: 'server',
      instanceId: state.instanceId,
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        targetPath,
        errorType: error.constructor.name,
        code: error.code || null
      }
    });

    return {
      success: false,
      instanceId: state.instanceId,
      error: error.message || 'Server failed to start.',
      code: error.code || 'SERVER_START_FAILED',
      details: error.details || null
    };
  }
}

function stopMinecraftServer(selector = {}) {
  const state = getState(selector);
  if (!state || !state.process) {
    return false;
  }

  state.shutdownRequest = 'stop';
  state.status = 'stopping';
  emitServerStatus(state);

  try {
    state.process.stdin.write('stop\n');
    return true;
  } catch {
    return false;
  }
}

function killMinecraftServer(selector = {}) {
  const state = getState(selector);
  if (!state || !state.process) {
    return false;
  }

  const child = state.process;
  state.shutdownRequest = 'kill';
  state.status = 'stopping';
  emitServerStatus(state);

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/F', '/T']);
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        process.kill(child.pid, 'SIGKILL');
      }
    }
    return true;
  } catch {
    return false;
  }
}

function sendServerCommand(selectorOrCommand, commandMaybe) {
  let selector = {};
  let command = commandMaybe;

  if (typeof selectorOrCommand === 'string' && commandMaybe === undefined) {
    command = selectorOrCommand;
  } else {
    selector = selectorOrCommand || {};
  }

  const state = getState(selector);
  if (!state || !state.process || !command || typeof command !== 'string') {
    return false;
  }

  try {
    state.process.stdin.write(`${command}\n`);
    safeSend('command-response', {
      instanceId: state.instanceId,
      command
    });
    return true;
  } catch {
    return false;
  }
}

function getServerState(selector = {}) {
  const state = getState(selector);
  if (!state) {
    return {
      instanceId: resolveInstanceId(selector),
      isRunning: false,
      serverProcess: null,
      serverStartMs: null,
      serverMaxRam: 4,
      playersInfo: { count: 0, names: [] },
      status: 'stopped',
      port: 25565,
      targetPath: null,
      loader: 'vanilla'
    };
  }

  return {
    instanceId: state.instanceId,
    isRunning: !!state.process,
    serverProcess: state.process,
    serverStartMs: state.startMs,
    serverMaxRam: state.maxRam,
    playersInfo: {
      count: state.playersInfo.count,
      names: [...state.playersInfo.names]
    },
    status: state.status,
    port: state.port,
    targetPath: state.targetPath,
    loader: state.loader
  };
}

function getAllServerStates() {
  return Array.from(serverStates.values()).map((state) => getServerState({ instanceId: state.instanceId }));
}

function getServerProcess(selector = {}) {
  const state = getState(selector);
  return state ? state.process : null;
}

function isInstanceRunning(selector = {}) {
  const state = getState(selector);
  return !!(state && state.process);
}

function getRunningServerInstanceIds() {
  return getRunningStates().map((state) => state.instanceId);
}

function clearIntervals(selector = null) {
  if (selector) {
    const state = getState(selector);
    if (state) {
      clearStateTimers(state);
    }
    return;
  }

  serverStates.forEach((state) => clearStateTimers(state));
}

function killAllMinecraftServers() {
  return getRunningStates().map((state) => killMinecraftServer({ instanceId: state.instanceId }));
}

function disposeServerState(selector = {}) {
  const matches = getMatchingStates(selector);
  let disposedCount = 0;

  matches.forEach((state) => {
    if (state.process) {
      return;
    }
    clearStateTimers(state);
    serverStates.delete(state.instanceId);
    disposedCount += 1;
  });

  return disposedCount;
}

function waitForChildExit(child, timeoutMs) {
  if (!child) {
    return Promise.resolve(true);
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout = null;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(result);
    };

    const onExit = () => finish(true);
    const onError = () => finish(true);

    child.once('exit', onExit);
    child.once('error', onError);

    timeout = setTimeout(() => finish(false), timeoutMs);
  });
}

async function shutdownMinecraftServer(selector = {}, options = {}) {
  const {
    gracefulTimeoutMs = 8000,
    killTimeoutMs = 5000,
    forceKill = true,
    disposeStateAfterStop = false
  } = options;

  const matches = getMatchingStates(selector);
  if (matches.length === 0) {
    return {
      success: true,
      alreadyStopped: true,
      instanceIds: []
    };
  }

  const results = [];

  for (const state of matches) {
    const result = {
      instanceId: state.instanceId,
      targetPath: state.targetPath,
      stopped: false,
      forced: false,
      alreadyStopped: !state.process
    };

    if (!state.process) {
      if (disposeStateAfterStop) {
        disposeServerState({ instanceId: state.instanceId, targetPath: state.targetPath });
      }
      result.stopped = true;
      results.push(result);
      continue;
    }

    const child = state.process;
    const gracefulRequested = stopMinecraftServer({ instanceId: state.instanceId });

    let stopped = false;
    if (gracefulRequested) {
      stopped = await waitForChildExit(child, gracefulTimeoutMs);
    }

    if (!stopped && forceKill) {
      const killRequested = killMinecraftServer({ instanceId: state.instanceId });
      if (killRequested) {
        result.forced = true;
        stopped = await waitForChildExit(child, killTimeoutMs);
      }
    }

    if (disposeStateAfterStop && !state.process) {
      disposeServerState({ instanceId: state.instanceId, targetPath: state.targetPath });
    }

    result.stopped = stopped || !state.process;
    results.push(result);
  }

  return {
    success: results.every((item) => item.stopped),
    forced: results.some((item) => item.forced),
    alreadyStopped: results.every((item) => item.alreadyStopped),
    instanceIds: results.map((item) => item.instanceId),
    results
  };
}

module.exports = {
  startMinecraftServer,
  stopMinecraftServer,
  killMinecraftServer,
  shutdownMinecraftServer,
  sendServerCommand,
  getServerState,
  getAllServerStates,
  getServerProcess,
  getRunningServerInstanceIds,
  isInstanceRunning,
  killAllMinecraftServers,
  disposeServerState,
  clearIntervals,
  sendMetricsUpdate
};
