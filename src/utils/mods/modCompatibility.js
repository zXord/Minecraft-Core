/**
 * Mod compatibility checking utilities
 */
import { get } from 'svelte/store';
import { installedModInfo, modsWithUpdates, disabledMods } from '../../stores/modStore.js';
import { safeInvoke } from '../ipcUtils.js';
import logger from '../logger.js';

/**
 * Check compatibility of dependencies with installed mods
 * @param {Array} dependencies - Mod dependencies
 * @param {string} mainModId - Main mod ID to avoid self-dependencies
 * @returns {Promise<Array>} - Array of compatibility issues
 */
export async function checkDependencyCompatibility(dependencies, mainModId = null, freshInstalledInfo = null) {
  logger.info('Checking dependency compatibility', {
    category: 'mods',
    data: {
      function: 'checkDependencyCompatibility',
      dependenciesCount: dependencies ? dependencies.length : 0,
      mainModId,
      hasFreshInstalledInfo: !!freshInstalledInfo
    }
  });
  
  const issues = [];
  
  // Skip if no dependencies
  if (!dependencies || dependencies.length === 0) {
    logger.debug('No dependencies to check', {
      category: 'mods',
      data: {
        function: 'checkDependencyCompatibility',
        dependencies
      }
    });
    return issues;
  }
  // Use fresh installed info if provided, otherwise get from store
  let installedInfo = freshInstalledInfo || get(installedModInfo);
  const updates = get(modsWithUpdates);
  const disabled = get(disabledMods); // Get the set of disabled mods
  const installedIds = new Set(installedInfo.map(info => info.projectId).filter(Boolean));
  
  logger.debug('Retrieved mod information for compatibility check', {
    category: 'mods',
    data: {
      function: 'checkDependencyCompatibility',
      installedModCount: installedInfo.length,
      updateCount: updates.size,
      disabledModCount: disabled.size,
      installedIdsCount: installedIds.size
    }
  });
  
  // First deduplicate dependencies by project ID to avoid showing the same dependency multiple times
  const uniqueDependencies = [];
  const seenProjectIds = new Set();
  
  // If we have a main mod ID, add it to seenProjectIds to avoid self-dependencies
  if (mainModId) {
    seenProjectIds.add(mainModId);
    logger.debug('Added main mod ID to avoid self-dependencies', {
      category: 'mods',
      data: {
        function: 'checkDependencyCompatibility',
        mainModId: mainModId
      }
    });
  }
  
  for (const dep of dependencies) {
    // Handle both project_id (from API) and projectId (from our normalized format)
    const projectId = dep.project_id || dep.projectId;
    
    // Skip if we've already seen this project ID or if it's undefined or if it's the main mod
    if (!projectId || seenProjectIds.has(projectId)) {
      continue;
    }
    
    seenProjectIds.add(projectId);
    uniqueDependencies.push(dep);
  }
  
  logger.debug('Deduplicated dependencies', {
    category: 'mods',
    data: {
      function: 'checkDependencyCompatibility',
      originalCount: dependencies.length,
      uniqueCount: uniqueDependencies.length,
      duplicatesRemoved: dependencies.length - uniqueDependencies.length
    }
  });  
  // Process each unique dependency
  for (const dep of uniqueDependencies) {
    // Handle both project_id (from API) and projectId (from our normalized format)
    const projectId = dep.project_id || dep.projectId;
    const dependencyType = dep.dependency_type || dep.dependencyType;
    
    logger.debug('Processing dependency', {
      category: 'mods',
      data: {
        function: 'checkDependencyCompatibility',
        projectId: projectId,
        dependencyType: dependencyType,
        hasVersionRequirement: !!(dep.version_requirement || dep.versionRequirement)
      }
    });
    
    // Try to get a better name for the dependency if it doesn't have one
    let name = dep.name || null;
    
    // If no name, try to get it from the API
    if (!name && projectId) {
      try {        // First try to get mod info which has more details
        const modInfo = await safeInvoke('get-mod-info', {
          modId: projectId,
          source: 'modrinth'
        });
        
        if (modInfo && modInfo.title) {
          name = modInfo.title;
        } else {
          // Fallback to project info
          const projectInfo = await safeInvoke('get-project-info', {
            projectId: projectId,
            source: 'modrinth'
          });
          
          if (projectInfo && projectInfo.title) {
            name = projectInfo.title;
          }
        }
      } catch (error) {
        // Ignore errors when fetching project info - fallback to other methods
        logger.debug('Failed to fetch project info, using fallback methods', {
          category: 'network',
          data: {
            function: 'checkDependencyCompatibility',
            error: error.message,
            context: 'projectInfoFallback',
            projectId: projectId,
            errorType: error.constructor.name
          }
        });
      }
    }
    
    // If still no name, see if it's already installed
    if (!name && projectId) {
      const installedMod = installedInfo.find(info => info.projectId === projectId);
      if (installedMod && installedMod.name) {
        name = installedMod.name;
      }
    }
    
    // If still no name, use a placeholder
    if (!name) {
      // Use a clean, generic name without exposing IDs in the UI
      name = 'Required Dependency';
    }
    
    // Check if this is a required dependency
    if (projectId && (dependencyType === 'required' || dependencyType === 'dependency_type')) {
      // Explicitly check if this mod is installed using the installedIds Set
      const isInstalled = installedIds.has(projectId);
      
      // Find the installed mod info if it exists
      const installedMod = installedInfo.find(info => info.projectId === projectId);
      
      // Check if the mod is disabled
      const isDisabled = installedMod && disabled.has(installedMod.fileName);
      
      // If the mod is not installed, it's a missing dependency
      if (!isInstalled) {
        logger.debug('Found missing required dependency', {
          category: 'mods',
          data: {
            function: 'checkDependencyCompatibility',
            projectId: projectId,
            dependencyName: name,
            versionRequirement: dep.version_requirement || dep.versionRequirement
          }
        });
        
        // Handle missing dependency - create a dependency issue
        const missingIssue = {
          type: 'missing',
          dependency: {
            projectId: projectId,
            name: name,
            dependencyType: 'required', // Always required for missing dependencies
            // Store version requirements for installation
            versionRequirement: dep.version_requirement || dep.versionRequirement
          },
          requiredVersion: dep.version_requirement || dep.versionRequirement,
          message: `Required dependency not installed`
        };
        
        // Try to get available versions
        try {
          const versions = await safeInvoke('get-mod-versions', {
            modId: projectId,
            source: 'modrinth'
          });
          
          if (versions && versions.length > 0) {
            // Sort versions by date (newest first)
            const sortedVersions = [...versions].sort((a, b) => {
              const dateA = a.datePublished ? new Date(a.datePublished).getTime() : 0;
              const dateB = b.datePublished ? new Date(b.datePublished).getTime() : 0;
              return dateB - dateA;
            });
            
            // Find latest version
            const latestVersion = sortedVersions[0].versionNumber;
            
            // Find required version based on version requirement
            let requiredVersionNumber = null;
            
            if (dep.version_requirement || dep.versionRequirement) {
              const requirement = dep.version_requirement || dep.versionRequirement;
              
              for (const version of sortedVersions) {
                if (checkVersionCompatibility(version.versionNumber, requirement)) {
                  requiredVersionNumber = version.versionNumber;
                  break;
                }
              }
              
              // Update the issue with version info
              missingIssue.requiredVersion = requiredVersionNumber || requirement;
              missingIssue.latestVersion = latestVersion;
              
              // Add info about version to be installed to the message
              if (requiredVersionNumber) {
                if (requiredVersionNumber !== latestVersion) {
                  missingIssue.versionInfo = `${requiredVersionNumber} (latest: ${latestVersion})`;
                } else {
                  missingIssue.versionInfo = `${requiredVersionNumber}`;
                }
              } else {
                missingIssue.versionInfo = `Requirement: ${requirement}`;
              }            } else {
              // No specific requirement, will install latest              missingIssue.requiredVersion = latestVersion;
              missingIssue.latestVersion = latestVersion;
              missingIssue.versionInfo = `${latestVersion}`;
            }
          }
        } catch (error) {
          // Ignore errors when fetching version info - continue without version details
          logger.debug('Failed to fetch version info, continuing without version details', {
            category: 'network',
            data: {
              function: 'checkDependencyCompatibility',
              error: error.message,
              context: 'versionInfoFallback',
              projectId: projectId,
              errorType: error.constructor.name
            }
          });
        }
        
        issues.push(missingIssue);
      } 
      // If the mod IS installed but disabled, add a disabled issue
      else if (isDisabled) {
        logger.debug('Found disabled required dependency', {
          category: 'mods',
          data: {
            function: 'checkDependencyCompatibility',
            projectId: projectId,
            dependencyName: name,
            fileName: installedMod?.fileName
          }
        });
        
        const disabledIssue = {
          type: 'disabled',
          dependency: {
            projectId: projectId,
            name: name,
            dependencyType: 'required',
            versionRequirement: dep.version_requirement || dep.versionRequirement
          },
          requiredVersion: dep.version_requirement || dep.versionRequirement,
          message: `Required dependency is installed but disabled`
        };
        issues.push(disabledIssue);
      }
      // If the mod IS installed and enabled, check for version compatibility
      else if (installedMod) {
        // The dependency is installed, check if the version matches requirements
        const versionRequirement = dep.version_requirement || dep.versionRequirement;
        
        if (versionRequirement && installedMod.versionNumber) {
          const isCompatible = checkVersionCompatibility(installedMod.versionNumber, versionRequirement);
          
          logger.debug('Checked version compatibility for installed dependency', {
            category: 'mods',
            data: {
              function: 'checkDependencyCompatibility',
              projectId: projectId,
              dependencyName: name,
              installedVersion: installedMod.versionNumber,
              versionRequirement: versionRequirement,
              isCompatible: isCompatible
            }
          });
          
          if (!isCompatible) {
            // For version mismatch issues, ALWAYS use the installed mod's proper name
            let displayName = installedMod.name;
            
            // If we don't have a name from installedMod, try harder to get one
            if (!displayName || displayName === 'Required Dependency') {
              try {
                // Try to get a better name from Modrinth
                const projectInfo = await safeInvoke('get-project-info', {
                  projectId: projectId,
                  source: 'modrinth'
                });
                
                if (projectInfo && projectInfo.title) {
                  displayName = projectInfo.title;                } else {
                  // If we still don't have a name, use a more descriptive fallback
                  displayName = `Installed Mod (needs update)`;
                }
              } catch {
                displayName = `Installed Mod (needs update)`;
              }
            }
            
            // Try to determine which version would be compatible
            let compatibleVersion = null;
            
            try {
              const versions = await safeInvoke('get-mod-versions', {
                modId: projectId,
                source: 'modrinth'
              });
              
              if (versions && versions.length > 0) {
                // Sort versions by date (newest first)
                const sortedVersions = [...versions].sort((a, b) => {
                  const dateA = a.datePublished ? new Date(a.datePublished).getTime() : 0;
                  const dateB = b.datePublished ? new Date(b.datePublished).getTime() : 0;
                  return dateB - dateA;
                });
                  // Find most recent compatible version
                for (const version of sortedVersions) {
                  if (checkVersionCompatibility(version.versionNumber, versionRequirement)) {
                    compatibleVersion = version.versionNumber;
                    break;
                  }
                }
              }
            } catch (error) {
              // Ignore errors when fetching version info - continue with version mismatch detection
              logger.debug('Failed to fetch version info for mismatch detection', {
                category: 'network',
                data: {
                  function: 'checkDependencyCompatibility',
                  error: error.message,
                  context: 'versionMismatchDetection',
                  projectId: projectId,
                  errorType: error.constructor.name
                }
              });
            }
            
            // Version mismatch - the installed version doesn't meet requirements
            logger.debug('Found version mismatch for dependency', {
              category: 'mods',
              data: {
                function: 'checkDependencyCompatibility',
                projectId: projectId,
                dependencyName: displayName,
                installedVersion: installedMod.versionNumber,
                requiredVersion: versionRequirement,
                compatibleVersion: compatibleVersion
              }
            });
            
            issues.push({
              type: 'version_mismatch',
              dependency: {
                projectId: projectId,
                name: displayName,
                dependencyType: 'compatibility',
                currentVersionId: installedMod.versionId,
                versionRequirement: versionRequirement,
                installedVersion: installedMod.versionNumber,
                targetVersion: compatibleVersion || versionRequirement
              },
              installedVersion: installedMod.versionNumber,
              requiredVersion: versionRequirement,
              targetVersion: compatibleVersion || versionRequirement,
              versionInfo: `${installedMod.versionNumber} → ${compatibleVersion || versionRequirement}`,
              message: `Version ${installedMod.versionNumber} needs to be updated to ${compatibleVersion || versionRequirement}`
            });
          }
        }
        
        // Check if there's an update that might be useful
        const updateInfo = updates.get(`project:${projectId}`);
        
        if (updateInfo) {
          // Only suggest updates if they don't conflict with version requirements
          const updateCompatible = !versionRequirement || checkVersionCompatibility(updateInfo.versionNumber, versionRequirement);
          
          logger.debug('Checked update availability for dependency', {
            category: 'mods',
            data: {
              function: 'checkDependencyCompatibility',
              projectId: projectId,
              dependencyName: name,
              currentVersion: installedMod.versionNumber,
              updateVersion: updateInfo.versionNumber,
              updateCompatible: updateCompatible
            }
          });
          
          if (updateCompatible) {
            issues.push({
              type: 'update_available',
              dependency: {
                projectId: projectId,
                name: name,
                dependencyType: 'optional',
                versionRequirement: versionRequirement
              },
              installedVersion: installedMod.versionNumber,
              updateVersion: updateInfo.versionNumber,
              versionInfo: `${installedMod.versionNumber} → ${updateInfo.versionNumber}`,
              message: `Update available: ${installedMod.versionNumber} → ${updateInfo.versionNumber}`
            });
          }
        }
      }
    }
  }
  
  logger.info('Dependency compatibility check completed', {
    category: 'mods',
    data: {
      function: 'checkDependencyCompatibility',
      issuesFound: issues.length,
      issueTypes: issues.reduce((acc, issue) => {
        acc[issue.type] = (acc[issue.type] || 0) + 1;
        return acc;
      }, {})
    }
  });
  
  return issues;
}

