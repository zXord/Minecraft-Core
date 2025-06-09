const os = require('os');
const fs = require('fs'); // For calculateFileChecksum
const { createHash } = require('crypto'); // For calculateFileChecksum
const { exec } = require('child_process'); // For logSystemInfo's ulimit

function logSystemInfo() {
  try {
    
    if (process.platform !== 'win32') {
      try {
        exec('ulimit -n', (error, stdout) => {
          if (!error) {
          }
        });
      } catch (e) {
        // Ignore
      }
    }
  } catch (error) {
  }
}

function logMemoryUsage() {
  try {
    const memUsage = process.memoryUsage();
                `Heap=${Math.round(memUsage.heapUsed/1024/1024)}MB/${Math.round(memUsage.heapTotal/1024/1024)}MB, ` +
                `External=${Math.round(memUsage.external/1024/1024)}MB, ` +
                `Free System=${Math.round(os.freemem()/1024/1024/1024)}GB`);
  } catch (error) {
    // Ignore
  }
}

function getRequiredJavaVersion(minecraftVersion) {
  const version = minecraftVersion.split('.');
  const major = parseInt(version[0]);
  const minor = parseInt(version[1]);
  const patch = parseInt(version[2] || 0);
  
  if (major === 1) {
    if (minor <= 16) {
      return 8;
    } else if (minor <= 20 || (minor === 20 && patch <= 4)) {
      return 17;
    } else {
      return 21;
    }
  }
  return 17; // Default
}

function calculateFileChecksum(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath);
    return createHash('md5').update(fileContent).digest('hex');
  } catch (error) {
    return null;
  }
}

module.exports = {
  logSystemInfo,
  logMemoryUsage,
  getRequiredJavaVersion,
  calculateFileChecksum
};
