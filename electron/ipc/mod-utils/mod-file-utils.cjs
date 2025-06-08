const fs = require('fs');
const path = require('path');

/**
 * Disable a mod by moving it to the disabled directory or renaming it
 * @param {string} modsDir - The mods directory path
 * @param {string} fileName - The mod filename to disable
 * @returns {Promise<boolean>} - Success status
 */
async function disableMod(modsDir, fileName) {
  try {
    const sourcePath = path.join(modsDir, fileName);
    
    if (!fs.existsSync(sourcePath)) {
      console.warn(`[ModFileUtils] Mod file not found for disabling: ${fileName}`);
      return false;
    }

    // Create disabled directory if it doesn't exist
    const disabledDir = path.join(modsDir, 'disabled');
    if (!fs.existsSync(disabledDir)) {
      fs.mkdirSync(disabledDir, { recursive: true });
    }

    const targetPath = path.join(disabledDir, fileName);
    
    // Check if target already exists
    if (fs.existsSync(targetPath)) {
      console.warn(`[ModFileUtils] Target disabled file already exists: ${fileName}`);
      return false;
    }

    // Move the file to disabled directory
    fs.renameSync(sourcePath, targetPath);
    console.log(`[ModFileUtils] Successfully disabled mod: ${fileName}`);
    return true;
  } catch (error) {
    console.error(`[ModFileUtils] Error disabling mod ${fileName}:`, error);
    return false;
  }
}

/**
 * Enable a mod by moving it from the disabled directory back to the mods directory
 * @param {string} modsDir - The mods directory path
 * @param {string} fileName - The mod filename to enable
 * @returns {Promise<boolean>} - Success status
 */
async function enableMod(modsDir, fileName) {
  try {
    const disabledDir = path.join(modsDir, 'disabled');
    const sourcePath = path.join(disabledDir, fileName);
    
    if (!fs.existsSync(sourcePath)) {
      console.warn(`[ModFileUtils] Disabled mod file not found for enabling: ${fileName}`);
      return false;
    }

    const targetPath = path.join(modsDir, fileName);
    
    // Check if target already exists
    if (fs.existsSync(targetPath)) {
      console.warn(`[ModFileUtils] Target enabled file already exists: ${fileName}`);
      return false;
    }

    // Move the file back to mods directory
    fs.renameSync(sourcePath, targetPath);
    console.log(`[ModFileUtils] Successfully enabled mod: ${fileName}`);
    return true;
  } catch (error) {
    console.error(`[ModFileUtils] Error enabling mod ${fileName}:`, error);
    return false;
  }
}

module.exports = {
  disableMod,
  enableMod
};
