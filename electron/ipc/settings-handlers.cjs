// Settings IPC handlers
const fs = require('fs');
const path = require('path');
const { rm } = require('fs/promises');
const fetch = require('node-fetch');
const nbt = require('prismarine-nbt');
const zlib = require('zlib');
const appStore = require('../utils/app-store.cjs');

async function createServersDat(clientDir, serverIp, managementPort, serverName = 'Minecraft Server') {
  try {
    let minecraftPort = 25565;
    try {
      const infoRes = await fetch(`http://${serverIp}:${managementPort}/api/server/info`, { timeout: 5000 });
      if (infoRes.ok) {
        const info = await infoRes.json();
        if (info.minecraftPort) {
          const portNum = parseInt(info.minecraftPort, 10);
          if (!Number.isNaN(portNum)) minecraftPort = portNum;
        }
      }
    } catch (e) {
      console.warn('[Settings] Could not retrieve server port for servers.dat:', e.message);
    }

    if (!fs.existsSync(clientDir)) {
      fs.mkdirSync(clientDir, { recursive: true });
    }

    const serverAddress = minecraftPort === 25565 ? serverIp : `${serverIp}:${minecraftPort}`;

    const optionsFile = path.join(clientDir, 'options.txt');
    let optionsContent = '';
    if (fs.existsSync(optionsFile)) {
      optionsContent = fs.readFileSync(optionsFile, 'utf8');
    }
    const lines = optionsContent.split('\n').filter(l => !l.startsWith('lastServer:'));
    lines.push(`lastServer:${serverAddress}`);
    fs.writeFileSync(optionsFile, lines.join('\n'), 'utf8');

    const serversDatPath = path.join(clientDir, 'servers.dat');
    let existingServers = [];
    if (fs.existsSync(serversDatPath)) {
      try {
        const buf = fs.readFileSync(serversDatPath);
        const uncompressed = zlib.gunzipSync(buf);
        const parsed = await nbt.parse(uncompressed);
        const list = parsed.parsed.value.servers?.value || [];
        existingServers = list.map(entry => entry.value ? {
          name: entry.value.name.value,
          ip: entry.value.ip.value,
          icon: entry.value.icon.value,
          acceptTextures: entry.value.acceptTextures.value
        } : entry);
        existingServers = existingServers.filter(s => s.ip !== serverAddress);
      } catch (err) {
        console.warn('[Settings] Could not parse existing servers.dat:', err.message);
        existingServers = [];
      }
    }

    existingServers.push({
      name: serverName,
      ip: serverAddress,
      icon: '',
      acceptTextures: 1
    });

    const nbtData = {
      type: 'compound',
      name: '',
      value: {
        servers: {
          type: 'list',
          listType: 'compound',
          value: existingServers.map(s => ({
            name: { type: 'string', value: s.name },
            ip: { type: 'string', value: s.ip },
            icon: { type: 'string', value: s.icon },
            acceptTextures: { type: 'int', value: s.acceptTextures }
          }))
        }
      }
    };

    const raw = nbt.writeUncompressed(nbtData, '');
    const compressed = zlib.gzipSync(raw);
    fs.writeFileSync(serversDatPath, compressed);
    return { success: true };
  } catch (err) {
    console.error('[Settings] Failed to create servers.dat:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Create settings IPC handlers
 * 
 * @param {BrowserWindow} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createSettingsHandlers(win) {
  return {
    'update-settings': async (_e, { port, maxRam, serverPath, autoStartMinecraft, autoStartManagement }) => {
      try {
        // Validate parameters
        if (port !== undefined && (typeof port !== 'number' || port < 1 || port > 65535)) {
          return { success: false, error: 'Invalid port number' };
        }
        
        if (maxRam !== undefined && (typeof maxRam !== 'number' || maxRam <= 0)) {
          return { success: false, error: 'Invalid memory allocation' };
        }
        
        // Get current settings to merge with updates
        const currentSettings = appStore.get('serverSettings') || { 
          port: 25565, 
          maxRam: 4, 
          autoStartMinecraft: false, 
          autoStartManagement: false 
        };
        
        // Update settings with new values
        const updatedSettings = {
          ...currentSettings,
          port: port !== undefined ? port : currentSettings.port,
          maxRam: maxRam !== undefined ? maxRam : currentSettings.maxRam,
          autoStartMinecraft: autoStartMinecraft !== undefined ? autoStartMinecraft : currentSettings.autoStartMinecraft,
          autoStartManagement: autoStartManagement !== undefined ? autoStartManagement : currentSettings.autoStartManagement
        };
        
        // Save to persistent store
        appStore.set('serverSettings', updatedSettings);
        
        // If serverPath is provided, update the lastServerPath
        if (serverPath && typeof serverPath === 'string' && serverPath.trim() !== '') {
          console.log('Saving last server path:', serverPath);
          appStore.set('lastServerPath', serverPath);
        }
        
        // Also update the server's config file if we have a path
        const usePath = serverPath || appStore.get('lastServerPath');
        if (usePath) {
          try {
            const configPath = path.join(usePath, '.minecraft-core.json');
            let config = {};
            
            if (fs.existsSync(configPath)) {
              try {
                const fileContent = fs.readFileSync(configPath, 'utf-8');
                config = JSON.parse(fileContent);
              } catch (parseErr) {
                console.error('Error parsing config file:', parseErr);
                // Continue with empty config
              }
            }
            
            // Update port and maxRam in config
            config.port = updatedSettings.port;
            config.maxRam = updatedSettings.maxRam;
            
            // Write back to file
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          } catch (configErr) {
            console.error('Error updating server config file:', configErr);
            // Continue even if config file update fails
          }
        }
        
        return { 
          success: true, 
          settings: {
            ...updatedSettings,
            serverPath: serverPath || appStore.get('lastServerPath')
          }
        };
      } catch (err) {
        console.error('Error updating settings:', err);
        return { success: false, error: err.message };
      }
    },
    
    'get-settings': async () => {
      try {
        const settings = appStore.get('serverSettings') || { 
          port: 25565, 
          maxRam: 4, 
          autoStartMinecraft: false, 
          autoStartManagement: false 
        };
        const serverPath = appStore.get('lastServerPath');
        
        return {
          success: true,
          settings: {
            ...settings,
            serverPath
          }
        };
      } catch (err) {
        console.error('Error getting settings:', err);
        return { success: false, error: err.message };
      }
    },
    
    'save-instances': async (_e, instances) => {
      try {
        if (!Array.isArray(instances)) {
          console.error('Invalid instances data received (not an array):', instances);
          return { success: false, error: 'Invalid instances data: not an array' };
        }
        
        // Filter out invalid instances and ensure required fields
        const validInstances = instances
          .filter(instance => {
            if (!instance || typeof instance !== 'object') {
              return false;
            }
            if (!instance.id || !instance.type) {
              return false;
            }
            if (instance.type === 'server' && !instance.path) {
              return false;
            }
            return true;
          })
          .map(instance => {
            const validInstance = {
              id: instance.id || `instance-${Date.now()}`,
              name: instance.name || `Instance ${Date.now()}`,
              type: instance.type || 'server'
            };
            
            // Include type-specific fields
            if (instance.type === 'server') {
              if (instance.path) {
                validInstance.path = instance.path;
              }
            } else if (instance.type === 'client') {
              // Include client-specific fields
              if (instance.path) validInstance.path = instance.path;
              if (instance.serverIp) validInstance.serverIp = instance.serverIp;
              if (instance.serverPort) validInstance.serverPort = instance.serverPort;
              if (instance.clientId) validInstance.clientId = instance.clientId;
              if (instance.clientName) validInstance.clientName = instance.clientName;
              if (instance.lastConnected) validInstance.lastConnected = instance.lastConnected;
            }
            
            return validInstance;
          });
        
        if (validInstances.length === 0 && instances.length > 0) {
          const error = 'All instances were filtered out due to invalid data';
          console.error(error);
          return { success: false, error };
        }
        
        try {
          // Save instances to the store
          appStore.set('instances', validInstances);
          
          // Update lastServerPath if there's a server instance
          const serverInstance = validInstances.find(i => i.type === 'server' && i.path);
          if (serverInstance && serverInstance.path) {
            appStore.set('lastServerPath', serverInstance.path);
          }
          
          // Force a write to disk
          appStore.set('__last_updated__', Date.now());
          
          // Verify the save
          const savedInstances = appStore.get('instances') || [];
          
          if (!Array.isArray(savedInstances)) {
            const error = 'Saved instances is not an array';
            console.error(error, savedInstances);
            return { success: false, error };
          }
          
          return { success: true, instances: savedInstances };
          
        } catch (err) {
          console.error('Error saving instances:', err);
          return { 
            success: false, 
            error: `Failed to save instances: ${err.message}` 
          };
        }
      } catch (err) {
        console.error('Error saving instances:', err);
        return { success: false, error: err.message };
      }
    },
    
    'get-instances': async () => {
      try {
        const instances = appStore.get('instances') || [];
        const validInstances = instances.filter(instance => 
          instance && 
          typeof instance === 'object' && 
          instance.id && 
          instance.name && 
          instance.type
        );
        
        return validInstances;
      } catch (error) {
        console.error('Error getting instances:', error);
        return [];
      }
    },
    
    // Rename instance
    'rename-instance': async (_e, { id, newName }) => {
      try {
        console.log(`Renaming instance ${id} to ${newName}`);
        
        if (!id || typeof newName !== 'string' || newName.trim() === '') {
          return { success: false, error: 'Invalid parameters' };
        }
        
        const instances = appStore.get('instances') || [];
        const idx = instances.findIndex(i => i.id === id);
        
        if (idx === -1) {
          return { success: false, error: 'Instance not found' };
        }
        
        instances[idx].name = newName;
        appStore.set('instances', instances);
        
        console.log('Instance renamed successfully');
        return { success: true, instances };
      } catch (err) {
        console.error('Error renaming instance:', err);
        return { success: false, error: err.message };
      }
    },
    
    // Delete instance (with optional dir deletion)
    'delete-instance': async (_e, { id, deleteFiles }) => {
      try {
        console.log(`Deleting instance ${id} (deleteFiles: ${deleteFiles})`);
        
        if (!id) {
          return { success: false, error: 'Invalid instance ID' };
        }
        
        const instances = appStore.get('instances') || [];
        const inst = instances.find(i => i.id === id);
        
        if (!inst) {
          return { success: false, error: 'Instance not found' };
        }
        
        const remaining = instances.filter(i => i.id !== id);
        appStore.set('instances', remaining);
        
        // also clear lastServerPath if it was the deleted one
        if (inst.path && appStore.get('lastServerPath') === inst.path) {
          console.log('Clearing lastServerPath as it matched deleted instance');
          appStore.set('lastServerPath', null);
        }
        
        // optionally delete directory
        if (deleteFiles && inst.path) {
          try {
            console.log(`Deleting server directory: ${inst.path}`);
            await rm(inst.path, { recursive: true, force: true });
            console.log('Server directory deleted successfully');
          } catch (err) {
            console.error('Failed to delete folder:', err);
            return { 
              success: true, 
              instances: remaining,
              warning: `Instance removed but could not delete server files: ${err.message}`
            };
          }
        }
        
        return { success: true, instances: remaining };
      } catch (err) {
        console.error('Error deleting instance:', err);
        return { success: false, error: err.message };
      }
    },
    
    // Save client configuration
    'save-client-config': async (_e, { path: clientPath, serverIp, serverPort, clientId, clientName }) => {
      try {
        console.log(`Saving client configuration for path: ${clientPath}, server: ${serverIp}:${serverPort}`);
        
        if (!clientPath || typeof clientPath !== 'string' || clientPath.trim() === '') {
          return { success: false, error: 'Invalid client path' };
        }
        
        if (!serverIp || typeof serverIp !== 'string' || serverIp.trim() === '') {
          return { success: false, error: 'Invalid server IP address' };
        }
        
        const fs = require('fs');
        const fsPromises = require('fs/promises');
        const path_module = require('path');
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(clientPath)) {
          console.log(`Creating client directory: ${clientPath}`);
          fs.mkdirSync(clientPath, { recursive: true });
        }
        
        // Save client configuration to a JSON file
        const configFile = path_module.join(clientPath, 'client-config.json');
        const config = {
          serverIp,
          serverPort: serverPort || '8080', // Default to management server port
          clientId: clientId || `client-${Date.now()}`,
          clientName: clientName || 'Unnamed Client',
          lastConnected: new Date().toISOString()
        };
        
        await fsPromises.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log('Client configuration saved to file successfully');

        // Create servers.dat so the server appears in multiplayer list
        const datResult = await createServersDat(clientPath, serverIp, config.serverPort, config.clientName);

        if (!datResult.success) {
          console.warn('Failed to create servers.dat:', datResult.error);
        } else {
          console.log('servers.dat created or updated successfully');
        }
        
        // ALSO update the instance in the app store so it persists across app restarts
        try {
          const instances = appStore.get('instances') || [];
          
          // Find the client instance by path
          const clientInstanceIndex = instances.findIndex(inst => 
            inst.type === 'client' && inst.path === clientPath
          );
          
          if (clientInstanceIndex !== -1) {
            // Update existing client instance
            instances[clientInstanceIndex] = {
              ...instances[clientInstanceIndex],
              serverIp,
              serverPort: serverPort || '8080',
              clientId: config.clientId,
              clientName: config.clientName,
              path: clientPath,
              lastConnected: config.lastConnected
            };
            console.log('Updated existing client instance in app store');
          } else {
            // Create new client instance entry
            const newInstance = {
              id: config.clientId,
              name: config.clientName,
              type: 'client',
              path: clientPath,
              serverIp,
              serverPort: serverPort || '8080',
              clientId: config.clientId,
              clientName: config.clientName,
              lastConnected: config.lastConnected
            };
            instances.push(newInstance);
            console.log('Added new client instance to app store');
          }
          
          appStore.set('instances', instances);
          console.log('Client instance data saved to app store');
          
        } catch (storeError) {
          console.error('Error updating app store:', storeError);
          // Continue anyway since file save succeeded
        }
        
        return { success: true };
      } catch (err) {
        console.error('Error saving client configuration:', err);
        return { success: false, error: err.message };
      }
    }
  };
}

module.exports = { createSettingsHandlers };
