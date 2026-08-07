<script>
  import { createEventDispatcher } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  export let suggestedRepositoryUrl = '';
  export let suggestedModrinthProjectId = '';
  export let currentReleaseId = '';
  export let serverId = '';
  let repositoryUrl = suggestedRepositoryUrl;
  let includePrereleases = false;
  let linkedRepositoryApproved = !suggestedModrinthProjectId;
  let releases = [];
  let pagination = { nextCursor: null };
  let loading = false;
  let error = null;

  $: usingSuggestedRepository = Boolean(suggestedRepositoryUrl && repositoryUrl === suggestedRepositoryUrl);
  $: usingLinkedRepository = Boolean(usingSuggestedRepository && suggestedModrinthProjectId);
  $: installedRelease = currentReleaseId ? releases.find(release => release.releaseId === currentReleaseId) : null;
  $: canLoad = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/releases\/tag\/[^/?#]+)?\/?$/.test(repositoryUrl.trim()) && (!usingLinkedRepository || linkedRepositoryApproved);

  async function loadReleases(cursor = null) {
    if (!canLoad) return;
    loading = true;
    error = null;
    try {
      const result = await modpackApi.listGithubReleases({
        repositoryUrl: repositoryUrl.trim(),
        includePrereleases,
        cursor
      });
      releases = cursor ? [...releases, ...(result?.releases || [])] : result?.releases || [];
      pagination = result?.pagination || { nextCursor: null };
    } catch (caught) {
      error = caught;
    } finally {
      loading = false;
    }
  }

  async function chooseRelease(release) {
    if (release.releaseId === currentReleaseId) return;
    let operationKind = null;
    if (currentReleaseId) {
      const selectedPublished = Date.parse(release.publishedAt || '');
      const currentPublished = Date.parse(installedRelease?.publishedAt || '');
      if (!installedRelease || !Number.isFinite(selectedPublished) || !Number.isFinite(currentPublished) || selectedPublished === currentPublished) {
        error = new Error('Minecraft Core could not prove whether this exact release is newer or older. Load older releases until the installed release appears, or use Switch modpack without guessing.');
        return;
      }
      operationKind = selectedPublished < currentPublished ? 'downgrade' : 'update';
    }
    loading = true;
    error = null;
    try {
      const assets = await modpackApi.listGithubAssets({
        repositoryId: release.repositoryId,
        releaseId: release.releaseId,
        ...(serverId ? { serverId } : {})
      });
      dispatch('assets', {
        release,
        assets,
        repositoryUrl: repositoryUrl.trim(),
        operationKind,
        linkedModrinthProjectId: usingLinkedRepository && linkedRepositoryApproved ? suggestedModrinthProjectId : null
      });
    } catch (caught) {
      error = caught;
    } finally {
      loading = false;
    }
  }
</script>

<div class="modpack-surface mp-stack">
  <div class="mp-toolbar">
    <div class="grow"><p class="mp-kicker">GitHub Releases</p><h2 class="mp-title">Choose an exact release</h2><p class="mp-subtitle">Only uploaded release assets are eligible. GitHub-generated source archives are never treated as server packs.</p></div>
    <button type="button" class="mp-button" on:click={() => dispatch('back')}>Change source</button>
  </div>

  <form class="mp-panel mp-stack" on:submit|preventDefault={() => loadReleases()}>
    <label class="mp-field">Public repository or release URL<input class="mp-input" bind:value={repositoryUrl} placeholder="https://github.com/owner/repository" spellcheck="false" /></label>
    {#if usingLinkedRepository}
      <label class="approval"><input type="checkbox" bind:checked={linkedRepositoryApproved} /><span>I explicitly approve using the GitHub repository linked by the selected Modrinth project.</span></label>
    {/if}
    <label class="approval"><input type="checkbox" bind:checked={includePrereleases} /><span>Show prereleases (stable releases are shown by default)</span></label>
    <div class="mp-actions"><button type="submit" class="mp-button primary" disabled={!canLoad || loading}>{loading ? 'Loading…' : 'Load releases'}</button></div>
  </form>

  {#if error}
    <section class="mp-state error" tabindex="-1" aria-live="assertive"><strong>Could not load GitHub releases</strong><p>{error.message}</p><div class="mp-actions"><button class="mp-button" type="button" on:click={() => loadReleases()}>Retry</button><button class="mp-button" type="button" on:click={() => dispatch('local')}>Import local archive</button><button class="mp-button" type="button" on:click={() => dispatch('custom')}>Empty/Custom Server</button></div></section>
  {/if}

  {#if releases.length > 0}
    <section class="mp-panel mp-stack" aria-label="GitHub release history">
      <div><h3>Release history</h3><p class="mp-muted">Review the tag, publication time, and channel before opening its uploaded assets.</p></div>
      <ul class="mp-list">
        {#each releases as release (release.releaseId)}
          <li><button type="button" class="mp-row" disabled={release.releaseId === currentReleaseId} on:click={() => chooseRelease(release)}><span><strong>{release.name || release.tagName}</strong><br /><span class="mp-muted">{release.tagName} · published {new Date(release.publishedAt).toLocaleString()}</span></span><span class="mp-badge {release.releaseId === currentReleaseId ? 'good' : release.prerelease ? 'warn' : 'good'}">{release.releaseId === currentReleaseId ? 'Installed' : release.prerelease ? 'Prerelease' : 'Stable'}</span></button></li>
        {/each}
      </ul>
      {#if pagination.nextCursor}<button class="mp-button" type="button" disabled={loading} on:click={() => loadReleases(pagination.nextCursor)}>Load older releases</button>{/if}
      {#if currentReleaseId && !installedRelease}<div class="mp-state warning"><strong>Installed release not loaded yet</strong><p>Load older releases until the exact installed release appears. Other releases stay unclassified until then.</p></div>{/if}
    </section>
  {:else if !loading && !error && repositoryUrl}
    <div class="mp-state">Enter a valid public GitHub URL, approve it when it came from a linked project, then load its stable release history.</div>
  {/if}
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  .approval { display: flex; align-items: flex-start; gap: 0.55rem; color: var(--mp-muted); }
  .approval input { margin-top: 0.25rem; }
</style>
