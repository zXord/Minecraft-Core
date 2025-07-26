// Player state store
import { writable } from 'svelte/store';
import logger from '../utils/logger.js';

// Create the player state store with default values
export const playerState = writable({
  count: 0,
  onlinePlayers: [],
  lists: {
    whitelist: [],
    ops: [],
    'banned-players': [],
    'banned-ips': []
  },
  selectedPlayer: '',
  contextMenu: { visible: false, x: 0, y: 0, player: '' },
  serverStatus: 'stopped', // Added to fix TypeScript error
  lastBannedPlayer: '' // Track the last player banned by IP
});

// Log store initialization
logger.debug('Player state store initialized', {
  category: 'core',
  data: {
    store: 'playerState',
    operation: 'initialization',
    defaultState: {
      count: 0,
      onlinePlayersCount: 0,
      listsCount: Object.keys({
        whitelist: [],
        ops: [],
        'banned-players': [],
        'banned-ips': []
      }).length
    }
  }
});

// Debounce mechanism for player updates
let pendingPlayerNames = null;
let pendingUpdateTimer = null;
const DEBOUNCE_DELAY = 1500; // 1.5 second debounce delay (reduced from 3 seconds)

// Helper functions for player state management
export function updateOnlinePlayers(players) {
  logger.debug('updateOnlinePlayers called', {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'updateOnlinePlayers',
      playersCount: Array.isArray(players) ? players.length : 'invalid',
      playersType: typeof players
    }
  });

  if (!Array.isArray(players)) {
    logger.error('Invalid players array provided to updateOnlinePlayers', {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'updateOnlinePlayers',
        players,
        isArray: Array.isArray(players),
        errorType: 'ValidationError'
      }
    });
    return;
  }
  
  const currentState = getStore();
  
  // If the player count decreased (someone left), update immediately
  if (players.length < currentState.count) {
    logger.info('Player left - updating immediately', {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'updateOnlinePlayers',
        operation: 'player_left',
        oldCount: currentState.count,
        newCount: players.length,
        playersLeft: currentState.count - players.length,
        remainingPlayers: players
      }
    });
    
    // Player left - update immediately
    playerState.update(state => {
      logger.debug('Store updated - player left', {
        category: 'core',
        data: {
          store: 'playerState',
          operation: 'store_update',
          context: 'player_left',
          previousCount: state.count,
          newCount: players.length
        }
      });
      
      return {
        ...state,
        count: players.length,
        onlinePlayers: players
      };
    });
    
    // Also clear any pending debounced updates
    if (pendingUpdateTimer) {
      clearTimeout(pendingUpdateTimer);
      pendingPlayerNames = null;
      logger.debug('Cleared pending debounced update', {
        category: 'core',
        data: {
          store: 'playerState',
          function: 'updateOnlinePlayers',
          operation: 'clear_debounce',
          reason: 'player_left'
        }
      });
    }
    return;
  }
  
  // If this is the first update or there are many players, don't debounce
  if (players.length > 1) {
    logger.debug('Multiple players detected - updating immediately', {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'updateOnlinePlayers',
        operation: 'multiple_players_update',
        playerCount: players.length,
        players
      }
    });
    
    // Always immediately show multiple players
    playerState.update(state => {
      logger.debug('Store updated - multiple players', {
        category: 'core',
        data: {
          store: 'playerState',
          operation: 'store_update',
          context: 'multiple_players',
          previousCount: state.count,
          newCount: players.length
        }
      });
      
      return {
        ...state,
        count: players.length,
        onlinePlayers: players
      };
    });
    return;
  }
  
  // If the new player list is empty and the last update had players,
  // we need to debounce this to avoid flickering when players join
  if (players.length === 0) {
    // If currently showing players, debounce empty player list
    if (currentState.count > 0) {
      logger.debug('Empty player list received - starting debounce', {
        category: 'core',
        data: {
          store: 'playerState',
          function: 'updateOnlinePlayers',
          operation: 'debounce_empty_list',
          previousCount: currentState.count,
          debounceDelay: DEBOUNCE_DELAY
        }
      });
      
      // We got an empty list while showing players - debounce it
      clearTimeout(pendingUpdateTimer);
      pendingPlayerNames = players;
      
      pendingUpdateTimer = setTimeout(() => {
        // Only update to empty list if no new players came in during debounce
        if (pendingPlayerNames && pendingPlayerNames.length === 0) {
          logger.info('Debounce completed - updating to empty player list', {
            category: 'core',
            data: {
              store: 'playerState',
              function: 'updateOnlinePlayers',
              operation: 'debounce_complete',
              finalCount: 0
            }
          });
          
          playerState.update(state => {
            logger.debug('Store updated - empty player list', {
              category: 'core',
              data: {
                store: 'playerState',
                operation: 'store_update',
                context: 'debounced_empty_list',
                previousCount: state.count,
                newCount: 0
              }
            });
            
            return {
              ...state,
              count: 0,
              onlinePlayers: []
            };
          });
        } else {
          logger.debug('Debounce cancelled - new players detected', {
            category: 'core',
            data: {
              store: 'playerState',
              function: 'updateOnlinePlayers',
              operation: 'debounce_cancelled',
              reason: 'new_players_detected'
            }
          });
        }
        pendingPlayerNames = null;
      }, DEBOUNCE_DELAY);
      return;
    }
  }
  
  // If we get a player while we were debouncing empty player list,
  // cancel that empty list update and show the player immediately
  if (players.length > 0 && pendingPlayerNames !== null) {
    logger.debug('Cancelling empty list debounce - new players detected', {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'updateOnlinePlayers',
        operation: 'cancel_debounce',
        newPlayerCount: players.length,
        reason: 'new_players_during_debounce'
      }
    });
    
    clearTimeout(pendingUpdateTimer);
    pendingPlayerNames = null;
  }
  
  // Normal update to the player list
  logger.debug('Normal player list update', {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'updateOnlinePlayers',
      operation: 'normal_update',
      playerCount: players.length,
      players
    }
  });
  
  playerState.update(state => {
    logger.debug('Store updated - normal update', {
      category: 'core',
      data: {
        store: 'playerState',
        operation: 'store_update',
        context: 'normal_update',
        previousCount: state.count,
        newCount: players.length
      }
    });
    
    return {
      ...state,
      count: players.length,
      onlinePlayers: players
    };
  });
}

