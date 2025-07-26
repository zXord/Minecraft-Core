<script>
  export let serverPath = "";
  import { onMount, onDestroy, afterUpdate } from "svelte";
  import ServerControls from "../components/server/ServerControls.svelte";
  import ServerMetrics from "../components/server/ServerMetrics.svelte";
  import ServerConsole from "../components/server/ServerConsole.svelte";
  import logger from "../utils/logger.js";

  let dashboardInitialized = false;
  let dataLoadingState = "idle"; // idle, loading, loaded, error
  let refreshCount = 0;
  let previousServerPath = "";

  onMount(async () => {
    const startTime = Date.now();

    logger.info("ServerDashboard page navigation started", {
      category: "ui",
      data: {
        component: "ServerDashboard",
        lifecycle: "onMount",
        serverPath,
        hasServerPath: !!serverPath,
        navigationStartTime: startTime,
      },
    });

    try {
      await initializeDashboard();
      const initDuration = Date.now() - startTime;

      logger.info("ServerDashboard initialization completed", {
        category: "ui",
        data: {
          component: "ServerDashboard",
          lifecycle: "onMount",
          success: true,
          initializationDuration: initDuration,
          dataLoadingState,
        },
      });
    } catch (error) {
      const initDuration = Date.now() - startTime;

      logger.error(`ServerDashboard initialization failed: ${error.message}`, {
        category: "ui",
        data: {
          component: "ServerDashboard",
          lifecycle: "onMount",
          errorType: error.constructor.name,
          initializationDuration: initDuration,
          serverPath,
        },
      });

      handleDashboardError(error, "initialization");
    }
  });

  onDestroy(() => {
    logger.debug("ServerDashboard page navigation ended", {
      category: "ui",
      data: {
        component: "ServerDashboard",
        lifecycle: "onDestroy",
        wasInitialized: dashboardInitialized,
        finalDataState: dataLoadingState,
        totalRefreshes: refreshCount,
      },
    });
  });

  async function initializeDashboard() {
    logger.debug("Dashboard data loading started", {
      category: "ui",
      data: {
        component: "ServerDashboard",
        operation: "initializeDashboard",
        serverPath,
        previousState: dataLoadingState,
      },
    });

    dataLoadingState = "loading";

    try {
      // Simulate dashboard data loading operations
      await loadDashboardData();

      dataLoadingState = "loaded";
      dashboardInitialized = true;

      logger.info("Dashboard data loading completed", {
        category: "ui",
        data: {
          component: "ServerDashboard",
          operation: "initializeDashboard",
          success: true,
          newState: dataLoadingState,
        },
      });
    } catch (error) {
      dataLoadingState = "error";

      logger.error(`Dashboard data loading failed: ${error.message}`, {
        category: "ui",
        data: {
          component: "ServerDashboard",
          operation: "initializeDashboard",
          errorType: error.constructor.name,
          newState: dataLoadingState,
        },
      });

      throw error;
    }
  }

  async function loadDashboardData() {
    logger.debug("Loading dashboard components data", {
      category: "ui",
      data: {
        component: "ServerDashboard",
        operation: "loadDashboardData",
        serverPath,
      },
    });

    // This would typically load data for child components
    // For now, we'll just simulate the operation
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async function refreshDashboard() {
    const startTime = Date.now();
    refreshCount++;

    logger.info("Dashboard refresh operation started", {
      category: "ui",
      data: {
        component: "ServerDashboard",
        operation: "refreshDashboard",
        refreshNumber: refreshCount,
        currentState: dataLoadingState,
      },
    });

    try {
      await loadDashboardData();
      const refreshDuration = Date.now() - startTime;

      logger.info("Dashboard refresh operation completed", {
        category: "ui",
        data: {
          component: "ServerDashboard",
          operation: "refreshDashboard",
          success: true,
          refreshNumber: refreshCount,
          refreshDuration,
        },
      });
    } catch (error) {
      const refreshDuration = Date.now() - startTime;

      logger.error(`Dashboard refresh operation failed: ${error.message}`, {
        category: "ui",
        data: {
          component: "ServerDashboard",
          operation: "refreshDashboard",
          errorType: error.constructor.name,
          refreshNumber: refreshCount,
          refreshDuration,
        },
      });

      handleDashboardError(error, "refresh");
    }
  }

  function handleDashboardError(error, context) {
    logger.error(`Dashboard component failure in ${context}`, {
      category: "ui",
      data: {
        component: "ServerDashboard",
        errorContext: context,
        errorType: error.constructor.name,
        errorMessage: error.message,
        serverPath,
        dataLoadingState,
        dashboardInitialized,
      },
    });

    // Could implement error recovery logic here
    dataLoadingState = "error";
  }

  // Handle serverPath changes without reactive loops
  afterUpdate(() => {
    if (serverPath !== undefined && serverPath !== previousServerPath) {
      logger.debug("ServerDashboard serverPath changed", {
        category: "ui",
        data: {
          component: "ServerDashboard",
          event: "serverPathChanged",
          newServerPath: serverPath,
          previousServerPath,
          hasServerPath: !!serverPath,
          wasInitialized: dashboardInitialized,
        },
      });

      // Re-initialize dashboard if path changes and component is already mounted
      if (dashboardInitialized && serverPath && typeof window !== "undefined") {
        logger.info("Re-initializing dashboard due to serverPath change", {
          category: "ui",
          data: {
            component: "ServerDashboard",
            event: "serverPathReinitialization",
            newServerPath: serverPath,
            previousServerPath,
          },
        });

        // Update previous path before re-initialization to prevent loops
        previousServerPath = serverPath;

        initializeDashboard().catch((error) => {
          handleDashboardError(error, "serverPath_change");
        });
      } else {
        previousServerPath = serverPath;
      }
    }
  });
</script>

<div class="dashboard-panel">
  <div class="dashboard-header">
    <h2>Server Dashboard</h2>
  </div>

  {#if dataLoadingState === "error"}
    <div class="error-state">
      <p>Failed to load dashboard data. Please try refreshing.</p>
      <button on:click={refreshDashboard}>Retry</button>
    </div>
  {:else}
    <ServerControls {serverPath} />
    <ServerMetrics />
    <ServerConsole />
  {/if}
</div>

<style>
  .dashboard-panel {
    max-width: 1200px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }

  .dashboard-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding: 0 1rem;
  }

  .dashboard-header h2 {
    margin: 0;
  }



  .error-state {
    background: #ffe6e6;
    border: 1px solid #ff9999;
    border-radius: 4px;
    padding: 1rem;
    margin: 1rem;
    text-align: center;
  }

  .error-state button {
    margin-top: 0.5rem;
    padding: 0.5rem 1rem;
    background: #dc3545;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
</style>
