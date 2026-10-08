<script>
  import { createEventDispatcher } from 'svelte';
  import ModpackInspectionProgress from '../modpacks/ModpackInspectionProgress.svelte';

  const dispatch = createEventDispatcher();
  export let release;
  export let assetResult = { assets: [], choices: [], status: 'ready' };
  export let busy = false;
  export let inspectionProgress = null;
  let selectedAssetIds = [];
  let rememberPattern = false;
  let initializedAssetResult = null;

  $: uploadedAssets = assetResult?.assets || [];
  $: choices = assetResult?.choices?.length ? assetResult.choices : uploadedAssets.map(asset => ({
    id: asset.assetId,
    assetIds: [asset.assetId],
    fileName: asset.fileName,
    size: asset.size,
    role: asset.role || 'provisional',
    complete: asset.installableCandidate !== false,
    missingVolumes: []
  }));
  $: if (assetResult !== initializedAssetResult) initializeSuggestedSelection(assetResult, choices);
  $: selectedChoice = choices.find(choice => {
    const ids = choiceIds(choice);
    return ids.length === selectedAssetIds.length && ids.every(id => selectedAssetIds.includes(id));
  });
  $: selectionBlocked = !selectedChoice || selectedChoice.complete === false || (selectedChoice.missingVolumes?.length || 0) > 0;

  function choiceIds(choice) {
    if (Array.isArray(choice?.parts)) {
      return choice.parts.map(part => part.providerAssetId || part.assetId || part.partId).filter(Boolean);
    }
    if (Array.isArray(choice?.assetIds)) return choice.assetIds.filter(Boolean);
    return [choice?.assetId].filter(Boolean);
  }

  function initializeSuggestedSelection(result, availableChoices) {
    initializedAssetResult = result;
    selectedAssetIds = [];
    const suggestedAssetIds = Array.isArray(result?.suggestedAssetIds)
      ? result.suggestedAssetIds.filter(id => typeof id === 'string' && id.length > 0)
      : [];
    if (suggestedAssetIds.length === 0 || suggestedAssetIds.length !== result.suggestedAssetIds.length) return;
    const matchingChoices = availableChoices.filter(choice => {
      if (choice.complete === false || (choice.missingVolumes?.length || 0) > 0) return false;
      const ids = choiceIds(choice);
      return ids.length === suggestedAssetIds.length && ids.every(id => suggestedAssetIds.includes(id));
    });
    if (matchingChoices.length === 1) selectedAssetIds = [...suggestedAssetIds];
  }

  function choiceName(choice) {
    if (choice?.fileName || choice?.name) return choice.fileName || choice.name;
    const names = choice?.parts?.map(part => part.fileName).filter(Boolean) || [];
    if (names.length === 1) return names[0];
    return names.length > 1 ? `${names[0]} and ${names.length - 1} more` : 'Reviewed archive set';
  }

  function selectChoice(choice) {
    if (choice.complete === false || choice.missingVolumes?.length) return;
    selectedAssetIds = choiceIds(choice);
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes)) return String(value || 'Unknown size');
    const units = ['B', 'KB', 'MB', 'GB'];
    let amount = bytes;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
    return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function continueWithAsset() {
    if (selectionBlocked) return;
    dispatch('select', {
      request: {
        provider: 'github',
        repositoryId: release.repositoryId,
        releaseId: release.releaseId,
        assetIds: selectedAssetIds
      },
      rememberPattern,
      label: `${release.name || release.tagName}: ${choiceName(selectedChoice)}`
    });
  }
</script>

<div class="modpack-surface mp-stack">
  <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Uploaded asset review</p><h2 class="mp-title">{release?.name || release?.tagName}</h2><p class="mp-subtitle">Labels are provisional until the selected bytes pass format, archive-safety, and runtime inspection. Compressed file data will be verified once during protected setup.</p></div><button class="mp-button" type="button" on:click={() => dispatch('back')}>Choose another release</button></div>

  {#if assetResult?.status === 'NO_INSTALLABLE_ASSET'}
    <section class="mp-state warning" tabindex="-1"><strong>NO_INSTALLABLE_ASSET</strong><p>This release has no uploaded ZIP, RAR, or MRPACK candidate. Generated GitHub source archives are not server packs.</p><div class="mp-actions"><button class="mp-button" type="button" on:click={() => dispatch('local')}>Import local archive</button><button class="mp-button" type="button" on:click={() => dispatch('custom')}>Empty/Custom Server</button></div></section>
  {:else}
    <section class="mp-panel mp-stack">
      <h3>All uploaded assets and multipart groups</h3>
      <div class="mp-list" role="radiogroup" aria-label="GitHub uploaded asset selection">
        {#each choices as choice (choice.primaryPartId || choice.id || choice.assetId || choice.fileName)}
          {@const ids = choiceIds(choice)}
          {@const unavailable = choice.complete === false || (choice.missingVolumes?.length || 0) > 0}
          <button type="button" class="mp-row" class:selected={selectedChoice === choice} role="radio" aria-checked={selectedChoice === choice} disabled={unavailable || busy} on:click={() => selectChoice(choice)}>
            <span><strong>{choiceName(choice)}</strong><br /><span class="mp-muted">{ids.length > 1 ? `${ids.length} uploaded parts · ` : ''}{formatBytes(choice.combinedSize || choice.size)} · provisional role: {choice.role || 'Unknown'}</span>{#if unavailable}<br /><span class="mp-danger">Incomplete or ambiguous: {choice.missingVolumes?.join(', ') || 'selection gap requires review'}</span>{/if}</span>
            <span class="choice-badges">
              {#if selectedChoice === choice}<span class="mp-badge selected-badge"><span aria-hidden="true">✓</span><span>Selected</span></span>{/if}
              <span class="mp-badge {unavailable ? 'danger' : 'warn'}">{unavailable ? 'Unavailable' : 'Provisional'}</span>
            </span>
          </button>
        {/each}
      </div>
      <details>
        <summary>Asset metadata, timestamps, and digest availability</summary>
        <ul class="metadata-list">
          {#each uploadedAssets as asset (asset.assetId)}
            <li><strong>{asset.fileName}</strong> — {formatBytes(asset.size)} — uploaded {new Date(asset.createdAt).toLocaleString()} — updated {new Date(asset.updatedAt).toLocaleString()} — digest {asset.providerDigest ? `${asset.providerDigest.algorithm} available` : 'missing'}</li>
          {/each}
        </ul>
      </details>
      <label class="remember"><input type="checkbox" bind:checked={rememberPattern} disabled={selectionBlocked} /><span><strong>Use this asset pattern for future releases</strong><br /><small>This is opt-in. Zero or multiple future matches will still require asset selection.</small></span></label>
      {#if busy}<ModpackInspectionProgress progress={inspectionProgress || { phase: 'resolving' }} />{/if}
      <div class="mp-actions"><button type="button" class="mp-button primary" disabled={selectionBlocked || busy} on:click={continueWithAsset}>{busy ? 'Inspection in progress…' : 'Download and inspect selected asset'}</button></div>
    </section>
  {/if}
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  .metadata-list { color: var(--mp-muted); line-height: 1.65; }
  .remember { display: flex; gap: 0.6rem; align-items: flex-start; }
  .remember input { margin-top: 0.25rem; }
  summary { cursor: pointer; color: #c4c7ff; }
  .choice-badges { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.4rem; }
  .selected-badge { color: rgba(255, 255, 255, 0.88); border-color: rgba(255, 255, 255, 0.38); background: rgba(255, 255, 255, 0.09); }
</style>