/**
 * Check if a version meets a version requirement
 * @param {string} currentVersion - Current installed version
 * @param {string} requirement - Version requirement (e.g. ">=1.0.0", "1.2.3")
 * @returns {boolean} - Whether the version is compatible
 */
export function checkVersionCompatibility(currentVersion, requirement) {
  logger.debug('Checking version compatibility', {
    category: 'mods',
    data: {
      function: 'checkVersionCompatibility',
      currentVersion,
      requirement
    }
  });
  
  // No requirement means any version is fine
  if (!requirement) {
    logger.debug('No requirement specified, version is compatible', {
      category: 'mods',
      data: {
        function: 'checkVersionCompatibility',
        currentVersion,
        result: true
      }
    });
    return true;
  }
  
  // Exact match
  if (currentVersion === requirement) {
    logger.debug('Exact version match found', {
      category: 'mods',
      data: {
        function: 'checkVersionCompatibility',
        currentVersion,
        requirement,
        result: true
      }
    });
    return true;
  }
  
  // Handle version ranges
  if (requirement.startsWith('>=')) {
    const minVersion = requirement.substring(2);
    const result = compareVersions(currentVersion, minVersion) >= 0;
    
    logger.debug('Version compatibility check: greater than or equal', {
      category: 'mods',
      data: {
        function: 'checkVersionCompatibility',
        currentVersion,
        minVersion,
        result,
        operator: '>='
      }
    });
    
    return result;
  }
  
  if (requirement.startsWith('>')) {
    const minVersion = requirement.substring(1);
    const result = compareVersions(currentVersion, minVersion) > 0;
    
    logger.debug('Version compatibility check: greater than', {
      category: 'mods',
      data: {
        function: 'checkVersionCompatibility',
        currentVersion,
        minVersion,
        result,
        operator: '>'
      }
    });
    
    return result;
  }
  
  if (requirement.startsWith('<=')) {
    const maxVersion = requirement.substring(2);
    const result = compareVersions(currentVersion, maxVersion) <= 0;
    
    logger.debug('Version compatibility check: less than or equal', {
      category: 'mods',
      data: {
        function: 'checkVersionCompatibility',
        currentVersion,
        maxVersion,
        result,
        operator: '<='
      }
    });
    
    return result;
  }
  
  if (requirement.startsWith('<')) {
    const maxVersion = requirement.substring(1);
    const result = compareVersions(currentVersion, maxVersion) < 0;
    
    logger.debug('Version compatibility check: less than', {
      category: 'mods',
      data: {
        function: 'checkVersionCompatibility',
        currentVersion,
        maxVersion,
        result,
        operator: '<'
      }
    });
    
    return result;
  }
  
  // Handle version range with tilde (~)
  if (requirement.startsWith('~')) {
    const baseVersion = requirement.substring(1);
    const parts = baseVersion.split('.');
    
    // ~1.2.3 means >= 1.2.3 and < 1.3.0
    if (parts.length >= 3) {
      const minVersion = baseVersion;
      const maxParts = [...parts];
      maxParts[1] = String(parseInt(maxParts[1]) + 1);
      maxParts[2] = '0';
      const maxVersion = maxParts.join('.');
      
      const result = compareVersions(currentVersion, minVersion) >= 0 && 
                     compareVersions(currentVersion, maxVersion) < 0;
      
      logger.debug('Version compatibility check: tilde range', {
        category: 'mods',
        data: {
          function: 'checkVersionCompatibility',
          currentVersion,
          baseVersion,
          minVersion,
          maxVersion,
          result,
          operator: '~'
        }
      });
      
      return result;
    }
    
    // Default to exact match if format not recognized
    const result = currentVersion === baseVersion;
    
    logger.debug('Version compatibility check: tilde fallback to exact', {
      category: 'mods',
      data: {
        function: 'checkVersionCompatibility',
        currentVersion,
        baseVersion,
        result,
        operator: '~ (fallback)'
      }
    });
    
    return result;
  }
  
  // Handle version range with caret (^)
  if (requirement.startsWith('^')) {
    const baseVersion = requirement.substring(1);
    const parts = baseVersion.split('.');
    
    // ^1.2.3 means >= 1.2.3 and < 2.0.0
    if (parts.length >= 3) {
      const minVersion = baseVersion;
      const maxParts = [...parts];
      maxParts[0] = String(parseInt(maxParts[0]) + 1);
      maxParts[1] = '0';
      maxParts[2] = '0';
      const maxVersion = maxParts.join('.');
      
      const result = compareVersions(currentVersion, minVersion) >= 0 && 
                     compareVersions(currentVersion, maxVersion) < 0;
      
      logger.debug('Version compatibility check: caret range', {
        category: 'mods',
        data: {
          function: 'checkVersionCompatibility',
          currentVersion,
          baseVersion,
          minVersion,
          maxVersion,
          result,
          operator: '^'
        }
      });
      
      return result;
    }
    
    // Default to exact match if format not recognized
    const result = currentVersion === baseVersion;
    
    logger.debug('Version compatibility check: caret fallback to exact', {
      category: 'mods',
      data: {
        function: 'checkVersionCompatibility',
        currentVersion,
        baseVersion,
        result,
        operator: '^ (fallback)'
      }
    });
    
    return result;
  }
  
  // Fallback - assume we need an exact match
  const result = currentVersion === requirement;
  
  logger.debug('Version compatibility check completed', {
    category: 'mods',
    data: {
      function: 'checkVersionCompatibility',
      currentVersion,
      requirement,
      result,
      method: 'exact_match_fallback'
    }
  });
  
  return result;
}

