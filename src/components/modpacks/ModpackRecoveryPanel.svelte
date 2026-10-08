<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';
  import { filterPendingNewServerRecoveryRecords } from '../../utils/modpacks/serverRequestScope.js';

  const dispatch = createEventDispatcher();
  export let serverId = '';
  export let records = null;
  export let visibilityScope = '';
  export let context = 'server';
  export let hideWhenEmpty = false;
  let loading = false;
  let error = null;
  let activeAction = '';
  let refreshSequence = 0;
  let resolvedRecoveryIds = new Set();

  $: allRecords = (Array.isArray(records) ? records : records?.items || [])
    .filter(record => !resolvedRecoveryIds.has(record?.recoveryId));
  $: visibleRecords = visibilityScope === 'pending-new-server'
    ? filterPendingNewServerRecoveryRecords(allRecords)
    : allRecords.filter(record => !serverId || record.serverId === serverId || record.instanceId === serverId || record.stableServerId === serverId);
  $: setupContext = context === 'setup';
  $: hidden = hideWhenEmpty && !loading && !error && visibleRecords.length === 0;

  async function refresh() {
    const sequence = ++refreshSequence;
    loading = true;
    error = null;
    try {
      const refreshedRecords = await modpackApi.listRecovery();
      if (sequence === refreshSequence) records = refreshedRecords;
    } catch (caught) {
      if (sequence === refreshSequence) error = caught;
    } finally {
      if (sequence === refreshSequence) loading = false;
    }
  }

  async function recover(record, actionId) {
    activeAction = `${record.recoveryId}:${actionId}`;
    error = null;
    let result;
    try {
      result = await modpackApi.recover(record.recoveryId, actionId);
    } catch (caught) {
      error = caught;
      activeAction = '';
      return;
    }
    if (result?.resolved === true) {
      resolvedRecoveryIds = new Set([...resolvedRecoveryIds, record.recoveryId]);
    }
    dispatch('recovered', { record, actionId, result });
    try {
      await refresh();
    } finally {
      activeAction = '';
    }
  }

  onMount(() => { if (records === null) refresh(); });
</script>

{#if !hidden}
  <section class="modpack-surface mp-panel mp-stack" aria-label={setupContext ? 'Setup recovery' : 'Modpack recovery'}>
    <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">{setupContext ? 'Setup recovery' : 'Recovery'}</p><h2 class="mp-title">{setupContext ? 'Unfinished server setup' : 'Durable recovery records'}</h2><p class="mp-subtitle">{setupContext ? 'A previous server setup stopped before it could be added to Minecraft Core. Resolve its saved transaction before reusing that destination.' : 'Starts and writes stay blocked until every ambiguous operation is resolved safely.'}</p></div><button class="mp-button" type="button" on:click={refresh} disabled={loading}>{loading ? 'Checking…' : 'Refresh'}</button></div>
    {#if error}<div class="mp-state error" tabindex="-1" aria-live="assertive"><strong>{setupContext ? 'Setup recovery could not be completed' : 'Recovery status unavailable'}</strong><p>{error.message}</p></div>{/if}
    {#if !loading && visibleRecords.length === 0}<div class="mp-state"><strong>No recovery action is pending</strong><p>{setupContext ? 'No interrupted server setup is waiting for recovery.' : 'The server has no unresolved lifecycle transaction.'}</p></div>{/if}
    <div class="mp-list">
      {#each visibleRecords as record (record.recoveryId)}
        <article class="mp-row recovery-row"><div><strong>{record.title || record.targetLabel || 'Modpack operation recovery'}</strong><p class="mp-muted">{setupContext ? 'Minecraft Core will verify the saved transaction and either finish it safely or remove only its verified temporary files.' : record.summary || record.message || `Phase ${record.phase || 'unknown'} requires a reviewed action.`}</p><div class="mp-actions"><span class="mp-badge danger">{record.phase || 'blocked'}</span>{#if record.automaticPossible}<span class="mp-badge good">Automatic option verified</span>{:else}<span class="mp-badge warn">Manual review required</span>{/if}</div></div><div class="action-column">{#each record.actions || [] as action (action.actionId)}<button class="mp-button {action.recommended ? 'primary' : ''}" type="button" disabled={Boolean(activeAction)} on:click={() => recover(record, action.actionId)}>{activeAction === `${record.recoveryId}:${action.actionId}` ? 'Working…' : action.label || action.actionId}</button>{/each}</div></article>
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
