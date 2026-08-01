const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateRemoteUrl,
  resolvePublicAddresses
} = require('../../electron/services/modpacks/network/remote-url-policy.cjs');

function invalidReleaseUrl(error) {
  return error?.code === 'INVALID_RELEASE_URL' && !JSON.stringify(error.toPublicResult()).includes('?');
}

test('remote URLs reject credentials, malformed input, and every non-HTTPS scheme without leaking the URL', () => {
  for (const value of [
    'not a URL',
    'http://downloads.example/file.zip?token=secret',
    'ftp://downloads.example/file.zip',
    'https://user:password@downloads.example/file.zip?token=secret'
  ]) {
    assert.throws(() => validateRemoteUrl(value, { allowedHosts: ['downloads.example'] }), invalidReleaseUrl);
  }
});

test('host policy is exact unless subdomains are explicitly allowed', () => {
  assert.equal(validateRemoteUrl('https://downloads.example/file', { allowedHosts: ['downloads.example'] }).hostname, 'downloads.example');
  assert.throws(() => validateRemoteUrl('https://cdn.downloads.example/file', { allowedHosts: ['downloads.example'] }), invalidReleaseUrl);
  assert.equal(validateRemoteUrl('https://cdn.downloads.example/file', { allowedHosts: ['downloads.example'], allowSubdomains: true }).hostname, 'cdn.downloads.example');
  assert.throws(() => validateRemoteUrl('https://downloads.example.evil.test/file', { allowedHosts: ['downloads.example'], allowSubdomains: true }), invalidReleaseUrl);
});

test('host matching normalizes case, IDNs, and one terminal DNS dot', () => {
  assert.equal(validateRemoteUrl('https://DOWNLOADS.EXAMPLE./file', { allowedHosts: ['downloads.example'] }).hostname, 'downloads.example.');
  assert.equal(validateRemoteUrl('https://xn--bcher-kva.example/file', { allowedHosts: ['bücher.example'] }).hostname, 'xn--bcher-kva.example');
});

test('provider URL policy rejects IPv4, IPv6, bracketed, and scoped literal hosts before DNS', () => {
  for (const value of [
    'https://8.8.8.8/file',
    'https://127.0.0.1/file',
    'https://[2606:4700:4700::1111]/file',
    'https://[::ffff:8.8.8.8]/file',
    'https://[fe80::1%25eth0]/file'
  ]) {
    const allowedHost = value.includes('[') ? value.slice(value.indexOf('['), value.indexOf(']') + 1) : new URL(value).hostname;
    assert.throws(() => validateRemoteUrl(value, { allowedHosts: [allowedHost] }), invalidReleaseUrl, value);
  }
});

test('resolution rejects all IPv4 non-public, reserved, documentation, and CGNAT ranges', async () => {
  const rejected = [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255'
  ];
  for (const address of rejected) {
    await assert.rejects(
      resolvePublicAddresses('downloads.example', { lookup: async () => [{ address, family: 4 }] }),
      invalidReleaseUrl,
      address
    );
  }
});

test('resolution rejects all IPv6 non-public, reserved, documentation, and private mapped forms', async () => {
  const rejected = [
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '2001:db8::1',
    '100::1', '2001:2::1', '2001:10::1', '::ffff:127.0.0.1', '::ffff:192.168.1.1',
    '::ffff:100.64.0.1', '::ffff:192.0.2.1'
  ];
  for (const address of rejected) {
    await assert.rejects(
      resolvePublicAddresses('downloads.example', { lookup: async () => [{ address, family: 6 }] }),
      invalidReleaseUrl,
      address
    );
  }
});

test('resolution accepts public IPv4, IPv6, and public IPv4-mapped IPv6 answers', async () => {
  const answers = [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '::ffff:8.8.4.4', family: 6 }
  ];
  const resolved = await resolvePublicAddresses('downloads.example', { lookup: async () => answers });
  assert.deepEqual(resolved.map(({ address, family }) => ({ address, family })), answers);
});

test('resolution rejects DNS family mismatches and scoped address forms', async () => {
  for (const answer of [
    { address: '8.8.8.8', family: 6 },
    { address: '2606:4700:4700::1111', family: 4 },
    { address: '::ffff:8.8.8.8', family: 4 },
    { address: 'fe80::1%eth0', family: 6 }
  ]) {
    await assert.rejects(resolvePublicAddresses('downloads.example', { lookup: async () => [answer] }), invalidReleaseUrl, JSON.stringify(answer));
  }
});

test('resolution rejects a globally routable IPv6 answer carrying a zone identifier', async () => {
  await assert.rejects(resolvePublicAddresses('downloads.example', {
    lookup: async () => [{ address: '2606:4700:4700::1111%eth0', family: 6 }]
  }), invalidReleaseUrl);
});

test('mapped IPv6 keeps family 6 and rejects its private IPv4 payload', async () => {
  const publicMapped = await resolvePublicAddresses('downloads.example', { lookup: async () => [{ address: '::ffff:8.8.8.8', family: 6 }] });
  assert.deepEqual(publicMapped, [{ address: '::ffff:8.8.8.8', family: 6 }]);
  await assert.rejects(resolvePublicAddresses('downloads.example', { lookup: async () => [{ address: '::ffff:10.0.0.1', family: 6 }] }), invalidReleaseUrl);
});

test('one non-public answer rejects the entire mixed DNS result', async () => {
  await assert.rejects(resolvePublicAddresses('downloads.example', {
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.4', family: 4 }
    ]
  }), invalidReleaseUrl);
});

test('resolution requires nonempty, well-formed address records and uses all/verbatim lookup', async () => {
  let seen;
  await assert.rejects(resolvePublicAddresses('downloads.example', { lookup: async (...args) => { seen = args; return []; } }), invalidReleaseUrl);
  assert.deepEqual(seen, ['downloads.example', { all: true, verbatim: true }]);
  await assert.rejects(resolvePublicAddresses('downloads.example', { lookup: async () => [{ address: 'bad', family: 4 }] }), invalidReleaseUrl);
});
