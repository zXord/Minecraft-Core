const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  BoundedApiClient,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_REQUEST_RESPONSE_BYTES
} = require('../../electron/services/modpacks/network/bounded-api-client.cjs');

function timedOut(error) {
  return error?.code === 'INVALID_RELEASE_URL' && error.retryable === true &&
    error.safeMessage === 'Provider request timed out' &&
    JSON.stringify(error.toPublicResult().error.details) === '{}';
}

function response(bytes, statusCode = 200, headers = {}) {
  const stream = Readable.from([bytes]);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

function chunkedResponse(bytes, headers = {}) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) chunks.push(bytes.subarray(offset, offset + 1024 * 1024));
  const stream = Readable.from(chunks);
  stream.statusCode = 200;
  stream.headers = headers;
  return stream;
}

test('bounded provider client scopes relative paths, encodes sorted query values, and returns buffered bytes', async () => {
  const calls = [];
  const client = new BoundedApiClient({
    client: {
      async request(url, options) {
        calls.push({ url, options });
        return response(Buffer.from('{"ok":true}'), 200, { etag: '"one"' });
      }
    },
    baseUrl: 'https://api.modrinth.com/v2/'
  });
  const result = await client.request('/search', { query: { query: 'fabric pack', limit: '20' }, headers: { Accept: 'application/json' } });
  assert.equal(calls[0].url, 'https://api.modrinth.com/v2/search?limit=20&query=fabric+pack');
  assert.deepEqual(calls[0].options.allowedHosts, ['api.modrinth.com']);
  assert.deepEqual(calls[0].options.allowedOrigins, ['https://api.modrinth.com']);
  assert.equal(calls[0].options.maxRedirects, 0);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.toString('utf8'), '{"ok":true}');
});

test('bounded provider client forwards one explicitly configured redirect while preserving its exact origin policy', async () => {
  const calls = [];
  const client = new BoundedApiClient({
    client: {
      async request(url, options) {
        calls.push({ url, options });
        return response(Buffer.from('ok'));
      }
    },
    baseUrl: 'https://api.github.com/',
    maxRedirects: 1
  });
  const result = await client.request('/repos/AllOfFabric/AOF-Normal');
  assert.equal(result.body.toString('utf8'), 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[0].options.signal.aborted, false);
  assert.deepEqual(calls[0].options.allowedHosts, ['api.github.com']);
  assert.deepEqual(calls[0].options.allowedOrigins, ['https://api.github.com']);
  assert.equal(calls[0].options.allowSubdomains, false);
  assert.equal(calls[0].options.maxRedirects, 1);
});

test('bounded provider deadline aborts a response that never finishes', { timeout: 500 }, async () => {
  let stream;
  let signal;
  const client = new BoundedApiClient({
    client: {
      async request(_url, options) {
        signal = options.signal;
        stream = new Readable({ read() {} });
        stream.statusCode = 200;
        stream.headers = {};
        return stream;
      }
    },
    baseUrl: 'https://api.modrinth.com/v2/',
    requestTimeoutMs: 25
  });
  await assert.rejects(client.request('/version/patch'), timedOut);
  assert.equal(signal.aborted, true);
  assert.equal(stream.destroyed, true);
});