/**
 * Simple version comparison function
 * @param {string} versionA - First version to compare
 * @param {string} versionB - Second version to compare
 * @returns {number} - Negative if A < B, positive if A > B, 0 if equal
 */
function compareVersions(versionA, versionB) {
  const partsA = versionA.split('.').map(p => parseInt(p, 10) || 0);
  const partsB = versionB.split('.').map(p => parseInt(p, 10) || 0);
  
  const length = Math.max(partsA.length, partsB.length);
  
  for (let i = 0; i < length; i++) {
    const a = i < partsA.length ? partsA[i] : 0;
    const b = i < partsB.length ? partsB[i] : 0;
    
    if (a !== b) {
      return a - b;
    }
  }
  
  return 0;
}

/**
 * Check client-side mod compatibility with a new Minecraft version
 * @param {string} newMinecraftVersion - The new Minecraft version to check against
 * @param {Array} clientMods - Array of client-side mods to check
 * @returns {Promise<Object>} - Compatibility report with incompatible mods and suggestions
 */
export async function checkClientModCompatibility(newMinecraftVersion, clientMods = []) {
  logger.info('Checking client mod compatibility', {
    category: 'mods',
    data: {
      function: 'checkClientModCompatibility',
      newMinecraftVersion,
      clientModsCount: clientMods ? clientMods.length : 0
    }
  });
  
  const compatibilityReport = {
    compatible: [],
    incompatible: [],
    needsUpdate: [],
    unknown: [],
    hasIncompatible: false,
    hasUpdatable: false
  };
  
  if (!clientMods || clientMods.length === 0) {
    logger.debug('No client mods to check', {
      category: 'mods',
      data: {
        function: 'checkClientModCompatibility',
        newMinecraftVersion,
        clientMods
      }
    });
    return compatibilityReport;
  }
  
  for (const mod of clientMods) {
    try {
      logger.debug('Processing client mod for compatibility', {
        category: 'mods',
        data: {
          function: 'checkClientModCompatibility',
          modName: mod.name || mod.fileName,
          modId: mod.projectId,
          disabled: mod.disabled,
          hasGameVersions: !!(mod.gameVersions?.length)
        }
      });
      
      // Skip if mod is disabled
      if (mod.disabled) {
        logger.debug('Skipping disabled mod', {
          category: 'mods',
          data: {
            function: 'checkClientModCompatibility',
            modName: mod.name || mod.fileName
          }
        });
        continue;
      }
      
      // Check if mod has version requirements
      if (mod.gameVersions && mod.gameVersions.length > 0) {
        const isCompatible = mod.gameVersions.includes(newMinecraftVersion);
        
        if (isCompatible) {
          logger.debug('Mod is compatible with new Minecraft version', {
            category: 'mods',
            data: {
              function: 'checkClientModCompatibility',
              modName: mod.name || mod.fileName,
              newMinecraftVersion: newMinecraftVersion,
              supportedVersions: mod.gameVersions
            }
          });
          
          compatibilityReport.compatible.push({
            ...mod,
            compatibilityStatus: 'compatible'
          });
        } else {
          // Check if there's an update available for the new version
          let hasUpdate = false;
          
          if (mod.projectId) {
            try {
              // Check for updates that support the new Minecraft version
              const updateCheck = await safeInvoke('check-mod-updates', {
                projectId: mod.projectId,
                currentVersion: mod.version,
                gameVersion: newMinecraftVersion,
                source: mod.source || 'modrinth'
              });
              
              if (updateCheck && updateCheck.hasUpdate && updateCheck.latestVersion) {
                hasUpdate = true;                compatibilityReport.needsUpdate.push({
                  ...mod,
                  compatibilityStatus: 'needs_update',
                  availableUpdate: updateCheck.latestVersion,
                  updateUrl: updateCheck.downloadUrl
                });
                compatibilityReport.hasUpdatable = true;
              }
            } catch (error) {
              // Ignore errors when checking for mod updates - continue with compatibility analysis
              logger.debug('Failed to check for mod updates during compatibility analysis', {
                category: 'network',
                data: {
                  function: 'checkClientModCompatibility',
                  error: error.message,
                  context: 'modUpdateCheck',
                  projectId: mod.projectId,
                  errorType: error.constructor.name
                }
              });
            }
          }
          
          if (!hasUpdate) {
            logger.debug('Mod is incompatible with new Minecraft version', {
              category: 'mods',
              data: {
                function: 'checkClientModCompatibility',
                modName: mod.name || mod.fileName,
                newMinecraftVersion: newMinecraftVersion,
                supportedVersions: mod.gameVersions
              }
            });
            
            compatibilityReport.incompatible.push({
              ...mod,
              compatibilityStatus: 'incompatible',
              reason: `Does not support Minecraft ${newMinecraftVersion}. Supported versions: ${mod.gameVersions.join(', ')}`
            });
            compatibilityReport.hasIncompatible = true;
          }
        }
      } else {
        // No version information available - try filename-based checking
        const filenameCompatibility = checkModCompatibilityFromFilename(mod.fileName || '', newMinecraftVersion);
        
        logger.debug('Using filename-based compatibility check', {
          category: 'mods',
          data: {
            function: 'checkClientModCompatibility',
            modName: mod.name || mod.fileName,
            fileName: mod.fileName,
            isCompatible: filenameCompatibility.isCompatible,
            confidence: filenameCompatibility.confidence
          }
        });
        
        if (filenameCompatibility.isCompatible) {
          compatibilityReport.compatible.push({
            ...mod,
            compatibilityStatus: 'compatible',
            note: 'Compatibility determined from filename'
          });
        } else {
          compatibilityReport.unknown.push({
            ...mod,
            compatibilityStatus: 'unknown',
            reason: 'Unable to determine compatibility - manual verification recommended'
          });
        }
      }
    } catch (err) {
      logger.error(`Error checking mod compatibility: ${err.message}`, {
        category: 'mods',
        data: {
          function: 'checkClientModCompatibility',
          modName: mod.name || mod.fileName,
          modId: mod.projectId,
          errorType: err.constructor.name
        }
      });
      
      compatibilityReport.unknown.push({
        ...mod,
        compatibilityStatus: 'unknown',
        reason: `Error checking compatibility: ${err.message}`
      });
    }
  }
  
  logger.info('Client mod compatibility check completed', {
    category: 'mods',
    data: {
      function: 'checkClientModCompatibility',
      newMinecraftVersion,
      compatibleCount: compatibilityReport.compatible.length,
      incompatibleCount: compatibilityReport.incompatible.length,
      needsUpdateCount: compatibilityReport.needsUpdate.length,
      unknownCount: compatibilityReport.unknown.length,
      hasIncompatible: compatibilityReport.hasIncompatible,
      hasUpdatable: compatibilityReport.hasUpdatable
    }
  });
  
  return compatibilityReport;
}

