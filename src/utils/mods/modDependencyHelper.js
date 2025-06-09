/**
 * Utilities for managing mod dependencies
 */
import { safeInvoke } from '../ipcUtils.js';
import { get } from 'svelte/store';
import {
  installedModIds,
  currentDependencies,
  dependencyModalOpen,
  modToInstall,
  installingModIds,
  successMessage,
  errorMessage,
  installedModInfo,
  loaderType,
  minecraftVersion,
  disabledMods
} from '../../stores/modStore.js';
import { installMod } from './modAPI.js';
import { checkVersionCompatibility } from './modCompatibility.js';

/**
 * Determine if the given project ID refers to Minecraft itself
 * This normalizes the ID by removing non-letter characters so values
 * like "minecraft", "com.mojang:minecraft" and "net.minecraft" match.
 * @param {string} id - Project ID to test
 * @returns {boolean} - True if the ID represents Minecraft
 */
function isMinecraftProjectId(id) {
  if (!id) return false;
  const canonical = String(id).toLowerCase().replace(/[^a-z]/g, '');
  return canonical === 'minecraft';
}

/**
 * Determine if the project ID refers to a system dependency (like Java)
 * These are not mods but system requirements and should not be looked up on Modrinth.
 * @param {string} id - Project ID to test
 * @returns {boolean} - True if the ID represents a system dependency
 */
function isSystemDependency(id) {
  if (!id) return false;
  const canonical = String(id).toLowerCase().replace(/[^a-z]/g, '');
  const systemDependencies = ['java', 'javafml', 'forge', 'fabricloader', 'quiltloader'];
  return systemDependencies.includes(canonical);
}

/**
 * Determine if the project ID refers to a Fabric API submodule or the loader
 * These modules are bundled with Fabric API or the loader and are not
 * standalone projects on Modrinth.
 * @param {string} id - Project ID
 * @returns {boolean}
 */
function isBundledFabricModule(id) {
  if (!id) return false;
  const canonical = String(id).toLowerCase();
  if (canonical === 'fabricloader') return true;
  if (canonical === 'fabric-api') return false;
  return /^fabric-.*-v\d+$/.test(canonical);
}

/**
 * Check for a mod's dependencies
 * @param {Object} mod - The mod object
 * @returns {Promise<Array>} - Array of dependency objects
 */
