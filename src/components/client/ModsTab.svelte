<script>
  export let instance;
  export let clientModManagerComponent;
  export let modSyncStatus;
  export let downloadStatus;
  export let getServerInfo;
  export let refreshMods;
</script>

<div class="mods-container">
  <ClientModManager
    bind:this={clientModManagerComponent}
    {instance}
    on:mod-sync-status={async (e) => {
      if (e.detail.fullSyncResult) {
        modSyncStatus = e.detail.fullSyncResult;
      } else {
        modSyncStatus = e.detail;
      }

      await getServerInfo();

      if (e.detail.synchronized) {
        downloadStatus = 'ready';
      } else {
        const hasDownloads = ((e.detail.missingMods?.length || 0) + (e.detail.outdatedMods?.length || 0) + (e.detail.missingOptionalMods?.length || 0) + (e.detail.outdatedOptionalMods?.length || 0)) > 0;
        const hasRemovals = ((e.detail.fullSyncResult?.requiredRemovals?.length || 0) + (e.detail.fullSyncResult?.optionalRemovals?.length || 0) + (e.detail.fullSyncResult?.acknowledgments?.length || 0)) > 0;
        if (hasDownloads || hasRemovals) {
          downloadStatus = 'needed';
        } else {
          downloadStatus = 'needed';
        }
      }
    }}
    on:refresh-mods={refreshMods}
  />
</div>

<style>
  .mods-container {
    padding: 1rem;
  }
</style>
