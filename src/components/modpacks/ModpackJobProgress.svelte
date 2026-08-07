<script>
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  export let job = null;

  const stageLabels = Object.freeze({
    queued: 'Resolving',
    resolving: 'Resolving',
    downloading: 'Downloading',
    verifying: 'Verifying',
    inspecting: 'Inspecting',
    planning: 'Planning',
    'awaiting-user': 'Planning',
    preflight: 'Planning',
    snapshotting: 'Creating restore point',
    staging: 'Extracting and Reconciling files',
    'validating-candidate': 'Configuring runtime and Java · Validating candidate on loopback',
    committing: 'Committing directory swap',
    publishing: 'Committing directory swap',
    published: 'Committing directory swap',
    registering: 'Committing directory swap',
    starting: 'Starting from final path',
    'validating-live': 'Validating final health',
    'committed-healthy': 'Cleaning rollback staging',
    cleanup: 'Cleaning rollback staging',
    'cleanup-pending': 'Cleaning rollback staging',
    completed: 'Completed',
    cancelling: 'Cancelling',
    cancelled: 'Nothing changed',
    'rolling-back': 'Rolling back',
    'rolled-back': 'Update failed; server restored successfully',
    failed: 'Nothing changed',
    'recovery-required': 'Manual recovery required'
  });
  const cancellable = new Set(['queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'preflight', 'snapshotting', 'staging', 'validating-candidate']);
  const terminal = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);
  let logs = [];
  let error = null;
  let pollTimer = null;
  let cleanups = [];
  let resultHeading;
  let cancelling = false;
  let actionBusy = '';

  $: phase = job?.phase || 'queued';
  $: stage = stageLabels[phase] || phase;
  $: progressValue = Number.isInteger(job?.progress?.percent) ? job.progress.percent : phase === 'completed' ? 100 : 0;
  $: canCancel = cancellable.has(phase) && !job?.cancellationRequested;
  $: outcomeKind = job?.outcome?.kind || job?.outcome?.resultKind || (phase === 'rolled-back' ? 'restored' : phase === 'recovery-required' ? (job?.outcome?.automatic ? 'automatic-recovery' : 'manual-recovery') : job?.outcome?.retainedDownload ? 'retained-download' : phase === 'cancelled' || phase === 'failed' ? 'nothing-changed' : 'completed');
  $: if (terminal.has(phase)) focusResult();

  async function focusResult() {
    await tick();
    resultHeading?.focus?.();
    dispatch('terminal', { job });
  }

  async function refresh() {
    if (!job?.jobId || terminal.has(job.phase)) return;
    try {
      job = await modpackApi.getJob(job.jobId);
      error = null;
    } catch (caught) {
      error = caught;
    }
    schedulePoll();
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (job?.jobId && !terminal.has(job.phase)) pollTimer = setTimeout(refresh, 1200);
  }

  async function cancel() {
    if (!canCancel) return;
    cancelling = true;
    try {
      job = await modpackApi.cancelJob(job.jobId);
      schedulePoll();
    } catch (caught) {
      error = caught;
    } finally {
      cancelling = false;
    }
  }

  function actionReference(actionId) {
    const actions = job?.outcome?.actions || [];
    const action = actions.find(item => item.actionId === actionId);
    return action?.opaqueRef || job?.outcome?.opaqueRef || null;
  }

  function hasAction(actionId) {
    return Boolean(actionReference(actionId));
  }

  async function performAction(actionId) {
    const opaqueRef = actionReference(actionId);
    if (!opaqueRef) {
      error = new Error('This outcome action is no longer available. Return to the Modpack page and refresh its durable state.');
      return;
    }
    actionBusy = actionId;
    error = null;
    try {
      const value = await modpackApi.performSafeAction(actionId, opaqueRef);
      dispatch('action', { actionId, value });
    } catch (caught) {
      error = caught;
    } finally {
      actionBusy = '';
    }
  }

  onMount(() => {
    cleanups = [
      modpackApi.onJobProgress(event => {
        if (event?.jobId !== job?.jobId) return;
        job = { ...job, ...event };
      }),
      modpackApi.onJobLog(event => {
        if (event?.jobId !== job?.jobId) return;
        logs = [...logs, event].slice(-500);
      })
    ];
    schedulePoll();
  });

  onDestroy(() => {
    if (pollTimer) clearTimeout(pollTimer);
    for (const cleanup of cleanups) cleanup();
  });
</script>

<div class="modpack-surface mp-stack">
  <section class="mp-panel mp-stack" aria-label="Modpack operation progress">
    <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Durable job {job?.jobId || 'starting'}</p><h2 class="mp-title">{stage}</h2><p class="mp-subtitle" aria-live="polite">{job?.progress?.message || 'Minecraft Core is preserving the reviewed operation state.'}</p></div><span class="mp-badge {terminal.has(phase) ? 'good' : ''}">{phase}</span></div>
    <div class="progress-track" role="progressbar" aria-label={stage} aria-valuemin="0" aria-valuemax="100" aria-valuenow={progressValue}><div class="progress-fill" style={`width: ${progressValue}%`}></div></div>
    {#if job?.progress?.currentItem}<p class="mp-muted">Current item: {job.progress.currentItem}</p>{/if}
    <div class="mp-actions">{#if canCancel}<button type="button" class="mp-button" disabled={cancelling} on:click={cancel}>{cancelling ? 'Cancelling…' : 'Cancel before commit'}</button>{:else if !terminal.has(phase)}<span class="mp-muted">The commit boundary has been reached; cancellation is replaced by rollback or recovery.</span>{/if}</div>
  </section>

  {#if error}<section class="mp-state error" tabindex="-1" aria-live="assertive"><strong>Operation status error</strong><p>{error.message}</p></section>{/if}

  {#if terminal.has(phase)}
    <section class="mp-panel mp-stack outcome" bind:this={resultHeading} tabindex="-1" aria-live="polite">
      {#if job?.outcome?.actionIssuanceFailed}<div class="mp-state error"><strong>Outcome actions unavailable</strong><p>The operation result is durable, but its safe action references could not be issued. Return to the Modpack page and review the current state.</p></div>{/if}
      {#if outcomeKind === 'retained-download'}
        <div><p class="mp-kicker">Manual outcome</p><h3>Downloaded file retained for manual use</h3><p class="mp-muted">No server files were changed. The verified download remains in the controlled cache.</p></div>
        <div class="mp-actions">{#if hasAction('open-retained-download-folder')}<button class="mp-button" on:click={() => performAction('open-retained-download-folder')} disabled={actionBusy}>Open folder</button>{/if}{#if hasAction('remove-retained-download')}<button class="mp-button danger" on:click={() => performAction('remove-retained-download')} disabled={actionBusy}>Remove download</button>{/if}{#if hasAction('choose-another-asset')}<button class="mp-button" on:click={() => performAction('choose-another-asset')} disabled={actionBusy}>Choose another asset</button>{/if}</div>
      {:else if outcomeKind === 'restored'}
        <div><p class="mp-kicker">Rollback complete</p><h3>Update failed; server restored successfully</h3><p class="mp-muted">The original server and its compatible world state were restored and verified.</p></div>
        <div class="mp-actions">{#if hasAction('return-to-server')}<button class="mp-button primary" on:click={() => performAction('return-to-server')} disabled={actionBusy}>Return to server</button>{/if}{#if hasAction('review-restore-point')}<button class="mp-button" on:click={() => performAction('review-restore-point')} disabled={actionBusy}>Review restore point</button>{/if}</div>
      {:else if outcomeKind === 'automatic-recovery'}
        <div><p class="mp-kicker">Restart recovery</p><h3>Automatic recovery required on next launch</h3><p class="mp-muted">The operation is safely blocked until startup recovery verifies the durable record.</p></div>
        <div class="mp-actions">{#if hasAction('restart-and-recover')}<button class="mp-button primary" on:click={() => performAction('restart-and-recover')} disabled={actionBusy}>Restart and recover</button>{/if}{#if hasAction('open-details')}<button class="mp-button" on:click={() => performAction('open-details')} disabled={actionBusy}>Open details</button>{/if}</div>
      {:else if outcomeKind === 'manual-recovery'}
        <div><p class="mp-kicker">Action required</p><h3>Manual recovery required</h3><p class="mp-muted">Minecraft Core could not prove one automatic choice. The server remains blocked from writes and starts.</p></div>
        <div class="mp-actions">{#if hasAction('review-recovery')}<button class="mp-button primary" on:click={() => performAction('review-recovery')} disabled={actionBusy}>Review recovery</button>{/if}{#if hasAction('restore-from-restore-point')}<button class="mp-button" on:click={() => performAction('restore-from-restore-point')} disabled={actionBusy}>Restore from restore point</button>{/if}{#if hasAction('open-details')}<button class="mp-button" on:click={() => performAction('open-details')} disabled={actionBusy}>Open diagnostic details</button>{/if}</div>
      {:else if outcomeKind === 'nothing-changed'}
        <div><p class="mp-kicker">Safe stop</p><h3>Nothing changed</h3><p class="mp-muted">The operation stopped before commit, so the server remains byte-for-byte in its prior state.</p></div>
        <div class="mp-actions">{#if hasAction('retry')}<button class="mp-button" on:click={() => performAction('retry')} disabled={actionBusy}>Retry</button>{/if}{#if hasAction('change-selection')}<button class="mp-button" on:click={() => performAction('change-selection')} disabled={actionBusy}>Change selection</button>{/if}{#if hasAction('open-details')}<button class="mp-button" on:click={() => performAction('open-details')} disabled={actionBusy}>Open details</button>{/if}</div>
      {:else}
        <div><p class="mp-kicker">Operation complete</p><h3>Completed</h3><p class="mp-muted">The reviewed server state was committed, validated from its final location, and recorded in history.</p></div>
        <div class="mp-actions"><button class="mp-button primary" on:click={() => dispatch('return', { job })}>Return to server</button>{#if hasAction('open-details')}<button class="mp-button" on:click={() => performAction('open-details')} disabled={actionBusy}>Open details</button>{/if}</div>
      {/if}
    </section>
  {/if}

  <details class="mp-panel"><summary>Technical operation log</summary><div class="raw-log" aria-live="off" aria-label="Raw operation logs">{#if logs.length === 0}<p class="mp-muted">No detailed log records have been published.</p>{:else}{#each logs as entry, index (`${entry.sequence || index}-${entry.message}`)}<p><time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</time> {entry.message}</p>{/each}{/if}</div></details>
</div>

<style>
  @import './modpack-ui.css';
  .progress-track { height: 10px; overflow: hidden; border-radius: 999px; background: rgba(255, 255, 255, 0.08); }
  .progress-fill { height: 100%; min-width: 2px; border-radius: inherit; background: linear-gradient(90deg, #646cff, #8a91ff); transition: width 180ms ease; }
  .outcome { border-color: rgba(124, 131, 255, 0.4); }
  .outcome h3 { margin: 0; font-size: 1.3rem; }
  summary { cursor: pointer; color: #c4c7ff; }
  .raw-log { margin-top: 0.8rem; max-height: 240px; overflow: auto; font: 0.78rem/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--mp-muted); }
  .raw-log p { margin: 0.2rem 0; }
</style>
