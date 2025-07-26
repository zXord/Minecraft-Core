import { writable, derived, get } from 'svelte/store';
import { SvelteSet } from 'svelte/reactivity';
import { safeInvoke } from '../utils/ipcUtils.js';
import logger from '../utils/logger.js';

// Validation and recovery functions for mod store data
function validateModStoreData(data, storeName) {
  try {
    // Some stores allow null as a valid value
    const nullAllowedStores = [
      'expandedModId',
      'expandedInstalledMod',
      'modToInstall',
      'serverConfig'
    ];

    if (data === null || data === undefined) {
      if (data === null && nullAllowedStores.includes(storeName)) {
        // null is valid for these stores
        return true;
      }

      logger.debug('Mod store data is null/undefined', {
        category: 'mods',
        data: {
          store: 'modStore',
          function: 'validateModStoreData',
          storeName,
          isNull: data === null,
          isUndefined: data === undefined
        }
      });
      return false;
    }

    // Validate based on store type
    switch (storeName) {
      case 'installedMods':
      case 'installedModInfo':
      case 'searchResults':
        if (!Array.isArray(data)) {
          logger.warn('Mod store array data is not an array', {
            category: 'mods',
            data: {
              store: 'modStore',
              function: 'validateModStoreData',
              storeName,
              dataType: typeof data,
              isArray: Array.isArray(data)
            }
          });
          return false;
        }
        break;
      case 'modVersionsCache':
      case 'installedModVersionsCache':
      case 'downloads':
        if (typeof data !== 'object' || Array.isArray(data)) {
          logger.warn('Mod store cache data is not an object', {
            category: 'mods',
            data: {
              store: 'modStore',
              function: 'validateModStoreData',
              storeName,
              dataType: typeof data,
              isArray: Array.isArray(data)
            }
          });
          return false;
        }
        break;
      case 'installedModIds':
      case 'installingModIds':
      case 'disabledMods':
      case 'serverManagedFiles':
        if (!(data instanceof SvelteSet) && !(data instanceof Set)) {
          logger.warn('Mod store set data is not a Set', {
            category: 'mods',
            data: {
              store: 'modStore',
              function: 'validateModStoreData',
              storeName,
              dataType: typeof data,
              isSvelteSet: data instanceof SvelteSet,
              isSet: data instanceof Set
            }
          });
          return false;
        }
        break;
      case 'modsWithUpdates':
      case 'modWarnings':
      case 'disabledModUpdates':
      case 'modCategories':
        if (!(data instanceof Map)) {
          logger.warn('Mod store map data is not a Map', {
            category: 'mods',
            data: {
              store: 'modStore',
              function: 'validateModStoreData',
              storeName,
              dataType: typeof data,
              isMap: data instanceof Map
            }
          });
          return false;
        }
        break;
    }

    return true;
  } catch (error) {
    logger.error(`Mod store data validation failed: ${error.message}`, {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'validateModStoreData',
        storeName,
        errorType: error.constructor.name,
        stack: error.stack
      }
    });
    return false;
  }
}

