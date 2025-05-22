// Config file management utilities
const fs = require('fs');
const path = require('path');

/**
 * Ensures a .minecraft-core.json config file exists in the given server directory
 * 
 * @param {string} serverPath - Path to the server directory
 * @param {object} defaultSettings - Default settings to use if config doesn't exist
 * @returns {object} The current config (either existing or newly created)
 */
function ensureConfigFile(serverPath, defaultSettings = {}) {
  if (!serverPath) {
    console.error('Invalid server path provided');
    return null;
  }
  
  try {
    // Check if the directory exists
    if (!fs.existsSync(serverPath)) {
      console.error(`Server directory does not exist: ${serverPath}`);
      return null;
    }
    
    const configPath = path.join(serverPath, '.minecraft-core.json');
    let config = defaultSettings;
    
    // Try to read existing config
    if (fs.existsSync(configPath)) {
      try {
        const configData = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(configData);
      } catch (err) {
        console.error('Error reading config file:', err);
        // Will use the default settings if there's an error
      }
    }
    
    // Merge with defaults to ensure all fields exist
    config = {
      ...defaultSettings,
      ...config
    };
    
    // Write the config back to ensure all fields are present
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (err) {
      console.error('Error writing config file:', err);
    }
    
    return config;
  } catch (err) {
    console.error('Unexpected error in ensureConfigFile:', err);
    return null;
  }
}

module.exports = {
  ensureConfigFile
};
