import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import logger from './utils/logger.js'

// Log application startup
logger.info('Application starting', {
  category: 'core',
  data: {
    timestamp: Date.now(),
    userAgent: navigator.userAgent,
    // Use userAgentData if available, fallback to deprecated platform
    platform: (() => {
      try {
        // Check if userAgentData exists on navigator (experimental API)
        const nav = navigator;
        if ('userAgentData' in nav && nav.userAgentData) {
          const userAgentData = nav.userAgentData;
          if (userAgentData && typeof userAgentData === 'object' && 'platform' in userAgentData) {
            return String(userAgentData.platform);
          }
        }
        return navigator.platform;
      } catch {
        return navigator.platform;
      }
    })()
  }
});

// Create a simple global store for initial instances
const initialInstanceStore = {
  instances: [],
  loaded: false
};

// Create the missing global serverPath store that components expect
// This implements the ServerPath interface with get/set methods
let currentServerPath = '';
const serverPathStore = {
  get: () => currentServerPath,
  /**
   * Set the server path
   * @param {string} path - The server path to set
   */
  set: (path) => {
    currentServerPath = typeof path === 'string' ? path : String(path || '');
  }
};

// Make stores available globally
if (typeof window !== 'undefined') {
  logger.debug('Setting up global stores', {
    category: 'core',
    data: {
      hasWindow: true,
      initialInstancesCount: initialInstanceStore.instances.length
    }
  });

  window.getInitialInstances = () => initialInstanceStore;

  // Safely set serverPath - check if it's already defined
  try {
    if (!window.serverPath) {
      window.serverPath = serverPathStore;
      logger.debug('Global serverPath store created successfully', {
        category: 'core',
        data: { method: 'direct_assignment' }
      });
    } else {
      logger.debug('Global serverPath store already exists', {
        category: 'core',
        data: { existing: true }
      });
    }
  } catch (err) {
    logger.warn('Failed to set serverPath directly, trying defineProperty', {
      category: 'core',
      data: {
        errorType: err.constructor.name,
        errorMessage: err.message
      }
    });

    // If setting fails, use Object.defineProperty for more control
    try {
      Object.defineProperty(window, 'serverPath', {
        value: serverPathStore,
        writable: true,
        configurable: true
      });
      logger.info('Global serverPath store created via defineProperty', {
        category: 'core',
        data: { method: 'define_property', success: true }
      });
    } catch (defineError) {
      logger.error('Could not set window.serverPath', {
        category: 'core',
        data: {
          errorType: defineError.constructor.name,
          errorMessage: defineError.message,
          fallbackFailed: true
        }
      });
    }
  }
} else {
  logger.warn('Window object not available, skipping global store setup', {
    category: 'core',
    data: { hasWindow: false, environment: 'non-browser' }
  });
}

// Mount the App first, then initialize async data
logger.debug('Mounting main App component', {
  category: 'core',
  data: {
    targetElement: 'app',
    hasTarget: !!document.getElementById('app')
  }
});

const startTime = Date.now();
try {
  const app = mount(App, {
    target: document.getElementById('app')
  });

  const mountDuration = Date.now() - startTime;
  logger.info('App component mounted successfully', {
    category: 'performance',
    data: {
      mountDuration,
      performanceCategory: mountDuration > 1000 ? 'slow' : 'normal'
    }
  });

  // Export app for later use
  if (typeof window !== 'undefined') {
    window['app'] = app;
  }

  // After app is mounted, fetch instances asynchronously
  logger.debug('Fetching initial instances from backend', {
    category: 'core',
    data: { operation: 'get-instances' }
  });

  const instanceFetchStart = Date.now();
  window.electron.invoke('get-instances')
    .then(instances => {
      const fetchDuration = Date.now() - instanceFetchStart;
      const initialInstances = Array.isArray(instances) ? instances : [];

      logger.info('Initial instances loaded successfully', {
        category: 'core',
        data: {
          instanceCount: initialInstances.length,
          fetchDuration,
          instanceTypes: initialInstances.map(i => i.type || 'unknown')
        }
      });

      // Store them in our simple store
      initialInstanceStore.instances = initialInstances;
      initialInstanceStore.loaded = true;
    })
    .catch(error => {
      const fetchDuration = Date.now() - instanceFetchStart;
      logger.error('Error fetching initial instances', {
        category: 'core',
        data: {
          errorType: error?.constructor?.name || 'Unknown',
          errorMessage: error?.message || 'Unknown error',
          fetchDuration,
          fallbackApplied: true
        }
      });

      // Mark as loaded anyway to prevent hanging
      initialInstanceStore.loaded = true;
    });

} catch (mountError) {
  const mountDuration = Date.now() - startTime;
  logger.fatal('Failed to mount App component', {
    category: 'core',
    data: {
      errorType: mountError.constructor.name,
      errorMessage: mountError.message,
      mountDuration,
      targetElement: 'app',
      hasTarget: !!document.getElementById('app')
    }
  });

  // Re-throw to prevent silent failures
  throw mountError;
}

logger.info('Application initialization completed', {
  category: 'core',
  data: {
    totalInitTime: Date.now() - startTime,
    hasGlobalStores: !!(window.getInitialInstances && window.serverPath),
    environment: 'browser'
  }
});

export default (typeof window !== 'undefined' && window['app']) || null;
