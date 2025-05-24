// Settings IPC handlers
const fs = require('fs');
const path = require('path');
const { rm } = require('fs/promises');
const appStore = require('../utils/app-store.cjs');

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
        
        console.log('Received instances to save:', JSON.stringify(instances, null, 2));
        
        // Filter out invalid instances and ensure required fields
        const validInstances = instances
          .filter(instance => {
            if (!instance || typeof instance !== 'object') {
              console.log('Instance is not an object:', instance);
              return false;
            }
            if (!instance.id || !instance.type) {
              console.log('Instance missing required fields (id or type):', instance);
              return false;
            }
            if (instance.type === 'server' && !instance.path) {
              console.log('Server instance missing path:', instance);
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
            
            console.log('Mapped instance:', JSON.stringify(validInstance, null, 2));
            return validInstance;
          });
        
        if (validInstances.length === 0 && instances.length > 0) {
          const error = 'All instances were filtered out due to invalid data';
          console.error(error);
          return { success: false, error };
        }
        
        console.log('Valid instances to save:', JSON.stringify(validInstances, null, 2));
        
        try {
          // Save instances to the store
          console.log('Saving instances to store...');
          appStore.set('instances', validInstances);
          
          // Update lastServerPath if there's a server instance
          const serverInstance = validInstances.find(i => i.type === 'server' && i.path);
          if (serverInstance && serverInstance.path) {
            console.log('Updating lastServerPath from instances:', serverInstance.path);
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
          
          console.log('Successfully saved instances:', JSON.stringify(savedInstances, null, 2));
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
      console.log('\n--- get-instances called ---');
      
      try {
        console.log('Getting instances from store...');
        
        // Get all store data for debugging
        const allStoreData = appStore.store;
        console.log('All store data:', JSON.stringify(allStoreData, null, 2));
        
        // Get instances with a fallback to empty array
        let instances = [];
        try {
          const instancesData = appStore.get('instances');
          console.log('Raw instances data from store:', JSON.stringify(instancesData, null, 2));
          
          // Handle case where instances is null/undefined
          if (instancesData === null || instancesData === undefined) {
            console.log('No instances found in store, returning empty array');
            return { success: true, instances: [] };
          }
          
          // Ensure instances is an array
          if (!Array.isArray(instancesData)) {
            console.error('Corrupted instances data in store (not an array):', instancesData);
            // Try to recover by resetting to empty array
            try {
              console.log('Attempting to fix corrupted instances data...');
              appStore.set('instances', []);
              console.log('Successfully reset instances to empty array');
            } catch (err) {
              console.error('Failed to fix corrupted instances data:', err);
            }
            return { success: true, instances: [] };
          }
          
          instances = instancesData;
          console.log(`Found ${instances.length} instances in store`);
          
        } catch (err) {
          console.error('Error reading instances from store:', err);
          // On error, return empty array
          return { success: true, instances: [] };
        }
        
        // Filter out any invalid instances
        const validInstances = instances
          .filter((instance, index) => {
            try {
              // Basic validation
              if (!instance || typeof instance !== 'object') {
                console.log(`Instance at index ${index} is not an object:`, instance);
                return false;
              }
              
              // Must have id and type
              if (!instance.id || !instance.type) {
                console.log(`Instance at index ${index} missing required fields (id or type):`, instance);
                return false;
              }
              
              // Server instances must have a non-empty path
              if (instance.type === 'server') {
                if (!instance.path || typeof instance.path !== 'string' || instance.path.trim() === '') {
                  console.log(`Server instance at index ${index} has invalid path:`, instance);
                  return false;
                }
              }
              
              return true;
              
            } catch (err) {
              console.error(`Error validating instance at index ${index}:`, instance, err);
              return false;
            }
          })
          .map((instance, index) => {
            let validInstance = {
              id: instance.id,
              name: instance.name || `Instance ${instance.id}`,
              type: instance.type
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
            
            console.log(`Mapped instance ${index + 1}/${instances.length}:`, JSON.stringify(validInstance, null, 2));
            return validInstance;
          });
        
        // If we filtered out any instances, update the store
        if (validInstances.length !== instances.length) {
          const invalidCount = instances.length - validInstances.length;
          console.log(`Filtered out ${invalidCount} invalid instances`);
          
          try {
            console.log('Updating store with valid instances...');
            appStore.set('instances', validInstances);
            console.log('Successfully updated store with valid instances');
          } catch (err) {
            console.error('Error updating store with valid instances:', err);
          }
        } else {
          console.log('All instances are valid');
        }
        
        console.log(`Returning ${validInstances.length} valid instances`);
        return { success: true, instances: validInstances };
      } catch (err) {
        console.error('Error getting instances:', err);
        return { success: false, error: err.message, instances: [] };
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
    'save-client-config': async (_e, { path, serverIp, serverPort, clientId, clientName }) => {
      try {
        console.log(`Saving client configuration for path: ${path}, server: ${serverIp}:${serverPort}`);
        
        if (!path || typeof path !== 'string' || path.trim() === '') {
          return { success: false, error: 'Invalid client path' };
        }
        
        if (!serverIp || typeof serverIp !== 'string' || serverIp.trim() === '') {
          return { success: false, error: 'Invalid server IP address' };
        }
        
        const fs = require('fs');
        const fsPromises = require('fs/promises');
        const path_module = require('path');
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(path)) {
          console.log(`Creating client directory: ${path}`);
          fs.mkdirSync(path, { recursive: true });
        }
        
        // Save client configuration to a JSON file
        const configFile = path_module.join(path, 'client-config.json');
        const config = {
          serverIp,
          serverPort: serverPort || '8080', // Default to management server port
          clientId: clientId || `client-${Date.now()}`,
          clientName: clientName || 'Unnamed Client',
          lastConnected: new Date().toISOString()
        };
        
        await fsPromises.writeFile(configFile, JSON.stringify(config, null, 2));
        console.log('Client configuration saved to file successfully');
        
        // ALSO update the instance in the app store so it persists across app restarts
        try {
          const instances = appStore.get('instances') || [];
          
          // Find the client instance by path
          const clientInstanceIndex = instances.findIndex(inst => 
            inst.type === 'client' && inst.path === path
          );
          
          if (clientInstanceIndex !== -1) {
            // Update existing client instance
            instances[clientInstanceIndex] = {
              ...instances[clientInstanceIndex],
              serverIp,
              serverPort: serverPort || '8080',
              clientId: config.clientId,
              clientName: config.clientName,
              path,
              lastConnected: config.lastConnected
            };
            console.log('Updated existing client instance in app store');
          } else {
            // Create new client instance entry
            const newInstance = {
              id: config.clientId,
              name: config.clientName,
              type: 'client',
              path,
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
