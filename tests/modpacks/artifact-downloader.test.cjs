const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');

const { ArtifactDownloader } = require('../../electron/services/modpacks/artifacts/artifact-downloader.cjs');
const { ArtifactCache } = require('../../electron/services/modpacks/artifacts/artifact-cache.cjs');
const { PinnedHttpsClient } = require('../../electron/services/modpacks/network/pinned-https-client.cjs');
const { buildMrpackClientPlan, buildMrpackServerPlan } = require('../../electron/services/modpacks/mrpack/mrpack-file-plan.cjs');
const {
  createArtifactSetPlan,
  isAppIssuedVerifiedArtifactSet
} = require('../../electron/services/modpacks/contracts.cjs');
const { computePlanFingerprint } = require('../../electron/services/modpacks/artifacts/artifact-fingerprint.cjs');
const {
  GITHUB_ASSET_HOSTS,
  GitHubReleasesSource
} = require('../../electron/services/modpacks/providers/github-releases-source.cjs');

const digest = (data, algorithm) => crypto.createHash(algorithm).update(data).digest('hex');

async function fixture({ responses = new Map(), maxSetBytes, randomUUID } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-download-test-'));
  const cache = new ArtifactCache({ root: path.join(root, 'cache'), workspaceRoot: path.join(root, 'work') });
  const requestCalls = [];
  const client = { async request(url, options) {
    requestCalls.push({ url, options });
    const result = responses.get(url);
    if (result instanceof Error) throw result;
    if (typeof result === 'function') return result();
    const response = Readable.from(result?.chunks || [result?.body || Buffer.alloc(0)]);
    response.statusCode = result?.statusCode ?? 200; response.headers = result?.headers || {};
    return response;
  } };
  const downloader = new ArtifactDownloader({ client, cache, partialRoot: cache.root, ...(maxSetBytes === undefined ? {} : { maxSetBytes }), ...(randomUUID ? { randomUUID } : {}) });
  return { root, cache, client, downloader, requestCalls, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function plan(provider, parts) {
  const normalized = createArtifactSetPlan({
    provider,
    ...(provider === 'local' ? {} : { project: { id: 'project-1', slug: 'project', title: 'Project' }, release: { id: 'release-1', version: '1.0.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' } }),
    artifactSet: {
      kind: parts.length === 1 ? 'single' : 'multipart', primaryPartId: parts[0].partId,
      groupingScheme: parts.length === 1 ? 'single' : 'part-number',
      parts: parts.map(part => ({
        partId: part.partId,
        ...(part.providerAssetId === undefined ? {} : { providerAssetId: part.providerAssetId }),
        fileName: part.fileName, size: part.size,
        ...(part.updatedAt === undefined ? {} : { updatedAt: part.updatedAt }),
        ...(part.providerDigest === undefined ? {} : { providerDigest: part.providerDigest })
      })),
      providerImmutable: false, attestationStatus: 'unverified'
    }
  });
  return { ...normalized, artifactSet: { ...normalized.artifactSet, parts: normalized.artifactSet.parts.map((part, index) => ({ ...part, downloadUrl: parts[index].downloadUrl, allowedHosts: parts[index].allowedHosts, ...(parts[index].requiredProviderDigests ? { requiredProviderDigests: parts[index].requiredProviderDigests } : {}) })) } };
}

function part(content, { provider = 'local', algorithm, value, id = 'part-1', url = 'https://cdn.example/file.zip', size = String(content.length) } = {}) {
  return { provider, partId: id, fileName: `${id}.zip`, size, downloadUrl: url, allowedHosts: ['cdn.example'], ...(algorithm ? { providerDigest: { algorithm, value: value || digest(content, algorithm) } } : {}) };
}

async function issuedGitHubPlan(content, { includeDigest = true } = {}) {
  const response = value => ({ statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(value), 'utf8') });
  const source = new GitHubReleasesSource({
    clock: { now: () => Date.parse('2026-08-01T12:00:00.000Z') },
    http: {
      async request(requestPath) {
        if (requestPath === '/repos/Canonical/Pack') {
          return response({
            id: 101, name: 'Pack', full_name: 'Canonical/Pack', private: false,
            visibility: 'public', archived: false, disabled: false,
            owner: { login: 'Canonical' }
          });
        }
        if (requestPath === '/repos/Canonical/Pack/releases/201') {
          return response({
            id: 201, tag_name: 'v1.0.0', name: 'Version 1', draft: false,
            prerelease: false, immutable: true,
            created_at: '2026-07-01T00:00:00.000Z',
            updated_at: '2026-07-01T00:01:00.000Z',
            published_at: '2026-07-01T00:02:00.000Z'
          });
        }
        if (requestPath === '/repos/Canonical/Pack/releases/201/assets') {
          return response([{
            id: 301, name: 'server-pack.zip', label: 'Server pack',
            content_type: 'application/zip', state: 'uploaded', size: content.length,
            digest: includeDigest ? `sha256:${digest(content, 'sha256')}` : null,
            created_at: '2026-07-01T00:03:00.000Z',
            updated_at: '2026-07-01T00:04:00.000Z'
          }]);
        }
        throw new Error(`Unexpected GitHub test request: ${requestPath}`);
      }
    }
  });
  const identity = await source.getRepositoryIdentity('https://github.com/Canonical/Pack');
  const artifactPlan = await source.buildArtifactSetPlan({
    repositoryId: identity.repositoryId,
    releaseId: '201',
    selectedAssetIds: ['301']
  });
  return {
    artifactPlan,
    downloadUrl: 'https://api.github.com/repos/Canonical/Pack/releases/assets/301'
  };
}

async function partialFiles(root) {
  try { return (await fs.readdir(root, { recursive: true })).filter(name => String(name).endsWith('.partial')); } catch { return []; }
}

const MRPACK_GITHUB_URL = 'https://github.com/example/pack/releases/download/v1/example.jar';
const MRPACK_CDN_HOSTS = [
  'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'
];

function mrpackDownload(builder, content, { url = MRPACK_GITHUB_URL, hashes, fileSize = content.length, candidates = [] } = {}) {
  return builder({ manifest: {
    formatVersion: 1, game: 'minecraft', versionId: 'v1', name: 'Redirect fixture',
    dependencies: { minecraft: '1.21.1' },
    files: [{
      path: 'mods/example.jar', fileSize,
      hashes: hashes || { sha1: digest(content, 'sha1'), sha512: digest(content, 'sha512') },
      env: { client: 'required', server: 'required' }, downloads: [url, ...candidates]
    }]
  } }).downloads[0];
}

async function mrpackRedirectFixture(routes) {
  const f = await fixture();
  const calls = []; const lookupCalls = []; const responses = [];
  const client = new PinnedHttpsClient({
    lookup: async hostname => { lookupCalls.push(hostname); return [{ address: '8.8.8.8', family: 4 }]; },
    request(url, options, callback) {
      const req = new EventEmitter();
      req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); };
      req.end = () => options.lookup(url.hostname, {}, (error, address, family) => {
        if (error) return req.emit('error', error);
        calls.push({ url: url.href, options, address, family });
        const route = routes.get(url.href);
        if (!route) return req.emit('error', new Error('Unexpected injected MRPACK route'));
        const response = route.response || new Readable({ read() {
          this.bodyReads += 1;
          this.push(route.body || Buffer.alloc(0)); this.push(null);
        } });
        response.bodyReads = 0;
        response.statusCode = route.statusCode ?? 200;
        response.headers = route.headers || {};
        response.socket = { remoteAddress: '8.8.8.8' };
        responses.push(response); callback(response);
      });
      return req;
    }
  });
  const downloader = new ArtifactDownloader({ client, cache: f.cache, partialRoot: f.cache.root });
  return { ...f, client, downloader, calls, lookupCalls, responses };
}

