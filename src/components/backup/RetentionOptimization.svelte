<script>
  import { createEventDispatcher } from 'svelte';
  import { formatSize } from '../../utils/backup/index.js';
  import { RecommendationPriority } from '../../utils/backup/retentionOptimizer.js';
  import {
    RecommendationSeverity,
    RecommendationGroups
  } from '../../utils/backup/retentionWarnings.js';

  const dispatch = createEventDispatcher();

  /** @type {Object|null} */
  export let optimization = null;
  export let loading = false;
  export let compact = false;
  export let recommendationHistory = {};

  const EMPTY_EFFECTIVENESS = {
    overallScore: 0,
    storageEfficiency: 0,
    retentionBalance: 0,
    policyUtilization: 0
  };

  const EMPTY_PATTERNS = {
    totalBackups: 0,
    totalSize: 0,
    growthTrend: 'unknown',
    frequency: null
  };

  const EMPTY_METRICS = null;

  $: safeOptimization = optimization ?? {};
  $: safeEffectiveness = safeOptimization.effectiveness ?? EMPTY_EFFECTIVENESS;
  $: safePatterns = safeOptimization.patterns ?? EMPTY_PATTERNS;
  $: safeRecommendations = safeOptimization.recommendations ?? [];
  $: safeSuggestedPolicies = safeOptimization.suggestedPolicies ?? [];
  $: safeMetrics = safeOptimization.metrics ?? EMPTY_METRICS;
  $: normalizedRecommendations = safeRecommendations.map(ensureRecommendationMetadata);
  $: recommendationSummary = buildRecommendationSummary(normalizedRecommendations);

  function mapPriorityToSeverity(priority) {
    const normalized = typeof priority === 'string' ? priority.toLowerCase() : priority;
    switch (normalized) {
      case RecommendationPriority.CRITICAL:
      case 'critical':
        return RecommendationSeverity.CRITICAL;
      case RecommendationPriority.HIGH:
      case 'high':
        return RecommendationSeverity.WARNING;
      case RecommendationPriority.MEDIUM:
      case 'medium':
        return RecommendationSeverity.ADVISORY;
      case RecommendationPriority.LOW:
      case 'low':
      default:
        return RecommendationSeverity.INFO;
    }
  }

  function mapSeverityToPriority(severity) {
    switch (severity) {
      case RecommendationSeverity.CRITICAL:
        return 'critical';
      case RecommendationSeverity.WARNING:
        return 'high';
      case RecommendationSeverity.ADVISORY:
        return 'medium';
      case RecommendationSeverity.INFO:
      default:
        return 'low';
    }
  }

  function getRecommendationSeverityClass(severity) {
    switch (severity) {
      case RecommendationSeverity.CRITICAL:
        return 'rec-critical';
      case RecommendationSeverity.WARNING:
        return 'rec-warning';
      case RecommendationSeverity.ADVISORY:
        return 'rec-advisory';
      default:
        return 'rec-info';
    }
  }

  function getRecommendationSeverityIcon(severity) {
    switch (severity) {
      case RecommendationSeverity.CRITICAL:
        return '🚨';
      case RecommendationSeverity.WARNING:
        return '⚠️';
      case RecommendationSeverity.ADVISORY:
        return '💡';
      default:
        return 'ℹ️';
    }
  }

  function getRecommendationGroupLabel(group) {
    switch (group) {
      case RecommendationGroups.COVERAGE:
        return 'Policy Coverage';
      case RecommendationGroups.STORAGE:
        return 'Storage Health';
      case RecommendationGroups.SAFETY:
        return 'Data Safety';
      case RecommendationGroups.PERFORMANCE:
        return 'Performance';
      case RecommendationGroups.MAINTENANCE:
        return 'Maintenance';
      default:
        return 'General';
    }
  }

  function hasQuickAction(recommendation) {
    return recommendation?.suggestedValue !== undefined || recommendation?.suggestedSettings;
  }

  function getQuickActionLabel(recommendation) {
    if (recommendation?.quickActionLabel) {
      return recommendation.quickActionLabel;
    }

    if (recommendation?.suggestedSettings) {
      return 'Apply Suggested Settings';
    }

    if (recommendation?.suggestedAction) {
      return 'Apply Suggested Action';
    }

    return 'Apply Suggestion';
  }

  function extractSuggestedSettings(recommendation) {
    const settings = recommendation?.suggestedSettings;
    if (!settings) {
      return [];
    }

    const summaries = [];
    if ('sizeRetentionEnabled' in settings) {
      summaries.push(`${settings.sizeRetentionEnabled ? 'Enable' : 'Disable'} size-based retention`);
    }
    if (settings.maxSizeValue !== undefined) {
      summaries.push(`Set size limit to ${settings.maxSizeValue} ${settings.maxSizeUnit || 'GB'}`);
    }
    if ('ageRetentionEnabled' in settings) {
      summaries.push(`${settings.ageRetentionEnabled ? 'Enable' : 'Disable'} age-based retention`);
    }
    if (settings.maxAgeValue !== undefined) {
      summaries.push(`Expire backups after ${settings.maxAgeValue} ${settings.maxAgeUnit || 'days'}`);
    }
    if ('countRetentionEnabled' in settings) {
      summaries.push(`${settings.countRetentionEnabled ? 'Enable' : 'Disable'} count-based retention`);
    }
    if (settings.maxCountValue !== undefined) {
      summaries.push(`Keep the latest ${settings.maxCountValue} backups`);
    }

    return summaries;
  }

  function normalizeSeverityKey(severity) {
    if (!severity) {
      return 'info';
    }
    const normalized = String(severity).toLowerCase();
    switch (normalized) {
      case RecommendationSeverity.CRITICAL:
      case 'critical':
        return 'critical';
      case RecommendationSeverity.WARNING:
      case 'warning':
        return 'warning';
      case RecommendationSeverity.ADVISORY:
      case 'advisory':
        return 'advisory';
      default:
        return 'info';
    }
  }

  function buildRecommendationSummary(recommendations = []) {
    if (!recommendations || recommendations.length === 0) {
      return null;
    }

    const severityCounts = {
      critical: 0,
      warning: 0,
      advisory: 0,
      info: 0
    };

  const groupCounts = {};
    let quickApply = 0;

    for (const recommendation of recommendations) {
      const severityKey = normalizeSeverityKey(recommendation.severity);
      severityCounts[severityKey] = (severityCounts[severityKey] || 0) + 1;

      if (hasQuickAction(recommendation)) {
        quickApply += 1;
      }

  const groupKey = recommendation.group || 'general';
  groupCounts[groupKey] = (groupCounts[groupKey] || 0) + 1;
    }

    const topGroups = Object.entries(groupCounts)
      .map(([key, count]) => ({
        key,
        count,
        label: getRecommendationGroupLabel(key)
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return {
      total: recommendations.length,
      quickApply,
      severityCounts,
      topGroups
    };
  }

  function formatConfidence(confidence) {
    if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
      return null;
    }
    return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}% confidence`;
  }

  function dismissRecommendation(recommendation) {
    dispatch('dismiss-recommendation', { recommendation });
  }

  function getRecommendationKey(recommendation) {
    if (!recommendation) {
      return null;
    }

    return recommendation.id || recommendation.type || recommendation.title || null;
  }

  function formatRelativeTime(timestamp) {
    if (!timestamp) {
      return null;
    }

    const now = Date.now();
    const elapsed = now - Number(timestamp);
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      return null;
    }

    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;
    const month = 30 * day;

    if (elapsed < minute) {
      return 'moments ago';
    }
    if (elapsed < hour) {
      const minutes = Math.round(elapsed / minute);
      return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    }
    if (elapsed < day) {
      const hours = Math.round(elapsed / hour);
      return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    }
    if (elapsed < week) {
      const days = Math.round(elapsed / day);
      return `${days} day${days === 1 ? '' : 's'} ago`;
    }
    if (elapsed < month) {
      const weeks = Math.round(elapsed / week);
      return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
    }

    const months = Math.round(elapsed / month);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }

  function formatHistoryChanges(recommendation, stored) {
    if (!recommendation?.metrics || !stored?.metrics) {
      return [];
    }

    const changes = [];
    const metricInfo = [
      ['sizeRatio', 'storage usage'],
      ['countRatio', 'backup count'],
      ['ageRatio', 'backup age'],
      ['storageUtilization', 'storage utilization'],
      ['projectedMonthlyGrowth', 'projected growth']
    ];

    for (const [key, label] of metricInfo) {
      const current = Number(recommendation.metrics[key]);
      const previous = Number(stored.metrics[key]);
      if (!Number.isFinite(current) || !Number.isFinite(previous)) {
        continue;
      }

      const delta = current - previous;
      if (Math.abs(delta) < 0.05 && key !== 'projectedMonthlyGrowth') {
        continue;
      }

      if (key === 'projectedMonthlyGrowth') {
        const gigabytesDelta = (delta / (1024 ** 3)) || 0;
        if (Math.abs(gigabytesDelta) < 1) {
          continue;
        }
        const direction = gigabytesDelta > 0 ? 'up' : 'down';
        changes.push(`${label} ${direction} ${Math.abs(gigabytesDelta).toFixed(1)} GB/mo`);
      } else {
        const percentDelta = Math.round(delta * 100);
        if (percentDelta === 0) {
          continue;
        }
        const direction = percentDelta > 0 ? 'up' : 'down';
        changes.push(`${label} ${direction} ${Math.abs(percentDelta)} pts`);
      }
    }

    return changes;
  }

  function getRecommendationHistorySummary(recommendation) {
    const key = getRecommendationKey(recommendation);
    if (!key) {
      return null;
    }

    const stored = recommendationHistory?.[key];
    if (!stored) {
      return null;
    }

    const parts = [];
    const relativeTime = formatRelativeTime(stored.dismissedAt);
    if (relativeTime) {
      parts.push(`Dismissed ${relativeTime}`);
    } else {
      parts.push('Previously dismissed');
    }

    if (stored.severity) {
      parts.push(`Marked as ${stored.severity}`);
    }

    const changeDescriptions = formatHistoryChanges(recommendation, stored);
    if (changeDescriptions.length) {
      parts.push(`Changes since: ${changeDescriptions.join(', ')}`);
    }

    return parts.join(' · ');
  }

  function ensureRecommendationMetadata(recommendation) {
    if (!recommendation) {
      return recommendation;
    }

    const severity = recommendation.severity || mapPriorityToSeverity(recommendation.priority);
    const priority = recommendation.priority || mapSeverityToPriority(severity);
    const historySummary = [
      getRecommendationHistorySummary(recommendation),
      recommendation.justification
    ].filter(Boolean).join(' • ') || null;

    return {
      ...recommendation,
      severity,
      priority,
      group: recommendation.group || recommendation.inferredGroup || RecommendationGroups.STORAGE,
      historySummary
    };
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
    if (typeof score !== 'number' || Number.isNaN(score)) {
      return 0;
    }
    const normalized = Math.max(0, Math.min(1, score));
    return Math.round(normalized * 100);
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
  $: hasOptimization = !loading && !!optimization;
  $: hasRecommendations = hasOptimization && safeRecommendations.length > 0;
  $: hasSuggestedPolicies = hasOptimization && safeSuggestedPolicies.length > 0;
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
          <span class="overall-score score-{Math.floor((safeEffectiveness.overallScore || 0) * 5)}">
            {formatScore(safeEffectiveness.overallScore)}%
          </span>
          <span class="score-label">Policy Effectiveness</span>
        </div>
        <div class="effectiveness-details">
          <span class="detail-item">Storage: {formatScore(safeEffectiveness.storageEfficiency)}%</span>
          <span class="detail-item">Balance: {formatScore(safeEffectiveness.retentionBalance)}%</span>
          <span class="detail-item">Utilization: {formatScore(safeEffectiveness.policyUtilization)}%</span>
        </div>
      </div>

      <!-- Backup Patterns Summary - Compact -->
      <div class="patterns-summary compact">
        <div class="patterns-inline">
          <span class="pattern-stat">{safePatterns.totalBackups} backups</span>
          <span class="pattern-stat">{formatSize(safePatterns.totalSize)} total</span>
          <span class="pattern-stat">{getGrowthTrendDescription(safePatterns.growthTrend)}</span>
          <span class="pattern-stat">{safePatterns.frequency ? getFrequencyDescription(safePatterns.frequency.pattern) : 'Unknown frequency'}</span>
        </div>
      </div>
    {/if}

    <!-- Recommendations -->
    {#if hasRecommendations}
      <div class="recommendations-section">
        <h3>Optimization Recommendations</h3>
        {#if recommendationSummary}
          <div class="recommendations-overview">
            <div class="overview-row">
              <div class="overview-metric total">
                <span class="metric-label">Total</span>
                <span class="metric-value">{recommendationSummary.total}</span>
              </div>
              <div class="overview-metric critical">
                <span class="metric-label">Critical</span>
                <span class="metric-value">{recommendationSummary.severityCounts.critical}</span>
              </div>
              <div class="overview-metric warning">
                <span class="metric-label">Warnings</span>
                <span class="metric-value">{recommendationSummary.severityCounts.warning}</span>
              </div>
              <div class="overview-metric advisory">
                <span class="metric-label">Advisories</span>
                <span class="metric-value">{recommendationSummary.severityCounts.advisory}</span>
              </div>
              <div class="overview-metric quick-actions">
                <span class="metric-label">Quick applies</span>
                <span class="metric-value">{recommendationSummary.quickApply}</span>
              </div>
            </div>
            {#if recommendationSummary.topGroups.length > 0}
              <div class="overview-groups">
                <span class="metric-label">Focus areas</span>
                <div class="group-chips">
                  {#each recommendationSummary.topGroups as group (group.key)}
                    <span class="group-chip">{group.label} ({group.count})</span>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
        <div class="recommendations-list">
          {#each normalizedRecommendations as recommendation (recommendation.id || recommendation.type || recommendation.title)}
            <div class="recommendation-item {getRecommendationSeverityClass(recommendation.severity)}">
              <div class="recommendation-header">
                <div class="recommendation-title">
                  <span class="recommendation-icon">{getRecommendationSeverityIcon(recommendation.severity)}</span>
                  <span>{recommendation.title}</span>
                </div>
                <div class="recommendation-meta">
                  <div class="recommendation-tags">
                    {#if recommendation.group}
                      <span class="recommendation-tag group">{getRecommendationGroupLabel(recommendation.group)}</span>
                    {/if}
                    <span class="recommendation-tag priority">{recommendation.priority}</span>
                    <span class="recommendation-tag severity">{recommendation.severity}</span>
                    {#if formatConfidence(recommendation.confidence)}
                      <span class="recommendation-tag confidence">{formatConfidence(recommendation.confidence)}</span>
                    {/if}
                    {#if recommendation.historySummary}
                      <span class="recommendation-tag history" title={recommendation.historySummary}>History</span>
                    {/if}
                  </div>
                  <button
                    class="recommendation-dismiss"
                    type="button"
                    on:click={() => dismissRecommendation(recommendation)}
                    title="Dismiss recommendation"
                  >
                    Dismiss
                  </button>
                </div>
              </div>

              <div class="recommendation-body">
                <div class="recommendation-message">{recommendation.message}</div>
                {#if recommendation.description}
                  <div class="recommendation-details">{recommendation.description}</div>
                {/if}

                {#if recommendation.expectedImpact}
                  <div class="recommendation-impact">
                    <strong>Expected Impact:</strong> {recommendation.expectedImpact}
                  </div>
                {/if}

                {#if recommendation.suggestedAction}
                  <div class="recommendation-action">
                    <strong>Suggested:</strong> {recommendation.suggestedAction}
                  </div>
                {/if}

                {#if recommendation.suggestedValue !== undefined}
                  <div class="recommendation-suggestion">
                    <strong>Target:</strong> {recommendation.suggestedValue}
                    {#if recommendation.suggestedUnit}
                      {recommendation.suggestedUnit}
                    {/if}
                  </div>
                {/if}

                {#if extractSuggestedSettings(recommendation).length}
                  <ul class="recommendation-checklist">
                    {#each extractSuggestedSettings(recommendation) as checklistItem (checklistItem)}
                      <li>{checklistItem}</li>
                    {/each}
                  </ul>
                {/if}

                {#if recommendation.metrics?.projectedMonthlyGrowth}
                  <div class="recommendation-metric">
                    <strong>Projected Monthly Growth:</strong> {formatSize(recommendation.metrics.projectedMonthlyGrowth)}
                  </div>
                {/if}
                {#if recommendation.metrics?.sizeRatio !== undefined}
                  <div class="recommendation-metric">
                    <strong>Size Ratio:</strong> {(recommendation.metrics.sizeRatio * 100).toFixed(0)}%
                  </div>
                {/if}
              </div>

              {#if hasQuickAction(recommendation)}
                <div class="recommendation-actions">
                  <button
                    class="apply-recommendation-btn"
                    on:click={() => applyRecommendation(recommendation)}
                  >
                    {getQuickActionLabel(recommendation)}
                  </button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="recommendations-empty">
        <div class="empty-icon">🎉</div>
        <div class="empty-title">Retention settings look healthy</div>
        <p class="empty-message">
          No immediate adjustments are needed. Keep an eye on storage trends and rerun optimization after major changes.
        </p>
      </div>
    {/if}

    <!-- Suggested Policy Configurations -->
    {#if hasSuggestedPolicies && !compact}
      <div class="suggested-policies-section">
        <h3>Suggested Policy Configurations</h3>
        <p class="section-description">
          These presets apply a complete retention policy in one click. Choose a preset when you want an overall strategy, and use the recommendations above when you need focused adjustments.
        </p>
        <div class="policies-grid">
          {#each safeSuggestedPolicies as policy (policy.name)}
            <div class="policy-card">
              <div class="policy-header">
                <h4 class="policy-name">{policy.name}</h4>
                <span class="policy-risk risk-{policy.expectedImpact?.riskLevel ?? 'unknown'}">
                  {(policy.expectedImpact?.riskLevel ?? 'unknown')} risk
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
                  <span class="impact-value">{formatScore(policy.expectedImpact?.storageReduction ?? 0)}%</span>
                </div>
                <div class="impact-item">
                  <span class="impact-label">Backups Kept:</span>
                  <span class="impact-value">{formatScore(policy.expectedImpact?.backupsKept ?? 0)}%</span>
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
    {#if compact && safeMetrics}
      <div class="metrics-compact">
        <div class="metric-item">
          <span class="metric-label">Optimization Potential:</span>
          <span class="metric-value">{formatScore(safeMetrics.optimizationPotential)}%</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">Storage Utilization:</span>
          <span class="metric-value">{formatScore(safeMetrics.storageUtilization)}%</span>
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

  .suggested-policies-section .section-description {
    margin: -0.5rem 0 0.75rem;
    color: var(--text-muted);
    font-size: 0.9rem;
    line-height: 1.4;
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

  .recommendations-overview {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--card-bg, rgba(255, 255, 255, 0.04));
    padding: 0.85rem 1rem;
    margin-bottom: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .overview-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 0.75rem;
  }

  .overview-metric {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.6rem 0.75rem;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
  }

  .overview-metric .metric-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .overview-metric .metric-value {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--text-color);
  }

  .overview-metric.total {
    border-color: rgba(76, 110, 245, 0.35);
    background: rgba(76, 110, 245, 0.12);
  }

  .overview-metric.critical {
    border-color: rgba(220, 53, 69, 0.4);
    background: rgba(220, 53, 69, 0.12);
  }

  .overview-metric.warning {
    border-color: rgba(255, 193, 7, 0.4);
    background: rgba(255, 193, 7, 0.12);
  }

  .overview-metric.advisory {
    border-color: rgba(23, 162, 184, 0.35);
    background: rgba(23, 162, 184, 0.12);
  }

  .overview-metric.quick-actions {
    border-color: rgba(40, 167, 69, 0.35);
    background: rgba(40, 167, 69, 0.12);
  }

  .overview-groups {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .overview-groups .metric-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .group-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .group-chip {
    font-size: 0.75rem;
    padding: 0.25rem 0.55rem;
    border-radius: 999px;
    background: rgba(76, 110, 245, 0.18);
    color: var(--accent-color);
  }

  .recommendation-item {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1rem;
    border-left: 4px solid;
    background: var(--card-bg, rgba(255, 255, 255, 0.03));
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .recommendation-item.rec-critical {
    border-left-color: var(--danger-color);
    background: rgba(220, 53, 69, 0.08);
  }

  .recommendation-item.rec-warning {
    border-left-color: var(--warning-color);
    background: rgba(255, 193, 7, 0.08);
  }

  .recommendation-item.rec-advisory {
    border-left-color: var(--info-color);
    background: rgba(23, 162, 184, 0.08);
  }

  .recommendation-item.rec-info {
    border-left-color: var(--text-muted);
    background: rgba(108, 117, 125, 0.06);
  }

  .recommendation-header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .recommendation-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    color: var(--text-color);
    min-width: 200px;
  }

  .recommendation-icon {
    font-size: 1.1rem;
  }

  .recommendation-meta {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .recommendation-tags {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .recommendation-tag {
    font-size: 0.7rem;
    padding: 0.25rem 0.5rem;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: rgba(0, 0, 0, 0.2);
    color: var(--text-color);
  }

  .recommendation-tag.group {
    background: rgba(76, 110, 245, 0.25);
    color: var(--accent-color);
  }

  .recommendation-tag.priority {
    background: rgba(60, 64, 67, 0.35);
  }

  .recommendation-tag.severity {
    background: rgba(220, 53, 69, 0.25);
    color: var(--danger-color);
  }

  .recommendation-tag.confidence {
    background: rgba(25, 135, 84, 0.25);
    color: var(--success-color);
  }

  .recommendation-tag.history {
    background: rgba(255, 193, 7, 0.25);
    color: var(--warning-color);
    cursor: help;
  }

  .recommendation-dismiss {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    transition: color 0.2s;
  }

  .recommendation-dismiss:hover {
    color: var(--danger-color);
  }

  .recommendation-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: var(--text-color);
    font-size: 0.95rem;
  }

  .recommendation-message {
    font-weight: 500;
  }

  .recommendation-details,
  .recommendation-impact,
  .recommendation-action,
  .recommendation-suggestion,
  .recommendation-metric {
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .recommendation-checklist {
    margin: 0.25rem 0 0;
    padding-left: 1.25rem;
    color: var(--text-muted);
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .recommendation-checklist li::marker {
    content: '• ';
    color: var(--accent-color);
  }

  .recommendation-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.5rem;
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

  .recommendations-empty {
    border: 1px dashed var(--border-color);
    border-radius: 8px;
    padding: 1.5rem;
    text-align: center;
    background: rgba(255, 255, 255, 0.02);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: center;
    justify-content: center;
  }

  .recommendations-empty .empty-icon {
    font-size: 2rem;
  }

  .recommendations-empty .empty-title {
    font-weight: 600;
    color: var(--text-color);
  }

  .recommendations-empty .empty-message {
    color: var(--text-muted);
    font-size: 0.9rem;
    max-width: 420px;
    margin: 0;
  }
</style>