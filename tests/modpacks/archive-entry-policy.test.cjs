const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalWindowsArchivePath,
  validateArchiveEntries
} = require('../../electron/services/modpacks/archive/archive-entry-policy.cjs');
const { ARCHIVE_LIMITS } = require('../../electron/services/modpacks/limits.cjs');

function file(path, overrides = {}) {
  return {
    path,
    type: 'file',
    size: '5',
    packedSize: '5',
    encrypted: false,
    attributes: 'A',
    ...overrides
  };
}

function directory(path, overrides = {}) {
  return {
    path,
    type: 'directory',
    size: '0',
    packedSize: '0',
    encrypted: false,
    attributes: 'D',
    ...overrides
  };
}

function hasCode(code, reasonCode) {
  return error => error?.code === code && (!reasonCode || error?.details?.reasonCode === reasonCode) &&
    !/[A-Z]:\\|https?:|secret|\.\.\/world/i.test(error.message);
}

test('normalizes NFC and separator style while returning closed frozen limit evidence', () => {
  const result = validateArchiveEntries([
    directory('config'),
    file('config\\café.toml', { size: '12', packedSize: '10' }),
    file('🚀/mod.jar', { size: '20', packedSize: '18' })
  ], ARCHIVE_LIMITS);

  assert.deepEqual(result.entries.map(entry => ({ path: entry.path, canonicalPath: entry.canonicalPath })), [
    { path: 'config', canonicalPath: 'config' },
    { path: 'config/café.toml', canonicalPath: 'config/café.toml' },
    { path: '🚀/mod.jar', canonicalPath: '🚀/mod.jar' }
  ]);
  assert.deepEqual(result.totals, {
    entryCount: 3,
    fileCount: 2,
    directoryCount: 1,
    expandedBytes: '32',
    packedBytes: '28',
    maximumDepth: 2,
    maximumPathLength: 16
  });
  assert.equal(result.policyVersion, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.entries), true);
});

test('canonical Windows comparison is NFC and locale-stable case-insensitive', () => {
  assert.equal(canonicalWindowsArchivePath('Mods/CAFÉ.jar'), 'mods/café.jar');
  assert.equal(canonicalWindowsArchivePath('Mods/Cafe\u0301.jar'), 'mods/café.jar');
});

test('rejects absolute, drive, UNC, device namespace, root-relative, traversal, ADS, and ambiguous separators', () => {
  const unsafe = [
    '/server.jar', '\\server.jar', 'C:/server.jar', 'C:server.jar',
    '\\\\host\\share\\server.jar', '\\\\?\\C:\\server.jar', '\\\\.\\NUL',
    '../world/level.dat', 'world/../ops.json', 'world\\..\\ops.json',
    'mods//a.jar', 'mods\\\\a.jar', 'mods/a\\b.jar', 'mods/a.jar:evil'
  ];
  for (const path of unsafe) {
    assert.throws(() => validateArchiveEntries([file(path)], ARCHIVE_LIMITS), hasCode('UNSAFE_ARCHIVE_ENTRY', 'path-traversal'), path);
  }
});

test('rejects controls, forbidden Windows characters, trailing dots/spaces, and empty segments', () => {
  const unsafe = [
    'mods/a\u0000.jar', 'mods/a\u001f.jar', 'mods/a\u007f.jar',
    'mods/a?.jar', 'mods/a*.jar', 'mods/a<.jar', 'mods/a>.jar', 'mods/a|.jar', 'mods/a".jar',
    'mods/a. ', 'mods/a.', 'mods/a ', 'mods//a.jar', './mods/a.jar', 'mods/./a.jar'
  ];
  for (const path of unsafe) {
    assert.throws(() => validateArchiveEntries([file(path)], ARCHIVE_LIMITS), hasCode('UNSAFE_ARCHIVE_ENTRY'), JSON.stringify(path));
  }
});