// Helper function to get current store value
function getStore() {
  let storeValue = { count: 0, onlinePlayers: [] }; // Default value to prevent undefined
  const unsubscribe = playerState.subscribe(value => {
    storeValue = value;
  });
  unsubscribe();
  return storeValue;
}

// Player authentication and permission management functions
export function updatePlayerAuthentication(player, authStatus, authData = {}) {
  logger.info('Player authentication status updated', {
    category: 'auth',
    data: {
      store: 'playerState',
      function: 'updatePlayerAuthentication',
      operation: 'player_auth_update',
      player,
      authStatus,
      hasAuthData: Object.keys(authData).length > 0,
      authDataKeys: Object.keys(authData)
    }
  });

  try {
    playerState.update(state => {
      logger.debug('Store updated - player authentication', {
        category: 'auth',
        data: {
          store: 'playerState',
          operation: 'store_update',
          context: 'player_authentication',
          player,
          authStatus,
          previousSelectedPlayer: state.selectedPlayer
        }
      });
      
      return {
        ...state,
        // Update any authentication-related state here if needed
        selectedPlayer: state.selectedPlayer === player ? player : state.selectedPlayer
      };
    });
  } catch (error) {
    logger.error(`Failed to update player authentication: ${error.message}`, {
      category: 'auth',
      data: {
        store: 'playerState',
        function: 'updatePlayerAuthentication',
        operation: 'player_auth_update_error',
        player,
        authStatus,
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    });
    throw error;
  }
}

export function updatePlayerPermissions(player, permissionType, action, permissionData = {}) {
  logger.info('Player permissions updated', {
    category: 'auth',
    data: {
      store: 'playerState',
      function: 'updatePlayerPermissions',
      operation: 'player_permission_update',
      player,
      permissionType, // 'op', 'whitelist', 'ban', etc.
      action, // 'add', 'remove', 'modify'
      hasPermissionData: Object.keys(permissionData).length > 0,
      permissionDataKeys: Object.keys(permissionData)
    }
  });

  try {
    const currentState = getStore();
    const listName = permissionType === 'op' ? 'ops' : 
                    permissionType === 'whitelist' ? 'whitelist' :
                    permissionType === 'ban' ? 'banned-players' :
                    permissionType === 'ban-ip' ? 'banned-ips' : null;

    if (listName && currentState.lists[listName]) {
      const currentList = [...currentState.lists[listName]];
      let updatedList = currentList;
      
      if (action === 'add' && !currentList.includes(player)) {
        updatedList = [...currentList, player];
      } else if (action === 'remove') {
        updatedList = currentList.filter(p => p !== player);
      }
      
      logger.debug('Permission list updated', {
        category: 'auth',
        data: {
          store: 'playerState',
          function: 'updatePlayerPermissions',
          operation: 'permission_list_change',
          listName,
          player,
          action,
          previousCount: currentList.length,
          newCount: updatedList.length,
          wasInList: currentList.includes(player),
          isInList: updatedList.includes(player)
        }
      });
      
      updatePlayerList(listName, updatedList);
    } else {
      logger.warn('Unknown permission type or list not found', {
        category: 'auth',
        data: {
          store: 'playerState',
          function: 'updatePlayerPermissions',
          operation: 'permission_update_warning',
          player,
          permissionType,
          action,
          listName,
          availableLists: Object.keys(currentState.lists)
        }
      });
    }
  } catch (error) {
    logger.error(`Failed to update player permissions: ${error.message}`, {
      category: 'auth',
      data: {
        store: 'playerState',
        function: 'updatePlayerPermissions',
        operation: 'player_permission_update_error',
        player,
        permissionType,
        action,
        errorType: error.constructor.name,
        errorMessage: error.message,
        stack: error.stack
      }
    });
    throw error;
  }
}

// Player data synchronization error recovery
export function handlePlayerDataSyncError(error, context = {}) {
  logger.error(`Player data synchronization error: ${error.message}`, {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'handlePlayerDataSyncError',
      operation: 'sync_error_handling',
      errorType: error.constructor.name,
      errorMessage: error.message,
      context,
      stack: error.stack
    }
  });

  try {
    // Attempt to recover by resetting to safe defaults
    const currentState = getStore();
    
    logger.warn('Attempting player data recovery', {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'handlePlayerDataSyncError',
        operation: 'recovery_attempt',
        currentOnlineCount: currentState.count,
        currentListsCount: Object.keys(currentState.lists).length,
        recoveryStrategy: 'partial_reset'
      }
    });

    // Keep online players but reset problematic lists if needed
    if (context.affectedLists) {
      playerState.update(state => {
        const newLists = { ...state.lists };
        context.affectedLists.forEach(listName => {
          newLists[listName] = [];
        });
        
        logger.info('Player data partially recovered', {
          category: 'core',
          data: {
            store: 'playerState',
            operation: 'store_update',
            context: 'error_recovery',
            affectedLists: context.affectedLists,
            recoveryAction: 'reset_affected_lists'
          }
        });
        
        return {
          ...state,
          lists: newLists
        };
      });
    }
  } catch (recoveryError) {
    logger.fatal(`Failed to recover from player data sync error: ${recoveryError.message}`, {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'handlePlayerDataSyncError',
        operation: 'recovery_failed',
        originalError: error.message,
        recoveryError: recoveryError.message,
        errorType: recoveryError.constructor.name
      }
    });
  }
}

