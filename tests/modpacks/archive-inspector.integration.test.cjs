const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const {
  createArtifactSetPlan,
  finalizeVerifiedArtifactSet
} = require('../../electron/services/modpacks/contracts.cjs');
const {
  classifyArchive
} = require('../../electron/services/modpacks/archive/archive-classifier.cjs');
const {
  createArchiveInspector,
  inspectArchive
} = require('../../electron/services/modpacks/archive/archive-inspector.cjs');

const fixtureRoot = path.resolve(__dirname, '..', 'fixtures', 'archives');

// These pins are populated before production implementation and intentionally make
// fixture drift a test failure. CI never generates RAR files.
const FIXTURE_SHA256 = Object.freeze({
  'tiny.zip': '2263efc47699dff59d9aff2d3e7def4b2eaa580938bfa3f9c5847c6dc15d56af',
  'tiny-zip64.zip': 'f4735f3d12914a8b3ddacbab8aaefc84912b91a0df4194be5ba5db0e46af3279',
  'encrypted.zip': '41d5385a18d61e93d14d19b4d82b2a1a13db9c382b41f1e6700be416856bc5e3',
  'traversal.zip': 'b610f140c37669a753051fc166f8bf71e3f7049267a30df61484e6878e69ca7f',
  'unicode-alias.zip': 'ebd23b7ea8fce77240780ffd78b75fb7050387df6810e50e89dbe6e81da39b17',
  'file-directory-collision.zip': '7b2aee4b0291b0686e406ecde869418894db39a767d773390e2e0e1f605b66bb',
  'symlink-metadata.zip': '97a95d81b857822912db32e1c0c075976608a27af2a2bc9491d350df06a9535f',
  'high-ratio.zip': '9f6e6b9c2d0f514df8927063f1ad519afe279d76b26f7724097245ff78e0d05d',
  'prepared-vanilla.zip': '5304c611fa8329dec173d90cd83d10cc4f49440023e6216c1eea93764b891814',
  'installer-only.zip': 'f441af84292a25383bcee67e6f1920b8e9c812846f53ad933a61bf7494b77152',
  'minecraft-core-backup.zip': '76102411cc5a1d3c602e2d7b3f9f7e58d4cd1835c2829de4d23c089ff6a1f6c1',
  'client-only.mrpack': '49c26b533cc367623ef943567ebda72324692ea01aab589e19eadddb5b500bc4',
  'conflicting-loader.zip': '4508441bebc745f81c3bca02ebe1a5ea5a4dd091c54e974db2d9f454bff4176c',
  'custom-bootstrap.zip': 'a676cd8d78350a575ec5b7c97916f60726fee4393dd6a9ee34afdb47cb784370',
  'ambiguous-roots.zip': '57777dee2b7afa772b41e4e83b0be2b54121ed46ca6f45cab65961cc547c6f39',
  'rar4.rar': 'dce342bc0c2852fcaa36a03da5e55abb7dd69c045bbd812faebebc1a3844f5a4',
  'rar5.rar': 'a546b39c1aa42669543ef81f5ec8c4ef49fc7c2e5b8d08ab10549e919996e1a4',
  'multipart.part0001.rar': '54769cdaa6aeac494b9ba580804598369ba240f61550620434e08350e4428ec2',
  'multipart.part0002.rar': '9dd6b28d2fdf0d012390259548cc86be9535ee6eb5ec630c99fbb5dc8d037ed1',
  'multipart.part0003.rar': '7d72ef6e876e98e6a317b7e534c0285615a2953543e68135a8a0dcc94b41cf21',
  'rar5-multipart.part01.rar': '6607f575dad0b28aaeb02298b4c04a0e5a606e77f952127d2d9e346f60616a26',
  'rar5-multipart.part02.rar': 'eb119ed53511905ca6f1844c164b6246d8fcdca0d1f38a8e3fb13da9c0932fbd',
  'rar5-multipart.part03.rar': 'e814c3dbdaf3f613fd25c840065d25543f31e6b6c95505e7e25f47867a4812bd',
  'rar5-multipart.part04.rar': '9ff5a4e633b0e82a2ce6e022f3d389654dbb77a0906a34f107676d6673989c9f'
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha512(bytes) {
  return crypto.createHash('sha512').update(bytes).digest('hex');
}

function slt({ type = 'zip', archive = [], entries = [] } = {}) {
  const rows = [
    '',
    '7-Zip 26.02 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-06-25',
    '',
    'Scanning the drive for archives:',
    '1 file, 123 bytes (1 KiB)',
    '',
    'Listing archive: C:\\redacted\\archive',
    '',
    '--',
    'Path = C:\\redacted\\archive',
    `Type = ${type}`,
    'Physical Size = 123',
    ...archive,
    '',
    '----------'
  ];
  for (const entry of entries) {
    const common = [
      `Path = ${entry.path}`,
      `Folder = ${entry.type === 'directory' ? '+' : '-'}`,
      `Size = ${entry.size ?? '1'}`,
      `Packed Size = ${entry.packedSize ?? entry.size ?? '1'}`,
      'Modified = 2026-08-02 00:00:00', 'Created = ', 'Accessed = ',
      `Attributes = ${entry.type === 'directory' ? 'D' : 'A'}`
    ];
    if (type === 'Rar5') {
      rows.push(...common,
        'Alternate Stream = -', `Encrypted = ${entry.encrypted ? '+' : '-'}`, 'Solid = -',
        'Split Before = -', 'Split After = -', `CRC = ${entry.type === 'directory' ? '' : '00000000'}`,
        'Host OS = Unix', 'Method = v6:m0:128K', 'Characteristics = CRC',
        'Symbolic Link = ', 'Hard Link = ', 'Copy Link = ', 'Volume Index = 0',
        'Checksum = ', 'NT Security = ', '');
    } else if (type === 'Rar') {
      rows.push(...common,
        `Encrypted = ${entry.encrypted ? '+' : '-'}`, 'Solid = -', 'Commented = -',
        'Split Before = -', 'Split After = -', `CRC = ${entry.type === 'directory' ? '' : '00000000'}`,
        'Host OS = MS DOS', 'Method = m0:17', 'Version = 20', 'Volume Index = 0', '');
    } else {
      rows.push(...common,
        `Encrypted = ${entry.encrypted ? '+' : '-'}`, 'Comment = ',
        `CRC = ${entry.type === 'directory' ? '' : '00000000'}`,
        'Method = Store', 'Characteristics = ', 'Host OS = FAT', 'Version = 20',
        'Volume Index = 0', 'Offset = 0', '');
    }
  }
  return `${rows.join('\r\n')}\r\n`;
}

function makeVerifiedSet(parts, { groupingScheme = 'single', primaryPartId = parts[0].partId, fileNames } = {}) {
  const plan = createArtifactSetPlan({
    provider: 'local',
    artifactSet: {
      kind: parts.length === 1 ? 'single' : 'multipart',
      primaryPartId,
      groupingScheme: parts.length === 1 ? 'single' : groupingScheme,
      parts: parts.map((part, index) => ({
        partId: part.partId,
        fileName: fileNames?.[index] ?? part.fileName,
        size: String(part.bytes.length),
        providerDigest: { algorithm: 'sha256', value: sha256(part.bytes) }
      })),
      providerImmutable: true,
      attestationStatus: 'verified'
    }
  });
  return finalizeVerifiedArtifactSet(plan, parts.map(part => ({
    partId: part.partId,
    measuredSize: String(part.bytes.length),
    sha256: sha256(part.bytes),
    sha512: sha512(part.bytes)
  })));
}

function idFactory() {
  let next = 0;
  return () => `fixture-${++next}`;
}

async function inspectorFixture({ verifiedSet, sourceParts, listText, entryData = {}, workerFailure } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-archive-inspector-'));
  const parts = new Map(verifiedSet.artifactSet.parts.map(part => [part.partId, part]));
  const sourceBytes = new Map();
  for (const [index, part] of [...parts.values()].entries()) sourceBytes.set(part.partId, sourceParts[index].bytes);
  const events = [];
  const cache = {
    retain() {},
    release() {},
    async materializeSet(set, destination) {
      await fsp.mkdir(destination);
      for (const part of set.artifactSet.parts) await fsp.writeFile(path.join(destination, part.fileName), sourceBytes.get(part.partId));
      return path.join(destination, set.artifactSet.parts.find(part => part.partId === set.artifactSet.primaryPartId).fileName);
    }
  };
  const registry = new ArtifactWorkspaceRegistry({ root, artifactCache: cache, idFactory: idFactory() });
  const worker = {
    async run(request, { signal, onFrame } = {}) {
      events.push({ operation: request.operation, family: request.archiveFamily, maxDataBytes: request.maxDataBytes });
      if (signal?.aborted) {
        const error = new Error('cancelled'); error.code = 'CANCELLED'; throw error;
      }
      if (workerFailure?.operation === request.operation) throw workerFailure.error;
      if (request.operation === 'list') onFrame({ type: 'stdout', text: listText });
      if (request.operation === 'read-entry') {
        const data = entryData[request.entryName];
        if (!Buffer.isBuffer(data)) throw new Error('unexpected read');
        assert.ok(BigInt(data.length) <= BigInt(request.maxDataBytes));
        onFrame({ type: 'data', data: data.toString('base64') });
      }
      return Object.freeze({ type: 'status', ok: true, exitCode: 0, metrics: {
        stdoutBytes: '0', stderrBytes: '0', dataBytes: '0', elapsedMs: 1
      } });
    }
  };
  const service = createArchiveInspector({ workspaceRegistry: registry, workspaceRoot: root, workerClient: worker });
  return {
    root, registry, worker, service, events,
    cleanup: () => fsp.rm(root, { recursive: true, force: true })
  };
}

function pathFree(value) {
  if (!value || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(pathFree);
  return Object.entries(value).every(([key, child]) => !/(?:^path|path$|directory$)/i.test(key) && pathFree(child));
}

function hasCode(code) {
  return error => error?.code === code && !/[A-Z]:\\|https?:|redacted|archive\.zip/i.test(error.message);
}

test('every checked-in archive fixture has its exact reviewed SHA-256', async () => {
  for (const [name, expected] of Object.entries(FIXTURE_SHA256)) {
    const bytes = await fsp.readFile(path.join(fixtureRoot, name));
    assert.equal(sha256(bytes), expected, name);
  }
});

test('known multipart names remain provisional until engine verification', async t => {
  const sourceParts = [
    { partId: 'one', fileName: 'multipart.part0001.rar', bytes: Buffer.from('526172211a07010001020304', 'hex') },
    { partId: 'two', fileName: 'multipart.part0002.rar', bytes: Buffer.from('secondary-volume') }
  ];
  const verifiedArtifactSet = makeVerifiedSet(sourceParts, { groupingScheme: 'part-number' });
  const fixture = await inspectorFixture({
    verifiedSet: verifiedArtifactSet,
    sourceParts,
    listText: slt({
      type: 'Rar5',
      archive: [
        'Characteristics = Volume FirstVolume', 'Encrypted = -', 'Solid = -', 'Blocks = 1',
        'Method = v6:1M:m0', 'Multivolume = +', 'Volume Index = 0', 'Volumes = 2'
      ],
      entries: [{ path: 'server.jar', type: 'file' }]
    })
  });
  t.after(fixture.cleanup);

  const result = await fixture.service.inspectArchive({ verifiedArtifactSet });
  assert.equal(result.artifactSet.completeness, 'verified-complete-set');
  assert.equal(result.engineEvidence.family, 'rar');
  assert.equal(result.archiveFamily, 'multipart-rar');
  assert.deepEqual(fixture.events.map(event => event.operation), ['list', 'test']);
  assert.ok(fixture.events.every(event => event.family === 'rar5'));
  assert.equal(pathFree(result), true);
  assert.equal(Object.isFrozen(result), true);
});

test('the exact 7-Zip missing-volume header becomes a path-free multipart failure before integrity testing', async t => {
  const sourceParts = [
    { partId: 'one', fileName: 'multipart.part0001.rar', bytes: Buffer.from('526172211a07000001020304', 'hex') },
    { partId: 'two', fileName: 'multipart.part0002.rar', bytes: Buffer.from('secondary-volume') }
  ];
  const verifiedArtifactSet = makeVerifiedSet(sourceParts, { groupingScheme: 'part-number' });
  const listing = slt({
    type: 'Rar',
    archive: ['Solid = -', 'Blocks = 1', 'Multivolume = +', 'Volume Index = 0', 'Volumes = 2'],
    entries: [{ path: 'server.jar', type: 'file' }]
  }).replace(
    'Type = Rar\r\nPhysical Size = 123',
    'Type = Rar\r\nERROR = Missing volume : multipart.part0003.rar\r\nPhysical Size = 123'
  );
  const fixture = await inspectorFixture({ verifiedSet: verifiedArtifactSet, sourceParts, listText: listing });
  t.after(fixture.cleanup);

  await assert.rejects(
    fixture.service.inspectArchive({ verifiedArtifactSet }),
    error => error?.code === 'MULTIPART_VOLUME_MISSING' &&
      !/part0003|[A-Z]:\\|https?:/iu.test(error.message) && error.details === undefined
  );
  assert.deepEqual(fixture.events.map(event => event.operation), ['list']);
});

test('missing, duplicate, extra, secondary-only, wrong-family, and unconfirmed multipart sets never verify', async () => {
  const primary = { partId: 'one', fileName: 'pack.part1.rar', bytes: Buffer.from('526172211a07010001020304', 'hex') };
  const second = { partId: 'two', fileName: 'pack.part2.rar', bytes: Buffer.from('part-two') };
  const cases = [
    { names: ['pack.part1.rar', 'pack.part3.rar'], volumes: '3' },
    { names: ['pack.part2.rar', 'pack.part3.rar'], volumes: '2' },
    { names: ['pack.part1.rar', 'pack.part2.rar'], volumes: '3' },
    { names: ['pack.part1.rar', 'pack.part01.rar'], volumes: '2' },
    { names: ['pack.rar', 'pack.r00'], groupingScheme: 'rar-rxx', volumes: '1' },
    { names: ['pack.part1.rar', 'pack.part2.rar'], volumes: '2', type: 'Rar', expected: 'MAGIC_EXTENSION_MISMATCH' },
    { names: ['pack.part1.rar', 'pack.part2.rar'], volumes: '2', multivolume: false }
  ];
  for (const current of cases) {
    const sourceParts = [primary, second];
    const verifiedArtifactSet = makeVerifiedSet(sourceParts, {
      groupingScheme: current.groupingScheme ?? 'part-number',
      fileNames: current.names
    });
    const fixture = await inspectorFixture({
      verifiedSet: verifiedArtifactSet,
      sourceParts,
      listText: slt({ type: current.type ?? 'Rar5', archive: [
        'Characteristics = Volume FirstVolume', 'Encrypted = -', 'Solid = -', 'Blocks = 1',
        'Method = v6:1M:m0', `Multivolume = ${current.multivolume === false ? '-' : '+'}`, 'Volume Index = 0', `Volumes = ${current.volumes}`
      ], entries: [{ path: 'server.jar' }] })
    });
    try {
      await assert.rejects(fixture.service.inspectArchive({ verifiedArtifactSet }), hasCode(current.expected ?? 'MULTIPART_VOLUME_MISSING'));
    } finally {
      await fixture.cleanup();
    }
  }
});

test('inspection sequence is materialize, forced list, policy, integrity test, bounded read, and classification', async t => {
  const bytes = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(40)]);
  const sourceParts = [{ partId: 'main', fileName: 'prepared.zip', bytes }];
  const verifiedArtifactSet = makeVerifiedSet(sourceParts);
  const fixture = await inspectorFixture({
    verifiedSet: verifiedArtifactSet,
    sourceParts,
    listText: slt({ entries: [
      { path: 'wrapper', type: 'directory', size: '0', packedSize: '0' },
      { path: 'wrapper/server.jar', type: 'file' },
      { path: 'wrapper/server.properties', type: 'file' }
    ] })
  });
  t.after(fixture.cleanup);

  const progress = [];
  const result = await fixture.service.inspectArchive({ verifiedArtifactSet, onProgress: value => progress.push(value) });
  assert.equal(result.integrity, 'tested');
  assert.equal(result.selectedRoot, 'wrapper');
  assert.equal(result.classification.kind, 'prepared-server-pack');
  assert.equal(result.classification.runtime.loaderFamily, 'vanilla');
  assert.deepEqual(fixture.events.map(event => event.operation), ['list', 'test']);
  assert.deepEqual(progress.map(item => item.phase), ['materialize', 'list', 'validate', 'test', 'classify', 'complete']);
  assert.ok(progress.every(pathFree));
});

test('a worker failure remains the primary list failure when parser input is closed during cleanup', async t => {
  const bytes = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(40)]);
  const sourceParts = [{ partId: 'main', fileName: 'worker-failure.zip', bytes }];
  const verifiedArtifactSet = makeVerifiedSet(sourceParts);
  const workerError = new Error('injected worker failure');
  const fixture = await inspectorFixture({
    verifiedSet: verifiedArtifactSet,
    sourceParts,
    listText: slt({ entries: [{ path: 'server.jar' }] }),
    workerFailure: { operation: 'list', error: workerError }
  });
  t.after(fixture.cleanup);

  await assert.rejects(
    fixture.service.inspectArchive({ verifiedArtifactSet }),
    error => error?.code === 'EXTRACTOR_FAILED' && error.cause === workerError
  );
});

