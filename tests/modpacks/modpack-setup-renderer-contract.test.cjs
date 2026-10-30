const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

test('launch ownership is installed before the synchronous Start bridge entry', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const entry = setup.slice(setup.indexOf('function startReviewedOperation('), setup.indexOf('function completeSetup('));
  assert.ok(entry.indexOf("record.state = 'launch-pending'") >= 0);
  assert.ok(entry.indexOf("record.state = 'launch-pending'") < entry.indexOf('modpackApi.startOperation('));
  assert.ok(entry.indexOf('attempt.promise =') < entry.indexOf('modpackApi.startOperation('));
  for (const name of ['ArchiveGuidedReview', 'ModpackPlanReview']) {
    const child = source(`src/components/${name === 'ArchiveGuidedReview' ? 'setup' : 'modpacks'}/${name}.svelte`);
    assert.doesNotMatch(child, /modpackApi\.startOperation/u);
    assert.match(child, /startReviewedOperation\(/u);
    assert.match(child, /reviewContext/u);
  }
});

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function functionSource(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `Expected ${signature}`);
  let depth = 0;
  for (let index = text.indexOf('{', start); index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`Unterminated ${signature}`);
}

test('a settled not-started destination is released only through the guarded release, never by default', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const release = functionSource(setup, 'async function releasePendingDestination(');
  // Launch-pending, unknown and job-owned records are never released by the renderer.
  assert.match(release, /if \(!record \|\| !\['unlaunched', 'not-started'\]\.includes\(record\.state\)\) return false;/u);
  assert.doesNotMatch(release, /launch-pending|unknown|job-owned/u);

  const abandoned = functionSource(setup, 'function releaseAbandonedDestination(');
  assert.match(abandoned, /^function releaseAbandonedDestination\(record\) \{/u);
  assert.match(abandoned, /if \(!record\) return Promise\.resolve\(false\);/u);
  assert.match(abandoned, /if \(record\.state !== 'not-started'\) return releasePendingDestination\(record\);/u);
  assert.match(abandoned, /return releasePendingDestination\(record\)\.catch\(\(\) => false\);/u);
  for (const exit of ['async function refreshStaleReview(', 'async function goToSource(']) {
    const body = functionSource(setup, exit);
    assert.match(body, /releaseAbandonedDestination\(record\)/u);
    assert.doesNotMatch(body, /releasePendingDestination\(/u);
  }
});

test('not-started and not-observed settle together and a later read cannot reopen them', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const reconcile = functionSource(setup, 'async function reconcileLaunch(');
  assert.match(reconcile, /if \(result\.status === 'not-started' \|\| result\.status === 'not-observed'\) \{\s*settleNotStarted\(attempt\);\s*return noteNotStarted\(attempt\);/u);
  assert.equal(reconcile.match(/if \(settledNotStarted\(attempt\)\) return noteNotStarted\(attempt\);/gu)?.length, 2);
  assert.doesNotMatch(setup, /this plan is still usable/u);
  // Reads never re-assign the selection; that re-created the focused status button on every read.
  assert.doesNotMatch(reconcile, /selectedLaunch\s*=/u);
  assert.match(functionSource(setup, 'function startReviewedOperation('), /if \(attempt\.status === 'launch-pending'\) \{ attempt\.status = 'unknown';/u);
  assert.match(functionSource(setup, 'async function selectLaunch('), /status: settled \? 'not-started' : 'unknown'/u);
  const note = functionSource(setup, 'function noteNotStarted(');
  assert.match(note, /if \(!shown && attempt\.reservationRecord\?\.state === 'not-started'\) void releaseAbandonedDestination\(attempt\.reservationRecord\);/u);
});

test('launch notices belong to the selected launch and the v26.6.1 custom setup never shows them', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const invalidate = functionSource(setup, 'function invalidateIntent(');
  for (const reset of [/launchNotice = '';/u, /launchSettlement = null;/u, /launchCheckAnnouncement = '';/u, /reviewActionFailure = null;/u]) {
    assert.match(invalidate, reset);
  }
  assert.match(setup, /\$: shownLaunchNotice = stage === 'custom' \? '' :/u);
  assert.match(setup, /\{#if shownLaunchNotice\}<section class="mp-state warning" role="status" aria-live="polite">/u);
  assert.equal(functionSource(setup, 'async function adoptLaunch(').match(/if \(!currentAttempt\(attempt\) \|\| stage === 'custom'\) return;/gu)?.length, 2);
  assert.match(functionSource(setup, 'async function checkLaunchStatus('), /if \(!alive \|\| stage === 'custom' \|\| !target\) return;/u);
  assert.match(setup, /<ArchiveGuidedReview[^>]*busy=\{busy \|\| launchProtected\}/u);
});

test('the exact launch status button stays mounted while it reads', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const button = setup.match(/<button[^>]*on:click=\{checkLaunchStatus\}>Check exact launch status<\/button>/u)?.[0] || '';
  assert.match(setup, /\{#if checkableLaunch\}<button[^>]*on:click=\{checkLaunchStatus\}>/u);
  assert.match(button, /aria-busy=\{checkableLaunch\.reading \? 'true' : 'false'\}/u);
  assert.doesNotMatch(button, /\bdisabled\b/u);
  assert.doesNotMatch(setup, /\{#if [^}]*\.reading[^}]*\}/u);
  assert.match(setup, /<span class="mp-sr-only">\{launchCheckAnnouncement\}<\/span>/u);
});

test('the review reports its destination and preflight outcome next to its button', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const review = setup.slice(setup.indexOf("{:else if stage === 'review'}"), setup.indexOf("{:else if stage === 'progress'}"));
  const child = review.indexOf('<ArchiveGuidedReview');
  assert.ok(child >= 0);
  assert.ok(review.indexOf('destination-notice') > child, 'the destination notice follows the review button');
  assert.ok(review.indexOf('review-action-failure') > child, 'a failed review action follows the review button');
  assert.match(review, /<section class="mp-state error review-action-failure" bind:this=\{reviewActionRegion\} tabindex="-1" role="alert">/u);
  assert.match(review, /<ArchiveGuidedReview[^>]*error=\{reviewBannerError\}/u);
  const build = functionSource(setup, 'async function buildPreflight(');
  assert.match(build, /reviewActionFailure = caught;\s*void revealReviewActionFailure\(caught\);/u);
  // After a successful pick, a review that is still shown ends with a plan or a visible reason, never a silent reset.
  assert.match(build, /if \(reservationRecord !== record \|\| record\.state !== 'unlaunched'\) \{\s*throw new ModpackApiError\(\{ code: 'PLAN_STALE'/u);
  assert.doesNotMatch(build, /record\.state !== 'unlaunched'\) return;/u);
  const reveal = functionSource(setup, 'async function revealReviewActionFailure(');
  assert.match(reveal, /await tick\(\);/u);
  assert.match(reveal, /reviewActionRegion\.scrollIntoView\?\.\(\{ block: 'nearest' \}\);\s*reviewActionRegion\.focus\(\);/u);

  // The picker status and the chosen destination follow the native picker itself.
  const ensure = functionSource(setup, 'async function ensureTargetInstance(');
  assert.match(ensure, /selectingDestination = true;\s*reservedDestinationName = '';\s*const reservation = await modpackApi\.reserveServerDestination\(\);/u);
  assert.doesNotMatch(setup, /selectingDestination = !pendingInstanceId/u);
});

test('an Install press that did not start is reported next to the Install button, scrolled into view and focused', () => {
  const review = source('src/components/setup/ArchiveGuidedReview.svelte');
  // Every reason for a fresh review relabels the Install button, not only a not-started read from the parent.
  assert.match(review, /\$: reviewRequiresRefresh = launchNotStarted \|\| installNotStarted \|\| planStale \|\| isPlanStaleError\(error\);/u);
  assert.match(review, /on:click=\{startReviewedPlan\}>\{reviewRequiresRefresh \? 'Fresh review required' : starting \? 'Starting…' : launchUnknown \? 'Checking Start outcome…' : 'Install this exact reviewed plan'\}<\/button><\/div>/u);
  assert.match(review, /\$: installRefreshShown = Boolean\(reviewedPlan\) && !conflictReview && \(launchNotStarted \|\| planStale \|\| installNotStarted\);/u);

  // The outcome region directly follows the Install button and holds the only refresh action after a press.
  const install = review.indexOf('<button data-launch-start');
  assert.ok(install >= 0);
  const outcome = review.slice(install, review.indexOf('</section>{/if}', install));
  const refresh = outcome.indexOf('{#if installRefreshShown}<section class="mp-state warning install-action-outcome" bind:this={installActionRegion} tabindex="-1" role="alert">');
  const failed = outcome.indexOf('{:else if installError}<section class="mp-state error install-action-outcome" bind:this={installActionRegion} tabindex="-1" role="alert">');
  assert.ok(refresh > 0 && failed > refresh, 'the refresh and failure outcomes follow the Install button');
  assert.match(outcome.slice(refresh, failed), /<strong>Reviewed plan needs to be refreshed<\/strong>.*disabled=\{busy \|\| starting\} on:click=\{\(\) => dispatch\('stale'\)\}>Run a fresh preflight review<\/button>/u);
  assert.match(outcome.slice(failed), /<strong>Could not start the reviewed plan<\/strong><p>\{installError\.message\}<\/p>/u);
  // The top banner keeps only staleness the parent reports, such as a stale preflight.
  assert.match(review, /\{#if reviewRequiresRefresh\}\{#if !installRefreshShown\}<section class="mp-state warning" tabindex="-1" aria-live="assertive"><strong>Reviewed plan needs to be refreshed<\/strong>/u);
  assert.ok(review.indexOf('{#if reviewRequiresRefresh}') < review.indexOf('aria-label="Archive inspection evidence"'));

  // A Start that was not invoked stays with this review instead of being repeated by the parent at the top.
  const start = functionSource(review, 'async function startReviewedPlan(');
  assert.doesNotMatch(review, /dispatch\('error'/u);
  assert.match(start, /installNotStarted = false;\s*installError = null;/u);
  assert.match(start, /if \(result\?\.status === 'not-started'\) installNotStarted = true;/u);
  assert.match(start, /if \(isPlanStaleError\(result\.error\)\) planStale = true;\s*else installError = result\.error;/u);
  assert.match(start, /if \(revealOutcome\) await revealInstallOutcome\(owner\);\s*\}$/u);
  const reset = functionSource(review, 'function resetReviewedPlanState(');
  assert.match(reset, /installNotStarted = false;\s*installError = null;/u);

  // Only the press reveals its outcome; status re-checks and prop changes never move focus.
  const reveal = functionSource(review, 'async function revealInstallOutcome(');
  assert.match(reveal, /await tick\(\);/u);
  assert.match(reveal, /installActionRegion\.scrollIntoView\?\.\(\{ block: 'nearest' \}\);\s*installActionRegion\.focus\(\{ preventScroll: true \}\);/u);
  assert.equal(review.match(/revealInstallOutcome\(/gu)?.length, 2);
  assert.doesNotMatch(review, /\$:[^\n]*(?:revealInstallOutcome|installActionRegion)/u);
});

test('renderer modpack client uses only lifecycle IPC and symmetric event cleanup', () => {
  const api = source('src/utils/modpacks/modpackApi.js');
  for (const channel of [
    'modpacks:search-catalog', 'modpacks:list-versions', 'modpacks:list-github-releases',
    'modpacks:list-github-assets', 'modpacks:select-local-archive', 'modpacks:reserve-server-destination', 'modpacks:inspect',
    'modpacks:preflight', 'modpacks:start-operation', 'modpacks:get-job'
  ]) assert.match(api, new RegExp(channel.replace(':', '\\:')));
  assert.match(api, /removeListener/);
  assert.doesNotMatch(api, /shell|showItemInFolder|dialog\.showOpenDialog/);
});

test('setup offers empty custom and complete Modrinth GitHub and local source paths', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const sourceChoice = source('src/components/setup/ModpackSourceChoice.svelte');
  assert.match(setup, /Empty\/Custom Server/);
  assert.match(setup, /Install Modpack/);
  assert.match(setup, /SetupWizard/);
  assert.match(sourceChoice, /Modrinth/);
  assert.match(sourceChoice, /GitHub Releases/);
  assert.match(sourceChoice, /Local archive/);
  assert.match(setup, /selectLocalArchive/);
});

test('immediate source actions stay neutral while persistent asset selection remains restrained', () => {
  const sourceChoice = source('src/components/setup/ModpackSourceChoice.svelte');
  const sharedStyles = source('src/components/modpacks/modpack-ui.css');
  const releases = source('src/components/setup/GitHubReleasePicker.svelte');
  const versions = source('src/components/setup/ModrinthPackBrowser.svelte');
  const assets = source('src/components/setup/GitHubAssetReview.svelte');
  const rowSelectedRule = sharedStyles.match(/\.mp-row\.selected\s*\{[^}]+\}/u)?.[0] || '';

  assert.match(rowSelectedRule, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.09\)/u);
  assert.doesNotMatch(sourceChoice, /\.source-card\.selected|class:selected|role=["']radio["']|aria-checked/u);
  assert.doesNotMatch(rowSelectedRule, /var\(--mp-accent\)|rgba\(124,\s*131,\s*255|\bblue\b|#(?:00f|0000ff)\b/iu);
  assert.match(assets, /class:selected=\{selectedChoice === choice\}/u);
  assert.doesNotMatch(releases, /class:selected=/u);
  assert.doesNotMatch(versions, /class:selected=/u);
});

test('new-server retained-download actions consume safe result destinations and reset a recovery-blocked folder', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  assert.match(setup, /function handleOutcomeAction\(event\)/u);
  assert.match(setup, /\['selection', 'asset-selection'\]\.includes\(destination\.kind\)/u);
  assert.match(setup, /isNewServerDestinationRecoveryOutcome\(event\.detail\?\.job\?\.outcome\)/u);
  assert.match(setup, /pendingInstanceId\s*=\s*instanceId/u);
  assert.match(setup, /reservedDestinationName\s*=\s*''/u);
  assert.match(setup, /<ModpackJobProgress[^>]*on:action=\{handleOutcomeAction\}/u);
  assert.match(source('src/components/modpacks/ModpackJobProgress.svelte'), /dispatch\('action',\s*\{\s*actionId,\s*value,\s*job,\s*selectionContext:\s*context\s*\}\)/u);
});

test('Modrinth browser preserves filters paging history and recovery actions', () => {
  const browser = source('src/components/setup/ModrinthPackBrowser.svelte');
  for (const contract of [
    /query/, /categories/, /gameVersion/, /loader/, /channel/, /serverCompatibility/,
    /sort/, /offset/, /loading/, /offline/, /rate limit/i, /Retry/, /Import local archive/,
    /Empty\/Custom Server/, /description/, /runtimes/, /gallery/, /version history/i
  ]) assert.match(browser, contract);
});

test('GitHub flow defaults stable and requires explicit reviewed asset selection', () => {
  const releases = source('src/components/setup/GitHubReleasePicker.svelte');
  const assets = source('src/components/setup/GitHubAssetReview.svelte');
  assert.match(releases, /repositoryUrl/);
  assert.match(releases, /includePrereleases\s*=\s*false/);
  assert.match(releases, /RATE_LIMITED/);
  assert.match(releases, /explicit/i);
  assert.match(releases, /approve/i);
  for (const contract of [
    /uploaded asset/i, /provisional/i, /size/i, /timestamp/i, /digest/i,
    /Use this asset pattern for future releases/, /NO_INSTALLABLE_ASSET/,
    /Import local archive/, /Empty\/Custom Server/, /ambigu/i
  ]) assert.match(assets, contract);
  assert.match(assets, /choice\.parts/);
  assert.match(assets, /providerAssetId/);
  assert.match(assets, /assetIds:\s*selectedAssetIds/);
  assert.match(assets, /rememberPattern/);
  assert.match(source('src/components/setup/ServerSetupWizard.svelte'), /rememberAssetPattern/);
  assert.match(source('src/routes/ModpackPage.svelte'), /rememberAssetPattern/);
});

test('managed GitHub suggestions preselect one reviewed choice without auto-continuing or leaking setup context', () => {
  const releases = source('src/components/setup/GitHubReleasePicker.svelte');
  const assets = source('src/components/setup/GitHubAssetReview.svelte');
  const management = source('src/routes/ModpackPage.svelte');
  const setup = source('src/components/setup/ServerSetupWizard.svelte');

  assert.match(releases, /export let serverId\s*=\s*['"]/);
  assert.match(releases, /serverId\s*\?\s*\{\s*serverId\s*\}\s*:\s*\{\s*\}/);
  assert.match(assets, /suggestedAssetIds/);
  assert.match(assets, /matchingChoices\.length\s*===\s*1/);
  assert.match(assets, /on:click=\{continueWithAsset\}/);
  assert.doesNotMatch(assets, /\$:[^\n]*continueWithAsset\s*\(/);
  assert.match(management, /<GitHubReleasePicker[^>]*\{serverId\}/s);
  assert.doesNotMatch(setup, /<GitHubReleasePicker[^>]*\{serverId\}/s);
});

test('a Modrinth-linked GitHub source requires explicit approval and carries only its project ID', () => {
  const browser = source('src/components/setup/ModrinthPackBrowser.svelte');
  const releases = source('src/components/setup/GitHubReleasePicker.svelte');
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  assert.match(browser, /upstreamLinkCandidates/);
  assert.match(browser, /linked GitHub/i);
  assert.match(releases, /linkedRepositoryApproved/);
  assert.match(setup, /linkedModrinthProjectId/);
  assert.doesNotMatch(setup, /acceptedMapping\s*:/);
});

test('guided review exposes evidence changes preservation choices and hard blockers', () => {
  const review = source('src/components/setup/ArchiveGuidedReview.svelte');
  for (const contract of [
    /integrity/i, /archive tree/i, /root/i, /classification/i, /runtime/i, /Java/,
    /ownership/i, /conflict/i, /files added/i, /files removed/i, /preserv/i,
    /EULA/, /missing digest/i, /downgrade/i, /start after install/i,
    /files-only/i, /unresolved/i
  ]) assert.match(review, contract);
  assert.match(review, /selectedRoot/);
  assert.match(review, /runtimeChoice/);
  assert.match(review, /minecraftVersion/);
  assert.match(review, /loaderFamily/);
  assert.match(review, /loaderVersion/);
  assert.match(review, /classification\?\.optionalFiles/);
  assert.match(review, /defaultSelected/);
  assert.match(review, /requiresConflictReview/);
  assert.match(review, /allowedChoices/);
  assert.match(review, /alternateOptions/);
  assert.match(review, /alternateId/);
  for (const choice of ['keep-mine', 'use-pack', 'keep-both', 'disable-addon', 'remove-addon']) {
    assert.match(review, new RegExp(choice));
  }
  assert.match(review, /runtimeMinecraftVersion/);
  assert.match(review, /runtimeLoaderFamily/);
  assert.match(review, /runtimeLoaderVersion/);
  assert.doesNotMatch(review, /candidate\?\.label/);
  assert.doesNotMatch(review, /runtimeChoice\s*=\s*\{[^}]*javaMajor/s);
  assert.doesNotMatch(review, /runtimeChoice\s*=\s*\{[^}]*\bos\s*:/s);
  assert.doesNotMatch(review, /runtimeChoice\s*=\s*\{[^}]*architecture/s);
  assert.match(source('src/routes/ModpackPage.svelte'), /requiresConflictReview\s*===\s*true\s*\?\s*['"]inspection['"]\s*:\s*['"]review['"]/);
});

test('new-server review binds an editable bounded RAM allocation and displays it in the sealed plan', () => {
  const review = source('src/components/setup/ArchiveGuidedReview.svelte');
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const app = source('src/App.svelte');

  assert.match(review, /export let defaultMaxRam\s*=\s*4/u);
  assert.match(review, /let maxRam\s*=\s*normalizedDefaultMaxRam\(defaultMaxRam\)/u);
  assert.match(review, /maxRam\s*=\s*normalizedDefaultMaxRam\(defaultMaxRam\)/u);
  assert.match(review, /type=["']number["'][^>]*bind:value=\{maxRam\}/u);
  assert.match(review, /min=["']1["']/u);
  assert.match(review, /max=["']64["']/u);
  assert.match(review, /maxRam:\s*needsNewServerResources\s*&&\s*validMaxRam\s*\?\s*Number\(maxRam\)\s*:\s*null/u);
  assert.match(review, /maxRam:\s*null/u);
  assert.match(review, /plan\.resources\?\.maxRam/u);
  assert.match(setup, /export let defaultMaxRam\s*=\s*4/u);
  assert.match(setup, /maxRam:\s*requestedKind\s*===\s*['"]import-files-only-new['"]\s*\?\s*null\s*:\s*normalizedDefaultMaxRam\(defaultMaxRam\)/u);
  assert.match(setup, /<ArchiveGuidedReview[^>]*\{defaultMaxRam\}/su);
  assert.match(app, /defaultMaxRam=\{\$serverState\.maxRam\}/u);
});

test('new-server review seals the Minecraft port and network binding selected in the rendered flow', () => {
  const review = source('src/components/setup/ArchiveGuidedReview.svelte');
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const app = source('src/App.svelte');

  assert.match(review, /export let defaultServerPort\s*=\s*25565/u);
  assert.match(review, /let serverPort\s*=\s*normalizedServerPort\(defaultServerPort\)/u);
  assert.match(review, /let networkAccess\s*=\s*['"]pack-default['"]/u);
  assert.match(review, /bind:value=\{serverPort\}/u);
  assert.match(review, /type=["']number["'][^>]*min=["']1025["'][^>]*max=["']65535["'][^>]*bind:value=\{serverPort\}/u);
  assert.match(review, /Number\.isSafeInteger\(parsed\)\s*&&\s*parsed\s*>=\s*1025\s*&&\s*parsed\s*<=\s*65535/u);
  assert.match(review, /min=["']1["']/u);
  assert.match(review, /max=["']65535["']/u);
  assert.match(review, /bind:value=\{networkAccess\}/u);
  assert.match(review, /value=["']pack-default["']/u);
  assert.match(review, /value=["']loopback["']/u);
  assert.match(review, /serverPort:\s*needsNewServerResources\s*&&\s*validServerPort\s*\?\s*Number\(serverPort\)\s*:\s*null/u);
  assert.match(review, /networkAccess:\s*needsNewServerResources\s*\?\s*networkAccess\s*:\s*null/u);
  assert.match(review, /plan\.resources\?\.serverPort/u);
  assert.match(review, /plan\.resources\?\.networkAccess/u);
  assert.match(setup, /export let defaultServerPort\s*=\s*25565/u);
  assert.match(setup, /serverPort:\s*requestedKind\s*===\s*['"]import-files-only-new['"]\s*\?\s*null\s*:\s*normalizedServerPort\(defaultServerPort\)/u);
  assert.match(setup, /networkAccess:\s*requestedKind\s*===\s*['"]import-files-only-new['"]\s*\?\s*null\s*:\s*['"]pack-default['"]/u);
  assert.match(setup, /<ArchiveGuidedReview[^>]*\{defaultServerPort\}/su);
  assert.match(app, /defaultServerPort=\{25565\}/u);
  assert.doesNotMatch(app, /defaultServerPort=\{\$serverState\.port\}/u);
  assert.match(review, /persisted[^<]*normal server starts[^<]*final running validation/iu);
  assert.match(review, /stopped-after-install[^<]*separate private test port/iu);
  assert.doesNotMatch(review, /exact port for installation health checks/iu);
});

test('guided review asks for a nested root only when classification found multiple runtime roots', () => {
  const review = source('src/components/setup/ArchiveGuidedReview.svelte');
  assert.match(review, /classification\?\.confidence\s*===\s*['"]multiple-roots['"]/);
  assert.doesNotMatch(review, /rootChoiceRequired\s*=\s*!inspection\?\.selectedRoot\s*&&\s*rootCandidates\.length\s*>\s*1\s*;/);
});

test('guided review explains known client-only and unsupported archive blockers instead of calling them ambiguous', () => {
  const review = source('src/components/setup/ArchiveGuidedReview.svelte');
  assert.match(review, /multimc-client-only/);
  assert.match(review, /mrpack-client-only/);
  assert.match(review, /client launcher archive/i);
  assert.match(review, /unsupported-runtime-layout/);
  assert.match(review, /Choose the uploaded server pack/i);
});

test('new modpack setup reserves an opaque destination and never selects or persists a renderer path', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  assert.match(setup, /modpackApi\.reserveServerDestination\(\)/);
  assert.match(setup, /operationKind:\s*requestedKind\s*\|\|\s*['"]install-new['"]/);
  assert.match(setup, /operationKind=['"]install-new['"]/);
  assert.doesNotMatch(setup, /invoke\(['"]select-folder['"]/);
  assert.doesNotMatch(setup, /invoke\(['"]save-instances['"]/);
  assert.doesNotMatch(setup, /selectedTarget/);
  assert.doesNotMatch(setup, /dispatch\(['"]setup-complete['"],\s*\{[^}]*\bpath\s*:/s);
});

test('setup submits plan ID and fingerprint, never a server or archive path', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const review = source('src/components/setup/ArchiveGuidedReview.svelte');
  const combined = `${setup}\n${review}`;
  assert.match(combined, /planId/);
  assert.match(combined, /planFingerprint/);
  assert.match(combined, /startOperation\(\{[\s\S]*planId[\s\S]*planFingerprint[\s\S]*choices/);
  assert.doesNotMatch(combined, /archivePath\s*:/);
  assert.doesNotMatch(combined, /serverPath\s*:/);
});

test('an expired setup plan is disabled and routes through a fresh exact-source review', () => {
  const review = source('src/components/setup/ArchiveGuidedReview.svelte');
  const setup = source('src/components/setup/ServerSetupWizard.svelte');

  assert.match(review, /isPlanStaleError/);
  assert.match(review, /!planStale/);
  assert.match(review, /Run a fresh preflight review/i);
  assert.match(review, /dispatch\(['"]stale['"]\)/);
  assert.match(setup, /async function refreshStaleReview/);
  assert.match(setup, /requestedSelection\?\.provider\s*===\s*['"]local['"]/);
  assert.match(setup, /Select the local archive again/i);
  assert.match(setup, /stage\s*=\s*['"]source['"];[\s\S]*inspectSelection\(requestedSelection, requestedLabel/);
  assert.match(setup, /inspectSelection\(requestedSelection, requestedLabel/);
  assert.match(setup, /on:stale=\{refreshStaleReview\}/);

  const refreshBody = setup.match(/async function refreshStaleReview\(\)\s*\{[\s\S]*?\n\s*\}/u)?.[0] || '';
  assert.doesNotMatch(refreshBody, /startOperation|\.preflight\(/);
  assert.match(review, /hasCurrentInspection/);
});