function recoverModStoreData(corruptedData, storeName) {
  logger.warn('Attempting to recover corrupted mod store data', {
    category: 'mods',
    data: {
      store: 'modStore',
      function: 'recoverModStoreData',
      storeName,
      corruptedDataType: typeof corruptedData,
      isNull: corruptedData === null
    }
  });

  try {
    let recoveredData;

    switch (storeName) {
      case 'installedMods':
      case 'installedModInfo':
      case 'searchResults':
        recoveredData = Array.isArray(corruptedData) ? corruptedData : [];
        break;
      case 'modVersionsCache':
      case 'installedModVersionsCache':
      case 'downloads':
        recoveredData = (typeof corruptedData === 'object' && !Array.isArray(corruptedData)) ? corruptedData : {};
        break;
      case 'installedModIds':
      case 'installingModIds':
      case 'disabledMods':
      case 'serverManagedFiles':
        if (corruptedData instanceof SvelteSet || corruptedData instanceof Set) {
          recoveredData = new SvelteSet(corruptedData);
        } else if (Array.isArray(corruptedData)) {
          recoveredData = new SvelteSet(corruptedData);
        } else {
          recoveredData = new SvelteSet();
        }
        break;
      case 'modsWithUpdates':
      case 'modWarnings':
      case 'disabledModUpdates':
      case 'modCategories':
        if (corruptedData instanceof Map) {
          recoveredData = new Map(corruptedData);
        } else if (Array.isArray(corruptedData)) {
          recoveredData = new Map(corruptedData);
        } else {
          recoveredData = new Map();
        }
        break;
      default:
        recoveredData = corruptedData;
    }

    logger.info('Mod store data recovered successfully', {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'recoverModStoreData',
        storeName,
        recoveredDataType: typeof recoveredData,
        recoveredSize: getDataSize(recoveredData),
        recoveryApplied: true
      }
    });

    return recoveredData;
  } catch (error) {
    logger.error(`Mod store data recovery failed: ${error.message}`, {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'recoverModStoreData',
        storeName,
        errorType: error.constructor.name,
        fallbackToDefault: true
      }
    });

    // Return safe defaults
    switch (storeName) {
      case 'installedMods':
      case 'installedModInfo':
      case 'searchResults':
        return [];
      case 'modVersionsCache':
      case 'installedModVersionsCache':
      case 'downloads':
        return {};
      case 'installedModIds':
      case 'installingModIds':
      case 'disabledMods':
      case 'serverManagedFiles':
        return new SvelteSet();
      case 'modsWithUpdates':
      case 'modWarnings':
      case 'disabledModUpdates':
      case 'modCategories':
        return new Map();
      default:
        return null;
    }
  }
}

function getDataSize(data) {
  try {
    if (Array.isArray(data)) return data.length;
    if (data instanceof Map || data instanceof Set || data instanceof SvelteSet) return data.size;
    if (typeof data === 'object' && data !== null) return Object.keys(data).length;
    return 0;
  } catch {
    return 0;
  }
}

// Enhanced store creation with logging and validation
function createEnhancedModStore(initialValue, storeName) {
  logger.debug('Creating enhanced mod store', {
    category: 'mods',
    data: {
      store: 'modStore',
      function: 'createEnhancedModStore',
      storeName,
      initialSize: getDataSize(initialValue)
    }
  });

  const { subscribe, set, update } = writable(initialValue);

  return {
    subscribe,
    set: (value) => {
      try {
        if (validateModStoreData(value, storeName)) {
          logger.debug('Mod store set with valid data', {
            category: 'mods',
            data: {
              store: 'modStore',
              function: 'set',
              storeName,
              newSize: getDataSize(value),
              dataType: typeof value
            }
          });
          set(value);
        } else {
          const recoveredData = recoverModStoreData(value, storeName);
          logger.warn('Mod store set with invalid data, using recovered data', {
            category: 'mods',
            data: {
              store: 'modStore',
              function: 'set',
              storeName,
              recoveryApplied: true,
              recoveredSize: getDataSize(recoveredData)
            }
          });
          set(recoveredData);
        }
      } catch (error) {
        logger.error(`Mod store set failed: ${error.message}`, {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'set',
            storeName,
            errorType: error.constructor.name,
            fallbackToDefault: true
          }
        });
        set(recoverModStoreData(null, storeName));
      }
    },
    update: (updater) => {
      try {
        update((currentValue) => {
          const startTime = Date.now();
          const newValue = updater(currentValue);
          const duration = Date.now() - startTime;

          if (validateModStoreData(newValue, storeName)) {
            // Log significant changes
            const oldSize = getDataSize(currentValue);
            const newSize = getDataSize(newValue);

            if (oldSize !== newSize || duration > 10) {
              logger.debug('Mod store updated', {
                category: 'mods',
                data: {
                  store: 'modStore',
                  function: 'update',
                  storeName,
                  oldSize,
                  newSize,
                  sizeChange: newSize - oldSize,
                  duration,
                  timestamp: Date.now()
                }
              });
            }

            // Log performance warnings
            if (duration > 50) {
              logger.warn('Slow mod store update detected', {
                category: 'performance',
                data: {
                  store: 'modStore',
                  function: 'update',
                  storeName,
                  duration,
                  threshold: 50
                }
              });
            }

            return newValue;
          } else {
            const recoveredData = recoverModStoreData(newValue, storeName);
            logger.warn('Mod store update produced invalid data, using recovered data', {
              category: 'mods',
              data: {
                store: 'modStore',
                function: 'update',
                storeName,
                recoveryApplied: true,
                duration
              }
            });
            return recoveredData;
          }
        });
      } catch (error) {
        logger.error(`Mod store update failed: ${error.message}`, {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'update',
            storeName,
            errorType: error.constructor.name,
            stack: error.stack
          }
        });
        // Don't update on error to maintain current state
      }
    }
  };
}

