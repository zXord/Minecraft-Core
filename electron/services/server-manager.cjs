const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const process = require('process');
const pidusage = require('pidusage');
const { safeSend } = require('../utils/safe-send.cjs');
const eventBus = require('../utils/event-bus.cjs');
const appStore = require('../utils/app-store.cjs');
const { ServerJavaManager } = require('./server-java-manager.cjs');
const { readServerConfig, getDefaultServerConfig, detectMinecraftVersion } = require('../utils/config-manager.cjs');
const { resolveServerLoader, normalizeLoaderName } = require('../utils/server-loader.cjs');
const { normalizeRuntimeTuple } = require('./modpacks/contracts.cjs');
const { syncServerPort } = require('./server-launcher.cjs');
const { launchServerProcess } = require('./server-process-runner.cjs');
const { runManagedRuntimeVerificationWorker } = require('./managed-runtime-worker-client.cjs');
const { requestServerProcessSupervision } = require('../watchdog/server-process-supervision.cjs');
const { isServerProcessSupervisionRequired } = require('../watchdog/server-process-supervision-policy.cjs');
const {
  getCurrentServerMutationLease,
  getServerMutationCoordinator,
  runWithServerMutationLease
} = require('./server-mutation-context.cjs');
const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');

const logger = getLoggerHandlers();

const serverStates = new Map();
const lifecycleAdoptions = new Map();
const METRICS_INTERVAL_MS = 2000;
const LIST_COMMAND_THROTTLE = 30000;
const FAILED_START_STOP_TIMEOUT_MS = 5000;
const monitoredServerInputStreams = new WeakSet();
const failedServerInputStreams = new WeakSet();

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
    shutdownRequest: null,
    readyMarkers: [],
    fatalMarkers: [],
    runtime: null,
    startupOutcome: null,
    processCloseBarrier: null
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

function markServerInputFailed(state, child, stdin, error) {
  const alreadyFailed = failedServerInputStreams.has(stdin);
  failedServerInputStreams.add(stdin);
  if (state.process !== child) return;

  state.expectingListResponse = false;
  clearResponseTimeout(state);
  if (!alreadyFailed && !state.shutdownRequest) {
    emitServerLog(state, `[ERROR] Server command input closed: ${error?.message || 'unknown stream error'}`);
  }
}

function monitorServerInput(state, child) {
  const stdin = child?.stdin;
  if (!stdin || typeof stdin.on !== 'function' || monitoredServerInputStreams.has(stdin)) return;

  monitoredServerInputStreams.add(stdin);
  stdin.on('error', (error) => {
    markServerInputFailed(state, child, stdin, error);
  });
}

function canWriteServerInput(state, { allowDuringShutdown = false } = {}) {
  const child = state.process;
  const stdin = child?.stdin;
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) return false;
  if (!allowDuringShutdown && state.shutdownRequest) return false;
  if (!stdin || typeof stdin.write !== 'function' || failedServerInputStreams.has(stdin)) return false;
  if (
    stdin.destroyed === true
    || stdin.closed === true
    || stdin.writable === false
    || stdin.writableEnded === true
    || stdin.writableFinished === true
  ) {
    return false;
  }
  return true;
}

