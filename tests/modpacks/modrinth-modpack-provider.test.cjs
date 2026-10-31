const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { BoundedApiClient } = require('../../electron/services/modpacks/network/bounded-api-client.cjs');

const {
  MODRINTH_ARTIFACT_HOSTS,
  ModrinthModpackProvider
} = require('../../electron/services/modpacks/providers/modrinth-modpack-provider.cjs');

// Version history may be up to 16 MiB; every other Modrinth response keeps 2 MiB.
const HISTORY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_LIMIT_BYTES = 2 * 1024 * 1024;
const HISTORY_TOO_LARGE_MESSAGE = 'This modpack has too many versions to list here. Download its .mrpack file from Modrinth and use Local archive instead.';

function jsonResponse(value, statusCode = 200) {
  return { statusCode, body: Buffer.from(JSON.stringify(value), 'utf8') };
}

function paddedJson(value, size) {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  assert.ok(json.length <= size);
  const body = Buffer.alloc(size, 0x20);
  json.copy(body);
  return body;
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

function makeBoundedHistoryHttp(history) {
  const fullBody = jsonResponse(history).body;
  const lightBody = jsonResponse(history.map(({ changelog, ...metadata }) => metadata)).body;
  const calls = [];
  const responses = [];
  const http = new BoundedApiClient({
    baseUrl: 'https://api.modrinth.com/v2/',
    client: {
      async request(url) {
        const parsed = new URL(url);
        calls.push(parsed);
        assert.equal(parsed.pathname, '/v2/project/project-exact/version');
        const body = parsed.searchParams.get('include_changelog') === 'false' ? lightBody : fullBody;
        const response = Readable.from([body.subarray(0, 1024 * 1024), body.subarray(1024 * 1024)]);
        response.statusCode = 200;
        response.headers = {};
        responses.push(response);
        return response;
      }
    }
  });
  return { http, calls, responses, fullBody, lightBody };
}

function makeBoundedRoutesHttp(bodies) {
  const calls = [];
  const http = new BoundedApiClient({
    baseUrl: 'https://api.modrinth.com/v2/',
    client: {
      async request(url) {
        const parsed = new URL(url);
        const body = bodies[parsed.pathname.slice('/v2'.length)];
        if (!body) throw new Error(`Unplanned request: ${parsed.pathname}`);
        const response = Readable.from([body.subarray(0, 1024 * 1024), body.subarray(1024 * 1024)]);
        response.statusCode = 200;
        response.headers = {};
        calls.push({ path: parsed.pathname, response });
        return response;
      }
    }
  });
  return { http, calls };
}

function dependencies(count, seed) {
  return Array.from({ length: count }, (_, index) => ({
    version_id: `v${seed}-${index}`.padEnd(8, '0'), project_id: `p${index}`.padEnd(8, '0'), file_name: null, dependency_type: 'embedded'
  }));
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

function searchHit(overrides = {}) {
  return {
    project_id: 'project-exact', project_type: 'modpack', slug: 'exact-pack', title: 'Exact Pack', description: '',
    categories: ['fabric'], display_categories: ['fabric'], versions: ['1.21.1'], client_side: 'required',
    server_side: 'required', downloads: 1, icon_url: 'https://images.example/icon.png', gallery: [],
    date_modified: '2026-01-01T00:00:00.000Z', ...overrides
  };
}

function project(overrides = {}) {
  return {
    id: 'project-exact', project_type: 'modpack', slug: 'exact-pack', title: 'Exact Pack', description: '', body: '',
    icon_url: 'https://images.example/icon.png', gallery: [], game_versions: ['1.21.1'], loaders: ['fabric'],
    client_side: 'required', server_side: 'required', updated: '2026-01-01T00:00:00.000Z', downloads: 1,
    donation_urls: [], ...overrides
  };
}

test('optional icons preserve every mixed search hit in order and upstream pagination', async () => {
  const provider = new ModrinthModpackProvider({ http: makeHttp({ '/search': jsonResponse({
    hits: [searchHit({ project_id: 'first' }), searchHit({ project_id: 'empty-icon', icon_url: '' }), searchHit({ project_id: 'last' })],
    offset: 20, limit: 20, total_hits: 83
  }) }) });
  const result = await provider.searchProjects({ offset: 20, limit: 20 });
  assert.deepEqual(result.items.map(item => [item.projectId, item.iconUrlCandidate]), [
    ['first', 'https://images.example/icon.png'], ['empty-icon', null], ['last', 'https://images.example/icon.png']
  ]);
  assert.deepEqual(result.pagination, { offset: 20, limit: 20, total: 83 });
});

for (const [label, icon] of [['null', null], ['absent', undefined], ['empty', '']]) {
  for (const endpoint of ['search', 'project']) {
    test(`optional icons normalize ${label} to null in ${endpoint} metadata`, async () => {
      const provider = new ModrinthModpackProvider({ http: makeHttp({
        '/search': jsonResponse({ hits: [searchHit({ icon_url: icon })], offset: 0, limit: 20, total_hits: 1 }),
        '/project/project-exact': jsonResponse(project({ icon_url: icon }))
      }) });
      const result = endpoint === 'search' ? (await provider.searchProjects()).items[0] : await provider.getProject('project-exact');
      assert.equal(result.iconUrlCandidate, null);
    });
  }
}

for (const [label, icon] of [['wrong type', 42], ['control character', 'https://images.example/\u0001'], ['overlong', 'x'.repeat(4097)]]) {
  test(`optional icons still reject ${label} in search and project metadata`, async () => {
    const provider = new ModrinthModpackProvider({ http: makeHttp({
      '/search': jsonResponse({ hits: [searchHit({ icon_url: icon })], offset: 0, limit: 20, total_hits: 1 }),
      '/project/project-exact': jsonResponse(project({ icon_url: icon }))
    }) });
    await assert.rejects(provider.searchProjects(), { code: 'INVALID_REQUEST' });
    await assert.rejects(provider.getProject('project-exact'), { code: 'INVALID_REQUEST' });
  });
}

test('optional icons preserve nonempty candidates at the existing 4096 character boundary', async () => {
  const icon = 'x'.repeat(4096);
  const provider = new ModrinthModpackProvider({ http: makeHttp({
    '/search': jsonResponse({ hits: [searchHit({ icon_url: icon })], offset: 0, limit: 20, total_hits: 1 }),
    '/project/project-exact': jsonResponse(project({ icon_url: icon }))
  }) });
  assert.equal((await provider.searchProjects()).items[0].iconUrlCandidate, icon);
  assert.equal((await provider.getProject('project-exact')).iconUrlCandidate, icon);
});

test('optional icons do not loosen required titles slugs galleries links or artifact URLs', async () => {
  for (const overrides of [{ title: '' }, { slug: '' }, { gallery: [''] }]) {
    const provider = new ModrinthModpackProvider({ http: makeHttp({ '/search': jsonResponse({
      hits: [searchHit({ icon_url: null, ...overrides })], offset: 0, limit: 20, total_hits: 1
    }) }) });
    await assert.rejects(provider.searchProjects(), { code: 'INVALID_REQUEST' });
  }
  for (const overrides of [{ title: '' }, { slug: '' }, { gallery: [{ url: '', featured: true }] }, { source_url: '' }]) {
    const provider = new ModrinthModpackProvider({ http: makeHttp({
      '/project/project-exact': jsonResponse(project({ icon_url: null, ...overrides }))
    }) });
    await assert.rejects(provider.getProject('project-exact'), { code: 'INVALID_REQUEST' });
  }
  const provider = new ModrinthModpackProvider({ http: makeHttp({
    '/version/version-exact': jsonResponse(version({ files: [{ ...version().files[0], url: '' }] }))
  }) });
  await assert.rejects(provider.resolveArtifactSetPlan('version-exact'), { code: 'INVALID_REQUEST' });
});

test('display galleries keep the first images instead of failing the catalog on a long gallery', async () => {
  // A live Modrinth project with 57 gallery images made every search page fail.
  const urls = Array.from({ length: 57 }, (_, index) => `https://cdn.modrinth.com/data/glade/images/${index}.webp`);
  const entries = Array.from({ length: 200 }, (_, index) => ({ url: `https://cdn.modrinth.com/data/glade/images/${index}.webp`, featured: index === 0 }));
  const provider = new ModrinthModpackProvider({ http: makeHttp({
    '/search': jsonResponse({ hits: [searchHit({ project_id: 'first' }), searchHit({ project_id: 'glade', gallery: urls })], offset: 0, limit: 20, total_hits: 2 }),
    '/project/project-exact': jsonResponse(project({ gallery: entries }))
  }) });
  const search = await provider.searchProjects();
  assert.deepEqual(search.items.map(item => item.projectId), ['first', 'glade']);
  assert.deepEqual(search.items[1].galleryUrlCandidates, urls.slice(0, 32));
  const detail = await provider.getProject('project-exact');
  assert.equal(detail.galleryCandidates.length, 128);
  assert.deepEqual(detail.galleryCandidates[127], { urlCandidate: entries[127].url, featured: false });
});

test('long Minecraft version lists do not fail the catalog, project or version metadata', async () => {
  const versions = Array.from({ length: 300 }, (_, index) => `1.${index}`);
  const provider = new ModrinthModpackProvider({ http: makeHttp({
    '/search': jsonResponse({ hits: [searchHit({ versions })], offset: 0, limit: 20, total_hits: 1 }),
    '/project/project-exact': jsonResponse(project({ game_versions: versions })),
    '/version/version-exact': jsonResponse(version({ game_versions: versions }))
  }) });
  assert.equal((await provider.searchProjects()).items[0].minecraftVersions.length, 300);
  assert.equal((await provider.getProject('project-exact')).runtimes.minecraftVersions.length, 300);
  assert.equal((await provider.getVersion('version-exact')).minecraftVersions.length, 300);

  const tooMany = Array.from({ length: 2049 }, (_, index) => `1.${index}`);
  const refusing = new ModrinthModpackProvider({ http: makeHttp({
    '/search': jsonResponse({ hits: [searchHit({ versions: tooMany })], offset: 0, limit: 20, total_hits: 1 })
  }) });
  await assert.rejects(refusing.searchProjects(), { code: 'INVALID_REQUEST' });
});

test('display galleries still reject malformed shown entries and non-list values', async () => {
  for (const gallery of [null, 'https://images.example/one.png', [...Array.from({ length: 31 }, () => 'https://images.example/ok.png'), '']]) {
    const provider = new ModrinthModpackProvider({ http: makeHttp({ '/search': jsonResponse({
      hits: [searchHit({ gallery })], offset: 0, limit: 20, total_hits: 1
    }) }) });
    await assert.rejects(provider.searchProjects(), { code: 'INVALID_REQUEST' });
  }
  for (const gallery of ['https://images.example/one.png', { url: 'https://images.example/one.png', featured: true }, [{ url: 'https://images.example/one.png', featured: 'yes' }]]) {
    const provider = new ModrinthModpackProvider({ http: makeHttp({ '/project/project-exact': jsonResponse(project({ gallery })) }) });
    await assert.rejects(provider.getProject('project-exact'), { code: 'INVALID_REQUEST' });
  }
});

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
        project_id: 'project-7', project_type: 'modpack', slug: 'factory-pack', title: 'Factory Pack', description: 'Build things',
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
      assert.deepEqual(query, { include_changelog: 'false', game_versions: '["1.21.1"]', loaders: '["fabric"]' });
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

test('version history omits unused changelogs to preserve every runtime loader channel and ordered ID within the byte limit', async () => {
  const runtimes = ['1.21.1', '1.20.1', '1.19.2'];
  const upstreamLoaders = ['minecraft', 'fabric', 'forge', 'neoforge', 'quilt'];
  const appLoaders = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'];
  const channels = ['release', 'beta', 'alpha'];
  // With changelogs this history is past the 16 MiB history bound; without them it fits.
  const history = Array.from({ length: 783 }, (_, index) => version({
    id: `history-${index}`, changelog: 'x'.repeat(24_000),
    game_versions: [runtimes[index % 3]], loaders: [upstreamLoaders[index % 5]],
    version_type: channels[index % 3]
  }));
  const transport = makeBoundedHistoryHttp(history);
  assert.ok(transport.fullBody.length > HISTORY_LIMIT_BYTES);
  assert.ok(transport.lightBody.length < HISTORY_LIMIT_BYTES);
  const provider = new ModrinthModpackProvider({ http: transport.http });

  const listed = await provider.listVersions({ projectId: 'project-exact' });
  assert.deepEqual(listed.map(item => [item.versionId, item.minecraftVersions, item.loaders, item.channel]),
    Array.from({ length: 783 }, (_, index) => [
      `history-${index}`, [runtimes[index % 3]], [appLoaders[index % 5]], channels[index % 3]
    ]));
  assert.ok(listed.every(item => item.changelog === null));
  assert.equal(transport.calls.length, 1);
  assert.deepEqual([...transport.calls[0].searchParams], [['include_changelog', 'false']]);
});

test('version history accepts a 5 MiB changelog-free history with hundreds of dependencies per version through the real bounded client', async () => {
  // Live Modrinth packs list hundreds of dependencies per version: Prominence II's
  // 106 versions came to 5,146 KB without changelogs, which failed at 2 MiB.
  const history = Array.from({ length: 106 }, (_, index) => version({
    id: `history-${index}`, changelog: null, dependencies: dependencies(520, index)
  }));
  const transport = makeBoundedHistoryHttp(history);
  assert.ok(transport.lightBody.length > 5 * 1024 * 1024);
  assert.ok(transport.lightBody.length < HISTORY_LIMIT_BYTES);
  const provider = new ModrinthModpackProvider({ http: transport.http });

  const listed = await provider.listVersions({ projectId: 'project-exact' });
  assert.deepEqual(listed.map(item => item.versionId), history.map(item => item.id));
  assert.equal(transport.calls.length, 1);
  assert.deepEqual([...transport.calls[0].searchParams], [['include_changelog', 'false']]);
});

test('version history rejects a still-oversized changelog-free response without a partial result or fallback', async () => {
  const history = Array.from({ length: 360 }, (_, index) => version({
    id: `history-${index}`, changelog: null, dependencies: dependencies(520, index)
  }));
  const transport = makeBoundedHistoryHttp(history);
  assert.ok(transport.lightBody.length > HISTORY_LIMIT_BYTES);
  const provider = new ModrinthModpackProvider({ http: transport.http });
  await assert.rejects(provider.listVersions({ projectId: 'project-exact' }), {
    code: 'ARCHIVE_LIMIT_EXCEEDED', message: HISTORY_TOO_LARGE_MESSAGE
  });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual([...transport.calls[0].searchParams], [['include_changelog', 'false']]);
  assert.equal(transport.responses[0].destroyed, true);
});

test('search, project and version responses keep the 2 MiB bound through the real bounded client', async () => {
  const bodies = size => ({
    '/search': paddedJson({ hits: [searchHit()], offset: 0, limit: 20, total_hits: 1 }, size),
    '/project/project-exact': paddedJson(project(), size),
    '/version/version-exact': paddedJson(version(), size)
  });
  const atLimit = new ModrinthModpackProvider({ http: makeBoundedRoutesHttp(bodies(DEFAULT_LIMIT_BYTES)).http });
  assert.equal((await atLimit.searchProjects()).items.length, 1);
  assert.equal((await atLimit.getProject('project-exact')).projectId, 'project-exact');
  assert.equal((await atLimit.getVersion('version-exact')).versionId, 'version-exact');

  const transport = makeBoundedRoutesHttp(bodies(DEFAULT_LIMIT_BYTES + 1));
  const provider = new ModrinthModpackProvider({ http: transport.http });
  for (const call of [() => provider.searchProjects(), () => provider.getProject('project-exact'), () => provider.getVersion('version-exact')]) {
    await assert.rejects(call(), { code: 'ARCHIVE_LIMIT_EXCEEDED', message: 'Provider response exceeded the configured byte limit' });
  }
  assert.deepEqual(transport.calls.map(({ path }) => path), ['/v2/search', '/v2/project/project-exact', '/v2/version/version-exact']);
  assert.ok(transport.calls.every(({ response }) => response.destroyed));
});

test('the provider re-checks the version history bound when its transport ignores per-request limits', async () => {
  for (const size of [3 * 1024 * 1024, HISTORY_LIMIT_BYTES]) {
    const http = makeHttp({ '/project/project-exact/version': { statusCode: 200, body: paddedJson([version({ changelog: undefined })], size) } });
    const listed = await new ModrinthModpackProvider({ http }).listVersions({ projectId: 'project-exact' });
    assert.deepEqual(listed.map(item => item.versionId), ['version-exact']);
    assert.deepEqual(http.calls[0].options, { query: { include_changelog: 'false' }, maxResponseBytes: HISTORY_LIMIT_BYTES });
  }
  for (const statusCode of [200, 404]) {
    const http = makeHttp({ '/project/project-exact/version': { statusCode, body: Buffer.alloc(HISTORY_LIMIT_BYTES + 1, 0x20) } });
    await assert.rejects(new ModrinthModpackProvider({ http }).listVersions({ projectId: 'project-exact' }), error =>
      error.code === 'ARCHIVE_LIMIT_EXCEEDED' && error.message === HISTORY_TOO_LARGE_MESSAGE &&
      error.details?.actual === String(HISTORY_LIMIT_BYTES + 1));
  }

  const oversized = { statusCode: 200, body: Buffer.alloc(DEFAULT_LIMIT_BYTES + 1, 0x20) };
  const http = makeHttp({ '/search': oversized, '/project/project-exact': oversized, '/version/version-exact': oversized });
  const provider = new ModrinthModpackProvider({ http });
  for (const call of [() => provider.searchProjects(), () => provider.getProject('project-exact'), () => provider.getVersion('version-exact')]) {
    await assert.rejects(call(), { code: 'ARCHIVE_LIMIT_EXCEEDED', message: 'Modrinth response exceeded the configured byte limit' });
  }
  assert.ok(http.calls.every(({ options }) => options.maxResponseBytes === undefined));
});

test('version history lists up to 5000 versions and refuses 5001 rather than returning a truncated success', async () => {
  // Live packs such as Optimizationn already publish 1,501 versions.
  const accepted = Array.from({ length: 5000 }, (_, index) => version({ id: `history-${index}`, changelog: undefined }));
  const listed = await new ModrinthModpackProvider({ http: makeHttp({ '/project/project-exact/version': jsonResponse(accepted) }) })
    .listVersions({ projectId: 'project-exact' });
  assert.equal(listed.length, 5000);
  assert.equal(listed[4999].versionId, 'history-4999');

  const history = Array.from({ length: 5001 }, (_, index) => version({ id: `history-${index}`, changelog: undefined }));
  const http = makeHttp({ '/project/project-exact/version': jsonResponse(history) });
  const provider = new ModrinthModpackProvider({ http });
  await assert.rejects(provider.listVersions({ projectId: 'project-exact' }), { code: 'ARCHIVE_LIMIT_EXCEEDED', message: HISTORY_TOO_LARGE_MESSAGE });
  assert.deepEqual(http.requestedPaths, ['/project/project-exact/version']);
});

test('changelog-free history normalizes absence and null while exact getVersion retains full changelog and file authority', async () => {
  const http = makeHttp({
    '/project/project-exact/version': jsonResponse([
      version({ changelog: undefined }), version({ id: 'null-changelog', changelog: null })
    ]),
    '/version/version-exact': jsonResponse(version())
  });
  const provider = new ModrinthModpackProvider({ http });
  assert.deepEqual((await provider.listVersions({ projectId: 'project-exact' })).map(item => item.changelog), [null, null]);
  const exact = await provider.getVersion('version-exact');
  assert.equal(exact.versionId, 'version-exact');
  assert.equal(exact.projectId, 'project-exact');
  assert.equal(exact.changelog, 'Changes');
  assert.deepEqual(exact.files, [{
    hashes: { sha1: '1'.repeat(40), sha512: '5'.repeat(128) },
    downloadUrlCandidate: 'https://cdn.modrinth.com/data/project-exact/versions/version-exact/server.mrpack',
    fileName: 'server.mrpack', primary: true, size: '1234', fileType: 'required-resource-pack'
  }]);
  assert.deepEqual(http.calls, [
    { path: '/project/project-exact/version', options: { query: { include_changelog: 'false' }, maxResponseBytes: HISTORY_LIMIT_BYTES } },
    { path: '/version/version-exact', options: {} }
  ]);
});

test('changelog-free history still rejects malformed required version and file metadata', async () => {
  for (const overrides of [
    { name: '' }, { game_versions: '1.21.1' }, { loaders: ['bukkit'] }, { version_type: 'unknown' },
    { files: [{ ...version().files[0], hashes: { sha1: 'bad', sha512: '5'.repeat(128) } }] }
  ]) {
    const provider = new ModrinthModpackProvider({ http: makeHttp({
      '/project/project-exact/version': jsonResponse([version({ changelog: undefined, ...overrides })])
    }) });
    await assert.rejects(provider.listVersions({ projectId: 'project-exact' }), { code: 'INVALID_REQUEST' });
  }
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

test('search rejects project-search channels because the official endpoint has no channel facet', async () => {
  const http = makeHttp({});
  const provider = new ModrinthModpackProvider({ http });
  await assert.rejects(provider.searchProjects({ channel: 'release', offset: 0, limit: 10 }), error => error.code === 'INVALID_REQUEST');
  assert.deepEqual(http.calls, []);
});

test('search requires modpack result types and unique exact project IDs', async () => {
  const base = {
    project_id: 'same-project', project_type: 'modpack', slug: 'same', title: 'Same', description: '',
    categories: ['fabric'], display_categories: ['fabric'], versions: ['1.21.1'], client_side: 'required',
    server_side: 'required', downloads: 1, icon_url: null, gallery: [], date_modified: '2026-01-01T00:00:00.000Z'
  };
  for (const hits of [[{ ...base, project_type: 'mod' }], [base, { ...base, slug: 'duplicate' }]]) {
    const provider = new ModrinthModpackProvider({ http: makeHttp({ '/search': jsonResponse({ hits, offset: 0, limit: 10, total_hits: hits.length }) }) });
    await assert.rejects(provider.searchProjects({ offset: 0, limit: 10 }), error => error.code === 'INVALID_REQUEST');
  }
});

test('exact project and version endpoints reject mismatched response identities without fallback', async () => {
  const projectBody = {
    id: 'different-project', slug: 'different', project_type: 'modpack', title: 'Different', description: '', body: '', icon_url: null,
    gallery: [], game_versions: ['1.21.1'], loaders: ['fabric'], client_side: 'required', server_side: 'required',
    updated: '2026-01-01T00:00:00.000Z', downloads: 1, donation_urls: []
  };
  const projectHttp = makeHttp({ '/project/project-exact': jsonResponse(projectBody) });
  await assert.rejects(new ModrinthModpackProvider({ http: projectHttp }).getProject('project-exact'), error => error.code === 'INVALID_REQUEST');
  assert.deepEqual(projectHttp.requestedPaths, ['/project/project-exact']);

  const versionHttp = makeHttp({ '/version/version-exact': jsonResponse(version({ id: 'different-version' })) });
  await assert.rejects(new ModrinthModpackProvider({ http: versionHttp }).resolveArtifactSetPlan('version-exact'), error => error.code === 'INVALID_REQUEST');
  assert.deepEqual(versionHttp.requestedPaths, ['/version/version-exact']);
});

test('version history requires the requested project ID and unique exact version IDs', async () => {
  for (const values of [
    [version({ id: 'v1', project_id: 'other-project' })],
    [version({ id: 'v1' }), version({ id: 'v1', version_number: 'duplicate' })]
  ]) {
    const http = makeHttp({ '/project/project-exact/version': jsonResponse(values) });
    const provider = new ModrinthModpackProvider({ http });
    await assert.rejects(provider.listVersions({ projectId: 'project-exact' }), error => error.code === 'INVALID_REQUEST');
    assert.deepEqual(http.requestedPaths, ['/project/project-exact/version']);
  }
});

test('provider accepts only bounded Buffer bodies with fatal UTF-8', async () => {
  const stringBody = new ModrinthModpackProvider({ http: makeHttp({ '/search': { statusCode: 200, body: '{"hits":[],"offset":0,"limit":10,"total_hits":0}' } }) });
  await assert.rejects(stringBody.searchProjects({ offset: 0, limit: 10 }), error => error.code === 'INVALID_REQUEST');
  const invalidUtf8 = new ModrinthModpackProvider({ http: makeHttp({ '/search': { statusCode: 200, body: Buffer.from([0xc3, 0x28]) } }) });
  await assert.rejects(invalidUtf8.searchProjects({ offset: 0, limit: 10 }), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => new ModrinthModpackProvider({ http: makeHttp({}), maxResponseBytes: 2 * 1024 * 1024 + 1 }), TypeError);
});

test('provider enforces the response byte ceiling before 404 and 429 status dispatch', async () => {
  const oversized404 = new ModrinthModpackProvider({
    http: makeHttp({ '/project/missing': { statusCode: 404, body: Buffer.alloc(33, 0x78) } }),
    maxResponseBytes: 32
  });
  await assert.rejects(
    oversized404.getProject('missing'),
    error => error.code === 'ARCHIVE_LIMIT_EXCEEDED' && error.details?.actual === '33'
  );

  const oversized429 = new ModrinthModpackProvider({
    http: makeHttp({ '/search': { statusCode: 429, body: Buffer.alloc(33, 0x78) } }),
    maxResponseBytes: 32
  });
  await assert.rejects(
    oversized429.searchProjects({ offset: 0, limit: 10 }),
    error => error.code === 'ARCHIVE_LIMIT_EXCEEDED' && error.details?.actual === '33'
  );
});

test('loader normalization is closed deduplicated and list queries serialize exact upstream names', async () => {
  const project = {
    id: 'project-exact', slug: 'exact', project_type: 'modpack', title: 'Exact', description: '', body: '', icon_url: null,
    gallery: [], game_versions: ['1.21.1'], loaders: ['minecraft', 'vanilla', 'fabric', 'fabric-loader', 'forge', 'neoforge', 'quilt-loader'],
    client_side: 'required', server_side: 'required', updated: '2026-01-01T00:00:00.000Z', downloads: 1, donation_urls: []
  };
  const http = makeHttp({
    '/project/project-exact': jsonResponse(project),
    '/search': ({ query }) => {
      assert.deepEqual(JSON.parse(query.facets), [['project_type:modpack'], ['categories:vanilla']]);
      return jsonResponse({ hits: [], offset: 0, limit: 10, total_hits: 0 });
    },
    '/project/project-exact/version': ({ query }) => {
      assert.deepEqual(query, { include_changelog: 'false', loaders: '["minecraft","fabric","forge","neoforge","quilt"]' });
      return jsonResponse([version({ loaders: ['minecraft', 'vanilla', 'fabric', 'fabric-loader', 'forge', 'neoforge', 'quilt-loader'] })]);
    }
  });
  const provider = new ModrinthModpackProvider({ http });
  assert.deepEqual((await provider.getProject('project-exact')).runtimes.loaders, ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);
  await provider.searchProjects({ loader: 'vanilla', offset: 0, limit: 10 });
  const listed = await provider.listVersions({ projectId: 'project-exact', loaders: ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'] });
  assert.deepEqual(listed[0].loaders, ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);

  const invalidRequestHttp = makeHttp({});
  await assert.rejects(new ModrinthModpackProvider({ http: invalidRequestHttp }).listVersions({ projectId: 'project-exact', loaders: ['bukkit'] }), error => error.code === 'INVALID_REQUEST');
  assert.deepEqual(invalidRequestHttp.calls, []);

  for (const route of ['/project/project-exact', '/version/version-exact']) {
    const body = route.startsWith('/project/') ? { ...project, loaders: ['bukkit'] } : version({ loaders: ['bukkit'] });
    const invalid = new ModrinthModpackProvider({ http: makeHttp({ [route]: jsonResponse(body) }) });
    await assert.rejects(route.startsWith('/project/') ? invalid.getProject('project-exact') : invalid.getVersion('version-exact'), error => error.code === 'INVALID_REQUEST');
  }
});
