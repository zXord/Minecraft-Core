<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { playerState, hideContextMenu } from '../../stores/playerState.js';
  
  // Access the context menu state from the store
  $: contextMenu = $playerState.contextMenu;
  $: player = contextMenu.player;
  
  // Access player lists from the store
  $: isOp = $playerState.lists.ops.includes(player);
  $: isWhitelisted = $playerState.lists.whitelist.includes(player);
  $: isBanned = $playerState.lists['banned-players'].includes(player);
  $: isOnline = $playerState.onlinePlayers.includes(player);
  
  // Derived state to control which actions are visible
  $: canOp = !isOp && !isBanned;
  $: canDeop = isOp && !isBanned;
  $: canWhitelist = !isWhitelisted && !isBanned;
  $: canRemoveFromWhitelist = isWhitelisted;
  $: canBan = !isBanned && isOnline;
  $: canUnban = isBanned && !isOnline;
  $: canKick = isOnline;
  
  
  
  // Handle context menu actions
  async function performContextAction(action) {
    if (!player) return;
    
    await handlePlayerAction(player, action);
    hideContextMenu();
  }
  async function handlePlayerAction(player, action) {
    if (!action) return;
    
    // Determine list and command
    const mapping = {
      op: ['ops', `op ${player}`],
      deop: ['ops', `deop ${player}`],
      'whitelist add': ['whitelist', `whitelist add ${player}`],
      'whitelist remove': ['whitelist', `whitelist remove ${player}`],
      ban: ['banned-players', `ban ${player}`],
      unban: ['banned-players', `pardon ${player}`],
      'ban-ip': ['banned-ips', `ban-ip ${player}`],
      'unban-ip': ['banned-ips', `pardon-ip ${player}`],
      kick: [null, `kick ${player}`]
    };
    
    const [listName, cmd] = mapping[action] || [];
    
    // Special handling for kick action which doesn't modify any list
    if (action === 'kick') {
      const statusResult = await window.electron.invoke('get-server-status');
      const serverStatus = statusResult?.status || statusResult || 'stopped';
      
      if (serverStatus && ['running', 'Running'].includes(serverStatus)) {
        await window.electron.invoke('send-command', { command: cmd });
        return;
      } else {
        return;
      }
    }
    
    if (listName) {
      try {
        // Get server path from global context - properly await the Promise
        let serverPath = '';        if (window.serverPath) {
          try {            // Make sure to await the Promise and extract the path property
            const pathResult = await window.serverPath.get();
            // The result could be either { path: '...' } or just the path string
            if (pathResult) {
              if (typeof pathResult === 'object' && pathResult && 'path' in pathResult) {
                serverPath = /** @type {any} */ (pathResult).path;
              } else {
                serverPath = String(pathResult);
              }
            }
          } catch (err) {
          }
        }
        
        
        if (!serverPath) {
          return;
        }
        
        // Special handling for ban-ip to include the player name
        if (action === 'ban-ip') {
          try {
            // For IP bans, we need to include player name
            // Generate a mock IP for demonstration and include the player name
            const mockIp = `127.0.0.${Math.floor(Math.random() * 255)}`;
            
            // Store the player name for the banned IP
            playerState.update(state => ({
              ...state,
              lastBannedPlayer: player
            }));            
            // Create a specially formatted string that our backend can parse
            const formattedEntry = `${mockIp} (Player: ${player})`;
            
            // Add the IP with the special formatted string to save player name
            await window.electron.invoke('add-player', listName, serverPath, formattedEntry);
            
            // Reload the list to show all banned IPs
            const updatedList = await window.electron.invoke('read-players', listName, serverPath) || [];
            
            // Update the UI
            playerState.update(state => {
              const lists = { ...state.lists };
              lists[listName] = updatedList.map(item => {
                if (typeof item === 'string') return item;
                return item.ip || item;
              });
              return { ...state, lists };
            });
            
            // Send ban-ip command if server is running
            const statusResult = await window.electron.invoke('get-server-status');
            const serverStatus = statusResult?.status || statusResult || 'stopped';
            
            if (serverStatus && ['running', 'Running'].includes(serverStatus)) {
              await window.electron.invoke('send-command', { command: `ban-ip ${player}` });
            }
          } catch (err) {
          }
          
          return; // Exit early since we've handled the entire action        } else {
          // Regular player actions
          // Update list in backend
          try {
            await window.electron.invoke(
              action.startsWith('un') ? 'remove-player' : 'add-player', 
              listName, 
              serverPath,
              player
            );
          } catch (err) {
            // Error handled silently
          }
        }
        
        // Reload list
        const updatedList = await window.electron.invoke('read-players', listName, serverPath) || [];
        playerState.update(state => {
          const lists = { ...state.lists };
          lists[listName] = updatedList.map(item => {
            if (listName === 'banned-ips' && item && typeof item === 'object' && item.ip) {
              // Format banned IPs to include player name in parentheses if available
              return item.playerName ? `${item.ip} (${item.playerName})` : item.ip;
            }
            return item.name || item.ip || item;
          });
          return { ...state, lists };
        });
        
        // Send command if server is running
        const statusResult = await window.electron.invoke('get-server-status');
        // Check both result formats (object with status property or direct status string)
        const serverStatus = statusResult?.status || statusResult;
        
        if (serverStatus && ['running', 'Running'].includes(serverStatus)) {
          await window.electron.invoke('send-command', { command: cmd });
        } else if (listName === 'whitelist') {
          // If server is not running and this is a whitelist action, update the onlinePlayers list
          playerState.update(state => {
            if (action === 'whitelist add' && !state.onlinePlayers.includes(player)) {
              // Add to online players when whitelisting if not already in the list
              return { ...state, onlinePlayers: [...state.onlinePlayers, player] };
            } else if (action === 'whitelist remove') {
              // Remove from online players when removing from whitelist
              return { ...state, onlinePlayers: state.onlinePlayers.filter(p => p !== player) };
            }
            return state;
          });
        }
      } catch (err) {
      }
    }
  }
