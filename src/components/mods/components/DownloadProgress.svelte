<!-- @ts-ignore -->
<script>
  import {
    downloads,
    showDownloads,
    DOWNLOAD_STATES,
    DOWNLOAD_SOURCES,
    formatTimeRemaining,
  } from "../../../stores/modStore.js";
  import { safeInvoke } from "../../../utils/ipcUtils.js";
  import logger from "../../../utils/logger.js";
  import DownloadErrorModal from "./DownloadErrorModal.svelte";
  import DownloadToast from "./DownloadToast.svelte";

  /**
   * Format file size
   * @param {number} bytes - Size in bytes
   * @param {number} decimals - Number of decimal places
   * @returns {string} Formatted size string
   */
  function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return "0 B";

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB"];

    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  }

  /**
   * Format speed
   * @param {number} bytesPerSecond - Speed in bytes per second
   * @returns {string} Formatted speed string
   */
  function formatSpeed(bytesPerSecond) {
    return formatBytes(bytesPerSecond) + "/s";
  }

  /**
   * Get source display name
   * @param {string} source - Download source
   * @returns {string} Display name for source
   */
  function getSourceDisplayName(source) {
    switch (source) {
      case DOWNLOAD_SOURCES.SERVER:
        return "Server";
      case DOWNLOAD_SOURCES.MODRINTH:
        return "Modrinth";
      case DOWNLOAD_SOURCES.CURSEFORGE:
        return "CurseForge";
      default:
        return "Unknown";
    }
  }

  /**
   * Get state display class
   * @param {string} state - Download state
   * @returns {string} CSS class name for state
   */
  function getStateClass(state) {
    switch (state) {
      case DOWNLOAD_STATES.QUEUED:
        return "queued";
      case DOWNLOAD_STATES.DOWNLOADING:
        return "downloading";
      case DOWNLOAD_STATES.VERIFYING:
        return "verifying";
      case DOWNLOAD_STATES.RETRYING:
        return "retrying";
      case DOWNLOAD_STATES.FALLBACK:
        return "fallback";
      case DOWNLOAD_STATES.COMPLETED:
        return "completed";
      case DOWNLOAD_STATES.FAILED:
        return "failed";
      default:
        return "unknown";
    }
  }

  /**
   * Check if download is in progress
   * @param {Object} download - Download object
   * @returns {boolean} True if download is in progress
   */
  function isInProgress(download) {
    return [
      DOWNLOAD_STATES.QUEUED,
      DOWNLOAD_STATES.DOWNLOADING,
      DOWNLOAD_STATES.VERIFYING,
      DOWNLOAD_STATES.RETRYING,
      DOWNLOAD_STATES.FALLBACK,
    ].includes(download.state);
  }

  /**
   * Check if download can be cancelled
   * @param {Object} download - Download object
   * @returns {boolean} True if download can be cancelled
   */
  function canCancel(download) {
    return isInProgress(download);
  }

  /**
   * Check if download can be retried
   * @param {Object} download - Download object
   * @returns {boolean} True if download can be retried
   */
  function canRetry(download) {
    return download.state === DOWNLOAD_STATES.FAILED;
  }

  // Computes download state
  $: activeDownloads = Object.values($downloads).filter((d) => isInProgress(d));
  $: completedDownloads = Object.values($downloads).filter(
    (d) => d.state === DOWNLOAD_STATES.COMPLETED,
  );
  $: errorDownloads = Object.values($downloads).filter(
    (d) => d.state === DOWNLOAD_STATES.FAILED,
  );
  $: cancellableDownloads = Object.values($downloads).filter((d) =>
    canCancel(d),
  );
  $: retryableDownloads = Object.values($downloads).filter((d) => canRetry(d));

  // Toggle expanded state
  let expanded = true;

  // Modal and toast states
  let errorModalOpen = false;
  let selectedError = null;
  let selectedDownload = null;
  let activeToasts = [];
  let toastId = 0;

  // Track previous download states for toast notifications
  let previousDownloadStates = {};

  function toggleExpanded() {
    expanded = !expanded;
  }

  function closeDownloads() {
    $showDownloads = false;
  }

  /**
   * Show error modal for a download
   * @param {Object} download - Download object with error
   */
  function showErrorModal(download) {
    if (download.error && download.errorDetails) {
      selectedError = download.errorDetails;
      selectedDownload = download;
      errorModalOpen = true;
    }
  }



  /**
   * Add a toast notification
   * @param {Object} toast - Toast configuration object
   */
  function addToast(toast) {
    const id = ++toastId;
    const toastWithId = { ...toast, id };
    activeToasts = [...activeToasts, toastWithId];

    // Auto-remove toast after duration
    setTimeout(() => {
      removeToast(id);
    }, toast.duration || 4000);
  }

  /**
   * Remove a toast notification
   * @param {number} id - Toast ID to remove
   */
  function removeToast(id) {
    activeToasts = activeToasts.filter((toast) => toast.id !== id);
  }

  // Watch for download state changes to show toast notifications
  $: {
    Object.values($downloads).forEach((download) => {
      const previousState = previousDownloadStates[download.id];

      // Only show notifications for actual state changes, not initial states
      if (previousState && previousState !== download.state && previousState !== undefined) {
        // Show toast for significant state changes
        if (download.state === DOWNLOAD_STATES.FAILED) {
          addToast({
            type: "download-state",
            state: download.state,
            message: `${download.name} download failed`,
            duration: 5000,
            actions: [
              {
                label: "Details",
                handler: () => showErrorModal(download),
              },
              {
                label: "Retry",
                handler: () => retryDownload(download.id),
              },
            ],
          });
        } else if (download.state === DOWNLOAD_STATES.FALLBACK) {
          addToast({
            type: "download-state",
            state: download.state,
            message: `${download.name} trying alternative source`,
            duration: 4000,
          });
        } else if (download.state === DOWNLOAD_STATES.RETRYING) {
          addToast({
            type: "download-state",
            state: download.state,
            message: `Retrying ${download.name} (attempt ${download.attempt}/${download.maxAttempts})`,
            duration: 3000,
          });
        }
      }

      previousDownloadStates[download.id] = download.state;
    });
  }

  // Download management functions
  /**
   * Cancel a specific download
   * @param {string} downloadId - ID of download to cancel
   */
  async function cancelDownload(downloadId) {
    try {
      logger.info("Cancelling download", {
        category: "mods",
        data: { downloadId },
      });

      await safeInvoke("cancel-download", { downloadId });

      // Update local state immediately for better UX
      downloads.update((current) => {
        const updated = { ...current };
        if (updated[downloadId]) {
          updated[downloadId] = {
            ...updated[downloadId],
            state: DOWNLOAD_STATES.FAILED,
            error: "Download cancelled by user",
            statusMessage: "Download cancelled",
            completedTime: Date.now(),
          };
        }
        return updated;
      });
    } catch (error) {
      logger.error("Failed to cancel download", {
        category: "mods",
        data: { downloadId, error: error.message },
      });
    }
  }

  /**
   * Retry a failed download
   * @param {string} downloadId - ID of download to retry
   */
  async function retryDownload(downloadId) {
    try {
      const download = $downloads[downloadId];
      if (!download) return;

      logger.info("Retrying download", {
        category: "mods",
        data: { downloadId, downloadName: download.name },
      });

      await safeInvoke("retry-download", {
        downloadId,
        modName: download.name,
        source: download.source,
      });

      // Update local state immediately
      downloads.update((current) => {
        const updated = { ...current };
        if (updated[downloadId]) {
          updated[downloadId] = {
            ...updated[downloadId],
            state: DOWNLOAD_STATES.QUEUED,
            error: null,
            statusMessage: "Queued for retry...",
            attempt: 1,
            progress: 0,
            startTime: Date.now(),
            completedTime: null,
          };
        }
        return updated;
      });
    } catch (error) {
      logger.error("Failed to retry download", {
        category: "mods",
        data: { downloadId, error: error.message },
      });
    }
  }

  /**
   * Cancel all active downloads
   */
  async function cancelAllDownloads() {
    try {
      logger.info("Cancelling all downloads", {
        category: "mods",
        data: { count: cancellableDownloads.length },
      });

      const promises = cancellableDownloads.map((download) =>
        cancelDownload(download.id),
      );
      await Promise.all(promises);
    } catch (error) {
      logger.error("Failed to cancel all downloads", {
        category: "mods",
        data: { error: error.message },
      });
    }
  }

  /**
   * Retry all failed downloads
   */
  async function retryAllDownloads() {
    try {
      logger.info("Retrying all failed downloads", {
        category: "mods",
        data: { count: retryableDownloads.length },
      });

      const promises = retryableDownloads.map((download) =>
        retryDownload(download.id),
      );
      await Promise.all(promises);
    } catch (error) {
      logger.error("Failed to retry all downloads", {
        category: "mods",
        data: { error: error.message },
      });
    }
  }

  /**
   * Clear all completed downloads from the list
   */
  async function clearCompleted() {
    try {
      logger.info("Clearing completed downloads", {
        category: "mods",
        data: { count: completedDownloads.length },
      });

      downloads.update((current) => {
        const updated = { ...current };
        completedDownloads.forEach((download) => {
          delete updated[download.id];
        });
        return updated;
      });
    } catch (error) {
      logger.error("Failed to clear completed downloads", {
        category: "mods",
        data: { error: error.message },
      });
    }
  }

  /**
   * Move a download to the top of the queue
   * @param {string} downloadId - ID of download to prioritize
   */
  async function moveToTop(downloadId) {
    try {
      logger.info("Moving download to top of queue", {
        category: "mods",
        data: { downloadId },
      });

      await safeInvoke("prioritize-download", { downloadId, priority: "high" });
    } catch (error) {
      logger.error("Failed to prioritize download", {
        category: "mods",
        data: { downloadId, error: error.message },
      });
    }
  }
