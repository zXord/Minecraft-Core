<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  export let currentRuntime = null;
  export let busy = false;
  const pageSize = 20;
  let query = '';
  let categoriesText = '';
  let gameVersion = '';
  let loader = '';
  let serverCompatibility = 'compatible';
  let sort = 'updated';
  let offset = 0;
  let items = [];
  let pagination = { offset: 0, limit: pageSize, total: 0 };
  let selectedProject = null;
  let projectDetails = null;
  let versions = [];
  let loadingCatalog = false;
  let loadingProject = false;
  let catalogError = null;
  let projectError = null;
  let versionsError = null;
  let requestSequence = 0;
  let projectRequestSequence = 0;

  $: categories = categoriesText.split(',').map(value => value.trim()).filter(Boolean);
  $: currentPage = Math.floor((pagination.offset || 0) / (pagination.limit || pageSize)) + 1;
  $: totalPages = Math.max(1, Math.ceil((pagination.total || 0) / (pagination.limit || pageSize)));
  $: githubSourceCandidate = projectDetails?.upstreamLinkCandidates?.find(candidate =>
    candidate.kind === 'source' && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/.test(candidate.urlCandidate)
  ) || null;

  function searchRequest() {
    return Object.fromEntries(Object.entries({
      query, categories, gameVersion, loader, serverCompatibility, sort, offset, limit: pageSize
    }).filter(([, value]) => value !== '' && (!Array.isArray(value) || value.length)));
  }

  async function search({ keepOffset = false } = {}) {
    if (busy) return;
    if (!keepOffset) offset = 0;
    const sequence = ++requestSequence;
    loadingCatalog = true;
    catalogError = null;
    try {
      const result = await modpackApi.searchCatalog(searchRequest());
      if (sequence !== requestSequence) return;
      items = result?.items || [];
      pagination = result?.pagination || { offset, limit: pageSize, total: items.length };
    } catch (caught) {
      if (sequence === requestSequence) catalogError = caught;
    } finally {
      if (sequence === requestSequence) loadingCatalog = false;
    }
  }

  async function openProject(project) {
    if (busy) return;
    const sequence = ++projectRequestSequence;
    selectedProject = project;
    projectDetails = null;
    versions = [];
    loadingProject = true;
    projectError = null;
    versionsError = null;
    const [detailsResult, versionsResult] = await Promise.allSettled([
        modpackApi.getProject(project.projectId),
        modpackApi.listVersions({ projectId: project.projectId })
      ]);
    if (sequence !== projectRequestSequence) return;
    if (detailsResult.status === 'fulfilled') projectDetails = detailsResult.value;
    else projectError = detailsResult.reason;
    if (versionsResult.status === 'fulfilled') versions = versionsResult.value;
    else versionsError = versionsResult.reason;
    if (sequence === projectRequestSequence) loadingProject = false;
  }

  function closeProject() {
    if (busy) return;
    dispatch('inspectionreset');
    projectRequestSequence += 1;
    selectedProject = null;
    projectDetails = null;
    versions = [];
    projectError = null;
    versionsError = null;
    loadingProject = false;
  }

  function chooseVersion(version) {
    if (busy || !selectedProject || !versions.some(candidate => candidate.versionId === version.versionId)) return;
    dispatch('select', {
      request: { provider: 'modrinth', projectId: selectedProject.projectId, versionId: version.versionId },
      label: `${projectDetails?.title || selectedProject.title} ${version.version || version.name || version.versionId}`
    });
  }

  function runtimeMessage(version) {
    if (!currentRuntime?.minecraftVersion || !currentRuntime?.loaderFamily) {
      return 'This pack selects its runtime. Archive inspection confirms the exact runtime.';
    }
    const matchesMinecraft = version.minecraftVersions?.includes(currentRuntime.minecraftVersion);
    const matchesLoader = version.loaders?.includes(currentRuntime.loaderFamily);
    return matchesMinecraft && matchesLoader
      ? 'Advertises the current Minecraft version and loader family. Archive inspection must confirm the exact runtime and loader version.'
      : 'Advertises a different Minecraft version or loader family. Archive inspection must confirm the exact runtime and loader version.';
  }

  function reviewLinkedGithub() {
    if (busy || !githubSourceCandidate) return;
    dispatch('github', {
      repositoryUrl: githubSourceCandidate.urlCandidate,
      modrinthProjectId: selectedProject.projectId
    });
  }

  async function page(delta) {
    if (busy) return;
    const next = Math.max(0, Math.min((totalPages - 1) * pageSize, offset + delta * pageSize));
    if (next === offset) return;
    offset = next;
    await search({ keepOffset: true });
  }

  onMount(() => search({ keepOffset: true }));
