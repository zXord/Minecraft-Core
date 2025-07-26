<script>
  import { onMount, onDestroy } from "svelte";
  import logger from "../../utils/logger.js";
  import LoggerFilters from "./LoggerFilters.svelte";
  import LogTable from "./LogTable.svelte";
  import LogDetails from "./LogDetails.svelte";
  import LoggerFooter from "./LoggerFooter.svelte";
  import LoggerStatistics from "./LoggerStatistics.svelte";
  import LoggerSettings from "./LoggerSettings.svelte";
  import ExportSuccessModal from "./ExportSuccessModal.svelte";
  import ConfirmationModal from "./ConfirmationModal.svelte";

  // State variables
  let logs = [];
  let filteredLogs = []; // Always initialized as empty array
  let selectedLog = null;
  let loading = true;
  let searchTerm = "";
  let stats = {};
  let showStatistics = false;
  let showExportModal = false;
  let exportFilePath = "";
  let exportCount = 0;
  let showSettings = false;
  let showClearConfirmation = false;
  let loggerSettings = {
    maxLogs: 1000,
    logLevel: "all",
    exportFormat: "json",
    maxFileSize: 50,
    maxFiles: 5,
    retentionDays: 7,
  };

  // Filter states
  let levelFilter = "all";
  let instanceFilter = "all";
  let categoryFilter = "all";
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
    debug: "#6b7280", // gray
    info: "#3b82f6", // blue
    warn: "#f59e0b", // yellow
    error: "#ef4444", // red
    fatal: "#7f1d1d", // dark red
  };

  onMount(async () => {
    // Component mounting - logging disabled

    try {
      await initializeLogger();
      setupRealTimeStreaming();
      setupFilterOptionsRefresh();

      // Initialization success - logging disabled
    } catch (error) {
      logger.error(`LoggerWindow initialization failed: ${error.message}`, {
        category: "ui",
        data: {
          component: "LoggerWindow",
          function: "onMount",
          errorType: error.constructor.name,
          errorMessage: error.message,
        },
      });
    }
  });

  let filterRefreshInterval;

  onDestroy(() => {
    // Component unmounting - logging disabled

    if (unsubscribeNewLog) unsubscribeNewLog();
    if (unsubscribeLogsCleared) unsubscribeLogsCleared();
    if (filterRefreshInterval) clearInterval(filterRefreshInterval);
  });

  async function initializeLogger() {
    // Logger initialization - logging disabled

    try {
      // Check if electron IPC is available
      if (!window.electron || !window.electron.invoke) {
        throw new Error(
          "Electron IPC not available - logger window communication will fail",
        );
      }

      // Load saved settings first
      let settingsResult;
      try {
        settingsResult = await window.electron.invoke("logger-get-settings");
      } catch (settingsError) {
        logger.error("Failed to load logger settings via IPC", {
          category: "ui",
          data: {
            component: "LoggerWindow",
            function: "initializeLogger",
            operation: "load_settings",
            errorType: settingsError.constructor.name,
            errorMessage: settingsError.message,
            communicationFailure: true,
          },
        });
        throw new Error(
          `Settings communication failed: ${settingsError.message}`,
        );
      }

      if (settingsResult.success) {
        loggerSettings = settingsResult.settings;
        levelFilter = loggerSettings.logLevel;

        // Settings loaded - logging disabled
      } else {
        // Settings load warning - logging disabled
      }

      // Load initial logs - use saved maxLogs setting
      let logsResult;
      try {
        logsResult = await logger.getLogs({ limit: loggerSettings.maxLogs });
      } catch (logsError) {
        logger.error("Failed to load initial logs via IPC", {
          category: "ui",
          data: {
            component: "LoggerWindow",
            function: "initializeLogger",
            operation: "load_logs",
            errorType: logsError.constructor.name,
            errorMessage: logsError.message,
            communicationFailure: true,
          },
        });
        throw new Error(`Logs communication failed: ${logsError.message}`);
      }

      if (logsResult.success) {
        logs = logsResult.logs || [];
        // Explicitly apply initial filters
        applyFilters();

        // Initial logs loaded - logging disabled
      } else {
        logger.warn("Failed to load initial logs", {
          category: "ui",
          data: {
            component: "LoggerWindow",
            function: "initializeLogger",
            operation: "load_logs",
            error: logsResult.error,
            communicationFailure: true,
          },
        });
        logs = []; // Fallback to empty array
      }

      // Load filter options with individual error handling
      try {
        const [instancesResult, categoriesResult, statsResult] =
          await Promise.all([
            logger
              .getInstances()
              .catch((err) => ({ success: false, error: err.message })),
            logger
              .getCategories()
              .catch((err) => ({ success: false, error: err.message })),
            logger
              .getStats()
              .catch((err) => ({ success: false, error: err.message })),
          ]);

        if (instancesResult.success) {
          availableInstances = instancesResult.instances || [];
        } else {
          logger.warn("Failed to load available instances", {
            category: "ui",
            data: {
              component: "LoggerWindow",
              function: "initializeLogger",
              operation: "load_instances",
              error: instancesResult.error,
              communicationFailure: true,
            },
          });
          availableInstances = [];
        }

        if (categoriesResult.success) {
          availableCategories = categoriesResult.categories || [];
        } else {
          // Categories load warning - logging disabled
          availableCategories = [];
        }

        if (statsResult.success) {
          stats = statsResult.stats || {};
        } else {
          // Statistics load warning - logging disabled
          stats = {};
        }

        // Filter options loaded - logging disabled
      } catch (filterError) {
        logger.error("Failed to load filter options", {
          category: "ui",
          data: {
            component: "LoggerWindow",
            function: "initializeLogger",
            operation: "load_filter_options",
            errorType: filterError.constructor.name,
            errorMessage: filterError.message,
            communicationFailure: true,
          },
        });

        // Set fallback values
        availableInstances = [];
        availableCategories = [];
        stats = {};
      }
    } catch (error) {
      logger.error(`Failed to initialize logger window: ${error.message}`, {
        category: "ui",
        data: {
          component: "LoggerWindow",
          function: "initializeLogger",
          errorType: error.constructor.name,
          errorMessage: error.message,
          communicationFailure: true,
        },
      });

      // Set fallback state for failed initialization
      logs = [];
      filteredLogs = [];
      availableInstances = [];
      availableCategories = [];
      stats = {};
    } finally {
      loading = false;
    }
  }

  function setupFilterOptionsRefresh() {
    // Refresh filter options every 5 seconds to catch new instances/categories
    filterRefreshInterval = setInterval(async () => {
      try {
        const [instancesResult, categoriesResult] = await Promise.all([
          logger.getInstances(),
          logger.getCategories(),
        ]);

        if (instancesResult.success) {
          availableInstances = instancesResult.instances || [];
        }

        if (categoriesResult.success) {
          availableCategories = categoriesResult.categories || [];
        }
      } catch (error) {
        // Silent refresh failure - don't spam logs
      }
    }, 5000);
  }

  function setupRealTimeStreaming() {
    // Real-time streaming setup - logging disabled

    try {
      // Listen for new log entries
      if (window.electron && window.electron.on) {
        const newLogHandler = (logEntry) => {
          logs = [logEntry, ...logs].slice(0, loggerSettings.maxLogs);

          // Auto-scroll to top if showing recent logs and user is near the top
          if (isShowingRecentLogs() && isUserNearTop()) {
            setTimeout(() => {
              const tableWrapper = document.querySelector(".table-wrapper");
              if (tableWrapper) {
                tableWrapper.scrollTop = 0;
              }
            }, 50);
          }
        };

        const logsClearedHandler = () => {
          // Logs cleared event - logging disabled

          logs = [];
          filteredLogs = [];
          selectedLog = null;
        };

        window.electron.on("logger-new-log", newLogHandler);
        window.electron.on("logger-logs-cleared", logsClearedHandler);

        // Store cleanup functions
        unsubscribeNewLog = () =>
          window.electron.removeListener("logger-new-log", newLogHandler);
        unsubscribeLogsCleared = () =>
          window.electron.removeListener(
            "logger-logs-cleared",
            logsClearedHandler,
          );

        // Real-time streaming completed - logging disabled
      } else {
        // Real-time streaming IPC warning - logging disabled
      }
    } catch (error) {
      logger.error(`Failed to setup real-time streaming: ${error.message}`, {
        category: "ui",
        data: {
          component: "LoggerWindow",
          function: "setupRealTimeStreaming",
          errorType: error.constructor.name,
          errorMessage: error.message,
        },
      });
    }
  }

  function isShowingRecentLogs() {
    // Check if we're showing recent logs (no time filters applied)
    return (
      !startDate &&
      !endDate &&
      levelFilter === "all" &&
      instanceFilter === "all" &&
      categoryFilter === "all" &&
      !searchTerm.trim()
    );
  }

  function isUserNearTop() {
    // Check if user is near the top of the table (within 100px)
    const tableWrapper = document.querySelector(".table-wrapper");
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

  // Track filter changes for logging
  let previousLevelFilter = "all";
  let previousInstanceFilter = "all";
  let previousCategoryFilter = "all";
  let previousStartDate = null;
  let previousEndDate = null;

  $: if (
    levelFilter !== previousLevelFilter ||
    instanceFilter !== previousInstanceFilter ||
    categoryFilter !== previousCategoryFilter ||
    startDate !== previousStartDate ||
    endDate !== previousEndDate
  ) {
    // Log filter changes
    const filterChanges = [];
    if (levelFilter !== previousLevelFilter) {
      filterChanges.push({
        type: "level",
        from: previousLevelFilter,
        to: levelFilter,
      });
      previousLevelFilter = levelFilter;
    }
    if (instanceFilter !== previousInstanceFilter) {
      filterChanges.push({
        type: "instance",
        from: previousInstanceFilter,
        to: instanceFilter,
      });
      previousInstanceFilter = instanceFilter;
    }
    if (categoryFilter !== previousCategoryFilter) {
      filterChanges.push({
        type: "category",
        from: previousCategoryFilter,
        to: categoryFilter,
      });
      previousCategoryFilter = categoryFilter;
    }
    if (startDate !== previousStartDate) {
      filterChanges.push({
        type: "startDate",
        from: previousStartDate,
        to: startDate,
      });
      previousStartDate = startDate;
    }
    if (endDate !== previousEndDate) {
      filterChanges.push({
        type: "endDate",
        from: previousEndDate,
        to: endDate,
      });
      previousEndDate = endDate;
    }

    if (filterChanges.length > 0) {
      // Filter changes - logging disabled
    }

    // Immediate update for filter changes
    applyFilters();
  }

  let filterTimeout;

  function handleSearchKeydown(event) {
    if (event.key === "Escape") {
      // Search cleared - logging disabled

      searchTerm = "";
      event.target.blur();
    } else if (event.key === "Enter") {
      // Search executed - logging disabled
    }
  }

  // React to settings changes - removed reactive statement that was causing issues

  function applyFiltersDebounced() {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(applyFilters, 150);
  }

  // Track search term changes for logging
  let previousSearchTerm = "";
  $: if (searchTerm !== previousSearchTerm) {
    if (searchTerm.trim() !== previousSearchTerm.trim()) {
      // Search changed - logging disabled
    }
    previousSearchTerm = searchTerm;
  }

  function applyFilters() {
    // Filter start logging disabled to prevent recursion

    try {
      // Ensure we have valid logs array
      if (!logs || !Array.isArray(logs)) {
        filteredLogs = [];
        // Invalid logs warning - logging disabled
        return;
      }

      let result = [...logs];

      // Apply search filter
      if (searchTerm && searchTerm.trim()) {
        const search = searchTerm.trim().toLowerCase();

        result = result.filter((log) => {
          if (!log) return false;
          return (
            (log.message || "").toLowerCase().includes(search) ||
            (log.instanceId || "").toLowerCase().includes(search) ||
            (log.category || "").toLowerCase().includes(search) ||
            (log.level || "").toLowerCase().includes(search)
          );
        });

        // Search filter applied - logging disabled
      }

      // Apply level filter (supports multi-select)
      if (levelFilter && levelFilter !== "all") {
        const selectedLevels = levelFilter.split(",");
        result = result.filter(
          (log) => log && selectedLevels.includes(log.level),
        );

        // Level filter applied - logging disabled
      }

      // Apply instance filter (supports multi-select)
      if (instanceFilter && instanceFilter !== "all") {
        const selectedInstances = instanceFilter.split(",");
        result = result.filter(
          (log) => log && selectedInstances.includes(log.instanceId),
        );

        // Instance filter applied - logging disabled
      }

      // Apply category filter (supports multi-select)
      if (categoryFilter && categoryFilter !== "all") {
        const selectedCategories = categoryFilter.split(",");
        result = result.filter(
          (log) => log && selectedCategories.includes(log.category),
        );

        // Category filter applied - logging disabled
      }

      // Apply date range filter
      if (startDate || endDate) {
        result = result.filter((log) => {
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

        // Date range filter applied - logging disabled
      }

      // Set filtered results
      filteredLogs = result;

      // Filtering logging disabled to prevent recursion
    } catch (error) {
      logger.error(`Filter application failed: ${error.message}`, {
        category: "ui",
        data: {
          component: "LoggerWindow",
          function: "applyFilters",
          errorType: error.constructor.name,
          errorMessage: error.message,
          totalLogs: logs?.length || 0,
        },
      });

      // Fallback to empty array on error
      filteredLogs = [];
    }
  }

  // Log selection
  function selectLog(log) {
    // Log selected - logging disabled

    selectedLog = log;
  }

  // Export functionality
  async function exportLogs() {
    // Export operation starting - logging disabled

    try {
      const filters = {
        search: searchTerm.trim() || undefined,
        level: levelFilter !== "all" ? levelFilter : undefined,
        instanceId: instanceFilter !== "all" ? instanceFilter : undefined,
        category: categoryFilter !== "all" ? categoryFilter : undefined,
        startTime: startDate || undefined,
        endTime: endDate || undefined,
        format: loggerSettings.exportFormat,
      };

      const result = await logger.exportLogs(filters);

      if (result.success) {
        exportFilePath = result.path;
        exportCount = result.count;
        showExportModal = true;

        // Export completed - logging disabled
      } else {
        // Export failed - logging disabled

        alert(`Export failed: ${result.error}`);
      }
    } catch (error) {
      logger.error(`Log export operation failed: ${error.message}`, {
        category: "ui",
        data: {
          component: "LoggerWindow",
          function: "exportLogs",
          errorType: error.constructor.name,
          errorMessage: error.message,
          filteredLogsCount: filteredLogs.length,
          format: loggerSettings.exportFormat,
          communicationFailure: true,
        },
      });

      alert(`Export error: ${error.message}`);
    }
  }

  // Clear logs
  async function clearLogs() {
    // Clear operation initiated - logging disabled

    showClearConfirmation = true;
  }

  async function handleClearConfirm() {
    // Clear operation executing - logging disabled

    try {
      const result = await logger.clearLogs();

      if (result.success) {
        logs = [];
        filteredLogs = [];
        selectedLog = null;

        // Logs cleared successfully - logging disabled
      } else {
        // Clear failed - logging disabled

        alert(`Failed to clear logs: ${result.error}`);
      }
    } catch (error) {
      logger.error(`Log clear operation failed: ${error.message}`, {
        category: "ui",
        data: {
          component: "LoggerWindow",
          function: "handleClearConfirm",
          errorType: error.constructor.name,
          errorMessage: error.message,
          logsCount: logs.length,
          communicationFailure: true,
        },
      });

      alert(`Clear error: ${error.message}`);
    }
  }

  function handleClearCancel() {
    // Clear cancelled - logging disabled

    showClearConfirmation = false;
  }

  // Show statistics modal
  function showStats() {
    // Statistics modal opening - logging disabled

    showStatistics = true;
  }

  function closeStatistics() {
    // Statistics modal closing - logging disabled

    showStatistics = false;
  }

  // Settings functionality
  function showSettingsModal() {
    // Settings modal opening - logging disabled

    showSettings = true;
  }

  async function handleSettingsSave(event) {
    const newSettings = { ...event.detail };

    // Settings saving - logging disabled

    try {
      // Save settings via IPC
      const result = await window.electron.invoke(
        "logger-save-settings",
        newSettings,
      );
      if (result.success) {
        // If maxLogs changed, trim current logs
        if (newSettings.maxLogs !== loggerSettings.maxLogs) {
          logs = logs.slice(0, newSettings.maxLogs);

          // Logs trimmed - logging disabled
        }

        loggerSettings = result.settings;

        // Apply settings immediately
        levelFilter = loggerSettings.logLevel;
        showSettings = false;

        // Settings saved successfully - logging disabled
      } else {
        // Settings save failed - logging disabled

        console.error("Failed to save logger settings:", result.error);
      }
    } catch (error) {
      // Settings save error - logging disabled

      console.error("Error saving logger settings:", error);
    }
  }

  function closeSettings() {
    // Settings modal closing - logging disabled

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
          <path
            d="M44 4H30.6666V17.3334H17.3334V30.6666H4V44H44V4Z"
            fill="currentColor"
          ></path>
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
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          fill="currentColor"
          viewBox="0 0 256 256"
        >
          <path
            d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.6,107.6,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3.18-3.18L186,40.54a8,8,0,0,0-3.94-6,107.29,107.29,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3.18,3.18L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.6,107.6,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3.18,3.18L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3.18-3.18L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z"
          ></path>
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
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24px"
              height="24px"
              fill="currentColor"
              viewBox="0 0 256 256"
            >
              <path
                d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"
              ></path>
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
                on:click={() => (selectedLog = null)}
                title="Close details"
                aria-label="Close log details"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  fill="currentColor"
                  viewBox="0 0 256 256"
                >
                  <path
                    d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"
                  ></path>
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
<ExportSuccessModal
  bind:visible={showExportModal}
  filePath={exportFilePath}
  count={exportCount}
/>

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