test('rejects DOS devices including extension and superscript COM/LPT aliases', () => {
  const devices = [
    'CON', 'con.txt', 'PRN', 'AUX.json', 'NUL', 'CLOCK$',
    'COM1', 'com9.jar', 'LPT1', 'lpt9.txt', 'COM¹.log', 'COM²', 'COM³.dat', 'LPT¹.cfg'
  ];
  for (const path of devices) {
    assert.throws(() => validateArchiveEntries([file(`config/${path}`)], ARCHIVE_LIMITS), hasCode('UNSAFE_ARCHIVE_ENTRY'), path);
  }
});

test('rejects Unicode, case, separator, exact, file-directory, and ancestor collisions', () => {
  const cases = [
    [file('mods/Café.jar'), file('mods/Cafe\u0301.jar')],
    [file('mods/A.jar'), file('MODS/a.jar')],
    [file('mods/a.jar'), file('mods\\a.jar')],
    [file('a'), file('a')],
    [file('a'), directory('a')],
    [file('a'), file('a/b')],
    [file('a/b'), file('a')],
    [directory('a/b'), file('a')]
  ];
  for (const entries of cases) {
    assert.throws(() => validateArchiveEntries(entries, ARCHIVE_LIMITS), hasCode('ARCHIVE_ENTRY_COLLISION'));
  }
});

test('allows only explicit regular files and directories and rejects every redirection target', () => {
  const unsafe = [
    file('link', { type: 'symlink', symbolicLink: 'target' }),
    file('link', { symbolicLink: 'target' }),
    file('link', { hardLink: 'target' }),
    file('link', { linkTarget: 'target' }),
    file('link', { attributes: 'lrwxrwxrwx' }),
    file('junction', { reparse: true }),
    file('device', { type: 'device' }),
    file('socket', { type: 'socket' }),
    file('stream', { type: 'stream' }),
    file('other', { type: 'other' })
  ];
  for (const entry of unsafe) {
    const expectedReason = entry.type === 'symlink' || entry.symbolicLink || entry.hardLink || entry.linkTarget
      ? 'link-entry'
      : 'non-regular-entry';
    assert.throws(() => validateArchiveEntries([entry], ARCHIVE_LIMITS), hasCode('UNSAFE_ARCHIVE_ENTRY', expectedReason));
  }
});

test('rejects encrypted entries before applying any remaining archive policy', () => {
  assert.throws(() => validateArchiveEntries([
    file('../secret', { encrypted: true })
  ], ARCHIVE_LIMITS), hasCode('ENCRYPTED_ARCHIVE'));
});

test('enforces depth and UTF-16 normalized path length exactly', () => {
  const atDepth = Array.from({ length: ARCHIVE_LIMITS.maxPathDepth }, (_, index) => `d${index}`).join('/');
  assert.equal(validateArchiveEntries([file(atDepth)], ARCHIVE_LIMITS).entries[0].depth, ARCHIVE_LIMITS.maxPathDepth);
  assert.throws(() => validateArchiveEntries([file(`${atDepth}/overflow`)], ARCHIVE_LIMITS), hasCode('UNSAFE_ARCHIVE_ENTRY', 'path-depth'));

  const atLength = new Array(5).fill('x'.repeat(204)).join('/');
  assert.equal(atLength.length, ARCHIVE_LIMITS.maxNormalizedPathLength);
  assert.doesNotThrow(() => validateArchiveEntries([file(atLength)], ARCHIVE_LIMITS));
  assert.throws(() => validateArchiveEntries([file(`${atLength}x`)], ARCHIVE_LIMITS), hasCode('UNSAFE_ARCHIVE_ENTRY', 'path-length'));

  const astralOverflow = `a/${'🚀'.repeat(512)}`;
  assert.equal([...astralOverflow].length < ARCHIVE_LIMITS.maxNormalizedPathLength, true);
  assert.equal(astralOverflow.length > ARCHIVE_LIMITS.maxNormalizedPathLength, true);
  assert.throws(() => validateArchiveEntries([file(astralOverflow)], ARCHIVE_LIMITS), hasCode('UNSAFE_ARCHIVE_ENTRY', 'path-length'));
});

