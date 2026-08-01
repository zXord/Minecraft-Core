const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MRPACK_MANIFEST_MAX_BYTES,
  parseMrpackManifest,
  validateMrpackManifest
} = require('../../electron/services/modpacks/mrpack/mrpack-parser.cjs');
const { ARCHIVE_LIMITS } = require('../../electron/services/modpacks/limits.cjs');

function manifest(overrides = {}) {
  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'pack-version-1',
    name: 'Pack',
    summary: 'Server pack',
    files: [{
      path: 'mods/example.jar',
      hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
      env: { client: 'required', server: 'required' },
      downloads: ['https://cdn.modrinth.com/data/a/versions/b/example.jar'],
      fileSize: 123
    }],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' },
    ...overrides
  };
}

test('parses only a bounded supplied UTF-8 manifest buffer and returns a frozen normalized value', () => {
  const parsed = parseMrpackManifest(Buffer.from(JSON.stringify(manifest()), 'utf8'));
  assert.equal(parsed.files[0].fileSize, '123');
  assert.equal(parsed.files[0].path, 'mods/example.jar');
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.files[0].hashes));
  assert.throws(() => parseMrpackManifest(JSON.stringify(manifest())), error => error.code === 'MANIFEST_INVALID');
  assert.throws(() => parseMrpackManifest(Buffer.alloc(MRPACK_MANIFEST_MAX_BYTES + 1, 0x20)), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
  assert.throws(() => parseMrpackManifest(Buffer.from([0xc3, 0x28])), error => error.code === 'MANIFEST_INVALID');
  assert.throws(() => parseMrpackManifest(Buffer.from('{"token":"secret"}', 'utf8')), error => error.code === 'MANIFEST_INVALID' && !String(error.message).includes('secret'));
});

test('requires format version one minecraft metadata and exact supported dependencies', () => {
  for (const bad of [
    manifest({ formatVersion: 2 }), manifest({ formatVersion: '1' }), manifest({ game: 'other' }),
    manifest({ versionId: '' }), manifest({ name: '' }), manifest({ dependencies: {} }),
    manifest({ dependencies: { minecraft: '1.21.1', unknown: '1' } })
  ]) {
    assert.throws(() => validateMrpackManifest(bad), error => error.code === 'MANIFEST_INVALID');
  }
  assert.deepEqual(validateMrpackManifest(manifest({ dependencies: { minecraft: '1.21.1' } })).dependencies, { minecraft: '1.21.1' });
});

test('multiple MRPACK loader dependencies fail with LOADER_CONFLICT', () => {
  assert.throws(
    () => validateMrpackManifest(manifest({ dependencies: { minecraft: '1.21.1', forge: '1', neoforge: '2' } })),
    error => error.code === 'LOADER_CONFLICT'
  );
});

test('requires lower-case SHA-1 and SHA-512 with exact lengths and safe integer sizes', () => {
  const good = manifest();
  for (const files of [
    [{ ...good.files[0], hashes: { sha512: 'b'.repeat(128) } }],
    [{ ...good.files[0], hashes: { sha1: 'a'.repeat(40) } }],
    [{ ...good.files[0], hashes: { sha1: 'A'.repeat(40), sha512: 'b'.repeat(128) } }],
    [{ ...good.files[0], hashes: { sha1: 'a'.repeat(39), sha512: 'b'.repeat(128) } }],
    [{ ...good.files[0], hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(127) } }],
    [{ ...good.files[0], fileSize: -1 }],
    [{ ...good.files[0], fileSize: Number.MAX_SAFE_INTEGER + 1 }]
  ]) assert.throws(() => validateMrpackManifest(manifest({ files })), error => error.code === 'MANIFEST_INVALID');
});

