const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GITHUB_API_HEADERS,
  GITHUB_ASSET_HOSTS,
  GitHubReleasesSource
} = require('../../electron/services/modpacks/providers/github-releases-source.cjs');

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const REPOSITORY_ID = 101;
const RELEASE_ID = 201;
const ASSET_ID = 301;
const SHA256 = 'a'.repeat(64);

function jsonResponse(value, statusCode = 200, headers = {}) {
  return { statusCode, headers, body: Buffer.from(JSON.stringify(value), 'utf8') };
}

function makeHttp(handler) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, options: structuredClone(options) });
      return handler(path, options, calls.length);
    }
  };
}

function repository(overrides = {}) {
  return {
    id: REPOSITORY_ID, node_id: 'R_kgDOExample', name: 'Pack', full_name: 'Canonical/Pack',
    private: false, owner: { login: 'Canonical', id: 77, type: 'Organization' },
    html_url: 'https://github.com/Canonical/Pack', url: 'https://api.github.com/repos/Canonical/Pack',
    visibility: 'public', archived: false, disabled: false,
    ...overrides
  };
}

function release(overrides = {}) {
  return {
    id: RELEASE_ID, node_id: 'RE_kwExample', tag_name: 'v1.0.0', target_commitish: 'main',
    name: 'Version 1', draft: false, prerelease: false, immutable: true,
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:01:00.000Z',
    published_at: '2026-07-01T00:02:00.000Z',
    zipball_url: 'https://api.github.com/repos/Canonical/Pack/zipball/v1.0.0',
    tarball_url: 'https://api.github.com/repos/Canonical/Pack/tarball/v1.0.0',
    assets_url: 'https://api.github.com/repos/Canonical/Pack/releases/201/assets',
    html_url: 'https://github.com/Canonical/Pack/releases/tag/v1.0.0', assets: [],
    ...overrides
  };
}

function asset(overrides = {}) {
  return {
    id: ASSET_ID, node_id: 'RA_kwExample', name: 'server-pack.zip', label: 'Server pack',
    uploader: { login: 'publisher' }, content_type: 'application/zip', state: 'uploaded', size: 100,
    digest: `sha256:${SHA256}`, download_count: 42,
    created_at: '2026-07-01T00:03:00.000Z', updated_at: '2026-07-01T00:04:00.000Z',
    browser_download_url: 'https://github.com/Canonical/Pack/releases/download/v1.0.0/server-pack.zip',
    url: 'https://api.github.com/repos/Canonical/Pack/releases/assets/301',
    ...overrides
  };
}

function sourceFor(handler, options = {}) {
  const http = makeHttp(handler);
  return {
    http,
    source: new GitHubReleasesSource({ http, clock: { now: () => NOW }, ...options })
  };
}

async function bind(source, url = 'https://github.com/Hint/Pack') {
  return source.getRepositoryIdentity(url);
}

test('requires injected transport and clock and a non-expandable two MiB response cap', () => {
  const http = { request: async () => jsonResponse({}) };
  assert.throws(() => new GitHubReleasesSource({ http }), TypeError);
  assert.throws(() => new GitHubReleasesSource({ clock: { now: () => NOW } }), TypeError);
  assert.throws(() => new GitHubReleasesSource({ http, clock: { now: () => NOW }, maxResponseBytes: 2 * 1024 * 1024 + 1 }), TypeError);
});

test('resolves URL hints to a canonical public numeric repository identity using pinned headers', async () => {
  const { source, http } = sourceFor((path) => {
    assert.equal(path, '/repos/Hint/Pack');
    return jsonResponse(repository());
  });
  const identity = await source.getRepositoryIdentity('https://github.com/Hint/Pack/releases/tag/v1.0.0');
  assert.deepEqual(identity, {
    repositoryId: '101', owner: 'Canonical', repo: 'Pack', fullName: 'Canonical/Pack',
    visibility: 'public', archived: false, disabled: false, tagHint: 'v1.0.0'
  });
  assert.equal(Object.isFrozen(identity), true);
  assert.deepEqual(http.calls[0].options.headers, GITHUB_API_HEADERS);
  assert.equal(Object.values(identity).some(value => String(value).includes('https://')), false);
});

