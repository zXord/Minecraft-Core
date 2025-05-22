<!-- @ts-ignore -->
<script>
  import { downloads, showDownloads } from '../../../stores/modStore.js';
  
  // Format file size
  function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
  
  // Format speed
  function formatSpeed(bytesPerSecond) {
    return formatBytes(bytesPerSecond) + '/s';
  }
  
  // Computes download state
  $: activeDownloads = Object.values($downloads).filter(d => !d.completed && !d.error);
  $: completedDownloads = Object.values($downloads).filter(d => d.completed);
  $: errorDownloads = Object.values($downloads).filter(d => d.error);
  
  // Toggle expanded state
  let expanded = true;
  
  function toggleExpanded() {
    expanded = !expanded;
  }
  
  function closeDownloads() {
    $showDownloads = false;
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
              <span class="download-count completed" title="Completed downloads">
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
          <span class="toggle-icon" title={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? '▼' : '▲'}
          </span>
        </div>
      </button>
      
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
            class="download-item" 
            class:completed={download.completed} 
            class:error={download.error}
          >
            <div class="download-info">
              <div class="download-name">{download.name}</div>
              
              {#if download.error}
                <div class="download-error">Error: {download.error}</div>
              {:else if download.completed}
                <div class="download-status">Complete</div>
              {:else}
                <div class="download-details">
                  {#if typeof download.size === 'number' && !isNaN(download.size) && download.size > 0}
                    {formatBytes(download.progress * download.size / 100)} of {formatBytes(download.size)}
                  {:else}
                    {(download.progress || 0).toFixed(0)}% complete
                  {/if}
                  {#if download.speed && !isNaN(download.speed)}
                    ({formatSpeed(download.speed)})
                  {/if}
                </div>
              {/if}
            </div>
            
            {#if !download.completed && !download.error}
              <div class="progress-bar-container">
                <div 
                  class="progress-bar" 
                  style="width: {download.progress}%"
                  role="progressbar"
                  aria-valuenow={download.progress}
                  aria-valuemin="0"
                  aria-valuemax="100"
                >
                </div>
                <div class="progress-text">{download.progress.toFixed(0)}%</div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

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
  
  .toggle-icon, .close-button {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
    transition: color 0.2s;
  }
  
  .toggle-icon:hover, .close-button:hover {
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
    padding: 8px 10px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.05);
    margin-bottom: 8px;
  }
  
  .download-item.completed {
    background: rgba(76, 175, 80, 0.1);
    border-left: 3px solid #4caf50;
  }
  
  .download-item.error {
    background: rgba(244, 67, 54, 0.1);
    border-left: 3px solid #f44336;
  }
  
  .download-name {
    font-weight: 500;
    font-size: 13px;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .download-details {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 6px;
  }
  
  .download-status {
    font-size: 11px;
    color: #4caf50;
  }
  
  .download-error {
    font-size: 11px;
    color: #f44336;
  }
  
  .progress-bar-container {
    height: 6px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 3px;
    overflow: hidden;
    position: relative;
    margin-top: 6px;
  }
  
  .progress-bar {
    height: 100%;
    background: linear-gradient(to right, #2196f3, #03a9f4);
    border-radius: 3px;
    transition: width 0.3s ease;
  }
  
  .progress-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 9px;
    color: white;
    text-shadow: 0 0 2px rgba(0, 0, 0, 0.7);
  }
</style> 