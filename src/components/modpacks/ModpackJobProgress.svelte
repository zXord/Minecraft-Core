<script>
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { modpackApi } from '../../utils/modpacks/modpackApi.js';
  import { isNewServerDestinationRecoveryOutcome } from '../../utils/modpacks/serverRequestScope.js';

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
  const failureStepLabels = Object.freeze({
    'acquire-mutation': 'acquire mutation',
    'suspend-auto-restart': 'suspend auto restart',
    quiesce: 'quiesce server',
    'revalidate-plan': 'revalidate plan'
  });
  const safeErrorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
  const safeFailureFieldPattern = /^[A-Za-z][A-Za-z0-9.]{0,127}$/u;
  const filesystemFailureCopy = Object.freeze({
    'sharing-violation': 'A required file is still in use.',
    'access-denied': 'Minecraft Core could not access a required folder.',
    timeout: 'A filesystem check did not finish in time.',
    'integrity-failure': 'File integrity check could not be completed.',
    'io-failure': 'A filesystem operation could not be completed.',
    'worker-failure': 'A protected filesystem check could not be completed.'
  });
  const filesystemBoundaries = new Set([
    'root-open', 'source-open', 'destination-parent-open', 'source-parent-open', 'ancestor-open',
    'preflight-revalidation', 'handle-rename', 'completion-flush', 'published-identity',
    'final-revalidation', 'request'
  ]);
  const filesystemFailureStages = new Set(['filesystem-operation', 'durable-move']);
  const candidateBootBoundaries = Object.freeze({
    'health-validation': 'checking the isolated server candidate',
    'properties-overlay': 'preparing isolated server settings',
    'java-resolution': 'selecting the reviewed Java runtime',
    'runtime-verification': 'checking the reviewed loader and runtime',
    'process-launch': 'starting the isolated candidate process',
    readiness: 'waiting for the isolated server to report that it was ready',
    'endpoint-verification': 'verifying the isolated loopback server',
    shutdown: 'stopping the isolated test server',
    'properties-restore': 'restoring the candidate server settings'
  });
  const candidateBootFailureCopy = Object.freeze({
    'out-of-memory': Object.freeze({
      message: 'The isolated server ran out of memory during startup.',
      nextStep: 'Increase the reviewed server memory and retry.'
    }),
    'runtime-java-mismatch': Object.freeze({
      message: 'The pack could not start with its reviewed Java and runtime combination.',
      nextStep: 'Choose a compatible pack version or release and retry.'
    }),
    'mod-loading-failure': Object.freeze({
      message: 'One or more mods failed during the isolated startup test.',
      nextStep: 'Try another pack version or review the publisher release notes before retrying.'
    }),
    'port-conflict': Object.freeze({
      message: 'The private loopback port was unavailable during the startup test.',
      nextStep: 'Retry so Minecraft Core can choose another private port.'
    }),
    'process-exited': Object.freeze({
      message: 'The isolated server process exited before it became ready.',
      nextStep: 'Try another pack version or asset, then retry.'
    }),
    'readiness-timeout': Object.freeze({
      message: 'The isolated server did not become ready within the protected test window.',
      nextStep: 'Increase the reviewed server memory or try another pack version, then retry.'
    }),
    'health-failure': Object.freeze({
      message: 'Minecraft Core could not prove that the isolated server was healthy.',
      nextStep: 'Retry or choose another pack version or asset.'
    })
  });
  let logs = [];
  let displayLogs = [];
  let error = null;
  let pollTimer = null;
  let hydratedTerminalJobId = null;
  let hydratingTerminalJobId = null;
  let cleanups = [];
  let resultHeading;
  let cancelling = false;
  let actionBusy = '';
  let retainedDownloadRemoved = false;
  let actionResultJobId = null;

  $: phase = job?.phase || 'queued';
  $: cleanupPending = terminal.has(phase) && job?.outcome?.cleanupPending === true;
  $: primaryErrorCode = typeof job?.outcome?.errorCode === 'string' && safeErrorCodePattern.test(job.outcome.errorCode) ? job.outcome.errorCode : null;
  $: cleanupErrorCode = typeof job?.outcome?.cleanupErrorCode === 'string' && safeErrorCodePattern.test(job.outcome.cleanupErrorCode) ? job.outcome.cleanupErrorCode : null;
  $: completedVerify = phase === 'completed' && job?.operationKind === 'verify';
  $: verificationResult = job?.outcome?.result;
  $: verificationAvailable = typeof verificationResult?.healthy === 'boolean' &&
    validVerificationCount(verificationResult?.checkedFiles) && validVerificationCount(verificationResult?.mismatchCount);
  $: verificationTitle = !verificationAvailable ? 'Verification result unavailable'
    : verificationResult.healthy ? 'Verified healthy' : 'Differences found';
  $: verificationMismatches = Array.isArray(verificationResult?.mismatches) ? verificationResult.mismatches : [];
  $: stage = cleanupPending ? 'Recovery needs review' : completedVerify ? 'Verification complete' : stageLabels[phase] || phase;
  $: badgeLabel = cleanupPending ? 'Recovery needs review' : completedVerify ? verificationTitle : phase;
  $: activityText = `${stage}: ${job?.progress?.message || 'Minecraft Core is preserving the reviewed operation state.'}`;
  $: canCancel = cancellable.has(phase) && !job?.cancellationRequested;
  $: outcomeKind = cleanupPending ? 'cleanup-pending' : job?.outcome?.kind || job?.outcome?.resultKind || (phase === 'rolled-back' ? 'restored' : phase === 'recovery-required' ? (job?.outcome?.automatic ? 'automatic-recovery' : 'manual-recovery') : job?.outcome?.retainedDownload ? 'retained-download' : phase === 'cancelled' || phase === 'failed' ? 'nothing-changed' : 'completed');
  $: outcomeBadgeClass = cleanupPending || phase === 'failed' || phase === 'recovery-required'
    ? 'danger'
    : phase === 'cancelled' || phase === 'rolled-back'
      ? 'warn'
      : phase === 'completed'
        ? (completedVerify && (!verificationAvailable || verificationResult.healthy !== true) ? 'warn' : 'good')
        : '';
  $: filesystemFailure = cleanupPending ? null : safeFilesystemFailure(job?.outcome?.failure);
  $: candidateBootFailure = cleanupPending ? null : safeCandidateBootFailure(job?.outcome?.failure);
  $: destinationRecoveryBlocked = !cleanupPending && phase === 'failed' &&
    isNewServerDestinationRecoveryOutcome(job?.outcome);
  $: displayLogs = mergeLogs(job?.events, logs);
  $: if ((job?.jobId || null) !== actionResultJobId) {
    actionResultJobId = job?.jobId || null;
    retainedDownloadRemoved = false;
    logs = [];
  }
  $: if (terminal.has(phase)) focusResult();

  function validVerificationCount(value) {
    return (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) ||
      (Number.isSafeInteger(value) && value >= 0);
  }

  function strictFailureDescriptors(value, expectedNames) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
          Object.getOwnPropertySymbols(value).length !== 0) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const names = Object.keys(descriptors).sort();
      if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index]) ||
          Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) return null;
      return descriptors;
    } catch {
      return null;
    }
  }

  function safeFilesystemFailure(value) {
    const descriptors = strictFailureDescriptors(value, ['category', 'stage']) ||
      strictFailureDescriptors(value, ['boundary', 'category', 'stage']);
    if (!descriptors) return null;
    const stage = descriptors.stage.value;
    const category = descriptors.category.value;
    const boundary = descriptors.boundary?.value;
    if (!filesystemFailureStages.has(stage) || typeof category !== 'string' || !Object.hasOwn(filesystemFailureCopy, category)) return null;
    if (boundary !== undefined && (typeof boundary !== 'string' || !filesystemBoundaries.has(boundary))) return null;
    return {
      message: filesystemFailureCopy[category],
      nextStep: boundary === 'destination-parent-open'
        ? 'Check that the selected destination folder is available, then retry.'
        : 'Review the selected server location and retry.'
    };
  }

  function safeCandidateBootFailure(value) {
    const descriptors = strictFailureDescriptors(value, ['boundary', 'category', 'stage']);
    if (!descriptors || descriptors.stage.value !== 'candidate-boot') return null;
    const boundary = descriptors.boundary.value;
    const category = descriptors.category.value;
    if (typeof boundary !== 'string' || !Object.hasOwn(candidateBootBoundaries, boundary) ||
        typeof category !== 'string' || !Object.hasOwn(candidateBootFailureCopy, category)) return null;
    return {
      boundary: candidateBootBoundaries[boundary],
      ...candidateBootFailureCopy[category]
    };
  }

  function safeLogEvent(value) {
    const descriptors = strictFailureDescriptors(value, [
      'channel', 'currentItem', 'details', 'jobId', 'message', 'phase', 'progress', 'sequence', 'timestamp'
    ]);
    if (!descriptors || descriptors.channel.value !== 'log' ||
        !Number.isSafeInteger(descriptors.sequence.value) || descriptors.sequence.value < 1 ||
        typeof descriptors.message.value !== 'string' || descriptors.message.value.length < 1 ||
        typeof descriptors.phase.value !== 'string' || typeof descriptors.timestamp.value !== 'string') return null;
    const details = descriptors.details.value;
    let errorCode = null;
    let step = null;
    let field = null;
    try {
      if (details && typeof details === 'object' && !Array.isArray(details) &&
          Object.getPrototypeOf(details) === Object.prototype && Object.getOwnPropertySymbols(details).length === 0) {
        const detailDescriptors = Object.getOwnPropertyDescriptors(details);
        const dataValue = name => {
          const descriptor = detailDescriptors[name];
          return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
        };
        const errorCodeValue = dataValue('errorCode');
        const stepValue = dataValue('step');
        const fieldValue = dataValue('field');
        errorCode = typeof errorCodeValue === 'string' && safeErrorCodePattern.test(errorCodeValue) ? errorCodeValue : null;
        step = typeof stepValue === 'string' && Object.hasOwn(failureStepLabels, stepValue)
          ? failureStepLabels[stepValue]
          : null;
        field = typeof fieldValue === 'string' && safeFailureFieldPattern.test(fieldValue) ? fieldValue : null;
      }
    } catch {
      errorCode = null;
      step = null;
      field = null;
    }
    return {
      sequence: descriptors.sequence.value,
      timestamp: descriptors.timestamp.value,
      phase: descriptors.phase.value,
      message: descriptors.message.value,
      errorCode,
      step,
      field
    };
  }

  function mergeLogs(persisted, live) {
    const merged = new Map();
    for (const value of Array.isArray(persisted) ? persisted : []) {
      const entry = safeLogEvent(value);
      if (entry) merged.set(`${entry.sequence}:${entry.timestamp}:${entry.message}`, entry);
    }
    for (const value of Array.isArray(live) ? live : []) {
      const entry = safeLogEvent(value);
      if (entry) merged.set(`${entry.sequence}:${entry.timestamp}:${entry.message}`, entry);
    }
    return [...merged.values()].sort((left, right) => left.sequence - right.sequence).slice(-500);
  }

  async function focusResult() {
    await tick();
    resultHeading?.focus?.();
    dispatch('terminal', { job });
  }

  async function refresh() {
    if (!job?.jobId || terminal.has(job.phase)) return;
    const jobId = job.jobId;
    try {
      const refreshed = await modpackApi.getJob(jobId);
      if (job?.jobId !== jobId) return;
      if (terminal.has(refreshed?.phase)) hydratedTerminalJobId = jobId;
      job = refreshed;
      error = null;
    } catch (caught) {
      error = caught;
    }
    schedulePoll();
  }

  async function hydrateTerminalJob(jobId) {
    if (!jobId || hydratedTerminalJobId === jobId || hydratingTerminalJobId === jobId) return;
    hydratingTerminalJobId = jobId;
    let retryDelay = 0;
    try {
      const hydrated = await modpackApi.getJob(jobId);
      if (job?.jobId !== jobId) return;
      job = hydrated;
      error = null;
      if (terminal.has(hydrated?.phase)) hydratedTerminalJobId = jobId;
    } catch (caught) {
      if (job?.jobId === jobId) error = caught;
      retryDelay = 1200;
    } finally {
      if (hydratingTerminalJobId === jobId) hydratingTerminalJobId = null;
      schedulePoll(retryDelay);
    }
  }

  function schedulePoll(terminalDelay = 0) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (!job?.jobId) return;
    if (terminal.has(job.phase)) {
      if (hydratedTerminalJobId !== job.jobId && hydratingTerminalJobId !== job.jobId) {
        const jobId = job.jobId;
        pollTimer = setTimeout(() => hydrateTerminalJob(jobId), terminalDelay);
      }
      return;
    }
    pollTimer = setTimeout(refresh, 1200);
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
      if (actionId === 'remove-retained-download' && value?.status === 'removed') {
        retainedDownloadRemoved = true;
      }
      dispatch('action', { actionId, value, job });
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
        schedulePoll();
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
    <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Durable job {job?.jobId || 'starting'}</p><h2 class="mp-title">{stage}</h2><p class="mp-subtitle" aria-live="polite">{job?.progress?.message || 'Minecraft Core is preserving the reviewed operation state.'}</p></div><span class="mp-badge {outcomeBadgeClass}">{badgeLabel}</span></div>
    {#if !terminal.has(phase)}
      <div class="mp-progress-track" role="progressbar" aria-label={stage} aria-valuetext={activityText}><span class="mp-progress-activity"></span></div>
      <p class="progress-note">This stage stays active until the current operation finishes.</p>
    {/if}
    {#if job?.progress?.currentItem}<p class="mp-muted">Current item: {job.progress.currentItem}</p>{/if}
    <div class="mp-actions">{#if canCancel}<button type="button" class="mp-button" disabled={cancelling} on:click={cancel}>{cancelling ? 'Cancelling…' : 'Cancel before commit'}</button>{:else if !terminal.has(phase)}<span class="mp-muted">The commit boundary has been reached; cancellation is replaced by rollback or recovery.</span>{/if}</div>
  </section>

  {#if error}<section class="mp-state error" tabindex="-1" aria-live="assertive"><strong>Operation status error</strong><p>{error.message}</p></section>{/if}

  {#if terminal.has(phase)}
    <section class="mp-panel mp-stack outcome {outcomeBadgeClass}" bind:this={resultHeading} tabindex="-1" aria-live="polite">
      {#if job?.outcome?.actionIssuanceFailed}<div class="mp-state error"><strong>Outcome actions unavailable</strong><p>The operation result is durable, but its safe action references could not be issued. Return to the Modpack page and review the current state.</p></div>{/if}
      {#if destinationRecoveryBlocked}<div class="mp-state error"><strong>Destination has unfinished recovery</strong><p>This folder belongs to an earlier unfinished server operation. The existing server files were not touched.</p><p>Choose a different empty folder for this new server, or finish the earlier server recovery before reusing this destination.</p></div>{/if}
      {#if filesystemFailure}<div class="mp-state error"><strong>Filesystem check</strong><p>{filesystemFailure.message}</p><p>{filesystemFailure.nextStep}</p></div>{/if}
      {#if candidateBootFailure}<div class="mp-state error"><strong>Candidate boot check</strong><p>Failed while {candidateBootFailure.boundary}.</p><p>{candidateBootFailure.message}</p><p>{candidateBootFailure.nextStep}</p></div>{/if}
      {#if cleanupPending}
        <div><p class="mp-kicker">Unfinished operation cleanup</p><h3>Recovery needs review</h3><p>This operation stopped before cleanup could finish. Open the Modpack page to check its current recovery status before retrying.</p></div>
        {#if primaryErrorCode}<p class="mp-muted">Operation error: {primaryErrorCode}</p>{/if}
        {#if cleanupErrorCode}<p class="mp-muted">Cleanup error: {cleanupErrorCode}</p>{/if}
        {#if job?.outcome?.retainedDownload}<p class="mp-muted">The verified download remains available in the controlled cache.</p>{/if}
        <div class="mp-actions"><button class="mp-button primary" on:click={() => dispatch('return', { job })}>Review recovery status</button>{#if job?.outcome?.retainedDownload && hasAction('open-retained-download-folder')}<button class="mp-button" on:click={() => performAction('open-retained-download-folder')} disabled={actionBusy}>Open folder</button>{/if}</div>
      {:else if completedVerify}
        <div>
          <p class="mp-kicker">Read-only verification</p>
          <h3>{verificationTitle}</h3>
          <p class="mp-muted">No server files were changed.</p>
        </div>
        {#if verificationAvailable}
          <p>Checked files: {verificationResult.checkedFiles} · Mismatches: {verificationResult.mismatchCount}</p>
          {#if verificationResult.mismatchesTruncated === true}
            <p class="mp-muted">Showing {verificationMismatches.length} of {verificationResult.mismatchCount} differences; {verificationResult.omittedMismatchCount} additional differences are not listed. The full verification counts include all checked files.</p>
          {/if}
          {#if verificationMismatches.length > 0}
            <ul class="verification-mismatches" aria-label="Managed file differences">
              {#each verificationMismatches as mismatch}
                <li><span>{mismatch?.entryName || 'Filename unavailable'}</span> — {mismatch?.status || 'Status unavailable'}</li>
              {/each}
            </ul>
          {/if}
        {:else}
          <p class="mp-muted">This job does not include a complete verification result. Return to the Modpack page and run Verify again.</p>
        {/if}
        <p class="mp-muted">{verificationResult?.repairAvailable === true
          ? 'Repair is available separately from Actions on the Modpack page. Verify did not repair any files.'
          : verificationAvailable && verificationResult.healthy
            ? 'Repair is not needed for the checked content.'
            : verificationResult?.repairAvailable === false
              ? 'Repair is not available for this result.'
              : 'Repair availability is unknown. Run Verify again before reviewing Repair.'}</p>
        <div class="mp-actions"><button class="mp-button primary" on:click={() => dispatch('return', { job })}>Return to server</button>{#if hasAction('open-details')}<button class="mp-button" on:click={() => performAction('open-details')} disabled={actionBusy}>Open details</button>{/if}</div>
      {:else if outcomeKind === 'retained-download'}
        {#if retainedDownloadRemoved}
          <div><p class="mp-kicker">Manual outcome</p><h3>Downloaded file removed</h3><p class="mp-muted">No server files were changed. The retained download was removed from the controlled cache.</p></div>
        {:else}
          <div><p class="mp-kicker">Manual outcome</p><h3>Downloaded file retained for manual use</h3><p class="mp-muted">No server files were changed. The verified download remains available for manual use and becomes eligible for automatic cleanup after seven days.</p></div>
        {/if}
        <div class="mp-actions">{#if !retainedDownloadRemoved && hasAction('open-retained-download-folder')}<button class="mp-button" on:click={() => performAction('open-retained-download-folder')} disabled={actionBusy}>Open folder</button>{/if}{#if !retainedDownloadRemoved && hasAction('remove-retained-download')}<button class="mp-button danger" on:click={() => performAction('remove-retained-download')} disabled={actionBusy}>Remove download</button>{/if}{#if hasAction('choose-another-asset')}<button class="mp-button primary" on:click={() => performAction('choose-another-asset')} disabled={actionBusy}>{destinationRecoveryBlocked ? 'Start setup again' : 'Choose another asset'}</button>{/if}</div>
      {:else if outcomeKind === 'restored'}
        <div><p class="mp-kicker">Rollback complete</p><h3>Update failed; server restored successfully</h3><p class="mp-muted">The original server and its compatible world state were restored and verified.</p></div>
        <div class="mp-actions">{#if hasAction('return-to-server')}<button class="mp-button primary" on:click={() => performAction('return-to-server')} disabled={actionBusy}>Return to server</button>{/if}{#if hasAction('review-restore-point')}<button class="mp-button" on:click={() => performAction('review-restore-point')} disabled={actionBusy}>Review restore point</button>{/if}</div>
      {:else if outcomeKind === 'automatic-recovery'}
        <div><p class="mp-kicker">Reviewed recovery</p><h3>Verified recovery is ready</h3><p class="mp-muted">The affected server remains safely blocked until you run its reviewed recovery action.</p></div>
        <div class="mp-actions">{#if hasAction('restart-and-recover')}<button class="mp-button primary" on:click={() => performAction('restart-and-recover')} disabled={actionBusy}>Recover now</button>{/if}{#if hasAction('open-details')}<button class="mp-button" on:click={() => performAction('open-details')} disabled={actionBusy}>Open details</button>{/if}</div>
      {:else if outcomeKind === 'manual-recovery'}
        <div><p class="mp-kicker">Action required</p><h3>Manual recovery required</h3><p class="mp-muted">Minecraft Core could not prove one automatic choice. The server remains blocked from writes and starts.</p></div>
        <div class="mp-actions">{#if hasAction('review-recovery')}<button class="mp-button primary" on:click={() => performAction('review-recovery')} disabled={actionBusy}>Review recovery</button>{/if}{#if hasAction('restore-from-restore-point')}<button class="mp-button" on:click={() => performAction('restore-from-restore-point')} disabled={actionBusy}>Restore from restore point</button>{/if}{#if hasAction('open-details')}<button class="mp-button" on:click={() => performAction('open-details')} disabled={actionBusy}>Open diagnostic details</button>{/if}</div>
      {:else if outcomeKind === 'nothing-changed'}
        <div><p class="mp-kicker">Safe stop</p><h3>Stopped before server changes</h3><p class="mp-muted">No server files were changed. The operation stopped before the commit boundary, so the server remains byte-for-byte in its prior state.</p></div>
        <div class="mp-actions">{#if hasAction('retry')}<button class="mp-button primary" on:click={() => performAction('retry')} disabled={actionBusy}>Retry</button>{/if}{#if hasAction('change-selection')}<button class="mp-button" class:primary={!hasAction('retry')} on:click={() => performAction('change-selection')} disabled={actionBusy}>Change selection</button>{/if}{#if hasAction('open-details')}<button class="mp-button" on:click={() => performAction('open-details')} disabled={actionBusy}>Open details</button>{/if}</div>
      {:else}
        <div><p class="mp-kicker">Operation complete</p><h3>Completed</h3><p class="mp-muted">The reviewed server state was committed, validated from its final location, and recorded in history.</p></div>
        <div class="mp-actions"><button class="mp-button primary" on:click={() => dispatch('return', { job })}>Return to server</button>{#if hasAction('open-details')}<button class="mp-button" on:click={() => performAction('open-details')} disabled={actionBusy}>Open details</button>{/if}</div>
      {/if}
    </section>
  {/if}

  <details class="mp-panel"><summary>Technical operation log</summary><div class="raw-log" aria-live="off" aria-label="Raw operation logs">{#if displayLogs.length === 0}<p class="mp-muted">No detailed log records have been published.</p>{:else}{#each displayLogs as entry, index (`${entry.sequence || index}-${entry.message}`)}<p><time>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</time> {entry.phase}{entry.errorCode ? ` · ${entry.errorCode}` : ''}{entry.step ? ` · ${entry.step}` : ''}{entry.field ? ` · ${entry.field}` : ''}: {entry.message}</p>{/each}{/if}</div></details>
</div>

<style>
  @import './modpack-ui.css';
  .progress-note { margin: -0.35rem 0 0; color: var(--mp-muted); font-size: 0.82rem; }
  .outcome { border-color: var(--mp-border); }
  .outcome.good { border-color: rgba(98, 216, 154, 0.42); }
  .outcome.warn { border-color: rgba(244, 189, 98, 0.42); }
  .outcome.danger { border-color: rgba(255, 123, 123, 0.46); }
  .outcome h3 { margin: 0; font-size: 1.3rem; }
  .verification-mismatches { margin: 0; padding-left: 1.25rem; overflow-wrap: anywhere; }
  summary { cursor: pointer; color: #c4c7ff; }
  .raw-log { margin-top: 0.8rem; max-height: 240px; overflow: auto; font: 0.78rem/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--mp-muted); }
  .raw-log p { margin: 0.2rem 0; }
</style>
