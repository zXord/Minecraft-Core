<script>
  export let progress = { phase: 'resolving' };

  const phaseLabels = Object.freeze({
    resolving: 'Resolving selected release',
    downloading: 'Downloading selected asset',
    verifying: 'Verifying downloaded bytes',
    materialize: 'Preparing the archive workspace',
    list: 'Reading archive contents',
    validate: 'Checking archive safety',
    classify: 'Detecting the server runtime',
    complete: 'Opening inspection review'
  });

  $: phase = Object.hasOwn(phaseLabels, progress?.phase) ? progress.phase : 'resolving';
  $: transferredBytes = finiteBytes(progress?.transferredBytes);
  $: totalBytes = finiteBytes(progress?.totalBytes);
  $: measuredPercent = finitePercent(progress?.percent);
  $: percent = measuredPercent ?? (totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : null);
  $: determinateDownload = phase === 'downloading' && totalBytes > 0 && percent !== null;

  function finiteBytes(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function finitePercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
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
</script>

<section class="inspection-progress mp-state" role="status" aria-live="polite" aria-atomic="true">
  <div class="progress-heading">
    <strong>{phaseLabels[phase]}</strong>
    {#if percent !== null}<span>{percent}%</span>{/if}
  </div>

  {#if determinateDownload}
    <progress class="mp-progress-meter" aria-label="Downloading selected asset" max="100" value={percent}>{percent}%</progress>
    <p>{formatBytes(transferredBytes)} of {formatBytes(totalBytes)}</p>
  {:else}
    <div class="indeterminate mp-progress-track" aria-hidden="true"><span class="mp-progress-activity"></span></div>
    <p>This can take a while for large modpacks. Minecraft Core will keep this status updated.</p>
  {/if}
</section>

<style>
  @import './modpack-ui.css';
  .inspection-progress { display: grid; gap: 0.65rem; border-left-color: rgba(255, 255, 255, 0.48); }
  .progress-heading { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .progress-heading span, p { color: var(--mp-muted); }
  p { margin: 0; font-size: 0.86rem; }
</style>
