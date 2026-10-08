const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

const {
  REAL_GITHUB_RELEASES_ENV,
  REAL_GITHUB_RELEASE_MONITOR,
  REAL_GITHUB_SERVER_PACK,
  assertExactReleaseChronology,
  assertPinnedInstalledVersion,
  assertPinnedReleaseArchiveEvidence,
  assertUnmanagedSentinel,
  auditCompletedLifecycle,
  createIsolatedRealLifecycle,
  createIsolatedRealReleaseMonitor,
  finalizeRealLifecycle,
  isRealGitHubReleaseMonitorEnabled,
  isRealGitHubReleasesEnabled,
  reviewExactGitHubArchive,
  requiresMissingProviderDigestAcknowledgement,
  selectKnownRelease,
  selectKnownOlderRelease,
  selectKnownOlderServerAsset,
  selectKnownServerAsset
} = require('./real-github-releases-harness.cjs');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fakeModpackPage(handler) {
  return {
    async evaluate(_callback, payload) {
      try {
        return { ok: true, value: await handler(payload.channel, payload.request) };
      } catch (error) {
        return {
          ok: false,
          error: { code: error?.code || 'TEST_FAILURE', message: error?.message || 'Test failure' }
        };
      }
    }
  };
}

test('real GitHub Releases E2E stays opt-in', () => {
  assert.equal(isRealGitHubReleasesEnabled({}), false);
  assert.equal(isRealGitHubReleasesEnabled({ [REAL_GITHUB_RELEASES_ENV]: 'true' }), true);
  assert.equal(isRealGitHubReleasesEnabled({ [REAL_GITHUB_RELEASES_ENV]: '0' }), false);
  assert.equal(isRealGitHubReleaseMonitorEnabled({}), false);
  assert.equal(isRealGitHubReleaseMonitorEnabled({ MINECRAFT_CORE_REAL_GITHUB_RELEASE_MONITOR_E2E: '1' }), true);
});

test('real GitHub lifecycle selects only the pinned repository, release IDs, tags, and names', () => {
  const olderRelease = {
    repositoryId: '451038871', releaseId: '272697650', tagName: '1.7.6', name: '1.7.6',
    draft: false, prerelease: false, publishedAt: '2025-12-01T00:00:00.000Z'
  };
  const newerRelease = {
    repositoryId: '451038871', releaseId: '274141765', tagName: '1.7.7', name: '1.7.7',
    draft: false, prerelease: false, publishedAt: '2025-12-02T00:00:00.000Z'
  };

  const release = selectKnownRelease([
    olderRelease,
    newerRelease
  ]);
  assert.deepEqual(release, newerRelease);
  assert.deepEqual(selectKnownOlderRelease([newerRelease, olderRelease]), olderRelease);

  for (const mutation of [
    { ...newerRelease, repositoryId: '451038872' },
    { ...newerRelease, releaseId: '274141766' },
    { ...newerRelease, tagName: '1.7.7-source' },
    { ...newerRelease, name: 'Nomi CEu 1.7.7' },
    { ...newerRelease, draft: true },
    { ...newerRelease, prerelease: true }
  ]) assert.equal(selectKnownRelease([mutation]), null);

  for (const mutation of [
    { ...olderRelease, repositoryId: '451038872' },
    { ...olderRelease, releaseId: '272697651' },
    { ...olderRelease, tagName: '1.7.6-source' },
    { ...olderRelease, name: 'Nomi CEu 1.7.6' },
    { ...olderRelease, draft: true },
    { ...olderRelease, prerelease: true }
  ]) assert.equal(selectKnownOlderRelease([mutation]), null);

  assert.doesNotThrow(() => assertExactReleaseChronology(olderRelease, newerRelease));
  assert.throws(() => assertExactReleaseChronology(newerRelease, olderRelease), /chronology/iu);
  assert.throws(() => assertExactReleaseChronology(olderRelease, { ...newerRelease, publishedAt: 'invalid' }), /chronology/iu);
});

