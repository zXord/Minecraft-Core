import { get } from 'svelte/store';
import { SvelteSet } from 'svelte/reactivity';
import {
  installedModIds,
  installedModInfo,
  serverManagedFiles,
  successMessage,
  errorMessage,
  removeServerManagedFiles
} from '../stores/modStore.js';
import {
  connectionStatus,
  serverMods,
  requiredMods,
  optionalMods,
  allClientMods,
  installedModsInfo,
  modSyncStatus,
  isLoadingMods,
  lastModCheck,
  acknowledgedDeps,
  updateServerManagedFiles
} from '../stores/clientModManager.js';
import { minecraftVersion } from '../stores/modStore.js';
import { safeInvoke } from './ipcUtils.js';
import { buildAuthHeaders, ensureSessionToken, getManagementBaseUrl, resolveManagementUrl } from './managementAuth.js';

interface Instance {
  serverIp?: string;
  serverPort?: string;
  serverProtocol?: string;
  path?: string;
  clientId?: string;
  clientName?: string;
  sessionToken?: string;
  inviteSecret?: string;
  managementCertFingerprint?: string;
}

export async function loadInstalledInfo(instance: Instance) {
  try {
    const info = await window.electron.invoke('get-client-installed-mod-info', instance.path);
    if (Array.isArray(info)) {
      installedModsInfo.set(info);
      const reqMods = get(requiredMods);
      const allMods = get(allClientMods) || [];
      const enrichedInfo = info.map(mod => {
        if (mod.projectId) return mod;
        const serverMod = [...reqMods, ...allMods].find(sm => sm.fileName === mod.fileName);
        if (serverMod && serverMod.projectId) {
          return { ...mod, projectId: serverMod.projectId };
        }
        return mod;
      });
      const projectIds = new SvelteSet(enrichedInfo.map(i => i.projectId).filter(Boolean));
      installedModIds.set(projectIds);
      installedModInfo.set(enrichedInfo);
    }
  } catch (err: any) {
    // Log error but continue - mod enrichment is not critical
    const logger = await import('./logger.js');
    logger.default.error('Failed to enrich installed mod information', {
      category: 'mods',
      data: {
        error: err.message,
        context: 'enrichInstalledMods'
      }
    });
  }
}

export async function loadModsFromServer(instance: Instance) {
  const baseUrl = getManagementBaseUrl(instance);
  if (!instance || !baseUrl) {
    serverManagedFiles.set(new SvelteSet());
    return;
  }
  isLoadingMods.set(true);
  try {
    const testUrl = resolveManagementUrl(instance, '/api/test');
    const testResponse = await fetch(testUrl, {
      method: 'GET',
      headers: buildAuthHeaders(instance),
      signal: AbortSignal.timeout(10000)
    }); // Increased timeout
    if (!testResponse.ok) {
      connectionStatus.set('disconnected');
      serverManagedFiles.set(new SvelteSet());
      return;
    }
    connectionStatus.set('connected');
    await ensureSessionToken(instance);
    const serverInfoUrl = resolveManagementUrl(instance, '/api/server/info');
    const serverInfoResponse = await fetch(serverInfoUrl, {
      method: 'GET',
      headers: buildAuthHeaders(instance),
      signal: AbortSignal.timeout(10000)
    }); // Increased timeout
    if (serverInfoResponse.ok) {
      const serverInfo = await serverInfoResponse.json();
      if (serverInfo.success) {
        if (serverInfo.minecraftVersion) {
          minecraftVersion.set(serverInfo.minecraftVersion);
        }
        requiredMods.set(serverInfo.requiredMods || []);
        allClientMods.set(serverInfo.allClientMods || []);
        const currentServerMods = new Set([
          ...serverInfo.requiredMods.map((m: any) => m.fileName.toLowerCase()),
          ...(serverInfo.allClientMods || []).map((m: any) => m.fileName.toLowerCase())
        ]);
        try {        const state = await window.electron.invoke('load-expected-mod-state', { clientPath: instance.path });
        if (state.success && Array.isArray(state.acknowledgedDeps)) {
          // Merge with existing acknowledged deps instead of overwriting
          acknowledgedDeps.update(currentSet => {
            const newSet = new Set(currentSet);
            state.acknowledgedDeps.forEach((dep: string) => {
              newSet.add(dep.toLowerCase());
            });
            return newSet;
          });
        }
        } catch {
          // ignore
        }
        serverManagedFiles.update((existing: SvelteSet<string>) => {
          const combined = new SvelteSet(existing);
          for (const mod of currentServerMods) combined.add(mod);
          return combined;
        });
        await loadInstalledInfo(instance);
        const modsUrl = resolveManagementUrl(instance, '/api/mods/list');
        const modsResponse = await fetch(modsUrl, {
          method: 'GET',
          headers: buildAuthHeaders(instance),
          signal: AbortSignal.timeout(5000)
        });
        if (modsResponse.ok) {
          const modsData = await modsResponse.json();
          if (modsData.success) {
            serverMods.set(modsData.mods.server || []);
            optionalMods.set(get(allClientMods).filter(mod => !get(requiredMods).some(r => r.fileName === mod.fileName)));
          }
        }
        if (instance.path) {
          await checkModSynchronization(instance);
          // Intentionally do NOT auto-download shaders/resource packs here.
          // Asset synchronization is now user-initiated from the Play tab, similar to mods.
        }
      }
    }
    lastModCheck.set(new Date());
  } catch (err: any) {
    connectionStatus.set('disconnected');
    serverManagedFiles.set(new SvelteSet());
    errorMessage.set('Failed to connect to server: ' + err.message);
    setTimeout(() => errorMessage.set(''), 5000);
  } finally {
    isLoadingMods.set(false);
  }
}

