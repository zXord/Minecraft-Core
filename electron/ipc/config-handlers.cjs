// Config IPC handlers
const fs = require('fs');
const path = require('path');

/**
 * Create config IPC handlers
 * 
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createConfigHandlers() {
  return {
    'read-config': async (_e, serverPath) => {
      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          throw new Error('Invalid server path');
        }
        
        const configPath = path.join(serverPath, '.minecraft-core.json');
        
        if (!fs.existsSync(configPath)) {
          return null; // No config file exists yet
        }
        
        const configContent = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(configContent);
      } catch (err) {
        throw err;
      }
    },
    
    'write-config': async (_e, { serverPath, config }) => {
      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          throw new Error('Invalid server path');
        }
        
        if (!config || typeof config !== 'object') {
          throw new Error('Invalid configuration data');
        }
        
        const configPath = path.join(serverPath, '.minecraft-core.json');
        
        // Write the config file
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    'update-config': async (_e, { serverPath, updates }) => {
      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          throw new Error('Invalid server path');
        }
        
        if (!updates || typeof updates !== 'object') {
          throw new Error('Invalid update data');
        }
        
        const configPath = path.join(serverPath, '.minecraft-core.json');
        let config = {};
          // Read existing config if it exists
        if (fs.existsSync(configPath)) {
          try {
            const content = fs.readFileSync(configPath, 'utf-8');
            config = JSON.parse(content);
          } catch {
            // Continue with empty config
          }
        }
        
        // Update with new values
        const updatedConfig = { ...config, ...updates };
        
        // Write back to file
        fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
        
        return { success: true, config: updatedConfig };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  };
}

// Export the function directly
module.exports = { createConfigHandlers }; 
