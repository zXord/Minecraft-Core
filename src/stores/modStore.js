/// <reference path="../electron.d.ts" />
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
      case 'shaderResults':
      case 'resourcePackResults':
      case 'installedShaders':
      case 'installedResourcePacks':
      case 'installedShaderInfo':
      case 'installedResourcePackInfo':
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
      case 'shaderResults':
      case 'resourcePackResults':
      case 'installedShaders':
      case 'installedResourcePacks':
      case 'installedShaderInfo':
      case 'installedResourcePackInfo':
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
      case 'shaderResults':
      case 'resourcePackResults':
      case 'installedShaders':
      case 'installedResourcePacks':
      case 'installedShaderInfo':
      case 'installedResourcePackInfo':
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
// Store for ignored updates (Map<fileName, { ids: Set<string>, vers: Set<string> }>)
const ignoredUpdates = createEnhancedModStore(new Map(), 'ignoredUpdates');
// Names of mods that are managed by the server (required or optional)
const serverManagedFiles = createEnhancedModStore(new SvelteSet(), 'serverManagedFiles');

// Loading states with logging
const isLoading = createEnhancedModStore(false, 'isLoading');
const isSearching = createEnhancedModStore(false, 'isSearching');
const isCheckingUpdates = createEnhancedModStore(false, 'isCheckingUpdates');
const lastUpdateCheckTime = createEnhancedModStore(0, 'lastUpdateCheckTime');

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

// Content type stores for shaders and resource packs
const activeContentType = createEnhancedModStore('mods', 'activeContentType');
const shaderResults = createEnhancedModStore([], 'shaderResults');
const resourcePackResults = createEnhancedModStore([], 'resourcePackResults');
const installedShaders = createEnhancedModStore([], 'installedShaders');
const installedResourcePacks = createEnhancedModStore([], 'installedResourcePacks');

// Content type switching performance optimization stores
const contentTypeSwitching = createEnhancedModStore(false, 'contentTypeSwitching');
const contentTypeCache = createEnhancedModStore(new Map(), 'contentTypeCache');
const contentTypeRetryCount = createEnhancedModStore(new Map(), 'contentTypeRetryCount');

// Installed ID stores for different content types
const installedShaderIds = createEnhancedModStore(new SvelteSet(), 'installedShaderIds');
const installedResourcePackIds = createEnhancedModStore(new SvelteSet(), 'installedResourcePackIds');

// Installed info stores for different content types (similar to installedModInfo)
const installedShaderInfo = createEnhancedModStore([], 'installedShaderInfo');
const installedResourcePackInfo = createEnhancedModStore([], 'installedResourcePackInfo');

// Content type configuration objects
export const CONTENT_TYPES = {
  MODS: 'mods',
  SHADERS: 'shaders',
  RESOURCE_PACKS: 'resourcepacks'
};

export const contentTypeConfigs = {
  [CONTENT_TYPES.MODS]: {
    id: CONTENT_TYPES.MODS,
    label: 'Mods',
    icon: '🧩',
    searchEndpoint: 'search-mods',
    installDirectory: 'mods',
    fileExtensions: ['.jar'],
    resultsStore: 'searchResults',
    installedStore: 'installedMods',
    installedIdsStore: 'installedModIds'
  },
  [CONTENT_TYPES.SHADERS]: {
    id: CONTENT_TYPES.SHADERS,
    label: 'Shaders',
    icon: '✨',
    searchEndpoint: 'search-shaders',
    installDirectory: 'shaderpacks',
    fileExtensions: ['.zip'],
    resultsStore: 'shaderResults',
    installedStore: 'installedShaders',
    installedIdsStore: 'installedShaderIds',
    installedInfoStore: 'installedShaderInfo'
  },
  [CONTENT_TYPES.RESOURCE_PACKS]: {
    id: CONTENT_TYPES.RESOURCE_PACKS,
    label: 'Resource Packs',
    icon: '🎨',
    searchEndpoint: 'search-resourcepacks',
    installDirectory: 'resourcepacks',
    fileExtensions: ['.zip'],
    resultsStore: 'resourcePackResults',
    installedStore: 'installedResourcePacks',
    installedIdsStore: 'installedResourcePackIds',
    installedInfoStore: 'installedResourcePackInfo'
  }
};

