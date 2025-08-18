<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import { SvelteSet } from 'svelte/reactivity';
  import { minecraftVersion } from '../../stores/modStore.js';

  type Mode = 'required' | 'client';

  export let mode: Mode = 'required';
  export let title = '';
  export let description = '';
  // For required: items are server-provided { fileName }
  // For client: items are local assets { fileName, enabled }
  export let items: Array<any> = [];
  // Installed list for required mode to determine presence
  export let installedItems: Array<any> = [];

  const dispatch = createEventDispatcher();
  let expanded: Record<string, boolean> = {};
  let versionsCache: Record<string, Array<any>> = {};
  let updatesInfo: Record<string, { latest: any } | null> = {};
  const pending: Set<string> = new SvelteSet();

  function isPresent(fileName: string) {
    return installedItems?.some(
      (a) => a.fileName?.toLowerCase() === fileName.toLowerCase()
    );
  }

  function handleDownload(item: any) {
    dispatch('download', { item });
  }

  // No enable/disable for assets

  function handleDelete(item: any) {
    dispatch('delete', { item });
  }

  function handleRemove(item: any) {
    dispatch('remove', { item });
  }

  async function toggleExpand(item: any) {
    const key = item.fileName;
    expanded[key] = !expanded[key];
    expanded = { ...expanded };
    if (expanded[key] && item.projectId && !versionsCache[item.projectId]) {
      // Lazy-load versions for this project
      try {
        const versions = await window.electron.invoke('get-mod-versions', {
          modId: item.projectId,
          source: 'modrinth'
        });
        versionsCache[item.projectId] = versions || [];
        versionsCache = { ...versionsCache };
        computeLatest(item.projectId);
      } catch (_) {}
    }
  }

  function installVersion(item: any, version: any) {
    dispatch('install-asset-version', { item, version });
  }

  // Determine if a required item needs update by comparing server vs installed
  function resolveUpdateStatus(serverItem: any) {
    const fileName = serverItem?.fileName || '';
    const installed = isPresent(fileName) ? getInstalledInfo(fileName) : null;
    const serverVersion = serverItem?.versionNumber || null;
    const installedVersion = installed?.versionNumber || null;
    const serverChecksum = serverItem?.checksum || null;
    const installedChecksum = installed?.checksum || null;
    let needUpdate = false;
    let reason = '';
    if (installed) {
      if (serverVersion && installedVersion && serverVersion !== installedVersion) {
        needUpdate = true; reason = 'version-mismatch';
      } else if (!serverVersion && serverChecksum && installedChecksum && serverChecksum !== installedChecksum) {
        needUpdate = true; reason = 'checksum-mismatch';
      } else if (serverVersion && !installedVersion) {
        // Server has a version but installed is unknown; prefer server
        needUpdate = true; reason = 'installed-unknown';
      }
    }
    try {
      console.debug('[ClientAssetList] required update check', {
        fileName,
        serverVersion,
        installedVersion,
        serverChecksum: serverChecksum?.slice(0,8),
        installedChecksum: installedChecksum?.slice(0,8),
        needUpdate,
        reason
      });
    } catch {}
    return { needUpdate, serverVersion, installedVersion };
  }

  // Utility: find installed info for a required item
  function getInstalledInfo(fileName: string) {
    return installedItems?.find((a) => a.fileName?.toLowerCase() === fileName.toLowerCase());
  }

  // Compute latest compatible version per projectId
  function computeLatest(projectId: string) {
    const versions = versionsCache[projectId] || [];
    if (!versions.length) {
      updatesInfo[projectId] = null;
      updatesInfo = { ...updatesInfo };
      return;
    }
    const mc = get(minecraftVersion) || '';
    // Prefer versions compatible with current MC version
    const compatible = versions.filter((v: any) => Array.isArray(v.gameVersions) ? v.gameVersions.includes(mc) : false);
    const pool = compatible.length ? compatible : versions;
    pool.sort((a: any, b: any) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime());
    updatesInfo[projectId] = { latest: pool[0] };
    updatesInfo = { ...updatesInfo };
  }

  // Background-fetch versions for rows that have projectId
  async function scheduleFetch(projectId: string) {
    if (!projectId || versionsCache[projectId] || pending.has(projectId)) return;
    try {
      pending.add(projectId);
      const versions = await window.electron.invoke('get-mod-versions', {
        modId: projectId,
        source: 'modrinth'
      });
      versionsCache[projectId] = versions || [];
      versionsCache = { ...versionsCache };
      computeLatest(projectId);
    } catch (_) {
    } finally {
      pending.delete(projectId);
    }
  }

  // React to incoming items/installedItems
  $: {
    const list = mode === 'required' ? installedItems : items;
    (list || []).forEach((it: any) => {
      if (it?.projectId) scheduleFetch(it.projectId);
    });
  }
</script>

