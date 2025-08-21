<!-- @ts-ignore -->
<script>    /// <reference path="../../electron.d.ts" />
  import { onMount } from 'svelte';
  import { playerState, updatePlayerList } from '../../stores/playerState.js';

  export let serverPath = '';

  // Player-list data
  const listNames = {
    whitelist: 'Whitelist',
    ops: 'Operators',
    'banned-players': 'Banned Players',
    'banned-ips': 'IP Bans'
  };

  // New entries for each list
  let newEntry = { whitelist: '', ops: '', 'banned-players': '', 'banned-ips': '' };
  
  // Store raw data for banned IPs to access player names
  let rawBannedIps = [];

  // Get lists from the store
  $: lists = $playerState.lists;
  $: serverStatus = $playerState.serverStatus;
  
  // Process rawBannedIps to update player names when it changes
  $: {
    if (rawBannedIps && rawBannedIps.length > 0) {
      for (const item of rawBannedIps) {
        if (item && typeof item === 'object' && item.playerName && 
            item.playerName !== 'Unknown') {
          // Update the global state with this player name
          playerState.update(state => ({
            ...state,
            lastBannedPlayer: item.playerName
          }));
          break;
        }
      }
    }
  }

  // Ensure we have a valid server path
  $: {
    if (!serverPath && window.serverPath && typeof window.serverPath.get === 'function') {
      // Note: don't await in reactive block; handled in onMount and per-call
      // Keep this as a noop to avoid setting a Promise
    }
  }

  async function loadList(name) {
    try {
      // Ensure we have a valid server path
      if (!serverPath) {
        const sp = window.serverPath && typeof window.serverPath.get === 'function' ? await window.serverPath.get() : '';
        const spVal = sp == null ? '' : sp;
        serverPath = (typeof spVal === 'object' && /** @type {any} */(spVal).path) ? String(/** @type {any} */(spVal).path) : String(spVal);
        if (!serverPath) return;
      }

      const raw = await window.electron.invoke('read-players', name, serverPath) || [];
      let items;
      
      // Store raw banned IPs data for reference
      if (name === 'banned-ips') {
        rawBannedIps = raw;
        
        // Look for player names in the raw data
        for (const item of raw) {
          if (item && typeof item === 'object' && item.playerName && 
              item.playerName !== 'Unknown') {
            // Save this player name for all IPs
            playerState.update(state => ({
              ...state,
              lastBannedPlayer: item.playerName
            }));
            break;
          }
        }
      }
      
      if (name === 'ops' || name === 'whitelist') {
        items = raw.map(item => item.name || item);
      } else if (name === 'banned-players') {
        items = raw.map(item => item.name || item);
      } else if (name === 'banned-ips') {
        items = raw.map(item => {
          // For IP ban entries, format to show player name if available
          if (typeof item === 'string') {
            return item;
          }
          if (item && typeof item === 'object' && item.ip) {
            // Store the player name for display if it's a real player (not special)
            if (item.playerName && item.playerName !== 'Unknown') {
              playerState.update(state => ({
                ...state,
                lastBannedPlayer: item.playerName
              }));
            }
            
            return item.ip; // Just return the IP, we'll display the playerName separately
          }
          return item;
        });
      } else {
        items = raw;
      }
      
      // Filter out any undefined or null values
      items = items.filter(item => item);
      
      updatePlayerList(name, items);
    } catch (err) {
      // If we hit an error, update with empty list
      updatePlayerList(name, []);
    }
  }

  // Load all four lists
  function loadAllLists() {
    for (const name of Object.keys(lists)) {
      loadList(name);
    }
  }

  async function addEntry(name) {
    const entry = newEntry[name].trim();
    if (!entry) return;

    try {
      // Ensure we have a valid server path
      if (!serverPath) {
        const sp = window.serverPath && typeof window.serverPath.get === 'function' ? await window.serverPath.get() : '';
        const spVal = sp == null ? '' : sp;
        serverPath = (typeof spVal === 'object' && /** @type {any} */(spVal).path) ? String(/** @type {any} */(spVal).path) : String(spVal);
        if (!serverPath) return;
      }
      
      // Special handling for banned-ips to save the player name
      if (name === 'banned-ips') {
        const currentPlayer = $playerState.lastBannedPlayer || 'Player';
        // Format the entry to include the player name
        const formattedEntry = `${entry} (Player: ${currentPlayer})`;
        
        // Store this IP with the player name
        await window.electron.invoke('add-player', name, serverPath, formattedEntry);
        
        // Update the last banned player
        playerState.update(state => ({
          ...state,
          lastBannedPlayer: currentPlayer
        }));
      } else {
        // Normal entries for other lists
        await window.electron.invoke('add-player', name, serverPath, entry);
      }
      
      // Clear the input field
      newEntry = { ...newEntry, [name]: '' };
      await loadList(name);

      // Update onlinePlayers list if we're adding to whitelist when server is stopped
      if (name === 'whitelist' && serverStatus !== 'running') {
        playerState.update(state => {
          // Only add if not already in the list
          if (!state.onlinePlayers.includes(entry)) {
            return {
              ...state,
              onlinePlayers: [...state.onlinePlayers, entry]
            };
          }
          return state;
        });
      }

      // Live command
      if (serverStatus === 'running') {
        let cmd;
        if (name === 'ops') cmd = `op ${entry}`;
        else if (name === 'whitelist') cmd = `whitelist add ${entry}`;
        else if (name === 'banned-players') cmd = `ban ${entry}`;
        else if (name === 'banned-ips') cmd = `ban-ip ${entry}`;
        
        if (cmd) {
          await window.electron.invoke('send-command', { command: cmd });
        }
      }
    } catch (err) {
      // Error is already logged by the electron API
    }
  }

  async function removeEntry(name, entry) {
    try {
      // Ensure we have a valid server path
      if (!serverPath) {
        serverPath = window.serverPath ? await window.serverPath.get() : '';
        if (!serverPath) {
          return;
        }
      }
      
      // For banned-ips, extract just the IP portion if the entry has a player name in parentheses
      let entryToRemove = entry;
      if (name === 'banned-ips') {
        const matches = entry.match(/^(.+)\s+\((.+)\)$/);
        if (matches) {
          // Extract just the IP address part
          entryToRemove = matches[1];
        }
      }
      
      await window.electron.invoke('remove-player', name, serverPath, entryToRemove);
      
      await loadList(name);
      
      // Update onlinePlayers list if we're removing from whitelist when server is stopped
      if (name === 'whitelist' && serverStatus !== 'running') {
        playerState.update(state => ({
          ...state,
          onlinePlayers: state.onlinePlayers.filter(player => player !== entry)
        }));
      }
      
      // Live command
      if (serverStatus === 'running') {
        let cmd;
        if (name === 'ops') cmd = `deop ${entry}`;
        else if (name === 'whitelist') cmd = `whitelist remove ${entry}`;
        else if (name === 'banned-players') cmd = `pardon ${entry}`;
        else if (name === 'banned-ips') {
          // For IP bans, use the extracted IP
          cmd = `pardon-ip ${entryToRemove}`;
        }
        
        if (cmd) {
          await window.electron.invoke('send-command', { command: cmd });
        }
      }
    } catch (err) {
      // Error is already logged by the electron API
    }
  }

  onMount(() => {
    // Make sure we have a valid server path
    (async () => {
      if (!serverPath && window.serverPath && typeof window.serverPath.get === 'function') {
        const sp = await window.serverPath.get();
        const spVal = sp == null ? '' : sp;
        serverPath = (typeof spVal === 'object' && /** @type {any} */(spVal).path) ? String(/** @type {any} */(spVal).path) : String(spVal);
      }
      
      // Initialize our component state
      try {
        const statusResult = await window.electron.invoke('get-server-status');
        // The result will be an object with a 'status' property ('running' or 'stopped')
        if (statusResult && typeof statusResult === 'object') {
          playerState.update(state => ({ ...state, serverStatus: statusResult.status }));
        } else {
          // Handle case where direct string might be returned
          playerState.update(state => ({ ...state, serverStatus: statusResult || 'stopped' }));
        }
      } catch (err) {
        playerState.update(state => ({ ...state, serverStatus: 'stopped' }));
      }
      
      // Load all player lists
      if (serverPath) {
        // First, fetch the last banned player
        try {
          const result = await window.electron.invoke('get-last-banned-player', serverPath);
          if (result && result.lastBannedPlayer) {
            // Store the player name in the global state
            playerState.update(state => ({
              ...state,
              lastBannedPlayer: result.lastBannedPlayer
            }));
          }
        } catch (err) {
        }
        
        // Now load all player lists
        await loadAllLists();
      }
    })();

    // Listen for status updates
    const statusHandler = (statusData) => {
      // The status might be a simple string or an object with a status property
      const status = typeof statusData === 'object' ? statusData.status : statusData;
      playerState.update(state => ({ ...state, serverStatus: status }));
    };
    
    // Remove any existing listeners to avoid duplicates
    window.electron.removeAllListeners('server-status');
    window.electron.on('server-status', statusHandler);

    // Listen for player list changes from any context (app or web)
    const playersChangedHandler = async (payload) => {
      try {
        if (!payload) return;
        const { listName } = payload;
        if (!serverPath && window.serverPath) {
          serverPath = await window.serverPath.get();
        }
        if (!serverPath) return;
        if (listName && listNames[listName]) {
          // Refresh just the affected list
          await loadList(listName);
          // If banned-ips changed, refresh raw list too
          if (listName === 'banned-ips') {
            const raw = await window.electron.invoke('read-players', 'banned-ips', serverPath) || [];
            rawBannedIps = raw;
          }
        } else {
          // Unknown list: refresh all as a fallback
          await loadAllLists();
        }
      } catch {}
    };
    window.electron.on('players-list-changed', playersChangedHandler);
    
    return () => {
      window.electron.removeListener('server-status', statusHandler);
      window.electron.removeListener('players-list-changed', playersChangedHandler);
    };
  });
