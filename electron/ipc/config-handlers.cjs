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
        // Clean up old server JARs with various naming patterns
        if (file.endsWith('.jar')) {
          // Patterns: minecraft_server.1.21.1.jar, server.jar (but check dates), fabric-server-*.jar, etc.
          if (file.includes('minecraft_server') || file.includes('fabric-server') || file.includes('server-launch')) {
            // Check if this file contains the old version or is older than expected
            if (oldConfig.version && (file.includes(oldConfig.version) || file.includes(oldConfig.version.replace('.', '_')))) {
              filesToCleanup.push({ file, reason: `Old Minecraft server JAR (${oldConfig.version})` });
            }
          }
          
          // Clean up old fabric installer JARs
          if (file.includes('fabric-installer') || file.includes('fabric-loader')) {
            if (oldConfig.fabric && (file.includes(oldConfig.fabric) || file.includes(oldConfig.fabric.replace('.', '_')))) {
              filesToCleanup.push({ file, reason: `Old Fabric installer (${oldConfig.fabric})` });
            }
          }
        }
          // Clean up version-specific downloaded files
        if (file.startsWith('minecraft_server.') && file.endsWith('.jar')) {
          const versionMatch = file.match(/minecraft_server\.(.+)\.jar/);
          if (versionMatch && oldConfig.version && versionMatch[1] === oldConfig.version) {
            filesToCleanup.push({ file, reason: `Old Minecraft server JAR (${oldConfig.version})` });
          }
        }
        
        // Clean up server JAR files with version in name (various patterns)
        if (file.endsWith('.jar') && oldConfig.version) {
          // Pattern: server-1.21.3.jar, fabric-server-mc.1.21.3-loader.0.16.9-launcher.1.0.2.jar, etc.
          if (file.includes(oldConfig.version.replace(/\./g, '\\.')) || 
              file.includes(oldConfig.version.replace(/\./g, '-')) ||
              file.includes(`mc.${oldConfig.version}`) ||
              file.includes(`mc${oldConfig.version}`)) {
            filesToCleanup.push({ file, reason: `Old server JAR with version (${oldConfig.version})` });
          }
        }
        
        // Clean up Fabric launcher JARs
        if (file.includes('fabric-server-launch') && file.endsWith('.jar')) {
          filesToCleanup.push({ file, reason: `Old Fabric server launcher JAR` });
        }
        
        // Clean up old server backups that might have version info
        if (file.startsWith('server_backup_') && (file.includes(oldConfig.version) || file.includes(oldConfig.fabric))) {
          filesToCleanup.push({ file, reason: `Old version backup` });
        }
        
        // Clean up old logs that might be version-specific
        if (file.startsWith('latest.log') || file.startsWith('debug.log')) {
          // Skip - these are current logs
        } else if (file.endsWith('.log') && stat.mtime < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {
          // Old log files (older than 7 days)
          filesToCleanup.push({ file, reason: 'Old log file' });
        }      } else if (stat.isDirectory()) {
        // Clean up libraries directory if it exists (Fabric libraries)
        if (file === 'libraries') {
          // Fabric creates version-specific library structures
          // We could clean this up but it's safer to leave it for manual cleanup
        }
          // Clean up version-specific directories
        if (file === 'versions' && oldConfig.version) {
          const versionDir = path.join(serverPath, file);
          try {
            const versionDirContents = fs.readdirSync(versionDir);
            for (const versionFile of versionDirContents) {
              if (versionFile === oldConfig.version || versionFile.includes(oldConfig.version)) {
                // Mark the entire version subdirectory for deletion
                filesToCleanup.push({ 
                  file: path.join(file, versionFile), 
                  reason: `Old version directory (${oldConfig.version})`,
                  isDirectory: true
                });
              }
            }
          } catch {
            // Ignore directory read errors
          }
        }
      }    }
    
    // Delete identified files and directories
    for (const { file, isDirectory } of filesToCleanup) {
      try {
        const filePath = path.join(serverPath, file);
        if (isDirectory) {
          // Delete directory recursively
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          // Delete file
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        console.warn(`⚠️ Failed to delete ${file}: ${error.message}`);
      }    }
    
  } catch (error) {
    console.error('❌ Error during server version cleanup:', error);
    // Don't throw - cleanup is not critical for functionality
  }
}

// Export the function directly
module.exports = { createConfigHandlers };
