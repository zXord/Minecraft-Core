<script>
  import { onMount, onDestroy, tick } from "svelte";

  import { SvelteSet } from "svelte/reactivity";
  import ConfirmationDialog from "./common/ConfirmationDialog.svelte";
  import { serverState } from "../stores/serverState.js";
  import { writable } from "svelte/store";
  import logger from "../utils/logger.js";
  import {
    calculateTotalSize,
    formatSize,
    getCachedSize,
    setCachedSize,
    invalidateSizeCache,
    addSizeChangeListenerOptimized,
    BackupStatistics,
    analyzeRetentionWarnings,
    generateRetentionPreview,
    optimizeRetentionPolicies,
  } from "../utils/backup/index.js";
  import RetentionPreviewDialog from "./backup/RetentionPreviewDialog.svelte";
  import RetentionWarnings from "./backup/RetentionWarnings.svelte";
  import RetentionOptimization from "./backup/RetentionOptimization.svelte";

  let sizeChangeCleanup = null;

  onMount(() => {
    logger.info("Backups component mounted", {
      category: "ui",
      data: {
        component: "Backups",
        lifecycle: "onMount",
        serverPath,
        hasServerPath: !!serverPath,
      },
    });

    // Set up size change listener for real-time updates
    if (serverPath) {
      sizeChangeCleanup = addSizeChangeListenerOptimized((changeData) => {
        if (changeData.serverPath === serverPath) {
          logger.debug("Size change detected, updating UI", {
            category: "ui",
            data: {
              component: "Backups",
              serverPath: changeData.serverPath,
              totalSize: changeData.totalSize,
              changes: changeData.changes,
            },
          });

          // Update total size without blocking UI
          updateTotalSize(false, true);
        }
      });
    }
  });

  onDestroy(() => {
    logger.debug("Backups component destroyed", {
      category: "ui",
      data: {
        component: "Backups",
        lifecycle: "onDestroy",
      },
    });

    // Clean up timeout when component is destroyed
    if (successMessageTimeout) {
      clearTimeout(successMessageTimeout);
      successMessageTimeout = null;
    }

    // Clean up size change listener
    if (sizeChangeCleanup) {
      sizeChangeCleanup();
      sizeChangeCleanup = null;
    }
  });

  export let serverPath = "";
  let backups = [];
  let loading = false;
  let error = "";
  let showDeleteDialog = false;
  let showRenameDialog = false;
  let backupToDelete = null;
  let backupToRename = null;
  let newName = "";
  let status = "";
  let lastServerPath = "";
  let renameInputEl;
  let renameDialogJustOpened = false;
  let showRestoreDialog = false;
  let backupToRestore = null;
  let selectedBackups = writable(new SvelteSet());
  let selectAll = false;
  let showBulkDeleteDialog = false;
  let lastAutoBackup = "";

  // Total size display variables
  let totalBackupSize = 0;
  let totalSizeLoading = false;
  let totalSizeError = "";

  // Automation settings
  let autoBackupEnabled = false;
  let backupFrequency = 86400000; // Default to daily (24 hours in ms)
  let backupType = "world";

  let runOnLaunch = false;
  let backupHour = 3; // Default to 3 AM
  let backupMinute = 0; // Default to 00 minutes
  let backupDay = 0; // Default to Sunday (0-based, 0=Sunday, 6=Saturday)
  let manualBackupType = "world";
  let nextBackupTimeIso = null;
  let remainingTime = "";

  // Retention policy settings
  let sizeRetentionEnabled = false;
  let maxSizeValue = 10;
  let maxSizeUnit = "GB";
  let ageRetentionEnabled = false;
  let maxAgeValue = 30;
  let maxAgeUnit = "days";
  let countRetentionEnabled = false;
  let maxCountValue = 14;

  // Statistics variables
  let backupStatistics = null;
  let statisticsLoading = false;
  let statisticsError = "";
  let showStatisticsModal = false;

  // Retention warnings and preview variables
  let retentionWarnings = [];
  let showRetentionPreview = false;
  let retentionPreview = null;
  let previewLoading = false;

  // Retention optimization variables
  let retentionOptimization = null;
  let optimizationLoading = false;
  let showOptimization = false;

  // Button state management with persistence
  let retentionButtonsDisabled = false;
  let appliedSettingsHash = undefined; // undefined = not loaded, null = loaded but empty, string = has value
  let showSuccessMessage = false;
  let successMessageTimeout = null;
  let hasInitialized = false; // Track if we've initialized for this serverPath
  let settingsLoaded = false; // Track if retention settings have been loaded

  // Define frequency options (in milliseconds)
  const frequencyOptions = [
    { value: 900000, label: "Every 15 minutes" },
    { value: 1800000, label: "Every 30 minutes" },
    { value: 3600000, label: "Hourly" },
    { value: 21600000, label: "Every 6 hours" },
    { value: 86400000, label: "Daily" },
    { value: 604800000, label: "Weekly" },
  ];

  // Day names for weekly backup day selection
  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  $: isServerRunning = $serverState.status === "Running";
  $: $selectedBackups;

  // Set visible based on frequency selection - show time selector for all except very short intervals
  $: showTimeSelector = backupFrequency >= 3600000; // Show for hourly and longer options

  // Only show day selector for weekly backups
  $: showDaySelector = backupFrequency >= 604800000; // Weekly

  // Update warnings when retention settings change and settings are loaded
  $: if (backups && backups.length > 0 && settingsLoaded) {
    // Debounce warnings update to avoid excessive calls
    const updateWarnings = () => updateRetentionWarnings();
    setTimeout(updateWarnings, 500);
  }

  // Generate hash of current retention settings
  function getSettingsHash() {
    const settings = {
      sizeRetentionEnabled,
      maxSizeValue,
      maxSizeUnit,
      ageRetentionEnabled,
      maxAgeValue,
      maxAgeUnit,
      countRetentionEnabled,
      maxCountValue,
    };
    return JSON.stringify(settings);
  }

  // Save applied settings hash to localStorage
  function saveAppliedSettingsHash(hash) {
    if (serverPath) {
      try {
        const key = `retention-applied-${serverPath}`;
        localStorage.setItem(key, hash);
      } catch (e) {
        console.warn("Failed to save retention state to localStorage:", e);
      }
    }
  }

  // Load applied settings hash from localStorage
  function loadAppliedSettingsHash() {
    if (serverPath) {
      try {
        const key = `retention-applied-${serverPath}`;
        return localStorage.getItem(key);
      } catch (e) {
        console.warn("Failed to load retention state from localStorage:", e);
      }
    }
    return null;
  }

  // Clear applied settings hash from localStorage
  function clearAppliedSettingsHash() {
    if (serverPath) {
      try {
        const key = `retention-applied-${serverPath}`;
        localStorage.removeItem(key);
      } catch (e) {
        console.warn("Failed to clear retention state from localStorage:", e);
      }
    }
  }

  // Initialize state when serverPath changes
  $: if (serverPath && serverPath !== lastServerPath) {
    hasInitialized = false;
    appliedSettingsHash = undefined;
    settingsLoaded = false;
  }

  // Load localStorage when we have serverPath but haven't initialized yet
  $: if (serverPath && !hasInitialized) {
    const loaded = loadAppliedSettingsHash();
    appliedSettingsHash = loaded || null; // Convert empty string to null
    hasInitialized = true;
  }

  // Check if retention settings have changed to re-enable buttons
  // Only run comparison when both settings and localStorage are fully loaded
  $: if (
    serverPath &&
    appliedSettingsHash !== undefined && // localStorage has been loaded
    settingsLoaded && // Backend settings have been loaded
    sizeRetentionEnabled !== undefined &&
    maxSizeValue !== undefined &&
    maxSizeUnit !== undefined &&
    ageRetentionEnabled !== undefined &&
    maxAgeValue !== undefined &&
    maxAgeUnit !== undefined &&
    countRetentionEnabled !== undefined &&
    maxCountValue !== undefined
  ) {
    const currentSettingsHash = getSettingsHash();

    // Compare current settings with applied settings
    if (appliedSettingsHash && currentSettingsHash !== appliedSettingsHash) {
      retentionButtonsDisabled = false;
      showSuccessMessage = false;

      // Clear the applied hash and localStorage since settings changed
      appliedSettingsHash = null;
      clearAppliedSettingsHash();

      // Clear any existing timeout
      if (successMessageTimeout) {
        clearTimeout(successMessageTimeout);
        successMessageTimeout = null;
      }
    } else if (
      appliedSettingsHash &&
      currentSettingsHash === appliedSettingsHash
    ) {
      retentionButtonsDisabled = true;
      // Don't automatically show success message here - only show it after applying
    } else if (appliedSettingsHash === null) {
      retentionButtonsDisabled = false;
      showSuccessMessage = false;
    }
  }

  // Calculate and update total backup size with performance optimizations
  async function updateTotalSize(forceRefresh = false, useBackground = false) {
    if (!backups || backups.length === 0) {
      totalBackupSize = 0;
      totalSizeError = "";
      return;
    }

    // Create cache key based on backup names and sizes
    const cacheKey = `total-size-${serverPath}-${backups.map((b) => `${b.name}:${b.size || 0}`).join(",")}`;

    // Check cache first unless force refresh is requested
    if (!forceRefresh) {
      const cached = getCachedSize(cacheKey);
      if (cached !== null) {
        totalBackupSize = cached;
        totalSizeError = "";
        return;
      }
    }

    totalSizeLoading = true;
    totalSizeError = "";

    try {
      // Use optimized calculation with server path for better performance
      const calculationOptions = {
        useOptimized: true,
        forceRefresh,
        enableBackground: true,
        enableIncremental: true,
      };

      if (useBackground) {
        // Use background calculation to avoid blocking UI
        totalBackupSize = await calculateTotalSize(
          backups,
          serverPath,
          calculationOptions,
        );
      } else {
        totalBackupSize = await calculateTotalSize(
          backups,
          serverPath,
          calculationOptions,
        );
      }

      // Cache the result
      setCachedSize(cacheKey, totalBackupSize);

      logger.debug("Total backup size calculated with optimizations", {
        category: "ui",
        data: {
          component: "Backups",
          function: "updateTotalSize",
          totalSize: totalBackupSize,
          backupsCount: backups.length,
          cached: !forceRefresh,
          useBackground,
          serverPath,
        },
      });
    } catch (e) {
      totalSizeError = "Failed to calculate total size";
      logger.error("Failed to calculate total backup size", {
        category: "ui",
        data: {
          component: "Backups",
          function: "updateTotalSize",
          errorMessage: e.message,
          serverPath,
        },
      });
    }

    totalSizeLoading = false;
  }

  // Calculate backup statistics with performance optimizations
  async function updateStatistics(useBackground = false) {
    if (!backups || backups.length === 0) {
      backupStatistics = null;
      statisticsError = "";
      return;
    }

    statisticsLoading = true;
    statisticsError = "";

    try {
      // Calculate retention savings if retention policies are enabled
      let retentionSavings = null;
      if (
        sizeRetentionEnabled ||
        ageRetentionEnabled ||
        countRetentionEnabled
      ) {
        // This would be populated from actual retention policy execution results
        // For now, we'll pass null and let the statistics service handle it
        retentionSavings = { spaceSaved: 0 };
      }

      const statisticsOptions = {
        useOptimized: true,
        forceRefresh: false,
        enableBackground: useBackground,
        useIncremental: true,
      };

      if (useBackground) {
        // Queue background update and use cached result if available
        BackupStatistics.queueBackgroundUpdate(serverPath, backups, 1);

        // Try to get cached result first
        backupStatistics = await BackupStatistics.calculateStatistics(
          backups,
          retentionSavings,
          serverPath,
          { ...statisticsOptions, forceRefresh: false },
        );
      } else {
        backupStatistics = await BackupStatistics.calculateStatistics(
          backups,
          retentionSavings,
          serverPath,
          statisticsOptions,
        );
      }

      logger.debug("Backup statistics calculated with optimizations", {
        category: "ui",
        data: {
          component: "Backups",
          function: "updateStatistics",
          totalBackups: backupStatistics.totalBackups,
          totalSize: backupStatistics.totalSize,
          growthTrendLength: backupStatistics.sizeGrowthTrend.length,
          useBackground,
          incremental: backupStatistics.incremental || false,
          serverPath,
        },
      });

      // Update optimization if it's currently shown
      if (showOptimization && !optimizationLoading) {
        await generateOptimization();
      }
    } catch (e) {
      statisticsError = "Failed to calculate statistics";
      logger.error("Failed to calculate backup statistics", {
        category: "ui",
        data: {
          component: "Backups",
          function: "updateStatistics",
          errorMessage: e.message,
          serverPath,
        },
      });
    }

    statisticsLoading = false;
  }

  // Fetch backups from server
  async function fetchBackups() {
    logger.info("Fetching backups list", {
      category: "ui",
      data: {
        component: "Backups",
        function: "fetchBackups",
        serverPath,
        hasServerPath: !!serverPath,
      },
    });

    loading = true;
    error = "";
    try {
      backups = await window.electron.invoke("backups:list", { serverPath });

      logger.info("Backups list fetched successfully", {
        category: "ui",
        data: {
          component: "Backups",
          function: "fetchBackups",
          backupsCount: backups.length,
          serverPath,
        },
      });

      // Calculate total size after fetching backups using background processing
      await updateTotalSize(false, true);

      // Calculate statistics after fetching backups using background processing
      await updateStatistics(true);

      // Update retention warnings after fetching backups (only if settings are loaded)
      if (settingsLoaded) {
        await updateRetentionWarnings();
      }

      // Update last auto backup time if available
      const autoBackups = backups.filter(
        (b) =>
          b.metadata &&
          (b.metadata.trigger === "auto" ||
            b.metadata.trigger === "app-launch"),
      );
      if (autoBackups.length > 0) {
        // Sort by timestamp to get the most recent
        autoBackups.sort((a, b) => {
          const timeA = a.metadata?.timestamp
            ? new Date(a.metadata.timestamp).getTime()
            : new Date(a.created).getTime();
          const timeB = b.metadata?.timestamp
            ? new Date(b.metadata.timestamp).getTime()
            : new Date(b.created).getTime();
          return timeB - timeA;
        });
        if (autoBackups[0]?.metadata?.timestamp) {
          const date = new Date(autoBackups[0].metadata.timestamp);
          lastAutoBackup = date.toLocaleString();

          logger.debug("Last auto backup time updated", {
            category: "ui",
            data: {
              component: "Backups",
              function: "fetchBackups",
              lastAutoBackup,
              autoBackupsCount: autoBackups.length,
            },
          });
        }
      }
    } catch (e) {
      error = e.message || "Failed to load backups";
      logger.error("Failed to fetch backups", {
        category: "ui",
        data: {
          component: "Backups",
          function: "fetchBackups",
          errorMessage: e.message,
          serverPath,
        },
      });
    }
    loading = false;
  }

  // Only fetch backups when serverPath is set, valid, and changes
  $: if (
    serverPath &&
    serverPath.trim() !== "" &&
    serverPath !== lastServerPath
  ) {
    logger.debug("Server path changed, loading backups and settings", {
      category: "ui",
      data: {
        component: "Backups",
        event: "serverPathChanged",
        oldPath: lastServerPath,
        newPath: serverPath,
      },
    });

    lastServerPath = serverPath;
    fetchBackups();
    loadAutomationSettings();
    loadRetentionSettings();
  }

  // Load automation settings from electron store
  async function loadAutomationSettings() {
    logger.debug("Loading automation settings", {
      category: "ui",
      data: {
        component: "Backups",
        function: "loadAutomationSettings",
      },
    });

    try {
      const result = await window.electron.invoke(
        "backups:get-automation-settings",
      );
      if (result && result.success && result.settings) {
        const settings = result.settings;
        autoBackupEnabled = settings.enabled || false;
        backupFrequency = settings.frequency || 86400000;
        backupType = settings.type || "world";
        manualBackupType = backupType;

        runOnLaunch = settings.runOnLaunch || false;
        backupHour = settings.hour || 3;
        backupMinute = settings.minute || 0;
        backupDay = settings.day !== undefined ? settings.day : 0;
        nextBackupTimeIso = settings.nextBackupTime || null;
        updateRemainingTime();

        logger.info("Automation settings loaded successfully", {
          category: "ui",
          data: {
            component: "Backups",
            function: "loadAutomationSettings",
            settings: {
              enabled: autoBackupEnabled,
              frequency: backupFrequency,
              type: backupType,
              runOnLaunch,
              hour: backupHour,
              minute: backupMinute,
              day: backupDay,
            },
          },
        });

        // If we have a last run time, update the UI
        if (settings.lastRun) {
          lastAutoBackup = new Date(settings.lastRun).toLocaleString();
        }
      }
    } catch (e) {
      logger.error("Failed to load automation settings", {
        category: "ui",
        data: {
          component: "Backups",
          function: "loadAutomationSettings",
          errorMessage: e.message,
        },
      });
    }
  }

  // Load retention policy settings
  async function loadRetentionSettings() {
    logger.debug("Loading retention policy settings", {
      category: "ui",
      data: {
        component: "Backups",
        function: "loadRetentionSettings",
      },
    });

    try {
      const result = await window.electron.invoke(
        "backups:get-retention-settings",
        { serverPath },
      );
      if (result && result.success && result.settings) {
        const settings = result.settings;
        sizeRetentionEnabled = settings.sizeRetentionEnabled || false;
        maxSizeValue = settings.maxSizeValue || 10;
        maxSizeUnit = settings.maxSizeUnit || "GB";
        ageRetentionEnabled = settings.ageRetentionEnabled || false;
        maxAgeValue = settings.maxAgeValue || 30;
        maxAgeUnit = settings.maxAgeUnit || "days";
        countRetentionEnabled = settings.countRetentionEnabled || false;
        maxCountValue = settings.maxCountValue || 14;
        settingsLoaded = true;

        logger.info("Retention policy settings loaded successfully", {
          category: "ui",
          data: {
            component: "Backups",
            function: "loadRetentionSettings",
            settings: {
              sizeRetentionEnabled,
              maxSizeValue,
              maxSizeUnit,
              ageRetentionEnabled,
              maxAgeValue,
              maxAgeUnit,
              countRetentionEnabled,
              maxCountValue,
            },
          },
        });
      }
    } catch (e) {
      logger.error("Failed to load retention policy settings", {
        category: "ui",
        data: {
          component: "Backups",
          function: "loadRetentionSettings",
          errorMessage: e.message,
        },
      });
    }
  }

  // Save retention policy settings
  async function saveRetentionSettings() {
    logger.info("Saving retention policy settings", {
      category: "ui",
      data: {
        component: "Backups",
        function: "saveRetentionSettings",
        settings: {
          sizeRetentionEnabled,
          maxSizeValue,
          maxSizeUnit,
          ageRetentionEnabled,
          maxAgeValue,
          maxAgeUnit,
          countRetentionEnabled,
          maxCountValue,
        },
        serverPath,
      },
    });

    try {
      await window.electron.invoke("backups:save-retention-settings", {
        serverPath,
        settings: {
          sizeRetentionEnabled,
          maxSizeValue,
          maxSizeUnit,
          ageRetentionEnabled,
          maxAgeValue,
          maxAgeUnit,
          countRetentionEnabled,
          maxCountValue,
        },
      });

      logger.info("Retention policy settings saved successfully", {
        category: "ui",
        data: {
          component: "Backups",
          function: "saveRetentionSettings",
        },
      });

      status = "Retention policy settings saved";
      setTimeout(() => (status = ""), 2000);

      // Don't automatically reset button state when saving - let the reactive statement handle it
      // The reactive statement will detect if settings changed from the applied state

      // Update warnings after saving settings
      if (settingsLoaded) {
        await updateRetentionWarnings();
      }
    } catch (e) {
      error =
        cleanErrorMessage(e.message) ||
        "Failed to save retention policy settings";
      logger.error("Failed to save retention policy settings", {
        category: "ui",
        data: {
          component: "Backups",
          function: "saveRetentionSettings",
          errorMessage: e.message,
        },
      });
    }
  }

  // Update retention warnings
  async function updateRetentionWarnings() {
    if (!backups || backups.length === 0) {
      retentionWarnings = [];
      return;
    }

    try {
      const settings = {
        sizeRetentionEnabled,
        maxSizeValue,
        maxSizeUnit,
        ageRetentionEnabled,
        maxAgeValue,
        maxAgeUnit,
        countRetentionEnabled,
        maxCountValue,
      };

      retentionWarnings = await analyzeRetentionWarnings(backups, settings);

      logger.debug("Retention warnings updated", {
        category: "ui",
        data: {
          component: "Backups",
          function: "updateRetentionWarnings",
          warningsCount: retentionWarnings.length,
          warningTypes: retentionWarnings.map((w) => w.type),
        },
      });
    } catch (e) {
      logger.error("Failed to update retention warnings", {
        category: "ui",
        data: {
          component: "Backups",
          function: "updateRetentionWarnings",
          errorMessage: e.message,
        },
      });
      retentionWarnings = [];
    }
  }

  // Generate retention policy preview with enhanced error handling
  async function generatePreview() {
    if (!backups || backups.length === 0) {
      error = "No backups available to preview retention policy";
      return;
    }

    previewLoading = true;
    showRetentionPreview = true;
    retentionPreview = null;
    error = ""; // Clear any previous errors

    try {
      // Validate settings before generating preview
      const settings = {
        sizeRetentionEnabled,
        maxSizeValue,
        maxSizeUnit,
        ageRetentionEnabled,
        maxAgeValue,
        maxAgeUnit,
        countRetentionEnabled,
        maxCountValue,
      };

      // Check if at least one retention policy is enabled
      if (
        !sizeRetentionEnabled &&
        !ageRetentionEnabled &&
        !countRetentionEnabled
      ) {
        error =
          "Please enable at least one retention policy (size, age, or count) to generate a preview";
        showRetentionPreview = false;
        return;
      }

      // Validate individual settings
      if (sizeRetentionEnabled && (!maxSizeValue || maxSizeValue <= 0)) {
        error = "Please enter a valid size limit value";
        showRetentionPreview = false;
        return;
      }

      if (ageRetentionEnabled && (!maxAgeValue || maxAgeValue <= 0)) {
        error = "Please enter a valid age limit value";
        showRetentionPreview = false;
        return;
      }

      if (countRetentionEnabled && (!maxCountValue || maxCountValue <= 0)) {
        error = "Please enter a valid count limit value";
        showRetentionPreview = false;
        return;
      }

      logger.debug("Generating retention preview with settings", {
        category: "ui",
        data: {
          component: "Backups",
          function: "generatePreview",
          settings,
          backupsCount: backups.length,
        },
      });

      retentionPreview = await generateRetentionPreview(backups, settings);

      if (!retentionPreview) {
        throw new Error(
          "No preview result returned from retention policy engine",
        );
      }

      logger.info("Retention preview generated successfully", {
        category: "ui",
        data: {
          component: "Backups",
          function: "generatePreview",
          totalBackups: retentionPreview.impact?.totalBackups || 0,
          backupsToDelete: retentionPreview.impact?.backupsToDelete || 0,
          spaceSaved: retentionPreview.impact?.spaceSaved || 0,
        },
      });
    } catch (e) {
      const errorMessage = e.message || "Unknown error occurred";
      error = `Unable to generate retention policy preview: ${errorMessage}`;

      logger.error("Failed to generate retention preview", {
        category: "ui",
        data: {
          component: "Backups",
          function: "generatePreview",
          errorMessage,
          stack: e.stack,
          settings: {
            sizeRetentionEnabled,
            maxSizeValue,
            maxSizeUnit,
            ageRetentionEnabled,
            maxAgeValue,
            maxAgeUnit,
            countRetentionEnabled,
            maxCountValue,
          },
        },
      });

      retentionPreview = null;
      showRetentionPreview = false;
    } finally {
      previewLoading = false;
    }
  }

  // Handle preview dialog confirmation
  async function handlePreviewConfirm() {
    showRetentionPreview = false;
    await applyRetentionPolicy();
  }

  // Handle preview dialog cancellation
  function handlePreviewCancel() {
    showRetentionPreview = false;
    retentionPreview = null;
  }

  // Apply retention policy with preview
  async function applyRetentionPolicyWithPreview() {
    await generatePreview();
  }

  // Generate retention optimization analysis
  async function generateOptimization() {
    // Start optimization analysis
    logger.debug("Retention optimization generation started", {
      category: "ui",
      data: {
        component: "Backups",
        function: "generateOptimization",
        backupCount: backups ? backups.length : 0,
        hasBackups: !!(backups && backups.length)
      }
    });

    if (!backups || backups.length === 0) {
      optimizationLoading = false; // prevent spinner hang when no backups
      logger.debug("Retention optimization skipped (no backups)", {
        category: "ui",
        data: { component: "Backups", function: "generateOptimization" }
      });
      return;
    }

    optimizationLoading = true;
    retentionOptimization = null;

    try {
      const settings = {
        sizeRetentionEnabled,
        maxSizeValue,
        maxSizeUnit,
        ageRetentionEnabled,
        maxAgeValue,
        maxAgeUnit,
        countRetentionEnabled,
        maxCountValue,
      };

      retentionOptimization = await optimizeRetentionPolicies(
        backups,
        settings,
      );

      logger.debug("Retention optimization raw result", {
        category: "ui",
        data: {
          component: "Backups",
            function: "generateOptimization",
            recommendationsCount: retentionOptimization?.recommendations?.length || 0,
            effectivenessScore: retentionOptimization?.effectiveness?.overallScore,
            backupCount: backups.length
        }
      });

      logger.info("Retention optimization analysis completed", {
        category: "ui",
        data: {
          component: "Backups",
          function: "generateOptimization",
          recommendationsCount: retentionOptimization.recommendations.length,
          effectivenessScore: retentionOptimization.effectiveness.overallScore,
        },
      });
    } catch (e) {
      logger.error("Failed to generate retention optimization", {
        category: "ui",
        data: {
          component: "Backups",
          function: "generateOptimization",
          errorMessage: e.message,
          stack: e.stack
        },
      });
      retentionOptimization = null;
    }
    optimizationLoading = false;
    logger.debug("Retention optimization generation finished", {
      category: "ui",
      data: {
        component: "Backups",
        function: "generateOptimization",
        loading: optimizationLoading,
        hasResult: !!retentionOptimization
      }
    });
  }

  // Toggle optimization display
  function toggleOptimization() {
    showOptimization = !showOptimization;
    if (showOptimization && !retentionOptimization && !optimizationLoading) {
      generateOptimization();
    }
  }

  // Apply a suggested policy configuration
  async function applySuggestedPolicy(event) {
    const policy = event.detail;

    logger.info("Applying suggested retention policy", {
      category: "ui",
      data: {
        component: "Backups",
        function: "applySuggestedPolicy",
        policyName: policy.name,
      },
    });

    // Update settings with suggested policy
    sizeRetentionEnabled = policy.settings.sizeRetentionEnabled;
    maxSizeValue = policy.settings.maxSizeValue;
    maxSizeUnit = policy.settings.maxSizeUnit;
    ageRetentionEnabled = policy.settings.ageRetentionEnabled;
    maxAgeValue = policy.settings.maxAgeValue;
    maxAgeUnit = policy.settings.maxAgeUnit;
    countRetentionEnabled = policy.settings.countRetentionEnabled;
    maxCountValue = policy.settings.maxCountValue;

    // Save the new settings
    await saveRetentionSettings();

    // Regenerate optimization analysis
    await generateOptimization();
  }

  // Apply a specific recommendation
  async function applyRecommendation(event) {
    const recommendation = event.detail;

    logger.info("Applying retention recommendation", {
      category: "ui",
      data: {
        component: "Backups",
        function: "applyRecommendation",
        recommendationType: recommendation.type,
      },
    });

    // Apply the recommendation based on its type
    switch (recommendation.type) {
      case "enable-size-retention":
        sizeRetentionEnabled = true;
        if (recommendation.suggestedValue) {
          maxSizeValue = recommendation.suggestedValue;
          maxSizeUnit = recommendation.suggestedUnit || "GB";
        }
        break;

      case "enable-age-retention":
        ageRetentionEnabled = true;
        if (recommendation.suggestedValue) {
          maxAgeValue = recommendation.suggestedValue;
          maxAgeUnit = recommendation.suggestedUnit || "days";
        }
        break;

      case "enable-count-retention":
        countRetentionEnabled = true;
        if (recommendation.suggestedValue) {
          maxCountValue = recommendation.suggestedValue;
        }
        break;

      case "adjust-size-limit":
        if (recommendation.suggestedValue) {
          maxSizeValue = recommendation.suggestedValue;
          maxSizeUnit = recommendation.suggestedUnit || "GB";
        }
        break;

      case "adjust-age-limit":
        if (recommendation.suggestedValue) {
          maxAgeValue = recommendation.suggestedValue;
          maxAgeUnit = recommendation.suggestedUnit || "days";
        }
        break;

      case "adjust-count-limit":
        if (recommendation.suggestedValue) {
          maxCountValue = recommendation.suggestedValue;
        }
        break;
    }

    // Save the updated settings
    await saveRetentionSettings();

    // Regenerate optimization analysis
    await generateOptimization();
  }

  // Apply retention policy manually
  async function applyRetentionPolicy() {
    logger.info("Applying retention policy manually", {
      category: "ui",
      data: {
        component: "Backups",
        function: "applyRetentionPolicy",
        serverPath,
  backupCount: backups ? backups.length : 0
      },
    });

    loading = true;
    error = "";
    try {
      const policy = {
        maxSize: sizeRetentionEnabled
          ? convertSizeToBytes(maxSizeValue, maxSizeUnit)
          : null,
        maxAge: ageRetentionEnabled
          ? convertAgeToMilliseconds(maxAgeValue, maxAgeUnit)
          : null,
        maxCount: countRetentionEnabled ? maxCountValue : null,
        preserveRecent: 1,
      };

      const result = await window.electron.invoke(
        "backups:apply-retention-policy",
        {
          serverPath,
          policy,
        },
      );

      logger.debug("Retention policy IPC response", {
        category: "ui",
        data: {
          component: "Backups",
          function: "applyRetentionPolicy",
          responseSuccess: !!(result && result.success),
          deletedBackups: result?.deletedBackups?.length || 0,
          spaceSaved: result?.spaceSaved || 0
        }
      });

      if (result && result.success) {
        logger.info("Retention policy applied successfully", {
          category: "ui",
          data: {
            component: "Backups",
            function: "applyRetentionPolicy",
            deletedCount: result.deletedBackups?.length || 0,
            spaceSaved: result.spaceSaved || 0,
          },
        });

        const deletedCount = result.deletedBackups?.length || 0;
        const spaceSaved = result.spaceSaved || 0;

        if (deletedCount > 0) {
          status = `Retention policy applied: ${deletedCount} backups deleted, ${formatSize(spaceSaved)} freed`;
        } else {
          status = "Retention policy applied: no backups needed to be deleted";
        }

        // Store settings hash when policy is successfully applied
        const currentHash = getSettingsHash();
        appliedSettingsHash = currentHash;
        saveAppliedSettingsHash(currentHash);
        retentionButtonsDisabled = true;
        showSuccessMessage = true;

        // Set timeout to hide success message after 5 seconds
        if (successMessageTimeout) {
          clearTimeout(successMessageTimeout);
        }
        successMessageTimeout = setTimeout(() => {
          showSuccessMessage = false;
          successMessageTimeout = null;
        }, 5000);

        // Invalidate size cache and refresh backups
        invalidateSizeCache(serverPath);
        await fetchBackups();
        setTimeout(() => (status = ""), 5000);
      } else {
        error = result?.error || "Failed to apply retention policy";
        logger.error("Retention policy application failed", {
          category: "ui",
          data: {
            component: "Backups",
            function: "applyRetentionPolicy",
            error: result?.error,
          },
        });
      }
    } catch (e) {
      error =
        cleanErrorMessage(e.message) || "Failed to apply retention policy";
      logger.error("Error during retention policy application", {
        category: "ui",
        data: {
          component: "Backups",
          function: "applyRetentionPolicy",
          errorMessage: e.message,
        },
      });
    }
    loading = false;
  }

  // Helper functions for retention policy
  function convertSizeToBytes(value, unit) {
    const multipliers = {
      GB: 1024 * 1024 * 1024,
      TB: 1024 * 1024 * 1024 * 1024,
    };
    return value * (multipliers[unit] || multipliers.GB);
  }

  function convertAgeToMilliseconds(value, unit) {
    const multipliers = {
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
      months: 30 * 24 * 60 * 60 * 1000,
    };
    return value * (multipliers[unit] || multipliers.days);
  }

  // Save automation settings
  async function saveAutomationSettings() {
    logger.info("Saving automation settings", {
      category: "ui",
      data: {
        component: "Backups",
        function: "saveAutomationSettings",
        settings: {
          enabled: autoBackupEnabled,
          frequency: backupFrequency,
          type: backupType,
          runOnLaunch,
          hour: backupHour,
          minute: backupMinute,
          day: backupDay,
        },
        serverPath,
      },
    });

    try {
      await window.electron.invoke("backups:configure-automation", {
        enabled: autoBackupEnabled,
        frequency: backupFrequency,
        type: backupType,
        retentionCount: 100, // High default to avoid unwanted deletion
        runOnLaunch: runOnLaunch,
        hour: backupHour,
        minute: backupMinute,
        day: backupDay,
        serverPath: serverPath,
      });

      logger.info("Automation settings saved successfully", {
        category: "ui",
        data: {
          component: "Backups",
          function: "saveAutomationSettings",
        },
      });

      status = "Backup automation settings saved";
      setTimeout(() => (status = ""), 2000);

      // Refresh automation settings to get updated next backup time
      loadAutomationSettings();
    } catch (e) {
      error =
        cleanErrorMessage(e.message) || "Failed to save automation settings";
      logger.error("Failed to save automation settings", {
        category: "ui",
        data: {
          component: "Backups",
          function: "saveAutomationSettings",
          errorMessage: e.message,
        },
      });
    }
  }

  // Run backup now
  async function runAutoBackupNow() {
    logger.info("Running manual backup", {
      category: "ui",
      data: {
        component: "Backups",
        function: "runAutoBackupNow",
        serverPath,
        type: manualBackupType,
      },
    });

    loading = true;
    error = "";
    try {
      const result = await window.electron.invoke(
        "backups:run-immediate-auto",
        {
          serverPath,
          type: manualBackupType,
        },
      );

      if (result && !result.error) {
        logger.info("Manual backup completed successfully", {
          category: "ui",
          data: {
            component: "Backups",
            function: "runAutoBackupNow",
            type: manualBackupType,
            result,
          },
        });

        status = `Manual ${manualBackupType === "full" ? "full" : "world-only"} backup created successfully`;
        // Invalidate size cache before refreshing
        invalidateSizeCache(serverPath);
        await fetchBackups(); // Refresh the backup list and total size
        loadAutomationSettings(); // Refresh next-backup timer

        // Auto-apply retention policy (new engine) if any policy is active
        try {
          const retentionActive = (
            (sizeRetentionEnabled && maxSizeValue) ||
            (ageRetentionEnabled && maxAgeValue) ||
            (countRetentionEnabled && maxCountValue)
          );
          if (retentionActive) {
            const policy = {
              maxSize: sizeRetentionEnabled ? convertSizeToBytes(maxSizeValue, maxSizeUnit) : null,
              maxAge: ageRetentionEnabled ? convertAgeToMilliseconds(maxAgeValue, maxAgeUnit) : null,
              maxCount: countRetentionEnabled ? maxCountValue : null,
              preserveRecent: 1,
            };
            const retentionResult = await window.electron.invoke('backups:apply-retention-policy', { serverPath, policy });
            if (retentionResult && retentionResult.deletedBackups && retentionResult.deletedBackups.length) {
              // Refresh list again if deletions occurred
              await fetchBackups();
              status = `Backup + retention: deleted ${retentionResult.deletedBackups.length} old backup(s)`;
            }
          }
        } catch (re) {
          logger.error('Retention auto-apply failed', { category: 'ui', data: { component: 'Backups', error: re?.message } });
        }
        setTimeout(() => (status = ""), 2000);
      } else {
        error = result?.error || "Failed to create manual backup";
        logger.error("Manual backup failed", {
          category: "ui",
          data: {
            component: "Backups",
            function: "runAutoBackupNow",
            type: manualBackupType,
            error: result?.error,
          },
        });
      }
    } catch (e) {
      error = cleanErrorMessage(e.message) || "Failed to create manual backup";
      logger.error("Error during manual backup", {
        category: "ui",
        data: {
          component: "Backups",
          function: "runAutoBackupNow",
          errorMessage: e.message,
        },
      });
    }
    loading = false;
  }
  // Handle rename dialog focus without reactive loop
  function handleRenameDialogFocus(dialogVisible, inputElement, justOpened) {
    if (dialogVisible && inputElement && justOpened) {
      tick().then(() => {
        if (inputElement) {
          inputElement.focus();
          const base = newName.endsWith(".zip")
            ? newName.slice(0, -4)
            : newName;
          inputElement.setSelectionRange(0, base.length);
        }
      });
      renameDialogJustOpened = false;
    }
  }

  // Call focus handler when needed
  $: handleRenameDialogFocus(
    showRenameDialog,
    renameInputEl,
    renameDialogJustOpened,
  );

  function cleanErrorMessage(msg) {
    if (!msg) return "";
    // Remove Electron's remote method error prefix    return msg.replace(/^Error invoking remote method '[^']+':\s*/i, '');
  }

  function confirmDelete(backup) {
    logger.info("Confirming backup deletion", {
      category: "ui",
      data: {
        component: "Backups",
        function: "confirmDelete",
        backupName: backup.name,
        backupSize: backup.size,
      },
    });

    backupToDelete = backup;
    showDeleteDialog = true;
  }

  async function deleteBackup() {
    if (!backupToDelete) {
      logger.error("Delete backup called with null backupToDelete", {
        category: "ui",
        data: {
          component: "Backups",
          function: "deleteBackup",
        },
      });
      return;
    }

    // Store backup name before it might be set to null
    const backupName = backupToDelete.name;

    logger.info("Deleting backup", {
      category: "ui",
      data: {
        component: "Backups",
        function: "deleteBackup",
        backupName: backupName,
        serverPath,
      },
    });

    loading = true;
    error = "";
    try {
      const result = await window.electron.invoke("backups:delete", {
        serverPath,
        name: backupName,
      });
      if (!result || result.success !== true) {
        throw new Error(
          result && result.error ? result.error : "Delete failed",
        );
      }

      logger.info("Backup deleted successfully", {
        category: "ui",
        data: {
          component: "Backups",
          function: "deleteBackup",
          backupName: backupName,
        },
      });

      // Invalidate size cache before refreshing
      invalidateSizeCache(serverPath);
      await fetchBackups(); // Refresh the backup list and total size
      status = "Backup deleted.";
      showDeleteDialog = false;
      backupToDelete = null;
    } catch (e) {
      error = cleanErrorMessage(e.message) || "Delete failed";
      logger.error("Failed to delete backup", {
        category: "ui",
        data: {
          component: "Backups",
          function: "deleteBackup",
          backupName: backupName,
          errorMessage: e.message,
        },
      });
    }
    loading = false;
  }

  function promptRename(backup) {
    logger.info("Prompting backup rename", {
      category: "ui",
      data: {
        component: "Backups",
        function: "promptRename",
        backupName: backup.name,
        backupSize: backup.size,
      },
    });

    backupToRename = backup;
    newName = backup.name;
    showRenameDialog = true;
    renameDialogJustOpened = true;
  }

  async function renameBackup() {
    if (!backupToRename) {
      logger.error("Rename backup called with null backupToRename", {
        category: "ui",
        data: {
          component: "Backups",
          function: "renameBackup",
        },
      });
      return;
    }

    // Store backup name before it might be set to null
    const oldBackupName = backupToRename.name;

    let finalName = newName.trim();
    if (!finalName.toLowerCase().endsWith(".zip")) {
      finalName += ".zip";
    }

    logger.info("Renaming backup", {
      category: "ui",
      data: {
        component: "Backups",
        function: "renameBackup",
        oldName: oldBackupName,
        newName: finalName,
        serverPath,
      },
    });

    loading = true;
    error = "";
    try {
      await window.electron.invoke("backups:rename", {
        serverPath,
        oldName: oldBackupName,
        newName: finalName,
      });

      logger.info("Backup renamed successfully", {
        category: "ui",
        data: {
          component: "Backups",
          function: "renameBackup",
          oldName: oldBackupName,
          newName: finalName,
        },
      });

      await fetchBackups(); // Refresh the backup list and total size
    } catch (e) {
      error = cleanErrorMessage(e.message) || "Rename failed";
      logger.error("Failed to rename backup", {
        category: "ui",
        data: {
          component: "Backups",
          function: "renameBackup",
          oldName: oldBackupName,
          newName: finalName,
          errorMessage: e.message,
        },
      });
    }
    loading = false;
    showRenameDialog = false;
    backupToRename = null;
  }

  function confirmRestore(backup) {
    logger.info("Confirming backup restore", {
      category: "ui",
      data: {
        component: "Backups",
        function: "confirmRestore",
        backupName: backup.name,
        backupSize: backup.size,
        serverStatus: $serverState.status,
      },
    });

    backupToRestore = backup;
    showRestoreDialog = true;
  }

  async function doRestoreBackup() {
    if (!backupToRestore) {
      logger.error("Restore backup called with null backupToRestore", {
        category: "ui",
        data: {
          component: "Backups",
          function: "doRestoreBackup",
        },
      });
      return;
    }

    // Store backup name before it might be set to null
    const backupName = backupToRestore.name;

    logger.info("Starting backup restore", {
      category: "ui",
      data: {
        component: "Backups",
        function: "doRestoreBackup",
        backupName: backupName,
        serverPath,
        serverStatus: $serverState.status,
      },
    });

    loading = true;
    error = "";
    try {
      const result = await window.electron.invoke("backups:restore", {
        serverPath,
        name: backupName,
        serverStatus: $serverState.status,
      });
      if (result && result.success) {
        logger.info("Backup restored successfully", {
          category: "ui",
          data: {
            component: "Backups",
            function: "doRestoreBackup",
            backupName: backupName,
            preRestoreBackup: result.preRestoreBackup,
            message: result.message,
          },
        });

        status = result.message || "Backup restored successfully.";
        if (result.preRestoreBackup) {
          status += ` (Previous state saved as ${result.preRestoreBackup})`;
        }
        // Invalidate size cache before refreshing (restore may create pre-restore backup)
        invalidateSizeCache(serverPath);
        await fetchBackups(); // Refresh the backup list and total size
      } else {
        error = cleanErrorMessage(
          result && result.error ? result.error : "Restore failed",
        );
        logger.error("Backup restore failed", {
          category: "ui",
          data: {
            component: "Backups",
            function: "doRestoreBackup",
            backupName: backupName,
            error: result?.error,
          },
        });
        showRestoreDialog = false;
        backupToRestore = null;
        loading = false;
        return;
      }
      showRestoreDialog = false;
      backupToRestore = null;
    } catch (e) {
      error = cleanErrorMessage(e.message) || "Restore failed";
      logger.error("Error during backup restore", {
        category: "ui",
        data: {
          component: "Backups",
          function: "doRestoreBackup",
          backupName: backupName,
          errorMessage: e.message,
        },
      });
    }
    loading = false;
  }

  // Derived value for selectAll
  $: selectAll = backups.length > 0 && $selectedBackups.size === backups.length;

  function toggleSelectAll() {
    if (!selectAll) {
      $selectedBackups = new SvelteSet(backups.map((b) => b.name));
    } else {
      $selectedBackups = new SvelteSet();
    }
  }

  function toggleSelect(name) {
    const newSet = new SvelteSet($selectedBackups);
    if (newSet.has(name)) {
      newSet.delete(name);
    } else {
      newSet.add(name);
    }
    $selectedBackups = newSet;
  }

  async function bulkDeleteBackups() {
    logger.info("Starting bulk backup deletion", {
      category: "ui",
      data: {
        component: "Backups",
        function: "bulkDeleteBackups",
        selectedCount: $selectedBackups.size,
        selectedBackups: Array.from($selectedBackups),
        serverPath,
      },
    });

    loading = true;
    error = "";
    try {
      for (const name of $selectedBackups) {
        await window.electron.invoke("backups:delete", { serverPath, name });
      }

      logger.info("Bulk backup deletion completed successfully", {
        category: "ui",
        data: {
          component: "Backups",
          function: "bulkDeleteBackups",
          deletedCount: $selectedBackups.size,
        },
      });

      // Invalidate size cache before refreshing
      invalidateSizeCache(serverPath);
      await fetchBackups(); // Refresh the backup list and total size
      status = "Selected backups deleted.";
      $selectedBackups = new SvelteSet();
      showBulkDeleteDialog = false;
      setTimeout(() => (status = ""), 2000);
    } catch (e) {
      error = cleanErrorMessage(e.message) || "Bulk delete failed";
      logger.error("Bulk backup deletion failed", {
        category: "ui",
        data: {
          component: "Backups",
          function: "bulkDeleteBackups",
          selectedCount: $selectedBackups.size,
          errorMessage: e.message,
        },
      });
    }
    loading = false;
  }

  function updateRemainingTime() {
    if (!nextBackupTimeIso) {
      remainingTime = "";
      return;
    }
    const now = new Date();
    const next = new Date(nextBackupTimeIso);
    if (isNaN(next.getTime())) {
      remainingTime = "";
      return;
    }
    const diffMs = next.getTime() - now.getTime();
    if (diffMs <= 0) {
      remainingTime = "due now";
      return;
    }
    const totalMinutes = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    remainingTime = parts.join(" ");
  }

  // Add notification event listener
  onMount(() => {
    // Set up event listener for backup notifications
    const notificationHandler = (notification) => {
      logger.debug("Backup notification received", {
        category: "ui",
        data: {
          component: "Backups",
          event: "backup-notification",
          notification: {
            message: notification?.message,
            success: notification?.success,
          },
        },
      });

      if (notification && notification.message) {
        if (notification.success) {
          status = notification.message;
          // Refresh backup list and automation settings whenever a backup succeeds
          if (
            notification.message.includes("auto-backup") ||
            notification.message.includes("backup created")
          ) {
            // Invalidate size cache before refreshing
            invalidateSizeCache(serverPath);
            fetchBackups(); // This will also update total size
            loadAutomationSettings();
          }
        } else {
          error = notification.message;
        }
        // Clear after a delay
        setTimeout(() => {
          if (status === notification.message) status = "";
          if (error === notification.message) error = "";
        }, 5000);
      }
    };

    // Register event handler
    window.electron.on("backup-notification", notificationHandler);

    // Initial load of automation settings
    loadAutomationSettings();

    // Add a visibility change handler to refresh backups when tab becomes active
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        logger.debug("Tab became visible, refreshing backups", {
          category: "ui",
          data: {
            component: "Backups",
            event: "visibilityChange",
          },
        });
        fetchBackups();
      }
    };

    // Add event listeners
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Clean up on destroy
    let remainingInterval;
    remainingInterval = setInterval(updateRemainingTime, 60000);
    updateRemainingTime();
    return () => {
      window.electron.removeListener(
        "backup-notification",
        notificationHandler,
      );
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (remainingInterval) clearInterval(remainingInterval);
    };
  });

  // Helper function to format timestamps consistently
  function formatTimestamp(timestamp) {
    if (!timestamp) return "-";

    try {
      // Handle both ISO strings and Date objects
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return timestamp; // Return original if invalid

      return date.toLocaleString(); // Convert to local time
    } catch (e) {
      return timestamp; // Return original if conversion fails
    }
  }
