<script>
  import { createEventDispatcher } from 'svelte';
  import { formatSize } from '../../utils/backup/index.js';
  import { RecommendationPriority } from '../../utils/backup/retentionOptimizer.js';

  const dispatch = createEventDispatcher();

  /** @type {Object|null} */
  export let optimization = null;
  export let loading = false;
  export let compact = false;

  // Get priority class for recommendations
  function getPriorityClass(priority) {
    switch (priority) {
      case RecommendationPriority.CRITICAL:
        return 'priority-critical';
      case RecommendationPriority.HIGH:
        return 'priority-high';
      case RecommendationPriority.MEDIUM:
        return 'priority-medium';
      case RecommendationPriority.LOW:
        return 'priority-low';
      default:
        return 'priority-info';
    }
  }

  // Get priority icon
  function getPriorityIcon(priority) {
    switch (priority) {
      case RecommendationPriority.CRITICAL:
        return '🚨';
      case RecommendationPriority.HIGH:
        return '⚠️';
      case RecommendationPriority.MEDIUM:
        return '💡';
      case RecommendationPriority.LOW:
        return 'ℹ️';
      default:
        return 'ℹ️';
    }
  }

  // Apply a suggested policy configuration
  function applySuggestedPolicy(policy) {
    dispatch('apply-policy', policy);
  }

  // Apply a specific recommendation
  function applyRecommendation(recommendation) {
    dispatch('apply-recommendation', recommendation);
  }

  // Format effectiveness score
  function formatScore(score) {
    return Math.round(score * 100);
  }



  // Get frequency pattern description
  function getFrequencyDescription(pattern) {
    switch (pattern) {
      case 'very-frequent': return 'Very Frequent (< 1 hour)';
      case 'frequent': return 'Frequent (< 1 day)';
      case 'daily': return 'Daily (1-7 days)';
      case 'weekly': return 'Weekly (1-4 weeks)';
      case 'infrequent': return 'Infrequent (> 1 month)';
      case 'irregular': return 'Irregular';
      default: return 'Unknown';
    }
  }

  // Get growth trend description
  function getGrowthTrendDescription(trend) {
    switch (trend) {
      case 'growing': return 'Growing 📈';
      case 'shrinking': return 'Shrinking 📉';
      case 'stable': return 'Stable ➡️';
      default: return 'Unknown';
    }
  }

  // Check if optimization data is available
  $: hasOptimization = optimization && !loading;
  $: hasRecommendations = hasOptimization && optimization && optimization.recommendations && optimization.recommendations.length > 0;
  $: hasSuggestedPolicies = hasOptimization && optimization && optimization.suggestedPolicies && optimization.suggestedPolicies.length > 0;
</script>

