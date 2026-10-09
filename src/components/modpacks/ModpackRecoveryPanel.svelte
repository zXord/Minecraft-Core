<script>
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';
  import { filterPendingNewServerRecoveryRecords } from '../../utils/modpacks/serverRequestScope.js';

  const dispatch = createEventDispatcher();
  export let serverId = '';
  export let records = null;
  export let visibilityScope = '';
  export let context = 'server';
  export let hideWhenEmpty = false;
  export let status = null;
  export let loadError = null;
  export let actionError = null;
  export let pendingAction = '';
  export let onRefresh = null;
  export let onRecover = null;
  let error = null;
  let localActionError = null;
  let localStatus = records === null ? 'unknown' : 'ready';
  let activeAction = '';
  let refreshSequence = 0;
  let resolvedRecoveryIds = new Set();
  let destroyed = false;

  $: allRecords = Array.isArray(records) ? records : records?.items || [];
  $: scopedRecords = visibilityScope === 'pending-new-server'
    ? filterPendingNewServerRecoveryRecords(allRecords)
    : allRecords.filter(record => !serverId || record.serverId === serverId || record.instanceId === serverId || record.stableServerId === serverId);
  $: visibleRecords = scopedRecords.filter(record => !resolvedRecoveryIds.has(record?.recoveryId));
  $: setupContext = context === 'setup';
  $: currentStatus = status || localStatus;
  $: checking = currentStatus === 'unknown' || currentStatus === 'loading';
  $: currentLoadError = loadError || error;
  $: currentActionError = actionError || localActionError;
  $: actionInProgress = pendingAction || activeAction;
  $: confirmedEmpty = currentStatus === 'ready' && !currentLoadError &&
    scopedRecords.length === 0;
  $: hidden = hideWhenEmpty && confirmedEmpty;

  async function refresh() {
    if (actionInProgress) return;
    if (onRefresh) return onRefresh();
    return refreshStandalone();
  }

  async function refreshStandalone() {
    const sequence = ++refreshSequence;
    localStatus = 'loading';
    error = null;
    try {
      const refreshedRecords = await modpackApi.listRecovery();
      if (!destroyed && sequence === refreshSequence) {
        records = refreshedRecords;
        localStatus = 'ready';
        localActionError = null;
      }
    } catch (caught) {
      if (!destroyed && sequence === refreshSequence) {
        error = caught;
        localStatus = 'error';
      }
    }
  }

  async function recover(record, actionId) {
    if (actionInProgress) return;
    if (onRecover) return onRecover(record, actionId);
    activeAction = `${record.recoveryId}:${actionId}`;
    localActionError = null;
    let result;
    try {
      result = await modpackApi.recover(record.recoveryId, actionId);
    } catch (caught) {
      if (destroyed) return;
      localActionError = caught;
      activeAction = '';
      return;
    }
    if (destroyed) return;
    if (result?.resolved === true) {
      resolvedRecoveryIds = new Set([...resolvedRecoveryIds, record.recoveryId]);
    }
    dispatch('recovered', { record, actionId, result });
    try {
      await refreshStandalone();
    } finally {
      activeAction = '';
    }
  }

  onMount(() => { if (records === null) refresh(); });
  onDestroy(() => { destroyed = true; refreshSequence += 1; });
</script>

{#if !hidden}
  <section class="modpack-surface mp-panel mp-stack" aria-label={setupContext ? 'Setup recovery' : 'Modpack recovery'}>
    <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">{setupContext ? 'Setup recovery' : 'Recovery'}</p><h2 class="mp-title">{setupContext ? 'Unfinished server setup' : 'Durable recovery records'}</h2><p class="mp-subtitle">{setupContext ? 'A previous server setup stopped before it could be added to Minecraft Core. Resolve its saved transaction before reusing that destination.' : 'Starts and writes stay blocked until every ambiguous operation is resolved safely.'}</p></div><button class="mp-button" type="button" on:click={refresh} disabled={checking || Boolean(actionInProgress)}>{checking ? 'Checking…' : 'Refresh'}</button></div>
    {#if checking}<div class="mp-state" role="status">Checking recovery status…</div>{/if}
    {#if currentLoadError}<div class="mp-state error" tabindex="-1" aria-live="assertive"><strong>{setupContext ? 'Setup recovery could not be completed' : 'Recovery status unavailable'}</strong><p>{currentLoadError.message}</p></div>{/if}
    {#if currentActionError}<div class="mp-state error" tabindex="-1" aria-live="assertive"><strong>{setupContext ? 'Setup recovery could not be completed' : 'Recovery action could not be completed'}</strong><p>{currentActionError.message}</p></div>{/if}
    {#if currentStatus !== 'ready' && visibleRecords.length}<div class="mp-state">Previously loaded recovery records are not current. Refresh must succeed before page recovery actions are available.</div>{/if}
    {#if confirmedEmpty}<div class="mp-state"><strong>No recovery action is pending</strong><p>{setupContext ? 'No interrupted server setup is waiting for recovery.' : 'The server has no unresolved lifecycle transaction.'}</p></div>{/if}
    <div class="mp-list">
      {#each visibleRecords as record (record.recoveryId)}
        <article class="mp-row recovery-row"><div><strong>{record.title || record.targetLabel || 'Modpack operation recovery'}</strong><p class="mp-muted">{setupContext ? 'Minecraft Core will verify the saved transaction and either finish it safely or remove only its verified temporary files.' : record.summary || record.message || `Phase ${record.phase || 'unknown'} requires a reviewed action.`}</p><div class="mp-actions"><span class="mp-badge danger">{record.phase || 'blocked'}</span>{#if record.automaticPossible}<span class="mp-badge good">Automatic option verified</span>{:else}<span class="mp-badge warn">Manual review required</span>{/if}</div></div><div class="action-column">{#each record.actions || [] as action (action.actionId)}<button class="mp-button {action.recommended ? 'primary' : ''}" type="button" disabled={Boolean(actionInProgress) || (Boolean(onRecover) && currentStatus !== 'ready')} on:click={() => recover(record, action.actionId)}>{actionInProgress === `${record.recoveryId}:${action.actionId}` ? 'Working…' : action.label || action.actionId}</button>{/each}</div></article>
      {/each}
    </div>
  </section>
{/if}

<style>
  @import './modpack-ui.css';
  .recovery-row { align-items: center; }
  .recovery-row p { margin: 0.35rem 0 0.7rem; }
  .action-column { display: flex; flex-direction: column; gap: 0.5rem; flex: 0 0 auto; }
  @media (max-width: 650px) { .recovery-row { flex-direction: column; } .action-column { width: 100%; } }
</style>
