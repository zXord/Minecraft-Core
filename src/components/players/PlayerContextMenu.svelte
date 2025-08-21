<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { playerState, hideContextMenu, refreshPlayerLists, updatePlayerPermissions } from '../../stores/playerState.js';
  import logger from '../../utils/logger.js';
  
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
  
  // Track if an action is in progress
  let actionInProgress = false;
  
  // Handle context menu actions
  async function performContextAction(action) {
    if (!player || actionInProgress) return;
    
    actionInProgress = true;
    
    try {
  // (debug removed)
      await handlePlayerAction(player, action);
      
      // Get server path for refreshing lists
      let serverPath = '';
      // Try window.serverPath first
      try {
        if (window.serverPath && typeof window.serverPath.get === 'function') {
          const pathResult = await window.serverPath.get();
          if (pathResult) {
            serverPath = typeof pathResult === 'object' && pathResult && 'path' in pathResult
              ? /** @type {any} */ (pathResult).path
              : String(pathResult);
          }
        }
  } catch (e) { /* suppressed debug: serverPath.get failed */ }
      // Fallback to settings store (lastServerPath) via API
      if (!serverPath) {
        try {
          const settings = await window.electron.invoke('get-settings');
          const sp = settings && (settings.serverPath || settings.lastServerPath || settings.settings?.serverPath);
          if (sp) serverPath = String(sp);
  } catch (e) { /* suppressed debug: get-settings failed */ }
      }
      
      // In browser panel, SSE will drive the refresh; avoid immediate refresh that can overwrite optimistic UI
      const isWeb = !!(window.electron && window.electron.isBrowserPanel);
      if (!isWeb && serverPath) {
        try {
          // Delay slightly to allow backend writes to settle
          await new Promise(r => setTimeout(r, 200));
          await refreshPlayerLists(serverPath);
          // (debug removed)
        } catch (e) {
          logger.error('refreshPlayerLists failed after context action', { category: 'ui', data: { error: e?.message } });
        }
      }
      
      // Small delay to ensure state updates have propagated
      await new Promise(resolve => setTimeout(resolve, 100));
      
  } finally {
      actionInProgress = false;
      hideContextMenu();
    }
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
        let serverPath = '';
        try {
          if (window.serverPath && typeof window.serverPath.get === 'function') {
            const pathResult = await window.serverPath.get();
            if (pathResult) {
              serverPath = typeof pathResult === 'object' && pathResult && 'path' in pathResult
                ? /** @type {any} */ (pathResult).path
                : String(pathResult);
            }
          }
          if (!serverPath) {
            const settings = await window.electron.invoke('get-settings');
            const sp = settings && (settings.serverPath || settings.lastServerPath || settings.settings?.serverPath);
            if (sp) serverPath = String(sp);
          }
  } catch (e) { /* suppressed debug: serverPath resolution failed */ }
        
        
        if (!serverPath) {
          logger.error('No serverPath available for player action', { category: 'ui', data: { action, player } });
          return;
        }
        
        // Decide optimistic update details
        const permType = listName === 'ops' ? 'op' : listName === 'whitelist' ? 'whitelist' : listName === 'banned-players' ? 'ban' : listName === 'banned-ips' ? 'ban-ip' : null;
        const isRemove = action === 'deop' || action === 'whitelist remove' || action === 'unban' || action === 'unban-ip' || action.startsWith('un');
        const optimisticAction = isRemove ? 'remove' : 'add';

        // Apply optimistic update first so the next right-click reflects immediately
        if (permType) {
          try { updatePlayerPermissions(player, permType, optimisticAction); } catch {}
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
            // (debug removed)
            
            // Send ban-ip command if server is running
            const statusResult = await window.electron.invoke('get-server-status');
            const serverStatus = statusResult?.status || statusResult || 'stopped';
            
            if (serverStatus && ['running', 'Running'].includes(serverStatus)) {
              await window.electron.invoke('send-command', { command: `ban-ip ${player}` });
              // (debug removed)
            }
          } catch (err) {
            logger.error('ban-ip action failed', { category: 'ui', data: { error: err?.message } });
            // Rollback optimistic update
            try { updatePlayerPermissions(player, 'ban-ip', 'remove'); } catch {}
          }
          
          return; // Exit early since we've handled the entire action        } else {
          // Regular player actions
          // Update list in backend
          try {
            const channel = isRemove ? 'remove-player' : 'add-player';
            await window.electron.invoke(
              channel, 
              listName, 
              serverPath,
              player
            );
            // (debug removed)
          } catch (err) {
            // Error handled silently
            logger.error('player list update invoke failed', { category: 'ui', data: { action, error: err?.message } });
            // Rollback optimistic update
            if (permType) {
              try { updatePlayerPermissions(player, permType, isRemove ? 'add' : 'remove'); } catch {}
            }
          }
        }
        
        // Send command if server is running
        const statusResult = await window.electron.invoke('get-server-status');
        // Check both result formats (object with status property or direct status string)
        const serverStatus = statusResult?.status || statusResult;
        
        if (serverStatus && ['running', 'Running'].includes(serverStatus)) {
          await window.electron.invoke('send-command', { command: cmd });
          // (debug removed)
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
        logger.error('handlePlayerAction failed', { category: 'ui', data: { action, error: err?.message } });
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
              disabled={actionInProgress}
              on:click={() => performContextAction('op')}
            >
              {actionInProgress ? '⏳ Op' : 'Op'}
            </button>
          </li>
        {/if}
        
        {#if canDeop}
          <li role="menuitem">
            <button
              type="button"
              disabled={actionInProgress}
              on:click={() => performContextAction('deop')}
            >
              {actionInProgress ? '⏳ Deop' : 'Deop'}
            </button>
          </li>
        {/if}
        
        {#if canWhitelist}
          <li role="menuitem">
            <button
              type="button"
              disabled={actionInProgress}
              on:click={() => performContextAction('whitelist add')}
            >
              {actionInProgress ? '⏳ Whitelist' : 'Whitelist'}
            </button>
          </li>
        {/if}
        
        {#if canRemoveFromWhitelist}
          <li role="menuitem">
            <button
              type="button"
              disabled={actionInProgress}
              on:click={() => performContextAction('whitelist remove')}
            >
              {actionInProgress ? '⏳ Remove from Whitelist' : 'Remove from Whitelist'}
            </button>
          </li>
        {/if}
        
        {#if canBan}
          <li role="menuitem">
            <button
              type="button"
              disabled={actionInProgress}
              on:click={() => performContextAction('ban')}
            >
              {actionInProgress ? '⏳ Ban' : 'Ban'}
            </button>
          </li>
        {/if}
        
        {#if canKick && isOnline}
          <li role="menuitem">
            <button
              type="button"
              disabled={actionInProgress}
              on:click={() => performContextAction('kick')}
            >
              {actionInProgress ? '⏳ Kick' : 'Kick'}
            </button>
          </li>
        {/if}
        
        {#if canUnban}
          <li role="menuitem">
            <button
              type="button"
              disabled={actionInProgress}
              on:click={() => performContextAction('unban')}
            >
              {actionInProgress ? '⏳ Unban' : 'Unban'}
            </button>
          </li>
        {/if}
        
        {#if canBan && isOnline}
          <li role="menuitem">
            <button
              type="button"
              disabled={actionInProgress}
              on:click={() => performContextAction('ban-ip')}
            >
              {actionInProgress ? '⏳ Ban IP' : 'Ban IP'}
            </button>
          </li>
        {/if}
        
        {#if !isOnline && $playerState.lists['banned-ips'].includes(player)}
          <li role="menuitem">
            <button
              type="button"
              disabled={actionInProgress}
              on:click={() => performContextAction('unban-ip')}
            >
              {actionInProgress ? '⏳ Unban IP' : 'Unban IP'}
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
  
    .context-menu li button:hover:not(:disabled) {
    background-color: #f0f0f0;
    color: #000;
  }
  
  .context-menu li button:disabled {
    background-color: #f5f5f5;
    color: #999;
    cursor: not-allowed;
    opacity: 0.7;
  }
  
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
