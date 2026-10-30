'use strict';
// Decisions and publication steps for .github/workflows/release.yml. Node built-ins only: the publish job
// never installs project dependencies.
//   plan                  check-version: decide whether this run builds and whether it may publish
//   discard-stale-drafts  publish: delete unpublished drafts for the tag left by an earlier attempt
//   verify-and-publish    publish: prove the draft holds exactly the verified files, then publish it
//   confirm-feed          publish: prove the public feed installed apps read now serves this release
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyReleaseArtifacts } = require('./verify-release-artifacts.cjs');

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const RELEASE_TAG_REF = /^refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const MAIN_REF = 'refs/heads/main';
const STALE_DRAFT_AUTHOR = 'github-actions[bot]';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const API_VERSION = '2022-11-28';
const USER_AGENT = 'minecraft-core-release-pipeline';
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const FEED_ATTEMPTS = 12;
const FEED_INTERVAL_MS = 15_000;

function compareVersions(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function parseReleaseTags(lsRemoteOutput) {
  const versions = new Set();
  for (const line of String(lsRemoteOutput).split(/\r?\n/u)) {
    const match = RELEASE_TAG_REF.exec(line.split('\t')[1]?.trim() ?? '');
    if (match) versions.add(match[1]);
  }
  return [...versions];
}

function planRelease({ eventName, ref, dryRun, version, releasedVersions }) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) throw new Error('package.json contains an invalid release version');
  if (eventName !== 'push' && eventName !== 'workflow_dispatch') throw new Error(`Unsupported release trigger ${eventName}`);
  if (!Array.isArray(releasedVersions)) throw new Error(`Could not verify whether release tag v${version} exists`);
  // Only a manual dispatch can be a dry run; a push to main always means a release.
  const isDryRun = eventName === 'workflow_dispatch' && dryRun === true;
  if (!isDryRun && ref !== MAIN_REF) {
    throw new Error('Releases can only be created from refs/heads/main; dispatch with dry_run=true to build another ref');
  }
  if (releasedVersions.includes(version)) {
    if (isDryRun) {
      throw new Error(`v${version} is already released; bump the version before a dry run so its installer cannot pass for the public v${version}`);
    }
    return Object.freeze({ version, build: false, publish: false, reason: `v${version} is already released; nothing to build or publish` });
  }
  const latest = releasedVersions.reduce((max, candidate) => (max === null || compareVersions(candidate, max) > 0 ? candidate : max), null);
  if (latest !== null && compareVersions(version, latest) <= 0) {
    throw new Error(`v${version} is not newer than the latest release v${latest}; existing users would never be offered it`);
  }
  return Object.freeze(isDryRun
    ? { version, build: true, publish: false, reason: `Dry run of v${version}: every release gate runs and nothing is published` }
    : { version, build: true, publish: true, reason: `Release v${version}: build, verify and publish` });
}

function listRemoteReleaseTags({ remote = 'origin', run = spawnSync } = {}) {
  const result = run('git', ['ls-remote', '--tags', remote], { encoding: 'utf8', timeout: 60_000, windowsHide: true, shell: false });
  return result.status === 0 && !result.error ? parseReleaseTags(result.stdout) : null;
}

function runPlan({ env, version, listRemoteTags, writeOutput, log }) {
  if (env.DRY_RUN !== 'true' && env.DRY_RUN !== 'false') throw new Error('DRY_RUN must be "true" or "false"');
  const plan = planRelease({
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    dryRun: env.DRY_RUN === 'true',
    version,
    releasedVersions: listRemoteTags()
  });
  writeOutput(`version=${plan.version}\nbuild=${plan.build}\npublish=${plan.publish}\n`);
  log(`::notice::${plan.reason}`);
  return plan;
}

function githubContext(env, { withToken = false } = {}) {
  const repository = String(env.GITHUB_REPOSITORY || '');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(repository)) throw new Error('GITHUB_REPOSITORY is not an owner/repository name');
  const httpsBase = value => {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error(`${value} is not an https URL`);
    return url.href.replace(/\/+$/u, '');
  };
  const context = {
    repository,
    apiUrl: httpsBase(env.GITHUB_API_URL || 'https://api.github.com'),
    serverUrl: httpsBase(env.GITHUB_SERVER_URL || 'https://github.com')
  };
  if (withToken) {
    if (!env.GH_TOKEN) throw new Error('GH_TOKEN is required for this step');
    context.token = env.GH_TOKEN;
  }
  return Object.freeze(context);
}