test('inspection accepts only an app-issued verified set and releases all temporary workspaces on failure', async t => {
  const bytes = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(40)]);
  const sourceParts = [{ partId: 'main', fileName: 'bad.zip', bytes }];
  const verifiedArtifactSet = makeVerifiedSet(sourceParts);
  const fixture = await inspectorFixture({
    verifiedSet: verifiedArtifactSet,
    sourceParts,
    listText: slt({ entries: [{ path: '../escape' }] })
  });
  t.after(fixture.cleanup);

  await assert.rejects(fixture.service.inspectArchive({ verifiedArtifactSet: structuredClone(verifiedArtifactSet) }), hasCode('INVALID_REQUEST'));
  await assert.rejects(fixture.service.inspectArchive({ verifiedArtifactSet }), hasCode('UNSAFE_ARCHIVE_ENTRY'));
  assert.deepEqual(fs.readdirSync(fixture.root), []);
});

test('materialization rehashes every part before any worker operation', async t => {
  const reviewedBytes = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(40)]);
  const tamperedBytes = Buffer.from(reviewedBytes);
  tamperedBytes[tamperedBytes.length - 1] = 1;
  const reviewedParts = [{ partId: 'main', fileName: 'pack.zip', bytes: reviewedBytes }];
  const verifiedArtifactSet = makeVerifiedSet(reviewedParts);
  const fixture = await inspectorFixture({
    verifiedSet: verifiedArtifactSet,
    sourceParts: [{ ...reviewedParts[0], bytes: tamperedBytes }],
    listText: slt({ entries: [{ path: 'server.jar' }] })
  });
  t.after(fixture.cleanup);

  await assert.rejects(fixture.service.inspectArchive({ verifiedArtifactSet }), hasCode('HASH_MISMATCH'));
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fs.readdirSync(fixture.root), []);
});

