<script>
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const MAX_RELEASE_PAGES = 100;
  const dispatch = createEventDispatcher();
  export let suggestedRepositoryUrl = '';
  export let suggestedModrinthProjectId = '';
  export let currentReleaseId = '';
  export let serverId = '';
  export let requestedReleaseId = '';
  export let requestedNavigationToken = 0;
  export let allowCurrentReleaseReview = false;
  let repositoryUrl = suggestedRepositoryUrl;
  let includePrereleases = false;
  let linkedRepositoryApproved = !suggestedModrinthProjectId;
  let releases = [];
  let pagination = { nextCursor: null };
  let loading = false;
  let error = null;
  let requestSequence = 0;
  let handledRequestedNavigationToken = 0;

  $: usingSuggestedRepository = Boolean(suggestedRepositoryUrl && repositoryUrl === suggestedRepositoryUrl);
  $: usingLinkedRepository = Boolean(usingSuggestedRepository && suggestedModrinthProjectId);
  $: installedRelease = currentReleaseId ? releases.find(release => release.releaseId === currentReleaseId) : null;
  $: rateLimited = error?.code === 'RATE_LIMITED';
  $: canLoad = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/releases\/tag\/[^/?#]+)?\/?$/.test(repositoryUrl.trim()) && (!usingLinkedRepository || linkedRepositoryApproved);
  $: if (requestedNavigationToken && requestedReleaseId &&
      requestedNavigationToken !== handledRequestedNavigationToken) {
    handledRequestedNavigationToken = requestedNavigationToken;
    void loadRequestedRelease(requestedReleaseId, requestedNavigationToken);
  }

  function requestIsCurrent(sequence, navigationToken = 0) {
    return sequence === requestSequence &&
      (!navigationToken || navigationToken === handledRequestedNavigationToken);
  }

  function exactReleaseError(message, code = 'RELEASE_NOT_FOUND') {
    const value = new Error(message);
    value.code = code;
    return value;
  }

  function classifyRelease(release, availableReleases, { allowCurrent = false } = {}) {
    if (release.releaseId === currentReleaseId) {
      if (allowCurrent) return 'update';
      return null;
    }
    if (!currentReleaseId) return null;
    const current = availableReleases.find(candidate => candidate.releaseId === currentReleaseId);
    const selectedPublished = Date.parse(release.publishedAt || '');
    const currentPublished = Date.parse(current?.publishedAt || '');
    if (!current || !Number.isFinite(selectedPublished) || !Number.isFinite(currentPublished) || selectedPublished === currentPublished) {
      throw exactReleaseError('Minecraft Core could not prove whether this exact release is newer or older. Load older releases until the installed release appears, or use Switch modpack without guessing.', 'PLAN_STALE');
    }
    return selectedPublished < currentPublished ? 'downgrade' : 'update';
  }

  async function loadAssetsForRelease(release, availableReleases, sequence, {
    allowCurrent = false,
    navigationToken = 0
  } = {}) {
    const operationKind = classifyRelease(release, availableReleases, { allowCurrent });
    const assets = await modpackApi.listGithubAssets({
      repositoryId: release.repositoryId,
      releaseId: release.releaseId,
      ...(serverId ? { serverId } : {})
    });
    if (!requestIsCurrent(sequence, navigationToken)) return false;
    dispatch('assets', {
      release,
      assets,
      repositoryUrl: repositoryUrl.trim(),
      operationKind,
      linkedModrinthProjectId: usingLinkedRepository && linkedRepositoryApproved ? suggestedModrinthProjectId : null
    });
    return true;
  }

  async function loadReleases(cursor = null) {
    if (!canLoad) return;
    const sequence = ++requestSequence;
    loading = true;
    error = null;
    try {
      const result = await modpackApi.listGithubReleases({
        repositoryUrl: repositoryUrl.trim(),
        includePrereleases,
        cursor
      });
      if (!requestIsCurrent(sequence)) return;
      releases = cursor ? [...releases, ...(result?.releases || [])] : result?.releases || [];
      pagination = result?.pagination || { nextCursor: null };
    } catch (caught) {
      if (requestIsCurrent(sequence)) error = caught;
    } finally {
      if (requestIsCurrent(sequence)) loading = false;
    }
  }

  async function chooseRelease(release) {
    if (release.releaseId === currentReleaseId) return;
    const sequence = ++requestSequence;
    loading = true;
    error = null;
    try {
      await loadAssetsForRelease(release, releases, sequence);
    } catch (caught) {
      if (requestIsCurrent(sequence)) error = caught;
    } finally {
      if (requestIsCurrent(sequence)) loading = false;
    }
  }

  async function loadRequestedRelease(exactReleaseId, navigationToken) {
    if (!canLoad || exactReleaseId !== requestedReleaseId) return;
    const sequence = ++requestSequence;
    includePrereleases = true;
    releases = [];
    pagination = { nextCursor: null };
    loading = true;
    error = null;
    const seenCursors = new Set();
    let cursor = null;
    let collected = [];
    try {
      for (let page = 0; page < MAX_RELEASE_PAGES; page += 1) {
        const result = await modpackApi.listGithubReleases({
          repositoryUrl: repositoryUrl.trim(),
          includePrereleases: true,
          cursor
        });
        if (!requestIsCurrent(sequence, navigationToken)) return;
        collected = [...collected, ...(result?.releases || [])];
        releases = collected;
        pagination = result?.pagination || { nextCursor: null };
        const requested = collected.find(release => release.releaseId === requestedReleaseId);
        const installed = currentReleaseId
          ? collected.find(release => release.releaseId === currentReleaseId)
          : null;
        const canClassify = !currentReleaseId || Boolean(installed) ||
          (allowCurrentReleaseReview && requested?.releaseId === currentReleaseId);
        if (requested && canClassify) {
          await loadAssetsForRelease(requested, collected, sequence, {
            allowCurrent: allowCurrentReleaseReview,
            navigationToken
          });
          return;
        }
        const nextCursor = pagination.nextCursor;
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) {
          throw exactReleaseError('GitHub release pagination repeated itself before the exact notified release could be resolved.', 'INVALID_RESPONSE');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      const requested = collected.find(release => release.releaseId === requestedReleaseId);
      if (!requested) {
        throw exactReleaseError('The exact GitHub release from this notification is no longer available. Minecraft Core did not substitute another release.');
      }
      throw exactReleaseError('Minecraft Core could not find the installed release in the exact GitHub history, so it did not guess whether the notified release is an update or downgrade.', 'PLAN_STALE');
    } catch (caught) {
      if (requestIsCurrent(sequence, navigationToken)) error = caught;
    } finally {
      if (requestIsCurrent(sequence, navigationToken)) loading = false;
    }
  }

  onDestroy(() => {
    requestSequence += 1;
  });
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
    <section class="mp-state error" tabindex="-1" aria-live="assertive"><strong>{rateLimited ? 'GitHub rate limit reached' : 'Could not load GitHub releases'}</strong><p>{error.message}{rateLimited ? ' Wait until GitHub allows more requests, then retry. Your repository and channel selection are preserved.' : ''}</p><div class="mp-actions"><button class="mp-button" type="button" on:click={() => loadReleases()}>Retry</button><button class="mp-button" type="button" on:click={() => dispatch('local')}>Import local archive</button><button class="mp-button" type="button" on:click={() => dispatch('custom')}>Empty/Custom Server</button></div></section>
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
