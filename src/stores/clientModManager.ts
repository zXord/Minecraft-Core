import { writable } from 'svelte/store';
import { serverManagedFiles } from './modStore.js';

export const connectionStatus = writable('disconnected');
export const serverMods = writable([]);
export const requiredMods = writable([]);
export const optionalMods = writable([]);
export const allClientMods = writable([]);
export const installedModsInfo = writable([]);
export const modSyncStatus = writable(null);
export const isLoadingMods = writable(false);
export const lastModCheck = writable(null as Date | null);
export const acknowledgedDeps = writable(new Set<string>());

export function updateServerManagedFiles(action: 'add' | 'remove', mods: any[]) {
  serverManagedFiles.update(currentSet => {
    const newSet = new Set(currentSet);
    if (action === 'remove') {
      mods.forEach(mod => {
        const modName = typeof mod === 'string' ? mod : mod.fileName || mod.name;
        newSet.delete(modName.toLowerCase());
      });
    } else if (action === 'add') {
      mods.forEach(mod => {
        const modName = typeof mod === 'string' ? mod : mod.fileName || mod.name;
        newSet.add(modName.toLowerCase());
      });
    }
    return newSet;
  });
}