export async function checkModDependencies(mod, visited = new Set()) {
  try {
    if (!mod || !mod.id) {
      return [];
    }
    
    // Avoid infinite recursion by checking visited mods
    if (visited.has(mod.id)) {
      return [];
    }
    visited.add(mod.id);
    
    
    // Initialize an array to collect all dependencies from various sources
    const allDependencies = [];
    let isFabricMod = false;
    
    // FIRST ATTEMPT: Try getting dependencies from the API
    try {
      const versionId = mod.selectedVersionId;
      let versionInfo;
      
      // If we don't have a selected version ID, get the latest version info
      if (!versionId) {
        // Get the detailed version info for the latest version
        versionInfo = await safeInvoke('get-version-info', {
          modId: mod.id,
          source: mod.source || 'modrinth',
          loader: get(loaderType),
          gameVersion: get(minecraftVersion)
        });
      } else {
        // Get specific version info
        versionInfo = await safeInvoke('get-version-info', {
          modId: mod.id,
          versionId,
          source: mod.source || 'modrinth',
          loader: get(loaderType),
          gameVersion: get(minecraftVersion)
        });
      }
      
      // Check if we got valid version info
      if (versionInfo) {
        
        // Check if this is a Fabric mod
        if (versionInfo.loaders && Array.isArray(versionInfo.loaders)) {
          isFabricMod = versionInfo.loaders.includes('fabric');
        }
        
        // METHOD 1: Standard dependencies array
        if (versionInfo.dependencies && Array.isArray(versionInfo.dependencies)) {
          allDependencies.push(...versionInfo.dependencies);
        }
        
        // METHOD 2: Check 'depends' property (older Modrinth API format)
        if (versionInfo.depends && Array.isArray(versionInfo.depends)) {
          allDependencies.push(...versionInfo.depends.map(dep => ({
            ...dep,
            dependency_type: 'required' // Mark as required
          })));
        }
        
        // METHOD 3: Check 'required_dependencies' or 'required_mods' property
        if (versionInfo.required_dependencies && Array.isArray(versionInfo.required_dependencies)) {
          allDependencies.push(...versionInfo.required_dependencies.map(dep => {
            // Convert to standard format if it's just a string or ID
            if (typeof dep === 'string') {
              return {
                project_id: dep,
                dependency_type: 'required'
              };
            }
            return {
              ...dep,
              dependency_type: 'required'
            };
          }));
        }
        
        if (versionInfo.required_mods && Array.isArray(versionInfo.required_mods)) {
          allDependencies.push(...versionInfo.required_mods.map(dep => {
            // Convert to standard format if it's just a string or ID
            if (typeof dep === 'string') {
              return {
                project_id: dep,
                dependency_type: 'required'
              };
            }
            return {
              ...dep,
              dependency_type: 'required'
            };
          }));
        }
        
        // METHOD 4: Check if there's a 'game_versions' property with a 'requires' subproperty
        if (versionInfo.game_versions && Array.isArray(versionInfo.game_versions)) {
          for (const gameVersion of versionInfo.game_versions) {
            if (gameVersion.requires && Array.isArray(gameVersion.requires)) {
              allDependencies.push(...gameVersion.requires.map(dep => ({
                ...dep,
                dependency_type: 'required'
              })));
            }
          }
        }
        
        // METHOD 5: Check for 'relationships' property (used by some API formats)
        if (versionInfo.relationships && typeof versionInfo.relationships === 'object') {
          const relationships = versionInfo.relationships;
          if (relationships.dependencies && Array.isArray(relationships.dependencies)) {
            allDependencies.push(...relationships.dependencies.map(dep => ({
              project_id: dep.id || dep.project_id || dep.slug,
              dependency_type: 'required'
            })));
          }
          if (relationships.required && Array.isArray(relationships.required)) {
            allDependencies.push(...relationships.required.map(dep => ({
              project_id: dep.id || dep.project_id || dep.slug,
              dependency_type: 'required'
            })));
          }
        }
        
        // METHOD 6: Check custom 'metadata' property that some mods might use
        if (versionInfo.metadata && typeof versionInfo.metadata === 'object') {
          const metadata = versionInfo.metadata;
          
          if (metadata.dependencies && Array.isArray(metadata.dependencies)) {
            allDependencies.push(...metadata.dependencies.map(dep => {
              // Handle both object format and string format
              if (typeof dep === 'string') {
                return {
                  project_id: dep,
                  dependency_type: 'required'
                };
              }
              return {
                ...dep,
                dependency_type: dep.required === true ? 'required' : (dep.type || 'optional')
              };
            }));
          }
        }
        
        // Save the downloadUrl for potential later analysis
        if (versionInfo.files && versionInfo.files.length > 0) {
          mod.downloadUrl = versionInfo.files[0].url;
        }
      }
    } catch (apiError) {
      // Only log as error if it's not a 404 (which can be normal)
      if (apiError.message && apiError.message.includes('404')) {
      } else {
      }
    }
    
    // SECOND ATTEMPT: If we couldn't find dependencies through API, try to analyze installed file
    if (allDependencies.length === 0) {
      
      try {
        // Check if this mod is already installed, and ask backend to analyze its JAR file
        const installedModsInfo = get(installedModInfo);
        const installedMod = installedModsInfo.find(info => info.projectId === mod.id);
        
        if (installedMod && installedMod.fileName) {
          
          // Ask the backend to analyze the installed JAR file
          const jarDeps = await safeInvoke('extract-jar-dependencies', installedMod.filePath);
          
          if (jarDeps && jarDeps.length > 0) {
            // Resolve any slug-based IDs to actual project IDs and names
            for (const dep of jarDeps) {
              let pid = dep.id;
              let depName = null;
              try {
                const projectInfo = await safeInvoke('get-project-info', { projectId: dep.id, source: 'modrinth' });
                if (projectInfo?.id) pid = projectInfo.id;
                if (projectInfo?.title) depName = projectInfo.title;
              } catch (err) {
              }
              allDependencies.push({
                project_id: pid,
                dependency_type: dep.dependency_type,
                version_requirement: dep.version_requirement,
                name: depName
              });
            }
          }
          
          // Check if this is a Fabric mod based on the filename
          if (installedMod.fileName.toLowerCase().includes('fabric')) {
            isFabricMod = true;
          }
        }
        // If mod isn't installed but we have a URL, ask backend to analyze it
        else if (mod.downloadUrl) {
          
          // Ask the backend to download and analyze the JAR
          const jarDeps = await safeInvoke('analyze-mod-from-url', {
            url: mod.downloadUrl,
            modId: mod.id
          });
          
          if (jarDeps && jarDeps.length > 0) {
            // Resolve any slug-based IDs to actual project IDs and names
            for (const dep of jarDeps) {
              let pid = dep.id;
              let depName = null;
              try {
                const projectInfo = await safeInvoke('get-project-info', { projectId: dep.id, source: 'modrinth' });
                if (projectInfo?.id) pid = projectInfo.id;
                if (projectInfo?.title) depName = projectInfo.title;
              } catch (err) {
              }
              allDependencies.push({
                project_id: pid,
                dependency_type: dep.dependency_type,
                version_requirement: dep.version_requirement,
                name: depName
              });
            }
          }
        }
      } catch (jarError) {
      }
    }
    
    
    // SPECIAL CASE: If this is a Fabric mod, ensure Fabric API is included (unless installing Fabric API itself)
    if (isFabricMod) {
      try {
        // Fetch real Fabric API project info by slug
        const fapiInfo = await safeInvoke('get-project-info', { projectId: 'fabric-api', source: 'modrinth' });
        const fapiId = fapiInfo.id;
        const fapiName = fapiInfo.title || 'Fabric API';
        // Only inject if we're not installing Fabric API itself
        if (mod.id !== fapiId) {
          const hasFapi = allDependencies.some(dep => dep.project_id === fapiId);
          if (!hasFapi) {
            allDependencies.push({
              project_id: fapiId,
              dependency_type: 'required',
              name: fapiName
            });
          }
        }
      } catch (err) {
      }
    }
    
    // Process the combined dependencies to normalize them
    const processedDependencies = allDependencies.map(dep => {
      // If dependency_type is missing, try to infer it from other properties
      if (!dep.dependency_type && !dep.dependencyType) {
        
        // If there's a 'required' property that's true, mark as required
        if (dep.required === true) {
          dep.dependency_type = 'required';
        }
        
        // If there's a 'type' property with value 'required', mark as required
        else if (dep.type === 'required' || dep.type === 'depends') {
          dep.dependency_type = 'required';
        }
        
        // Default to 'required' for safety if we can't determine
        else {
          dep.dependency_type = 'required';
        }
      }
      
      return dep;
    });
    
    // Filter out duplicate dependencies by project_id
    const uniqueDeps = [];
    const processedIds = new Set();
    
    for (const dep of processedDependencies) {
      const projectId = dep.project_id || dep.projectId;
      if (projectId && !processedIds.has(projectId)) {
        processedIds.add(projectId);
        uniqueDeps.push(dep);
      }
    }
    
    
    if (uniqueDeps.length === 0) {
      return [];
    }
      // Remove self-dependency entries
    const filteredDeps = uniqueDeps.filter(dep => {
      const depId = dep.project_id || dep.projectId;
      if (depId === mod.id) {
        return false; // remove self dependencies
      }
      if (isMinecraftProjectId(depId)) {
        return false;
      }
      if (isSystemDependency(depId)) {
        return false;
      }
      if (isBundledFabricModule(depId)) {
        return false;
      }
      return true;
    });

    if (filteredDeps.length === 0) {
      return [];
    }
    

    
    // Resolve direct dependencies
    const directDeps = await filterAndResolveDependencies(filteredDeps);
    // Recursively check dependencies of each dependency
    const allDeps = [...directDeps];
    for (const dep of directDeps) {
      const nestedDeps = await checkModDependencies({ id: dep.projectId, selectedVersionId: null, source: mod.source || 'modrinth' }, visited);
      for (const nested of nestedDeps) {
        if (!allDeps.find(d => d.projectId === nested.projectId)) {
          allDeps.push(nested);
        }
      }
    }
    return allDeps;
  } catch (error) {
    return [];
  }
}