{#if loading}
  <div class="optimization-loading">
    <div class="spinner"></div>
    <p>Analyzing backup patterns and optimizing retention policies...</p>
  </div>
{:else if hasOptimization}
  <div class="retention-optimization {compact ? 'compact' : ''}">
    
    {#if !compact}
      <!-- Effectiveness Overview - Compact -->
      <div class="effectiveness-overview compact">
        <div class="effectiveness-summary">
          <span class="overall-score score-{Math.floor(optimization.effectiveness.overallScore * 5)}">
            {formatScore(optimization.effectiveness.overallScore)}%
          </span>
          <span class="score-label">Policy Effectiveness</span>
        </div>
        <div class="effectiveness-details">
          <span class="detail-item">Storage: {formatScore(optimization.effectiveness.storageEfficiency)}%</span>
          <span class="detail-item">Balance: {formatScore(optimization.effectiveness.retentionBalance)}%</span>
          <span class="detail-item">Utilization: {formatScore(optimization.effectiveness.policyUtilization)}%</span>
        </div>
      </div>

      <!-- Backup Patterns Summary - Compact -->
      <div class="patterns-summary compact">
        <div class="patterns-inline">
          <span class="pattern-stat">{optimization.patterns.totalBackups} backups</span>
          <span class="pattern-stat">{formatSize(optimization.patterns.totalSize)} total</span>
          <span class="pattern-stat">{getGrowthTrendDescription(optimization.patterns.growthTrend)}</span>
          <span class="pattern-stat">{optimization.patterns.frequency ? getFrequencyDescription(optimization.patterns.frequency.pattern) : 'Unknown frequency'}</span>
        </div>
      </div>
    {/if}

    <!-- Recommendations -->
    {#if hasRecommendations}
      <div class="recommendations-section">
        <h3>Optimization Recommendations</h3>
        <div class="recommendations-list">
          {#each optimization.recommendations as recommendation (recommendation.type)}
            <div class="recommendation-item {getPriorityClass(recommendation.priority)}">
              <div class="recommendation-header">
                <span class="recommendation-icon">{getPriorityIcon(recommendation.priority)}</span>
                <span class="recommendation-title">{recommendation.title}</span>
                <span class="recommendation-priority">{recommendation.priority}</span>
                {#if recommendation.confidence}
                  <span class="recommendation-confidence">{Math.round(recommendation.confidence * 100)}%</span>
                {/if}
              </div>
              
              <div class="recommendation-content">
                <div class="recommendation-message">{recommendation.message}</div>
                {#if recommendation.description}
                  <div class="recommendation-description">{recommendation.description}</div>
                {/if}
                
                {#if recommendation.suggestedValue !== undefined}
                  <div class="recommendation-suggestion">
                    <strong>Suggested:</strong> 
                    {recommendation.suggestedValue}
                    {#if recommendation.suggestedUnit}{recommendation.suggestedUnit}{/if}
                  </div>
                {/if}
                
                {#if recommendation.suggestedAction}
                  <div class="recommendation-action">
                    <strong>Action:</strong> {recommendation.suggestedAction}
                  </div>
                {/if}
                
                {#if recommendation.expectedImpact}
                  <div class="recommendation-impact">
                    <strong>Expected Impact:</strong> {recommendation.expectedImpact}
                  </div>
                {/if}
              </div>
              
              {#if recommendation.suggestedValue !== undefined}
                <div class="recommendation-actions">
                  <button 
                    class="apply-recommendation-btn"
                    on:click={() => applyRecommendation(recommendation)}
                  >
                    Apply Suggestion
                  </button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Suggested Policy Configurations -->
    {#if hasSuggestedPolicies && !compact}
      <div class="suggested-policies-section">
        <h3>Suggested Policy Configurations</h3>
        <div class="policies-grid">
          {#each optimization.suggestedPolicies as policy (policy.name)}
            <div class="policy-card">
              <div class="policy-header">
                <h4 class="policy-name">{policy.name}</h4>
                <span class="policy-risk risk-{policy.expectedImpact.riskLevel}">
                  {policy.expectedImpact.riskLevel} risk
                </span>
              </div>
              
              <div class="policy-description">
                {policy.description}
              </div>
              
              <div class="policy-settings">
                <div class="policy-setting">
                  <span class="setting-label">Size Limit:</span>
                  <span class="setting-value">
                    {#if policy.settings.sizeRetentionEnabled}
                      {policy.settings.maxSizeValue} {policy.settings.maxSizeUnit}
                    {:else}
                      Disabled
                    {/if}
                  </span>
                </div>
                <div class="policy-setting">
                  <span class="setting-label">Age Limit:</span>
                  <span class="setting-value">
                    {#if policy.settings.ageRetentionEnabled}
                      {policy.settings.maxAgeValue} {policy.settings.maxAgeUnit}
                    {:else}
                      Disabled
                    {/if}
                  </span>
                </div>
                <div class="policy-setting">
                  <span class="setting-label">Count Limit:</span>
                  <span class="setting-value">
                    {#if policy.settings.countRetentionEnabled}
                      {policy.settings.maxCountValue} backups
                    {:else}
                      Disabled
                    {/if}
                  </span>
                </div>
              </div>
              
              <div class="policy-impact">
                <div class="impact-item">
                  <span class="impact-label">Storage Reduction:</span>
                  <span class="impact-value">{Math.round(policy.expectedImpact.storageReduction * 100)}%</span>
                </div>
                <div class="impact-item">
                  <span class="impact-label">Backups Kept:</span>
                  <span class="impact-value">{Math.round(policy.expectedImpact.backupsKept * 100)}%</span>
                </div>
              </div>
              
              <div class="policy-actions">
                <button 
                  class="apply-policy-btn"
                  on:click={() => applySuggestedPolicy(policy)}
                >
                  Apply Configuration
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Optimization Metrics (compact view) -->
    {#if compact && optimization.metrics}
      <div class="metrics-compact">
        <div class="metric-item">
          <span class="metric-label">Optimization Potential:</span>
          <span class="metric-value">{formatScore(optimization.metrics.optimizationPotential)}%</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Storage Utilization:</span>
          <span class="metric-value">{formatScore(optimization.metrics.storageUtilization)}%</span>
        </div>
      </div>
    {/if}
  </div>
{:else}
  <div class="optimization-empty">
    <p>No optimization data available. Ensure you have backups to analyze.</p>
  </div>
{/if}

<style>
  .optimization-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem;
    color: var(--text-color);
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border-color);
    border-top: 3px solid var(--accent-color);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 1rem;
  }

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  .retention-optimization {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .retention-optimization.compact {
    gap: 1rem;
  }

  .effectiveness-overview,
  .patterns-summary,
  .recommendations-section,
  .suggested-policies-section {
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 1rem;
  }

  .effectiveness-overview.compact {
    padding: 0.75rem;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .effectiveness-summary {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .overall-score {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text-color);
  }

  .score-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .effectiveness-details {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .detail-item {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .patterns-summary.compact {
    padding: 0.75rem;
  }

  .patterns-inline {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: center;
  }

  .pattern-stat {
    font-size: 0.85rem;
    color: var(--text-color);
    background: rgba(0, 0, 0, 0.1);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    white-space: nowrap;
  }

  .recommendations-section h3,
  .suggested-policies-section h3 {
    margin: 0 0 1rem 0;
    color: var(--text-color);
    font-size: 1.1rem;
  }

  .effectiveness-grid,
  .patterns-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
  }

  .effectiveness-item,
  .pattern-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .effectiveness-label,
  .pattern-label {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .effectiveness-value,
  .pattern-value {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--text-color);
  }

  .effectiveness-value.score-0,
  .effectiveness-value.score-1 {
    color: var(--danger-color);
  }

  .effectiveness-value.score-2 {
    color: var(--warning-color);
  }

  .effectiveness-value.score-3,
  .effectiveness-value.score-4,
  .effectiveness-value.score-5 {
    color: var(--success-color);
  }

  .recommendations-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .recommendation-item {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 1rem;
    border-left: 4px solid;
  }

  .recommendation-item.priority-critical {
    border-left-color: var(--danger-color);
    background: rgba(220, 53, 69, 0.05);
  }

  .recommendation-item.priority-high {
    border-left-color: var(--warning-color);
    background: rgba(255, 193, 7, 0.05);
  }

  .recommendation-item.priority-medium {
    border-left-color: var(--info-color);
    background: rgba(23, 162, 184, 0.05);
  }

  .recommendation-item.priority-low,
  .recommendation-item.priority-info {
    border-left-color: var(--text-muted);
    background: rgba(108, 117, 125, 0.05);
  }

  .recommendation-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .recommendation-icon {
    font-size: 1.1rem;
  }

  .recommendation-title {
    font-weight: 600;
    color: var(--text-color);
    flex: 1;
  }

  .recommendation-priority {
    font-size: 0.75rem;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
    color: white;
  }

  .priority-critical .recommendation-priority {
    background: var(--danger-color);
  }

  .priority-high .recommendation-priority {
    background: var(--warning-color);
  }

  .priority-medium .recommendation-priority {
    background: var(--info-color);
  }

  .priority-low .recommendation-priority,
  .priority-info .recommendation-priority {
    background: var(--text-muted);
  }

  .recommendation-confidence {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .recommendation-content {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .recommendation-message {
    color: var(--text-color);
    font-weight: 500;
  }

  .recommendation-description,
  .recommendation-suggestion,
  .recommendation-action,
  .recommendation-impact {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .recommendation-actions {
    margin-top: 0.75rem;
    display: flex;
    justify-content: flex-end;
  }

  .apply-recommendation-btn {
    background: var(--accent-color);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .apply-recommendation-btn:hover {
    background: var(--accent-hover);
  }

  .policies-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1rem;
  }

  .policy-card {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 1rem;
    background: var(--bg-color);
  }

  .policy-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .policy-name {
    margin: 0;
    color: var(--text-color);
    font-size: 1rem;
  }

  .policy-risk {
    font-size: 0.75rem;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
    color: white;
  }

  .policy-risk.risk-low {
    background: var(--success-color);
  }

  .policy-risk.risk-medium {
    background: var(--warning-color);
  }

  .policy-risk.risk-high {
    background: var(--danger-color);
  }

  .policy-description {
    color: var(--text-muted);
    font-size: 0.9rem;
    margin-bottom: 1rem;
  }

  .policy-settings {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .policy-setting {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .setting-label {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .setting-value {
    color: var(--text-color);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .policy-impact {
    display: flex;
    justify-content: space-between;
    margin-bottom: 1rem;
    padding: 0.5rem;
    background: rgba(0, 0, 0, 0.1);
    border-radius: 4px;
  }

  .impact-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .impact-label {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .impact-value {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-color);
  }

  .policy-actions {
    display: flex;
    justify-content: center;
  }

  .apply-policy-btn {
    background: var(--success-color);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .apply-policy-btn:hover {
    background: #218838;
  }

  .metrics-compact {
    display: flex;
    gap: 1rem;
    padding: 0.75rem;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 6px;
  }

  .metric-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .metric-label {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .metric-value {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-color);
  }

  .optimization-empty {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
    font-style: italic;
  }
</style>