function writeServerInput(state, value, options = {}) {
  if (!canWriteServerInput(state, options)) return false;

  const child = state.process;
  const stdin = child.stdin;
  monitorServerInput(state, child);
  try {
    stdin.write(value, (error) => {
      if (error) markServerInputFailed(state, child, stdin, error);
    });
    return true;
  } catch (error) {
    markServerInputFailed(state, child, stdin, error);
    return false;
  }
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
  if (!canWriteServerInput(state)) {
    state.expectingListResponse = false;
    return;
  }

  const now = Date.now();
  if (now - state.lastListCommandTime < LIST_COMMAND_THROTTLE && !state.intensivePlayerCheckMode) {
    return;
  }

  state.expectingListResponse = true;
  if (!writeServerInput(state, 'list\n')) {
    state.expectingListResponse = false;
    return;
  }
  state.lastListCommandTime = now;
  clearResponseTimeout(state);
  state.responseTimeout = setTimeout(() => {
    state.expectingListResponse = false;
  }, 2000);
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
  if (state.status === 'starting' && state.startupOutcome === null) {
    const fatalMarker = state.fatalMarkers.find(marker => trimmed.includes(marker));
    if (fatalMarker) {
      state.startupOutcome = 'fatal';
      state.status = 'error';
      emitServerStatus(state);
    } else if (state.readyMarkers.some(marker => trimmed.includes(marker))) {
      const child = state.process;
      const supervisionReady = child?.serverProcessHandle?.supervisionReady;
      state.startupOutcome = 'ready-pending-supervision';
      if (!supervisionReady || typeof supervisionReady.then !== 'function') {
        state.startupOutcome = 'fatal';
        state.status = 'error';
        emitServerStatus(state);
        try { child?.kill?.('SIGKILL'); } catch { /* exact child only */ }
      } else {
        Promise.resolve(supervisionReady).then(() => {
          if (state.process !== child || state.startupOutcome !== 'ready-pending-supervision') return;
          if (typeof child.serverProcessHandle?.isLive !== 'function' || !child.serverProcessHandle.isLive()) {
            state.startupOutcome = 'fatal';
            state.status = 'error';
            emitServerStatus(state);
            return;
          }
          state.startupOutcome = 'ready';
          state.status = 'running';
          emitServerStatus(state);
          startMetricsReporting(state);
          eventBus.emit('server-started', {
            instanceId: state.instanceId,
            pid: child.pid,
            targetPath: state.targetPath,
            port: state.port,
            maxRam: state.maxRam,
            loader: state.loader,
            runtime: state.runtime
          });
        }, () => {
          if (state.process !== child || state.startupOutcome !== 'ready-pending-supervision') return;
          state.startupOutcome = 'fatal';
          state.status = 'error';
          emitServerStatus(state);
        });
      }
    }
  }
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

function emitServerProcessOwnership(state, child, operationId) {
  if (!state || typeof state.instanceId !== 'string' || !state.instanceId ||
      !child || !Number.isSafeInteger(child.pid) || child.pid <= 0 ||
      typeof operationId !== 'string' || !operationId) {
    throw new Error('Managed server process ownership is invalid');
  }
  return requestServerProcessSupervision({
    eventBus,
    identity: { instanceId: state.instanceId, operationId, pid: child.pid },
    onFailure() {
      try { child.kill('SIGKILL'); } catch {
        // Exact-child termination is best effort; the active start lease remains fail-closed.
      }
    },
    required: isServerProcessSupervisionRequired()
  });
}

function managedRuntimeFromConfig(config) {
  if (config?.modpackManaged !== true) return null;
  try {
    return normalizeRuntimeTuple(config.runtime);
  } catch (cause) {
    const error = new Error('The managed server runtime is incomplete.', { cause });
    error.code = 'RUNTIME_INCOMPLETE';
    throw error;
  }
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

function releaseStartLease(state, startLease, operation) {
  try {
    startLease.release();
    return null;
  } catch (releaseError) {
    logger.error(`Server start lease release failed: ${releaseError.message}`, {
      category: 'server',
      instanceId: state.instanceId,
      data: {
        service: 'ServerManager',
        operation,
        errorType: releaseError.constructor.name,
        code: releaseError.code || null
      }
    });
    return releaseError;
  }
}

function releaseStartLeaseAfterClose(state, startLease, processHandle) {
  return Promise.resolve(processHandle.closed).then(
    (closeEvidence) => {
      const validExitCode = closeEvidence?.exitCode === null || Number.isSafeInteger(closeEvidence?.exitCode);
      const validSignal = closeEvidence?.signal === null ||
        (typeof closeEvidence?.signal === 'string' && closeEvidence.signal.length > 0);
      let confirmedNotLive = false;
      try { confirmedNotLive = processHandle.isLive() === false; } catch {
        // Invalid liveness evidence retains the lease fail-closed.
      }
      if (!closeEvidence || typeof closeEvidence !== 'object' || Array.isArray(closeEvidence) ||
          !validExitCode || !validSignal || !confirmedNotLive) {
        logger.error('Server process close evidence was invalid; retaining the start lease', {
          category: 'server',
          instanceId: state.instanceId,
          data: {
            service: 'ServerManager',
            operation: 'serverProcess.close.validate'
          }
        });
        return false;
      }
      return releaseStartLease(state, startLease, 'serverProcess.close.releaseLease') === null;
    },
    (error) => {
      logger.error('Server process close evidence failed; retaining the start lease', {
        category: 'server',
        instanceId: state.instanceId,
        data: {
          service: 'ServerManager',
          operation: 'serverProcess.close.await',
          errorType: error?.constructor?.name || 'Error',
          code: error?.code || null
        }
      });
      return false;
    }
  );
}

function trackProcessCloseBarrier(state, barrier) {
  state.processCloseBarrier = barrier;
  return barrier;
}

function attachProcessExitBarrier(state, child, closeBarrier, onFullyClosed) {
  let exitHandled = false;
  child.on('exit', (code, signal) => {
    if (exitHandled || state.process !== child) return;
    exitHandled = true;
    const wasManualShutdown = state.shutdownRequest === 'stop' || state.shutdownRequest === 'kill';
    const isNormalExit = wasManualShutdown || code === 0 || signal === 'SIGTERM' || signal === 'SIGINT';

    clearStateTimers(state);
    state.status = 'stopping';
    emitServerStatus(state);

    Promise.resolve(closeBarrier).then((released) => {
      if (released !== true || state.process !== child) return;
      state.process = null;
      state.status = 'stopped';
      state.startMs = null;
      state.shutdownRequest = null;
      state.playersInfo = { count: 0, names: [] };
      if (state.processCloseBarrier === closeBarrier) state.processCloseBarrier = null;
      emitServerStatus(state);
      onFullyClosed({ code, isNormalExit, signal });
    }, () => {
      // A rejected or invalid close barrier retains the stopping state fail-closed.
    });
  });
}

function reportStartFailure(state, startLease, targetPath, error, { releaseLease = true } = {}) {
  let reportedError = error;
  if (releaseLease) {
    const releaseError = releaseStartLease(state, startLease, 'startMinecraftServer.failure.releaseLease');
    if (releaseError) reportedError = releaseError;
  }
  clearStateTimers(state);
  state.process = null;
  state.status = 'error';
  state.startMs = null;
  emitServerStatus(state);
  emitServerLog(state, `[ERROR] ${reportedError.message}`);

  logger.error(`Server start failed: ${reportedError.message}`, {
    category: 'server',
    instanceId: state.instanceId,
    data: {
      service: 'ServerManager',
      operation: 'startMinecraftServer',
      targetPath,
      errorType: reportedError.constructor.name,
      code: reportedError.code || null
    }
  });

  return {
    success: false,
    instanceId: state.instanceId,
    error: reportedError.message || 'Server failed to start.',
    code: reportedError.code || 'SERVER_START_FAILED',
    details: reportedError.details || null
  };
}

function adoptValidatedLifecycleProcess(request) {
  const allowedKeys = new Set([
    'eventId', 'handoff', 'instanceId', 'jobId', 'maxRam', 'port', 'runtime', 'serverPath'
  ]);
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some(key => !allowedKeys.has(key)) ||
      typeof request.eventId !== 'string' || typeof request.jobId !== 'string' ||
      request.eventId !== `modpack-runtime-handoff:${request.jobId}` ||
      typeof request.instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.instanceId) ||
      typeof request.serverPath !== 'string' || !request.serverPath || !request.handoff ||
      typeof request.handoff !== 'object') {
    throw new Error('Validated lifecycle handoff is invalid');
  }
  const { processHandle, startLease } = request.handoff;
  if (!processHandle || !processHandle.closed || typeof processHandle.closed.then !== 'function') {
    throw new Error('Validated lifecycle handoff cannot be proven');
  }
  const existingAdoption = lifecycleAdoptions.get(request.eventId);
  if (existingAdoption) {
    if (existingAdoption.instanceId !== request.instanceId || existingAdoption.serverPath !== request.serverPath ||
        !existingAdoption.processHandle.isLive()) throw new Error('Validated lifecycle handoff is stale');
    return existingAdoption.result;
  }

  const child = processHandle?.child;
  if (!processHandle || typeof processHandle.isLive !== 'function' || processHandle.isLive() !== true ||
      processHandle.publishEvents !== false || !Number.isSafeInteger(processHandle.pid) || processHandle.pid <= 0 ||
      !processHandle.supervisionReady || typeof processHandle.supervisionReady.then !== 'function' ||
      !child || child.pid !== processHandle.pid || !child.stdout || !child.stderr || !child.stdin ||
      typeof child.on !== 'function' || !startLease || startLease.kind !== 'start' ||
      startLease.operation !== 'server-health-live' || startLease.operationId !== processHandle.operationId ||
      startLease.instanceId !== request.instanceId || startLease.serverPath !== request.serverPath ||
      typeof startLease.assertOwnedPath !== 'function' || typeof startLease.release !== 'function') {
    throw new Error('Validated lifecycle handoff cannot be proven');
  }
  startLease.assertOwnedPath(request.serverPath);
  if (Array.from(serverStates.values()).some(item => item.process === child ||
      (item.process && (item.instanceId === request.instanceId || item.targetPath === request.serverPath)))) {
    throw new Error('A different managed process already owns this server');
  }
  const state = getOrCreateState({ instanceId: request.instanceId, targetPath: request.serverPath });
  if (state.process) throw new Error('A managed process already owns this server');
  const launchPlan = processHandle.launchPlan;
  if (!launchPlan || typeof launchPlan !== 'object' || !Array.isArray(launchPlan.readyMarkers) ||
      !Array.isArray(launchPlan.fatalMarkers) || !launchPlan.runtime) {
    throw new Error('Validated lifecycle launch evidence is incomplete');
  }
  const config = readServerConfig(request.serverPath, buildConfigDefaultsFromStore()) || buildConfigDefaultsFromStore();
  const port = Number.isSafeInteger(request.port) && request.port > 0 && request.port <= 65535
    ? request.port : toNumber(config.port, 25565);
  const maxRam = typeof request.maxRam === 'number' && Number.isFinite(request.maxRam) && request.maxRam > 0
    ? request.maxRam : toNumber(config.maxRam, 4);
  const runtime = request.runtime || launchPlan.runtime;

  state.targetPath = request.serverPath;
  state.port = port;
  state.maxRam = maxRam;
  state.loader = launchPlan.loader;
  state.status = 'running';
  state.startMs = Date.now();
  state.shutdownRequest = null;
  state.playersInfo = { count: 0, names: [] };
  state.cloudSyncWarningSent = false;
  state.stdoutBuffer = '';
  state.lastLine = '';
  state.readyMarkers = [...launchPlan.readyMarkers];
  state.fatalMarkers = [...launchPlan.fatalMarkers];
  state.runtime = runtime;
  state.startupOutcome = 'ready';
  state.process = child;
  monitorServerInput(state, child);

  child.serverProcessHandle = processHandle;
  const processCloseBarrier = trackProcessCloseBarrier(
    state,
    releaseStartLeaseAfterClose(state, startLease, processHandle)
  );
  child.serverInfo = {
    id: processHandle.operationId,
    instanceId: state.instanceId,
    port,
    maxRam,
    startTime: state.startMs,
    targetPath: state.targetPath,
    loader: launchPlan.loader,
    loaderVersion: runtime.loaderVersion,
    minecraftVersion: runtime.minecraftVersion,
    jar: launchPlan.jar || null,
    launchType: launchPlan.type,
    cwd: launchPlan.cwd,
    runtime,
    readyMarkers: [...launchPlan.readyMarkers],
    fatalMarkers: [...launchPlan.fatalMarkers]
  };

  attachProcessExitBarrier(state, child, processCloseBarrier, ({ code, isNormalExit, signal }) => {
    lifecycleAdoptions.delete(request.eventId);
    if (isNormalExit) eventBus.emit('server-normal-exit', {
      instanceId: state.instanceId,
      operationId: processHandle.operationId,
      pid: child.pid
    });
    else {
      eventBus.emit('server-crashed', {
        instanceId: state.instanceId,
        operationId: processHandle.operationId,
        pid: child.pid,
        serverInfo: { targetPath: state.targetPath, port: state.port, maxRam: state.maxRam, loader: state.loader },
        exitCode: code,
        signal
      });
    }
  });
  const adoptionSupervision = emitServerProcessOwnership(state, child, processHandle.operationId);

  child.stdout.on('data', chunk => {
    state.stdoutBuffer += chunk.toString();
    const lines = state.stdoutBuffer.split(/\r?\n/);
    state.stdoutBuffer = lines.pop() || '';
    lines.forEach(line => handleLogLine(state, line));
  });
  child.stdout.on('end', () => {
    if (state.stdoutBuffer.trim()) handleLogLine(state, state.stdoutBuffer);
    state.stdoutBuffer = '';
  });
  child.stderr.on('data', chunk => emitServerLog(state, `[STDERR] ${chunk.toString().trimEnd()}`));
  child.on('error', error => emitServerLog(state, `[ERROR] Server process error: ${error.message}`));
  clearListInterval(state);
  state.listInterval = setInterval(() => {
    if (state.process && !state.process.killed && !state.intensivePlayerCheckMode) sendListCommand(state);
  }, 120000);
  startMetricsReporting(state);
  emitServerStatus(state);
  Promise.all([processHandle.supervisionReady, adoptionSupervision.ready]).then(() => {
    if (state.process !== child || !processHandle.isLive()) return;
    eventBus.emit('server-started', {
      instanceId: state.instanceId,
      pid: child.pid,
      targetPath: state.targetPath,
      port: state.port,
      maxRam: state.maxRam,
      loader: state.loader,
      runtime: state.runtime
    });
  }, () => {
    try { child.kill('SIGKILL'); } catch { /* exact adopted child only */ }
  });
  const result = Object.freeze({ adopted: true, instanceId: state.instanceId, pid: child.pid });
  lifecycleAdoptions.set(request.eventId, {
    instanceId: state.instanceId,
    processHandle,
    result,
    serverPath: state.targetPath
  });
  return result;
}

