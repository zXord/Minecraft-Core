<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { createEventDispatcher, onMount } from 'svelte';
  
  // Event dispatcher to communicate with parent component
  const dispatch = createEventDispatcher();
  
  // State variables
  let path = '';
  let mcVersions = [];
  let fabricVersions = [];
  let selectedMC = null;
  let selectedFabric = null;
  let acceptEula = false;
  let installing = false;
  let installProgress = 0;
  let installSpeed = '0 MB/s';
  let installLogs = [];
  let step = 'chooseFolder'; // chooseFolder → chooseVersion → done
  
  // Functions
  async function selectFolder() {
    try {
      const result = await window.electron.invoke('select-folder');
      if (!result) {
        return;
      }
      path = result;
      
      // Update global server path
      if (window.serverPath) {
        window.serverPath.set(path);
      }

      const config = await window.electron.invoke('read-config', path);
      if (config?.version && config?.fabric) {
        // Existing configuration found
        selectedMC = config.version;
        selectedFabric = config.fabric;
        
        // Skip to completion
        dispatchSetupComplete();
      } else {
        // Need to configure
        step = 'chooseVersion';
        await fetchMinecraftVersions();
      }
    } catch (err) {
    }
  }
  
  async function fetchMinecraftVersions() {
    try {
    const res = await fetch('https://meta.fabricmc.net/v2/versions/game');
      if (!res.ok) {
        throw new Error(`Failed to fetch Minecraft versions: ${res.status}`);
      }
      const data = await res.json();
      mcVersions = data.filter(v => v.stable).map(v => v.version);
    } catch (err) {
      mcVersions = [];
    }
  }

  async function onMCVersionChange() {
    selectedFabric = null;
    try {
    const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${selectedMC}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch Fabric versions: ${res.status}`);
      }
      const data = await res.json();
      fabricVersions = data.map(v => v.loader.version);
    } catch (err) {
      fabricVersions = [];
    }
  }
  
  async function saveVersionSelection() {
    try {
      installing = true;
      installLogs = [];
      installProgress = 0;
      installSpeed = 'Starting...';
    
      // Register event handlers for installation progress
      setupInstallationListeners();
      
      // Add initial log message
      installLogs = [...installLogs, 'Starting server setup...'];
    
      // Save configuration
      installLogs = [...installLogs, 'Saving configuration...'];
      await window.electron.invoke('save-version-selection', {
        path,
        mcVersion: selectedMC,
        fabricVersion: selectedFabric
      });
      
      // Download Minecraft server
      installLogs = [...installLogs, `Downloading Minecraft server version ${selectedMC}...`];
      await window.electron.invoke('download-minecraft-server', {
        mcVersion: selectedMC,
        targetPath: path
      });
      
      // Accept EULA if checked
      if (acceptEula) {
        installLogs = [...installLogs, 'Accepting Minecraft EULA...'];
        await window.electron.invoke('write-eula', { path, content: 'eula=true\n' });
      }
      
      // Install Fabric
      installLogs = [...installLogs, `Installing Fabric ${selectedFabric}...`];
      await window.electron.invoke('download-and-install-fabric', {
        path,
        mcVersion: selectedMC,
        fabricVersion: selectedFabric
      });
      
      // Download Java for the server
      installLogs = [...installLogs, 'Checking Java requirements...'];
      try {
        const javaResult = await window.electron.invoke('server-java-ensure', {
          minecraftVersion: selectedMC,
          serverPath: path
        });
        
        if (javaResult.success) {
          installLogs = [...installLogs, 'Java ready for server!'];
        } else {
          // Java download failed, but don't fail the whole setup - it will download on first start
          installLogs = [...installLogs, `Java setup skipped: ${javaResult.error || 'Will download on first server start'}`];
        }
      } catch (javaError) {
        // Java download failed, but don't fail the whole setup
        installLogs = [...installLogs, 'Java setup skipped - will download on first server start'];
      }
      
      // Complete setup
      installLogs = [...installLogs, 'Setup completed successfully!'];
      installing = false;
      dispatchSetupComplete();
    } catch (err) {
      installing = false;
      installLogs = [...installLogs, `Error: ${err.message || 'Unknown error during installation'}`];
    }
  }
  
  function setupInstallationListeners() {
    // Remove any existing listeners first to prevent duplicates
    window.electron.removeAllListeners('minecraft-server-progress');
    window.electron.removeAllListeners('fabric-install-progress');
    window.electron.removeAllListeners('install-log');
    window.electron.removeAllListeners('server-java-download-progress');
    
    // Add new listeners
    window.electron.on('minecraft-server-progress', (data) => {
      if (data && typeof data === 'object') {
        installProgress = data.percent || 0;
        installSpeed = data.speed || '0 MB/s';
      }
    });
    
    window.electron.on('fabric-install-progress', (data) => {
      if (data && typeof data === 'object') {
        installProgress = data.percent || 0;
        installSpeed = data.speed || '0 MB/s';
      }
    });
    
    window.electron.on('install-log', (line) => {
      if (line && typeof line === 'string') {
        installLogs = [...installLogs, line];
      }
    });
    
    window.electron.on('server-java-download-progress', (data) => {
      if (data && typeof data === 'object') {
        installProgress = data.progress || 0;
        installSpeed = data.downloadedMB && data.totalMB 
          ? `${data.downloadedMB}/${data.totalMB} MB`
          : '';
        installLogs = [...installLogs, `Java: ${data.task}`];
      }
    });
  }
  
  function dispatchSetupComplete() {
    // Make sure path is not empty
    if (!path || path.trim() === '') {
      return;
    }
    
    // Use a setTimeout to ensure the event is dispatched after the current execution
    setTimeout(() => {
      dispatch('setup-complete', { 
        path, 
        mcVersion: selectedMC, 
        fabricVersion: selectedFabric 
      });
    }, 0);
  }
  
  onMount(() => {
    // Setup listeners on mount to catch any delayed events
    setupInstallationListeners();
    
    // Clean up event listeners when component is unmounted
    return () => {
      window.electron.removeAllListeners('minecraft-server-progress');
      window.electron.removeAllListeners('fabric-install-progress');
      window.electron.removeAllListeners('install-log');
      window.electron.removeAllListeners('server-java-download-progress');
    };
  });
</script>

<div class="setup-wizard">
  {#if step === 'chooseFolder'}
    <h1>Select a folder to set up Minecraft Core</h1>
    <p>Click the button below to choose a folder for your Minecraft server</p>
    <button class="action-button large-button" on:click={selectFolder}>
      📁 Choose Folder
    </button>
  
  {:else if step === 'chooseVersion'}
    <div class="version-selection">
      <h2>Choose Minecraft version</h2>
      <select bind:value={selectedMC} on:change={onMCVersionChange}>        <option disabled selected value={null}>
          -- Select Minecraft Version --
        </option>
        {#each mcVersions as v (v)}
          <option value={v}>{v}</option>
        {/each}
      </select>

      {#if selectedMC}
        <h2>Choose Fabric loader version</h2>
        <select bind:value={selectedFabric}>          <option disabled selected value={null}>
            -- Select Fabric Loader --
          </option>
          {#each fabricVersions as v (v)}
            <option value={v}>{v}</option>
          {/each}
        </select>
      {/if}

      {#if selectedFabric}
        <label class="eula-label">
          <input
            type="checkbox"
            bind:checked={acceptEula}
          />
          <span>I accept the Minecraft EULA</span>
        </label>
        
        {#if !acceptEula}
          <p class="eula-warning">You must accept the EULA to continue</p>
        {/if}
        
        <button 
          class="action-button" 
          disabled={!acceptEula || installing} 
          on:click={saveVersionSelection}
        >
          {installing ? 'Installing...' : 'Install Server'}
        </button>
      {/if}

      {#if installing}
        <div class="installation-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: {installProgress}%"></div>
          </div>
          <p class="progress-text">Progress: {installProgress}% ({installSpeed})</p>
          
          <div class="install-logs">            <h3>Installation Logs</h3>
            <div class="logs-container">
              {#each installLogs as log, index (index)}
                <p>{log}</p>
              {/each}
              <!-- Auto-scroll to bottom -->
              <div class="auto-scroll"></div>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .setup-wizard {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    max-width: 800px;
    width: 100%;
    margin: 0 auto;
  }
  
  h1, h2, h3 {
    color: white;
    text-align: center;
    margin-bottom: 1.5rem;
  }
  
  .version-selection {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 500px;
  }
  
  select {
    width: 100%;
    padding: 0.75rem;
    margin-bottom: 2rem;
    background-color: #2d3748;
    color: white;
    border: 1px solid #4b5563;
    border-radius: 4px;
    font-size: 1rem;
  }
  
  .action-button {
    background-color: #3b82f6;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.75rem 2rem;
    font-size: 1rem;
    cursor: pointer;
    transition: background-color 0.2s;
    margin: 1rem 0;
    width: 100%;
    max-width: 300px;
  }
  
  .large-button {
    font-size: 1.25rem;
    padding: 1rem 2.5rem;
    margin-bottom: 1.5rem;
  }
  
  .eula-label {
    display: flex;
    align-items: center;
    margin: 1.5rem 0;
    color: white;
  }
  
  .eula-label input {
    margin-right: 0.5rem;
  }
  
  .eula-warning {
    color: #ef4444;
    font-size: 0.875rem;
    margin-bottom: 1rem;
  }
  
  .installation-progress {
    width: 100%;
    margin-top: 1.5rem;
  }
  
  .progress-bar {
    width: 100%;
    height: 0.75rem;
    background-color: #1f2937;
    border-radius: 0.375rem;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }
  
  .progress-fill {
    height: 100%;
    background-color: #3b82f6;
    transition: width 0.3s ease;
  }
  
  .progress-text {
    text-align: center;
    margin-bottom: 1rem;
    font-weight: 500;
  }
  
  .install-logs {
    margin-top: 1.5rem;
    width: 100%;
  }
  
  .logs-container {
    background-color: #1f2937;
    border-radius: 4px;
    padding: 1rem;
    max-height: 200px;
    overflow-y: auto;
    font-family: monospace;
    font-size: 0.875rem;
    color: #d1d5db;
    position: relative;
  }
  
  .logs-container p {
    margin: 0.25rem 0;
  }
  
  .auto-scroll {
    float: left;
    clear: both;
  }
  
  .action-button:hover:not(:disabled) {
    background-color: #2563eb;
  }
  
  .action-button:disabled {
    background-color: #4b5563;
    cursor: not-allowed;
  }
</style>