// Create the enhanced writable stores with logging and validation
const installedMods = createEnhancedModStore([], 'installedMods');
const installedModInfo = createEnhancedModStore([], 'installedModInfo');
const searchResults = createEnhancedModStore([], 'searchResults');
const installedModIds = createEnhancedModStore(new SvelteSet(), 'installedModIds');
const modVersionsCache = createEnhancedModStore({}, 'modVersionsCache');
const installedModVersionsCache = createEnhancedModStore({}, 'installedModVersionsCache');
const modsWithUpdates = createEnhancedModStore(new Map(), 'modsWithUpdates');
const downloads = createEnhancedModStore({}, 'downloads');
const installingModIds = createEnhancedModStore(new SvelteSet(), 'installingModIds');
const modWarnings = createEnhancedModStore(new Map(), 'modWarnings');
const disabledMods = createEnhancedModStore(new SvelteSet(), 'disabledMods'); // Store for disabled mods
const disabledModUpdates = createEnhancedModStore(new Map(), 'disabledModUpdates'); // Store for disabled mods with available updates
// Names of mods that are managed by the server (required or optional)
const serverManagedFiles = createEnhancedModStore(new SvelteSet(), 'serverManagedFiles');

// Loading states with logging
const isLoading = createEnhancedModStore(false, 'isLoading');
const isSearching = createEnhancedModStore(false, 'isSearching');
const isCheckingUpdates = createEnhancedModStore(false, 'isCheckingUpdates');

// UI states with logging
const errorMessage = createEnhancedModStore('', 'errorMessage');
const successMessage = createEnhancedModStore('', 'successMessage');
const searchError = createEnhancedModStore('', 'searchError');
const expandedModId = createEnhancedModStore(null, 'expandedModId');
const expandedInstalledMod = createEnhancedModStore(null, 'expandedInstalledMod');
const isDragging = createEnhancedModStore(false, 'isDragging');
const showDownloads = createEnhancedModStore(false, 'showDownloads');

// Search options with logging
const searchKeyword = createEnhancedModStore('', 'searchKeyword');
const modSource = createEnhancedModStore('modrinth', 'modSource');
const currentPage = createEnhancedModStore(1, 'currentPage');
const totalPages = createEnhancedModStore(0, 'totalPages'); // Start with 0 to prevent showing incorrect values
const totalResults = createEnhancedModStore(0, 'totalResults'); // Start with 0 to prevent showing incorrect values
const resultsPerPage = createEnhancedModStore(20, 'resultsPerPage');

// Dependency modal with logging
const dependencyModalOpen = createEnhancedModStore(false, 'dependencyModalOpen');
const currentDependencies = createEnhancedModStore([], 'currentDependencies');
const modToInstall = createEnhancedModStore(null, 'modToInstall');

// Server configuration with logging
const serverConfig = createEnhancedModStore(null, 'serverConfig');
const minecraftVersion = createEnhancedModStore('', 'minecraftVersion');
const loaderType = createEnhancedModStore('fabric', 'loaderType');

// Filter stores with logging
const filterMinecraftVersion = createEnhancedModStore('', 'filterMinecraftVersion');
const filterModLoader = createEnhancedModStore('fabric', 'filterModLoader');

// Store for mod categories and requirement status with enhanced logging
const modCategories = createEnhancedModStore(new Map(), 'modCategories'); // Map of modId -> { category: string, required: boolean }

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

