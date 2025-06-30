<script>  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { serverState } from '../../stores/serverState.js';
  import { settingsStore, updateVersions } from '../../stores/settingsStore.js';
  import { safeInvoke } from '../../utils/ipcUtils.js';
  import ConfirmationDialog from '../common/ConfirmationDialog.svelte';
  import { fetchAllFabricVersions } from '../../utils/versionUtils.js';

  export let serverPath = '';

  let mcVersions = [];
  let fabricVersions = [];
  let selectedMC = null;
  let selectedFabric = null;  let checking = false;
  let updating = false;
  let compatChecked = false;
  let incompatibleMods = [];
  let compatibleMods = [];
  let modsWithUpdates = [];
  let showUpdateConfirmation = false;  let updateProgress = 0;
  let updateStatus = '';
  let currentTask = '';  let totalSteps = 0;
  let currentStep = 0;
  let completedUpdates = []; // Track successful mod updates
  let updateSummary = null; // Complete summary of all changes

  // Track current server status
  $: serverStatus = $serverState.status;
  $: serverRunning = serverStatus === 'Running';

  $: resolvedPath = serverPath || get(settingsStore).path;
  
  // Debug completed updates
  $: if (completedUpdates.length > 0) {
  }
  onMount(() => {
    fetchMinecraftVersions();
      // Set up progress listeners
    window.electron.on('minecraft-server-progress', (data) => {
      updateProgress = Math.round(data.percent || 0);
      updateStatus = data.speed || '';
      currentTask = 'Downloading Minecraft server...';
    });
    
    window.electron.on('fabric-install-progress', (data) => {
      updateProgress = Math.round(data.percent || 0);
      updateStatus = data.speed || '';
      currentTask = 'Installing Fabric loader...';
    });
      window.electron.on('download-progress', (data) => {
      if (data.id && data.id.startsWith('mod-')) {
        updateProgress = Math.round(data.progress || 0);
        updateStatus = data.speed ? `${(data.speed / 1024 / 1024).toFixed(2)} MB/s` : '';
        currentTask = `Updating ${data.name || 'mod'}...`;
      }
    });
    
    window.electron.on('server-java-download-progress', (data) => {
      if (data && typeof data === 'object') {
        updateProgress = data.progress || 0;
        updateStatus = data.downloadedMB && data.totalMB 
          ? `${data.downloadedMB}/${data.totalMB} MB`
          : '';
        currentTask = `Java: ${data.task}`;
      }
    });
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
    if (!selectedMC) return;
    try {
      fabricVersions = await fetchAllFabricVersions(selectedMC);
    } catch (err) {
    }
  }    async function checkCompatibility() {
    if (!selectedMC || !selectedFabric) return;
    checking = true;
    compatChecked = false;
    incompatibleMods = [];
    compatibleMods = [];
    modsWithUpdates = [];
    completedUpdates = []; // Clear previous completed updates
    updateSummary = null; // Clear previous update summary
    
    try {
      const results = await safeInvoke('check-mod-compatibility', {
        serverPath: resolvedPath,
        mcVersion: selectedMC,
        fabricVersion: selectedFabric
      });
      
      // Get disabled mods to filter them out from frontend processing as well
      const disabledModsList = await safeInvoke('get-disabled-mods', resolvedPath);
      const disabledModsSet = new Set(disabledModsList || []);
      
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
                v.loaders && v.loaders.includes('fabric')
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
    }
    checking = false;
  }
  async function updateServerVersion() {
    showUpdateConfirmation = true;
  }  async function confirmUpdate() {
    showUpdateConfirmation = false;
    updating = true;
    updateProgress = 0;
    currentTask = 'Starting update...';
    
    // Capture current versions before update
    const currentSettings = get(settingsStore);
    const beforeUpdate = {
      mcVersion: currentSettings.mcVersion,
      fabricVersion: currentSettings.fabricVersion
    };
      
    // Reset tracking arrays
    completedUpdates = [];
    updateSummary = null;
      
      // Calculate total steps for progress tracking
    totalSteps = 4; // Minecraft server, Fabric, Java, Config
    if (modsWithUpdates.length > 0) totalSteps += modsWithUpdates.length;
    if (incompatibleMods.length > 0) totalSteps += 1;
    currentStep = 0;
    
    try {
      // Step 1: Download Minecraft server
      currentStep++;
      currentTask = 'Downloading Minecraft server...';
      updateProgress = Math.round((currentStep / totalSteps) * 100);
      await safeInvoke('download-minecraft-server', { mcVersion: selectedMC, targetPath: resolvedPath });
      
      // Step 2: Install Fabric
      currentStep++;
      currentTask = 'Installing Fabric loader...';
      updateProgress = Math.round((currentStep / totalSteps) * 100);
      await safeInvoke('download-and-install-fabric', { path: resolvedPath, mcVersion: selectedMC, fabricVersion: selectedFabric });
      
      // Step 3: Check and download Java if needed
      currentStep++;
      currentTask = 'Checking Java requirements...';
      updateProgress = Math.round((currentStep / totalSteps) * 100);
      try {
        const javaResult = await safeInvoke('server-java-ensure', {
          minecraftVersion: selectedMC,
          serverPath: resolvedPath
        });
        
        if (javaResult.success) {
          currentTask = 'Java ready for server!';
        } else {
          // Java download failed, but don't fail the whole update - it will download on server start
          currentTask = `Java setup skipped - will download on server start`;
        }
      } catch (javaError) {
        // Java download failed, but don't fail the whole update
        currentTask = 'Java setup skipped - will download on server start';
      }
      
      // Step 4: Update mods that have new versions
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
              fileName: mod.fileName
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
      
      // Step 5: Update server config
      currentStep++;
      currentTask = 'Updating configuration...';
      updateProgress = Math.round((currentStep / totalSteps) * 100);
      await safeInvoke('update-config', { serverPath: resolvedPath, updates: { version: selectedMC, fabric: selectedFabric } });
      
      // Step 6: Handle incompatible mods
      if (incompatibleMods.length > 0) {
        currentStep++;
        currentTask = 'Disabling incompatible mods...';
        updateProgress = Math.round((currentStep / totalSteps) * 100);
        // Extract just the filenames from incompatible mods for the disable operation
        const modFilesToDisable = incompatibleMods.map(mod => mod.fileName);
        await safeInvoke('save-disabled-mods', resolvedPath, modFilesToDisable);
      }        // Step 7: Update version state
      updateVersions(selectedMC, selectedFabric);
      compatChecked = false;
        // Create comprehensive update summary
      updateSummary = {
        versionChanges: {
          minecraft: {
            from: beforeUpdate.mcVersion,
            to: selectedMC,
            changed: beforeUpdate.mcVersion !== selectedMC
          },
          fabric: {
            from: beforeUpdate.fabricVersion,
            to: selectedFabric,
            changed: beforeUpdate.fabricVersion !== selectedFabric
          }
        },
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

    {#if selectedMC}      <select bind:value={selectedFabric}>
        <option value="" disabled selected>Select Fabric Loader</option>
        {#each fabricVersions as f (f)}
          <option value={f}>
            {#if $settingsStore.fabricVersion && $settingsStore.fabricVersion !== f}
              {$settingsStore.fabricVersion} → {f}
            {:else}
              {f}
            {/if}
          </option>
        {/each}
      </select>
    {/if}
  </div>

  <button class="check-btn" on:click={checkCompatibility} disabled={!selectedFabric || checking}>
    {checking ? 'Checking...' : 'Check Compatibility'}
  </button>
  
  <div class="check-info">
    <p>Note: Only enabled mods are checked for compatibility. Disabled mods will remain disabled and unchanged.</p>
  </div>
  {#if compatChecked}
    <div class="compat-results-container">
      <!-- Mod Updates Available -->
      {#if modsWithUpdates.length > 0}
        <div class="compat-results info">          <h4>🔄 Mod Updates Available ({modsWithUpdates.length})</h4>
          <ul class="mod-updates-list">
            {#each modsWithUpdates as mod (mod.name)}
              <li class="mod-update-item">
                <span class="mod-name">{mod.name}</span>
                <span class="version-change">{mod.currentVersion} → {mod.newVersion}</span>
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
                <li class="compatible-mod-item">
                  <span class="mod-name">{mod.name}</span>
                  {#if mod.currentVersion}
                    <span class="mod-version">v{mod.currentVersion}</span>
                  {/if}
                  <span class="compatible-status">✅ Compatible</span>
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
              <li class="incompatible-mod-item">
                <span class="mod-name">{mod.name}</span>
                {#if mod.currentVersion}
                  <span class="mod-version">v{mod.currentVersion}</span>
                {/if}
                <span class="incompatible-reason">No compatible version found</span>
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
  <button
    class="update-btn"
    on:click={updateServerVersion}
    disabled={!compatChecked || serverRunning || updating}
    title={serverRunning ? 'Stop the server before updating.' : ''}
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
          {#if updateSummary.versionChanges.fabric.changed}
            <div class="version-change-item fabric">
              <span class="change-label">Fabric Loader:</span>
              <span class="change-value">
                {updateSummary.versionChanges.fabric.from} → {updateSummary.versionChanges.fabric.to}
              </span>
            </div>
          {/if}
        </div>
      </div>

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
                  <span class="mod-version">v{mod.currentVersion}</span>
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
      <button class="close-summary-btn" on:click={() => updateSummary = null}>
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
  message="Update server to Minecraft {selectedMC} with Fabric {selectedFabric}?{incompatibleMods.length > 0 ? ' Incompatible mods will be disabled.' : ''}"
  confirmText="Update"
  cancelText="Cancel"
  confirmType="primary"
  backdropClosable={true}
  on:confirm={confirmUpdate}
  on:cancel={() => showUpdateConfirmation = false}
/>

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
  .mod-name {
    font-weight: 500;
    flex: 1;
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
  }
  
  .check-info p {
    margin: 0;
    color: #34d58a;
  }
</style>