test('normalizes private inaccessible and not-found repositories to the same redacted public failure', async () => {
  for (const response of [jsonResponse({ message: 'private token=secret' }, 404), jsonResponse(repository({ private: true, visibility: 'private' }))]) {
    const { source } = sourceFor(() => response);
    await assert.rejects(source.getRepositoryIdentity('https://github.com/Hint/Pack'), error => {
      assert.equal(error.code, 'REPOSITORY_NOT_FOUND');
      assert.equal(error.details?.repositoryId, undefined);
      assert.equal(error.toPublicResult().error.details.repositoryId, undefined);
      assert.equal(JSON.stringify(error.toPublicResult()).includes(String(REPOSITORY_ID)), false);
      assert.equal(String(error.message).includes('secret'), false);
      assert.equal(String(error.message).includes('private'), false);
      return true;
    });
  }
});

test('redacts a learned numeric repository ID when a previously public repository becomes inaccessible', async () => {
  const { source } = sourceFor((path) => path === '/repos/Hint/Pack'
    ? jsonResponse(repository())
    : jsonResponse({ message: 'private token=secret' }, 403));
  const identity = await bind(source);
  await assert.rejects(source.listReleases({ ...identity, includePrereleases: false }), error => {
    assert.equal(error.code, 'REPOSITORY_NOT_FOUND');
    assert.equal(error.details?.repositoryId, undefined);
    assert.equal(JSON.stringify(error.toPublicResult()).includes(identity.repositoryId), false);
    return true;
  });
});

test('validates bounded Buffer-only fatal-UTF8 JSON and repository field identity at the boundary', async () => {
  const responses = [
    { statusCode: 200, headers: {}, body: JSON.stringify(repository()) },
    { statusCode: 200, headers: {}, body: Buffer.from([0xc3, 0x28]) },
    jsonResponse(repository({ id: Number.MAX_SAFE_INTEGER + 1 })),
    jsonResponse(repository({ full_name: 'Other/Repository' })),
    jsonResponse(repository({ owner: { login: 'bad\nowner', id: 1 } }))
  ];
  for (const response of responses) {
    const { source } = sourceFor(() => response);
    await assert.rejects(source.getRepositoryIdentity('https://github.com/Hint/Pack'), error => error.code === 'INVALID_REQUEST');
  }
  const { source } = sourceFor(() => jsonResponse(repository({ name: 'x'.repeat(200) })), { maxResponseBytes: 64 });
  await assert.rejects(source.getRepositoryIdentity('https://github.com/Hint/Pack'), error =>
    error.code === 'ARCHIVE_LIMIT_EXCEEDED' && !String(error.message).includes('x'.repeat(20)));
});

test('lists only non-draft stable releases by default and never exposes generated archives or response URLs', async () => {
  const { source, http } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    assert.equal(path, '/repos/Canonical/Pack/releases');
    return jsonResponse([
      release(),
      release({ id: 202, tag_name: 'v1.1.0-beta', prerelease: true }),
      release({ id: 203, tag_name: 'draft', draft: true, published_at: null })
    ], 200, { etag: '"release-etag"' });
  });
  const identity = await bind(source);
  const result = await source.listReleases({
    repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repo,
    includePrereleases: false
  });
  assert.equal(result.releases.length, 1);
  assert.deepEqual(result.releases[0], {
    repositoryId: '101', releaseId: '201', tagName: 'v1.0.0', name: 'Version 1',
    prerelease: false, channel: 'release', immutable: true,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:01:00.000Z',
    publishedAt: '2026-07-01T00:02:00.000Z'
  });
  assert.equal(result.etag, '"release-etag"');
  assert.equal(result.checkedAt, '2026-08-01T12:00:00.000Z');
  assert.deepEqual(result.pagination, { perPage: 100, nextCursor: null });
  assert.equal(JSON.stringify(result).includes('zipball'), false);
  assert.equal(JSON.stringify(result).includes('https://'), false);
  assert.equal(Object.isFrozen(result.releases[0]), true);
  assert.deepEqual(http.calls[1].options.query, { per_page: '100', page: '1' });
  assert.deepEqual(http.calls[1].options.headers, GITHUB_API_HEADERS);
});