// Cache operation helpers with logging
export function getCacheValue(cacheStore, key, cacheName) {
  try {
    const cache = get(cacheStore);
    const hasValue = cache && Object.prototype.hasOwnProperty.call(cache, key);
    const value = hasValue ? cache[key] : null;

    logger.debug('Cache access', {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'getCacheValue',
        cacheName,
        key,
        hit: hasValue,
        valueType: typeof value,
        cacheSize: cache ? Object.keys(cache).length : 0
      }
    });

    return value;
  } catch (error) {
    logger.error(`Cache access failed: ${error.message}`, {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'getCacheValue',
        cacheName,
        key,
        errorType: error.constructor.name
      }
    });
    return null;
  }
}

export function setCacheValue(cacheStore, key, value, cacheName) {
  try {
    const startTime = Date.now();

    cacheStore.update(cache => {
      const newCache = { ...cache, [key]: value };
      const duration = Date.now() - startTime;

      logger.debug('Cache update', {
        category: 'mods',
        data: {
          store: 'modStore',
          function: 'setCacheValue',
          cacheName,
          key,
          valueType: typeof value,
          oldCacheSize: cache ? Object.keys(cache).length : 0,
          newCacheSize: Object.keys(newCache).length,
          duration
        }
      });

      return newCache;
    });

    return true;
  } catch (error) {
    logger.error(`Cache update failed: ${error.message}`, {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'setCacheValue',
        cacheName,
        key,
        errorType: error.constructor.name
      }
    });
    return false;
  }
}

export function clearCache(cacheStore, cacheName) {
  try {
    const oldCache = get(cacheStore);
    const oldSize = oldCache ? Object.keys(oldCache).length : 0;

    logger.info('Clearing cache', {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'clearCache',
        cacheName,
        oldSize
      }
    });

    cacheStore.set({});

    logger.info('Cache cleared successfully', {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'clearCache',
        cacheName,
        clearedEntries: oldSize
      }
    });

    return true;
  } catch (error) {
    logger.error(`Cache clear failed: ${error.message}`, {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'clearCache',
        cacheName,
        errorType: error.constructor.name
      }
    });
    return false;
  }
}

// Data synchronization helpers with logging
export function syncModData(sourceData, targetStore, storeName, syncType = 'full') {
  try {
    const startTime = Date.now();

    logger.info('Starting mod data synchronization', {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'syncModData',
        storeName,
        syncType,
        sourceSize: getDataSize(sourceData),
        timestamp: startTime
      }
    });

    if (!validateModStoreData(sourceData, storeName)) {
      logger.warn('Source data validation failed during sync', {
        category: 'mods',
        data: {
          store: 'modStore',
          function: 'syncModData',
          storeName,
          syncType,
          validationFailed: true
        }
      });

      const recoveredData = recoverModStoreData(sourceData, storeName);
      targetStore.set(recoveredData);

      logger.warn('Sync completed with data recovery', {
        category: 'mods',
        data: {
          store: 'modStore',
          function: 'syncModData',
          storeName,
          syncType,
          recoveryApplied: true,
          duration: Date.now() - startTime
        }
      });

      return false;
    }

    targetStore.set(sourceData);
    const duration = Date.now() - startTime;

    logger.info('Mod data synchronization completed', {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'syncModData',
        storeName,
        syncType,
        success: true,
        syncedSize: getDataSize(sourceData),
        duration
      }
    });

    return true;
  } catch (error) {
    logger.error(`Mod data synchronization failed: ${error.message}`, {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'syncModData',
        storeName,
        syncType,
        errorType: error.constructor.name,
        stack: error.stack
      }
    });
    return false;
  }
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
  const startTime = Date.now();
  const categoriesMap = get(modCategories);

  logger.info('Starting mod categories persistence operation', {
    category: 'storage',
    data: {
      store: 'modStore',
      function: 'saveModCategories',
      categoriesCount: categoriesMap.size,
      timestamp: startTime
    }
  });

  try {
    // Validate categories data before saving
    if (!validateModStoreData(categoriesMap, 'modCategories')) {
      logger.error('Mod categories data validation failed before save', {
        category: 'storage',
        data: {
          store: 'modStore',
          function: 'saveModCategories',
          validationFailed: true,
          categoriesType: typeof categoriesMap
        }
      });
      return false;
    }

    // Get the paths from localStorage with error handling
    let serverPath = '';
    let clientPath = '';

    try {
      // First try to get paths from the instances list
      const storedInstances = localStorage.getItem('instances');
      if (storedInstances) {
        const instances = JSON.parse(storedInstances);

        logger.debug('Retrieved instances from localStorage', {
          category: 'storage',
          data: {
            store: 'modStore',
            function: 'saveModCategories',
            instancesCount: instances.length
          }
        });

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
    } catch (pathError) {
      logger.warn(`Failed to retrieve paths from localStorage: ${pathError.message}`, {
        category: 'storage',
        data: {
          store: 'modStore',
          function: 'saveModCategories',
          pathRetrievalError: pathError.constructor.name
        }
      });
    }

    // Convert Map to array of objects for storage
    const categoriesArray = Array.from(categoriesMap).map(([modId, info]) => ({
      modId,
      ...info
    }));

    logger.debug('Converted categories for storage', {
      category: 'storage',
      data: {
        store: 'modStore',
        function: 'saveModCategories',
        arrayLength: categoriesArray.length,
        serverPath: !!serverPath,
        clientPath: !!clientPath
      }
    });

    await safeInvoke('save-mod-categories', categoriesArray, serverPath, clientPath);
    const duration = Date.now() - startTime;

    logger.info('Mod categories persistence completed successfully', {
      category: 'storage',
      data: {
        store: 'modStore',
        function: 'saveModCategories',
        categoriesCount: categoriesArray.length,
        serverPath: !!serverPath,
        clientPath: !!clientPath,
        duration,
        success: true
      }
    });

    return true;
  } catch (err) {
    const duration = Date.now() - startTime;

    logger.error(`Mod categories persistence failed: ${err.message}`, {
      category: 'storage',
      data: {
        store: 'modStore',
        function: 'saveModCategories',
        errorType: err.constructor.name,
        errorMessage: err.message,
        duration,
        categoriesCount: categoriesMap.size,
        stack: err.stack
      }
    });
    return false;
  }
}

