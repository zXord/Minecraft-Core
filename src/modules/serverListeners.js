import { serverState } from '../stores/serverState.js';
import { playerState } from '../stores/playerState.js';
import { isRestarting } from '../stores/restartState.js';

export function setupIpcListeners() {
  let restarting = false;
  isRestarting.subscribe(v => restarting = v);

  window.electron.removeAllListeners('server-status');
  window.electron.removeAllListeners('metrics-update');

  window.electron.on('server-status', status => {
    if (restarting) {
      if (status === 'running') {
        isRestarting.set(false);
      }
      if (status === 'stopped') {
        return;
      }
    }
    const normalizedStatus = status === 'running' ? 'Running' : 'Stopped';
    serverState.update(state => ({ ...state, status: normalizedStatus }));
    if (normalizedStatus === 'Stopped') {
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
  });

  window.electron.on('metrics-update', metrics => {
    serverState.update(state => ({
      ...state,
      cpuLoad: metrics.cpuPct,
      memUsedMB: metrics.memUsedMB,
      maxRamMB: metrics.maxRamMB,
      uptime: metrics.uptime
    }));
  });
}
