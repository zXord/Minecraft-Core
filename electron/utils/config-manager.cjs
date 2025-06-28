// Config file management utilities
const fs = require('fs');
const path = require('path');

/**
 * Detects Minecraft version from server JAR files
 * @param {string} serverPath - Path to the server directory
 * @returns {string|null} Detected version or null if not found
 */
function detectMinecraftVersion(serverPath) {
  try {
    if (!fs.existsSync(serverPath)) {
      return null;
    }
    
    const files = fs.readdirSync(serverPath);
    const serverJars = files.filter(file =>
      file.endsWith('.jar') && (
        file.includes('server') ||
        file.includes('minecraft') ||
        file.includes('paper') || 
        file.includes('forge') || 
        file.includes('fabric') ||
        file === 'fabric-server-launch.jar'
      )
    );
    
    // Try to extract version from jar filenames
    for (const jarName of serverJars) {
      const versionMatch = jarName.match(/(\d+\.\d+(?:\.\d+)?)/);
      if (versionMatch) {
        return versionMatch[1];
      }
    }
    
    // Check for version.json file (vanilla servers)
    const versionPath = path.join(serverPath, 'version.json');
    if (fs.existsSync(versionPath)) {
      try {
        const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
        if (versionData.name || versionData.id) {
          return versionData.name || versionData.id;
        }
      } catch {
        // Continue with other methods
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensures a .minecraft-core.json config file exists in the given server directory
 * 
 * @param {string} serverPath - Path to the server directory
 * @param {object} defaultSettings - Default settings to use if config doesn't exist
 * @returns {object} The current config (either existing or newly created)
 */
function ensureConfigFile(serverPath, defaultSettings = {}) {
  if (!serverPath) {
    return null;
  }
  
  try {
    // Check if the directory exists
    if (!fs.existsSync(serverPath)) {
      return null;
    }
    
    const configPath = path.join(serverPath, '.minecraft-core.json');
    let config = defaultSettings;
      // Try to read existing config
    if (fs.existsSync(configPath)) {
      try {
        const configData = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(configData);
      } catch {
        // Will use the default settings if there's an error
      }
    }
    
    // Merge with defaults to ensure all fields exist
    config = {
      ...defaultSettings,
      ...config
    };
    
    // AUTO-DETECT version if not provided and not already in config
    if (!config.version) {
      const detectedVersion = detectMinecraftVersion(serverPath);
      if (detectedVersion) {
        config.version = detectedVersion;
        config.detectedAt = new Date().toISOString();
        config.detectionMethod = 'automatic';
      }
    }
    
    // Set managedBy field to identify our config files
    if (!config.managedBy) {
      config.managedBy = 'minecraft-core';
    }
      // Write the config back to ensure all fields are present
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch {
      // Ignore write errors - will return config anyway
    }
      return config;
  } catch {
    return null;
  }
}

module.exports = {
  ensureConfigFile,
  detectMinecraftVersion
};
