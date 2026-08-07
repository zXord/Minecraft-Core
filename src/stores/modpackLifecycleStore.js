import { writable } from 'svelte/store';
import { modpackApi } from '../utils/modpacks/modpackApi.js';

const TERMINAL_PHASES = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);

function createLifecycleStore() {
  const { subscribe, update, set } = writable({
    serverId: null,
    inspection: null,
    reviewedPlan: null,
    job: null,
    logs: [],
    loading: false,
    error: null
  });
  let cleanups = [];
  let pollTimer = null;

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function refreshJob(jobId) {
    if (!jobId) return null;
    const job = await modpackApi.getJob(jobId);
    update(state => ({ ...state, job, error: null }));
    stopPolling();
    if (!TERMINAL_PHASES.has(job?.phase)) {
      pollTimer = setTimeout(() => refreshJob(jobId).catch(error => update(state => ({ ...state, error }))), 1500);
    }
    return job;
  }

  function connect(serverId) {
    destroyListeners();
    update(state => ({ ...state, serverId }));
    cleanups = [
      modpackApi.onJobProgress(event => {
        if (!event || (serverId && event.serverId && event.serverId !== serverId)) return;
        update(state => ({ ...state, job: state.job?.jobId === event.jobId ? { ...state.job, ...event } : state.job }));
      }),
      modpackApi.onJobLog(event => {
        if (!event || (serverId && event.serverId && event.serverId !== serverId)) return;
        update(state => ({ ...state, logs: [...state.logs, event].slice(-1000) }));
      }),
      modpackApi.onStateChanged(event => {
        if (event?.instanceId === serverId || event?.serverId === serverId) update(state => ({ ...state, stateChangedAt: Date.now() }));
      })
    ];
  }

  function destroyListeners() {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    stopPolling();
  }

  async function inspect(request) {
    update(state => ({ ...state, loading: true, error: null }));
    try {
      const inspection = await modpackApi.inspect(request);
      update(state => ({ ...state, inspection, reviewedPlan: null, loading: false }));
      return inspection;
    } catch (error) {
      update(state => ({ ...state, loading: false, error }));
      throw error;
    }
  }

  async function preflight(request) {
    update(state => ({ ...state, loading: true, error: null }));
    try {
      const reviewedPlan = await modpackApi.preflight(request);
      update(state => ({ ...state, reviewedPlan, loading: false }));
      return reviewedPlan;
    } catch (error) {
      update(state => ({ ...state, loading: false, error }));
      throw error;
    }
  }

  async function startOperation({ planId, planFingerprint, choices }) {
    update(state => ({ ...state, loading: true, error: null, logs: [] }));
    try {
      const job = await modpackApi.startOperation({ planId, planFingerprint, choices });
      update(state => ({ ...state, job, loading: false }));
      await refreshJob(job.jobId);
      return job;
    } catch (error) {
      update(state => ({ ...state, loading: false, error }));
      throw error;
    }
  }

  function reset() {
    destroyListeners();
    set({ serverId: null, inspection: null, reviewedPlan: null, job: null, logs: [], loading: false, error: null });
  }

  return { subscribe, connect, inspect, preflight, startOperation, refreshJob, destroyListeners, reset };
}

export const modpackLifecycleStore = createLifecycleStore();