// Download states enum for enhanced download tracking
export const DOWNLOAD_STATES = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  RETRYING: 'retrying',
  FALLBACK: 'fallback',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Download sources enum
export const DOWNLOAD_SOURCES = {
  SERVER: 'server',
  MODRINTH: 'modrinth',
  CURSEFORGE: 'curseforge'
};

// Enhanced download progress management functions
/**
 * Create an enhanced download progress object with all required fields
 * @param {string} id - Download ID
 * @param {string} name - Download name
 * @param {Object} options - Additional options
 * @returns {Object} Enhanced download progress object
 */
export function createEnhancedDownloadProgress(id, name, options = {}) {
  const now = Date.now();
  
  const progress = {
    // Basic properties
    id,
    name,
    state: options.state || DOWNLOAD_STATES.QUEUED,
    progress: options.progress || 0,
    size: options.size || 0,
    speed: options.speed || 0,
    
    // Enhanced properties
    source: options.source || DOWNLOAD_SOURCES.SERVER,
    attempt: options.attempt || 1,
    maxAttempts: options.maxAttempts || 3,
    checksumValidation: options.checksumValidation || null,
    fallbackCountdown: options.fallbackCountdown || 0,
    estimatedTimeRemaining: options.estimatedTimeRemaining || 0,
    queuePosition: options.queuePosition || 0,
    
    // Status messages
    statusMessage: options.statusMessage || generateStatusMessage(options.state || DOWNLOAD_STATES.QUEUED, options),
    detailedStatus: options.detailedStatus || null,
    
    // Error information
    error: options.error || null,
    errorDetails: options.errorDetails || null,
    
    // Timestamps
    startTime: options.startTime || now,
    completedTime: options.completedTime || null,
    lastUpdateTime: options.lastUpdateTime || now,
    
    // Legacy compatibility
    completed: options.completed || false
  };
  
  logger.debug('Created enhanced download progress', {
    category: 'mods',
    data: {
      function: 'createEnhancedDownloadProgress',
      downloadId: id,
      downloadName: name,
      state: progress.state,
      source: progress.source,
      attempt: progress.attempt,
      maxAttempts: progress.maxAttempts
    }
  });
  
  return progress;
}

/**
 * Generate status message based on download state and context
 * @param {string} state - Download state
 * @param {Object} context - Additional context for message generation
 * @returns {string} Status message
 */
export function generateStatusMessage(state, context = {}) {
  switch (state) {
    case DOWNLOAD_STATES.QUEUED:
      return context.queuePosition > 0 ? 
        `Queued (position ${context.queuePosition})` : 
        'Queued for download...';
    
    case DOWNLOAD_STATES.DOWNLOADING:
      if (context.source === DOWNLOAD_SOURCES.SERVER) {
        return 'Downloading from server...';
      } else if (context.source === DOWNLOAD_SOURCES.MODRINTH) {
        return 'Downloading from Modrinth...';
      } else if (context.source === DOWNLOAD_SOURCES.CURSEFORGE) {
        return 'Downloading from CurseForge...';
      }
      return 'Downloading...';
    
    case DOWNLOAD_STATES.VERIFYING:
      return 'Verifying file integrity...';
    
    case DOWNLOAD_STATES.RETRYING:
      return `Retrying download (attempt ${context.attempt || 1}/${context.maxAttempts || 3})...`;
    
    case DOWNLOAD_STATES.FALLBACK:
      if (context.fallbackCountdown > 0) {
        const minutes = Math.ceil(context.fallbackCountdown / 60000);
        return `Trying alternative source in ${minutes} minute${minutes !== 1 ? 's' : ''}...`;
      }
      return 'Trying alternative source...';
    
    case DOWNLOAD_STATES.COMPLETED:
      return 'Download completed successfully';
    
    case DOWNLOAD_STATES.FAILED:
      return context.error || 'Download failed';
    
    default:
      return 'Processing...';
  }
}