test('MRPACK client and server GitHub releases follow each approved CDN with measured dual-hash verification', async t => {
  const content = Buffer.from('MRPACK redirected verified bytes');
  for (const [side, builder] of [['client', buildMrpackClientPlan], ['server', buildMrpackServerPlan]]) {
    for (const host of MRPACK_CDN_HOSTS) await t.test(`${side}: ${host}`, async t => {
      const target = `https://${host}/asset?signature=fixture-secret`;
      const f = await mrpackRedirectFixture(new Map([
        [MRPACK_GITHUB_URL, { statusCode: 302, headers: { location: target } }],
        [target, { body: content, headers: { 'content-length': String(content.length) } }]
      ]));
      try {
        const download = mrpackDownload(builder, content);
        let verified;
        try { verified = await f.downloader.downloadPart(download); }
        catch (error) {
          t.diagnostic(`download rejected: ${error.code}/${error.details?.reasonCode}; requests=${f.calls.length}; lookups=${f.lookupCalls.length}`);
          throw error;
        }
        assert.equal(verified.measuredSize, String(content.length));
        assert.equal(verified.sha256, digest(content, 'sha256'));
        assert.equal(verified.sha512, digest(content, 'sha512'));
        assert.deepEqual(await fs.readFile(f.cache.pathForSha256(verified.sha256)), content);
        assert.deepEqual(f.calls.map(call => call.url), [MRPACK_GITHUB_URL, target]);
        assert.deepEqual(f.lookupCalls, ['github.com', host]);
        assert.equal(f.responses[0].bodyReads, 0);
        assert.deepEqual(await partialFiles(f.cache.root), []);
      } finally { await f.cleanup(); }
    });
  }
});

