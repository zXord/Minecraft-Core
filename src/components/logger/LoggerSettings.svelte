<script>
  import { createEventDispatcher } from 'svelte';

  export let visible = false;
  export let settings = {
    autoScroll: true,
    maxLogs: 1000,
    logLevel: 'all',
    exportFormat: 'json',
    realTimeStreaming: true,
    showTimestamps: true,
    showCategories: true,
    showInstances: true
  };

  const dispatch = createEventDispatcher();

  function closeModal() {
    visible = false;
    dispatch('close');
  }

  function saveSettings() {
    dispatch('save', settings);
    closeModal();
  }

  function resetSettings() {
    settings = {
      autoScroll: true,
      maxLogs: 1000,
      logLevel: 'all',
      exportFormat: 'json',
      realTimeStreaming: true,
      showTimestamps: true,
      showCategories: true,
      showInstances: true
    };
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

  const logLevels = [
    { value: 'all', label: 'All Levels' },
    { value: 'debug', label: 'Debug & Above' },
    { value: 'info', label: 'Info & Above' },
    { value: 'warn', label: 'Warning & Above' },
    { value: 'error', label: 'Error & Above' },
    { value: 'fatal', label: 'Fatal Only' }
  ];

  const exportFormats = [
    { value: 'json', label: 'JSON' },
    { value: 'csv', label: 'CSV' },
    { value: 'txt', label: 'Plain Text' }
  ];

  const maxLogsOptions = [
    { value: 100, label: '100 logs' },
    { value: 500, label: '500 logs' },
    { value: 1000, label: '1,000 logs' },
    { value: 2000, label: '2,000 logs' },
    { value: 5000, label: '5,000 logs' },
    { value: 10000, label: '10,000 logs' }
  ];
</script>

<svelte:window on:keydown={handleKeydown} />

{#if visible}
  <div class="modal-backdrop" on:click={handleBackdropClick} on:keydown={handleKeydown} role="presentation">
    <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
      <div class="modal-header">
        <h2 id="settings-modal-title">Logger Settings</h2>
        <button class="close-button" on:click={closeModal} aria-label="Close settings modal">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 256 256">
            <path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path>
          </svg>
        </button>
      </div>

      <div class="modal-body">
        <!-- Display Settings -->
        <div class="settings-section">
          <h3>Display Settings</h3>
          <div class="setting-group">
            <label class="setting-item">
              <input type="checkbox" bind:checked={settings.autoScroll} />
              <span class="setting-label">Auto-scroll to new logs</span>
              <span class="setting-description">Automatically scroll to the newest log entries</span>
            </label>
            
            <label class="setting-item">
              <input type="checkbox" bind:checked={settings.showTimestamps} />
              <span class="setting-label">Show timestamps</span>
              <span class="setting-description">Display timestamp column in log table</span>
            </label>
            
            <label class="setting-item">
              <input type="checkbox" bind:checked={settings.showCategories} />
              <span class="setting-label">Show categories</span>
              <span class="setting-description">Display category column in log table</span>
            </label>
            
            <label class="setting-item">
              <input type="checkbox" bind:checked={settings.showInstances} />
              <span class="setting-label">Show instances</span>
              <span class="setting-description">Display instance column in log table</span>
            </label>
          </div>
        </div>

        <!-- Performance Settings -->
        <div class="settings-section">
          <h3>Performance Settings</h3>
          <div class="setting-group">
            <label class="setting-item">
              <input type="checkbox" bind:checked={settings.realTimeStreaming} />
              <span class="setting-label">Real-time streaming</span>
              <span class="setting-description">Receive new logs in real-time</span>
            </label>
            
            <div class="setting-item">
              <span class="setting-label">Maximum logs in memory</span>
              <span class="setting-description">Limit the number of logs kept in memory for performance</span>
              <select bind:value={settings.maxLogs} class="setting-select">
                {#each maxLogsOptions as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </div>
          </div>
        </div>

        <!-- Filter Settings -->
        <div class="settings-section">
          <h3>Default Filter Settings</h3>
          <div class="setting-group">
            <div class="setting-item">
              <span class="setting-label">Default log level filter</span>
              <span class="setting-description">Default log level to show when opening logger</span>
              <select bind:value={settings.logLevel} class="setting-select">
                {#each logLevels as level}
                  <option value={level.value}>{level.label}</option>
                {/each}
              </select>
            </div>
          </div>
        </div>

        <!-- Export Settings -->
        <div class="settings-section">
          <h3>Export Settings</h3>
          <div class="setting-group">
            <div class="setting-item">
              <span class="setting-label">Default export format</span>
              <span class="setting-description">Default file format for log exports</span>
              <select bind:value={settings.exportFormat} class="setting-select">
                {#each exportFormats as format}
                  <option value={format.value}>{format.label}</option>
                {/each}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="reset-button" on:click={resetSettings}>Reset to Defaults</button>
        <div class="footer-actions">
          <button class="cancel-button" on:click={closeModal}>Cancel</button>
          <button class="save-button" on:click={saveSettings}>Save Settings</button>
        </div>
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
    max-width: 700px;
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
    padding: 1rem;
  }

  .settings-section {
    margin-bottom: 1rem;
  }

  .settings-section:last-child {
    margin-bottom: 0;
  }

  .settings-section h3 {
    color: white;
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    font-weight: 600;
  }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .setting-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem;
    background: #223649;
    border-radius: 0.5rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .setting-item:hover {
    background: #2a3f56;
  }

  .setting-item input[type="checkbox"] {
    width: 20px;
    height: 20px;
    margin-right: 0.75rem;
    accent-color: #0c7ff2;
  }

  .setting-label {
    color: white;
    font-weight: 500;
    font-size: 0.9rem;
  }

  .setting-description {
    color: #90adcb;
    font-size: 0.8rem;
    margin-top: 0.25rem;
  }

  .setting-select {
    background: #314d68;
    border: 1px solid #3f5a7a;
    border-radius: 0.375rem;
    color: white;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    outline: none;
    transition: border-color 0.2s;
    margin-top: 0.5rem;
  }

  .setting-select:focus {
    border-color: #0c7ff2;
  }

  .setting-select option {
    background: #223649;
    color: white;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.5rem;
    border-top: 1px solid #314d68;
  }

  .footer-actions {
    display: flex;
    gap: 0.75rem;
  }

  .reset-button {
    background: #6b7280;
    border: none;
    border-radius: 0.5rem;
    color: white;
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .reset-button:hover {
    background: #4b5563;
  }

  .cancel-button {
    background: #374151;
    border: none;
    border-radius: 0.5rem;
    color: white;
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .cancel-button:hover {
    background: #4b5563;
  }

  .save-button {
    background: #0c7ff2;
    border: none;
    border-radius: 0.5rem;
    color: white;
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .save-button:hover {
    background: #0369a1;
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .modal-content {
      width: 95%;
      max-height: 90vh;
    }

    .modal-footer {
      flex-direction: column;
      gap: 1rem;
      align-items: stretch;
    }

    .footer-actions {
      justify-content: center;
    }
  }
</style> 