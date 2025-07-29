<script>
  import { createEventDispatcher } from 'svelte';
  import { formatSize } from '../../utils/backup/index.js';
  import { WarningSeverity } from '../../utils/backup/retentionWarnings.js';

  const dispatch = createEventDispatcher();

  export let show = false;
  /** @type {Object|null} */
  export let preview = null;
  export let loading = false;

  let dialogElement;

  // Close dialog when clicking outside
  function handleBackdropClick(event) {
    if (event.target === dialogElement) {
      dispatch('cancel');
    }
  }

  // Handle keyboard events
  function handleKeydown(event) {
    if (event.key === 'Escape') {
      dispatch('cancel');
    }
  }

  // Get severity class for warnings
  function getWarningSeverityClass(severity) {
    switch (severity) {
      case WarningSeverity.CRITICAL:
        return 'warning-critical';
      case WarningSeverity.ERROR:
        return 'warning-error';
      case WarningSeverity.WARNING:
        return 'warning-warning';
      default:
        return 'warning-info';
    }
  }

  // Get icon for warning severity
  function getWarningIcon(severity) {
    switch (severity) {
      case WarningSeverity.CRITICAL:
      case WarningSeverity.ERROR:
        return '⚠️';
      case WarningSeverity.WARNING:
        return '⚠️';
      default:
        return 'ℹ️';
    }
  }

  // Format backup age for display
  function formatBackupAge(ageInDays) {
    if (ageInDays === 0) return 'Today';
    if (ageInDays === 1) return '1 day ago';
    if (ageInDays < 7) return `${ageInDays} days ago`;
    if (ageInDays < 30) return `${Math.floor(ageInDays / 7)} weeks ago`;
    return `${Math.floor(ageInDays / 30)} months ago`;
  }

  // Check if operation is safe to proceed
  $: isSafeOperation = preview && preview.warnings && (
    !preview.warnings.some(w => 
      w.severity === WarningSeverity.CRITICAL || 
      w.severity === WarningSeverity.ERROR
    )
  );

  // Get summary statistics
  $: summaryStats = preview && preview.impact ? {
    totalBackups: preview.impact.totalBackups,
    toDelete: preview.impact.backupsToDelete,
    toKeep: preview.impact.backupsRemaining,
    spaceSaved: preview.impact.spaceSaved,
    totalSize: preview.impact.totalSize
  } : null;
</script>

<svelte:window on:keydown={handleKeydown} />