// Load mod categories from persistent storage
export async function loadModCategories() {
  const startTime = Date.now();

  logger.info('Starting mod categories load operation', {
    category: 'storage',
    data: {
      store: 'modStore',
      function: 'loadModCategories',
      timestamp: startTime
    }
  });

  try {
    const categoriesArray = await window.electron.invoke('get-mod-categories');
    const duration = Date.now() - startTime;

    logger.debug('Retrieved categories data from backend', {
      category: 'storage',
      data: {
        store: 'modStore',
        function: 'loadModCategories',
        isArray: Array.isArray(categoriesArray),
        dataLength: categoriesArray?.length || 0,
        duration
      }
    });

    if (Array.isArray(categoriesArray)) {
      const categoriesMap = new Map();
      let validItems = 0;
      let invalidItems = 0;

      categoriesArray.forEach(item => {
        if (item && item.modId) {
          categoriesMap.set(item.modId, {
            category: item.category || 'server-only',
            required: item.required !== false // Default to true if not specified
          });
          validItems++;
        } else {
          invalidItems++;
          logger.debug('Skipped invalid category item', {
            category: 'storage',
            data: {
              store: 'modStore',
              function: 'loadModCategories',
              item,
              hasModId: !!(item && item.modId)
            }
          });
        }
      });

      // Validate the constructed map
      if (validateModStoreData(categoriesMap, 'modCategories')) {
        modCategories.set(categoriesMap);

        logger.info('Mod categories loaded and synchronized successfully', {
          category: 'storage',
          data: {
            store: 'modStore',
            function: 'loadModCategories',
            totalItems: categoriesArray.length,
            validItems,
            invalidItems,
            mapSize: categoriesMap.size,
            duration: Date.now() - startTime,
            success: true
          }
        });
      } else {
        logger.error('Constructed categories map failed validation', {
          category: 'storage',
          data: {
            store: 'modStore',
            function: 'loadModCategories',
            mapType: typeof categoriesMap,
            isMap: categoriesMap instanceof Map,
            validationFailed: true
          }
        });
        return false;
      }
    } else {
      logger.warn('Categories data is not an array, using empty map', {
        category: 'storage',
        data: {
          store: 'modStore',
          function: 'loadModCategories',
          dataType: typeof categoriesArray,
          isNull: categoriesArray === null,
          fallbackToEmpty: true
        }
      });

      modCategories.set(new Map());
    }

    return true;
  } catch (err) {
    const duration = Date.now() - startTime;

    logger.error(`Mod categories load failed: ${err.message}`, {
      category: 'storage',
      data: {
        store: 'modStore',
        function: 'loadModCategories',
        errorType: err.constructor.name,
        errorMessage: err.message,
        duration,
        stack: err.stack
      }
    });

    // Set empty map as fallback
    try {
      modCategories.set(new Map());
      logger.info('Set empty categories map as fallback', {
        category: 'storage',
        data: {
          store: 'modStore',
          function: 'loadModCategories',
          fallbackApplied: true
        }
      });
    } catch (fallbackError) {
      logger.error(`Failed to set fallback categories: ${fallbackError.message}`, {
        category: 'storage',
        data: {
          store: 'modStore',
          function: 'loadModCategories',
          fallbackError: fallbackError.constructor.name
        }
      });
    }

    return false;
  }
}

