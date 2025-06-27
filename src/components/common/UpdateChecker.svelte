<script>
  import { onMount } from 'svelte';
  import { toast } from 'svelte-sonner';
  
  let currentVersion = '1.0.0';
  let isChecking = false;
  let lastChecked = null;
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
        } else if (result.updateAvailable) {
          toast.success('Update Available!', {
            description: `Version ${result.latestVersion} is available for download`,
            duration: 8000
          });
        } else {
          toast.info('No Updates Available', {
            description: 'You are running the latest version',
            duration: 5000
          });
        }
        
        updateStatus = {
          updateAvailable: result.updateAvailable || false,
          latestVersion: result.latestVersion,
          isCheckingForUpdates: false,
          developmentMode: result.developmentMode || false
        };
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      toast.error('Update Check Failed', {
        description: error.message || 'Failed to check for updates',
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

  // Test update notification (development only)
  function testUpdateNotification() {
    toast.info('Development Mode Test', {
      description: 'In development mode, update notifications are disabled. Configure your GitHub repository to enable real update checking.',
      duration: 5000
    });
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
    });
    
    window.electron.on('update-not-available', () => {
      updateStatus.updateAvailable = false;
      updateStatus.isCheckingForUpdates = false;
      updateStatus = { ...updateStatus };
    });
  });
</script>

<div class="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
  <div class="flex items-center justify-between mb-4">
    <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Application Updates</h3>
    <div class="flex items-center space-x-2">
      {#if updateStatus.updateAvailable}
        <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
          <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Update Available
        </span>
      {:else}
        <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
          <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          Up to Date
        </span>
      {/if}
    </div>
  </div>

  <!-- Version Information -->
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
    <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
      <div class="text-sm text-gray-600 dark:text-gray-400 mb-1">Current Version</div>
      <div class="text-lg font-semibold text-gray-900 dark:text-white">{currentVersion}</div>
    </div>
    
    <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
      <div class="text-sm text-gray-600 dark:text-gray-400 mb-1">Latest Version</div>
      <div class="text-lg font-semibold text-gray-900 dark:text-white">
        {updateStatus.latestVersion || currentVersion}
        {#if updateStatus.latestVersion && updateStatus.latestVersion !== currentVersion}
          <span class="text-sm text-blue-600 dark:text-blue-400 ml-2">(New!)</span>
        {/if}
      </div>
    </div>
  </div>

  <!-- Check Status -->
  <div class="mb-4">
    <div class="text-sm text-gray-600 dark:text-gray-400">
      Last checked: {formatLastChecked(lastChecked)}
    </div>
    {#if updateStatus.isCheckingForUpdates}
      <div class="text-sm text-blue-600 dark:text-blue-400 mt-1">
        <svg class="w-4 h-4 inline mr-1 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        Checking for updates...
      </div>
    {/if}
  </div>

  <!-- Action Button -->
  <button 
    on:click={checkForUpdates}
    disabled={isChecking || updateStatus.isCheckingForUpdates}
    class="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center space-x-2"
  >
    {#if isChecking || updateStatus.isCheckingForUpdates}
      <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      <span>Checking for Updates...</span>
    {:else}
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      <span>{updateStatus.developmentMode ? 'Test Update Check' : 'Check for Updates'}</span>
    {/if}
  </button>

  <!-- Development Test Button -->
  {#if updateStatus.developmentMode}
    <button 
      on:click={testUpdateNotification}
      class="w-full mt-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg font-medium transition-colors flex items-center justify-center space-x-2"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4V2a1 1 0 011-1h4a1 1 0 011 1v2m-6 0h8m-8 0v1a3 3 0 003 3h2a3 3 0 003-3V4m-8 16V8m8 8V8" />
      </svg>
      <span>Test Update UI</span>
    </button>
  {/if}

  <!-- Update Note -->
  {#if updateStatus.developmentMode}
    <div class="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
      <div class="flex items-start space-x-2">
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
        <div class="text-sm">
          <div class="font-medium text-blue-800 dark:text-blue-300 mb-1">Development Mode</div>
          <div class="text-blue-700 dark:text-blue-400">
            Update checking is disabled in development mode. Configure your GitHub repository in package.json to enable automatic updates.
          </div>
        </div>
      </div>
    </div>
  {:else}
    <div class="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
      <div class="flex items-start space-x-2">
        <svg class="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div class="text-sm">
          <div class="font-medium text-yellow-800 dark:text-yellow-300 mb-1">Automatic Updates</div>
          <div class="text-yellow-700 dark:text-yellow-400">
            The app automatically checks for updates every 12 hours. 
            Updates include bug fixes, new features, and security improvements.
          </div>
        </div>
      </div>
    </div>
  {/if}
</div> 