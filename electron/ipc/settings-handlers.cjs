// Settings IPC handlers
const appStore = require('../utils/app-store.cjs');
const { ensureServersDat } = require('../utils/servers-dat.cjs');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { rm } = require('fs/promises');

/**
 * Create settings IPC handlers
 */
function createSettingsHandlers() {
  return {
    'update-settings': async (_e, { port, maxRam, managementPort, serverPath, autoStartMinecraft, autoStartManagement }) => {
      try {
        // Validate parameters
        if (port !== undefined && (typeof port !== 'number' || port < 1 || port > 65535)) {
          return { success: false, error: 'Invalid port number' };
        }
        
        if (maxRam !== undefined && (typeof maxRam !== 'number' || maxRam <= 0)) {
          return { success: false, error: 'Invalid memory allocation' };
        }
        
        if (managementPort !== undefined && (typeof managementPort !== 'number' || managementPort < 1025 || managementPort > 65535)) {
          return { success: false, error: 'Invalid management port number' };
        }
        
        // Get current settings to merge with updates
        const currentSettings = appStore.get('serverSettings') || { 
          port: 25565, 
          maxRam: 4, 
          managementPort: 8080,
          autoStartMinecraft: false, 
          autoStartManagement: false 
        };
        
        // Update settings with new values
        const updatedSettings = {
          ...currentSettings,
          port: port !== undefined ? port : currentSettings.port,
          maxRam: maxRam !== undefined ? maxRam : currentSettings.maxRam,
          managementPort: managementPort !== undefined ? managementPort : currentSettings.managementPort,
          autoStartMinecraft: autoStartMinecraft !== undefined ? autoStartMinecraft : currentSettings.autoStartMinecraft,
          autoStartManagement: autoStartManagement !== undefined ? autoStartManagement : currentSettings.autoStartManagement
        };
        
        // Save to persistent store
        appStore.set('serverSettings', updatedSettings);
        
        // If serverPath is provided, update the lastServerPath
        if (serverPath && typeof serverPath === 'string' && serverPath.trim() !== '') {
          appStore.set('lastServerPath', serverPath);
        }
        
        // Also update the server's config file if we have a path
        const usePath = serverPath || appStore.get('lastServerPath');
        if (usePath) {
          const configPath = path.join(usePath, '.minecraft-core.json');
          let config = { port: updatedSettings.port, maxRam: updatedSettings.maxRam };

          if (fs.existsSync(configPath)) {
            try {
              const fileContent = fs.readFileSync(configPath, 'utf-8');
              config = JSON.parse(fileContent);
            } catch {
              config = { port: updatedSettings.port, maxRam: updatedSettings.maxRam };
            }
          }

          config.port = updatedSettings.port;
          config.maxRam = updatedSettings.maxRam;

          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
        
        return { 
          success: true, 
          settings: {
            ...updatedSettings,
            serverPath: serverPath || appStore.get('lastServerPath')
          }
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    'get-settings': async () => {
      try {
        const settings = appStore.get('serverSettings') || { 
          port: 25565, 
          maxRam: 4, 
          managementPort: 8080,
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
        return { success: false, error: err.message };
      }
    },
    
    'save-instances': async (_e, instances) => {
      try {
        if (!Array.isArray(instances)) {
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
            return { success: false, error };
          }
          
          return { success: true, instances: savedInstances };
          
        } catch (err) {
          return { 
            success: false, 
            error: `Failed to save instances: ${err.message}` 
          };
        }
      } catch (err) {
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
      } catch {
        return [];
      }
    },
    
    // Rename instance
    'rename-instance': async (_e, { id, newName }) => {
      try {
        
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
        
        return { success: true, instances };
      } catch (err) {
        return { success: false, error: err.message };
      }    },
    
    // Delete instance (with optional dir deletion)
    'delete-instance': async (_e, { id, deleteFiles }) => {
      try {
        
        if (!id) {
          return { success: false, error: 'Invalid instance ID' };
        }
        
        const instances = appStore.get('instances') || [];
        const inst = instances.find(i => i.id === id);
        
        if (!inst) {
          return { success: false, error: 'Instance not found' };
        }
        
        // CRITICAL: Stop file watchers for server instances before deletion
        if (inst.type === 'server' && inst.path) {
          try {
            // Stop management server watchers if they're watching this path
            const { getManagementServer } = require('../services/management-server.cjs');
            const managementServer = getManagementServer();
            const status = managementServer.getStatus();
            
            if (status.isRunning && status.serverPath === inst.path) {
              // If management server is watching this path, stop the watcher
              managementServer.stopVersionWatcher();
              
              // Update server path to null to prevent further file system operations
              managementServer.updateServerPath(null);
            }
          } catch (err) {
            // Log but don't fail - continue with deletion
            console.warn('Failed to cleanup management server watchers:', err.message);
          }
          
          // Also stop any server processes that might be using this directory
          try {
            const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
            const serverProcess = getServerProcess();
            if (serverProcess) {
              killMinecraftServer();
              // Wait a bit for process cleanup
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (err) {
            console.warn('Failed to cleanup server process:', err.message);
          }
        }
        
        const remaining = instances.filter(i => i.id !== id);
        appStore.set('instances', remaining);
        
        // also clear lastServerPath if it was the deleted one
        if (inst.path && appStore.get('lastServerPath') === inst.path) {
          appStore.set('lastServerPath', null);
        }
        
        // optionally delete directory
        if (deleteFiles && inst.path) {
          try {
            await rm(inst.path, { recursive: true, force: true });
          } catch (err) {
            return { 
              success: true, 
              instances: remaining,
              warning: `Instance removed but could not delete server files: ${err.message}`
            };
          }
        }
        
        return { success: true, instances: remaining };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    // Save client configuration
    'save-client-config': async (_e, { path: clientPath, serverIp, serverPort, clientId, clientName }) => {
      try {
        
        if (!clientPath || typeof clientPath !== 'string' || clientPath.trim() === '') {
          return { success: false, error: 'Invalid client path' };
        }
        
        if (!serverIp || typeof serverIp !== 'string' || serverIp.trim() === '') {
          return { success: false, error: 'Invalid server IP address' };
        }
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(clientPath)) {
          fs.mkdirSync(clientPath, { recursive: true });
        }

        // Save client configuration to a JSON file
        const configFile = path.join(clientPath, 'client-config.json');
        const config = {
          serverIp,
          serverPort: serverPort || '8080', // Default to management server port
          clientId: clientId || `client-${Date.now()}`,
          clientName: clientName || 'Unnamed Client',
          lastConnected: new Date().toISOString()
        };
        
        await fsPromises.writeFile(configFile, JSON.stringify(config, null, 2));

        // Create servers.dat so the server appears in multiplayer list (only if not already initialized)
        const serversInitializedFile = path.join(clientPath, '.servers-initialized');
        if (!fs.existsSync(serversInitializedFile)) {
        await ensureServersDat(clientPath, serverIp, config.serverPort, config.clientName);
          
          // Create flag file to indicate servers.dat has been initialized
          fs.writeFileSync(serversInitializedFile, JSON.stringify({
            initializedAt: new Date().toISOString(),
            serverIp,
            serverPort: config.serverPort,
            clientName: config.clientName
          }), 'utf8');
        }
        
        // ALSO update the instance in the app store so it persists across app restarts
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
          }
          

        appStore.set('instances', instances);

        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  };
}

module.exports = { createSettingsHandlers };