test('includes prereleases only on explicit request and still excludes drafts', async () => {
  const { source } = sourceFor((path) => path === '/repos/Hint/Pack'
    ? jsonResponse(repository())
    : jsonResponse([release(), release({ id: 202, tag_name: 'beta', prerelease: true }), release({ id: 203, draft: true, tag_name: 'draft', published_at: null })]));
  const identity = await bind(source);
  const result = await source.listReleases({ ...identity, includePrereleases: true });
  assert.deepEqual(result.releases.map(item => [item.releaseId, item.channel]), [['201', 'release'], ['202', 'prerelease']]);
});

test('binds all release calls to the registered numeric repository identity and rejects mismatched hints before transport', async () => {
  const { source, http } = sourceFor((path) => path === '/repos/Hint/Pack' ? jsonResponse(repository()) : jsonResponse([]));
  const identity = await bind(source);
  await assert.rejects(source.listReleases({
    repositoryId: identity.repositoryId, owner: 'Other', repo: identity.repo, includePrereleases: false
  }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(source.listReleases({
    repositoryId: '102', owner: identity.owner, repo: identity.repo, includePrereleases: false
  }), error => error.code === 'REPOSITORY_NOT_FOUND');
  assert.equal(http.calls.length, 1);
});

test('follows validated GitHub Link metadata through an opaque source-issued cursor only', async () => {
  const { source, http } = sourceFor((path, options) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (options.query.page === '1') {
      return jsonResponse([release()], 200, {
        link: '<https://api.github.com/repositories/101/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/101/releases?per_page=100&page=3>; rel="last"'
      });
    }
    assert.equal(options.query.page, '2');
    return jsonResponse([release({ id: 202, tag_name: 'v2' })]);
  });
  const identity = await bind(source);
  const first = await source.listReleases({ ...identity, includePrereleases: false });
  assert.equal(typeof first.pagination.nextCursor, 'string');
  assert.equal(first.pagination.nextCursor.includes('https://'), false);
  const second = await source.listReleases({ ...identity, includePrereleases: false, cursor: first.pagination.nextCursor });
  assert.deepEqual(second.releases.map(item => item.releaseId), ['202']);
  await assert.rejects(source.listReleases({ ...identity, includePrereleases: false, cursor: 'https://api.github.com/?page=99' }), error => error.code === 'INVALID_REQUEST');
  assert.equal(http.calls.length, 3);
});

test('rejects malicious or cross-repository Link pagination metadata instead of following it', async () => {
  for (const link of [
    '<https://evil.example/repositories/101/releases?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repositories/102/releases?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repositories/101/releases?per_page=99&page=2>; rel="next"',
    '<https://api.github.com/repositories/101/releases?per_page=100&page=2&token=secret>; rel="next"',
    '<https://user:secret@api.github.com/repositories/101/releases?per_page=100&page=2>; rel="next"'
  ]) {
    const { source } = sourceFor((path) => path === '/repos/Hint/Pack'
      ? jsonResponse(repository())
      : jsonResponse([], 200, { link }));
    const identity = await bind(source);
    await assert.rejects(source.listReleases({ ...identity, includePrereleases: false }), error =>
      error.code === 'INVALID_REQUEST' && !String(error.message).includes('secret'));
  }
});

test('rejects skipped Link pages and duplicate exact release IDs across opaque cursor pages', async () => {
  const skipped = sourceFor((path) => path === '/repos/Hint/Pack'
    ? jsonResponse(repository())
    : jsonResponse([release()], 200, {
        link: '<https://api.github.com/repositories/101/releases?per_page=100&page=3>; rel="next"'
      })).source;
  const skippedIdentity = await bind(skipped);
  await assert.rejects(skipped.listReleases({ ...skippedIdentity, includePrereleases: false }), error => error.code === 'INVALID_REQUEST');

  const duplicate = sourceFor((path, options) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (options.query.page === '1') return jsonResponse([release()], 200, {
      link: '<https://api.github.com/repositories/101/releases?per_page=100&page=2>; rel="next"'
    });
    return jsonResponse([release()]);
  }).source;
  const duplicateIdentity = await bind(duplicate);
  const first = await duplicate.listReleases({ ...duplicateIdentity, includePrereleases: false });
  await assert.rejects(duplicate.listReleases({ ...duplicateIdentity, includePrereleases: false, cursor: first.pagination.nextCursor }), error => error.code === 'INVALID_REQUEST');
});