async function assertNoMrpackPublication(f, content) {
  assert.deepEqual(await partialFiles(f.cache.root), []);
  await assert.rejects(fs.stat(f.cache.pathForSha256(digest(content, 'sha256'))), error => error.code === 'ENOENT');
}

function redactedMrpackFailure(error, code = 'INVALID_RELEASE_URL') {
  assert.equal(error.code, code);
  const rendered = JSON.stringify({ message: error.message, details: error.details, public: error.toPublicResult() });
  assert.doesNotMatch(rendered, /fixture-secret|signed-secret|user-secret|password-secret|https:|upstream-secret/);
  return true;
}

test('MRPACK GitHub redirects reject disallowed targets before their DNS or request and redact secrets', async t => {
  const content = Buffer.from('rejected redirect bytes');
  const targets = [
    'https://release-assets.githubusercontent.com.evil.example/asset?token=signed-secret',
    'https://cdn.release-assets.githubusercontent.com/asset?token=signed-secret',
    'https://api.github.com/asset?token=signed-secret', 'https://evil.example/asset?token=signed-secret',
    'http://release-assets.githubusercontent.com/asset?token=signed-secret',
    'https://user-secret:password-secret@release-assets.githubusercontent.com/asset?token=signed-secret',
    'https://release-assets.githubusercontent.com:444/asset?token=signed-secret',
    'https://127.0.0.1/asset?token=signed-secret'
  ];
  for (const [side, builder] of [['client', buildMrpackClientPlan], ['server', buildMrpackServerPlan]]) {
    for (const [index, target] of targets.entries()) await t.test(`${side}: target ${index}`, async () => {
      const f = await mrpackRedirectFixture(new Map([
        [MRPACK_GITHUB_URL, { statusCode: 302, headers: { location: target }, body: Buffer.from('upstream-secret') }],
        [target, { body: content }]
      ]));
      try {
        await assert.rejects(f.downloader.downloadPart(mrpackDownload(builder, content)), redactedMrpackFailure);
        assert.deepEqual(f.calls.map(call => call.url), [MRPACK_GITHUB_URL]);
        assert.deepEqual(f.lookupCalls, ['github.com']);
        assert.equal(f.responses[0].bodyReads, 0);
        await assertNoMrpackPublication(f, content);
      } finally { await f.cleanup(); }
    });
  }
});

test('MRPACK non-GitHub initial downloads cannot acquire CDN authority from mirrors or later GitHub hops', async t => {
  const content = Buffer.from('non-GitHub authority bytes');
  const target = 'https://objects.githubusercontent.com/asset?token=signed-secret';
  for (const [side, builder] of [['client', buildMrpackClientPlan], ['server', buildMrpackServerPlan]]) {
    for (const host of ['cdn.modrinth.com', 'raw.githubusercontent.com', 'gitlab.com', 'github.com.']) {
      for (const viaGithub of [false, true]) await t.test(`${side}: ${host} ${viaGithub ? 'via GitHub' : 'direct'}`, async () => {
        const initial = `https://${host}/example.jar`;
        const f = await mrpackRedirectFixture(new Map([
          [initial, { statusCode: 302, headers: { location: viaGithub ? MRPACK_GITHUB_URL : target } }],
          [MRPACK_GITHUB_URL, { statusCode: 302, headers: { location: target } }],
          [target, { body: content }]
        ]));
        try {
          const download = mrpackDownload(builder, content, { url: initial, candidates: [MRPACK_GITHUB_URL] });
          await assert.rejects(f.downloader.downloadPart(download), error => {
            assert.equal(error.details.reasonCode, 'host-not-allowed');
            return redactedMrpackFailure(error);
          });
          assert.deepEqual(f.calls.map(call => call.url), viaGithub ? [initial, MRPACK_GITHUB_URL] : [initial]);
          assert.deepEqual(f.lookupCalls, viaGithub ? [host, 'github.com'] : [host]);
          await assertNoMrpackPublication(f, content);
        } finally { await f.cleanup(); }
      });
    }
  }
});

test('MRPACK admitted CDN hops still reject a disallowed later redirect with no publication', async t => {
  const content = Buffer.from('chained authority bytes');
  const cdn = 'https://github-releases.githubusercontent.com/asset?token=fixture-secret';
  const denied = 'https://evil.example/asset?token=signed-secret';
  for (const [side, builder] of [['client', buildMrpackClientPlan], ['server', buildMrpackServerPlan]]) await t.test(side, async () => {
    const f = await mrpackRedirectFixture(new Map([
      [MRPACK_GITHUB_URL, { statusCode: 302, headers: { location: cdn } }],
      [cdn, { statusCode: 302, headers: { location: denied } }], [denied, { body: content }]
    ]));
    try {
      await assert.rejects(f.downloader.downloadPart(mrpackDownload(builder, content)), redactedMrpackFailure);
      assert.deepEqual(f.calls.map(call => call.url), [MRPACK_GITHUB_URL, cdn]);
      assert.deepEqual(f.lookupCalls, ['github.com', 'github-releases.githubusercontent.com']);
      await assertNoMrpackPublication(f, content);
    } finally { await f.cleanup(); }
  });
});

