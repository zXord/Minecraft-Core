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

<!-- Remove the old container and title - they're now in the parent card -->
<div class="server-properties-content">
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
    {#each Object.keys(propertyCategories) as category (category)}
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
              {#each getCategoryProperties(category) as property (property)}
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
                      <!-- Enum as dropdown -->                      <select 
                        id={property}
                        value={get(propertiesMap)[property]} 
                        on:change={e => updateProperty(property, e.currentTarget.value)}
                      >
                        {#each propertyTypes[property].options as option (option)}
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
  /* Remove ALL old styling - this component is now wrapped in cards */

  /* Style the controls to fit in the card */
  .controls {
    background: none !important;
    border: none !important;
    padding: 0.5rem 0 !important;
    margin: 0 0 0.5rem 0 !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 0.5rem !important;
  }

  .search-box {
    background: rgba(17, 24, 39, 0.4) !important;
    border: 1px solid rgba(75, 85, 99, 0.3) !important;
    border-radius: 4px !important;
    padding: 0.3rem 0.5rem !important;
    position: relative !important;
    display: flex !important;
    align-items: center !important;
  }

  .search-box input {
    background: none !important;
    border: none !important;
    color: #e2e8f0 !important;
    font-size: 0.8rem !important;
    width: 100% !important;
  }

  .action-buttons {
    display: flex !important;
    gap: 0.5rem !important;
    margin-top: 0.5rem !important;
  }

  .action-buttons button {
    background: rgba(75, 85, 99, 0.3) !important;
    border: 1px solid rgba(75, 85, 99, 0.5) !important;
    color: #e2e8f0 !important;
    border-radius: 4px !important;
    padding: 0.3rem 0.6rem !important;
    font-size: 0.75rem !important;
    cursor: pointer !important;
  }

  .action-buttons button:hover {
    background: rgba(75, 85, 99, 0.5) !important;
  }

  /* Category sections */
  .property-category {
    background: none !important;
    border: none !important;
    margin: 0.25rem 0 !important;
    border-radius: 4px !important;
    overflow: hidden !important;
  }

  .category-header {
    background: rgba(17, 24, 39, 0.4) !important;
    border: 1px solid rgba(75, 85, 99, 0.3) !important;
    padding: 0.4rem 0.6rem !important;
    border-radius: 4px !important;
    cursor: pointer !important;
    width: 100% !important;
    display: flex !important;
    align-items: center !important;
    color: #e2e8f0 !important;
    text-align: left !important;
  }

  .category-header h4 {
    margin: 0 !important;
    font-size: 0.8rem !important;
    color: #e2e8f0 !important;
  }

  /* Property items */
  .category-properties {
    padding: 0.5rem !important;
    background: rgba(17, 24, 39, 0.2) !important;
  }

  .property-row {
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    padding: 0.3rem 0 !important;
    border-bottom: 1px solid rgba(75, 85, 99, 0.2) !important;
    gap: 0.5rem !important;
  }

  .property-row:last-child {
    border-bottom: none !important;
  }

  /* Form controls */
  .property-row label {
    color: #9ca3af !important;
    font-size: 0.75rem !important;
    margin: 0 !important;
    flex: 1 !important;
  }

  .property-input {
    flex: 1 !important;
    max-width: 180px !important;
  }

  .property-input input,
  .property-input select {
    background: rgba(17, 24, 39, 0.6) !important;
    border: 1px solid rgba(75, 85, 99, 0.4) !important;
    color: #e2e8f0 !important;
    border-radius: 3px !important;
    padding: 0.2rem 0.4rem !important;
    font-size: 0.75rem !important;
    width: 100% !important;
  }

  .property-input input[type="checkbox"] {
    width: auto !important;
    max-width: none !important;
  }

  /* Compact everything for card design */

  /* Remove any remaining old styles */
  .loading,
  .error {
    background: none !important;
    border: none !important;
    padding: 0.5rem !important;
    font-size: 0.8rem !important;
    color: #9ca3af !important;
    text-align: center !important;
  }

  .no-results {
    background: rgba(17, 24, 39, 0.3) !important;
    border: 1px solid rgba(75, 85, 99, 0.3) !important;
    padding: 1rem !important;
    font-size: 0.8rem !important;
    color: #9ca3af !important;
    text-align: center !important;
    border-radius: 4px !important;
    margin: 0.5rem 0 !important;
  }

  .clear-search {
    position: absolute !important;
    right: 8px !important;
    background: none !important;
    border: none !important;
    color: #9ca3af !important;
    cursor: pointer !important;
    font-size: 1rem !important;
    padding: 0 !important;
  }

  .clear-search:hover {
    color: #e2e8f0 !important;
  }

  .category-arrow {
    margin-right: 0.5rem !important;
    font-size: 0.8rem !important;
  }

  .match-count {
    margin-left: auto !important;
    font-size: 0.7rem !important;
    color: #9ca3af !important;
  }

  .save-button {
    background: rgba(59, 130, 246, 0.3) !important;
    border: 1px solid rgba(59, 130, 246, 0.5) !important;
    color: #3b82f6 !important;
    border-radius: 4px !important;
    padding: 0.3rem 0.6rem !important;
    font-size: 0.75rem !important;
    cursor: pointer !important;
  }

  .save-button:hover {
    background: rgba(59, 130, 246, 0.5) !important;
  }

  .save-button:disabled {
    opacity: 0.5 !important;
    cursor: not-allowed !important;
  }

  .restart-notification {
    background: rgba(251, 146, 60, 0.1) !important;
    border: 1px solid rgba(251, 146, 60, 0.3) !important;
    border-radius: 4px !important;
    padding: 0.5rem !important;
    margin: 0.5rem 0 0 0 !important;
    text-align: center !important;
  }

  .restart-notification p {
    margin: 0 0 0.5rem 0 !important;
    font-size: 0.8rem !important;
    color: #fb923c !important;
  }

  .restart-button {
    background: rgba(251, 146, 60, 0.3) !important;
    border: 1px solid rgba(251, 146, 60, 0.5) !important;
    color: #fb923c !important;
    border-radius: 4px !important;
    padding: 0.3rem 0.6rem !important;
    font-size: 0.75rem !important;
    cursor: pointer !important;
    width: 100% !important;
  }

  .restart-button:hover:not(:disabled) {
    background: rgba(251, 146, 60, 0.5) !important;
  }

  .restart-button.full-width {
    width: 100% !important;
    margin-top: 0 !important;
    font-weight: 500 !important;
    padding: 0.4rem !important;
  }
</style> 