test('uses cached ETags for conditional release requests and handles 304 without losing normalized records', async () => {
  let requests = 0;
  const { source, http } = sourceFor((path, options) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    requests += 1;
    if (requests === 1) return jsonResponse([release()], 200, { etag: 'W/"abc123"' });
    assert.equal(options.headers['If-None-Match'], 'W/"abc123"');
    return { statusCode: 304, headers: { etag: 'W/"abc123"' }, body: Buffer.alloc(0) };
  });
  const identity = await bind(source);
  const first = await source.listReleases({ ...identity, includePrereleases: false });
  const second = await source.listReleases({ ...identity, includePrereleases: false });
  assert.equal(first.notModified, false);
  assert.equal(second.notModified, true);
  assert.deepEqual(second.releases, first.releases);
  assert.equal(http.calls.length, 3);
});

test('rechecks duplicate release IDs and tags against cursor history on cached 304 pages', async () => {
  for (const duplicateField of ['releaseId', 'tagName']) {
    let pageOneRequests = 0;
    let pageTwoRequests = 0;
    const { source } = sourceFor((path, options) => {
      if (path === '/repos/Hint/Pack') return jsonResponse(repository());
      if (options.query.page === '1') {
        pageOneRequests += 1;
        const item = pageOneRequests === 1
          ? release()
          : release({ id: duplicateField === 'releaseId' ? 202 : 203, tag_name: duplicateField === 'tagName' ? 'v2' : 'v3' });
        return jsonResponse([item], 200, {
          link: '<https://api.github.com/repositories/101/releases?per_page=100&page=2>; rel="next"'
        });
      }
      pageTwoRequests += 1;
      if (pageTwoRequests === 1) {
        return jsonResponse([release({ id: 202, tag_name: 'v2' })], 200, { etag: '"page-two"' });
      }
      assert.equal(options.headers['If-None-Match'], '"page-two"');
      return { statusCode: 304, headers: { etag: '"page-two"' }, body: Buffer.alloc(0) };
    });
    const identity = await bind(source);
    const initialFirst = await source.listReleases({ ...identity, includePrereleases: false });
    await source.listReleases({ ...identity, includePrereleases: false, cursor: initialFirst.pagination.nextCursor });
    const changedFirst = await source.listReleases({ ...identity, includePrereleases: false });
    await assert.rejects(
      source.listReleases({ ...identity, includePrereleases: false, cursor: changedFirst.pagination.nextCursor }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('emits bounded safe Retry-After rate-reset and exponential metadata without sleeping', async () => {
  let failures = 0;
  const { source } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    failures += 1;
    return jsonResponse({ message: 'secondary rate limit token=secret' }, 429, {
      'retry-after': failures === 1 ? '5' : '10',
      'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 30),
      'x-ratelimit-remaining': '0'
    });
  }, { baseBackoffMs: 1000, maxBackoffMs: 8000 });
  const identity = await bind(source);
  for (const expected of [
    { retryAfterMs: 5000, rateLimitResetAt: '2026-08-01T12:00:30.000Z', backoffMs: 1000, nextAttemptAfterMs: 30000 },
    { retryAfterMs: 10000, rateLimitResetAt: '2026-08-01T12:00:30.000Z', backoffMs: 2000, nextAttemptAfterMs: 30000 }
  ]) {
    await assert.rejects(source.listReleases({ ...identity, includePrereleases: false }), error => {
      assert.equal(error.code, 'INVALID_RELEASE_URL');
      assert.equal(error.retryable, true);
      assert.deepEqual(error.retryMetadata, expected);
      assert.equal(String(error.message).includes('secret'), false);
      return true;
    });
  }
});

test('treats a 403 with only zero remaining quota as retryable rate limiting', async () => {
  const { source } = sourceFor((path) => path === '/repos/Hint/Pack'
    ? jsonResponse(repository())
    : jsonResponse({ message: 'quota body token=secret' }, 403, { 'x-ratelimit-remaining': '0' }));
  const identity = await bind(source);
  await assert.rejects(source.listReleases({ ...identity, includePrereleases: false }), error =>
    error.code === 'INVALID_RELEASE_URL' && error.retryable &&
    error.retryMetadata.backoffMs === 1000 && !String(error.message).includes('secret'));
});

test('recognizes only the exact bounded fatal-UTF8 GitHub secondary-limit body on a headerless 403', async () => {
  const exactBody = {
    message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
    documentation_url: 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api'
  };
  const { source } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    return jsonResponse(exactBody, 403);
  }, { baseBackoffMs: 1000, maxBackoffMs: 8000 });
  const identity = await bind(source);
  for (const expectedBackoff of [60_000, 120_000]) {
    await assert.rejects(source.listReleases({ ...identity, includePrereleases: false }), error => {
      assert.equal(error.code, 'INVALID_RELEASE_URL');
      assert.equal(error.retryable, true);
      assert.deepEqual(error.retryMetadata, {
        retryAfterMs: 0,
        backoffMs: expectedBackoff,
        nextAttemptAfterMs: expectedBackoff
      });
      assert.equal(Object.isFrozen(error.retryMetadata), true);
      assert.equal(Object.values(error.retryMetadata).every(value => Number.isSafeInteger(value)), true);
      return true;
    });
  }
});

test('near-match malformed oversized and reset-only 403 responses remain redacted non-retryable repository failures', async () => {
  const message = 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
  const documentation_url = 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api';
  const responses = [
    jsonResponse({ message: `${message} `, documentation_url }, 403),
    jsonResponse({ message, documentation_url: `${documentation_url}#secondary` }, 403),
    jsonResponse({ message, documentation_url, status: '403' }, 403),
    { statusCode: 403, headers: {}, body: Buffer.from([0xc3, 0x28]) },
    jsonResponse({ message, documentation_url, padding: 'x'.repeat(20 * 1024) }, 403),
    { statusCode: 403, headers: {}, body: Buffer.from(`${' '.repeat(20 * 1024)}${JSON.stringify({ message, documentation_url })}`, 'utf8') },
    jsonResponse({ message: 'forbidden token=secret' }, 403, {
      'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 30),
      'x-ratelimit-remaining': '5'
    })
  ];
  for (const response of responses) {
    const { source } = sourceFor((path) => path === '/repos/Hint/Pack' ? jsonResponse(repository()) : response);
    const identity = await bind(source);
    await assert.rejects(source.listReleases({ ...identity, includePrereleases: false }), error => {
      assert.equal(error.code, 'REPOSITORY_NOT_FOUND');
      assert.equal(error.retryable, false);
      assert.equal(error.details?.repositoryId, undefined);
      assert.equal(String(error.message).includes('secret'), false);
      return true;
    });
  }
});

test('gets an exact non-draft release and rejects mismatched IDs drafts and public 404s safely', async () => {
  for (const [response, code] of [
    [jsonResponse(release()), null],
    [jsonResponse(release({ id: 202 })), 'INVALID_REQUEST'],
    [jsonResponse(release({ draft: true, published_at: null })), 'RELEASE_NOT_FOUND'],
    [jsonResponse({ message: 'token=secret' }, 404), 'RELEASE_NOT_FOUND']
  ]) {
    const { source } = sourceFor((path) => {
      if (path === '/repos/Hint/Pack') return jsonResponse(repository());
      assert.equal(path, '/repos/Canonical/Pack/releases/201');
      return response;
    });
    const identity = await bind(source);
    if (!code) assert.equal((await source.getRelease({ repositoryId: identity.repositoryId, releaseId: '201' })).releaseId, '201');
    else await assert.rejects(source.getRelease({ repositoryId: identity.repositoryId, releaseId: '201' }), error => error.code === code && !String(error.message).includes('secret'));
  }
});

test('revalidates the exact release and excludes draft assets even when the asset endpoint would return uploaded bytes', async () => {
  let assetRequests = 0;
  const { source } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (path === '/repos/Canonical/Pack/releases/201') return jsonResponse(release({ draft: true, published_at: null }));
    assetRequests += 1;
    return jsonResponse([asset()]);
  });
  const identity = await bind(source);
  await assert.rejects(source.listUploadedAssets({ repositoryId: identity.repositoryId, releaseId: '201' }), error => error.code === 'RELEASE_NOT_FOUND');
  assert.equal(assetRequests, 0);
});

