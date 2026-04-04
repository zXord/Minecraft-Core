import { writable } from 'svelte/store';
import { fetchLatestMinecraftVersion } from '../utils/versionUtils.js';

function buildLatestVersionState({
  mc = null,
  loader = 'vanilla',
  loaderVersion = null,
  targetMc = null,
  targetLoaderVersion = null
} = {}) {
  return {
    mc,
    loader,
    loaderVersion,
    fabric: loader === 'fabric' ? loaderVersion : null,
    targetMc: targetMc || mc,
    targetLoaderVersion,
    targetFabric: loader === 'fabric' ? targetLoaderVersion : null
  };
}

async function fetchLatestLoaderVersion(loader, mcVersion) {
  if (!mcVersion || loader === 'vanilla' || typeof window === 'undefined' || !window?.electron?.invoke) {
    return null;
  }

  const result = await window.electron.invoke('get-loader-versions', {
    loader,
    mcVersion
  });

  if (result?.success && Array.isArray(result.versions) && result.versions.length > 0) {
    return result.versions[0] || null;
  }

  return null;
}

export const latestVersions = writable(buildLatestVersionState());

export async function refreshLatestVersions(currentMcVersion, currentLoader = 'vanilla') {
  const normalizedLoader = currentLoader || 'vanilla';

  try {
    const mc = await fetchLatestMinecraftVersion();
    const currentLookupMc = currentMcVersion || mc;
    const loaderVersion = await fetchLatestLoaderVersion(normalizedLoader, currentLookupMc);
    const targetMc = mc || currentLookupMc;
    const targetLoaderVersion = targetMc === currentLookupMc
      ? loaderVersion
      : await fetchLatestLoaderVersion(normalizedLoader, targetMc);

    const state = buildLatestVersionState({
      mc,
      loader: normalizedLoader,
      loaderVersion,
      targetMc,
      targetLoaderVersion
    });
    latestVersions.set(state);
    return state;
  } catch {
    const state = buildLatestVersionState({
      loader: normalizedLoader
    });
    latestVersions.set(state);
    return null;
  }
}