test('normalizes target separators and rejects traversal Windows aliases devices and reserved state paths', () => {
  const normalized = validateMrpackManifest(manifest({ files: [{ ...manifest().files[0], path: 'config\\nested\\file.toml' }] }));
  assert.equal(normalized.files[0].path, 'config/nested/file.toml');

  for (const path of [
    '../escape.jar', '/absolute.jar', '\\server\\share.jar', 'C:\\drive.jar', 'mods/../escape.jar',
    'mods/file.jar.', 'mods/file.jar ', 'mods/AUX.txt', 'mods/name:stream', 'mods/\u0000bad',
    '.minecraft-core-state/owned.json', '.Minecraft-CoreFuture/file', 'mods//empty.jar'
  ]) {
    assert.throws(() => validateMrpackManifest(manifest({ files: [{ ...manifest().files[0], path }] })), error => error.code === 'MANIFEST_INVALID');
  }
});

test('rejects Win32 superscript COM and LPT device aliases in manifest targets', () => {
  for (const device of ['COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³']) {
    assert.throws(
      () => validateMrpackManifest(manifest({ files: [{ ...manifest().files[0], path: `mods/${device}.jar` }] })),
      error => error.code === 'MANIFEST_INVALID'
    );
  }
});

test('rejects duplicate file targets using Windows case and Unicode aliases', () => {
  const first = manifest().files[0];
  for (const alias of ['MODS/EXAMPLE.JAR', 'mods/e\u0301.jar']) {
    const base = alias.includes('e\u0301') ? { ...first, path: 'mods/\u00e9.jar' } : first;
    assert.throws(() => validateMrpackManifest(manifest({ files: [base, { ...first, path: alias }] })), error => error.code === 'ARCHIVE_ENTRY_COLLISION');
  }
});

test('enforces exact public HTTPS download hosts without credentials or non-default ports', () => {
  for (const host of ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']) {
    const parsed = validateMrpackManifest(manifest({ files: [{ ...manifest().files[0], downloads: [`https://${host}/owner/file.jar`] }] }));
    assert.equal(parsed.files[0].downloads[0], `https://${host}/owner/file.jar`);
  }
  for (const url of [
    'http://cdn.modrinth.com/file.jar', 'https://user:pass@cdn.modrinth.com/file.jar',
    'https://evil.example/file.jar', 'https://sub.cdn.modrinth.com/file.jar',
    'https://cdn.modrinth.com:444/file.jar', 'https://127.0.0.1/file.jar'
  ]) assert.throws(() => validateMrpackManifest(manifest({ files: [{ ...manifest().files[0], downloads: [url] }] })), error => error.code === 'INVALID_RELEASE_URL');
});

test('normalizes absent environment as required and validates explicit server states', () => {
  const source = manifest().files[0];
  assert.deepEqual(validateMrpackManifest(manifest({ files: [{ ...source, env: undefined }] })).files[0].env, { client: 'required', server: 'required' });
  for (const server of ['required', 'optional', 'unsupported']) {
    assert.equal(validateMrpackManifest(manifest({ files: [{ ...source, env: { client: 'optional', server } }] })).files[0].env.server, server);
  }
  assert.throws(() => validateMrpackManifest(manifest({ files: [{ ...source, env: { client: 'required' } }] })), error => error.code === 'MANIFEST_INVALID');
  assert.throws(() => validateMrpackManifest(manifest({ files: [{ ...source, env: { client: 'required', server: 'maybe' } }] })), error => error.code === 'MANIFEST_INVALID');
});

test('enforces the central per-file expanded-byte limit at its exact boundary', () => {
  const maximum = Number(BigInt(ARCHIVE_LIMITS.maxFileExpandedBytes));
  assert.equal(validateMrpackManifest(manifest({ files: [{ ...manifest().files[0], fileSize: maximum }] })).files[0].fileSize, String(maximum));
  assert.throws(
    () => validateMrpackManifest(manifest({ files: [{ ...manifest().files[0], fileSize: maximum + 1 }] })),
    error => error.code === 'ARCHIVE_LIMIT_EXCEEDED' && error.details?.limit === 'maxFileExpandedBytes' && error.details?.actual === String(maximum + 1)
  );
});
