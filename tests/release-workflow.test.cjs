const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const releasePlanPath = path.join(repositoryRoot, 'scripts', 'release-plan.cjs');
const releaseArtifactsPath = path.join(repositoryRoot, 'scripts', 'verify-release-artifacts.cjs');

function optionalScript(scriptPath) {
  try {
    return require(scriptPath);
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes(path.basename(scriptPath))) throw error;
    return {};
  }
}

const releasePlan = optionalScript(releasePlanPath);
const releaseArtifacts = optionalScript(releaseArtifactsPath);

const PUBLIC = Object.freeze(['1.2.3', '25.12.5', '26.4.3', '26.6.1']);
const API = 'https://api.github.com';
const SERVER = 'https://github.com';
const REPOSITORY = 'zXord/Minecraft-Core';
const GITHUB = Object.freeze({ repository: REPOSITORY, apiUrl: API, serverUrl: SERVER, token: 'test-token' });
const BOT = Object.freeze({ login: 'github-actions[bot]', type: 'Bot' });
const COMMIT = 'a'.repeat(40);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha512Base64(bytes) {
  return crypto.createHash('sha512').update(bytes).digest('base64');
}

function plan(input) {
  return releasePlan.planRelease({ eventName: 'push', ref: 'refs/heads/main', dryRun: false, version: '26.11.1', releasedVersions: PUBLIC, ...input });
}