test('MRPACK redirected bytes retain independent SHA-1 SHA-512 and measured-size enforcement', async t => {
  const content = Buffer.from('dual hash CDN content');
  const target = 'https://release-assets.githubusercontent.com/asset?token=fixture-secret';
  for (const [side, builder] of [['client', buildMrpackClientPlan], ['server', buildMrpackServerPlan]]) {
    for (const [name, options, headers, algorithm] of [
      ['sha1 mismatch', { hashes: { sha1: 'a'.repeat(40), sha512: digest(content, 'sha512') } }, {}, 'sha1'],
      ['sha512 mismatch', { hashes: { sha1: digest(content, 'sha1'), sha512: 'b'.repeat(128) } }, {}, 'sha512'],
      ['short body', { fileSize: content.length + 1 }, {}],
      ['long body', { fileSize: content.length - 1 }, {}],
      ['declared size mismatch', {}, { 'content-length': String(content.length + 1) }]
    ]) await t.test(`${side}: ${name}`, async () => {
      const f = await mrpackRedirectFixture(new Map([
        [MRPACK_GITHUB_URL, { statusCode: 302, headers: { location: target } }], [target, { body: content, headers }]
      ]));
      try {
        await assert.rejects(f.downloader.downloadPart(mrpackDownload(builder, content, options)), error => {
          assert.equal(error.details?.algorithm, algorithm);
          return redactedMrpackFailure(error, 'HASH_MISMATCH');
        });
        assert.deepEqual(f.calls.map(call => call.url), [MRPACK_GITHUB_URL, target]);
        await assertNoMrpackPublication(f, content);
      } finally { await f.cleanup(); }
    });
  }
});

test('MRPACK abort after a redirected CDN body chunk destroys the response and removes partials', { timeout: 2000 }, async t => {
  const content = Buffer.from('cancelled CDN content');
  const target = 'https://objects.githubusercontent.com/asset?token=fixture-secret';
  for (const [side, builder] of [['client', buildMrpackClientPlan], ['server', buildMrpackServerPlan]]) await t.test(side, async () => {
    const controller = new AbortController(); const body = new PassThrough(); const progress = [];
    const f = await mrpackRedirectFixture(new Map([
      [MRPACK_GITHUB_URL, { statusCode: 302, headers: { location: target } }], [target, { response: body }]
    ]));
    try {
      const pending = f.downloader.downloadPart(mrpackDownload(builder, content), {
        signal: controller.signal, onProgress(event) { progress.push(event); controller.abort(); }
      });
      body.write(content.subarray(0, 3));
      await assert.rejects(pending, error => redactedMrpackFailure(error, 'CANCELLED'));
      assert.deepEqual(progress.map(event => event.partBytes), ['3']);
      assert.equal(body.destroyed, true);
      assert.deepEqual(f.calls.map(call => call.url), [MRPACK_GITHUB_URL, target]);
      await assertNoMrpackPublication(f, content);
    } finally { body.destroy(); await f.cleanup(); }
  });
});

test('GitHub plans retain permanent IDs without caller-carried request policy', async () => {
  const { artifactPlan } = await issuedGitHubPlan(Buffer.from('issued plan bytes'));
  const plannedPart = artifactPlan.artifactSet.parts[0];
  assert.equal(plannedPart.providerAssetId, '301');
  assert.equal(Object.hasOwn(plannedPart, 'downloadUrl'), false);
  assert.equal(Object.hasOwn(plannedPart, 'allowedHosts'), false);
  assert.equal(Object.hasOwn(plannedPart, 'headers'), false);
});

test('GitHub downloads require the exact issued plan and derive canonical request policy', async () => {
  const content = Buffer.from('bound GitHub bytes');
  const { artifactPlan, downloadUrl } = await issuedGitHubPlan(content);
  const exact = await fixture({ responses: new Map([[downloadUrl, { body: content }]]) });
  try {
    const verified = await exact.downloader.downloadSet(artifactPlan, {});
    assert.equal(verified.type, 'verified-artifact-set');
    assert.equal(exact.requestCalls[0].url, downloadUrl);
    assert.deepEqual(exact.requestCalls[0].options.allowedHosts, [...GITHUB_ASSET_HOSTS]);
    assert.deepEqual(exact.requestCalls[0].options.headers, {
      Accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'Minecraft-Core'
    });
  } finally { await exact.cleanup(); }

  for (const candidate of [structuredClone(artifactPlan), {
    ...structuredClone(artifactPlan),
    sourceEvidence: structuredClone(artifactPlan.sourceEvidence)
  }]) {
    candidate.artifactSet.parts[0].downloadUrl = 'https://attacker.example/payload';
    candidate.artifactSet.parts[0].allowedHosts = ['attacker.example'];
    candidate.artifactSet.parts[0].headers = { Accept: 'application/octet-stream' };
    const forged = await fixture({ responses: new Map([['https://attacker.example/payload', { body: content }]]) });
    try {
      await assert.rejects(
        forged.downloader.downloadSet(candidate, {}),
        error => error.code === 'INVALID_REQUEST'
      );
      assert.equal(forged.requestCalls.length, 0);
    } finally { await forged.cleanup(); }
  }
});

