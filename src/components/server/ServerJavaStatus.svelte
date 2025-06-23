<script>
  import { onMount, onDestroy } from 'svelte';
  import { checkServerJavaRequirements, ensureServerJava, getAvailableServerJavaVersions, onServerJavaDownloadProgress } from '../../utils/serverJava.js';
  import { serverState } from '../../stores/serverState.js';
  
  export let minecraftVersion = '';
  
  let javaStatus = {
    loading: true,
    requiredJavaVersion: null,
    isAvailable: false,
    needsDownload: false,
    javaPath: null,
    error: null
  };
  
  let availableVersions = [];
  let isDownloading = false;
  let downloadProgress = null;
  let downloadCleanup = null;
  
  // Check Java status when component mounts or version changes
  $: if (minecraftVersion) {
    checkJavaStatus();
  }
  
  onMount(() => {
    loadAvailableVersions();
    
    // Listen for Java download progress
    downloadCleanup = onServerJavaDownloadProgress((progress) => {
      if (progress.minecraftVersion === minecraftVersion) {
        downloadProgress = progress;
        isDownloading = progress.type !== 'Complete';
        
        if (progress.type === 'Complete') {
          // Refresh status after download completes
          setTimeout(checkJavaStatus, 1000);
        }
      }
    });
  });
  
  onDestroy(() => {
    if (downloadCleanup) {
      downloadCleanup();
    }
  });
  
  async function checkJavaStatus() {
    if (!minecraftVersion || minecraftVersion === 'unknown') return;
    
    javaStatus.loading = true;
    
    try {
      const result = await checkServerJavaRequirements(minecraftVersion);
      
      if (result.success !== false) {
        javaStatus = {
          loading: false,
          requiredJavaVersion: result.requiredJavaVersion,
          isAvailable: result.isAvailable,
          needsDownload: result.needsDownload,
          javaPath: result.javaPath,
          error: null
        };
      } else {
        javaStatus = {
          loading: false,
          error: result.error || 'Failed to check Java requirements'
        };
      }
    } catch (error) {
      javaStatus = {
        loading: false,
        error: error.message
      };
    }
  }
  
  async function loadAvailableVersions() {
    try {
      const result = await getAvailableServerJavaVersions();
      if (result.success) {
        availableVersions = result.versions;
      }
    } catch (error) {
      console.error('Error loading available Java versions:', error);
    }
  }
  
  async function downloadJava() {
    if (!minecraftVersion || isDownloading) return;
    
    isDownloading = true;
    downloadProgress = { type: 'Preparing', task: 'Preparing to download Java...', progress: 0 };
    
    try {
      const result = await ensureServerJava(minecraftVersion);
      
      if (result.success) {
        await checkJavaStatus();
        await loadAvailableVersions();
      } else {
        alert(`Failed to download Java: ${result.error}`);
      }
    } catch (error) {
      alert(`Error downloading Java: ${error.message}`);
    } finally {
      isDownloading = false;
      downloadProgress = null;
    }
  }
  
  function getStatusColor() {
    if (javaStatus.loading) return '#6B7280';
    if (javaStatus.error) return '#EF4444';
    if (javaStatus.isAvailable) return '#10B981';
    return '#F59E0B';
  }
  
  function getStatusText() {
    if (javaStatus.loading) return 'Checking Java...';
    if (javaStatus.error) return `Error: ${javaStatus.error}`;
    if (javaStatus.isAvailable) return `Java ${javaStatus.requiredJavaVersion} Ready`;
    if (javaStatus.needsDownload) return `Java ${javaStatus.requiredJavaVersion} Required`;
    return 'Java Status Unknown';
  }
</script>

<div class="java-status-container">
  <div class="status-header">
    <div class="status-indicator" style="background-color: {getStatusColor()}"></div>
    <h3>Server Java Status</h3>
  </div>
  
  <div class="status-content">
    <div class="status-info">
      <span class="status-text">{getStatusText()}</span>
      
      {#if minecraftVersion && minecraftVersion !== 'unknown'}
        <div class="version-info">
          <small>Minecraft {minecraftVersion}</small>
          {#if javaStatus.requiredJavaVersion}
            <small>Requires Java {javaStatus.requiredJavaVersion}</small>
          {/if}
        </div>
      {:else}
        <div class="version-info">
          <small class="warning">Minecraft version not detected</small>
        </div>
      {/if}
    </div>
    
    {#if isDownloading && downloadProgress}
      <div class="download-progress">
        <div class="progress-text">
          {downloadProgress.task}
          {#if downloadProgress.progress}
            <span class="progress-percent">({downloadProgress.progress}%)</span>
          {/if}
        </div>
        {#if downloadProgress.progress}
          <div class="progress-bar">
            <div class="progress-fill" style="width: {downloadProgress.progress}%"></div>
          </div>
        {/if}
      </div>
    {:else if javaStatus.needsDownload && !javaStatus.loading}
      <button class="download-button" on:click={downloadJava} disabled={isDownloading}>
        📥 Download Java {javaStatus.requiredJavaVersion}
      </button>
    {/if}
    
    {#if javaStatus.javaPath}
      <div class="java-path">
        <small>Java Path: {javaStatus.javaPath}</small>
      </div>
    {/if}
    
    {#if availableVersions.length > 0}
      <div class="available-versions">
        <small>Available: Java {availableVersions.join(', ')}</small>
      </div>
    {/if}
  </div>
</div>

<style>
  .java-status-container {
    background: #f8f9fa;
    border: 1px solid #e9ecef;
    border-radius: 8px;
    padding: 16px;
    margin: 12px 0;
  }
  
  .status-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  
  .status-indicator {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }
  
  .status-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #212529;
  }
  
  .status-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  
  .status-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  
  .status-text {
    font-weight: 500;
    color: #495057;
  }
  
  .version-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  
  .version-info small {
    color: #6c757d;
    font-size: 12px;
  }
  
  .version-info small.warning {
    color: #dc3545;
  }
  
  .download-progress {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  
  .progress-text {
    font-size: 14px;
    color: #495057;
  }
  
  .progress-percent {
    font-weight: 500;
    color: #007bff;
  }
  
  .progress-bar {
    width: 100%;
    height: 6px;
    background-color: #e9ecef;
    border-radius: 3px;
    overflow: hidden;
  }
  
  .progress-fill {
    height: 100%;
    background-color: #007bff;
    transition: width 0.3s ease;
  }
  
  .download-button {
    align-self: flex-start;
    background: #007bff;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    transition: background-color 0.2s;
  }
  
  .download-button:hover:not(:disabled) {
    background: #0056b3;
  }
  
  .download-button:disabled {
    background: #6c757d;
    cursor: not-allowed;
  }
  
  .java-path, .available-versions {
    margin-top: 4px;
  }
  
  .java-path small, .available-versions small {
    color: #6c757d;
    font-size: 11px;
    word-break: break-all;
  }
</style> 