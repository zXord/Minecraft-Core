const fs = require('fs');
const path = require('path');
const os = require('os');
const { JavaManager } = require('./minecraft-launcher/java-manager.cjs');
const utils = require('./minecraft-launcher/utils.cjs');

/**
 * Server-specific Java Manager
 * Extends JavaManager functionality for server use
 * Uses server-specific Java directory (serverPath/java/) for each server
 */
class ServerJavaManager extends JavaManager {
  constructor(serverPath = null) {
    // Initialize with no client path to use global directory as fallback
    super(null);
    
    // Set server-specific Java directory
    this.setServerPath(serverPath);
  }
  
  /**
   * Set the server path and update Java directory
   * @param {string} serverPath - Path to the server directory
   */
  setServerPath(serverPath) {
    this.serverPath = serverPath;
    
    if (serverPath) {
      // Use server-specific Java directory
      this.javaBaseDir = path.join(serverPath, 'java');
    } else {
      // Fallback to global directory
      this.javaBaseDir = path.join(os.homedir(), '.minecraft-core', 'server-java');
    }
    
    // Ensure Java directory exists
    if (!fs.existsSync(this.javaBaseDir)) {
      fs.mkdirSync(this.javaBaseDir, { recursive: true });
    }
  }
  
  /**
   * Check if the correct Java version is available for a Minecraft version
   * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
   * @returns {boolean} - True if correct Java version is available
   */
  isCorrectJavaAvailableForMinecraft(minecraftVersion) {
    const requiredJavaVersion = utils.getRequiredJavaVersion(minecraftVersion);
    return this.isJavaInstalled(requiredJavaVersion);
  }
  
  /**
   * Get the best Java path for a Minecraft version
   * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
   * @returns {string|null} - Path to Java executable or null if not available
   */
  getBestJavaPathForMinecraft(minecraftVersion) {
    const requiredJavaVersion = utils.getRequiredJavaVersion(minecraftVersion);
    return this.getBestJavaPath(requiredJavaVersion);
  }
  
  /**
   * Ensure the correct Java version is available for a Minecraft version
   * Will download Java if needed
   * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
   * @param {Function} progressCallback - Progress callback function
   * @returns {Promise<{success: boolean, javaPath?: string, error?: string}>}
   */
  async ensureJavaForMinecraft(minecraftVersion, progressCallback) {
    const requiredJavaVersion = utils.getRequiredJavaVersion(minecraftVersion);
    
    try {
      return await this.ensureJava(requiredJavaVersion, progressCallback);
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get information about Java requirements for a Minecraft version
   * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
   * @returns {object} - Java requirement information
   */
  getJavaRequirementsForMinecraft(minecraftVersion) {
    const requiredJavaVersion = utils.getRequiredJavaVersion(minecraftVersion);
    const isAvailable = this.isJavaInstalled(requiredJavaVersion);
    const javaPath = isAvailable ? this.getBestJavaPath(requiredJavaVersion) : null;
    
    return {
      minecraftVersion,
      requiredJavaVersion,
      isAvailable,
      javaPath,
      needsDownload: !isAvailable
    };
  }
  
  /**
   * Get all available Java versions in the server Java directory
   * @returns {Array<string>} - Array of available Java versions
   */
  getAvailableJavaVersions() {
    if (!fs.existsSync(this.javaBaseDir)) {
      return [];
    }
    
    try {
      const javaDirs = fs.readdirSync(this.javaBaseDir);
      return javaDirs
        .filter(dir => dir.startsWith('java-'))
        .map(dir => dir.replace('java-', ''))
        .filter(version => !isNaN(parseInt(version)))
        .sort((a, b) => parseInt(b) - parseInt(a)); // Sort descending (highest first)
    } catch {
      return [];
    }
  }
}

module.exports = { ServerJavaManager }; 