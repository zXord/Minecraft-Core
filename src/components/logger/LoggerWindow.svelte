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
  import ConfirmationModal from './ConfirmationModal.svelte';

  // State variables
  let logs = [];
  let filteredLogs = []; // Always initialized as empty array
  let selectedLog = null;
  let loading = true;
  let searchTerm = '';
  let stats = {};
  let showStatistics = false;
  let showExportModal = false;
  let exportFilePath = '';
  let exportCount = 0;
  let showSettings = false;
  let showClearConfirmation = false;
  let loggerSettings = {
    maxLogs: 1000,
    logLevel: 'all',
    exportFormat: 'json',
    maxFileSize: 50,
    maxFiles: 5,
    retentionDays: 7
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
      // Load saved settings first
      const settingsResult = await window.electron.invoke('logger-get-settings');
      if (settingsResult.success) {
        loggerSettings = settingsResult.settings;
        levelFilter = loggerSettings.logLevel;
      }

      // Load initial logs - use saved maxLogs setting
      const logsResult = await logger.getLogs({ limit: loggerSettings.maxLogs });
      if (logsResult.success) {
        logs = logsResult.logs || [];
        // Explicitly apply initial filters
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
        logs = [logEntry, ...logs].slice(0, loggerSettings.maxLogs);
        
        // Auto-scroll to top if showing recent logs and user is near the top
        if (isShowingRecentLogs() && isUserNearTop()) {
          setTimeout(() => {
            const tableWrapper = document.querySelector('.table-wrapper');
            if (tableWrapper) {
              tableWrapper.scrollTop = 0;
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

  function isUserNearTop() {
    // Check if user is near the top of the table (within 100px)
    const tableWrapper = document.querySelector('.table-wrapper');
    if (!tableWrapper) return true; // Default to true if can't check
    
    return tableWrapper.scrollTop < 100;
  }

  // Separate reactive statements for different types of changes
  $: if (logs) {
    // Only trigger when logs array changes (data updates)
    applyFiltersDebounced();
  }
  
  $: if (searchTerm !== undefined) {
    // Debounce search changes
    applyFiltersDebounced();
  }
  
  $: if (levelFilter || instanceFilter || categoryFilter || startDate || endDate) {
    // Immediate update for filter changes
    applyFilters();
  }
  
  let filterTimeout;
  
  function handleSearchKeydown(event) {
    if (event.key === 'Escape') {
      searchTerm = '';
      event.target.blur();
    }
  }
  
  // React to settings changes - removed reactive statement that was causing issues

  function applyFiltersDebounced() {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(applyFilters, 150);
  }
  
  function applyFilters() {
    // Ensure we have valid logs array
    if (!logs || !Array.isArray(logs)) {
      filteredLogs = [];
      return;
    }

    let result = [...logs];

    // Apply search filter
    if (searchTerm && searchTerm.trim()) {
      const search = searchTerm.trim().toLowerCase();
      result = result.filter(log => {
        if (!log) return false;
        return (
          (log.message || '').toLowerCase().includes(search) ||
          (log.instanceId || '').toLowerCase().includes(search) ||
          (log.category || '').toLowerCase().includes(search) ||
          (log.level || '').toLowerCase().includes(search)
        );
      });
    }

    // Apply level filter
    if (levelFilter && levelFilter !== 'all') {
      result = result.filter(log => log && log.level === levelFilter);
    }

    // Apply instance filter
    if (instanceFilter && instanceFilter !== 'all') {
      result = result.filter(log => log && log.instanceId === instanceFilter);
    }

    // Apply category filter
    if (categoryFilter && categoryFilter !== 'all') {
      result = result.filter(log => log && log.category === categoryFilter);
    }

    // Apply date range filter
    if (startDate || endDate) {
      result = result.filter(log => {
        if (!log || !log.timestamp) return false;
        
        const logTime = new Date(log.timestamp).getTime();
        if (isNaN(logTime)) return false;
        
        let startTime = 0;
        if (startDate && startDate.trim()) {
          const start = new Date(startDate);
          if (!isNaN(start.getTime())) {
            startTime = start.getTime();
          }
        }
        
        let endTime = Date.now();
        if (endDate && endDate.trim()) {
          const end = new Date(endDate);
          if (!isNaN(end.getTime())) {
            endTime = end.getTime();
          }
        }
        
        return logTime >= startTime && logTime <= endTime;
      });
    }

    // Set filtered results
    filteredLogs = result;
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
        format: loggerSettings.exportFormat
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
    showClearConfirmation = true;
  }

  async function handleClearConfirm() {
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

  function handleClearCancel() {
    showClearConfirmation = false;
  }

  // Show statistics modal
  function showStats() {
    showStatistics = true;
  }
  
  function closeStatistics() {
    showStatistics = false;
  }

  // Settings functionality
  function showSettingsModal() {
    showSettings = true;
  }
  
  async function handleSettingsSave(event) {
    const newSettings = { ...event.detail };
    
    try {
      // Save settings via IPC
      const result = await window.electron.invoke('logger-save-settings', newSettings);
      
      if (result.success) {
        // If maxLogs changed, trim current logs
        if (newSettings.maxLogs !== loggerSettings.maxLogs) {
          logs = logs.slice(0, newSettings.maxLogs);
        }
        
        loggerSettings = result.settings;
        
        // Apply settings immediately
        levelFilter = loggerSettings.logLevel;
        showSettings = false;
      } else {
        console.error('Failed to save logger settings:', result.error);
      }
    } catch (error) {
      console.error('Error saving logger settings:', error);
    }
  }
  
  function closeSettings() {
    showSettings = false;
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
      <button 
        class="settings-button"
        on:click={showSettingsModal}
        title="Logger Settings"
        aria-label="Open logger settings"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
          <path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.6,107.6,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3.18-3.18L186,40.54a8,8,0,0,0-3.94-6,107.29,107.29,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3.18,3.18L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.6,107.6,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3.18,3.18L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3.18-3.18L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z"></path>
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
            on:keydown={handleSearchKeydown}
            class="search-input"
          />
        </div>
      </div>



      <!-- Main Content Area -->
      <div class="main-content-area">
        <!-- Log Table -->
        <div class="log-table-section" class:compressed={selectedLog}>
          <LogTable 
            logs={filteredLogs}
            {selectedLog}
            {formatTimestamp}
            {getLevelColor}
            on:selectLog={(e) => selectLog(e.detail)}
            {loading}
          />
        </div>

        <!-- Log Details -->
        {#if selectedLog}
          <div class="log-details-section">
            <div class="details-header-bar">
              <h3>Log Details</h3>
              <button 
                class="close-details-button"
                on:click={() => selectedLog = null}
                title="Close details"
                aria-label="Close log details"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
                  <path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path>
                </svg>
              </button>
            </div>
            <LogDetails log={selectedLog} />
          </div>
        {/if}
      </div>

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
  on:save={handleSettingsSave}
  on:close={closeSettings}
/>

<!-- Export Success Modal -->
<ExportSuccessModal bind:visible={showExportModal} filePath={exportFilePath} count={exportCount} />

<!-- Clear Logs Confirmation Modal -->
<ConfirmationModal
  bind:visible={showClearConfirmation}
  title="Clear All Logs"
  message="Are you sure you want to clear all logs from memory? This action cannot be undone."
  confirmText="Clear All"
  cancelText="Cancel"
  type="danger"
  on:confirm={handleClearConfirm}
  on:cancel={handleClearCancel}
/>

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

  .settings-button {
    background: none;
    border: none;
    color: #90adcb;
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 0.375rem;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .settings-button:hover {
    background: #223649;
    color: white;
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
    height: 100%;
    min-height: 0;
  }

  .search-bar-row {
    padding: 0 1rem;
  }

  .main-content-area {
    display: flex;
    flex-direction: row;
    gap: 1rem;
    flex: 1;
    min-height: 0;
  }

  .log-table-section {
    flex: 1;
    min-width: 0;
    min-height: 0;
    transition: flex 0.3s ease;
    display: flex;
    flex-direction: column;
  }

  .log-table-section.compressed {
    flex: 0.6;
  }

  .log-details-section {
    flex: 0.4;
    min-width: 300px;
    background: #182634;
    border-radius: 0.5rem;
    border: 1px solid #314d68;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    max-height: 100%;
  }

  .details-header-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    border-bottom: 1px solid #314d68;
    background: #223649;
  }

  .details-header-bar h3 {
    margin: 0;
    color: white;
    font-size: 1rem;
    font-weight: 600;
  }

  .close-details-button {
    background: none;
    border: none;
    color: #90adcb;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.25rem;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-details-button:hover {
    background: #314d68;
    color: white;
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

    .main-content-area {
      flex-direction: column;
    }

    .log-table-section.compressed {
      flex: 1;
    }

    .log-details-section {
      flex: none;
      min-width: auto;
      max-height: 40vh;
      overflow-y: auto;
    }
  }

  @media (max-width: 1024px) {
    .main-content-area {
      flex-direction: column;
    }

    .log-table-section.compressed {
      flex: 1;
    }

    .log-details-section {
      flex: none;
      min-width: auto;
      max-height: 50vh;
      overflow-y: auto;
    }
  }
</style> 