</script>

{#if $showDownloads}
  <div class="downloads-container">
    <div class="downloads-header">
      <button
        class="toggle-header-button"
        on:click={toggleExpanded}
        type="button"
        aria-expanded={expanded}
        aria-controls="downloads-content"
      >
        <div class="header-title">
          <span class="downloads-icon">📥</span>
          <span class="downloads-title">Downloads</span>

          <div class="download-counts">
            {#if activeDownloads.length > 0}
              <span class="download-count active" title="Active downloads">
                {activeDownloads.length}
              </span>
            {/if}

            {#if completedDownloads.length > 0}
              <span
                class="download-count completed"
                title="Completed downloads"
              >
                {completedDownloads.length}
              </span>
            {/if}

            {#if errorDownloads.length > 0}
              <span class="download-count error" title="Failed downloads">
                {errorDownloads.length}
              </span>
            {/if}
          </div>
        </div>

        <div class="header-actions">
          <span class="toggle-icon" title={expanded ? "Collapse" : "Expand"}>
            {expanded ? "▼" : "▲"}
          </span>
        </div>
      </button>

      <div class="header-controls">
        {#if retryableDownloads.length > 0}
          <button
            class="control-button retry-all"
            on:click={retryAllDownloads}
            title="Retry all failed downloads"
            type="button"
          >
            🔄
          </button>
        {/if}

        {#if cancellableDownloads.length > 0}
          <button
            class="control-button cancel-all"
            on:click={cancelAllDownloads}
            title="Cancel all active downloads"
            type="button"
          >
            ⏹️
          </button>
        {/if}

        {#if completedDownloads.length > 0}
          <button
            class="control-button clear-completed"
            on:click={clearCompleted}
            title="Clear completed downloads"
            type="button"
          >
            🗑️
          </button>
        {/if}
      </div>

      <button
        class="close-button"
        on:click={closeDownloads}
        title="Close"
        type="button"
        aria-label="Close downloads panel"
      >
        ✕
      </button>
    </div>

    {#if expanded}
      <div id="downloads-content" class="downloads-content">
        {#each Object.values($downloads) as download (download.id)}
          <div
            class="download-item {getStateClass(download.state)}"
            class:completed={download.state === DOWNLOAD_STATES.COMPLETED}
            class:error={download.state === DOWNLOAD_STATES.FAILED}
          >
            <div class="download-info">
              <div class="download-header">
                <div class="download-name" title={download.name}>
                  {download.name}
                </div>
                <div class="download-actions">
                  <div class="download-source" title="Download source">
                    {getSourceDisplayName(download.source)}
                  </div>

                  <div class="download-controls">
                    {#if download.state === DOWNLOAD_STATES.QUEUED}
                      <button
                        class="download-control-btn priority-btn"
                        on:click={() => moveToTop(download.id)}
                        title="Move to top of queue"
                        type="button"
                      >
                        ⬆️
                      </button>
                    {/if}

                    {#if canCancel(download)}
                      <button
                        class="download-control-btn cancel-btn"
                        on:click={() => cancelDownload(download.id)}
                        title="Cancel download"
                        type="button"
                      >
                        ❌
                      </button>
                    {/if}

                    {#if canRetry(download)}
                      <button
                        class="download-control-btn retry-btn"
                        on:click={() => retryDownload(download.id)}
                        title="Retry download"
                        type="button"
                      >
                        🔄
                      </button>
                    {/if}
                  </div>
                </div>
              </div>

              <div class="download-status-line">
                <div class="status-message">{download.statusMessage}</div>
                {#if download.state === DOWNLOAD_STATES.RETRYING}
                  <div class="retry-info">
                    Attempt {download.attempt}/{download.maxAttempts}
                  </div>
                {/if}
              </div>

              {#if download.state === DOWNLOAD_STATES.FALLBACK && download.fallbackCountdown > 0}
                <div class="fallback-countdown">
                  Trying alternative source in {formatTimeRemaining(
                    download.fallbackCountdown,
                  )}
                </div>
              {/if}

              {#if download.state === DOWNLOAD_STATES.QUEUED && download.queuePosition > 0}
                <div class="queue-position">
                  Queue position: {download.queuePosition}
                </div>
              {/if}

              {#if download.state === DOWNLOAD_STATES.FAILED}
                <div class="download-error">
                  <button
                    class="error-message"
                    on:click={() => showErrorModal(download)}
                    type="button"
                    title="Click to view error details"
                  >
                    {download.error || "Download failed"}
                    <span class="error-details-link">Click for details</span>
                  </button>
                  {#if download.errorDetails}
                    <div class="error-summary">
                      Last attempted: {getSourceDisplayName(
                        download.errorDetails.source,
                      )}
                      {#if download.errorDetails.type === "checksum"}
                        (Checksum validation failed)
                      {/if}
                    </div>
                  {/if}
                </div>
              {:else if download.state === DOWNLOAD_STATES.COMPLETED}
                <div class="download-success">
                  Completed
                  {#if download.checksumValidation?.isValid}
                    <span class="checksum-valid" title="File integrity verified"
                      >✓</span
                    >
                  {/if}
                </div>
              {:else if isInProgress(download)}
                <div class="download-details">
                  {#if typeof download.size === "number" && !isNaN(download.size) && download.size > 0}
                    <div class="size-info">
                      {formatBytes((download.progress * download.size) / 100)} of
                      {formatBytes(download.size)}
                    </div>
                  {:else}
                    <div class="progress-info">
                      {(download.progress || 0).toFixed(0)}% complete
                    </div>
                  {/if}

                  <div class="speed-time-info">
                    {#if download.speed && !isNaN(download.speed) && download.speed > 0}
                      <span class="speed">{formatSpeed(download.speed)}</span>
                    {/if}
                    {#if download.estimatedTimeRemaining > 0}
                      <span class="time-remaining">
                        {formatTimeRemaining(download.estimatedTimeRemaining)} remaining
                      </span>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>

            {#if isInProgress(download)}
              <div class="progress-bar-container">
                <div
                  class="progress-bar {getStateClass(download.state)}"
                  style="width: {download.progress}%"
                  role="progressbar"
                  aria-valuenow={download.progress}
                  aria-valuemin="0"
                  aria-valuemax="100"
                ></div>
                <div class="progress-text">{download.progress.toFixed(0)}%</div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<!-- Error Modal -->
<DownloadErrorModal
  bind:isOpen={errorModalOpen}
  error={selectedError}
  download={selectedDownload}
  on:close={() => {
    errorModalOpen = false;
    selectedError = null;
    selectedDownload = null;
  }}
  on:retry={(event) => retryDownload(event.detail.downloadId)}
  on:report={(event) => {
    logger.info("Error reported by user", {
      category: "mods",
      data: {
        downloadId: event.detail.download.id,
        errorType: event.detail.error.type,
      },
    });
  }}
/>



<!-- Toast Notifications -->
{#each activeToasts as toast (toast.id)}
  <DownloadToast {toast} on:dismiss={() => removeToast(toast.id)} />
{/each}

<style>
  .downloads-container {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 300px;
    background: #272727;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    z-index: 100;
    overflow: hidden;
    transition: all 0.2s ease;
  }

  .downloads-container:hover {
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  }

  .downloads-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #1a1a1a;
    user-select: none;
  }

  .header-controls {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .control-button {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 12px;
    padding: 4px 6px;
    border-radius: 4px;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .control-button:hover {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .control-button.retry-all:hover {
    background: rgba(76, 175, 80, 0.2);
    color: #4caf50;
  }

  .control-button.cancel-all:hover {
    background: rgba(244, 67, 54, 0.2);
    color: #f44336;
  }

  .control-button.clear-completed:hover {
    background: rgba(158, 158, 158, 0.2);
    color: #9e9e9e;
  }



  .toggle-header-button {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    flex: 1;
    padding: 10px 12px;
    text-align: left;
  }

  .header-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .downloads-icon {
    font-size: 16px;
  }

  .downloads-title {
    font-weight: 500;
    font-size: 14px;
  }

  .download-counts {
    display: flex;
    gap: 4px;
    margin-left: 8px;
  }

  .download-count {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .download-count.active {
    background-color: #2196f3;
    color: white;
  }

  .download-count.completed {
    background-color: #4caf50;
    color: white;
  }

  .download-count.error {
    background-color: #f44336;
    color: white;
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .toggle-icon,
  .close-button {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
    transition: color 0.2s;
  }

  .toggle-icon:hover,
  .close-button:hover {
    color: white;
  }

  .close-button {
    padding: 10px 12px;
  }

  .downloads-content {
    max-height: 300px;
    overflow-y: auto;
    padding: 10px;
  }

  .download-item {
    padding: 10px 12px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.05);
    margin-bottom: 8px;
    border-left: 3px solid transparent;
    transition: all 0.2s ease;
  }

  .download-item.completed {
    background: rgba(76, 175, 80, 0.1);
    border-left-color: #4caf50;
  }

  .download-item.error {
    background: rgba(244, 67, 54, 0.1);
    border-left-color: #f44336;
  }

  .download-item.downloading {
    border-left-color: #2196f3;
  }

  .download-item.verifying {
    border-left-color: #ff9800;
  }

  .download-item.retrying {
    border-left-color: #ff5722;
  }

  .download-item.fallback {
    border-left-color: #9c27b0;
  }

  .download-item.queued {
    border-left-color: #607d8b;
  }

  .download-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  .download-name {
    font-weight: 500;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    margin-right: 8px;
  }

  .download-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .download-source {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.6);
    background: rgba(255, 255, 255, 0.1);
    padding: 2px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }

  .download-controls {
    display: flex;
    gap: 2px;
    align-items: center;
  }

  .download-control-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    font-size: 10px;
    padding: 2px 4px;
    border-radius: 3px;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
  }

  .download-control-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .download-control-btn.retry-btn:hover {
    background: rgba(76, 175, 80, 0.2);
    color: #4caf50;
  }

  .download-control-btn.cancel-btn:hover {
    background: rgba(244, 67, 54, 0.2);
    color: #f44336;
  }

  .download-control-btn.priority-btn:hover {
    background: rgba(33, 150, 243, 0.2);
    color: #2196f3;
  }

  .download-status-line {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  .status-message {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.8);
    flex: 1;
  }

  .retry-info {
    font-size: 10px;
    color: #ff5722;
    background: rgba(255, 87, 34, 0.1);
    padding: 2px 6px;
    border-radius: 10px;
    white-space: nowrap;
  }

  .fallback-countdown {
    font-size: 10px;
    color: #9c27b0;
    background: rgba(156, 39, 176, 0.1);
    padding: 4px 8px;
    border-radius: 4px;
    margin-bottom: 4px;
  }

  .queue-position {
    font-size: 10px;
    color: #607d8b;
    background: rgba(96, 125, 139, 0.1);
    padding: 2px 6px;
    border-radius: 10px;
    margin-bottom: 4px;
  }

  .download-details {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 6px;
  }

  .size-info,
  .progress-info {
    margin-bottom: 2px;
  }

  .speed-time-info {
    display: flex;
    gap: 8px;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.6);
  }

  .speed {
    color: #2196f3;
  }

  .time-remaining {
    color: #ff9800;
  }

  .download-success {
    font-size: 11px;
    color: #4caf50;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .checksum-valid {
    color: #4caf50;
    font-weight: bold;
  }

  .download-error {
    font-size: 11px;
    color: #f44336;
  }

  .error-message {
    background: none;
    border: none;
    color: inherit;
    font-size: inherit;
    font-family: inherit;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    transition: background 0.2s;
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    text-align: left;
  }

  .error-message:hover {
    background: rgba(244, 67, 54, 0.1);
  }

  .error-details-link {
    font-size: 9px;
    color: rgba(244, 67, 54, 0.7);
    font-style: italic;
  }

  .error-summary {
    font-size: 10px;
    color: rgba(244, 67, 54, 0.8);
    margin-top: 2px;
  }

  .progress-bar-container {
    height: 8px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    overflow: hidden;
    position: relative;
    margin-top: 6px;
  }

  .progress-bar {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s ease;
  }

  .progress-bar.downloading {
    background: linear-gradient(to right, #2196f3, #03a9f4);
  }

  .progress-bar.verifying {
    background: linear-gradient(to right, #ff9800, #ffc107);
    animation: pulse 1.5s ease-in-out infinite alternate;
  }

  .progress-bar.retrying {
    background: linear-gradient(to right, #ff5722, #ff7043);
    animation: pulse 1s ease-in-out infinite alternate;
  }

  .progress-bar.fallback {
    background: linear-gradient(to right, #9c27b0, #ba68c8);
  }

  .progress-bar.queued {
    background: linear-gradient(to right, #607d8b, #78909c);
  }

  @keyframes pulse {
    from {
      opacity: 0.6;
    }
    to {
      opacity: 1;
    }
  }

  .progress-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 9px;
    color: white;
    text-shadow: 0 0 2px rgba(0, 0, 0, 0.7);
    font-weight: 500;
  }
</style>