test('rejects unknown, signed, padded, overflowing, and inconsistent safety sizes', () => {
  const invalid = [
    file('a', { size: undefined }),
    file('a', { packedSize: undefined }),
    file('a', { size: '-1' }),
    file('a', { size: '+1' }),
    file('a', { size: ' 1' }),
    file('a', { size: '01' }),
    file('a', { size: '18446744073709551616' }),
    file('a', { size: '1', packedSize: '0' }),
    directory('a', { size: '1' }),
    directory('a', { packedSize: '1' })
  ];
  for (const entry of invalid) {
    assert.throws(() => validateArchiveEntries([entry], ARCHIVE_LIMITS), error =>
      error?.code === 'UNSAFE_ARCHIVE_ENTRY' || error?.code === 'ARCHIVE_LIMIT_EXCEEDED');
  }
});

test('enforces exact entry, per-file, and aggregate expansion limits with safe decimals', () => {
  assert.throws(() => validateArchiveEntries(
    new Array(ARCHIVE_LIMITS.maxArchiveEntries + 1).fill(file('never-read')),
    ARCHIVE_LIMITS
  ), error => error?.code === 'ARCHIVE_LIMIT_EXCEEDED' && error?.details?.limit === 'maxArchiveEntries' && error?.details?.actual === '250001');

  assert.doesNotThrow(() => validateArchiveEntries([file('max.bin', {
    size: ARCHIVE_LIMITS.maxFileExpandedBytes,
    packedSize: ARCHIVE_LIMITS.maxFileExpandedBytes
  })], ARCHIVE_LIMITS));
  assert.throws(() => validateArchiveEntries([file('large.bin', {
    size: (BigInt(ARCHIVE_LIMITS.maxFileExpandedBytes) + 1n).toString(),
    packedSize: '1'
  })], ARCHIVE_LIMITS), error => error?.code === 'ARCHIVE_LIMIT_EXCEEDED' && error?.details?.limit === 'maxFileExpandedBytes');

  assert.throws(() => validateArchiveEntries(Array.from({ length: 5 }, (_, index) => file(`f${index}`, {
    size: ARCHIVE_LIMITS.maxFileExpandedBytes,
    packedSize: ARCHIVE_LIMITS.maxFileExpandedBytes
  })), ARCHIVE_LIMITS), error => error?.code === 'ARCHIVE_LIMIT_EXCEEDED' && error?.details?.limit === 'maxExpandedBytes');
});

test('enforces exact per-entry ratio at 64 MiB and aggregate ratio at 256 MiB', () => {
  const threshold = BigInt(ARCHIVE_LIMITS.minPerEntryRatioExpandedBytes);
  assert.doesNotThrow(() => validateArchiveEntries([file('edge.bin', {
    size: threshold.toString(), packedSize: ((threshold + 999n) / 1000n).toString()
  })], ARCHIVE_LIMITS));
  assert.throws(() => validateArchiveEntries([file('bomb.bin', {
    size: threshold.toString(), packedSize: (threshold / 1000n).toString()
  })], ARCHIVE_LIMITS), error => error?.code === 'ARCHIVE_LIMIT_EXCEEDED' && error?.details?.limit === 'maxPerEntryCompressionRatio');

  const aggregateEntrySize = 53687092n;
  const aggregatePacked = 53687n;
  const entries = Array.from({ length: 5 }, (_, index) => file(`aggregate-${index}`, {
    size: aggregateEntrySize.toString(), packedSize: aggregatePacked.toString()
  }));
  assert.throws(() => validateArchiveEntries(entries, ARCHIVE_LIMITS), error =>
    error?.code === 'ARCHIVE_LIMIT_EXCEEDED' && error?.details?.limit === 'maxAggregateCompressionRatio');
});

test('custom limits must retain the exact closed versioned policy shape', () => {
  assert.throws(() => validateArchiveEntries([file('a')], { ...ARCHIVE_LIMITS, unexpected: 1 }), hasCode('INVALID_REQUEST'));
  assert.throws(() => validateArchiveEntries([file('a')], { ...ARCHIVE_LIMITS, version: 2 }), hasCode('INVALID_REQUEST'));
  assert.throws(() => validateArchiveEntries([file('a')], null), hasCode('INVALID_REQUEST'));
});
