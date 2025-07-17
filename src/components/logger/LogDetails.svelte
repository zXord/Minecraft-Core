<script>
  export let log;

  function formatJsonData(data) {
    if (!data) return 'N/A';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch (e) {
      return String(data);
    }
  }

  function formatTimestamp(timestamp) {
    return new Date(timestamp).toLocaleString();
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        // TODO: Add proper logging - Failed to copy to clipboard
      });
    }
  }
</script>

<div class="log-details">
  <div class="details-header">
    <h3 class="details-title">Log Details</h3>
    <button 
      class="copy-button"
      on:click={() => copyToClipboard(JSON.stringify(log, null, 2))}
      title="Copy full log entry to clipboard"
      aria-label="Copy full log entry to clipboard"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
        <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"></path>
      </svg>
    </button>
  </div>

  <div class="details-content">
    <!-- Basic Information -->
    <div class="detail-section">
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">Timestamp:</span>
          <span class="detail-value">{formatTimestamp(log.timestamp)}</span>
        </div>
        
        <div class="detail-item">
          <span class="detail-label">Level:</span>
          <span class="detail-value level-{log.level}">{log.level.toUpperCase()}</span>
        </div>
        
        <div class="detail-item">
          <span class="detail-label">Instance:</span>
          <span class="detail-value">{log.instanceId}</span>
        </div>
        
        <div class="detail-item">
          <span class="detail-label">Category:</span>
          <span class="detail-value">{log.category}</span>
        </div>
      </div>
    </div>

    <!-- Message -->
    <div class="detail-section">
      <div class="detail-label">Full Message:</div>
      <div class="message-container">
        <pre class="message-text">{log.message}</pre>
        <button 
          class="copy-message-button"
          on:click={() => copyToClipboard(log.message)}
          title="Copy message to clipboard"
          aria-label="Copy message to clipboard"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
            <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"></path>
          </svg>
        </button>
      </div>
    </div>

    <!-- Stack Trace (if exists) -->
    {#if log.stackTrace}
      <div class="detail-section">
        <div class="detail-label">Stack Trace:</div>
        <div class="stacktrace-container">
          <pre class="stacktrace-text">{log.stackTrace}</pre>
          <button 
            class="copy-stacktrace-button"
            on:click={() => copyToClipboard(log.stackTrace)}
            title="Copy stack trace to clipboard"
            aria-label="Copy stack trace to clipboard"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
              <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"></path>
            </svg>
          </button>
        </div>
      </div>
    {/if}

    <!-- Context Data (if exists) -->
    {#if log.data && Object.keys(log.data).length > 0}
      <div class="detail-section">
        <div class="detail-label">Context Data:</div>
        <div class="context-container">
          <pre class="context-text">{formatJsonData(log.data)}</pre>
          <button 
            class="copy-context-button"
            on:click={() => copyToClipboard(formatJsonData(log.data))}
            title="Copy context data to clipboard"
            aria-label="Copy context data to clipboard"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
              <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"></path>
            </svg>
          </button>
        </div>
      </div>
    {/if}

    <!-- Additional Info -->
    <div class="detail-section">
      <div class="detail-grid">
        {#if log.id}
          <div class="detail-item">
            <span class="detail-label">Log ID:</span>
            <span class="detail-value log-id">{log.id}</span>
          </div>
        {/if}
        
        {#if log.source}
          <div class="detail-item">
            <span class="detail-label">Source:</span>
            <span class="detail-value">{log.source}</span>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .log-details {
    background: #182634;
    border-radius: 0.5rem;
    border: 1px solid #314d68;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .details-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    background: #223649;
    border-bottom: 1px solid #314d68;
  }

  .details-title {
    margin: 0;
    font-size: 1.125rem;
    font-weight: bold;
    color: white;
  }

  .copy-button {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #314d68;
    border: none;
    border-radius: 0.375rem;
    padding: 0.5rem;
    color: #90adcb;
    cursor: pointer;
    transition: all 0.2s;
  }

  .copy-button:hover {
    background: #475569;
    color: white;
  }

  .details-content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    overflow-y: auto;
    flex: 1;
  }

  .detail-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .detail-label {
    font-weight: 600;
    color: white;
    font-size: 0.875rem;
    margin-bottom: 0.5rem;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .detail-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .detail-item .detail-label {
    margin-bottom: 0;
    font-size: 0.8rem;
    color: #90adcb;
    font-weight: 500;
  }

  .detail-value {
    color: white;
    font-size: 0.875rem;
    word-break: break-word;
  }

  .log-id {
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 0.8rem;
    color: #90adcb;
  }

  /* Level Colors */
  .level-debug { color: #6b7280; }
  .level-info { color: #3b82f6; }
  .level-warn { color: #f59e0b; }
  .level-error { color: #ef4444; }
  .level-fatal { color: #7f1d1d; font-weight: bold; }

  /* Code Containers */
  .message-container,
  .stacktrace-container,
  .context-container {
    position: relative;
    background: #101a23;
    border: 1px solid #314d68;
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .message-text,
  .stacktrace-text,
  .context-text {
    margin: 0;
    padding: 1rem;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 0.8rem;
    line-height: 1.5;
    color: #e5e7eb;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }

  .copy-message-button,
  .copy-stacktrace-button,
  .copy-context-button {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    background: rgba(34, 54, 73, 0.8);
    border: none;
    border-radius: 0.25rem;
    padding: 0.375rem;
    color: #90adcb;
    cursor: pointer;
    transition: all 0.2s;
    backdrop-filter: blur(4px);
  }

  .copy-message-button:hover,
  .copy-stacktrace-button:hover,
  .copy-context-button:hover {
    background: rgba(49, 77, 104, 0.9);
    color: white;
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .details-header {
      padding: 0.75rem 1rem;
    }

    .details-content {
      padding: 1rem;
      gap: 1rem;
    }

    .detail-grid {
      grid-template-columns: 1fr;
      gap: 0.75rem;
    }

    .message-text,
    .stacktrace-text,
    .context-text {
      font-size: 0.75rem;
      padding: 0.75rem;
    }
  }

  /* Scrollbar Styling */
  .details-content::-webkit-scrollbar,
  .message-text::-webkit-scrollbar,
  .stacktrace-text::-webkit-scrollbar,
  .context-text::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  .details-content::-webkit-scrollbar-track,
  .message-text::-webkit-scrollbar-track,
  .stacktrace-text::-webkit-scrollbar-track,
  .context-text::-webkit-scrollbar-track {
    background: #223649;
  }

  .details-content::-webkit-scrollbar-thumb,
  .message-text::-webkit-scrollbar-thumb,
  .stacktrace-text::-webkit-scrollbar-thumb,
  .context-text::-webkit-scrollbar-thumb {
    background: #314d68;
    border-radius: 3px;
  }

  .details-content::-webkit-scrollbar-thumb:hover,
  .message-text::-webkit-scrollbar-thumb:hover,
  .stacktrace-text::-webkit-scrollbar-thumb:hover,
  .context-text::-webkit-scrollbar-thumb:hover {
    background: #475569;
  }
</style> 