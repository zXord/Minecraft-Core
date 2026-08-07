<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  export let serverId = '';
  export let records = null;
  let loading = false;
  let error = null;
  let activeAction = '';

  $: allRecords = Array.isArray(records) ? records : records?.items || [];
  $: visibleRecords = allRecords.filter(record => !serverId || record.serverId === serverId || record.instanceId === serverId || record.stableServerId === serverId);

  async function refresh() {
    loading = true;
    error = null;
    try {
      records = await modpackApi.listRecovery();
    } catch (caught) {
      error = caught;
    } finally {
      loading = false;
    }
  }

  async function recover(record, actionId) {
    activeAction = `${record.recoveryId}:${actionId}`;
    error = null;
    try {
      const result = await modpackApi.recover(record.recoveryId, actionId);
      dispatch('recovered', { record, actionId, result });
      await refresh();
    } catch (caught) {
      error = caught;
    } finally {
      activeAction = '';
    }
  }

  onMount(() => { if (records === null) refresh(); });
</script>

<section class="modpack-surface mp-panel mp-stack" aria-label="Modpack recovery">
  <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Recovery</p><h2 class="mp-title">Durable recovery records</h2><p class="mp-subtitle">Starts and writes stay blocked until every ambiguous operation is resolved safely.</p></div><button class="mp-button" type="button" on:click={refresh} disabled={loading}>{loading ? 'Checking…' : 'Refresh'}</button></div>
  {#if error}<div class="mp-state error" tabindex="-1" aria-live="assertive"><strong>Recovery status unavailable</strong><p>{error.message}</p></div>{/if}
  {#if !loading && visibleRecords.length === 0}<div class="mp-state"><strong>No recovery action is pending</strong><p>The server has no unresolved lifecycle transaction.</p></div>{/if}
  <div class="mp-list">
    {#each visibleRecords as record (record.recoveryId)}
      <article class="mp-row recovery-row"><div><strong>{record.title || record.targetLabel || 'Modpack operation recovery'}</strong><p class="mp-muted">{record.summary || record.message || `Phase ${record.phase || 'unknown'} requires a reviewed action.`}</p><div class="mp-actions"><span class="mp-badge danger">{record.phase || 'blocked'}</span>{#if record.automaticPossible}<span class="mp-badge good">Automatic option verified</span>{:else}<span class="mp-badge warn">Manual review required</span>{/if}</div></div><div class="action-column">{#each record.actions || [{ actionId: 'review-recovery', label: 'Review recovery' }] as action (action.actionId)}<button class="mp-button {action.recommended ? 'primary' : ''}" type="button" disabled={Boolean(activeAction)} on:click={() => recover(record, action.actionId)}>{activeAction === `${record.recoveryId}:${action.actionId}` ? 'Working…' : action.label || action.actionId}</button>{/each}</div></article>
    {/each}
  </div>
</section>

<style>
  @import './modpack-ui.css';
  .recovery-row { align-items: center; }
  .recovery-row p { margin: 0.35rem 0 0.7rem; }
  .action-column { display: flex; flex-direction: column; gap: 0.5rem; flex: 0 0 auto; }
  @media (max-width: 650px) { .recovery-row { flex-direction: column; } .action-column { width: 100%; } }
</style>
