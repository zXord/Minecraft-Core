// filepath: c:\Users\Saeed\Desktop\ET\Codes\minecraft-core\electron\ipc\mod-utils\mod-file-utils.cjs
const fs = require('fs');
const path = require('path');

/**
 * Disable a mod by renaming it with .disabled extension
 * @param {string} modsDir - The mods directory path
 * @param {string} fileName - The mod filename to disable
 * @returns {Promise<boolean>} - Success status
 */
async function disableMod(modsDir, fileName) {
  try {
    const sourcePath = path.join(modsDir, fileName);
    
    if (!fs.existsSync(sourcePath)) {
      return false;
    }    // Rename the file with .disabled extension
    const targetPath = path.join(modsDir, fileName + '.disabled');
    
    // Check if target already exists
    if (fs.existsSync(targetPath)) {
      return false;
    }

    // Rename the file with .disabled extension
    fs.renameSync(sourcePath, targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enable a mod by removing the .disabled extension
 * @param {string} modsDir - The mods directory path
 * @param {string} fileName - The mod filename to enable (without .disabled extension)
 * @returns {Promise<boolean>} - Success status
 */
async function enableMod(modsDir, fileName) {
  try {
    const sourcePath = path.join(modsDir, fileName + '.disabled');
    
    if (!fs.existsSync(sourcePath)) {
      return false;
    }

    const targetPath = path.join(modsDir, fileName);
    
    // Check if target already exists
    if (fs.existsSync(targetPath)) {
      return false;
    }

    // Remove the .disabled extension
    fs.renameSync(sourcePath, targetPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  disableMod,
  enableMod
};