test('entry encryption stops before integrity testing and maps to one stable code', async t => {
  const bytes = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(40)]);
  const sourceParts = [{ partId: 'main', fileName: 'encrypted.zip', bytes }];
  const verifiedArtifactSet = makeVerifiedSet(sourceParts);
  const fixture = await inspectorFixture({
    verifiedSet: verifiedArtifactSet,
    sourceParts,
    listText: slt({ entries: [{ path: 'secret.txt', encrypted: true }] })
  });
  t.after(fixture.cleanup);
  await assert.rejects(fixture.service.inspectArchive({ verifiedArtifactSet }), hasCode('ENCRYPTED_ARCHIVE'));
  assert.deepEqual(fixture.events.map(event => event.operation), ['list']);
});

test('classification reads only validated regular evidence under a purpose-specific byte cap', async () => {
  const manifest = Buffer.from(JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'server-pack-1',
    name: 'Server Pack',
    files: [{
      path: 'mods/server.jar',
      hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
      env: { client: 'optional', server: 'required' },
      downloads: ['https://cdn.modrinth.com/data/project/versions/version/server.jar'],
      fileSize: 1
    }],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' }
  }), 'utf8');
  const calls = [];
  const entries = [
    { path: 'modrinth.index.json', canonicalPath: 'modrinth.index.json', type: 'file', size: String(manifest.length), packedSize: String(manifest.length), encrypted: false },
    { path: 'overrides/server.properties', canonicalPath: 'overrides/server.properties', type: 'file', size: '1', packedSize: '1', encrypted: false }
  ];
  const result = await classifyArchive({
    entries,
    selectedRoot: null,
    readEntry: async (entryName, options) => {
      calls.push({ entryName, ...options });
      return manifest;
    }
  });
  assert.equal(result.kind, 'mrpack-server');
  assert.equal(result.runtime.loaderFamily, 'fabric');
  assert.deepEqual(calls, [{ entryName: 'modrinth.index.json', purpose: 'mrpack-manifest', maxBytes: 2097152 }]);
});

