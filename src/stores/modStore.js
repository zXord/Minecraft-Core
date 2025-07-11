import { writable, derived, get } from 'svelte/store';
import { safeInvoke } from '../utils/ipcUtils.js';

// Create the writable stores
const installedMods = writable([]);
const installedModInfo = writable([]);
const searchResults = writable([]);
const installedModIds = writable(new Set());
const modVersionsCache = writable({});
const installedModVersionsCache = writable({});
const modsWithUpdates = writable(new Map());
const downloads = writable({});
const installingModIds = writable(new Set());
const modWarnings = writable(new Map());
const disabledMods = writable(new Set()); // Store for disabled mods
const disabledModUpdates = writable(new Map()); // Store for disabled mods with available updates
// Names of mods that are managed by the server (required or optional)
const serverManagedFiles = writable(new Set());

// Loading states
const isLoading = writable(false);
const isSearching = writable(false);
const isCheckingUpdates = writable(false);

// UI states
const errorMessage = writable('');
const successMessage = writable('');
const searchError = writable('');
const expandedModId = writable(null);
const expandedInstalledMod = writable(null);
const isDragging = writable(false);
const showDownloads = writable(false);

// Search options
const searchKeyword = writable('');
const modSource = writable('modrinth');
const currentPage = writable(1);
const totalPages = writable(0); // Start with 0 to prevent showing incorrect values
const totalResults = writable(0); // Start with 0 to prevent showing incorrect values
const resultsPerPage = writable(20);

// Dependency modal
const dependencyModalOpen = writable(false);
const currentDependencies = writable([]);
const modToInstall = writable(null);

// Server configuration
const serverConfig = writable(null);
const minecraftVersion = writable('');
const loaderType = writable('fabric');

// Filter stores
const filterMinecraftVersion = writable('');
const filterModLoader = writable('fabric');

// Store for mod categories and requirement status
const modCategories = writable(new Map()); // Map of modId -> { category: string, required: boolean }

// Version comparison helper function
function compareVersions(versionA, versionB) {
  if (!versionA || !versionB) return 0;
  if (versionA === versionB) return 0;
  
  // Convert to arrays of version components
  const partsA = versionA.split(/[.-]/).map(part => {
    const num = parseInt(part, 10);
    return isNaN(num) ? part : num;
  });
  
  const partsB = versionB.split(/[.-]/).map(part => {
    const num = parseInt(part, 10);
    return isNaN(num) ? part : num;
  });
  
  // Compare each part
  const minLength = Math.min(partsA.length, partsB.length);
  
  for (let i = 0; i < minLength; i++) {
    const a = partsA[i];
    const b = partsB[i];
    
    // If both are numbers, compare numerically
    if (typeof a === 'number' && typeof b === 'number') {
      if (a !== b) return a - b;
    } 
    // If both are strings, compare alphabetically
    else if (typeof a === 'string' && typeof b === 'string') {
      if (a !== b) return a.localeCompare(b);
    }
    // Numbers are considered greater than strings for this purpose
    else if (typeof a === 'number') {
      return 1;
    } else {
      return -1;
    }
  }
  
  // If we get here, one version might be a prefix of the other
  // The longer one is considered newer (e.g., 1.0.1 > 1.0)
  return partsA.length - partsB.length;
}

// Lazy-loaded derived stores to avoid effect_orphan errors
let hasUpdates = null;
let updateCount = null;
let categorizedMods = null;

// Functions to create derived stores when needed (within component context)
function getHasUpdates() {
  if (!hasUpdates) {
    hasUpdates = derived(
      modsWithUpdates,
      $modsWithUpdates => {
        for (const key of $modsWithUpdates.keys()) {
          if (key.startsWith('project:')) {
            return true;
          }
        }
        return false;
      }
    );
  }
  return hasUpdates;
}

function getUpdateCount() {
  if (!updateCount) {
    updateCount = derived([modsWithUpdates, disabledModUpdates], ([$updates, $disabledUpdates]) => {
      // Count regular enabled mod updates
      let count = 0;
      for (const [modName] of $updates.entries()) {
        if (!modName.startsWith('project:')) {
          count++;
        }
      }
      
      // Add disabled mods with compatible updates
      count += $disabledUpdates.size;
      
      return count;
    });
  }
  return updateCount;
}

