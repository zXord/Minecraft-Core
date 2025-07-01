// Player state store
import { writable } from 'svelte/store';

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

// Debounce mechanism for player updates
let pendingPlayerNames = null;
let pendingUpdateTimer = null;
const DEBOUNCE_DELAY = 1500; // 1.5 second debounce delay (reduced from 3 seconds)

// Helper functions for player state management
export function updateOnlinePlayers(players) {
  if (!Array.isArray(players)) return;
  
  const currentState = getStore();
  
  // If the player count decreased (someone left), update immediately
  if (players.length < currentState.count) {
    // Player left - update immediately
    playerState.update(state => ({
      ...state,
      count: players.length,
      onlinePlayers: players
    }));
    
    // Also clear any pending debounced updates
    if (pendingUpdateTimer) {
      clearTimeout(pendingUpdateTimer);
      pendingPlayerNames = null;
    }
    return;
  }
  
  // If this is the first update or there are many players, don't debounce
  if (players.length > 1) {
    // Always immediately show multiple players
    playerState.update(state => ({
      ...state,
      count: players.length,
      onlinePlayers: players
    }));
    return;
  }
  
  // If the new player list is empty and the last update had players,
  // we need to debounce this to avoid flickering when players join
  if (players.length === 0) {
    // If currently showing players, debounce empty player list
    if (currentState.count > 0) {
      // We got an empty list while showing players - debounce it
      clearTimeout(pendingUpdateTimer);
      pendingPlayerNames = players;
      
      pendingUpdateTimer = setTimeout(() => {
        // Only update to empty list if no new players came in during debounce
        if (pendingPlayerNames && pendingPlayerNames.length === 0) {
          playerState.update(state => ({
            ...state,
            count: 0,
            onlinePlayers: []
          }));
        }
        pendingPlayerNames = null;
      }, DEBOUNCE_DELAY);
      return;
    }
  }
  
  // If we get a player while we were debouncing empty player list,
  // cancel that empty list update and show the player immediately
  if (players.length > 0 && pendingPlayerNames !== null) {
    clearTimeout(pendingUpdateTimer);
    pendingPlayerNames = null;
  }
  
  // Normal update to the player list
  playerState.update(state => ({
    ...state,
    count: players.length,
    onlinePlayers: players
  }));
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

export function updatePlayerList(listName, players) {
  if (!listName || !Array.isArray(players)) return;
  
  playerState.update(state => {
    const lists = { ...state.lists };
    lists[listName] = players;
    return { ...state, lists };
  });
}

export function selectPlayer(player) {
  playerState.update(state => ({
    ...state,
    selectedPlayer: player,
    contextMenu: { ...state.contextMenu, visible: false }
  }));
}

export function showContextMenu(x, y, player) {
  // Force the menu to be hidden first (to trigger re-render)
  playerState.update(state => ({
    ...state,
    contextMenu: { visible: false, x: 0, y: 0, player: '' }
  }));
  
  // Then show it after a short delay (helps with re-rendering)
  setTimeout(() => {
    // Ensure the menu stays within viewport boundaries
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const menuWidth = 200; // Approximate width of context menu
    const menuHeight = 300; // Approximate height of context menu
    
    // Adjust position if menu would go outside viewport
    const adjustedX = Math.min(x, viewportWidth - menuWidth);
    const adjustedY = Math.min(y, viewportHeight - menuHeight);
    
    playerState.update(state => ({
      ...state,
      contextMenu: { visible: true, x: adjustedX, y: adjustedY, player }
    }));
  }, 50);
}

export function hideContextMenu() {
  playerState.update(state => ({
    ...state,
    contextMenu: { ...state.contextMenu, visible: false }
  }));
}

// Function to refresh all player lists from the backend
export async function refreshPlayerLists(serverPath) {
  if (!serverPath || typeof serverPath !== 'string') {
    return;
  }
  
  try {
    const listNames = ['whitelist', 'ops', 'banned-players', 'banned-ips'];
    const updatedLists = {};
    
    // Load all lists concurrently
    const listPromises = listNames.map(async (listName) => {
      try {
        const list = await window.electron.invoke('read-players', listName, serverPath) || [];
        return [listName, list];
      } catch (error) {
        console.warn(`Failed to load ${listName}:`, error);
        return [listName, []];
      }
    });
    
    const results = await Promise.allSettled(listPromises);
    
    // Process results
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        const [listName, list] = result.value;
        updatedLists[listName] = list.map(item => {
          if (listName === 'banned-ips' && item && typeof item === 'object' && item.ip) {
            // Format banned IPs to include player name in parentheses if available
            return item.playerName ? `${item.ip} (${item.playerName})` : item.ip;
          }
          return item.name || item.ip || item;
        });
      }
    });
    
    // Update the store with all new lists at once
    playerState.update(state => ({
      ...state,
      lists: { ...state.lists, ...updatedLists }
    }));
    
  } catch (error) {
    console.warn('Failed to refresh player lists:', error);
  }
}
