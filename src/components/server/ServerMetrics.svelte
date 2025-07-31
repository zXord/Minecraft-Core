<!-- @ts-ignore -->
<script>
  /// <reference path="../../electron.d.ts" />
  import { onMount, onDestroy } from "svelte";
  import { serverState } from "../../stores/serverState.js";
  import { playerState } from "../../stores/playerState.js";

  import { MetricsFormatter } from "../../utils/metrics/formatter.js";
  import logger from "../../utils/logger.js";

  // Simplified metrics variables (CPU monitoring removed)
  let metricsErrors = {
    memory: null,
    uptime: null,
    players: null,
  };
  let metricsRetryAttempts = {
    memory: 0,
    uptime: 0,
    players: 0,
  };

  // Tooltip variables removed (CPU charts removed)

  onMount(() => {
    logger.info("ServerMetrics component mounted (CPU monitoring removed)", {
      category: "ui",
      data: {
        component: "ServerMetrics",
        lifecycle: "onMount",
      },
    });

    // Initialize error recovery mechanisms
    initializeErrorRecovery();
  });

  onDestroy(() => {
    logger.debug("ServerMetrics component destroyed", {
      category: "ui",
      data: {
        component: "ServerMetrics",
        lifecycle: "onDestroy",
      },
    });

    // Clean up error recovery
    cleanupErrorRecovery();
  });

  // Error recovery and retry mechanisms (simplified)
  function initializeErrorRecovery() {
    logger.debug("Initializing metrics error recovery", {
      category: "ui",
      data: {
        component: "ServerMetrics",
        function: "initializeErrorRecovery",
      },
    });
  }

  function cleanupErrorRecovery() {
    logger.debug("Cleaned up metrics error recovery", {
      category: "ui",
      data: {
        component: "ServerMetrics",
        function: "cleanupErrorRecovery",
      },
    });
  }

  // CPU monitoring functions removed - only Memory, Uptime, and Players metrics remain

  function handleMetricError(metricType, error, retryCallback = null) {
    try {
      metricsErrors[metricType] = error;
      metricsRetryAttempts[metricType]++;

      logger.warn(`Metrics error for ${metricType}`, {
        category: "ui",
        data: {
          component: "ServerMetrics",
          function: "handleMetricError",
          metricType,
          error: error.message || error,
          retryAttempt: metricsRetryAttempts[metricType],
          maxRetries: 3,
        },
      });

      // Attempt retry if callback provided and under retry limit
      if (retryCallback && metricsRetryAttempts[metricType] <= 3) {
        const retryDelay = Math.min(
          1000 * Math.pow(2, metricsRetryAttempts[metricType] - 1),
          10000,
        );

        setTimeout(() => {
          logger.info(`Retrying ${metricType} metric calculation`, {
            category: "ui",
            data: {
              component: "ServerMetrics",
              function: "handleMetricError.retry",
              metricType,
              retryAttempt: metricsRetryAttempts[metricType],
              retryDelay,
            },
          });

          try {
            retryCallback();
          } catch (retryError) {
            logger.error(`Retry failed for ${metricType}`, {
              category: "ui",
              data: {
                component: "ServerMetrics",
                function: "handleMetricError.retry",
                metricType,
                retryError: retryError.message || retryError,
              },
            });
          }
        }, retryDelay);
      }
    } catch (handlerError) {
      logger.error("Error in metric error handler", {
        category: "ui",
        data: {
          component: "ServerMetrics",
          function: "handleMetricError",
          handlerError: handlerError.message || handlerError,
          originalMetricType: metricType,
        },
      });
    }
  }

  function clearMetricError(metricType) {
    try {
      if (metricsErrors[metricType]) {
        logger.debug(`Clearing error for ${metricType}`, {
          category: "ui",
          data: {
            component: "ServerMetrics",
            function: "clearMetricError",
            metricType,
            previousError: metricsErrors[metricType],
          },
        });

        metricsErrors[metricType] = null;
        metricsRetryAttempts[metricType] = 0;
      }
    } catch (error) {
      logger.warn("Error clearing metric error", {
        category: "ui",
        data: {
          component: "ServerMetrics",
          function: "clearMetricError",
          error: error.message || error,
          metricType,
        },
      });
    }
  }

  // CPU monitoring error handler removed

  // CPU monitoring start function removed

  // Reactive variables from stores (CPU monitoring removed)
  $: memUsedMB = $serverState.memUsedMB;
  $: maxRamMB = $serverState.maxRamMB;
  $: uptime = $serverState.uptime;
  $: players = $playerState.count;
  $: isServerRunning = $serverState.status === "Running";
  // CPU usage display removed - only Memory, Uptime, and Players metrics remain

  // CPU trend analysis removed

  // Enhanced memory usage display with comprehensive error handling
  $: memoryDisplay = (() => {
    try {
      if (!isServerRunning) {
        clearMetricError("memory");
        return MetricsFormatter.createUnavailableState(
          "memory usage",
          "Server not running",
        );
      }

      // Validate memory inputs
      if (
        memUsedMB === null ||
        memUsedMB === undefined ||
        maxRamMB === null ||
        maxRamMB === undefined
      ) {
        handleMetricError("memory", "Memory data not available");
        return MetricsFormatter.createLoadingState("memory usage");
      }

      if (typeof memUsedMB !== "number" || typeof maxRamMB !== "number") {
        handleMetricError(
          "memory",
          `Invalid memory data types: used=${typeof memUsedMB}, max=${typeof maxRamMB}`,
        );
        return MetricsFormatter.createErrorState(
          "memory usage",
          "Invalid memory data format",
        );
      }

      if (isNaN(memUsedMB) || isNaN(maxRamMB)) {
        handleMetricError(
          "memory",
          `Memory values are NaN: used=${memUsedMB}, max=${maxRamMB}`,
        );
        return MetricsFormatter.createErrorState(
          "memory usage",
          "Memory calculation failed",
        );
      }

      if (memUsedMB < 0 || maxRamMB <= 0) {
        handleMetricError(
          "memory",
          `Invalid memory values: used=${memUsedMB}MB, max=${maxRamMB}MB`,
        );
        return MetricsFormatter.createErrorState(
          "memory usage",
          "Invalid memory values",
        );
      }

      if (memUsedMB > maxRamMB * 1.1) {
        // Allow 10% tolerance for measurement variations
        handleMetricError(
          "memory",
          `Used memory (${memUsedMB}MB) exceeds maximum (${maxRamMB}MB)`,
        );
        return MetricsFormatter.createErrorState(
          "memory usage",
          "Memory usage exceeds maximum",
        );
      }

      // Clear any previous errors on successful validation
      clearMetricError("memory");

      const result = MetricsFormatter.formatMemoryWithErrorHandling(
        memUsedMB,
        maxRamMB,
      );

      // Additional validation of the formatted result
      if (MetricsFormatter.isErrorState(result)) {
        handleMetricError("memory", result.error || "Memory formatting failed");
      }

      return result;
    } catch (error) {
      logger.error("Memory display calculation error", {
        category: "ui",
        data: {
          component: "ServerMetrics",
          function: "memoryDisplay",
          error: error.message || error,
          memUsedMB,
          maxRamMB,
          isServerRunning,
        },
      });

      handleMetricError("memory", error);
      return MetricsFormatter.createErrorState("memory usage", error);
    }
  })();

  // Enhanced uptime display with comprehensive error handling
  $: uptimeDisplay = (() => {
    try {
      if (!isServerRunning) {
        clearMetricError("uptime");
        return MetricsFormatter.createUnavailableState(
          "uptime",
          "Server not running",
        );
      }

      // Validate uptime input
      if (uptime === null || uptime === undefined) {
        handleMetricError("uptime", "Uptime data not available");
        return MetricsFormatter.createLoadingState("uptime");
      }

      if (typeof uptime !== "string") {
        handleMetricError(
          "uptime",
          `Invalid uptime format: expected string, got ${typeof uptime}`,
        );
        return MetricsFormatter.createErrorState(
          "uptime",
          "Invalid uptime format",
        );
      }

      // Validate uptime format (should match pattern like "1h 23m 45s")
      const uptimePattern = /^\d+h \d+m \d+s$/;
      if (!uptimePattern.test(uptime.trim()) && uptime.trim() !== "0h 0m 0s") {
        handleMetricError("uptime", `Invalid uptime pattern: ${uptime}`);
        return MetricsFormatter.createErrorState(
          "uptime",
          "Invalid uptime format",
        );
      }

      // Clear any previous errors on successful validation
      clearMetricError("uptime");

      const result = MetricsFormatter.formatUptimeWithErrorHandling(uptime);

      // Additional validation of the formatted result
      if (MetricsFormatter.isErrorState(result)) {
        handleMetricError("uptime", result.error || "Uptime formatting failed");
      }

      return result;
    } catch (error) {
      logger.error("Uptime display calculation error", {
        category: "ui",
        data: {
          component: "ServerMetrics",
          function: "uptimeDisplay",
          error: error.message || error,
          uptime,
          isServerRunning,
        },
      });

      handleMetricError("uptime", error);
      return MetricsFormatter.createErrorState("uptime", error);
    }
  })();

  // Enhanced player count display with comprehensive error handling
  $: playerDisplay = (() => {
    try {
      if (!isServerRunning) {
        clearMetricError("players");
        return MetricsFormatter.createUnavailableState(
          "player count",
          "Server not running",
        );
      }

      // Validate player count input
      if (players === null || players === undefined) {
        handleMetricError("players", "Player count data not available");
        return MetricsFormatter.createLoadingState("player count");
      }

      if (typeof players !== "number") {
        handleMetricError(
          "players",
          `Invalid player count format: expected number, got ${typeof players}`,
        );
        return MetricsFormatter.createErrorState(
          "player count",
          "Invalid player count format",
        );
      }

      if (isNaN(players)) {
        handleMetricError("players", `Player count is NaN: ${players}`);
        return MetricsFormatter.createErrorState(
          "player count",
          "Player count calculation failed",
        );
      }

      if (players < 0) {
        handleMetricError("players", `Negative player count: ${players}`);
        return MetricsFormatter.createErrorState(
          "player count",
          "Invalid player count",
        );
      }

      // Reasonable upper limit check (assuming max 1000 players is reasonable)
      if (players > 1000) {
        handleMetricError("players", `Unrealistic player count: ${players}`);
        return MetricsFormatter.createErrorState(
          "player count",
          "Player count seems unrealistic",
        );
      }

      // Clear any previous errors on successful validation
      clearMetricError("players");

      // For now, we don't have max players info, so pass null
      const result = MetricsFormatter.formatPlayerCountWithErrorHandling(
        players,
        null,
      );

      // Additional validation of the formatted result
      if (MetricsFormatter.isErrorState(result)) {
        handleMetricError(
          "players",
          result.error || "Player count formatting failed",
        );
      }

      return result;
    } catch (error) {
      logger.error("Player count display calculation error", {
        category: "ui",
        data: {
          component: "ServerMetrics",
          function: "playerDisplay",
          error: error.message || error,
          players,
          isServerRunning,
        },
      });

      handleMetricError("players", error);
      return MetricsFormatter.createErrorState("player count", error);
    }
  })();

  // Reset metrics when server stops - simplified logic (CPU removed)
  $: if (!isServerRunning && $serverState.memUsedMB !== 0) {
    // Only reset if values are non-zero to avoid infinite loops
    logger.debug("Server stopped, resetting metrics", {
      category: "ui",
      data: {
        component: "ServerMetrics",
        event: "resetMetrics",
        previousMemUsed: $serverState.memUsedMB,
      },
    });

    setTimeout(() => {
      serverState.update((state) => ({
        ...state,
        memUsedMB: 0,
        uptime: "0h 0m 0s",
      }));
    }, 100);
  }

  // Tooltip functions removed (CPU charts removed)

  // Additional mount handling removed (CPU monitoring removed)

  // Metrics handler and event listeners removed (CPU monitoring removed)