test('missing published files identify only their safe filename and missing HTTP status', async t => {
  for (const statusCode of [404, 410]) await t.test(String(statusCode), async () => {
    const content = Buffer.from('expected');
    const url = 'https://cdn.example/private?token=secret';
    const f = await fixture({ responses: new Map([[url, { statusCode, body: Buffer.from('private upstream body') }]]) });
    try {
      const request = part(content, { url });
      delete request.fileName;
      request.targetPath = 'resourcepacks/midnight-ae2-30e7823.zip';
      await assert.rejects(f.downloader.downloadPart(request), error => {
        const result = error.toPublicResult();
        assert.equal(result.error.code, 'ARTIFACT_UNAVAILABLE');
        assert.deepEqual(result.error.details, { fileName: 'midnight-ae2-30e7823.zip', httpStatus: String(statusCode) });
        assert.equal(result.error.retryable, false);
        assert.doesNotMatch(JSON.stringify(result), /secret|private|https:|resourcepacks/);
        return true;
      });
      assert.deepEqual(await partialFiles(f.cache.root), []);
    } finally { await f.cleanup(); }
  });
});

test('GitHub asset rate limits are retryable while unrelated forbidden responses stay redacted', async t => {
  const content = Buffer.from('rate-limited GitHub bytes');
  const { artifactPlan, downloadUrl } = await issuedGitHubPlan(content);
  for (const [name, response, expectedCode, expectedRetryable] of [
    ['exhausted primary quota', { statusCode: 403, headers: { 'x-ratelimit-remaining': '0' } }, 'RATE_LIMITED', true],
    ['explicit too-many-requests response', { statusCode: 429 }, 'RATE_LIMITED', true],
    ['unrelated forbidden response', { statusCode: 403, headers: { 'x-ratelimit-remaining': '12' } }, 'INVALID_RELEASE_URL', false]
  ]) await t.test(name, async () => {
    const f = await fixture({ responses: new Map([[downloadUrl, response]]) });
    try {
      await assert.rejects(f.downloader.downloadSet(artifactPlan, {}), error => {
        const publicText = JSON.stringify(error.toPublicResult());
        return error.code === expectedCode && error.retryable === expectedRetryable &&
          !publicText.includes(downloadUrl) && !publicText.includes('github.com');
      });
      assert.deepEqual(await partialFiles(f.cache.root), []);
    } finally { await f.cleanup(); }
  });
});

test('GitHub SHA-256 is verified while local SHA-256 and SHA-512 are always recorded', async () => {
  const content = Buffer.from('github content'); const { artifactPlan, downloadUrl: url } = await issuedGitHubPlan(content);
  const f = await fixture({ responses: new Map([[url, { body: content, headers: { 'content-length': String(content.length) } }]]) });
  try {
    const result = await f.downloader.downloadSet(artifactPlan, {});
    assert.equal(result.type, 'verified-artifact-set');
    const verified = result.artifactSet.parts[0];
    assert.equal(verified.calculatedDigests.sha256, digest(content, 'sha256'));
    assert.equal(verified.calculatedDigests.sha512, digest(content, 'sha512'));
    assert.equal(await fs.readFile(f.cache.pathForSha256(verified.calculatedDigests.sha256), 'utf8'), content.toString());
  } finally { await f.cleanup(); }
});

test('standalone or forged GitHub requests cannot bypass issued-plan provenance', async () => {
  const content = Buffer.from('github restricted digest');
  const p = part(content, { provider: 'github', algorithm: 'sha256' });
  const f = await fixture({ responses: new Map([[p.downloadUrl, { body: content }]]) });
  try {
    await assert.rejects(f.downloader.downloadPart(p, {}), error => error.code === 'INVALID_REQUEST');
    await assert.rejects(f.downloader.downloadSet(plan('github', [p]), {}), error => error.code === 'INVALID_REQUEST');
    assert.equal(f.requestCalls.length, 0);
  } finally { await f.cleanup(); }
});

