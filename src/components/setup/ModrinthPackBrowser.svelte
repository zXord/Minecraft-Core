<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  const pageSize = 20;
  let query = '';
  let categoriesText = '';
  let gameVersion = '';
  let loader = '';
  let channel = 'release';
  let serverCompatibility = 'compatible';
  let sort = 'updated';
  let offset = 0;
  let items = [];
  let pagination = { offset: 0, limit: pageSize, total: 0 };
  let selectedProject = null;
  let projectDetails = null;
  let versions = [];
  let loading = false;
  let error = null;
  let requestSequence = 0;

  $: categories = categoriesText.split(',').map(value => value.trim()).filter(Boolean);
  $: currentPage = Math.floor((pagination.offset || 0) / (pagination.limit || pageSize)) + 1;
  $: totalPages = Math.max(1, Math.ceil((pagination.total || 0) / (pagination.limit || pageSize)));
  $: visibleVersions = versions.filter(version => channel === 'all' || version.channel === channel);
  $: githubSourceCandidate = projectDetails?.upstreamLinkCandidates?.find(candidate =>
    candidate.kind === 'source' && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/.test(candidate.urlCandidate)
  ) || null;

  function searchRequest() {
    return Object.fromEntries(Object.entries({
      query, categories, gameVersion, loader, serverCompatibility, sort, offset, limit: pageSize
    }).filter(([, value]) => value !== '' && (!Array.isArray(value) || value.length)));
  }

  async function search({ keepOffset = false } = {}) {
    if (!keepOffset) offset = 0;
    const sequence = ++requestSequence;
    loading = true;
    error = null;
    try {
      const result = await modpackApi.searchCatalog(searchRequest());
      if (sequence !== requestSequence) return;
      items = result?.items || [];
      pagination = result?.pagination || { offset, limit: pageSize, total: items.length };
    } catch (caught) {
      if (sequence === requestSequence) error = caught;
    } finally {
      if (sequence === requestSequence) loading = false;
    }
  }

  async function openProject(project) {
    selectedProject = project;
    projectDetails = null;
    versions = [];
    loading = true;
    error = null;
    try {
      [projectDetails, versions] = await Promise.all([
        modpackApi.getProject(project.projectId),
        modpackApi.listVersions({
          projectId: project.projectId,
          ...(gameVersion ? { gameVersions: [gameVersion] } : {}),
          ...(loader ? { loaders: [loader] } : {}),
          channels: channel === 'all' ? ['release', 'beta', 'alpha'] : [channel]
        })
      ]);
    } catch (caught) {
      error = caught;
    } finally {
      loading = false;
    }
  }

  function keyboardOpen(event, project) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openProject(project);
    }
  }

  function chooseVersion(version) {
    dispatch('select', {
      request: { provider: 'modrinth', projectId: selectedProject.projectId, versionId: version.versionId },
      label: `${projectDetails?.title || selectedProject.title} ${version.version || version.name || version.versionId}`
    });
  }

  function reviewLinkedGithub() {
    if (!githubSourceCandidate) return;
    dispatch('github', {
      repositoryUrl: githubSourceCandidate.urlCandidate,
      modrinthProjectId: selectedProject.projectId
    });
  }

  async function page(delta) {
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
      <p class="mp-subtitle">Filters, paging, and exact version history remain selected if a request fails.</p>
    </div>
    <button type="button" class="mp-button" on:click={() => dispatch('back')}>Change source</button>
  </div>

  <form class="mp-panel mp-stack" role="search" aria-label="Search Modrinth modpacks" on:submit|preventDefault={() => search()}>
    <div class="filters">
      <label class="mp-field wide">Search<input class="mp-input" bind:value={query} placeholder="Factory, adventure, Create…" /></label>
      <label class="mp-field">Categories<input class="mp-input" bind:value={categoriesText} placeholder="technology, quests" /></label>
      <label class="mp-field">Minecraft version<input class="mp-input" bind:value={gameVersion} placeholder="1.21.1" /></label>
      <label class="mp-field">Loader<select class="mp-select" bind:value={loader}><option value="">Any loader</option><option value="fabric">Fabric</option><option value="forge">Forge</option><option value="neoforge">NeoForge</option><option value="quilt">Quilt</option><option value="vanilla">Vanilla</option></select></label>
      <label class="mp-field">Channel<select class="mp-select" bind:value={channel}><option value="release">Release</option><option value="beta">Beta</option><option value="alpha">Alpha</option><option value="all">All channels</option></select></label>
      <label class="mp-field">Server compatibility<select class="mp-select" bind:value={serverCompatibility}><option value="compatible">Compatible</option><option value="required">Required</option><option value="optional">Optional</option><option value="unknown">Unknown</option></select></label>
      <label class="mp-field">Sort<select class="mp-select" bind:value={sort}><option value="updated">Recently updated</option><option value="downloads">Downloads</option></select></label>
    </div>
    <div class="mp-actions"><button class="mp-button primary" type="submit" disabled={loading}>{loading ? 'Loading…' : 'Search'}</button></div>
  </form>

  {#if error}
    <section class="mp-state error" tabindex="-1" aria-live="assertive">
      <strong>{error.code === 'INVALID_RELEASE_URL' ? 'Modrinth is offline or rate limited' : 'Could not load Modrinth'}</strong>
      <p>{error.message}{error.code === 'INVALID_RELEASE_URL' ? ' Your filters and current page were preserved for a Retry.' : ''}</p>
      <div class="mp-actions"><button class="mp-button" type="button" on:click={() => search({ keepOffset: true })}>Retry</button><button class="mp-button" type="button" on:click={() => dispatch('local')}>Import local archive</button><button class="mp-button" type="button" on:click={() => dispatch('custom')}>Empty/Custom Server</button></div>
    </section>
  {/if}

  {#if selectedProject}
    <section class="mp-panel mp-stack" aria-label="Selected Modrinth project">
      <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Project detail</p><h3 class="mp-title">{projectDetails?.title || selectedProject.title}</h3><p class="mp-subtitle">{projectDetails?.description || projectDetails?.summary || selectedProject.summary || 'No description was published.'}</p></div><button class="mp-button" type="button" on:click={() => { selectedProject = null; projectDetails = null; versions = []; }}>Back to results</button></div>
      {#if projectDetails}
        <div class="mp-grid">
          <div class="mp-card"><strong>Supported runtimes</strong><p class="mp-muted">Minecraft {projectDetails.runtimes?.minecraftVersions?.join(', ') || 'not stated'} · {projectDetails.runtimes?.loaders?.join(', ') || 'loader not stated'}</p></div>
          <div class="mp-card"><strong>Gallery</strong><p class="mp-muted">{projectDetails.galleryCandidates?.length || 0} published image{projectDetails.galleryCandidates?.length === 1 ? '' : 's'} available for this project.</p></div>
          <div class="mp-card"><strong>Server support</strong><p class="mp-muted">{projectDetails.serverCompatibility || selectedProject.serverCompatibility || 'unknown'}</p></div>
        </div>
        {#if githubSourceCandidate}<div class="mp-state"><strong>Linked GitHub Releases are available</strong><p>The project publishes a GitHub source link. Minecraft Core will require your explicit approval, resolve its permanent public repository identity, and still make you review the uploaded release assets.</p><button class="mp-button" type="button" on:click={reviewLinkedGithub}>Review linked GitHub Releases</button></div>{/if}
      {/if}
      <div><h3>Exact version history</h3><p class="mp-muted">Choose one immutable version ID. Minecraft Core never substitutes “latest.”</p></div>
      {#if loading}<div class="mp-state">Loading exact version history…</div>{:else if visibleVersions.length === 0}<div class="mp-state warning">No versions match the selected Minecraft, loader, and channel filters.</div>{:else}<ul class="mp-list">{#each visibleVersions as version (version.versionId)}<li><button class="mp-row" type="button" on:click={() => chooseVersion(version)}><span><strong>{version.version || version.name || version.versionId}</strong><br /><span class="mp-muted">Published {new Date(version.publishedAt).toLocaleString()} · {version.minecraftVersions?.join(', ')} · {version.loaders?.join(', ')}</span></span><span class="mp-badge {version.channel === 'release' ? 'good' : 'warn'}">{version.channel}</span></button></li>{/each}</ul>{/if}
    </section>
  {:else}
    <section class="mp-panel mp-stack" aria-busy={loading}>
      <div class="mp-toolbar"><strong class="grow">{pagination.total || 0} matching modpacks</strong><span class="mp-muted">Page {currentPage} of {totalPages}</span><button class="mp-button" type="button" disabled={currentPage <= 1 || loading} on:click={() => page(-1)}>Previous</button><button class="mp-button" type="button" disabled={currentPage >= totalPages || loading} on:click={() => page(1)}>Next</button></div>
      {#if loading && items.length === 0}<div class="mp-state">Loading Modrinth catalog…</div>{:else if items.length === 0}<div class="mp-state">No server modpacks match these filters. Try broader compatibility or a different Minecraft version.</div>{:else}<div class="mp-grid">{#each items as project (project.projectId)}<button class="mp-card result-card" type="button" on:click={() => openProject(project)} on:keydown={(event) => keyboardOpen(event, project)}><span class="mp-badge {project.serverCompatibility === 'required' ? 'good' : ''}">{project.serverCompatibility || 'unknown'} server support</span><strong>{project.title}</strong><span>{project.summary || 'No description published.'}</span><small>{project.downloads?.toLocaleString?.() || project.downloads || 0} downloads · updated {new Date(project.updatedAt).toLocaleDateString()}</small></button>{/each}</div>{/if}
    </section>
  {/if}
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 0.75rem; }
  .filters .wide { grid-column: span 2; }
  .result-card { display: grid; gap: 0.65rem; color: inherit; text-align: left; font: inherit; cursor: pointer; }
  .result-card:hover, .result-card:focus-visible { border-color: rgba(124, 131, 255, 0.72); transform: translateY(-1px); }
  .result-card > span:not(.mp-badge), .result-card small { color: var(--mp-muted); }
  @media (max-width: 520px) { .filters .wide { grid-column: span 1; } }
</style>