<div class="client-asset-list">
  <div class="table-container">
  <table class="client-mods-table" class:required-table={mode === 'required'} class:optional-table={mode !== 'required'}>
      <thead>
        <tr class="section-header {mode}">
          <td colspan="4">
            <div class="section-header-content">
              <h3>{title}</h3>
              {#if description}
                <p class="section-description">{description}</p>
              {/if}
            </div>
          </td>
        </tr>
        {#if items.length > 0}
          <tr class="column-headers">
            <th>File</th>
            <th class="version">Version</th>
            <th class="upd">Update</th>
            <th class="act">Actions</th>
          </tr>
        {/if}
      </thead>
      <tbody>
        {#each items as it (it.fileName)}
          <tr>
            <td>
              <div class="mod-name-cell">
                {#if mode === 'client' && it.projectId}
                  <button class="chev" on:click={() => toggleExpand(it)} aria-label="Toggle versions">{expanded[it.fileName] ? '▾' : '▸'}</button>
                {/if}
                <strong>{it.fileName}</strong>
              </div>
            </td>
            <td class="version">
              {#if mode === 'required'}
                {#if it.needsRemoval}
                  <span class="tag disabled">To Remove</span>
                {:else}
                  {#if isPresent(it.fileName)}
                    {@const inst = getInstalledInfo(it.fileName)}
                    {#if inst?.versionNumber}
                      <span class="tag ok" title={inst?.name ? `${inst.name}` : ''}>{inst.versionNumber}</span>
                    {:else}
                      <span class="tag warn">Unknown</span>
                    {/if}
                  {:else}
                    <span class="tag missing">Missing</span>
                  {/if}
                {/if}
              {:else}
                {#if it.versionNumber}
                  <span class="tag ok" title={it.name ? `${it.name}` : ''}>{it.versionNumber}</span>
                {:else}
                  <span class="tag warn">Unknown</span>
                {/if}
              {/if}
            </td>
            <td class="upd">
              {#if mode === 'required'}
                {@const inst = isPresent(it.fileName) ? getInstalledInfo(it.fileName) : null}
                {#if it.needsRemoval}
                  <span class="tag warn">—</span>
                {:else if inst}
                  {@const upd = resolveUpdateStatus(it)}
                  {#if upd.needUpdate}
                    <button class="primary sm" title={`Install server version ${upd.serverVersion || ''}`} on:click={() => handleDownload(it)}>
                      Update{upd.serverVersion ? ` to ${upd.serverVersion}` : ''}
                    </button>
                  {:else}
                    <span class="tag ok">Up to date</span>
                  {/if}
                {:else}
                  <span class="tag warn">—</span>
                {/if}
              {:else}
                {#if it.projectId}
                  {@const info = updatesInfo[it.projectId]}
                  {#if info && info.latest}
                    {@const latestId = info.latest.id}
                    {@const installedId = it.versionId}
                    {@const norm = (v) => (typeof v === 'string' ? v.trim().replace(/^v/i, '') : v)}
                    {@const latestVer = norm(info.latest.versionNumber || info.latest.version_number)}
                    {@const installedVer = norm(it.versionNumber)}
                    {#if (installedId && latestId && installedId !== latestId) || (!installedId && (!installedVer || (latestVer && latestVer !== installedVer)))}
                      <button class="primary sm" title={`Install ${info.latest.versionNumber || info.latest.version_number}`} on:click={() => installVersion(it, info.latest)}>
                        Update to {info.latest.versionNumber || info.latest.version_number}
                      </button>
                    {:else}
                      <span class="tag ok">Up to date</span>
                    {/if}
                  {:else}
                    <span class="tag warn">Checking…</span>
                  {/if}
                {:else}
                  <span class="tag warn">—</span>
                {/if}
              {/if}
            </td>
            <td class="act">
              {#if mode === 'required'}
                {#if it.needsRemoval}
                  <button class="danger sm" on:click={() => handleRemove(it)}>❌ Remove</button>
                {:else}
                  {#if !isPresent(it.fileName)}
                    <button class="primary sm" on:click={() => handleDownload(it)}>📥 Download</button>
                  {:else}
                    <span class="required-tag">Required</span>
                  {/if}
                {/if}
              {:else}
                <div class="action-group">
                  <button class="danger sm" on:click={() => handleDelete(it)}>🗑️</button>
                </div>
              {/if}
            </td>
          </tr>
          {#if mode === 'client' && it.projectId && expanded[it.fileName]}
            <tr class="versions-row">
              <td colspan="4">
                {#if versionsCache[it.projectId] && versionsCache[it.projectId].length > 0}
                  <div class="versions-list">
                    {#each versionsCache[it.projectId].slice(0, 10) as ver (ver.id)}
                      <button class="version-pill" title={ver.gameVersions?.join(', ') || ''} on:click={() => installVersion(it, ver)}>
                        {ver.versionNumber || ver.version_number}
                      </button>
                    {/each}
                  </div>
                {:else}
                  <div class="versions-list empty">No versions found.</div>
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
      {#if items.length === 0}
        <tbody>
          <tr class="empty-state">
            <td colspan="4">
              <p>No items found.</p>
            </td>
          </tr>
        </tbody>
      {/if}
    </table>
  </div>
</div>

<style>
  .client-asset-list {
    --row-py: 3px;
    --cell-px: 6px;
    --col-ok: #14a047;
    --col-warn: #c9801f;
    --col-danger: #b33;
    --col-primary: #0a84ff;
    --bg-primary: #181818;
    --bg-secondary: #141414;
    --bg-tertiary: #1a1a1a;
    --text-primary: #ddd;
    --text-secondary: #aaa;
    --border-color: #333;
  }

  .table-container {
    width: 100%;
    overflow-x: auto;
    border: 1px solid #374151;
    border-radius: 6px;
  }

  .client-mods-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
    background: linear-gradient(to bottom, var(--bg-primary), var(--bg-secondary));
  }

  .client-mods-table th,
  .client-mods-table td {
    padding: var(--row-py) var(--cell-px);
  }

  .client-mods-table thead { background: var(--bg-tertiary); position: sticky; top: 0; z-index: 6; }
  .client-mods-table th { text-align: center; }
  .client-mods-table th:first-child { text-align: left; }
  .client-mods-table tbody tr:nth-child(even) { background: rgba(24,24,24,0.8); }
  .client-mods-table tbody tr:hover { background: #212121; box-shadow: 0 0 4px rgba(255,255,255,0.1); }

  .section-header td { background-color: #1f2937; border-top: 3px solid #3b82f6; padding: 0.75rem var(--cell-px) !important; }
  .section-header.required td { border-top-color: #ef4444; }
  .section-header.client td { border-top-color: #f59e0b; }
  .section-header-content { text-align: center; }
  .section-header h3 { color: white; margin: 0 0 0.15rem 0; font-size: 1rem; font-weight: 600; }
  .section-header .section-description { color: #9ca3af; font-size: 0.8rem; margin: 0; line-height: 1.3; }

  .client-mods-table td:first-child { text-align: left; }
  .client-mods-table th.version, .client-mods-table td.version { width: 140px; min-width: 120px; text-align: center; }
  .client-mods-table th.upd, .client-mods-table td.upd { width: 140px; min-width: 120px; text-align: center; }
  .client-mods-table th.act, .client-mods-table td.act { width: 140px; min-width: 110px; text-align: center; }

  .mod-name-cell strong { color: var(--text-primary); font-weight: 600; word-break: break-word; }
  .mod-name-cell { display: flex; align-items: center; gap: 6px; }
  .chev { background: transparent; border: none; color: #9ca3af; cursor: pointer; font-size: 0.9rem; padding: 0 2px; }
  .chev:hover { color: #fff; }

  .tag { padding: 1px 6px; border-radius: 3px; font-size: 0.75rem; font-weight: 500; text-align: center; white-space: nowrap; }
  .tag.ok { background: rgba(20,160,71,0.2); color: var(--col-ok); }
  .tag.warn { background: rgba(200,128,31,0.2); color: var(--col-warn); }
  .tag.disabled { background: rgba(179,51,51,0.2); color: var(--col-danger); }
  .tag.missing { background: rgba(179,51,51,0.2); color: var(--col-danger); }

  .primary, .danger, .toggle { padding: 2px 8px; border: none; border-radius: 3px; font-size: 0.75rem; font-weight: 500; cursor: pointer; transition: all 0.2s; }
  .sm { font-size: 0.7rem; padding: 1px 6px; }
  .primary { background: var(--col-primary); color: white; }
  .primary:hover { background: #2563eb; }
  .danger { background: var(--col-danger); color: white; }
  .danger:hover { background: #990000; }
  .toggle { background: rgba(168,85,247,0.2); color: #a855f7; border: 1px solid rgba(168,85,247,0.3); }
  .toggle:hover { background: rgba(168,85,247,0.3); }
  .action-group { display: flex; gap: 4px; align-items: center; justify-content: center; }
  .required-tag { font-size: 0.75rem; color: var(--col-danger); font-weight: 500; }

  .empty-state { text-align: center; padding: 2rem; color: #9ca3af; font-style: italic; background-color: #1f2937; border: 1px solid #374151; border-top: none; border-radius: 0 0 6px 6px; }
  .versions-row td { background: #101418; border-top: 1px solid #223; }
  .versions-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .version-pill { background: #1f2937; color: #e5e7eb; border: 1px solid #374151; border-radius: 12px; padding: 2px 8px; font-size: 0.75rem; cursor: pointer; }
  .version-pill:hover { background: #2b3646; }
</style>