async function startMinecraftServer(targetPathOrOptions, port, maxRam) {
  const args = normalizeStartArguments(targetPathOrOptions, port, maxRam);
  const { targetPath, instanceId: requestedInstanceId } = args;

  if (!targetPath) {
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

  let startLease;
  try {
    startLease = await getServerMutationCoordinator().acquireStart(
      { instanceId, serverPath: targetPath },
      {
        operation: 'server-start',
        operationId: `server-start-${crypto.randomUUID()}`,
        parentMutationLease: getCurrentServerMutationLease()
      }
    );
  } catch (error) {
    logger.error(`Server start gate rejected the request: ${error.message}`, {
      category: 'server',
      instanceId: state.instanceId,
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer.acquireStart',
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

  const startServerWithinLease = async () => {
    if (!fs.existsSync(targetPath)) {
      startLease.release();
      return {
        success: false,
        error: 'Invalid server path',
        code: 'INVALID_SERVER_PATH'
      };
    }

    const defaults = buildConfigDefaultsFromStore();
    const config = readServerConfig(targetPath, defaults) || defaults;
    const managedRuntime = managedRuntimeFromConfig(config);
    const minecraftVersion = managedRuntime?.minecraftVersion || config.version ||
      detectMinecraftVersion(targetPath) || '1.20.1';
    const loaderInfo = managedRuntime ? null : resolveServerLoader(targetPath);
    const loader = managedRuntime?.loaderFamily ||
      normalizeLoaderName(config.loader || loaderInfo.loader || 'vanilla');
    const loaderVersion = managedRuntime?.loaderVersion ||
      config.loaderVersion || config.fabric || loaderInfo.loaderVersion || null;

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
    state.readyMarkers = [];
    state.fatalMarkers = [];
    state.runtime = null;
    state.startupOutcome = null;

    emitServerStatus(state);
    emitServerLog(state, `[INFO] Preparing ${loader} server startup...`);

    let child = null;
    let processHandle = null;
    try {
      syncServerPort(targetPath, state.port, config.networkAccess || 'pack-default');

      const javaRequirements = await ensureJavaReadyForServer(targetPath, minecraftVersion);
      const javaPath = javaRequirements.javaPath;
      if (managedRuntime && javaRequirements.requiredJavaVersion !== managedRuntime.javaMajor) {
        const error = new Error('The managed server Java runtime does not match the prepared runtime.');
        error.code = 'RUNTIME_INCOMPLETE';
        throw error;
      }
      const runtimeTuple = managedRuntime || {
        minecraftVersion,
        loaderFamily: loader,
        loaderVersion: loaderVersion || minecraftVersion,
        javaMajor: javaRequirements.requiredJavaVersion,
        os: 'win32',
        architecture: 'x64'
      };
      const runtimeValidation = managedRuntime
        ? await runManagedRuntimeVerificationWorker({ targetPath, runtime: runtimeTuple })
        : null;
      const serverIdentifier = `server-${crypto.randomUUID()}`;
      try {
        processHandle = launchServerProcess({
          serverPath: targetPath,
          instanceId: state.instanceId,
          runtime: runtimeTuple,
          javaPath,
          maxRam: state.maxRam,
          operationId: serverIdentifier,
          publishEvents: true,
          onLine() {},
          ...(runtimeValidation ? { runtimeValidation } : {})
        });
      } catch (error) {
        if (error?.code === 'HEALTH_CHECK_FAILED') {
          throw new Error('Server process failed to launch', { cause: error });
        }
        throw error;
      }
      child = processHandle.child;
      const processCloseBarrier = trackProcessCloseBarrier(
        state,
        releaseStartLeaseAfterClose(state, startLease, processHandle)
      );
      const launchPlan = processHandle.launchPlan;
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

      state.process = child;
      monitorServerInput(state, child);
      state.startMs = Date.now();
      state.loader = launchPlan.loader;
      state.readyMarkers = [...launchPlan.readyMarkers];
      state.fatalMarkers = [...launchPlan.fatalMarkers];
      state.runtime = launchPlan.runtime;
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
        launchType: launchPlan.type,
        cwd: launchPlan.cwd,
        runtime: launchPlan.runtime,
        readyMarkers: [...launchPlan.readyMarkers],
        fatalMarkers: [...launchPlan.fatalMarkers]
      };
      child.serverProcessHandle = processHandle;

      attachProcessExitBarrier(state, child, processCloseBarrier, ({ code, isNormalExit, signal }) => {
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
            operationId: serverIdentifier,
            pid: child.pid,
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
          eventBus.emit('server-normal-exit', {
            instanceId: state.instanceId,
            operationId: serverIdentifier,
            pid: child.pid
          });
        }
      });
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
        if (state.status === 'starting') {
          for (const line of text.split(/\r?\n/).filter(Boolean)) {
            const fatalMarker = state.fatalMarkers.find(marker => line.includes(marker));
            if (fatalMarker) {
              state.startupOutcome = 'fatal';
              state.status = 'error';
              emitServerStatus(state);
              break;
            }
          }
        }
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

      startLease.markRunning({ pid: child.pid });

      clearListInterval(state);
      state.listInterval = setInterval(() => {
        if (state.process && !state.process.killed && !state.intensivePlayerCheckMode) {
          sendListCommand(state);
        }
      }, 120000);

      return {
        success: true,
        instanceId: state.instanceId,
        pid: child.pid,
        javaPath,
        jar: launchPlan.jar || null,
        loader
      };
    } catch (error) {
      const releaseLease = processHandle === null;
      if (processHandle) {
        try {
          await processHandle.stopFully({
            gracefulTimeoutMs: FAILED_START_STOP_TIMEOUT_MS,
            killTimeoutMs: FAILED_START_STOP_TIMEOUT_MS
          });
        } catch (cleanupError) {
          logger.error(`Failed server start cleanup could not prove process close: ${cleanupError.message}`, {
            category: 'server',
            instanceId: state.instanceId,
            data: {
              service: 'ServerManager',
              operation: 'startMinecraftServer.cleanup',
              errorType: cleanupError.constructor.name,
              code: cleanupError.code || null
            }
          });
        }
      }
      return reportStartFailure(state, startLease, targetPath, error, { releaseLease });
    }
  };

  try {
    return await runWithServerMutationLease(startLease, startServerWithinLease);
  } catch (error) {
    return reportStartFailure(state, startLease, targetPath, error);
  }
}

function stopMinecraftServer(selector = {}) {
  const state = getState(selector);
  if (!state || !state.process) {
    return false;
  }

  state.shutdownRequest = 'stop';
  state.status = 'stopping';
  clearStateTimers(state);
  emitServerStatus(state);

  return writeServerInput(state, 'stop\n', { allowDuringShutdown: true });
}

function killMinecraftServer(selector = {}) {
  const state = getState(selector);
  if (!state || !state.process) {
    return false;
  }

  const child = state.process;
  state.shutdownRequest = 'kill';
  state.status = 'stopping';
  clearStateTimers(state);
  emitServerStatus(state);

  try {
    return child.kill('SIGKILL') !== false;
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

  if (!writeServerInput(state, `${command}\n`)) {
    return false;
  }
  safeSend('command-response', {
    instanceId: state.instanceId,
    command
  });
  return true;
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

async function handleServerStartRequest(payload = {}) {
  const result = await startMinecraftServer(payload);
  if (!result?.success) {
    const targetPath = payload && typeof payload === 'object' ? payload.targetPath : null;
    const instanceId = payload && typeof payload === 'object' ? payload.instanceId : null;
    const message = result?.error || 'Unknown server start failure';

    logger.error(`Auto-restart server start failed: ${message}`, {
      category: 'server',
      instanceId: result?.instanceId || instanceId || 'system',
      data: {
        service: 'ServerManager',
        operation: 'handleServerStartRequest',
        targetPath,
        code: result?.code || null,
        details: result?.details || null
      }
    });

    safeSend('server-log', {
      instanceId: result?.instanceId || instanceId || null,
      targetPath,
      line: `[ERROR] Auto-restart failed to start server: ${message}`
    });
  }

  return result;
}

eventBus.on('request-server-start', (payload) => {
  handleServerStartRequest(payload).catch((error) => {
    logger.error(`Auto-restart request failed: ${error.message}`, {
      category: 'server',
      instanceId: payload?.instanceId || 'system',
      data: {
        service: 'ServerManager',
        operation: 'request-server-start',
        targetPath: payload?.targetPath || null,
        errorType: error.constructor.name
      }
    });

    safeSend('server-log', {
      instanceId: payload?.instanceId || null,
      targetPath: payload?.targetPath || null,
      line: `[ERROR] Auto-restart request failed: ${error.message}`
    });
  });
});

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

function waitForProcessCloseBarrier(barrier, timeoutMs) {
  if (!barrier || typeof barrier.then !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result === true);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    Promise.resolve(barrier).then(finish, () => finish(false));
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
    const processCloseBarrier = state.processCloseBarrier;
    const result = {
      instanceId: state.instanceId,
      targetPath: state.targetPath,
      stopped: false,
      forced: false,
      alreadyStopped: !state.process
    };

    if (!state.process) {
      const fullyClosed = processCloseBarrier
        ? await waitForProcessCloseBarrier(processCloseBarrier, killTimeoutMs)
        : true;
      if (disposeStateAfterStop && fullyClosed) {
        disposeServerState({ instanceId: state.instanceId, targetPath: state.targetPath });
      }
      result.stopped = fullyClosed;
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

    const fullyClosed = (stopped || !state.process)
      ? await waitForProcessCloseBarrier(processCloseBarrier, killTimeoutMs)
      : false;

    if (disposeStateAfterStop && fullyClosed && !state.process) {
      disposeServerState({ instanceId: state.instanceId, targetPath: state.targetPath });
    }

    result.stopped = fullyClosed;
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
  adoptValidatedLifecycleProcess,
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
  handleServerStartRequest,
  killAllMinecraftServers,
  disposeServerState,
  clearIntervals,
  sendMetricsUpdate
};
