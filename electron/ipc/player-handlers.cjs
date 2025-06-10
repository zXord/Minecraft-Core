// Player management IPC handlers
const path = require('path');
const fs = require('fs');

// Keep track of player names associated with IPs
const playerIpMap = new Map();

/**
 * Initialize the player-IP map from the persistent file
 * @param {string} serverPath Path to the server directory
 */
function initializePlayerIpMap(serverPath) {
  if (!serverPath || !fs.existsSync(serverPath)) return;
  
  const playerMapFile = path.join(serverPath, 'player-ip-map.json');
  if (fs.existsSync(playerMapFile)) {
    const mapData = JSON.parse(fs.readFileSync(playerMapFile, 'utf-8'));

    // Populate the in-memory map
    Object.entries(mapData).forEach(([ip, playerName]) => {
      playerIpMap.set(ip, playerName);
    });
  }
}

/**
 * Create player management IPC handlers
 * 
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createPlayerHandlers() {
  return {
    'read-players': (_e, listName, serverPath) => {
      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          throw new Error('Invalid server path');
        }
        
        if (!listName || typeof listName !== 'string') {
          throw new Error('Invalid list name');
        }
        
        let filename = listName;
        if (listName === 'banned-players' || listName === 'banned') filename = 'banned-players';
        else if (listName === 'banned-ips' || listName === 'ips') filename = 'banned-ips';
        else if (!['ops', 'whitelist'].includes(filename)) {
          throw new Error(`Unsupported list type: ${listName}`);
        }
        
        const file = path.join(serverPath, `${filename}.json`);
        if (!fs.existsSync(file)) return [];
        
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
          
          // Special handling for banned IPs to ensure player names are properly read
          if (filename === 'banned-ips') {
            // Initialize the player-IP map when reading banned IPs
            initializePlayerIpMap(serverPath);
            
            // Get the most recently used player name from the playerIpMap if available
            let lastUsedPlayerName = null;
            if (playerIpMap.size > 0) {
              // Extract the last entry from the map
              for (const [_, playerName] of playerIpMap) {
                lastUsedPlayerName = playerName;
              }
            }
            
            // Read the player-ip-map file to get player names
            const playerMapFile = path.join(serverPath, 'player-ip-map.json');
            let mapData = {};
            if (fs.existsSync(playerMapFile)) {
              mapData = JSON.parse(fs.readFileSync(playerMapFile, 'utf-8'));
            }
            
            // Ensure each entry has a valid playerName field if possible
            const processedData = data.map(item => {
              // Handle common IP addresses with special default names if no other name is available
              const assignSpecialNameIfNeeded = (ip) => {
                // If we already have a name in our map, use that
                if (playerIpMap.has(ip)) {
                  return playerIpMap.get(ip);
                }
                
                // Check the persistent map file directly
                if (mapData[ip]) {
                  return mapData[ip];
                }
                
                // If we have a last used player name, use that
                if (lastUsedPlayerName) {
                  return lastUsedPlayerName;
                }
                
                return null; // No special name assigned
              };
              
              if (typeof item === 'string') {
                // Try to extract player name from string format
                const matches = item.match(/^(.+)\s+\(Player:\s+(.+)\)$/);
                if (matches) {
                  const [_, ip, playerName] = matches;
                  return {
                    ip: ip.trim(),
                    playerName: playerName.trim(),
                    created: new Date().toISOString(),
                    source: "Minecraft Core",
                    expires: "forever"
                  };
                }
                // Just a plain IP string - check if we have a playerName in our map
                const playerName = playerIpMap.get(item) || assignSpecialNameIfNeeded(item);
                return {
                  ip: item,
                  created: new Date().toISOString(),
                  source: "Minecraft Core",
                  expires: "forever",
                  playerName: playerName || "Unknown"
                };
              }
              
              // For object entries, ensure they have a playerName
              if (item && typeof item === 'object' && item.ip) {
                if (!item.playerName || item.playerName === 'Unknown') {
                  // Try to find a player name for this IP
                  const specialName = assignSpecialNameIfNeeded(item.ip);
                  if (specialName) {
                    item.playerName = specialName;
                    
                    // Also update our in-memory map and persistent file
                    playerIpMap.set(item.ip, specialName);
                    mapData[item.ip] = specialName;
                    fs.writeFileSync(playerMapFile, JSON.stringify(mapData, null, 2));
                  }
                }
              }
              
              return item;
            });
            
            // Save the processed data back to ensure format consistency
            fs.writeFileSync(file, JSON.stringify(processedData, null, 2));
            return processedData;
          }
          
          return data;
        } catch (parseErr) {
          return [];
        }
      } catch (err) {
        throw err;
      }
    },
    
    'write-file': (_e, filePath, content) => {
      try {
        if (!filePath || typeof filePath !== 'string') {
          throw new Error('Invalid file path');
        }
        
        if (!content || typeof content !== 'string') {
          throw new Error('Invalid file content');
        }
        
        // Make sure the directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        // Write the file
        fs.writeFileSync(filePath, content);
        return { success: true };
      } catch (err) {
        throw err;
      }
    },
    
    'add-player': (_e, listName, serverPath, entry) => {
      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          throw new Error('Invalid server path');
        }
        
        if (!listName || typeof listName !== 'string') {
          throw new Error('Invalid list name');
        }
        
        if (!entry || typeof entry !== 'string' || entry.trim() === '') {
          throw new Error('Invalid player entry');
        }
        
        let filename = listName;
        if (listName === 'banned') filename = 'banned-players';
        else if (listName === 'ips') filename = 'banned-ips';
        else if (!['ops', 'whitelist', 'banned-players', 'banned-ips'].includes(filename)) {
          throw new Error(`Unsupported list type: ${listName}`);
        }
        
        const file = path.join(serverPath, `${filename}.json`);
        let list = [];
        
        // Read existing list
        if (fs.existsSync(file)) {
          try {
            list = JSON.parse(fs.readFileSync(file, 'utf-8'));
          } catch (err) {
            list = [];
          }
        }
        
        // Ensure list is an array
        if (!Array.isArray(list)) {
          list = [];
        }
        
        // Check if this is a special format for banned-ips with player name included
        let playerName = null;
        if (listName === 'banned-ips' && entry.includes(' (Player: ')) {
          // Format: "127.0.0.1 (Player: PlayerName)"
          const parts = entry.split(' (Player: ');
          entry = parts[0].trim(); // Extract just the IP
          playerName = parts[1].replace(')', '').trim(); // Extract the player name
          
          // Store this association in our map for future lookups
          playerIpMap.set(entry, playerName);
            // Also store it in a persistent file
          const playerMapFile = path.join(serverPath, 'player-ip-map.json');
          try {
            let mapData = {};
            if (fs.existsSync(playerMapFile)) {
              mapData = JSON.parse(fs.readFileSync(playerMapFile, 'utf-8'));
            }
            mapData[entry] = playerName;
            fs.writeFileSync(playerMapFile, JSON.stringify(mapData, null, 2));
          } catch (mapErr) {
            // Ignore errors writing to player map file
          }
        }// Format objects based on the list type
        let newEntry = entry;
        if (listName === 'ops' || listName === 'whitelist') {
          newEntry = { name: entry, uuid: `player-${Date.now()}`, level: 4 };
        } else if (listName === 'banned-players' || listName === 'banned') {
          newEntry = { 
            name: entry, 
            created: new Date().toISOString(),
            source: "Minecraft Core", 
            expires: "forever" 
          };
        } else if (listName === 'banned-ips' || listName === 'ips') {
          // Try to get player name from our map if not provided directly
          if (!playerName && playerIpMap.has(entry)) {
            playerName = playerIpMap.get(entry);
          }
          
          newEntry = { 
            ip: entry, 
            created: new Date().toISOString(),
            source: "Minecraft Core", 
            expires: "forever",
            playerName: playerName || "Unknown"
          };
        }
        
        // Add to list if not already there
        if (Array.isArray(list)) {
          const exists = list.some(item => 
            (typeof item === 'string' && item === entry) ||
            (item && typeof item === 'object' && 
              ((item.name && item.name === entry) || (item.ip && item.ip === entry)))
          );
          
          if (!exists) {
            list.push(newEntry);
          }
        } else {
          list = [newEntry];
        }
        
        // Ensure directory exists
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(file, JSON.stringify(list, null, 2));
        return list;
      } catch (err) {
        throw err;
      }
    },
    
    'add-player-with-details': (_e, listName, serverPath, detailsObj) => {
      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          throw new Error('Invalid server path');
        }
        
        if (!listName || typeof listName !== 'string') {
          throw new Error('Invalid list name');
        }
        
        if (!detailsObj || typeof detailsObj !== 'object') {
          throw new Error('Invalid player details');
        }
        
        let filename = listName;
        if (listName === 'banned') filename = 'banned-players';
        else if (listName === 'ips') filename = 'banned-ips';
        else if (!['ops', 'whitelist', 'banned-players', 'banned-ips'].includes(filename)) {
          throw new Error(`Unsupported list type: ${listName}`);
        }
        
        const file = path.join(serverPath, `${filename}.json`);
        let list = [];
        
        // Read existing list
        if (fs.existsSync(file)) {
          try {
            list = JSON.parse(fs.readFileSync(file, 'utf-8'));
          } catch (err) {
            list = [];
          }
        }
        
        // Ensure list is an array
        if (!Array.isArray(list)) {
          list = [];
        }
        
        // For banned-ips, check if IP already exists
        if (listName === 'banned-ips' && detailsObj.ip) {
          const exists = list.some(item => 
            (typeof item === 'string' && item === detailsObj.ip) ||
            (item && typeof item === 'object' && item.ip === detailsObj.ip)
          );
          
          if (!exists) {
            list.push(detailsObj);
          }
        } else {
          // For other lists
          list.push(detailsObj);
        }
        
        // Ensure directory exists
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(file, JSON.stringify(list, null, 2));
        return list;
      } catch (err) {
        throw err;
      }
    },
    
    'get-player-ip': () => {
      return `127.0.0.${Math.floor(Math.random() * 255)}`;
    },
    
    'get-last-banned-player': (_e, serverPath) => {
      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          return { lastBannedPlayer: null };
        }
        
        // Get the most recently used player name from our in-memory map
        let lastPlayerName = null;
        if (playerIpMap.size > 0) {
          // Extract the last entry from the map
          for (const [, playerName] of playerIpMap) {
            if (playerName && playerName !== 'Unknown') {
              lastPlayerName = playerName;
            }
          }
          if (lastPlayerName) {
            return { lastBannedPlayer: lastPlayerName };
          }
        }
        
        // Check our persistent player map file
        const playerMapFile = path.join(serverPath, 'player-ip-map.json');
        if (fs.existsSync(playerMapFile)) {
          const mapData = JSON.parse(fs.readFileSync(playerMapFile, 'utf-8'));
          const entries = Object.entries(mapData);
          if (entries.length > 0) {
            for (const [, playerName] of entries) {
              if (playerName && playerName !== 'Unknown') {
                return { lastBannedPlayer: playerName };
              }
            }

            const [, playerName] = entries[entries.length - 1];
            return { lastBannedPlayer: playerName };
          }
        }
        
        // Fallback to checking banned-ips.json
        const file = path.join(serverPath, 'banned-ips.json');
        if (fs.existsSync(file)) {
          const data = JSON.parse(fs.readFileSync(file, 'utf-8'));

          for (const item of data) {
            if (item && typeof item === 'object' && item.playerName &&
                item.playerName !== 'Unknown') {
              return { lastBannedPlayer: item.playerName };
            }
          }
        }
        
        // Fallback to checking banned-players.json for a player name
        const bannedPlayersFile = path.join(serverPath, 'banned-players.json');
        if (fs.existsSync(bannedPlayersFile)) {
          const data = JSON.parse(fs.readFileSync(bannedPlayersFile, 'utf-8'));
          if (Array.isArray(data) && data.length > 0) {
            for (const item of data) {
              if (item && typeof item === 'object' && item.name) {
                return { lastBannedPlayer: item.name };
              } else if (typeof item === 'string') {
                return { lastBannedPlayer: item };
              }
            }
          }
        }
          // If we still don't have a player name, check whitelist.json
        const whitelistFile = path.join(serverPath, 'whitelist.json');
        if (fs.existsSync(whitelistFile)) {
          const data = JSON.parse(fs.readFileSync(whitelistFile, 'utf-8'));
          if (Array.isArray(data) && data.length > 0) {
            for (const item of data) {
              if (item && typeof item === 'object' && item.name) {
                return { lastBannedPlayer: item.name };
              } else if (typeof item === 'string') {
                return { lastBannedPlayer: item };
              }
            }
          }
        }

        return { lastBannedPlayer: null };
      } catch (err) {
        return { lastBannedPlayer: null };
      }
    },
    
    'remove-player': (_e, listName, serverPath, entry) => {
      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          throw new Error('Invalid server path');
        }
        
        if (!listName || typeof listName !== 'string') {
          throw new Error('Invalid list name');
        }
        
        if (!entry || typeof entry !== 'string' || entry.trim() === '') {
          throw new Error('Invalid player entry');
        }
        
        let filename = listName;
        if (listName === 'banned-players' || listName === 'banned') filename = 'banned-players';
        else if (listName === 'banned-ips' || listName === 'ips') filename = 'banned-ips';
        else if (!['ops', 'whitelist', 'banned-players', 'banned-ips'].includes(filename)) {
          throw new Error(`Unsupported list type: ${listName}`);
        }
        
        const file = path.join(serverPath, `${filename}.json`);
        if (!fs.existsSync(file)) return [];
        
        let rawList;
        try {
          rawList = JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (parseErr) {
          return [];
        }
        
        // Ensure list is an array
        if (!Array.isArray(rawList)) {
          return [];
        }
        
        // Filter out entry matching strings or object fields
        const newList = rawList.filter(item => {
          if (item && typeof item === 'object') {
            if ('name' in item) return item.name !== entry;
            if ('ip' in item) return item.ip !== entry;
          }
          return item !== entry;
        });
        
        fs.writeFileSync(file, JSON.stringify(newList, null, 2));
        return newList;
      } catch (err) {
        throw err;
      }
    }
  };
}

module.exports = { createPlayerHandlers, initializePlayerIpMap };
