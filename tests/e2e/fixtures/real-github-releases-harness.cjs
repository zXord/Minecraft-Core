const lifecycleHarness = require('./real-modpack-harness.cjs');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

const REAL_GITHUB_RELEASES_ENV = 'MINECRAFT_CORE_REAL_GITHUB_RELEASES_E2E';
const REAL_GITHUB_RELEASE_MONITOR_ENV = 'MINECRAFT_CORE_REAL_GITHUB_RELEASE_MONITOR_E2E';
const REAL_GITHUB_SERVER_PACK = Object.freeze({
  repositoryUrl: 'https://github.com/Nomi-CEu/Nomi-CEu',
  repositoryId: '451038871',
  releaseId: '274141765',
  tagName: '1.7.7',
  releaseName: '1.7.7',
  assetId: '336455935',
  assetFileName: 'nomi-ceu-1.7.7-server.zip',
  assetSize: 224970470,
  assetSha256: 'b9915d046b1b6ac2f3d02ea731d248a4bcd6e3dd4ceb81a1dfecdc350347295a',
  artifactSetDigest: '872318e5bd312bcc609ed07654fbcfa3915cc8cd58ef67dd97b9eb69149a0ae3',
  archiveChangelogSha256: 'c07fcd345e7ec716994aa8e0a7c98921a9a3eb7b42d843a0a4284fb0d84fd8ba',
  installedVersionMarkerPath: 'config/nomilabs-version.cfg',
  runtimeChoice: Object.freeze({
    minecraftVersion: '1.12.2',
    loaderFamily: 'forge',
    loaderVersion: '14.23.5.2860'
  })
});
const REAL_GITHUB_RELEASE_MONITOR = Object.freeze({
  repositoryId: '451038871',
  olderReleaseId: '272697650',
  olderTagName: '1.7.6',
  olderReleaseName: '1.7.6',
  olderAssetId: '332525404',
  olderAssetFileName: 'nomi-ceu-1.7.6-server.zip',
  olderAssetSize: 224959015,
  olderAssetSha256: 'eda7972ba8370293ffefcedb50341bc2b0fc2839058185f2522b0676288f6926',
  olderArtifactSetDigest: 'd4c4cb4e5643f89c90351434e287af12f611f2511c4e3b4b935b57d23e9f7c47',
  olderArchiveChangelogSha256: 'aa3bc08a32cc6cc259436a82756678bc9a199e1ece2aa5867c40e2bd472a2ee8',
  olderInstalledVersionMarkerPath: 'config/nomilabs-version.cfg'
});
const UNMANAGED_SENTINEL_RELATIVE_PATH = 'world/minecraft-core-real-github.keep';
const UNMANAGED_SENTINEL_BYTES = Buffer.from('unmanaged GitHub lifecycle data must survive\n', 'utf8');
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RELEASE_TEXT_EVIDENCE_BYTES = 1024 * 1024;

function samePath(left, right) {
  const normalize = value => {
    const normalized = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  return normalize(left) === normalize(right);
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function pinnedReleaseEvidence(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release) ||
      typeof release.tagName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(release.tagName) ||
      typeof release.assetSha256 !== 'string' || !SHA256.test(release.assetSha256) ||
       !Number.isSafeInteger(release.assetSize) || release.assetSize < 1 ||
       typeof release.archiveChangelogSha256 !== 'string' || !SHA256.test(release.archiveChangelogSha256) ||
       release.installedVersionMarkerPath !== 'config/nomilabs-version.cfg') {
    throw new TypeError('Pinned GitHub release evidence is invalid');
  }
  return release;
}

async function stableRegularFile(filePath, root, { maximumBytes = Number.MAX_SAFE_INTEGER } = {}) {
  const resolved = path.resolve(filePath);
  if (!isPathWithin(root, resolved)) throw new TypeError('Pinned release evidence escaped its isolated root');
  const before = await fs.promises.lstat(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n ||
      before.size > BigInt(maximumBytes) || !samePath(await fs.promises.realpath(resolved), resolved)) {
    throw new TypeError('Pinned release evidence file is invalid');
  }
  return Object.freeze({
    birthtimeNs: before.birthtimeNs,
    dev: before.dev,
    ino: before.ino,
    mtimeNs: before.mtimeNs,
    path: resolved,
    size: before.size
  });
}