</script>

{#if contextMenu.visible}
  <!-- Invisible overlay to catch clicks outside the menu -->
  <div 
    class="context-overlay"
    role="button"
    aria-label="Close menu"
    on:click={hideContextMenu}
    on:keydown={e => e.key === 'Escape' && hideContextMenu()}
    tabindex="-1"
  ></div>
  
  <!-- Actual menu -->
  <div
    class="context-menu"
    role="menu"
    style="top: {contextMenu.y}px; left: {contextMenu.x}px;"
  >    <ul>
      {#if player}
        {#if canOp}
          <li role="menuitem">
            <button
              type="button"
              on:click={() => performContextAction('op')}
            >
              Op
            </button>
          </li>
        {/if}
        
        {#if canDeop}
          <li role="menuitem">
            <button
              type="button"
              on:click={() => performContextAction('deop')}
            >
              Deop
            </button>
          </li>
        {/if}
        
        {#if canWhitelist}
          <li role="menuitem">
            <button
              type="button"
              on:click={() => performContextAction('whitelist add')}
            >
              Whitelist
            </button>
          </li>
        {/if}
        
        {#if canRemoveFromWhitelist}
          <li role="menuitem">
            <button
              type="button"
              on:click={() => performContextAction('whitelist remove')}
            >
              Remove from Whitelist
            </button>
          </li>
        {/if}
        
        {#if canBan}
          <li role="menuitem">
            <button
              type="button"
              on:click={() => performContextAction('ban')}
            >
              Ban
            </button>
          </li>
        {/if}
        
        {#if canKick && isOnline}
          <li role="menuitem">
            <button
              type="button"
              on:click={() => performContextAction('kick')}
            >
              Kick
            </button>
          </li>
        {/if}
        
        {#if canUnban}
          <li role="menuitem">
            <button
              type="button"
              on:click={() => performContextAction('unban')}
            >
              Unban        </button>
          </li>
        {/if}
        
        {#if canBan && isOnline}
          <li role="menuitem">
            <button
              type="button"
              on:click={() => performContextAction('ban-ip')}
            >
              Ban IP
            </button>
          </li>
        {/if}
        
        {#if !isOnline && $playerState.lists['banned-ips'].includes(player)}
          <li role="menuitem">
            <button
              type="button"
              on:click={() => performContextAction('unban-ip')}
            >
              Unban IP
            </button>
          </li>
        {/if}
      {/if}
    </ul>
  </div>
{/if}

<style>  .context-overlay {     position: fixed;     top: 0;     left: 0;     width: 100vw;     height: 100vh;     z-index: 99998; /* Just below context menu */    background-color: transparent;     cursor: default;    pointer-events: auto; /* Ensures clicks are captured */  }    .context-menu {  
    position: fixed; /* Changed from absolute to fixed */
    background: white; 
    border: 2px solid #646cff; /* More visible border */
    z-index: 99999; /* Increased z-index to ensure it's above everything */
    min-width: 150px;
    max-width: 200px;
    box-shadow: 0 3px 20px rgba(100, 108, 255, 0.7);
    border-radius: 4px;
    color: #333;
    font-size: 1rem;
    animation: popup 0.2s ease-out;
    transform-origin: top left;
  }
  
  @keyframes popup {
    0% { transform: scale(0.5); opacity: 0; }
    100% { transform: scale(1); opacity: 1; }
  }
  
  .context-menu ul { 
    list-style: none; 
    margin: 0; 
    padding: 4px 0; 
  }
  
  .context-menu li { 
    padding: 0; 
    cursor: pointer; 
  }
  .context-menu li button { 
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 8px 15px;
    margin: 0;
    font-size: 0.95rem;
    cursor: pointer;
    color: #333;
    transition: background-color 0.2s;
  }
  
    .context-menu li button:hover {    background-color: #f0f0f0;    color: #000;  }
  
  /* Empty menu fallback */
  .context-menu ul:empty::after {
    content: "No actions available";
    display: block;
    padding: 8px 15px;
    color: #999;
    font-style: italic;
    font-size: 0.9rem;
  }
</style>
