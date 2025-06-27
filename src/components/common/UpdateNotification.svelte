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

  // Handle update available
  function handleUpdateAvailable(info) {
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

  // Handle update downloaded
  function handleUpdateDownloaded(info) {
    isDownloading = false;
    isDownloaded = true;
    
    toast.success('Update Downloaded', {
      description: `Version ${info.version} is ready to install`,
      duration: 10000,
      action: {
        label: 'Install Now',
        onClick: installUpdate
      }
    });
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
    try {
      isDownloading = true;
      const result = await window.electron.invoke('download-update');
      
      if (!result.success) {
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

  // Install update
  async function installUpdate() {
    try {
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
      console.error('Failed to get update status:', error);
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
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" 
    role="dialog" 
    aria-modal="true" 
    tabindex="-1"
    on:click|self={() => showNotification = false}
    on:keydown={(e) => e.key === 'Escape' && (showNotification = false)}
  >
    <div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
      <div class="flex items-start justify-between mb-4">
        <div class="flex items-center space-x-3">
          <div class="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
            <svg class="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </div>
          <div>
            <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Update Available</h3>
            <p class="text-sm text-gray-600 dark:text-gray-400">
              Version {updateInfo.version} is ready to download
            </p>
          </div>
        </div>
        <button 
          on:click={() => showNotification = false}
          class="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          aria-label="Close update notification"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Current vs New Version -->
      <div class="mb-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
        <div class="flex justify-between text-sm">
          <span class="text-gray-600 dark:text-gray-400">Current:</span>
          <span class="font-medium text-gray-900 dark:text-white">{updateStatus.currentVersion}</span>
        </div>
        <div class="flex justify-between text-sm mt-1">
          <span class="text-gray-600 dark:text-gray-400">Latest:</span>
          <span class="font-medium text-blue-600 dark:text-blue-400">{updateInfo.version}</span>
        </div>
      </div>

      {#if isDownloading}
        <!-- Download Progress -->
        <div class="mb-4">
          <div class="flex justify-between text-sm mb-2">
            <span class="text-gray-600 dark:text-gray-400">Downloading...</span>
            <span class="text-gray-900 dark:text-white">{updateStatus.downloadProgress.percent}%</span>
          </div>
          <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div 
              class="bg-blue-600 h-2 rounded-full transition-all duration-300" 
              style="width: {updateStatus.downloadProgress.percent}%"
            ></div>
          </div>
          <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
            <span>{formatSpeed(updateStatus.downloadProgress.bytesPerSecond)}</span>
            <span>{formatFileSize(updateStatus.downloadProgress.transferred)} / {formatFileSize(updateStatus.downloadProgress.total)}</span>
          </div>
        </div>
      {:else if isDownloaded}
        <!-- Ready to Install -->
        <div class="mb-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
          <div class="flex items-center space-x-2">
            <svg class="w-5 h-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            <span class="text-green-800 dark:text-green-300 font-medium">Update downloaded and ready to install</span>
          </div>
        </div>
      {/if}

      <!-- Auto-install Option -->
      <div class="mb-4">
        <label class="flex items-center space-x-3 cursor-pointer">
          <input 
            type="checkbox" 
            bind:checked={updateStatus.autoInstallEnabled}
            on:change={toggleAutoInstall}
            class="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          >
          <span class="text-sm text-gray-700 dark:text-gray-300">Automatically install updates when downloaded</span>
        </label>
      </div>

      <!-- Action Buttons -->
      <div class="flex space-x-3">
        {#if isDownloaded}
          <button 
            on:click={installUpdate}
            class="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            Install & Restart
          </button>
        {:else if isDownloading}
          <div class="flex-1 bg-gray-400 text-white px-4 py-2 rounded-lg font-medium text-center">
            Downloading...
          </div>
        {:else}
          <button 
            on:click={downloadUpdate}
            class="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
          >
            Download Update
          </button>
        {/if}
        
        <button 
          on:click={remindLater}
          class="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 font-medium transition-colors"
        >
          Remind Later
        </button>
        
        <button 
          on:click={ignoreUpdate}
          class="px-4 py-2 text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 font-medium transition-colors"
        >
          Ignore
        </button>
      </div>
    </div>
  </div>
{/if} 