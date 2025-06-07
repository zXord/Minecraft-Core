<script>
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { serverState } from '../../stores/serverState.js';
  import { settingsStore, updateVersions } from '../../stores/settingsStore.js';
  import { safeInvoke, showConfirmationDialog } from '../../utils/ipcUtils.js';
  import { checkDependencyCompatibility } from '../../utils/mods/modCompatibility.js';

  export let serverPath = '';

  let mcVersions = [];
  let fabricVersions = [];
  let selectedMC = null;
  let selectedFabric = null;
  let checking = false;
  let updating = false;
  let compatChecked = false;
  let incompatibleMods = [];

  // Track current server status
  $: serverStatus = $serverState.status;
  $: serverRunning = serverStatus === 'Running';

  $: resolvedPath = serverPath || get(settingsStore).path;

  onMount(() => {
    fetchMinecraftVersions();
  });

  async function fetchMinecraftVersions() {
    try {
      const res = await fetch('https://meta.fabricmc.net/v2/versions/game');
      const data = await res.json();
      mcVersions = data.filter(v => v.stable).map(v => v.version);
    } catch (err) {
      console.error('Failed to fetch MC versions', err);
      mcVersions = [];
    }
  }

  async function onMCChange() {
    selectedFabric = null;
    fabricVersions = [];
    if (!selectedMC) return;
    try {
      const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${selectedMC}`);
      const data = await res.json();
      fabricVersions = data.map(v => v.loader.version);
    } catch (err) {
      console.error('Failed to fetch Fabric versions', err);
      fabricVersions = [];
    }
  }

  async function checkCompatibility() {
    if (!selectedMC || !selectedFabric) return;
    checking = true;
    compatChecked = false;
    incompatibleMods = [];
    try {
      const results = await safeInvoke('check-mod-compatibility', {
        serverPath: resolvedPath,
        mcVersion: selectedMC,
        fabricVersion: selectedFabric
      });
      for (const mod of results) {
        let incompatible = !mod.compatible;
        if (mod.dependencies && mod.dependencies.length > 0) {
          const issues = await checkDependencyCompatibility(mod.dependencies, mod.projectId);
          if (issues.length > 0) {
            incompatible = true;
          }
        }
        if (incompatible) {
          incompatibleMods.push(mod.fileName || mod.name || mod.projectId);
        }
      }
      compatChecked = true;
    } catch (err) {
      console.error('Compatibility check failed', err);
    }
    checking = false;
  }

  async function updateServerVersion() {
    const confirmed = await showConfirmationDialog(`Update server to Minecraft ${selectedMC} with Fabric ${selectedFabric}? Incompatible mods will be disabled.`);
    if (!confirmed) return;
    updating = true;
    try {
      await safeInvoke('download-minecraft-server', { mcVersion: selectedMC, targetPath: resolvedPath });
      await safeInvoke('download-and-install-fabric', { path: resolvedPath, mcVersion: selectedMC, fabricVersion: selectedFabric });
      await safeInvoke('update-config', { serverPath: resolvedPath, updates: { version: selectedMC, fabric: selectedFabric } });
      if (incompatibleMods.length > 0) {
        await safeInvoke('save-disabled-mods', resolvedPath, incompatibleMods);
      }
      updateVersions(selectedMC, selectedFabric);
      compatChecked = false;
    } catch (err) {
      console.error('Update failed', err);
    }
    updating = false;
  }
</script>

<div class="version-updater">
  <h3>Server Version Updater</h3>
  <div class="version-select">
    <select bind:value={selectedMC} on:change={onMCChange}>
      <option value="" disabled selected>Select Minecraft Version</option>
      {#each mcVersions as v}
        <option value={v}>{v}</option>
      {/each}
    </select>

    {#if selectedMC}
      <select bind:value={selectedFabric}>
        <option value="" disabled selected>Select Fabric Loader</option>
        {#each fabricVersions as f}
          <option value={f}>{f}</option>
        {/each}
      </select>
    {/if}
  </div>

  <button class="check-btn" on:click={checkCompatibility} disabled={!selectedFabric || checking}>
    {checking ? 'Checking...' : 'Check Compatibility'}
  </button>

  {#if compatChecked}
    {#if incompatibleMods.length}
      <div class="compat-results warning">
        <h4>Incompatible Mods</h4>
        <ul>
          {#each incompatibleMods as m}
            <li>{m}</li>
          {/each}
        </ul>
      </div>
    {:else}
      <div class="compat-results success">All mods are compatible!</div>
    {/if}
  {/if}

  <button
    class="update-btn"
    on:click={updateServerVersion}
    disabled={!compatChecked || serverRunning || updating}
    title={serverRunning ? 'Stop the server before updating.' : ''}
  >
    {updating ? 'Updating...' : 'Update Server Version'}
  </button>
  {#if serverRunning}
    <p class="server-running-warning">Stop the server before updating.</p>
  {/if}
</div>

<style>
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
  }
  .compat-results {
    margin: 1rem 0;
    padding: 0.75rem;
    border-radius: 6px;
  }
  .compat-results.warning {
    background-color: rgba(255, 180, 0, 0.1);
    border: 1px solid rgba(255, 180, 0, 0.3);
  }
  .compat-results.success {
    background-color: rgba(76, 175, 80, 0.1);
    border: 1px solid rgba(76, 175, 80, 0.3);
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    margin: 0.25rem 0;
  }
  .server-running-warning {
    color: #ff9800;
    margin-top: 0.5rem;
  }
</style>
