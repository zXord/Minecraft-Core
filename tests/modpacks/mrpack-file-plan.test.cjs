const test = require('node:test');
const assert = require('node:assert/strict');

const { validateMrpackManifest } = require('../../electron/services/modpacks/mrpack/mrpack-parser.cjs');
const { buildMrpackServerPlan } = require('../../electron/services/modpacks/mrpack/mrpack-file-plan.cjs');

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
    partId: `file-${'a'.repeat(40)}`,
    targetPath: 'mods/required.jar', optional: false, selected: true,
    downloadUrl: 'https://cdn.modrinth.com/data/a/versions/b/required.jar',
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
    manifest: manifest([file('mods/client.jar', 'unsupported')]), archiveEntries: ['client-overrides/config/client.json']
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
    manifest: manifest(), archiveEntries: ['overrides/config/A.toml', 'overrides/config/a.toml']
  }), error => error.code === 'ARCHIVE_ENTRY_COLLISION');
  assert.throws(() => buildMrpackServerPlan({
    manifest: manifest(), archiveEntries: ['server-overrides/e\u0301.toml', 'server-overrides/\u00e9.toml']
  }), error => error.code === 'ARCHIVE_ENTRY_COLLISION');
  assert.doesNotThrow(() => buildMrpackServerPlan({
    manifest: manifest(), archiveEntries: ['overrides/config/a.toml', 'server-overrides/config/A.toml']
  }));
});

test('rejects unsafe archive entries and reserved state targets before planning', () => {
  for (const entry of [
    '../escape.txt', '/absolute.txt', 'C:\\drive.txt', 'overrides/../../escape.txt',
    'overrides/.minecraft-core-state/pack.json', 'server-overrides/AUX.txt',
    { path: 'overrides/link', type: 'symbolic-link' },
    { path: 'overrides/file', type: 'file', size: -1 }
  ]) assert.throws(() => buildMrpackServerPlan({ manifest: manifest(), archiveEntries: [entry] }), error => ['UNSAFE_ARCHIVE_ENTRY', 'MANIFEST_INVALID'].includes(error.code));
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
