const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MODRINTH_ARTIFACT_HOSTS,
  ModrinthModpackProvider
} = require('../../electron/services/modpacks/providers/modrinth-modpack-provider.cjs');

function jsonResponse(value, statusCode = 200) {
  return { statusCode, body: Buffer.from(JSON.stringify(value), 'utf8') };
}

function makeHttp(routes) {
  const calls = [];
  return {
    calls,
    get requestedPaths() { return calls.map(({ path }) => path); },
    async request(path, options = {}) {
      calls.push({ path, options });
      const route = routes[path];
      if (route instanceof Error) throw route;
      if (typeof route === 'function') return route(options);
      if (!route) throw new Error(`Unplanned request: ${path}`);
      return route;
    }
  };
}

function version(overrides = {}) {
  return {
    id: 'version-exact',
    project_id: 'project-exact',
    author_id: 'author-1',
    name: 'Server release',
    version_number: '2.0.0',
    changelog: 'Changes',
    version_type: 'release',
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    featured: true,
    status: 'listed',
    requested_status: null,
    date_published: '2026-07-01T02:03:04.000Z',
    downloads: 42,
    files: [{
      hashes: { sha1: '1'.repeat(40), sha512: '5'.repeat(128) },
      url: 'https://cdn.modrinth.com/data/project-exact/versions/version-exact/server.mrpack',
      filename: 'server.mrpack',
      primary: true,
      size: 1234,
      file_type: 'required-resource-pack'
    }],
    dependencies: [],
    ...overrides
  };
}

test('search serializes Modrinth modpack facets, paging, compatibility, and supported sorts', async () => {
  const http = makeHttp({
    '/search': jsonResponse({ hits: [], offset: 20, limit: 25, total_hits: 0 })
  });
  const provider = new ModrinthModpackProvider({ http });

  assert.deepEqual(await provider.searchProjects({
    query: 'factory',
    categories: ['technology', 'adventure'],
    gameVersion: '1.21.1',
    loader: 'fabric',
    channel: 'release',
    serverCompatibility: 'compatible',
    sort: 'downloads',
    offset: 20,
    limit: 25
  }), { items: [], pagination: { offset: 20, limit: 25, total: 0 } });

  assert.equal(http.calls[0].path, '/search');
  assert.deepEqual(http.calls[0].options.query, {
    query: 'factory',
    facets: JSON.stringify([
      ['project_type:modpack'],
      ['categories:technology', 'categories:adventure'],
      ['versions:1.21.1'],
      ['categories:fabric'],
      ['server_side:required', 'server_side:optional']
    ]),
    index: 'downloads',
    offset: '20',
    limit: '25'
  });
});

test('search preserves exact project IDs and derives server-side compatibility without trusting media URLs', async () => {
  const http = makeHttp({
    '/search': jsonResponse({
      hits: [{
        project_id: 'project-7', slug: 'factory-pack', title: 'Factory Pack', description: 'Build things',
        categories: ['fabric', 'technology'], display_categories: ['technology'], versions: ['1.21.1'],
        client_side: 'required', server_side: 'optional', downloads: 9001,
        icon_url: 'https://images.example/icon.png', gallery: ['https://images.example/gallery.png'],
        date_modified: '2026-07-02T03:04:05.000Z'
      }],
      offset: 0, limit: 10, total_hits: 1
    })
  });
  const provider = new ModrinthModpackProvider({ http });

  const result = await provider.searchProjects({ sort: 'updated', offset: 0, limit: 10 });
  assert.deepEqual(result, {
    items: [{
      projectId: 'project-7', slug: 'factory-pack', title: 'Factory Pack', summary: 'Build things',
      iconUrlCandidate: 'https://images.example/icon.png', galleryUrlCandidates: ['https://images.example/gallery.png'],
      categories: ['fabric', 'technology'], minecraftVersions: ['1.21.1'], loaders: ['fabric'],
      serverCompatibility: 'optional', updatedAt: '2026-07-02T03:04:05.000Z', downloads: 9001
    }],
    pagination: { offset: 0, limit: 10, total: 1 }
  });
  assert.equal(http.calls[0].options.query.index, 'updated');
  assert.deepEqual(JSON.parse(http.calls[0].options.query.facets), [['project_type:modpack']]);
});