test('Modrinth requires a provider digest while GitHub reports a safe missing-digest warning', async () => {
  const content = Buffer.from('provider bytes');
  const { artifactPlan, downloadUrl: url } = await issuedGitHubPlan(content, { includeDigest: false });
  const modrinthUrl = 'https://cdn.example/no-digest';
  const f = await fixture({ responses: new Map([[url, { body: content }], [modrinthUrl, { body: content }]]) });
  try {
    await assert.rejects(f.downloader.downloadSet(plan('modrinth', [part(content, { provider: 'modrinth', url: modrinthUrl })]), {}), error => error.code === 'MISSING_PROVIDER_DIGEST' && error.details.partId === 'part-1');
    const result = await f.downloader.downloadSet(artifactPlan, {});
    assert.deepEqual(result.warnings, [{ code: 'MISSING_PROVIDER_DIGEST', partId: 'asset-301' }]);
    assert.equal(result.type, 'verified-artifact-set');
  } finally { await f.cleanup(); }
});

test('downloaded artifact sets retain app-issued authenticity after warnings are attached', async () => {
  const content = Buffer.from('archive inspection boundary');
  const { artifactPlan, downloadUrl } = await issuedGitHubPlan(content, { includeDigest: false });
  const f = await fixture({ responses: new Map([[downloadUrl, { body: content }]]) });
  try {
    const result = await f.downloader.downloadSet(artifactPlan, {});
    assert.equal(isAppIssuedVerifiedArtifactSet(result), true);
  } finally { await f.cleanup(); }
});

test('digest mismatch blocks cache publication and removes the partial', async () => {
  const content = Buffer.from('tampered'); const p = part(content, { algorithm: 'sha256', value: 'a'.repeat(64) });
  const f = await fixture({ responses: new Map([[p.downloadUrl, { body: content }]]) });
  try {
    await assert.rejects(f.downloader.downloadSet(plan('local', [p]), {}), error => error.code === 'HASH_MISMATCH' && error.details.algorithm === 'sha256');
    assert.deepEqual(await partialFiles(f.cache.root), []);
  } finally { await f.cleanup(); }
});

