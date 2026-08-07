const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const source = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

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
  assert.match(panel, />\s*Repair\s*</);
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
  assert.match(page, /inspectSelection\(\{ provider: ['"]local['"], selectionId: selection\.selectionId \}, requestedOperationKind\)/);
  assert.match(page, /return inspectSelection\(\{[\s\S]*rememberAssetPattern[\s\S]*\}, operationKind\);/);
  assert.match(source('src/components/setup/ArchiveGuidedReview.svelte'), /canFilesOnly\s*=\s*operationKind\s*!==\s*['"]repair['"]/);
});

test('version management supports exact updates downgrades switches and rollback', () => {
  const panel = source('src/components/modpacks/ModpackVersionPanel.svelte');
  for (const contract of [
    /Update/, /exact version/i, /Downgrade/, /Switch/, /restore point/i, /prerelease/i
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
    'Nothing changed', 'Downloaded file retained for manual use',
    'Update failed; server restored successfully', 'Automatic recovery required on next launch',
    'Manual recovery required', 'Retry', 'Change selection', 'Open details', 'Open folder',
    'Remove download', 'Choose another asset', 'Return to server', 'Review restore point',
    'Restart and recover', 'Review recovery', 'Restore from restore point'
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