test('lists only uploaded assets while retaining exact IDs ETag digest sizes timestamps labels and provisional roles', async () => {
  const { source, http } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (path === '/repos/Canonical/Pack/releases/201') return jsonResponse(release());
    assert.equal(path, '/repos/Canonical/Pack/releases/201/assets');
    return jsonResponse([
      asset(),
      asset({ id: 302, name: 'pending.zip', state: 'new', digest: null }),
      asset({ id: 303, name: 'readme.txt', label: null, content_type: 'text/plain', digest: null })
    ], 200, { etag: '"assets-etag"' });
  });
  const identity = await bind(source);
  const result = await source.listUploadedAssets({ repositoryId: identity.repositoryId, releaseId: '201' });
  assert.deepEqual(result.assets.map(item => item.assetId), ['301', '303']);
  assert.deepEqual(result.assets[0], {
    repositoryId: '101', releaseId: '201', assetId: '301', fileName: 'server-pack.zip',
    label: 'Server pack', contentType: 'application/zip', state: 'uploaded', role: 'provisional',
    size: '100', providerDigest: { algorithm: 'sha256', value: SHA256 },
    createdAt: '2026-07-01T00:03:00.000Z', updatedAt: '2026-07-01T00:04:00.000Z',
    etag: '"assets-etag"', installableCandidate: true
  });
  assert.equal(result.choices.length, 1);
  assert.equal(result.choices[0].role, 'provisional');
  assert.equal(result.status, 'ready');
  assert.equal(JSON.stringify(result).includes('browser_download_url'), false);
  assert.equal(JSON.stringify(result).includes('https://'), false);
  assert.equal(Object.isFrozen(result.assets[0].providerDigest), true);
  assert.deepEqual(http.calls[2].options.query, { per_page: '100', page: '1' });
});