export function updatePlayerList(listName, players) {
  logger.debug('updatePlayerList called', {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'updatePlayerList',
      listName,
      playersCount: Array.isArray(players) ? players.length : 'invalid',
      playersType: typeof players
    }
  });

  if (!listName || !Array.isArray(players)) {
    logger.error('Invalid parameters for updatePlayerList', {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'updatePlayerList',
        listName,
        players,
        hasListName: !!listName,
        isPlayersArray: Array.isArray(players),
        errorType: 'ValidationError'
      }
    });
    return;
  }
  
  logger.info('Updating player list', {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'updatePlayerList',
      operation: 'player_list_update',
      listName,
      playersCount: players.length,
      listType: listName.includes('banned') ? 'banned' : 
                listName === 'ops' ? 'permissions' : 
                listName === 'whitelist' ? 'access' : 'unknown'
    }
  });
  
  playerState.update(state => {
    const previousCount = state.lists[listName]?.length || 0;
    const lists = { ...state.lists };
    lists[listName] = players;
    
    logger.debug('Store updated - player list', {
      category: 'core',
      data: {
        store: 'playerState',
        operation: 'store_update',
        context: 'player_list_update',
        listName,
        previousCount,
        newCount: players.length,
        changeType: players.length > previousCount ? 'added' : 
                   players.length < previousCount ? 'removed' : 'modified'
      }
    });
    
    return { ...state, lists };
  });
}

