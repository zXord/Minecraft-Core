<script>
  import { createEventDispatcher } from 'svelte';
  import UpdateChecker from './UpdateChecker.svelte';
  
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

  // Browser control panel (served by management server)
  let browserPanelEnabled = false;
  let browserPanelAutoStart = false;
  let browserPanelPort = 8080;
  let browserPanelUsername = 'user';
  let browserPanelPassword = 'password';
  // Per-instance visibility (id -> boolean). Only server instances matter server-side.
  let instanceVisibility = {};
  let instances = [];
  
  // Browser panel status for Start/Stop UX (decoupled from management server)
  let panelIsRunning = false;
  let panelPort = null;
  let panelStatusText = 'Unknown';
  let panelError = '';
  let panelBusy = false;
  // Derived selection state for server visibility
  $: serverInstances = (instances || []).filter((i) => i.type === 'server');
  $: hasVisibleServers = serverInstances.some((s) => instanceVisibility[s.id] !== false);
  
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
        customHeight,
        browserPanel: {
          enabled: browserPanelEnabled,
          autoStart: browserPanelAutoStart,
          port: browserPanelPort,
          username: browserPanelUsername,
          password: browserPanelPassword,
          instanceVisibility
        }
      };
      
    try {
      const result = await window.electron.invoke('save-app-settings', settings);
      
      if (result.success) {
        // Apply window settings immediately
        await applyWindowSettings();
      } else {
        // TODO: Add proper logging - Failed to save app settings
      }
    } catch (error) {
      // TODO: Add proper logging - Error saving app settings
    }
    
    try {
      // Persist instance visibility separately to keep a lightweight IPC you can reuse elsewhere
      await window.electron.invoke('set-instance-visibility', instanceVisibility);
    } catch {}

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
      // TODO: Add proper logging - Error applying window settings
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

  // Load current settings when modal opens
  $: if (visible) {
    loadCurrentSettings();
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

        // Load browser panel settings
        const bp = result.settings.browserPanel || {};
  browserPanelEnabled = !!bp.enabled;
  browserPanelAutoStart = !!bp.autoStart;
        browserPanelPort = bp.port || 8080;
        browserPanelUsername = bp.username || 'user';
        browserPanelPassword = bp.password || 'password';
        instanceVisibility = bp.instanceVisibility || {};
      }
      // Load instances to let user choose which servers are visible
      try {
        instances = await window.electron.invoke('get-instances');
      } catch {}

  // Also refresh browser panel status
  await refreshPanelStatus();
    } catch (error) {
      // TODO: Add proper logging - Error loading app settings
    }
  }

  async function refreshPanelStatus() {
    try {
      const res = await window.electron.invoke('browser-panel:status');
      if (res && res.success && res.status) {
        panelIsRunning = !!res.status.isRunning;
        panelPort = res.status.port || null;
        panelStatusText = panelIsRunning ? `Running on port ${panelPort}` : 'Stopped';
      } else {
        panelIsRunning = false;
        panelPort = null;
        panelStatusText = 'Stopped';
      }
    } catch {
      panelIsRunning = false;
      panelPort = null;
      panelStatusText = 'Stopped';
    }
  }

  // Start/Stop the web panel (separate server)
  async function startWebPanel() {
    panelError = '';
    panelBusy = true;
    // Require at least one visible server
    if (!(instances || []).some(i => i.type === 'server' && instanceVisibility[i.id] !== false)) {
      panelBusy = false;
      panelError = 'Select at least one server under "Visible Server Instances" to start the web panel.';
      return;
    }
    // Persist port/creds changes without flipping enabled yet
    await saveSettingsLightweight(/*enabledOverride*/ null);
    // Try starting on configured port
    const res = await window.electron.invoke('browser-panel:start', { port: browserPanelPort });
    if (res && res.success) {
      browserPanelEnabled = true;
      await saveSettingsLightweight(/*enabledOverride*/ true);
    } else {
      panelError = (res && res.error) || 'Failed to start the web panel';
    }
    await refreshPanelStatus();
    panelBusy = false;
  }

  async function stopWebPanel() {
    panelError = '';
    panelBusy = true;
    const res = await window.electron.invoke('browser-panel:stop');
    if (res && res.success) {
      browserPanelEnabled = false;
      await saveSettingsLightweight(/*enabledOverride*/ false);
    } else {
      panelError = (res && res.error) || 'Failed to stop the web panel';
    }
    await refreshPanelStatus();
    panelBusy = false;
  }

  // Save only browser panel related settings without closing modal
  async function saveSettingsLightweight(enabledOverride = null) {
    const settings = {
      minimizeToTray,
      startMinimized,
      startOnStartup,
      windowSize,
      customWidth,
      customHeight,
      browserPanel: {
        enabled: enabledOverride === null ? browserPanelEnabled : !!enabledOverride,
        autoStart: browserPanelAutoStart,
        port: browserPanelPort,
        username: browserPanelUsername,
        password: browserPanelPassword,
        instanceVisibility
      }
    };
    try {
      await window.electron.invoke('save-app-settings', settings);
      // Persist instance visibility separately as done in full save
      try { await window.electron.invoke('set-instance-visibility', instanceVisibility); } catch {}
    } catch {}
  }

  async function openLogger() {
    try {
      // Import logger dynamically to avoid circular dependencies
      const { default: logger } = await import('../../utils/logger.js');
      const result = await logger.openWindow();
      
      if (!result.success) {
        // TODO: Add proper logging - Failed to open logger
      }
    } catch (error) {
      // TODO: Add proper logging - Error opening logger
    }
  }

  // Listen for live browser panel status updates
  if (typeof window !== 'undefined' && window.electron && window.electron.on) {
    window.electron.on('browser-panel-status', (_evt, payload) => {
      panelIsRunning = !!(payload && payload.isRunning);
      panelPort = payload && payload.port ? payload.port : panelPort;
      panelStatusText = panelIsRunning ? `Running on port ${panelPort}` : 'Stopped';
    });
  }

  async function openPanelInBrowser() {
    try {
      const url = `http://localhost:${panelPort || browserPanelPort}/`;
      const result = await window.electron.invoke('open-external-url', url);
      if (!result || !result.success) {
        await window.electron.invoke('show-error-dialog', { title: 'Open in Browser', message: 'Failed to open the web panel in your browser.', detail: result?.error || 'Unknown error' });
      }
    } catch (err) {
      try {
        await window.electron.invoke('show-error-dialog', { title: 'Open in Browser', message: 'Failed to open the web panel in your browser.', detail: err?.message });
      } catch {}
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} on:resize={handleWindowResize} />

{#if visible}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
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
          <UpdateChecker />
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

        <!-- Logging & Debugging Section -->
        <div class="settings-section">
          <h4>
            <span class="section-icon">📋</span>
            Logging & Debugging
          </h4>
          
          <div class="setting-item">
            <div class="setting-description">
              <span class="setting-text">
                <strong>Application Logger</strong>
                <small>View real-time application logs for troubleshooting and debugging. The logger captures system events, errors, and performance metrics from all application components.</small>
              </span>
            </div>
            <button 
              class="logger-button"
              on:click={openLogger}
              type="button"
            >
              <span class="logger-icon">📊</span>
              Open Logger
            </button>
          </div>
          
          <div class="setting-info">
            <small>💡 The logger opens in a separate window and provides real-time log streaming, filtering, search, and export capabilities.</small>
          </div>
        </div>

        <!-- Browser Control Panel (served by management server) -->
        <div class="settings-section compact-panel">
          <h4>
            <span class="section-icon">🌐</span>
            Browser Control Panel <span class="beta-badge" title="Early feature – still evolving">BETA</span>
          </h4>
          <div class="panel-header-row">
            <div class="panel-title">
              <small class="status">{panelStatusText}</small>
              {#if panelIsRunning}
                <button class="open-link small-btn" type="button" on:click={openPanelInBrowser}>Open in browser</button>
              {/if}
            </div>
            <div class="actions">
              <button class="start-button" on:click={startWebPanel} disabled={panelIsRunning || panelBusy || !hasVisibleServers} type="button">{panelBusy && !panelIsRunning ? 'Starting…' : 'Start'}</button>
              <button class="stop-button" on:click={stopWebPanel} disabled={!panelIsRunning || panelBusy} type="button">{panelBusy && panelIsRunning ? 'Stopping…' : 'Stop'}</button>
            </div>
          </div>
          {#if panelError}
            <div class="setting-info error"><small>{panelError}</small></div>
          {/if}
          {#if panelIsRunning && panelPort && browserPanelPort != panelPort}
            <div class="setting-info warning"><small>Panel is running on port {panelPort}. Change applies after Stop → Start.</small></div>
          {/if}

      <div class="panel-grid-3">
            <div>
              <label for="browser-port" class="field-label">Port</label>
              <input id="browser-port" type="number" min="1" max="65535" bind:value={browserPanelPort} class="size-input" placeholder="8081" disabled={panelIsRunning || panelBusy} />
            </div>
            <div>
              <label for="browser-username" class="field-label">User</label>
              <input id="browser-username" type="text" bind:value={browserPanelUsername} class="size-input" placeholder="user" disabled={panelIsRunning || panelBusy} />
            </div>
            <div>
              <label for="browser-password" class="field-label">Password</label>
              <input id="browser-password" type="password" bind:value={browserPanelPassword} class="size-input" placeholder="password" disabled={panelIsRunning || panelBusy} />
            </div>
          </div>

          <div class="setting-item">
            <label class="setting-label" for="browser-autostart">
              <span class="setting-text">
                <strong>Auto start on app launch</strong>
                <small>Start the browser control panel automatically when the desktop app starts</small>
              </span>
            </label>
            <input id="browser-autostart" type="checkbox" bind:checked={browserPanelAutoStart} disabled={!hasVisibleServers || panelIsRunning || panelBusy} title={!hasVisibleServers ? 'Select at least one server below' : (panelIsRunning ? 'Stop the panel to change this' : '')} />
          </div>

          <div class="setting-item">
            <div class="setting-label" style="cursor:default">
              <span class="setting-text">
                <strong>Visible Server Instances</strong>
                <small>Only server instances will show. Toggle which ones are visible on the web panel.</small>
              </span>
            </div>
            <div class="instance-list compact-list">
        {#each (instances || []).filter(i => i.type === 'server') as inst (inst.id)}
        <label class="instance-row">
      <input type="checkbox" checked={instanceVisibility[inst.id] !== false} disabled={panelIsRunning || panelBusy} on:change={(e) => { instanceVisibility = { ...instanceVisibility, [inst.id]: e.currentTarget.checked }; }} />
                  <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block;">
                    <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><strong>{inst.name}</strong></div>
                    <div class="small" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{inst.path}</div>
                  </span>
                </label>
              {/each}
              {#if (instances || []).filter(i => i.type === 'server').length === 0}
                <div class="setting-info"><small>No server instances found.</small></div>
              {/if}
              {#if ((instances || []).filter(i => i.type === 'server').length > 0) && !hasVisibleServers}
                <div class="setting-info warning" style="margin-top:0.5rem"><small>Select at least one server to enable Start.</small></div>
              {/if}
            </div>
          </div>
          <div class="setting-info"><small>Protected with HTTP Basic Auth. Change credentials above.</small></div>
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

  /* removed old .grid-2 layout (no longer used) */
  .instance-list { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .instance-row { display: flex; align-items: flex-start; gap: 0.6rem; }
  .instance-row input[type="checkbox"] { margin-top: 4px; accent-color: #3b82f6; }
  .small { font-size: 0.75rem; color: #9ca3af; }
  
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
  /* Web panel controls */
  .actions { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.25rem; }
  .start-button { background: #10b981; color: #fff; border: none; padding: 0.4rem 0.75rem; border-radius: 6px; cursor: pointer; }
  .stop-button { background: #ef4444; color: #fff; border: none; padding: 0.4rem 0.75rem; border-radius: 6px; cursor: pointer; }
  .start-button:disabled, .stop-button:disabled { opacity: 0.6; cursor: not-allowed; }
  .setting-info.error { color: #ef4444; background: rgba(239, 68, 68, 0.08); border-color: rgba(239, 68, 68, 0.4); }
  .setting-info.warning { color: #f59e0b; background: rgba(245, 158, 11, 0.08); border-color: rgba(245, 158, 11, 0.4); }
  .open-link { color: #60a5fa; text-decoration: none; }
  .open-link:hover { text-decoration: underline; }
  
  /* Compact Browser Control Panel layout */
  .compact-panel .panel-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .compact-panel .panel-title { display: flex; align-items: center; gap: 0.5rem; }
  .compact-panel .panel-title .status { color: #9ca3af; margin-left: 0.25rem; }
  .compact-panel .panel-grid-3 {
    display: grid;
    grid-template-columns: 120px minmax(160px, 1fr) minmax(170px, 1.1fr);
    gap: 0.6rem;
    margin: 0.25rem 0 0.75rem 0;
  }
  /* Responsive collapse to avoid placeholder overlapping */
  @media (max-width: 640px) {
    .compact-panel .panel-grid-3 { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  }
  @media (max-width: 480px) {
    .compact-panel .panel-grid-3 { grid-template-columns: 1fr; }
  }
  .field-label { display: block; font-size: 0.75rem; color: #cbd5e1; }
  .small-btn { padding: 0.2rem 0.45rem; font-size: 0.8rem; }
  .compact-list { gap: 0.3rem; }
  /* Compact inputs in panel */
  .compact-panel .size-input {
    padding: 0.4rem 0.55rem;
    font-size: 0.85rem;
    border-radius: 5px;
    margin-top: 0.4rem;
    width: 100%;
    box-sizing: border-box;
  }
  .compact-panel .size-input::placeholder { color: #9aa1ad; opacity: 0.85; }
  .compact-panel .panel-grid-3 > div { min-width: 0; position: relative; }
  /* Prevent visual collision of long placeholder strings by allowing them to fade */
  .compact-panel .size-input {
    background: linear-gradient(to right, rgba(45,55,72,1), rgba(45,55,72,0.9));
  }
  /* Badge */
  .beta-badge {
    display: inline-block;
    background: linear-gradient(90deg,#6366f1,#3b82f6);
    color: #fff;
    font-size: 0.55rem;
    font-weight: 600;
    padding: 0.15rem 0.4rem 0.2rem 0.4rem;
    border-radius: 4px;
    letter-spacing: 0.5px;
    vertical-align: middle;
    position: relative;
    top: -1px;
  }
  .compact-panel .actions .start-button,
  .compact-panel .actions .stop-button {
    padding: 0.3rem 0.6rem;
    font-size: 0.85rem;
    border-radius: 5px;
  }
  .compact-panel .panel-title .status { font-size: 0.8rem; }
  /* Compact checkboxes */
  .compact-panel input[type="checkbox"] {
    transform: scale(1.0);
    margin-top: 0.1rem;
  }
  .compact-panel .instance-row { gap: 0.5rem; }
  .compact-panel .instance-row .small { font-size: 0.7rem; }




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

  /* Logger section styles */
  .setting-description {
    margin-bottom: 1rem;
  }

  .logger-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    background: linear-gradient(135deg, #3b82f6, #1d4ed8);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);
  }

  .logger-button:hover {
    background: linear-gradient(135deg, #2563eb, #1e40af);
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(59, 130, 246, 0.4);
  }

  .logger-button:active {
    transform: translateY(0);
    box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);
  }

  .logger-icon {
    font-size: 1.1rem;
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