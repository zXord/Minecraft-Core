<!-- @ts-ignore -->
<script>
  import { createEventDispatcher } from 'svelte';
  import { DOWNLOAD_SOURCES } from '../../../stores/modStore.js';
  import logger from '../../../utils/logger.js';
  
  /** @type {boolean} */
  export let isOpen = false;
  /** @type {any} */
  export let error = null;
  /** @type {any} */
  export let download = null;
  
  const dispatch = createEventDispatcher();
  
  function closeModal() {
    isOpen = false;
    dispatch('close');
  }
  
  /**
   * @param {any} error
   * @returns {string}
   */
  function getErrorTitle(error) {
    if (!error) return 'Download Error';
    
    switch (error.type) {
      case 'checksum':
        return 'File Integrity Error';
      case 'network':
        return 'Network Error';
      case 'timeout':
        return 'Download Timeout';
      case 'server':
        return 'Server Error';
      default:
        return 'Download Error';
    }
  }
  
  /**
   * @param {any} error
   * @param {any} download
   * @returns {string}
   */
  function getErrorDescription(error, download) {
    if (!error) return 'An unknown error occurred during download.';
    
    switch (error.type) {
      case 'checksum':
        return `The downloaded file for "${download?.name || 'unknown mod'}" failed integrity verification. This usually means the file was corrupted during download or the server has an outdated version.`;
      case 'network':
        return `Network connection failed while downloading "${download?.name || 'unknown mod'}". This could be due to internet connectivity issues or server unavailability.`;
      case 'timeout':
        return `The download of "${download?.name || 'unknown mod'}" timed out. This usually happens with slow connections or server overload.`;
      case 'server':
        return `The server encountered an error while processing the download of "${download?.name || 'unknown mod'}". This is typically a temporary server-side issue.`;
      default:
        return `An unexpected error occurred while downloading "${download?.name || 'unknown mod'}": ${error.message || 'Unknown error'}`;
    }
  }
  
  /**
   * @param {any} error
   * @param {any} download
   * @returns {string[]}
   */
  function getActionableSuggestions(error, download) {
    if (!error) return [];
    
    const suggestions = [];
    
    switch (error.type) {
      case 'checksum':
        suggestions.push('Try downloading the mod again - the file may have been corrupted during transfer');
        suggestions.push('Check if the server has the latest version of the mod');
        suggestions.push('If the problem persists, contact the server administrator');
        if (download?.source === DOWNLOAD_SOURCES.SERVER) {
          suggestions.push('The system will automatically try alternative sources after 15 minutes');
        }
        break;
      case 'network':
        suggestions.push('Check your internet connection');
        suggestions.push('Try again in a few minutes');
        suggestions.push('If using a VPN, try disconnecting it temporarily');
        suggestions.push('Check if your firewall is blocking the connection');
        break;
      case 'timeout':
        suggestions.push('Try downloading again - the server may be less busy now');
        suggestions.push('Check your internet connection speed');
        suggestions.push('If the problem persists, the server may be overloaded');
        break;
      case 'server':
        suggestions.push('Try again in a few minutes - this is usually temporary');
        suggestions.push('Check the server status with the administrator');
        suggestions.push('If the error persists, report it to the server administrator');
        break;
      default:
        suggestions.push('Try downloading the mod again');
        suggestions.push('Check your internet connection');
        suggestions.push('Contact support if the problem persists');
    }
    
    return suggestions;
  }
  
  /**
   * @param {any} source
   * @returns {string}
   */
  function getSourceDisplayName(source) {
    switch (source) {
      case DOWNLOAD_SOURCES.SERVER:
        return 'Server';
      case DOWNLOAD_SOURCES.MODRINTH:
        return 'Modrinth';
      case DOWNLOAD_SOURCES.CURSEFORGE:
        return 'CurseForge';
      default:
        return 'Unknown';
    }
  }
  
  function copyErrorDetails() {
    if (!error || !download) return;
    
    const errorDetails = {
      mod: download.name,
      source: getSourceDisplayName(download.source),
      attempt: download.attempt,
      errorType: error.type,
      errorMessage: error.message,
      timestamp: new Date(error.timestamp).toISOString(),
      details: error.details
    };
    
    const errorText = JSON.stringify(errorDetails, null, 2);
    
    navigator.clipboard.writeText(errorText).then(() => {
      logger.info('Error details copied to clipboard', {
        category: 'ui',
        data: { downloadId: download.id }
      });
    }).catch(err => {
      logger.error('Failed to copy error details', {
        category: 'ui',
        data: { error: err.message }
      });
    });
  }
  
  function retryDownload() {
    if (download) {
      dispatch('retry', { downloadId: download.id });
      closeModal();
    }
  }
  
  function reportError() {
    if (error && download) {
      logger.info('User reported download error', {
        category: 'mods',
        data: {
          downloadId: download.id,
          errorType: error.type,
          userReported: true
        }
      });
      
      // TODO: Implement error reporting to server
      dispatch('report', { error, download });
      closeModal();
    }
  }
