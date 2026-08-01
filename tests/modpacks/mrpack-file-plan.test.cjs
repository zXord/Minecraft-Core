const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMrpackManifest } = require('../../electron/services/modpacks/mrpack/mrpack-parser.cjs');
const { buildMrpackServerPlan } = require('../../electron/services/modpacks/mrpack/mrpack-file-plan.cjs');
const { ARCHIVE_LIMITS } = require('../../electron/services/modpacks/limits.cjs');

function archiveFile(path, size) {
  return { path, type: 'file', ...(size === undefined ? {} : { size }) };
}

function archiveDirectory(path) {
  return { path, type: 'directory' };
}

function file(path, server = 'required', extra = {}) {
  return {
    path,
    hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
    env: { client: 'required', server },
    downloads: [`https://cdn.modrinth.com/data/a/versions/b/${path.split('/').at(-1)}`],
    fileSize: 12,
    ...extra
  };
}

function manifest(files = [file('mods/required.jar')]) {
  return validateMrpackManifest({
    formatVersion: 1, game: 'minecraft', versionId: 'v1', name: 'Pack', files,
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' }
  });
}

test('builds deterministic required downloads with both hashes and exact runtime dependencies', () => {
  const plan = buildMrpackServerPlan({ manifest: manifest(), selectedOptionalFiles: [], archiveEntries: [] });
  assert.deepEqual(plan.runtime, { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.9' });
  assert.deepEqual(plan.downloads, [{
    partId: 'file-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-140e8bce9451a32f82f9944c94c163bf94ac1a892553546f927208754ee178dc',
    targetPath: 'mods/required.jar', optional: false, selected: true,
    downloadUrl: 'https://cdn.modrinth.com/data/a/versions/b/required.jar',
    downloadUrlCandidates: ['https://cdn.modrinth.com/data/a/versions/b/required.jar'],
    allowedHosts: ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'], allowSubdomains: false,
    size: '12', provider: 'modrinth', providerDigest: { algorithm: 'sha512', value: 'b'.repeat(128) },
    requiredProviderDigests: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) }
  }]);
  assert.deepEqual(plan.layers, [{ name: 'downloads', order: 0 }, { name: 'overrides', order: 1 }, { name: 'server-overrides', order: 2 }]);
});

test('server optional files default included and accept only an exact selected optional allowlist', () => {
  const pack = manifest([file('mods/required.jar'), file('mods/optional.jar', 'optional')]);
  const defaultPlan = buildMrpackServerPlan({ manifest: pack, archiveEntries: [] });
  assert.equal(defaultPlan.downloads.find(entry => entry.targetPath === 'mods/optional.jar').selected, true);

  const excluded = buildMrpackServerPlan({ manifest: pack, selectedOptionalFiles: [], archiveEntries: [] });
  assert.deepEqual(excluded.downloads.map(({ targetPath, selected }) => ({ targetPath, selected })), [
    { targetPath: 'mods/required.jar', selected: true }, { targetPath: 'mods/optional.jar', selected: false }
  ]);
  const included = buildMrpackServerPlan({ manifest: pack, selectedOptionalFiles: ['MODS\\OPTIONAL.JAR'], archiveEntries: [] });
  assert.equal(included.downloads[1].selected, true);
  assert.throws(() => buildMrpackServerPlan({ manifest: pack, selectedOptionalFiles: ['mods/not-declared.jar'], archiveEntries: [] }), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => buildMrpackServerPlan({ manifest: pack, selectedOptionalFiles: ['mods/optional.jar', 'MODS/OPTIONAL.JAR'], archiveEntries: [] }), error => error.code === 'INVALID_REQUEST');
});

test('excludes server-unsupported entries and rejects an explicitly client-only pack', () => {
  const mixed = buildMrpackServerPlan({
    manifest: manifest([file('mods/server.jar'), file('mods/client.jar', 'unsupported')]), archiveEntries: []
  });
  assert.deepEqual(mixed.downloads.map(entry => entry.targetPath), ['mods/server.jar']);
  assert.throws(() => buildMrpackServerPlan({
    manifest: manifest([file('mods/client.jar', 'unsupported')]), archiveEntries: [archiveFile('client-overrides/config/client.json')]
  }), error => error.code === 'CLIENT_ONLY_PACK');
});