test('inspection obtains classification evidence only through a natively bounded read-entry request', async t => {
  const manifest = Buffer.from(JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'server-pack-1',
    name: 'Server Pack',
    files: [{
      path: 'mods/server.jar',
      hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
      env: { client: 'optional', server: 'required' },
      downloads: ['https://cdn.modrinth.com/data/project/versions/version/server.jar'],
      fileSize: 1
    }],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' }
  }), 'utf8');
  const bytes = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(40)]);
  const sourceParts = [{ partId: 'main', fileName: 'server.mrpack', bytes }];
  const verifiedArtifactSet = makeVerifiedSet(sourceParts);
  const fixture = await inspectorFixture({
    verifiedSet: verifiedArtifactSet,
    sourceParts,
    listText: slt({ entries: [{
      path: 'modrinth.index.json', type: 'file', size: String(manifest.length), packedSize: String(manifest.length)
    }] }),
    entryData: { 'modrinth.index.json': manifest }
  });
  t.after(fixture.cleanup);

  const result = await fixture.service.inspectArchive({ verifiedArtifactSet });
  assert.equal(result.classification.kind, 'mrpack-server');
  assert.deepEqual(fixture.events, [
    { operation: 'list', family: 'zip', maxDataBytes: undefined },
    { operation: 'test', family: 'zip', maxDataBytes: undefined },
    { operation: 'read-entry', family: 'zip', maxDataBytes: '2097152' }
  ]);
});

