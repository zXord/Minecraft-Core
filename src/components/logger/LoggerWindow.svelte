<script>
  import { onMount, onDestroy } from 'svelte';
  import logger from '../../utils/logger.js';
  import LoggerFilters from './LoggerFilters.svelte';
  import LogTable from './LogTable.svelte';
  import LogDetails from './LogDetails.svelte';
  import LoggerFooter from './LoggerFooter.svelte';
  import LoggerStatistics from './LoggerStatistics.svelte';
  import LoggerSettings from './LoggerSettings.svelte';
  import ExportSuccessModal from './ExportSuccessModal.svelte';

  // State variables
  let logs = [];
  let filteredLogs = [];
  let selectedLog = null;
  let loading = true;
  let searchTerm = '';
  let autoScroll = true;
  let stats = {};
  let showStatistics = false;
  let showSettings = false;
  let showExportModal = false;
  let exportFilePath = '';
  let exportCount = 0;
  let loggerSettings = {
    autoScroll: true,
    maxLogs: 1000,
    logLevel: 'all',
    exportFormat: 'json',
    realTimeStreaming: true,
    showTimestamps: true,
    showCategories: true,
    showInstances: true
  };
  
  // Filter states
  let levelFilter = 'all';
  let instanceFilter = 'all';
  let categoryFilter = 'all';
  let startDate = null;
  let endDate = null;
  
  // Available filter options
  let availableInstances = [];
  let availableCategories = [];
  
  // Real-time log streaming
  let unsubscribeNewLog = null;
  let unsubscribeLogsCleared = null;

  // Log level colors matching our backend
  const levelColors = {
    debug: '#6b7280',   // gray
    info: '#3b82f6',    // blue  
    warn: '#f59e0b',    // yellow
    error: '#ef4444',   // red
    fatal: '#7f1d1d'    // dark red
  };

  onMount(async () => {
    await initializeLogger();
    setupRealTimeStreaming();
  });

  onDestroy(() => {
    if (unsubscribeNewLog) unsubscribeNewLog();
    if (unsubscribeLogsCleared) unsubscribeLogsCleared();
  });

  async function initializeLogger() {
    try {
      // Load initial logs
      const logsResult = await logger.getLogs({ limit: 100 });
      if (logsResult.success) {
        logs = logsResult.logs || [];
        applyFilters();
      }

      // Load filter options
      const [instancesResult, categoriesResult, statsResult] = await Promise.all([
        logger.getInstances(),
        logger.getCategories(), 
        logger.getStats()
      ]);

      if (instancesResult.success) {
        availableInstances = instancesResult.instances || [];
      }
      
      if (categoriesResult.success) {
        availableCategories = categoriesResult.categories || [];
      }

      if (statsResult.success) {
        stats = statsResult.stats || {};
      }

    } catch (error) {
      // TODO: Add proper logging - Failed to initialize logger
    } finally {
      loading = false;
    }
  }

  function setupRealTimeStreaming() {
    // Listen for new log entries
    if (window.electron && window.electron.on) {
      unsubscribeNewLog = window.electron.on('logger-new-log', (logEntry) => {
        logs = [logEntry, ...logs].slice(0, 1000); // Keep last 1000 in UI
        applyFilters();
        
        // Auto-scroll to top if enabled and showing recent logs
        if (autoScroll && isShowingRecentLogs()) {
          setTimeout(() => {
            const tableContainer = document.querySelector('.log-table-container');
            if (tableContainer) {
              tableContainer.scrollTop = 0;
            }
          }, 50);
        }
      });

      unsubscribeLogsCleared = window.electron.on('logger-logs-cleared', () => {
        logs = [];
        filteredLogs = [];
        selectedLog = null;
      });
    }
  }

  function isShowingRecentLogs() {
    // Check if we're showing recent logs (no time filters applied)
    return !startDate && !endDate && 
           levelFilter === 'all' && 
           instanceFilter === 'all' && 
           categoryFilter === 'all' &&
           !searchTerm.trim();
  }

      // Filter and search functionality - reactive to all filter changes
  $: levelFilter, instanceFilter, categoryFilter, startDate, endDate, searchTerm, logs, applyFilters();

  function applyFilters() {
    console.log('ApplyFilters called with:', {
      logs: logs.length,
      levelFilter,
      instanceFilter,
      categoryFilter,
      startDate,
      endDate,
      searchTerm
    });
    
    if (!logs || logs.length === 0) {
      filteredLogs = [];
      return;
    }
    
    let filtered = [...logs];

    // Apply search filter
    if (searchTerm.trim()) {
      const search = searchTerm.toLowerCase();
      filtered = filtered.filter(log => 
        log.message.toLowerCase().includes(search) ||
        log.instanceId.toLowerCase().includes(search) ||
        log.category.toLowerCase().includes(search) ||
        log.level.toLowerCase().includes(search)
      );
    }

    // Apply level filter
    if (levelFilter !== 'all') {
      filtered = filtered.filter(log => log.level === levelFilter);
    }

    // Apply instance filter
    if (instanceFilter !== 'all') {
      filtered = filtered.filter(log => log.instanceId === instanceFilter);
    }

    // Apply category filter  
    if (categoryFilter !== 'all') {
      filtered = filtered.filter(log => log.category === categoryFilter);
    }

    // Apply date range filter
    if (startDate || endDate) {
      filtered = filtered.filter(log => {
        const logTime = new Date(log.timestamp).getTime();
        
        // Check if log timestamp is valid
        if (isNaN(logTime)) {
          return false;
        }
        
        // Handle start date
        let startTime = 0;
        if (startDate && startDate.trim()) {
          const startDateObj = new Date(startDate);
          if (!isNaN(startDateObj.getTime())) {
            startTime = startDateObj.getTime();
          }
        }
        
        // Handle end date
        let endTime = Date.now();
        if (endDate && endDate.trim()) {
          const endDateObj = new Date(endDate);
          if (!isNaN(endDateObj.getTime())) {
            endTime = endDateObj.getTime();
          }
        }
        
        return logTime >= startTime && logTime <= endTime;
      });
    }

    filteredLogs = filtered;
    
    console.log('ApplyFilters result:', {
      originalCount: logs.length,
      filteredCount: filtered.length,
      filters: { levelFilter, instanceFilter, categoryFilter, startDate, endDate, searchTerm }
    });
  }

  // Log selection
  function selectLog(log) {
    selectedLog = log;
  }

  // Export functionality
  async function exportLogs() {
    try {
      const filters = {
        search: searchTerm.trim() || undefined,
        level: levelFilter !== 'all' ? levelFilter : undefined,
        instanceId: instanceFilter !== 'all' ? instanceFilter : undefined,
        category: categoryFilter !== 'all' ? categoryFilter : undefined,
        startTime: startDate || undefined,
        endTime: endDate || undefined,
        format: 'json' // TODO: Make this configurable
      };

      const result = await logger.exportLogs(filters);
      
      if (result.success) {
        exportFilePath = result.path;
        exportCount = result.count;
        showExportModal = true;
      } else {
        alert(`Export failed: ${result.error}`);
      }
    } catch (error) {
      alert(`Export error: ${error.message}`);
    }
  }

  // Clear logs
  async function clearLogs() {
    if (confirm('Are you sure you want to clear all logs from memory? This cannot be undone.')) {
      try {
        const result = await logger.clearLogs();
        if (result.success) {
          logs = [];
          filteredLogs = [];
          selectedLog = null;
        } else {
          alert(`Failed to clear logs: ${result.error}`);
        }
      } catch (error) {
        alert(`Clear error: ${error.message}`);
      }
    }
  }

  // Show settings modal
  function openSettings() {
    showSettings = true;
  }
  
  function closeSettings() {
    showSettings = false;
  }
  
  function saveLoggerSettings(event) {
    loggerSettings = { ...event.detail };
    // Apply settings immediately
    autoScroll = loggerSettings.autoScroll;
    // Could add more settings application logic here
  }

  // Show statistics modal
  function showStats() {
    showStatistics = true;
  }
  
  function closeStatistics() {
    showStatistics = false;
  }

  // Format timestamp for display
  function formatTimestamp(timestamp) {
    return new Date(timestamp).toLocaleString();
  }

  // Get level color
  function getLevelColor(level) {
    return levelColors[level] || levelColors.info;
  }
