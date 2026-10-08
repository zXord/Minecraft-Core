const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyServerNetworkProperties,
  MAX_SERVER_PROPERTIES_BYTES,
  readEffectiveServerProperty
} = require('../electron/utils/server-network-properties.cjs');

test('shared properties reader follows Java separators, escapes, continuations, and last-value semantics', () => {
  const properties = Buffer.from([
    '# preserved comment',
    'server-ip:192.0.2.10',
    'server\\u002dip 127.0.0.' + '\\',
    '    \\u0031',
    'server\\-port:25563',
    'server-port=25564',
    'server\\u002dport:25565'
  ].join('\r\n') + '\r\n', 'utf8');

  assert.equal(readEffectiveServerProperty(properties, 'server-ip'), '127.0.0.1');
  assert.equal(readEffectiveServerProperty(properties, 'server-port'), '25565');
  assert.equal(readEffectiveServerProperty(properties, 'missing-property'), null);
});

test('shared properties reader matches Java escaping at end of file', () => {
  const terminalContinuation = Buffer.from('server-ip=127.0.0.1' + '\\', 'utf8');
  const escapedValue = Buffer.from('server-ip=local\\host\nserver-port=25565\n', 'utf8');
  const continuedKey = Buffer.from('server-' + '\\' + '\r\n \tip=127.0.0.1\n', 'utf8');
  const unicodeValue = Buffer.from('server-ip=\\u005b::1\\u005d\n', 'utf8');

  assert.equal(readEffectiveServerProperty(terminalContinuation, 'server-ip'), '127.0.0.1');
  assert.equal(readEffectiveServerProperty(escapedValue, 'server-ip'), 'localhost');
  assert.equal(readEffectiveServerProperty(continuedKey, 'server-ip'), '127.0.0.1');
  assert.equal(readEffectiveServerProperty(unicodeValue, 'server-ip'), '[::1]');
});

test('network overlay removes every semantic network-key duplicate and preserves comments and CRLF style', () => {
  const properties = Buffer.from([
    '# publisher comment',
    'server-ip:192.0.2.10',
    'server\\u002dip 192.0.2.' + '\\',
    '    11',
    'server-port 25564',
    'server\\u002dport:25565',
    'motd=Keep me'
  ].join('\r\n') + '\r\n', 'utf8');

  const overlaid = applyServerNetworkProperties(properties, {
    port: 25571,
    networkAccess: 'loopback'
  });

  assert.equal(overlaid.toString('utf8'), [
    '# publisher comment',
    'motd=Keep me',
    'server-port=25571',
    'server-ip=127.0.0.1'
  ].join('\r\n') + '\r\n');
  assert.equal(readEffectiveServerProperty(overlaid, 'server-ip'), '127.0.0.1');
  assert.equal(readEffectiveServerProperty(overlaid, 'server-port'), '25571');
});

test('network overlay preserves exact unrelated comments, line endings, blanks, and escaped non-target keys', () => {
  const original = Buffer.from(
    '# publisher comment\r\n' +
    'server-ip:192.0.2.10\r' +
    'server-' + '\\' + '\r\n \tip=192.0.2.11\r' +
    'server-ip\\=shadow=value\n' +
    'server-ip\\u003dshadow=other\r' +
    'motd=Keep me\r\n' +
    '\r\n' +
    '! tail comment\n' +
    '\r\n',
    'utf8'
  );

  const overlaid = applyServerNetworkProperties(original, {
    port: 25571,
    networkAccess: 'loopback'
  });

  assert.deepEqual(overlaid, Buffer.from(
    '# publisher comment\r\n' +
    'server-ip\\=shadow=value\n' +
    'server-ip\\u003dshadow=other\r' +
    'motd=Keep me\r\n' +
    '\r\n' +
    '! tail comment\n' +
    '\r\n' +
    'server-port=25571\r\n' +
    'server-ip=127.0.0.1\r\n',
    'utf8'
  ));
});

test('network overlay separates appended properties from a Java continuation at end of file', () => {
  const original = Buffer.from('motd=Keep me' + '\\', 'utf8');

  const overlaid = applyServerNetworkProperties(original, {
    port: 25571,
    networkAccess: 'loopback'
  });

  assert.equal(overlaid.toString('utf8'),
    'motd=Keep me' + '\\' + '\n\n' +
    'server-port=25571\n' +
    'server-ip=127.0.0.1\n');
  assert.equal(readEffectiveServerProperty(overlaid, 'motd'), 'Keep me');
  assert.equal(readEffectiveServerProperty(overlaid, 'server-port'), '25571');
});

test('shared properties reader fails closed on a malformed Unicode escape', () => {
  const malformed = Buffer.from('server\\u00G0ip=127.0.0.1\n', 'utf8');
  const malformedValue = Buffer.from('server-ip=127.0.0.\\u00G0\n', 'utf8');
  const repeatedUnicodeMarker = Buffer.from('server\\uu002dip=127.0.0.1\n', 'utf8');
  const malformedComment = Buffer.from('# server-ip=\\u00G0\nserver-ip=127.0.0.1\n', 'utf8');

  assert.throws(
    () => readEffectiveServerProperty(malformed, 'server-ip'),
    error => error instanceof TypeError && /properties/i.test(error.message)
  );
  assert.throws(
    () => applyServerNetworkProperties(malformed, { port: 25571, networkAccess: 'loopback' }),
    error => error instanceof TypeError && /properties/i.test(error.message)
  );
  assert.throws(
    () => readEffectiveServerProperty(malformedValue, 'server-ip'),
    error => error instanceof TypeError && /properties/i.test(error.message)
  );
  assert.throws(
    () => readEffectiveServerProperty(repeatedUnicodeMarker, 'server-ip'),
    error => error instanceof TypeError && /properties/i.test(error.message)
  );
  assert.equal(readEffectiveServerProperty(malformedComment, 'server-ip'), '127.0.0.1');
});

test('shared properties reader is bounded and rejects invalid UTF-8 without replacement corruption', () => {
  const oversized = Buffer.alloc(MAX_SERVER_PROPERTIES_BYTES + 1, 0x61);
  const invalidUtf8 = Buffer.from([0x73, 0x65, 0x72, 0x76, 0x65, 0x72, 0x2d, 0x69, 0x70, 0x3d, 0xff]);

  assert.throws(
    () => readEffectiveServerProperty(oversized, 'server-ip'),
    error => error instanceof TypeError && /properties/i.test(error.message)
  );
  assert.throws(
    () => applyServerNetworkProperties(invalidUtf8, { port: 25571, networkAccess: 'loopback' }),
    error => error instanceof TypeError && /properties/i.test(error.message)
  );
});