</script>

<div class="metrics-container">
  <!-- CPU Usage card removed - only Memory, Uptime, and Players metrics remain -->

  <div class="metric-card memory-card">
    <h3>Memory Usage</h3>
    <div
      class="metric-value {MetricsFormatter.getStatusClass(
        memoryDisplay.status,
      )}"
      title={memoryDisplay.context || ""}
    >
      {memoryDisplay.display}
    </div>
    <div class="progress-bar">
      <div
        class="progress-fill {MetricsFormatter.getStatusClass(
          memoryDisplay.status,
        )}"
        style="width: {memoryDisplay.percentage || 0}%"
      ></div>
    </div>
    {#if memoryDisplay.isError}
      <div class="error-message" title={memoryDisplay.error}>
        Memory calculation error
      </div>
    {/if}
  </div>

  <div class="metric-card uptime-card">
    <h3>Server Uptime</h3>
    <div
      class="metric-value {MetricsFormatter.getStatusClass(
        uptimeDisplay.status,
      )}"
      title={uptimeDisplay.context || ""}
    >
      {uptimeDisplay.display}
    </div>
    {#if uptimeDisplay.context && uptimeDisplay.status !== "not-running"}
      <div class="context-info">
        {uptimeDisplay.context}
      </div>
    {/if}
    {#if uptimeDisplay.isError}
      <div class="error-message" title={uptimeDisplay.error}>
        Uptime calculation error
      </div>
    {/if}
  </div>

  <div class="metric-card players-card">
    <h3>Players Online</h3>
    <div
      class="metric-value {MetricsFormatter.getStatusClass(
        playerDisplay.status,
      )}"
      title={playerDisplay.context || ""}
    >
      {playerDisplay.display}
    </div>
    {#if playerDisplay.context && playerDisplay.status !== "not-running"}
      <div class="context-info">
        {playerDisplay.context}
      </div>
    {/if}
    {#if playerDisplay.percentage > 0}
      <div class="progress-bar">
        <div
          class="progress-fill {MetricsFormatter.getStatusClass(
            playerDisplay.status,
          )}"
          style="width: {playerDisplay.percentage}%"
        ></div>
      </div>
    {/if}
    {#if playerDisplay.isError}
      <div class="error-message" title={playerDisplay.error}>
        Player count error
      </div>
    {/if}
  </div>
</div>

<!-- CPU History Chart Tooltip removed -->

<style>
  .metrics-container {
    display: grid;
    grid-template-columns: repeat(
      3,
      1fr
    ); /* 3 columns for Memory, Uptime, Players */
    gap: 1rem;
    margin: 1rem auto;
    width: 100%;
    max-width: 1200px;
    box-sizing: border-box;
  }

  /* Responsive design for smaller screens */
  @media (max-width: 768px) {
    .metrics-container {
      grid-template-columns: 1fr; /* Stack vertically on mobile */
      gap: 0.5rem;
      max-width: 400px;
    }

    .metric-card {
      padding: 0.5rem;
      min-width: 0; /* Allow cards to shrink */
    }

    .metric-card h3 {
      font-size: 0.8rem;
    }

    .metric-value {
      font-size: 1.1rem;
    }
  }

  /* Medium screens - 2 columns */
  @media (min-width: 769px) and (max-width: 1024px) {
    .metrics-container {
      grid-template-columns: repeat(2, 1fr);
      max-width: 800px;
    }
  }

  .metric-card {
    background-color: #2b2b2b;
    border-radius: 8px;
    padding: 1rem;
    text-align: center;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .metric-card h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1rem;
    color: #cccccc;
  }

  .metric-value {
    font-size: 1.5rem;
    font-weight: bold;
    margin-bottom: 0.5rem;
  }

  .not-running {
    color: #888;
    font-style: italic;
  }

  .calculating {
    color: #f0a030;
    font-style: italic;
    font-size: 1.2rem;
  }

  .progress-bar {
    height: 10px;
    background-color: #3a3a3a;
    border-radius: 5px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background-color: #4caf50;
    transition: width 0.3s ease;
  }

  /* CPU styling removed - only Memory, Uptime, and Players metrics remain */

  /* Enhanced CPU history chart styling */
  .cpu-history-chart {
    margin-top: 0.5rem;
    position: relative;
  }

  .chart-container {
    display: flex;
    align-items: flex-end;
    height: 50px;
    gap: 1px;
    background-color: #2a2a2a;
    border-radius: 6px;
    padding: 4px;
    overflow: hidden;
    border: 1px solid #404040;
    position: relative;
  }

  .chart-bar {
    flex: 1;
    min-height: 3px;
    border-radius: 2px;
    transition: all 0.2s ease;
    cursor: pointer;
    position: relative;
    outline: none;
  }

  .chart-bar.normal {
    background-color: #4caf50;
    box-shadow: 0 0 2px rgba(76, 175, 80, 0.3);
  }

  .chart-bar.warning {
    background-color: #ffaa00;
    box-shadow: 0 0 2px rgba(255, 170, 0, 0.3);
  }

  .chart-bar.high {
    background-color: #ff4444;
    box-shadow: 0 0 2px rgba(255, 68, 68, 0.3);
    animation: pulse-critical 2s ease-in-out infinite;
  }

  .chart-bar:hover {
    opacity: 0.9;
    transform: scaleY(1.05) scaleX(1.1);
    z-index: 10;
  }

  .chart-bar:focus {
    outline: 2px solid #66bb6a;
    outline-offset: 1px;
  }

  .chart-label {
    font-size: 0.65rem;
    color: #aaa;
    text-align: center;
    margin-top: 0.3rem;
    line-height: 1.2;
  }

  .chart-timespan {
    display: block;
    font-size: 0.6rem;
    color: #777;
    margin-top: 0.1rem;
  }

  /* CPU Tooltip styling removed */

  /* Responsive design for alerts, trends, and chart */
  @media (max-width: 768px) {
    .chart-container {
      height: 40px;
      padding: 3px;
      gap: 0.5px;
    }

    .chart-label {
      font-size: 0.6rem;
    }

    .chart-timespan {
      font-size: 0.55rem;
    }

    /* CPU tooltip, alert, and trend responsive styles removed */
  }

  @media (max-width: 480px) {
    .chart-container {
      height: 35px;
      padding: 2px;
    }

    .chart-bar {
      min-height: 2px;
    }

    .chart-label {
      font-size: 0.55rem;
    }

    .chart-timespan {
      display: none; /* Hide timespan on very small screens */
    }

    /* CPU alert and trend mobile styles removed */
  }

  /* Animations for critical CPU usage */
  @keyframes pulse-critical {
    0%,
    100% {
      box-shadow: 0 0 2px rgba(255, 68, 68, 0.3);
    }
    50% {
      box-shadow: 0 0 8px rgba(255, 68, 68, 0.6);
    }
  }

  @keyframes pulse-card {
    0%,
    100% {
      box-shadow: 0 2px 8px rgba(255, 68, 68, 0.3);
    }
    50% {
      box-shadow: 0 4px 16px rgba(255, 68, 68, 0.5);
    }
  }

  @keyframes pulse-alert {
    0%,
    100% {
      background-color: rgba(255, 68, 68, 0.1);
    }
    50% {
      background-color: rgba(255, 68, 68, 0.2);
    }
  }

  /* Status-based styling for metric values */
  .metric-value.normal {
    color: #4caf50;
  }

  .metric-value.warning {
    color: #ffaa00;
  }

  .metric-value.critical {
    color: #ff4444;
  }

  .metric-value.error {
    color: #ff4444;
    font-style: italic;
  }

  .metric-value.calculating {
    color: #f0a030;
    font-style: italic;
  }

  .metric-value.not-running {
    color: #888;
    font-style: italic;
  }

  /* Progress bar status colors */
  .progress-fill.normal {
    background-color: #4caf50;
  }

  .progress-fill.warning {
    background-color: #ffaa00;
  }

  .progress-fill.critical {
    background-color: #ff4444;
  }

  .progress-fill.error {
    background-color: #666;
  }

  .progress-fill.calculating {
    background-color: #f0a030;
    animation: pulse 1.5s ease-in-out infinite alternate;
  }

  .progress-fill.not-running {
    background-color: #444;
  }

  /* Error message styling */
  .error-message {
    font-size: 0.7rem;
    color: #ff4444;
    text-align: center;
    margin-top: 0.25rem;
    font-style: italic;
  }

  /* Debug info styling */
  .debug-info {
    font-size: 0.6rem;
    color: #66bb6a;
    text-align: center;
    margin-top: 0.25rem;
    font-style: italic;
    opacity: 0.8;
  }

  /* Additional status classes for consistent formatting */
  .metric-value.status-normal {
    color: #4caf50;
  }

  .metric-value.status-warning {
    color: #ffaa00;
  }

  .metric-value.status-critical {
    color: #ff4444;
  }

  .metric-value.status-error {
    color: #ff4444;
    font-style: italic;
  }

  .metric-value.status-loading {
    color: #f0a030;
    font-style: italic;
  }

  .metric-value.status-not-running {
    color: #888;
    font-style: italic;
  }

  .metric-value.status-recent {
    color: #66bb6a;
  }

  .metric-value.status-stable {
    color: #4caf50;
  }

  .metric-value.status-full {
    color: #ff4444;
  }

  .metric-value.status-busy {
    color: #ffaa00;
  }

  .metric-value.status-active {
    color: #4caf50;
  }

  .metric-value.status-empty {
    color: #888;
  }

  /* Progress bar status classes */
  .progress-fill.status-normal {
    background-color: #4caf50;
  }

  .progress-fill.status-warning {
    background-color: #ffaa00;
  }

  .progress-fill.status-critical {
    background-color: #ff4444;
  }

  .progress-fill.status-error {
    background-color: #666;
  }

  .progress-fill.status-loading {
    background-color: #f0a030;
    animation: pulse 1.5s ease-in-out infinite alternate;
  }

  .progress-fill.status-not-running {
    background-color: #444;
  }

  .progress-fill.status-recent {
    background-color: #66bb6a;
  }

  .progress-fill.status-stable {
    background-color: #4caf50;
  }

  .progress-fill.status-full {
    background-color: #ff4444;
  }

  .progress-fill.status-busy {
    background-color: #ffaa00;
  }

  .progress-fill.status-active {
    background-color: #4caf50;
  }

  .progress-fill.status-empty {
    background-color: #444;
  }

  /* Context information styling */
  .context-info {
    font-size: 0.7rem;
    color: #aaa;
    text-align: center;
    margin-top: 0.25rem;
    font-style: italic;
  }

  /* Enhanced card styling */
  .memory-card,
  .uptime-card,
  .players-card {
    position: relative;
  }

  /* Pulse animation for loading states */
  @keyframes pulse {
    from {
      opacity: 0.6;
    }
    to {
      opacity: 1;
    }
  }
</style>
