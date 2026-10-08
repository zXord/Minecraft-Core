<script>
  import { createEventDispatcher } from 'svelte';
  import { isPlanStaleError, modpackApi } from '../../utils/modpacks/modpackApi.js';

  const dispatch = createEventDispatcher();
  export let inspection;
  export let reviewedPlan = null;
  export let busy = false;
  export let error = null;
  export let operationKind = 'install-existing';
  export let preflightProgress = null;
  export let selectingDestination = false;
  export let defaultMaxRam = 4;
  export let defaultServerPort = 25565;

  function normalizedDefaultMaxRam(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 64 ? parsed : 4;
  }

  function normalizedServerPort(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1025 && parsed <= 65535 ? parsed : 25565;
  }

  const preflightPhaseLabels = Object.freeze({
    'validating-destination': 'Validating the selected destination',
    'preparing-candidate': 'Preparing candidate files',
    'scanning-server': 'Scanning current server files',
    'calculating-changes': 'Calculating safe file changes',
    'checking-capacity': 'Checking disk capacity and write safety',
    'sealing-plan': 'Sealing the one-use reviewed plan',
    complete: 'Opening the reviewed plan'
  });
  const preflightPhases = Object.freeze(Object.keys(preflightPhaseLabels));
  const preflightActivityLabels = Object.freeze({
    extracting: 'Extracting archive',
    'verifying-archive': 'Verifying archive',
    'downloading-pack-files': 'Downloading pack files',
    'assembling-files': 'Assembling files',
    'hashing-candidate-files': 'Hashing candidate files'
  });

  let acceptEula = false;
  let startAfterInstall = true;
  let acknowledgeMissingProviderDigest = false;
  let acknowledgeDowngradeWorldRisk = false;
  let optionalFileIds = [];
  let conflictChoices = { paths: {}, categories: {} };
  let selectedRoot = null;
  let runtimeChoice = null;
  let runtimeMinecraftVersion = '';
  let runtimeLoaderFamily = '';
  let runtimeLoaderVersion = '';
  let maxRam = normalizedDefaultMaxRam(defaultMaxRam);
  let serverPort = normalizedServerPort(defaultServerPort);
  let networkAccess = 'pack-default';
  let selectionInspectionId = null;
  let starting = false;
  let planStale = false;
  let activeReviewedPlanId = null;

  $: rootCandidates = inspection?.rootCandidates || [];
  $: detectedRuntime = cleanRuntimeChoice(inspection?.classification?.runtime);
  $: runtimeCandidates = inspection?.classification?.runtimeCandidates || inspection?.classification?.candidates?.filter(candidate => cleanRuntimeChoice(candidate)) || [];
  $: loaderChoices = [...new Set([
    ...((inspection?.classification?.candidates || []).map(candidate => candidate?.loaderFamily).filter(Boolean)),
    'vanilla', 'fabric', 'forge', 'neoforge', 'quilt'
  ])];
  $: optionalFiles = inspection?.classification?.optionalFiles || [];
  $: conflictReview = reviewedPlan?.requiresConflictReview === true;
  $: conflicts = conflictReview && Array.isArray(reviewedPlan?.conflicts) ? reviewedPlan.conflicts : [];
  $: if ((inspection?.inspectionId || null) !== selectionInspectionId) resetInspectionSelections(inspection);
  $: if ((reviewedPlan?.planId || null) !== activeReviewedPlanId) resetReviewedPlanState(reviewedPlan);
  $: runtimeChoice = cleanRuntimeChoice({
    minecraftVersion: runtimeMinecraftVersion,
    loaderFamily: runtimeLoaderFamily,
    loaderVersion: runtimeLoaderVersion
  });
  $: missingDigest = Boolean(inspection?.warnings?.some?.(warning => warning.code === 'MISSING_PROVIDER_DIGEST') || reviewedPlan?.planView?.warnings?.some?.(warning => warning.code === 'MISSING_PROVIDER_DIGEST'));
  $: rootChoiceRequired = inspection?.classification?.kind === 'ambiguous-or-unknown' &&
    inspection?.classification?.confidence === 'multiple-roots' &&
    !inspection?.selectedRoot && rootCandidates.length > 1;
  $: runtimeChoiceRequired = !rootChoiceRequired && !detectedRuntime && inspection?.classification?.kind === 'ambiguous-or-unknown';
  $: classificationKind = inspection?.classification?.kind || '';
  $: clientOnlyArchive = ['multimc-client-only', 'mrpack-client-only'].includes(classificationKind);
  $: unsupportedRuntimeArchive = classificationKind === 'unsupported-runtime-layout';
  $: backupArchive = classificationKind === 'backup-archive';
  $: knownClassificationBlocker = inspection?.classification?.blocked === true &&
    (clientOnlyArchive || unsupportedRuntimeArchive || backupArchive);
  $: classificationStillUnknown = inspection?.classification?.blocked === true &&
    !knownClassificationBlocker && !rootChoiceRequired && !runtimeChoiceRequired;
  $: unresolvedAmbiguity = (rootChoiceRequired && !selectedRoot) ||
    (runtimeChoiceRequired && !runtimeChoice) || classificationStillUnknown || knownClassificationBlocker;
  $: hardConflictBlocker = conflicts.some(conflict => !Array.isArray(conflict.allowedChoices) || conflict.allowedChoices.length === 0);
  $: unresolvedConflictCount = conflicts.filter(conflict => !isConflictResolved(conflict, conflictChoices)).length;
  $: keepExistingCount = conflicts.filter(conflict => canFillConflict(conflict, 'keep-mine', conflictChoices)).length;
  $: packConfigCount = conflicts.filter(conflict => canFillConflict(conflict, 'use-pack', conflictChoices)).length;
  $: conflictsResolved = !conflictReview || (!hardConflictBlocker && unresolvedConflictCount === 0);
  $: filesOnlyEligible = ['files-only', 'ambiguous-or-unknown', 'unsupported-runtime-layout'].includes(inspection?.classification?.kind);
  $: blockers = reviewedPlan?.planView?.blockers || [];
  $: hasCurrentInspection = Boolean(inspection?.inspectionId);
  $: reviewRequiresRefresh = planStale || isPlanStaleError(error);
  $: downgradeRiskAccepted = operationKind !== 'downgrade' || acknowledgeDowngradeWorldRisk;
  $: needsNewServerResources = operationKind === 'install-new';
  $: validMaxRam = Number.isSafeInteger(Number(maxRam)) && Number(maxRam) >= 1 && Number(maxRam) <= 64;
  $: validServerPort = Number.isSafeInteger(Number(serverPort)) && Number(serverPort) >= 1025 && Number(serverPort) <= 65535;
  $: validNetworkAccess = ['pack-default', 'loopback'].includes(networkAccess);
  $: canPreflight = hasCurrentInspection && !reviewRequiresRefresh && !knownClassificationBlocker && !unresolvedAmbiguity && conflictsResolved && (!missingDigest || acknowledgeMissingProviderDigest) && downgradeRiskAccepted && (!needsNewServerResources || (validMaxRam && validServerPort && validNetworkAccess));
  $: canFilesOnly = operationKind !== 'repair' && hasCurrentInspection && !reviewRequiresRefresh && filesOnlyEligible && (!rootChoiceRequired || Boolean(selectedRoot)) && (!missingDigest || acknowledgeMissingProviderDigest);
  $: canStart = !planStale && !isPlanStaleError(error) && Boolean(reviewedPlan?.planId && reviewedPlan?.planFingerprint && blockers.length === 0 && acceptEula && (!missingDigest || acknowledgeMissingProviderDigest));
  $: plan = reviewedPlan?.planView || {};
  $: changes = plan.changes || {};
  $: preflightPhase = Object.hasOwn(preflightPhaseLabels, preflightProgress?.phase)
    ? preflightProgress.phase
    : 'validating-destination';
  $: preflightStage = preflightPhases.indexOf(preflightPhase) + 1;
  $: preflightActivity = Object.hasOwn(preflightActivityLabels, preflightProgress?.activity)
    ? preflightProgress.activity
    : null;
  $: preflightStatusLabel = preflightActivity
    ? preflightActivityLabels[preflightActivity]
    : preflightPhaseLabels[preflightPhase];
  $: byteProgress = validProgressPair(preflightProgress?.processedBytes, preflightProgress?.totalBytes);
  $: itemProgress = validProgressPair(preflightProgress?.completedItems, preflightProgress?.totalItems);
  $: determinateProgress = byteProgress?.total > 0 ? byteProgress : itemProgress?.total > 0 ? itemProgress : null;
  $: preflightPercent = determinateProgress
    ? Math.max(0, Math.min(100, Math.round((determinateProgress.completed / determinateProgress.total) * 100)))
    : null;

  function rootLabel(candidate) {
    return typeof candidate === 'string' ? candidate : '';
  }

  function cleanRuntimeChoice(candidate) {
    if (!candidate) return null;
    const { minecraftVersion, loaderFamily, loaderVersion } = candidate;
    if (typeof minecraftVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/.test(minecraftVersion) ||
        !['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'].includes(loaderFamily) ||
        typeof loaderVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(loaderVersion)) return null;
    return { minecraftVersion, loaderFamily, loaderVersion };
  }

  function runtimeLabel(candidate) {
    const value = cleanRuntimeChoice(candidate);
    return value ? `Minecraft ${value.minecraftVersion} · ${value.loaderFamily} ${value.loaderVersion}` : 'Incomplete runtime evidence';
  }

  function resetInspectionSelections(nextInspection) {
    selectionInspectionId = nextInspection?.inspectionId || null;
    const roots = nextInspection?.rootCandidates || [];
    optionalFileIds = (nextInspection?.classification?.optionalFiles || [])
      .filter(item => item?.defaultSelected === true)
      .map(item => item.id);
    selectedRoot = typeof nextInspection?.selectedRoot === 'string'
      ? nextInspection.selectedRoot
      : roots.length === 1 ? rootLabel(roots[0]) : null;
    const runtimes = nextInspection?.classification?.runtimeCandidates || [];
    const suggestedRuntime = runtimes.length === 1 ? cleanRuntimeChoice(runtimes[0]) : null;
    runtimeMinecraftVersion = suggestedRuntime?.minecraftVersion || '';
    runtimeLoaderFamily = suggestedRuntime?.loaderFamily || '';
    runtimeLoaderVersion = suggestedRuntime?.loaderVersion || '';
    maxRam = normalizedDefaultMaxRam(defaultMaxRam);
    serverPort = normalizedServerPort(defaultServerPort);
    networkAccess = 'pack-default';
    conflictChoices = { paths: {}, categories: {} };
  }

  function validProgressPair(completed, total) {
    return Number.isSafeInteger(completed) && completed >= 0 && Number.isSafeInteger(total) &&
      total >= 0 && completed <= total ? { completed, total } : null;
  }

  function formatProgressDetail(bytes, items, activity) {
    if (bytes?.total > 0 && items?.total > 0) {
      const unit = ['downloading-pack-files', 'assembling-files', 'hashing-candidate-files'].includes(activity) ? 'files' : 'items';
      return `${items.completed.toLocaleString('en-US')} of ${items.total.toLocaleString('en-US')} ${unit} · ${formatBytes(bytes.completed)} of ${formatBytes(bytes.total)}`;
    }
    if (bytes?.total > 0) return `${formatBytes(bytes.completed)} of ${formatBytes(bytes.total)}`;
    if (items?.total > 0) return `${items.completed} of ${items.total} items`;
    return 'Server files remain unchanged while this reviewed plan is prepared.';
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

  function resetReviewedPlanState(nextPlan) {
    activeReviewedPlanId = nextPlan?.planId || null;
    planStale = false;
    acceptEula = false;
    startAfterInstall = true;
  }

  function conflictDecision(conflictId, selections = conflictChoices) {
    return selections.paths?.[conflictId] || null;
  }

  function isConflictResolved(conflict, selections) {
    const decision = conflictDecision(conflict.id, selections);
    return Boolean(decision && Array.isArray(conflict.allowedChoices) && conflict.allowedChoices.includes(decision.choice) &&
      (decision.choice !== 'keep-both' || typeof decision.alternateId === 'string'));
  }

  function canFillConflict(conflict, choice, selections) {
    if (conflictDecision(conflict.id, selections)?.choice ||
        !Array.isArray(conflict.allowedChoices) || !conflict.allowedChoices.includes(choice)) return false;
    return choice === 'keep-mine' ||
      (choice === 'use-pack' && conflict.role === 'configuration' && conflict.protected === false);
  }

  function fillConflictChoices(choice) {
    if (busy || starting || reviewRequiresRefresh) return;
    const paths = { ...conflictChoices.paths };
    for (const conflict of conflicts) {
      if (canFillConflict(conflict, choice, conflictChoices)) paths[conflict.id] = { choice };
    }
    conflictChoices = { ...conflictChoices, paths };
  }

  function chooseConflict(conflict, choice) {
    const prior = conflictDecision(conflict.id);
    const next = choice ? { choice, ...(choice === 'keep-both' && prior?.alternateId ? { alternateId: prior.alternateId } : {}) } : null;
    const paths = { ...conflictChoices.paths };
    if (next) paths[conflict.id] = next;
    else delete paths[conflict.id];
    conflictChoices = { ...conflictChoices, paths };
  }

  function chooseConflictAlternate(conflict, alternateId) {
    const decision = conflictDecision(conflict.id);
    if (decision?.choice !== 'keep-both') return;
    conflictChoices = {
      ...conflictChoices,
      paths: { ...conflictChoices.paths, [conflict.id]: { choice: 'keep-both', ...(alternateId ? { alternateId } : {}) } }
    };
  }

  function choiceLabel(choice) {
    return {
      'keep-mine': 'Keep my file',
      'use-pack': 'Use the pack file',
      'keep-both': 'Keep both',
      'disable-addon': 'Disable the conflicting add-on',
      'remove-addon': 'Remove the conflicting add-on'
    }[choice] || choice;
  }

  function planningSelections() {
    return {
      optionalFileIds,
      conflictChoices,
      acknowledgeMissingProviderDigest,
      ...(operationKind === 'downgrade' ? { acknowledgeDowngradeWorldRisk } : { acknowledgeDowngradeWorldRisk: false }),
      selectedRoot,
      runtimeChoice: cleanRuntimeChoice(runtimeChoice),
      maxRam: needsNewServerResources && validMaxRam ? Number(maxRam) : null,
      serverPort: needsNewServerResources && validServerPort ? Number(serverPort) : null,
      networkAccess: needsNewServerResources ? networkAccess : null
    };
  }

  function requestPreflight() {
    if (!canPreflight) return;
    dispatch('preflight', { selections: planningSelections() });
  }

  function requestFilesOnlyPreflight() {
    if (!canFilesOnly) return;
    dispatch('filesonly', { selections: {
      ...planningSelections(),
      acknowledgeDowngradeWorldRisk: false,
      runtimeChoice: null,
      maxRam: null,
      serverPort: null,
      networkAccess: null
    } });
  }

  async function startReviewedPlan() {
    if (!canStart) return;
    starting = true;
    try {
      const { planId, planFingerprint } = reviewedPlan;
      const choices = { acceptEula, startAfterInstall, restorePointId: null };
      const job = await modpackApi.startOperation({ planId, planFingerprint, choices });
      dispatch('started', { job });
    } catch (caught) {
      if (isPlanStaleError(caught)) {
        planStale = true;
        return;
      }
      dispatch('error', { error: caught });
    } finally {
      starting = false;
    }
  }

  function count(value) {
    return value ?? 0;
  }

  function integrityLabel(value) {
    if (value === 'deferred-to-extraction') return 'Will be checked during protected setup';
    if (value === 'tested') return 'Checked';
    return 'Not checked';
  }
</script>

<div class="modpack-surface mp-stack">
  <div class="mp-toolbar"><div class="grow"><p class="mp-kicker">Guided archive review</p><h2 class="mp-title">Inspect evidence before installation</h2><p class="mp-subtitle">No server write occurs until this exact plan is accepted and started.</p></div><button type="button" class="mp-button" on:click={() => dispatch('back')}>Choose another asset</button></div>

  {#if reviewRequiresRefresh}<section class="mp-state warning" tabindex="-1" aria-live="assertive"><strong>Reviewed plan needs to be refreshed</strong><p>The server, archive session, or one-use plan changed before installation started. Nothing was installed. Refresh the exact selection and review a newly generated plan before continuing.</p><button type="button" class="mp-button" disabled={busy || starting} on:click={() => dispatch('stale')}>Run a fresh preflight review</button></section>
  {:else if error}<section class="mp-state error" tabindex="-1" aria-live="assertive"><strong>Review could not continue</strong><p>{error.message}</p></section>{/if}

  <section class="mp-grid" aria-label="Archive inspection evidence">
    <div class="mp-card mp-metric"><span class="mp-muted">Compressed data</span><strong>{integrityLabel(inspection?.integrity)}</strong><span class="mp-muted">{inspection?.archiveFamily || 'Unknown'} archive</span></div>
    <div class="mp-card mp-metric"><span class="mp-muted">Archive tree</span><strong>{inspection?.limitEvidence?.totals?.entryCount || inspection?.entries?.length || 0} files</strong><span class="mp-muted">{inspection?.limitEvidence?.totals?.expandedBytes || 'Unknown'} expanded bytes</span></div>
    <div class="mp-card mp-metric"><span class="mp-muted">Classification</span><strong>{inspection?.classification?.kind || 'Unknown package'}</strong><span class="mp-muted">{inspection?.classification?.confidence || 'No confidence'} evidence</span></div>
    <div class="mp-card mp-metric"><span class="mp-muted">Proposed root</span><strong>{selectedRoot || 'Archive root'}</strong><span class="mp-muted">{rootCandidates.length} root candidate{rootCandidates.length === 1 ? '' : 's'}</span></div>
  </section>

  <section class="mp-panel mp-stack">
    <div><h3>Runtime and Java evidence</h3><p class="mp-muted">Minecraft {plan.runtime?.minecraft || detectedRuntime?.minecraftVersion || runtimeChoice?.minecraftVersion || 'not identified'} · {plan.runtime?.loader || detectedRuntime?.loaderFamily || runtimeChoice?.loaderFamily || 'loader not identified'} {plan.runtime?.loaderVersion || detectedRuntime?.loaderVersion || runtimeChoice?.loaderVersion || ''} · Java {plan.runtime?.java || inspection?.classification?.runtime?.javaMajor || 'derived after selection'}</p></div>
    {#if rootChoiceRequired}
      <fieldset class="choice-list"><legend>Choose the server root</legend>{#each rootCandidates as candidate (rootLabel(candidate))}<label><input type="radio" name="archive-root" bind:group={selectedRoot} value={rootLabel(candidate)} /><span><strong>{rootLabel(candidate)}</strong><small>Use this archive directory as the server root.</small></span></label>{/each}</fieldset>
    {/if}
    {#if runtimeChoiceRequired}
      <fieldset class="choice-list runtime-fields"><legend>Enter the exact runtime</legend><label><span><strong>Minecraft version</strong><small>Use the exact version declared by the pack publisher.</small></span><input type="text" bind:value={runtimeMinecraftVersion} placeholder="1.21.1" /></label><label><span><strong>Loader family</strong><small>Select the exact supported loader family.</small></span><select bind:value={runtimeLoaderFamily}><option value="">Select loader</option>{#each loaderChoices as loader (loader)}<option value={loader}>{loader}</option>{/each}</select></label><label><span><strong>Loader version</strong><small>Use the exact loader version declared by the pack publisher.</small></span><input type="text" bind:value={runtimeLoaderVersion} placeholder="0.16.14" /></label><p class="mp-muted">Java, operating system, and architecture are derived and validated by the main process.</p></fieldset>
    {/if}
    {#if needsNewServerResources}
      <label class="resource-choice"><span><strong>Maximum server RAM</strong><small>This exact allocation is included in the reviewed plan and used for candidate and final health checks.</small></span><span class="resource-input"><input class="mp-input" type="number" min="1" max="64" step="1" bind:value={maxRam} aria-describedby="modpack-memory-help" /><span>GiB</span></span></label>
      <p id="modpack-memory-help" class="mp-muted">The initial allocation comes from your app settings. Large packs may need more RAM; adjust this value for the pack and your computer.</p>
      {#if !validMaxRam}<div class="mp-state error"><strong>Choose a whole-number RAM allocation</strong><p>Enter between 1 and 64 GiB before building the reviewed plan.</p></div>{/if}
      <label class="resource-choice"><span><strong>Minecraft server port</strong><small>This exact port is persisted for normal server starts and final running validation.</small></span><span class="resource-input"><input class="mp-input" type="number" min="1025" max="65535" step="1" bind:value={serverPort} aria-describedby="modpack-port-help" /></span></label>
      <p id="modpack-port-help" class="mp-muted">A stopped-after-install setup may use a separate private test port for its temporary boot check. Choose a free non-reserved port from 1025 to 65535; the normal Minecraft default is 25565.</p>
      {#if !validServerPort}<div class="mp-state error"><strong>Choose a valid Minecraft port</strong><p>Enter a whole number between 1025 and 65535 before building the reviewed plan.</p></div>{/if}
      <label class="resource-choice"><span><strong>Network access</strong><small>Choose whether the server follows the pack's normal network binding or stays reachable only from this computer.</small></span><select class="mp-input" bind:value={networkAccess}><option value="pack-default">Use pack/default network binding</option><option value="loopback">This computer only (127.0.0.1)</option></select></label>
      <p class="mp-muted">This computer only avoids LAN exposure and normally avoids a Windows Firewall permission prompt. Choose the pack/default binding when other devices need to join.</p>
    {/if}
    {#if optionalFiles.length > 0}
      <fieldset class="choice-list"><legend>Optional pack files</legend>{#each optionalFiles as item (item.id)}<label><input type="checkbox" bind:group={optionalFileIds} value={item.id} /><span><strong>{item.label}</strong><small>{item.defaultSelected ? 'Included by the pack by default.' : 'Not included unless selected.'}</small></span></label>{/each}</fieldset>
    {/if}
    {#if conflictReview}
      <section class="conflict-review mp-stack" aria-label="Conflict choices">
        <div><h3>Choose which files to keep</h3><p class="mp-muted">Your server and the pack have different versions of these files. Make your choices, then review the planned changes before installing.</p></div>
        <p class="mp-muted" role="status" aria-live="polite">{conflicts.length - unresolvedConflictCount} of {conflicts.length} files decided · {unresolvedConflictCount} remaining</p>
        <div class="mp-actions">
          <button type="button" class="mp-button" disabled={busy || starting || reviewRequiresRefresh || keepExistingCount === 0} on:click={() => fillConflictChoices('keep-mine')}>Keep existing files</button>
          <button type="button" class="mp-button" disabled={busy || starting || reviewRequiresRefresh || packConfigCount === 0} on:click={() => fillConflictChoices('use-pack')}>Use pack files for configs</button>
        </div>
        <p class="mp-muted">These buttons fill only choices you have not made. Pack files are selected only for unprotected configuration files; protected settings and startup files are never replaced by the config button. You can change any choice below.</p>
        {#each conflicts as conflict (conflict.id)}
          <fieldset class="choice-list" disabled={busy || starting || reviewRequiresRefresh}>
            <legend>{conflict.label}</legend>
            <p class="mp-muted">{conflict.protected ? 'Protected file. The config button will not replace this file.' : conflict.role === 'configuration' ? 'Configuration file. Keeping your copy preserves your changes; using the pack file replaces them.' : 'Choose how to handle this file.'}</p>
            {#if !conflict.allowedChoices?.length}
              <div class="mp-state error"><strong>Structural conflict cannot be overridden</strong><p>Choose another archive or change the server contents before retrying.</p></div>
            {:else}
              <label><span><strong>Resolution</strong></span><select aria-label={`Resolution for ${conflict.label}`} value={conflictDecision(conflict.id, conflictChoices)?.choice || ''} on:change={(event) => chooseConflict(conflict, event.target.value)}><option value="">Choose a resolution</option>{#each conflict.allowedChoices as choice (choice)}<option value={choice}>{choiceLabel(choice)}</option>{/each}</select></label>
              {#if conflictDecision(conflict.id, conflictChoices)?.choice === 'keep-both'}
                <label><span><strong>Alternate destination</strong></span><select aria-label={`Alternate destination for ${conflict.label}`} value={conflictDecision(conflict.id, conflictChoices)?.alternateId || ''} on:change={(event) => chooseConflictAlternate(conflict, event.target.value)}><option value="">Choose an approved alternate</option>{#each conflict.alternateOptions || [] as alternate (alternate.id)}<option value={alternate.id}>{alternate.label}</option>{/each}</select></label>
              {/if}
            {/if}
          </fieldset>
        {/each}
      </section>
    {/if}
    {#if clientOnlyArchive}
      <div class="mp-state error"><strong>Client launcher archive cannot create a server</strong><p>This asset is a client instance, not a server pack. Choose the uploaded server pack asset instead; Minecraft Core will not guess at or execute a client launcher's files as a server.</p></div>
    {:else if unsupportedRuntimeArchive}
      <div class="mp-state error"><strong>Managed setup is unavailable</strong><p>This archive needs a launcher or runtime Minecraft Core cannot safely set up. Choose a server package made for managed setup, or use files-only import when you only need the reviewed server data.</p></div>
    {:else if backupArchive}
      <div class="mp-state error"><strong>Backup archive cannot be installed as a modpack</strong><p>Restore this archive through the backup workflow, or choose the uploaded server pack asset instead.</p></div>
    {:else if unresolvedAmbiguity}
      <div class="mp-state error"><strong>Unresolved ambiguity blocks installation</strong><p>Select one safe server root and one exact runtime where offered. If the remaining evidence is still conflicting, choose another asset; Minecraft Core will not guess.</p></div>
    {/if}
    {#if missingDigest}<label class="acknowledgement"><input type="checkbox" bind:checked={acknowledgeMissingProviderDigest} /><span><strong>Missing digest acknowledgement</strong><br /><small>The provider did not publish a trustworthy digest. Minecraft Core will still calculate and pin its own SHA-256 after download.</small></span></label>{/if}
    {#if operationKind === 'downgrade'}<label class="acknowledgement"><input type="checkbox" bind:checked={acknowledgeDowngradeWorldRisk} /><span>I understand a downgrade can make the current world incompatible. Minecraft Core will create a verified safety restore point first.</span></label>{/if}
  </section>

  {#if !reviewedPlan || conflictReview}
    <section class="mp-panel mp-stack">
      <div><h3>{conflictReview ? 'Review conflict resolutions' : 'Build a managed server plan'}</h3><p class="mp-muted">Managed setup verifies the runtime, Java, ownership, conflicts, disk space, protected content, and planned changes before it can create a server that Minecraft Core can manage and start.</p></div>
      {#if busy && selectingDestination}
        <div class="preflight-status mp-state" role="status" aria-live="polite" aria-atomic="true"><strong>Choose the server destination</strong><p>The native folder picker is open. After you choose a folder, Minecraft Core will run the protected safety checks.</p></div>
      {:else if busy && preflightProgress}
        <div class="preflight-status mp-state" role="status" aria-live="polite" aria-atomic="true">
          <div class="preflight-heading"><div><span>Stage {preflightStage} of {preflightPhases.length}</span><strong>{preflightStatusLabel}</strong></div>{#if preflightPercent !== null}<span>{preflightPercent}%</span>{/if}</div>
          {#if determinateProgress}
            <progress class="mp-progress-meter" aria-label={preflightStatusLabel} max="100" value={preflightPercent}>{preflightPercent}%</progress>
          {:else}
            <div class="indeterminate mp-progress-track" aria-hidden="true"><span class="mp-progress-activity"></span></div>
          {/if}
          <p>{formatProgressDetail(byteProgress, itemProgress, preflightActivity)}</p>
        </div>
      {/if}
      <div class="mp-actions"><button type="button" class="mp-button primary" disabled={!canPreflight || busy} on:click={requestPreflight}>{busy ? selectingDestination ? 'Waiting for destination…' : preflightProgress ? `${preflightStatusLabel}…` : 'Starting plan review…' : conflictReview ? 'Re-run review with conflict choices' : operationKind === 'install-new' ? 'Choose destination and review plan' : 'Review planned changes'}</button>{#if !conflictReview && filesOnlyEligible}<div class="files-only-fallback"><p class="mp-muted">Files-only import copies reviewed server data without running an archive launcher. It does not make the server managed or ready to start.</p><button type="button" class="mp-button" on:click={requestFilesOnlyPreflight} disabled={!canFilesOnly || busy}>Import reviewed data as files-only</button></div>{/if}</div>
    </section>
  {:else}
    <section class="mp-panel mp-stack" aria-label="Reviewed modpack plan">
      <div><p class="mp-kicker">Exact reviewed plan</p><h3>{plan.title || 'Modpack installation'}</h3><p class="mp-muted">{plan.source?.provider || 'Reviewed source'} · version {plan.source?.version || 'exact selection'} · server revision {plan.server?.contentRevision ?? 'new'}</p></div>
      <div class="mp-grid" aria-label="File diff summary">
        <div class="mp-card mp-metric"><span class="mp-muted">Files added</span><strong>{count(changes.added)}</strong></div>
        <div class="mp-card mp-metric"><span class="mp-muted">Files changed</span><strong>{count(changes.changed)}</strong></div>
        <div class="mp-card mp-metric"><span class="mp-muted">Files removed</span><strong>{count(changes.removed)}</strong></div>
        <div class="mp-card mp-metric"><span class="mp-muted">Files preserved</span><strong>{count(changes.preserved)}</strong></div>
      </div>
      <div class="mp-split">
        <div class="mp-card"><strong>Ownership and conflicts</strong><p class="mp-muted">Pack-managed and runtime-managed files are tracked separately from user-owned additions. Protected worlds, secrets, modified files, and unresolved conflicts are preserved or block the plan.</p></div>
        <div class="mp-card"><strong>Planned work</strong><p class="mp-muted">Verified downloads, safe extraction, runtime and Java configuration, candidate validation, directory commit, final-path health validation, and rollback cleanup.</p></div>
      </div>
      {#if plan.resources?.maxRam}<div class="mp-state"><strong>Reviewed server resources</strong><p>{plan.resources.maxRam} GiB maximum RAM and Minecraft port {plan.resources?.serverPort} will be persisted in the server configuration. The selected port is used for normal server starts and final running validation; a stopped-after-install boot test may use a separate private port. Network access: {plan.resources?.networkAccess === 'loopback' ? 'this computer only' : 'pack/default binding'}.</p></div>{/if}
      {#if plan.warnings?.length}<div class="mp-state warning"><strong>Warnings require review</strong><ul>{#each plan.warnings as warning, index (index)}<li>{warning.message || warning.code || warning}</li>{/each}</ul></div>{/if}
      {#if blockers.length}<div class="mp-state error"><strong>Plan has unresolved blockers</strong><ul>{#each blockers as blocker, index (index)}<li>{blocker.message || blocker.code || blocker}</li>{/each}</ul></div>{/if}
      <label class="acknowledgement"><input type="checkbox" bind:checked={acceptEula} /><span><strong>I accept the Minecraft EULA</strong><br /><small>Pack-supplied EULA files are ignored; this explicit choice controls application-owned acceptance.</small></span></label>
      <label class="acknowledgement"><input type="checkbox" bind:checked={startAfterInstall} /><span>Start after install and validate final health</span></label>
      <div class="mp-actions"><button type="button" class="mp-button primary" disabled={!canStart || busy || starting} on:click={startReviewedPlan}>{starting ? 'Starting…' : 'Install this exact reviewed plan'}</button></div>
    </section>
  {/if}
</div>

<style>
  @import '../modpacks/modpack-ui.css';
  h3 { margin: 0 0 0.35rem; }
  .acknowledgement { display: flex; gap: 0.65rem; align-items: flex-start; }
  .acknowledgement input { margin-top: 0.25rem; }
  .choice-list { display: grid; gap: 0.55rem; margin: 0; padding: 0.8rem; border: 1px solid var(--mp-border); border-radius: 8px; }
  .choice-list legend { padding: 0 0.35rem; font-weight: 700; }
  .choice-list label { display: flex; gap: 0.6rem; align-items: flex-start; padding: 0.55rem; border: 1px solid transparent; border-radius: 7px; }
  .choice-list label:has(> input:is([type='radio'], [type='checkbox']):checked) { border-color: rgba(255, 255, 255, 0.46); background: rgba(255, 255, 255, 0.09); box-shadow: inset 3px 0 rgba(255, 255, 255, 0.48); }
  .choice-list label:has(> input:focus-visible) { outline: 2px solid rgba(196, 199, 255, 0.72); outline-offset: 2px; }
  .choice-list label:has(> input:disabled) { cursor: not-allowed; opacity: 0.48; }
  .choice-list label span { display: grid; gap: 0.15rem; }
  .choice-list small { color: var(--mp-muted); }
  .choice-list select, .choice-list input[type='text'] { min-width: min(100%, 18rem); padding: 0.55rem; color: inherit; background: rgba(0, 0, 0, 0.24); border: 1px solid var(--mp-border); border-radius: 6px; }
  .runtime-fields label { justify-content: space-between; align-items: center; gap: 1rem; }
  .resource-choice { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.8rem; border: 1px solid var(--mp-border); border-radius: 8px; }
  .resource-choice > span:first-child { display: grid; gap: 0.15rem; }
  .resource-choice small { color: var(--mp-muted); }
  .resource-input { display: flex; align-items: center; gap: 0.45rem; flex: 0 0 auto; }
  .resource-input .mp-input { width: 6rem; }
  .conflict-review { padding-top: 0.25rem; }
  .files-only-fallback { display: grid; gap: 0.45rem; max-width: 31rem; }
  .files-only-fallback p { margin: 0; }
  .preflight-status { display: grid; gap: 0.6rem; border-left-color: rgba(255, 255, 255, 0.48); }
  .preflight-heading { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .preflight-heading div { display: grid; gap: 0.15rem; }
  .preflight-heading span, .preflight-status p { color: var(--mp-muted); }
  .preflight-status p { margin: 0; font-size: 0.86rem; }
</style>