</script>

{#if isOpen && error && download}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
  <div class="modal-overlay" on:click={closeModal} role="dialog" aria-modal="true" tabindex="-1">
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
    <div class="modal-content" on:click|stopPropagation role="document">
      <div class="modal-header">
        <h2 class="modal-title">{getErrorTitle(error)}</h2>
        <button class="close-button" on:click={closeModal} aria-label="Close modal">✕</button>
      </div>
      
      <div class="modal-body">
        <div class="error-info">
          <div class="error-icon">⚠️</div>
          <div class="error-details">
            <h3>What happened?</h3>
            <p class="error-description">{getErrorDescription(error, download)}</p>
            
            <div class="technical-details">
              <h4>Technical Details</h4>
              <div class="detail-row">
                <span class="detail-label">Mod:</span>
                <span class="detail-value">{download.name}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Source:</span>
                <span class="detail-value">{getSourceDisplayName(download.source)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Attempt:</span>
                <span class="detail-value">{download.attempt} of {download.maxAttempts}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Error Type:</span>
                <span class="detail-value">{error.type}</span>
              </div>
              {#if error.details?.httpStatus}
                <div class="detail-row">
                  <span class="detail-label">HTTP Status:</span>
                  <span class="detail-value">{error.details.httpStatus}</span>
                </div>
              {/if}
              {#if error.details?.checksumMismatch}
                <div class="detail-row">
                  <span class="detail-label">Expected Checksum:</span>
                  <span class="detail-value checksum">{error.details.checksumMismatch.expected}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Actual Checksum:</span>
                  <span class="detail-value checksum">{error.details.checksumMismatch.actual}</span>
                </div>
              {/if}
            </div>
          </div>
        </div>
        
        <div class="suggestions">
          <h3>What can you do?</h3>
          <ul class="suggestion-list">
            {#each getActionableSuggestions(error, download) as suggestion, index (index)}
              <li>{suggestion}</li>
            {/each}
          </ul>
        </div>
      </div>
      
      <div class="modal-footer">
        <div class="footer-actions">
          <button class="action-button secondary" on:click={copyErrorDetails}>
            📋 Copy Details
          </button>
          <button class="action-button secondary" on:click={reportError}>
            📤 Report Error
          </button>
          <button class="action-button primary" on:click={retryDownload}>
            🔄 Try Again
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(2px);
  }
  
  .modal-content {
    background: #2a2a2a;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
    max-width: 600px;
    width: 90%;
    max-height: 80vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 24px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    background: #1a1a1a;
  }
  
  .modal-title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: #f44336;
  }
  
  .close-button {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 18px;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;
  }
  
  .close-button:hover {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }
  
  .modal-body {
    padding: 24px;
    overflow-y: auto;
    flex: 1;
  }
  
  .error-info {
    display: flex;
    gap: 16px;
    margin-bottom: 24px;
  }
  
  .error-icon {
    font-size: 32px;
    flex-shrink: 0;
  }
  
  .error-details {
    flex: 1;
  }
  
  .error-details h3 {
    margin: 0 0 8px 0;
    font-size: 16px;
    color: white;
  }
  
  .error-description {
    margin: 0 0 16px 0;
    line-height: 1.5;
    color: rgba(255, 255, 255, 0.8);
  }
  
  .technical-details {
    background: rgba(0, 0, 0, 0.3);
    border-radius: 8px;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  
  .technical-details h4 {
    margin: 0 0 8px 0;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
  }
  
  .detail-row {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
    font-size: 12px;
  }
  
  .detail-label {
    color: rgba(255, 255, 255, 0.6);
    font-weight: 500;
  }
  
  .detail-value {
    color: rgba(255, 255, 255, 0.9);
    font-family: monospace;
  }
  
  .detail-value.checksum {
    font-size: 10px;
    word-break: break-all;
    max-width: 200px;
    text-align: right;
  }
  
  .suggestions h3 {
    margin: 0 0 12px 0;
    font-size: 16px;
    color: white;
  }
  
  .suggestion-list {
    margin: 0;
    padding-left: 20px;
    color: rgba(255, 255, 255, 0.8);
    line-height: 1.6;
  }
  
  .suggestion-list li {
    margin-bottom: 8px;
  }
  
  .modal-footer {
    padding: 20px 24px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    background: #1a1a1a;
  }
  
  .footer-actions {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
  }
  
  .action-button {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  
  .action-button.primary {
    background: #2196f3;
    color: white;
  }
  
  .action-button.primary:hover {
    background: #1976d2;
  }
  
  .action-button.secondary {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
  
  .action-button.secondary:hover {
    background: rgba(255, 255, 255, 0.2);
    color: white;
  }
</style>