/**
 * Filter dependencies that are required and not installed, then resolve their names
 * @param {Array} dependencies - Raw dependencies from API
 * @returns {Promise<Array>} - Filtered and resolved dependencies
 */
async function filterAndResolveDependencies(dependencies) {
  const installedIds = get(installedModIds);
  const disabled = get(disabledMods); // Get the set of disabled mods
  
  
  // Get the actual installed mod info to double-check physical installation
  const actualInstalledInfo = get(installedModInfo);
  const actualInstalledIds = new Set(actualInstalledInfo.map(info => info.projectId));
  
  
  // Convert dependencies to standard format to handle different API response formats
  const normalizedDeps = dependencies
    .map(dep => ({
      project_id: dep.project_id || dep.projectId,
      dependency_type: dep.dependency_type || dep.dependencyType || 'required',
      name: dep.name || null,
      version_requirement: dep.version_requirement || dep.versionRequirement || null
    }))    // Skip entries that refer to Minecraft, system dependencies, or bundled Fabric modules
    .filter(dep => {
      if (isMinecraftProjectId(dep.project_id)) {
        return false;
      }
      if (isSystemDependency(dep.project_id)) {
        return false;
      }
      if (isBundledFabricModule(dep.project_id)) {
        return false;
      }
      return true;
    });
  
  
  // Filter for required dependencies that are not already installed and enabled
  const requiredDeps = normalizedDeps.filter(dep => {
    const isRequired = dep.dependency_type === 'required';
    const installedMod = actualInstalledInfo.find(info => info.projectId === dep.project_id);
    const isPhysicallyInstalled = !!installedMod;
    const isDisabled = installedMod && disabled.has(installedMod.fileName);
    const isInstalledAndEnabled = isPhysicallyInstalled && !isDisabled;
    
    return isRequired && !isInstalledAndEnabled;
  });
  
  
  if (requiredDeps.length === 0) {
    return [];
  }
  
  // Debug logging
  
  // Resolve dependency names and versions
  const resolvedDeps = await Promise.all(requiredDeps.map(async (dep) => {
    let name = dep.name;
    let versionInfo = '';
    let versionToInstall = '';
    let latestVersion = '';
    
    try {
      // Fetch project info to get the name and available versions
      const projectInfo = await safeInvoke('get-project-info', {
        projectId: dep.project_id,
        source: 'modrinth'
      });
      
      if (projectInfo && projectInfo.title) {
        name = projectInfo.title;
      }
      
      // Get available versions for this dependency
      const loader = get(loaderType);
      const mcVersion = get(minecraftVersion);
      const versions = await safeInvoke('get-mod-versions', {
        modId: dep.project_id,
        source: 'modrinth',
        loader,
        mcVersion
      });
      
      if (versions && versions.length > 0) {
        // Sort versions by date (newest first)
        const sortedVersions = [...versions].sort((a, b) => {
          const dateA = a.datePublished ? new Date(a.datePublished).getTime() : 0;
          const dateB = b.datePublished ? new Date(b.datePublished).getTime() : 0;
          return dateB - dateA;
        });
        
        // Find latest version
        latestVersion = sortedVersions[0].versionNumber;
        
        // Find compatible version based on version requirement
        if (dep.version_requirement) {
          for (const version of sortedVersions) {
            if (checkVersionCompatibility(version.versionNumber, dep.version_requirement)) {
              versionToInstall = version.versionNumber;
              break;
            }
          }
        } else {
          // If no specific requirement, will use latest
          versionToInstall = latestVersion;
        }
        
        // Create version info string
        if (versionToInstall) {
          if (versionToInstall !== latestVersion) {
            versionInfo = `v${versionToInstall} (latest: v${latestVersion})`;
          } else {
            versionInfo = `v${versionToInstall}`;
          }
        } else if (dep.version_requirement) {
          versionInfo = `Requirement: ${dep.version_requirement}`;
        }
      }
    } catch (error) {
      // Fall back to basic info if available
      if (!name && dep.project_id) {
        name = dep.project_id;
      }
      if (dep.version_requirement) {
        versionInfo = `Requirement: ${dep.version_requirement}`;
      }
    }
    
    // If we still don't have a name, use a generic one
    if (!name) {
      name = 'Required Dependency';
    }
    
    return {
      projectId: dep.project_id,
      name: name,
      dependencyType: dep.dependency_type,
      versionRequirement: dep.version_requirement,
      versionInfo: versionInfo
    };
  }));
  
  return resolvedDeps;
}

