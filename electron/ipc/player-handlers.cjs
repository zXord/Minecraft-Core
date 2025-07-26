// Player management IPC handlers
const path = require('path');
const fs = require('fs');
const { getLoggerHandlers } = require('./logger-handlers.cjs');

// Keep track of player names associated with IPs
const playerIpMap = new Map();

// Initialize logger
const logger = getLoggerHandlers();

/**
 * Initialize the player-IP map from the persistent file
 * @param {string} serverPath Path to the server directory
 */
function initializePlayerIpMap(serverPath) {
  logger.debug('Initializing player-IP map', {
    category: 'core',
    data: {
      handler: 'initializePlayerIpMap',
      serverPath: serverPath || 'undefined',
      serverPathExists: serverPath ? fs.existsSync(serverPath) : false
    }
  });

  if (!serverPath || !fs.existsSync(serverPath)) {
    logger.warn('Cannot initialize player-IP map: invalid server path', {
      category: 'core',
      data: {
        handler: 'initializePlayerIpMap',
        serverPath: serverPath || 'undefined',
        reason: !serverPath ? 'no_path' : 'path_not_exists'
      }
    });
    return;
  }
  
  const playerMapFile = path.join(serverPath, 'player-ip-map.json');
  
  try {
    if (fs.existsSync(playerMapFile)) {
      const mapData = JSON.parse(fs.readFileSync(playerMapFile, 'utf-8'));
      const entryCount = Object.keys(mapData).length;

      // Populate the in-memory map
      Object.entries(mapData).forEach(([ip, playerName]) => {
        playerIpMap.set(ip, playerName);
      });

      logger.info('Player-IP map initialized successfully', {
        category: 'core',
        data: {
          handler: 'initializePlayerIpMap',
          serverPath,
          entryCount,
          mapSize: playerIpMap.size
        }
      });
    } else {
      logger.debug('Player-IP map file does not exist, starting with empty map', {
        category: 'core',
        data: {
          handler: 'initializePlayerIpMap',
          serverPath,
          playerMapFile
        }
      });
    }
  } catch (error) {
    logger.error(`Failed to initialize player-IP map: ${error.message}`, {
      category: 'core',
      data: {
        handler: 'initializePlayerIpMap',
        serverPath,
        playerMapFile,
        errorType: error.constructor.name,
        stack: error.stack
      }
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
        logger.info('Reading player list', {
          category: 'core',
          data: {
            handler: 'read-players',
            listName,
            serverPath: serverPath || 'undefined',
            serverPathExists: serverPath ? fs.existsSync(serverPath) : false
          }
        });

        if (!serverPath || !fs.existsSync(serverPath)) {
          logger.error('Failed to read players: invalid server path', {
            category: 'core',
            data: {
              handler: 'read-players',
              listName,
              serverPath: serverPath || 'undefined',
              reason: !serverPath ? 'no_path' : 'path_not_exists'
            }
          });
          throw new Error('Invalid server path');
        }
        
        if (!listName || typeof listName !== 'string') {
          logger.error('Failed to read players: invalid list name', {
            category: 'core',
            data: {
              handler: 'read-players',
              listName: listName || 'undefined',
              listNameType: typeof listName,
              serverPath
            }
          });
          throw new Error('Invalid list name');
        }
        
        let filename = listName;
        if (listName === 'banned-players' || listName === 'banned') filename = 'banned-players';
        else if (listName === 'banned-ips' || listName === 'ips') filename = 'banned-ips';
        else if (!['ops', 'whitelist'].includes(filename)) {
          logger.error('Failed to read players: unsupported list type', {
            category: 'core',
            data: {
              handler: 'read-players',
              listName,
              filename,
              serverPath,
              supportedTypes: ['ops', 'whitelist', 'banned-players', 'banned-ips']
            }
          });
          throw new Error(`Unsupported list type: ${listName}`);
        }
        
        const file = path.join(serverPath, `${filename}.json`);
        
        logger.debug('Checking player list file', {
          category: 'storage',
          data: {
            handler: 'read-players',
            listName,
            filename,
            file,
            fileExists: fs.existsSync(file)
          }
        });

        if (!fs.existsSync(file)) {
          logger.info('Player list file does not exist, returning empty list', {
            category: 'storage',
            data: {
              handler: 'read-players',
              listName,
              filename,
              file
            }
          });
          return [];
        }
        
        try {
          const rawData = fs.readFileSync(file, 'utf-8');
          const data = JSON.parse(rawData);
          
          logger.debug('Successfully read player list file', {
            category: 'storage',
            data: {
              handler: 'read-players',
              listName,
              filename,
              file,
              dataLength: Array.isArray(data) ? data.length : 'not_array',
              fileSize: rawData.length
            }
          });
          
          // Special handling for banned IPs to ensure player names are properly read
          if (filename === 'banned-ips') {
            logger.debug('Processing banned IPs with special handling', {
              category: 'core',
              data: {
                handler: 'read-players',
                listName,
                dataCount: Array.isArray(data) ? data.length : 0,
                playerIpMapSize: playerIpMap.size
              }
            });

            // Initialize the player-IP map when reading banned IPs
            initializePlayerIpMap(serverPath);
            
            // Get the most recently used player name from the playerIpMap if available
            let lastUsedPlayerName = null;
            if (playerIpMap.size > 0) {
              for (const [, playerName] of playerIpMap) {
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
                  const [, ip, playerName] = matches;
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
            
            logger.info('Successfully processed banned IPs list', {
              category: 'core',
              data: {
                handler: 'read-players',
                listName,
                originalCount: Array.isArray(data) ? data.length : 0,
                processedCount: processedData.length,
                playerIpMapSize: playerIpMap.size
              }
            });
            
            return processedData;
          }
          
          return data;
        } catch {
          return [];
        }
    },
    
    'write-file': (_e, filePath, content) => {
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
    },
    
    'add-player': (_e, listName, serverPath, entry) => {
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
          } catch {
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
          let mapData = {};
          if (fs.existsSync(playerMapFile)) {
            mapData = JSON.parse(fs.readFileSync(playerMapFile, 'utf-8'));
          }
          mapData[entry] = playerName;
          fs.writeFileSync(playerMapFile, JSON.stringify(mapData, null, 2));
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
    },
    
    'add-player-with-details': (_e, listName, serverPath, detailsObj) => {
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
          } catch {
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
        } catch {
          return { lastBannedPlayer: null };
        }
    },
    
    'remove-player': (_e, listName, serverPath, entry) => {
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
        } catch {
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
    }
  };
}

module.exports = { createPlayerHandlers, initializePlayerIpMap };