</script>

<div class="players-page-container">
  <div class="players-grid">
{#each Object.entries(lists) as [name, list] (name)}
      <section class="player-card">
        <div class="section-header">
          <h3>{listNames[name]} <span class="player-count">{list.length}</span></h3>
        </div>
        
        <div class="add-player-form">
      <input
            class="player-input"
        value={newEntry[name]}
        placeholder="Username or IP"
        on:input={e => {
          const target = /** @type {HTMLInputElement} */ (e.target);
          newEntry = { ...newEntry, [name]: target.value };
        }}
        on:keydown={e => e.key === 'Enter' && addEntry(name)}
      />
      <button
            class="add-button"
        on:click={() => addEntry(name)}
        disabled={!newEntry[name].trim()}
      >
            +
      </button>
    </div>
    
        <div class="player-list-content">        {#if list.length === 0}
            <div class="no-players">No entries</div>
          {:else}
      {#each list as entry (entry)}
              <div class="player-row">
                <div class="player-info">
                  <div class="player-avatar">
                    {#if name !== 'banned-ips'}
                      <img 
                        src={`https://minotar.net/avatar/${entry}/24`} 
                        alt="Player avatar"
                        loading="lazy"
                        on:error={e => {
                          const target = /** @type {HTMLImageElement} */ (e.target);
                          target.src = 'https://minotar.net/avatar/MHF_Steve/24';
                        }}
                      />
                    {:else}
                      <div class="ip-icon">IP</div>
                    {/if}
                  </div>
                  <div class="player-name">
                    {#if name === 'banned-ips'}
                      <!-- Show default player name for each banned IP -->
                      <div class="ip-ban-entry">
                        <span class="ip-part">{entry}</span>
                        <!-- Display player name for IP -->
                        {#if rawBannedIps && rawBannedIps.length > 0}
                          <!-- Try finding the exact IP match first -->
                          {@const matchedEntry = rawBannedIps.find(item => 
                            (item && typeof item === 'object' && item.ip === entry && item.playerName && item.playerName !== 'Unknown')
                          )}
                          
                          {#if matchedEntry}
                            <span class="player-part">Player: {matchedEntry.playerName}</span>
                          {:else}
                            <!-- Fallback to last banned player -->
                            <span class="player-part">Player: {$playerState.lastBannedPlayer || 'Unknown'}</span>
                          {/if}
                        {:else}
                          <span class="player-part">Player: {$playerState.lastBannedPlayer || 'Unknown'}</span>
                        {/if}
                      </div>
                    {:else}
                      {entry}
                    {/if}
                  </div>
                </div>
                <button
                        class="remove-button"
                  on:click={() => removeEntry(name, entry)}
                >
                        ✕
                </button>
              </div>
      {/each}
          {/if}
        </div>
  </section>
{/each}
  </div>
</div>

<style>
  .players-page-container {
    width: 100%;
    max-width: 100%;
    margin: 0 auto;
    padding: 0.5rem;
    box-sizing: border-box;
    overflow-x: hidden;
  }
  
  .players-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.75rem;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }

  /* Responsive grid */
  @media (max-width: 1000px) {
    .players-grid {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0.5rem;
    }
  }

  @media (max-width: 800px) {
    .players-grid {
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 0.4rem;
    }
  }
  
  .player-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    background: rgba(20, 20, 20, 0.7);
    border-radius: 6px;
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }
  
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    background: rgba(0, 0, 0, 0.2);
  }
  
  .section-header h3 {
    font-size: 1rem;
    margin: 0;
    font-weight: 600;
    color: var(--text-color, rgba(255, 255, 255, 0.9));
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .player-count {
    background: rgba(100, 108, 255, 0.2);
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.7rem;
    padding: 0.15rem 0.4rem;
    border-radius: 10px;
    font-weight: normal;
  }
  
  .add-player-form {
    display: flex;
    padding: 0.5rem;
    gap: 0.3rem;
    border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    width: 100%;
    box-sizing: border-box;
  }
  
  .player-input {
    flex: 1;
    padding: 0.35rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.2));
    background: rgba(0, 0, 0, 0.2);
    color: var(--text-color, white);
    font-size: 0.8rem;
  }
  
  .player-input:focus {
    outline: none;
    border-color: var(--accent-color, #646cff);
    box-shadow: 0 0 0 1px rgba(100, 108, 255, 0.3);
  }
  
  .add-button {
    background: var(--accent-color, #646cff);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.25rem 0.4rem;
    font-weight: 500;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s;
    min-width: 28px;
    max-width: 32px;
    flex-shrink: 0;
  }
  
  .add-button:hover {
    background: var(--accent-color-hover, #7a81ff);
    transform: translateY(-1px);
  }
  
  .add-button:disabled {
    background: var(--disabled-color, rgba(100, 108, 255, 0.3));
    cursor: not-allowed;
    transform: none;
  }
  
  .player-list-content {
    flex: 1;
    overflow: auto;
    max-height: 280px;
  }

  .no-players {
    padding: 1rem 0.5rem;
    text-align: center;
    color: rgba(255, 255, 255, 0.5);
    font-style: italic;
    font-size: 0.85rem;
  }
  
  .player-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.05));
    transition: background-color 0.15s;
  }
  
  .player-row:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .player-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    overflow: hidden;
    max-width: 85%;
  }
  
  .player-avatar {
    width: 24px;
    height: 24px;
    border-radius: 3px;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .player-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    image-rendering: pixelated;
  }

  .ip-icon {
    width: 100%;
    height: 100%;
    background: rgba(100, 108, 255, 0.2);
    color: #a0a8ff;
    font-size: 0.6rem;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .player-name {
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0.15rem 0;
    font-size: 0.85rem;
  }
   
  /* IP ban entry formatting */
  .ip-ban-entry {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }
  
  .ip-part {
    color: #eeeeee;
    font-weight: bold;
  }
  
  .player-part {
    color: #61dafb;
    font-style: italic;
    font-size: 0.75rem;
    opacity: 0.8;
  }
  
  .remove-button {
    background: rgba(244, 67, 54, 0.2);
    color: #ff6b6b;
    border: none;
    border-radius: 4px;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    cursor: pointer;
    transition: all 0.2s;
    padding: 0;
  }

  .remove-button:hover {
    background: rgba(244, 67, 54, 0.3);
    transform: translateY(-1px);
  }
</style>
