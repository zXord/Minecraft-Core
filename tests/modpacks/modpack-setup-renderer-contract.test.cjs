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
