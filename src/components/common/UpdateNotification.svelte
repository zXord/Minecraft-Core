<script>
  import { onMount, onDestroy } from 'svelte';
  import { toast } from 'svelte-sonner';
  
  let updateStatus = {
    updateAvailable: false,
    latestVersion: null,
    currentVersion: null,
    isCheckingForUpdates: false,
    downloadProgress: { percent: 0, bytesPerSecond: 0 },
    autoInstallEnabled: false
  };
  
  let isDownloading = false;
  let isDownloaded = false;
  let showNotification = false;
  let updateInfo = null;

  // Format bytes per second to readable speed
  function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond === 0) return '0 B/s';
    
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(1024));
    const size = (bytesPerSecond / Math.pow(1024, i)).toFixed(1);
    
    return `${size} ${units[i]}`;
  }

  // Format file size
  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = (bytes / Math.pow(1024, i)).toFixed(1);
    
    return `${size} ${units[i]}`;
  }

  // Check if we're in a client instance (don't show popup notifications for clients)
  function isClientInstance() {
    // Check if we're currently viewing a client interface
    // Client instances should handle version compatibility in the Play tab, not as popups
    return document.querySelector('.client-interface') !== null ||
           document.querySelector('.client-wrapper') !== null;
  }

  // Handle update available
  function handleUpdateAvailable(info) {
    // Don't show popup notifications for client instances
    // Client version compatibility is handled in the Play tab
    if (isClientInstance()) {
      return;
    }
    
    // Prevent duplicate notifications for the same version
    if (updateInfo && updateInfo.version === info.version && showNotification) {
      return;
    }
    
    updateInfo = info;
    showNotification = true;
    
    toast.info('Update Available', {
      description: `Version ${info.version} is available for download`,
      duration: 8000,
      action: {
        label: 'View Details',
        onClick: () => showNotification = true
      }
    });
  }

  // Handle download progress
  function handleDownloadProgress(progress) {
    updateStatus.downloadProgress = progress;
    updateStatus = { ...updateStatus };
  }

  // Handle update downloaded (prevent duplicate notifications)
  let downloadNotificationShown = false;
  
  function handleUpdateDownloaded(info) {
    isDownloading = false;
    isDownloaded = true;
    
    // Only show notification once per download
    if (!downloadNotificationShown) {
      downloadNotificationShown = true;
      toast.success('Update Downloaded', {
        description: `Version ${info.version} is ready to install`,
        duration: 10000,
        action: {
          label: 'Install Now',
          onClick: installUpdate
        }
      });
    }
  }

  // Handle errors
  function handleUpdateError(error) {
    isDownloading = false;
    
    toast.error('Update Error', {
      description: error.message || 'Failed to check for updates',
      duration: 8000
    });
  }

  // Download update
  async function downloadUpdate() {
    // Prevent multiple simultaneous downloads
    if (isDownloading) {
      return;
    }
    
    try {
      isDownloading = true;
      const result = await window.electron.invoke('download-update');
      
      if (!result.success) {
        isDownloading = false;
        throw new Error(result.error);
      }
    } catch (error) {
      isDownloading = false;
      toast.error('Download Failed', {
        description: error.message,
        duration: 8000
      });
    }
  }

  // Check if server is running before install
  async function checkServerStatus() {
    try {
      const result = await window.electron.invoke('get-server-status');
      return result.isRunning || false;
    } catch (error) {
      return false;
    }
  }

  // Install update
  async function installUpdate() {
    try {
      // Check if server is running
      const serverRunning = await checkServerStatus();
      
      if (serverRunning) {
        toast.error('Cannot Install Update', {
          description: 'Please stop the Minecraft server before installing the update to prevent data corruption.',
          duration: 10000
        });
        return;
      }

      const result = await window.electron.invoke('install-update');
      
      if (result.success) {
        toast.info('Installing Update', {
          description: 'The app will restart to complete the installation',
          duration: 5000
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      toast.error('Installation Failed', {
        description: error.message,
        duration: 8000
      });
    }
  }

  // Ignore this version
  async function ignoreUpdate() {
    try {
      await window.electron.invoke('ignore-update', updateInfo?.version);
      showNotification = false;
      updateStatus.updateAvailable = false;
      
      toast.success('Update Ignored', {
        description: `Version ${updateInfo?.version} will not be shown again`,
        duration: 5000
      });
    } catch (error) {
      toast.error('Failed to ignore update', {
        description: error.message,
        duration: 5000
      });
    }
  }

  // Remind later
  async function remindLater() {
    try {
      await window.electron.invoke('remind-later');
      showNotification = false;
      
      toast.info('Update Reminder', {
        description: 'You will be reminded about this update later',
        duration: 5000
      });
    } catch (error) {
      toast.error('Failed to set reminder', {
        description: error.message,
        duration: 5000
      });
    }
  }

  // Toggle auto-install
  async function toggleAutoInstall() {
    try {
      const newValue = !updateStatus.autoInstallEnabled;
      await window.electron.invoke('set-auto-install', newValue);
      updateStatus.autoInstallEnabled = newValue;
      updateStatus = { ...updateStatus };
      
      toast.success('Setting Updated', {
        description: `Auto-install ${newValue ? 'enabled' : 'disabled'}`,
        duration: 3000
      });
    } catch (error) {
      toast.error('Failed to update setting', {
        description: error.message,
        duration: 5000
      });
    }
  }

  // Get current update status
  async function refreshUpdateStatus() {
    try {
      const result = await window.electron.invoke('get-update-status');
      if (result.success) {
        updateStatus = { ...updateStatus, ...result };
      }
    } catch (error) {
      // TODO: Add proper logging - Failed to get update status
    }
  }

  // Set up event listeners
  onMount(() => {
    // Get initial status
    refreshUpdateStatus();
    
    // Listen for update events
    window.electron.on('update-available', handleUpdateAvailable);
    window.electron.on('update-download-progress', handleDownloadProgress);
    window.electron.on('update-downloaded', handleUpdateDownloaded);
    window.electron.on('update-error', handleUpdateError);
    window.electron.on('update-not-available', () => {
      updateStatus.isCheckingForUpdates = false;
      updateStatus = { ...updateStatus };
    });
    window.electron.on('update-checking-for-update', () => {
      updateStatus.isCheckingForUpdates = true;
      updateStatus = { ...updateStatus };
    });
    
    // Reset notification flag when new update is available
    window.electron.on('update-available', () => {
      downloadNotificationShown = false;
    });
  });

  onDestroy(() => {
    // Clean up event listeners
    window.electron.removeListener('update-available', handleUpdateAvailable);
    window.electron.removeListener('update-download-progress', handleDownloadProgress);
    window.electron.removeListener('update-downloaded', handleUpdateDownloaded);
    window.electron.removeListener('update-error', handleUpdateError);
    window.electron.removeListener('update-not-available', () => {});
    window.electron.removeListener('update-checking-for-update', () => {});
  });
</script>

{#if showNotification && updateInfo}
  <!-- Update Notification Modal -->
  <div 
    class="modal-backdrop" 
    role="dialog" 
    aria-modal="true" 
    tabindex="-1"
    on:click|self={() => showNotification = false}
    on:keydown={(e) => e.key === 'Escape' && (showNotification = false)}
  >
    <div class="modal-content">
      <div class="modal-header">
        <div class="header-info">
          <div class="update-icon">
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </div>
          <div class="header-text">
            <h3 class="modal-title">Update Available</h3>
            <p class="modal-subtitle">
              Version {updateInfo.version} is ready to download
            </p>
          </div>
        </div>
        <button 
          on:click={() => showNotification = false}
          class="close-button"
          aria-label="Close update notification"
        >
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Current vs New Version -->
      <div class="version-info">
        <div class="version-row">
          <span class="version-label">Current:</span>
          <span class="version-current">{updateStatus.currentVersion}</span>
        </div>
        <div class="version-row">
          <span class="version-label">Latest:</span>
          <span class="version-new">{updateInfo.version}</span>
        </div>
      </div>

      {#if isDownloading}
        <!-- Download Progress -->
        <div class="progress-section">
          <div class="progress-header">
            <span class="progress-label">Downloading...</span>
            <span class="progress-percent">{updateStatus.downloadProgress.percent}%</span>
          </div>
          <div class="progress-bar">
            <div 
              class="progress-fill" 
              style="width: {updateStatus.downloadProgress.percent}%"
            ></div>
          </div>
          <div class="progress-footer">
            <span>{formatSpeed(updateStatus.downloadProgress.bytesPerSecond)}</span>
            <span>{formatFileSize(updateStatus.downloadProgress.transferred)} / {formatFileSize(updateStatus.downloadProgress.total)}</span>
          </div>
        </div>
      {:else if isDownloaded}
        <!-- Ready to Install -->
        <div class="ready-section">
          <div class="ready-content">
            <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span class="ready-text">Update downloaded and ready to install</span>
              </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }

  .modal-content {
    background: #1f2937;
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 8px;
    padding: 1.5rem;
    max-width: 28rem;
    width: 100%;
    margin: 1rem;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4);
  }

  .modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .header-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .update-icon {
    width: 2.5rem;
    height: 2.5rem;
    background: rgba(59, 130, 246, 0.2);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #3b82f6;
  }

  .header-text {
    flex: 1;
  }

  .modal-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: #e2e8f0;
    margin: 0 0 0.25rem 0;
  }

  .modal-subtitle {
    font-size: 0.875rem;
    color: #9ca3af;
    margin: 0;
  }

  .close-button {
    background: none;
    border: none;
    color: #6b7280;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 4px;
    transition: color 0.2s;
  }

  .close-button:hover {
    color: #e2e8f0;
  }

  .version-info {
    background: rgba(17, 24, 39, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.2);
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 1rem;
  }

  .version-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.875rem;
  }

  .version-row + .version-row {
    margin-top: 0.25rem;
  }

  .version-label {
    color: #9ca3af;
  }

  .version-current {
    font-weight: 500;
    color: #e2e8f0;
  }

  .version-new {
    font-weight: 500;
    color: #3b82f6;
  }

  .progress-section {
    margin-bottom: 1rem;
  }

  .progress-header {
    display: flex;
    justify-content: space-between;
    font-size: 0.875rem;
    margin-bottom: 0.5rem;
  }

  .progress-label {
    color: #9ca3af;
  }

  .progress-percent {
    color: #e2e8f0;
  }

  .progress-bar {
    width: 100%;
    background: rgba(75, 85, 99, 0.3);
    border-radius: 9999px;
    height: 0.5rem;
    overflow: hidden;
  }

  .progress-fill {
    background: #3b82f6;
    height: 100%;
    border-radius: 9999px;
    transition: width 0.3s ease;
  }

  .progress-footer {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: #6b7280;
    margin-top: 0.25rem;
  }

  .ready-section {
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.3);
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 1rem;
  }

  .ready-content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #10b981;
  }

  .ready-text {
    font-weight: 500;
  }

  .auto-install-section {
    margin-bottom: 1rem;
  }

  .auto-install-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    cursor: pointer;
  }

  .auto-install-checkbox {
    width: 1rem;
    height: 1rem;
    border-radius: 3px;
    border: 1px solid #6b7280;
    background: transparent;
    accent-color: #3b82f6;
  }

  .auto-install-text {
    font-size: 0.875rem;
    color: #d1d5db;
  }

  .action-buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .primary-button {
    flex: 1;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .primary-button:hover {
    background: #2563eb;
  }

  .install-button {
    flex: 1;
    background: #dc2626;
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .install-button:hover {
    background: #b91c1c;
  }

  .disabled-button {
    flex: 1;
    background: #6b7280;
    color: white;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    text-align: center;
    opacity: 0.7;
  }

  .secondary-button {
    background: transparent;
    color: #9ca3af;
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .secondary-button:hover {
    color: #e2e8f0;
    border-color: rgba(75, 85, 99, 0.5);
    background: rgba(75, 85, 99, 0.1);
  }

  .tertiary-button {
    background: transparent;
    color: #6b7280;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.2s;
    white-space: nowrap;
  }

  .tertiary-button:hover {
    color: #9ca3af;
  }

  @media (max-width: 640px) {
    .action-buttons {
      flex-direction: column;
    }
    
    .secondary-button,
    .tertiary-button {
      text-align: center;
    }
  }
</style>

      <!-- Auto-install Option -->
      <div class="auto-install-section">
        <label class="auto-install-label">
          <input 
            type="checkbox" 
            bind:checked={updateStatus.autoInstallEnabled}
            on:change={toggleAutoInstall}
            class="auto-install-checkbox"
          >
          <span class="auto-install-text">Automatically install updates when downloaded</span>
        </label>
      </div>

      <!-- Action Buttons -->
      <div class="action-buttons">
        {#if isDownloaded}
          <button 
            on:click={installUpdate}
            class="install-button"
          >
            Install & Restart
          </button>
        {:else if isDownloading}
          <div class="disabled-button">
            Downloading...
          </div>
        {:else}
          <button 
            on:click={downloadUpdate}
            class="primary-button"
          >
            Download Update
          </button>
        {/if}
        
        <button 
          on:click={remindLater}
          class="secondary-button"
        >
          Remind Later
        </button>
        
        <button 
          on:click={ignoreUpdate}
          class="tertiary-button"
        >
          Ignore
        </button>
      </div>
    </div>
  </div>
{/if} 