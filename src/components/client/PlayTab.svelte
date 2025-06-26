<script>
  import { clientState } from '../../stores/clientStore.js';
  export let authStatus;
  export let authenticateWithMicrosoft;
  export let checkAuthentication;
  export let username;
  export let authData;
  export let serverInfo;
  export let requiredMods = [];
  export let clientSyncStatus;
  export let clientSyncInfo;
  export let downloadStatus;
  export let modSyncStatus;
  export let filteredAcknowledgments = [];
  export let downloadClient;
  export let onDownloadModsClick;
  export let onAcknowledgeAllDependencies;
  export let maxMemory;
  export let isLaunching;
  export let launchStatus;
  export let launchMinecraft;
  export let stopMinecraft;
  export let launchProgress;
  export let downloadProgress;
  export let downloadSpeed;
  export let currentDownloadFile;
  export let fileProgress;
  export let clientDownloadProgress;
  export let handleRefreshFromDashboard;  export let lastCheck;
  export let isChecking;
  // Debug terminal toggle setting
  let showDebugTerminal = false;
  
  // Load debug terminal setting from localStorage
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('minecraft-debug-terminal');
    showDebugTerminal = saved === 'true';
  }
  
  // Reactive statement to save debug terminal setting when changed
  $: if (typeof window !== 'undefined') {
    localStorage.setItem('minecraft-debug-terminal', showDebugTerminal.toString());
  }
  
  // Modified launch function that passes debug terminal setting
  function launchMinecraftWithDebug() {
    launchMinecraft(showDebugTerminal);
  }

