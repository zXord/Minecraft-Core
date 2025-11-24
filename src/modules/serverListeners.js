import { get } from 'svelte/store';
import { serverState, updateServerStatus } from '../stores/serverState.js';
import { playerState } from '../stores/playerState.js';
import { isRestarting } from '../stores/restartState.js';

// Map the raw status payload into our canonical set of statuses
const STATUS_MAP = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  stopping: 'Stopping',
  restarting: 'Starting', // Treat restarting as part of the startup path
  error: 'Error',
  failed: 'Error',
  unknown: 'Unknown'
};

const METRICS_STALE_MS = 12000; // If we saw metrics recently, distrust "stopped" blips
let lastMetricsReceivedAt = 0;
let pendingStatusVerification = null;
let fallbackStatusOnFailure = null; // Use the incoming status if verification IPC fails

function normalizeStatusPayload(payload) {
  if (typeof payload === 'string') {
    const mapped = STATUS_MAP[payload.toLowerCase()];
    return { status: mapped || 'Unknown', confidence: mapped ? 'high' : 'low' };
  }

  if (payload && typeof payload === 'object') {
    if (typeof payload.isRunning === 'boolean') {
      return { status: payload.isRunning ? 'Running' : 'Stopped', confidence: 'high' };
    }
    if (typeof payload.status === 'string') {
      const mapped = STATUS_MAP[payload.status.toLowerCase()];
      return { status: mapped || 'Unknown', confidence: mapped ? 'medium' : 'low' };
    }
  }

  return { status: 'Unknown', confidence: 'low' };
}

async function verifyServerStatus(options = {}) {
  if (options.fallbackStatus) {
    fallbackStatusOnFailure = options.fallbackStatus;
  }
  if (pendingStatusVerification) return pendingStatusVerification;

  pendingStatusVerification = window.electron.invoke('get-server-status')
    .then(result => {
      const verifiedStatus = result?.status === 'running' ? 'Running' : 'Stopped';
      updateServerStatus(verifiedStatus);

      if (verifiedStatus === 'Stopped') {
        resetMetricsAndPlayers();
      }
      return verifiedStatus;
    })
    .catch(() => {
      if (fallbackStatusOnFailure) {
        updateServerStatus(fallbackStatusOnFailure);
        if (fallbackStatusOnFailure === 'Stopped') {
          resetMetricsAndPlayers();
        }
        return fallbackStatusOnFailure;
      }
      return get(serverState).status;
    })
    .finally(() => {
      pendingStatusVerification = null;
      fallbackStatusOnFailure = null;
    });

  return pendingStatusVerification;
}

function resetMetricsAndPlayers() {
  serverState.update(state => ({
    ...state,
    cpuLoad: 0,
    memUsedMB: 0,
    uptime: '0h 0m 0s'
  }));
  playerState.update(state => ({ ...state, count: 0, onlinePlayers: [] }));

  setTimeout(() => {
    const portInput = document.getElementById('port-input');
    const ramInput = document.getElementById('ram-input');
    const portLabel = document.getElementById('port-label');
    const ramLabel = document.getElementById('ram-label');
    if (portInput && portInput instanceof HTMLInputElement) {
      portInput.disabled = false;
      portInput.classList.remove('disabled-input');
    }
    if (ramInput && ramInput instanceof HTMLInputElement) {
      ramInput.disabled = false;
      ramInput.classList.remove('disabled-input');
    }
    if (portLabel) portLabel.classList.remove('disabled');
    if (ramLabel) ramLabel.classList.remove('disabled');
  }, 200);
}

export function setupIpcListeners() {
  let restarting = false;
  isRestarting.subscribe(v => restarting = v);

  window.electron.removeAllListeners('server-status');
  window.electron.removeAllListeners('metrics-update');

  window.electron.on('server-status', status => {
    const { status: normalizedStatus, confidence } = normalizeStatusPayload(status);

    if (restarting) {
      if (normalizedStatus === 'Running') {
        isRestarting.set(false);
      }
      if (normalizedStatus === 'Stopped') {
        return;
      }
    }

    // If we get an unknown or low-confidence stopped status while metrics were just flowing, verify before flipping to stopped.
    const metricsRecently = Date.now() - lastMetricsReceivedAt < METRICS_STALE_MS;
    const stopLooksSuspicious = normalizedStatus === 'Stopped' && (confidence === 'low' || metricsRecently);
    if (normalizedStatus === 'Unknown' || stopLooksSuspicious) {
      verifyServerStatus(stopLooksSuspicious ? { fallbackStatus: normalizedStatus } : undefined);
      return; // Avoid showing a wrong status while we double-check.
    }

    updateServerStatus(normalizedStatus);

    if (normalizedStatus === 'Stopped') {
      resetMetricsAndPlayers();
    }
  });

  window.electron.on('metrics-update', metrics => {
    lastMetricsReceivedAt = Date.now();

    serverState.update(state => ({
      ...state,
      cpuLoad: metrics.cpuPct,
      memUsedMB: metrics.memUsedMB,
      maxRamMB: metrics.maxRamMB,
      uptime: metrics.uptime
    }));

    // If metrics are arriving but status is not marked as running, promote it to running.
    const hasActivity = (metrics?.cpuPct ?? 0) > 0 || (metrics?.memUsedMB ?? 0) > 0 || (metrics?.uptime && metrics.uptime !== '0h 0m 0s');
    if (hasActivity && get(serverState).status !== 'Running') {
      updateServerStatus('Running');
    }
  });
}
