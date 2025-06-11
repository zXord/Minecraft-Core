<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { onMount, onDestroy } from 'svelte';
  import { writable, get } from 'svelte/store';
  import { serverState } from '../../stores/serverState.js';
  import { safeInvoke } from '../../utils/ipcUtils.js';
  import { propertiesRestartNeeded } from '../../stores/propertiesRestart.js';
  import { isRestarting } from '../../stores/restartState.js';
  
  // Export server path as a property
  export let serverPath = '';
  
  // State management
  let propertiesMap = writable({});
  let originalProperties = {}; // For dirty state tracking
  let isLoading = true;
  let error = null;
  let searchQuery = '';  let hasChanges = false;
  let showRestoreConfirmation = false;
  
  // propertiesRestartNeeded persists across component unmounts
  // Clear restart-needed only when server transitions from Stopped to Running
  let lastServerStatus = null;
  const unsubscribeRestart = serverState.subscribe(state => {
    if (lastServerStatus !== null) {
      // If server was stopped and is now running, clear the restart flag
      if (lastServerStatus === 'Stopped' && state.status === 'Running') {
        propertiesRestartNeeded.set(false);
      }
    }
    lastServerStatus = state.status;
  });
  onDestroy(() => unsubscribeRestart());
  
  // Define property categories for grouping
  const propertyCategories = {
    gameplay: ['difficulty', 'gamemode', 'hardcore', 'pvp', 'force-gamemode', 'allow-nether', 'allow-flight'],
    world: ['level-name', 'level-seed', 'level-type', 'generator-settings', 'generate-structures', 'spawn-animals', 'spawn-monsters', 'spawn-npcs', 'spawn-protection'],
    network: ['server-ip', 'server-port', 'max-players', 'online-mode', 'white-list', 'enforce-whitelist', 'query.port', 'enable-query', 'enable-rcon', 'rcon.port', 'rcon.password', 'prevent-proxy-connections', 'network-compression-threshold', 'rate-limit'],
    performance: ['view-distance', 'simulation-distance', 'entity-broadcast-range-percentage', 'max-tick-time', 'max-world-size', 'max-build-height', 'sync-chunk-writes'],
    misc: [] // This will hold properties not in other categories
  };

  // Expanded state for categories (collapsed by default)
  let expandedCategories = Object.keys(propertyCategories).reduce((acc, category) => {
    acc[category] = false; // Start with all collapsed
    return acc;
  }, {});
  
  // Property types for validation and UI
  const propertyTypes = {
    // Booleans - will render as checkboxes
    'pvp': 'boolean',
    'hardcore': 'boolean',
    'online-mode': 'boolean',
    'white-list': 'boolean',
    'spawn-animals': 'boolean',
    'spawn-monsters': 'boolean',
    'spawn-npcs': 'boolean',
    'generate-structures': 'boolean',
    'allow-nether': 'boolean',
    'enforce-whitelist': 'boolean',
    'force-gamemode': 'boolean',
    'enable-query': 'boolean',
    'enable-rcon': 'boolean',
    'enable-status': 'boolean',
    'enable-command-block': 'boolean',
    'allow-flight': 'boolean',
    'snooper-enabled': 'boolean',
    'broadcast-console-to-ops': 'boolean',
    'broadcast-rcon-to-ops': 'boolean',
    'sync-chunk-writes': 'boolean',
    'prevent-proxy-connections': 'boolean',
    'use-native-transport': 'boolean',
    'enable-jmx-monitoring': 'boolean',
    
    // Numbers - will have min/max validation
    'max-players': { type: 'number', min: 1, max: 2000 },
    'server-port': { type: 'number', min: 1, max: 65535 },
    'view-distance': { type: 'number', min: 3, max: 32 },
    'simulation-distance': { type: 'number', min: 3, max: 32 },
    'max-build-height': { type: 'number', min: 64, max: 256 },
    'max-world-size': { type: 'number', min: 1, max: 29999984 },
    'spawn-protection': { type: 'number', min: 0, max: 100 },
    'player-idle-timeout': { type: 'number', min: 0, max: 60 },
    'max-tick-time': { type: 'number', min: 0, max: 60000 },
    'query.port': { type: 'number', min: 1025, max: 65534 },
    'rcon.port': { type: 'number', min: 1025, max: 65534 },
    'entity-broadcast-range-percentage': { type: 'number', min: 10, max: 1000 },
    'network-compression-threshold': { type: 'number', min: -1, max: 1024 },
    'op-permission-level': { type: 'number', min: 1, max: 4 },
    'function-permission-level': { type: 'number', min: 1, max: 4 },
    'rate-limit': { type: 'number', min: 0, max: 1000 },
    
    // Enums - will render as dropdowns
    'difficulty': {
      type: 'enum',
      options: ['peaceful', 'easy', 'normal', 'hard']
    },
    'gamemode': {
      type: 'enum',
      options: ['survival', 'creative', 'adventure', 'spectator']
    },
    'level-type': {
      type: 'enum',
      options: ['default', 'flat', 'largeBiomes', 'amplified', 'buffet']
    }
  };

  // Human readable names for properties
  const propertyLabels = {
    'pvp': 'PvP',
    'hardcore': 'Hardcore Mode',
    'level-name': 'World Name',
    'level-seed': 'World Seed',
    'motd': 'Server Message',
    'difficulty': 'Difficulty',
    'gamemode': 'Game Mode',
    'max-players': 'Max Players',
    'server-port': 'Server Port',
    'view-distance': 'View Distance',
    'simulation-distance': 'Simulation Distance',
    'online-mode': 'Online Mode (Authentication)',
    'white-list': 'Whitelist Enabled',
    'spawn-animals': 'Spawn Animals',
    'spawn-monsters': 'Spawn Monsters',
    'spawn-npcs': 'Spawn NPCs',
    'spawn-protection': 'Spawn Protection Radius',
    'level-type': 'World Type',
    'generate-structures': 'Generate Structures',
    'generator-settings': 'Generator Settings',
    'enforce-whitelist': 'Enforce Whitelist',
    'max-world-size': 'Max World Size',
    'max-build-height': 'Max Build Height',
    'force-gamemode': 'Force Gamemode',
    'server-ip': 'Server IP',
    'allow-nether': 'Allow Nether',
    'allow-flight': 'Allow Flight',
    'enable-query': 'Enable Query',
    'query.port': 'Query Port',
    'enable-rcon': 'Enable RCON',
    'rcon.port': 'RCON Port',
    'rcon.password': 'RCON Password',
    'max-tick-time': 'Max Tick Time',
    'player-idle-timeout': 'Player Idle Timeout',
    'entity-broadcast-range-percentage': 'Entity Broadcast Range %',
    'sync-chunk-writes': 'Sync Chunk Writes',
    'network-compression-threshold': 'Network Compression Threshold',
    'rate-limit': 'Rate Limit',
    'op-permission-level': 'OP Permission Level',
    'function-permission-level': 'Function Permission Level',
    'prevent-proxy-connections': 'Prevent Proxy Connections',
    'use-native-transport': 'Use Native Transport',
    'enable-jmx-monitoring': 'Enable JMX Monitoring',
    'enable-command-block': 'Enable Command Blocks',
    'snooper-enabled': 'Snooper Enabled',
    'broadcast-console-to-ops': 'Broadcast Console to OPs',
    'broadcast-rcon-to-ops': 'Broadcast RCON to OPs'  };

  // Helper functions for property type checking
  function isBoolean(property) {
    if (propertyTypes[property] === 'boolean') {
      return true;
    }
    
    // Auto-detect if not defined
    const value = get(propertiesMap)[property];
    return value === 'true' || value === 'false';
  }

  function isNumber(property) {
    if (propertyTypes[property]?.type === 'number') {
      return true;
    }
    
    // Auto-detect if not defined
    const value = get(propertiesMap)[property];
    return !isNaN(Number(value)) && value?.trim() !== '';
  }
  function isEnum(property) {
    return propertyTypes[property]?.type === 'enum' || false;
  }

  // Load server.properties file
  async function loadServerProperties() {
    isLoading = true;
    error = null;
    
    try {
      if (!serverPath) {
        throw new Error('Server path is not set');
      }
      
      
      // Create an IPC function in the main process to read the file
      const result = await window.electron.invoke('read-server-properties', serverPath);
      
      if (result && result.success) {
        const properties = result.properties || {};
        originalProperties = { ...properties }; // Store original for dirty checking
        propertiesMap.set(properties);
        isLoading = false;
        hasChanges = false;
      } else {
        throw new Error(result?.error || 'Failed to read server.properties');
      }
    } catch (err) {
      error = err.message;
      isLoading = false;
    }
  }

  // Save changes to server.properties file
  async function saveProperties() {
    try {
      if (!serverPath) {
        throw new Error('Server path is not set');
      }
      
      // Get latest data from store
      const properties = get(propertiesMap);
      
      // Show saving indicator
      const saveButton = document.querySelector('.save-button');
      if (saveButton && saveButton instanceof HTMLButtonElement) {
        saveButton.textContent = '💾 Saving...';
        saveButton.disabled = true;
      }
      
      const result = await window.electron.invoke('write-server-properties', {
        serverPath,
        properties
      });
      
      if (result.success) {
        // Update original properties to match current state
        originalProperties = { ...properties };
        hasChanges = false;
        
        // Only mark that a restart is needed if the server is currently running
        if ($serverState.status === 'Running') {
          propertiesRestartNeeded.set(true);
        }
        
        // Show success indicator briefly
        if (saveButton && saveButton instanceof HTMLButtonElement) {
          saveButton.textContent = '✅ Saved!';
          setTimeout(() => {
            saveButton.textContent = '💾 Save Changes';
            saveButton.disabled = false;
          }, 2000);
        }
      } else {
        throw new Error(result.error || 'Failed to save server.properties');
      }
    } catch (err) {
      error = err.message;
      
      // Show error indicator briefly
      const saveButton = document.querySelector('.save-button');
      if (saveButton && saveButton instanceof HTMLButtonElement) {
        saveButton.textContent = '❌ Error!';
        setTimeout(() => {
          saveButton.textContent = '💾 Save Changes';
          saveButton.disabled = false;
        }, 2000);
      }
    }
  }

  // Restart server to apply changes
  async function restartServer() {
    // Only restart if server is running
    if ($serverState.status !== 'Running') return;
    
    try {
      // Flag that we are performing a restart to ignore intermediate stop events
      isRestarting.set(true);
      
      // Stop the server
      await safeInvoke('stop-server');
      
      // Small delay to ensure server has properly stopped
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Start it again with current settings
      const { port, maxRam } = $serverState;
      await safeInvoke('start-server', { targetPath: serverPath, port, maxRam });
      
      // Update UI status to show server is starting again
      serverState.update(state => ({ ...state, status: 'Running' }));
      
      // Clear restart-needed flag after successful restart
      propertiesRestartNeeded.set(false);
    } catch (err) {
      error = err.message;
      // Reset restart flag in case of error
      isRestarting.set(false);
    }
  }

  // Restore default server.properties
  async function restoreDefaultProperties() {
    try {
      if (!serverPath) {
        throw new Error('Server path is not set');
      }
      
      isLoading = true;
      showRestoreConfirmation = false;
      
      const result = await window.electron.invoke('restore-backup-properties', serverPath);
      
      if (result.success) {
        // If the server returned the default properties, use them directly
        if (result.properties) {
          // Check if there's actually a change from current properties
          const currentProps = get(propertiesMap);
          const hasActualChanges = Object.keys(result.properties).some(key => 
            String(result.properties[key]) !== String(currentProps[key])
          );
          
          // Update the properties
          originalProperties = { ...result.properties };
          propertiesMap.set(result.properties);
          hasChanges = false;
          isLoading = false;
          
          // Only set restart needed if server is running AND properties actually changed
          if ($serverState.status === 'Running' && hasActualChanges) {
            propertiesRestartNeeded.set(true);
          }
        } else {
          // Otherwise reload from file
          await loadServerProperties();
        }
      } else {
        throw new Error(result.error || 'Failed to restore default properties');
      }
    } catch (err) {
      error = err.message;
      isLoading = false;
    }
  }

  // Property update handler
  function updateProperty(property, value) {
    propertiesMap.update(props => {
      const newProps = { ...props };
      newProps[property] = value;
      return newProps;
    });
    
    // Check if any value is different from original
    const currentProps = get(propertiesMap);
    
    hasChanges = Object.keys(currentProps).some(key => 
      String(currentProps[key]) !== String(originalProperties[key])
    );
  }

  // Category display logic
  function getCategoryProperties(category) {
    const properties = get(propertiesMap);
    
    const definedProps = propertyCategories[category] || [];
    
    // For 'misc' category, include all properties not in other categories
    if (category === 'misc') {
      const allCategoryProps = Object.values(propertyCategories).flat();
      return Object.keys(properties)
        .filter(prop => !allCategoryProps.includes(prop))
        .filter(prop => matchesSearch(prop, properties[prop]));
    }
    
    return definedProps.filter(prop => 
      prop in properties && matchesSearch(prop, properties[prop])
    );
  }

  // Filter properties by search query
  function matchesSearch(property, value) {
    if (!searchQuery) return true;
    
    const query = searchQuery.toLowerCase();
    const propName = property.toLowerCase();
    const label = (propertyLabels[property] || property).toLowerCase();
    const propValue = String(value).toLowerCase();
    
    return propName.includes(query) || 
           label.includes(query) || 
           propValue.includes(query);
  }

  // Toggle category expansion
  function toggleCategory(category) {
    expandedCategories = {
      ...expandedCategories, 
      [category]: !expandedCategories[category]
    };
  }

  // Expand all categories when searching
  $: if (searchQuery) {
    expandedCategories = Object.keys(propertyCategories).reduce((acc, category) => {
      acc[category] = true;
      return acc;
    }, {});
  }

  // Reset search
  function clearSearch() {
    searchQuery = '';
  }

  // Load properties when component mounts
  onMount(() => {
    if (serverPath) {
      loadServerProperties();
    }
    
    return () => {
      // Clean up any event listeners if needed
    };
  });

  // Watch for server path changes
  $: if (serverPath) {
    loadServerProperties();
  }
  
  // Check if a category has any matching properties
  function categoryHasMatchingProperties(category) {
    return getCategoryProperties(category).length > 0;
  }
  
  // Check if search has any results at all
  function searchHasResults() {
    return Object.keys(propertyCategories).some(category => categoryHasMatchingProperties(category));
  }
