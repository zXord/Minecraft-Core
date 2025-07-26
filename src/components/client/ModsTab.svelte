<script>
  import ClientModManager from './ClientModManager.svelte';
  import { clientState, setClientModVersionUpdates } from '../../stores/clientStore.js';
  import logger from '../../utils/logger.js';

  export let instance;
  export let clientModManagerComponent;
  export let modSyncStatus;
  export let downloadStatus;
  export let getServerInfo;
  export let refreshMods;
  export let filteredAcknowledgments;
  export let clientModVersionUpdates = null;

  // Handle mod removal - clear client version updates and refresh state
  function handleModRemoved(event) {
    const { fileName } = event.detail;
    
    logger.info('Handling client mod removal', {
      category: 'ui',
      data: {
        component: 'ModsTab',
        function: 'handleModRemoved',
        fileName,
        hasClientModVersionUpdates: !!(clientModVersionUpdates && clientModVersionUpdates.updates)
      }
    });
    
    // Clear any client mod version updates for the removed mod
    if (clientModVersionUpdates && clientModVersionUpdates.updates) {
      const filteredUpdates = clientModVersionUpdates.updates.filter(
        update => update.fileName.toLowerCase() !== fileName.toLowerCase()
      );
      
      logger.debug('Filtered client mod version updates after removal', {
        category: 'ui',
        data: {
          component: 'ModsTab',
          function: 'handleModRemoved',
          originalUpdatesCount: clientModVersionUpdates.updates.length,
          filteredUpdatesCount: filteredUpdates.length
        }
      });
      
      if (filteredUpdates.length === 0) {
        // No more client mod updates - clear the entire state
        setClientModVersionUpdates(null);
        logger.debug('Cleared all client mod version updates', {
          category: 'ui',
          data: {
            component: 'ModsTab',
            function: 'handleModRemoved'
          }
        });
      } else {
        // Update with filtered list
        setClientModVersionUpdates({
          ...clientModVersionUpdates,
          updates: filteredUpdates,
          hasChanges: filteredUpdates.length > 0
        });
        logger.debug('Updated client mod version updates with filtered list', {
          category: 'ui',
          data: {
            component: 'ModsTab',
            function: 'handleModRemoved',
            remainingUpdatesCount: filteredUpdates.length
          }
        });
      }
    }
    
    // Trigger comprehensive refresh
    refreshMods();
  }
</script>

<div class="mods-container">
  <!-- Modern Status Header -->
  <div class="status-header-container">
    <div class="connection-card">
      <div class="compact-status-item">
        <div class="status-dot {$clientState.connectionStatus}"></div>
        <div class="status-info">
          <span class="status-label">Management</span>
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

  <ClientModManager
    bind:this={clientModManagerComponent}
    {instance}
    {clientModVersionUpdates}
    on:mod-sync-status={async (e) => {
      logger.debug('Received mod sync status update', {
        category: 'ui',
        data: {
          component: 'ModsTab',
          function: 'mod-sync-status',
          synchronized: e.detail.synchronized,
          hasFullSyncResult: !!e.detail.fullSyncResult
        }
      });
      
      if (e.detail.fullSyncResult) {
        modSyncStatus = e.detail.fullSyncResult;
      } else {
        modSyncStatus = e.detail;
      }

      await getServerInfo();

      if (e.detail.synchronized) {
        downloadStatus = 'ready';
        logger.info('Client mods are synchronized', {
          category: 'ui',
          data: {
            component: 'ModsTab',
            function: 'mod-sync-status',
            downloadStatus: 'ready'
          }
        });
      } else {
        const hasDownloads = ((e.detail.missingMods?.length || 0) + (e.detail.outdatedMods?.length || 0) + (e.detail.missingOptionalMods?.length || 0) + (e.detail.outdatedOptionalMods?.length || 0)) > 0;
        const hasRemovals = ((e.detail.fullSyncResult?.requiredRemovals?.length || 0) + (e.detail.fullSyncResult?.optionalRemovals?.length || 0)) > 0;
        const hasUnacknowledgedDeps = filteredAcknowledgments?.length > 0;
        
        if (hasDownloads || hasRemovals || hasUnacknowledgedDeps) {
          downloadStatus = 'needed';
          logger.info('Client mods need synchronization', {
            category: 'ui',
            data: {
              component: 'ModsTab',
              function: 'mod-sync-status',
              downloadStatus: 'needed',
              hasDownloads,
              hasRemovals,
              hasUnacknowledgedDeps,
              missingMods: e.detail.missingMods?.length || 0,
              outdatedMods: e.detail.outdatedMods?.length || 0
            }
          });
        } else {
          downloadStatus = 'ready';
          logger.debug('Client mods status ready despite not synchronized', {
            category: 'ui',
            data: {
              component: 'ModsTab',
              function: 'mod-sync-status',
              downloadStatus: 'ready'
            }
          });
        }
      }
    }}
    on:refresh-mods={() => {
      logger.debug('Refreshing mods from ModsTab', {
        category: 'ui',
        data: {
          component: 'ModsTab',
          function: 'refresh-mods'
        }
      });
      refreshMods();
    }}
    on:mod-removed={handleModRemoved}
  />
</div>

<style>
  .mods-container {
    padding: 1rem;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    overflow-x: hidden;
  }

  /* Modern Status Header */
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

  /* Responsive Design */
  @media (max-width: 768px) {
    .status-header-container {
      flex-direction: column;
      gap: 0.5rem;
    }
  }
</style>
