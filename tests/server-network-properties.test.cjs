const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyServerNetworkProperties,
  MAX_SERVER_PROPERTIES_BYTES,
  overlayServerProperties,
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

test('network overlay replaces the first semantic entry in place, removes later duplicates, and preserves CRLF style', () => {
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
    'server-ip=127.0.0.1',
    'server-port=25571',
    'motd=Keep me'
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
    'server-ip=127.0.0.1\r' +
    'server-ip\\=shadow=value\n' +
    'server-ip\\u003dshadow=other\r' +
    'motd=Keep me\r\n' +
    '\r\n' +
    '! tail comment\n' +
    '\r\n' +
    'server-port=25571\r\n',
    'utf8'
  ));
});

test('network overlay keeps a Minecraft-shaped file byte-identical when nothing changes and edits a changed port in place', () => {
  const minecraftShaped = Buffer.from([
    '#Minecraft server properties',
    '#Thu Oct 29 21:14:03 AST 2026',
    'allow-flight=false',
    'motd=A Minecraft Server',
    'server-ip=',
    'server-port=25565',
    'view-distance=10'
  ].join('\n') + '\n', 'utf8');

  assert.deepEqual(applyServerNetworkProperties(minecraftShaped, { port: 25565, networkAccess: 'pack-default' }), minecraftShaped);
  assert.equal(
    applyServerNetworkProperties(minecraftShaped, { port: 25570, networkAccess: 'pack-default' }).toString('utf8'),
    minecraftShaped.toString('utf8').replace('server-port=25565\n', 'server-port=25570\n')
  );
  const loopback = applyServerNetworkProperties(minecraftShaped, { port: 25565, networkAccess: 'loopback' });
  assert.equal(
    loopback.toString('utf8'),
    minecraftShaped.toString('utf8').replace('server-ip=\n', 'server-ip=127.0.0.1\n')
  );
  assert.deepEqual(applyServerNetworkProperties(loopback, { port: 25565, networkAccess: 'loopback' }), loopback);
});

test('network overlay removes a later duplicate together with its continuation lines and keeps a final unterminated entry unterminated', () => {
  const original = Buffer.from(
    'server-port=25564\n' +
    'motd=Keep me\n' +
    'server\\u002dport 2556' + '\\' + '\n' +
    '    5\n' +
    'view-distance=9\n' +
    'server-ip=192.0.2.10',
    'utf8'
  );

  const overlaid = applyServerNetworkProperties(original, { port: 25571, networkAccess: 'loopback' });

  assert.equal(overlaid.toString('utf8'),
    'server-port=25571\n' +
    'motd=Keep me\n' +
    'view-distance=9\n' +
    'server-ip=127.0.0.1');
  assert.equal(readEffectiveServerProperty(overlaid, 'server-port'), '25571');
  assert.equal(readEffectiveServerProperty(overlaid, 'server-ip'), '127.0.0.1');
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
    () => readEffectiveServerProperty(invalidUtf8, 'server-ip'),
    error => error instanceof TypeError && /properties/i.test(error.message)
  );
  assert.throws(
    () => applyServerNetworkProperties(oversized, { port: 25571, networkAccess: 'loopback' }),
    error => error instanceof TypeError && /properties/i.test(error.message)
  );
});

test('network overlay keeps an ANSI (cp1252) MOTD byte-exact while replacing the port in place', () => {
  const ansi = Buffer.concat([
    Buffer.from('#Minecraft server properties\r\nmotd=', 'ascii'),
    Buffer.from([0xa7, 0x36, 0x43, 0x61, 0x66, 0xe9]),
    Buffer.from('\r\nserver-port=25565\r\nlevel-name=world\r\n', 'ascii')
  ]);

  const overlaid = applyServerNetworkProperties(ansi, { port: 25571, networkAccess: 'pack-default' });

  assert.deepEqual(overlaid, Buffer.concat([
    Buffer.from('#Minecraft server properties\r\nmotd=', 'ascii'),
    Buffer.from([0xa7, 0x36, 0x43, 0x61, 0x66, 0xe9]),
    Buffer.from('\r\nserver-port=25571\r\nlevel-name=world\r\n', 'ascii')
  ]));
  assert.deepEqual(applyServerNetworkProperties(overlaid, { port: 25571, networkAccess: 'pack-default' }), overlaid);
  assert.throws(
    () => readEffectiveServerProperty(ansi, 'level-name'),
    error => error instanceof TypeError && /properties/i.test(error.message)
  );
});

test('network overlay keeps UTF-8 text byte-exact and accepts only printable ASCII overlay values', () => {
  const utf8 = Buffer.from('motd=§6Café ☃\nserver-port=25565\n', 'utf8');
  assert.deepEqual(
    overlayServerProperties(utf8, { 'server-port': 25570 }),
    Buffer.from('motd=§6Café ☃\nserver-port=25570\n', 'utf8')
  );
  assert.deepEqual(
    overlayServerProperties(utf8, { motd: 'minecraft-core-health:0123abcd', 'enable-query': false }),
    Buffer.from('motd=minecraft-core-health:0123abcd\nserver-port=25565\nenable-query=false\n', 'utf8')
  );

  for (const value of ['Café', '§6', 'line\nbreak', 'tab\tvalue', 'nul\u0000', '\u007f']) {
    assert.throws(
      () => overlayServerProperties(utf8, { motd: value }),
      error => error instanceof TypeError && /overlay/i.test(error.message),
      JSON.stringify(value)
    );
  }
});