test('returns a safe NO_INSTALLABLE_ASSET outcome when no uploaded installable asset exists', async () => {
  const { source } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (path === '/repos/Canonical/Pack/releases/201') return jsonResponse(release());
    return jsonResponse([asset({ name: 'README.txt', digest: null })]);
  });
  const identity = await bind(source);
  const result = await source.listUploadedAssets({ repositoryId: identity.repositoryId, releaseId: '201' });
  assert.equal(result.status, 'NO_INSTALLABLE_ASSET');
  assert.deepEqual(result.actions, ['import-local', 'create-empty']);
  assert.deepEqual(result.choices, []);
});

test('keeps a lone multipart primary provisional and rejects it as an incomplete install selection', async () => {
  const { source } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (path === '/repos/Canonical/Pack/releases/201') return jsonResponse(release());
    return jsonResponse([asset({ name: 'server-pack.part1.rar', digest: null })]);
  });
  const identity = await bind(source);
  const result = await source.listUploadedAssets({ repositoryId: identity.repositoryId, releaseId: '201' });
  assert.equal(result.status, 'NO_INSTALLABLE_ASSET');
  assert.equal(result.choices.length, 1);
  assert.equal(result.choices[0].kind, 'multipart');
  assert.equal(result.choices[0].complete, false);
  assert.equal(result.choices[0].disabled, true);
  assert.equal(result.choices[0].disabledReason, 'missing-volume');
  await assert.rejects(source.buildArtifactSetPlan({
    repositoryId: identity.repositoryId, releaseId: '201', selectedAssetIds: ['301']
  }), error => error.code === 'MULTIPART_VOLUME_MISSING');
});