export function selectPlayer(player) {
  logger.debug('Player selected', {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'selectPlayer',
      operation: 'player_selection',
      player,
      hasPlayer: !!player
    }
  });

  playerState.update(state => {
    logger.debug('Store updated - player selection', {
      category: 'core',
      data: {
        store: 'playerState',
        operation: 'store_update',
        context: 'player_selection',
        previousPlayer: state.selectedPlayer,
        newPlayer: player,
        contextMenuClosed: true
      }
    });
    
    return {
      ...state,
      selectedPlayer: player,
      contextMenu: { ...state.contextMenu, visible: false }
    };
  });
}

export function showContextMenu(x, y, player) {
  logger.debug('Context menu requested', {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'showContextMenu',
      operation: 'context_menu_show',
      player,
      position: { x, y },
      hasPlayer: !!player
    }
  });

  // Force the menu to be hidden first (to trigger re-render)
  playerState.update(state => {
    logger.debug('Store updated - context menu hidden', {
      category: 'core',
      data: {
        store: 'playerState',
        operation: 'store_update',
        context: 'context_menu_hide_before_show',
        player
      }
    });
    
    return {
      ...state,
      contextMenu: { visible: false, x: 0, y: 0, player: '' }
    };
  });
  
  // Then show it after a short delay (helps with re-rendering)
  setTimeout(() => {
    try {
      // Ensure the menu stays within viewport boundaries
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const menuWidth = 200; // Approximate width of context menu
      const menuHeight = 300; // Approximate height of context menu
      
      // Adjust position if menu would go outside viewport
      const adjustedX = Math.min(x, viewportWidth - menuWidth);
      const adjustedY = Math.min(y, viewportHeight - menuHeight);
      
      logger.debug('Context menu position calculated', {
        category: 'core',
        data: {
          store: 'playerState',
          function: 'showContextMenu',
          operation: 'position_calculation',
          originalPosition: { x, y },
          adjustedPosition: { x: adjustedX, y: adjustedY },
          viewport: { width: viewportWidth, height: viewportHeight },
          positionAdjusted: adjustedX !== x || adjustedY !== y
        }
      });
      
      playerState.update(state => {
        logger.debug('Store updated - context menu shown', {
          category: 'core',
          data: {
            store: 'playerState',
            operation: 'store_update',
            context: 'context_menu_show',
            player,
            position: { x: adjustedX, y: adjustedY },
            visible: true
          }
        });
        
        return {
          ...state,
          contextMenu: { visible: true, x: adjustedX, y: adjustedY, player }
        };
      });
    } catch (error) {
      logger.error(`Failed to show context menu: ${error.message}`, {
        category: 'core',
        data: {
          store: 'playerState',
          function: 'showContextMenu',
          operation: 'context_menu_show_error',
          player,
          position: { x, y },
          errorType: error.constructor.name,
          errorMessage: error.message
        }
      });
    }
  }, 50);
}

export function hideContextMenu() {
  logger.debug('Context menu hide requested', {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'hideContextMenu',
      operation: 'context_menu_hide'
    }
  });

  playerState.update(state => {
    logger.debug('Store updated - context menu hidden', {
      category: 'core',
      data: {
        store: 'playerState',
        operation: 'store_update',
        context: 'context_menu_hide',
        previouslyVisible: state.contextMenu.visible,
        player: state.contextMenu.player
      }
    });
    
    return {
      ...state,
      contextMenu: { ...state.contextMenu, visible: false }
    };
  });
}

