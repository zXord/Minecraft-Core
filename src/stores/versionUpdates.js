import { writable } from 'svelte/store';
import { fetchLatestMinecraftVersion, fetchLatestFabricVersion } from '../utils/versionUtils.js';

export const latestVersions = writable({
  mc: null,
  fabric: null
});

export async function refreshLatestVersions(currentMcVersion) {
  try {
    const mc = await fetchLatestMinecraftVersion();
    const fabric = await fetchLatestFabricVersion(currentMcVersion || mc);
    latestVersions.set({ mc, fabric });
    return { mc, fabric };
  } catch (err) {
    console.error('Failed to refresh latest versions:', err);
    latestVersions.set({ mc: null, fabric: null });
    return null;
  }
}