test('rejects Windows device aliases from GitHub including superscript-digit and stream device names', async () => {
  for (const name of ['COM¹.zip', 'LPT².rar', 'CONIN$.zip', 'CONOUT$.mrpack']) {
    const { source } = sourceFor((path) => {
      if (path === '/repos/Hint/Pack') return jsonResponse(repository());
      if (path === '/repos/Canonical/Pack/releases/201') return jsonResponse(release());
      return jsonResponse([asset({ name })]);
    });
    const identity = await bind(source);
    await assert.rejects(
      source.listUploadedAssets({ repositoryId: identity.repositoryId, releaseId: '201' }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('paginates asset lists internally using validated Link pages and rejects duplicate IDs across pages', async () => {
  for (const duplicate of [false, true]) {
    const { source, http } = sourceFor((path, options) => {
      if (path === '/repos/Hint/Pack') return jsonResponse(repository());
      if (path === '/repos/Canonical/Pack/releases/201') return jsonResponse(release());
      if (options.query.page === '1') return jsonResponse([asset()], 200, {
        link: '<https://api.github.com/repositories/101/releases/201/assets?per_page=100&page=2>; rel="next"'
      });
      return jsonResponse([asset({ id: duplicate ? 301 : 302, name: 'extra.zip' })]);
    });
    const identity = await bind(source);
    if (duplicate) await assert.rejects(source.listUploadedAssets({ repositoryId: identity.repositoryId, releaseId: '201' }), error => error.code === 'INVALID_REQUEST');
    else assert.deepEqual((await source.listUploadedAssets({ repositoryId: identity.repositoryId, releaseId: '201' })).assets.map(item => item.assetId), ['301', '302']);
    assert.equal(http.calls.length, 4);
  }
});

test('rejects asset Link metadata that skips a page in the exact release asset set', async () => {
  const { source } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (path === '/repos/Canonical/Pack/releases/201') return jsonResponse(release());
    return jsonResponse([asset()], 200, {
        link: '<https://api.github.com/repositories/101/releases/201/assets?per_page=100&page=3>; rel="next"'
      });
  });
  const identity = await bind(source);
  await assert.rejects(source.listUploadedAssets({ repositoryId: identity.repositoryId, releaseId: '201' }), error => error.code === 'INVALID_REQUEST');
});

test('builds an explicitly selected exact-ID artifact plan and derives only the numeric GitHub asset API request', async () => {
  const { source } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (path === '/repos/Canonical/Pack/releases/201') return jsonResponse(release());
    return jsonResponse([asset({ digest: null })], 200, { etag: '"assets-etag"' });
  });
  const identity = await bind(source);
  const plan = await source.buildArtifactSetPlan({
    repositoryId: identity.repositoryId, releaseId: '201', selectedAssetIds: ['301']
  });
  assert.equal(plan.type, 'artifact-set-plan');
  assert.equal(plan.provider, 'github');
  assert.deepEqual(plan.project, { id: '101', slug: 'Canonical/Pack', title: 'Canonical/Pack' });
  assert.deepEqual(plan.release, {
    id: '201', version: 'v1.0.0', channel: 'release', publishedAt: '2026-07-01T00:02:00.000Z'
  });
  assert.equal(plan.artifactSet.primaryPartId, 'asset-301');
  assert.deepEqual(plan.artifactSet.parts[0], {
    partId: 'asset-301', providerAssetId: '301', fileName: 'server-pack.zip', size: '100',
    updatedAt: '2026-07-01T00:04:00.000Z',
    downloadUrl: 'https://api.github.com/repos/Canonical/Pack/releases/assets/301',
    allowedHosts: [...GITHUB_ASSET_HOSTS], allowSubdomains: false,
    headers: {
      Accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'Minecraft-Core'
    }
  });
  assert.deepEqual(plan.warnings, [{ code: 'MISSING_PROVIDER_DIGEST', partId: 'asset-301' }]);
  assert.equal(JSON.stringify(plan).includes('browser_download'), false);
  assert.equal(Object.isFrozen(plan), true);
});

test('normalizes a supplied GitHub SHA-256 as authoritative plan integrity and removes the missing-digest warning', async () => {
  const { source } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (path.endsWith('/releases/201')) return jsonResponse(release());
    return jsonResponse([asset()]);
  });
  const identity = await bind(source);
  const plan = await source.buildArtifactSetPlan({ repositoryId: identity.repositoryId, releaseId: '201', selectedAssetIds: ['301'] });
  assert.deepEqual(plan.artifactSet.parts[0].providerDigest, { algorithm: 'sha256', value: SHA256 });
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.artifactSet.attestationStatus, 'verified');
  assert.equal(plan.artifactSet.providerImmutable, true);
});

