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
  let windowSize = 'medium'; // 'small', 'medium', 'large', 'custom'
  let customWidth = 1200;
  let customHeight = 800;
  let currentVersion = 'v1.0.0'; // This will be loaded from the app
  let latestVersion = null;
  let updateStatus = 'checking'; // 'checking', 'up-to-date', 'available', 'error'
  
  // Window size presets
  const windowPresets = {
    small: { width: 1000, height: 700 },
    medium: { width: 1200, height: 800 },
    large: { width: 1400, height: 900 }
  };
  
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
        startOnStartup,
        windowSize,
        customWidth,
        customHeight
      };
      
    try {
      const result = await window.electron.invoke('save-app-settings', settings);
      
      if (result.success) {
        // Apply window settings immediately
        await applyWindowSettings();
      } else {
        console.error('Failed to save app settings:', result.error);
      }
    } catch (error) {
      console.error('Error saving app settings:', error);
    }
    
    closeModal();
  }
  
  // Apply window settings
  async function applyWindowSettings() {
    try {
      let width, height;
      
      if (windowSize === 'custom') {
        width = customWidth;
        height = customHeight;
      } else {
        const preset = windowPresets[windowSize];
        width = preset.width;
        height = preset.height;
      }
      
      await window.electron.invoke('set-window-size', {
        width,
        height,
        resizable: false // Always lock window size - no manual resizing
      });
      
      // Update content area width to match window size
      updateContentAreaWidth(width);
    } catch (error) {
      console.error('Error applying window settings:', error);
    }
  }
  
  // Update CSS variable for content area width based on window size
  function updateContentAreaWidth(windowWidth) {
    // Calculate content width: window width minus padding and margins
    // Account for: window padding, scrollbars, and content margins
    const contentWidth = Math.max(600, windowWidth - 200); // 200px for padding/margins to prevent scrolling
    
    // Update the CSS variable
    document.documentElement.style.setProperty('--content-area-width', `${contentWidth}px`);
    
    // Also ensure no horizontal scrolling on body/html
    document.documentElement.style.overflowX = 'hidden';
    document.body.style.overflowX = 'hidden';
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
  
  // Handle window resize for responsive modal
  function handleWindowResize() {
    if (!visible) return;
    
    // Force re-render by updating a reactive variable
    const windowWidth = window.innerWidth;
    if (windowWidth < 768) {
      // Mobile adjustments
      document.documentElement.style.setProperty('--modal-padding', '1rem');
    } else {
      // Desktop adjustments  
      document.documentElement.style.setProperty('--modal-padding', '1.5rem');
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
    // Don't call updateContentAreaOnOpen() here - it was causing size change bugs
  }

  async function loadCurrentSettings() {
    try {
      const result = await window.electron.invoke('get-app-settings');
      
      if (result.success) {
        minimizeToTray = result.settings.minimizeToTray || false;
        startMinimized = result.settings.startMinimized || false;
        startOnStartup = result.settings.startOnStartup || false;
        windowSize = result.settings.windowSize || 'medium';
        customWidth = result.settings.customWidth || 1200;
        customHeight = result.settings.customHeight || 800;
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

<svelte:window on:keydown={handleKeydown} on:resize={handleWindowResize} />

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

        <!-- Window & Display Settings -->
        <div class="settings-section">
          <h4>
            <span class="section-icon">🖥️</span>
            Window & Display
          </h4>
          
          <div class="setting-item">
            <label class="setting-label" for="window-size-select">
              <span class="setting-text">
                <strong>Window Size</strong>
                <small>Choose the size of the application window</small>
            </span>
            </label>
            <select bind:value={windowSize} class="size-select" id="window-size-select">
              <option value="small">Small (1000×700)</option>
              <option value="medium">Medium (1200×800)</option>
              <option value="large">Large (1400×900)</option>
              <option value="custom">Custom Size</option>
            </select>
          </div>
          
          {#if windowSize === 'custom'}
            <div class="custom-size-settings">
                             <div class="setting-item">
                 <label class="setting-label" for="custom-width-input">
                   <span class="setting-text">
                     <strong>Custom Width</strong>
                     <small>Width in pixels (minimum 800)</small>
                   </span>
                 </label>
                 <input 
                   type="number" 
                   bind:value={customWidth} 
                   min="800" 
                   max="2560"
                   class="size-input"
                   id="custom-width-input"
                 />
               </div>
              
                             <div class="setting-item">
                 <label class="setting-label" for="custom-height-input">
                   <span class="setting-text">
                     <strong>Custom Height</strong>
                     <small>Height in pixels (minimum 600)</small>
                   </span>
                 </label>
                 <input 
                   type="number" 
                   bind:value={customHeight} 
                   min="600" 
                   max="1440"
                   class="size-input"
                   id="custom-height-input"
                 />
               </div>
            </div>
                     {/if}
           
           <div class="setting-info">
             <small>💡 Window size is locked to prevent layout issues. Use the size dropdown to change dimensions.</small>
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
    width: min(90vw, 600px); /* Responsive width */
    max-width: 600px;
    max-height: 90vh;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    animation: slide-up 0.3s ease-out;
    border: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    flex-direction: column;
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
    font-size: clamp(1.25rem, 2.5vw, 1.5rem); /* Responsive font size */
    color: white;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  
  .settings-icon {
    font-size: clamp(1rem, 2vw, 1.25rem); /* Responsive icon size */
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
    flex: 1;
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
  
  .setting-info {
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 6px;
    padding: 0.75rem;
    margin-top: 0.5rem;
  }

  .setting-info small {
    color: #93c5fd;
    font-size: 0.85rem;
    line-height: 1.4;
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

  /* Window size settings */
  .size-select {
    width: 100%;
    padding: 0.5rem;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: #2d3748;
    color: white;
    font-size: 0.9rem;
    margin-top: 0.5rem;
  }

  .size-select:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
  }

  .custom-size-settings {
    margin-left: 1rem;
    padding-left: 1rem;
    border-left: 2px solid rgba(59, 130, 246, 0.3);
    margin-top: 1rem;
  }

  .size-input {
    width: 100%;
    padding: 0.5rem;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: #2d3748;
    color: white;
    font-size: 0.9rem;
    margin-top: 0.5rem;
  }

  .size-input:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
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