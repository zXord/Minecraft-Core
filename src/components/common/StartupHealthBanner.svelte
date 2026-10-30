<script>
  import { onMount, onDestroy } from 'svelte';
  import logger from '../../utils/logger.js';

  /**
   * The startup health from startup:get-health:
   * {status, modpackServices, legacyFallbacks, failure, recoveryGate, issues}.
   * When none is passed in, the banner reads it from the main process.
   */
  export let health = null;

  const DATA_SAFETY_LINE = 'Your servers, clients and worlds were not changed.';
  const ARCHIVE_WORKER_REASONS = Object.freeze(['archive-worker-missing', 'archive-worker-blocked']);
  const DEGRADED_TITLE = 'Some Minecraft Core features are turned off';
  const WORKER_TITLE = 'Modpack features need attention';
  const UNAFFECTED_LINE = 'Servers and clients that do not use modpacks keep working.';
  const WORKER_GATE_LINE = `${UNAFFECTED_LINE} Modpack installs, updates and repairs need this helper.`;
  const UNKNOWN_FAILURE = Object.freeze({
    summary: 'Minecraft Core could not start its modpack features.',
    hint: 'Check for updates, or open the log folder and send the newest log to the developer.'
  });
  const HEALTH_READ_ATTEMPTS = 20;
  const HEALTH_RETRY_DELAY_MS = 500;
  // A started install closes Minecraft Core, normally within seconds, and a
  // refused one is reported at once. A download that ends in neither, for
  // example because another download request turned the install off, hands
  // the update back after this long.
  const INSTALL_START_TIMEOUT_MS = 60_000;
  const MAX_MESSAGE_LENGTH = 500;
  const CHECKING_MESSAGE = 'Checking for updates…';
  const CHECK_FAILED_MESSAGE = 'Minecraft Core could not check for updates. Check your internet connection and try again.';
  const CHECK_BUSY_MESSAGE = 'An update check is already running. Try again in a moment.';
  const NO_UPDATE_MESSAGE = 'No newer version is available yet.';
  const DEVELOPMENT_COPY_MESSAGE = 'This development copy does not check for app updates.';
  const DOWNLOAD_FAILED_MESSAGE = 'The update could not be downloaded. Try again.';
  const INSTALL_REFUSED_MESSAGE = 'The update was downloaded but could not be installed yet. Try again.';
  const INSTALL_NOT_STARTED_MESSAGE = 'The update was downloaded but did not start installing. Try again.';
  const INSTALLING_MESSAGE = 'The update is installing. Minecraft Core restarts when the installer finishes.';
  const RESTARTING_MESSAGE = 'Restarting Minecraft Core…';
  const RESTART_FAILED_MESSAGE = 'Minecraft Core could not restart. Close it and open it again.';
  const OPEN_LOGS_FAILED_MESSAGE = 'The log folder could not be opened.';
  const COPIED_MESSAGE = 'Details copied.';
  const COPY_FAILED_MESSAGE = 'The details could not be copied.';

  let updateState = 'idle'; // idle | checking | available | downloading | installing
  let updateVersion = '';
  let updatePercent = 0;
  let statusMessage = '';
  let statusIsError = false;
  let restarting = false;
  let listeningForUpdates = false;
  let healthRetryTimer = null;
  let installStartTimer = null;
  let destroyed = false;

  $: degraded = health?.status === 'degraded';
  $: problem = degraded ? usableProblem(health?.failure) || UNKNOWN_FAILURE : archiveWorkerIssue(health);
  $: title = degraded ? DEGRADED_TITLE : WORKER_TITLE;
  $: gateLine = degraded ? describeRecoveryGate(health?.recoveryGate) : WORKER_GATE_LINE;
  $: updateBusy = updateState === 'checking' || updateState === 'downloading' || updateState === 'installing';
  $: progressText = updateState === 'installing'
    ? INSTALLING_MESSAGE
    : `Downloading ${versionLabel(updateVersion)}… ${updatePercent}%`;

  function messageText(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
  }

  function usableProblem(value) {
    return value && typeof value === 'object' && messageText(value.summary) ? value : null;
  }

  // A ready start still warns when the file safety helper is missing or blocked,
  // because every modpack operation needs it.
  function archiveWorkerIssue(value) {
    const issues = Array.isArray(value?.issues) ? value.issues : [];
    return issues.find(issue => ARCHIVE_WORKER_REASONS.includes(issue?.reason) && usableProblem(issue)) || null;
  }

  function describeRecoveryGate(gate) {
    if (gate?.globalBlock === true) {
      return 'Server starts and server changes are paused until Minecraft Core can check its unfinished modpack work. Fix the problem above, then restart Minecraft Core.';
    }
    const blocked = Array.isArray(gate?.blockedServers) ? gate.blockedServers.length : 0;
    if (blocked === 1) {
      return `One server with unfinished modpack work stays blocked until Minecraft Core can finish that work. ${UNAFFECTED_LINE}`;
    }
    if (blocked > 1) {
      return `${blocked} servers with unfinished modpack work stay blocked until Minecraft Core can finish that work. ${UNAFFECTED_LINE}`;
    }
    return `${UNAFFECTED_LINE} Modpack features stay off until this is fixed.`;
  }

  function versionLabel(version) {
    if (!version) return 'the update';
    return /^v/iu.test(version) ? version : `v${version}`;
  }

  function hasText(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  function problemLines(label, value) {
    if (!value || typeof value !== 'object') return [];
    const fields = [
      ['What to do', value.hint],
      ['Stage', value.stage],
      ['Reason', value.reason],
      ['Technical details', value.technical]
    ];
    return [
      `${label}: ${hasText(value.summary) ? value.summary : 'unknown'}`,
      ...fields.filter(([, text]) => hasText(text)).map(([name, text]) => `  ${name}: ${text}`)
    ];
  }

  function healthDetails(value) {
    const gate = value?.recoveryGate;
    const blocked = Array.isArray(gate?.blockedServers) ? gate.blockedServers.length : 0;
    const issues = Array.isArray(value?.issues) ? value.issues : [];
    return [
      'Minecraft Core startup health',
      `Status: ${value?.status || 'unknown'}`,
      `Modpack services: ${value?.modpackServices || 'unknown'}`,
      `Legacy fallbacks: ${value?.legacyFallbacks || 'unknown'}`,
      ...problemLines('Problem', value?.failure),
      ...(gate
        ? [`Recovery check: ${gate.basis || 'unknown'}; global block ${gate.globalBlock === true ? 'on' : 'off'}; ${blocked} blocked server${blocked === 1 ? '' : 's'}`]
        : []),
      ...issues.flatMap((issue, index) => problemLines(`Issue ${index + 1}`, issue))
    ].join('\n');
  }

  function showStatus(message, isError = false) {
    statusMessage = message;
    statusIsError = isError;
  }

  async function readHealth(attempt = 1) {
    let snapshot;
    try {
      snapshot = await window.electron.invoke('startup:get-health');
    } catch (error) {
      logger.debug('Startup health is unavailable', {
        category: 'core',
        data: { component: 'StartupHealthBanner', errorType: error?.constructor?.name || 'Error' }
      });
      return;
    }
    if (destroyed || !snapshot || typeof snapshot !== 'object' || typeof snapshot.status !== 'string') return;
    health = snapshot;
    // Startup publishes its final status before the main window opens. A
    // snapshot that is still starting is read again for a few seconds.
    if (snapshot.status === 'starting' && attempt < HEALTH_READ_ATTEMPTS) {
      healthRetryTimer = setTimeout(() => {
        healthRetryTimer = null;
        void readHealth(attempt + 1);
      }, HEALTH_RETRY_DELAY_MS);
    }
  }

  async function checkForUpdates() {
    if (updateState !== 'idle') return;
    updateState = 'checking';
    showStatus(CHECKING_MESSAGE);
    let result;
    try {
      result = await window.electron.invoke('check-for-updates');
    } catch (error) {
      updateState = 'idle';
      showStatus(messageText(error?.message) || CHECK_FAILED_MESSAGE, true);
      return;
    }
    if (result?.checking === true) {
      updateState = 'idle';
      showStatus(CHECK_BUSY_MESSAGE, true);
    } else if (result?.success !== true) {
      updateState = 'idle';
      showStatus(messageText(result?.error) || CHECK_FAILED_MESSAGE, true);
    } else if (result.updateAvailable !== true) {
      updateState = 'idle';
      showStatus(result.developmentMode === true ? DEVELOPMENT_COPY_MESSAGE : NO_UPDATE_MESSAGE);
    } else {
      updateVersion = messageText(result.latestVersion);
      updateState = 'available';
      showStatus(updateVersion
        ? `Minecraft Core ${versionLabel(updateVersion)} is available.`
        : 'A newer version of Minecraft Core is available.');
    }
  }

  // The update service installs the download itself (installAfterDownload);
  // the banner only follows its progress and its errors.
  async function downloadAndInstall() {
    if (updateState !== 'available') return;
    listenForUpdateEvents();
    updateState = 'downloading';
    updatePercent = 0;
    showStatus('');
    let result;
    try {
      result = await window.electron.invoke('download-update', { installAfterDownload: true });
    } catch (error) {
      failUpdate(messageText(error?.message) || DOWNLOAD_FAILED_MESSAGE);
      return;
    }
    if (result?.success === false) failUpdate(messageText(result.error) || DOWNLOAD_FAILED_MESSAGE);
  }

  // A failed download or a refused install keeps the update on offer, so it
  // can be tried again once the reason is resolved.
  function failUpdate(message) {
    if (updateState !== 'downloading' && updateState !== 'installing') return;
    stopWaitingForInstall();
    updateState = 'available';
    showStatus(message, true);
  }

  function stopWaitingForInstall() {
    if (!installStartTimer) return;
    clearTimeout(installStartTimer);
    installStartTimer = null;
  }

  function handleInstallNotStarted() {
    installStartTimer = null;
    if (updateState === 'installing') failUpdate(INSTALL_NOT_STARTED_MESSAGE);
  }

  function handleDownloadProgress(progress) {
    if (updateState !== 'downloading') return;
    const percent = Number(progress?.percent);
    if (Number.isFinite(percent)) updatePercent = Math.min(100, Math.max(0, Math.floor(percent)));
  }

  function handleUpdateDownloaded() {
    if (updateState !== 'downloading') return;
    updatePercent = 100;
    updateState = 'installing';
    stopWaitingForInstall();
    installStartTimer = setTimeout(handleInstallNotStarted, INSTALL_START_TIMEOUT_MS);
  }

  function handleUpdateError(details) {
    if (updateState === 'downloading') failUpdate(messageText(details?.message) || DOWNLOAD_FAILED_MESSAGE);
    else if (updateState === 'installing') failUpdate(messageText(details?.message) || INSTALL_REFUSED_MESSAGE);
  }

  function listenForUpdateEvents() {
    if (listeningForUpdates) return;
    listeningForUpdates = true;
    window.electron.on('update-download-progress', handleDownloadProgress);
    window.electron.on('update-downloaded', handleUpdateDownloaded);
    window.electron.on('update-error', handleUpdateError);
  }

  function stopListeningForUpdateEvents() {
    if (!listeningForUpdates) return;
    listeningForUpdates = false;
    window.electron.removeListener('update-download-progress', handleDownloadProgress);
    window.electron.removeListener('update-downloaded', handleUpdateDownloaded);
    window.electron.removeListener('update-error', handleUpdateError);
  }

  async function restartApp() {
    if (restarting) return;
    restarting = true;
    showStatus(RESTARTING_MESSAGE);
    let failure = '';
    try {
      const result = await window.electron.invoke('startup:relaunch');
      if (result?.success === false) failure = messageText(result.error) || RESTART_FAILED_MESSAGE;
    } catch (error) {
      failure = messageText(error?.message) || RESTART_FAILED_MESSAGE;
    }
    if (failure) {
      restarting = false;
      showStatus(failure, true);
    }
  }

  async function openLogFolder() {
    let failure = '';
    try {
      const result = await window.electron.invoke('startup:open-logs');
      if (result?.success === false) failure = messageText(result.error) || OPEN_LOGS_FAILED_MESSAGE;
    } catch (error) {
      failure = messageText(error?.message) || OPEN_LOGS_FAILED_MESSAGE;
    }
    if (failure) showStatus(failure, true);
  }

  async function copyDetails() {
    try {
      await navigator.clipboard.writeText(healthDetails(health));
      showStatus(COPIED_MESSAGE);
    } catch {
      showStatus(COPY_FAILED_MESSAGE, true);
    }
  }

  onMount(() => {
    // The browser panel has no startup channels of its own.
    if (health === null && !window.IS_BROWSER_PANEL && typeof window.electron?.invoke === 'function') {
      void readHealth();
    }
  });

  onDestroy(() => {
    destroyed = true;
    if (healthRetryTimer) clearTimeout(healthRetryTimer);
    stopWaitingForInstall();
    stopListeningForUpdateEvents();
  });
</script>

{#if problem}
  <section class="startup-health-banner" aria-labelledby="startup-health-banner-title">
    <h2 id="startup-health-banner-title" class="banner-title">{title}</h2>
    <p class="banner-summary">{problem.summary}</p>
    {#if hasText(problem.hint)}
      <p class="banner-hint">{problem.hint}</p>
    {/if}
    <p class="banner-safety">{DATA_SAFETY_LINE}</p>
    <p class="banner-gate">{gateLine}</p>
    <div class="banner-actions">
      {#if updateState === 'available'}
        <button type="button" class="banner-button primary" on:click={downloadAndInstall}>
          Download and install {versionLabel(updateVersion)}
        </button>
      {:else}
        <button type="button" class="banner-button primary" disabled={updateBusy} on:click={checkForUpdates}>
          Check for updates
        </button>
      {/if}
      <button type="button" class="banner-button" disabled={restarting || updateState === 'installing'} on:click={restartApp}>
        Restart
      </button>
      <button type="button" class="banner-button" on:click={openLogFolder}>
        Open log folder
      </button>
      <button type="button" class="banner-button" on:click={copyDetails}>
        Copy details
      </button>
    </div>
    {#if updateState === 'downloading' || updateState === 'installing'}
      <div class="banner-progress">
        <progress max="100" value={updatePercent} aria-label="Update download progress"></progress>
        <span>{progressText}</span>
      </div>
    {/if}
    <p class="banner-status" class:error={statusIsError} role="status" aria-live="polite">{statusMessage}</p>
  </section>
{/if}

<style>
  .startup-health-banner {
    /* The left margin clears the fixed sidebar toggle. */
    margin: 0.75rem 1rem 0 3.75rem;
    padding: 0.9rem 1.1rem;
    border: 1px solid rgba(245, 158, 11, 0.4);
    border-left: 4px solid #f59e0b;
    border-radius: 8px;
    background: rgba(245, 158, 11, 0.08);
    color: #e5e7eb;
    text-align: left;
    box-sizing: border-box;
  }

  .banner-title {
    margin: 0 0 0.35rem;
    font-size: 1rem;
    font-weight: 600;
    color: #fbbf24;
    text-align: left;
  }

  .banner-summary,
  .banner-hint,
  .banner-safety,
  .banner-gate {
    margin: 0.2rem 0;
    font-size: 0.875rem;
    line-height: 1.4;
  }

  .banner-hint,
  .banner-gate {
    color: #d1d5db;
  }

  .banner-safety {
    color: #86efac;
  }

  .banner-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .banner-button {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: #e5e7eb;
    padding: 0.4rem 0.85rem;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .banner-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.16);
  }

  .banner-button.primary {
    background: #2563eb;
    border-color: #2563eb;
    color: #ffffff;
  }

  .banner-button.primary:hover:not(:disabled) {
    background: #1d4ed8;
  }

  .banner-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .banner-progress {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
    font-size: 0.85rem;
    color: #d1d5db;
  }

  .banner-progress progress {
    flex: 1;
    max-width: 18rem;
    height: 0.5rem;
    accent-color: #3b82f6;
  }

  .banner-status {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
    color: #d1d5db;
  }

  .banner-status.error {
    color: #fca5a5;
  }

  .banner-status:empty {
    margin: 0;
  }
</style>
