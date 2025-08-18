/**
 * Utility functions to fetch the latest Minecraft and Fabric versions
 */
import logger from './logger.js';

/**
 * Fetch the latest stable Minecraft version from Fabric's meta API
 * @returns {Promise<string|null>} latest version or null on failure
 */
export async function fetchLatestMinecraftVersion() {
  logger.info('Fetching latest Minecraft version', {
    category: 'utils',
    data: {
      function: 'fetchLatestMinecraftVersion',
      apiUrl: 'https://meta.fabricmc.net/v2/versions/game'
    }
  });
  
  try {
    const res = await fetch('https://meta.fabricmc.net/v2/versions/game');
    if (!res.ok) {
      const errorMsg = `Status ${res.status}`;
      logger.error('Failed to fetch Minecraft versions - HTTP error', {
        category: 'utils',
        data: {
          function: 'fetchLatestMinecraftVersion',
          status: res.status,
          statusText: res.statusText
        }
      });
      throw new Error(errorMsg);
    }
    
    const data = await res.json();
    const stable = data.find(v => v.stable);
    const version = stable ? stable.version : (data[0]?.version ?? null);
    
    logger.info('Latest Minecraft version fetched successfully', {
      category: 'utils',
      data: {
        function: 'fetchLatestMinecraftVersion',
        version,
        isStable: !!stable,
        totalVersions: data.length
      }
    });
    
    return version;
  } catch (err) {
    logger.error('Error fetching latest Minecraft version', {
      category: 'utils',
      data: {
        function: 'fetchLatestMinecraftVersion',
        errorMessage: err.message
      }
    });
    return null;
  }
}

/**
 * Fetch the latest Fabric loader version for a given Minecraft version
 * @param {string} mcVersion - Minecraft version to check
 * @returns {Promise<string|null>} latest loader version or null on failure
 */
export async function fetchLatestFabricVersion(mcVersion) {
  if (!mcVersion) {
    logger.warn('No Minecraft version provided to fetchLatestFabricVersion', {
      category: 'utils',
      data: {
        function: 'fetchLatestFabricVersion',
        mcVersion
      }
    });
    return null;
  }
  
  logger.info('Fetching latest Fabric version', {
    category: 'utils',
    data: {
      function: 'fetchLatestFabricVersion',
      mcVersion,
      apiUrl: `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`
    }
  });
  
  try {
    const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
    if (!res.ok) {
      const errorMsg = `Status ${res.status}`;
      logger.error('Failed to fetch Fabric versions - HTTP error', {
        category: 'utils',
        data: {
          function: 'fetchLatestFabricVersion',
          mcVersion,
          status: res.status,
          statusText: res.statusText
        }
      });
      throw new Error(errorMsg);
    }
    
    const data = await res.json();
    const version = data.length > 0 ? data[0].loader.version : null;
    
    logger.info('Latest Fabric version fetched successfully', {
      category: 'utils',
      data: {
        function: 'fetchLatestFabricVersion',
        mcVersion,
        fabricVersion: version,
        totalVersions: data.length
      }
    });
    
    return version;
  } catch (err) {
    logger.error('Error fetching latest Fabric version', {
      category: 'utils',
      data: {
        function: 'fetchLatestFabricVersion',
        mcVersion,
        errorMessage: err.message
      }
    });
    return null;
  }
}

/**
 * Fetch all Fabric loader versions for a given Minecraft version
 * @param {string} mcVersion - Minecraft version to check
 * @returns {Promise<string[]>} array of loader versions (may include unstable releases)
 */
