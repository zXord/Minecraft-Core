<script>
  export let progress = { phase: 'scanning-server' };

  const phaseLabels = Object.freeze({
    'validating-destination': 'Validating the selected destination',
    'preparing-candidate': 'Preparing candidate files',
    'scanning-server': 'Scanning current server files',
    'verifying-restore-point': 'Verifying the selected restore point',
    'calculating-changes': 'Calculating safe file changes',
    'checking-capacity': 'Checking disk capacity and write safety',
    'sealing-plan': 'Sealing the one-use reviewed plan',
    complete: 'Opening the reviewed plan'
  });
  const phaseOrder = Object.freeze(Object.keys(phaseLabels));
  const activityLabels = Object.freeze({
    extracting: 'Extracting archive',
    'verifying-archive': 'Verifying archive contents',
    'downloading-pack-files': 'Downloading pack files',
    'assembling-files': 'Assembling files',
    'hashing-candidate-files': 'Hashing candidate files'
  });

  $: phase = Object.hasOwn(phaseLabels, progress?.phase) ? progress.phase : 'scanning-server';
  $: activity = Object.hasOwn(activityLabels, progress?.activity) ? progress.activity : null;
  $: label = activity ? activityLabels[activity] : phaseLabels[phase];
  $: stage = phaseOrder.indexOf(phase) + 1;
  $: byteProgress = validPair(progress?.processedBytes, progress?.totalBytes);
  $: itemProgress = validPair(progress?.completedItems, progress?.totalItems);
  $: measured = byteProgress?.total > 0 ? { ...byteProgress, kind: 'bytes' }
    : itemProgress?.total > 0 ? { ...itemProgress, kind: 'items' } : null;
  $: percent = measured
    ? Math.max(0, Math.min(100, Math.round((measured.completed / measured.total) * 100)))
    : null;

  function validPair(completedValue, totalValue) {
    const completed = Number(completedValue);
    const total = Number(totalValue);
    return Number.isSafeInteger(completed) && completed >= 0 &&
      Number.isSafeInteger(total) && total >= completed
      ? { completed, total }
      : null;
  }

  function formatBytes(value) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = Math.max(0, Number(value) || 0);
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function detail(measurement, currentPhase, items, currentActivity) {
    if (measurement?.kind === 'bytes' && items?.total > 0) {
      const unit = ['downloading-pack-files', 'assembling-files', 'hashing-candidate-files'].includes(currentActivity) ? 'files' : 'items';
      return `${items.completed.toLocaleString('en-US')} of ${items.total.toLocaleString('en-US')} ${unit} · ${formatBytes(measurement.completed)} of ${formatBytes(measurement.total)}`;
    }
    if (measurement?.kind === 'bytes') {
      return `${formatBytes(measurement.completed)} of ${formatBytes(measurement.total)} checked`;
    }
    if (measurement?.kind === 'items') return `${measurement.completed} of ${measurement.total} items checked`;
    if (currentPhase === 'scanning-server') {
      return 'Hashing the current server tree without changing it. Large servers can take a few minutes.';
    }
    if (currentPhase === 'verifying-restore-point') {
      return 'Reading the selected restore archive before the plan can be reviewed.';
    }
    return 'Minecraft Core is preparing an exact plan. No server files are being changed yet.';
  }
</script>

<section class="preflight-status mp-state" role="status" aria-label="Modpack preflight progress" aria-live="polite" aria-atomic="true">
  <div class="preflight-heading">
    <div><span>Stage {stage} of {phaseOrder.length}</span><strong>{label}</strong></div>
    {#if percent !== null}<span>{percent}%</span>{/if}
  </div>
  {#if measured}
    <progress class="mp-progress-meter" aria-label={label} max="100" value={percent}>{percent}%</progress>
  {:else}
    <div class="indeterminate mp-progress-track" aria-hidden="true"><span class="mp-progress-activity"></span></div>
  {/if}
  <p>{detail(measured, phase, itemProgress, activity)}</p>
</section>

<style>
  @import './modpack-ui.css';
  .preflight-status { display: grid; gap: 0.65rem; border-left-color: rgba(255, 255, 255, 0.48); }
  .preflight-heading { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .preflight-heading > div { display: grid; gap: 0.15rem; }
  .preflight-heading span, p { color: var(--mp-muted); }
  .preflight-heading strong { color: var(--mp-text); }
  p { margin: 0; font-size: 0.86rem; }
</style>