</script>

<div class="server-properties-editor">
  <h3>Server Properties Editor</h3>
  
  {#if isLoading}
    <div class="loading">Loading server properties...</div>
  {:else if error}
    <div class="error">
      {#if error.includes('not found')}
        <p>Please run the server for the first time to generate the server.properties file.</p>
      {:else}
        <p>{error}</p>
      {/if}
      <div class="error-actions">
        <button on:click={loadServerProperties}>Try Again</button>
      </div>
    </div>
  {:else}
    <!-- Search and controls -->
    <div class="controls">
      <div class="search-box">
        <input 
          type="text" 
          placeholder="Search properties..." 
          bind:value={searchQuery}
        />
        {#if searchQuery}
          <button class="clear-search" on:click={clearSearch}>×</button>
        {/if}
      </div>
      
      <div class="action-buttons">
        <button 
          class="reload-button" 
          title="Reload from disk" 
          on:click={loadServerProperties}
        >
          🔄 Reload
        </button>
        <div class="restore-button-container">          <button 
            class="restore-button" 
            title="Restore default properties" 
            on:click={() => showRestoreConfirmation = true}
          >
            ↩️ Defaults
          </button>
          
          {#if showRestoreConfirmation}
            <div class="tooltip-confirmation">
              <div class="tooltip-content">
                <h4>Restore Default Properties?</h4>
                <p>This will reset all server properties to Minecraft defaults.</p>
                <div class="tooltip-actions">
                  <button class="cancel-button" on:click={() => showRestoreConfirmation = false}>Cancel</button>
                  <button class="confirm-button" on:click={restoreDefaultProperties}>Restore</button>
                </div>
              </div>
            </div>
          {/if}
        </div>
        <button 
          class="save-button" 
          disabled={!hasChanges} 
          on:click={saveProperties}
        >
          💾 Save Changes
        </button>
      </div>
    </div>
    
    {#if searchQuery && !searchHasResults()}
      <div class="no-results">No properties match your search</div>
    {/if}
    
    <!-- Properties by category -->
    {#each Object.keys(propertyCategories) as category}
      {#if !searchQuery || categoryHasMatchingProperties(category)}
        <div class="property-category">          <button class="category-header" on:click={() => toggleCategory(category)} type="button">
            <span class="category-arrow">{expandedCategories[category] ? '▼' : '►'}</span>
            <h4>{category.charAt(0).toUpperCase() + category.slice(1)}</h4>
            {#if searchQuery}
              <span class="match-count">({getCategoryProperties(category).length} matches)</span>
            {/if}
          </button>
          
          {#if expandedCategories[category]}
            <div class="category-properties">
              {#each getCategoryProperties(category) as property}
                <div class="property-row">
                  <label for={property}>
                    {propertyLabels[property] || property}:
                  </label>
                  
                  <div class="property-input">
                    {#if isBoolean(property)}
                      <!-- Boolean as checkbox -->
                      <input 
                        type="checkbox" 
                        id={property}
                        checked={get(propertiesMap)[property] === 'true'} 
                        on:change={e => updateProperty(property, e.currentTarget.checked ? 'true' : 'false')}
                      />
                    {:else if isEnum(property)}
                      <!-- Enum as dropdown -->
                      <select 
                        id={property}
                        value={get(propertiesMap)[property]} 
                        on:change={e => updateProperty(property, e.currentTarget.value)}
                      >
                        {#each propertyTypes[property].options as option}
                          <option value={option}>{option}</option>
                        {/each}
                      </select>
                    {:else if isNumber(property)}
                      <!-- Number with validation -->
                      <input 
                        type="number" 
                        id={property}
                        value={get(propertiesMap)[property]} 
                        min={propertyTypes[property]?.min || 0} 
                        max={propertyTypes[property]?.max || 99999}
                        on:change={e => updateProperty(property, e.currentTarget.value)}
                      />
                    {:else}
                      <!-- Default text input -->
                      <input 
                        type="text" 
                        id={property}
                        value={get(propertiesMap)[property]} 
                        on:change={e => updateProperty(property, e.currentTarget.value)}
                      />
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/each}

    {#if $propertiesRestartNeeded && $serverState.status === 'Running'}
      <div class="restart-notification">
        <p><strong>Changes saved!</strong> Server needs to be restarted to apply these changes.</p>
        <button 
          class="restart-button full-width" 
          on:click={restartServer}
        >
          🔁 Restart Server Now
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .server-properties-editor {
    max-width: 600px;
    margin: 0 auto 1.5rem;
    padding: 1rem;
    border: 1px solid #ffffff;
    border-radius: 8px;
    background: #272727;
    position: relative;
  }
  
  h3 {
    margin-top: 0;
    margin-bottom: 1rem;
    text-align: center;
  }
  
  .loading, .error {
    text-align: center;
    padding: 1rem;
  }
  
  .error {
    color: #ff5555;
  }
  
  
  .error-actions {
    display: flex;
    justify-content: center;
    gap: 1rem;
    margin-top: 1rem;
  }
  
  .controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  
  .search-box {
    position: relative;
    flex: 1;
    min-width: 200px;
  }
  
  .search-box input {
    width: 100%;
    padding: 0.5rem;
    border-radius: 4px;
    border: 1px solid #555;
    background: #333;
    color: white;
  }
  
  .clear-search {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: #aaa;
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0;
  }
  
  .action-buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  
  .restore-button-container {
    position: relative;
  }
  
  .tooltip-confirmation {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 5px;
    z-index: 100;
    width: 280px;
  }
  
  .tooltip-content {
    background: #333;
    padding: 1rem;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
    border: 1px solid #444;
  }
  
  .tooltip-content h4 {
    margin-top: 0;
    color: #ff5555;
    font-size: 1rem;
  }
  
  .tooltip-content p {
    margin: 0.5rem 0;
    font-size: 0.9rem;
  }
  
  .tooltip-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  
  button {
    padding: 0.5rem 1rem;
    border-radius: 4px;
    border: 1px solid #555;
    background: #3a3a3a;
    color: white;
    cursor: pointer;
  }
  
  button:hover:not(:disabled) {
    background: #444;
  }
  
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .save-button {
    background: #2a5a8a;
  }
  
  .save-button:hover:not(:disabled) {
    background: #326aa0;
  }
  
  .restore-button {
    background: #8a2a5a;
  }
  
  .restore-button:hover:not(:disabled) {
    background: #a03268;
  }
  
  .cancel-button {
    background: #3a3a3a;
    padding: 0.3rem 0.7rem;
    font-size: 0.85rem;
  }
  
  .confirm-button {
    background: #8a2a5a;
    padding: 0.3rem 0.7rem;
    font-size: 0.85rem;
  }
  
  .property-category {
    margin-bottom: 1rem;
    border: 1px solid #444;
    border-radius: 4px;
    overflow: hidden;
  }
    .category-header {
    width: 100%;
    padding: 0.5rem;
    background: #333;
    cursor: pointer;
    display: flex;
    align-items: center;
    border: none;
    color: white;
    text-align: left;
  }
  
  .category-header:hover {
    background: #3a3a3a;
  }
  
  .category-header h4 {
    margin: 0;
    flex: 1;
  }
  
  .match-count {
    font-size: 0.8rem;
    color: #aaa;
    margin-left: 0.5rem;
  }
  
  .category-arrow {
    margin-right: 0.5rem;
    display: inline-block;
    width: 1rem;
  }
  
  .category-properties {
    padding: 0.5rem;
  }
  
  .property-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0;
    border-bottom: 1px solid #3a3a3a;
  }
  
  .property-row:last-child {
    border-bottom: none;
  }
  
  .property-row label {
    flex: 1;
  }
  
  .property-input {
    width: 50%;
  }
  
  .property-input input[type="text"],
  .property-input input[type="number"],
  .property-input select {
    width: 100%;
    padding: 0.3rem;
    border-radius: 4px;
    border: 1px solid #555;
    background: #333;
    color: white;
  }
  
  .no-results {
    padding: 1rem;
    color: #aaa;
    text-align: center;
    background: #333;
    border-radius: 4px;
    margin-bottom: 1rem;
  }
  
  /* Make checkbox more visible */
  input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: #2a5a8a;
  }
  
  .restart-button {
    background: #ffa500;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }
  
  .restart-button:hover:not(:disabled) {
    background: #ffb733;
  }
  
  .restart-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .restart-notification {
    padding: 1rem;
    background: rgba(255, 165, 0, 0.2);
    border: 1px solid #ffa500;
    border-radius: 4px;
    margin-top: 1rem;
    animation: pulse 2s infinite;
  }
  
  .restart-notification p {
    margin: 0 0 0.5rem 0;
    font-size: 0.9rem;
    color: #ffa500;
    font-weight: bold;
  }
  
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(255, 165, 0, 0.4); }
    70% { box-shadow: 0 0 0 10px rgba(255, 165, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(255, 165, 0, 0); }
  }
  
  .restart-button.full-width {
    width: 100%;
    margin-top: 0.5rem;
    font-weight: bold;
    padding: 0.75rem;
  }
</style> 