test('project detail uses the exact endpoint and keeps gallery and upstream links as untrusted candidates', async () => {
  const http = makeHttp({
    '/project/project-exact': jsonResponse({
      id: 'project-exact', slug: 'exact-pack', project_type: 'modpack', title: 'Exact Pack',
      description: 'Summary', body: '# Long body', icon_url: 'https://untrusted.example/icon',
      gallery: [{ url: 'https://untrusted.example/one', featured: true, title: 'One', description: 'Caption', created: '2026-01-01T00:00:00.000Z', ordering: 0 }],
      game_versions: ['1.20.1'], loaders: ['forge'], client_side: 'required', server_side: 'required',
      updated: '2026-06-01T00:00:00.000Z', downloads: 100,
      source_url: 'https://github.com/example/repo', issues_url: 'https://tracker.example/issues',
      wiki_url: null, discord_url: 'https://discord.example/invite', donation_urls: [{ id: 'custom', platform: 'Sponsor', url: 'https://pay.example' }]
    })
  });
  const provider = new ModrinthModpackProvider({ http });

  assert.deepEqual(await provider.getProject('project-exact'), {
    projectId: 'project-exact', slug: 'exact-pack', title: 'Exact Pack', summary: 'Summary', body: '# Long body',
    iconUrlCandidate: 'https://untrusted.example/icon',
    galleryCandidates: [{ urlCandidate: 'https://untrusted.example/one', featured: true, title: 'One', description: 'Caption' }],
    runtimes: { minecraftVersions: ['1.20.1'], loaders: ['forge'] }, serverCompatibility: 'required',
    updatedAt: '2026-06-01T00:00:00.000Z', downloads: 100,
    upstreamLinkCandidates: [
      { kind: 'source', urlCandidate: 'https://github.com/example/repo' },
      { kind: 'issues', urlCandidate: 'https://tracker.example/issues' },
      { kind: 'discord', urlCandidate: 'https://discord.example/invite' },
      { kind: 'donation', label: 'Sponsor', urlCandidate: 'https://pay.example' }
    ]
  });
  assert.deepEqual(http.requestedPaths, ['/project/project-exact']);
});

test('version listing preserves IDs, timestamps, and release beta alpha channels while filtering exact values', async () => {
  const http = makeHttp({
    '/project/project-exact/version': ({ query }) => {
      assert.deepEqual(query, { game_versions: '["1.21.1"]', loaders: '["fabric"]' });
      return jsonResponse([
        version({ id: 'release-id', version_type: 'release' }),
        version({ id: 'beta-id', version_type: 'beta', date_published: '2026-06-02T00:00:00.000Z' }),
        version({ id: 'alpha-id', version_type: 'alpha' })
      ]);
    }
  });
  const provider = new ModrinthModpackProvider({ http });

  const result = await provider.listVersions({
    projectId: 'project-exact', gameVersions: ['1.21.1'], loaders: ['fabric'], channels: ['release', 'alpha']
  });
  assert.deepEqual(result.map(({ versionId, channel, publishedAt }) => ({ versionId, channel, publishedAt })), [
    { versionId: 'release-id', channel: 'release', publishedAt: '2026-07-01T02:03:04.000Z' },
    { versionId: 'alpha-id', channel: 'alpha', publishedAt: '2026-07-01T02:03:04.000Z' }
  ]);
});

test('execution resolves the selected Modrinth version and never latest', async () => {
  const http = makeHttp({ '/version/version-exact': jsonResponse(version()) });
  const provider = new ModrinthModpackProvider({ http });

  await provider.resolveArtifactSetPlan('version-exact');
  assert.deepEqual(http.requestedPaths, ['/version/version-exact']);
});