</script>

<div class="modpack-surface mp-stack">
  <div class="mp-toolbar">
    <div class="grow">
      <p class="mp-kicker">Modrinth</p>
      <h2 class="mp-title">Browse server modpacks</h2>
      <p class="mp-subtitle">Catalog filters guide discovery only. Every project opens its complete exact version history.</p>
    </div>
    <button type="button" class="mp-button" disabled={busy} on:click={() => dispatch('back')}>Change source</button>
  </div>

  <form class="mp-panel mp-stack" role="search" aria-label="Search Modrinth modpacks" on:submit|preventDefault={() => search()}>
    <div class="filters">
      <label class="mp-field wide">Search<input class="mp-input" bind:value={query} disabled={busy} placeholder="Factory, adventure, Create…" /></label>
      <label class="mp-field">Categories<input class="mp-input" bind:value={categoriesText} disabled={busy} placeholder="technology, quests" /></label>
      <label class="mp-field">Minecraft version<input class="mp-input" bind:value={gameVersion} disabled={busy} placeholder="1.21.1" /></label>
      <label class="mp-field">Loader<select class="mp-select" bind:value={loader} disabled={busy}><option value="">Any loader</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option><option value="quilt">Quilt</option><option value="vanilla">Vanilla</option></select></label>
      <label class="mp-field">Server compatibility<select class="mp-select" bind:value={serverCompatibility} disabled={busy}><option value="compatible">Compatible</option><option value="required">Required</option><option value="optional">Optional</option><option value="unknown">Unknown</option></select></label>
      <label class="mp-field">Sort<select class="mp-select" bind:value={sort} disabled={busy}><option value="updated">Recently updated</option><option value="downloads">Downloads</option></select></label>
    </div>
    <div class="mp-actions"><button class="mp-button primary" type="submit" disabled={loadingCatalog || busy}>{loadingCatalog ? 'Loading…' : 'Search'}</button></div>
  </form>

  {#if catalogError && !selectedProject}
    <section class="mp-state error" tabindex="-1" aria-live="assertive">
      <strong>{catalogError.code === 'INVALID_RELEASE_URL' ? 'Modrinth is offline or rate limited' : 'Could not load Modrinth'}</strong>
      <p>{catalogError.message}{catalogError.code === 'INVALID_RELEASE_URL' ? ' Your filters and current page were preserved for a Retry.' : ''}</p>
      <div class="mp-actions"><button class="mp-button" type="button" disabled={busy} on:click={() => search({ keepOffset: true })}>Retry</button><button class="mp-button" type="button" disabled={busy} on:click={() => dispatch('local')}>Import local archive</button><button class="mp-button" type="button" disabled={busy} on:click={() => dispatch('custom')}>Empty/Custom Server</button></div>
    </section>
  {/if}

  {#if selectedProject}
    <section class="mp-panel mp-stack" aria-label="Selected Modrinth project">
      <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Project detail</p><h3 class="mp-title">{projectDetails?.title || selectedProject.title}</h3><p class="mp-subtitle">{projectDetails?.description || projectDetails?.summary || selectedProject.summary || 'No description was published.'}</p></div><button class="mp-button" type="button" disabled={busy} on:click={closeProject}>Back to results</button></div>
      {#if projectError}<div class="mp-state error" role="alert" aria-live="assertive"><strong>Project details unavailable</strong><p>{projectError.message}</p></div>{/if}
      {#if projectDetails}
        <div class="mp-grid">
          <div class="mp-card"><strong>Supported runtimes</strong><p class="mp-muted">Minecraft {projectDetails.runtimes?.minecraftVersions?.join(', ') || 'not stated'} · {projectDetails.runtimes?.loaders?.join(', ') || 'loader not stated'}</p></div>
          <div class="mp-card"><strong>Gallery</strong><p class="mp-muted">{projectDetails.galleryCandidates?.length || 0} published image{projectDetails.galleryCandidates?.length === 1 ? '' : 's'} available for this project.</p></div>
          <div class="mp-card"><strong>Server support</strong><p class="mp-muted">{projectDetails.serverCompatibility || selectedProject.serverCompatibility || 'unknown'}</p></div>
        </div>
        {#if githubSourceCandidate}<div class="mp-state"><strong>Linked GitHub Releases are available</strong><p>The project publishes a GitHub source link. Minecraft Core will require your explicit approval, resolve its permanent public repository identity, and still make you review the uploaded release assets.</p><button class="mp-button" type="button" disabled={busy} on:click={reviewLinkedGithub}>Review linked GitHub Releases</button></div>{/if}
      {/if}
      <div><h3>Exact version history</h3><p class="mp-muted">Choose one immutable version ID. Minecraft Core never substitutes “latest.”</p></div>
      {#if loadingProject}<div class="mp-state">Loading exact version history…</div>{:else if versionsError}<div class="mp-state error" role="alert" aria-live="assertive"><strong>Version history unavailable</strong><p>{versionsError.message}</p></div>{:else if versions.length === 0}<div class="mp-state">This project has no published versions.</div>{:else}<ul class="mp-list">{#each versions as version (version.versionId)}<li><button class="mp-row" type="button" disabled={busy} on:click={() => chooseVersion(version)}><span><strong>{version.version || version.name || version.versionId}</strong><br /><span class="mp-muted">Published {new Date(version.publishedAt).toLocaleString()} · {version.minecraftVersions?.join(', ')} · {version.loaders?.join(', ')}</span><br /><span class="mp-muted">{runtimeMessage(version)}</span></span><span class="mp-badge {version.channel === 'release' ? 'good' : 'warn'}">{version.channel}</span></button></li>{/each}</ul>{/if}
    </section>
  {:else}
    <section class="mp-panel mp-stack" aria-busy={loadingCatalog}>
      <div class="mp-toolbar"><strong class="grow">{pagination.total || 0} matching modpacks</strong><span class="mp-muted">Page {currentPage} of {totalPages}</span><button class="mp-button" type="button" disabled={currentPage <= 1 || loadingCatalog || busy} on:click={() => page(-1)}>Previous</button><button class="mp-button" type="button" disabled={currentPage >= totalPages || loadingCatalog || busy} on:click={() => page(1)}>Next</button></div>
      {#if loadingCatalog && items.length === 0}<div class="mp-state">Loading Modrinth catalog…</div>{:else if items.length === 0}<div class="mp-state">No server modpacks match these filters. Try broader compatibility or a different Minecraft version.</div>{:else}<div class="mp-grid">{#each items as project (project.projectId)}<button class="mp-card result-card" type="button" disabled={busy} on:click={() => openProject(project)}><span class="mp-badge {project.serverCompatibility === 'required' ? 'good' : ''}">{project.serverCompatibility || 'unknown'} server support</span><strong>{project.title}</strong><span>{project.summary || 'No description published.'}</span><small>{project.downloads?.toLocaleString?.() || project.downloads || 0} downloads · updated {new Date(project.updatedAt).toLocaleDateString()}</small></button>{/each}</div>{/if}
    </section>
  {/if}
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 0.75rem; }
  .filters .wide { grid-column: span 2; }
  .result-card { display: grid; gap: 0.65rem; color: inherit; text-align: left; font: inherit; cursor: pointer; }
  .result-card:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.3); transform: translateY(-1px); }
  .result-card:focus-visible { border-color: rgba(196, 199, 255, 0.78); outline: 2px solid rgba(196, 199, 255, 0.72); outline-offset: 2px; }
  .result-card > span:not(.mp-badge), .result-card small { color: var(--mp-muted); }
  @media (max-width: 520px) { .filters .wide { grid-column: span 1; } }
</style>