// Update a mod's category
export async function updateModCategory(modId, category) {
  const startTime = Date.now();

  logger.info('Starting mod category update', {
    category: 'mods',
    data: {
      store: 'modStore',
      function: 'updateModCategory',
      modId,
      newCategory: category,
      timestamp: startTime
    }
  });

  try {
    if (!modId || typeof modId !== 'string') {
      logger.error('Invalid modId provided for category update', {
        category: 'mods',
        data: {
          store: 'modStore',
          function: 'updateModCategory',
          modId,
          modIdType: typeof modId,
          category
        }
      });
      return false;
    }

    let updateApplied = false;
    let oldCategory = null;

    modCategories.update($categories => {
      const current = $categories.get(modId) || { required: true };
      oldCategory = current.category;

      if (current.category !== category) {
        $categories.set(modId, { ...current, category });
        updateApplied = true;

        logger.debug('Mod category updated in store', {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'updateModCategory',
            modId,
            oldCategory,
            newCategory: category,
            required: current.required
          }
        });
      } else {
        logger.debug('Mod category unchanged', {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'updateModCategory',
            modId,
            category,
            noChange: true
          }
        });
      }

      return $categories;
    });

    if (updateApplied) {
      const saveSuccess = await saveModCategories();
      const duration = Date.now() - startTime;

      if (saveSuccess) {
        logger.info('Mod category update completed successfully', {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'updateModCategory',
            modId,
            oldCategory,
            newCategory: category,
            duration,
            persistenceSuccess: true
          }
        });
      } else {
        logger.warn('Mod category updated in store but persistence failed', {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'updateModCategory',
            modId,
            category,
            duration,
            persistenceFailed: true
          }
        });
      }

      return saveSuccess;
    }

    return true;
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(`Mod category update failed: ${error.message}`, {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'updateModCategory',
        modId,
        category,
        errorType: error.constructor.name,
        duration,
        stack: error.stack
      }
    });
    return false;
  }
}

// Update a mod's required status
export async function updateModRequired(modId, required) {
  const startTime = Date.now();

  logger.info('Starting mod required status update', {
    category: 'mods',
    data: {
      store: 'modStore',
      function: 'updateModRequired',
      modId,
      required,
      timestamp: startTime
    }
  });

  try {
    if (!modId || typeof modId !== 'string') {
      logger.error('Invalid modId provided for required status update', {
        category: 'mods',
        data: {
          store: 'modStore',
          function: 'updateModRequired',
          modId,
          modIdType: typeof modId,
          required
        }
      });
      return false;
    }

    let updateApplied = false;
    let oldRequired = null;

    modCategories.update($categories => {
      const current = $categories.get(modId) || { category: 'server-only' };
      oldRequired = current.required;

      if (current.required !== required) {
        $categories.set(modId, { ...current, required });
        updateApplied = true;

        logger.debug('Mod required status updated in store', {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'updateModRequired',
            modId,
            oldRequired,
            newRequired: required,
            category: current.category
          }
        });
      } else {
        logger.debug('Mod required status unchanged', {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'updateModRequired',
            modId,
            required,
            noChange: true
          }
        });
      }

      return $categories;
    });

    if (updateApplied) {
      const saveSuccess = await saveModCategories();
      const duration = Date.now() - startTime;

      if (saveSuccess) {
        logger.info('Mod required status update completed successfully', {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'updateModRequired',
            modId,
            oldRequired,
            newRequired: required,
            duration,
            persistenceSuccess: true
          }
        });
      } else {
        logger.warn('Mod required status updated in store but persistence failed', {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'updateModRequired',
            modId,
            required,
            duration,
            persistenceFailed: true
          }
        });
      }

      return saveSuccess;
    }

    return true;
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(`Mod required status update failed: ${error.message}`, {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'updateModRequired',
        modId,
        required,
        errorType: error.constructor.name,
        duration,
        stack: error.stack
      }
    });
    return false;
  }
}

