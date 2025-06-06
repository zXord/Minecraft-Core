<script>
  export let expanded = false;
  export let modId = '';
  export let loading = false;
  export let error = null;
  export let filteredVersions = [];
  export let filterMinecraftVersion = '';
  export let selectedVersionId = '';
  export let installedVersionId = '';
  export let versions = [];
  export let selectVersion;
  export let formatFileSize;
</script>

{#if expanded}
  <div id="version-selector-{modId}" class="version-selector">
    {#if loading}
      <div class="loading-versions">Loading versions...</div>
    {:else if error}
      <div class="version-error">Error loading versions: {error}</div>
    {:else if filteredVersions.length === 0}
      <div class="no-versions">
        No compatible versions for Minecraft {filterMinecraftVersion}
      </div>
    {:else}
      {#if filteredVersions.some(v => v.gameVersions.includes(filterMinecraftVersion))}
        <div class="version-list">
          {#each filteredVersions as version}
            <button
              class="version-item"
              class:selected={version.id === selectedVersionId}
              class:installed-version={version.id === installedVersionId}
              class:compatible={version.gameVersions.includes(filterMinecraftVersion)}
              on:click={() => selectVersion(version)}
              type="button"
              aria-selected={version.id === selectedVersionId}
            >
              <div class="version-info">
                <span class="version-name">{version.name || version.versionNumber}</span>
                <span class="version-mc">{version.gameVersions.join(', ')}</span>
                {#if version.id === installedVersionId}
                  <span class="installed-badge">Installed</span>
                {/if}
              </div>
              <div class="version-meta">
                {#if version.downloads !== undefined}
                  <span class="download-count" title="Download count">
                    {version.downloads.toLocaleString()} DL
                  </span>
                {/if}
                {#if version.fileSize !== undefined}
                  <span class="file-size" title="File size">
                    {formatFileSize(version.fileSize)}
                  </span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      {:else}
        <div class="version-note">
          No versions are officially tagged for Minecraft {filterMinecraftVersion}, but these versions may be compatible:
        </div>
        <div class="version-list">
          {#each filteredVersions as version}
            <button
              class="version-item"
              class:selected={version.id === selectedVersionId}
              class:installed-version={version.id === installedVersionId}
              on:click={() => selectVersion(version)}
              type="button"
              aria-selected={version.id === selectedVersionId}
            >
              <div class="version-info">
                <span class="version-name">{version.name || version.versionNumber}</span>
                <span class="version-mc">{version.gameVersions.join(', ')}</span>
                {#if version.id === installedVersionId}
                  <span class="installed-badge">Installed</span>
                {/if}
              </div>
              <div class="version-meta">
                {#if version.downloads !== undefined}
                  <span class="download-count" title="Download count">
                    {version.downloads.toLocaleString()} DL
                  </span>
                {/if}
                {#if version.fileSize !== undefined}
                  <span class="file-size" title="File size">
                    {formatFileSize(version.fileSize)}
                  </span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
{/if}