function githubApi(github, fetchImpl, method, apiPath, { body, accept = 'application/vnd.github+json', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return fetchImpl(`${github.apiUrl}${apiPath}`, {
    method,
    headers: {
      Accept: accept,
      Authorization: `Bearer ${github.token}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': API_VERSION,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function jsonResult(responsePromise, action) {
  const response = await responsePromise;
  if (!response.ok) throw new Error(`${action} failed with HTTP ${response.status}`);
  return response.json();
}

async function listPages(fetchPage, action) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await jsonResult(fetchPage(page), action);
    if (!Array.isArray(batch)) throw new Error(`${action} returned an unexpected response`);
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return items;
  }
  throw new Error(`${action} returned more than ${MAX_PAGES * PAGE_SIZE} entries`);
}

function listReleases(github, fetchImpl) {
  return listPages(page => githubApi(github, fetchImpl, 'GET', `/repos/${github.repository}/releases?per_page=${PAGE_SIZE}&page=${page}`),
    'Listing releases');
}

// Only drafts this workflow created for the tag are stale; a published release or a hand-made draft stops publication.
function selectStaleDrafts(releases, tag) {
  const matching = releases.filter(release => release && release.tag_name === tag);
  if (matching.some(release => release.draft !== true)) throw new Error(`A published release already uses ${tag}; refusing to change it`);
  const foreign = matching.filter(release => release.author?.login !== STALE_DRAFT_AUTHOR);
  if (foreign.length > 0) {
    throw new Error(`Draft release ${foreign.map(release => release.id).join(', ')} for ${tag} was not created by ${STALE_DRAFT_AUTHOR}; ` +
      'publish or delete it by hand before re-running');
  }
  const ids = matching.map(release => release.id);
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error(`A draft release for ${tag} has an invalid id`);
  return ids;
}

async function discardStaleDrafts({ github, version, listRemoteTags, fetch: fetchImpl, log }) {
  const tag = `v${version}`;
  const released = listRemoteTags();
  if (!Array.isArray(released)) throw new Error(`Could not verify whether tag ${tag} exists`);
  if (released.includes(version)) {
    throw new Error(`Tag ${tag} already exists, so this release is already public; verify it by hand and do not re-run publication`);
  }
  const ids = selectStaleDrafts(await listReleases(github, fetchImpl), tag);
  for (const id of ids) {
    const response = await githubApi(github, fetchImpl, 'DELETE', `/repos/${github.repository}/releases/${id}`);
    if (response.status !== 204) throw new Error(`Deleting draft release ${id} failed with HTTP ${response.status}`);
    log(`Deleted unpublished draft release ${id} for ${tag} from an earlier attempt`);
  }
  if (ids.length === 0) log(`No unpublished drafts for ${tag}`);
  return Object.freeze({ tag, deleted: Object.freeze([...ids]) });
}

async function hashBody(response, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      hash.update(chunk);
      size += chunk.length;
    }
  }
  return { size, digest: hash.digest(encoding) };
}

async function uploadedSha256(github, fetchImpl, asset) {
  if (typeof asset.digest === 'string' && asset.digest.length > 0) return asset.digest;
  // Older API responses carry no digest; hash the uploaded bytes instead of trusting the name and size.
  const response = await githubApi(github, fetchImpl, 'GET', `/repos/${github.repository}/releases/assets/${asset.id}`,
    { accept: 'application/octet-stream', timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (!response.ok) throw new Error(`Downloading uploaded ${asset.name} failed with HTTP ${response.status}`);
  const downloaded = await hashBody(response, 'sha256', 'hex');
  if (downloaded.size !== asset.size) throw new Error(`Uploaded ${asset.name} is ${downloaded.size} bytes, not ${asset.size}`);
  return `sha256:${downloaded.digest}`;
}

async function verifyAndPublish({ github, version, releaseId, targetCommitish, artifacts, fetch: fetchImpl, log }) {
  const tag = `v${version}`;
  if (!/^[1-9]\d*$/u.test(String(releaseId ?? ''))) throw new Error('The draft release id is missing; the draft step must expose its id output');
  if (!/^[0-9a-f]{40}$/u.test(String(targetCommitish ?? ''))) throw new Error('GITHUB_SHA is not a commit id');
  const releasePath = `/repos/${github.repository}/releases/${releaseId}`;
  const release = await jsonResult(githubApi(github, fetchImpl, 'GET', releasePath), 'Reading the draft release');
  if (release.draft !== true || release.prerelease !== false || release.tag_name !== tag ||
      release.target_commitish !== targetCommitish || release.author?.login !== STALE_DRAFT_AUTHOR) {
    throw new Error(`Release ${releaseId} is not this run's unpublished ${tag} draft for ${targetCommitish}`);
  }
  const assets = await listPages(page => githubApi(github, fetchImpl, 'GET', `${releasePath}/assets?per_page=${PAGE_SIZE}&page=${page}`),
    'Listing the draft assets');
  const expected = [artifacts.installer, artifacts.blockmap, artifacts.latestYml];
  const names = assets.map(asset => asset.name).sort();
  const expectedNames = expected.map(file => file.name).sort();
  if (names.join('\n') !== expectedNames.join('\n')) {
    throw new Error(`Draft ${tag} must hold exactly ${expectedNames.join(', ')}; it holds ${names.join(', ') || 'nothing'}`);
  }
  for (const file of expected) {
    const asset = assets.find(candidate => candidate.name === file.name);
    if (asset.state !== 'uploaded' || asset.size !== file.size) throw new Error(`Uploaded ${file.name} is incomplete or has the wrong size`);
    if (await uploadedSha256(github, fetchImpl, asset) !== `sha256:${file.sha256}`) {
      throw new Error(`Uploaded ${file.name} is not the verified file`);
    }
  }
  const published = await jsonResult(githubApi(github, fetchImpl, 'PATCH', releasePath, { body: { draft: false, make_latest: 'true' } }),
    'Publishing the draft release');
  if (published.draft !== false || published.tag_name !== tag) throw new Error(`Publishing ${tag} did not take effect`);
  log(`Published ${tag} as the latest release with exactly the verified installer, blockmap and latest.yml`);
  return Object.freeze({ tag, id: Number(releaseId), draft: false });
}

async function publicGet(fetchImpl, url, accept, timeoutMs) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: accept, 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response;
}

// The same anonymous requests electron-updater makes: releases/latest names the tag, then the release
// downloads must be byte-for-byte the files this run verified.
async function checkFeedOnce({ github, tag, artifacts, fetch: fetchImpl }) {
  const releases = `${github.serverUrl}/${github.repository}/releases`;
  const latest = await (await publicGet(fetchImpl, `${releases}/latest`, 'application/json', REQUEST_TIMEOUT_MS)).json();
  if (latest?.tag_name !== tag) throw new Error(`releases/latest names ${latest?.tag_name ?? 'no release'}, not ${tag}`);
  const download = name => publicGet(fetchImpl, `${releases}/download/${tag}/${name}`, 'application/octet-stream', DOWNLOAD_TIMEOUT_MS);
  for (const file of [artifacts.latestYml, artifacts.blockmap]) {
    const served = await hashBody(await download(file.name), 'sha256', 'hex');
    if (served.size !== file.size || served.digest !== file.sha256) throw new Error(`the public ${file.name} is not the verified file`);
  }
  const installer = await hashBody(await download(artifacts.installer.name), 'sha512', 'base64');
  if (installer.size !== artifacts.installer.size || installer.digest !== artifacts.installer.sha512) {
    throw new Error(`the public ${artifacts.installer.name} does not match the size and sha512 in latest.yml`);
  }
}

async function confirmFeed({ github, version, artifacts, fetch: fetchImpl, sleep, attempts = FEED_ATTEMPTS, intervalMs = FEED_INTERVAL_MS, log }) {
  const tag = `v${version}`;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await checkFeedOnce({ github, tag, artifacts, fetch: fetchImpl });
      log(`The public update feed serves ${tag}: latest release, latest.yml, blockmap and installer all match`);
      return Object.freeze({ tag, attempts: attempt });
    } catch (error) {
      lastError = error;
      log(`Feed check ${attempt} of ${attempts}: ${error.message}`);
      if (attempt < attempts) await sleep(intervalMs);
    }
  }
  throw new Error(`The public update feed does not serve ${tag} correctly: ${lastError.message}. ` +
    'The release is already public; verify it by hand and do not re-run publication');
}

