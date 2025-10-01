<script>
  import { onMount, onDestroy, createEventDispatcher } from "svelte";

  export let serverPath = "";
  export let currentInstance;

  const dispatch = createEventDispatcher();
  import { openFolder, validateServerPath } from "../utils/folderUtils.js";
  import AutoRestartSettings from "../components/settings/AutoRestartSettings.svelte";
  import VersionUpdater from "../components/settings/VersionUpdater.svelte";
  import WorldSettings from "../components/settings/WorldSettings.svelte";
  import ServerPropertiesEditor from "../components/settings/ServerPropertiesEditor.svelte";
  import InstanceSettings from "../components/settings/InstanceSettings.svelte";
  import { errorMessage } from "../stores/modStore.js";
  import logger from "../utils/logger.js";

  // Enhanced state management
  let showCopyConfirmation = false;
  let pageInitialized = false;
  let loadingState = "idle"; // idle, loading, loaded, error
  let activeCategory = "overview";
  let settingsInteractions = 0;
  let formOperations = 0;
  let categoryChanges = 0;
  let previousServerPath = "";
  let serverFolderSize = null; // bytes
  let serverFolderSizeLoading = false;
  
  // Server config info
  let serverConfig = null;
  let serverConfigLoading = false;
  let javaVersion = null;

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    if (!bytes || isNaN(bytes)) return '—';
    const k = 1024;
    const sizes = ['B','KB','MB','GB','TB'];
    const i = Math.min(Math.floor(Math.log(bytes)/Math.log(k)), sizes.length-1);
    return `${(bytes/Math.pow(k,i)).toFixed(2)} ${sizes[i]}`;
  }

  async function loadServerFolderSize() {
    if (!serverPath) return;
    serverFolderSizeLoading = true;
    try {
      const res = await window.electron.invoke('get-folder-size', { path: serverPath });
      if (res?.success) {
        serverFolderSize = res.size;
      }
    } catch (e) {
      // ignore size errors to keep UI responsive
    } finally {
      serverFolderSizeLoading = false;
    }
  }

  async function loadServerConfig() {
    if (!serverPath) return;
    serverConfigLoading = true;
    try {
      const config = await window.electron.invoke('read-config', serverPath);
      if (config) {
        serverConfig = config;
        console.log('Loaded server config:', config);
        
        // Get Java version info
        if (config.version) {
          const javaInfo = await window.electron.invoke('server-java-check-requirements', {
            minecraftVersion: config.version,
            serverPath: serverPath
          });
          if (javaInfo?.requiredJavaVersion) {
            javaVersion = javaInfo.requiredJavaVersion;
          }
        }
      }
    } catch (e) {
      console.error('Failed to load server config:', e);
    } finally {
      serverConfigLoading = false;
    }
  }

  const settingsCategories = [
    { id: "overview", name: "Server Overview", icon: "🖥️" },
    { id: "properties", name: "Server Properties", icon: "⚙️" },
    { id: "world", name: "World Management", icon: "🌍" },
    { id: "autorestart", name: "Auto-Restart", icon: "🔄" },
    { id: "version", name: "Version Management", icon: "📦" },
    { id: "instance", name: "Instance Management", icon: "⚠️" },
  ];

  onMount(async () => {
    const startTime = Date.now();

    logger.info("SettingsPage navigation started", {
      category: "settings",
      data: {
        component: "SettingsPage",
        lifecycle: "onMount",
        serverPath,
        hasServerPath: !!serverPath,
        hasCurrentInstance: !!currentInstance,
        instanceName: currentInstance?.name,
        navigationStartTime: startTime,
      },
    });

    try {
      await initializeSettingsPage();
      const initDuration = Date.now() - startTime;

      logger.info("SettingsPage initialization completed", {
        category: "settings",
        data: {
          component: "SettingsPage",
          lifecycle: "onMount",
          success: true,
          initializationDuration: initDuration,

          defaultCategory: activeCategory,
          availableCategories: settingsCategories.length,
        },
      });
    } catch (error) {
      const initDuration = Date.now() - startTime;

      logger.error(`SettingsPage initialization failed: ${error.message}`, {
        category: "settings",
        data: {
          component: "SettingsPage",
          lifecycle: "onMount",
          errorType: error.constructor.name,
          initializationDuration: initDuration,
          serverPath,
          instanceName: currentInstance?.name,
        },
      });

      handleSettingsPageError(error, "initialization");
    }
  });

  onDestroy(() => {
    logger.info("SettingsPage navigation ended", {
      category: "settings",
      data: {
        component: "SettingsPage",
        lifecycle: "onDestroy",
        wasInitialized: pageInitialized,

        finalActiveCategory: activeCategory,
        totalInteractions: settingsInteractions,
        totalFormOperations: formOperations,
        totalCategoryChanges: categoryChanges,
      },
    });
  });

  async function initializeSettingsPage() {
    loadingState = "loading";

    logger.debug("SettingsPage data loading started", {
      category: "settings",
      data: {
        component: "SettingsPage",
        operation: "initializeSettingsPage",
        serverPath,
        previousState: loadingState,
      },
    });

    try {
      // Simulate settings data loading
      await loadSettingsData();
      
      // Load server info (non-blocking)
      loadServerFolderSize();
      loadServerConfig();

      pageInitialized = true;
      loadingState = "loaded";

      logger.info("SettingsPage data loading completed", {
        category: "settings",
        data: {
          component: "SettingsPage",
          operation: "initializeSettingsPage",
          success: true,
          newState: loadingState,
        },
      });
    } catch (error) {
      loadingState = "error";

      logger.error(`SettingsPage data loading failed: ${error.message}`, {
        category: "settings",
        data: {
          component: "SettingsPage",
          operation: "initializeSettingsPage",
          errorType: error.constructor.name,
          newState: loadingState,
        },
      });

      throw error;
    }
  }

  async function loadSettingsData() {
    logger.debug("Loading settings data", {
      category: "settings",
      data: {
        component: "SettingsPage",
        operation: "loadSettingsData",
        serverPath,
        instanceName: currentInstance?.name,
      },
    });

    // Simulate settings data loading
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  function handleFormOperation(operationType, formData = {}) {
    formOperations++;
    settingsInteractions++;

    logger.info(`Settings form operation: ${operationType}`, {
      category: "settings",
      data: {
        component: "SettingsPage",
        operation: "formOperation",
        operationType,
        formOperationNumber: formOperations,
        activeCategory,
        formDataKeys: Object.keys(formData),
        hasFormData: Object.keys(formData).length > 0,
      },
    });
  }

  function handleSettingsPageError(error, context) {
    logger.error(`SettingsPage component failure in ${context}`, {
      category: "settings",
      data: {
        component: "SettingsPage",
        errorContext: context,
        errorType: error.constructor.name,
        errorMessage: error.message,
        serverPath,
        instanceName: currentInstance?.name,
        loadingState,
        pageInitialized,
        activeCategory,
      },
    });

    // Could implement error recovery logic here
  }

  // Handle serverPath changes without reactive loops - using simple reactive statement for logging only
  $: if (serverPath !== previousServerPath) {
    if (serverPath !== undefined) {
      logger.debug("SettingsPage serverPath changed", {
        category: "settings",
        data: {
          component: "SettingsPage",
          event: "serverPathChanged",
          newServerPath: serverPath,
          previousServerPath,
          hasServerPath: !!serverPath,
          wasInitialized: pageInitialized,
        },
      });
    }
    previousServerPath = serverPath;
  }

  $: if (currentInstance !== undefined) {
    logger.debug("SettingsPage currentInstance changed", {
      category: "settings",
      data: {
        component: "SettingsPage",
        event: "currentInstanceChanged",
        hasCurrentInstance: !!currentInstance,
        instanceName: currentInstance?.name,
        previousInstanceName: currentInstance?.name,
        wasInitialized: pageInitialized,
      },
    });

    // Log instance-specific settings availability
    if (currentInstance) {
      logger.info("Instance-specific settings available", {
        category: "settings",
        data: {
          component: "SettingsPage",
          event: "instanceSettingsAvailable",
          instanceName: currentInstance.name,
          instanceType: currentInstance.type,
          hasInstanceManagement: true,
        },
      });
    }
  }

  // Copy path functionality
  async function copyPath() {
    settingsInteractions++;

    logger.debug("Copying server path to clipboard", {
      category: "settings",
      data: {
        component: "SettingsPage",
        operation: "copyPath",
        hasServerPath: !!serverPath,
        interactionNumber: settingsInteractions,
      },
    });

    if (serverPath) {
      try {
        await navigator.clipboard.writeText(serverPath);
        showCopyConfirmation = true;

        logger.info("Server path copied to clipboard successfully", {
          category: "settings",
          data: {
            component: "SettingsPage",
            operation: "copyPath",
            success: true,
            serverPath,
            pathLength: serverPath.length,
          },
        });

        setTimeout(() => {
          showCopyConfirmation = false;
        }, 2000);
      } catch (err) {
        logger.error(
          `Failed to copy server path to clipboard: ${err.message}`,
          {
            category: "settings",
            data: {
              component: "SettingsPage",
              operation: "copyPath",
              errorType: err.constructor.name,
              serverPath,
              pathLength: serverPath.length,
            },
          },
        );

        handleSettingsPageError(err, "clipboard_copy");
      }
    } else {
      logger.warn("Cannot copy server path - path is empty", {
        category: "settings",
        data: {
          component: "SettingsPage",
          operation: "copyPath",
          reason: "empty_path",
        },
      });
    }
  }

  async function openServerFolder() {
    settingsInteractions++;

    logger.info("Opening server folder", {
      category: "settings",
      data: {
        component: "SettingsPage",
        operation: "openServerFolder",
        serverPath,
        hasServerPath: !!serverPath,
        interactionNumber: settingsInteractions,
      },
    });

    if (!validateServerPath(serverPath)) {
      const message =
        "Server path is empty or invalid. Please set up the server first.";
      logger.warn("Cannot open server folder - invalid path", {
        category: "settings",
        data: {
          component: "SettingsPage",
          operation: "openServerFolder",
          serverPath,
          reason: "invalid_path",
          validationFailed: true,
        },
      });

      errorMessage.set(message);
      setTimeout(() => errorMessage.set(""), 5000);
      return;
    }

    try {
      const success = await openFolder(serverPath);
      if (!success) {
        const message = `Failed to open folder. Please access it manually at: ${serverPath}`;
        logger.error("Failed to open server folder", {
          category: "settings",
          data: {
            component: "SettingsPage",
            operation: "openServerFolder",
            serverPath,
            success: false,
            reason: "folder_open_failed",
          },
        });

        errorMessage.set(message);
        setTimeout(() => errorMessage.set(""), 5000);
      } else {
        logger.info("Server folder opened successfully", {
          category: "settings",
          data: {
            component: "SettingsPage",
            operation: "openServerFolder",
            serverPath,
            success: true,
          },
        });
      }
    } catch (error) {
      logger.error(`Server folder open operation failed: ${error.message}`, {
        category: "settings",
        data: {
          component: "SettingsPage",
          operation: "openServerFolder",
          errorType: error.constructor.name,
          serverPath,
        },
      });

      handleSettingsPageError(error, "folder_open");
    }
  }

</script>

<div class="settings-container">
  <!-- Settings Navigation -->
  <div class="settings-navigation">
    <h2>Settings</h2>
  </div>

  {#if loadingState === "loading"}
    <div class="loading-indicator">
      <div class="spinner"></div>
      <p>Loading settings...</p>
    </div>
  {:else if loadingState === "error"}
    <div class="error-indicator">
      <p>Failed to load settings. Please try again.</p>
      <button on:click={() => initializeSettingsPage()}>Retry</button>
    </div>
  {:else}
    <!-- Enhanced Compact Cards Layout -->
    <div class="settings-cards">
      <!-- Server Overview Card -->
      <div class="settings-card overview-card">
        <div class="card-header">
          <h3>
            <span class="icon-wrapper" aria-hidden="true">
              <svg class="server-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                <rect x="3" y="3" width="18" height="6" rx="1.5" ry="1.5"></rect>
                <rect x="3" y="10" width="18" height="6" rx="1.5" ry="1.5"></rect>
                <rect x="3" y="17" width="18" height="4" rx="1.5" ry="1.5"></rect>
                <circle cx="7" cy="6" r="1.2" fill="#4ade80"></circle>
                <circle cx="11" cy="6" r="1.2" fill="#facc15"></circle>
                <circle cx="15" cy="6" r="1.2" fill="#ef4444"></circle>
                <circle cx="7" cy="13" r="1.2" fill="#4ade80"></circle>
                <circle cx="11" cy="13" r="1.2" fill="#facc15"></circle>
                <circle cx="15" cy="13" r="1.2" fill="#ef4444"></circle>
              </svg>
            </span>
            Server Overview
          </h3>
          <div class="status-pills">
            <div class="status-pill server">
              <div class="status-dot"></div>
              <span>Server Instance</span>
            </div>
          </div>
        </div>
        <div class="card-content">
          <div class="info-grid">
            <div class="info-row enhanced" title="Server instance name">
              <div class="info-label">
                  <span class="info-icon">🏷️</span>
                <span>Name</span>
              </div>
              <span class="info-value"
                >{currentInstance?.name || "Unnamed Server"}</span
              >
            </div>
            <div class="info-row enhanced" title="Server installation path">
              <div class="info-label">
                <span class="info-icon">📁</span>
                <span>Server Path</span>
              </div>
              <div class="path-container">
                <span class="info-value path-text"
                  >{serverPath || "Not configured"}</span
                >
                {#if serverPath}
                  <div class="path-actions">
                    <button
                      class="icon-btn"
                      on:click={copyPath}
                      title="Copy path"
                      disabled={showCopyConfirmation}
                    >
                      {showCopyConfirmation ? "✅" : "📋"}
                    </button>
                    {#if !window.IS_BROWSER_PANEL}
                      <button
                        class="icon-btn"
                        on:click={openServerFolder}
                        title="Open server folder">📁</button
                      >
                    {/if}
                  </div>
                {/if}
              </div>
            </div>
            {#if serverPath}
            <div class="info-row enhanced" title="Total size of the server folder">
              <div class="info-label">
                <span class="info-icon">💾</span>
                <span>Folder Size</span>
              </div>
              <span class="info-value">
                {serverFolderSizeLoading ? 'Calculating...' : (serverFolderSize !== null ? formatBytes(serverFolderSize) : '—')}
                {#if !serverFolderSizeLoading}
                  <button class="icon-btn" on:click={loadServerFolderSize} title="Refresh size" style="margin-left:6px;">🔄</button>
                {/if}
              </span>
            </div>
            
            <div class="info-row enhanced" title="Minecraft version installed">
              <div class="info-label">
                <span class="info-icon">🎮</span>
                <span>Minecraft</span>
              </div>
              <span class="info-value">
                {serverConfigLoading ? 'Loading...' : (serverConfig?.version || '—')}
              </span>
            </div>
            
            <div class="info-row enhanced" title="Mod loader type and version">
              <div class="info-label">
                <span class="info-icon">⚙️</span>
                <span>Loader</span>
              </div>
              <span class="info-value">
                {#if serverConfigLoading}
                  Loading...
                {:else if serverConfig?.loader}
                  {serverConfig.loader.charAt(0).toUpperCase() + serverConfig.loader.slice(1)} {serverConfig.loaderVersion || ''}
                {:else}
                  —
                {/if}
              </span>
            </div>
            
            <div class="info-row enhanced" title="Java version required for this Minecraft version">
              <div class="info-label">
                <span class="info-icon">☕</span>
                <span>Java</span>
              </div>
              <span class="info-value">
                {serverConfigLoading ? 'Loading...' : (javaVersion ? `Java ${javaVersion}` : '—')}
              </span>
            </div>
            {/if}
          </div>
        </div>
      </div>

      <!-- Server Configuration Cards -->
      <div class="settings-card">
        <div class="card-header">
          <h3>⚙️ Server Properties</h3>
        </div>
        <div class="card-content">
          <ServerPropertiesEditor {serverPath} />
        </div>
      </div>

      <div class="settings-card">
        <div class="card-header">
          <h3>🌍 World Management</h3>
        </div>
        <div class="card-content">
          <WorldSettings {serverPath} />
        </div>
      </div>

      <div class="settings-card">
        <div class="card-header">
          <h3>🔄 Auto-Restart</h3>
        </div>
        <div class="card-content">
          <AutoRestartSettings />
        </div>
      </div>

      <div class="settings-card">
        <div class="card-header">
          <h3>📦 Version Management</h3>
        </div>
        <div class="card-content">
          <VersionUpdater {serverPath} />
        </div>
      </div>

      <!-- Instance Management Card -->
      {#if currentInstance}
        <div class="settings-card danger-card">
          <div class="card-header">
            <h3>⚠️ Instance Management</h3>
            <div class="warning-badge" title="These actions are permanent">
              Destructive
            </div>
          </div>
          <div class="card-content">
            <InstanceSettings
              instance={currentInstance}
              on:deleted={(e) => {
                handleFormOperation("instance_deletion", {
                  instanceName: e.detail?.instanceName,
                  deletedFiles: e.detail?.deletedFiles,
                });

                logger.info("Instance deletion event received", {
                  category: "settings",
                  data: {
                    component: "SettingsPage",
                    event: "instanceDeleted",
                    instanceName: e.detail?.instanceName,
                    deletedFiles: e.detail?.deletedFiles,
                    formOperationNumber: formOperations,
                  },
                });

                // Forward the deletion event to the parent component (App.svelte)
                dispatch("deleted", e.detail);
              }}
            />
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .settings-container {
    padding: 0.5rem; /* COMPACT: Reduced from 1rem */
    max-width: 1000px; /* COMPACT: Match client settings */
    margin: 0 auto;
    box-sizing: border-box;
  }

  .settings-navigation {
    margin-bottom: 1rem;
  }

  .settings-navigation h2 {
    margin: 0 0 1rem 0;
    color: #e2e8f0;
  }

  .loading-indicator,
  .error-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    text-align: center;
    background: rgba(31, 41, 55, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    margin: 1rem 0;
  }

  .loading-indicator p,
  .error-indicator p {
    color: #e2e8f0;
    margin: 0.5rem 0;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid rgba(75, 85, 99, 0.3);
    border-top: 2px solid #3b82f6;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  .error-indicator button {
    background: #3b82f6;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    cursor: pointer;
    margin-top: 0.5rem;
    transition: background-color 0.2s ease;
  }

  .error-indicator button:hover {
    background: #2563eb;
  }

  /* Enhanced Cards Layout - COMPACT */
  .settings-cards {
    display: grid;
    gap: 0.5rem; /* COMPACT: Reduced from 0.75rem */
    grid-template-columns: 1fr;
  }

  .settings-card {
    background: rgba(31, 41, 55, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    overflow: hidden;
    transition: all 0.2s ease;
  }

  .settings-card:hover {
    border-color: rgba(75, 85, 99, 0.5);
    background: rgba(31, 41, 55, 0.7);
    transform: translateY(-1px);
  }

  .card-header {
    background: rgba(17, 24, 39, 0.8);
    padding: 0.4rem 0.75rem; /* COMPACT: Reduced from 0.6rem 1rem */
    border-bottom: 1px solid rgba(75, 85, 99, 0.3);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem; /* COMPACT: Reduced from 0.75rem */
    flex-wrap: wrap;
  }

  .card-header h3 {
    margin: 0;
    color: #e2e8f0;
    font-size: 0.85rem; /* COMPACT: Reduced from 0.9rem */
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.3rem; /* COMPACT: Reduced from 0.4rem */
  }

  .card-content {
    padding: 0.5rem 0.75rem; /* COMPACT: Reduced from 0.75rem 1rem */
  }

  /* Status Pills */
  .status-pills {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .status-pill {
    display: flex;
    align-items: center;
    gap: 0.25rem; /* COMPACT: Reduced from 0.3rem */
    padding: 0.2rem 0.5rem; /* COMPACT: Reduced from 0.25rem 0.6rem */
    border-radius: 12px;
    font-size: 0.6rem; /* COMPACT: Reduced from 0.65rem */
    font-weight: 600;
    border: 1px solid transparent;
    transition: all 0.2s ease;
  }

  .status-pill.server {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.3);
  }

  .status-pill .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-pill.server .status-dot {
    background: #3b82f6;
    box-shadow: 0 0 4px rgba(59, 130, 246, 0.6);
  }

  /* Enhanced Info Grid - COMPACT */
  .info-grid {
    display: grid;
    gap: 0.25rem; /* COMPACT: Reduced from 0.4rem */
    grid-template-columns: 1fr;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.3rem 0.5rem; /* COMPACT: Reduced from 0.4rem 0.6rem */
    background: rgba(17, 24, 39, 0.4);
    border-radius: 4px;
    border: 1px solid rgba(75, 85, 99, 0.2);
    gap: 0.5rem; /* COMPACT: Reduced from 0.75rem */
    min-height: 28px; /* COMPACT: Reduced from 32px */
    transition: all 0.2s ease;
  }

  .info-row.enhanced:hover {
    background: rgba(17, 24, 39, 0.6);
    border-color: rgba(75, 85, 99, 0.4);
    transform: translateX(2px);
  }

  .info-label {
    font-size: 0.75rem; /* COMPACT: Reduced from 0.8rem */
    color: #9ca3af;
    font-weight: 500;
    min-width: fit-content;
    display: flex;
    align-items: center;
    gap: 0.3rem; /* COMPACT: Reduced from 0.4rem */
  }

  .info-icon {
    font-size: 0.8rem; /* COMPACT: Reduced from 0.9rem */
    opacity: 0.8;
  }

  .info-value {
    font-size: 0.75rem; /* COMPACT: Reduced from 0.8rem */
    color: #e2e8f0;
    font-weight: 500;
    text-align: right;
    word-break: break-all;
  }

  .path-container {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    justify-content: flex-end;
  }

  .path-text {
    font-family: "Monaco", "Menlo", "Ubuntu Mono", monospace;
    font-size: 0.7rem;
    background: rgba(17, 24, 39, 0.8);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    border: 1px solid rgba(75, 85, 99, 0.3);
    transition: all 0.2s ease;
  }

  .path-text:hover {
    border-color: rgba(75, 85, 99, 0.5);
  }

  .path-actions {
    display: flex;
    gap: 0.25rem;
  }

  .icon-btn {
    background: rgba(75, 85, 99, 0.3);
    border: 1px solid rgba(75, 85, 99, 0.5);
    color: #e2e8f0;
    border-radius: 3px;
    padding: 0.2rem 0.4rem;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s ease;
    min-width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .icon-btn:hover:not(:disabled) {
    background: rgba(75, 85, 99, 0.5);
    border-color: rgba(75, 85, 99, 0.7);
    transform: scale(1.05);
  }

  .icon-btn:disabled {
    background: rgba(16, 185, 129, 0.3);
    border-color: rgba(16, 185, 129, 0.5);
    color: #10b981;
    cursor: not-allowed;
  }

  /* Danger Card Styling */
  .danger-card {
    border-color: rgba(239, 68, 68, 0.3);
  }

  .danger-card:hover {
    border-color: rgba(239, 68, 68, 0.5);
  }

  .danger-card .card-header {
    background: rgba(239, 68, 68, 0.1);
  }

  .warning-badge {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
    padding: 0.2rem 0.4rem; /* COMPACT: Reduced from 0.25rem 0.5rem */
    border-radius: 12px;
    font-size: 0.6rem; /* COMPACT: Reduced from 0.65rem */
    font-weight: 600;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  /* Override nested component styling - COMPACT */
  .settings-card :global(.setting-item),
  .settings-card :global(.section-content) {
    background: transparent !important;
    border: none !important;
    margin: 0 !important;
    padding: 0.25rem 0 !important; /* COMPACT: Reduced from 0.5rem */
  }

  .settings-card :global(h3),
  .settings-card :global(h4) {
    color: #e2e8f0 !important;
    font-size: 0.8rem !important; /* COMPACT: Reduced from 0.9rem */
    margin: 0.25rem 0 !important; /* COMPACT: Reduced from 0.5rem */
  }

  .settings-card :global(.danger-zone) {
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    margin: 0 !important;
  }
  /* Server overview icon styles */
  .icon-wrapper { display:inline-flex; align-items:center; margin-right:6px; }
  .server-icon { vertical-align:middle; color: var(--color-text, #ccc); }
  h3 { display:flex; align-items:center; gap:4px; }
</style>
