import { writable } from 'svelte/store';
import { modpackApi } from '../utils/modpacks/modpackApi.js';

const INITIAL_FILTERS = Object.freeze({
  query: '',
  categories: [],
  gameVersion: '',
  loader: '',
  channel: 'release',
  serverCompatibility: 'compatible',
  sort: 'updated',
  offset: 0,
  limit: 20
});

function compactRequest(filters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => {
    if (value === '' || value === null || value === undefined) return false;
    return !Array.isArray(value) || value.length > 0;
  }));
}

function createCatalogStore() {
  const { subscribe, update, set } = writable({
    filters: { ...INITIAL_FILTERS },
    items: [],
    pagination: { offset: 0, limit: 20, total: 0 },
    selectedProject: null,
    versions: [],
    loading: false,
    error: null
  });
  let requestId = 0;

  async function search(patch = {}) {
    const currentRequest = ++requestId;
    let request;
    update(state => {
      const filters = { ...state.filters, ...patch };
      request = compactRequest({ ...filters, channel: undefined });
      return { ...state, filters, loading: true, error: null };
    });
    try {
      const result = await modpackApi.searchCatalog(request);
      if (currentRequest !== requestId) return result;
      update(state => ({ ...state, items: result?.items || [], pagination: result?.pagination || state.pagination, loading: false }));
      return result;
    } catch (error) {
      if (currentRequest === requestId) update(state => ({ ...state, loading: false, error }));
      throw error;
    }
  }

  async function selectProject(project) {
    update(state => ({ ...state, selectedProject: project, versions: [], loading: true, error: null }));
    try {
      const [details, versions] = await Promise.all([
        modpackApi.getProject(project.projectId),
        modpackApi.listVersions({
          projectId: project.projectId,
          channels: ['release', 'beta', 'alpha']
        })
      ]);
      update(state => ({ ...state, selectedProject: { ...project, ...details }, versions: versions || [], loading: false }));
      return { details, versions };
    } catch (error) {
      update(state => ({ ...state, loading: false, error }));
      throw error;
    }
  }

  function reset() {
    requestId += 1;
    set({
      filters: { ...INITIAL_FILTERS }, items: [], pagination: { offset: 0, limit: 20, total: 0 },
      selectedProject: null, versions: [], loading: false, error: null
    });
  }

  return { subscribe, search, selectProject, reset };
}

export const modpackCatalogStore = createCatalogStore();
