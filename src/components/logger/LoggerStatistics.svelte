<script>
  import { createEventDispatcher } from 'svelte';

  export let stats = {};
  export let visible = false;
  export let totalLogs = 0;
  export let filteredLogs = 0;

  const dispatch = createEventDispatcher();

  function closeModal() {
    visible = false;
    dispatch('close');
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && visible) {
      closeModal();
    }
  }

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) {
      closeModal();
    }
  }

  // Calculate percentages for levels
  function calculatePercentage(count, total) {
    return total > 0 ? ((count / total) * 100).toFixed(1) : 0;
  }

  // Get level color
  function getLevelColor(level) {
    const colors = {
      debug: '#6b7280',
      info: '#3b82f6',
      warn: '#f59e0b',
      error: '#ef4444',
      fatal: '#7f1d1d'
    };
    return colors[level] || colors.info;
  }

  // Sort levels by severity
  function getSortedLevels() {
    const levelOrder = ['fatal', 'error', 'warn', 'info', 'debug'];
    const levels = Object.entries(stats.levels || {});
    return levels.sort((a, b) => {
      const aIndex = levelOrder.indexOf(a[0]);
      const bIndex = levelOrder.indexOf(b[0]);
      return aIndex - bIndex;
    });
  }

  // Get top categories
  function getTopCategories() {
    const categories = Object.entries(stats.categories || {});
    return categories.sort((a, b) => b[1] - a[1]).slice(0, 10);
  }

  // Get top instances
  function getTopInstances() {
    const instances = Object.entries(stats.instances || {});
    return instances.sort((a, b) => b[1] - a[1]).slice(0, 10);
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if visible}
  <div class="modal-backdrop" on:click={handleBackdropClick} on:keydown={handleKeydown} role="presentation">
    <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="stats-modal-title">
              <div class="modal-header">
          <h2 id="stats-modal-title">Logger Statistics</h2>
          <button class="close-button" on:click={closeModal} aria-label="Close statistics modal">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256">
            <path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path>
          </svg>
        </button>
      </div>

      <div class="modal-body">
        <!-- Overview Section -->
        <div class="stats-section">
          <h3>Overview</h3>
          <div class="stats-grid">
            <div class="stat-item">
              <div class="stat-number">{totalLogs.toLocaleString()}</div>
              <div class="stat-label">Total Logs</div>
            </div>
            <div class="stat-item">
              <div class="stat-number">{filteredLogs.toLocaleString()}</div>
              <div class="stat-label">Filtered Logs</div>
            </div>
            <div class="stat-item">
              <div class="stat-number">{Object.keys(stats.levels || {}).length}</div>
              <div class="stat-label">Log Levels</div>
            </div>
            <div class="stat-item">
              <div class="stat-number">{Object.keys(stats.categories || {}).length}</div>
              <div class="stat-label">Categories</div>
            </div>
          </div>
        </div>

        <!-- Log Levels Section -->
        <div class="stats-section">
          <h3>Log Levels</h3>
          <div class="levels-chart">
            {#each getSortedLevels() as [level, count]}
              <div class="level-item">
                <div class="level-info">
                  <div class="level-indicator" style="background-color: {getLevelColor(level)}"></div>
                  <span class="level-name">{level.charAt(0).toUpperCase() + level.slice(1)}</span>
                </div>
                <div class="level-stats">
                  <div class="level-count">{count.toLocaleString()}</div>
                  <div class="level-percentage">{calculatePercentage(count, totalLogs)}%</div>
                </div>
                <div class="level-bar">
                  <div 
                    class="level-fill" 
                    style="width: {calculatePercentage(count, totalLogs)}%; background-color: {getLevelColor(level)}"
                  ></div>
                </div>
              </div>
            {/each}
          </div>
        </div>

        <!-- Categories Section -->
        <div class="stats-section">
          <h3>Top Categories</h3>
          <div class="category-list">
            {#each getTopCategories() as [category, count]}
              <div class="category-item">
                <div class="category-name">{category}</div>
                <div class="category-count">{count.toLocaleString()} logs</div>
              </div>
            {/each}
          </div>
        </div>

        <!-- Instances Section -->
        <div class="stats-section">
          <h3>Top Instances</h3>
          <div class="instance-list">
            {#each getTopInstances() as [instance, count]}
              <div class="instance-item">
                <div class="instance-name">{instance}</div>
                <div class="instance-count">{count.toLocaleString()} logs</div>
              </div>
            {/each}
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="close-modal-button" on:click={closeModal}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-content {
    background: #182634;
    border-radius: 0.75rem;
    max-width: 800px;
    width: 90%;
    max-height: 80vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border: 1px solid #314d68;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.5rem;
    border-bottom: 1px solid #314d68;
  }

  .modal-header h2 {
    color: white;
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }

  .close-button {
    background: none;
    border: none;
    color: #90adcb;
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 0.375rem;
    transition: all 0.2s;
  }

  .close-button:hover {
    background: #223649;
    color: white;
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem;
  }

  .stats-section {
    margin-bottom: 2rem;
  }

  .stats-section:last-child {
    margin-bottom: 0;
  }

  .stats-section h3 {
    color: white;
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    font-weight: 600;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
  }

  .stat-item {
    background: #223649;
    border-radius: 0.5rem;
    padding: 1rem;
    text-align: center;
  }

  .stat-number {
    font-size: 1.5rem;
    font-weight: bold;
    color: white;
    margin-bottom: 0.25rem;
  }

  .stat-label {
    color: #90adcb;
    font-size: 0.875rem;
  }

  .levels-chart {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .level-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem;
    background: #223649;
    border-radius: 0.5rem;
  }

  .level-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 80px;
  }

  .level-indicator {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }

  .level-name {
    color: white;
    font-weight: 500;
  }

  .level-stats {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 100px;
  }

  .level-count {
    color: white;
    font-weight: 600;
  }

  .level-percentage {
    color: #90adcb;
    font-size: 0.875rem;
  }

  .level-bar {
    flex: 1;
    height: 8px;
    background: #314d68;
    border-radius: 4px;
    overflow: hidden;
  }

  .level-fill {
    height: 100%;
    transition: width 0.3s ease;
  }

  .category-list,
  .instance-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .category-item,
  .instance-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem;
    background: #223649;
    border-radius: 0.5rem;
  }

  .category-name,
  .instance-name {
    color: white;
    font-weight: 500;
  }

  .category-count,
  .instance-count {
    color: #90adcb;
    font-size: 0.875rem;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    padding: 1.5rem;
    border-top: 1px solid #314d68;
  }

  .close-modal-button {
    background: #0c7ff2;
    border: none;
    border-radius: 0.5rem;
    color: white;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .close-modal-button:hover {
    background: #0369a1;
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .modal-content {
      width: 95%;
      max-height: 90vh;
    }

    .stats-grid {
      grid-template-columns: repeat(2, 1fr);
    }

    .level-item {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .level-stats {
      align-self: flex-end;
    }

    .level-bar {
      width: 100%;
    }
  }
</style> 