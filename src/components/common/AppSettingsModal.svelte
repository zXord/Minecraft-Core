<script>
  import { createEventDispatcher } from 'svelte';
  
  // Props
  export let visible = false;
  
  // Event dispatcher
  const dispatch = createEventDispatcher();
  
  // Settings state - these would eventually be stored persistently
  let minimizeToTray = false;
  let startMinimized = false;
  let startOnStartup = false;
  let currentVersion = 'v1.0.0'; // This will be loaded from the app
  let latestVersion = null;
  let updateStatus = 'checking'; // 'checking', 'up-to-date', 'available', 'error'
  
  // References for focus management
  let modalContent;
  let previousFocus;
  
  // Handle close modal
  function closeModal() {
    visible = false;
    dispatch('close');
  }
  
  // Handle save settings
  async function saveSettings() {
      const settings = {
        minimizeToTray,
        startMinimized,
        startOnStartup
      };
      
    try {
      const result = await window.electron.invoke('save-app-settings', settings);
      
      if (result.success) {
        // Settings saved successfully
      } else {
        console.error('Failed to save app settings:', result.error);
      }
    } catch (error) {
      console.error('Error saving app settings:', error);
    }
    
    closeModal();
  }
  
  // Check for updates
  async function checkForUpdates() {
    updateStatus = 'checking';
    try {
      const result = await window.electron.invoke('check-for-updates');
      if (result.success) {
        latestVersion = result.latestVersion;
        updateStatus = result.hasUpdate ? 'available' : 'up-to-date';
      } else {
        updateStatus = 'error';
      }
    } catch (error) {
      console.error('Error checking for updates:', error);
      updateStatus = 'error';
    }
  }
  
  // Handle escape key
  function handleKeydown(event) {
    if (!visible) return;
    
    if (event.key === 'Escape') {
      closeModal();
    }
  }
  
  // Focus management
  $: if (visible) {
    previousFocus = document.activeElement;
    setTimeout(() => {
      if (modalContent) {
        modalContent.focus();
      }
    }, 0);
  } else if (previousFocus) {
    previousFocus.focus();
  }

  // Load current settings and app version when modal opens
  $: if (visible) {
    loadCurrentSettings();
    loadAppVersion();
  }

  async function loadCurrentSettings() {
    try {
      const result = await window.electron.invoke('get-app-settings');
      
      if (result.success) {
        minimizeToTray = result.settings.minimizeToTray || false;
        startMinimized = result.settings.startMinimized || false;
        startOnStartup = result.settings.startOnStartup || false;
      }
    } catch (error) {
      console.error('Error loading app settings:', error);
    }
  }

  async function loadAppVersion() {
    try {
      const result = await window.electron.invoke('get-app-version');
      if (result.success) {
        currentVersion = result.version;
      }
    } catch (error) {
      console.error('Error loading app version:', error);
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if visible}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div 
    class="modal-backdrop" 
    on:click={(e) => e.target === e.currentTarget && closeModal()}
    role="dialog"
    aria-modal="true"
    aria-labelledby="app-settings-title"
    tabindex="-1"
  >
    <div
      class="modal-content"
      role="document"
      bind:this={modalContent}
      tabindex="-1"
    >
      <div class="modal-header">
        <h3 id="app-settings-title">
          <span class="settings-icon">⚙️</span>
          App Settings
        </h3>
        <button 
          class="close-button" 
          on:click={closeModal}
          aria-label="Close settings"
        >
          ✕
        </button>
      </div>
      
      <div class="modal-body">
        <!-- App Updates Section -->
        <div class="settings-section">
          <h4>
            <span class="section-icon">🔄</span>
            App Updates
          </h4>
          <div class="update-info">
            <div class="version-info">
              <span class="version-label">Current Version:</span>
              <span class="version-number">{currentVersion}</span>
            </div>
            {#if updateStatus === 'checking'}
              <div class="update-status checking">
                <span class="status-icon">⏳</span>
                Checking for updates...
              </div>
            {:else if updateStatus === 'up-to-date'}
              <div class="update-status up-to-date">
                <span class="status-icon">✅</span>
                You have the latest version
              </div>
            {:else if updateStatus === 'available'}
              <div class="update-status available">
                <span class="status-icon">📦</span>
                Update available: {latestVersion}
              </div>
            {:else if updateStatus === 'error'}
              <div class="update-status error">
                <span class="status-icon">❌</span>
                Failed to check for updates
              </div>
            {/if}
            <button class="update-button" on:click={checkForUpdates} disabled={updateStatus === 'checking'}>
              {updateStatus === 'checking' ? 'Checking...' : 'Check for Updates'}
            </button>
          </div>
        </div>

        <!-- System Tray & Startup Settings -->
        <div class="settings-section">
          <h4>
            <span class="section-icon">🚀</span>
            System & Startup
          </h4>
          
          <div class="setting-item">
            <label class="setting-label">
              <input 
                type="checkbox" 
                bind:checked={startOnStartup}
                class="setting-checkbox"
              />
              <span class="setting-text">
                <strong>Start on system startup</strong>
                <small>Launch Minecraft Core automatically when your computer starts</small>
              </span>
            </label>
          </div>
          
          <div class="setting-item">
            <label class="setting-label">
              <input 
                type="checkbox" 
                bind:checked={minimizeToTray}
                class="setting-checkbox"
              />
              <span class="setting-text">
                <strong>Minimize to system tray</strong>
                <small>When minimizing, hide to system tray instead of taskbar</small>
              </span>
            </label>
          </div>
          
          <div class="setting-item" class:disabled={!minimizeToTray}>
            <label class="setting-label">
              <input 
                type="checkbox" 
                bind:checked={startMinimized}
                disabled={!minimizeToTray}
                class="setting-checkbox"
              />
              <span class="setting-text">
                <strong>Start minimized to tray</strong>
                <small>Launch app in system tray instead of showing main window</small>
              </span>
            </label>
          </div>
        </div>

        <!-- Future Settings Placeholder -->
        <div class="settings-section">
          <h4>
            <span class="section-icon">🔧</span>
            Advanced
          </h4>
          <div class="setting-item">
            <span class="setting-placeholder">
              Additional app-wide settings will appear here as they are implemented
            </span>
          </div>
        </div>
      </div>
      
      <div class="modal-footer">
        <button 
          class="cancel-button" 
          on:click={closeModal}
          type="button"
        >
          Cancel
        </button>
        <button 
          class="save-button" 
          on:click={saveSettings}
          type="button"
        >
          Save Settings
        </button>
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
    z-index: 1000;
    display: flex;
    justify-content: center;
    align-items: center;
    animation: fade-in 0.2s ease-out;
  }
  
  .modal-content {
    background: #1e1e1e;
    border-radius: 8px;
    width: 90%;
    max-width: 600px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    animation: slide-up 0.3s ease-out;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  
  .modal-header {
    padding: 1.5rem 1.5rem 1rem 1.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .modal-header h3 {
    margin: 0;
    font-size: 1.5rem;
    color: white;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  
  .settings-icon {
    font-size: 1.25rem;
  }
  
  .close-button {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 4px;
    transition: all 0.2s;
  }
  
  .close-button:hover {
    color: white;
    background: rgba(255, 255, 255, 0.1);
  }
  
  .modal-body {
    padding: 1.5rem;
    max-height: 60vh;
    overflow-y: auto;
  }
  
  .settings-section {
    margin-bottom: 2rem;
  }
  
  .settings-section:last-child {
    margin-bottom: 0;
  }
  
  .settings-section h4 {
    margin: 0 0 1rem 0;
    color: #3b82f6;
    font-size: 1.1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(59, 130, 246, 0.2);
  }
  
  .section-icon {
    font-size: 1rem;
  }
  
  .setting-item {
    margin-bottom: 1rem;
    transition: opacity 0.2s;
  }
  
  .setting-item.disabled {
    opacity: 0.5;
  }
  
  .setting-label {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    cursor: pointer;
  }
  
  .setting-checkbox {
    margin: 0;
    transform: scale(1.2);
    accent-color: #3b82f6;
    flex-shrink: 0;
    margin-top: 0.15rem;
  }
  
  .setting-text {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .setting-text strong {
    color: white;
    font-size: 0.95rem;
  }
  
  .setting-text small {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.85rem;
    line-height: 1.3;
  }
  
  .setting-placeholder {
    color: rgba(255, 255, 255, 0.5);
    font-style: italic;
    font-size: 0.9rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    text-align: center;
  }

  /* Update section styles */
  .update-info {
    background: rgba(31, 41, 55, 0.4);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .version-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .version-label {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.9rem;
  }

  .version-number {
    color: white;
    font-weight: 600;
    font-family: monospace;
    background: rgba(59, 130, 246, 0.2);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.9rem;
  }

  .update-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    padding: 0.5rem;
    border-radius: 4px;
  }

  .update-status.checking {
    background: rgba(245, 158, 11, 0.1);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.3);
  }

  .update-status.up-to-date {
    background: rgba(16, 185, 129, 0.1);
    color: #10b981;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }

  .update-status.available {
    background: rgba(59, 130, 246, 0.1);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  .update-status.error {
    background: rgba(239, 68, 68, 0.1);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .status-icon {
    font-size: 1rem;
  }

  .update-button {
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    align-self: flex-start;
  }

  .update-button:hover:not(:disabled) {
    background: #2563eb;
  }

  .update-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  
  .modal-footer {
    padding: 1rem 1.5rem 1.5rem 1.5rem;
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }
  
  button {
    padding: 0.5rem 1.5rem;
    border-radius: 6px;
    border: none;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .cancel-button {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.8);
  }
  
  .cancel-button:hover {
    background: rgba(255, 255, 255, 0.15);
    color: white;
  }
  
  .save-button {
    background: #3b82f6;
    color: white;
  }
  
  .save-button:hover {
    background: #2563eb;
  }
  
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  
  @keyframes slide-up {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style> 