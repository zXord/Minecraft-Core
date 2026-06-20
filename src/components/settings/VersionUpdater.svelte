<script>
  import { onMount, onDestroy } from 'svelte';
  
  import { SvelteSet } from 'svelte/reactivity';
  import { get } from 'svelte/store';
  import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-svelte';
  import { serverState } from '../../stores/serverState.js';
  import { settingsStore, updateVersions } from '../../stores/settingsStore.js';
  import { safeInvoke } from '../../utils/ipcUtils.js';
  import { clearModUpdateIndicators } from '../../utils/mods/modAPI.js';
  import { getProjectPageAction, getProjectSource, getProjectSourceLabel, normalizeModrinthProjectDetails } from '../../utils/mods/modrinthProjectLinks.js';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import { modAvailabilityWatchStore } from '../../stores/modAvailabilityWatchStore.js';

  export let serverPath = '';

  let mcVersions = [];
  let fabricVersions = [];
  let selectedMC = null;
  let selectedFabric = null;
  let checking = false;
  let compatibilityCheckProgress = {
    active: false,
    phase: 'idle',
    current: 0,
    total: 0,
    percent: 0,
    message: ''
  };
  let targetJavaInfo = null;
  let targetJavaInfoLoading = false;
  let javaInfoRequestId = 0;
  let updating = false;
  let compatChecked = false;
  let incompatibleMods = [];
  let compatibleMods = [];
  let modsWithUpdates = [];
  let showUpdateConfirmation = false;
  let createRestorePointBeforeUpdate = true;
  let updateProgress = 0;
  let updateStatus = '';
  let currentTask = '';
  let totalSteps = 0;
  let currentStep = 0;
  let completedUpdates = []; // Track successful mod updates
  let updateSummary = null; // Complete summary of all changes
  let showWatchPanel = false;
  let serverPathLocal = '';
  let showWatchSettings = false;
  let modWatchPrefs = { showWindowsNotifications: false, intervalHours: 12 };
  let teardownIpcListeners = () => {};
  let preflightBackupWarning = '';
  let expandedModDetails = {};
  let modDetailsLoading = {};
  let modProjectDetails = {};
  let modProjectDetailErrors = {};
  $: serverPathLocal = resolvedPath;
  $: if (serverPathLocal && !$modAvailabilityWatchStore.loaded) {
    modAvailabilityWatchStore.refresh(serverPathLocal);
  }
  let selectedLoader = 'fabric';

  function formatLoaderName(loader) {
    if (!loader) return 'Loader';
    const normalized = String(loader).toLowerCase();
    if (normalized === 'vanilla') return 'Vanilla';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  function deriveWatchKey(entry) {
    if (!entry) return '';
    if (entry.key) return entry.key;
    const target = entry.target || {};
    const loader = target.loader || (target.fabric ? 'fabric' : '');
    const loaderVersion = target.loaderVersion || target.fabric || '';
    return `${entry.projectId || ''}::${target.mc || ''}::${loader}::${loaderVersion}`;
  }
  function formatWatchTarget(target) {
    if (!target) return '-';
    const loader = target.loader || (target.fabric ? 'fabric' : '');
    const loaderVersion = target.loaderVersion || target.fabric || '';
    const loaderLabel = loader ? loader + (loaderVersion ? ` ${loaderVersion}` : '') : loaderVersion;
    const mc = target.mc || '?';
    return loaderLabel ? `${mc} / ${loaderLabel}` : mc;
  }
  $: activeWatches = new Set(($modAvailabilityWatchStore.watches || []).map(deriveWatchKey));
  function watchKey(mod) { return `${mod.projectId}::${selectedMC}::${selectedLoader}::${selectedFabric}`; }
  async function toggleWatch(mod) {
    if (!resolvedPath || !mod?.projectId || !selectedMC || !selectedFabric) return;
    const key = watchKey(mod);
    if (activeWatches.has(key)) {
      await modAvailabilityWatchStore.remove(resolvedPath, { projectId: mod.projectId, target: { mc: selectedMC, fabric: selectedFabric, loader: selectedLoader, loaderVersion: selectedFabric } });
    } else {
      await modAvailabilityWatchStore.add(resolvedPath, { projectId: mod.projectId, name: mod.name, fileName: mod.fileName, targetMc: selectedMC, targetFabric: selectedFabric, targetLoader: selectedLoader, targetLoaderVersion: selectedFabric });
    }
  }
  function formatDate(ts) { if (!ts) return '-'; try { return new Date(ts).toLocaleString(); } catch { return ts; } }

  function modDetailKey(mod) {
    return mod?.projectId || mod?.fileName || mod?.name || '';
  }

  function getModProjectIdentifier(mod) {
    return mod?.projectId || mod?.modrinthId || mod?.curseforgeId || mod?.id || '';
  }

  function isModDetailsExpanded(mod, expandedState = expandedModDetails) {
    const key = modDetailKey(mod);
    return !!(key && expandedState[key]);
  }

  function isModDetailsLoading(mod, loadingState = modDetailsLoading) {
    const key = modDetailKey(mod);
    return !!(key && loadingState[key]);
  }

  function formatCompactNumber(value) {
    const number = Number(value) || 0;
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(number);
  }

  function formatSideSupport(value) {
    if (!value) return 'unknown';
    return String(value).replace(/_/g, ' ');
  }

  function canLoadProviderDetails(mod) {
    return getProjectSource(mod) === 'modrinth' && !!(mod?.projectId || mod?.modrinthId);
  }

  function getModPageAction(mod, projectDetailsByKey = modProjectDetails) {
    const key = modDetailKey(mod);
    return getProjectPageAction(mod, projectDetailsByKey[key] || {});
  }

  function getModPageLabel(mod, projectDetailsByKey = modProjectDetails) {
    return getModPageAction(mod, projectDetailsByKey)?.label || 'project page';
  }

  function hasModPageAction(mod, projectDetailsByKey = modProjectDetails) {
    return !!getModPageAction(mod, projectDetailsByKey);
  }

  function getModProjectDetails(mod, projectDetailsByKey = modProjectDetails) {
    return projectDetailsByKey[modDetailKey(mod)] || {};
  }

  function getModDetailError(mod, detailErrorsByKey = modProjectDetailErrors) {
    return detailErrorsByKey[modDetailKey(mod)] || '';
  }

  function getModDetailsText(mod, details = {}) {
    if (details.description) {
      return details.description;
    }

    const sourceLabel = getProjectSourceLabel(mod, details);
    if (canLoadProviderDetails(mod)) {
      return `No ${sourceLabel} description is available for this project.`;
    }

    return `Installed from ${sourceLabel}. No provider description is available for this item, so only local file and version details are shown.`;
  }

  async function loadModDetails(mod) {
    const key = modDetailKey(mod);
    const projectId = mod?.projectId || mod?.modrinthId;
    if (!key || !canLoadProviderDetails(mod) || modProjectDetails[key] || modDetailsLoading[key]) {
      return;
    }

    modDetailsLoading = { ...modDetailsLoading, [key]: true };
    modProjectDetailErrors = { ...modProjectDetailErrors, [key]: '' };

    try {
      const projectInfo = await safeInvoke('get-project-info', {
        projectId,
        source: 'modrinth'
      });
      modProjectDetails = {
        ...modProjectDetails,
        [key]: normalizeModrinthProjectDetails(projectInfo)
      };
    } catch (error) {
      modProjectDetailErrors = {
        ...modProjectDetailErrors,
        [key]: error?.message || 'Could not load Modrinth details.'
      };
    } finally {
      modDetailsLoading = { ...modDetailsLoading, [key]: false };
    }
  }

  function toggleModDetails(mod) {
    const key = modDetailKey(mod);
    if (!key) return;

    if (expandedModDetails[key]) {
      const { [key]: _removed, ...remaining } = expandedModDetails;
      expandedModDetails = remaining;
      return;
    }

    expandedModDetails = { ...expandedModDetails, [key]: true };
    void loadModDetails(mod);
  }

  async function openModPage(mod) {
    const action = getModPageAction(mod);
    if (!action?.url) return;

    await safeInvoke('open-external-url', action.url);
  }

  async function loadModWatchPrefs() {
    try {
      const res = await safeInvoke('get-app-settings');
      if (res?.settings?.modWatch) {
        modWatchPrefs = { ...modWatchPrefs, ...res.settings.modWatch };
      }
    } catch {}
  }
  loadModWatchPrefs();

  async function saveModWatchPrefs() {
    try {
      await safeInvoke('save-app-settings', { modWatch: modWatchPrefs });
      await safeInvoke('mod-watch:interval:set', modWatchPrefs.intervalHours);
      // refresh config display
      modAvailabilityWatchStore.refresh(resolvedPath);
      showWatchSettings = false;
    } catch {}
  }

  // Track current server status
  $: serverStatus = $serverState.status;
  $: serverRunning = serverStatus === 'Running';

      $: resolvedPath = serverPath || get(settingsStore).path;
  $: if (selectedMC && resolvedPath) {
    void loadTargetJavaInfo();
  } else if (!selectedMC) {
    targetJavaInfo = null;
    targetJavaInfoLoading = false;
  }

  $: updateConfirmationMessage = [
    selectedMC && (selectedLoader === 'vanilla' || selectedFabric)
      ? `Update server to Minecraft ${selectedMC}${selectedLoader === 'vanilla' ? ' with Vanilla' : ` with ${formatLoaderName(selectedLoader)} ${selectedFabric}`}?`
      : 'Update server version?',
    targetJavaInfo?.requiredJavaVersion
      ? (targetJavaInfo.isAvailable
        ? ` Java ${targetJavaInfo.requiredJavaVersion} is already available.`
        : ` Java ${targetJavaInfo.requiredJavaVersion} will also be installed.`)
      : '',
    targetJavaInfo?.requiredJavaVersion
      ? ' Older local Java runtimes for this server will be cleaned up automatically.'
      : '',
    incompatibleMods.length > 0 ? ' Incompatible mods will be disabled.' : ''
  ].join('');

  function handleMinecraftServerProgress(data) {
    if (!data || typeof data !== 'object') return;
    updateProgress = Math.round(data.percent || 0);
    updateStatus = data.speed || '';
    currentTask = 'Downloading Minecraft server...';
  }

  function handleFabricInstallProgress(data) {
    if (!data || typeof data !== 'object') return;
    updateProgress = Math.round(data.percent || 0);
    updateStatus = data.speed || '';
    currentTask = `Installing ${selectedLoader} loader...`;
  }

  function handleDownloadProgress(data) {
    if (!data || typeof data !== 'object') return;
    if (data.id && typeof data.id === 'string' && data.id.startsWith('mod-')) {
      updateProgress = Math.round(data.progress || 0);
      updateStatus = data.speed ? `${(data.speed / 1024 / 1024).toFixed(2)} MB/s` : '';
      currentTask = `Updating ${data.name || 'mod'}...`;
    }
  }

  function formatProgressBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
  }

  function handleBackupProgress(data) {
    if (!data || typeof data !== 'object' || data.trigger !== 'pre-update') return;
    const percent = Number(data.percent);
    if (Number.isFinite(percent)) {
      updateProgress = Math.max(1, Math.min(100, Math.round(percent)));
    }
    currentTask = data.message || 'Creating restore point...';
    if (data.processedBytes || data.totalBytes) {
      updateStatus = data.totalBytes
        ? `${formatProgressBytes(data.processedBytes)} of ${formatProgressBytes(data.totalBytes)}`
        : `${formatProgressBytes(data.processedBytes)} processed`;
    } else if (data.entriesProcessed || data.entriesTotal) {
      updateStatus = `${data.entriesProcessed || 0}/${data.entriesTotal || 0} files`;
    } else {
      updateStatus = '';
    }
  }

  function resetCompatibilityCheckProgress(message = '') {
    compatibilityCheckProgress = {
      active: !!message,
      phase: message ? 'loading' : 'idle',
      current: 0,
      total: 0,
      percent: 0,
      message
    };
  }

  function handleModCompatibilityProgress(data) {
    if (!data || typeof data !== 'object') return;
    const total = Math.max(0, Number(data.total) || 0);
    const current = Math.max(0, Math.min(total || Number(data.current) || 0, Number(data.current) || 0));
    const percent = total > 0
      ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
      : Math.max(0, Math.min(100, Number(data.percent) || 0));

    compatibilityCheckProgress = {
      active: checking || data.phase !== 'complete',
      phase: data.phase || 'checking',
      current,
      total,
      percent,
      message: data.message || (total > 0 ? `Checking mods ${current}/${total}...` : 'Checking mods...')
    };
  }

  function getCompatibilityButtonLabel() {
    if (!checking) return 'Check Compatibility';
    if (compatibilityCheckProgress.total > 0) {
      return `Checking ${compatibilityCheckProgress.current}/${compatibilityCheckProgress.total}`;
    }
    return 'Checking...';
  }

  function getCompatibilityProgressLabel() {
    if (compatibilityCheckProgress.total > 0) {
      return `${compatibilityCheckProgress.current}/${compatibilityCheckProgress.total}`;
    }
    if (compatibilityCheckProgress.percent > 0) {
      return `${compatibilityCheckProgress.percent}%`;
    }
    return '';
  }

  function handleServerJavaDownloadProgress(data) {
    if (!data || typeof data !== 'object') return;
    updateProgress = data.progress || 0;
    updateStatus = data.downloadedMB && data.totalMB
      ? `${data.downloadedMB}/${data.totalMB} MB`
      : '';
    currentTask = `Java: ${data.task}`;
  }

  function registerIpcListeners() {
    if (!window?.electron) {
      return () => {};
    }

    window.electron.on('minecraft-server-progress', handleMinecraftServerProgress);
    window.electron.on('fabric-install-progress', handleFabricInstallProgress);
    window.electron.on('loader-install-progress', handleFabricInstallProgress);
    window.electron.on('download-progress', handleDownloadProgress);
    window.electron.on('backup-progress', handleBackupProgress);
    window.electron.on('mod-compatibility-progress', handleModCompatibilityProgress);
    window.electron.on('server-java-download-progress', handleServerJavaDownloadProgress);

    return () => {
      window.electron.removeListener?.('minecraft-server-progress', handleMinecraftServerProgress);
      window.electron.removeListener?.('fabric-install-progress', handleFabricInstallProgress);
      window.electron.removeListener?.('loader-install-progress', handleFabricInstallProgress);
      window.electron.removeListener?.('download-progress', handleDownloadProgress);
      window.electron.removeListener?.('backup-progress', handleBackupProgress);
      window.electron.removeListener?.('mod-compatibility-progress', handleModCompatibilityProgress);
      window.electron.removeListener?.('server-java-download-progress', handleServerJavaDownloadProgress);
    };
  }

  onMount(() => {
    fetchMinecraftVersions();
    loadCurrentConfig();
    teardownIpcListeners = registerIpcListeners();
  });

  onDestroy(() => {
    teardownIpcListeners?.();
    teardownIpcListeners = () => {};
  });

  async function fetchMinecraftVersions() {
    try {
      const res = await fetch('https://meta.fabricmc.net/v2/versions/game');
      const data = await res.json();
      mcVersions = data.filter(v => v.stable).map(v => v.version);
    } catch (err) {
      mcVersions = [];
    }
  }

  async function onMCChange() {
    selectedFabric = null;
    fabricVersions = [];
    compatChecked = false;
    targetJavaInfo = null;
    if (!selectedMC) return;
    try {
      if (selectedLoader === 'vanilla') {
        fabricVersions = [];
      } else {
        const result = await safeInvoke('get-loader-versions', {
          loader: selectedLoader,
          mcVersion: selectedMC
        });
        fabricVersions = result?.versions || [];
      }
    } catch (err) {
    }
  }

  async function loadCurrentConfig() {
    if (!resolvedPath) return;
    try {
      const config = await safeInvoke('read-config', resolvedPath);
      selectedLoader = config?.loader || (config?.fabric ? 'fabric' : 'vanilla');
      selectedMC = config?.version || null;
      selectedFabric = config?.loaderVersion || config?.fabric || null;
      if (selectedMC) {
        await onMCChange();
        if (selectedFabric && !fabricVersions.includes(selectedFabric)) {
          fabricVersions = [selectedFabric, ...fabricVersions];
        }
      }
    } catch {}
  }

  async function loadTargetJavaInfo() {
    const requestId = ++javaInfoRequestId;
    targetJavaInfoLoading = true;

    try {
      const javaInfo = await safeInvoke('server-java-check-requirements', {
        minecraftVersion: selectedMC,
        serverPath: resolvedPath
      });

      if (requestId !== javaInfoRequestId) return;
      targetJavaInfo = javaInfo?.success === false ? null : javaInfo;
    } catch (err) {
      if (requestId !== javaInfoRequestId) return;
      targetJavaInfo = null;
    } finally {
      if (requestId === javaInfoRequestId) {
        targetJavaInfoLoading = false;
      }
    }
  }

  async function checkCompatibility() {
    if (!selectedMC || (selectedLoader !== 'vanilla' && !selectedFabric)) return;
    checking = true;
    compatChecked = false;
    incompatibleMods = [];
    compatibleMods = [];
    modsWithUpdates = [];
    completedUpdates = []; // Clear previous completed updates
    updateSummary = null; // Clear previous update summary
    expandedModDetails = {};
    modDetailsLoading = {};
    modProjectDetails = {};
    modProjectDetailErrors = {};
    resetCompatibilityCheckProgress('Loading installed mods...');
    
    try {
      const results = await safeInvoke('check-mod-compatibility', {
        serverPath: resolvedPath,
        mcVersion: selectedMC,
        loader: selectedLoader,
        loaderVersion: selectedFabric,
        fabricVersion: selectedFabric
      });
      compatibilityCheckProgress = {
        ...compatibilityCheckProgress,
        active: true,
        phase: 'finalizing',
        percent: 100,
        message: 'Finalizing compatibility results...'
      };
      
      // Get disabled mods to filter them out from frontend processing as well
      const disabledModsList = await safeInvoke('get-disabled-mods', resolvedPath);
      const disabledModsSet = new SvelteSet(disabledModsList || []);
      
      for (const mod of results) {
        // Skip disabled mods in frontend processing too (double safety)
        if (disabledModsSet.has(mod.fileName)) {
          continue;
        }
        
        let incompatible = !mod.compatible;
        let modInfo = {
          name: mod.displayName || mod.fileName || mod.name || mod.projectId,
          fileName: mod.fileName,
          currentVersion: mod.currentVersion,
          projectId: mod.projectId,
          modrinthId: mod.modrinthId,
          curseforgeId: mod.curseforgeId,
          source: mod.source,
          projectUrl: mod.projectUrl || mod.pageUrl || mod.websiteUrl || mod.url,
          slug: mod.slug,
          compatible: mod.compatible
        };
        
        // Check if mod has updates available - use backend data if available
        if (mod.compatible && mod.latestVersion && mod.currentVersion) {
          if (mod.latestVersion !== mod.currentVersion) {
            modInfo.updateAvailable = true;
            modInfo.newVersion = mod.latestVersion;
            modsWithUpdates.push(modInfo);
          }
        } else if (mod.compatible && mod.projectId) {
          // Fallback to frontend version checking if backend didn't provide version info
          try {
            // Check for mod versions compatible with the new MC/Fabric versions
            const versions = await safeInvoke('get-mod-versions', {
              modId: mod.projectId,
              source: 'modrinth'
            });
            
            if (versions && versions.length > 0) {
              // Filter versions compatible with target MC version
              const compatibleVersions = versions.filter(v => 
                v.gameVersions && v.gameVersions.includes(selectedMC) &&
                v.loaders && v.loaders.includes(selectedLoader)
              );
              
              if (compatibleVersions.length > 0) {
                // Sort by date to get the latest
                compatibleVersions.sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime());
                const latestVersion = compatibleVersions[0];
                
                // Check if this is actually an update
                if (latestVersion.versionNumber !== mod.currentVersion) {
                  modInfo.updateAvailable = true;
                  modInfo.newVersion = latestVersion.versionNumber;
                  modInfo.versionId = latestVersion.id;
                  modsWithUpdates.push(modInfo);
                }
              }
            }
          } catch (error) {
          }        }
        
        // Note: We trust the backend compatibility decision and don't override it
        // The backend already considers dependencies in its compatibility logic
        
        if (incompatible) {
          incompatibleMods.push(modInfo);
        } else {
          compatibleMods.push(modInfo);
        }
      }
      
      compatChecked = true;
    } catch (err) {
    } finally {
      checking = false;
      compatibilityCheckProgress = {
        ...compatibilityCheckProgress,
        active: false
      };
    }
  }
  async function updateServerVersion() {
    createRestorePointBeforeUpdate = true;
    showUpdateConfirmation = true;
  }  async function confirmUpdate() {
    showUpdateConfirmation = false;
    const shouldCreateRestorePoint = createRestorePointBeforeUpdate;
    updating = true;
    updateProgress = 0;
    currentTask = 'Starting update...';
    
    // Capture current versions before update
      const currentSettings = get(settingsStore);
      const beforeUpdate = {
        mcVersion: currentSettings.mcVersion,
        loader: currentSettings.loader || (currentSettings.fabricVersion ? 'fabric' : 'vanilla'),
        loaderVersion: currentSettings.loaderVersion || currentSettings.fabricVersion
      };
      
    // Reset tracking arrays
    completedUpdates = [];
    updateSummary = null;
      
      // Calculate total steps for progress tracking
    totalSteps = shouldCreateRestorePoint ? 5 : 4; // Optional backup, Minecraft server, loader, Java, Config
    if (modsWithUpdates.length > 0) totalSteps += modsWithUpdates.length;
    if (incompatibleMods.length > 0) totalSteps += 1;
    currentStep = 0;
    
    try {
      // Step 1: Optionally create a restore-point backup before mutating the server folder
      preflightBackupWarning = '';
      if (shouldCreateRestorePoint) {
        currentStep++;
        currentTask = 'Creating restore point...';
        updateProgress = 1;
        try {
          const backupResult = await safeInvoke('backups:safe-create', {
            serverPath: resolvedPath,
            type: 'full',
            trigger: 'pre-update'
          });
          if (!backupResult?.success) {
            preflightBackupWarning = backupResult?.error || 'Restore-point backup could not be created.';
            updateStatus = `Warning: ${preflightBackupWarning}`;
          } else {
            updateStatus = `Restore point created: ${backupResult.name || 'backup ready'}`;
          }
        } catch (backupError) {
          preflightBackupWarning = backupError.message || 'Restore-point backup could not be created.';
          updateStatus = `Warning: ${preflightBackupWarning}`;
        }
      } else {
        updateStatus = 'Restore point skipped by user choice.';
      }

      // Step 2: Download Minecraft server
      currentStep++;
      currentTask = 'Downloading Minecraft server...';
      updateProgress = Math.round((currentStep / totalSteps) * 100);
      await safeInvoke('download-minecraft-server', { mcVersion: selectedMC, targetPath: resolvedPath });
      
      // Step 3: Install loader
      currentStep++;
      currentTask = selectedLoader === 'vanilla' ? 'Preparing Vanilla server...' : `Installing ${selectedLoader} loader...`;
      updateProgress = Math.round((currentStep / totalSteps) * 100);
      await safeInvoke('download-and-install-loader', {
        path: resolvedPath,
        mcVersion: selectedMC,
        loader: selectedLoader,
        loaderVersion: selectedFabric,
        fabricVersion: selectedFabric
      });
      
      // Step 4: Check and download Java if needed
      currentStep++;
      currentTask = 'Checking Java requirements...';
      updateProgress = Math.round((currentStep / totalSteps) * 100);
      try {
        const javaResult = await safeInvoke('server-java-ensure', {
          minecraftVersion: selectedMC,
          serverPath: resolvedPath
        });
        
        if (javaResult.success) {
          const readyJavaVersion = javaResult.requiredJavaVersion || targetJavaInfo?.requiredJavaVersion;
          const cleanedJavaVersions = javaResult.cleanup?.cleanedVersions || [];
          currentTask = readyJavaVersion
            ? (cleanedJavaVersions.length > 0
              ? `Java ${readyJavaVersion} ready. Cleaned old local Java ${cleanedJavaVersions.join(', ')}.`
              : `Java ${readyJavaVersion} ready for server!`)
            : 'Java ready for server!';
        } else {
          // Java download failed, but don't fail the whole update - it will download on server start
          currentTask = `Java setup skipped - will download on server start`;
        }
      } catch (javaError) {
        // Java download failed, but don't fail the whole update
        currentTask = 'Java setup skipped - will download on server start';
      }
      
      // Step 5: Update mods that have new versions
      if (modsWithUpdates.length > 0) {
        for (let i = 0; i < modsWithUpdates.length; i++) {
          const mod = modsWithUpdates[i];
          try {
            currentStep++;
            currentTask = `Updating ${mod.name}...`;
            updateProgress = Math.round((currentStep / totalSteps) * 100);
              // Use the mod update API
            const updateResult = await safeInvoke('update-mod', {
              serverPath: resolvedPath,
              projectId: mod.projectId,
              targetVersion: mod.newVersion,
              fileName: mod.fileName,
              mcVersion: selectedMC
            });
              // Track successful update
            if (updateResult && updateResult.success) {
              completedUpdates.push({
                name: mod.name,
                oldVersion: mod.currentVersion,
                newVersion: mod.newVersion,
                oldFileName: updateResult.oldFileName,
                newFileName: updateResult.newFileName
              });
            } else {
            }
          } catch (modError) {
            // Continue with other mods even if one fails
          }
        }
      }
      
      // Step 6: Update server config
      currentStep++;
      currentTask = 'Updating configuration...';
      updateProgress = Math.round((currentStep / totalSteps) * 100);
      await safeInvoke('update-config', {
        serverPath: resolvedPath,
        updates: {
          version: selectedMC,
          loader: selectedLoader,
          loaderVersion: selectedFabric,
          fabric: selectedLoader === 'fabric' ? selectedFabric : null
        }
      });
      
      // Step 7: Handle incompatible mods (preserve previously disabled mods)
      if (incompatibleMods.length > 0) {
        currentStep++;
        currentTask = 'Disabling incompatible mods...';
        updateProgress = Math.round((currentStep / totalSteps) * 100);
        
        // Get the current list of disabled mods BEFORE the upgrade
        const currentlyDisabledMods = await safeInvoke('get-disabled-mods', resolvedPath) || [];
        
        // Extract just the filenames from newly incompatible mods
        const newlyIncompatibleMods = incompatibleMods.map(mod => mod.fileName);
        
        // Merge: keep previously disabled mods + add newly incompatible ones (avoid duplicates)
        const allDisabledMods = [...new Set([...currentlyDisabledMods, ...newlyIncompatibleMods])];
        
        await safeInvoke('save-disabled-mods', resolvedPath, allDisabledMods);
      }        // Step 7: Update version state
      updateVersions(selectedMC, selectedFabric, selectedLoader);
      clearModUpdateIndicators();
      // After successful upgrade, clear any remaining mod availability watches (upgrade path complete)
      try {
        if (resolvedPath) {
          await modAvailabilityWatchStore.clear(resolvedPath);
        }
      } catch {}
      compatChecked = false;
        // Create comprehensive update summary
      updateSummary = {
        versionChanges: {
          minecraft: {
            from: beforeUpdate.mcVersion,
            to: selectedMC,
            changed: beforeUpdate.mcVersion !== selectedMC
          },
          loaderVersion: {
            from: beforeUpdate.loaderVersion,
            to: selectedFabric,
            changed: beforeUpdate.loaderVersion !== selectedFabric
          }
        },
        loader: selectedLoader,
        restorePointCreated: shouldCreateRestorePoint && !preflightBackupWarning,
        restorePointSkipped: !shouldCreateRestorePoint,
        preflightBackupWarning,
        modUpdates: completedUpdates,
        disabledMods: incompatibleMods,
        totalCompatibleMods: compatibleMods.length,
        completedAt: new Date().toLocaleString()
      };
      
      currentTask = `Update completed successfully!`;
      updateProgress = 100;
        // Clear progress after a delay but keep completed updates visible
      setTimeout(() => {
        updateProgress = 0;
        currentTask = '';
        updateStatus = '';
        // Don't clear completedUpdates here so they remain visible
      }, 3000);
      
    } catch (err) {
      currentTask = `Update failed: ${err.message}`;
      updateProgress = 0;
    }
    updating = false;
  }