export async function checkModSynchronization(instance: Instance) {
  if (!instance?.path) return;
  try {
    const managedFiles = get(serverManagedFiles);
    const ackSet = get(acknowledgedDeps);
    const filteredRequired = get(requiredMods).filter(
      m => !ackSet.has(m.fileName.toLowerCase())
    );
    const filteredAll = get(allClientMods).filter(
      m => !ackSet.has(m.fileName.toLowerCase())
    );
    const result = await window.electron.invoke('minecraft-check-mods', {
      clientPath: instance.path,
      requiredMods: filteredRequired,
      allClientMods: filteredAll,
      serverManagedFiles: Array.from(managedFiles)
    });
    if (result.success) {
      modSyncStatus.set(result);
      try {
        const state = await window.electron.invoke('load-expected-mod-state', { clientPath: instance.path });        if (state.success && Array.isArray(state.acknowledgedDeps)) {
          // Merge with existing acknowledged deps instead of overwriting
          acknowledgedDeps.update(currentSet => {
            const newSet = new Set(currentSet);
            state.acknowledgedDeps.forEach((dep: string) => {
              newSet.add(dep.toLowerCase());
            });
            return newSet;
          });
        }
      } catch (error: any) {
        // Log error but continue - mod synchronization update is not critical
        const logger = await import('./logger.js');
        logger.default.debug('Failed to update mod synchronization state', {
          category: 'mods',
          data: {
            error: error.message,
            context: 'modSynchronizationUpdate'
          }
        });
      }
      if (result.successfullyRemovedMods && result.successfullyRemovedMods.length > 0) {
        updateServerManagedFiles('remove', result.successfullyRemovedMods);
      }
    } else {
      errorMessage.set(result.error || 'Failed to check mod synchronization.');
      setTimeout(() => errorMessage.set(''), 5000);
    }
  } catch {
    errorMessage.set('Failed to check mod synchronization.');
    setTimeout(() => errorMessage.set(''), 5000);
  }
}

export async function refreshInstalledMods(instance: Instance) {
  if (!instance?.path) return;
  await loadInstalledInfo(instance);
  await checkModSynchronization(instance);
}