function getCategorizedMods() {
  if (!categorizedMods) {
    categorizedMods = derived(
      [installedMods, modCategories],
      ([$installedMods, $modCategories]) => {
        return $installedMods.map(mod => {
          // If the mod is just a string (filename)
          const modFileName = typeof mod === 'string' ? mod : mod.fileName;
          
          const categoryInfo = $modCategories.get(modFileName);
          
          // If no category info found, provide safe defaults
          const defaultCategory = 'server-only';
          const defaultRequired = true;
          
          const result = {
            fileName: modFileName,
            name: modFileName.replace('.jar', ''),
            category: categoryInfo?.category || defaultCategory,
            required: categoryInfo?.required !== undefined ? categoryInfo.required : defaultRequired
          };
          
          return result;
        });
      }
    );
  }
  return categorizedMods;
}

// Export all stores and helper functions
export {
  // Stores
  installedMods,
  installedModInfo,
  searchResults,
  installedModIds,
  modVersionsCache,
  installedModVersionsCache,
  modsWithUpdates,
  downloads,
  installingModIds,
  modWarnings,
  disabledMods,
  disabledModUpdates,
  serverManagedFiles,
  isLoading,
  isSearching,
  isCheckingUpdates,
  errorMessage,
  successMessage,
  searchError,
  expandedModId,
  expandedInstalledMod,
  isDragging,
  showDownloads,
  searchKeyword,
  modSource,
  currentPage,
  totalPages,
  totalResults,
  resultsPerPage,
  dependencyModalOpen,
  currentDependencies,
  modToInstall,
  serverConfig,
  minecraftVersion,
  loaderType,
  filterMinecraftVersion,
  filterModLoader,
  modCategories,
  // Derived store getters (lazy-loaded)
  getHasUpdates,
  getUpdateCount,
  getCategorizedMods,

  // Helper functions
  compareVersions
};

// Save mod categories to persistent storage
export async function saveModCategories() {
  try {
    // Get the paths from localStorage
    let serverPath = '';
    let clientPath = '';
      // First try to get paths from the instances list
      const storedInstances = localStorage.getItem('instances');
      if (storedInstances) {
        const instances = JSON.parse(storedInstances);
        
        // Find server and client instances
        const serverInstance = instances.find(i => i.type === 'server');
        const clientInstance = instances.find(i => i.type === 'client');
        
        if (serverInstance && serverInstance.path) {
          serverPath = serverInstance.path;
        }
        
        if (clientInstance && clientInstance.path) {
          clientPath = clientInstance.path;
        }
      }
      
      // If we don't have a server path yet, try to get from current instance
      if (!serverPath) {
        const storedInstance = localStorage.getItem('currentInstance');
        if (storedInstance) {
          const instance = JSON.parse(storedInstance);
          if (instance && instance.path) {
            serverPath = instance.path;
          }
        }
      }


    // Convert Map to array of objects for storage
    const categoriesArray = Array.from(get(modCategories)).map(([modId, info]) => ({
      modId,
      ...info
    }));
    
    
    await safeInvoke('save-mod-categories', categoriesArray, serverPath, clientPath);
    return true;
  } catch {
    return false;
  }
}

// Load mod categories from persistent storage
export async function loadModCategories() {
  try {
    const categoriesArray = await window.electron.invoke('get-mod-categories');
    
    if (Array.isArray(categoriesArray)) {
      const categoriesMap = new Map();
      
      categoriesArray.forEach(item => {
        if (item.modId) {
          categoriesMap.set(item.modId, {
            category: item.category || 'server-only',
            required: item.required !== false // Default to true if not specified
          });
        }
      });
      
      modCategories.set(categoriesMap);
    }
    
    return true;
  } catch (error) {
    console.error('Error loading categories:', error);
    return false;
  }
}

// Update a mod's category
export async function updateModCategory(modId, category) {
  
  modCategories.update($categories => {
    const current = $categories.get(modId) || { required: true };
    $categories.set(modId, { ...current, category });
    return $categories;
  });
  
  await saveModCategories();
}

// Update a mod's required status
export async function updateModRequired(modId, required) {
  
  modCategories.update($categories => {
    const current = $categories.get(modId) || { category: 'server-only' };
    $categories.set(modId, { ...current, required });
    return $categories;
  });
  
  await saveModCategories();
}

// Remove files from the serverManagedFiles set (case-insensitive)
export function removeServerManagedFiles(fileNames = []) {
  if (!Array.isArray(fileNames) || fileNames.length === 0) return;

  serverManagedFiles.update(current => {
    const updated = new Set(current);
    fileNames.forEach(fileName => {
      // Find and remove using case-insensitive comparison
      for (const existingFile of updated) {
        if (existingFile.toLowerCase() === fileName.toLowerCase()) {
          updated.delete(existingFile);
          break;
        }
      }
    });
    return updated;
  });
}