/**
 * Update download progress with state transitions and validation
 * @param {Object} currentProgress - Current progress object
 * @param {Object} updates - Updates to apply
 * @returns {Object} Updated progress object
 */
export function updateDownloadProgress(currentProgress, updates) {
  const now = Date.now();
  
  // Validate state transitions
  const validatedUpdates = { ...updates };
  
  if (updates.state && !isValidStateTransition(currentProgress.state, updates.state)) {
    logger.warn('Invalid download state transition attempted', {
      category: 'mods',
      data: {
        function: 'updateDownloadProgress',
        downloadId: currentProgress.id,
        currentState: currentProgress.state,
        attemptedState: updates.state
      }
    });
    delete validatedUpdates.state;
  }
  
  // Skip update if state is the same and no other meaningful changes
  if (updates.state === currentProgress.state && 
      updates.progress === currentProgress.progress &&
      !updates.error && !updates.statusMessage) {
    return currentProgress;
  }
  
  // Ensure progress is within valid range
  if (typeof validatedUpdates.progress === 'number') {
    validatedUpdates.progress = Math.max(0, Math.min(100, validatedUpdates.progress));
  }
  
  // Update timestamps
  validatedUpdates.lastUpdateTime = now;
  
  // Set completion time for final states
  if (validatedUpdates.state === DOWNLOAD_STATES.COMPLETED || 
      validatedUpdates.state === DOWNLOAD_STATES.FAILED) {
    validatedUpdates.completedTime = now;
    validatedUpdates.completed = validatedUpdates.state === DOWNLOAD_STATES.COMPLETED;
    
    if (validatedUpdates.state === DOWNLOAD_STATES.COMPLETED) {
      validatedUpdates.progress = 100;
    }
  }
  
  // Update estimated time remaining if we have speed and size data
  if (validatedUpdates.speed && validatedUpdates.size && validatedUpdates.progress < 100) {
    validatedUpdates.estimatedTimeRemaining = calculateEstimatedTimeRemaining(
      validatedUpdates.progress,
      validatedUpdates.speed,
      validatedUpdates.size
    );
  }
  
  const updatedProgress = {
    ...currentProgress,
    ...validatedUpdates
  };
  
  // Generate status message if not provided
  if (!validatedUpdates.statusMessage && validatedUpdates.state) {
    updatedProgress.statusMessage = generateStatusMessage(validatedUpdates.state, updatedProgress);
  }
  
  logger.debug('Download progress updated', {
    category: 'mods',
    data: {
      function: 'updateDownloadProgress',
      downloadId: updatedProgress.id,
      oldState: currentProgress.state,
      newState: updatedProgress.state,
      progress: updatedProgress.progress,
      attempt: updatedProgress.attempt,
      source: updatedProgress.source,
      statusMessage: updatedProgress.statusMessage
    }
  });
  
  return updatedProgress;
}

/**
 * Check if a state transition is valid
 * @param {string} currentState - Current state
 * @param {string} newState - New state
 * @returns {boolean} True if transition is valid
 */
function isValidStateTransition(currentState, newState) {
  // Allow same-state transitions (no-op updates)
  if (currentState === newState) {
    return true;
  }
  
  const validTransitions = {
    [DOWNLOAD_STATES.QUEUED]: [
      DOWNLOAD_STATES.DOWNLOADING,
      DOWNLOAD_STATES.FAILED
    ],
    [DOWNLOAD_STATES.DOWNLOADING]: [
      DOWNLOAD_STATES.VERIFYING,
      DOWNLOAD_STATES.RETRYING,
      DOWNLOAD_STATES.FALLBACK,
      DOWNLOAD_STATES.COMPLETED,
      DOWNLOAD_STATES.FAILED
    ],
    [DOWNLOAD_STATES.VERIFYING]: [
      DOWNLOAD_STATES.RETRYING,
      DOWNLOAD_STATES.FALLBACK,
      DOWNLOAD_STATES.COMPLETED,
      DOWNLOAD_STATES.FAILED
    ],
    [DOWNLOAD_STATES.RETRYING]: [
      DOWNLOAD_STATES.DOWNLOADING,
      DOWNLOAD_STATES.FALLBACK,
      DOWNLOAD_STATES.FAILED
    ],
    [DOWNLOAD_STATES.FALLBACK]: [
      DOWNLOAD_STATES.DOWNLOADING,
      DOWNLOAD_STATES.COMPLETED,
      DOWNLOAD_STATES.FAILED
    ],
    [DOWNLOAD_STATES.COMPLETED]: [], // Terminal state
    [DOWNLOAD_STATES.FAILED]: []     // Terminal state
  };
  
  return validTransitions[currentState]?.includes(newState) || false;
}