</script>

<div class="logger-window">
  <!-- Header -->
  <header class="logger-header">
    <div class="header-left">
      <div class="logger-icon">
        <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M44 4H30.6666V17.3334H17.3334V30.6666H4V44H44V4Z" fill="currentColor"></path>
        </svg>
      </div>
      <h2 class="logger-title">Log Viewer</h2>
    </div>
    
    <div class="header-right">
      <button class="header-button" on:click={openSettings} aria-label="Open logger settings">
        <svg xmlns="http://www.w3.org/2000/svg" width="20px" height="20px" fill="currentColor" viewBox="0 0 256 256">
          <path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"></path>
        </svg>
      </button>
    </div>
  </header>

  <!-- Main Content -->
  <main class="logger-main">
    <div class="content-container">
      


      <!-- Filters -->
      <LoggerFilters 
        bind:levelFilter 
        bind:instanceFilter 
        bind:categoryFilter
        bind:startDate
        bind:endDate
        {availableInstances}
        {availableCategories}
      />

      <!-- Search Bar Relocated -->
      <div class="search-bar-row">
        <div class="search-container">
          <div class="search-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="24px" height="24px" fill="currentColor" viewBox="0 0 256 256">
              <path d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"></path>
            </svg>
          </div>
          <input
            type="text"
            placeholder="Search logs"
            bind:value={searchTerm}
            class="search-input"
          />
        </div>
      </div>

      <!-- Auto Scroll Toggle -->
      <div class="auto-scroll-container">
        <span class="auto-scroll-label">Auto Scroll</span>
        <label class="toggle-switch">
          <input type="checkbox" bind:checked={autoScroll} />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <!-- Log Table -->
      <LogTable 
        logs={filteredLogs}
        {selectedLog}
        {formatTimestamp}
        {getLevelColor}
        on:selectLog={(e) => selectLog(e.detail)}
        {loading}
      />

      <!-- Log Details -->
      {#if selectedLog}
        <LogDetails log={selectedLog} />
      {/if}

      <!-- Footer -->
      <LoggerFooter 
        on:export={exportLogs}
        on:clear={clearLogs}
        on:stats={showStats}
        logCount={filteredLogs.length}
        totalCount={logs.length}
      />

    </div>
  </main>
</div>

<!-- Statistics Modal -->
<LoggerStatistics 
  bind:visible={showStatistics}
  {stats}
  totalLogs={logs.length}
  filteredLogs={filteredLogs.length}
  on:close={closeStatistics}
/>

<!-- Settings Modal -->
<LoggerSettings 
  bind:visible={showSettings}
  bind:settings={loggerSettings}
  on:close={closeSettings}
  on:save={saveLoggerSettings}
/>

<!-- Export Success Modal -->
<ExportSuccessModal bind:visible={showExportModal} filePath={exportFilePath} count={exportCount} />

<style>
  .logger-window {
    height: 100vh;
    background: #101a23;
    color: white;
    font-family: Inter, "Noto Sans", sans-serif;
    display: flex;
    flex-direction: column;
  }

  /* Header Styles */
  .logger-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 2.5rem;
    border-bottom: 1px solid #223649;
    background: #101a23;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .logger-icon {
    width: 1rem;
    height: 1rem;
    color: white;
  }

  .logger-title {
    font-size: 1.125rem;
    font-weight: bold;
    margin: 0;
    color: white;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 2rem;
  }

  .search-container {
    display: flex;
    align-items: center;
    background: #223649;
    border-radius: 0.5rem;
    min-width: 10rem;
    height: 2.5rem;
  }

  .search-icon {
    padding: 0 1rem;
    color: #90adcb;
    display: flex;
    align-items: center;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    color: white;
    padding: 0 1rem 0 0.5rem;
    outline: none;
    font-size: 0.875rem;
  }

  .search-input::placeholder {
    color: #90adcb;
  }

  .header-button {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #223649;
    border: none;
    border-radius: 0.5rem;
    padding: 0.625rem;
    color: white;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .header-button:hover {
    background: #314d68;
  }

  /* Main Content */
  .logger-main {
    flex: 1;
    overflow: hidden;
    display: flex;
    justify-content: center;
    padding: 1.25rem 10rem;
  }

  .content-container {
    display: flex;
    flex-direction: column;
    max-width: 60rem;
    width: 100%;
    gap: 1rem;
  }

  .search-bar-row {
    padding: 0 1rem;
  }


  /* Auto Scroll */
  .auto-scroll-container {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    background: #101a23;
    min-height: 3.5rem;
  }

  .auto-scroll-label {
    font-size: 1rem;
    color: white;
  }

  .toggle-switch {
    position: relative;
    display: inline-block;
    width: 51px;
    height: 31px;
    cursor: pointer;
  }

  .toggle-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: #223649;
    border-radius: 31px;
    transition: 0.3s;
    display: flex;
    align-items: center;
    padding: 2px;
  }

  .toggle-slider:before {
    content: "";
    height: 27px;
    width: 27px;
    background-color: white;
    border-radius: 50%;
    transition: 0.3s;
    box-shadow: rgba(0, 0, 0, 0.15) 0px 3px 8px, rgba(0, 0, 0, 0.06) 0px 3px 1px;
  }

  input:checked + .toggle-slider {
    background-color: #0c7ff2;
  }

  input:checked + .toggle-slider:before {
    transform: translateX(20px);
  }

  /* Responsive Design */
  @media (max-width: 1200px) {
    .logger-main {
      padding: 1.25rem 2rem;
    }
  }

  @media (max-width: 768px) {
    .header-right {
      gap: 1rem;
    }
    
    .search-container {
      min-width: 8rem;
    }
    
    .logger-main {
      padding: 1rem;
    }
  }
</style> 