</script>

<div class="backups-container">
  <!-- Modern Header -->
  <div class="backups-header">
    <h1 class="backups-title">Backup Automation</h1>
    <div class="header-controls">
      {#if backups.length > 0}
        <button
          class="stats-icon-btn"
          on:click={() => (showStatisticsModal = true)}
          title="View backup statistics"
        >
          📊
        </button>
      {/if}
      <div class="backup-type-selector">
        <select bind:value={manualBackupType} class="type-select">
          <option value="world">World-only</option>
          <option value="full">Full</option>
        </select>
        <span class="select-arrow">▼</span>
      </div>
      <button
        class="run-backup-btn"
        on:click={runAutoBackupNow}
        disabled={loading}
      >
        Run Backup Now
      </button>
    </div>
  </div>

  <!-- Main Settings Card -->
  <div class="settings-card">
    <!-- Enable Toggle -->
    <div class="enable-section">
      <div class="toggle-container">
        <input
          type="checkbox"
          id="enable-automation"
          bind:checked={autoBackupEnabled}
          on:change={saveAutomationSettings}
          class="modern-checkbox"
        />
        <label for="enable-automation" class="enable-label">
          Enable Automatic Backups
        </label>
      </div>
    </div>

    <!-- Settings Grid -->
    <div class="settings-grid" class:disabled={!autoBackupEnabled}>
      <!-- Frequency -->
      <div class="setting-group">
        <label class="setting-label" for="frequency-select">Frequency</label>
        <div class="select-wrapper">
          <select
            id="frequency-select"
            bind:value={backupFrequency}
            on:change={saveAutomationSettings}
            disabled={!autoBackupEnabled}
            class="modern-select"
          >
            {#each frequencyOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <span class="select-arrow">▼</span>
        </div>
      </div>

      <!-- Schedule Time -->
      {#if showTimeSelector}
        <div class="setting-group">
          <label class="setting-label" for="hour-select">Schedule at</label>
          <div class="time-controls">
            {#if showDaySelector}
              <div class="select-wrapper small">
                <select
                  id="day-select"
                  bind:value={backupDay}
                  on:change={saveAutomationSettings}
                  disabled={!autoBackupEnabled}
                  class="modern-select small"
                >
                  {#each dayNames as day, index (index)}
                    <option value={index}>{day.slice(0, 3)}</option>
                  {/each}
                </select>
                <span class="select-arrow">▼</span>
              </div>
            {/if}
            <div class="number-wrapper small">
              <input
                id="hour-input"
                type="number"
                min="0"
                max="23"
                bind:value={backupHour}
                on:change={saveAutomationSettings}
                disabled={!autoBackupEnabled}
                class="number-input small"
              />
            </div>
            <span class="time-separator">:</span>
            <div class="number-wrapper small">
              <input
                id="minute-input"
                type="number"
                min="0"
                max="59"
                step="1"
                bind:value={backupMinute}
                on:change={saveAutomationSettings}
                disabled={!autoBackupEnabled}
                class="number-input small"
              />
            </div>
          </div>
        </div>
      {/if}

      <!-- Backup Type -->
      <div class="setting-group">
        <span class="setting-label">Content</span>
        <div class="radio-group">
          <div class="radio-option">
            <input
              type="radio"
              id="type-full"
              name="backup-type"
              value="full"
              bind:group={backupType}
              on:change={saveAutomationSettings}
              disabled={!autoBackupEnabled}
              class="modern-radio"
            />
            <label for="type-full" class="radio-label">Full</label>
          </div>
          <div class="radio-option">
            <input
              type="radio"
              id="type-world"
              name="backup-type"
              value="world"
              bind:group={backupType}
              on:change={saveAutomationSettings}
              disabled={!autoBackupEnabled}
              class="modern-radio"
            />
            <label for="type-world" class="radio-label">World-only</label>
          </div>
        </div>
      </div>
    </div>

    <!-- Status Footer -->
    {#if autoBackupEnabled}
      <div class="status-footer">
        <div class="next-backup">
          {#if backupFrequency >= 604800000}
            Next backup: {dayNames[backupDay]} at {backupHour
              .toString()
              .padStart(2, "0")}:{backupMinute.toString().padStart(2, "0")}
          {:else if backupFrequency >= 86400000}
            Next backup: daily at {backupHour
              .toString()
              .padStart(2, "0")}:{backupMinute.toString().padStart(2, "0")}
          {:else}
            Next backup: every {Math.floor(backupFrequency / 3600000)}h {Math.floor(
              (backupFrequency % 3600000) / 60000,
            )}m
          {/if}
          {#if remainingTime}
            &nbsp;(<span class="remaining-time">in {remainingTime}</span>)
          {/if}
        </div>
        <div class="last-backup">
          <span class="status-icon">✓</span>
          <span>Last backup: {lastAutoBackup || "Never"}</span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Retention Policy Settings Card -->
  <div class="settings-card">
    <div class="retention-header">
      <h3 class="retention-title">Retention Policies</h3>
      <div class="retention-header-actions">
        {#if retentionWarnings.length > 0}
          <RetentionWarnings warnings={retentionWarnings} compact={true} />
        {/if}
        <button
          class="optimize-icon-btn"
          on:click={toggleOptimization}
          disabled={loading}
          title={showOptimization
            ? "Hide optimization recommendations"
            : "Get optimization recommendations"}
        >
          🔧
        </button>
      </div>
    </div>

    <!-- Ultra Compact Retention Settings - Single Row -->
    <div class="retention-single-row">
      <!-- Size-based Retention -->
      <div class="retention-inline-item">
        <input
          type="checkbox"
          id="size-retention-enabled"
          bind:checked={sizeRetentionEnabled}
          on:change={saveRetentionSettings}
          class="modern-checkbox"
        />
        <label for="size-retention-enabled" class="inline-label"
          >Max size:</label
        >
        <input
          type="number"
          bind:value={maxSizeValue}
          on:change={saveRetentionSettings}
          min="1"
          max="1000"
          class="inline-input"
          disabled={!sizeRetentionEnabled}
        />
        <select
          bind:value={maxSizeUnit}
          on:change={saveRetentionSettings}
          disabled={!sizeRetentionEnabled}
          class="inline-select"
        >
          <option value="GB">GB</option>
          <option value="TB">TB</option>
        </select>
      </div>

      <div class="retention-separator">|</div>

      <!-- Age-based Retention -->
      <div class="retention-inline-item">
        <input
          type="checkbox"
          id="age-retention-enabled"
          bind:checked={ageRetentionEnabled}
          on:change={saveRetentionSettings}
          class="modern-checkbox"
        />
        <label for="age-retention-enabled" class="inline-label">Max age:</label>
        <input
          type="number"
          bind:value={maxAgeValue}
          on:change={saveRetentionSettings}
          min="1"
          max="365"
          class="inline-input"
          disabled={!ageRetentionEnabled}
        />
        <select
          bind:value={maxAgeUnit}
          on:change={saveRetentionSettings}
          disabled={!ageRetentionEnabled}
          class="inline-select"
        >
          <option value="days">Days</option>
          <option value="weeks">Weeks</option>
          <option value="months">Months</option>
        </select>
      </div>

      <div class="retention-separator">|</div>

      <!-- Count-based Retention -->
      <div class="retention-inline-item">
        <input
          type="checkbox"
          id="count-retention-enabled"
          bind:checked={countRetentionEnabled}
          on:change={saveRetentionSettings}
          class="modern-checkbox"
        />
        <label for="count-retention-enabled" class="inline-label"
          >Max count:</label
        >
        <input
          type="number"
          bind:value={maxCountValue}
          on:change={saveRetentionSettings}
          min="1"
          max="100"
          class="inline-input"
          disabled={!countRetentionEnabled}
        />
        <span class="inline-suffix">backups</span>
      </div>
    </div>

    <!-- Retention Warnings -->
    {#if retentionWarnings.length > 0}
      <RetentionWarnings warnings={retentionWarnings} />
    {/if}

    <!-- Retention Policy Info -->
    {#if sizeRetentionEnabled || ageRetentionEnabled || countRetentionEnabled}
      <div class="retention-info">
        <div class="info-icon">ℹ️</div>
        <div class="info-text">
          Backups will be deleted when:
          {#if sizeRetentionEnabled}
            total size exceeds {maxSizeValue}
            {maxSizeUnit}{#if ageRetentionEnabled || countRetentionEnabled}, OR{/if}
          {/if}
          {#if ageRetentionEnabled}
            backups are older than {maxAgeValue}
            {maxAgeUnit}{#if countRetentionEnabled}, OR{/if}
          {/if}
          {#if countRetentionEnabled}
            more than {maxCountValue} backups exist
          {/if}. At least 1 recent backup will always be preserved.
        </div>
      </div>
    {/if}

    <!-- Retention Actions -->
    {#if sizeRetentionEnabled || ageRetentionEnabled || countRetentionEnabled}
      {#if !retentionButtonsDisabled}
        <div class="retention-actions">
          <button
            class="preview-btn primary-action"
            on:click={applyRetentionPolicyWithPreview}
            disabled={loading}
            title="Preview what would be deleted before applying"
          >
            📋 Preview & Apply Policy
          </button>
          <button
            class="apply-direct-btn secondary-action"
            on:click={applyRetentionPolicy}
            disabled={loading}
            title="Apply retention policy immediately without preview"
          >
            ⚡ Apply Immediately
          </button>
        </div>
      {:else if showSuccessMessage}
        <div class="retention-applied-message">
          <span class="applied-icon">✅</span>
          <span class="applied-text">Retention policy applied successfully</span
          >
          <span class="applied-hint"
            >Change settings above to apply a different policy</span
          >
        </div>
      {/if}
    {/if}

    <!-- Retention Optimization -->
    {#if showOptimization}
      <div class="optimization-section">
        <RetentionOptimization
          optimization={retentionOptimization}
          loading={optimizationLoading}
          on:apply-policy={applySuggestedPolicy}
          on:apply-recommendation={applyRecommendation}
        />
      </div>
    {/if}
  </div>

  <!-- Status Messages -->
  {#if status}
    <div class="status-message success">{status}</div>
  {/if}
  {#if error}
    <div class="status-message error">{error}</div>
  {/if}

  <!-- Backup List -->
  <div class="backup-list-section">
    <div class="list-header">
      <h2 class="list-title">Backup List</h2>
      {#if $selectedBackups.size > 0}
        <button
          class="bulk-delete-btn"
          on:click={() => (showBulkDeleteDialog = true)}
          disabled={loading}
        >
          🗑️ Delete Selected ({$selectedBackups.size})
        </button>
      {/if}
    </div>

    <div class="table-container">
      <table class="modern-table">
        <thead>
          <tr>
            <th class="checkbox-col">
              <input
                type="checkbox"
                checked={selectAll}
                on:change={toggleSelectAll}
                class="modern-checkbox small"
              />
            </th>
            <th>Name</th>
            <th>Type</th>
            <th class="size-header">
              Size
              <div class="total-size-display">
                {#if totalSizeLoading}
                  <span class="size-loading">Calculating...</span>
                {:else if totalSizeError}
                  <span class="size-error" title={totalSizeError}>Error</span>
                {:else}
                  <span class="total-size"
                    >Total: {formatSize(totalBackupSize)}</span
                  >
                {/if}
              </div>
            </th>
            <th>Timestamp</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each backups as backup (backup.name)}
            <tr>
              <td class="checkbox-col">
                <input
                  type="checkbox"
                  checked={$selectedBackups.has(backup.name)}
                  on:change={() => toggleSelect(backup.name)}
                  class="modern-checkbox small"
                />
              </td>
              <td class="backup-name">
                {backup.name}
                {#if backup.metadata?.automated}
                  <span class="backup-badge">🤖</span>
                {/if}
              </td>
              <td>{backup.metadata?.type || "-"}</td>
              <td>{(backup.size / 1024 / 1024).toFixed(2)} MB</td>
              <td
                >{formatTimestamp(
                  backup.metadata?.timestamp || backup.created,
                )}</td
              >
              <td>
                <div class="action-buttons">
                  <button
                    class="action-btn restore"
                    on:click={() => confirmRestore(backup)}
                    disabled={loading || isServerRunning}
                    title="Restore"
                  >
                    ↻
                  </button>
                  <button
                    class="action-btn rename"
                    on:click={() => promptRename(backup)}
                    disabled={loading}
                    title="Rename"
                  >
                    ✏️
                  </button>
                  <button
                    class="action-btn delete"
                    on:click={() => confirmDelete(backup)}
                    disabled={loading}
                    title="Delete"
                  >
                    🗑️
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- Statistics Modal -->
{#if showStatisticsModal}
  <div
    class="modal-overlay"
    role="presentation"
    on:click={() => (showStatisticsModal = false)}
    on:keydown={(e) => e.key === "Escape" && (showStatisticsModal = false)}
  >
    <div
      class="statistics-modal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      on:click|stopPropagation
      on:keydown|stopPropagation
    >
      <div class="modal-header">
        <h3>Backup Statistics</h3>
        <button
          class="modal-close"
          on:click={() => (showStatisticsModal = false)}>×</button
        >
      </div>

      <div class="modal-content">
        {#if statisticsLoading}
          <div class="statistics-loading">
            <span class="size-loading">Calculating statistics...</span>
          </div>
        {:else if statisticsError}
          <div class="statistics-error">
            <span class="size-error">{statisticsError}</span>
          </div>
        {:else if backupStatistics}
          <div class="statistics-grid">
            <div class="stat-item">
              <span class="stat-label">Total Backups</span>
              <span class="stat-value">{backupStatistics.totalBackups}</span>
            </div>

            <div class="stat-item">
              <span class="stat-label">Total Size</span>
              <span class="stat-value"
                >{formatSize(backupStatistics.totalSize)}</span
              >
            </div>

            <div class="stat-item">
              <span class="stat-label">Average Size</span>
              <span class="stat-value"
                >{formatSize(backupStatistics.averageSize)}</span
              >
            </div>

            <div class="stat-item">
              <span class="stat-label">Storage Saved</span>
              <span class="stat-value savings"
                >{formatSize(backupStatistics.retentionSavings)}</span
              >
              <span class="stat-help">Space freed by retention policies</span>
            </div>

            {#if backupStatistics.oldestBackup}
              <div class="stat-item">
                <span class="stat-label">Oldest Backup</span>
                <span class="stat-value"
                  >{BackupStatistics.formatDate(
                    BackupStatistics.getBackupDate(
                      backupStatistics.oldestBackup,
                    ),
                  )}</span
                >
              </div>
            {/if}

            {#if backupStatistics.newestBackup}
              <div class="stat-item">
                <span class="stat-label">Newest Backup</span>
                <span class="stat-value"
                  >{BackupStatistics.formatDate(
                    BackupStatistics.getBackupDate(
                      backupStatistics.newestBackup,
                    ),
                  )}</span
                >
              </div>
            {/if}
          </div>

          {#if backupStatistics.sizeGrowthTrend && backupStatistics.sizeGrowthTrend.length > 0}
            <div class="growth-chart-section">
              <h4 class="chart-title">Size Growth (Last 30 Days)</h4>
              <div class="chart-container">
                {#each backupStatistics.sizeGrowthTrend as point (point.date)}
                  {@const maxSize = Math.max(
                    ...backupStatistics.sizeGrowthTrend.map((p) => p.size),
                  )}
                  {@const height =
                    maxSize > 0 ? (point.size / maxSize) * 100 : 0}
                  <div class="chart-bar" style="height: {height}%">
                    <div class="chart-tooltip">
                      <div class="tooltip-date">
                        {new Date(point.date).toLocaleDateString()}
                      </div>
                      <div class="tooltip-size">{formatSize(point.size)}</div>
                      <div class="tooltip-count">
                        {point.count} backup{point.count !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#if backupStatistics.frequencyPattern && backupStatistics.frequencyPattern.formattedAverageInterval}
            <div class="frequency-info">
              <div class="info-icon">📊</div>
              <div class="info-text">
                Average backup interval: {backupStatistics.frequencyPattern
                  .formattedAverageInterval}
              </div>
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if showDeleteDialog}
  <ConfirmationDialog
    visible={showDeleteDialog}
    message={`Delete backup ${backupToDelete?.name}?`}
    on:confirm={deleteBackup}
    on:cancel={() => {
      showDeleteDialog = false;
      backupToDelete = null;
    }}
  />
{/if}

{#if showRenameDialog}
  <div class="rename-dialog-modal">
    <div class="rename-dialog-content">
      <h3>Rename Backup</h3>
      <label for="rename-input">New name:</label>
      <input
        id="rename-input"
        bind:value={newName}
        bind:this={renameInputEl}
        class="rename-input"
        on:keydown={(e) => {
          if (e.key === "Enter") renameBackup();
        }}
      />
      <div class="rename-dialog-actions">
        <button
          class="rename-confirm"
          on:click={renameBackup}
          disabled={loading}>Rename</button
        >
        <button
          class="rename-cancel"
          on:click={() => {
            showRenameDialog = false;
            backupToRename = null;
          }}>Cancel</button
        >
      </div>
    </div>
  </div>
{/if}

{#if showRestoreDialog}
  <ConfirmationDialog
    visible={showRestoreDialog}
    message={`Restore backup ${backupToRestore?.name}? This will overwrite your current server/world data.`}
    on:confirm={doRestoreBackup}
    on:cancel={() => {
      showRestoreDialog = false;
      backupToRestore = null;
    }}
  />
{/if}

{#if showBulkDeleteDialog}
  <ConfirmationDialog
    visible={showBulkDeleteDialog}
    message={`Delete ${$selectedBackups.size} selected backups? This cannot be undone.`}
    on:confirm={bulkDeleteBackups}
    on:cancel={() => (showBulkDeleteDialog = false)}
  />
{/if}

<!-- Retention Policy Preview Dialog -->
<RetentionPreviewDialog
  show={showRetentionPreview}
  preview={retentionPreview}
  loading={previewLoading}
  on:confirm={handlePreviewConfirm}
  on:cancel={handlePreviewCancel}
/>

<style>
  .backups-container {
    padding: 1rem;
    box-sizing: border-box;
    max-width: 100%;
    overflow-x: auto;
  }

  .backups-header {
    background: #2a2e36;
    border-radius: 8px;
    padding: 1rem 1.25rem;
    margin-bottom: 1rem;
    border: 1px solid #444;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .backups-title {
    margin: 0;
    color: #d9eef7;
    font-size: 1.8rem;
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .backup-type-selector {
    position: relative;
    display: flex;
    align-items: center;
    background: #2a2e36;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 0.3rem 0.5rem;
    color: #d9eef7;
    font-size: 0.95rem;
  }

  .type-select {
    background: transparent;
    border: none;
    color: #d9eef7;
    font-size: 0.95rem;
    padding: 0.2rem 1.5rem 0.2rem 0.5rem; /* Add right padding so text doesn't overlap arrow */
    cursor: pointer;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    width: 100%;
  }

  .select-arrow {
    position: absolute;
    right: 0.5rem;
    pointer-events: none;
    color: #555;
  }

  .run-backup-btn {
    background: #3498db;
    border: none;
    border-radius: 4px;
    padding: 0.6rem 1.2rem;
    color: white;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
  }

  .run-backup-btn:hover:not(:disabled) {
    background: #2980b9;
  }

  .run-backup-btn:disabled {
    background: #95a5a6;
    cursor: not-allowed;
  }

  .settings-card {
    background: #2a2e36;
    border-radius: 8px;
    padding: 1rem 1.25rem;
    margin-bottom: 1.25rem;
    border: 1px solid #444;
    max-width: 100%;
    overflow-x: auto;
    box-sizing: border-box;
  }

  .enable-section {
    margin-bottom: 1.5rem;
    /* Only one separator - remove bottom border, rely on settings-grid top border */
    padding-bottom: 0.5rem;
  }

  .toggle-container {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 0.8rem;
  }

  .enable-label {
    color: #bbb;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
  }

  .modern-checkbox {
    width: 1.25rem;
    height: 1.25rem;
    accent-color: #3498db;
  }

  .modern-checkbox:checked {
    background-color: #3498db;
    border-color: #3498db;
  }

  .modern-checkbox:focus {
    outline: 2px solid #3498db;
    outline-offset: 2px;
  }

  .settings-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1rem;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid #444;
    max-width: 100%;
    overflow-x: auto;
    align-items: end; /* Align items for better vertical alignment */
  }

  .settings-grid.disabled {
    opacity: 0.7;
    pointer-events: none;
  }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .setting-label {
    color: #bbb;
    font-size: 0.9rem;
    font-weight: 500;
  }

  .select-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    background: #1e2228;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.4rem 0.8rem;
    color: #eee;
    font-size: 0.95rem;
    width: 100%;
    max-width: 200px; /* Limit width for select */
  }

  .select-wrapper.small {
    max-width: 100px; /* Smaller select for time */
  }

  .modern-select {
    background: transparent;
    border: none;
    color: #eee;
    font-size: 0.95rem;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    width: 100%;
  }

  .modern-select:focus {
    outline: none;
    box-shadow: 0 0 0 2px #3498db;
  }

  .time-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .time-separator {
    color: #555;
    font-size: 1.1rem;
    font-weight: bold;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .radio-option {
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }

  .modern-radio {
    width: 1.25rem;
    height: 1.25rem;
    accent-color: #3498db;
  }

  .modern-radio:checked {
    background-color: #3498db;
    border-color: #3498db;
  }

  .modern-radio:focus {
    outline: 2px solid #3498db;
    outline-offset: 2px;
  }

  .radio-label {
    color: #bbb;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .status-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid #444;
    color: #999;
    font-size: 0.9rem;
  }

  .next-backup {
    color: #d9eef7;
    font-weight: 500;
  }

  .last-backup {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-icon {
    color: #2ecc71;
    font-size: 1rem;
  }

  .backup-list-section {
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid #444;
  }

  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.8rem;
  }

  .list-title {
    margin: 0;
    color: #d9eef7;
    font-size: 1.2rem;
  }

  .bulk-delete-btn {
    background: #f44336;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.4rem 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }

  .bulk-delete-btn:hover:not(:disabled) {
    background: #c62828;
  }

  .bulk-delete-btn:disabled {
    background: #e57373;
    cursor: not-allowed;
  }

  .table-container {
    background: #2a2e36;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #444;
  }

  .modern-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 0.5rem;
    table-layout: fixed;
    max-width: 100%;
  }

  .modern-table th {
    background: #3a3e46;
    color: #d9eef7;
    font-weight: 500;
    text-transform: uppercase;
    font-size: 0.8rem;
    letter-spacing: 0.05em;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #444;
    text-align: left;
  }

  .modern-table td {
    padding: 0.55rem 0.8rem;
    border-bottom: 1px solid #444;
    color: #bbb;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modern-table tbody tr:hover {
    background: #32383f;
  }

  .checkbox-col {
    width: 40px; /* Checkbox column */
  }

  .size-header {
    position: relative;
  }

  .total-size-display {
    font-size: 0.75rem;
    font-weight: normal;
    text-transform: none;
    letter-spacing: normal;
    margin-top: 0.25rem;
    color: #999;
  }

  .size-loading {
    color: #3498db;
    font-style: italic;
  }

  .size-error {
    color: #e74c3c;
    cursor: help;
  }

  .total-size {
    color: #2ecc71;
    font-weight: 500;
  }

  .backup-name {
    width: 30%; /* Name column */
    color: #d9eef7;
    font-weight: 500;
  }

  .backup-badge {
    margin-left: 0.5rem;
    font-size: 0.8rem;
    color: #3498db;
  }

  .action-buttons {
    display: flex;
    gap: 0.3rem;
    justify-content: center;
    align-items: center;
    flex-wrap: nowrap;
  }

  .action-btn {
    min-width: 28px;
    height: 28px;
    padding: 0.2rem;
    border: 1px solid #555;
    border-radius: 4px;
    background: #2a2e36;
    color: #d9eef7;
    cursor: pointer;
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }

  .action-btn:hover:not(:disabled) {
    background: #3a3e46;
    border-color: #666;
    transform: translateY(-1px);
  }

  .action-btn:disabled {
    background: #1a1e26;
    color: #777;
    cursor: not-allowed;
    border-color: #333;
  }

  .restore:hover:not(:disabled) {
    background: #27ae60;
    border-color: #2ecc71;
    color: white;
  }

  .rename:hover:not(:disabled) {
    background: #3498db;
    border-color: #2980b9;
    color: white;
  }

  .delete:hover:not(:disabled) {
    background: #e74c3c;
    border-color: #c0392b;
    color: white;
  }

  .rename-dialog-modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1001;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .rename-dialog-content {
    background: #2a2e36;
    border-radius: 8px;
    padding: 2rem;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
    max-width: 400px;
    width: 90%;
    text-align: center;
  }

  .rename-dialog-content h3 {
    margin-top: 0;
    margin-bottom: 1.5rem;
    color: #d9eef7;
  }

  .rename-dialog-content label {
    display: block;
    margin-bottom: 0.8rem;
    color: #bbb;
    font-size: 0.95rem;
  }

  .rename-input {
    width: 100%;
    padding: 0.6rem 1rem;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1e2228;
    color: #eee;
    font-size: 1rem;
    box-sizing: border-box;
  }

  .rename-input:focus {
    outline: none;
    border-color: #3498db;
    box-shadow: 0 0 0 2px #3498db;
  }

  .rename-dialog-actions {
    display: flex;
    justify-content: space-around;
    margin-top: 1.5rem;
  }

  .rename-confirm,
  .rename-cancel {
    padding: 0.6rem 1.2rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.2s;
  }

  .rename-confirm {
    background: #3498db;
    color: white;
  }

  .rename-confirm:hover:not(:disabled) {
    background: #2980b9;
  }

  .rename-confirm:disabled {
    background: #95a5a6;
    cursor: not-allowed;
  }

  .rename-cancel {
    background: #e74c3c;
    color: white;
  }

  .rename-cancel:hover:not(:disabled) {
    background: #c0392b;
  }

  .rename-cancel:disabled {
    background: #e57373;
    cursor: not-allowed;
  }

  .status-message {
    padding: 0.8rem 1rem;
    border-radius: 4px;
    margin-bottom: 0.8rem;
    font-weight: 500;
    font-size: 0.95rem;
  }

  .status-message.success {
    background-color: #2ecc71;
    color: white;
  }

  .status-message.error {
    background-color: #e74c3c;
    color: white;
  }

  .modern-select option,
  .type-select option {
    /* ensure header dropdown too */
    color: #000;
    background: #fff;
  }

  .remaining-time {
    color: #aaa;
    font-style: italic;
  }

  /* Add styles for new numeric inputs */
  .number-wrapper {
    background: #1e2228;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.32rem 0.6rem;
    color: #eee;
    display: flex;
    align-items: center;
  }
  .number-wrapper.small {
    max-width: 80px;
  }
  .number-input {
    background: transparent;
    border: none;
    color: #eee;
    font-size: 0.95rem;
    width: 48px;
    text-align: right;
  }
  .number-input:focus {
    outline: none;
    box-shadow: 0 0 0 2px #3498db;
  }

  /* Retention Policy Styles */
  .retention-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    padding-bottom: 0.5rem;
  }

  .retention-header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .retention-title {
    margin: 0;
    color: #d9eef7;
    font-size: 1.2rem;
    font-weight: 500;
  }

  .retention-info {
    display: flex;
    align-items: flex-start;
    gap: 0.8rem;
    padding: 1rem;
    background: rgba(52, 152, 219, 0.1);
    border: 1px solid rgba(52, 152, 219, 0.3);
    border-radius: 6px;
    margin-top: 1rem;
  }

  .info-icon {
    font-size: 1.1rem;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }

  .info-text {
    color: #bbb;
    font-size: 0.9rem;
    line-height: 1.4;
  }

  /* Statistics Section Styles */
  .statistics-loading,
  .statistics-error {
    padding: 1rem;
    text-align: center;
    color: #aaa;
    font-style: italic;
  }

  .statistics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .stat-item {
    background: #1e2228;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .stat-label {
    color: #aaa;
    font-size: 0.85rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .stat-value {
    color: #d9eef7;
    font-size: 1.1rem;
    font-weight: 600;
  }

  .stat-value.savings {
    color: #27ae60;
  }

  .growth-chart-section {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid #444;
  }

  .chart-title {
    color: #d9eef7;
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 1rem 0;
  }

  .chart-container {
    display: flex;
    align-items: end;
    gap: 2px;
    height: 100px;
    background: #1e2228;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 0.5rem;
    overflow-x: auto;
    position: relative;
  }

  .chart-bar {
    position: relative;
    min-width: 8px;
    background: linear-gradient(to top, #3498db, #5dade2);
    border-radius: 2px 2px 0 0;
    cursor: pointer;
    transition: opacity 0.2s;
    flex: 1;
    /* Allow the tooltip to escape and stack above neighbors */
    z-index: 0;
    overflow: visible;
  }

  .chart-bar:hover,
  .chart-bar:focus-within {
    opacity: 0.8;
    z-index: 5;
  }

  .chart-tooltip {
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background: #2a2e36;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 0.6rem 0.8rem;
    font-size: 0.8rem;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
    z-index: 1001; /* Higher than modal overlay */
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    margin-bottom: 0.5rem;
    min-width: 120px;
    text-align: center;
  }

  /* When tooltip would be cut off at top, show it overlaying on the bar */
  .chart-bar:hover .chart-tooltip {
    opacity: 1;
  }

  /* For bars that would cause tooltip cutoff, position on top of the bar */
  .chart-container .chart-bar:hover .chart-tooltip {
    bottom: 20%;
    margin-bottom: 0;
  }

  .chart-tooltip::after {
    content: "";
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    border: 6px solid transparent;
    border-top-color: #2a2e36;
  }

  /* Adjust tooltip positioning for bars near the edges */
  .chart-bar:first-child .chart-tooltip {
    left: 0;
    transform: translateX(0);
  }

  .chart-bar:first-child .chart-tooltip::after {
    left: 20px;
    transform: translateX(0);
  }

  .chart-bar:last-child .chart-tooltip {
    left: auto;
    right: 0;
    transform: translateX(0);
  }

  .chart-bar:last-child .chart-tooltip::after {
    left: auto;
    right: 20px;
    transform: translateX(0);
  }

  .chart-bar:hover .chart-tooltip {
    opacity: 1;
  }

  .tooltip-date {
    color: #d9eef7;
    font-weight: 600;
    margin-bottom: 0.2rem;
  }

  .tooltip-size {
    color: #3498db;
    font-weight: 500;
    margin-bottom: 0.1rem;
  }

  .tooltip-count {
    color: #aaa;
    font-size: 0.75rem;
  }

  .frequency-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 1rem;
    padding: 0.75rem;
    background: #1e2228;
    border: 1px solid #444;
    border-radius: 6px;
  }

  .frequency-info .info-icon {
    font-size: 1.2rem;
  }

  .frequency-info .info-text {
    color: #bbb;
    font-size: 0.9rem;
  }

  /* Stats Icon Button */
  .stats-icon-btn {
    background: #2a2e36;
    border: 1px solid #555;
    border-radius: 4px;
    padding: 0.5rem;
    color: #d9eef7;
    font-size: 1.2rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .stats-icon-btn:hover {
    background: #3a3e46;
  }

  /* Statistics Modal */
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .statistics-modal {
    background: #2a2e36;
    border: 1px solid #555;
    border-radius: 8px;
    width: 90%;
    max-width: 800px;
    max-height: 80vh;
    overflow-y: auto;
    position: relative;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid #444;
  }

  .modal-header h3 {
    margin: 0;
    color: #d9eef7;
    font-size: 1.2rem;
  }

  .modal-close {
    background: none;
    border: none;
    color: #aaa;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0;
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-close:hover {
    color: #d9eef7;
  }

  .modal-content {
    padding: 1.25rem;
  }

  .stat-help {
    color: #888;
    font-size: 0.75rem;
    font-style: italic;
    margin-top: 0.25rem;
  }

  /* Ultra Compact Single Row Retention Styles */
  .retention-single-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem;
    background: #1e2228;
    border: 1px solid #444;
    border-radius: 4px;
    flex-wrap: wrap;
  }

  .retention-inline-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .retention-separator {
    color: #555;
    font-size: 1rem;
    user-select: none;
  }

  .inline-label {
    color: #bbb;
    font-size: 0.85rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .inline-input {
    background: #2a2e36;
    border: 1px solid #555;
    border-radius: 3px;
    padding: 0.2rem 0.4rem;
    color: #d9eef7;
    font-size: 0.85rem;
    width: 50px;
    text-align: center;
  }

  .inline-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .inline-input:focus {
    outline: none;
    border-color: #3498db;
  }

  .inline-select {
    background: #2a2e36;
    border: 1px solid #555;
    border-radius: 3px;
    padding: 0.2rem 0.3rem;
    color: #d9eef7;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .inline-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .inline-suffix {
    color: #aaa;
    font-size: 0.85rem;
    white-space: nowrap;
  }

  /* Retention Actions Styles */
  .retention-actions {
    display: flex;
    gap: 1rem;
    margin-top: 1.5rem;
    padding: 1.25rem;
    background: rgba(52, 152, 219, 0.05);
    border: 1px solid rgba(52, 152, 219, 0.2);
    border-radius: 8px;
    justify-content: center;
    align-items: center;
  }

  .preview-btn {
    background: #3498db;
    border: none;
    border-radius: 6px;
    padding: 0.75rem 1.5rem;
    color: white;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    font-size: 0.95rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    box-shadow: 0 2px 4px rgba(52, 152, 219, 0.3);
  }

  .preview-btn.primary-action {
    background: #2ecc71;
    box-shadow: 0 2px 4px rgba(46, 204, 113, 0.3);
  }

  .preview-btn:hover:not(:disabled) {
    background: #2980b9;
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(52, 152, 219, 0.4);
  }

  .preview-btn.primary-action:hover:not(:disabled) {
    background: #27ae60;
    box-shadow: 0 4px 8px rgba(46, 204, 113, 0.4);
  }

  .preview-btn:disabled {
    background: #95a5a6;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
    opacity: 0.7;
  }

  .apply-direct-btn {
    background: #e67e22;
    border: none;
    border-radius: 6px;
    padding: 0.75rem 1.5rem;
    color: white;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    font-size: 0.95rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    box-shadow: 0 2px 4px rgba(230, 126, 34, 0.3);
  }

  .apply-direct-btn.secondary-action {
    background: #95a5a6;
    box-shadow: 0 2px 4px rgba(149, 165, 166, 0.3);
  }

  .apply-direct-btn:hover:not(:disabled) {
    background: #d35400;
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(230, 126, 34, 0.4);
  }

  .apply-direct-btn.secondary-action:hover:not(:disabled) {
    background: #7f8c8d;
    box-shadow: 0 4px 8px rgba(149, 165, 166, 0.4);
  }

  .apply-direct-btn:disabled {
    background: #95a5a6;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
    opacity: 0.7;
  }

  .retention-applied-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 16px;
    background: #d5f4e6;
    border: 1px solid #27ae60;
    border-radius: 8px;
    margin: 12px 0;
    position: relative;
  }

  .applied-icon {
    font-size: 24px;
    margin-bottom: 8px;
  }

  .applied-text {
    font-weight: 600;
    color: #27ae60;
    margin-bottom: 4px;
  }

  .applied-hint {
    font-size: 12px;
    color: #7f8c8d;
    text-align: center;
  }

  .optimize-icon-btn {
    background: #9b59b6;
    border: none;
    border-radius: 50%;
    width: 36px;
    height: 36px;
    color: white;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 4px rgba(155, 89, 182, 0.3);
  }

  .optimize-icon-btn:hover:not(:disabled) {
    background: #8e44ad;
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(155, 89, 182, 0.4);
  }

  .optimize-icon-btn:disabled {
    background: #95a5a6;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  .optimization-section {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid #444;
  }

  /* Responsive behavior for smaller screens */
  @media (max-width: 768px) {
    .retention-single-row {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }

    .retention-separator {
      display: none;
    }

    .retention-inline-item {
      justify-content: space-between;
      padding: 0.25rem 0;
    }
  }
</style>
