<script>
  import { clientState } from '../../stores/clientStore.js';

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

  // Enhanced state management
  let isAuthenticating = false;
  let isCheckingClient = false;
  let isRedownloading = false;
  let isDeletingInstance = false;
  let showCopyConfirmation = false;
  let lastAuthDate = authData?.lastLogin || null;

  // Enhanced functions with loading states
  async function handleAuthenticate() {
    isAuthenticating = true;
    try {
      await authenticateWithMicrosoft();
      lastAuthDate = new Date().toISOString();
    } finally {
      isAuthenticating = false;
    }
  }

  async function handleCheckClient() {
    isCheckingClient = true;
    try {
      await checkClientSynchronization();
    } finally {
      isCheckingClient = false;
    }
  }

  async function handleRedownload() {
    isRedownloading = true;
    try {
      await redownloadClient();
    } finally {
      isRedownloading = false;
    }
  }

  async function handleDeleteInstance() {
    isDeletingInstance = true;
    try {
      await promptDelete();
    } finally {
      isDeletingInstance = false;
    }
  }

  // Copy path functionality
  async function copyPath() {
    if (instance.path) {
      try {
        await navigator.clipboard.writeText(instance.path);
        showCopyConfirmation = true;
        setTimeout(() => {
          showCopyConfirmation = false;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy path:', err);
      }
    }
  }
</script>

      <div class="settings-container">
  <!-- Enhanced Compact Cards Layout -->
  <div class="settings-cards">
    <!-- Combined Status & Client Overview Card -->
    <div class="settings-card overview-card">
      <div class="card-header">
        <h3>📋 Client Overview</h3>
        <div class="status-pills">
          <div class="status-pill {$clientState.connectionStatus}">
            <div class="status-dot"></div>
            <span>Management: {$clientState.connectionStatus === 'connected' ? 'Connected' : 'Disconnected'}</span>
          </div>
          <div class="status-pill {$clientState.minecraftServerStatus}">
            <div class="status-dot"></div>
            <span>Server: {$clientState.minecraftServerStatus === 'running' ? 'Running' : 'Stopped'}</span>
          </div>
        </div>
      </div>
      <div class="card-content">
        <div class="info-grid">
          <div class="info-row enhanced" title="Client instance name">
            <div class="info-label">
              <span class="info-icon">📛</span>
              <span>Name</span>
            </div>
              <span class="info-value">{instance.name || 'Unnamed Client'}</span>
          </div>
          <div class="info-row enhanced" title="Management server address">
            <div class="info-label">
              <span class="info-icon">🖥️</span>
              <span>Management Server</span>
            </div>
            <span class="info-value">{instance.serverIp || 'localhost'}:{instance.serverPort || '8080'}</span>
          </div>
          <div class="info-row enhanced" title="Local client installation path">
            <div class="info-label">
              <span class="info-icon">📁</span>
              <span>Client Path</span>
            </div>
            <div class="path-container">
              <span class="info-value path-text">{instance.path || 'Not configured'}</span>
              {#if instance.path}
                <div class="path-actions">
                  <button class="icon-btn" on:click={copyPath} title="Copy path" disabled={showCopyConfirmation}>
                    {showCopyConfirmation ? '✅' : '📋'}
                  </button>
                  <button class="icon-btn" on:click={openClientFolder} title="Open client folder">📁</button>
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Authentication & Client Management Combined (60/40 Split) -->
    <div class="settings-card dual-card">
      <div class="card-content">
        <div class="dual-sections asymmetric">
          <!-- Authentication Section (40%) -->
          <div class="section auth-section">
            <div class="section-header">
              <h4>🔐 Authentication</h4>
              <div class="status-badge {authStatus === 'authenticated' ? 'success' : 'error'}">
                {authStatus === 'authenticated' ? '✅ Logged In' : '❌ Not Authenticated'}
              </div>
          </div>
            <div class="section-content">
            {#if authStatus === 'authenticated'}
                <p class="auth-description">Logged in as <strong>{username}</strong></p>
                {#if lastAuthDate}
                  <p class="auth-date">Last login: {new Date(lastAuthDate).toLocaleDateString()}</p>
                {/if}
                <button 
                  class="modern-btn secondary sm" 
                  on:click={handleAuthenticate} 
                  disabled={isAuthenticating}
                  title="Re-authenticate"
                >
                  {isAuthenticating ? '⏳ Authenticating...' : '🔄 Re-authenticate'}
              </button>
            {:else}
                <p class="auth-description">Microsoft authentication required</p>
                <button 
                  class="modern-btn primary sm" 
                  on:click={handleAuthenticate} 
                  disabled={isAuthenticating}
                  title="Login with Microsoft"
                >
                  {isAuthenticating ? '⏳ Authenticating...' : '🔑 Login with Microsoft'}
              </button>
            {/if}
            </div>
          </div>
          
          <!-- Client Management Section (60%) -->
          <div class="section management-section">
            <div class="section-header">
              <h4>🎮 Client Management</h4>
              {#if serverInfo?.minecraftVersion}
                <div class="version-badge">v{serverInfo.minecraftVersion}</div>
              {/if}
            </div>
            <div class="section-content">
            {#if serverInfo?.minecraftVersion}
                <div class="client-status-compact">
                  <span class="status-label">Status:</span>
                  <div class="status-indicator {clientSyncStatus}">
                {#if clientSyncStatus === 'ready'}
                  ✅ Ready
                {:else if clientSyncStatus === 'needed'}
                      ⚠️ Needs Download
                {:else if clientSyncStatus === 'downloading'}
                      ⏳ Downloading...
                {:else}
                  ❓ Unknown
                {/if}
                  </div>
                </div>
              
                <div class="action-buttons compact">
                  <button 
                    class="modern-btn secondary sm" 
                    on:click={handleCheckClient}
                    disabled={isCheckingClient}
                    title="Check client files integrity"
                  >
                    {isCheckingClient ? '⏳ Checking...' : '🔍 Check Files'}
                </button>
                  <button 
                    class="modern-btn warning sm" 
                    on:click={handleRedownload}
                    disabled={isRedownloading}
                    title="Re-download client files"
                  >
                    {isRedownloading ? '⏳ Downloading...' : '🔄 Re-download'}
                </button>
              </div>
              
                <p class="help-text">
                  If Minecraft won't launch, try re-downloading client files.
              </p>
            {:else}
                <div class="no-connection">
                  <p>❌ No server connection</p>
                </div>
            {/if}
            </div>
          </div>
        </div>
      </div>
          </div>
          
    <!-- Enhanced Danger Zone Card -->
    <div class="settings-card danger-card">
      <div class="card-header">
        <h3>⚠️ Danger Zone</h3>
        <div class="warning-badge" title="These actions are permanent">Destructive</div>
      </div>
      <div class="card-content">
        <p class="danger-warning">Actions cannot be undone. Please be careful.</p>
            
        <div class="danger-actions">
            {#if instance.path}
            <div class="delete-option">
              <label class="checkbox-container" title="Include all client files in deletion">
                  <input type="checkbox" bind:checked={deleteFiles} />
                <span class="checkbox-label">Delete all client files</span>
                </label>
              <p class="delete-path">{instance.path}</p>
              </div>
            {/if}
            
            <button 
            class="modern-btn danger sm" 
            on:click={handleDeleteInstance}
            disabled={isDeletingInstance}
            title="Permanently delete this client instance"
          >
            {isDeletingInstance ? '⏳ Deleting...' : '🗑️ Delete Instance'}
            </button>
        </div>
      </div>
          </div>
        </div>
      </div>

<style>
  .settings-container {
    padding: 1rem;
    max-width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
    overflow-x: hidden;
  }

  /* Enhanced Cards Layout */
  .settings-cards {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: 1fr;
  }

  .settings-card {
    background: rgba(31, 41, 55, 0.6);
    border: 1px solid rgba(75, 85, 99, 0.3);
    border-radius: 6px;
    overflow: hidden;
    transition: all 0.2s ease;
  }

  .settings-card:hover {
    border-color: rgba(75, 85, 99, 0.5);
    background: rgba(31, 41, 55, 0.7);
    transform: translateY(-1px);
  }

  .card-header {
    background: rgba(17, 24, 39, 0.8);
    padding: 0.6rem 1rem;
    border-bottom: 1px solid rgba(75, 85, 99, 0.3);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .card-header h3 {
    margin: 0;
    color: #e2e8f0;
    font-size: 0.9rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .card-content {
    padding: 0.75rem 1rem;
  }

  /* Status Pills (Replacing separate status header) */
  .status-pills {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .status-pill {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.6rem;
    border-radius: 12px;
    font-size: 0.65rem;
    font-weight: 600;
    border: 1px solid transparent;
    transition: all 0.2s ease;
  }

  .status-pill.connected {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
    border-color: rgba(16, 185, 129, 0.3);
  }

  .status-pill.running {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
    border-color: rgba(16, 185, 129, 0.3);
  }

  .status-pill:not(.connected):not(.running) {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.3);
  }

  .status-pill .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-pill.connected .status-dot,
  .status-pill.running .status-dot {
    background: #10b981;
    box-shadow: 0 0 4px rgba(16, 185, 129, 0.6);
  }

  .status-pill:not(.connected):not(.running) .status-dot {
    background: #ef4444;
    box-shadow: 0 0 4px rgba(239, 68, 68, 0.6);
  }

  /* Enhanced Info Grid with Icons and Hover */
  .info-grid {
    display: grid;
    gap: 0.4rem;
    grid-template-columns: 1fr;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0.6rem;
    background: rgba(17, 24, 39, 0.4);
    border-radius: 4px;
    border: 1px solid rgba(75, 85, 99, 0.2);
    gap: 0.75rem;
    min-height: 32px;
    transition: all 0.2s ease;
  }

  .info-row.enhanced:hover {
    background: rgba(17, 24, 39, 0.6);
    border-color: rgba(75, 85, 99, 0.4);
    transform: translateX(2px);
  }

  .info-label {
    font-size: 0.8rem;
    color: #9ca3af;
    font-weight: 500;
    min-width: fit-content;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .info-icon {
    font-size: 0.9rem;
    opacity: 0.8;
  }

  .info-value {
    font-size: 0.8rem;
    color: #e2e8f0;
    font-weight: 500;
    text-align: right;
    word-break: break-all;
  }

  .path-container {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    justify-content: flex-end;
  }

  .path-text {
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 0.7rem;
    background: rgba(17, 24, 39, 0.8);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    border: 1px solid rgba(75, 85, 99, 0.3);
    transition: all 0.2s ease;
  }

  .path-text:hover {
    border-color: rgba(75, 85, 99, 0.5);
  }

  .path-actions {
    display: flex;
    gap: 0.25rem;
  }

  .icon-btn {
    background: rgba(75, 85, 99, 0.3);
    border: 1px solid rgba(75, 85, 99, 0.5);
    color: #e2e8f0;
    border-radius: 3px;
    padding: 0.2rem 0.4rem;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s ease;
    min-width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .icon-btn:hover:not(:disabled) {
    background: rgba(75, 85, 99, 0.5);
    border-color: rgba(75, 85, 99, 0.7);
    transform: scale(1.05);
  }

  .icon-btn:disabled {
    background: rgba(16, 185, 129, 0.3);
    border-color: rgba(16, 185, 129, 0.5);
    color: #10b981;
    cursor: not-allowed;
  }

  /* Asymmetric Dual Sections (40/60 Split) */
  .dual-sections {
    display: grid;
    gap: 1rem;
    grid-template-columns: 1fr 1fr;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }

  .dual-sections.asymmetric {
    grid-template-columns: 2fr 3fr;
  }

  /* Responsive dual sections */
  @media (max-width: 800px) {
    .dual-sections,
    .dual-sections.asymmetric {
      grid-template-columns: 1fr;
      gap: 0.75rem;
    }
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid rgba(75, 85, 99, 0.3);
  }

  .section-header h4 {
    margin: 0;
    color: #e2e8f0;
    font-size: 0.85rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .section-content {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Enhanced Status Badges */
  .status-badge {
    padding: 0.15rem 0.5rem;
    border-radius: 8px;
    font-size: 0.65rem;
    font-weight: 600;
    white-space: nowrap;
    transition: all 0.2s ease;
  }

  .status-badge:hover {
    transform: scale(1.05);
  }

  .status-badge.success {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }

  .status-badge.error {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .version-badge {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.3);
    padding: 0.15rem 0.5rem;
    border-radius: 8px;
    font-size: 0.65rem;
    font-weight: 600;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    transition: all 0.2s ease;
  }

  .version-badge:hover {
    transform: scale(1.05);
  }

  .warning-badge {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.3);
    padding: 0.15rem 0.5rem;
    border-radius: 8px;
    font-size: 0.65rem;
    font-weight: 600;
    transition: all 0.2s ease;
  }

  .warning-badge:hover {
    transform: scale(1.05);
  }

  /* Auth Section Enhancements */
  .auth-description {
    color: #d1d5db;
    margin: 0;
    line-height: 1.4;
    font-size: 0.8rem;
  }

  .auth-date {
    color: #9ca3af;
    margin: 0;
    font-size: 0.7rem;
    font-style: italic;
  }

  /* Client Management Enhancements */
  .client-status-compact {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0.6rem;
    background: rgba(17, 24, 39, 0.4);
    border-radius: 4px;
    border: 1px solid rgba(75, 85, 99, 0.2);
    transition: all 0.2s ease;
  }

  .client-status-compact:hover {
    background: rgba(17, 24, 39, 0.6);
    border-color: rgba(75, 85, 99, 0.4);
  }

  .status-indicator {
    padding: 0.15rem 0.5rem;
    border-radius: 8px;
    font-size: 0.7rem;
    font-weight: 600;
    transition: all 0.2s ease;
  }

  .status-indicator:hover {
    transform: scale(1.05);
  }

  .status-indicator.ready {
    background: rgba(16, 185, 129, 0.15);
    color: #10b981;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }

  .status-indicator.needed {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.3);
  }

  .status-indicator.downloading {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  /* Enhanced Action Buttons */
  .action-buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .action-buttons.compact {
    gap: 0.3rem;
  }

  .help-text {
    color: #9ca3af;
    font-size: 0.75rem;
    line-height: 1.4;
    margin: 0;
  }

  .no-connection {
    text-align: center;
    padding: 1rem;
    color: #9ca3af;
    font-size: 0.8rem;
  }

  /* Enhanced Modern Buttons with Loading States */
  .modern-btn {
    padding: 0.4rem 0.75rem;
    border: 1px solid transparent;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    text-decoration: none;
    position: relative;
    overflow: hidden;
  }

  .modern-btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  .modern-btn:disabled {
    opacity: 0.7;
    cursor: not-allowed;
    transform: none !important;
  }

  .modern-btn.sm {
    padding: 0.3rem 0.6rem;
    font-size: 0.7rem;
  }

  .modern-btn.primary {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.3);
  }

  .modern-btn.primary:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.25);
    border-color: rgba(59, 130, 246, 0.5);
  }

  .modern-btn.secondary {
    background: rgba(75, 85, 99, 0.15);
    color: #d1d5db;
    border-color: rgba(75, 85, 99, 0.3);
  }

  .modern-btn.secondary:hover:not(:disabled) {
    background: rgba(75, 85, 99, 0.25);
    border-color: rgba(75, 85, 99, 0.5);
  }

  .modern-btn.warning {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.3);
  }

  .modern-btn.warning:hover:not(:disabled) {
    background: rgba(245, 158, 11, 0.25);
    border-color: rgba(245, 158, 11, 0.5);
  }

  .modern-btn.danger {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.3);
  }

  .modern-btn.danger:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.25);
    border-color: rgba(239, 68, 68, 0.5);
  }

  /* Enhanced Danger Zone */
  .danger-card {
    border-color: rgba(239, 68, 68, 0.3) !important;
  }

  .danger-card .card-header {
    background: rgba(127, 29, 29, 0.3);
    border-bottom-color: rgba(239, 68, 68, 0.3);
  }

  .danger-warning {
    color: #f87171;
    font-weight: 500;
    margin: 0 0 0.75rem 0;
    padding: 0.5rem;
    background: rgba(239, 68, 68, 0.1);
    border-radius: 4px;
    border: 1px solid rgba(239, 68, 68, 0.2);
    font-size: 0.8rem;
  }

  .danger-actions {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .delete-option {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .checkbox-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .checkbox-container:hover {
    transform: translateX(2px);
  }

  .checkbox-container input[type="checkbox"] {
    width: 14px;
    height: 14px;
    accent-color: #ef4444;
    transition: all 0.2s ease;
  }

  .checkbox-container input[type="checkbox"]:hover {
    transform: scale(1.1);
  }

  .checkbox-label {
    color: #e2e8f0;
    font-weight: 500;
    font-size: 0.8rem;
  }

  .delete-path {
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 0.7rem;
    color: #9ca3af;
    background: rgba(17, 24, 39, 0.8);
    padding: 0.3rem 0.5rem;
    border-radius: 3px;
    border: 1px solid rgba(75, 85, 99, 0.3);
    margin: 0;
    word-break: break-all;
  }

  /* Enhanced Responsive Design */
  @media (max-width: 768px) {
    .settings-container {
      padding: 0.5rem;
    }

    .card-header {
      padding: 0.5rem 0.75rem;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }

    .status-pills {
      flex-direction: column;
      gap: 0.25rem;
      width: 100%;
    }

    .status-pill {
      justify-content: center;
    }

    .card-content {
      padding: 0.5rem 0.75rem;
    }

    .dual-sections,
    .dual-sections.asymmetric {
      grid-template-columns: 1fr;
      gap: 0.75rem;
    }

    .info-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
      padding: 0.5rem;
    }

    .info-label {
      align-self: flex-start;
    }

    .info-value {
      text-align: left;
      align-self: flex-start;
    }

    .path-container {
      justify-content: flex-start;
      width: 100%;
    }

    .path-text {
      flex: 1;
      min-width: 0;
    }

    .action-buttons {
      flex-direction: column;
    }

    .modern-btn {
      justify-content: center;
    }

    .client-status-compact {
      flex-direction: column;
      gap: 0.5rem;
      align-items: flex-start;
    }

    .section-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.25rem;
    }

    .danger-actions {
      gap: 0.5rem;
    }
  }
</style>
