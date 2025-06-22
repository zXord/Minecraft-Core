// Config IPC handlers
const fs = require('fs');
const path = require('path');

/**
 * Create config IPC handlers
 * 
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createConfigHandlers() {
  return {    'read-config': async (_e, serverPath) => {
      if (!serverPath || !fs.existsSync(serverPath)) {
        throw new Error('Invalid server path');
      }
      
      const configPath = path.join(serverPath, '.minecraft-core.json');
      
      if (!fs.existsSync(configPath)) {
        return null; // No config file exists yet
      }
      
      const configContent = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(configContent);
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
        let previousConfig = {};
          // Read existing config if it exists
        if (fs.existsSync(configPath)) {
          try {
            const content = fs.readFileSync(configPath, 'utf-8');
            config = JSON.parse(content);
            previousConfig = { ...config }; // Store previous state for cleanup
          } catch {
            // Continue with empty config
          }
        }
        
        // Update with new values
        const updatedConfig = { ...config, ...updates };
        
        // Write back to file
        fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));

        // Perform server version cleanup if versions changed
        const versionChanged = updates.version && updates.version !== previousConfig.version;
        const fabricChanged = updates.fabric && updates.fabric !== previousConfig.fabric;
          if (versionChanged || fabricChanged) {
          console.log('🧹 Server version changed, cleaning up old server files...');
          await cleanupOldServerVersions(serverPath, previousConfig);
        }
        
        return { success: true, config: updatedConfig };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  };
}

/**
 * Clean up old server version files after a version update
 * @param {string} serverPath - Path to the server directory
 * @param {object} oldConfig - Previous configuration for comparison
 */
async function cleanupOldServerVersions(serverPath, oldConfig) {
  try {
    const filesToCleanup = [];
    
    // Files that typically contain version information and should be cleaned up
    const serverFiles = fs.readdirSync(serverPath);
    
    // Clean up old version-specific files
    for (const file of serverFiles) {
      const filePath = path.join(serverPath, file);
      const stat = fs.lstatSync(filePath);
      
      if (stat.isFile()) {
        // Clean up old server JARs with version numbers
        if (file.includes('minecraft_server') && file.endsWith('.jar')) {
          // Check if this file contains the old version
          if (oldConfig.version && file.includes(oldConfig.version)) {
            filesToCleanup.push({ file, reason: `Old Minecraft server JAR (${oldConfig.version})` });
          }
        }
        
        // Clean up old fabric installer versions
        if (file.includes('fabric-installer') && file.endsWith('.jar')) {
          // Check if this is an old fabric installer version
          if (oldConfig.fabric && file.includes(oldConfig.fabric)) {
            filesToCleanup.push({ file, reason: `Old Fabric installer (${oldConfig.fabric})` });
          }
        }
        
        // Clean up libraries directory if it exists (Fabric libraries)
        if (file === 'libraries' && stat.isDirectory()) {
          // Fabric creates version-specific library structures
          // We could clean this up but it's safer to leave it for manual cleanup
          console.log('📁 Note: Libraries directory detected - manual cleanup may be needed for old Fabric libraries');
        }
        
        // Clean up old server backups that might have version info
        if (file.startsWith('server_backup_') && (file.includes(oldConfig.version) || file.includes(oldConfig.fabric))) {
          filesToCleanup.push({ file, reason: `Old version backup` });
        }
      }
    }
    
    // Delete identified files
    let deletedCount = 0;
    for (const { file, reason } of filesToCleanup) {
      try {
        const filePath = path.join(serverPath, file);
        fs.unlinkSync(filePath);
        console.log(`✅ Deleted: ${file} (${reason})`);
        deletedCount++;
      } catch (error) {
        console.warn(`⚠️ Failed to delete ${file}: ${error.message}`);
      }
    }
      console.log(`🧹 Server cleanup completed: ${deletedCount} old version files deleted`);
    
  } catch (error) {
    console.error('❌ Error during server version cleanup:', error);
    // Don't throw - cleanup is not critical for functionality
  }
}

// Export the function directly
module.exports = { createConfigHandlers };
