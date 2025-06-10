const fs = require('fs');
const { createHash } = require('crypto');

function getRequiredJavaVersion(minecraftVersion) {
  const version = minecraftVersion.split('.');
  const major = parseInt(version[0]);
  const minor = parseInt(version[1]);
  
  if (major === 1) {
    if (minor <= 16) {
      return 8;
    } else if (minor <= 20 || (minor === 20 && parseInt(version[2] || 0) <= 4)) {
      return 17;
    } else {
      return 21;
    }
  }
  return 17;
}

function calculateFileChecksum(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath);
    return createHash('md5').update(fileContent).digest('hex');
  } catch {
    return null;
  }
}

module.exports = {
  getRequiredJavaVersion,
  calculateFileChecksum
};