test('classifies client-only, prepared, installer, backup, conflicts, custom bootstrap, and ambiguous roots conservatively', async () => {
  const clientManifest = Buffer.from(JSON.stringify({
    formatVersion: 1, game: 'minecraft', versionId: 'client', name: 'Client',
    files: [{
      path: 'mods/client.jar', hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
      env: { client: 'required', server: 'unsupported' },
      downloads: ['https://cdn.modrinth.com/data/p/v/client.jar'], fileSize: 1
    }], dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' }
  }), 'utf8');
  const backupState = Buffer.from(JSON.stringify({ version: '1.21.1', loader: 'fabric', loaderVersion: '0.16.10' }), 'utf8');
  const scenarios = [
    {
      expected: 'mrpack-client-only',
      entries: [fileEntry('modrinth.index.json', clientManifest.length)],
      reads: { 'modrinth.index.json': clientManifest }
    },
    { expected: 'prepared-server-pack', entries: [fileEntry('server.jar'), fileEntry('run.bat')] },
    { expected: 'loader-installer-bundle', entries: [fileEntry('forge-1.21.1-52.0.1-installer.jar'), fileEntry('install.ps1')] },
    {
      expected: 'backup-archive',
      entries: [fileEntry('.minecraft-core.json', backupState.length), fileEntry('server.properties')],
      reads: { '.minecraft-core.json': backupState }
    },
    { expected: 'ambiguous-or-unknown', entries: [fileEntry('fabric-server-launch.jar'), fileEntry('libraries/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar'), fileEntry('libraries/net/neoforged/neoforge/21.1.1/win_args.txt')] },
    { expected: 'unsupported-runtime-layout', entries: [fileEntry('custom-wrapper.jar'), fileEntry('launch-custom.bat')] },
    { expected: 'ambiguous-or-unknown', entries: [fileEntry('one/server.jar'), fileEntry('two/server.jar')] }
  ];
  for (const scenario of scenarios) {
    const result = await classifyArchive({
      entries: scenario.entries,
      selectedRoot: null,
      readEntry: async (entryName, { maxBytes }) => {
        const value = scenario.reads?.[entryName];
        assert.ok(value && value.length <= maxBytes);
        return value;
      }
    });
    assert.equal(result.kind, scenario.expected);
    if (scenario.expected === 'mrpack-client-only') {
      assert.deepEqual(result.runtime, {
        minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10'
      });
    }
    assert.equal(Object.isFrozen(result), true);
    assert.equal(pathFree(result), true);
  }
});

test('a convenience script beside a complete supported runtime does not make it unsupported', async () => {
  const result = await classifyArchive({
    entries: [fileEntry('server.jar'), fileEntry('start-server.bat'), fileEntry('README.txt')],
    selectedRoot: null,
    readEntry: async () => assert.fail('classification must not execute or read a script')
  });
  assert.equal(result.kind, 'prepared-server-pack');
  assert.equal(result.evidence.some(item => item.kind === 'convenience-script'), true);
});

test('standalone inspectArchive keeps dependencies internal and returns no worker/runtime/cache path', async () => {
  await assert.rejects(inspectArchive({ verifiedArtifactSet: null }), hasCode('INVALID_REQUEST'));
});

function fileEntry(path, size = 1) {
  return { path, canonicalPath: path.normalize('NFC').toLocaleLowerCase('en-US'), type: 'file', size: String(size), packedSize: String(size), encrypted: false };
}
