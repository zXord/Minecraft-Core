const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

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
  assert.match(source('src/components/modpacks/ModpackJobProgress.svelte'), /dispatch\('action',\s*\{\s*actionId,\s*value,\s*job\s*\}\)/u);
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