async function assertStableRegularFile(snapshot) {
  const after = await fs.promises.lstat(snapshot.path, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
      after.dev !== snapshot.dev || after.ino !== snapshot.ino || after.birthtimeNs !== snapshot.birthtimeNs ||
      after.mtimeNs !== snapshot.mtimeNs || after.size !== snapshot.size ||
      !samePath(await fs.promises.realpath(snapshot.path), snapshot.path)) {
    throw new TypeError('Pinned release evidence changed while it was read');
  }
}

function readExactZipEntry(archivePath, entryName, maximumBytes) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, {
      autoClose: false,
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (openError, archive) => {
      if (openError) {
        reject(openError);
        return;
      }
      let matched = false;
      let captured = null;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        try { archive.close(); } catch { /* retain the primary evidence result */ }
        if (error) reject(error);
        else resolve(value);
      };
      archive.once('error', error => finish(error));
      archive.once('end', () => finish(
        matched && captured ? null : new Error('Pinned archive CHANGELOG.md is unavailable'),
        captured
      ));
      archive.on('entry', entry => {
        if (entry.fileName !== entryName) {
          archive.readEntry();
          return;
        }
        if (matched || entry.fileName.endsWith('/') || Boolean(entry.generalPurposeBitFlag & 1) ||
            !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 1 ||
            entry.uncompressedSize > maximumBytes) {
          finish(new Error('Pinned archive CHANGELOG.md is invalid'));
          return;
        }
        matched = true;
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            finish(streamError);
            return;
          }
          const chunks = [];
          let measured = 0;
          stream.once('error', error => finish(error));
          stream.on('data', chunk => {
            measured += chunk.length;
            if (measured > maximumBytes || measured > entry.uncompressedSize) {
              stream.destroy(new Error('Pinned archive CHANGELOG.md exceeded its reviewed size'));
              return;
            }
            chunks.push(chunk);
          });
          stream.once('end', () => {
            if (measured !== entry.uncompressedSize) {
              finish(new Error('Pinned archive CHANGELOG.md size changed'));
              return;
            }
            captured = Buffer.concat(chunks, measured);
            archive.readEntry();
          });
        });
      });
      archive.readEntry();
    });
  });
}

async function assertPinnedReleaseArchiveEvidence(lifecycle, releaseValue) {
  const release = pinnedReleaseEvidence(releaseValue);
  const root = path.resolve(lifecycle?.root || '');
  const userDataPath = path.resolve(lifecycle?.userDataPath || '');
  if (!samePath(userDataPath, path.join(root, 'user-data'))) {
    throw new TypeError('Pinned archive evidence requires an isolated lifecycle');
  }
  const archivePath = path.join(
    userDataPath,
    'modpack-lifecycle',
    'cache',
    'sha256',
    release.assetSha256.slice(0, 2),
    release.assetSha256
  );
  const snapshot = await stableRegularFile(archivePath, userDataPath);
  if (snapshot.size !== BigInt(release.assetSize)) throw new Error('Pinned GitHub release asset size changed');
  const changelog = await readExactZipEntry(archivePath, 'CHANGELOG.md', MAX_RELEASE_TEXT_EVIDENCE_BYTES);
  await assertStableRegularFile(snapshot);
  const changelogSha256 = crypto.createHash('sha256').update(changelog).digest('hex');
  const firstLine = changelog.toString('utf8').split(/\r?\n/u, 1)[0];
  if (changelogSha256 !== release.archiveChangelogSha256 ||
      !firstLine.includes(`/Nomi-CEu/Nomi-CEu/releases/tag/${release.tagName}`)) {
    throw new Error('Pinned archive CHANGELOG.md did not match the exact release');
  }
  return Object.freeze({ assetSha256: release.assetSha256, changelogSha256, tagName: release.tagName });
}

