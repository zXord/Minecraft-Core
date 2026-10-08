const fs = require('fs');
const path = require('path');
const os = require('os');
const { JavaManager } = require('./minecraft-launcher/java-manager.cjs');
const { markCurrentServerMutationDirty } = require('./server-mutation-context.cjs');
const utils = require('./minecraft-launcher/utils.cjs');

/**
 * Server-specific Java Manager
 * Extends JavaManager functionality for server use
 * Uses server-specific Java directory (serverPath/java/) for each server
 */
class ServerJavaManager extends JavaManager {
  constructor(serverPath = null, options = {}) {
    const { onMutation = markCurrentServerMutationDirty } = options;
    // Initialize with no client path to use global directory as fallback
    super(null, options);

    this.onMutation = typeof onMutation === 'function' ? onMutation : markCurrentServerMutationDirty;

    // Set server-specific Java directory
    this.setServerPath(serverPath);
  }

  beforeFilesystemMutation(targetPath) {
    if (!this.serverPath || typeof this.onMutation !== 'function') return false;
    const marked = this.onMutation(this.serverPath, targetPath);
    if (marked !== true) {
      const error = new Error('Server Java filesystem mutation requires an active server mutation lease');
      error.code = 'INVALID_REQUEST';
      throw error;
    }
    return true;
  }
  
  /**
   * Set the server path and update Java directory
   * @param {string} serverPath - Path to the server directory
   */
  setServerPath(serverPath) {
    this.serverPath = serverPath;
    this.isScopedJavaDir = Boolean(serverPath);
    
    if (serverPath) {
      // Use server-specific Java directory
      this.javaBaseDir = path.join(serverPath, 'java');
    } else {
      // Fallback to global directory
      this.javaBaseDir = path.join(os.homedir(), '.minecraft-core', 'server-java');
    }
    
    // The directory is created lazily by the first write so read-only checks
    // remain read-only and do not advance the server content revision.
  }
  
  /**
   * Check if the correct Java version is available for a Minecraft version
   * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
   * @returns {boolean} - True if correct Java version is available
   */
  async isCorrectJavaAvailableForMinecraft(minecraftVersion) {
    const { requiredJavaVersion } = await utils.resolveRequiredJavaVersion(minecraftVersion);
    return this.isJavaInstalled(requiredJavaVersion);
  }
  
  /**
   * Get the best Java path for a Minecraft version
   * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
   * @returns {string|null} - Path to Java executable or null if not available
   */
  async getBestJavaPathForMinecraft(minecraftVersion) {
    const { requiredJavaVersion } = await utils.resolveRequiredJavaVersion(minecraftVersion);
    return this.getBestJavaPath(requiredJavaVersion);
  }
  
  /**
   * Ensure the correct Java version is available for a Minecraft version
   * Will download Java if needed
   * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
   * @param {Function} progressCallback - Progress callback function
   * @returns {Promise<{success: boolean, javaPath?: string, error?: string}>}
   */
  async ensureJavaForMinecraft(minecraftVersion, progressCallback, options = {}) {
    const javaRequirement = await utils.resolveRequiredJavaVersion(minecraftVersion);
    const requiredJavaVersion = javaRequirement.requiredJavaVersion;
    
    try {
      const result = await this.ensureJava(requiredJavaVersion, progressCallback, options);
      return {
        ...result,
        requiredJavaVersion,
        source: javaRequirement.source,
        javaComponent: javaRequirement.javaComponent || null
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        requiredJavaVersion,
        source: javaRequirement.source,
        javaComponent: javaRequirement.javaComponent || null
      };
    }
  }
  
  /**
   * Get information about Java requirements for a Minecraft version
   * @param {string} minecraftVersion - Minecraft version (e.g., "1.21.4")
   * @returns {object} - Java requirement information
   */
  async getJavaRequirementsForMinecraft(minecraftVersion) {
    const javaRequirement = await utils.resolveRequiredJavaVersion(minecraftVersion);
    const requiredJavaVersion = javaRequirement.requiredJavaVersion;
    const validationStatus = this.getJavaValidationStatus(requiredJavaVersion);
    const isAvailable = validationStatus.isInstalled;
    const javaPath = validationStatus.javaPath || null;
    
    return {
      minecraftVersion,
      requiredJavaVersion,
      source: javaRequirement.source,
      javaComponent: javaRequirement.javaComponent || null,
      metadataError: javaRequirement.error || null,
      isAvailable,
      javaPath,
      needsDownload: !isAvailable,
      installationState: validationStatus.state || (isAvailable ? 'available' : 'missing'),
      validationMessage: validationStatus.validation ? validationStatus.validation.message : '',
      validationCode: validationStatus.validation ? validationStatus.validation.code : ''
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