{#if show}
  <div 
    class="dialog-backdrop" 
    bind:this={dialogElement}
    on:click={handleBackdropClick}
    on:keydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-labelledby="preview-title"
    tabindex="-1"
  >
    <div class="dialog-content retention-preview-dialog">
      <div class="dialog-header">
        <h2 id="preview-title">Retention Policy Preview</h2>
        <button 
          class="close-button" 
          on:click={() => dispatch('cancel')}
          aria-label="Close dialog"
        >
          ×
        </button>
      </div>

      <div class="dialog-body">
        {#if loading}
          <div class="loading-state">
            <div class="spinner"></div>
            <p>Analyzing retention policy impact...</p>
          </div>
        {:else if preview}
          <!-- Summary Section -->
          <div class="preview-summary">
            <h3>Impact Summary</h3>
            <div class="summary-grid">
              <div class="summary-item">
                <span class="summary-label">Total Backups</span>
                <span class="summary-value">{summaryStats.totalBackups}</span>
              </div>
              <div class="summary-item delete">
                <span class="summary-label">To Delete</span>
                <span class="summary-value">{summaryStats.toDelete}</span>
              </div>
              <div class="summary-item keep">
                <span class="summary-label">To Keep</span>
                <span class="summary-value">{summaryStats.toKeep}</span>
              </div>
              <div class="summary-item space">
                <span class="summary-label">Space Saved</span>
                <span class="summary-value">{formatSize(summaryStats.spaceSaved)}</span>
              </div>
            </div>
            
            {#if preview.policyDescription}
              <div class="policy-description">
                <strong>Active Policy:</strong> {preview.policyDescription}
              </div>
            {/if}
          </div>

          <!-- Warnings Section -->
          {#if preview.warnings && preview.warnings.length > 0}
            <div class="warnings-section">
              <h3>Warnings & Alerts</h3>
              <div class="warnings-list">
                {#each preview.warnings as warning (warning.type + warning.timestamp)}
                  <div class="warning-item {getWarningSeverityClass(warning.severity)}">
                    <div class="warning-header">
                      <span class="warning-icon">{getWarningIcon(warning.severity)}</span>
                      <span class="warning-title">{warning.title}</span>
                    </div>
                    <div class="warning-message">{warning.message}</div>
                    {#if warning.details}
                      <div class="warning-details">{warning.details}</div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Backups to Delete Section -->
          {#if preview.backupsToDelete && preview.backupsToDelete.length > 0}
            <div class="backups-section delete-section">
              <h3>Backups to Delete ({preview.backupsToDelete.length})</h3>
              <div class="backups-list">
                {#each preview.backupsToDelete as backup (backup.name)}
                  <div class="backup-item delete-item">
                    <div class="backup-info">
                      <span class="backup-name">{backup.name}</span>
                      <span class="backup-size">{formatSize(backup.size || 0)}</span>
                      <span class="backup-age">{formatBackupAge(backup.ageInDays)}</span>
                    </div>
                    <div class="backup-reason">{backup.reason}</div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Backups to Keep Section -->
          {#if preview.backupsToKeep && preview.backupsToKeep.length > 0}
            <div class="backups-section keep-section">
              <h3>Backups to Keep ({preview.backupsToKeep.length})</h3>
              <div class="backups-list">
                {#each preview.backupsToKeep.slice(0, 5) as backup (backup.name)}
                  <div class="backup-item keep-item">
                    <div class="backup-info">
                      <span class="backup-name">{backup.name}</span>
                      <span class="backup-size">{formatSize(backup.size || 0)}</span>
                      <span class="backup-age">{formatBackupAge(backup.ageInDays)}</span>
                    </div>
                    <div class="backup-reason">{backup.reason}</div>
                  </div>
                {/each}
                {#if preview.backupsToKeep.length > 5}
                  <div class="more-items">
                    ... and {preview.backupsToKeep.length - 5} more backups
                  </div>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Recommendations Section -->
          {#if preview.recommendations && preview.recommendations.length > 0}
            <div class="recommendations-section">
              <h3>Recommendations</h3>
              <div class="recommendations-list">
                {#each preview.recommendations as recommendation (recommendation.type)}
                  <div class="recommendation-item priority-{recommendation.priority}">
                    <div class="recommendation-header">
                      <span class="recommendation-title">{recommendation.title}</span>
                      <span class="recommendation-priority">{recommendation.priority}</span>
                    </div>
                    <div class="recommendation-message">{recommendation.message}</div>
                    {#if recommendation.suggestedAction}
                      <div class="recommendation-action">
                        <strong>Suggested:</strong> {recommendation.suggestedAction}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {:else}
          <div class="error-state">
            <p>Unable to generate retention policy preview.</p>
          </div>
        {/if}
      </div>

      <div class="dialog-footer">
        <button 
          class="button secondary" 
          on:click={() => dispatch('cancel')}
          disabled={loading}
        >
          Cancel
        </button>
        
        {#if preview}
          {#if summaryStats.toDelete > 0}
            <button 
              class="button {isSafeOperation ? 'primary' : 'danger'}" 
              on:click={() => dispatch('confirm')}
              disabled={loading}
            >
              {isSafeOperation ? 'Apply Policy' : 'Apply Anyway'}
            </button>
          {:else}
            <button 
              class="button primary" 
              on:click={() => dispatch('confirm')}
              disabled={loading}
            >
              Apply Policy
            </button>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(2px);
  }

  .retention-preview-dialog {
    background: #2a2e36;
    border: 2px solid #444;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    max-width: 800px;
    max-height: 90vh;
    width: 90%;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .retention-preview-dialog::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: #2a2e36;
    border-radius: 6px;
    z-index: -1;
  }

  .dialog-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px;
    border-bottom: 2px solid #444;
    background: #32383f;
    border-radius: 8px 8px 0 0;
  }

  .dialog-header h2 {
    margin: 0;
    color: #d9eef7;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .close-button {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #d9eef7;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.2s;
  }

  .close-button:hover {
    background: #3a3e46;
    color: #fff;
  }

  .dialog-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    background: #2a2e36;
    color: #d9eef7;
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 40px;
    color: var(--text-color);
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border-color);
    border-top: 3px solid var(--accent-color);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 16px;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .preview-summary {
    margin-bottom: 24px;
  }

  .preview-summary h3 {
    margin: 0 0 16px 0;
    color: var(--text-color);
    font-size: 1.1rem;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }

  .summary-item {
    display: flex;
    flex-direction: column;
    padding: 12px;
    background: #1e2228;
    border-radius: 6px;
    border: 1px solid #444;
  }

  .summary-item.delete {
    border-color: var(--danger-color);
    background: rgba(220, 53, 69, 0.1);
  }

  .summary-item.keep {
    border-color: var(--success-color);
    background: rgba(40, 167, 69, 0.1);
  }

  .summary-item.space {
    border-color: var(--info-color);
    background: rgba(23, 162, 184, 0.1);
  }

  .summary-label {
    font-size: 0.875rem;
    color: #aaa;
    margin-bottom: 4px;
  }

  .summary-value {
    font-size: 1.25rem;
    font-weight: 600;
    color: #d9eef7;
  }

  .policy-description {
    padding: 12px;
    background: rgba(23, 162, 184, 0.15);
    border: 1px solid rgba(23, 162, 184, 0.3);
    border-radius: 6px;
    color: #d9eef7;
    font-size: 0.9rem;
  }

  .warnings-section,
  .backups-section,
  .recommendations-section {
    margin-bottom: 24px;
  }

  .warnings-section h3,
  .backups-section h3,
  .recommendations-section h3 {
    margin: 0 0 12px 0;
    color: var(--text-color);
    font-size: 1.1rem;
  }

  .warnings-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .warning-item {
    padding: 12px;
    border-radius: 6px;
    border-left: 4px solid;
  }

  .warning-critical {
    background: rgba(220, 53, 69, 0.1);
    border-left-color: var(--danger-color);
  }

  .warning-error {
    background: rgba(220, 53, 69, 0.1);
    border-left-color: var(--danger-color);
  }

  .warning-warning {
    background: rgba(255, 193, 7, 0.1);
    border-left-color: var(--warning-color);
  }

  .warning-info {
    background: rgba(23, 162, 184, 0.1);
    border-left-color: var(--info-color);
  }

  .warning-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .warning-icon {
    font-size: 1.1rem;
  }

  .warning-title {
    font-weight: 600;
    color: var(--text-color);
  }

  .warning-message {
    color: var(--text-color);
    margin-bottom: 4px;
  }

  .warning-details {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .backups-list {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--border-color);
    border-radius: 6px;
  }

  .backup-item {
    padding: 12px;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .backup-item:last-child {
    border-bottom: none;
  }

  .delete-item {
    background: rgba(220, 53, 69, 0.05);
  }

  .keep-item {
    background: rgba(40, 167, 69, 0.05);
  }

  .backup-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .backup-name {
    font-weight: 500;
    color: var(--text-color);
  }

  .backup-size,
  .backup-age {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .backup-reason {
    font-size: 0.875rem;
    color: var(--text-muted);
    text-align: right;
    max-width: 200px;
  }

  .more-items {
    padding: 12px;
    text-align: center;
    color: var(--text-muted);
    font-style: italic;
    background: var(--card-bg);
  }

  .recommendations-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .recommendation-item {
    padding: 12px;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: var(--card-bg);
  }

  .recommendation-item.priority-high {
    border-left: 4px solid var(--danger-color);
  }

  .recommendation-item.priority-medium {
    border-left: 4px solid var(--warning-color);
  }

  .recommendation-item.priority-low {
    border-left: 4px solid var(--info-color);
  }

  .recommendation-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  .recommendation-title {
    font-weight: 600;
    color: var(--text-color);
  }

  .recommendation-priority {
    font-size: 0.75rem;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
  }

  .priority-high .recommendation-priority {
    background: var(--danger-color);
    color: white;
  }

  .priority-medium .recommendation-priority {
    background: var(--warning-color);
    color: white;
  }

  .priority-low .recommendation-priority {
    background: var(--info-color);
    color: white;
  }

  .recommendation-message {
    color: var(--text-color);
    margin-bottom: 4px;
  }

  .recommendation-action {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 20px;
    border-top: 2px solid #444;
    background: #32383f;
    border-radius: 0 0 8px 8px;
  }

  .button {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .button.secondary {
    background: var(--card-bg);
    color: var(--text-color);
    border: 1px solid var(--border-color);
  }

  .button.secondary:hover:not(:disabled) {
    background: var(--hover-color);
  }

  .button.primary {
    background: var(--accent-color);
    color: white;
  }

  .button.primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .button.danger {
    background: var(--danger-color);
    color: white;
  }

  .button.danger:hover:not(:disabled) {
    background: #c82333;
  }

  .error-state {
    text-align: center;
    padding: 40px;
    color: var(--text-muted);
  }
</style>