test('expresses override then server-override precedence without extracting or running entries', () => {
  const plan = buildMrpackServerPlan({
    manifest: manifest(),
    archiveEntries: [
      { path: 'modrinth.index.json', type: 'file' },
      { path: 'overrides/config/common.toml', type: 'file', size: 10 },
      { path: 'server-overrides/config/common.toml', type: 'file', size: 20 },
      { path: 'server-overrides/server.properties', type: 'file', size: 30 },
      { path: 'client-overrides/options.txt', type: 'file', size: 40 }
    ]
  });
  assert.deepEqual(plan.overrideOperations, [
    { layer: 'overrides', order: 1, archivePath: 'overrides/config/common.toml', targetPath: 'config/common.toml', size: '10' },
    { layer: 'server-overrides', order: 2, archivePath: 'server-overrides/config/common.toml', targetPath: 'config/common.toml', size: '20' },
    { layer: 'server-overrides', order: 2, archivePath: 'server-overrides/server.properties', targetPath: 'server.properties', size: '30' }
  ]);
  assert.deepEqual(plan.finalOverrides, [
    { layer: 'server-overrides', archivePath: 'server-overrides/config/common.toml', targetPath: 'config/common.toml', size: '20' },
    { layer: 'server-overrides', archivePath: 'server-overrides/server.properties', targetPath: 'server.properties', size: '30' }
  ]);
  assert.equal(plan.overrideOperations.some(entry => entry.archivePath.includes('client-overrides')), false);
});

test('rejects duplicate targets within a layer but permits deterministic cross-layer replacement', () => {
  assert.throws(() => buildMrpackServerPlan({
    manifest: manifest(), archiveEntries: [archiveFile('overrides/config/A.toml'), archiveFile('overrides/config/a.toml')]
  }), error => error.code === 'ARCHIVE_ENTRY_COLLISION');
  assert.throws(() => buildMrpackServerPlan({
    manifest: manifest(), archiveEntries: [archiveFile('server-overrides/e\u0301.toml'), archiveFile('server-overrides/\u00e9.toml')]
  }), error => error.code === 'ARCHIVE_ENTRY_COLLISION');
  assert.doesNotThrow(() => buildMrpackServerPlan({
    manifest: manifest(), archiveEntries: [archiveFile('overrides/config/a.toml'), archiveFile('server-overrides/config/A.toml')]
  }));
});

test('rejects unsafe archive entries and reserved state targets before planning', () => {
  for (const entry of [
    archiveFile('../escape.txt'), archiveFile('/absolute.txt'), archiveFile('C:\\drive.txt'), archiveFile('overrides/../../escape.txt'),
    archiveFile('overrides/.minecraft-core-state/pack.json'), archiveFile('server-overrides/AUX.txt'),
    { path: 'overrides/link', type: 'symbolic-link' },
    { path: 'overrides/file', type: 'file', size: -1 }
  ]) assert.throws(() => buildMrpackServerPlan({ manifest: manifest(), archiveEntries: [entry] }), error => ['UNSAFE_ARCHIVE_ENTRY', 'MANIFEST_INVALID'].includes(error.code));
});

test('archive entry metadata must be explicit plain and closed', () => {
  for (const entry of [
    'overrides/config/a.toml',
    ['overrides/config/a.toml'],
    { path: 'overrides/config/a.toml' },
    { type: 'file' },
    { path: 'overrides/config/a.toml', type: 'file', crc: 'secret' },
    { path: 'overrides/link', type: 'symlink' },
    { path: 'overrides/link', type: 'reparse' },
    { path: 'overrides/device', type: 'device' }
  ]) assert.throws(() => buildMrpackServerPlan({ manifest: manifest(), archiveEntries: [entry] }), error => error.code === 'UNSAFE_ARCHIVE_ENTRY');
});

test('projected overrides reject Win32 superscript COM and LPT device aliases', () => {
  for (const device of ['COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³']) {
    assert.throws(
      () => buildMrpackServerPlan({ manifest: manifest(), archiveEntries: [archiveFile(`overrides/config/${device}.toml`)] }),
      error => error.code === 'UNSAFE_ARCHIVE_ENTRY'
    );
  }
});

test('rejects archive aliases and file-directory conflicts even outside applied override trees', () => {
  assert.throws(() => buildMrpackServerPlan({
    manifest: manifest(), archiveEntries: [
      { path: 'docs/A.txt', type: 'file' }, { path: 'DOCS/a.txt', type: 'file' }
    ]
  }), error => error.code === 'ARCHIVE_ENTRY_COLLISION');
  assert.throws(() => buildMrpackServerPlan({
    manifest: manifest(), archiveEntries: [
      { path: 'overrides/config', type: 'file' }, { path: 'overrides/config/a.toml', type: 'file' }
    ]
  }), error => error.code === 'ARCHIVE_ENTRY_COLLISION');
});

