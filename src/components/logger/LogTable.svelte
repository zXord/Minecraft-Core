<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let logs: Array<{id: number, timestamp: string, level: string, instanceId: string, category: string, message: string}> = [];
  export let selectedLog = null;
  export let formatTimestamp;
  export let getLevelColor;
  export let loading = false;

  const dispatch = createEventDispatcher();

  function selectLog(log) {
    dispatch('selectLog', log);
  }

  function getLevelDisplayName(level) {
    const levelMap = {
      debug: 'Debug',
      info: 'Info', 
      warn: 'Warning',
      error: 'Error',
      fatal: 'Fatal'
    };
    return levelMap[level] || level;
  }

  function formatInstanceId(instanceId) {
    // Convert instance IDs to more readable format
    if (instanceId === 'system') return 'System';
    if (instanceId.startsWith('server-')) return instanceId.replace('server-', 'Server ');
    if (instanceId.startsWith('client-')) return instanceId.replace('client-', 'Client ');
    return instanceId;
  }

  function formatCategory(category) {
    // Capitalize first letter
    return category.charAt(0).toUpperCase() + category.slice(1);
  }

  function truncateMessage(message, maxLength = 60) {
    if (message.length <= maxLength) return message;
    return message.substring(0, maxLength) + '...';
  }
</script>

<div class="log-table-container">
  {#if loading}
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <p>Loading logs...</p>
    </div>
  {:else if logs.length === 0}
    <div class="empty-state">
      <div class="empty-icon">📝</div>
      <h3>No logs found</h3>
      <p>No log entries match your current filters.</p>
    </div>
  {:else}
    <div class="table-wrapper">
      <table class="log-table">
        <thead>
          <tr class="table-header">
            <th class="col-timestamp">Timestamp</th>
            <th class="col-level">Level</th>
            <th class="col-instance">Instance</th>
            <th class="col-category">Category</th>
            <th class="col-message">Message</th>
          </tr>
        </thead>
        <tbody>
          {#each logs as log (log.id)}
            <tr 
              class="log-row" 
              class:selected={selectedLog && selectedLog.id === log.id}
              on:click={() => selectLog(log)}
            >
              <td class="col-timestamp">
                <span class="timestamp-text">
                  {formatTimestamp(log.timestamp)}
                </span>
              </td>
              
              <td class="col-level">
                <span 
                  class="level-badge" 
                  style="background-color: {getLevelColor(log.level)};"
                >
                  {getLevelDisplayName(log.level)}
                </span>
              </td>
              
              <td class="col-instance">
                <span class="instance-text">
                  {formatInstanceId(log.instanceId)}
                </span>
              </td>
              
              <td class="col-category">
                <span class="category-text">
                  {formatCategory(log.category)}
                </span>
              </td>
              
              <td class="col-message">
                <span class="message-text" title={log.message}>
                  {truncateMessage(log.message)}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .log-table-container {
    flex: 1;
    overflow: hidden;
    border: 1px solid #314d68;
    border-radius: 0.5rem;
    background: #101a23;
  }

  .loading-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem;
    gap: 1rem;
    color: #90adcb;
  }

  .loading-spinner {
    width: 2rem;
    height: 2rem;
    border: 2px solid #314d68;
    border-top: 2px solid #0c7ff2;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem;
    gap: 1rem;
    color: #90adcb;
    text-align: center;
  }

  .empty-icon {
    font-size: 3rem;
    opacity: 0.5;
  }

  .empty-state h3 {
    margin: 0;
    font-size: 1.25rem;
    color: white;
  }

  .empty-state p {
    margin: 0;
    font-size: 0.875rem;
    opacity: 0.8;
  }

  .table-wrapper {
    height: 100%;
    overflow: auto;
  }

  .log-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .table-header {
    background: #182634;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .table-header th {
    padding: 0.75rem 1rem;
    text-align: left;
    color: white;
    font-weight: 500;
    border-bottom: 1px solid #314d68;
  }

  .log-row {
    border-bottom: 1px solid #314d68;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .log-row:hover {
    background: rgba(59, 130, 246, 0.1);
  }

  .log-row.selected {
    background: rgba(59, 130, 246, 0.2);
  }

  .log-row td {
    padding: 1rem;
    vertical-align: top;
  }

  /* Column Widths */
  .col-timestamp {
    width: 200px;
    min-width: 180px;
  }

  .col-level {
    width: 120px;
    min-width: 100px;
  }

  .col-instance {
    width: 150px;
    min-width: 120px;
  }

  .col-category {
    width: 120px;
    min-width: 100px;
  }

  .col-message {
    width: auto;
    min-width: 200px;
  }

  /* Cell Content Styling */
  .timestamp-text {
    color: #90adcb;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 0.8rem;
  }

  .level-badge {
    display: inline-block;
    padding: 0.25rem 0.75rem;
    border-radius: 0.375rem;
    color: white;
    font-weight: 500;
    font-size: 0.8rem;
    text-align: center;
    min-width: 70px;
  }

  .instance-text {
    color: #90adcb;
    font-weight: 500;
  }

  .category-text {
    color: #90adcb;
  }

  .message-text {
    color: #90adcb;
    line-height: 1.4;
    word-break: break-word;
  }

  /* Responsive Design */
  @media (max-width: 1024px) {
    .col-timestamp {
      width: 160px;
      min-width: 140px;
    }
    
    .col-instance,
    .col-category {
      width: 100px;
      min-width: 80px;
    }
  }

  @media (max-width: 768px) {
    .log-table {
      font-size: 0.8rem;
    }
    
    .log-row td {
      padding: 0.75rem 0.5rem;
    }
    
    .col-timestamp {
      width: 140px;
      min-width: 120px;
    }
    
    .col-level {
      width: 80px;
      min-width: 70px;
    }
    
    .col-instance,
    .col-category {
      width: 80px;
      min-width: 60px;
    }
    
    .timestamp-text {
      font-size: 0.75rem;
    }
    
    .level-badge {
      padding: 0.2rem 0.5rem;
      font-size: 0.75rem;
      min-width: 60px;
    }
  }

  /* Hide columns on very small screens */
  @media (max-width: 600px) {
    .col-category {
      display: none;
    }
  }

  @media (max-width: 480px) {
    .col-instance {
      display: none;
    }
  }

  /* Scrollbar Styling */
  .table-wrapper::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .table-wrapper::-webkit-scrollbar-track {
    background: #223649;
  }

  .table-wrapper::-webkit-scrollbar-thumb {
    background: #314d68;
    border-radius: 4px;
  }

  .table-wrapper::-webkit-scrollbar-thumb:hover {
    background: #475569;
  }
</style> 