const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { PinnedHttpsClient } = require('../../electron/services/modpacks/network/pinned-https-client.cjs');

class TrackedResponse extends Readable {
  constructor({ statusCode = 200, headers = {}, body = '', peer = '8.8.8.8' } = {}) {
    super(); this.statusCode = statusCode; this.headers = headers; this.socket = { remoteAddress: peer }; this.bodyReads = 0; this.body = Buffer.from(body); this.sent = false;
  }
  _read() { this.bodyReads += 1; if (!this.sent) { this.sent = true; this.push(this.body); this.push(null); } }
}

function harness(routes, dnsAnswers = {}) {
  const calls = [];
  const lookupCalls = [];
  const lookup = async (hostname, options) => {
    lookupCalls.push({ hostname, options });
    const answer = dnsAnswers[hostname] || [{ address: '8.8.8.8', family: 4 }];
    return typeof answer === 'function' ? answer() : answer;
  };
  const request = (url, options, callback) => {
    const req = new EventEmitter(); req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); }; req.end = () => {
      options.lookup(url.hostname, {}, (error, address, family) => {
        if (error) return req.emit('error', error);
        const route = routes[url.href];
        calls.push({ url: url.href, options, pinned: { address, family } });
        if (!route) return req.emit('error', new Error(`unexpected route ${url.href}`));
        if (route.error) return req.emit('error', route.error);
        const response = route.response || new TrackedResponse(route);
        callback(response);
      });
    }; return req;
  };
  return { client: new PinnedHttpsClient({ lookup, request }), calls, lookupCalls };
}

function invalid(error) { return error?.code === 'INVALID_RELEASE_URL'; }

test('a redirect to a private address is rejected before a body is read', async () => {
  const publicUrl = 'https://public.example/start';
  const redirectResponse = new TrackedResponse({ statusCode: 302, headers: { location: 'https://private.example/secret?token=hidden' } });
  const routes = { [publicUrl]: { response: redirectResponse } };
  const { client, calls } = harness(routes, { 'public.example': [{ address: '8.8.8.8', family: 4 }], 'private.example': [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(client.request(publicUrl, { allowedHosts: ['public.example', 'private.example'] }), invalid);
  assert.equal(calls.length, 1);
  assert.equal(redirectResponse.bodyReads, 0);
});

test('DNS is resolved once per hop and the HTTPS socket lookup is pinned to a vetted answer', async () => {
  let resolutions = 0;
  const { client, calls } = harness({ 'https://cdn.example/file': {} }, {
    'cdn.example': () => (++resolutions === 1 ? [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }])
  });
  const response = await client.request('https://cdn.example/file', { allowedHosts: ['cdn.example'] });
  response.destroy();
  assert.equal(resolutions, 1);
  assert.deepEqual(calls[0].pinned, { address: '8.8.8.8', family: 4 });
});

test('a connected peer outside the vetted set is rejected and normalized mapped peers compare safely', async () => {
  const wrong = harness({ 'https://cdn.example/wrong': { peer: '1.1.1.1' } }, { 'cdn.example': [{ address: '8.8.8.8', family: 4 }] });
  await assert.rejects(wrong.client.request('https://cdn.example/wrong', { allowedHosts: ['cdn.example'] }), invalid);
  const mapped = harness({ 'https://cdn.example/mapped': { peer: '::ffff:8.8.8.8' } }, { 'cdn.example': [{ address: '8.8.8.8', family: 4 }] });
  const response = await mapped.client.request('https://cdn.example/mapped', { allowedHosts: ['cdn.example'] });
  response.destroy();
});

test('HTTPS options preserve TLS SNI and built-in hostname validation', async () => {
  const h = harness({ 'https://cdn.example/file': {} });
  const response = await h.client.request('https://cdn.example/file', { allowedHosts: ['cdn.example'] }); response.destroy();
  assert.equal(h.calls[0].options.servername, 'cdn.example');
  assert.equal(h.calls[0].options.rejectUnauthorized, true);
  assert.equal(typeof h.calls[0].options.checkServerIdentity, 'function');
  assert.ok(h.calls[0].options.checkServerIdentity('cdn.example', { subjectaltname: 'DNS:wrong.example' }) instanceof Error);
});

test('redirect loops and redirect counts beyond the cap fail closed without consuming redirect bodies', async () => {
  const loopA = new TrackedResponse({ statusCode: 302, headers: { location: '/b' } });
  const loopB = new TrackedResponse({ statusCode: 307, headers: { location: '/a' } });
  const loop = harness({ 'https://cdn.example/a': { response: loopA }, 'https://cdn.example/b': { response: loopB } });
  await assert.rejects(loop.client.request('https://cdn.example/a', { allowedHosts: ['cdn.example'], maxRedirects: 5 }), invalid);
  assert.equal(loopA.bodyReads, 0); assert.equal(loopB.bodyReads, 0);
  const capped = harness({
    'https://cdn.example/0': { statusCode: 302, headers: { location: '/1' } },
    'https://cdn.example/1': { statusCode: 302, headers: { location: '/2' } }
  });
  await assert.rejects(capped.client.request('https://cdn.example/0', { allowedHosts: ['cdn.example'], maxRedirects: 1 }), invalid);
});

test('redirect requests stay GET-only, reject unsafe framing headers, and strip credentials across origins', async () => {
  const h = harness({
    'https://one.example/start': { statusCode: 303, headers: { location: 'https://two.example/final' } },
    'https://two.example/final': {}
  });
  const response = await h.client.request('https://one.example/start', {
    allowedHosts: ['one.example', 'two.example'],
    headers: { accept: 'application/octet-stream', authorization: 'Bearer secret', cookie: 'sid=secret' }
  }); response.destroy();
  assert.deepEqual(h.calls.map(call => call.options.method), ['GET', 'GET']);
  assert.equal(h.calls[1].options.headers.accept, 'application/octet-stream');
  assert.equal(h.calls[1].options.headers.authorization, undefined);
  assert.equal(h.calls[1].options.headers.cookie, undefined);
  await assert.rejects(h.client.request('https://one.example/start', { allowedHosts: ['one.example'], headers: { host: 'evil.test' } }), invalid);
  await assert.rejects(h.client.request('https://one.example/start', { allowedHosts: ['one.example'], headers: { 'content-length': '10' } }), invalid);
});

test('request and redirect failures expose no query, token, provider body, or URL in ModpackError', async () => {
  const secretUrl = 'https://cdn.example/file?token=top-secret';
  const h = harness({ [secretUrl]: { error: new Error(`provider failed for ${secretUrl}: private-body`) } });
  await assert.rejects(h.client.request(secretUrl, { allowedHosts: ['cdn.example'] }), error => {
    const rendered = JSON.stringify({ message: error.message, details: error.details, public: error.toPublicResult() });
    return error.code === 'INVALID_RELEASE_URL' && !rendered.includes('top-secret') && !rendered.includes('private-body') && !rendered.includes('https://');
  });
});