/**
 * Check mod compatibility based on filename
 * @param {string} filename - The mod filename
 * @param {string} minecraftVersion - Target Minecraft version
 * @returns {Object} - Compatibility result
 */
function checkModCompatibilityFromFilename(filename, minecraftVersion) {
  logger.debug('Checking mod compatibility from filename', {
    category: 'mods',
    data: {
      function: 'checkModCompatibilityFromFilename',
      filename,
      minecraftVersion
    }
  });
  
  if (!filename || !minecraftVersion) {
    logger.debug('Invalid filename or version for compatibility check', {
      category: 'mods',
      data: {
        function: 'checkModCompatibilityFromFilename',
        filename,
        minecraftVersion,
        result: { isCompatible: false, confidence: 'low' }
      }
    });
    return { isCompatible: false, confidence: 'low' };
  }
  
  const lowerFilename = filename.toLowerCase();
  const versionPattern = /(\d+\.\d+(?:\.\d+)?)/g;
  const matches = lowerFilename.match(versionPattern);
  
  if (!matches) {
    return { isCompatible: false, confidence: 'low' };
  }
  
  // Check if the target Minecraft version appears in the filename
  for (const match of matches) {
    if (match === minecraftVersion || minecraftVersion.startsWith(match)) {
      return { isCompatible: true, confidence: 'medium' };
    }
  }
  
  const result = { isCompatible: false, confidence: 'medium' };
  
  logger.debug('Filename compatibility check completed', {
    category: 'mods',
    data: {
      function: 'checkModCompatibilityFromFilename',
      filename,
      minecraftVersion,
      result,
      foundMatches: matches
    }
  });
  
  return result;
}