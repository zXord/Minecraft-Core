<script>
  export let isInstalled = false;
  export let isChangingVersion = false;
  export let isInstalling = false;
  export let hasUpdate = false;
  export let expanded = false;
  export let versions = [];
  export let selectedVersionId = '';
  export let handleInstallClick;
</script>

<div class="mod-actions">
  <button
    class="install-button"
    class:installed={isInstalled && (!isChangingVersion || !expanded) && !hasUpdate}
    class:update-available={isInstalled && hasUpdate && !expanded}
    class:change-version={isChangingVersion && expanded && !isInstalling}
    class:installing={isInstalling}
    disabled={isInstalling || (!isInstalled && versions.length > 0 && !selectedVersionId)}
    on:click={handleInstallClick}
  >
    {#if isInstalling}
      Installing...
    {:else if isInstalled}
      {#if expanded && isChangingVersion}
        Change Version
      {:else if hasUpdate}
        Update
      {:else}
        Installed
      {/if}
    {:else}
      Install
    {/if}
  </button>
</div>