test('artifact resolution selects exactly one primary mrpack and binds file hashes size and timestamp', async () => {
  const http = makeHttp({ '/version/version-exact': jsonResponse(version()) });
  const provider = new ModrinthModpackProvider({ http });

  const plan = await provider.resolveArtifactSetPlan('version-exact');
  assert.equal(plan.type, 'artifact-set-plan');
  assert.equal(plan.provider, 'modrinth');
  assert.deepEqual(plan.project, { id: 'project-exact', slug: 'project-exact', title: 'project-exact' });
  assert.deepEqual(plan.release, {
    id: 'version-exact', version: '2.0.0', channel: 'release', publishedAt: '2026-07-01T02:03:04.000Z'
  });
  assert.deepEqual(plan.artifactSet.parts[0], {
    partId: `file-${'1'.repeat(40)}`,
    fileName: 'server.mrpack', size: '1234', updatedAt: '2026-07-01T02:03:04.000Z',
    providerDigest: { algorithm: 'sha512', value: '5'.repeat(128) },
    downloadUrl: 'https://cdn.modrinth.com/data/project-exact/versions/version-exact/server.mrpack',
    allowedHosts: ['cdn.modrinth.com'], allowSubdomains: false,
    requiredProviderDigests: { sha1: '1'.repeat(40), sha512: '5'.repeat(128) }
  });
  assert.deepEqual(MODRINTH_ARTIFACT_HOSTS, ['cdn.modrinth.com']);
});

test('artifact resolution rejects no-primary, first-file fallback, multiple primaries, and changed identity', async () => {
  for (const [files, code] of [
    [[{ ...version().files[0], primary: false }], 'NO_INSTALLABLE_ASSET'],
    [[{ ...version().files[0], filename: 'readme.txt' }], 'NO_INSTALLABLE_ASSET'],
    [[version().files[0], { ...version().files[0], filename: 'second.mrpack' }], 'ASSET_AMBIGUOUS']
  ]) {
    const provider = new ModrinthModpackProvider({ http: makeHttp({ '/version/version-exact': jsonResponse(version({ files })) }) });
    await assert.rejects(provider.resolveArtifactSetPlan('version-exact'), error => error.code === code);
  }

  const provider = new ModrinthModpackProvider({ http: makeHttp({
    '/version/version-exact': jsonResponse(version({ files: [{ ...version().files[0], size: 1235 }] }))
  }) });
  const changed = await provider.resolveArtifactSetPlan('version-exact');
  assert.equal(changed.artifactSet.parts[0].size, '1235');
  assert.notEqual(changed.artifactSet.setDigest, (await new ModrinthModpackProvider({ http: makeHttp({ '/version/version-exact': jsonResponse(version()) }) }).resolveArtifactSetPlan('version-exact')).artifactSet.setDigest);
});

test('provider rejects malformed and oversized bodies and normalizes offline and rate-limit failures safely', async () => {
  const malformed = new ModrinthModpackProvider({ http: makeHttp({ '/search': jsonResponse({ hits: 'secret-response', offset: 0, limit: 10, total_hits: 1 }) }) });
  await assert.rejects(malformed.searchProjects({ offset: 0, limit: 10 }), error => error.code === 'INVALID_REQUEST' && !String(error.message).includes('secret-response'));

  const oversized = new ModrinthModpackProvider({ maxResponseBytes: 32, http: makeHttp({ '/project/p': jsonResponse({ id: 'p', body: 'token='.padEnd(100, 'x') }) }) });
  await assert.rejects(oversized.getProject('p'), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED' && !String(error.message).includes('token'));

  const offline = new ModrinthModpackProvider({ http: makeHttp({ '/project/p': new Error('offline token=secret') }) });
  await assert.rejects(offline.getProject('p'), error => error.code === 'INVALID_RELEASE_URL' && error.retryable === true && !String(error.message).includes('secret'));

  const limited = new ModrinthModpackProvider({ http: makeHttp({ '/project/p': jsonResponse({ error: 'token=secret' }, 429) }) });
  await assert.rejects(limited.getProject('p'), error => error.code === 'INVALID_RELEASE_URL' && error.retryable === true && !String(error.message).includes('secret'));
});

test('provider validates request identifiers filters and paging before transport', async () => {
  const http = makeHttp({});
  const provider = new ModrinthModpackProvider({ http });
  await assert.rejects(provider.getVersion('../latest'), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(provider.searchProjects({ query: 'bad\u0001query', offset: 0, limit: 10 }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(provider.searchProjects({ sort: 'relevance', offset: -1, limit: 101 }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(provider.listVersions({ projectId: 'ok', channels: ['prerelease'] }), error => error.code === 'INVALID_REQUEST');
  assert.deepEqual(http.calls, []);
});
