const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const { BoundedApiClient } = require('../../electron/services/modpacks/network/bounded-api-client.cjs');

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