test('declared content length over the cumulative set budget is rejected before body consumption', async () => {
  let reads = 0; const url = 'https://cdn.example/declared';
  const source = new Readable({ read() { reads += 1; this.push(Buffer.from('12345')); this.push(null); } }); source.statusCode = 200; source.headers = { 'content-length': '5' };
  const f = await fixture({ maxSetBytes: 4n, responses: new Map([[url, () => source]]) });
  try {
    await assert.rejects(f.downloader.downloadSet(plan('local', [part(Buffer.from('1234'), { url })]), {}), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
    assert.equal(reads, 0); assert.deepEqual(await partialFiles(f.cache.root), []);
  } finally { await f.cleanup(); }
});

test('chunked measured bytes cannot exceed the cumulative set budget', async () => {
  const content = Buffer.from('12345'); const p = part(content); const f = await fixture({ maxSetBytes: 4n, responses: new Map([[p.downloadUrl, { chunks: [Buffer.from('12'), Buffer.from('345')] }]]) });
  try {
    await assert.rejects(f.downloader.downloadSet(plan('local', [p]), {}), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
    assert.deepEqual(await partialFiles(f.cache.root), []);
  } finally { await f.cleanup(); }
});

test('planned bytes over the set budget fail before any request', async () => {
  const content = Buffer.from('12345'); const p = part(content); const f = await fixture({ maxSetBytes: 4n, responses: new Map([[p.downloadUrl, { body: content }]]) });
  try {
    await assert.rejects(f.downloader.downloadSet(plan('local', [p]), {}), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
    assert.equal(f.requestCalls.length, 0);
  } finally { await f.cleanup(); }
});

test('chunked bytes beyond the reviewed part size fail immediately below the global limit', async () => {
  const reviewed = Buffer.from('abc'); const p = part(reviewed); const events = [];
  const f = await fixture({ maxSetBytes: 100n, responses: new Map([[p.downloadUrl, { chunks: [Buffer.from('ab'), Buffer.from('cd')] }]]) });
  try {
    await assert.rejects(f.downloader.downloadSet(plan('local', [p]), { onProgress: event => events.push(event) }), error => error.code === 'HASH_MISMATCH');
    assert.deepEqual(events.map(event => event.partBytes), ['2']);
  } finally { await f.cleanup(); }
});

test('a body shorter than the reviewed size fails verification and is cleaned up', async () => {
  const content = Buffer.from('abc'); const p = part(content, { size: '5' }); const f = await fixture({ responses: new Map([[p.downloadUrl, { body: content, headers: { 'content-length': '5' } }]]) });
  try {
    await assert.rejects(f.downloader.downloadSet(plan('local', [p]), {}), error => error.code === 'HASH_MISMATCH');
    assert.deepEqual(await partialFiles(f.cache.root), []);
  } finally { await f.cleanup(); }
});

test('abort and response stream errors close and remove controlled partials', async t => {
  await t.test('abort', async () => {
    const controller = new AbortController(); const url = 'https://cdn.example/abort'; const stream = new PassThrough(); stream.statusCode = 200; stream.headers = {};
    const f = await fixture({ responses: new Map([[url, () => stream]]) });
    try {
      const promise = f.downloader.downloadSet(plan('local', [part(Buffer.from('abcdef'), { url })]), { signal: controller.signal, onProgress: () => controller.abort() });
      stream.write('abc');
      await assert.rejects(promise, error => error.code === 'CANCELLED');
      assert.deepEqual(await partialFiles(f.cache.root), []);
    } finally { stream.destroy(); await f.cleanup(); }
  });
  await t.test('stream error', async () => {
    const url = 'https://cdn.example/error';
    const f = await fixture({ responses: new Map([[url, () => {
      const stream = Readable.from((async function * failingBody() { yield Buffer.from('abc'); throw new Error('provider-body-secret'); })());
      stream.statusCode = 200; stream.headers = {}; return stream;
    }]]) });
    try {
      await assert.rejects(f.downloader.downloadSet(plan('local', [part(Buffer.from('abcdef'), { url })]), {}));
      assert.deepEqual(await partialFiles(f.cache.root), []);
    } finally { await f.cleanup(); }
  });
});

test('concurrent identical downloads survive cache publication races', async () => {
  const content = Buffer.from('same bytes'); const p = part(content, { algorithm: 'sha256' }); let n = 0;
  const f = await fixture({ responses: new Map([[p.downloadUrl, () => { const response = Readable.from([content]); response.statusCode = 200; response.headers = {}; return response; }]]), randomUUID: () => `unique-${++n}` });
  try {
    const [a, b] = await Promise.all([f.downloader.downloadSet(plan('local', [p]), {}), f.downloader.downloadSet(plan('local', [p]), {})]);
    assert.equal(a.artifactSet.parts[0].calculatedDigests.sha256, b.artifactSet.parts[0].calculatedDigests.sha256);
    assert.equal(await fs.readFile(f.cache.pathForSha256(digest(content, 'sha256')), 'utf8'), content.toString());
    assert.deepEqual(await partialFiles(f.cache.root), []);
  } finally { await f.cleanup(); }
});

test('progress reports measured part and cumulative set bytes as decimal strings', async () => {
  const one = Buffer.from('abc'); const two = Buffer.from('de'); const p1 = part(one, { id: 'one', url: 'https://cdn.example/one', algorithm: 'sha256' }); const p2 = part(two, { id: 'two', url: 'https://cdn.example/two', algorithm: 'sha256' });
  const f = await fixture({ responses: new Map([[p1.downloadUrl, { chunks: [Buffer.from('a'), Buffer.from('bc')] }], [p2.downloadUrl, { body: two }]]) }); const events = [];
  try {
    await f.downloader.downloadSet(plan('local', [p1, p2]), { onProgress: event => events.push(event) });
    assert.deepEqual(events.map(({ partId, partBytes, setBytes, totalBytes }) => ({ partId, partBytes, setBytes, totalBytes })), [
      { partId: 'one', partBytes: '1', setBytes: '1', totalBytes: '5' }, { partId: 'one', partBytes: '3', setBytes: '3', totalBytes: '5' }, { partId: 'two', partBytes: '2', setBytes: '5', totalBytes: '5' }
    ]);
  } finally { await f.cleanup(); }
});

test('download failures never expose URL queries, secrets, or provider bodies through ModpackError', async () => {
  const url = 'https://cdn.example/file?token=top-secret'; const failure = new Error(`request failed ${url} provider-private-body`); const f = await fixture({ responses: new Map([[url, failure]]) });
  try {
    await assert.rejects(f.downloader.downloadSet(plan('local', [part(Buffer.from('x'), { url })]), {}), error => {
      const rendered = JSON.stringify({ message: error.message, details: error.details, public: error.toPublicResult?.() });
      return !rendered.includes('top-secret') && !rendered.includes('provider-private-body') && !rendered.includes('https://');
    });
  } finally { await f.cleanup(); }
});

test('download sources require an explicit host allowlist instead of trusting their own URL host', async () => {
  const content = Buffer.from('x'); const p = part(content); const reviewed = plan('local', [p]); delete reviewed.artifactSet.parts[0].allowedHosts;
  const f = await fixture({ responses: new Map([[p.downloadUrl, { body: content }]]) });
  try {
    await assert.rejects(f.downloader.downloadSet(reviewed, {}), error => error.code === 'INVALID_REQUEST');
  } finally { await f.cleanup(); }
});

test('standalone part progress uses reviewed size and returns no cache path or source metadata', async () => {
  const content = Buffer.from('standalone'); const p = part(content, { algorithm: 'sha256' }); const events = [];
  const f = await fixture({ responses: new Map([[p.downloadUrl, { body: content }]]) });
  try {
    const result = await f.downloader.downloadPart(p, { onProgress: event => events.push(event) });
    assert.deepEqual(Object.keys(result).sort(), ['measuredSize', 'partId', 'sha256', 'sha512']);
    assert.equal(events.at(-1).totalBytes, String(content.length));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(f.root), false);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes('allowedHosts'), false);
    assert.equal(Object.isFrozen(result), true);
  } finally { await f.cleanup(); }
});

test('standalone parts reject unsafe canonical identifiers before network access or DTO creation', async () => {
  const content = Buffer.from('unsafe id bytes');
  const unsafeIds = [
    'part?token=top-secret',
    '../escape',
    'folder\\escape',
    'part\r\ncontrol',
    `a${'b'.repeat(128)}`
  ];
  for (const partId of unsafeIds) {
    const p = { ...part(content, { algorithm: 'sha256' }), partId };
    const f = await fixture({ responses: new Map([[p.downloadUrl, { body: content }]]) });
    try {
      const outcome = await f.downloader.downloadPart(p, {}).then(value => ({ value }), error => ({ error }));
      assert.equal(outcome.value, undefined, partId);
      assert.equal(outcome.error?.code, 'INVALID_REQUEST', partId);
      assert.equal(f.requestCalls.length, 0, partId);
      const publicText = JSON.stringify(outcome.error.toPublicResult());
      assert.equal(publicText.includes(partId), false, partId);
      assert.equal(publicText.includes('top-secret'), false, partId);
      assert.equal(publicText.includes('?'), false, partId);
      assert.equal(publicText.includes('..'), false, partId);
    } finally { await f.cleanup(); }
  }
});

function modrinthPart(content, overrides = {}) {
  const sha512 = digest(content, 'sha512');
  return part(content, {
    provider: 'modrinth', algorithm: 'sha512', value: sha512, ...overrides
  });
}

test('Modrinth requires transient SHA-1 and SHA-512 plus matching authoritative SHA-512', async t => {
  const content = Buffer.from('modrinth dual integrity'); const sha1 = digest(content, 'sha1'); const sha512 = digest(content, 'sha512');
  const cases = [
    ['missing sha1', { sha512 }, 'MISSING_PROVIDER_DIGEST'],
    ['missing sha512', { sha1 }, 'MISSING_PROVIDER_DIGEST'],
    ['mismatched authoritative sha512', { sha1, sha512 }, 'INVALID_REQUEST', { providerDigest: { algorithm: 'sha512', value: 'a'.repeat(128) } }]
  ];
  for (const [name, requiredProviderDigests, code, extra = {}] of cases) await t.test(name, async () => {
    const p = { ...modrinthPart(content), ...extra, requiredProviderDigests }; const f = await fixture({ responses: new Map([[p.downloadUrl, { body: content }]]) });
    try { await assert.rejects(f.downloader.downloadSet(plan('modrinth', [p]), {}), error => error.code === code); }
    finally { await f.cleanup(); }
  });
});

test('Modrinth verifies SHA-1 and SHA-512 independently', async t => {
  const content = Buffer.from('modrinth verified bytes'); const sha1 = digest(content, 'sha1'); const sha512 = digest(content, 'sha512');
  for (const [name, requiredProviderDigests, algorithm] of [
    ['sha1 mismatch', { sha1: 'a'.repeat(40), sha512 }, 'sha1'],
    ['sha512 mismatch', { sha1, sha512: 'b'.repeat(128) }, 'sha512']
  ]) await t.test(name, async () => {
    const p = modrinthPart(content); p.requiredProviderDigests = requiredProviderDigests;
    if (algorithm === 'sha512') p.providerDigest = { algorithm: 'sha512', value: requiredProviderDigests.sha512 };
    const f = await fixture({ responses: new Map([[p.downloadUrl, { body: content }]]) });
    try { await assert.rejects(f.downloader.downloadSet(plan('modrinth', [p]), {}), error => error.code === 'HASH_MISMATCH' && error.details.algorithm === algorithm); }
    finally { await f.cleanup(); }
  });
});

test('matching Modrinth dual digests verify without persisting transient source metadata', async () => {
  const content = Buffer.from('modrinth matching bytes'); const p = modrinthPart(content);
  p.requiredProviderDigests = { sha1: digest(content, 'sha1'), sha512: digest(content, 'sha512') };
  const f = await fixture({ responses: new Map([[p.downloadUrl, { body: content }]]) });
  try {
    const result = await f.downloader.downloadSet(plan('modrinth', [p]), {});
    assert.equal(result.type, 'verified-artifact-set');
    assert.equal(JSON.stringify(result).includes('requiredProviderDigests'), false);
    assert.match(computePlanFingerprint(result), /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(result.artifactSet.parts[0]).sort(), ['calculatedDigests', 'fileName', 'measuredSize', 'partId', 'providerDigest', 'size']);
  } finally { await f.cleanup(); }
});
