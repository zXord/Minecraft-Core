<script>
  export let serverPath = '';
  import { onMount, onDestroy } from 'svelte';
  import ServerModManager from '../components/server/ServerModManager.svelte';
  import logger from '../utils/logger.js';
  
  let pageInitialized = false;
  let loadingState = 'idle'; // idle, loading, loaded, error
  let searchQuery = '';
  let activeFilters = [];
  let sortBy = 'name';
  let viewMode = 'grid'; // grid, list
  let totalInteractions = 0;
  let searchCount = 0;
  let filterCount = 0;
  let previousServerPath = '';
  
  onMount(async () => {
    const startTime = Date.now();
    
    logger.info('ModsPage navigation started', {
      category: 'ui',
      data: {
        component: 'ModsPage',
        lifecycle: 'onMount',
        serverPath,
        hasServerPath: !!serverPath,
        navigationStartTime: startTime
      }
    });
    
    try {
      await initializeModsPage();
      const initDuration = Date.now() - startTime;
      
      logger.info('ModsPage initialization completed', {
        category: 'ui',
        data: {
          component: 'ModsPage',
          lifecycle: 'onMount',
          success: true,
          initializationDuration: initDuration,

          defaultSortBy: sortBy,
          defaultViewMode: viewMode
        }
      });
    } catch (error) {
      const initDuration = Date.now() - startTime;
      
      logger.error(`ModsPage initialization failed: ${error.message}`, {
        category: 'ui',
        data: {
          component: 'ModsPage',
          lifecycle: 'onMount',
          errorType: error.constructor.name,
          initializationDuration: initDuration,
          serverPath
        }
      });
      
      handleModsPageError(error, 'initialization');
    }
  });
  
  onDestroy(() => {
    logger.info('ModsPage navigation ended', {
      category: 'ui',
      data: {
        component: 'ModsPage',
        lifecycle: 'onDestroy',
        wasInitialized: pageInitialized,
        finalLoadingState: loadingState,
        totalInteractions,
        totalSearches: searchCount,
        totalFilters: filterCount,
        finalSearchQuery: searchQuery,
        finalFilters: activeFilters,
        finalSortBy: sortBy,
        finalViewMode: viewMode
      }
    });
  });
  
  async function initializeModsPage() {
    loadingState = 'loading';
    
    logger.debug('ModsPage data loading started', {
      category: 'mods',
      data: {
        component: 'ModsPage',
        operation: 'initializeModsPage',
        serverPath,
        previousState: loadingState
      }
    });
    
    try {
      // Simulate mod data loading
      await loadModsData();
      
      pageInitialized = true;
      loadingState = 'loaded';
      
      logger.info('ModsPage data loading completed', {
        category: 'mods',
        data: {
          component: 'ModsPage',
          operation: 'initializeModsPage',
          success: true,
          newState: loadingState
        }
      });
    } catch (error) {
      loadingState = 'error';
      
      logger.error(`ModsPage data loading failed: ${error.message}`, {
        category: 'mods',
        data: {
          component: 'ModsPage',
          operation: 'initializeModsPage',
          errorType: error.constructor.name,
          newState: loadingState
        }
      });
      
      throw error;
    }
  }
  
  async function loadModsData() {
    logger.debug('Loading mods data', {
      category: 'mods',
      data: {
        component: 'ModsPage',
        operation: 'loadModsData',
        serverPath
      }
    });
    
    // Simulate mod data loading
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  

  
  function handleModsPageError(error, context) {
    logger.error(`ModsPage component failure in ${context}`, {
      category: 'ui',
      data: {
        component: 'ModsPage',
        errorContext: context,
        errorType: error.constructor.name,
        errorMessage: error.message,
        serverPath,
        loadingState,
        pageInitialized,
        searchQuery,
        filtersCount: activeFilters.length
      }
    });
    
    // Could implement error recovery logic here
    loadingState = 'error';
  }
  
  // Handle serverPath changes without reactive loops
  $: if (serverPath !== previousServerPath) {
    if (serverPath !== undefined) {
      logger.debug('ModsPage serverPath changed', {
        category: 'ui',
        data: {
          component: 'ModsPage',
          event: 'serverPathChanged',
          newServerPath: serverPath,
          previousServerPath,
          hasServerPath: !!serverPath,
          wasInitialized: pageInitialized
        }
      });
    }
    previousServerPath = serverPath;
  }
</script>

<div class="content-panel">
  <div class="mods-header">
  </div>
  
  <div class="mods-content">
    <ServerModManager {serverPath} />
  </div>
</div>

<style>
  .content-panel {
    max-width: 1200px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
    padding: 1rem;
  }
  
  .mods-header {
    margin-bottom: 2rem;
  }
</style>