export async function fetchAllFabricVersions(mcVersion) {
  if (!mcVersion) {
    logger.warn('No Minecraft version provided to fetchAllFabricVersions', {
      category: 'utils',
      data: {
        function: 'fetchAllFabricVersions',
        mcVersion
      }
    });
    return [];
  }
  
  logger.info('Fetching all Fabric versions', {
    category: 'utils',
    data: {
      function: 'fetchAllFabricVersions',
      mcVersion,
      apiUrl: `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}?limit=1000`
    }
  });
  
  try {
    const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}?limit=1000`);
    if (!res.ok) {
      const errorMsg = `Status ${res.status}`;
      logger.error('Failed to fetch all Fabric versions - HTTP error', {
        category: 'utils',
        data: {
          function: 'fetchAllFabricVersions',
          mcVersion,
          status: res.status,
          statusText: res.statusText
        }
      });
      throw new Error(errorMsg);
    }
    
    const data = await res.json();
    const versions = data.map(v => v.loader.version);
    
    logger.info('All Fabric versions fetched successfully', {
      category: 'utils',
      data: {
        function: 'fetchAllFabricVersions',
        mcVersion,
        versionsCount: versions.length
      }
    });
    
    return versions;
  } catch (err) {
    logger.error('Error fetching all Fabric versions', {
      category: 'utils',
      data: {
        function: 'fetchAllFabricVersions',
        mcVersion,
        errorMessage: err.message
      }
    });
    return [];
  }
}

/**
 * Parse a version string into components for comparison
 * @param {string} version - Version string (e.g., "1.20.1", "0.14.21")
 * @returns {Object} Parsed version components
 */
export function parseVersion(version) {
  logger.debug('Parsing version string', {
    category: 'utils',
    data: {
      function: 'parseVersion',
      version,
      versionType: typeof version
    }
  });
  
  if (!version || typeof version !== 'string') {
    logger.error('Invalid version string provided to parseVersion', {
      category: 'utils',
      data: {
        function: 'parseVersion',
        version,
        versionType: typeof version
      }
    });
    return {
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: null,
      build: null,
      valid: false,
      original: version
    };
  }
  
  try {
    // Handle pre-release and build metadata
    const [mainVersion, ...rest] = version.split(/[-+]/);
    const parts = mainVersion.split('.').map(part => {
      const num = parseInt(part, 10);
      return isNaN(num) ? 0 : num;
    });
    
    const parsed = {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      prerelease: rest.length > 0 && version.includes('-') ? rest[0] : null,
      build: rest.length > 0 && version.includes('+') ? rest[rest.length - 1] : null,
      valid: true,
      original: version
    };
    
    logger.debug('Version parsed successfully', {
      category: 'utils',
      data: {
        function: 'parseVersion',
        version,
        parsed: {
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch,
          hasPrerelease: !!parsed.prerelease,
          hasBuild: !!parsed.build
        }
      }
    });
    
    return parsed;
  } catch (err) {
    logger.error('Error parsing version string', {
      category: 'utils',
      data: {
        function: 'parseVersion',
        version,
        errorMessage: err.message
      }
    });
    
    return {
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: null,
      build: null,
      valid: false,
      original: version
    };
  }
}

/**
 * Compare two version strings
 * @param {string} version1 - First version to compare
 * @param {string} version2 - Second version to compare
 * @returns {number} -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export function compareVersions(version1, version2) {
  // Robust comparator (matches store logic):
  // - Handles alphanumeric suffixes in segments: 1.2a > 1.2
  // - Handles pre-release markers: 1.2-rc1 < 1.2
  // - Ignores leading 'v'
  logger.debug('Comparing versions', {
    category: 'utils',
    data: { function: 'compareVersions', version1, version2 }
  });

  if (!version1 || !version2) return 0;
  if (version1 === version2) return 0;

  const normalize = (v) => String(v).trim().replace(/^v/i, '');
  const aStr = normalize(version1);
  const bStr = normalize(version2);

  const splitPre = (v) => {
    const idx = v.indexOf('-');
    return idx === -1 ? { main: v, pre: null } : { main: v.slice(0, idx), pre: v.slice(idx + 1) };
  };
  const tokenize = (seg) => (seg ? seg.match(/\d+|[A-Za-z]+/g)?.map(t => (/^\d+$/.test(t) ? Number(t) : t.toLowerCase())) || [] : []);
  const parse = (v) => {
    const { main, pre } = splitPre(v);
    return { mainTokens: main.split('.').flatMap(tokenize), preTokens: pre ? pre.split('.').flatMap(tokenize) : null, hasPre: !!pre };
  };

  const a = parse(aStr);
  const b = parse(bStr);

  const len = Math.max(a.mainTokens.length, b.mainTokens.length);
  for (let i = 0; i < len; i++) {
    const at = a.mainTokens[i];
    const bt = b.mainTokens[i];
    if (at === undefined && bt === undefined) break;
    if (at === undefined) {
      const rest = b.mainTokens.slice(i);
      const allZero = rest.every(x => typeof x === 'number' && x === 0);
      return allZero ? 0 : -1;
    }
    if (bt === undefined) {
      const rest = a.mainTokens.slice(i);
      const allZero = rest.every(x => typeof x === 'number' && x === 0);
      return allZero ? 0 : 1;
    }
    if (typeof at === 'number' && typeof bt === 'number') {
      if (at !== bt) return at > bt ? 1 : -1;
    } else if (typeof at === 'string' && typeof bt === 'string') {
      if (at !== bt) return at > bt ? 1 : -1;
    } else {
      return typeof at === 'number' ? 1 : -1;
    }
  }

  if (a.hasPre && !b.hasPre) return -1;
  if (!a.hasPre && b.hasPre) return 1;
  if (!a.hasPre && !b.hasPre) return 0;

  const maxPre = Math.max(a.preTokens.length, b.preTokens.length);
  for (let i = 0; i < maxPre; i++) {
    const at = a.preTokens[i];
    const bt = b.preTokens[i];
    if (at === undefined && bt === undefined) break;
    if (at === undefined) return -1;
    if (bt === undefined) return 1;
    if (typeof at === 'number' && typeof bt === 'number') {
      if (at !== bt) return at > bt ? 1 : -1;
    } else if (typeof at === 'string' && typeof bt === 'string') {
      if (at !== bt) return at > bt ? 1 : -1;
    } else {
      return typeof at === 'number' ? 1 : -1;
    }
  }

  logger.debug('Version comparison completed - versions are equal', {
    category: 'utils',
    data: { function: 'compareVersions', version1, version2, result: 0 }
  });
  return 0;
}

/**
 * Check if a version satisfies a requirement (supports basic semver-like ranges)
 * @param {string} version - Version to check
 * @param {string} requirement - Requirement string (e.g., ">=1.20.0", "^1.19.0", "~1.20.1")
 * @returns {boolean} True if version satisfies requirement
 */
export function satisfiesVersion(version, requirement) {
  logger.debug('Checking version compatibility', {
    category: 'utils',
    data: {
      function: 'satisfiesVersion',
      version,
      requirement
    }
  });
  
  if (!version || !requirement) {
    logger.warn('Invalid parameters provided to satisfiesVersion', {
      category: 'utils',
      data: {
        function: 'satisfiesVersion',
        version,
        requirement,
        hasVersion: !!version,
        hasRequirement: !!requirement
      }
    });
    return false;
  }
  
  try {
    // Handle exact match
    if (!requirement.match(/^[><=^~]/)) {
      const result = compareVersions(version, requirement) === 0;
      logger.debug('Exact version match check completed', {
        category: 'utils',
        data: {
          function: 'satisfiesVersion',
          version,
          requirement,
          result,
          matchType: 'exact'
        }
      });
      return result;
    }
    
    // Handle range operators
    if (requirement.startsWith('>=')) {
      const targetVersion = requirement.slice(2);
      const result = compareVersions(version, targetVersion) >= 0;
      logger.debug('Greater than or equal version check completed', {
        category: 'utils',
        data: {
          function: 'satisfiesVersion',
          version,
          requirement,
          targetVersion,
          result,
          matchType: '>='
        }
      });
      return result;
    }
    
    if (requirement.startsWith('<=')) {
      const targetVersion = requirement.slice(2);
      const result = compareVersions(version, targetVersion) <= 0;
      logger.debug('Less than or equal version check completed', {
        category: 'utils',
        data: {
          function: 'satisfiesVersion',
          version,
          requirement,
          targetVersion,
          result,
          matchType: '<='
        }
      });
      return result;
    }
    
    if (requirement.startsWith('>')) {
      const targetVersion = requirement.slice(1);
      const result = compareVersions(version, targetVersion) > 0;
      logger.debug('Greater than version check completed', {
        category: 'utils',
        data: {
          function: 'satisfiesVersion',
          version,
          requirement,
          targetVersion,
          result,
          matchType: '>'
        }
      });
      return result;
    }
    
    if (requirement.startsWith('<')) {
      const targetVersion = requirement.slice(1);
      const result = compareVersions(version, targetVersion) < 0;
      logger.debug('Less than version check completed', {
        category: 'utils',
        data: {
          function: 'satisfiesVersion',
          version,
          requirement,
          targetVersion,
          result,
          matchType: '<'
        }
      });
      return result;
    }
    
    // Handle caret range (^1.2.3 allows >=1.2.3 <2.0.0)
    if (requirement.startsWith('^')) {
      const targetVersion = requirement.slice(1);
      const parsed = parseVersion(version);
      const targetParsed = parseVersion(targetVersion);
      
      if (!parsed.valid || !targetParsed.valid) {
        logger.warn('Invalid version format in caret range check', {
          category: 'utils',
          data: {
            function: 'satisfiesVersion',
            version,
            requirement,
            versionValid: parsed.valid,
            targetValid: targetParsed.valid
          }
        });
        return false;
      }
      
      const result = parsed.major === targetParsed.major && 
                    compareVersions(version, targetVersion) >= 0;
      
      logger.debug('Caret range version check completed', {
        category: 'utils',
        data: {
          function: 'satisfiesVersion',
          version,
          requirement,
          targetVersion,
          result,
          matchType: '^',
          majorMatch: parsed.major === targetParsed.major
        }
      });
      return result;
    }
    
    // Handle tilde range (~1.2.3 allows >=1.2.3 <1.3.0)
    if (requirement.startsWith('~')) {
      const targetVersion = requirement.slice(1);
      const parsed = parseVersion(version);
      const targetParsed = parseVersion(targetVersion);
      
      if (!parsed.valid || !targetParsed.valid) {
        logger.warn('Invalid version format in tilde range check', {
          category: 'utils',
          data: {
            function: 'satisfiesVersion',
            version,
            requirement,
            versionValid: parsed.valid,
            targetValid: targetParsed.valid
          }
        });
        return false;
      }
      
      const result = parsed.major === targetParsed.major && 
                    parsed.minor === targetParsed.minor && 
                    compareVersions(version, targetVersion) >= 0;
      
      logger.debug('Tilde range version check completed', {
        category: 'utils',
        data: {
          function: 'satisfiesVersion',
          version,
          requirement,
          targetVersion,
          result,
          matchType: '~',
          majorMatch: parsed.major === targetParsed.major,
          minorMatch: parsed.minor === targetParsed.minor
        }
      });
      return result;
    }
    
    logger.warn('Unsupported version requirement format', {
      category: 'utils',
      data: {
        function: 'satisfiesVersion',
        version,
        requirement,
        result: false
      }
    });
    return false;
    
  } catch (err) {
    logger.error('Error checking version compatibility', {
      category: 'utils',
      data: {
        function: 'satisfiesVersion',
        version,
        requirement,
        errorMessage: err.message
      }
    });
    return false;
  }
}

/**
 * Validate if a version string is in a valid format
 * @param {string} version - Version string to validate
 * @returns {boolean} True if version is valid
 */
export function isValidVersion(version) {
  logger.debug('Validating version format', {
    category: 'utils',
    data: {
      function: 'isValidVersion',
      version,
      versionType: typeof version
    }
  });
  
  const parsed = parseVersion(version);
  
  logger.debug('Version validation completed', {
    category: 'utils',
    data: {
      function: 'isValidVersion',
      version,
      valid: parsed.valid
    }
  });
  
  return parsed.valid;
}