/**
 * Calculate estimated time remaining based on progress and speed
 * @param {number} progress - Current progress (0-100)
 * @param {number} speed - Download speed in bytes/second
 * @param {number} size - Total file size in bytes
 * @returns {number} Estimated time remaining in milliseconds
 */
export function calculateEstimatedTimeRemaining(progress, speed, size) {
  // Validate inputs
  if (!speed || speed <= 0 || !size || size <= 0 || progress >= 100) {
    return 0;
  }
  
  // Ensure progress is in valid range
  const validProgress = Math.max(0, Math.min(100, progress));
  
  const remainingBytes = size * ((100 - validProgress) / 100);
  const remainingSeconds = remainingBytes / speed;
  
  // Cap the estimate at a reasonable maximum (24 hours)
  const maxEstimate = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  
  return Math.max(0, Math.min(remainingSeconds * 1000, maxEstimate));
}

/**
 * Format time remaining for display
 * @param {number} milliseconds - Time in milliseconds
 * @returns {string} Formatted time string
 */
export function formatTimeRemaining(milliseconds) {
  if (!milliseconds || milliseconds <= 0) {
    return '';
  }
  
  const seconds = Math.floor(milliseconds / 1000);
  
  if (seconds < 60) {
    return `${seconds}s`;
  } else if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m`;
  } else if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  } else {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
}

/**
 * Get download queue position based on current downloads
 * @param {string} downloadId - Download ID to check
 * @param {Object} allDownloads - All current downloads
 * @returns {number} Queue position (0 if not queued)
 */
export function getDownloadQueuePosition(downloadId, allDownloads) {
  const queuedDownloads = Object.values(allDownloads)
    .filter(download => download.state === DOWNLOAD_STATES.QUEUED)
    .sort((a, b) => a.startTime - b.startTime);
  
  const position = queuedDownloads.findIndex(download => download.id === downloadId);
  return position >= 0 ? position + 1 : 0;
}

/**
 * Update all queued downloads with their current queue positions
 * @param {Object} allDownloads - All current downloads
 * @returns {Object} Updated downloads with queue positions
 */
export function updateQueuePositions(allDownloads) {
  const updatedDownloads = { ...allDownloads };
  
  Object.keys(updatedDownloads).forEach(downloadId => {
    if (updatedDownloads[downloadId].state === DOWNLOAD_STATES.QUEUED) {
      updatedDownloads[downloadId].queuePosition = getDownloadQueuePosition(
        downloadId,
        allDownloads
      );
    }
  });
  
  return updatedDownloads;
}

/**
 * Validate download progress data
 * @param {Object} progress - Download progress object to validate
 * @returns {boolean} True if valid
 */
export function validateDownloadProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return false;
  }
  
  // Required fields
  if (!progress.id || typeof progress.id !== 'string') {
    return false;
  }
  
  if (!progress.name || typeof progress.name !== 'string') {
    return false;
  }
  
  // Validate state
  if (!progress.state || !Object.values(DOWNLOAD_STATES).includes(progress.state)) {
    return false;
  }
  
  // Validate source
  if (!progress.source || !Object.values(DOWNLOAD_SOURCES).includes(progress.source)) {
    return false;
  }
  
  // Validate numeric fields
  if (typeof progress.progress !== 'number' || progress.progress < 0 || progress.progress > 100) {
    return false;
  }
  
  if (typeof progress.attempt !== 'number' || progress.attempt < 1) {
    return false;
  }
  
  if (typeof progress.maxAttempts !== 'number' || progress.maxAttempts < 1) {
    return false;
  }
  
  // Validate timestamps
  if (typeof progress.startTime !== 'number' || progress.startTime <= 0) {
    return false;
  }
  
  if (typeof progress.lastUpdateTime !== 'number' || progress.lastUpdateTime <= 0) {
    return false;
  }
  
  return true;
}

/**
 * Create a download error object
 * @param {string} type - Error type
 * @param {string} message - Error message
 * @param {string} source - Download source
 * @param {number} attempt - Attempt number
 * @param {Object} details - Additional error details
 * @returns {Object} Download error object
 */
export function createDownloadError(type, message, source, attempt, details = {}) {
  return {
    timestamp: Date.now(),
    source,
    attempt,
    type,
    message,
    details
  };
}

/**
 * Get download statistics for monitoring
 * @param {Object} allDownloads - All current downloads
 * @returns {Object} Download statistics
 */
export function getDownloadStatistics(allDownloads) {
  const downloads = Object.values(allDownloads);
  
  const stats = {
    total: downloads.length,
    queued: 0,
    downloading: 0,
    verifying: 0,
    retrying: 0,
    fallback: 0,
    completed: 0,
    failed: 0,
    averageSpeed: 0,
    totalSize: 0,
    completedSize: 0
  };
  
  let speedSum = 0;
  let activeDownloads = 0;
  
  downloads.forEach(download => {
    // Count by state (with fallback for invalid states)
    const state = download.state || 'unknown';
    if (Object.prototype.hasOwnProperty.call(stats, state)) {
      stats[state]++;
    }
    
    if (download.size && typeof download.size === 'number') {
      stats.totalSize += download.size;
      stats.completedSize += (download.size * (download.progress || 0)) / 100;
    }
    
    if (download.speed && typeof download.speed === 'number' && download.speed > 0) {
      speedSum += download.speed;
      activeDownloads++;
    }
  });
  
  if (activeDownloads > 0) {
    stats.averageSpeed = speedSum / activeDownloads;
  }
  
  logger.debug('Generated download statistics', {
    category: 'mods',
    data: {
      function: 'getDownloadStatistics',
      stats,
      totalDownloads: downloads.length,
      activeDownloads
    }
  });
  
  return stats;
}

// Version comparison helper function
function compareVersions(versionA, versionB) {
  // Robust comparator that understands:
  // - Alphanumeric suffixes in segments (e.g., 1.2a > 1.2, 1.2b > 1.2a)
  // - Pre-release markers ("-rc1", "-beta") are lower than release (1.2-rc1 < 1.2)
  // - Trailing .0 segments do not make a version newer (1.2.0 == 1.2)
  if (!versionA || !versionB) return 0;
  if (versionA === versionB) return 0;

  const normalize = (v) => String(v).trim().replace(/^v/i, '');
  const aStr = normalize(versionA);
  const bStr = normalize(versionB);

  const splitPre = (v) => {
    const idx = v.indexOf('-');
    if (idx === -1) return { main: v, pre: null };
    return { main: v.slice(0, idx), pre: v.slice(idx + 1) };
  };

  const tokenize = (seg) => {
    // Split into numeric and alphabetic tokens: '2a10' -> [2, 'a', 10]
    if (!seg) return [];
    return seg.match(/\d+|[A-Za-z]+/g)?.map(t => (/^\d+$/.test(t) ? Number(t) : t.toLowerCase())) || [];
  };

  const parse = (v) => {
    const { main, pre } = splitPre(v);
    const mainTokens = main.split('.').flatMap(tokenize);
    const preTokens = pre ? pre.split('.').flatMap(tokenize) : null;
    return { mainTokens, preTokens, hasPre: !!pre };
  };

  const a = parse(aStr);
  const b = parse(bStr);

  const len = Math.max(a.mainTokens.length, b.mainTokens.length);
  for (let i = 0; i < len; i++) {
    const at = a.mainTokens[i];
    const bt = b.mainTokens[i];
    if (at === undefined && bt === undefined) break;
    if (at === undefined) {
      // Remaining tokens in b: if all remaining are numeric zeros, treat equal; else b is newer
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
      // number vs string: number has higher precedence
      return typeof at === 'number' ? 1 : -1;
    }
  }

  // If main tokens are equal, handle pre-release: absence of pre means higher precedence
  if (a.hasPre && !b.hasPre) return -1;
  if (!a.hasPre && b.hasPre) return 1;
  if (!a.hasPre && !b.hasPre) return 0;

  // Both have pre-release; compare their tokens
  const maxPre = Math.max(a.preTokens.length, b.preTokens.length);
  for (let i = 0; i < maxPre; i++) {
    const at = a.preTokens[i];
    const bt = b.preTokens[i];
    if (at === undefined && bt === undefined) break;
    if (at === undefined) return -1; // shorter pre is considered smaller
    if (bt === undefined) return 1;
    if (typeof at === 'number' && typeof bt === 'number') {
      if (at !== bt) return at > bt ? 1 : -1;
    } else if (typeof at === 'string' && typeof bt === 'string') {
      if (at !== bt) return at > bt ? 1 : -1;
    } else {
      return typeof at === 'number' ? 1 : -1;
    }
  }
  return 0;
}

// Lazy-loaded derived stores to avoid effect_orphan errors
let hasUpdates = null;
let updateCount = null;
let categorizedMods = null;
let ignoredUpdatesLoaded = false;
// Persistence strategy: prefer server path file via IPC, fallback to localStorage
const IGNORED_UPDATES_LOCAL_KEY = 'minecraft-core:ignored-updates';
let ignoredUpdatesMigrated = false;
// (IgnorePersist logging removed)

// Helper: extract a plausible filesystem path from arbitrary value (object/string)
function _extractPathCandidate(raw, seen = new Set(), depth = 0) {
  if (!raw || depth > 3) return '';
  if (typeof raw === 'string') {
    // Quick heuristic: must contain path separator or drive letter pattern
    if (/^[a-zA-Z]:\\/.test(raw) || /[\\/]/.test(raw)) return raw;
    return '';
  }
  if (typeof raw !== 'object') return '';
  if (seen.has(raw)) return '';
  seen.add(raw);
  // Prefer obvious keys
  const preferredKeys = ['path','serverPath','dir','directory','root','value'];
  for (const k of preferredKeys) {
    if (typeof raw[k] === 'string') {
      const cand = _extractPathCandidate(raw[k], seen, depth + 1);
      if (cand) return cand;
    }
  }
  // Scan other string props
  for (const [,v] of Object.entries(raw)) {
    if (typeof v === 'string') {
      const cand = _extractPathCandidate(v, seen, depth + 1);
      if (cand) return cand;
    } else if (typeof v === 'object') {
      const cand = _extractPathCandidate(v, seen, depth + 1);
      if (cand) return cand;
    }
  }
  return '';
}

// Obtain current server path; fallback strategies if we get an object or nothing
async function _getServerPath() {
  try {
    const spObj = (typeof window !== 'undefined') ? window.serverPath : null;
    let rawVal = '';
    if (spObj && typeof spObj.get === 'function') {
      let val = spObj.get();
      // Promise-like
      // @ts-ignore
      if (val && typeof val.then === 'function') {
  try { val = await val; } catch { /* swallow */ }
      }
      rawVal = val;
    }
    let candidate = '';
    if (typeof rawVal === 'string') {
      candidate = rawVal;
    } else if (rawVal && typeof rawVal === 'object') {
      candidate = _extractPathCandidate(rawVal);
      if (!candidate) {
        try { candidate = Object.prototype.toString.call(rawVal); } catch { /* ignore */ }
      }
    }
    // If candidate still looks like [object Object] or lacks separators, treat as invalid
    if (!candidate || candidate === '[object Object]' || (!/[\\/]/.test(candidate) && !/^[a-zA-Z]:/.test(candidate))) {
      // Try IPC fallback for last server path
      try {
        if (window.electron && window.electron.invoke) {
          const last = await window.electron.invoke('get-last-server-path');
          if (typeof last === 'string' && (/[\\/]/.test(last) || /^[a-zA-Z]:/.test(last))) {
            return last;
          }
        }
      } catch { /* ignore */ }
      // Try localStorage cache if we ever stored it
      try {
        const ls = localStorage.getItem('minecraft-core:last-server-path');
  if (ls && (/[\\/]/.test(ls) || /^[a-zA-Z]:/.test(ls))) {
          return ls;
        }
      } catch { /* ignore */ }
  // server path unresolved
      return '';
    }
  // resolved server path
    // Cache for potential fallback later
    try { localStorage.setItem('minecraft-core:last-server-path', candidate); } catch { /* ignore */ }
    return candidate;
  } catch {
    return '';
  }
}

async function _loadIgnoredFromBackend() {
  try {
  const sp = await _getServerPath();
  if (!sp){ return null; }
  if (!window.electron || !window.electron.invoke){ return null; }
    const data = await window.electron.invoke('get-ignored-mod-updates', sp);
  if (data && typeof data === 'object'){ return data; }
  } catch { /* ignore */ }
  return null;
}

async function _saveIgnoredToBackend(map) {
  try {
  const sp = await _getServerPath();
    if (!sp) return false;
    if (!window.electron || !window.electron.invoke) return false;
    const obj = {};
    for (const [fileName, rec] of map.entries()) {
      obj[fileName] = { ids: Array.from(rec.ids||[]), vers: Array.from(rec.vers||[]) };
    }
  let json;
  try { json = JSON.stringify(obj); } catch { return false; }
  await window.electron.invoke('save-ignored-mod-updates', sp, json);
  // saved
    return true;
  } catch { return false; }
}

// Ensure backend file exists even with empty map
async function _ensureBackendIgnoredFile() {
  try {
  const sp = await _getServerPath();
  if (!sp){ return; }
  if (!window.electron || !window.electron.invoke){ return; }
    // Call save with existing map (may be empty) to force file creation
    const map = get(ignoredUpdates) || new Map();
    await _saveIgnoredToBackend(map);
  // ensure file attempted
  } catch { /* ignore */ }
}

// Load ignored updates from localStorage once
async function loadIgnoredUpdates() {
  if (ignoredUpdatesLoaded) return;
  ignoredUpdatesLoaded = true;
  let parsed = await _loadIgnoredFromBackend();
  if (!parsed) {
    try {
      const raw = localStorage.getItem(IGNORED_UPDATES_LOCAL_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch { /* ignore */ }
  }
  if (parsed && typeof parsed === 'object') {
    const map = new Map();
    for (const [fileName, data] of Object.entries(parsed)) {
      if (data && typeof data === 'object') {
        const ids = new SvelteSet(Array.isArray(data.ids) ? data.ids : []);
        const vers = new SvelteSet(Array.isArray(data.vers) ? data.vers : []);
        map.set(fileName, { ids, vers });
      }
    }
    ignoredUpdates.set(map);
  // initialized ignored updates store
  }
  // After load, attempt to create backend file if server path already set and no file existed
  setTimeout(_ensureBackendIgnoredFile, 500);
}
loadIgnoredUpdates();

async function attemptIgnoredUpdatesMigration() {
  if (ignoredUpdatesMigrated) return;
  try {
  const sp = await _getServerPath();
  if (!sp){ return; }
    const map = get(ignoredUpdates);
    // Migrate even if empty so file is created
    ignoredUpdatesMigrated = true; // mark before to avoid duplicate attempts
  _saveIgnoredToBackend(map || new Map()).then(saved => {
      if (!saved) {
        ignoredUpdatesMigrated = false; // allow retry
      }
    });
  } catch { /* ignore */ }
}

// Wrap serverPath.set to detect when user selects/changes server path
try {
  if (typeof window !== 'undefined' && window.serverPath && typeof window.serverPath.set === 'function' && !window.serverPath['__ignoredWrap']) {
    const originalSet = window.serverPath.set;
    window.serverPath.set = function(path) {
      const result = originalSet.call(this, path);
      // Fire and forget async migration
      setTimeout(() => { attemptIgnoredUpdatesMigration(); }, 0);
      return result;
    };
    window.serverPath['__ignoredWrap'] = true;
  }
} catch { /* ignore */ }

// Also attempt migration shortly after load in case serverPath already set
setTimeout(() => { attemptIgnoredUpdatesMigration(); }, 1000);

// Persist ignored updates on change (debounced)
let _ignorePersistTimer = null;
ignoredUpdates.subscribe(($map) => {
  if (_ignorePersistTimer) clearTimeout(_ignorePersistTimer);
  _ignorePersistTimer = setTimeout(async () => {
    // Attempt backend save first; fallback to localStorage
    const savedToBackend = await _saveIgnoredToBackend($map);
    if (!savedToBackend) {
      try {
        const obj = {};
        for (const [fileName, rec] of $map.entries()) {
          obj[fileName] = { ids: Array.from(rec.ids||[]), vers: Array.from(rec.vers||[]) };
        }
        localStorage.setItem(IGNORED_UPDATES_LOCAL_KEY, JSON.stringify(obj));
      } catch { /* ignore */ }
    }
  // After any change, attempt migration if not done yet
  attemptIgnoredUpdatesMigration();
  }, 250);
});

function ignoreUpdate(fileName, versionId, versionNumber) {
  if (!fileName) return;
  ignoredUpdates.update(map => {
    const rec = map.get(fileName) || { ids: new SvelteSet(), vers: new SvelteSet() };
    if (versionId) rec.ids.add(String(versionId));
    if (versionNumber) {
      const raw = String(versionNumber);
      rec.vers.add(raw);
      // Also store normalized variant (lowercase, strip leading 'v') for robust matching
      const norm = raw.trim().toLowerCase().replace(/^v/, '');
      rec.vers.add(norm);
    }
    map.set(fileName, rec);
    return map;
  });
}

function isUpdateIgnored(fileName, versionId, versionNumber) {
  try {
    const map = get(ignoredUpdates);
    const rec = map.get(fileName);
    if (!rec) return false;
    if (versionId && rec.ids.has(String(versionId))) return true;
    if (versionNumber) {
      const raw = String(versionNumber);
      const norm = raw.trim().toLowerCase().replace(/^v/, '');
      if (rec.vers.has(raw) || rec.vers.has(norm)) return true;
    }
  } catch {
    // ignore lookup errors
  }
  return false;
}

function clearIgnoredUpdates(fileName) {
  if (!fileName) return;
  ignoredUpdates.update(map => { map.delete(fileName); return map; });
}

function getIgnoredUpdatesStore() { return ignoredUpdates; }

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
    updateCount = derived([modsWithUpdates, disabledModUpdates, disabledMods], ([$updates, $disabledUpdates, $disabledSet]) => {
      let count = 0;
      const counted = new Set();

      // Count enabled mods (excluding project: references)
      for (const [modName] of $updates.entries()) {
        if (!modName.startsWith('project:') && !counted.has(modName)) {
          count++;
          counted.add(modName);
        }
      }

      // Count disabled mods (skip if already counted to avoid double-counting)
      if ($disabledUpdates) {
        for (const name of $disabledUpdates.keys()) {
          if ($disabledSet && $disabledSet.has && $disabledSet.has(name) && !counted.has(name)) {
            count++;
            counted.add(name);
          }
        }
      }

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
    logger.debug('Cache access', { category: 'mods', data: { store: 'modStore', function: 'getCacheValue', cacheName, key, hasValue, valueType: typeof value } });
    return value;
  } catch (error) {
    logger.error(`Cache access failed: ${error.message}`, { category: 'mods', data: { store: 'modStore', function: 'getCacheValue', cacheName, key, errorType: error.constructor.name } });
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
  ignoredUpdates,
  ignoreUpdate,
  isUpdateIgnored,
  clearIgnoredUpdates,
  getIgnoredUpdatesStore,
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
  lastUpdateCheckTime,
  filterMinecraftVersion,
  filterModLoader,
  modCategories,
  // Content type stores
  activeContentType,
  shaderResults,
  resourcePackResults,
  installedShaders,
  installedResourcePacks,
  installedShaderIds,
  installedResourcePackIds,
  installedShaderInfo,
  installedResourcePackInfo,
  // Content type performance optimization stores
  contentTypeSwitching,
  contentTypeCache,
  contentTypeRetryCount,
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
          for (const existingFile of Array.from(updated)) {
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
