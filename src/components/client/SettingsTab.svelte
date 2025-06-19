<script>
  export let instance;
  export let authStatus;
  export let authData;
  export let username;
  export let authenticateWithMicrosoft;
  export let openClientFolder;
  export let deleteFiles;
  export let promptDelete;
  export let serverInfo;
  export let clientSyncStatus;
  export let checkClientSynchronization;
  export let redownloadClient;
</script>

      <div class="settings-container">
        <div class="settings-section">
          <h2>Client Settings</h2>
          
          <div class="settings-info">
            <div class="info-item">
              <span class="info-label">Name:</span>
              <span class="info-value">{instance.name || 'Unnamed Client'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Management Server:</span>
              <span class="info-value">{instance.serverIp || 'Not configured'}:{instance.serverPort || '8080'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Client Path:</span>
              <span class="info-value">{instance.path || 'Not configured'}</span>
              {#if instance.path}
                <button class="folder-button" on:click={openClientFolder} title="Open client folder">📁</button>
              {/if}
            </div>
            {#if authData}
              <div class="info-item">
                <span class="info-label">Authenticated as:</span>
                <span class="info-value">{authData.username}</span>
              </div>
            {/if}
          </div>
          
          <div class="auth-management">
            <h3>Authentication</h3>
            {#if authStatus === 'authenticated'}
              <p class="auth-status-text">✅ You are logged in as {username}</p>
              <button class="re-auth-button" on:click={authenticateWithMicrosoft}>
                🔄 Re-authenticate
              </button>
            {:else}
              <p class="auth-status-text">❌ Not authenticated</p>
              <button class="auth-button" on:click={authenticateWithMicrosoft}>
                🔑 Login with Microsoft
              </button>
            {/if}
          </div>
          
          <div class="client-management">
            <h3>Client Management</h3>
            {#if serverInfo?.minecraftVersion}
              <p class="client-status-text">
                Minecraft Version: {serverInfo.minecraftVersion}
              </p>
              <p class="client-status-text">
                Client Status: 
                {#if clientSyncStatus === 'ready'}
                  ✅ Ready
                {:else if clientSyncStatus === 'needed'}
                  ❌ Needs Download
                {:else if clientSyncStatus === 'downloading'}
                  ⬬ Downloading...
                {:else}
                  ❓ Unknown
                {/if}
              </p>
              
              <div class="client-actions">
                <button class="check-client-button" on:click={checkClientSynchronization}>
                  🔍 Check Client Files
                </button>
                <button class="redownload-client-button" on:click={redownloadClient}>
                  🔄 Re-download Client Files
                </button>
              </div>
              
              <p class="client-info-text">
                If Minecraft won't launch, try re-downloading the client files. This will clear any corrupted files and download fresh ones.
              </p>
            {:else}
              <p class="client-status-text">❌ No server connection to check client requirements</p>
            {/if}
          </div>
          
          <div class="danger-zone">
            <h3>Danger Zone</h3>
            <p class="warning-text">These actions cannot be undone. Please be careful.</p>
            
            {#if instance.path}
              <div class="delete-options">
                <label class="delete-files-option">
                  <input type="checkbox" bind:checked={deleteFiles} />
                  <span>Delete all client files ({instance.path})</span>
                </label>
                <p class="delete-info">If checked, the entire client folder will be permanently deleted.</p>
              </div>
            {/if}
            
            <button 
              class="delete-instance-button" 
              on:click={promptDelete}
            >
              🗑️ Delete Instance
            </button>
          </div>
        </div>
      </div>

<style>
  .settings-container {
    padding: 1rem;
  }
</style>
