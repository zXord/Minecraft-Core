<script>
  import { createEventDispatcher } from 'svelte';
  
  export let serverPath = '';
  export let currentInstance;
  import { openFolder, validateServerPath } from '../utils/folderUtils.js';
  import AutoRestartSettings from '../components/settings/AutoRestartSettings.svelte';
  import VersionUpdater from '../components/settings/VersionUpdater.svelte';
  import WorldSettings from '../components/settings/WorldSettings.svelte';
  import ServerPropertiesEditor from '../components/settings/ServerPropertiesEditor.svelte';
  import InstanceSettings from '../components/settings/InstanceSettings.svelte';
  import { errorMessage } from '../stores/modStore.js';
  
  const dispatch = createEventDispatcher();
  
  // Enhanced state
  let showCopyConfirmation = false;
  
  // Copy path functionality
  async function copyPath() {
    if (serverPath) {
      try {
        await navigator.clipboard.writeText(serverPath);
        showCopyConfirmation = true;
        setTimeout(() => {
          showCopyConfirmation = false;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy path:', err);
      }
    }
  }
  
  async function openServerFolder() {
          if (!validateServerPath(serverPath)) {
            errorMessage.set('Server path is empty or invalid. Please set up the server first.');
            setTimeout(() => errorMessage.set(''), 5000);
            return;
          }
          const success = await openFolder(serverPath);
          if (!success) {
            errorMessage.set(`Failed to open folder. Please access it manually at: ${serverPath}`);
            setTimeout(() => errorMessage.set(''), 5000);
          }
  }
</script>

<div class="settings-container">
  <!-- Enhanced Compact Cards Layout -->
  <div class="settings-cards">
    <!-- Server Overview Card -->
    <div class="settings-card overview-card">
      <div class="card-header">
        <h3>🖥️ Server Overview</h3>
        <div class="status-pills">
          <div class="status-pill server">
            <div class="status-dot"></div>
            <span>Server Instance</span>
          </div>
        </div>
      </div>
      <div class="card-content">
        <div class="info-grid">
          <div class="info-row enhanced" title="Server instance name">
            <div class="info-label">
              <span class="info-icon">📛</span>
              <span>Name</span>
            </div>
            <span class="info-value">{currentInstance?.name || 'Unnamed Server'}</span>
          </div>
          <div class="info-row enhanced" title="Server installation path">
            <div class="info-label">
              <span class="info-icon">📁</span>
              <span>Server Path</span>
            </div>
            <div class="path-container">
              <span class="info-value path-text">{serverPath || 'Not configured'}</span>
              {#if serverPath}
                <div class="path-actions">
                  <button class="icon-btn" on:click={copyPath} title="Copy path" disabled={showCopyConfirmation}>
                    {showCopyConfirmation ? '✅' : '📋'}
      </button>
                  <button class="icon-btn" on:click={openServerFolder} title="Open server folder">📁</button>
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Server Configuration Cards -->
    <div class="settings-card">
      <div class="card-header">
        <h3>⚙️ Server Properties</h3>
  </div>
      <div class="card-content">
  <ServerPropertiesEditor serverPath={serverPath} />
      </div>
    </div>

    <div class="settings-card">
      <div class="card-header">
        <h3>🌍 World Management</h3>
      </div>
      <div class="card-content">
  <WorldSettings serverPath={serverPath} />
      </div>
    </div>

    <div class="settings-card">
      <div class="card-header">
        <h3>🔄 Auto-Restart</h3>
      </div>
      <div class="card-content">
  <AutoRestartSettings />
      </div>
    </div>

    <div class="settings-card">
      <div class="card-header">
        <h3>📦 Version Management</h3>
      </div>
      <div class="card-content">
        <VersionUpdater serverPath={serverPath} />
      </div>    </div>

    <!-- Instance Management Card -->
    {#if currentInstance}
      <div class="settings-card danger-card">
        <div class="card-header">
          <h3>⚠️ Instance Management</h3>
          <div class="warning-badge" title="These actions are permanent">Destructive</div>
        </div>
        <div class="card-content">
    <InstanceSettings
      instance={currentInstance}
      on:deleted={(e) => {
        // Forward the deletion event to the parent component (App.svelte)
        dispatch('deleted', e.detail);
      }}
    />
        </div>
      </div>
  {/if}
  </div>
</div>

<style>
  .settings-container {
    padding: 0.5rem; /* COMPACT: Reduced from 1rem */
    max-width: 1000px; /* COMPACT: Match client settings */
    margin: 0 auto;
    box-sizing: border-box;
  }

  /* Enhanced Cards Layout - COMPACT */
  .settings-cards {
    display: grid;
    gap: 0.5rem; /* COMPACT: Reduced from 0.75rem */
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
    padding: 0.4rem 0.75rem; /* COMPACT: Reduced from 0.6rem 1rem */
    border-bottom: 1px solid rgba(75, 85, 99, 0.3);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem; /* COMPACT: Reduced from 0.75rem */
    flex-wrap: wrap;
  }

  .card-header h3 {
    margin: 0;
    color: #e2e8f0;
    font-size: 0.85rem; /* COMPACT: Reduced from 0.9rem */
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.3rem; /* COMPACT: Reduced from 0.4rem */
  }

  .card-content {
    padding: 0.5rem 0.75rem; /* COMPACT: Reduced from 0.75rem 1rem */
  }

  /* Status Pills */
  .status-pills {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .status-pill {
    display: flex;
    align-items: center;
    gap: 0.25rem; /* COMPACT: Reduced from 0.3rem */
    padding: 0.2rem 0.5rem; /* COMPACT: Reduced from 0.25rem 0.6rem */
    border-radius: 12px;
    font-size: 0.6rem; /* COMPACT: Reduced from 0.65rem */
    font-weight: 600;
    border: 1px solid transparent;
    transition: all 0.2s ease;
  }

  .status-pill.server {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.3);
  }

  .status-pill .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-pill.server .status-dot {
    background: #3b82f6;
    box-shadow: 0 0 4px rgba(59, 130, 246, 0.6);
  }

  /* Enhanced Info Grid - COMPACT */
  .info-grid {
    display: grid;
    gap: 0.25rem; /* COMPACT: Reduced from 0.4rem */
    grid-template-columns: 1fr;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.3rem 0.5rem; /* COMPACT: Reduced from 0.4rem 0.6rem */
    background: rgba(17, 24, 39, 0.4);
    border-radius: 4px;
    border: 1px solid rgba(75, 85, 99, 0.2);
    gap: 0.5rem; /* COMPACT: Reduced from 0.75rem */
    min-height: 28px; /* COMPACT: Reduced from 32px */
    transition: all 0.2s ease;
  }

  .info-row.enhanced:hover {
    background: rgba(17, 24, 39, 0.6);
    border-color: rgba(75, 85, 99, 0.4);
    transform: translateX(2px);
  }

  .info-label {
    font-size: 0.75rem; /* COMPACT: Reduced from 0.8rem */
    color: #9ca3af;
    font-weight: 500;
    min-width: fit-content;
    display: flex;
    align-items: center;
    gap: 0.3rem; /* COMPACT: Reduced from 0.4rem */
  }

  .info-icon {
    font-size: 0.8rem; /* COMPACT: Reduced from 0.9rem */
    opacity: 0.8;
  }

  .info-value {
    font-size: 0.75rem; /* COMPACT: Reduced from 0.8rem */
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

  /* Danger Card Styling */
  .danger-card {
    border-color: rgba(239, 68, 68, 0.3);
  }

  .danger-card:hover {
    border-color: rgba(239, 68, 68, 0.5);
  }

  .danger-card .card-header {
    background: rgba(239, 68, 68, 0.1);
  }

  .warning-badge {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
    padding: 0.2rem 0.4rem; /* COMPACT: Reduced from 0.25rem 0.5rem */
    border-radius: 12px;
    font-size: 0.6rem; /* COMPACT: Reduced from 0.65rem */
    font-weight: 600;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  /* Override nested component styling - COMPACT */
  .settings-card :global(.setting-item),
  .settings-card :global(.section-content) {
    background: transparent !important;
    border: none !important;
    margin: 0 !important;
    padding: 0.25rem 0 !important; /* COMPACT: Reduced from 0.5rem */
  }

  .settings-card :global(h3),
  .settings-card :global(h4) {
    color: #e2e8f0 !important;
    font-size: 0.8rem !important; /* COMPACT: Reduced from 0.9rem */
    margin: 0.25rem 0 !important; /* COMPACT: Reduced from 0.5rem */
  }

  .settings-card :global(.danger-zone) {
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    margin: 0 !important;
  }
</style>