export async function downloadRequiredMods(instance: Instance) {
  const reqMods = get(requiredMods);
  if (!instance.path || !reqMods.length) return;
  
  // Filter to only download mods that are actually missing or outdated
  const syncStatus = get(modSyncStatus);
  const modsToDownload = reqMods.filter(mod => {
    const isMissing = syncStatus?.missingMods?.includes(mod.fileName);
    const isOutdated = syncStatus?.outdatedMods?.some((update: any) => 
      update.fileName?.toLowerCase() === mod.fileName.toLowerCase()
    );
    return isMissing || isOutdated;
  });
  
  if (modsToDownload.length === 0) {
    successMessage.set('All required mods are already up to date');
    setTimeout(() => successMessage.set(''), 3000);
    return;
  }
  
  try {
    const result = await window.electron.invoke('minecraft-download-mods', {
      clientPath: instance.path,
      requiredMods: modsToDownload,
      allClientMods: get(allClientMods),
      serverInfo: { serverIp: instance.serverIp, serverPort: instance.serverPort, serverProtocol: instance.serverProtocol, sessionToken: instance.sessionToken }
    });
    if (result.success) {
      successMessage.set(`Successfully downloaded ${result.downloaded} required mods`);
      setTimeout(() => successMessage.set(''), 5000);
      if (result.downloadedFiles?.length) updateServerManagedFiles('add', result.downloadedFiles);
      if (result.removedMods?.length) updateServerManagedFiles('remove', result.removedMods);
      setTimeout(async () => {
        await checkModSynchronization(instance);
        await refreshInstalledMods(instance);
      }, 1500);
    } else {
      // Enhanced error message with more details
      let detailedError = `Failed to download mods: ${result.error || 'Unknown error'}`;
      if (result.failures && result.failures.length > 0) {
        const firstFailure = result.failures[0];
        detailedError += ` | First failure: ${firstFailure.fileName} - ${firstFailure.error}`;
      }
      errorMessage.set(detailedError);
      setTimeout(() => errorMessage.set(''), 8000);
    }
  } catch (err: any) {
    errorMessage.set('Error downloading mods: ' + err.message);
    setTimeout(() => errorMessage.set(''), 5000);
  }
}


export async function acknowledgeAllDependencies(instance: Instance) {
  const status = get(modSyncStatus);
  if (!instance?.path || !status?.acknowledgments) return;
  const acknowledgments = status.acknowledgments || [];
  if (!acknowledgments.length) return;
  try {
    for (const acknowledgment of acknowledgments) {
      const result = await window.electron.invoke('minecraft-acknowledge-dependency', {
        clientPath: instance.path,
        modFileName: acknowledgment.fileName
      });
      if (result.success) {
        acknowledgedDeps.update(set => new SvelteSet(set).add(acknowledgment.fileName.toLowerCase()));
        removeServerManagedFiles([acknowledgment.fileName]);
      } else {
        throw new Error(result.error || `Failed to acknowledge ${acknowledgment.fileName}`);
      }
    }
    successMessage.set(`Successfully acknowledged ${acknowledgments.length} dependenc${acknowledgments.length > 1 ? 'ies' : 'y'}`);
    setTimeout(() => successMessage.set(''), 5000);
    setTimeout(async () => {
      await checkModSynchronization(instance);
    }, 3500); // Slightly longer than the 3-second optimistic update timeout
  } catch (err: any) {
    errorMessage.set('Error acknowledging dependencies: ' + err.message);
    setTimeout(() => errorMessage.set(''), 5000);
  }
}