async function runCommand(command, env) {
  const repositoryRoot = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const version = packageJson.version;
  const log = message => process.stdout.write(`${message}\n`);
  const verifiedArtifacts = () => verifyReleaseArtifacts({ distRoot: path.join(repositoryRoot, 'dist'), version });
  switch (command) {
    case 'plan':
      if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
      return runPlan({ env, version, listRemoteTags: listRemoteReleaseTags, writeOutput: text => fs.appendFileSync(env.GITHUB_OUTPUT, text), log });
    case 'discard-stale-drafts':
      return discardStaleDrafts({ github: githubContext(env, { withToken: true }), version, listRemoteTags: listRemoteReleaseTags, fetch, log });
    case 'verify-and-publish':
      return verifyAndPublish({
        github: githubContext(env, { withToken: true }),
        version,
        releaseId: env.RELEASE_ID,
        targetCommitish: env.GITHUB_SHA,
        artifacts: verifiedArtifacts(),
        fetch,
        log
      });
    case 'confirm-feed': {
      const github = githubContext(env);
      const feed = `${packageJson.build?.publish?.owner}/${packageJson.build?.publish?.repo}`;
      if (github.repository !== feed) log(`::notice::Rehearsal: ${github.repository} is not ${feed}, the feed installed apps read`);
      return confirmFeed({ github, version, artifacts: verifiedArtifacts(), fetch, sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), log });
    }
    default:
      throw new Error('Usage: node scripts/release-plan.cjs plan|discard-stale-drafts|verify-and-publish|confirm-feed');
  }
}

module.exports = {
  MAIN_REF,
  STALE_DRAFT_AUTHOR,
  compareVersions,
  confirmFeed,
  discardStaleDrafts,
  githubContext,
  listRemoteReleaseTags,
  parseReleaseTags,
  planRelease,
  runPlan,
  selectStaleDrafts,
  verifyAndPublish
};

if (require.main === module) {
  runCommand(process.argv.length === 3 ? process.argv[2] : undefined, process.env).catch(error => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}
