<script>
  import { createEventDispatcher } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  export let state = null;
  let versions = [];
  let loading = false;
  let error = null;
  let includePrereleases = false;

  $: provider = state?.source?.provider || '';
  $: currentVersion = state?.source?.version || '';
  $: currentVersionId = state?.source?.versionId || null;
  $: projectId = state?.source?.projectId || null;
  $: githubOwner = state?.source?.githubOwner || null;
  $: githubRepo = state?.source?.githubRepo || null;
  $: currentReleaseId = state?.source?.releaseId || null;
  $: visibleVersions = versions.filter(version => includePrereleases || version.channel === 'release');

  async function loadExactVersions() {
    if (provider !== 'modrinth' || !projectId) return;
    loading = true;
    error = null;
    try {
      versions = await modpackApi.listVersions({ projectId, channels: ['release', 'beta', 'alpha'] });
    } catch (caught) {
      error = caught;
    } finally {
      loading = false;
    }
  }

  function choose(version) {
    if (version.versionId === currentVersionId) return;
    const current = versions.find(candidate => candidate.versionId === currentVersionId);
    const selectedPublished = Date.parse(version.publishedAt || '');
    const currentPublished = Date.parse(current?.publishedAt || '');
    if (!current || !Number.isFinite(selectedPublished) || !Number.isFinite(currentPublished) || selectedPublished === currentPublished) {
      error = new Error('Minecraft Core could not prove whether this exact version is newer or older. Use Switch modpack to review it without guessing.');
      return;
    }
    const operationKind = selectedPublished < currentPublished ? 'downgrade' : 'update';
    dispatch('select', { operationKind, request: { provider: 'modrinth', projectId, versionId: version.versionId }, version });
  }

  function versionLabel(version) {
    return version.version || version.name || version.versionId;
  }

  function reviewGithubVersions() {
    if (!githubOwner || !githubRepo || !currentReleaseId) {
      error = new Error('Minecraft Core does not have enough trusted GitHub identity data to load this release history. Use Switch modpack to review another source.');
      return;
    }
    dispatch('github', {
      repositoryUrl: `https://github.com/${githubOwner}/${githubRepo}`,
      currentReleaseId
    });
  }
</script>

<section class="modpack-surface mp-panel mp-stack" aria-label="Modpack versions">
  <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Exact version management</p><h2 class="mp-title">Update, downgrade, or switch</h2><p class="mp-subtitle">Installed: {currentVersion || 'unknown'}. Every Update or Downgrade uses an exact provider ID; a compatible world restore point is mandatory for downgrade. Switch opens a new reviewed source.</p></div><button class="mp-button" type="button" on:click={() => dispatch('switch')}>Switch modpack</button></div>
  {#if provider === 'modrinth' && projectId}
    <div class="mp-actions"><button class="mp-button primary" type="button" on:click={loadExactVersions} disabled={loading}>{loading ? 'Loading…' : 'Load exact version history'}</button><label class="toggle"><input type="checkbox" bind:checked={includePrereleases} /> Include prerelease versions</label></div>
    {#if error}<div class="mp-state error"><strong>Version history unavailable</strong><p>{error.message}</p></div>{/if}
    {#if visibleVersions.length}<ul class="mp-list">{#each visibleVersions as version (version.versionId)}<li><button class="mp-row" type="button" disabled={version.versionId === currentVersionId} on:click={() => choose(version)}><span><strong>{versionLabel(version)}</strong><br /><span class="mp-muted">Exact version · {version.minecraftVersions?.join(', ')} · {version.loaders?.join(', ')} · {new Date(version.publishedAt).toLocaleString()}</span></span><span class="mp-badge {version.channel === 'release' ? 'good' : 'warn'}">{version.versionId === currentVersionId ? 'Installed' : version.channel}</span></button></li>{/each}</ul>{/if}
  {:else if provider === 'github'}
    <div class="mp-state"><strong>GitHub Release asset review required</strong><p>GitHub updates re-list uploaded assets so ZIP/RAR names, multipart completeness, timestamps, sizes, and digest availability can be reviewed again. The installed release must be found in GitHub's exact history before Minecraft Core will classify another release as an update or downgrade.</p><div class="mp-actions"><button class="mp-button primary" type="button" on:click={reviewGithubVersions}>Load this repository's releases</button><button class="mp-button" type="button" on:click={() => dispatch('switch')}>Switch modpack or source</button></div></div>
    {#if error}<div class="mp-state error"><strong>Version history unavailable</strong><p>{error.message}</p></div>{/if}
  {:else}
    <div class="mp-state"><strong>Choose a source to change versions</strong><p>Install a managed Modrinth or GitHub modpack to use exact update and downgrade history.</p><button class="mp-button" type="button" on:click={() => dispatch('switch')}>Review another exact version or source</button></div>
  {/if}
</section>

<style>
  @import './modpack-ui.css';
  .toggle { display: flex; gap: 0.45rem; align-items: center; color: var(--mp-muted); }
</style>