test('one projected target graph rejects file-directory and ancestor conflicts across every layer', () => {
  const cases = [
    { files: [file('config')], entries: [archiveDirectory('overrides/config')] },
    { files: [file('config/a.toml')], entries: [archiveFile('overrides/config')] },
    { files: [file('config')], entries: [archiveFile('overrides/config/a.toml')] },
    { files: [file('mods/base.jar')], entries: [archiveDirectory('overrides/config'), archiveFile('server-overrides/config')] },
    { files: [file('mods/base.jar')], entries: [archiveFile('server-overrides/config'), archiveDirectory('overrides/config')] },
    { files: [file('mods/base.jar')], entries: [archiveFile('overrides/config'), archiveFile('server-overrides/config/a.toml')] },
    { files: [file('mods/base.jar')], entries: [archiveFile('server-overrides/config/a.toml'), archiveFile('overrides/config')] }
  ];
  for (const { files, entries } of cases) {
    assert.throws(() => buildMrpackServerPlan({ manifest: manifest(files), archiveEntries: entries }), error => error.code === 'ARCHIVE_ENTRY_COLLISION');
  }
});

test('projected directories merge while only later exact file-to-file overrides replace', () => {
  const plan = buildMrpackServerPlan({
    manifest: manifest([file('config/common.toml')]),
    archiveEntries: [
      archiveDirectory('overrides/config'), archiveDirectory('server-overrides/config'),
      archiveFile('overrides/config/common.toml'), archiveFile('server-overrides/config/common.toml')
    ]
  });
  assert.deepEqual(plan.finalDirectories, [{ targetPath: 'config' }]);
  assert.deepEqual(plan.finalOverrides, [{
    layer: 'server-overrides', archivePath: 'server-overrides/config/common.toml', targetPath: 'config/common.toml'
  }]);
});

test('selected MRPACK payload enforces aggregate bytes and excludes unselected optional files', () => {
  const maximum = BigInt(ARCHIVE_LIMITS.maxArtifactSetBytes);
  const halfPlusOne = Number(maximum / 2n + 1n);
  const oversized = manifest([
    file('mods/one.jar', 'required', { fileSize: halfPlusOne, hashes: { sha1: '1'.repeat(40), sha512: '1'.repeat(128) } }),
    file('mods/two.jar', 'required', { fileSize: halfPlusOne, hashes: { sha1: '2'.repeat(40), sha512: '2'.repeat(128) } })
  ]);
  assert.throws(
    () => buildMrpackServerPlan({ manifest: oversized, archiveEntries: [] }),
    error => error.code === 'ARCHIVE_LIMIT_EXCEEDED' && error.details?.limit === 'maxArtifactSetBytes' && error.details?.actual === String(BigInt(halfPlusOne) * 2n)
  );

  const optional = manifest([
    file('mods/required.jar', 'required', { fileSize: 1, hashes: { sha1: '3'.repeat(40), sha512: '3'.repeat(128) } }),
    file('mods/optional.jar', 'optional', { fileSize: Number(maximum), hashes: { sha1: '4'.repeat(40), sha512: '4'.repeat(128) } })
  ]);
  assert.doesNotThrow(() => buildMrpackServerPlan({ manifest: optional, selectedOptionalFiles: [], archiveEntries: [] }));
  assert.throws(() => buildMrpackServerPlan({ manifest: optional, archiveEntries: [] }), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
});

test('MRPACK mirror candidates preserve validated provider order and are frozen', () => {
  const mirrors = [
    'https://cdn.modrinth.com/data/a/versions/b/example.jar',
    'https://github.com/owner/repository/releases/download/v1/example.jar',
    'https://raw.githubusercontent.com/owner/repository/main/example.jar'
  ];
  const plan = buildMrpackServerPlan({ manifest: manifest([file('mods/example.jar', 'required', { downloads: mirrors })]), archiveEntries: [] });
  assert.deepEqual(plan.downloads[0].downloadUrlCandidates, mirrors);
  assert.equal(plan.downloads[0].downloadUrl, mirrors[0]);
  assert.ok(Object.isFrozen(plan.downloads[0].downloadUrlCandidates));
  assert.throws(() => validateMrpackManifest({
    formatVersion: 1, game: 'minecraft', versionId: 'v1', name: 'Pack', dependencies: { minecraft: '1.21.1' },
    files: [file('mods/example.jar', 'required', { downloads: [...mirrors, 'https://evil.example/example.jar'] })]
  }), error => error.code === 'INVALID_RELEASE_URL');
});

test('duplicate bytes at distinct targets receive deterministic unique safe part IDs', () => {
  const pack = manifest([file('mods/one.jar'), file('mods/two.jar')]);
  const first = buildMrpackServerPlan({ manifest: pack, archiveEntries: [] });
  const second = buildMrpackServerPlan({ manifest: pack, archiveEntries: [] });
  assert.equal(first.downloads.length, 2);
  assert.notEqual(first.downloads[0].partId, first.downloads[1].partId);
  assert.deepEqual(first.downloads.map(download => download.partId), second.downloads.map(download => download.partId));
  for (const download of first.downloads) {
    assert.match(download.partId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    assert.deepEqual(download.requiredProviderDigests, { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) });
    assert.deepEqual(download.providerDigest, { algorithm: 'sha512', value: 'b'.repeat(128) });
  }
});
