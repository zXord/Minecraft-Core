<script>
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  export let state = null;
  export let requestedVersionId = '';
  export let requestedNavigationToken = 0;
  let versions = [];
  let loading = false;
  let error = null;
  let includePrereleases = true;
  let handledRequestedNavigationToken = 0;
  let versionRequestSequence = 0;
  let versionList;

  $: provider = state?.source?.provider || '';
  $: currentVersion = state?.source?.version || '';
  $: currentVersionId = state?.source?.versionId || null;
  $: projectId = state?.source?.projectId || null;
  $: githubOwner = state?.source?.githubOwner || null;
  $: githubRepo = state?.source?.githubRepo || null;
  $: currentReleaseId = state?.source?.releaseId || null;
  $: visibleVersions = versions.filter(version => includePrereleases || version.channel === 'release');
  $: if (requestedNavigationToken && requestedNavigationToken !== handledRequestedNavigationToken) {
    handledRequestedNavigationToken = requestedNavigationToken;
    void loadExactVersions(requestedVersionId, requestedNavigationToken);
  }

  async function loadExactVersions(notificationVersionId = '', navigationToken = 0) {
    if (provider !== 'modrinth' || !projectId) return;
    const requestSequence = ++versionRequestSequence;
    loading = true;
    error = null;
    try {
      const loaded = await modpackApi.listVersions({ projectId });
      if (requestSequence !== versionRequestSequence) return;
      versions = loaded;
      if (notificationVersionId) {
        const exact = versions.find(version => version.versionId === notificationVersionId);
        if (!exact) {
          const missing = new Error('The exact Modrinth version from this notification is no longer available. Minecraft Core did not substitute another version.');
          missing.code = 'RELEASE_NOT_FOUND';
          error = missing;
          return;
        }
        await tick();
        if (requestSequence !== versionRequestSequence ||
            (navigationToken && navigationToken !== handledRequestedNavigationToken)) return;
        const target = [...(versionList?.querySelectorAll?.('[data-version-id]') || [])]
          .find(element => element.dataset.versionId === notificationVersionId);
        target?.focus?.();
        target?.scrollIntoView?.({ block: 'nearest' });
      }
    } catch (caught) {
      if (requestSequence === versionRequestSequence) error = caught;
    } finally {
      if (requestSequence === versionRequestSequence) loading = false;
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
    const chronologicalOperation = selectedPublished < currentPublished ? 'downgrade' : 'update';
    dispatch('select', { chronologicalOperation, request: { provider: 'modrinth', projectId, versionId: version.versionId }, version });
  }

  function versionLabel(version) {
    return version.version || version.name || version.versionId;
  }

  function advertisesCurrentRuntime(version) {
    const runtime = state?.runtime;
    return Boolean(runtime?.minecraftVersion && runtime?.loaderFamily &&
      version.minecraftVersions?.includes(runtime.minecraftVersion) &&
      version.loaders?.includes(runtime.loaderFamily));
  }

  function runtimeMessage(version) {
    const runtime = state?.runtime;
    if (!runtime?.minecraftVersion || !runtime?.loaderFamily) return 'This pack selects its runtime. Archive inspection confirms the exact runtime.';
    return advertisesCurrentRuntime(version)
      ? 'Advertises the current Minecraft version and loader family. Archive inspection must confirm the exact runtime and loader version.'
      : 'Advertises a different Minecraft version or loader family. Archive inspection must confirm the exact runtime and loader version.';
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

  onDestroy(() => {
    versionRequestSequence += 1;
  });
</script>

<section class="modpack-surface mp-panel mp-stack" aria-label="Modpack versions">
  <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Exact version management</p><h2 class="mp-title">Update, downgrade, or switch</h2><p class="mp-subtitle">Installed: {currentVersion || 'unknown'}. Every update or downgrade uses an exact provider ID. Before a downgrade, Minecraft Core creates a verified safety restore point; the current world can still be incompatible with older pack files. Switch opens a new reviewed source.</p></div><button class="mp-button" type="button" on:click={() => dispatch('switch')}>Switch modpack</button></div>
  {#if provider === 'modrinth' && projectId}
    <div class="mp-actions"><button class="mp-button primary" type="button" on:click={() => loadExactVersions()} disabled={loading}>{loading ? 'Loading…' : 'Load exact version history'}</button><label class="toggle"><input type="checkbox" bind:checked={includePrereleases} /> Show prerelease versions</label></div>
    {#if error}<div class="mp-state error" role="alert" aria-live="assertive"><strong>Version history unavailable</strong><p>{error.message}</p></div>{/if}
    {#if visibleVersions.length}<ul class="mp-list" bind:this={versionList}>{#each visibleVersions as version (version.versionId)}{@const notificationTarget = requestedVersionId === version.versionId}<li><button class="mp-row" class:notification-target={notificationTarget} type="button" data-version-id={version.versionId} data-notification-target={notificationTarget ? 'true' : undefined} disabled={version.versionId === currentVersionId} on:click={() => choose(version)}><span><strong>{versionLabel(version)}</strong><br /><span class="mp-muted">Exact version · {version.minecraftVersions?.join(', ')} · {version.loaders?.join(', ')} · {new Date(version.publishedAt).toLocaleString()}</span><br /><span class="mp-muted">{runtimeMessage(version)}</span></span><span class="mp-badge {version.channel === 'release' ? 'good' : 'warn'}">{version.versionId === currentVersionId ? notificationTarget ? 'Installed · notification target' : 'Installed' : notificationTarget ? `${version.channel} · notification target` : version.channel}</span></button></li>{/each}</ul>{/if}
  {:else if provider === 'github'}
    <div class="mp-state"><strong>GitHub Release asset review required</strong><p>GitHub updates re-list uploaded assets so ZIP/RAR names, multipart completeness, timestamps, sizes, and digest availability can be reviewed again. The installed release must be found in GitHub's exact history before Minecraft Core will classify another release as an update or downgrade.</p><div class="mp-actions"><button class="mp-button primary" type="button" on:click={reviewGithubVersions}>Load this repository's releases</button><button class="mp-button" type="button" on:click={() => dispatch('switch')}>Switch modpack or source</button></div></div>
    {#if error}<div class="mp-state error" role="alert" aria-live="assertive"><strong>Version history unavailable</strong><p>{error.message}</p></div>{/if}
  {:else}
    <div class="mp-state"><strong>Choose a source to change versions</strong><p>Install a managed Modrinth or GitHub modpack to use exact update and downgrade history.</p><button class="mp-button" type="button" on:click={() => dispatch('switch')}>Review another exact version or source</button></div>
  {/if}
</section>

<style>
  @import './modpack-ui.css';
  .toggle { display: flex; gap: 0.45rem; align-items: center; color: var(--mp-muted); }
  .notification-target { border-color: rgba(255, 255, 255, 0.28); box-shadow: inset 3px 0 0 rgba(255, 255, 255, 0.16); }
</style>
