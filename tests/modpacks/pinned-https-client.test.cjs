const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { getEventListeners } = require('node:events');
const { Readable } = require('node:stream');
const https = require('node:https');
const selfsigned = require('selfsigned');

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

test('pinned redirects remain inside the exact allowed origin set and reject explicit ports before DNS', async () => {
  const redirect = new TrackedResponse({
    statusCode: 302,
    headers: { location: 'https://two.example/final' }
  });
  const h = harness({
    'https://one.example/start': { response: redirect },
    'https://two.example/final': {}
  });
  await assert.rejects(h.client.request('https://one.example/start', {
    allowedHosts: ['one.example', 'two.example'],
    allowedOrigins: ['https://one.example']
  }), invalid);
  assert.equal(h.calls.length, 1);
  assert.equal(redirect.bodyReads, 0);

  const alternate = harness({});
  await assert.rejects(alternate.client.request('https://one.example:444/file', {
    allowedHosts: ['one.example'],
    allowedOrigins: ['https://one.example']
  }), invalid);
  assert.equal(alternate.lookupCalls.length, 0);
  assert.equal(alternate.calls.length, 0);
});

test('request and redirect failures expose no query, token, provider body, or URL in ModpackError', async () => {
  const secretUrl = 'https://cdn.example/file?token=top-secret';
  const h = harness({ [secretUrl]: { error: new Error(`provider failed for ${secretUrl}: private-body`) } });
  await assert.rejects(h.client.request(secretUrl, { allowedHosts: ['cdn.example'] }), error => {
    const rendered = JSON.stringify({ message: error.message, details: error.details, public: error.toPublicResult() });
    return error.code === 'INVALID_RELEASE_URL' && !rendered.includes('top-secret') && !rendered.includes('private-body') && !rendered.includes('https://');
  });
});

async function localTlsFixture(certificateHost) {
  const generated = await selfsigned.generate([{ name: 'commonName', value: certificateHost }], {
    days: 1, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: certificateHost }] }]
  });
  const server = https.createServer({ key: generated.private, cert: generated.cert }, (_request, response) => response.end('trusted-body'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const request = (url, options, callback) => {
    const routed = new URL(url); routed.port = String(port);
    return https.request(routed, { ...options, ca: generated.cert, lookup: (_hostname, lookupOptions, done) => lookupOptions?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4) }, response => {
      Object.defineProperty(response.socket, 'remoteAddress', { configurable: true, value: '8.8.8.8' });
      callback(response);
    });
  };
  return { request, close: () => new Promise(resolve => server.close(resolve)) };
}

test('actual local HTTPS accepts a trusted certificate for the vetted hostname', async () => {
  const tlsFixture = await localTlsFixture('download.test');
  const client = new PinnedHttpsClient({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: tlsFixture.request });
  try {
    const response = await client.request('https://download.test/file', { allowedHosts: ['download.test'] });
    let body = ''; for await (const chunk of response) body += chunk;
    assert.equal(body, 'trusted-body');
  } finally { await tlsFixture.close(); }
});

test('actual local HTTPS rejects a trusted certificate for the wrong hostname', async () => {
  const tlsFixture = await localTlsFixture('wrong.test');
  const client = new PinnedHttpsClient({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: tlsFixture.request });
  try {
    await assert.rejects(client.request('https://download.test/file', { allowedHosts: ['download.test'] }), invalid);
  } finally { await tlsFixture.close(); }
});

test('abort before connect returns CANCELLED without DNS or request activity', async () => {
  const controller = new AbortController(); controller.abort(); let lookups = 0; let requests = 0;
  const client = new PinnedHttpsClient({ lookup: async () => { lookups += 1; return [{ address: '8.8.8.8', family: 4 }]; }, request: () => { requests += 1; } });
  await assert.rejects(client.request('https://cdn.example/file', { allowedHosts: ['cdn.example'], signal: controller.signal }), error => error.code === 'CANCELLED');
  assert.equal(lookups, 0); assert.equal(requests, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort during a pending request destroys it, returns CANCELLED, and removes listeners', async () => {
  const controller = new AbortController(); let destroyed = false;
  const request = () => { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed = true; queueMicrotask(() => req.emit('error', Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))); }; return req; };
  const client = new PinnedHttpsClient({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request });
  const pending = client.request('https://cdn.example/file', { allowedHosts: ['cdn.example'], signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(destroyed, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort at a redirect DNS boundary returns CANCELLED before another request', async () => {
  const controller = new AbortController(); let resolveSecond; let lookupCount = 0; let requestCount = 0;
  const lookup = async () => { lookupCount += 1; if (lookupCount === 1) return [{ address: '8.8.8.8', family: 4 }]; return new Promise(resolve => { resolveSecond = resolve; }); };
  const redirect = new TrackedResponse({ statusCode: 302, headers: { location: '/final' } });
  const request = (_url, options, callback) => { requestCount += 1; const req = new EventEmitter(); req.destroy = error => error && queueMicrotask(() => req.emit('error', error)); req.end = () => options.lookup('cdn.example', {}, () => callback(redirect)); return req; };
  const client = new PinnedHttpsClient({ lookup, request });
  const pending = client.request('https://cdn.example/start', { allowedHosts: ['cdn.example'], signal: controller.signal });
  while (!resolveSecond) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const outcome = await Promise.race([
    pending.then(() => 'resolved', error => error.code),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 100))
  ]);
  resolveSecond([{ address: '8.8.8.8', family: 4 }]);
  assert.equal(outcome, 'CANCELLED');
  assert.equal(requestCount, 1); assert.equal(redirect.destroyed, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort after final response destroys the body with CANCELLED and releases listeners', async () => {
  const controller = new AbortController(); const h = harness({ 'https://cdn.example/file': {} });
  const response = await h.client.request('https://cdn.example/file', { allowedHosts: ['cdn.example'], signal: controller.signal });
  const errorPromise = new Promise(resolve => response.once('error', resolve)); controller.abort();
  const error = await errorPromise;
  assert.equal(error.code, 'CANCELLED'); assert.equal(response.destroyed, true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('successful final response close releases the abort listener', async () => {
  const controller = new AbortController(); const h = harness({ 'https://cdn.example/file': {} });
  const response = await h.client.request('https://cdn.example/file', { allowedHosts: ['cdn.example'], signal: controller.signal });
  response.destroy(); await new Promise(resolve => response.once('close', resolve));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