test('never silently chooses the first archive and rejects absent duplicate unknown and mixed selections', async () => {
  const { source, http } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (path.endsWith('/releases/201')) return jsonResponse(release());
    return jsonResponse([asset(), asset({ id: 302, name: 'other.zip' })]);
  });
  const identity = await bind(source);
  const before = http.calls.length;
  for (const selectedAssetIds of [[], ['301', '301'], ['999'], ['301', '302']]) {
    await assert.rejects(source.buildArtifactSetPlan({
      repositoryId: identity.repositoryId, releaseId: '201', selectedAssetIds
    }), error => ['INVALID_REQUEST', 'ASSET_SELECTION_REQUIRED', 'ASSET_AMBIGUOUS'].includes(error.code));
  }
  assert.equal(http.calls.length > before, true);
});

test('requires the exact complete multipart group from one release and emits deterministic ordered parts', async () => {
  const assets = [
    asset({ id: 302, name: 'pack.part2.rar', size: 20, digest: null }),
    asset({ id: 301, name: 'pack.part1.rar', size: 10, digest: null }),
    asset({ id: 303, name: 'pack.part3.rar', size: 30, digest: null })
  ];
  const { source } = sourceFor((path) => {
    if (path === '/repos/Hint/Pack') return jsonResponse(repository());
    if (path.endsWith('/releases/201')) return jsonResponse(release());
    return jsonResponse(assets);
  });
  const identity = await bind(source);
  const plan = await source.buildArtifactSetPlan({
    repositoryId: identity.repositoryId, releaseId: '201', selectedAssetIds: ['303', '301', '302']
  });
  assert.equal(plan.artifactSet.kind, 'multipart');
  assert.equal(plan.artifactSet.groupingScheme, 'part-number');
  assert.equal(plan.artifactSet.primaryPartId, 'asset-301');
  assert.deepEqual(plan.artifactSet.parts.map(part => part.providerAssetId), ['301', '302', '303']);

  await assert.rejects(source.buildArtifactSetPlan({
    repositoryId: identity.repositoryId, releaseId: '201', selectedAssetIds: ['301', '302']
  }), error => error.code === 'MULTIPART_VOLUME_MISSING');
  await assert.rejects(source.buildArtifactSetPlan({
    repositoryId: identity.repositoryId, releaseId: '201', selectedAssetIds: ['302']
  }), error => error.code === 'MULTIPART_VOLUME_MISSING');
});

test('rejects malformed digests unsafe names invalid numeric fields and selected total-size overflow safely', async () => {
  const tooLarge = Number(8n * 1024n * 1024n * 1024n + 1n);
  for (const assets of [
    [asset({ digest: 'sha512:not-supported' })],
    [asset({ name: '../server.zip' })],
    [asset({ size: -1 })],
    [asset({ id: Number.MAX_SAFE_INTEGER + 1 })],
    [asset({ id: 301, name: 'pack.part1.rar', size: tooLarge }), asset({ id: 302, name: 'pack.part2.rar', size: tooLarge })]
  ]) {
    const { source } = sourceFor((path) => {
      if (path === '/repos/Hint/Pack') return jsonResponse(repository());
      if (path.endsWith('/releases/201')) return jsonResponse(release());
      return jsonResponse(assets);
    });
    const identity = await bind(source);
    const selectedAssetIds = assets.map(item => Number.isSafeInteger(item.id) ? String(item.id) : '301');
    await assert.rejects(source.buildArtifactSetPlan({
      repositoryId: identity.repositoryId, releaseId: '201', selectedAssetIds
    }), error => ['INVALID_REQUEST', 'ARCHIVE_LIMIT_EXCEEDED'].includes(error.code));
  }
});

test('pins the exact GitHub API and vetted asset host constants', () => {
  assert.deepEqual(GITHUB_API_HEADERS, {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'Minecraft-Core'
  });
  assert.deepEqual(GITHUB_ASSET_HOSTS, [
    'api.github.com', 'release-assets.githubusercontent.com',
    'objects.githubusercontent.com', 'github-releases.githubusercontent.com'
  ]);
});
