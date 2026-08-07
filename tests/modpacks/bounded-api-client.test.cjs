const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const { BoundedApiClient } = require('../../electron/services/modpacks/network/bounded-api-client.cjs');

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

test('bounded provider client rejects authority changes, traversal, redirects by policy, and oversized bodies', async () => {
  const underlying = { async request() { return response(Buffer.alloc(5)); } };
  const client = new BoundedApiClient({ client: underlying, baseUrl: 'https://api.github.com/', maxResponseBytes: 4 });
  for (const candidate of ['https://evil.invalid/', '//evil.invalid/', '/../escape', '/%2e%2e/escape', '/a\\b']) {
    await assert.rejects(client.request(candidate), error => error.code === 'INVALID_RELEASE_URL');
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