</script>

<div class="version-updater">  <div class="version-select">    <select bind:value={selectedMC} on:change={onMCChange}>
      <option value="" disabled selected>Select Minecraft Version</option>
      {#each mcVersions as v (v)}
        <option value={v}>
          {#if $settingsStore.mcVersion && $settingsStore.mcVersion !== v}
            {$settingsStore.mcVersion} → {v}
          {:else}
            {v}
          {/if}
        </option>
      {/each}
    </select>

    {#if selectedMC && selectedLoader !== 'vanilla'}      <select bind:value={selectedFabric}>
        <option value="" disabled selected>Select {selectedLoader} Loader</option>
        {#each fabricVersions as f (f)}
          <option value={f}>
            {#if ($settingsStore.loaderVersion || $settingsStore.fabricVersion) && ($settingsStore.loaderVersion || $settingsStore.fabricVersion) !== f}
              {$settingsStore.loaderVersion || $settingsStore.fabricVersion} → {f}
            {:else}
              {f}
            {/if}
          </option>
        {/each}
      </select>
    {/if}
  </div>

  <button class="check-btn" on:click={checkCompatibility} disabled={(!selectedMC || (selectedLoader !== 'vanilla' && !selectedFabric)) || checking}>
    {getCompatibilityButtonLabel()}
  </button>
  
  <div class="check-info">
    <p>Note: Only enabled mods are checked for compatibility. Disabled mods will remain disabled and unchanged.</p>
    {#if selectedMC}
      <p class="java-requirement" class:pending-java={targetJavaInfoLoading} class:missing-java={targetJavaInfo && !targetJavaInfo.isAvailable}>
        {#if targetJavaInfoLoading}
          Checking Java requirement for Minecraft {selectedMC}...
        {:else if targetJavaInfo?.requiredJavaVersion}
          Minecraft {selectedMC} requires Java {targetJavaInfo.requiredJavaVersion}.
          {targetJavaInfo.isAvailable ? ' This runtime is already available.' : ' The updater will install it automatically.'}
          Older local Java runtimes for this server are cleaned up automatically.
        {/if}
      </p>
    {/if}
  </div>
  {#if checking}
    <div class="compatibility-check-progress">
      <div class="compatibility-progress-header">
        <span>{compatibilityCheckProgress.message || 'Checking compatibility...'}</span>
        {#if getCompatibilityProgressLabel()}
          <strong>{getCompatibilityProgressLabel()}</strong>
        {/if}
      </div>
      <div class="progress-bar" class:indeterminate={compatibilityCheckProgress.total === 0}>
        <div
          class="progress-fill"
          style="width: {compatibilityCheckProgress.total > 0 ? compatibilityCheckProgress.percent : 35}%"
        ></div>
      </div>
    </div>
  {/if}
  {#if compatChecked}
    <div class="compat-results-container">
      <!-- Mod Updates Available -->
      {#if modsWithUpdates.length > 0}
        <div class="compat-results info">          <h4>🔄 Mod Updates Available ({modsWithUpdates.length})</h4>
          <ul class="mod-updates-list">
            {#each modsWithUpdates as mod (mod.name)}
              <li
                class="mod-update-item mod-detail-row"
                class:expanded={isModDetailsExpanded(mod, expandedModDetails)}
              >
                <div class="mod-row-main">
                  <span class="mod-name">{mod.name}</span>
                  <span class="version-change">{mod.currentVersion} → {mod.newVersion}</span>
                  <div class="mod-row-actions">
                    <button class="mod-row-icon-button" on:click|stopPropagation={() => toggleModDetails(mod)} title={isModDetailsExpanded(mod, expandedModDetails) ? 'Hide mod details' : 'Show mod details'} aria-label={isModDetailsExpanded(mod, expandedModDetails) ? 'Hide mod details' : 'Show mod details'}>
                      {#if isModDetailsExpanded(mod, expandedModDetails)}
                        <ChevronDown size={14} />
                      {:else}
                        <ChevronRight size={14} />
                      {/if}
                    </button>
                    {#if hasModPageAction(mod, modProjectDetails)}
                      <button class="mod-row-icon-button" on:click|stopPropagation={() => openModPage(mod)} title="Open {getModPageLabel(mod, modProjectDetails)}" aria-label="Open {getModPageLabel(mod, modProjectDetails)}">
                        <ExternalLink size={14} />
                      </button>
                    {/if}
                  </div>
                </div>
                {#if isModDetailsExpanded(mod, expandedModDetails)}
                  <div class="mod-details-panel">
                    {#if isModDetailsLoading(mod, modDetailsLoading)}
                      <p class="mod-details-text">Loading Modrinth details...</p>
                    {:else if getModDetailError(mod, modProjectDetailErrors)}
                      <p class="mod-details-error">{getModDetailError(mod, modProjectDetailErrors)}</p>
                    {:else}
                      <p class="mod-details-text">{getModDetailsText(mod, getModProjectDetails(mod, modProjectDetails))}</p>
                      <div class="mod-details-meta">
                        {#if getModProjectDetails(mod, modProjectDetails).title && getModProjectDetails(mod, modProjectDetails).title !== mod.name}<span>{getModProjectDetails(mod, modProjectDetails).title}</span>{/if}
                        <span>Source: {getProjectSourceLabel(mod, getModProjectDetails(mod, modProjectDetails))}</span>
                        {#if mod.fileName}<span>{mod.fileName}</span>{/if}
                        {#if getModProjectIdentifier(mod)}<span>Project: {getModProjectIdentifier(mod)}</span>{/if}
                        {#if getModProjectDetails(mod, modProjectDetails).downloads}<span>{formatCompactNumber(getModProjectDetails(mod, modProjectDetails).downloads)} downloads</span>{/if}
                        {#if getModProjectDetails(mod, modProjectDetails).followers}<span>{formatCompactNumber(getModProjectDetails(mod, modProjectDetails).followers)} followers</span>{/if}
                        {#if getModProjectDetails(mod, modProjectDetails).clientSide}<span>Client: {formatSideSupport(getModProjectDetails(mod, modProjectDetails).clientSide)}</span>{/if}
                        {#if getModProjectDetails(mod, modProjectDetails).serverSide}<span>Server: {formatSideSupport(getModProjectDetails(mod, modProjectDetails).serverSide)}</span>{/if}
                      </div>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}      <!-- Compatible Mods (without updates) -->
      {#if compatibleMods.length > modsWithUpdates.length}
        <div class="compat-results success">
          <h4>✅ Compatible Mods ({compatibleMods.length - modsWithUpdates.length})</h4>
          <div class="mod-summary">
            {compatibleMods.length - modsWithUpdates.length} mod{compatibleMods.length - modsWithUpdates.length === 1 ? '' : 's'} will continue to work without changes
          </div>
          <ul class="compatible-mods-list">
            {#each compatibleMods as mod (mod.name)}
              {#if !mod.updateAvailable}
                <li
                  class="compatible-mod-item mod-detail-row"
                  class:expanded={isModDetailsExpanded(mod, expandedModDetails)}
                >
                  <div class="mod-row-main">
                    <span class="mod-name">{mod.name}</span>
                    {#if mod.currentVersion}
                      <span class="mod-version">{mod.currentVersion}</span>
                    {/if}
                    <span class="compatible-status">✅ Compatible</span>
                    <div class="mod-row-actions">
                      <button class="mod-row-icon-button" on:click|stopPropagation={() => toggleModDetails(mod)} title={isModDetailsExpanded(mod, expandedModDetails) ? 'Hide mod details' : 'Show mod details'} aria-label={isModDetailsExpanded(mod, expandedModDetails) ? 'Hide mod details' : 'Show mod details'}>
                        {#if isModDetailsExpanded(mod, expandedModDetails)}
                          <ChevronDown size={14} />
                        {:else}
                          <ChevronRight size={14} />
                        {/if}
                      </button>
                      {#if hasModPageAction(mod, modProjectDetails)}
                        <button class="mod-row-icon-button" on:click|stopPropagation={() => openModPage(mod)} title="Open {getModPageLabel(mod, modProjectDetails)}" aria-label="Open {getModPageLabel(mod, modProjectDetails)}">
                          <ExternalLink size={14} />
                        </button>
                      {/if}
                    </div>
                  </div>
                  {#if isModDetailsExpanded(mod, expandedModDetails)}
                    <div class="mod-details-panel">
                      {#if isModDetailsLoading(mod, modDetailsLoading)}
                        <p class="mod-details-text">Loading Modrinth details...</p>
                      {:else if getModDetailError(mod, modProjectDetailErrors)}
                        <p class="mod-details-error">{getModDetailError(mod, modProjectDetailErrors)}</p>
                      {:else}
                        <p class="mod-details-text">{getModDetailsText(mod, getModProjectDetails(mod, modProjectDetails))}</p>
                        <div class="mod-details-meta">
                          {#if getModProjectDetails(mod, modProjectDetails).title && getModProjectDetails(mod, modProjectDetails).title !== mod.name}<span>{getModProjectDetails(mod, modProjectDetails).title}</span>{/if}
                          <span>Source: {getProjectSourceLabel(mod, getModProjectDetails(mod, modProjectDetails))}</span>
                          {#if mod.fileName}<span>{mod.fileName}</span>{/if}
                          {#if getModProjectIdentifier(mod)}<span>Project: {getModProjectIdentifier(mod)}</span>{/if}
                          {#if getModProjectDetails(mod, modProjectDetails).downloads}<span>{formatCompactNumber(getModProjectDetails(mod, modProjectDetails).downloads)} downloads</span>{/if}
                          {#if getModProjectDetails(mod, modProjectDetails).followers}<span>{formatCompactNumber(getModProjectDetails(mod, modProjectDetails).followers)} followers</span>{/if}
                          {#if getModProjectDetails(mod, modProjectDetails).clientSide}<span>Client: {formatSideSupport(getModProjectDetails(mod, modProjectDetails).clientSide)}</span>{/if}
                          {#if getModProjectDetails(mod, modProjectDetails).serverSide}<span>Server: {formatSideSupport(getModProjectDetails(mod, modProjectDetails).serverSide)}</span>{/if}
                        </div>
                      {/if}
                    </div>
                  {/if}
                </li>
              {/if}
            {/each}
          </ul>
        </div>
      {/if}

      <!-- Incompatible Mods -->
      {#if incompatibleMods.length > 0}
        <div class="compat-results warning">
          <h4>⚠️ Incompatible Mods ({incompatibleMods.length})</h4>          <p class="warning-text">These mods will be disabled during the update:</p>
          <ul class="incompatible-mods-list">
            {#each incompatibleMods as mod (mod.name)}
              <li
                class="incompatible-mod-item mod-detail-row"
                class:expanded={isModDetailsExpanded(mod, expandedModDetails)}
              >
                <div class="mod-row-main">
                  <span class="mod-name">{mod.name}</span>
                  {#if mod.currentVersion}
                    <span class="mod-version">{mod.currentVersion}</span>
                  {/if}
                  <span class="incompatible-reason">No compatible version found</span>
                  <div class="mod-row-actions">
                    <button class="mod-row-icon-button" on:click|stopPropagation={() => toggleModDetails(mod)} title={isModDetailsExpanded(mod, expandedModDetails) ? 'Hide mod details' : 'Show mod details'} aria-label={isModDetailsExpanded(mod, expandedModDetails) ? 'Hide mod details' : 'Show mod details'}>
                      {#if isModDetailsExpanded(mod, expandedModDetails)}
                        <ChevronDown size={14} />
                      {:else}
                        <ChevronRight size={14} />
                      {/if}
                    </button>
                    {#if hasModPageAction(mod, modProjectDetails)}
                      <button class="mod-row-icon-button" on:click|stopPropagation={() => openModPage(mod)} title="Open {getModPageLabel(mod, modProjectDetails)}" aria-label="Open {getModPageLabel(mod, modProjectDetails)}">
                        <ExternalLink size={14} />
                      </button>
                    {/if}
                    {#if mod.projectId}
                      <button class="watch-btn" on:click|stopPropagation={() => toggleWatch(mod)} title={activeWatches.has(watchKey(mod)) ? 'Remove watch' : 'Watch for availability'}>
                        {#if activeWatches.has(watchKey(mod))}🔔{:else}🔕{/if}
                      </button>
                    {/if}
                  </div>
                </div>
                {#if isModDetailsExpanded(mod, expandedModDetails)}
                  <div class="mod-details-panel">
                    {#if isModDetailsLoading(mod, modDetailsLoading)}
                      <p class="mod-details-text">Loading Modrinth details...</p>
                    {:else if getModDetailError(mod, modProjectDetailErrors)}
                      <p class="mod-details-error">{getModDetailError(mod, modProjectDetailErrors)}</p>
                    {:else}
                      <p class="mod-details-text">{getModDetailsText(mod, getModProjectDetails(mod, modProjectDetails))}</p>
                      <div class="mod-details-meta">
                        {#if getModProjectDetails(mod, modProjectDetails).title && getModProjectDetails(mod, modProjectDetails).title !== mod.name}<span>{getModProjectDetails(mod, modProjectDetails).title}</span>{/if}
                        <span>Source: {getProjectSourceLabel(mod, getModProjectDetails(mod, modProjectDetails))}</span>
                        {#if mod.fileName}<span>{mod.fileName}</span>{/if}
                        {#if getModProjectIdentifier(mod)}<span>Project: {getModProjectIdentifier(mod)}</span>{/if}
                        {#if getModProjectDetails(mod, modProjectDetails).downloads}<span>{formatCompactNumber(getModProjectDetails(mod, modProjectDetails).downloads)} downloads</span>{/if}
                        {#if getModProjectDetails(mod, modProjectDetails).followers}<span>{formatCompactNumber(getModProjectDetails(mod, modProjectDetails).followers)} followers</span>{/if}
                        {#if getModProjectDetails(mod, modProjectDetails).clientSide}<span>Client: {formatSideSupport(getModProjectDetails(mod, modProjectDetails).clientSide)}</span>{/if}
                        {#if getModProjectDetails(mod, modProjectDetails).serverSide}<span>Server: {formatSideSupport(getModProjectDetails(mod, modProjectDetails).serverSide)}</span>{/if}
                      </div>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- Summary -->
      <div class="compatibility-summary">
        <div class="summary-stats">
          <span class="stat-item compatible-count">
            {compatibleMods.length} Compatible
          </span>
          {#if modsWithUpdates.length > 0}
            <span class="stat-item updates-count">
              {modsWithUpdates.length} Updates
            </span>
          {/if}
          {#if incompatibleMods.length > 0}
            <span class="stat-item incompatible-count">
              {incompatibleMods.length} Incompatible
            </span>
          {/if}
        </div>
      </div>
    </div>
  {/if}
  <div class="watch-panel-toggle global">
    <button on:click={() => showWatchPanel = !showWatchPanel}>{showWatchPanel ? 'Hide' : 'Show'} Watched Mods</button>
  </div>
  {#if showWatchPanel}
    <div class="watch-panel">
      <div class="watch-header-row">
        <h5>Watched Mods ({$modAvailabilityWatchStore.watches.length})</h5>
        <button class="watch-settings-btn" on:click={() => showWatchSettings = !showWatchSettings} title="Mod watch settings">⚙️</button>
      </div>
      <div class="watch-config-line">Interval: {$modAvailabilityWatchStore.config.intervalHours}h | Last: {formatDate($modAvailabilityWatchStore.config.lastCheck)} | Next: {formatDate($modAvailabilityWatchStore.config.nextCheck)}</div>
      {#if showWatchSettings}
        <div class="watch-settings-form">
          <label><input type="checkbox" bind:checked={modWatchPrefs.showWindowsNotifications}> Windows Notification</label>
          <label>Interval:
            <select bind:value={modWatchPrefs.intervalHours}>
              <option value={12}>12 hours</option>
              <option value={24}>24 hours</option>
            </select>
          </label>
          <div class="settings-actions">
            <button on:click={saveModWatchPrefs}>Save</button>
            <button on:click={() => { showWatchSettings = false; loadModWatchPrefs(); }}>Cancel</button>
          </div>
        </div>
      {/if}
      {#if $modAvailabilityWatchStore.watches.length === 0}
        <p class="empty">No current watches.</p>
      {:else}
        <ul class="watch-list">
          {#each $modAvailabilityWatchStore.watches as w (deriveWatchKey(w))}
            <li class="watch-item">
              <div class="watch-main">
                <span class="watch-name">{w.modName || w.projectId}</span>
                <span class="watch-target">{formatWatchTarget(w.target)}</span>
                <span class="watch-added">added {formatDate(w.addedAt)}</span>
              </div>
              <div class="watch-buttons">
                <button class="remove-watch" on:click={() => modAvailabilityWatchStore.remove(resolvedPath, { projectId: w.projectId, target: w.target })}>✖</button>
              </div>
            </li>
          {/each}
        </ul>
        <div class="watch-actions">
          <button on:click={() => modAvailabilityWatchStore.clear(resolvedPath)}>Clear Watches</button>
        </div>
      {/if}
      <h5>History</h5>
      {#if $modAvailabilityWatchStore.history.length === 0}
        <p class="empty">No fulfilled watches yet.</p>
      {:else}
        <ul class="history-list">
          {#each $modAvailabilityWatchStore.history as h (h.projectId + h.foundAt)}
            <li class="history-item">
              <span class="hist-name">{h.modName || h.projectId}</span>
              <span class="hist-version">{h.versionFound}</span>
              <span class="hist-target">{formatWatchTarget(h.target)}</span>
              <span class="hist-time">{formatDate(h.foundAt)}</span>
            </li>
          {/each}
        </ul>
        <div class="watch-actions">
          <button on:click={() => modAvailabilityWatchStore.clearHistory(resolvedPath)}>Clear History</button>
        </div>
      {/if}
    </div>
  {/if}

  <button
    class="update-btn"
    on:click={updateServerVersion}
    disabled={!compatChecked || serverRunning || updating || targetJavaInfoLoading}
    title={serverRunning ? 'Stop the server before updating.' : (targetJavaInfoLoading ? 'Checking Java requirement...' : '')}
  >
    {updating ? 'Updating...' : 'Update Server Version'}
  </button>
  
  <!-- Update Progress -->
  {#if updating && (updateProgress > 0 || currentTask)}
    <div class="update-progress-container">
      <div class="progress-header">
        <h4>Update Progress</h4>
        <span class="progress-percentage">{updateProgress}%</span>
      </div>
      {#if currentTask}
        <p class="current-task">{currentTask}</p>
      {/if}
      <div class="progress-bar">
        <div class="progress-fill" style="width: {updateProgress}%"></div>
      </div>
      {#if updateStatus}
        <p class="update-status">{updateStatus}</p>
      {/if}
    </div>
  {/if}
    <!-- Comprehensive Update Summary -->
  {#if updateSummary}
    <div class="update-summary-container">
      <div class="summary-header">
        <h3>🎉 Update Complete!</h3>
        <p class="completion-time">Completed at {updateSummary.completedAt}</p>
      </div>

      <!-- Version Changes -->
      <div class="summary-section">
        <h4>📦 Version Updates</h4>
        <div class="version-changes">
          {#if updateSummary.versionChanges.minecraft.changed}
            <div class="version-change-item minecraft">
              <span class="change-label">Minecraft:</span>
              <span class="change-value">
                {updateSummary.versionChanges.minecraft.from} → {updateSummary.versionChanges.minecraft.to}
              </span>
            </div>
          {/if}
          {#if updateSummary.versionChanges.loaderVersion.changed}
            <div class="version-change-item fabric">
              <span class="change-label">{formatLoaderName(updateSummary.loader)} Loader:</span>
              <span class="change-value">
                {updateSummary.versionChanges.loaderVersion.from} → {updateSummary.versionChanges.loaderVersion.to}
              </span>
            </div>
          {/if}
        </div>
      </div>

      {#if updateSummary.preflightBackupWarning}
        <div class="summary-section warning">
          <h4>⚠️ Restore Point Warning</h4>
          <p class="warning-text">{updateSummary.preflightBackupWarning}</p>
        </div>
      {/if}

      <!-- Mod Updates -->
      {#if updateSummary.modUpdates.length > 0}
        <div class="summary-section">          <h4>🔄 Mod Updates ({updateSummary.modUpdates.length})</h4>
          <ul class="mod-updates-summary">
            {#each updateSummary.modUpdates as update (update.name)}
              <li class="mod-update-summary-item">
                <div class="mod-update-header">
                  <span class="mod-name">{update.name}</span>
                  <span class="version-change">{update.oldVersion} → {update.newVersion}</span>
                </div>
                <div class="file-change">
                  <span class="file-label">File:</span>
                  <span class="file-names">{update.oldFileName} → {update.newFileName}</span>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- Disabled Mods -->
      {#if updateSummary.disabledMods.length > 0}
        <div class="summary-section">
          <h4>⚠️ Disabled Mods ({updateSummary.disabledMods.length})</h4>          <p class="disabled-explanation">These mods were disabled because they're not compatible with the new version:</p>
          <ul class="disabled-mods-summary">
            {#each updateSummary.disabledMods as mod (mod.name)}
              <li class="disabled-mod-item">
                <span class="mod-name">{mod.name}</span>
                {#if mod.currentVersion}
                  <span class="mod-version">{mod.currentVersion}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- Compatible Mods -->
      {#if updateSummary.totalCompatibleMods > updateSummary.modUpdates.length}
        <div class="summary-section">
          <h4>✅ Compatible Mods ({updateSummary.totalCompatibleMods - updateSummary.modUpdates.length})</h4>
          <p class="compatible-explanation">
            {updateSummary.totalCompatibleMods - updateSummary.modUpdates.length} mod{updateSummary.totalCompatibleMods - updateSummary.modUpdates.length === 1 ? '' : 's'} 
            {updateSummary.totalCompatibleMods - updateSummary.modUpdates.length === 1 ? 'is' : 'are'} compatible and didn't need updates.
          </p>
        </div>
      {/if}

      <!-- Summary Stats -->
      <div class="summary-stats">
        <div class="stat-grid">
          <div class="stat-card">
            <span class="stat-number">{updateSummary.modUpdates.length}</span>
            <span class="stat-label">Mods Updated</span>
          </div>
          <div class="stat-card">
            <span class="stat-number">{updateSummary.totalCompatibleMods}</span>
            <span class="stat-label">Compatible Mods</span>
          </div>
          <div class="stat-card">
            <span class="stat-number">{updateSummary.disabledMods.length}</span>
            <span class="stat-label">Disabled Mods</span>
          </div>
        </div>
      </div>

      <!-- Action Button -->
      <button class="close-summary-btn" on:click={() => { updateSummary = null; completedUpdates = []; }}>
        Close Summary
      </button>
    </div>
  {/if}

  <!-- Fallback: Simple Completed Updates (if no summary available) -->
  {#if completedUpdates.length > 0 && !updateSummary}
    <div class="completed-updates-container">      <h4>✅ Completed Mod Updates ({completedUpdates.length})</h4>
      <ul class="completed-updates-list">
        {#each completedUpdates as update (update.name)}
          <li class="completed-update-item">
            <span class="mod-name">{update.name}</span>
            <span class="version-change">{update.oldVersion} → {update.newVersion}</span>
            <span class="file-change">{update.oldFileName} → {update.newFileName}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  
  {#if serverRunning}
    <p class="server-running-warning">Stop the server before updating.</p>
  {/if}
</div>

<!-- Update Confirmation Dialog -->
<ConfirmationDialog
  bind:visible={showUpdateConfirmation}
  title="Update Server Version"
  message={updateConfirmationMessage}
  confirmText="Update"
  cancelText="Cancel"
  confirmType="primary"
  backdropClosable={true}
  on:confirm={confirmUpdate}
  on:cancel={() => showUpdateConfirmation = false}
>
  <label class="restore-point-option">
    <input type="checkbox" bind:checked={createRestorePointBeforeUpdate} />
    <span>Create restore point before updating</span>
  </label>
</ConfirmationDialog>

<style>
  /* Remove ALL old container styling - this component is now wrapped in cards */
  .version-updater {
    background: none !important;
    border: none !important;
    border-radius: 0 !important;
    padding: 0 !important;
    margin: 0 !important;
    box-shadow: none !important;
    max-width: none !important;
  }

  /* Override component-specific sizes for compactness */
  .version-select select {
    background: rgba(17, 24, 39, 0.6) !important;
    border: 1px solid rgba(75, 85, 99, 0.4) !important;
    color: #e2e8f0 !important;
    border-radius: 4px !important;
    padding: 0.3rem 0.5rem !important;
    font-size: 0.8rem !important;
    margin: 0.25rem 0 !important;
  }

  .check-btn,
  .update-btn {
    background: rgba(59, 130, 246, 0.3) !important;
    border: 1px solid rgba(59, 130, 246, 0.5) !important;
    color: #3b82f6 !important;
    border-radius: 4px !important;
    padding: 0.3rem 0.6rem !important;
    font-size: 0.75rem !important;
    margin: 0.25rem 0 !important;
  }

  .check-btn:hover:not(:disabled),
  .update-btn:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.5) !important;
  }

  /* Compact results containers */
  .compat-results-container {
    margin: 0.5rem 0 !important;
    gap: 0.5rem !important;
  }

  .compat-results {
    margin: 0.25rem 0 !important;
    padding: 0.5rem !important;
    border-radius: 4px !important;
  }

  .compat-results h4 {
    margin: 0 0 0.25rem 0 !important;
    font-size: 0.8rem !important;
  }

  /* Original styles continue below... */
  .version-updater {
    background-color: #272727;
    padding: 1.5rem;
    border-radius: 8px;
    margin-top: 1.5rem;
    text-align: center;
    max-width: 600px;
    margin-left: auto;
    margin-right: auto;
  }
  .version-select {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  select {
    padding: 0.5rem;
    background-color: #2d3748;
    color: white;
    border: 1px solid #4b5563;
    border-radius: 4px;
    font-size: 1rem;
  }
  .check-btn, .update-btn {
    margin-top: 1rem;
    padding: 0.6rem 1.2rem;
    background-color: #4a6da7;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 0.2s;
  }
  .check-btn:hover:not(:disabled), .update-btn:hover:not(:disabled) {
    background-color: #5a7db7;
  }
  .update-btn {
    background-color: #3b82f6;
  }
  .update-btn:hover:not(:disabled) {
    background-color: #2563eb;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }  .compat-results {
    margin: 1rem 0;
    padding: 0.75rem;
    border-radius: 6px;
    text-align: left;
  }
  .compat-results.warning {
    background-color: rgba(255, 180, 0, 0.1);
    border: 1px solid rgba(255, 180, 0, 0.3);
  }
  .compat-results.success {
    background-color: rgba(76, 175, 80, 0.1);
    border: 1px solid rgba(76, 175, 80, 0.3);
  }
  .compat-results.info {
    background-color: rgba(33, 150, 243, 0.1);
    border: 1px solid rgba(33, 150, 243, 0.3);
  }
  .compat-results-container {
    margin: 1rem 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .compat-results h4 {
    margin: 0 0 0.5rem 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .mod-summary {
    color: #a0a0a0;
    font-size: 0.9rem;
  }
  .warning-text {
    color: #ffb347;
    margin: 0.5rem 0;
    font-size: 0.9rem;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }  .mod-updates-list, .incompatible-mods-list, .compatible-mods-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .mod-update-item, .incompatible-mod-item, .compatible-mod-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem;
    background-color: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    margin: 0;
  }
  .mod-detail-row {
    flex-direction: column;
    align-items: stretch;
    gap: 0.45rem;
  }
  .mod-detail-row.expanded {
    background-color: rgba(255, 255, 255, 0.07);
  }
  .mod-row-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 28px;
  }
  .mod-row-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
    flex: 0 0 auto;
  }
  .mod-row-icon-button {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: #cbd5e0;
    cursor: pointer;
    border-radius: 4px;
    padding: 0;
  }
  .mod-row-icon-button:hover {
    background: rgba(79, 195, 247, 0.16);
    border-color: rgba(79, 195, 247, 0.4);
    color: #e2f6ff;
  }
  .mod-details-panel {
    padding: 0.6rem 0.7rem;
    background: rgba(0, 0, 0, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 4px;
  }
  .mod-details-text,
  .mod-details-error {
    margin: 0;
    color: #cbd5e0;
    font-size: 0.78rem;
    line-height: 1.35;
  }
  .mod-details-error {
    color: #fc8181;
  }
  .mod-details-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.45rem;
  }
  .mod-details-meta span {
    color: #9fb7d0;
    background: rgba(79, 195, 247, 0.08);
    border: 1px solid rgba(79, 195, 247, 0.14);
    border-radius: 4px;
    padding: 0.15rem 0.35rem;
    font-size: 0.68rem;
  }
  .watch-btn { margin-left:0.5rem; background:transparent; border:1px solid rgba(255,255,255,0.2); color:#ffb347; cursor:pointer; border-radius:4px; padding:2px 6px; font-size:0.85rem; }
  .watch-btn:hover { background: rgba(255,255,255,0.1); }
  .mod-row-actions .watch-btn {
    height: 26px;
    margin-left: 0;
    padding: 0 0.35rem;
  }
  .watch-panel-toggle { margin-top:0.75rem; }
  .watch-panel-toggle.global { text-align:left; margin-top:1rem; }
  .watch-buttons { display:flex; gap:4px; }
  .watch-panel-toggle button { background:#2d3748; color:#fff; border:1px solid #4b5563; padding:0.3rem 0.6rem; border-radius:4px; cursor:pointer; font-size:0.75rem; }
  .watch-panel { margin-top:0.75rem; padding:0.6rem; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); border-radius:6px; font-size:0.75rem; }
  .restore-point-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    color: #dbeafe;
    font-size: 0.9rem;
    line-height: 1.3;
  }
  .restore-point-option input {
    width: 16px;
    height: 16px;
    accent-color: #3b82f6;
    flex: 0 0 auto;
  }
  .watch-header-row { display:flex; justify-content:space-between; align-items:center; }
  .watch-settings-btn { background:transparent; border:1px solid rgba(255,255,255,0.2); color:#a0aec0; cursor:pointer; border-radius:4px; padding:2px 6px; font-size:0.7rem; }
  .watch-settings-btn:hover { background:rgba(255,255,255,0.1); }
  .watch-settings-form { margin:0.5rem 0; display:flex; gap:1rem; flex-wrap:wrap; align-items:center; background:rgba(0,0,0,0.25); padding:6px 8px; border-radius:4px; }
  .watch-settings-form label { display:flex; gap:4px; align-items:center; font-size:0.65rem; }
  .watch-settings-form select { background:#2d3748; color:#e2e8f0; border:1px solid #4b5563; border-radius:4px; font-size:0.65rem; padding:2px 4px; }
  .settings-actions { display:flex; gap:6px; }
  .settings-actions button { background:#4a5568; border:1px solid #2d3748; color:#e2e8f0; padding:2px 8px; font-size:0.6rem; border-radius:4px; cursor:pointer; }
  .settings-actions button:hover { background:#2d3748; }
  .watch-panel h5 { margin:0.4rem 0 0.3rem 0; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px; color:#a0aec0; }
  .watch-config-line { font-size:0.65rem; color:#718096; margin-bottom:0.3rem; }
  .watch-list, .history-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
  .watch-item, .history-item { display:flex; align-items:center; justify-content:space-between; background:rgba(0,0,0,0.2); padding:4px 6px; border-radius:4px; }
  .watch-main { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .watch-name { font-weight:500; color:#e2e8f0; }
  .watch-target { color:#63b3ed; font-family:'Courier New', monospace; }
  .watch-added { color:#718096; font-size:0.6rem; }
  .remove-watch { background:transparent; border:none; color:#f56565; cursor:pointer; font-size:0.8rem; }
  .remove-watch:hover { color:#fc8181; }
  .hist-name { font-weight:500; color:#e2e8f0; }
  .hist-version { color:#48bb78; font-family:'Courier New', monospace; }
  .hist-target { color:#63b3ed; font-family:'Courier New', monospace; }
  .hist-time { color:#a0aec0; font-size:0.6rem; }
  .watch-actions { margin-top:4px; display:flex; gap:6px; }
  .watch-actions button { background:#4a5568; border:1px solid #2d3748; color:#e2e8f0; padding:2px 8px; font-size:0.65rem; border-radius:4px; cursor:pointer; }
  .watch-actions button:hover { background:#2d3748; }
  .empty { color:#718096; font-style:italic; }
  .mod-name {
    font-weight: 500;
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .version-change {
    font-family: 'Courier New', monospace;
    color: #4fc3f7;
    font-size: 0.9rem;
    background-color: rgba(79, 195, 247, 0.1);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
  }
  .mod-version {
    color: #a0a0a0;
    font-size: 0.85rem;
    margin-right: 0.5rem;
  }
  .incompatible-reason {
    color: #ff8a65;
    font-size: 0.85rem;
    font-style: italic;
  }
  .compatible-status {
    color: #4caf50;
    font-size: 0.85rem;
    font-weight: 500;
  }
  .compatibility-summary {
    margin-top: 1rem;
    padding: 0.75rem;
    background-color: rgba(255, 255, 255, 0.03);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  .summary-stats {
    display: flex;
    gap: 1rem;
    justify-content: center;
    flex-wrap: wrap;
  }
  .stat-item {
    font-size: 0.9rem;
    font-weight: 500;
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
  }
  .compatible-count {
    background-color: rgba(76, 175, 80, 0.2);
    color: #81c784;
  }
  .updates-count {
    background-color: rgba(33, 150, 243, 0.2);
    color: #64b5f6;
  }
  .incompatible-count {
    background-color: rgba(255, 152, 0, 0.2);
    color: #ffb74d;
  }  li {
    margin: 0.25rem 0;
  }
  .server-running-warning {
    color: #ff9800;
    margin-top: 0.5rem;
  }
  
  /* Completed Updates Styles */
  .completed-updates-container {
    margin: 1rem 0;
    padding: 1rem;
    background-color: rgba(76, 175, 80, 0.1);
    border-radius: 6px;
    border: 1px solid rgba(76, 175, 80, 0.3);
  }
  
  .completed-updates-list {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0 0 0;
  }
  
  .completed-update-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem;
    margin: 0.25rem 0;
    background-color: rgba(76, 175, 80, 0.05);
    border-radius: 4px;
    border-left: 3px solid #4caf50;
  }
  
  .completed-update-item .mod-name {
    font-weight: 600;
    color: #e2e8f0;
  }
  
  .completed-update-item .version-change {
    color: #4caf50;
    font-size: 0.9rem;
  }
  
  .completed-update-item .file-change {
    color: #94a3b8;
    font-size: 0.8rem;
    font-style: italic;
  }
  
  /* Update Progress Styles */
  .update-progress-container {
    margin: 1rem 0;
    padding: 1rem;
    background-color: rgba(255, 255, 255, 0.03);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  
  .progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  
  .progress-header h4 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: #4fc3f7;
  }
  
  .progress-percentage {
    font-size: 0.9rem;
    font-weight: 600;
    color: #4fc3f7;
  }
  
  .current-task {
    margin: 0.5rem 0;
    font-size: 0.9rem;
    color: #a0a0a0;
    text-align: left;
  }
  
  .progress-bar {
    width: 100%;
    height: 8px;
    background-color: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
    margin: 0.5rem 0;
  }
  
  .progress-fill {
    height: 100%;
    background-color: #4fc3f7;
    border-radius: 4px;
    transition: width 0.3s ease;
  }
  
  .update-status {
    margin: 0.5rem 0 0 0;
    font-size: 0.8rem;
    color: #4fc3f7;
    text-align: left;
  }
  
  .completed-updates-container {
    margin: 1rem 0;
    padding: 0.75rem;
    background-color: rgba(76, 175, 80, 0.1);
    border-radius: 6px;
    border: 1px solid rgba(76, 175, 80, 0.3);
    text-align: left;
  }
  
  .completed-updates-container h4 {
    margin: 0 0 0.5rem 0;
    font-size: 1rem;
    font-weight: 600;
    color: #4caf50;
  }
  
  .completed-updates-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .completed-update-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem;
    margin: 0.25rem 0;
    background-color: rgba(76, 175, 80, 0.05);
    border-radius: 4px;
    border-left: 3px solid #4caf50;
  }
    .file-change {
    color: #a0a0a0;
    font-size: 0.85rem;
    margin-left: 0.5rem;
  }

  /* Comprehensive Update Summary Styles */
  .update-summary-container {
    margin: 1.5rem 0;
    padding: 1.5rem;
    background: linear-gradient(135deg, rgba(76, 175, 80, 0.1) 0%, rgba(76, 175, 80, 0.05) 100%);
    border-radius: 12px;
    border: 1px solid rgba(76, 175, 80, 0.3);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  }

  .summary-header {
    text-align: center;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid rgba(76, 175, 80, 0.2);
  }

  .summary-header h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.5rem;
    font-weight: 700;
    color: #4caf50;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  .completion-time {
    margin: 0;
    font-size: 0.9rem;
    color: #94a3b8;
    font-style: italic;
  }

  .summary-section {
    margin: 1.25rem 0;
    padding: 1rem;
    background-color: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
    border-left: 4px solid #4caf50;
  }

  .summary-section h4 {
    margin: 0 0 0.75rem 0;
    font-size: 1.1rem;
    font-weight: 600;
    color: #e2e8f0;
  }

  .version-changes {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .version-change-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background-color: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
  }

  .version-change-item.minecraft {
    border-left: 3px solid #8bc34a;
  }

  .version-change-item.fabric {
    border-left: 3px solid #2196f3;
  }

  .change-label {
    font-weight: 500;
    color: #cbd5e0;
  }

  .change-value {
    font-family: 'Courier New', monospace;
    color: #4fc3f7;
    background-color: rgba(79, 195, 247, 0.1);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.9rem;
  }

  .mod-updates-summary {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .mod-update-summary-item {
    padding: 0.75rem;
    background-color: rgba(33, 150, 243, 0.05);
    border-radius: 6px;
    border-left: 3px solid #2196f3;
  }

  .mod-update-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .mod-update-header .mod-name {
    font-weight: 600;
    color: #e2e8f0;
  }

  .mod-update-header .version-change {
    font-family: 'Courier New', monospace;
    color: #2196f3;
    background-color: rgba(33, 150, 243, 0.1);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.85rem;
  }

  .file-change {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }

  .file-label {
    color: #94a3b8;
    font-weight: 500;
  }

  .file-names {
    color: #64748b;
    font-family: 'Courier New', monospace;
  }

  .disabled-explanation, .compatible-explanation {
    margin: 0.5rem 0;
    color: #94a3b8;
    font-size: 0.9rem;
    line-height: 1.4;
  }

  .disabled-mods-summary {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .disabled-mod-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background-color: rgba(255, 152, 0, 0.05);
    border-radius: 6px;
    border-left: 3px solid #ff9800;
  }

  .disabled-mod-item .mod-name {
    font-weight: 500;
    color: #e2e8f0;
  }

  .disabled-mod-item .mod-version {
    color: #94a3b8;
    font-size: 0.85rem;
  }

  .summary-stats {
    margin: 1.5rem 0 1rem 0;
    padding: 1rem;
    background-color: rgba(255, 255, 255, 0.02);
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 1rem;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0.75rem;
    background-color: rgba(255, 255, 255, 0.03);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .stat-number {
    font-size: 1.5rem;
    font-weight: 700;
    color: #4fc3f7;
    margin-bottom: 0.25rem;
  }

  .stat-label {
    font-size: 0.8rem;
    color: #94a3b8;
    text-align: center;
    line-height: 1.2;
  }

  .close-summary-btn {
    display: block;
    margin: 0 auto;
    padding: 0.75rem 1.5rem;
    background-color: #4caf50;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.3s ease;
  }

  .close-summary-btn:hover {
    background-color: #45a049;
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(76, 175, 80, 0.3);
  }

  .check-btn:disabled {
    background-color: #444 !important;
    cursor: not-allowed;
  }
  
  .check-info {
    margin-top: 8px;
    padding: 8px 12px;
    background: rgba(52, 213, 138, 0.1);
    border: 1px solid rgba(52, 213, 138, 0.3);
    border-radius: 4px;
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  
  .check-info p {
    margin: 0;
    color: #34d58a;
  }

  .java-requirement {
    color: #93c5fd !important;
  }

  .java-requirement.pending-java {
    color: #fbbf24 !important;
  }

  .java-requirement.missing-java {
    color: #f59e0b !important;
  }

  .compatibility-check-progress {
    margin: 0.5rem 0;
    padding: 0.75rem;
    background: rgba(59, 130, 246, 0.08);
    border: 1px solid rgba(59, 130, 246, 0.25);
    border-radius: 4px;
    text-align: left;
  }

  .compatibility-progress-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.45rem;
    color: #bfdbfe;
    font-size: 0.82rem;
  }

  .compatibility-progress-header span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .compatibility-progress-header strong {
    color: #60a5fa;
    font-size: 0.78rem;
    flex: 0 0 auto;
  }

  .progress-bar.indeterminate .progress-fill {
    animation: compatibility-progress-pulse 1.2s ease-in-out infinite alternate;
  }

  @keyframes compatibility-progress-pulse {
    from {
      transform: translateX(-40%);
    }

    to {
      transform: translateX(190%);
    }
  }
</style>