// Remove files from the serverManagedFiles set (case-insensitive)
export function removeServerManagedFiles(fileNames = []) {
  const startTime = Date.now();

  if (!Array.isArray(fileNames) || fileNames.length === 0) {
    logger.debug('No files to remove from server managed files', {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'removeServerManagedFiles',
        fileNames,
        isArray: Array.isArray(fileNames),
        length: fileNames?.length || 0
      }
    });
    return { success: true, removedCount: 0 };
  }

  logger.info('Starting server managed files removal', {
    category: 'mods',
    data: {
      store: 'modStore',
      function: 'removeServerManagedFiles',
      fileNamesCount: fileNames.length,
      fileNames,
      timestamp: startTime
    }
  });

  try {
    let removedCount = 0;
    let notFoundCount = 0;
    const removedFiles = [];
    const notFoundFiles = [];

    serverManagedFiles.update(current => {
      try {
        const updated = new SvelteSet(current);
        const initialSize = updated.size;

        fileNames.forEach(fileName => {
          if (!fileName || typeof fileName !== 'string') {
            logger.debug('Skipping invalid filename', {
              category: 'mods',
              data: {
                store: 'modStore',
                function: 'removeServerManagedFiles',
                fileName,
                fileNameType: typeof fileName
              }
            });
            return;
          }

          // Find and remove using case-insensitive comparison
          let found = false;
          for (const existingFile of updated) {
            if (existingFile.toLowerCase() === fileName.toLowerCase()) {
              updated.delete(existingFile);
              removedCount++;
              removedFiles.push(existingFile);
              found = true;
              break;
            }
          }

          if (!found) {
            notFoundCount++;
            notFoundFiles.push(fileName);
          }
        });

        const finalSize = updated.size;
        const actualRemoved = initialSize - finalSize;

        logger.debug('Server managed files set updated', {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'removeServerManagedFiles',
            initialSize,
            finalSize,
            actualRemoved,
            requestedRemoval: fileNames.length,
            removedFiles: removedFiles.length > 5 ? `${removedFiles.slice(0, 5).join(', ')}...` : removedFiles.join(', ')
          }
        });

        return updated;
      } catch (updateError) {
        logger.error(`Failed to update server managed files set: ${updateError.message}`, {
          category: 'mods',
          data: {
            store: 'modStore',
            function: 'removeServerManagedFiles.update',
            errorType: updateError.constructor.name,
            fileNamesCount: fileNames.length
          }
        });
        return current; // Return unchanged on error
      }
    });

    const duration = Date.now() - startTime;

    if (notFoundCount > 0) {
      logger.debug('Some files were not found in server managed files', {
        category: 'mods',
        data: {
          store: 'modStore',
          function: 'removeServerManagedFiles',
          notFoundCount,
          notFoundFiles: notFoundFiles.length > 3 ? `${notFoundFiles.slice(0, 3).join(', ')}...` : notFoundFiles.join(', ')
        }
      });
    }

    logger.info('Server managed files removal completed', {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'removeServerManagedFiles',
        requestedCount: fileNames.length,
        removedCount,
        notFoundCount,
        duration,
        success: true
      }
    });

    return { success: true, removedCount, notFoundCount, removedFiles, notFoundFiles };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(`Server managed files removal failed: ${error.message}`, {
      category: 'mods',
      data: {
        store: 'modStore',
        function: 'removeServerManagedFiles',
        fileNamesCount: fileNames.length,
        errorType: error.constructor.name,
        duration,
        stack: error.stack
      }
    });

    return { success: false, error: error.message, removedCount: 0 };
  }
}