test('real GitHub lifecycle sentinel and terminal audit reject byte drift, active recovery, siblings, and Java', async () => {
  const lifecycle = await createIsolatedRealLifecycle();
  try {
    const sentinelPath = require('node:path').join(lifecycle.serverPath, 'world', 'minecraft-core-real-github.keep');
    fs.mkdirSync(require('node:path').dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, 'unmanaged GitHub lifecycle data must survive\n');
    assert.doesNotThrow(() => assertUnmanagedSentinel(lifecycle));
    const clean = await auditCompletedLifecycle(lifecycle, { processes: [] });
    assert.deepEqual(clean.activeRecoveryEntries, []);
    assert.deepEqual(clean.workspaceEntries, []);
    assert.deepEqual(clean.orphanSiblingEntries, []);
    assert.deepEqual(clean.javaProcesses, []);

    fs.writeFileSync(sentinelPath, 'changed');
    assert.throws(() => assertUnmanagedSentinel(lifecycle), /sentinel/iu);
    fs.writeFileSync(sentinelPath, 'unmanaged GitHub lifecycle data must survive\n');
    fs.mkdirSync(require('node:path').join(lifecycle.userDataPath, 'modpack-lifecycle', 'active', 'job-active'), { recursive: true });
    await assert.rejects(auditCompletedLifecycle(lifecycle, { processes: [] }), /active recovery/iu);
    fs.rmSync(require('node:path').join(lifecycle.userDataPath, 'modpack-lifecycle', 'active'), { recursive: true, force: true });
    fs.mkdirSync(require('node:path').join(lifecycle.userDataPath, 'modpack-lifecycle', 'workspaces', 'job-workspace'), { recursive: true });
    await assert.rejects(auditCompletedLifecycle(lifecycle, { processes: [] }), /active workspace/iu);
    fs.rmSync(require('node:path').join(lifecycle.userDataPath, 'modpack-lifecycle', 'workspaces'), { recursive: true, force: true });
    const orphan = require('node:path').join(lifecycle.root, '.server.minecraft-core.job-test.candidate');
    fs.mkdirSync(orphan);
    await assert.rejects(auditCompletedLifecycle(lifecycle, { processes: [] }), /orphan transaction sibling/iu);
    fs.rmSync(orphan, { recursive: true, force: true });
    const compactOrphan = require('node:path').join(lifecycle.root, `.op2-${'a'.repeat(32)}.c`);
    fs.mkdirSync(compactOrphan);
    await assert.rejects(auditCompletedLifecycle(lifecycle, { processes: [] }), /orphan transaction sibling/iu);
    fs.rmSync(compactOrphan, { recursive: true, force: true });
    await assert.rejects(auditCompletedLifecycle(lifecycle, {
      processes: [{ name: 'java.exe', processId: 42, commandLine: `java -jar ${lifecycle.serverPath}` }]
    }), /Java process/iu);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('real lifecycle finalization performs the root-bound audit with the exact Electron and lifecycle before cleanup', async () => {
  const calls = [];
  const electronApp = { marker: 'github-electron' };
  const lifecycle = { root: 'C:\\Temp\\minecraft-core-real-github-releases-e2e-exact' };
  await finalizeRealLifecycle({
    completed: true,
    electronApp,
    lifecycle,
    async closeAndAudit(receivedElectron, receivedLifecycle) {
      calls.push(['close-and-audit', receivedElectron, receivedLifecycle]);
    },
    async collectEvidence() { calls.push('evidence'); return { ok: true }; },
    async attachEvidence(evidence) { calls.push(['attach', evidence]); },
    async dispose(options) { calls.push(['dispose', options]); }
  });
  assert.deepEqual(calls, [
    ['close-and-audit', electronApp, lifecycle],
    ['dispose', { preserveRoot: false }]
  ]);
});

test('real GitHub finalization attaches failed-run evidence before deleting a quiescent root', async () => {
  const calls = [];
  await finalizeRealLifecycle({
    completed: false,
    electronApp: { marker: 'github-electron' },
    lifecycle: { root: 'C:\\Temp\\minecraft-core-real-github-releases-e2e-failed-clean' },
    async closeAndAudit() { calls.push('close-and-audit'); },
    async collectEvidence() { calls.push('evidence'); return { ok: false }; },
    async attachEvidence(evidence) { calls.push(['attach', evidence]); },
    async dispose(options) { calls.push(['dispose', options]); },
    environment: {}
  });
  assert.deepEqual(calls, [
    'close-and-audit', 'evidence', ['attach', { ok: false }], ['dispose', { preserveRoot: false }]
  ]);
});

test('real GitHub finalization honors explicit failed-run debug preservation', async () => {
  const calls = [];
  await finalizeRealLifecycle({
    completed: false,
    electronApp: { marker: 'github-electron' },
    lifecycle: { root: 'C:\\Temp\\minecraft-core-real-github-releases-e2e-failed-debug' },
    async closeAndAudit() { calls.push('close-and-audit'); },
    async collectEvidence() { calls.push('evidence'); return { ok: false }; },
    async attachEvidence(evidence) { calls.push(['attach', evidence]); },
    async dispose(options) { calls.push(['dispose', options]); },
    environment: { MINECRAFT_CORE_PRESERVE_FAILED_REAL_E2E: '1' }
  });
  assert.deepEqual(calls, [
    'close-and-audit', 'evidence', ['attach', { ok: false }], ['dispose', { preserveRoot: true }]
  ]);
});

test('real GitHub finalization preserves a failed root when evidence attachment fails', async () => {
  const attachmentFailure = new Error('test reporter unavailable');
  const calls = [];

  await assert.rejects(finalizeRealLifecycle({
    completed: false,
    electronApp: { marker: 'github-electron' },
    lifecycle: { root: 'C:\\Temp\\minecraft-core-real-github-releases-e2e-attachment-failed' },
    async closeAndAudit() { calls.push('close-and-audit'); },
    async collectEvidence() { calls.push('evidence'); return { ok: false }; },
    async attachEvidence() { calls.push('attach'); throw attachmentFailure; },
    async dispose(options) { calls.push(['dispose', options]); },
    environment: {}
  }), error => error === attachmentFailure);

  assert.deepEqual(calls, [
    'close-and-audit', 'evidence', 'attach', ['dispose', { preserveRoot: true }]
  ]);
});

test('real GitHub finalization preserves a failed root when evidence collection fails', async () => {
  const collectionFailure = new Error('evidence filesystem unavailable');
  const calls = [];

  await assert.rejects(finalizeRealLifecycle({
    completed: false,
    electronApp: { marker: 'github-electron' },
    lifecycle: { root: 'C:\\Temp\\minecraft-core-real-github-releases-e2e-collection-failed' },
    async closeAndAudit() { calls.push('close-and-audit'); },
    async collectEvidence() { calls.push('evidence'); throw collectionFailure; },
    async attachEvidence() { calls.push('attach'); },
    async dispose(options) { calls.push(['dispose', options]); },
    environment: {}
  }), error => error === collectionFailure);

  assert.deepEqual(calls, [
    'close-and-audit', 'evidence', ['dispose', { preserveRoot: true }]
  ]);
});

test('real lifecycle finalization preserves and attaches evidence when the root-bound close audit fails', async () => {
  const calls = [];
  const electronApp = { marker: 'github-electron' };
  const lifecycle = { root: 'C:\\Temp\\minecraft-core-real-github-releases-e2e-exact' };
  const closeFailure = new Error('root-bound audit failed');
  await assert.rejects(finalizeRealLifecycle({
    completed: true,
    electronApp,
    lifecycle,
    async closeAndAudit(receivedElectron, receivedLifecycle) {
      calls.push(['close-and-audit', receivedElectron, receivedLifecycle]);
      throw closeFailure;
    },
    async collectEvidence() { calls.push('evidence'); return { ok: true }; },
    async attachEvidence(evidence) { calls.push(['attach', evidence]); },
    async dispose(options) { calls.push(['dispose', options]); }
  }), error => error === closeFailure);
  assert.deepEqual(calls, [
    ['close-and-audit', electronApp, lifecycle],
    'evidence', ['attach', { ok: true }], ['dispose', { preserveRoot: true }]
  ]);
});

test('evidence attachment cannot mask the original root-bound close audit failure', async () => {
  const closeFailure = new Error('root-bound process survived');
  const attachFailure = new Error('test reporter unavailable');
  const calls = [];

  await assert.rejects(finalizeRealLifecycle({
    completed: true,
    electronApp: { id: 'isolated-electron' },
    lifecycle: { root: 'C:\\isolated\\lifecycle' },
    async closeAndAudit() { calls.push('close'); throw closeFailure; },
    async collectEvidence() { calls.push('collect'); return { root: 'redacted' }; },
    async attachEvidence() { calls.push('attach'); throw attachFailure; },
    async dispose(options) { calls.push(['dispose', options]); }
  }), error => error === closeFailure);

  assert.deepEqual(calls, [
    'close',
    'collect',
    'attach',
    ['dispose', { preserveRoot: true }]
  ]);
});

test('real GitHub lifecycle selects only the pinned uploaded server asset IDs, names, and SHA-256 digests', () => {
  const newerAsset = {
    repositoryId: '451038871',
    releaseId: '274141765',
    assetId: '336455935',
    fileName: 'nomi-ceu-1.7.7-server.zip',
    installableCandidate: true,
    providerDigest: {
      algorithm: 'sha256',
      value: 'b9915d046b1b6ac2f3d02ea731d248a4bcd6e3dd4ceb81a1dfecdc350347295a'
    }
  };
  const olderAsset = {
    repositoryId: '451038871',
    releaseId: '272697650',
    assetId: '332525404',
    fileName: 'nomi-ceu-1.7.6-server.zip',
    installableCandidate: true,
    providerDigest: {
      algorithm: 'sha256',
      value: 'eda7972ba8370293ffefcedb50341bc2b0fc2839058185f2522b0676288f6926'
    }
  };

  const asset = selectKnownServerAsset([
    { ...newerAsset, assetId: '336455930', fileName: 'nomi-ceu-1.7.7-client.zip' },
    newerAsset
  ]);
  assert.deepEqual(asset, newerAsset);
  assert.deepEqual(selectKnownOlderServerAsset([olderAsset]), olderAsset);

  for (const mutation of [
    { ...newerAsset, repositoryId: '451038872' },
    { ...newerAsset, releaseId: '274141766' },
    { ...newerAsset, assetId: '336455936' },
    { ...newerAsset, fileName: 'nomi-ceu-1.7.7-client.zip' },
    { ...newerAsset, installableCandidate: false },
    { ...newerAsset, providerDigest: { algorithm: 'sha256', value: '0'.repeat(64) } },
    { ...newerAsset, providerDigest: { algorithm: 'sha512', value: REAL_GITHUB_SERVER_PACK.assetSha256 } }
  ]) assert.equal(selectKnownServerAsset([mutation]), null);

  for (const mutation of [
    { ...olderAsset, repositoryId: '451038872' },
    { ...olderAsset, releaseId: '272697651' },
    { ...olderAsset, assetId: '332525405' },
    { ...olderAsset, fileName: 'nomi-ceu-1.7.6-client.zip' },
    { ...olderAsset, installableCandidate: false },
    { ...olderAsset, providerDigest: { algorithm: 'sha256', value: '0'.repeat(64) } },
    { ...olderAsset, providerDigest: { algorithm: 'sha512', value: REAL_GITHUB_RELEASE_MONITOR.olderAssetSha256 } }
  ]) assert.equal(selectKnownOlderServerAsset([mutation]), null);

  assert.equal(requiresMissingProviderDigestAcknowledgement({
    providerDigest: { algorithm: 'sha256', value: 'a'.repeat(64) }
  }), false);
  assert.equal(requiresMissingProviderDigestAcknowledgement({ providerDigest: null }), true);
  assert.equal(requiresMissingProviderDigestAcknowledgement({}), false);
});

test('pinned GitHub releases carry exact installed artifact and version-file evidence', () => {
  assert.deepEqual({
    assetSize: REAL_GITHUB_RELEASE_MONITOR.olderAssetSize,
    artifactSetDigest: REAL_GITHUB_RELEASE_MONITOR.olderArtifactSetDigest,
    archiveChangelogSha256: REAL_GITHUB_RELEASE_MONITOR.olderArchiveChangelogSha256,
    installedVersionMarkerPath: REAL_GITHUB_RELEASE_MONITOR.olderInstalledVersionMarkerPath
  }, {
    assetSize: 224959015,
    artifactSetDigest: 'd4c4cb4e5643f89c90351434e287af12f611f2511c4e3b4b935b57d23e9f7c47',
    archiveChangelogSha256: 'aa3bc08a32cc6cc259436a82756678bc9a199e1ece2aa5867c40e2bd472a2ee8',
    installedVersionMarkerPath: 'config/nomilabs-version.cfg'
  });
  assert.deepEqual({
    assetSize: REAL_GITHUB_SERVER_PACK.assetSize,
    artifactSetDigest: REAL_GITHUB_SERVER_PACK.artifactSetDigest,
    archiveChangelogSha256: REAL_GITHUB_SERVER_PACK.archiveChangelogSha256,
    installedVersionMarkerPath: REAL_GITHUB_SERVER_PACK.installedVersionMarkerPath
  }, {
    assetSize: 224970470,
    artifactSetDigest: '872318e5bd312bcc609ed07654fbcfa3915cc8cd58ef67dd97b9eb69149a0ae3',
    archiveChangelogSha256: 'c07fcd345e7ec716994aa8e0a7c98921a9a3eb7b42d843a0a4284fb0d84fd8ba',
    installedVersionMarkerPath: 'config/nomilabs-version.cfg'
  });
  assert.notEqual(
    REAL_GITHUB_RELEASE_MONITOR.olderArtifactSetDigest,
    REAL_GITHUB_SERVER_PACK.artifactSetDigest
  );
});

test('release evidence helpers verify a bounded cached CHANGELOG and the installed managed version marker', async () => {
  const lifecycle = await createIsolatedRealLifecycle();
  try {
    const tagName = '9.9.9';
    const changelog = Buffer.from(
      `<h1><a href="https://github.com/Nomi-CEu/Nomi-CEu/releases/tag/${tagName}">Release</a></h1>\n`,
      'utf8'
    );
    const marker = Buffer.from(`general {\n    S:formattedVersion=v${tagName}\n}\n`, 'utf8');
    const zip = new AdmZip();
    zip.addFile('CHANGELOG.md', changelog);
    const stagedArchive = path.join(lifecycle.root, 'release-evidence.zip');
    zip.writeZip(stagedArchive);
    const archiveBytes = fs.readFileSync(stagedArchive);
    const assetSha256 = sha256(archiveBytes);
    const archivePath = path.join(
      lifecycle.userDataPath,
      'modpack-lifecycle',
      'cache',
      'sha256',
      assetSha256.slice(0, 2),
      assetSha256
    );
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.renameSync(stagedArchive, archivePath);
    const installedVersionMarkerPath = 'config/nomilabs-version.cfg';
    const installedPath = path.join(lifecycle.serverPath, ...installedVersionMarkerPath.split('/'));
    fs.mkdirSync(path.dirname(installedPath), { recursive: true });
    fs.writeFileSync(installedPath, marker);
    const release = {
      tagName,
      assetSha256,
      assetSize: archiveBytes.length,
      archiveChangelogSha256: sha256(changelog),
      installedVersionMarkerPath
    };

    assert.deepEqual(await assertPinnedReleaseArchiveEvidence(lifecycle, release), {
      assetSha256,
      changelogSha256: release.archiveChangelogSha256,
      tagName
    });
    assert.deepEqual(await assertPinnedInstalledVersion(lifecycle, release), {
      formattedVersion: `v${tagName}`,
      relativePath: installedVersionMarkerPath,
      tagName
    });

    fs.writeFileSync(
      installedPath,
      `# Configuration file\r\n\r\ngeneral {\r\n    S:formattedVersion=v${tagName}\r\n}\r\n`
    );
    assert.deepEqual(await assertPinnedInstalledVersion(lifecycle, release), {
      formattedVersion: `v${tagName}`,
      relativePath: installedVersionMarkerPath,
      tagName
    });

    await assert.rejects(
      assertPinnedReleaseArchiveEvidence(lifecycle, {
        ...release,
        archiveChangelogSha256: '0'.repeat(64)
      }),
      /changelog/iu
    );
    fs.writeFileSync(installedPath, 'S:formattedVersion=v0.0.0\n');
    await assert.rejects(assertPinnedInstalledVersion(lifecycle, release), /version marker/iu);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('real GitHub lifecycle retries conflict review with exact opaque pack approvals', async () => {
  const calls = [];
  const firstConflict = {
    id: 'opaque-conflict:v3:server-properties:91af',
    allowedChoices: ['keep-mine', 'use-pack']
  };
  const secondConflict = {
    id: 'opaque-conflict:v3:removed-addon:77cc',
    allowedChoices: ['keep-mine', 'remove-addon']
  };
  const page = fakeModpackPage(async (channel, request) => {
    assert.equal(channel, 'modpacks:preflight');
    calls.push(structuredClone(request));
    if (calls.length === 1) {
      return { requiresConflictReview: true, conflicts: [firstConflict, secondConflict] };
    }
    return {
      requiresConflictReview: false,
      planId: 'plan-reviewed-github',
      planFingerprint: 'f'.repeat(64),
      planView: { source: { provider: 'github', version: '1.7.7' } }
    };
  });

  const reviewed = await reviewExactGitHubArchive(page, {
    instanceId: 'server-github-e2e',
    release: { releaseId: '274141765' },
    asset: { providerDigest: null },
    inspection: { inspectionId: 'inspection-github-e2e', selectedRoot: 'server-root' },
    operationKind: 'update'
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    inspectionId: 'inspection-github-e2e',
    instanceId: 'server-github-e2e',
    operationKind: 'update',
    selections: {
      optionalFileIds: [],
      conflictChoices: { paths: {}, categories: {} },
      acknowledgeMissingProviderDigest: true,
      acknowledgeDowngradeWorldRisk: false,
      selectedRoot: 'server-root',
      runtimeChoice: { ...REAL_GITHUB_SERVER_PACK.runtimeChoice }
    }
  });
  assert.deepEqual(calls[1].selections.conflictChoices, {
    paths: {
      'opaque-conflict:v3:server-properties:91af': { choice: 'use-pack' },
      'opaque-conflict:v3:removed-addon:77cc': { choice: 'remove-addon' }
    },
    categories: {}
  });
  assert.deepEqual(reviewed.conflicts, [firstConflict, secondConflict]);
  assert.equal(reviewed.plan.planId, 'plan-reviewed-github');
  assert.deepEqual(reviewed.selections, calls[1].selections);
});

test('real GitHub lifecycle rejects an unresolved second conflict review', async () => {
  let calls = 0;
  const page = fakeModpackPage(async () => {
    calls += 1;
    return {
      requiresConflictReview: true,
      conflicts: [{ id: 'opaque-conflict:v3:repeat', allowedChoices: ['use-pack'] }]
    };
  });

  await assert.rejects(
    reviewExactGitHubArchive(page, {
      instanceId: 'server-github-e2e',
      release: { releaseId: '272697650' },
      asset: { providerDigest: { algorithm: 'sha256', value: 'a'.repeat(64) } },
      inspection: { inspectionId: 'inspection-github-e2e', selectedRoot: null },
      operationKind: 'downgrade',
      acknowledgeDowngradeWorldRisk: true
    }),
    /exact conflict choices did not produce a reviewed GitHub lifecycle plan/iu
  );
  assert.equal(calls, 2);
});

test('real GitHub Releases E2E uses its own scratch prefix and provider marker', async () => {
  const lifecycle = await createIsolatedRealLifecycle();
  try {
    assert.match(lifecycle.root, /minecraft-core-real-github-releases-e2e-/u);
    assert.deepEqual(JSON.parse(fs.readFileSync(lifecycle.identityPath, 'utf8')), {
      provider: 'github-releases', harness: 'real-github-releases'
    });
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('real GitHub release-monitor E2E has an independent disposable profile identity', async () => {
  const lifecycle = await createIsolatedRealReleaseMonitor();
  try {
    assert.match(lifecycle.root, /minecraft-core-real-github-release-monitor-e2e-/u);
    assert.deepEqual(JSON.parse(fs.readFileSync(lifecycle.identityPath, 'utf8')), {
      provider: 'github-releases', harness: 'real-github-release-monitor'
    });
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});
