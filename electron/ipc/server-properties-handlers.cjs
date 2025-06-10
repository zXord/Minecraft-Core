// Server Properties IPC handlers
const path = require('path');
const fs = require('fs');

/**
 * Create server properties IPC handlers
 */
function createServerPropertiesHandlers() {
  return {
    'read-server-properties': async (_e, serverPath) => {
      try {
        if (!serverPath) {
          return { success: false, error: 'Server path is required' };
        }
        
        const propertiesFilePath = path.join(serverPath, 'server.properties');
        const backupFilePath = path.join(serverPath, 'server.properties.default');
        
        // Check if file exists
        if (!fs.existsSync(propertiesFilePath)) {
          return { 
            success: false, 
            error: 'server.properties file not found. Run the server for the first time to generate this file.',
            filePath: propertiesFilePath 
          };
        }
        
        // Create default backup if not present
        if (!fs.existsSync(backupFilePath)) {
          fs.copyFileSync(propertiesFilePath, backupFilePath);
        }
        
        // Read and parse the file
        const fileContent = fs.readFileSync(propertiesFilePath, 'utf-8');
        const properties = parsePropertiesFile(fileContent);
        
        return { success: true, properties };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    'write-server-properties': async (_e, { serverPath, properties }) => {
      try {
        if (!serverPath) {
          return { success: false, error: 'Server path is required' };
        }
        
        if (!properties || typeof properties !== 'object') {
          return { success: false, error: 'Invalid properties object' };
        }
        
        const propertiesFilePath = path.join(serverPath, 'server.properties');
        
        // Make a backup of the original file
        if (fs.existsSync(propertiesFilePath)) {
          const backupPath = `${propertiesFilePath}.bak`;
          fs.copyFileSync(propertiesFilePath, backupPath);
        }
        
        // Convert properties object to file format
        const fileContent = serializePropertiesFile(properties);
        
        // Write to file
        fs.writeFileSync(propertiesFilePath, fileContent, 'utf-8');
        
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    'generate-server-properties': async (_e, serverPath) => {
      try {
        if (!serverPath) {
          return { success: false, error: 'Server path is required' };
        }
        
        const propertiesFilePath = path.join(serverPath, 'server.properties');
        
        // If file already exists, make a backup
        if (fs.existsSync(propertiesFilePath)) {
          const backupPath = `${propertiesFilePath}.bak`;
          fs.copyFileSync(propertiesFilePath, backupPath);
        }
        
        // Create default properties
        const defaultProperties = getDefaultProperties();
        
        // Convert to file format and write
        const fileContent = serializePropertiesFile(defaultProperties);
        fs.writeFileSync(propertiesFilePath, fileContent, 'utf-8');
        
        return { success: true, properties: defaultProperties };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    'restore-backup-properties': async (_e, serverPath) => {
      try {
        if (!serverPath) {
          return { success: false, error: 'Server path is required' };
        }
        const propertiesFilePath = path.join(serverPath, 'server.properties');
        const backupFilePath = path.join(serverPath, 'server.properties.default');
        // Check if backup exists
        if (!fs.existsSync(backupFilePath)) {
          return { success: false, error: 'No default backup file found. Run the server first.' };
        }
        // Restore backup
        fs.copyFileSync(backupFilePath, propertiesFilePath);
        // Read restored file
        const fileContent = fs.readFileSync(propertiesFilePath, 'utf-8');
        const properties = parsePropertiesFile(fileContent);
        return { success: true, properties };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  };
}

/**
 * Parse a server.properties file content into a key-value object
 * 
 * @param {string} fileContent - The content of the server.properties file
 * @returns {Object} The parsed properties as key-value pairs
 */
function parsePropertiesFile(fileContent) {
  const properties = {};
  
  // Split by lines and process each line
  const lines = fileContent.split(/\r?\n/);
  
  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }
    
    // Split by the first equals sign
    const eqIndex = line.indexOf('=');
    if (eqIndex !== -1) {
      const key = line.substring(0, eqIndex).trim();
      const value = line.substring(eqIndex + 1).trim();
      
      // Store in the properties object
      properties[key] = value;
    }
  }
  
  return properties;
}

/**
 * Serialize a properties object into server.properties file format
 * 
 * @param {Object} properties - Key-value pairs of server properties
 * @returns {string} Formatted server.properties file content
 */
function serializePropertiesFile(properties) {
  // Start with a header comment
  let fileContent = `#Minecraft server properties\n#${new Date().toString()}\n`;
  
  // Add each property
  for (const [key, value] of Object.entries(properties)) {
    fileContent += `${key}=${value}\n`;
  }
  
  return fileContent;
}

/**
 * Get default Minecraft server properties
 * 
 * @returns {Object} Default server properties
 */
function getDefaultProperties() {
  return {
    'spawn-protection': '16',
    'max-tick-time': '60000',
    'query.port': '25565',
    'generator-settings': '',
    'sync-chunk-writes': 'true',
    'force-gamemode': 'false',
    'allow-nether': 'true',
    'enforce-whitelist': 'false',
    'gamemode': 'survival',
    'broadcast-console-to-ops': 'true',
    'enable-query': 'false',
    'player-idle-timeout': '0',
    'difficulty': 'easy',
    'spawn-monsters': 'true',
    'broadcast-rcon-to-ops': 'true',
    'op-permission-level': '4',
    'pvp': 'true',
    'entity-broadcast-range-percentage': '100',
    'snooper-enabled': 'true',
    'level-type': 'default',
    'hardcore': 'false',
    'enable-status': 'true',
    'enable-command-block': 'false',
    'max-players': '20',
    'network-compression-threshold': '256',
    'resource-pack-sha1': '',
    'max-world-size': '29999984',
    'function-permission-level': '2',
    'rcon.port': '25575',
    'server-port': '25565',
    'server-ip': '',
    'spawn-npcs': 'true',
    'allow-flight': 'false',
    'level-name': 'world',
    'view-distance': '10',
    'resource-pack': '',
    'spawn-animals': 'true',
    'white-list': 'false',
    'rcon.password': '',
    'generate-structures': 'true',
    'max-build-height': '256',
    'online-mode': 'true',
    'level-seed': '',
    'use-native-transport': 'true',
    'prevent-proxy-connections': 'false',
    'enable-jmx-monitoring': 'false',
    'enable-rcon': 'false',
    'rate-limit': '0',
    'motd': 'A Minecraft Server'
  };
}

module.exports = { createServerPropertiesHandlers }; 