</script>

      <div class="client-main">
        <!-- Compact Status Header -->
        <div class="status-header-container">
          <div class="connection-card">
            <div class="compact-status-item">
              <div class="status-dot {$clientState.connectionStatus}"></div>
              <div class="status-info">
                <span class="status-label">Management</span>
                <code class="server-address">localhost:8080</code>
              </div>
              <span class="connection-text {$clientState.connectionStatus}">
                {$clientState.connectionStatus === 'connected' ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </div>

          <div class="server-card">
            <div class="compact-status-item">
              <div class="status-dot {$clientState.minecraftServerStatus}"></div>
              <div class="status-info">
                <span class="status-label">Minecraft Server</span>
              </div>
              <span class="server-status {$clientState.minecraftServerStatus}">
                {$clientState.minecraftServerStatus === 'running' ? 'Running' : 'Stopped'}
              </span>
            </div>
          </div>
        </div>

        <div class="client-status">
          {#if $clientState.connectionStatus !== 'connected'}
            <div class="connection-status-display">
              <h2>Connecting to Server</h2>
              <p>Attempting to connect to the management server...</p>
            </div>
          {:else if authStatus === 'needs-auth'}
            <div class="auth-section">
              <h2>Microsoft Authentication Required</h2>
              <p>You need to authenticate with your Microsoft account to play Minecraft.</p>
              <button class="auth-button" on:click={authenticateWithMicrosoft}>
                🔑 Login with Microsoft
              </button>
            </div>
          {:else if authStatus === 'authenticating'}
            <div class="auth-section">
              <h2>Authenticating...</h2>
              <p>Please complete the authentication process in your browser.</p>
              <p style="font-size: 0.9rem; color: #9ca3af; margin-top: 1rem;">
                If the browser closed but this message remains, the authentication may have succeeded.
              </p>
              <div style="display: flex; gap: 1rem; justify-content: center; margin-top: 1rem;">
                <button class="auth-button" on:click={checkAuthentication}>
                  🔄 Check Authentication
                </button>
                <button class="auth-button" on:click={() => { authStatus = 'needs-auth'; }}>
                  ❌ Reset
                </button>
              </div>
            </div>
          {:else if authStatus === 'authenticated' || (username && authData) || (username && username.length > 0)}
            <!-- Compact Game Information and Controls -->
            <div class="game-info-compact">
              <!-- Dynamic Status Header with User Info -->
              <div class="ready-header">
                <h2 class="status-header {
                  $clientState.minecraftServerStatus !== 'running' ? 'waiting' :
                  clientSyncStatus !== 'ready' ? 'needs-client' :
                  downloadStatus !== 'ready' ? 'needs-mods' : 'ready'
                }">
                  {#if $clientState.minecraftServerStatus !== 'running'}
                    ⏸️ Waiting for Server
                  {:else if clientSyncStatus !== 'ready'}
                    📥 Client Download Required
                  {:else if downloadStatus !== 'ready'}
                    🔄 Mods Need Update
                  {:else}
                    🚀 Ready to Play
                  {/if}
                </h2>
                <div class="player-info-inline">
                  <span class="player-label">Logged in as:</span>
                  <span class="player-name">{username}</span>
                </div>
              </div>
              
              <!-- Compact Server Info Card -->
              {#if serverInfo}
                <div class="server-info-compact">
                  <div class="server-detail-card">
                    <span class="detail-label">Server</span>
                    <span class="detail-value">{serverInfo.serverInfo?.name || 'A Minecraft Server'}</span>
                  </div>
                  <div class="divider"></div>
                  <div class="server-detail-card">
                    <span class="detail-label">Version</span>
                    <span class="detail-value">
                      {#if serverInfo.loaderType && serverInfo.loaderType !== 'vanilla'}
                        {serverInfo.loaderType}/{serverInfo.minecraftVersion || 'Unknown'}
                        {#if serverInfo.loaderVersion}
                          <span class="loader-version">({serverInfo.loaderVersion})</span>
                        {/if}
                      {:else}
                        {serverInfo.minecraftVersion || 'Unknown'}
                      {/if}
                    </span>
                  </div>
                  <div class="divider"></div>
                  <div class="server-detail-card">
                    <span class="detail-label">Required Mods</span>
                    <span class="detail-value">{requiredMods.length}</span>
                  </div>
                </div>
              {/if}
              
              <!-- Compact Status Indicators -->
              <div class="status-row">
                <!-- Client Status -->
                {#if clientSyncStatus === 'checking'}
                  <div class="status-indicator checking">
                    ⏳ <span>Checking Client Files...</span>
                  </div>
                {:else if clientSyncStatus === 'needed'}
                  <div class="status-indicator needed">
                    ❌ <span>Client Files Need Download</span>
                  </div>
                {:else if clientSyncStatus === 'downloading'}
                  <div class="status-indicator downloading">
                    📥 <span>Downloading Client ({Math.round((clientDownloadProgress.current / clientDownloadProgress.total) * 100) || 0}%)</span>
                  </div>
                {:else if clientSyncStatus === 'ready'}
                  <div class="status-indicator ready">
                    ✅ <span>Client Files Ready</span>
                  </div>
                {/if}

                <!-- Mod Status -->
                {#if downloadStatus === 'checking'}
                  <div class="status-indicator checking">
                    ⏳ <span>Checking Mods...</span>
                  </div>
                {:else if downloadStatus === 'needed'}
                  <div class="status-indicator needed">
                    ❌ <span>Mods Need Update</span>
                  </div>
                {:else if downloadStatus === 'downloading'}
                  <div class="status-indicator downloading">
                    📥 <span>Downloading Mods ({downloadProgress}%)</span>
                  </div>
                {:else if downloadStatus === 'checking-updates'}
                  <div class="status-indicator ready">
                    ✅ <span>All Required Mods Ready</span>
                  </div>
                {:else if downloadStatus === 'ready'}
                  <div class="status-indicator ready">
                    ✅ <span>All Required Mods Ready</span>
                    {#if modSyncStatus && ((modSyncStatus.missingOptionalMods && modSyncStatus.missingOptionalMods.length > 0) || (modSyncStatus.outdatedOptionalMods && modSyncStatus.outdatedOptionalMods.length > 0))}
                      {@const totalOptionalWork = (modSyncStatus.missingOptionalMods?.length || 0) + (modSyncStatus.outdatedOptionalMods?.length || 0)}
                      <button 
                        class="optional-indicator" 
                        on:click={() => $clientState.activeTab = 'mods'}
                        title="{totalOptionalWork} optional mod{totalOptionalWork > 1 ? 's' : ''} {modSyncStatus.missingOptionalMods?.length > 0 ? 'available' : 'need updates'}"
                      >
                        ℹ️ {totalOptionalWork}
                      </button>
                    {/if}
                  </div>
                {:else if downloadStatus === 'error'}
                  <div class="status-indicator error">
                    ❌ <span>Mod Check Failed</span>
                  </div>
                {/if}
              </div>

              <!-- Detailed Status Sections (when needed) -->
              {#if clientSyncStatus === 'needed'}
                <div class="detail-section">
                  <h3>Client Files Need Download</h3>
                  {#if clientSyncInfo}
                    <p>{clientSyncInfo.reason}</p>
                    {#if clientSyncInfo.needsJava}
                      <p><strong>Java {clientSyncInfo.requiredJavaVersion} will be automatically downloaded and installed.</strong></p>
                    {/if}
                  {/if}
                  <p>Minecraft {serverInfo?.minecraftVersion || 'Unknown'} client files are required.</p>
                  <button class="action-button" on:click={downloadClient}>
                    📥 Download Minecraft Client {clientSyncInfo?.needsJava ? '& Java' : ''}
                  </button>
                </div>
              {:else if clientSyncStatus === 'downloading'}
                <div class="detail-section">
                  <h3>Downloading Minecraft Client</h3>
                  <div class="progress-container">
                    <p>{clientDownloadProgress.type}: {clientDownloadProgress.task}</p>
                    {#if clientDownloadProgress.total > 0}
                      <div class="progress-bar">
                        <div class="progress-fill" style="width: {Math.round((clientDownloadProgress.current / clientDownloadProgress.total) * 100)}%"></div>
                      </div>
                      {#if clientDownloadProgress.type === 'Downloading' && clientDownloadProgress.totalMB}
                        <p class="progress-text">{clientDownloadProgress.current || 0} MB / {clientDownloadProgress.total} MB</p>
                      {/if}
                    {/if}
                  </div>
                </div>
              {/if}

              {#if downloadStatus === 'needed'}
                <div class="detail-section">
                  <!-- Show mod sync details when needed -->
                  {#if modSyncStatus}
                    {@const totalUpdatesNeeded = (modSyncStatus.missingMods?.length || 0) + (modSyncStatus.outdatedMods?.length || 0) + (modSyncStatus.outdatedOptionalMods?.length || 0) + (modSyncStatus.clientModUpdates?.length || 0)}
                    {@const actualRemovals = [...(modSyncStatus.requiredRemovals || []), ...(modSyncStatus.optionalRemovals || [])]}
                    {@const acknowledgments = filteredAcknowledgments || []}
                    
                    <h3>Mods Need Update ({totalUpdatesNeeded})</h3>
                    
                    <!-- Compact mod lists -->
                    {#if modSyncStatus.outdatedMods && modSyncStatus.outdatedMods.length > 0}
                      <div class="compact-mod-section">
                        <h4>📦 Required Updates:</h4>
                        <div class="compact-mod-list">
                          {#each modSyncStatus.outdatedMods as update, index (update.name || update.fileName || `req-update-${index}`)}
                            <div class="compact-mod-item">
                              <span class="mod-name">{update.name || update.fileName || 'Unknown Mod'}</span>
                              <span class="version-badge">v{update.currentVersion} → v{update.newVersion}</span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/if}

                    {#if modSyncStatus.outdatedOptionalMods && modSyncStatus.outdatedOptionalMods.length > 0}
                      <div class="compact-mod-section">
                        <h4>🔄 Optional Updates:</h4>
                        <div class="compact-mod-list">
                          {#each modSyncStatus.outdatedOptionalMods as update, index (update.name || update.fileName || `opt-update-${index}`)}
                            <div class="compact-mod-item optional">
                              <span class="mod-name">{update.name || update.fileName || 'Unknown Mod'}</span>
                              <span class="version-badge">v{update.currentVersion} → v{update.newVersion}</span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/if}

                    {#if modSyncStatus.clientModUpdates && modSyncStatus.clientModUpdates.length > 0}
                      <div class="compact-mod-section">
                        <h4>📱 Client Mod Updates:</h4>
                        <div class="compact-mod-list">
                          {#each modSyncStatus.clientModUpdates as update, index (update.name || update.fileName || `client-update-${index}`)}
                            <div class="compact-mod-item client-mod">
                              <span class="mod-name">{update.name || update.fileName || 'Unknown Mod'}</span>
                              <span class="version-badge">v{update.currentVersion} → v{update.newVersion}</span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/if}

                    {#if modSyncStatus.missingMods && modSyncStatus.missingMods.length > 0}
                      <div class="compact-mod-section">
                        <h4>📥 New Required:</h4>
                        <div class="compact-mod-list">
                          {#each modSyncStatus.missingMods as modName (modName)}
                            <div class="compact-mod-item new-download">
                              <span class="mod-name">{modName}</span>
                              <span class="new-badge">NEW</span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/if}

                    {#if actualRemovals.length > 0}
                      <div class="compact-mod-section">
                        <h4>❌ To be Removed:</h4>
                        <div class="compact-mod-list">
                          {#each actualRemovals as removal (removal.fileName)}
                            <div class="compact-mod-item removal">
                              <span class="mod-name">{removal.fileName}</span>
                              <span class="removal-badge">{removal.reason || 'no longer required'}</span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/if}
                    
                    {#if acknowledgments.length > 0}
                      <div class="compact-mod-section">
                        <h4>🔗 Need Acknowledgment:</h4>
                        <div class="compact-mod-list">
                          {#each acknowledgments as ack (ack.fileName)}
                            <div class="compact-mod-item acknowledgment">
                              <span class="mod-name">{ack.fileName}</span>
                              <span class="dependency-badge">{ack.reason || 'required as dependency'}</span>
                            </div>
                          {/each}
                        </div>
                      </div>
                    {/if}
                    
                    <!-- Action buttons -->
                    <div class="mod-actions-compact">
                    {#if totalUpdatesNeeded > 0}
                        <button class="mod-action-btn primary" on:click={onDownloadModsClick}>
                          📥 Download & Update ({totalUpdatesNeeded})
                      </button>
                    {:else if actualRemovals.length > 0}
                        <button class="mod-action-btn primary" on:click={onDownloadModsClick}>
                          🔄 Apply Changes ({actualRemovals.length})
                      </button>
                    {/if}
                    
                    {#if acknowledgments.length > 0}
                        <button class="mod-action-btn acknowledge" on:click={onAcknowledgeAllDependencies}>
                          ✓ Acknowledge ({acknowledgments.length})
                      </button>
                    {/if}
                    </div>
                  {:else}
                    <h3>Mods Need Update</h3>
                    <div class="mod-actions-compact">
                      <button class="mod-action-btn primary" on:click={onDownloadModsClick}>
                      🔄 Synchronize Mods
                    </button>
                    </div>
                  {/if}
                </div>
              {:else if downloadStatus === 'downloading'}
                <div class="detail-section">
                  <h3>Downloading Mods</h3>
                  <div class="progress-container">
                    <div class="progress-bar">
                      <div class="progress-fill" style="width: {downloadProgress}%"></div>
                    </div>
                    <p class="progress-text">Overall Progress: {downloadProgress}%</p>
                    {#if currentDownloadFile}
                      <div class="current-file-section">
                        <p class="current-file">Downloading: {currentDownloadFile}</p>
                        {#if fileProgress > 0}
                          <div class="file-progress-bar">
                            <div class="file-progress-fill" style="width: {fileProgress}%"></div>
                          </div>
                          <p class="file-progress-text">File Progress: {fileProgress}%</p>
                        {/if}
                        {#if downloadSpeed && downloadSpeed !== '0 MB/s'}
                          <p class="download-speed">{downloadSpeed}</p>
                        {/if}
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}
              
              <!-- Compact Memory Settings -->
              <div class="memory-settings-compact">
                <span class="memory-label">🧠 Max RAM (GB):</span>
                <input 
                  type="number" 
                  class="memory-input"
                  bind:value={maxMemory} 
                  min="0.5" 
                  max="16" 
                  step="0.5"
                  disabled={isLaunching || launchStatus === 'running'}
                  title="Amount of RAM to allocate to Minecraft"
                />
                <span class="memory-info">
                  {#if maxMemory < 1}
                    {maxMemory}GB (Low - may cause lag)
                  {:else if maxMemory >= 1 && maxMemory < 2}
                    {maxMemory}GB (Recommended for most users)
                  {:else if maxMemory >= 2 && maxMemory < 4}
                    {maxMemory}GB (Good for modded Minecraft)
                  {:else}
                    {maxMemory}GB (High - ensure enough system RAM)
                  {/if}
                </span>
              </div>
                
              <!-- Compact Launch Controls -->
              <div class="launch-section">
                <div class="debug-toggle-compact">
                  <label class="debug-checkbox-compact">
                    <input type="checkbox" bind:checked={showDebugTerminal} />
                    🐛 Show Debug Terminal
                  </label>
                </div>
                
                {#if launchStatus === 'ready'}
                  {#if $clientState.minecraftServerStatus === 'running' && clientSyncStatus === 'ready' && downloadStatus === 'ready'}
                    <button class="play-button-main" on:click={launchMinecraftWithDebug}>
                      🎮 PLAY MINECRAFT
                    </button>
                  {:else}
                    <button class="play-button-main disabled" disabled>
                      {#if $clientState.minecraftServerStatus !== 'running'}
                        ⏸️ WAITING FOR SERVER
                      {:else if clientSyncStatus !== 'ready'}
                        📥 DOWNLOAD CLIENT FIRST
                      {:else if downloadStatus !== 'ready'}
                        📥 DOWNLOAD MODS FIRST
                      {:else}
                        🎮 PLAY MINECRAFT
                      {/if}
                    </button>
                    {#if $clientState.minecraftServerStatus !== 'running'}
                      <div class="status-message">
                        The Minecraft server is not running. Please wait for it to start.
                      </div>
                    {:else if clientSyncStatus !== 'ready'}
                      <div class="status-message">
                        Download the Minecraft client files before playing.
                      </div>
                    {:else if downloadStatus !== 'ready'}
                      <div class="status-message">
                        Download the required mods before playing.
                      </div>
                    {/if}
                  {/if}
                {:else if launchStatus === 'launching'}
                  <div class="launching-section">
                    <h3>🚀 Launching Minecraft...</h3>
                    <div class="progress-container">
                      <p>{launchProgress.type}: {launchProgress.task}</p>
                      {#if launchProgress.total > 0}
                        <div class="progress-bar">
                          <div class="progress-fill" style="width: {Math.round((launchProgress.current / launchProgress.total) * 100)}%"></div>
                        </div>
                      {/if}
                    </div>
                    <button class="stop-button" on:click={stopMinecraft}>
                      ⏹️ Cancel Launch
                    </button>
                  </div>
                {:else if launchStatus === 'running'}
                  <div class="running-section">
                    <h3>🎮 Minecraft is Running</h3>
                    <p>Minecraft is currently running. You can close this window.</p>
                    <button class="stop-button" on:click={stopMinecraft}>
                      ⏹️ Stop Minecraft
                    </button>
                  </div>
                {:else if launchStatus === 'error'}
                  <div class="error-section">
                    <h3>❌ Launch Failed</h3>
                    <p>There was an error launching Minecraft. Check the logs for details.</p>
                    <button class="retry-button" on:click={() => launchStatus = 'ready'}>
                      🔄 Try Again
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            <!-- Fallback authentication state -->
            <div class="auth-section">
              <h2>Authentication Required</h2>
              <p>Please authenticate with your Microsoft account to continue.</p>
              <div style="display: flex; gap: 1rem; justify-content: center; margin-top: 1rem;">
                <button class="auth-button" on:click={checkAuthentication}>
                  🔄 Check Authentication
                </button>
                <button class="auth-button" on:click={authenticateWithMicrosoft}>
                  🔑 Login with Microsoft
                </button>
              </div>
            </div>
          {/if}
        </div>
        
        <div class="last-check">
          <span class="last-check-time">
            {#if lastCheck}
              Last checked: {lastCheck.toLocaleTimeString()}
            {:else}
              Never checked
            {/if}
          </span>
          {#if isChecking}
            <span class="checking">Checking...</span>
          {:else}
            <button class="refresh-button" on:click={handleRefreshFromDashboard}>
              Refresh
            </button>
          {/if}
        </div>
      </div>

<style>
  .client-main {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 100%;
    margin: 0;
    gap: 0.25rem;
    padding: 1rem; /* Add consistent padding like server components */
    box-sizing: border-box;
  }

  /* Improved Status Header */
  .status-header-container {
    display: flex;
    gap: 0.75rem;
    margin: 0 0 1rem 0; /* Consistent bottom margin */
    justify-content: center;
  }

  .connection-card,
  .server-card {
    background: rgba(31, 41, 55, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    transition: all 0.2s ease;
    min-width: fit-content;
    max-width: 200px;
  }

  .connection-card:hover,
  .server-card:hover {
    background: rgba(31, 41, 55, 0.8);
    border-color: rgba(75, 85, 99, 0.5);
  }

  .compact-status-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .status-label {
    font-size: 0.65rem;
    color: #9ca3af;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    white-space: nowrap;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: #ef4444; /* Default red */
    box-shadow: 0 0 4px rgba(239, 68, 68, 0.6);
  }

  /* Connection status - green when connected */
  .connection-card .status-dot.connected {
    background: #10b981 !important;
    box-shadow: 0 0 4px rgba(16, 185, 129, 0.6) !important;
  }

  /* Server status - green when running */
  .server-card .status-dot.running {
    background: #10b981 !important;
    box-shadow: 0 0 4px rgba(16, 185, 129, 0.6) !important;
  }

  /* Keep red for stopped/disconnected (default) */
  .connection-card .status-dot.disconnected,
  .server-card .status-dot.stopped {
    background: #ef4444;
    box-shadow: 0 0 4px rgba(239, 68, 68, 0.6);
  }

  .server-address {
    background: rgba(17, 24, 39, 0.8);
    color: #60a5fa;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.65rem;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    border: 1px solid rgba(59, 130, 246, 0.2);
    white-space: nowrap;
  }

  .connection-text {
    font-size: 0.7rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .connection-text.connected {
    color: #10b981;
  }

  .connection-text:not(.connected) {
    color: #ef4444;
  }

  .server-status {
    font-size: 0.7rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .server-status.running {
    color: #10b981;
  }

  .server-status:not(.running) {
    color: #ef4444;
  }

  /* Compact Game Info */
  .game-info-compact {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0;
  }

  .ready-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid #334155;
  }

  .ready-header h2 {
    margin: 0;
    font-size: 1.25rem;
  }

  /* Dynamic header colors */
  .status-header.ready {
    color: #10b981;
  }

  .status-header.waiting {
    color: #f59e0b;
  }

  .status-header.needs-client {
    color: #ef4444;
  }

  .status-header.needs-mods {
    color: #3b82f6;
  }

  .player-info-inline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .player-label {
    color: #9ca3af;
  }

  .player-name {
    color: #10b981;
    font-weight: 600;
  }

  /* Compact Server Info Card */
  .server-info-compact {
    display: flex;
    align-items: center;
    background: rgba(17, 24, 39, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    padding: 0.75rem 1rem;
    font-size: 0.9rem;
    border-top: 1px solid #334155;
    gap: 1rem;
    width: 100%;
    box-sizing: border-box;
  }

  .server-detail-card {
    display: flex;
    flex-direction: column;
    flex: 1;
    text-align: center;
    gap: 0.25rem;
  }

  .detail-label {
    color: #9ca3af;
    font-weight: 500;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .detail-value {
    color: #e5e7eb;
    font-weight: 600;
    font-size: 0.9rem;
  }

  .loader-version {
    color: #9ca3af;
    font-size: 0.8rem;
  }

  .divider {
    width: 1px;
    height: 30px;
    background: linear-gradient(to bottom, transparent, #6b7280, transparent);
    flex-shrink: 0;
  }

  /* Status Row */
  .status-row {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    justify-content: center;
    padding: 0.5rem;
    background: rgba(17, 24, 39, 0.3);
    border-radius: 6px;
    border-top: 1px solid #334155;
    width: 100%;
    box-sizing: border-box;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.9rem;
    font-weight: 500;
    border: 1px solid transparent;
    transition: all 0.2s;
  }

  .status-indicator.ready {
    background: rgba(16, 185, 129, 0.1);
    border-color: rgba(16, 185, 129, 0.2);
    color: #34d399;
  }

  .status-indicator.needed {
    background: rgba(239, 68, 68, 0.1);
    border-color: rgba(239, 68, 68, 0.2);
    color: #f87171;
  }

  .status-indicator.downloading {
    background: rgba(59, 130, 246, 0.1);
    border-color: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
  }

  .status-indicator.checking {
    background: rgba(245, 158, 11, 0.1);
    border-color: rgba(245, 158, 11, 0.2);
    color: #fbbf24;
  }

  .status-indicator.error {
    background: rgba(239, 68, 68, 0.1);
    border-color: rgba(239, 68, 68, 0.2);
    color: #f87171;
  }

  /* Detail Sections */
  .detail-section {
    background: rgba(31, 41, 55, 0.4);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    padding: 0.75rem;
    border-top: 1px solid #334155;
    width: 100%;
    box-sizing: border-box;
  }

  .detail-section h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1rem;
    color: #e5e7eb;
  }

  .detail-section p {
    margin: 0.25rem 0;
    font-size: 0.9rem;
    color: #9ca3af;
  }

  /* Compact Memory Settings */
  .memory-settings-compact {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    font-size: 0.9rem;
    background: rgba(31, 41, 55, 0.4);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid #334155;
    width: 100%;
    box-sizing: border-box;
  }

  .memory-label {
    color: #e5e7eb;
    font-weight: 500;
  }

  .memory-input {
    width: 60px !important;
    height: 28px !important;
    padding: 0.25rem !important;
    background: rgba(17, 24, 39, 0.8) !important;
    border: 1px solid rgba(75, 85, 99, 0.5) !important;
    border-radius: 4px !important;
    color: #e5e7eb !important;
    font-size: 0.85rem !important;
    text-align: center !important;
  }

  .memory-input:focus {
    outline: none !important;
    border-color: #3b82f6 !important;
  }

  .memory-info {
    color: #9ca3af;
    font-size: 0.8rem;
  }

  /* Launch Section */
  .launch-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem;
    background: rgba(17, 24, 39, 0.2);
    border-radius: 6px;
    border-top: 1px solid #334155;
    width: 100%;
    box-sizing: border-box;
  }

  .debug-toggle-compact {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .debug-checkbox-compact {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    color: #9ca3af;
    user-select: none;
  }

  .debug-checkbox-compact input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: #3b82f6;
    cursor: pointer;
  }

  .debug-checkbox-compact:hover {
    color: #e5e7eb;
  }

  /* Main Play Button */
  .play-button-main {
    width: 100% !important;
    height: 40px !important;
    background: linear-gradient(135deg, #10b981, #059669) !important;
    color: white !important;
    border: none !important;
    border-radius: 6px !important;
    font-size: 1rem !important;
    font-weight: 600 !important;
    cursor: pointer !important;
    transition: all 0.2s !important;
    margin: 0 !important;
    padding: 0 !important;
  }

  .play-button-main:hover:not(:disabled) {
    background: linear-gradient(135deg, #059669, #047857) !important;
    transform: translateY(-1px) !important;
  }

  .play-button-main:disabled {
    background: rgba(75, 85, 99, 0.5) !important;
    color: rgba(156, 163, 175, 0.8) !important;
    cursor: not-allowed !important;
    transform: none !important;
    box-shadow: 0 0 8px rgba(156, 163, 175, 0.3) !important;
    border: 1px solid rgba(156, 163, 175, 0.4) !important;
  }

  /* Modern Compact Action Buttons */
  .mod-actions-compact {
    display: flex;
    gap: 0.75rem;
    margin: 0.75rem 0;
    flex-wrap: wrap;
    justify-content: center;
  }

  .mod-action-btn {
    padding: 0.5rem 1rem;
    border: 1px solid transparent;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .mod-action-btn.primary {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.3);
  }

  .mod-action-btn.primary:hover {
    background: rgba(59, 130, 246, 0.25);
    border-color: rgba(59, 130, 246, 0.5);
    transform: translateY(-1px);
    color: #2563eb;
  }

  .mod-action-btn.acknowledge {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
    border-color: rgba(16, 185, 129, 0.3);
  }

  .mod-action-btn.acknowledge:hover {
    background: rgba(16, 185, 129, 0.25);
    border-color: rgba(16, 185, 129, 0.5);
    transform: translateY(-1px);
    color: #059669;
  }

  /* Compact Mod Lists */
  .compact-mod-section {
    margin: 0.75rem 0;
  }

  .compact-mod-section h4 {
    font-size: 0.9rem;
    color: #e5e7eb;
    margin: 0 0 0.5rem 0;
    font-weight: 600;
  }

  .compact-mod-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .compact-mod-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.25rem 0.5rem;
    background: rgba(17, 24, 39, 0.4);
    border-radius: 4px;
    border-left: 3px solid #3b82f6;
    font-size: 0.85rem;
  }

  .compact-mod-item.optional {
    border-left-color: #f59e0b;
    background: rgba(245, 158, 11, 0.1);
  }

  .compact-mod-item.client-mod {
    border-left-color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
  }

  .compact-mod-item.new-download {
    border-left-color: #10b981;
    background: rgba(16, 185, 129, 0.1);
  }

  .compact-mod-item.removal {
    border-left-color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
  }

  .compact-mod-item.acknowledgment {
    border-left-color: #10b981;
    background: rgba(16, 185, 129, 0.1);
  }

  .compact-mod-item .mod-name {
    color: #e5e7eb;
    font-weight: 500;
    flex: 1;
    margin-right: 0.5rem;
  }

  .version-badge {
    background: rgba(59, 130, 246, 0.2);
    color: #60a5fa;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .new-badge {
    background: rgba(16, 185, 129, 0.2);
    color: #34d399;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .removal-badge {
    background: rgba(239, 68, 68, 0.2);
    color: #f87171;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .dependency-badge {
    background: rgba(16, 185, 129, 0.2);
    color: #34d399;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
  }

  /* Status Message */
  .status-message {
    font-size: 0.8rem;
    color: #ef4444;
    text-align: center;
    margin-top: 0.25rem;
    font-style: italic;
  }

  /* Progress Components */
  .progress-container {
    margin-top: 0.5rem;
  }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: rgba(75, 85, 99, 0.3);
    border-radius: 4px;
    overflow: hidden;
    margin: 0.25rem 0;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #3b82f6, #10b981);
    transition: width 0.3s ease;
  }

  .progress-text {
    font-size: 0.8rem;
    color: #9ca3af;
    margin: 0.25rem 0;
  }

  .current-file {
    font-size: 0.8rem;
    color: #e5e7eb;
    margin: 0.25rem 0;
    font-weight: 500;
  }

  .current-file-section {
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: rgba(17, 24, 39, 0.4);
    border-radius: 4px;
    border: 1px solid rgba(75, 85, 99, 0.2);
  }

  .file-progress-bar {
    width: 100%;
    height: 6px;
    background: rgba(75, 85, 99, 0.3);
    border-radius: 3px;
    overflow: hidden;
    margin: 0.25rem 0;
  }

  .file-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #f59e0b, #f97316);
    transition: width 0.3s ease;
  }

  .file-progress-text {
    font-size: 0.75rem;
    color: #9ca3af;
    margin: 0.25rem 0;
  }

  .download-speed {
    font-size: 0.75rem;
    color: #3b82f6;
    margin: 0.25rem 0;
    font-weight: 500;
  }

  /* Special Status Sections */
  .launching-section,
  .running-section,
  .error-section {
    background: rgba(31, 41, 55, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    padding: 0.75rem;
    text-align: center;
  }

  .launching-section h3,
  .running-section h3,
  .error-section h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1rem;
  }

  .launching-section h3 {
    color: #3b82f6;
  }

  .running-section h3 {
    color: #10b981;
  }

  .error-section h3 {
    color: #ef4444;
  }

  /* Control Buttons */
  .stop-button,
  .retry-button {
    background: linear-gradient(135deg, #ef4444, #dc2626) !important;
    color: white !important;
    border: none !important;
    border-radius: 6px !important;
    padding: 0.5rem 1rem !important;
    font-size: 0.9rem !important;
    font-weight: 500 !important;
    cursor: pointer !important;
    transition: all 0.2s !important;
    margin: 0.5rem 0 0 0 !important;
  }

  .stop-button:hover,
  .retry-button:hover {
    background: linear-gradient(135deg, #dc2626, #b91c1c) !important;
  }

  .retry-button {
    background: linear-gradient(135deg, #3b82f6, #2563eb) !important;
  }

  .retry-button:hover {
    background: linear-gradient(135deg, #2563eb, #1d4ed8) !important;
  }

  /* Last Check Section */
  .last-check {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.8rem;
    color: #9ca3af;
    padding: 0.5rem;
    background: rgba(31, 41, 55, 0.4);
    border-radius: 6px;
    margin-top: 0.5rem;
  }

  .refresh-button {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(99, 102, 241, 0.2)) !important;
    color: #3b82f6 !important;
    border: 1px solid rgba(59, 130, 246, 0.3) !important;
    border-radius: 4px !important;
    padding: 0.25rem 0.5rem !important;
    font-size: 0.9rem !important;
    cursor: pointer !important;
    transition: all 0.2s !important;
  }

  .refresh-button:hover {
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(99, 102, 241, 0.3)) !important;
    transform: translateY(-1px) !important;
  }

  .checking {
    color: #f59e0b;
    font-style: italic;
  }

  /* Auth Section Styling */
  .auth-section {
    background: rgba(31, 41, 55, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 8px;
    padding: 2rem;
    text-align: center;
  }

  .auth-section h2 {
    color: #e5e7eb;
    margin-bottom: 1rem;
  }

  .auth-section p {
    color: #9ca3af;
    margin-bottom: 1rem;
  }

  .auth-button {
    background: linear-gradient(135deg, #3b82f6, #2563eb) !important;
    color: white !important;
    border: none !important;
    border-radius: 6px !important;
    padding: 0.75rem 1.5rem !important;
    font-size: 1rem !important;
    font-weight: 500 !important;
    cursor: pointer !important;
    transition: all 0.2s !important;
  }

  .auth-button:hover {
    background: linear-gradient(135deg, #2563eb, #1d4ed8) !important;
  }

  .connection-status-display {
    background: rgba(31, 41, 55, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 8px;
    padding: 2rem;
    text-align: center;
  }

  .connection-status-display h2 {
    color: #f59e0b;
    margin-bottom: 1rem;
  }

  .connection-status-display p {
    color: #9ca3af;
  }

  /* Legacy styling kept for compatibility */
  .mod-item.client-mod {
    border-left: 3px solid #a855f7;
    background: rgba(168, 85, 247, 0.1);
  }
  
  .mod-item.mod-disable {
    border-left: 3px solid #f59e0b;
    background: rgba(245, 158, 11, 0.1);
  }

  .mod-name {
    font-weight: 600;
    color: rgba(255, 255, 255, 0.95);
    margin-right: 0.75rem;
  }

  .version-change {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .current-version {
    color: rgba(255, 255, 255, 0.7);
    background: rgba(107, 114, 128, 0.2);
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    font-size: 0.85rem;
    font-weight: 500;
  }

  .version-arrow {
    color: rgba(255, 255, 255, 0.5);
    font-weight: bold;
  }

  .new-version {
    color: #10b981;
    background: rgba(16, 185, 129, 0.15);
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .update-check-status {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.9rem;
    font-style: italic;
    margin-top: 0.5rem;
  }

  /* Optional Indicator */
  .optional-indicator {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 4px;
    padding: 0.2rem 0.4rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    margin-left: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    white-space: nowrap;
  }

  .optional-indicator:hover {
    background: rgba(59, 130, 246, 0.25);
    border-color: rgba(59, 130, 246, 0.5);
    transform: translateY(-1px);
    color: #2563eb;
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .status-header-container {
      flex-direction: column;
      gap: 0.5rem;
    }

    .server-info-compact {
      flex-direction: column;
      gap: 0.5rem;
    }

    .status-row {
      flex-direction: column;
      gap: 0.5rem;
    }

    .memory-settings-compact {
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .mod-actions-compact {
      flex-direction: column;
      gap: 0.5rem;
    }

    .mod-action-btn {
      width: 100%;
      justify-content: center;
    }
  }
</style>