async function assertPinnedInstalledVersion(lifecycle, releaseValue) {
  const release = pinnedReleaseEvidence(releaseValue);
  const serverPath = path.resolve(lifecycle?.serverPath || '');
  if (!samePath(serverPath, path.join(path.resolve(lifecycle?.root || ''), 'server'))) {
    throw new TypeError('Installed release evidence requires an isolated lifecycle');
  }
  const relativePath = release.installedVersionMarkerPath;
  const markerPath = path.join(serverPath, ...relativePath.split('/'));
  const snapshot = await stableRegularFile(markerPath, serverPath, {
    maximumBytes: MAX_RELEASE_TEXT_EVIDENCE_BYTES
  });
  const marker = await fs.promises.readFile(markerPath);
  await assertStableRegularFile(snapshot);
  const formattedVersion = `v${release.tagName}`;
  const versionLines = marker.toString('utf8').match(/^\s*S:formattedVersion=\S+\s*$/gmu) || [];
  if (versionLines.length !== 1 || versionLines[0].trim() !== `S:formattedVersion=${formattedVersion}`) {
    throw new Error('Installed managed version marker did not match the exact release');
  }
  return Object.freeze({ formattedVersion, relativePath, tagName: release.tagName });
}

function isRealGitHubReleasesEnabled(environment = process.env) {
  const value = String(environment?.[REAL_GITHUB_RELEASES_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function isRealGitHubReleaseMonitorEnabled(environment = process.env) {
  const value = String(environment?.[REAL_GITHUB_RELEASE_MONITOR_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function selectKnownRelease(releases) {
  if (!Array.isArray(releases)) return null;
  return releases.find(release =>
    release?.repositoryId === REAL_GITHUB_SERVER_PACK.repositoryId &&
    release.releaseId === REAL_GITHUB_SERVER_PACK.releaseId &&
    release.tagName === REAL_GITHUB_SERVER_PACK.tagName &&
    release.name === REAL_GITHUB_SERVER_PACK.releaseName &&
    release.draft !== true && release.prerelease === false &&
    (release.channel === undefined || release.channel === 'release')
  ) || null;
}

function selectKnownOlderRelease(releases) {
  if (!Array.isArray(releases)) return null;
  return releases.find(release =>
    release?.repositoryId === REAL_GITHUB_RELEASE_MONITOR.repositoryId &&
    release.releaseId === REAL_GITHUB_RELEASE_MONITOR.olderReleaseId &&
    release.tagName === REAL_GITHUB_RELEASE_MONITOR.olderTagName &&
    release.name === REAL_GITHUB_RELEASE_MONITOR.olderReleaseName &&
    release.draft !== true && release.prerelease === false &&
    (release.channel === undefined || release.channel === 'release')
  ) || null;
}

function assertExactReleaseChronology(olderRelease, newerRelease) {
  const older = Date.parse(olderRelease?.publishedAt);
  const newer = Date.parse(newerRelease?.publishedAt);
  if (!Number.isFinite(older) || !Number.isFinite(newer) || newer <= older ||
      olderRelease?.releaseId === newerRelease?.releaseId) {
    throw new Error('The pinned GitHub release chronology is invalid');
  }
}

function sentinelPath(lifecycle) {
  const target = path.resolve(lifecycle.serverPath, ...UNMANAGED_SENTINEL_RELATIVE_PATH.split('/'));
  const relative = path.relative(path.resolve(lifecycle.serverPath), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unmanaged sentinel path escaped the isolated server');
  return target;
}

function createUnmanagedSentinel(lifecycle) {
  const target = sentinelPath(lifecycle);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, UNMANAGED_SENTINEL_BYTES, { flag: 'wx' });
  return target;
}

function assertUnmanagedSentinel(lifecycle) {
  const target = sentinelPath(lifecycle);
  let bytes;
  try { bytes = fs.readFileSync(target); } catch (error) { throw new Error('The unmanaged GitHub lifecycle sentinel is missing', { cause: error }); }
  if (bytes.length !== UNMANAGED_SENTINEL_BYTES.length ||
      !crypto.timingSafeEqual(bytes, UNMANAGED_SENTINEL_BYTES)) throw new Error('The unmanaged GitHub lifecycle sentinel changed');
  return Object.freeze({
    relativePath: UNMANAGED_SENTINEL_RELATIVE_PATH,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

function directoryEntries(directory) {
  try { return fs.readdirSync(directory).sort(); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}

function windowsJavaProcesses() {
  if (process.platform !== 'win32') return [];
  const command = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(java|javaw)\\.exe$" } | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json -Compress';
  const result = childProcess.spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: false
  });
  if (result.error || result.status !== 0 || result.signal || String(result.stderr || '').trim()) {
    throw new Error('Could not audit isolated Java processes');
  }
  const text = String(result.stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(value => ({
    name: value.Name, processId: value.ProcessId, commandLine: value.CommandLine || ''
  }));
}

async function auditCompletedLifecycle(lifecycle, { processes = null } = {}) {
  const lifecycleRoot = path.join(lifecycle.userDataPath, 'modpack-lifecycle');
  const activeRecoveryEntries = directoryEntries(path.join(lifecycleRoot, 'active'));
  const workspaceEntries = directoryEntries(path.join(lifecycleRoot, 'workspaces'));
  const orphanSiblingEntries = directoryEntries(lifecycle.root).filter(name =>
    /^(?:\.server\.minecraft-core\..+\.(?:candidate|rollback|failed)|\.op2-[0-9a-f]{32}\.[crf])$/u.test(name));
  const candidates = processes ?? windowsJavaProcesses();
  const rootKey = path.resolve(lifecycle.root).toLocaleLowerCase('en-US');
  const javaProcesses = candidates.filter(value => /^(?:java|javaw)(?:\.exe)?$/iu.test(value?.name || '') &&
    String(value?.commandLine || '').toLocaleLowerCase('en-US').includes(rootKey));
  if (activeRecoveryEntries.length) throw new Error('The GitHub lifecycle left active recovery state');
  if (workspaceEntries.length) throw new Error('The GitHub lifecycle left an active workspace');
  if (orphanSiblingEntries.length) throw new Error('The GitHub lifecycle left an orphan transaction sibling');
  if (javaProcesses.length) throw new Error('The GitHub lifecycle left an isolated Java process');
  return Object.freeze({ activeRecoveryEntries, workspaceEntries, orphanSiblingEntries, javaProcesses });
}

async function finalizeRealLifecycle({
  completed,
  electronApp,
  lifecycle,
  closeAndAudit = lifecycleHarness.closeProductionElectronAndAudit,
  collectEvidence,
  attachEvidence,
  dispose,
  environment = process.env
}) {
  if (typeof closeAndAudit !== 'function') throw new TypeError('A root-bound close audit is required');
  let closeError = null;
  try { await closeAndAudit(electronApp, lifecycle); } catch (error) { closeError = error; }
  const failed = !completed;
  let preserveRoot = closeError !== null ||
    (failed && lifecycleHarness.shouldPreserveFailedRealE2E(environment));
  let followupError = null;
  if (failed || closeError !== null) {
    try {
      const evidence = await collectEvidence();
      await attachEvidence(evidence);
    } catch (error) {
      preserveRoot = true;
      followupError = error;
    }
  }
  try {
    await dispose({ preserveRoot });
  } catch (error) {
    followupError ||= error;
  }
  if (closeError) throw closeError;
  if (followupError) throw followupError;
}

function selectKnownServerAsset(assets) {
  if (!Array.isArray(assets)) return null;
  return assets.find(asset =>
    asset?.repositoryId === REAL_GITHUB_SERVER_PACK.repositoryId &&
    asset.releaseId === REAL_GITHUB_SERVER_PACK.releaseId &&
    asset.assetId === REAL_GITHUB_SERVER_PACK.assetId &&
    asset.fileName === REAL_GITHUB_SERVER_PACK.assetFileName &&
    asset.installableCandidate === true &&
    asset.providerDigest?.algorithm === 'sha256' &&
    asset.providerDigest.value === REAL_GITHUB_SERVER_PACK.assetSha256
  ) || null;
}

function selectKnownOlderServerAsset(assets) {
  if (!Array.isArray(assets)) return null;
  return assets.find(asset =>
    asset?.repositoryId === REAL_GITHUB_RELEASE_MONITOR.repositoryId &&
    asset.releaseId === REAL_GITHUB_RELEASE_MONITOR.olderReleaseId &&
    asset.assetId === REAL_GITHUB_RELEASE_MONITOR.olderAssetId &&
    asset.fileName === REAL_GITHUB_RELEASE_MONITOR.olderAssetFileName &&
    asset.installableCandidate === true &&
    asset.providerDigest?.algorithm === 'sha256' &&
    asset.providerDigest.value === REAL_GITHUB_RELEASE_MONITOR.olderAssetSha256
  ) || null;
}

function requiresMissingProviderDigestAcknowledgement(asset) {
  return asset?.providerDigest === null;
}

function githubPlanningSelections({ asset, inspection, acknowledgeDowngradeWorldRisk = false, conflictChoices } = {}) {
  return {
    optionalFileIds: [],
    conflictChoices: conflictChoices ?? { paths: {}, categories: {} },
    acknowledgeMissingProviderDigest: requiresMissingProviderDigestAcknowledgement(asset),
    acknowledgeDowngradeWorldRisk,
    selectedRoot: inspection?.selectedRoot ?? null,
    runtimeChoice: { ...REAL_GITHUB_SERVER_PACK.runtimeChoice }
  };
}

async function reviewExactGitHubArchive(page, {
  instanceId,
  release,
  asset,
  inspection,
  operationKind,
  acknowledgeDowngradeWorldRisk = false
} = {}) {
  if (!release || typeof release.releaseId !== 'string' || !inspection || typeof inspection.inspectionId !== 'string') {
    throw new Error('Exact GitHub release review evidence is incomplete');
  }
  let selections = githubPlanningSelections({ asset, inspection, acknowledgeDowngradeWorldRisk });
  let plan = await lifecycleHarness.invokeModpack(page, 'modpacks:preflight', {
    inspectionId: inspection.inspectionId,
    instanceId,
    operationKind,
    selections
  });
  let conflicts = [];
  if (plan.requiresConflictReview === true) {
    conflicts = plan.conflicts;
    selections = githubPlanningSelections({
      asset,
      inspection,
      acknowledgeDowngradeWorldRisk,
      conflictChoices: lifecycleHarness.approvePackConflictChoices(conflicts)
    });
    plan = await lifecycleHarness.invokeModpack(page, 'modpacks:preflight', {
      inspectionId: inspection.inspectionId,
      instanceId,
      operationKind,
      selections
    });
  }
  if (plan.requiresConflictReview === true || !plan.planId || !plan.planFingerprint) {
    throw new Error('Exact conflict choices did not produce a reviewed GitHub lifecycle plan');
  }
  return Object.freeze({
    plan,
    selections: Object.freeze({
      ...selections,
      conflictChoices: Object.freeze({
        paths: Object.freeze({ ...selections.conflictChoices.paths }),
        categories: Object.freeze({ ...selections.conflictChoices.categories })
      }),
      runtimeChoice: Object.freeze({ ...selections.runtimeChoice })
    }),
    conflicts: Object.freeze([...conflicts])
  });
}

async function createIsolatedRealLifecycle() {
  return lifecycleHarness.createIsolatedRealLifecycle({
    scratchLabel: 'github-releases',
    identity: { provider: 'github-releases', harness: 'real-github-releases' }
  });
}

async function createIsolatedRealReleaseMonitor() {
  return lifecycleHarness.createIsolatedRealLifecycle({
    scratchLabel: 'github-release-monitor',
    identity: { provider: 'github-releases', harness: 'real-github-release-monitor' }
  });
}

module.exports = {
  ...lifecycleHarness,
  createIsolatedRealLifecycle,
  createIsolatedRealReleaseMonitor,
  REAL_GITHUB_RELEASES_ENV,
  REAL_GITHUB_RELEASE_MONITOR_ENV,
  REAL_GITHUB_SERVER_PACK,
  REAL_GITHUB_RELEASE_MONITOR,
  UNMANAGED_SENTINEL_RELATIVE_PATH,
  assertExactReleaseChronology,
  assertPinnedInstalledVersion,
  assertPinnedReleaseArchiveEvidence,
  assertUnmanagedSentinel,
  auditCompletedLifecycle,
  createUnmanagedSentinel,
  finalizeRealLifecycle,
  isRealGitHubReleasesEnabled,
  isRealGitHubReleaseMonitorEnabled,
  selectKnownRelease,
  selectKnownOlderRelease,
  selectKnownServerAsset,
  selectKnownOlderServerAsset,
  reviewExactGitHubArchive,
  requiresMissingProviderDigestAcknowledgement
};
