const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const source = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

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

test('App exposes a top-level Modpack tab beside Mods and lazy-loads its route', () => {
  const app = source('src/App.svelte');
  assert.match(app, /"mods",\s*"modpack"/);
  assert.match(app, /ModpackPage\.svelte/);
  assert.match(app, /🧰 Modpack|📦 Modpack|Modpack/);
});

test('management page supports unmanaged managed history and recovery states', () => {
  const page = source('src/routes/ModpackPage.svelte');
  for (const contract of [
    /getState/, /listHistory/, /listRecovery/, /ModpackOverview/, /ModpackActionPanel/,
    /beginSource/, /import-files-only-new/, /history/i, /recovery/i
  ]) assert.match(page, contract);
});

test('verify is available without immediately scheduling repair', () => {
  const panel = source('src/components/modpacks/ModpackActionPanel.svelte');
  assert.match(panel, />\s*Verify\s*</);
  assert.match(panel, /verifyModpack|dispatch\(['"]verify/);
  assert.match(panel, />\s*Review repair\s*</);
  assert.doesNotMatch(panel, /function\s+verify[\s\S]{0,300}operationKind:\s*['"]repair/);
});

test('repair keeps its operation kind while the user reselects and reviews the installed source', () => {
  const page = source('src/routes/ModpackPage.svelte');
  assert.match(page, /on:repair=\{\(\) => beginSource\(['"]repair['"]\)\}/);
  assert.doesNotMatch(page, /on:repair=\{\(\) => beginManagedOperation\(['"]repair['"]\)\}/);
  assert.match(page, /async function buildPreflight\(event, kind = operationKind\)/);
  assert.match(page, /if \(event\.detail\.operationKind && operationKind !== ['"]repair['"]\)/);
  assert.match(page, /on:select=\{\(event\) => inspectSelection\(event\.detail\.request, operationKind\)\}/);
  assert.match(page, /const requestedOperationKind = operationKind/);
  assert.match(page, /inspectSelection\(\{ provider: ['"]local['"], selectionId: selection\.selectionId \}, requestedOperationKind, false, true\)/);
  assert.match(page, /const classifyManagedRuntime = Boolean\(currentGithubReleaseId\) && operationKind !== ['"]repair['"]/);
  assert.match(page, /classifyManagedRuntime \? managedGithubChronologicalOperation : operationKind, classifyManagedRuntime\);/);
  assert.match(source('src/components/setup/ArchiveGuidedReview.svelte'), /canFilesOnly\s*=\s*operationKind\s*!==\s*['"]repair['"]/);
});

test('managed archive preflight streams its correlated planning progress into the guided review', () => {
  const page = source('src/routes/ModpackPage.svelte');

  assert.match(page, /let preflightProgress = null;/);
  assert.match(page, /let selectingDestination = false;/);
  assert.match(page, /preflightProgress = \{ phase: ['"]validating-destination['"], percent: 0 \};/);
  assert.match(page, /modpackApi\.preflight\([\s\S]*?\},\s*progress => \{[\s\S]*?if \(!currentServerRequest\(requestToken\)\) return;[\s\S]*?preflightProgress = progress;[\s\S]*?\}\);/);
  assert.match(page, /<ArchiveGuidedReview\s+[\s\S]*?\{preflightProgress\}[\s\S]*?\{selectingDestination\}/);
});

test('management preflight shows correlated semantic progress before a durable job exists', () => {
  const page = source('src/routes/ModpackPage.svelte');
  const progress = source('src/components/modpacks/ModpackPlanningProgress.svelte');

  assert.match(page, /preflightProgress = \{ phase: ['"]scanning-server['"] \};/);
  assert.match(page, /modpackApi\.preflightManagement\([\s\S]*?progress => \{[\s\S]*?if \(!currentServerRequest\(requestToken\)\) return;[\s\S]*?preflightProgress = progress;/);
  assert.match(page, /busy && preflightProgress && flow !== ['"]inspection['"]/);
  assert.match(page, /<ModpackPlanningProgress progress=\{preflightProgress\}/);
  assert.match(page, /class:selected=\{selectedRestorePointId === item\.restorePointId\}/);
  assert.match(page, /Verifying selection/);
  assert.match(progress, /role="status"/);
  assert.match(progress, /aria-label="Modpack preflight progress"/);
  assert.match(progress, /Scanning current server files/);
  assert.match(progress, /Verifying the selected restore point/);
  assert.match(progress, /processedBytes/);
  assert.match(progress, /totalBytes/);
  assert.match(progress, /Large servers can take a few minutes/);
});

test('version management supports exact updates downgrades switches and rollback', () => {
  const panel = source('src/components/modpacks/ModpackVersionPanel.svelte');
  for (const contract of [
    /Update/, /exact version/i, /Downgrade/i, /Switch/, /restore point/i, /prerelease/i
  ]) assert.match(panel, contract);
  assert.match(panel, /state\?\.source\?\.versionId/);
  assert.match(panel, /version\.versionId\s*===\s*currentVersionId/);
  assert.doesNotMatch(panel, /state\?\.installedAt/);
});

test('managed GitHub versions reuse trusted repository identity and never guess release order', () => {
  const panel = source('src/components/modpacks/ModpackVersionPanel.svelte');
  const picker = source('src/components/setup/GitHubReleasePicker.svelte');
  const page = source('src/routes/ModpackPage.svelte');
  assert.match(panel, /state\?\.source\?\.githubOwner/);
  assert.match(panel, /state\?\.source\?\.githubRepo/);
  assert.match(panel, /state\?\.source\?\.releaseId/);
  assert.match(panel, /dispatch\(['"]github/);
  assert.match(page, /currentGithubReleaseId/);
  assert.match(page, /on:github/);
  assert.match(picker, /currentReleaseId/);
  assert.match(picker, /installedRelease/);
  assert.match(picker, /selectedPublished\s*<\s*currentPublished\s*\?\s*['"]downgrade['"]\s*:\s*['"]update['"]/);
  assert.match(picker, /could not prove whether this exact release is newer or older/i);
  assert.match(picker, /release\.releaseId\s*===\s*currentReleaseId/);
});

test('progress names every durable phase and only permits pre-commit cancellation', () => {
  const progress = source('src/components/modpacks/ModpackJobProgress.svelte');
  for (const stage of [
    'Resolving', 'Downloading', 'Verifying', 'Inspecting', 'Planning', 'Creating restore point',
    'Extracting', 'Reconciling files', 'Configuring runtime and Java',
    'Validating candidate on loopback', 'Committing directory swap', 'Starting from final path',
    'Validating final health', 'Cleaning rollback staging', 'Completed', 'Rolling back'
  ]) assert.match(progress, new RegExp(stage, 'i'));
  assert.match(progress, /canCancel/);
  assert.match(progress, /getJob/);
});

test('outcome actions are opaque and render all required durable outcomes', () => {
  const progress = source('src/components/modpacks/ModpackJobProgress.svelte');
  for (const copy of [
    'Failed', 'Cancelled', 'Downloaded file retained for manual use',
    'Update failed; server restored successfully', 'Verified recovery is ready',
    'Manual recovery required', 'Retry', 'Change selection', 'Open details', 'Open folder',
    'Remove download', 'Choose another asset', 'Return to server', 'Review restore point',
    'Recover now', 'Review recovery', 'Restore from restore point'
  ]) assert.match(progress, new RegExp(copy, 'i'));
  assert.match(progress, /opaqueRef/);
  assert.match(progress, /hasAction/);
  assert.match(progress, /actionIssuanceFailed/);
  assert.doesNotMatch(progress, /path\s*:/);
  assert.ok(
    progress.indexOf('job?.outcome?.retainedDownload') < progress.indexOf("phase === 'cancelled' || phase === 'failed'"),
    'retained downloads must be classified before the generic failed/cancelled outcome'
  );
});

test('outcome action results consume the production destination DTO instead of a mock route', () => {
  const page = source('src/routes/ModpackPage.svelte');
  assert.match(page, /value\?\.destination/);
  for (const kind of ['selection', 'asset-selection', 'details', 'server', 'restore-point', 'recovery']) {
    assert.match(page, new RegExp(`['"]${kind}['"]`));
  }
  assert.doesNotMatch(page, /value\?\.route/);
});

test('detach and uninstall review state exact preservation guarantees', () => {
  const review = source('src/components/modpacks/ModpackPlanReview.svelte');
  for (const copy of [
    'Detach and keep all files', 'Remove managed pack files', 'zero files are removed',
    'management and notifications stop', 'unchanged managed', 'worlds', 'modified files',
    'non-runnable files-only instance', 'neither the instance nor its world is deleted'
  ]) assert.match(review, new RegExp(copy, 'i'));
});

test('management uninstall uses the management planning operation name', () => {
  const page = source('src/routes/ModpackPage.svelte');
  assert.match(page, /on:uninstall=\{\(\) => beginManagedOperation\(['"]uninstall['"]\)\}/);
  assert.doesNotMatch(page, /beginManagedOperation\(['"]uninstall-managed['"]\)/);
});

test('managed Settings routes version work to the Modpack page', () => {
  const settings = source('src/routes/SettingsPage.svelte');
  const updater = source('src/components/settings/VersionUpdater.svelte');
  assert.match(settings + updater, /Modpack/);
  assert.match(updater, /navigate\(['"]\/modpack['"]\)/);
});

test('persistent notification actions route the exact server to the matching review section', () => {
  const app = source('src/App.svelte');
  const center = source('src/components/modpacks/ModpackNotificationCenter.svelte');
  const page = source('src/routes/ModpackPage.svelte');
  assert.match(center, /notificationType:\s*item\.type/);
  assert.match(app, /modpackNavigationTarget/);
  assert.match(app, /navigationTarget=\{modpackNavigationTarget\}/);
  assert.match(page, /export let navigationTarget/);
  assert.match(page, /update-available/);
  assert.match(page, /github-asset-selection-required/);
  assert.match(page, /recovery-required/);
  assert.doesNotMatch(center, /install(?:Pack|Version|Modpack)\s*\(/);
});

test('managed modpack page exposes a rendered manual release check with visible progress', () => {
  const page = source('src/routes/ModpackPage.svelte');
  assert.match(page, /async function checkForModpackUpdates\(\)/u);
  assert.match(page, /modpackApi\.checkUpdates\(null,\s*true\)/u);
  assert.match(page, /checkingForUpdates/u);
  assert.match(page, /Check for updates/u);
  assert.match(page, /role=["']status["'][^>]*aria-label=["']Release check status["']/u);
  assert.match(page, /Checking for updates/u);
  assert.match(page, /aria-live=["']polite["']/u);
});

test('release notifications preserve the exact provider target through navigation and never substitute latest', () => {
  const center = source('src/components/modpacks/ModpackNotificationCenter.svelte');
  const page = source('src/routes/ModpackPage.svelte');
  const versions = source('src/components/modpacks/ModpackVersionPanel.svelte');
  const github = source('src/components/setup/GitHubReleasePicker.svelte');

  assert.match(center, /destination\?\.releaseTarget\?\.serverId/);
  assert.match(page, /destination\.releaseTarget/);
  assert.match(page, /releaseTarget\.sourceId/);
  assert.match(page, /requestedModrinthVersionId/);
  assert.match(page, /requestedGithubReleaseId/);
  assert.match(page, /source\.repositoryId/);
  assert.match(page, /source\?\.projectId/);
  assert.match(versions, /requestedVersionId/);
  assert.match(versions, /data-notification-target/);
  assert.doesNotMatch(versions, /aria-current=\{notificationTarget/);
  const notificationTargetRule = versions.match(/\.notification-target\s*\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(notificationTargetRule, /124\s*,\s*131\s*,\s*255|#7c83ff/i);
  assert.match(github, /requestedReleaseId/);
  assert.match(github, /loadRequestedRelease/);
  assert.match(github, /release\.releaseId\s*===\s*requestedReleaseId/);
  assert.match(github, /loadUploadedAssets|listGithubAssets/);
  assert.doesNotMatch(page + versions + github, /requested(?:Release|Version)Id\s*=\s*['"]latest['"]/iu);
});

test('modpack notification controls stay out of global server and client headers', () => {
  const app = source('src/App.svelte');
  const clientHeader = source('src/components/client/ClientHeader.svelte');
  const clientInterface = source('src/components/client/ClientInterface.svelte');
  const page = source('src/routes/ModpackPage.svelte');

  assert.doesNotMatch(app, /import\s+ModpackNotificationCenter/);
  assert.doesNotMatch(clientHeader, /ModpackNotificationCenter|Modpack notifications/);
  assert.doesNotMatch(clientInterface, /onModpackNotificationNavigate/);
  assert.match(page, /<ModpackNotificationCenter[\s\S]*variant=["']contextual["']/);
});

test('a reviewed operation that did not start is explained after its Start button, scrolled into view and focused', () => {
  const review = source('src/components/modpacks/ModpackPlanReview.svelte');
  const start = review.indexOf('<div class="mp-actions"><button class="mp-button {isUninstall');
  assert.ok(start >= 0);
  const stale = review.indexOf('{#if planStale}<div class="mp-state warning" bind:this={actionRegion} tabindex="-1" role="alert"><strong>Reviewed plan needs a fresh preflight</strong>');
  const failed = review.indexOf('{:else if error}<div class="mp-state error" bind:this={actionRegion} tabindex="-1" role="alert"><strong>Could not start the reviewed plan</strong><p>{error.message}</p>');
  assert.ok(stale > start && failed > stale, 'the stale and failed Start outcomes follow the Start button');
  assert.ok(review.indexOf('</section>', start) > failed, 'the outcomes stay inside the review');
  assert.equal(review.match(/Run a fresh preflight review/gu)?.length, 1);
  // The unknown-outcome status keeps its place with the plan details.
  assert.ok(review.indexOf('Start outcome is unknown') < review.indexOf('aria-label="Planned file diff"'));

  // Only a Start press reveals what it produced; the reveal waits for the region to render.
  const run = functionSource(review, 'async function run(');
  assert.match(run, /if \(isPlanStaleError\(result\.error\)\) planStale = true;\s*else error = result\.error;\s*revealOutcome = true;/u);
  assert.match(run, /if \(revealOutcome\) await revealActionOutcome\(owner\);\s*\}$/u);
  const reveal = functionSource(review, 'async function revealActionOutcome(');
  assert.match(reveal, /await tick\(\);/u);
  assert.match(reveal, /actionRegion\.scrollIntoView\?\.\(\{ block: 'nearest' \}\);\s*actionRegion\.focus\(\{ preventScroll: true \}\);/u);
  assert.equal(review.match(/revealActionOutcome\(/gu)?.length, 2);
});

test('an expired management plan cannot execute again and preserves its exact action for re-preflight', () => {
  const review = source('src/components/modpacks/ModpackPlanReview.svelte');
  const page = source('src/routes/ModpackPage.svelte');

  assert.match(review, /isPlanStaleError/);
  assert.match(review, /!planStale/);
  assert.match(review, /Run a fresh preflight review/i);
  assert.match(review, /dispatch\(['"]stale['"]\)/);
  assert.match(review, /hasReviewedPlan/);
  assert.match(page, /async function refreshStaleReview/);
  assert.match(page, /isPlanStaleError/);
  assert.match(page, /Run the action again to generate and review a fresh plan/i);
  assert.match(page, /buildManagementPlan\(operationKind, selectedRestorePointId\)/);
  assert.match(page, /activeSection\s*=\s*['"]actions['"]/);
  assert.match(page, /flow\s*=\s*['"]source['"];[\s\S]*inspectSelection\(requestedSelection, requestedOperationKind/);
  assert.match(page, /requestedSelection\?\.provider\s*===\s*['"]local['"]/);
  assert.match(page, /inspectSelection\(requestedSelection, requestedOperationKind/);
  assert.match(page, /on:stale=\{refreshStaleReview\}/);
});

test('a management review shows the backend reason for a stale review and generic retry guidance otherwise', () => {
  const page = source('src/routes/ModpackPage.svelte');
  const build = functionSource(page, 'async function buildManagementPlan(');

  assert.match(page, /import \{[^}]*\bplanStaleReason\b[^}]*\} from '\.\.\/utils\/modpacks\/modpackApi\.js';/u);
  assert.match(build, /error = isPlanStaleError\(caught\) && !planStaleReason\(caught\)\s*\?\s*new ModpackApiError\(\{/u);
  assert.match(build, /Run the action again to generate and review a fresh plan/u);
  assert.match(build, /:\s*caught;/u);
});
