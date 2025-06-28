<script>
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  
  let currentVersion = '1.0.0';
  let isChecking = false;
  let isDownloading = false;
  let isDownloaded = false;
  let lastChecked = null;
  let downloadProgress = { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0 };
 // Prevent duplicate notifications
  let updateStatus = {
    updateAvailable: false,
    latestVersion: null,
    isCheckingForUpdates: false,
    developmentMode: false
  };

  // Check for updates manually
  async function checkForUpdates() {
    if (isChecking) return;
    
    try {
      isChecking = true;
      
      // Immediately update UI state to show checking
      updateStatus = {
        ...updateStatus,
        isCheckingForUpdates: true
      };
      
      // Safety timeout to clear checking state after 10 seconds
      const timeoutId = setTimeout(() => {
        updateStatus = {
          ...updateStatus,
          isCheckingForUpdates: false
        };
        isChecking = false;
      }, 10000);
      
      const result = await window.electron.invoke('check-for-updates');
      
      // Clear the timeout since we got a result
      clearTimeout(timeoutId);
      
      if (result.success) {
        lastChecked = new Date();
        
        if (result.developmentMode) {
          toast.info('Development Mode', {
            description: 'Update checking is disabled in development mode',
            duration: 5000
          });
        } else if (!result.updateAvailable) {
          toast.info('No Updates Available', {
            description: 'You are running the latest version',
            duration: 5000
          });
        }
        // Note: Update available notifications are handled by UpdateNotification.svelte to avoid duplicates
        
        updateStatus = {
          updateAvailable: result.updateAvailable || false,
          latestVersion: result.latestVersion,
          isCheckingForUpdates: false,
          developmentMode: result.developmentMode || false
        };
      } else {
        // Handle errors with friendly messages
        let errorTitle = 'Update Check Failed';
        let errorDescription = result.error || 'Failed to check for updates';
        
        // Use detailed error information if available
        if (result.errorDetails) {
          errorTitle = result.errorDetails.title;
          errorDescription = result.errorDetails.message;
          
          // Add details if available
          if (result.errorDetails.details) {
            errorDescription += ` ${result.errorDetails.details}`;
          }
        }
        
        toast.error(errorTitle, {
          description: errorDescription,
          duration: 8000
        });
        
        // Clear checking state
        updateStatus = {
          ...updateStatus,
          isCheckingForUpdates: false
        };
      }
    } catch (error) {
      // Handle unexpected errors (network issues, etc.)
      toast.error('Connection Error', {
        description: 'Unable to connect to update server. Please check your internet connection and try again.',
        duration: 8000
      });
      
      // Make sure to clear checking state on error
      updateStatus = {
        ...updateStatus,
        isCheckingForUpdates: false
      };
    } finally {
      isChecking = false;
    }
  }

  // Get current version and status
  async function loadInitialData() {
    try {
      // Get current version
      const versionResult = await window.electron.invoke('get-current-version');
      if (versionResult.success) {
        currentVersion = versionResult.version;
      }
      
      // Get current update status
      const statusResult = await window.electron.invoke('get-update-status');
      if (statusResult.success) {
        updateStatus = {
          updateAvailable: statusResult.updateAvailable,
          latestVersion: statusResult.latestVersion,
          isCheckingForUpdates: statusResult.isCheckingForUpdates,
          developmentMode: statusResult.developmentMode || false
        };
      }
    } catch (error) {
      console.error('Failed to load initial update data:', error);
    }
  }

  // Format date for display
  function formatLastChecked(date) {
    if (!date) return 'Never';
    
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    
    return date.toLocaleDateString();
  }

  // Format bytes per second to readable speed
  function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond === 0) return '0 B/s';
    
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(1024));
    const size = (bytesPerSecond / Math.pow(1024, i)).toFixed(1);
    
    return `${size} ${units[i]}`;
  }

  // Test update notification (development only)
  function testUpdateNotification() {
    toast.info('Development Mode Test', {
      description: 'In development mode, update notifications are disabled. Configure your GitHub repository to enable real update checking.',
      duration: 5000
    });
  }

  // Download update
  async function downloadUpdate() {
    try {
      isDownloading = true;
      const result = await window.electron.invoke('download-update');
      
      if (result.success) {
        toast.success('Download Started', {
          description: 'Update download started. You will be notified when it completes.',
          duration: 5000
        });
      } else {
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

  onMount(() => {
    loadInitialData();
    
    // Listen for update status changes
    window.electron.on('update-checking-for-update', () => {
      updateStatus.isCheckingForUpdates = true;
      updateStatus = { ...updateStatus };
    });
    
    window.electron.on('update-available', (info) => {
      updateStatus.updateAvailable = true;
      updateStatus.latestVersion = info.version;
      updateStatus.isCheckingForUpdates = false;
      updateStatus = { ...updateStatus };
      isDownloaded = false; // Reset download state for new update
    });
    
    window.electron.on('update-not-available', () => {
      updateStatus.updateAvailable = false;
      updateStatus.isCheckingForUpdates = false;
      updateStatus = { ...updateStatus };
    });
    
    // Listen for download progress
    window.electron.on('update-download-progress', (progress) => {
      downloadProgress = progress;
      isDownloading = true;
    });
    
    // Listen for download completion
    window.electron.on('update-downloaded', () => {
      isDownloading = false;
      isDownloaded = true;
      
      // Don't show notification here since UpdateNotification component handles it
    });
    
    // Handle update errors with friendly messages
    window.electron.on('update-error', (errorData) => {
      updateStatus.isCheckingForUpdates = false;
      updateStatus = { ...updateStatus };
      
      // Show friendly error message
      if (errorData && errorData.title) {
        let description = errorData.message;
        if (errorData.details) {
          description += ` ${errorData.details}`;
        }
        
        toast.error(errorData.title, {
          description: description,
          duration: 8000
        });
      } else {
        // Fallback for old-style errors
        toast.error('Update Check Failed', {
          description: 'An unexpected error occurred while checking for updates',
          duration: 8000
        });
      }
    });
  });
</script>

<!-- App Updates Section Header -->
<h4>
  <span class="section-icon">🔄</span>
  App Updates
</h4>

<!-- Status -->
<div class="update-status-row">
  <div class="update-status-badge {updateStatus.updateAvailable ? 'available' : 'up-to-date'}">
    {#if updateStatus.updateAvailable}
      📦 Update Available
    {:else}
      ✅ Up to Date
    {/if}
  </div>
</div>

<!-- Version Info -->
<div class="version-grid">
  <div class="version-item">
    <div class="version-label">Current Version</div>
    <div class="version-value">{currentVersion}</div>
  </div>
  <div class="version-item">
    <div class="version-label">Latest Version</div>
    <div class="version-value">
      {updateStatus.latestVersion || currentVersion}
      {#if updateStatus.latestVersion && updateStatus.latestVersion !== currentVersion}
        <span class="new-badge">New!</span>
      {/if}
    </div>
  </div>
</div>

<!-- Last Checked -->
<div class="last-checked">
  Last checked: {formatLastChecked(lastChecked)}
  {#if updateStatus.isCheckingForUpdates}
    <span class="checking-indicator">
      🔄 Checking...
    </span>
  {/if}
</div>

<!-- Action Buttons -->
<div class="action-buttons">
  {#if updateStatus.updateAvailable && !updateStatus.developmentMode}
    <!-- Update Available Actions -->
    {#if isDownloaded}
      <button 
        on:click={installUpdate}
        class="install-button"
      >
        🚀 Install & Restart
      </button>
    {:else if isDownloading}
      <div class="downloading-status">
        <div class="download-progress">
          <span class="download-text">📥 Downloading... {downloadProgress.percent}%</span>
          <div class="progress-bar">
            <div class="progress-fill" style="width: {downloadProgress.percent}%"></div>
          </div>
          <span class="download-speed">{formatSpeed(downloadProgress.bytesPerSecond)}</span>
        </div>
      </div>
    {:else}
      <button 
        on:click={downloadUpdate}
        class="download-button"
      >
        📥 Download Update
      </button>
    {/if}
  {:else}
    <!-- Regular Check Button -->
    <button 
      on:click={checkForUpdates}
      disabled={isChecking || updateStatus.isCheckingForUpdates}
      class="update-button"
    >
      {#if isChecking || updateStatus.isCheckingForUpdates}
        🔄 Checking...
      {:else}
        {updateStatus.developmentMode ? '🧪 Test Update Check' : '🔄 Check for Updates'}
      {/if}
    </button>
    
    {#if updateStatus.developmentMode}
      <button 
        on:click={testUpdateNotification}
        class="test-button"
      >
        📋 Test Update UI
      </button>
    {/if}
  {/if}
</div>

<!-- Note -->
{#if updateStatus.developmentMode}
  <div class="dev-note">
    <div class="note-header">💡 Development Mode</div>
    <div class="note-text">
      Update checking is disabled in development mode. Configure your GitHub repository in package.json to enable automatic updates.
    </div>
  </div>
{:else}
  <div class="info-note">
    <div class="note-header">ℹ️ Automatic Updates</div>
    <div class="note-text">
      The app automatically checks for updates every 12 hours. Updates include bug fixes, new features, and security improvements.
    </div>
  </div>
{/if}

<style>
  h4 {
    margin: 0 0 1rem 0;
    color: #3b82f6;
    font-size: 1.1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(59, 130, 246, 0.2);
  }
  
  .section-icon {
    font-size: 1rem;
  }

  .update-status-row {
    margin-bottom: 1rem;
    display: flex;
    justify-content: flex-start;
  }

  .update-status-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 12px;
    font-size: 0.8rem;
    font-weight: 600;
    border: 1px solid transparent;
  }

  .update-status-badge.up-to-date {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
    border-color: rgba(16, 185, 129, 0.3);
  }

  .update-status-badge.available {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.3);
  }

  .version-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .version-item {
    background: rgba(17, 24, 39, 0.4);
    border: 1px solid rgba(75, 85, 99, 0.2);
    border-radius: 4px;
    padding: 0.5rem;
  }

  .version-label {
    font-size: 0.75rem;
    color: #9ca3af;
    margin-bottom: 0.25rem;
  }

  .version-value {
    font-size: 0.85rem;
    color: #e2e8f0;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .new-badge {
    background: rgba(59, 130, 246, 0.2);
    color: #3b82f6;
    padding: 0.125rem 0.375rem;
    border-radius: 8px;
    font-size: 0.7rem;
    font-weight: 500;
  }

  .last-checked {
    font-size: 0.8rem;
    color: #9ca3af;
    margin-bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .checking-indicator {
    color: #3b82f6;
    font-size: 0.75rem;
  }

  .action-buttons {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .update-button, .test-button, .download-button, .install-button {
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .update-button:hover:not(:disabled) {
    background: #2563eb;
  }

  .update-button:disabled {
    background: #6b7280;
    cursor: not-allowed;
    opacity: 0.7;
  }

  .test-button {
    background: #7c3aed;
  }

  .test-button:hover {
    background: #6d28d9;
  }

  .download-button {
    background: #059669;
  }

  .download-button:hover {
    background: #047857;
  }

  .install-button {
    background: #7c3aed;
  }

  .install-button:hover {
    background: #6d28d9;
  }

  .downloading-status {
    width: 100%;
  }

  .download-progress {
    padding: 0.5rem;
    background: rgba(17, 24, 39, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
  }

  .download-text {
    font-size: 0.8rem;
    color: #e2e8f0;
    margin-bottom: 0.5rem;
    display: block;
  }

  .download-speed {
    font-size: 0.75rem;
    color: #9ca3af;
    margin-top: 0.25rem;
    display: block;
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

  .dev-note, .info-note {
    background: rgba(17, 24, 39, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    padding: 0.75rem;
  }

  .dev-note {
    border-color: rgba(59, 130, 246, 0.3);
  }

  .info-note {
    border-color: rgba(245, 158, 11, 0.3);
  }

  .note-header {
    font-size: 0.8rem;
    font-weight: 600;
    color: #e2e8f0;
    margin-bottom: 0.25rem;
  }

  .note-text {
    font-size: 0.75rem;
    color: #9ca3af;
    line-height: 1.4;
  }

  @media (max-width: 600px) {
    .version-grid {
      grid-template-columns: 1fr;
    }
  }
</style> 