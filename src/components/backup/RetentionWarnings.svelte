<script>
  import { WarningTypes, WarningSeverity } from '../../utils/backup/retentionWarnings.js';
  import { formatSize } from '../../utils/backup/index.js';

  export let warnings = [];
  export let compact = false;

  // Group warnings by severity
  $: groupedWarnings = warnings.reduce((groups, warning) => {
    const severity = warning.severity || WarningSeverity.INFO;
    if (!groups[severity]) {
      groups[severity] = [];
    }
    groups[severity].push(warning);
    return groups;
  }, {});

  // Get the highest severity level present
  $: highestSeverity = warnings.length > 0 ? 
    [WarningSeverity.ERROR, WarningSeverity.CRITICAL, WarningSeverity.WARNING, WarningSeverity.INFO]
      .find(severity => groupedWarnings[severity]?.length > 0) : null;

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

  // Get severity class
  function getSeverityClass(severity) {
    switch (severity) {
      case WarningSeverity.CRITICAL:
        return 'severity-critical';
      case WarningSeverity.ERROR:
        return 'severity-error';
      case WarningSeverity.WARNING:
        return 'severity-warning';
      default:
        return 'severity-info';
    }
  }

  // Format warning details for display
  function formatWarningDetails(warning) {
    if (warning.type === WarningTypes.SIZE_APPROACHING_LIMIT || 
        warning.type === WarningTypes.SIZE_EXCEEDED) {
      return `Current: ${formatSize(warning.currentValue)}, Limit: ${formatSize(warning.limitValue)}`;
    }
    
    if (warning.type === WarningTypes.AGE_APPROACHING_LIMIT || 
        warning.type === WarningTypes.AGE_EXCEEDED) {
      return `${warning.details}`;
    }
    
    if (warning.type === WarningTypes.COUNT_APPROACHING_LIMIT || 
        warning.type === WarningTypes.COUNT_EXCEEDED) {
      return `Current: ${warning.currentValue}, Limit: ${warning.limitValue}`;
    }
    
    return warning.details;
  }

  // Check if warnings should be shown
  $: showWarnings = warnings.length > 0;
</script>

{#if showWarnings}
  <div class="retention-warnings {compact ? 'compact' : ''}">
    {#if compact}
      <!-- Compact view - just show summary -->
      <div class="warning-summary {getSeverityClass(highestSeverity)}">
        <span class="warning-icon">{getWarningIcon(highestSeverity)}</span>
        <span class="warning-count">
          {warnings.length} warning{warnings.length > 1 ? 's' : ''}
        </span>
      </div>
    {:else}
      <!-- Full view - show all warnings -->
      <div class="warnings-header">
        <span class="warnings-title">Retention Policy Warnings</span>
        <span class="warnings-count">{warnings.length}</span>
      </div>
      
      <div class="warnings-list">
        {#each Object.entries(groupedWarnings) as [severity, severityWarnings] (severity)}
          {#if severityWarnings.length > 0}
            <div class="severity-group {getSeverityClass(severity)}">
              {#each severityWarnings as warning (warning.type + warning.timestamp)}
                <div class="warning-item">
                  <div class="warning-header">
                    <span class="warning-icon">{getWarningIcon(severity)}</span>
                    <span class="warning-title">{warning.title}</span>
                  </div>
                  
                  <div class="warning-content">
                    <div class="warning-message">{warning.message}</div>
                    {#if warning.details}
                      <div class="warning-details">
                        {formatWarningDetails(warning)}
                      </div>
                    {/if}
                  </div>
                  
                  {#if warning.type === WarningTypes.SIZE_APPROACHING_LIMIT && warning.ratio}
                    <div class="warning-progress">
                      <div class="progress-bar">
                        <div 
                          class="progress-fill" 
                          style="width: {Math.min(warning.ratio * 100, 100)}%"
                        ></div>
                      </div>
                      <span class="progress-text">{Math.round(warning.ratio * 100)}%</span>
                    </div>
                  {/if}
                  
                  {#if warning.type === WarningTypes.COUNT_EXCEEDED && warning.excessCount}
                    <div class="warning-action">
                      <strong>{warning.excessCount}</strong> backup{warning.excessCount > 1 ? 's' : ''} will be deleted
                    </div>
                  {/if}
                  
                  {#if warning.type === WarningTypes.AGE_EXCEEDED && warning.expiredCount}
                    <div class="warning-action">
                      <strong>{warning.expiredCount}</strong> backup{warning.expiredCount > 1 ? 's' : ''} will be deleted
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .retention-warnings {
    margin: 12px 0;
  }

  .retention-warnings.compact {
    margin: 4px 0;
  }

  .warning-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 0.875rem;
    border: 1px solid;
  }

  .warnings-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border-color);
  }

  .warnings-title {
    font-weight: 600;
    color: var(--text-color);
    font-size: 0.9rem;
  }

  .warnings-count {
    background: var(--accent-color);
    color: white;
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .warnings-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .severity-group {
    border-radius: 6px;
    border: 1px solid;
    overflow: hidden;
  }

  .severity-critical {
    background: rgba(220, 53, 69, 0.1);
    border-color: var(--danger-color);
  }

  .severity-error {
    background: rgba(220, 53, 69, 0.1);
    border-color: var(--danger-color);
  }

  .severity-warning {
    background: rgba(255, 193, 7, 0.1);
    border-color: var(--warning-color);
  }

  .severity-info {
    background: rgba(23, 162, 184, 0.1);
    border-color: var(--info-color);
  }

  .warning-item {
    padding: 12px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  }

  .warning-item:last-child {
    border-bottom: none;
  }

  .warning-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .warning-icon {
    font-size: 1rem;
    flex-shrink: 0;
  }

  .warning-title {
    font-weight: 600;
    color: var(--text-color);
    font-size: 0.9rem;
  }

  .warning-content {
    margin-left: 24px;
  }

  .warning-message {
    color: var(--text-color);
    font-size: 0.875rem;
    margin-bottom: 4px;
  }

  .warning-details {
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-bottom: 8px;
  }

  .warning-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: 24px;
    margin-top: 8px;
  }

  .progress-bar {
    flex: 1;
    height: 6px;
    background: rgba(0, 0, 0, 0.1);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--warning-color);
    transition: width 0.3s ease;
  }

  .severity-critical .progress-fill,
  .severity-error .progress-fill {
    background: var(--danger-color);
  }

  .progress-text {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 600;
    min-width: 35px;
    text-align: right;
  }

  .warning-action {
    margin-left: 24px;
    margin-top: 6px;
    padding: 6px 10px;
    background: rgba(0, 0, 0, 0.05);
    border-radius: 4px;
    font-size: 0.8rem;
    color: var(--text-color);
  }

  .warning-count {
    font-weight: 500;
  }

  /* Compact mode specific styles */
  .compact .warning-summary.severity-critical,
  .compact .warning-summary.severity-error {
    background: rgba(220, 53, 69, 0.1);
    border-color: var(--danger-color);
    color: var(--danger-color);
  }

  .compact .warning-summary.severity-warning {
    background: rgba(255, 193, 7, 0.1);
    border-color: var(--warning-color);
    color: var(--warning-color);
  }

  .compact .warning-summary.severity-info {
    background: rgba(23, 162, 184, 0.1);
    border-color: var(--info-color);
    color: var(--info-color);
  }
</style>