// Function to refresh all player lists from the backend
export async function refreshPlayerLists(serverPath) {
  const startTime = Date.now();
  
  logger.debug('refreshPlayerLists called', {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'refreshPlayerLists',
      serverPath,
      serverPathType: typeof serverPath,
      operation: 'player_data_sync'
    }
  });

  if (!serverPath || typeof serverPath !== 'string') {
    logger.error('Invalid server path for refreshPlayerLists', {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'refreshPlayerLists',
        serverPath,
        isString: typeof serverPath === 'string',
        errorType: 'ValidationError',
        operation: 'player_data_sync_failed'
      }
    });
    return;
  }
  
  logger.info('Refreshing player lists from backend', {
    category: 'core',
    data: {
      store: 'playerState',
      function: 'refreshPlayerLists',
      operation: 'player_data_sync_start',
      serverPath
    }
  });
  
  try {
    const listNames = ['whitelist', 'ops', 'banned-players', 'banned-ips'];
    const updatedLists = {};
    let successCount = 0;
    let errorCount = 0;
    
    // Load all lists concurrently
    const listPromises = listNames.map(async (listName) => {
      try {
        logger.debug('Loading player list', {
          category: 'core',
          data: {
            store: 'playerState',
            function: 'refreshPlayerLists',
            operation: 'load_individual_list',
            listName,
            serverPath
          }
        });
        
        const list = await window.electron.invoke('read-players', listName, serverPath) || [];
        
        logger.debug('Player list loaded successfully', {
          category: 'core',
          data: {
            store: 'playerState',
            function: 'refreshPlayerLists',
            operation: 'load_individual_list_success',
            listName,
            itemCount: list.length
          }
        });
        
        return [listName, list];
      } catch (err) {
        logger.error(`Failed to load player list: ${err.message}`, {
          category: 'core',
          data: {
            store: 'playerState',
            function: 'refreshPlayerLists',
            operation: 'load_individual_list_error',
            listName,
            errorType: err.constructor.name,
            errorMessage: err.message,
            serverPath
          }
        });
        return [listName, []];
      }
    });
    
    const results = await Promise.allSettled(listPromises);
    
    // Process results
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        const [listName, list] = result.value;
        successCount++;
        
        updatedLists[listName] = list.map(item => {
          if (listName === 'banned-ips' && item && typeof item === 'object' && item.ip) {
            // Format banned IPs to include player name in parentheses if available
            return item.playerName ? `${item.ip} (${item.playerName})` : item.ip;
          }
          return item.name || item.ip || item;
        });
        
        logger.debug('Player list processed', {
          category: 'core',
          data: {
            store: 'playerState',
            function: 'refreshPlayerLists',
            operation: 'process_list_success',
            listName,
            originalCount: list.length,
            processedCount: updatedLists[listName].length
          }
        });
      } else {
        errorCount++;
        logger.error(`Failed to process player list result: ${result.reason}`, {
          category: 'core',
          data: {
            store: 'playerState',
            function: 'refreshPlayerLists',
            operation: 'process_list_error',
            errorType: 'PromiseRejection',
            reason: result.reason
          }
        });
      }
    });
    
    const duration = Date.now() - startTime;
    
    // Update the store with all new lists at once
    playerState.update(state => {
      const totalItemsBefore = Object.values(state.lists).reduce((sum, list) => sum + list.length, 0);
      const totalItemsAfter = Object.values(updatedLists).reduce((sum, list) => sum + list.length, 0);
      
      logger.info('Store updated - player lists refreshed', {
        category: 'core',
        data: {
          store: 'playerState',
          operation: 'store_update',
          context: 'player_lists_refresh',
          duration,
          successCount,
          errorCount,
          totalListsUpdated: Object.keys(updatedLists).length,
          totalItemsBefore,
          totalItemsAfter,
          itemsChanged: totalItemsAfter - totalItemsBefore
        }
      });
      
      return {
        ...state,
        lists: { ...state.lists, ...updatedLists }
      };
    });
    
    logger.info('Player lists refresh completed successfully', {
      category: 'performance',
      data: {
        store: 'playerState',
        function: 'refreshPlayerLists',
        operation: 'player_data_sync_complete',
        duration,
        successCount,
        errorCount,
        totalLists: listNames.length,
        serverPath
      }
    });
    
  } catch (err) {
    const duration = Date.now() - startTime;
    
    logger.error(`Failed to refresh player lists: ${err.message}`, {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'refreshPlayerLists',
        operation: 'player_data_sync_failed',
        serverPath,
        duration,
        errorType: err.constructor.name,
        errorMessage: err.message,
        stack: err.stack
      }
    });
    
    // Attempt recovery by keeping existing data
    logger.warn('Attempting recovery - keeping existing player lists', {
      category: 'core',
      data: {
        store: 'playerState',
        function: 'refreshPlayerLists',
        operation: 'recovery_attempt',
        recoveryStrategy: 'keep_existing_data'
      }
    });
  }
}