test('bounded provider client preserves caller cancellation while aborting a pending response', async () => {
  const controller = new AbortController();
  let stream;
  const client = new BoundedApiClient({
    client: {
      async request() {
        stream = new Readable({ read() {} });
        stream.statusCode = 200;
        stream.headers = {};
        return stream;
      }
    },
    baseUrl: 'https://api.modrinth.com/v2/',
    requestTimeoutMs: 500
  });
  const pending = client.request('/version/patch', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(stream.destroyed, true);
});

test('bounded provider client accepts only the supported redirect budget', () => {
  const dependency = { request() {} };
  for (const maxRedirects of [-1, 2, 1.5, '1']) {
    assert.throws(
      () => new BoundedApiClient({ client: dependency, baseUrl: 'https://api.github.com/', maxRedirects }),
      /Bounded API client dependencies are invalid/
    );
  }
});

test('bounded provider client rejects authority changes, traversal, redirects by policy, and oversized bodies', async () => {
  const underlying = { async request() { return response(Buffer.alloc(5)); } };
  const client = new BoundedApiClient({ client: underlying, baseUrl: 'https://api.github.com/', maxResponseBytes: 4 });
  for (const candidate of ['https://evil.invalid/', '//evil.invalid/', '/../escape', '/%2e%2e/escape', '/a\\b']) {
    await assert.rejects(client.request(candidate), error => error.code === 'INVALID_RELEASE_URL' && error.retryable === false);
  }
  await assert.rejects(client.request('/repos'), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
});

test('declared provider bodies are bounded before streaming', async () => {
  let destroyed = false;
  const client = new BoundedApiClient({
    client: { async request() { const value = response(Buffer.alloc(0), 200, { 'content-length': '9' }); value.destroy = () => { destroyed = true; }; return value; } },
    baseUrl: 'https://api.github.com/', maxResponseBytes: 8
  });
  await assert.rejects(client.request('/repos'), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
  assert.equal(destroyed, true);
});

test('one request may raise its own byte limit while the client default stays at 2 MiB', async () => {
  assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_REQUEST_RESPONSE_BYTES, 16 * 1024 * 1024);
  const body = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const calls = [];
  const streams = [];
  const client = new BoundedApiClient({
    client: {
      async request(url, options) {
        calls.push({ url, options });
        const stream = chunkedResponse(body);
        streams.push(stream);
        return stream;
      }
    },
    baseUrl: 'https://api.modrinth.com/v2/'
  });
  const raised = await client.request('/project/pack/version', {
    query: { include_changelog: 'false' }, maxResponseBytes: MAX_REQUEST_RESPONSE_BYTES
  });
  assert.equal(raised.body.length, body.length);
  // The client enforces the limit itself; the transport gets the same options as any request.
  assert.equal(calls[0].url, 'https://api.modrinth.com/v2/project/pack/version?include_changelog=false');
  assert.deepEqual(Object.keys(calls[0].options).sort(), ['allowSubdomains', 'allowedHosts', 'allowedOrigins', 'headers', 'maxRedirects', 'signal']);

  await assert.rejects(client.request('/project/pack/version', { query: { include_changelog: 'false' } }), {
    code: 'ARCHIVE_LIMIT_EXCEEDED', message: 'Provider response exceeded the configured byte limit'
  });
  assert.equal(streams[1].destroyed, true);
  assert.equal(client.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
});

test('a per-request byte limit bounds declared and measured bytes at its exact boundary', async () => {
  const limit = MAX_REQUEST_RESPONSE_BYTES;
  const bytes = Buffer.alloc(limit + 1, 0x61);
  let next;
  const client = new BoundedApiClient({ client: { async request() { return next(); } }, baseUrl: 'https://api.modrinth.com/v2/' });

  next = () => chunkedResponse(bytes.subarray(0, limit), { 'content-length': String(limit) });
  assert.equal((await client.request('/exact', { maxResponseBytes: limit })).body.length, limit);

  let measured;
  next = () => { measured = chunkedResponse(bytes); return measured; };
  await assert.rejects(client.request('/measured', { maxResponseBytes: limit }), error =>
    error.code === 'ARCHIVE_LIMIT_EXCEEDED' && error.details?.actual === String(limit + 1));
  assert.equal(measured.destroyed, true);

  let declaredDestroyed = false;
  next = () => {
    const declared = response(Buffer.alloc(0), 200, { 'content-length': String(limit + 1) });
    declared.destroy = () => { declaredDestroyed = true; };
    return declared;
  };
  await assert.rejects(client.request('/declared', { maxResponseBytes: limit }), error =>
    error.code === 'ARCHIVE_LIMIT_EXCEEDED' && error.details?.actual === String(limit + 1));
  assert.equal(declaredDestroyed, true);

  // A request may also tighten its limit below the client default.
  next = () => response(Buffer.alloc(5));
  await assert.rejects(client.request('/tight', { maxResponseBytes: 4 }), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
  next = () => response(Buffer.alloc(4));
  assert.equal((await client.request('/tight', { maxResponseBytes: 4 })).body.length, 4);
});

test('per-request byte limits accept 1 through the ceiling and refuse anything else before any transport call', async () => {
  const calls = [];
  const client = new BoundedApiClient({
    client: { async request(url) { calls.push(url); return response(Buffer.from('x')); } },
    baseUrl: 'https://api.modrinth.com/v2/'
  });
  for (const maxResponseBytes of [1, MAX_REQUEST_RESPONSE_BYTES, undefined]) {
    assert.equal((await client.request('/accepted', { maxResponseBytes })).body.toString('utf8'), 'x');
  }
  assert.equal(calls.length, 3);
  for (const maxResponseBytes of [0, -1, 1.5, MAX_REQUEST_RESPONSE_BYTES + 1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1024', null, 1024n, {}]) {
    await assert.rejects(client.request('/refused', { maxResponseBytes }), error =>
      error.code === 'INVALID_RELEASE_URL' && error.retryable === false);
  }
  // Other unknown options are still refused.
  await assert.rejects(client.request('/refused', { maxBytes: 1024 }), error => error.code === 'INVALID_RELEASE_URL');
  assert.equal(calls.length, 3);
});

test('the client-wide byte limit keeps its 2 MiB maximum', () => {
  const dependency = { request() {} };
  for (const maxResponseBytes of [0, DEFAULT_MAX_RESPONSE_BYTES + 1, MAX_REQUEST_RESPONSE_BYTES, 1.5, '1']) {
    assert.throws(
      () => new BoundedApiClient({ client: dependency, baseUrl: 'https://api.modrinth.com/v2/', maxResponseBytes }),
      /Bounded API client dependencies are invalid/
    );
  }
  const client = new BoundedApiClient({ client: dependency, baseUrl: 'https://api.modrinth.com/v2/', maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES });
  assert.equal(client.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
});