function releaseFixture(t, { version = '26.11.1', installerBytes = Buffer.from('installer bytes for the release fixture') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-release-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = `Minecraft-Core-Setup-${version}.exe`;
  const blockmapBytes = Buffer.from('blockmap bytes for the release fixture');
  fs.writeFileSync(path.join(root, installer), installerBytes);
  fs.writeFileSync(path.join(root, `${installer}.blockmap`), blockmapBytes);
  const sha512 = sha512Base64(installerBytes);
  const latest = `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: ${installerBytes.length}\n` +
    `path: ${installer}\nsha512: ${sha512}\nreleaseDate: '2026-11-02T10:00:00.000Z'\n`;
  fs.writeFileSync(path.join(root, 'latest.yml'), latest);
  return { root, version, installer, installerBytes, blockmapBytes, latest, latestBytes: Buffer.from(latest), sha512 };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function createFakeFetch(routes) {
  const calls = [];
  async function fetch(url, options = {}) {
    const method = options.method || 'GET';
    const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const call = { method, url: String(url), headers, body: options.body === undefined ? undefined : JSON.parse(options.body) };
    calls.push(call);
    const route = routes[`${method} ${url}`];
    if (!route) throw new Error(`Unexpected request ${method} ${url}`);
    return route(call, calls);
  }
  return { fetch, calls };
}

function verifiedArtifacts(fixture) {
  return releaseArtifacts.verifyReleaseArtifacts({ distRoot: fixture.root, version: fixture.version });
}

function draftRelease(overrides = {}) {
  return { id: 77, tag_name: 'v26.11.1', draft: true, prerelease: false, target_commitish: COMMIT, author: BOT, ...overrides };
}

function uploadedAssets(fixture, mutate = assets => assets) {
  return mutate([
    { id: 901, name: fixture.installer, state: 'uploaded', size: fixture.installerBytes.length, digest: `sha256:${sha256(fixture.installerBytes)}` },
    { id: 902, name: `${fixture.installer}.blockmap`, state: 'uploaded', size: fixture.blockmapBytes.length, digest: `sha256:${sha256(fixture.blockmapBytes)}` },
    { id: 903, name: 'latest.yml', state: 'uploaded', size: fixture.latestBytes.length, digest: `sha256:${sha256(fixture.latestBytes)}` }
  ]);
}

function publishRoutes({ release, assets, downloads = {} }) {
  const base = `${API}/repos/${REPOSITORY}/releases`;
  const routes = {
    [`GET ${base}/77`]: () => jsonResponse(release),
    [`GET ${base}/77/assets?per_page=100&page=1`]: () => jsonResponse(assets),
    [`PATCH ${base}/77`]: call => jsonResponse({ ...release, draft: call.body.draft, make_latest: call.body.make_latest })
  };
  for (const [id, bytes] of Object.entries(downloads)) {
    routes[`GET ${base}/assets/${id}`] = () => new Response(bytes, { status: 200 });
  }
  return routes;
}

async function runVerifyAndPublish(t, { release = draftRelease(), mutateAssets, downloads, releaseId = '77' } = {}) {
  const fixture = releaseFixture(t);
  const fake = createFakeFetch(publishRoutes({ release, assets: uploadedAssets(fixture, mutateAssets), downloads: downloads?.(fixture) }));
  const result = releasePlan.verifyAndPublish({
    github: GITHUB,
    version: '26.11.1',
    releaseId,
    targetCommitish: COMMIT,
    artifacts: verifiedArtifacts(fixture),
    fetch: fake.fetch,
    log: () => {}
  });
  return { fixture, fake, result };
}

function feedRoutes(fixture, overrides = {}) {
  const download = `${SERVER}/${REPOSITORY}/releases/download/v26.11.1`;
  return {
    [`GET ${SERVER}/${REPOSITORY}/releases/latest`]: overrides.latest || (() => jsonResponse({ tag_name: 'v26.11.1' })),
    [`GET ${download}/latest.yml`]: overrides.latestYml || (() => new Response(fixture.latestBytes)),
    [`GET ${download}/${fixture.installer}.blockmap`]: overrides.blockmap || (() => new Response(fixture.blockmapBytes)),
    [`GET ${download}/${fixture.installer}`]: overrides.installer || (() => new Response(fixture.installerBytes))
  };
}

async function runConfirmFeed(t, overrides, { attempts = 3 } = {}) {
  const fixture = releaseFixture(t);
  const fake = createFakeFetch(feedRoutes(fixture, overrides));
  const sleeps = [];
  const result = releasePlan.confirmFeed({
    github: { repository: REPOSITORY, apiUrl: API, serverUrl: SERVER },
    version: '26.11.1',
    artifacts: verifiedArtifacts(fixture),
    fetch: fake.fetch,
    sleep: async milliseconds => { sleeps.push(milliseconds); },
    attempts,
    intervalMs: 5,
    log: () => {}
  });
  return { fixture, fake, sleeps, result };
}

test('remote tag listing yields only plain release versions', () => {
  assert.equal(typeof releasePlan.parseReleaseTags, 'function', 'scripts/release-plan.cjs must export parseReleaseTags');
  const output = [
    'aaa\trefs/tags/v26.6.1',
    'bbb\trefs/tags/v26.6.1^{}',
    'ccc\trefs/tags/v1.1.11',
    'ddd\trefs/tags/nightly',
    'eee\trefs/tags/v26.06.2',
    'fff\trefs/tags/v26.7.0-beta',
    'ggg\trefs/heads/v26.8.0'
  ].join('\r\n');
  assert.deepEqual(releasePlan.parseReleaseTags(output).sort(), ['1.1.11', '26.6.1']);
  assert.equal(releasePlan.compareVersions('26.11.1', '26.6.1'), 1);
  assert.equal(releasePlan.compareVersions('26.6.1', '26.6.1'), 0);
  assert.equal(releasePlan.compareVersions('25.12.5', '26.4.3'), -1);
});

test('a dry run builds on any branch and can never publish', () => {
  assert.equal(typeof releasePlan.planRelease, 'function', 'scripts/release-plan.cjs must export planRelease');
  for (const ref of ['refs/heads/main', 'refs/heads/codex/verify-modpacks-client-packs']) {
    const result = plan({ eventName: 'workflow_dispatch', ref, dryRun: true });
    assert.equal(result.build, true);
    assert.equal(result.publish, false);
    assert.equal(result.version, '26.11.1');
    assert.equal(Object.isFrozen(result), true);
  }
});

test('a dry run refuses a version that is already public', () => {
  assert.equal(typeof releasePlan.planRelease, 'function');
  assert.throws(() => plan({ eventName: 'workflow_dispatch', ref: 'refs/heads/codex/x', dryRun: true, version: '26.6.1' }),
    /bump the version before a dry run/u);
  assert.throws(() => plan({ eventName: 'workflow_dispatch', ref: 'refs/heads/codex/x', dryRun: true, version: '26.5.9' }),
    /not newer than the latest release v26\.6\.1/u);
});

test('only main with a newer unreleased version publishes', () => {
  assert.equal(typeof releasePlan.planRelease, 'function');
  assert.equal(plan({}).publish, true);
  assert.equal(plan({}).build, true);
  assert.equal(plan({ eventName: 'workflow_dispatch' }).publish, true);
  const released = plan({ version: '26.6.1' });
  assert.equal(released.build, false);
  assert.equal(released.publish, false);
  assert.match(released.reason, /already released/u);
  assert.throws(() => plan({ eventName: 'workflow_dispatch', ref: 'refs/heads/feature' }), /only be created from refs\/heads\/main/u);
  assert.throws(() => plan({ ref: 'refs/heads/feature' }), /only be created from refs\/heads\/main/u);
  assert.throws(() => plan({ releasedVersions: null }), /Could not verify/u);
  assert.throws(() => plan({ version: '26.5.9' }), /not newer than the latest release v26\.6\.1/u);
  assert.throws(() => plan({ eventName: 'schedule' }), /Unsupported release trigger/u);
  for (const version of ['26.06.1', '26.11.1-beta', 'v26.11.1', '26.11', '', null]) {
    assert.throws(() => plan({ version }), /invalid release version/u, String(version));
  }
  // A push can never become a dry run, whatever DRY_RUN says.
  const push = plan({ dryRun: true });
  assert.equal(push.publish, true);
  // An empty tag list (a rehearsal repository) is a first release.
  assert.equal(plan({ releasedVersions: [] }).publish, true);
});

test('the plan command writes exactly the version, build and publish outputs', () => {
  assert.equal(typeof releasePlan.runPlan, 'function', 'scripts/release-plan.cjs must export runPlan');
  const run = (env, listRemoteTags = () => [...PUBLIC]) => {
    const outputs = [];
    const result = releasePlan.runPlan({ env, version: '26.11.1', listRemoteTags, writeOutput: text => outputs.push(text), log: () => {} });
    return { result, outputs };
  };
  const dryRun = run({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/codex/verify-modpacks-client-packs', DRY_RUN: 'true' });
  assert.deepEqual(dryRun.outputs, ['version=26.11.1\nbuild=true\npublish=false\n']);
  const release = run({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', DRY_RUN: 'false' });
  assert.deepEqual(release.outputs, ['version=26.11.1\nbuild=true\npublish=true\n']);
  assert.throws(() => run({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', DRY_RUN: 'false' }, () => null), /Could not verify/u);
  assert.throws(() => run({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }), /DRY_RUN/u);
});

test('remote tag listing fails closed when git ls-remote does not succeed', () => {
  assert.equal(typeof releasePlan.listRemoteReleaseTags, 'function', 'scripts/release-plan.cjs must export listRemoteReleaseTags');
  const calls = [];
  const listed = releasePlan.listRemoteReleaseTags({
    run: (command, args, options) => {
      calls.push({ command, args, shell: options.shell });
      return { status: 0, stdout: 'aaa\trefs/tags/v26.6.1\nbbb\trefs/tags/v26.6.1^{}\n' };
    }
  });
  assert.deepEqual(listed, ['26.6.1']);
  assert.deepEqual(calls, [{ command: 'git', args: ['ls-remote', '--tags', 'origin'], shell: false }]);
  assert.equal(releasePlan.listRemoteReleaseTags({ run: () => ({ status: 128, stdout: '' }) }), null);
  assert.equal(releasePlan.listRemoteReleaseTags({ run: () => ({ status: null, stdout: '', error: new Error('timed out') }) }), null);
});

test('GitHub context requires an owner/repository name, https endpoints and a token only where publishing needs one', () => {
  assert.equal(typeof releasePlan.githubContext, 'function', 'scripts/release-plan.cjs must export githubContext');
  assert.deepEqual({ ...releasePlan.githubContext({ GITHUB_REPOSITORY: REPOSITORY }) }, { repository: REPOSITORY, apiUrl: API, serverUrl: SERVER });
  assert.equal(releasePlan.githubContext({ GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: 'x' }, { withToken: true }).token, 'x');
  assert.throws(() => releasePlan.githubContext({ GITHUB_REPOSITORY: REPOSITORY }, { withToken: true }), /GH_TOKEN/u);
  assert.throws(() => releasePlan.githubContext({ GITHUB_REPOSITORY: 'zXord/Minecraft-Core/extra' }), /owner\/repository/u);
  assert.throws(() => releasePlan.githubContext({ GITHUB_REPOSITORY: REPOSITORY, GITHUB_API_URL: 'http://api.example.invalid' }), /https/u);
});

test('stale draft selection deletes only bot drafts for the tag and refuses anything else', () => {
  assert.equal(typeof releasePlan.selectStaleDrafts, 'function', 'scripts/release-plan.cjs must export selectStaleDrafts');
  assert.deepEqual(releasePlan.selectStaleDrafts([
    { id: 1, tag_name: 'v26.11.1', draft: true, author: BOT },
    { id: 2, tag_name: 'v26.6.1', draft: false, author: BOT },
    { id: 3, tag_name: 'v26.11.1', draft: true, author: BOT },
    { id: 4, tag_name: 'v26.10.9', draft: true, author: { login: 'zXord', type: 'User' } }
  ], 'v26.11.1'), [1, 3]);
  assert.deepEqual(releasePlan.selectStaleDrafts([{ id: 2, tag_name: 'v26.6.1', draft: false, author: BOT }], 'v26.11.1'), []);
  assert.throws(() => releasePlan.selectStaleDrafts([{ id: 4, tag_name: 'v26.11.1', draft: false, author: BOT }], 'v26.11.1'),
    /published release already uses v26\.11\.1/u);
  assert.throws(() => releasePlan.selectStaleDrafts([
    { id: 5, tag_name: 'v26.11.1', draft: true, author: BOT },
    { id: 6, tag_name: 'v26.11.1', draft: true, author: { login: 'zXord', type: 'User' } }
  ], 'v26.11.1'), /not created by github-actions\[bot\]/u);
});

test('discarding stale drafts refuses an existing tag and deletes only the bot drafts for this tag', async () => {
  assert.equal(typeof releasePlan.discardStaleDrafts, 'function', 'scripts/release-plan.cjs must export discardStaleDrafts');
  const base = `${API}/repos/${REPOSITORY}/releases`;
  const firstPage = [
    { id: 11, tag_name: 'v26.11.1', draft: true, author: BOT },
    { id: 2, tag_name: 'v26.6.1', draft: false, author: BOT },
    { id: 12, tag_name: 'v26.10.9', draft: true, author: BOT },
    ...Array.from({ length: 97 }, (_, index) => ({ id: 1000 + index, tag_name: `v1.0.${index}`, draft: false, author: BOT }))
  ];
  const deleted = [];
  const fake = createFakeFetch({
    [`GET ${base}?per_page=100&page=1`]: () => jsonResponse(firstPage),
    [`GET ${base}?per_page=100&page=2`]: () => jsonResponse([{ id: 13, tag_name: 'v26.11.1', draft: true, author: BOT }]),
    [`DELETE ${base}/11`]: () => { deleted.push(11); return new Response(null, { status: 204 }); },
    [`DELETE ${base}/13`]: () => { deleted.push(13); return new Response(null, { status: 204 }); }
  });
  const result = await releasePlan.discardStaleDrafts({
    github: GITHUB, version: '26.11.1', listRemoteTags: () => [...PUBLIC], fetch: fake.fetch, log: () => {}
  });
  assert.deepEqual(deleted, [11, 13]);
  assert.deepEqual([...result.deleted], [11, 13]);
  assert.equal(fake.calls.every(call => call.headers.authorization === 'Bearer test-token'), true);

  for (const listRemoteTags of [() => [...PUBLIC, '26.11.1'], () => null]) {
    const untouched = createFakeFetch({});
    await assert.rejects(releasePlan.discardStaleDrafts({
      github: GITHUB, version: '26.11.1', listRemoteTags, fetch: untouched.fetch, log: () => {}
    }), /already exists|Could not verify/u);
    assert.equal(untouched.calls.length, 0);
  }

  for (const release of [
    { id: 21, tag_name: 'v26.11.1', draft: false, author: BOT },
    { id: 22, tag_name: 'v26.11.1', draft: true, author: { login: 'zXord', type: 'User' } }
  ]) {
    const refused = createFakeFetch({
      [`GET ${base}?per_page=100&page=1`]: () => jsonResponse([release, { id: 23, tag_name: 'v26.11.1', draft: true, author: BOT }])
    });
    await assert.rejects(releasePlan.discardStaleDrafts({
      github: GITHUB, version: '26.11.1', listRemoteTags: () => [...PUBLIC], fetch: refused.fetch, log: () => {}
    }));
    assert.equal(refused.calls.some(call => call.method === 'DELETE'), false);
  }
});

test('verify-and-publish publishes a draft only when its assets are exactly the verified files', async (t) => {
  assert.equal(typeof releasePlan.verifyAndPublish, 'function', 'scripts/release-plan.cjs must export verifyAndPublish');
  const { fake, result } = await runVerifyAndPublish(t);
  const published = await result;
  assert.equal(published.draft, false);
  const patch = fake.calls.filter(call => call.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.deepEqual(patch[0].body, { draft: false, make_latest: 'true' });
  assert.equal(fake.calls.indexOf(patch[0]), fake.calls.length - 1, 'publishing is the last request');
  assert.equal(fake.calls.every(call => call.headers.authorization === 'Bearer test-token'), true);
});

test('verify-and-publish refuses a wrong exe, an extra asset, a missing asset or an unfinished upload', async (t) => {
  assert.equal(typeof releasePlan.verifyAndPublish, 'function');
  const cases = {
    'wrong exe digest': assets => assets.map(asset => asset.id === 901 ? { ...asset, digest: `sha256:${'0'.repeat(64)}` } : asset),
    'wrong exe size': assets => assets.map(asset => asset.id === 901 ? { ...asset, size: asset.size + 1 } : asset),
    'extra asset': assets => [...assets, { id: 904, name: 'Minecraft-Core-Setup-26.6.1.exe', state: 'uploaded', size: 3, digest: `sha256:${'1'.repeat(64)}` }],
    'missing asset': assets => assets.filter(asset => asset.id !== 902),
    'unfinished upload': assets => assets.map(asset => asset.id === 903 ? { ...asset, state: 'open' } : asset),
    'renamed asset': assets => assets.map(asset => asset.id === 903 ? { ...asset, name: 'latest-old.yml' } : asset)
  };
  for (const [name, mutateAssets] of Object.entries(cases)) {
    const { fake, result } = await runVerifyAndPublish(t, { mutateAssets });
    await assert.rejects(result, undefined, name);
    assert.equal(fake.calls.some(call => call.method === 'PATCH'), false, name);
  }
  for (const [name, release] of Object.entries({
    'already published': draftRelease({ draft: false }),
    'other tag': draftRelease({ tag_name: 'v26.11.2' }),
    'other commit': draftRelease({ target_commitish: 'b'.repeat(40) }),
    'hand-made draft': draftRelease({ author: { login: 'zXord', type: 'User' } })
  })) {
    const { fake, result } = await runVerifyAndPublish(t, { release });
    await assert.rejects(result, undefined, name);
    assert.equal(fake.calls.some(call => call.method === 'PATCH'), false, name);
  }
  const missingId = await runVerifyAndPublish(t, { releaseId: '' });
  await assert.rejects(missingId.result, /release id/u);
  assert.equal(missingId.fake.calls.length, 0);
});

test('verify-and-publish hashes the uploaded bytes when GitHub reports no digest', async (t) => {
  assert.equal(typeof releasePlan.verifyAndPublish, 'function');
  const withoutDigest = assets => assets.map(asset => asset.id === 901 ? { ...asset, digest: null } : asset);
  const good = await runVerifyAndPublish(t, { mutateAssets: withoutDigest, downloads: fixture => ({ 901: fixture.installerBytes }) });
  assert.equal((await good.result).draft, false);
  const download = good.fake.calls.find(call => call.url.endsWith('/releases/assets/901'));
  assert.equal(download.headers.accept, 'application/octet-stream');

  const bad = await runVerifyAndPublish(t, {
    mutateAssets: withoutDigest,
    downloads: fixture => ({ 901: Buffer.concat([fixture.installerBytes.subarray(1), Buffer.from('x')]) })
  });
  await assert.rejects(bad.result);
  assert.equal(bad.fake.calls.some(call => call.method === 'PATCH'), false);
});

test('confirm-feed proves the public feed serves the verified latest.yml, installer and blockmap without credentials', async (t) => {
  assert.equal(typeof releasePlan.confirmFeed, 'function', 'scripts/release-plan.cjs must export confirmFeed');
  const { fake, sleeps, result } = await runConfirmFeed(t);
  const evidence = await result;
  assert.equal(evidence.tag, 'v26.11.1');
  assert.deepEqual(sleeps, []);
  assert.equal(fake.calls.some(call => 'authorization' in call.headers), false, 'the feed check must not use a token');
  assert.equal(fake.calls.find(call => call.url.endsWith('/releases/latest')).headers.accept, 'application/json');
});

test('confirm-feed retries a lagging feed and rejects a wrong tag, latest.yml, installer or blockmap', async (t) => {
  assert.equal(typeof releasePlan.confirmFeed, 'function');
  let latestCalls = 0;
  const lagging = await runConfirmFeed(t, {
    latest: () => jsonResponse({ tag_name: (latestCalls += 1) === 1 ? 'v26.6.1' : 'v26.11.1' })
  });
  assert.equal((await lagging.result).tag, 'v26.11.1');
  assert.deepEqual(lagging.sleeps, [5]);

  const cases = {
    'stale latest tag': () => ({ latest: () => jsonResponse({ tag_name: 'v26.6.1' }) }),
    'missing release': () => ({ latest: () => jsonResponse({ error: 'Not Found' }, 404) }),
    'different latest.yml': () => ({ latestYml: () => new Response('version: 26.11.1\n') }),
    'installer with the same size but other bytes': fixture => ({
      installer: () => new Response(Buffer.from(fixture.installerBytes).reverse())
    }),
    'truncated installer': fixture => ({ installer: () => new Response(fixture.installerBytes.subarray(1)) }),
    'different blockmap': () => ({ blockmap: () => new Response('another blockmap') })
  };
  for (const [name, overridesFor] of Object.entries(cases)) {
    const fixture = releaseFixture(t);
    const fake = createFakeFetch(feedRoutes(fixture, overridesFor(fixture)));
    const sleeps = [];
    await assert.rejects(releasePlan.confirmFeed({
      github: { repository: REPOSITORY, apiUrl: API, serverUrl: SERVER },
      version: '26.11.1',
      artifacts: verifiedArtifacts(fixture),
      fetch: fake.fetch,
      sleep: async milliseconds => { sleeps.push(milliseconds); },
      attempts: 2,
      intervalMs: 5,
      log: () => {}
    }), /update feed/u, name);
    assert.deepEqual(sleeps, [5], name);
  }
});

test('release artifact verification binds version, name, size, SHA-512 and file digests', (t) => {
  assert.equal(typeof releaseArtifacts.verifyReleaseArtifacts, 'function', 'scripts/verify-release-artifacts.cjs must export verifyReleaseArtifacts');
  const fixture = releaseFixture(t);
  const result = releaseArtifacts.verifyReleaseArtifacts({ distRoot: fixture.root, version: '26.11.1' });
  assert.deepEqual(result, {
    version: '26.11.1',
    installer: {
      name: fixture.installer,
      size: fixture.installerBytes.length,
      sha512: fixture.sha512,
      sha256: sha256(fixture.installerBytes)
    },
    blockmap: { name: `${fixture.installer}.blockmap`, size: fixture.blockmapBytes.length, sha256: sha256(fixture.blockmapBytes) },
    latestYml: { name: 'latest.yml', size: fixture.latestBytes.length, sha256: sha256(fixture.latestBytes) }
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.installer), true);
  assert.throws(() => releaseArtifacts.verifyReleaseArtifacts({ distRoot: fixture.root, version: '26.11.2' }), /missing/u);
});

test('release artifact verification rejects a mismatched latest.yml and an ambiguous file set', (t) => {
  assert.equal(typeof releaseArtifacts.verifyReleaseArtifacts, 'function');
  const mutations = {
    'changed installer': ({ root, installer }) => fs.appendFileSync(path.join(root, installer), 'x'),
    'wrong files[0].size': ({ root, latest }) => fs.writeFileSync(path.join(root, 'latest.yml'), latest.replace(/size: \d+/u, 'size: 1')),
    'wrong files[0].sha512 only': ({ root, latest, sha512 }) => fs.writeFileSync(path.join(root, 'latest.yml'),
      latest.replace(`    sha512: ${sha512}`, `    sha512: ${sha512Base64(Buffer.from('other'))}`)),
    'wrong version': ({ root, latest }) => fs.writeFileSync(path.join(root, 'latest.yml'), latest.replace('version: 26.11.1', 'version: 26.6.1')),
    'two files entries': ({ root, latest, installer, sha512 }) => fs.writeFileSync(path.join(root, 'latest.yml'),
      latest.replace('path:', `  - url: ${installer}\n    sha512: ${sha512}\n    size: 1\npath:`)),
    'unexpected latest.yml key': ({ root, latest }) => fs.writeFileSync(path.join(root, 'latest.yml'), `${latest}stagingPercentage: 10\n`),
    'duplicate latest.yml key': ({ root, latest }) => fs.writeFileSync(path.join(root, 'latest.yml'), `${latest}version: 26.11.1\n`),
    'extra installer': ({ root }) => fs.writeFileSync(path.join(root, 'Minecraft-Core-Setup-26.6.1.exe'), 'old'),
    'extra blockmap': ({ root }) => fs.writeFileSync(path.join(root, 'Minecraft-Core-Setup-26.6.1.exe.blockmap'), 'old'),
    'missing blockmap': ({ root, installer }) => fs.rmSync(path.join(root, `${installer}.blockmap`)),
    'empty blockmap': ({ root, installer }) => fs.writeFileSync(path.join(root, `${installer}.blockmap`), ''),
    'directory instead of latest.yml': ({ root }) => {
      fs.rmSync(path.join(root, 'latest.yml'));
      fs.mkdirSync(path.join(root, 'latest.yml'));
    }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const fixture = releaseFixture(t);
    mutate(fixture);
    assert.throws(() => releaseArtifacts.verifyReleaseArtifacts({ distRoot: fixture.root, version: '26.11.1' }),
      error => error?.code === 'RELEASE_ARTIFACTS_INVALID', name);
  }
});

test('release artifact verification rejects a linked installer when links can be created', (t) => {
  assert.equal(typeof releaseArtifacts.verifyReleaseArtifacts, 'function');
  const fixture = releaseFixture(t);
  const installerPath = path.join(fixture.root, fixture.installer);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-release-link-target-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const target = path.join(elsewhere, fixture.installer);
  fs.renameSync(installerPath, target);
  try {
    fs.symlinkSync(target, installerPath, 'file');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('Creating file symlinks requires an elevated Windows privilege');
      return;
    }
    throw error;
  }
  assert.throws(() => releaseArtifacts.verifyReleaseArtifacts({ distRoot: fixture.root, version: '26.11.1' }),
    error => error?.code === 'RELEASE_ARTIFACTS_INVALID');
});

test('the release artifact command also requires the package.json version', (t) => {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
  const matching = releaseFixture(t, { version: packageVersion });
  const accepted = childProcess.spawnSync(process.execPath, [releaseArtifactsPath, matching.root, packageVersion], {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000
  });
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(accepted.stdout, new RegExp(`Minecraft-Core-Setup-${packageVersion.replaceAll('.', '\\.')}\\.exe`, 'u'));

  const other = releaseFixture(t, { version: '26.6.1' });
  const refused = childProcess.spawnSync(process.execPath, [releaseArtifactsPath, other.root, '26.6.1'], {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /package\.json/u);
});

test('the app-update.yml gate accepts exactly the update feed installed apps read', (t) => {
  assert.equal(typeof releaseArtifacts.verifyAppUpdateConfig, 'function', 'scripts/verify-release-artifacts.cjs must export verifyAppUpdateConfig');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.deepEqual(releaseArtifacts.EXPECTED_APP_UPDATE_CONFIG, {
    owner: 'zXord',
    repo: 'Minecraft-Core',
    provider: 'github',
    updaterCacheDirName: 'minecraft-core-updater'
  });
  assert.deepEqual(packageJson.build.publish, {
    provider: releaseArtifacts.EXPECTED_APP_UPDATE_CONFIG.provider,
    owner: releaseArtifacts.EXPECTED_APP_UPDATE_CONFIG.owner,
    repo: releaseArtifacts.EXPECTED_APP_UPDATE_CONFIG.repo
  });
  assert.equal(`${packageJson.build.extraMetadata.name}-updater`, releaseArtifacts.EXPECTED_APP_UPDATE_CONFIG.updaterCacheDirName);

  const exact = 'owner: zXord\nrepo: Minecraft-Core\nprovider: github\nupdaterCacheDirName: minecraft-core-updater\n';
  const appOutDir = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-app-update-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'resources'));
    return root;
  };
  const good = appOutDir();
  fs.writeFileSync(path.join(good, 'resources', 'app-update.yml'), exact);
  assert.deepEqual(releaseArtifacts.verifyAppUpdateConfig({ appOutDir: good }), releaseArtifacts.EXPECTED_APP_UPDATE_CONFIG);

  const variants = {
    missing: null,
    'other owner': exact.replace('owner: zXord', 'owner: someone-else'),
    'other repository': exact.replace('repo: Minecraft-Core', 'repo: Minecraft-Core-Rehearsal'),
    'generic provider': exact.replace('provider: github', 'provider: generic'),
    'missing cache name': exact.replace('updaterCacheDirName: minecraft-core-updater\n', ''),
    'extra key': `${exact}url: https://example.invalid/feed\n`,
    'duplicate key': `${exact}owner: zXord\n`,
    'nested value': exact.replace('owner: zXord', 'owner:\n  name: zXord'),
    empty: ''
  };
  for (const [name, contents] of Object.entries(variants)) {
    const root = appOutDir();
    if (contents !== null) fs.writeFileSync(path.join(root, 'resources', 'app-update.yml'), contents);
    assert.throws(() => releaseArtifacts.verifyAppUpdateConfig({ appOutDir: root }),
      error => error?.code === 'RELEASE_ARTIFACTS_INVALID', name);
  }
  const directory = appOutDir();
  fs.mkdirSync(path.join(directory, 'resources', 'app-update.yml'));
  assert.throws(() => releaseArtifacts.verifyAppUpdateConfig({ appOutDir: directory }),
    error => error?.code === 'RELEASE_ARTIFACTS_INVALID');
});

test('package.json and both package-lock.json version fields name the same release, newer than the public 26.6.1', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  assert.match(packageJson.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  assert.equal(lock.version, packageJson.version);
  assert.equal(lock.packages[''].version, packageJson.version);
  assert.equal(typeof releasePlan.compareVersions, 'function');
  assert.equal(releasePlan.compareVersions(packageJson.version, '26.6.1'), 1,
    'a build labelled as the public 26.6.1 would pass for it in the updater and the version checks');
});

test('release scripts load only Node built-ins so the publish jobs never need project dependencies', () => {
  for (const scriptPath of [releasePlanPath, releaseArtifactsPath]) {
    assert.equal(fs.existsSync(scriptPath), true, `${path.basename(scriptPath)} is required`);
    const source = fs.readFileSync(scriptPath, 'utf8');
    const literal = [...source.matchAll(/\brequire\(\s*'([^']+)'\s*\)/gu)].map(match => match[1]);
    assert.equal((source.match(/\brequire\(/gu) || []).length, literal.length, `${path.basename(scriptPath)} must only require literals`);
    for (const specifier of literal) {
      assert.ok(specifier.startsWith('node:') || specifier === './verify-release-artifacts.cjs',
        `${path.basename(scriptPath)} must not load ${specifier}`);
    }
    assert.doesNotMatch(source, /\bimport\s*\(|^\s*import\s/mu);
  }
});