export async function downloadOptionalMods(instance: Instance) {
  const allMods = get(allClientMods);
  if (!instance.path || !allMods.length) return;
  
  // Filter to only download optional mods that are actually missing or outdated
  const syncStatus = get(modSyncStatus);
  const optionalOnly = allMods.filter(mod => !mod.required);
  const modsToDownload = optionalOnly.filter(mod => {
    const isMissing = syncStatus?.missingOptionalMods?.includes(mod.fileName);
    const isOutdated = syncStatus?.outdatedOptionalMods?.some((update: any) => 
      update.fileName?.toLowerCase() === mod.fileName.toLowerCase()
    );
    return isMissing || isOutdated;
  });
  
  if (modsToDownload.length === 0) {
    successMessage.set('All optional mods are already up to date');
    setTimeout(() => successMessage.set(''), 3000);
    return;
  }
  
  try {
    const result = await window.electron.invoke('minecraft-download-mods', {
      clientPath: instance.path,
      requiredMods: [],
      optionalMods: modsToDownload,
      allClientMods: allMods,
      serverInfo: { serverIp: instance.serverIp, serverPort: instance.serverPort, serverProtocol: instance.serverProtocol, sessionToken: instance.sessionToken }
    });
    if (result.success) {
      successMessage.set(`Successfully downloaded ${result.downloaded} optional mods`);
      setTimeout(() => successMessage.set(''), 5000);
      if (result.removedMods?.length) removeServerManagedFiles(result.removedMods);
      setTimeout(async () => {
        await checkModSynchronization(instance);
        await refreshInstalledMods(instance);
      }, 1500);
    } else {
      errorMessage.set(`Failed to download optional mods: ${result.error || 'Unknown error'}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  } catch (err: any) {
    errorMessage.set('Error downloading optional mods: ' + err.message);
    setTimeout(() => errorMessage.set(''), 5000);
  }
}

export async function downloadSingleOptionalMod(instance: Instance, mod: any) {
  if (!instance.path) return;
  try {
    const result = await window.electron.invoke('minecraft-download-mods', {
      clientPath: instance.path,
      requiredMods: mod.required ? [mod] : [],
      optionalMods: mod.required ? [] : [mod],
      allClientMods: get(allClientMods),
      serverInfo: { serverIp: instance.serverIp, serverPort: instance.serverPort, serverProtocol: instance.serverProtocol, sessionToken: instance.sessionToken }
    });
    if (result.success) {
      // Avoid duplicate success toasts; the downloads UI already shows completion
      if (result.removedMods?.length) removeServerManagedFiles(result.removedMods);
      setTimeout(async () => {
        await checkModSynchronization(instance);
        await refreshInstalledMods(instance);
      }, 1500);
    } else {
      errorMessage.set(`Failed to download ${mod.fileName}: ${result.error || 'Unknown error'}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  } catch (err: any) {
    errorMessage.set(`Error downloading ${mod.fileName}: ${err.message}`);
    setTimeout(() => errorMessage.set(''), 5000);
  }
}

export async function downloadSingleRequiredMod(instance: Instance, mod: any) {
  if (!instance.path) return;
  try {
    const result = await window.electron.invoke('minecraft-download-mods', {
      clientPath: instance.path,
      requiredMods: [mod],
      optionalMods: [],
      allClientMods: get(allClientMods),
      serverInfo: { serverIp: instance.serverIp, serverPort: instance.serverPort, serverProtocol: instance.serverProtocol, sessionToken: instance.sessionToken }
    });
    if (result.success) {
      // Avoid duplicate success toasts; the downloads UI already shows completion
      if (result.removedMods?.length) removeServerManagedFiles(result.removedMods);
      setTimeout(async () => {
        await checkModSynchronization(instance);
        await refreshInstalledMods(instance);
      }, 1500);
    } else {
      errorMessage.set(`Failed to download ${mod.fileName}: ${result.error || 'Unknown error'}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  } catch (err: any) {
    errorMessage.set(`Error downloading ${mod.fileName}: ${err.message}`);
    setTimeout(() => errorMessage.set(''), 5000);
  }
}

export async function handleModToggle(instance: Instance, modFileName: string, enabled: boolean) {
  if (!instance.path) return;
  
  try {
    const result = await window.electron.invoke('toggle-client-mod', { clientPath: instance.path, modFileName, enabled });
    
    if (result.success) {
      successMessage.set(`Mod ${enabled ? 'enabled' : 'disabled'}: ${modFileName}`);
      setTimeout(() => successMessage.set(''), 3000);
    } else {
      errorMessage.set(`Failed to ${enabled ? 'enable' : 'disable'} mod: ${result.error}`);
      setTimeout(() => errorMessage.set(''), 5000);
      throw new Error(result.error || 'Toggle failed');
    }
  } catch (err: any) {
    errorMessage.set('Error toggling mod: ' + err.message);
    setTimeout(() => errorMessage.set(''), 5000);
    throw err; // Re-throw to let the wrapper handle it
  }
}

export async function handleModDelete(instance: Instance, modFileName: string) {
  if (!instance.path) return;
  try {
    const result = await window.electron.invoke('delete-client-mod', { clientPath: instance.path, modFileName });
    if (result.success) {
      successMessage.set(`Deleted mod: ${modFileName}`);
      setTimeout(() => successMessage.set(''), 3000);
      installedModInfo.update((info: any[]) => {
        const updated = info.filter((m: any) => m.fileName !== modFileName);
        const removed = info.find((m: any) => m.fileName === modFileName);
        if (removed && removed.projectId) {
          installedModIds.update((ids: SvelteSet<string>) => {
            ids.delete(removed.projectId);
            return new SvelteSet(ids);
          });
        }
        return updated;
      });
      checkModSynchronization(instance);
    } else {
      errorMessage.set(`Failed to delete mod: ${result.error}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  } catch (err: any) {
    errorMessage.set('Error deleting mod: ' + err.message);
    setTimeout(() => errorMessage.set(''), 5000);
  }
}

export async function handleServerModRemoval(instance: Instance, modFileName: string) {
  if (!instance.path) return;
  try {
    const result = await window.electron.invoke('minecraft-remove-server-managed-mods', {
      clientPath: instance.path,
      modsToRemove: [modFileName]
    });
    if (result.success) {
      successMessage.set(`Successfully removed ${result.count} mod${result.count !== 1 ? 's' : ''}`);
      setTimeout(() => successMessage.set(''), 3000);
      await checkModSynchronization(instance);
      await refreshInstalledMods(instance);
    } else {
      errorMessage.set(`Failed to remove mod: ${result.error || 'Unknown error'}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  } catch (err: any) {
    errorMessage.set('Error removing mod: ' + err.message);
    setTimeout(() => errorMessage.set(''), 5000);
  }
}

export async function handleBulkServerModRemoval(instance: Instance, modFileNames: string[]) {
  if (!instance.path || !modFileNames.length) return;
  try {
    const result = await window.electron.invoke('minecraft-remove-server-managed-mods', {
      clientPath: instance.path,
      modsToRemove: modFileNames
    });
    if (result.success) {
      successMessage.set(`Successfully removed ${result.count} mod${result.count !== 1 ? 's' : ''}`);
      setTimeout(() => successMessage.set(''), 3000);
      await checkModSynchronization(instance);
      await refreshInstalledMods(instance);
    } else {
      errorMessage.set(`Failed to remove mods: ${result.error || 'Unknown error'}`);
      setTimeout(() => errorMessage.set(''), 5000);
    }
  } catch (err: any) {
    errorMessage.set('Error removing mods: ' + err.message);
    setTimeout(() => errorMessage.set(''), 5000);
  }
}

export async function handleDependencyAcknowledgment(instance: Instance, modFileName: string) {
  const lower = modFileName.toLowerCase();
  try {
    const result = await window.electron.invoke('minecraft-acknowledge-dependency', {
      clientPath: instance.path,
      modFileName
    });
    if (result.success) {
      successMessage.set(`Acknowledged dependency: ${modFileName}`);
      setTimeout(() => successMessage.set(''), 2000);
      acknowledgedDeps.update(set => new SvelteSet(set).add(lower));
      removeServerManagedFiles([modFileName]);
      setTimeout(async () => {
        await checkModSynchronization(instance);
      }, 200);
    } else {
      throw new Error(result.error || 'Failed to acknowledge dependency in backend');
    }
  } catch (err: any) {
    errorMessage.set(`Failed to acknowledge dependency: ${err.message}`);
    setTimeout(() => errorMessage.set(''), 5000);
  }
}

export async function updateServerMod(instance: Instance, event: any) {
  const { fileName, name, currentVersion, newVersion, mod } = event.detail;
  try {
    let targetMod = null;
    const req = get(requiredMods);
    const opt = get(optionalMods);
    const allMods = get(allClientMods);
    if (req && req.length) targetMod = req.find(m => m.fileName === fileName);
    if (!targetMod && opt && opt.length) targetMod = opt.find(m => m.fileName === fileName);
    if (!targetMod && allMods && allMods.length) targetMod = allMods.find(m => m.fileName === fileName);
    if (!targetMod) throw new Error(`Target mod ${fileName} not found in mod data`);
    if (!targetMod.downloadUrl) throw new Error(`Target mod ${fileName} has no download URL`);
    const isRequired = mod.required !== false;
    const modRequiredMods = isRequired ? [targetMod] : [];
    const modOptionalMods = isRequired ? [] : [targetMod];
    const result = await safeInvoke('minecraft-download-mods', {
      clientPath: instance?.path,
      requiredMods: modRequiredMods,
      optionalMods: modOptionalMods,
      allClientMods: allMods,
      serverInfo: { serverIp: instance?.serverIp, serverPort: instance?.serverPort, serverProtocol: instance?.serverProtocol, sessionToken: instance?.sessionToken }
    });
    if (result?.success) {
      successMessage.set(`Successfully updated ${name} from v${currentVersion} to v${newVersion}`);
      installedModsInfo.update((info: any[]) => {
        const idx = info.findIndex((m: any) => m.fileName === fileName);
        if (idx !== -1) {
          const updated = [...info];
          updated[idx] = { ...updated[idx], versionNumber: newVersion, version: newVersion };
          return updated;
        }
        return info;
      });
      setTimeout(async () => {
        await checkModSynchronization(instance);
      }, 500);
    } else {
      errorMessage.set(`Failed to update ${name}: ${result?.error || 'Unknown error'}`);
    }
  } catch (err: any) {
    errorMessage.set(`Error updating ${name}: ${err.message}`);
  }
}