/**
 * Show dependency confirmation modal
 * @param {Object} mod - Mod to install
 * @param {Array} dependencies - Dependencies
 */
export function showDependencyModal(mod, dependencies) {
  modToInstall.set(mod);
  currentDependencies.set(dependencies);
  dependencyModalOpen.set(true);
}

/**
 * Install a mod with its dependencies
 * @param {string} serverPath - Server path
 * @returns {Promise<boolean>} - True if successful
 */
export async function installWithDependencies(serverPath, installFn = installMod) {
  const mod = get(modToInstall);
  // Get and dedupe dependencies by projectId to avoid duplicate downloads
  const allDeps = get(currentDependencies);
  const seen = new Set();
  const dependencies = [];
  for (const dep of allDeps) {
    // Skip optional update suggestions; these are not required for
    // successful installation and should only be installed if the
    // user explicitly chooses to update later.
    if (dep.dependencyType === 'optional') {
      continue;
    }

    if (dep.projectId) {
      if (!seen.has(dep.projectId)) {
        seen.add(dep.projectId);
        dependencies.push(dep);
      }
    } else {
      dependencies.push(dep);
    }
  }
  const installedIds = get(installedModIds);
  
  // Get the actual installed mod info to double-check physical installation
  const actualInstalledInfo = get(installedModInfo);
  const actualInstalledIds = new Set(actualInstalledInfo.map(info => info.projectId));
  
  
  if (!mod) {
    return false;
  }
  
  try {
    successMessage.set('Installing dependencies...');
    let installedCount = 0;
    
    // Close the modal immediately once installation starts
    dependencyModalOpen.set(false);
    
    // Track which mods we're installing (by projectId) to avoid duplicates
    const modsToInstall = new Set();
    
    // Always add the main mod to our installation tracking
    if (mod.id) {
      modsToInstall.add(mod.id);
    }
    
    // Install dependencies first
    for (const dependency of dependencies) {
      try {
        // Check if this dependency is actually installed (physically exists)
        const isPhysicallyInstalled = dependency.projectId && actualInstalledIds.has(dependency.projectId);

        // Determine if installed dependency meets version requirement
        let skipDependency = false;
        if (dependency.projectId && isPhysicallyInstalled) {
          // Find installed mod info to get version
          const installedInfoEntry = actualInstalledInfo.find(info => info.projectId === dependency.projectId);
          // Skip if no version requirement or installed version is compatible
          if (!dependency.versionRequirement || (installedInfoEntry && checkVersionCompatibility(installedInfoEntry.versionNumber, dependency.versionRequirement))) {
            skipDependency = true;
          } else {
          }
        }
        if (skipDependency) {
          continue;
        }
        
        // Skip if this dependency is the same as the main mod we're installing
        // or if it's already in our installation queue
        if (dependency.projectId && (
            dependency.projectId === mod.id || 
            modsToInstall.has(dependency.projectId)
          )) {
          continue;
        }
        
        // Add this dependency to our installation tracking
        if (dependency.projectId) {
          modsToInstall.add(dependency.projectId);
        }
        
        // Skip dependencies with generic names that might be incorrect
        if (dependency.name === 'Required Dependency' || dependency.name === 'Required_Dependency') {
          continue;
        }
        
        // Make sure we have a proper dependency name to avoid generic filenames
        let depName = dependency.name ? dependency.name.trim() : '';
        
        // Remove any parenthetical content, messages, or problematic text
        if (depName) {
          // Strip out any parenthetical content
          depName = depName.split('(')[0].trim();
          
          // Strip out any specific problematic phrases
          const phrasesToRemove = [
            'Required dependency not installed',
            'not installed',
            'Required dependency',
            'is not installed',
            'needs to be updated',
            'update available'
          ];
          
          for (const phrase of phrasesToRemove) {
            if (depName.includes(phrase)) {
              depName = depName.replace(phrase, '').trim();
            }
          }
          
          // Clean up any leftover punctuation
          depName = depName.replace(/[.:,;]+$/, '').trim();
        }
        
        // Skip dependencies with problematic names
        if (!depName || 
            depName === 'Required Dependency' || 
            depName === 'Required_Dependency' || 
            depName === 'Installed Mod' || 
            depName === 'Dependency' ||
            depName === 'Unknown Mod' ||
            depName === 'Unknown_Mod') {
          // Try to get a better name for the dependency
          try {
            const projectInfo = await safeInvoke('get-project-info', {
              projectId: dependency.projectId,
              source: 'modrinth'
            });
            
            if (projectInfo && projectInfo.title) {
              depName = projectInfo.title;
            } else if (dependency.projectId) {
              // If we can't get a name, use the project ID instead of a generic name
              depName = `mod-${dependency.projectId.substring(0, 8)}`;
            } else {
              // Skip dependencies without a proper name or ID
              continue;
            }
          } catch (error) {
            // Skip if we can't get proper identification
            continue;
          }
        }
        
        const depMod = {
          id: dependency.projectId,
          name: depName,
          source: 'modrinth',
          title: depName
        };
        
        // If there's a specific version requirement, handle it
        if (dependency.versionRequirement) {
          
          // Get all versions of this mod
          const loader = get(loaderType);
          const mcVersion = get(minecraftVersion);
          const versions = await safeInvoke('get-mod-versions', {
            modId: dependency.projectId,
            source: 'modrinth',
            loader,
            mcVersion
          });
          
          if (versions && versions.length > 0) {
            // Sort versions by release date (newest first)
            versions.sort((a, b) => {
              // Safely convert dates to timestamps, defaulting to 0 if invalid
              const dateA = a.datePublished ? new Date(a.datePublished).getTime() : 0;
              const dateB = b.datePublished ? new Date(b.datePublished).getTime() : 0;
              return dateB - dateA; // Descending order (newest first)
            });
            
            // Find the first version that meets the requirement
            let selectedVersion = null;
            
            // For version_mismatch issues, we may already have a specific version ID to install
            if (dependency.currentVersionId) {
              selectedVersion = versions.find(v => v.id === dependency.currentVersionId);
            } 
            
            // If we don't have a specific ID or couldn't find it, try to find a compatible version
            if (!selectedVersion) {
              for (const version of versions) {
                // Skip versions without version numbers
                if (!version.versionNumber) continue;
                
                // Check if this version meets the requirement
                if (checkVersionCompatibility(version.versionNumber, dependency.versionRequirement)) {
                  selectedVersion = version;
                  break;
                }
              }
            }
            
            // If we found a compatible version, use its ID
            if (selectedVersion) {
              depMod.selectedVersionId = selectedVersion.id;
            } else {
              // If no compatible version found, skip this dependency
              continue;
            }
          }
        }
        
        // Mark this dependency as being installed
        installingModIds.update(ids => {
          ids.add(dependency.projectId);
          return ids;
        });
        
        // Install the dependency
        await installFn(depMod, serverPath);
        installedCount++;
      } catch (depErr) {
        // Continue with other dependencies
      }
    }
    
    // Now install the main mod
    await installFn(mod, serverPath);
    
    // Update success message
    successMessage.set(`Installed ${mod.name} with ${installedCount} dependencies`);
    
    // Clear state
    modToInstall.set(null);
    currentDependencies.set([]);
    
    return true;
  } catch (error) {
    errorMessage.set(`Failed to install dependencies: ${error.message || 'Unknown error'}`);
    
    // Clean up installing state for all dependencies and main mod
    if (mod) {
      installingModIds.update(ids => {
        ids.delete(mod.id);
        return ids;
      });
    }
    
    for (const dependency of dependencies) {
      if (dependency.projectId) {
        installingModIds.update(ids => {
          ids.delete(dependency.projectId);
          return ids;
        });
      }
    }
    
    return false;
  }
} 