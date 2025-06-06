<script>
  export let mod = {};
  export let expanded = false;
  export let isInstalled = false;
  export let hasUpdate = false;
  export let updateVersionNumber = null;
  export let installedVersionNumber = '';
  export let selectedVersionId = '';
  export let installedVersionId = '';
  export let versions = [];
  export let toggleVersionSelector;
  export let getFirstChar;
  export let formatDate;
</script>

<div class="mod-header-container">
  <button
    class="mod-header"
    on:click={toggleVersionSelector}
    type="button"
    aria-expanded={expanded}
    aria-controls={`version-selector-${mod.id}`}
  >
    <div class="mod-icon-container">
      {#if mod.iconUrl}
        <img
          src={mod.iconUrl}
          alt={mod.name}
          class="mod-icon"
          on:error={() => mod.iconUrl = null}
          class:disabled={isInstalled && !hasUpdate}
        />
      {:else}
        <div class="mod-icon-placeholder" class:disabled={isInstalled && !hasUpdate}>
          {getFirstChar(mod.name || mod.title)}
        </div>
      {/if}
    </div>

    <div class="mod-details">
      <h3 class="mod-title" class:disabled={isInstalled && !hasUpdate}>
        {mod.name || mod.title}

        {#if mod.clientSide && mod.serverSide}
          <span class="environment-badge both" title="Works on both client and server">C/S</span>
        {:else if mod.clientSide}
          <span class="environment-badge client" title="Client-side mod">Client</span>
        {:else if mod.serverSide}
          <span class="environment-badge server" title="Server-side mod">Server</span>
        {/if}

        {#if hasUpdate}
          <span class="update-badge" title="Update available">
            New Update
          </span>
        {/if}

        {#if mod.warnings && mod.warnings.length > 0}
          <span
            class="warning-badge"
            title={mod.warnings.join('\n')}
          >
            ⚠️
          </span>
        {/if}
      </h3>

      <p class="mod-description" class:disabled={isInstalled && !hasUpdate}>
        {mod.description || 'No description available'}
      </p>

      <div class="mod-stats">
        {#if mod.downloads !== undefined}
          <span class="mod-stat" title="Downloads">
            <i class="stat-icon download-icon">⬇️</i> {mod.downloads.toLocaleString()}
          </span>
        {/if}

        {#if mod.followers !== undefined}
          <span class="mod-stat" title="Followers">
            <i class="stat-icon follow-icon">⭐</i> {mod.followers.toLocaleString()}
          </span>
        {/if}

        {#if mod.lastUpdated}
          <span class="mod-stat" title="Last Updated">
            <i class="stat-icon updated-icon">🔄</i> {formatDate(mod.lastUpdated)}
          </span>
        {/if}
      </div>

      <div class="mod-meta">
        {#if mod.author}
          <span class="mod-author">by {mod.author}</span>
        {/if}

        {#if isInstalled}
          <span class="version-tag-inline" class:has-update={hasUpdate}>
            {installedVersionNumber || 'Installed'}
            {#if hasUpdate && updateVersionNumber}
              <span class="update-available-tag" title={`Update to ${updateVersionNumber} available`}>
                ({updateVersionNumber} available)
              </span>
            {/if}
          </span>
        {:else if selectedVersionId && versions.length > 0}
          {@const selectedVersion = versions.find(v => v.id === selectedVersionId)}
          <span class="version-tag-inline">
            {selectedVersion ? selectedVersion.versionNumber : 'Select version'}
          </span>
        {/if}
      </div>
    </div>
  </button>
</div>
