import { get } from 'svelte/store';
import {
  expandedInstalledMod,
  installedModInfo,
  modsWithUpdates,
  isCheckingUpdates,
  successMessage,
  errorMessage
} from '../../stores/modStore.js';
import { fetchModVersions, checkForUpdates } from './modAPI.js';
import { checkDependencyCompatibility } from './modCompatibility.js';

export async function toggleInstalledVersionSelector(modName, cache, modStatusMap) {
  const isExpanded = get(expandedInstalledMod) === modName;
  if (isExpanded) {
    expandedInstalledMod.set(null);
    return;
  }
  expandedInstalledMod.set(modName);

  const modInfo = get(installedModInfo).find(m => m.fileName === modName);
  if (modInfo && modInfo.projectId && !cache[modInfo.projectId]) {
    try {
      const versions = await fetchModVersions(modInfo.projectId);
      cache[modInfo.projectId] = versions;
      if (!get(isCheckingUpdates)) {
        checkForUpdates();
      }
    } catch (error) {
      console.error(`Failed to fetch versions for ${modName}:`, error);
    }
  }
}

export function clearModStatus(modName, modStatusMap) {
  let changed = false;
  for (const key of [...modStatusMap.keys()]) {
    if (key.startsWith(`${modName}:`)) {
      modStatusMap.delete(key);
      changed = true;
    }
  }
  return changed;
}

export async function updateInstalledMod(modName, projectId, versionId, cache, modStatusMap, dispatch) {
  if (!projectId || !versionId) return;
  const versions = cache[projectId];
  if (!versions) return;
  const version = versions.find(v => v.id === versionId);
  if (!version) return;
  const modInfo = get(installedModInfo).find(m => m.fileName === modName);
  if (modInfo && modInfo.versionNumber === version.versionNumber) return;
  if (version.dependencies && version.dependencies.length > 0) {
    const issues = await checkDependencyCompatibility(version.dependencies);
    if (issues.length > 0) {
      dispatch('compatibility-warning', {
        issues,
        modToUpdate: { id: projectId, name: modName, selectedVersionId: versionId, source: 'modrinth' }
      });
      return;
    }
  }
  try {
    const statusKey = `${modName}:${versionId}`;
    modStatusMap.set(statusKey, 'updating');
    dispatch('updateMod', { modName, projectId, versionId, version });
  } catch (err) {
    const statusKey = `${modName}:${versionId}`;
    modStatusMap.set(statusKey, 'error');
    setTimeout(() => modStatusMap.delete(statusKey), 3000);
  }
}

export function updateModToLatest(modName, dispatch) {
  const updateInfo = get(modsWithUpdates).get(modName);
  const modInfo = get(installedModInfo).find(m => m.fileName === modName);
  if (!updateInfo || !modInfo || !modInfo.projectId) return;
  if (updateInfo.dependencies && updateInfo.dependencies.length > 0) {
    checkDependencyCompatibility(updateInfo.dependencies).then(issues => {
      if (issues.length > 0) {
        dispatch('compatibility-warning', {
          issues,
          modToUpdate: {
            id: modInfo.projectId,
            name: modName,
            selectedVersionId: updateInfo.id,
            source: 'modrinth'
          }
        });
      } else {
        proceedWithUpdate(modName, modInfo.projectId, updateInfo.id, updateInfo, dispatch);
      }
    });
  } else {
    proceedWithUpdate(modName, modInfo.projectId, updateInfo.id, updateInfo, dispatch);
  }
}

export function proceedWithUpdate(modName, projectId, versionId, version, dispatch) {
  const statusKey = `${modName}:${versionId}`;
  modsWithUpdates.update(u => { u.delete(modName); return u; });
  dispatch('updateMod', { modName, projectId, versionId, version });
  successMessage.set('Updating mod...');
}
