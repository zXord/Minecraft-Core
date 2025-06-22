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
            <!-- Show game information and launch controls -->
            <div class="game-info">
              <h2>Ready to Play</h2>
              <div class="player-info">
                <span class="player-label">Logged in as:</span>
                <span class="player-name">{username}</span>
              </div>
              
              {#if serverInfo}
                <div class="server-info-display">
                  <div class="info-item">
                    <span class="info-label">Server:</span>
                    <span class="info-value">{serverInfo.serverInfo?.name || 'Minecraft Server'}</span>
                  </div>
                  <div class="info-item">
                    <span class="info-label">Version:</span>
                    <span class="info-value">
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
                  <div class="info-item">
                    <span class="info-label">Required Mods:</span>
                    <span class="info-value">{requiredMods.length}</span>
                  </div>
                </div>
              {/if}
              
              <!-- Client synchronization status -->
              {#if clientSyncStatus === 'checking'}
                <div class="sync-status checking">
                  <h3>Checking Client Files...</h3>
                  <p>Verifying Minecraft client installation...</p>
                </div>
              {:else if clientSyncStatus === 'needed'}
                <div class="sync-status needed">
                  <h3>Client Files Need Download</h3>
                  {#if clientSyncInfo}
                    <p>{clientSyncInfo.reason}</p>
                    {#if clientSyncInfo.needsJava}
                      <p><strong>Java {clientSyncInfo.requiredJavaVersion} will be automatically downloaded and installed.</strong></p>
                    {/if}
                  {/if}
                  <p>Minecraft {serverInfo?.minecraftVersion || 'Unknown'} client files are required.</p>
                  <button class="download-button" on:click={downloadClient}>
                    📥 Download Minecraft Client {clientSyncInfo?.needsJava ? '& Java' : ''}
                  </button>
                </div>
              {:else if clientSyncStatus === 'downloading'}
                <div class="sync-status downloading">
                  <h3>Downloading Minecraft Client</h3>
                  <div class="launch-progress">
                    <p>{clientDownloadProgress.type}: {clientDownloadProgress.task}</p>
                    {#if clientDownloadProgress.total > 0}                      <div class="progress-bar">
                        <div class="progress-fill" style="width: {Math.round((clientDownloadProgress.current / clientDownloadProgress.total) * 100)}%"></div>
                      </div>
                      {#if clientDownloadProgress.type === 'Downloading' && clientDownloadProgress.totalMB}
                        <p class="progress-text">{clientDownloadProgress.current || 0} MB / {clientDownloadProgress.total} MB</p>
                      {/if}
                    {/if}
                  </div>
                </div>
              {:else if clientSyncStatus === 'ready'}
                <div class="sync-status ready">
                  <h3>✅ Client Files Ready</h3>
                  <p>Minecraft {serverInfo?.minecraftVersion || 'Unknown'} client is installed and ready.</p>
                  {#if clientSyncInfo?.javaVersion}
                    <p>Java {clientSyncInfo.javaVersion} is available and ready.</p>
                  {/if}
                </div>
              {/if}
              
              <!-- Mod synchronization status -->
              {#if downloadStatus === 'checking'}
                <div class="sync-status checking">
                  <h3>Checking Mods...</h3>
                  <p>Verifying installed mods...</p>
                </div>              {:else if downloadStatus === 'needed'}                <div class="sync-status needed">
                  {#if modSyncStatus}                    <!-- Use new response structure with filtered acknowledgments -->
                    {@const actualRemovals = [...(modSyncStatus.requiredRemovals || []), ...(modSyncStatus.optionalRemovals || [])]}
                    {@const acknowledgments = filteredAcknowledgments || []}
                      <!-- Dynamic title based on what needs to happen -->
                    {@const totalDownloadsNeeded = (modSyncStatus?.missingMods?.length || 0) + (modSyncStatus?.outdatedMods?.length || 0) + (modSyncStatus?.missingOptionalMods?.length || 0) + (modSyncStatus?.outdatedOptionalMods?.length || 0) + (modSyncStatus?.clientModUpdates?.length || 0)}
                    {#if totalDownloadsNeeded > 0 || actualRemovals.length > 0}
                      <h3>Mods Need Update</h3>
                    {:else if acknowledgments.length > 0}
                      <h3>Dependency Notifications</h3>
                    {:else}
                      <h3>Mod Sync Required</h3>                    {/if}

                    <!-- Display appropriate message based on what needs to happen -->
                    {@const totalUpdatesNeeded = (modSyncStatus?.outdatedMods?.length || 0) + (modSyncStatus?.outdatedOptionalMods?.length || 0) + (modSyncStatus?.clientModUpdates?.length || 0)}
                    {@const totalNewDownloads = (modSyncStatus?.missingMods?.length || 0) + (modSyncStatus?.missingOptionalMods?.length || 0)}
                    
                    {#if totalDownloadsNeeded > 0 && actualRemovals.length > 0 && acknowledgments.length > 0}
                      <p>{totalDownloadsNeeded} mod(s) need attention ({totalUpdatesNeeded} updates, {totalNewDownloads} new), {actualRemovals.length} mod(s) need to be removed, and {acknowledgments.length} dependency notification(s) need acknowledgment.</p>
                    {:else if totalDownloadsNeeded > 0 && actualRemovals.length > 0}
                      <p>{totalDownloadsNeeded} mod(s) need attention ({totalUpdatesNeeded} updates, {totalNewDownloads} new) and {actualRemovals.length} mod(s) need to be removed.</p>
                    {:else if totalDownloadsNeeded > 0 && acknowledgments.length > 0}
                      <p>{totalDownloadsNeeded} mod(s) need attention ({totalUpdatesNeeded} updates, {totalNewDownloads} new) and {acknowledgments.length} dependency notification(s) need acknowledgment.</p>
                    {:else if actualRemovals.length > 0 && acknowledgments.length > 0}
                      <p>{actualRemovals.length} mod(s) need to be removed and {acknowledgments.length} dependency notification(s) need acknowledgment.</p>
                    {:else if totalDownloadsNeeded > 0}
                      <p>{totalDownloadsNeeded} mod(s) need attention: {totalUpdatesNeeded} updates and {totalNewDownloads} new downloads.</p>
                    {:else if actualRemovals.length > 0}
                      <p>{actualRemovals.length} mod(s) need to be removed from your client.</p>
                    {:else if acknowledgments.length > 0}
                      <p>{acknowledgments.length} mod(s) are being kept as dependencies and need acknowledgment.</p>
                    {:else}
                      <p>Mod synchronization required.</p>
                    {/if}{:else}
                    <h3>Mods Need Update</h3>
                    <p>Checking mod status...</p>
                  {/if}
                    {#if modSyncStatus}
                    <!-- Required Mod Updates -->
                    {#if modSyncStatus.outdatedMods && modSyncStatus.outdatedMods.length > 0}
                      <div class="mod-changes-section">
                        <h4>� Required Mod Updates:</h4>                        <ul class="mod-list">                          {#each modSyncStatus.outdatedMods as update, index (update.name || update.fileName || `req-update-${index}`)}
                            <li class="mod-item mod-update">
                              <span class="mod-name">{update.name || update.fileName || 'Unknown Mod'}</span>
                              <span class="version-change">
                                <span class="current-version">v{update.currentVersion}</span>
                                <span class="version-arrow">→</span>
                                <span class="new-version">v{update.newVersion}</span>
                              </span>
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}                    <!-- Optional Mod Updates -->
                    {#if modSyncStatus.outdatedOptionalMods && modSyncStatus.outdatedOptionalMods.length > 0}
                      <div class="mod-changes-section">
                        <h4>🔄 Optional Mod Updates:</h4>                        <ul class="mod-list">                          {#each modSyncStatus.outdatedOptionalMods as update, index (update.name || update.fileName || `opt-update-${index}`)}
                            <li class="mod-item mod-update optional">
                              <span class="mod-name">{update.name || update.fileName || 'Unknown Mod'}</span>
                              <span class="version-change">
                                <span class="current-version">v{update.currentVersion}</span>
                                <span class="version-arrow">→</span>
                                <span class="new-version">v{update.newVersion}</span>
                              </span>
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}                    <!-- Client Downloaded Mod Updates -->
                    {#if modSyncStatus.clientModUpdates && modSyncStatus.clientModUpdates.length > 0}
                      <div class="mod-changes-section">
                        <h4>📱 Client Downloaded Mod Updates:</h4>                        <ul class="mod-list">
                          {#each modSyncStatus.clientModUpdates as update, index (update.name || update.fileName || `client-update-${index}`)}
                            <li class="mod-item mod-update client-mod">
                              <span class="mod-name">{update.name || update.fileName || 'Unknown Mod'}</span>
                              <span class="version-change">
                                <span class="current-version">v{update.currentVersion}</span>
                                <span class="version-arrow">→</span>
                                <span class="new-version">v{update.newVersion}</span>
                              </span>
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}
                    
                    <!-- Client Mod Compatibility Issues -->
                    {#if modSyncStatus.clientModDisables && modSyncStatus.clientModDisables.length > 0}
                      <div class="mod-changes-section">
                        <h4>⚠️ Client Mod Compatibility Issues:</h4>
                        <ul class="mod-list">
                          {#each modSyncStatus.clientModDisables as disable, index (disable.name || disable.fileName || `client-disable-${index}`)}
                            <li class="mod-item mod-disable client-mod">
                              {disable.name || disable.fileName || 'Unknown Mod'} v{disable.currentVersion} - {disable.reason}
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}

                    <!-- New Required Downloads -->
                    {#if modSyncStatus.missingMods && modSyncStatus.missingMods.length > 0}
                      <div class="mod-changes-section">
                        <h4>📥 New Required Downloads:</h4>
                        <ul class="mod-list">
                          {#each modSyncStatus.missingMods as modName (modName)}
                            <li class="mod-item new-download">{modName}</li>
                          {/each}
                        </ul>
                      </div>
                    {/if}

                    <!-- New Optional Downloads -->
                    {#if modSyncStatus.missingOptionalMods && modSyncStatus.missingOptionalMods.length > 0}                      <div class="mod-changes-section">
                        <h4>📥 New Optional Downloads:</h4>
                        <p class="clarification-note">
                          <em>Note: New optional mods must be downloaded individually from the Mods tab. They are not included in bulk updates.</em>
                        </p>
                        <ul class="mod-list">
                          {#each modSyncStatus.missingOptionalMods as modName (modName)}
                            <li class="mod-item new-download optional">{modName}</li>
                          {/each}
                        </ul>
                      </div>
                    {/if}<!-- Client Mod Removals - Use new response structure -->
                    {#if (modSyncStatus.requiredRemovals && modSyncStatus.requiredRemovals.length > 0) || (modSyncStatus.optionalRemovals && modSyncStatus.optionalRemovals.length > 0)}
                      <div class="mod-changes-section">
                        <h4>❌ Mods to be Removed:</h4>
                        <ul class="mod-list">
                          {#each [...(modSyncStatus.requiredRemovals || []), ...(modSyncStatus.optionalRemovals || [])] as removal (removal.fileName)}
                            <li class="mod-item mod-removal">
                              {removal.fileName} → {removal.reason || 'no longer required'}
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}                    <!-- Client Mod Dependency Acknowledgments - Use filtered acknowledgments -->
                    {#if filteredAcknowledgments && filteredAcknowledgments.length > 0}
                      <div class="mod-changes-section dependency-section">
                        <h4>🔗 Dependency Notifications:</h4>
                        <ul class="mod-list">
                          {#each filteredAcknowledgments as acknowledgment (acknowledgment.fileName)}
                            <li class="mod-item mod-dependency">
                              {acknowledgment.fileName} → {acknowledgment.reason || 'required as dependency by client downloaded mods'}
                            </li>
                          {/each}
                        </ul>
                      </div>                    {/if}                  {/if}                  <!-- Show appropriate action button based on what's needed -->                  {#if modSyncStatus}
                    {@const totalUpdatesNeeded = (modSyncStatus.missingMods?.length || 0) + (modSyncStatus.outdatedMods?.length || 0) + (modSyncStatus.outdatedOptionalMods?.length || 0) + (modSyncStatus.clientModUpdates?.length || 0)}
                    {#if totalUpdatesNeeded > 0}
                      <button class="download-button" on:click={onDownloadModsClick}>
                        📥 Download & Update Mods ({totalUpdatesNeeded})
                      </button>
                    {:else if ((modSyncStatus.requiredRemovals && modSyncStatus.requiredRemovals.length > 0) || (modSyncStatus.optionalRemovals && modSyncStatus.optionalRemovals.length > 0) || (filteredAcknowledgments && filteredAcknowledgments.length > 0))}
                      {@const actualRemovals = [...(modSyncStatus.requiredRemovals || []), ...(modSyncStatus.optionalRemovals || [])]}
                      {@const acknowledgments = filteredAcknowledgments || []}
                      
                      {#if actualRemovals.length > 0}
                        <button class="download-button" on:click={onDownloadModsClick}>
                          🔄 Apply Mod Changes (Remove {actualRemovals.length} mod{actualRemovals.length > 1 ? 's' : ''})
                        </button>
                      {/if}
                      
                      {#if acknowledgments.length > 0}
                        <button class="acknowledge-button" on:click={onAcknowledgeAllDependencies}>
                          ✓ Acknowledge Dependencies ({acknowledgments.length})
                        </button>
                      {/if}
                    {:else}
                      <button class="download-button" on:click={onDownloadModsClick}>
                        🔄 Synchronize Mods
                      </button>
                    {/if}
                  {/if}
                </div>
              {:else if downloadStatus === 'downloading'}
                <div class="sync-status downloading">
                  <h3>Downloading Mods</h3>
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
                {:else if downloadStatus === 'error'}
                  <div class="sync-status error">
                    <h3>Mod Check Failed</h3>
                    <p>Unable to verify mod status. Please refresh and try again.</p>
                  </div>                {:else if downloadStatus === 'ready'}                  <div class="sync-status ready">
                    <h3>✅ All Required Mods Ready</h3>
                    {#if modSyncStatus}
                      {@const optionalAvailable = (modSyncStatus.missingOptionalMods?.length || 0) + (modSyncStatus.outdatedOptionalMods?.length || 0)}
                      {#if optionalAvailable > 0}
                        <p>All required mods are installed and up to date.</p>
                        <div class="optional-mods-notice">
                          <span class="optional-icon">ℹ️</span>
                          <span class="optional-text">
                            {optionalAvailable} optional mod{optionalAvailable > 1 ? 's are' : ' is'} available for download. 
                            Check the <strong>Mods</strong> tab to download them.
                          </span>
                        </div>
                      {:else}
                        <p>All mods are installed and up to date.</p>
                      {/if}
                    {:else}
                      <p>All mods are installed and up to date.</p>
                    {/if}                  </div>
                {/if}
              
              <!-- Memory Settings -->
              <div class="memory-settings">
                <h3>🧠 Memory Settings</h3>
                <div class="memory-setting">
                  <label for="max-memory">Maximum RAM (GB):</label>
                  <input 
                    type="number" 
                    id="max-memory"
                    bind:value={maxMemory} 
                    min="0.5" 
                    max="16" 
                    step="0.5"
                    disabled={isLaunching || launchStatus === 'running'}
                    title="Amount of RAM to allocate to Minecraft. Higher values may improve performance but require more system memory."
                  />
                  <span class="memory-info">
                    {maxMemory}GB
                    {#if maxMemory < 1}
                      (Low - may cause lag)
                    {:else if maxMemory >= 1 && maxMemory < 2}
                      (Recommended for most users)
                    {:else if maxMemory >= 2 && maxMemory < 4}
                      (Good for modded Minecraft)
                    {:else}
                      (High - ensure you have enough system RAM)
                    {/if}
                  </span>
                </div>
                {#if isLaunching || launchStatus === 'running'}
                  <p class="memory-disabled-note">Memory settings cannot be changed while Minecraft is launching or running.</p>
                {/if}
              </div>
                <!-- Launch controls -->
              <div class="launch-controls">                <!-- Debug terminal toggle -->
                <div class="debug-toggle">
                  <label class="debug-checkbox">
                    <input type="checkbox" bind:checked={showDebugTerminal} />
                    🐛 Show Debug Terminal (for troubleshooting launch issues)
                  </label>
                </div>
                
                {#if launchStatus === 'ready'}
                  {#if $clientState.minecraftServerStatus === 'running' && clientSyncStatus === 'ready' && downloadStatus === 'ready'}
                    <button class="play-button" on:click={launchMinecraftWithDebug}>
                      🎮 PLAY MINECRAFT
                    </button>
                  {:else}
                    <button class="play-button disabled" disabled>
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
                      <p class="server-status-message">
                        The Minecraft server is not running. Please wait for it to start.
                      </p>
                    {:else if clientSyncStatus !== 'ready'}
                      <p class="server-status-message">
                        Download the Minecraft client files before playing.
                      </p>
                    {:else if downloadStatus !== 'ready'}
                      <p class="server-status-message">
                        Download the required mods before playing.
                      </p>
                    {/if}
                  {/if}
                {:else if launchStatus === 'launching'}
                  <div class="launching-status">
                    <h3>🚀 Launching Minecraft...</h3>
                    <div class="launch-progress">
                      <p>{launchProgress.type}: {launchProgress.task}</p>
                      {#if launchProgress.total > 0}                        <div class="progress-bar">
                          <div class="progress-fill" style="width: {Math.round((launchProgress.current / launchProgress.total) * 100)}%"></div>
                        </div>
                      {/if}
                    </div>
                    <button class="stop-button" on:click={stopMinecraft}>
                      ⏹️ Cancel Launch
                    </button>
                  </div>
                {:else if launchStatus === 'running'}
                  <div class="running-status">
                    <h3>🎮 Minecraft is Running</h3>
                    <p>Minecraft is currently running. You can close this window.</p>
                    <button class="stop-button" on:click={stopMinecraft}>
                      ⏹️ Stop Minecraft
                    </button>
                  </div>
                {:else if launchStatus === 'error'}
                  <div class="error-status">
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
            <!-- Catch-all for debugging -->
            <div class="auth-section">
              <h2>Status Check</h2>
              <p>Connection: {$clientState.connectionStatus}</p>
              <p>Auth Status: {authStatus}</p>
              <p>Username: {username || 'None'}</p>
              <p>Auth Data: {authData ? 'Present' : 'Missing'}</p>
              <p>Condition Check: {authStatus === 'authenticated' || (username && authData)}</p>
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
          {#if lastCheck}
            Last checked: {lastCheck.toLocaleTimeString()}
          {/if}
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
  }
  
  /* Client mod styling */  .mod-item.client-mod {
    border-left: 3px solid #a855f7;
    background: rgba(168, 85, 247, 0.1);
  }
  
  .mod-item.mod-disable {
    border-left: 3px solid #f59e0b;
    background: rgba(245, 158, 11, 0.1);
  }

  /* Mod name and version styling for better distinction */
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
    font-size: 0.85rem;    font-weight: 600;
  }
  /* Debug terminal toggle */
  .debug-toggle {
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 8px;
  }

  .debug-checkbox {
    display: flex;
    align-items: center;
    cursor: pointer;
    font-size: 0.9rem;
    color: #e5e7eb;
    user-select: none;
    gap: 0.5rem;
  }

  .debug-checkbox input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: #3b82f6;
    cursor: pointer;
    flex-shrink: 0;
  }

  .debug-checkbox:hover {
    color: #f3f4f6;
  }
</style>
