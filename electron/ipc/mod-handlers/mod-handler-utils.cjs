// Utility functions shared across mod handlers
const modAnalysisUtils = require('../mod-utils/mod-analysis-utils.cjs');

function compareVersions(versionA, versionB) {
  if (!versionA || !versionB) return 0;
  if (versionA === versionB) return 0;
  
  // Remove any suffixes like "-rc.3", "-alpha", etc. for comparison
  const cleanA = versionA.split('-')[0];
  const cleanB = versionB.split('-')[0];
  
  const partsA = cleanA.split('.').map(Number);
  const partsB = cleanB.split('.').map(Number);
  
  const maxLength = Math.max(partsA.length, partsB.length);
  
  for (let i = 0; i < maxLength; i++) {
    const a = partsA[i] || 0;
    const b = partsB[i] || 0;
    
    if (a > b) return 1;
    if (a < b) return -1;
  }
  
  return 0;
}

function extractVersionFromFilename(filename) {
  if (!filename) return null;
  const cleanName = filename.replace(/\.jar(\.disabled)?$/i, '');
  const patterns = [
    /[-_](\d+\.\d+\.\d+[\w.-]*)/,
    /[-_]v(\d+\.\d+\.\d+[\w.-]*)/,
    /[_](\d+\.\d+\.\d+[\w.-]*)/,
    /\s+(\d+\.\d+\.\d+[\w.-]*)/,
    /[[(](\d+\.\d+\.\d+[\w.-]*?)[)\]]/,
    /mc\d+\.\d+\.\d+[^\d]*(\d+\.\d+[.\d]*[\w-]*)/,
    /(\d+\.\d+[.\d]*[\w-]*)$/
  ];
  for (const pattern of patterns) {
    const match = cleanName.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

async function readModMetadata(filePath) {
  try {
    const result = await modAnalysisUtils.extractDependenciesFromJar(filePath);
    return result;
  } catch {
    return null;
  }
}

function checkModCompatibilityFromFilename(filename, minecraftVersion) {
  if (!filename || !minecraftVersion) {
    return { isCompatible: false, confidence: 'low' };
  }
  const lowerFilename = filename.toLowerCase();
  const versionPattern = /(\d+\.\d+(?:\.\d+)?)/g;
  const matches = lowerFilename.match(versionPattern);
  if (!matches) {
    return { isCompatible: false, confidence: 'low' };
  }
  for (const match of matches) {
    if (match === minecraftVersion || minecraftVersion.startsWith(match)) {
      return { isCompatible: true, confidence: 'medium' };
    }
  }
  return { isCompatible: false, confidence: 'medium' };
}

// Helper function for version compatibility checking
function checkMinecraftVersionCompatibility(modVersion, targetVersion) {
  if (!modVersion || !targetVersion) return false;
  
  // Exact match
  if (modVersion === targetVersion) return true;
  
  // Handle arrays (like ["1.21.x"])
  if (Array.isArray(modVersion)) {
    return modVersion.some(v => checkMinecraftVersionCompatibility(v, targetVersion));
  }
  
  // Handle range format like ">=1.21.2 <=1.21.3" or ">=1.21.4- <1.21.5-"
  if ((modVersion.includes('>=') || modVersion.includes('>')) && (modVersion.includes('<=') || modVersion.includes('<'))) {
    const rangeParts = modVersion.split(' ').filter(p => p.trim());
    let minPart = null;
    let maxPart = null;
    let minInclusive = true;
    let maxInclusive = true;
    
    for (const part of rangeParts) {
      if (part.startsWith('>=')) {
        minPart = part.substring(2).trim();
        minInclusive = true;
      } else if (part.startsWith('>')) {
        minPart = part.substring(1).trim();
        minInclusive = false;
      } else if (part.startsWith('<=')) {
        maxPart = part.substring(2).trim();
        maxInclusive = true;
      } else if (part.startsWith('<')) {
        maxPart = part.substring(1).trim();
        maxInclusive = false;
      }
    }
    
    if (minPart && maxPart) {
      // Clean version strings by removing trailing dashes and suffixes
      const cleanMinVersion = minPart.replace(/[-+].*$/, '');
      const cleanMaxVersion = maxPart.replace(/[-+].*$/, '');
      const cleanTargetVersion = targetVersion.replace(/[-+].*$/, '');
      
      const minCheck = minInclusive ? 
        compareVersions(cleanTargetVersion, cleanMinVersion) >= 0 : 
        compareVersions(cleanTargetVersion, cleanMinVersion) > 0;
      
      const maxCheck = maxInclusive ? 
        compareVersions(cleanTargetVersion, cleanMaxVersion) <= 0 : 
        compareVersions(cleanTargetVersion, cleanMaxVersion) < 0;
      
      return minCheck && maxCheck;
    }
  }
  
  // Handle version ranges like "1.21.x" or "1.21.*"
  if (modVersion.includes('.x') || modVersion.includes('.*')) {
    const baseVersion = modVersion.replace(/\.[x*].*$/, '');
    return targetVersion.startsWith(baseVersion + '.');
  }
  
  // Handle ">=" comparisons like ">=1.21.4-rc.3"
  if (modVersion.startsWith('>=')) {
    const minVersion = modVersion.substring(2).trim();
    return compareVersions(targetVersion, minVersion) >= 0;
  }
  
  // Handle ">" comparisons
  if (modVersion.startsWith('>')) {
    const minVersion = modVersion.substring(1).trim();
    return compareVersions(targetVersion, minVersion) > 0;
  }
  
  // Handle "<=" comparisons
  if (modVersion.startsWith('<=')) {
    const maxVersion = modVersion.substring(2).trim();
    return compareVersions(targetVersion, maxVersion) <= 0;
  }
  
  // Handle "<" comparisons
  if (modVersion.startsWith('<')) {
    const maxVersion = modVersion.substring(1).trim();
    return compareVersions(targetVersion, maxVersion) < 0;
  }
  
  // Handle "~" (approximately equal) like "~1.21.4"
  if (modVersion.startsWith('~')) {
    const baseVersion = modVersion.substring(1).trim();
    const [baseMajor, baseMinor] = baseVersion.split('.');
    const [targetMajor, targetMinor] = targetVersion.split('.');
    return baseMajor === targetMajor && baseMinor === targetMinor;
  }
  
  return false;
}



module.exports = {
  compareVersions,
  extractVersionFromFilename,
  readModMetadata,
  checkModCompatibilityFromFilename,
  checkMinecraftVersionCompatibility
};
