// Utility functions shared across mod handlers
const modAnalysisUtils = require('../mod-utils/mod-analysis-utils.cjs');

function compareVersions(versionA, versionB) {
  if (!versionA || !versionB) return 0;
  if (versionA === versionB) return 0;
  const partsA = versionA.split(/[.-]/).map(part => {
    const num = parseInt(part, 10);
    return isNaN(num) ? part : num;
  });
  const partsB = versionB.split(/[.-]/).map(part => {
    const num = parseInt(part, 10);
    return isNaN(num) ? part : num;
  });
  const minLength = Math.min(partsA.length, partsB.length);
  for (let i = 0; i < minLength; i++) {
    const a = partsA[i];
    const b = partsB[i];
    if (typeof a === 'number' && typeof b === 'number') {
      if (a !== b) return a - b;
    } else if (typeof a === 'string' && typeof b === 'string') {
      if (a !== b) return a.localeCompare(b);
    } else if (typeof a === 'number') {
      return 1;
    } else {
      return -1;
    }
  }
  return partsA.length - partsB.length;
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

module.exports = {
  compareVersions,
  extractVersionFromFilename,
  readModMetadata,
  checkModCompatibilityFromFilename
};
