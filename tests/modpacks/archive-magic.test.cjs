const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getBundledArchiveRuntime,
  resolveBundledArchiveRuntimePaths
} = require('../../electron/services/modpacks/archive/archive-engine-paths.cjs');
const { detectArchiveFamily: detectMagic } = require('../../electron/services/modpacks/archive/archive-magic.cjs');

const ZIP_LOCAL = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(28)]);
const ZIP_EMPTY = Buffer.concat([Buffer.from('504b0506', 'hex'), Buffer.alloc(18)]);
const ZIP64 = Buffer.concat([Buffer.from('504b0606', 'hex'), Buffer.alloc(52)]);
const RAR4 = Buffer.from('526172211a0700000000000000', 'hex');
const RAR5 = Buffer.from('526172211a0701000000000000', 'hex');

function copyPackagedArchiveResources(targetRoot) {
  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const archiveRoot = path.join(targetRoot, 'archive');
  for (const [source, destination] of [
    ['vendor/7zip/x64', '7zip'],
    ['vendor/archive-worker/x64', 'worker'],
    ['third-party/7zip', 'licenses'],
    ['build-resources/archive-runtime', 'manifests']
  ]) {
    fs.cpSync(path.join(repositoryRoot, source), path.join(archiveRoot, destination), { recursive: true });
  }
  return archiveRoot;
}

function reviewed(primaryFileName, overrides = {}) {
  return {
    kind: 'single',
    groupingScheme: 'single',
    primaryPartId: 'primary',
    parts: [{ partId: 'primary', fileName: primaryFileName }],
    ...overrides
  };
}

function hasCode(code) {
  return error => error?.code === code && !/[A-Z]:\\|https?:|resources|vendor|7z\.exe/i.test(error.message);
}

test('detects exact ZIP, ZIP64, RAR4, and RAR5 primary markers', () => {
  assert.deepEqual(detectMagic(ZIP_LOCAL, reviewed('pack.zip')), {
    archiveFamily: 'zip', engineFamily: 'zip', signature: 'zip-local'
  });
  assert.deepEqual(detectMagic(ZIP_EMPTY, reviewed('empty.zip')), {
    archiveFamily: 'zip', engineFamily: 'zip', signature: 'zip-empty'
  });
  assert.deepEqual(detectMagic(ZIP64, reviewed('large.zip')), {
    archiveFamily: 'zip', engineFamily: 'zip', signature: 'zip64-eocd'
  });
  assert.deepEqual(detectMagic(RAR4, reviewed('pack.rar')), {
    archiveFamily: 'rar4', engineFamily: 'rar', signature: 'rar4'
  });
  assert.deepEqual(detectMagic(RAR5, reviewed('pack.rar')), {
    archiveFamily: 'rar5', engineFamily: 'rar', signature: 'rar5'
  });
});

test('mrpack requires ZIP magic and the exact reviewed primary role and name', () => {
  assert.deepEqual(detectMagic(ZIP_LOCAL, reviewed('example.mrpack')), {
    archiveFamily: 'mrpack', engineFamily: 'zip', signature: 'zip-local'
  });
  assert.throws(() => detectMagic(RAR5, reviewed('example.mrpack')), hasCode('MAGIC_EXTENSION_MISMATCH'));
  assert.throws(() => detectMagic(ZIP_LOCAL, reviewed('example.mrpack', {
    kind: 'multipart',
    groupingScheme: 'part-number',
    parts: [
      { partId: 'primary', fileName: 'example.mrpack' },
      { partId: 'second', fileName: 'example.part2.rar' }
    ]
  })), hasCode('MAGIC_EXTENSION_MISMATCH'));
});

test('known multipart RAR names remain a provisional RAR family at magic time', () => {
  const names = reviewed('pack.part1.rar', {
    kind: 'multipart',
    groupingScheme: 'part-number',
    parts: [
      { partId: 'primary', fileName: 'pack.part1.rar' },
      { partId: 'second', fileName: 'pack.part2.rar' }
    ]
  });
  assert.deepEqual(detectMagic(RAR5, names), {
    archiveFamily: 'multipart-rar', engineFamily: 'rar', signature: 'rar5'
  });
});

test('rejects split or spanned ZIP markers and truncated or ambiguous prefixes', () => {
  for (const bytes of [
    Buffer.from('504b0708', 'hex'),
    Buffer.from('504b3030', 'hex'),
    Buffer.from('50', 'hex'),
    Buffer.from('504b03', 'hex'),
    Buffer.from('526172211a0701', 'hex'),
    Buffer.alloc(0)
  ]) {
    assert.throws(() => detectMagic(bytes, reviewed('pack.zip')), hasCode('UNSUPPORTED_ARCHIVE'));
  }
});

test('magic and reviewed extension mismatches fail closed', () => {
  const cases = [
    [ZIP_LOCAL, reviewed('pack.rar')],
    [RAR4, reviewed('pack.zip')],
    [RAR5, reviewed('pack.mrpack')],
    [ZIP_LOCAL, reviewed('pack.part1.rar')],
    [ZIP_LOCAL, reviewed('pack.001', { kind: 'multipart', groupingScheme: 'numbered-volume' })]
  ];
  for (const [bytes, names] of cases) {
    if (names.parts.length === 1 && names.kind === 'multipart') {
      names.parts.push({ partId: 'second', fileName: 'pack.002' });
    }
    assert.throws(() => detectMagic(bytes, names), hasCode('MAGIC_EXTENSION_MISMATCH'));
  }
});

test('reviewed name input is closed, complete, and Windows-basename safe', () => {
  for (const names of [
    null,
    reviewed('../pack.zip'),
    reviewed('pack.zip', { unexpected: true }),
    reviewed('pack.zip', { primaryPartId: 'missing' }),
    reviewed('pack.zip', { parts: [{ partId: 'primary', fileName: 'pack.zip' }, { partId: 'x', fileName: 'PACK.ZIP' }] })
  ]) {
    assert.throws(() => detectMagic(ZIP_LOCAL, names), hasCode('INVALID_REQUEST'));
  }
});

test('packaged runtime resolution uses only resourcesPath/archive and never a vendor or PATH fallback', async () => {
  const resourcesPath = path.resolve('C:/Program Files/Minecraft Core/resources');
  const calls = [];
  const result = await getBundledArchiveRuntime({
    resourcesPath,
    arch: 'x64',
    isPackaged: true,
    verifyRuntime: async root => {
      calls.push(['runtime', root]);
      return { version: '26.02', architecture: 'x64', handlers: { zip: true, rar: true } };
    },
    verifyWorker: async options => {
      calls.push(['worker', options.workerPath, options.workerManifestPath]);
      return { architecture: 'x64', runtimeIdentifier: 'win-x64' };
    }
  });

  const expectedRoot = path.join(resourcesPath, 'archive');
  assert.equal(result.resourcesRoot, expectedRoot);
  assert.equal(result.enginePath, path.join(expectedRoot, '7zip', '7z.exe'));
  assert.equal(result.workerPath, path.join(expectedRoot, 'worker', 'ArchiveWorker.exe'));
  assert.equal(result.workerManifestPath, path.join(expectedRoot, 'manifests', 'archive-worker-x64.json'));
  assert.equal(result.engineVersion, '26.02');
  assert.equal(calls[0][1], expectedRoot);
  assert.deepEqual(calls[1], [
    'worker',
    path.join(expectedRoot, 'worker', 'ArchiveWorker.exe'),
    path.join(expectedRoot, 'manifests', 'archive-worker-x64.json')
  ]);
  assert.ok(calls.slice(1).flat().every(value => typeof value !== 'string' || !value.includes(process.env.PATH || '\0')));
  assert.equal(Object.isFrozen(result), true);
});

test('path-only runtime resolution derives and freezes the closed packaged layout without verification', () => {
  const resourcesPath = path.resolve('C:/Program Files/Minecraft Core/resources');
  const runtime = resolveBundledArchiveRuntimePaths({
    resourcesPath,
    arch: 'x64',
    isPackaged: true,
    verifyRuntime: () => assert.fail('path-only resolution must not verify the runtime'),
    verifyWorker: () => assert.fail('path-only resolution must not verify the worker')
  });

  const expectedRoot = path.join(resourcesPath, 'archive');
  assert.deepEqual(runtime, {
    resourcesRoot: expectedRoot,
    runtimeLayout: 'packaged',
    enginePath: path.join(expectedRoot, '7zip', '7z.exe'),
    workerPath: path.join(expectedRoot, 'worker', 'ArchiveWorker.exe'),
    workerManifestPath: path.join(expectedRoot, 'manifests', 'archive-worker-x64.json'),
    architecture: 'x64'
  });
  assert.equal(Object.isFrozen(runtime), true);
  assert.throws(() => resolveBundledArchiveRuntimePaths({
    resourcesPath: 'relative', arch: 'x64', isPackaged: true
  }), hasCode('EXTRACTOR_UNAVAILABLE'));
});

test('the real verifier accepts only the closed packaged archive layout', { timeout: 30000 }, async (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-archive-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const archiveRoot = copyPackagedArchiveResources(resourcesPath);

  const runtime = await getBundledArchiveRuntime({
    resourcesPath,
    arch: 'x64',
    isPackaged: true
  });

  assert.equal(runtime.resourcesRoot, archiveRoot);
  assert.equal(runtime.runtimeLayout, 'packaged');
  assert.equal(runtime.enginePath, path.join(archiveRoot, '7zip', '7z.exe'));
  assert.equal(runtime.workerPath, path.join(archiveRoot, 'worker', 'ArchiveWorker.exe'));
});

test('a missing or tampered packaged runtime fails even when another runtime exists', async () => {
  const resourcesPath = path.resolve('C:/Program Files/Minecraft Core/resources');
  await assert.rejects(getBundledArchiveRuntime({
    resourcesPath,
    arch: 'x64',
    isPackaged: true,
    runtimeRoot: path.resolve('vendor'),
    verifyRuntime: async root => {
      assert.equal(root, path.join(resourcesPath, 'archive'));
      throw new Error('tampered');
    },
    verifyWorker: async () => assert.fail('worker verification must not mask runtime failure')
  }), hasCode('EXTRACTOR_UNAVAILABLE'));
});

test('development requires an explicit verified repository root and x64 architecture', async () => {
  await assert.rejects(getBundledArchiveRuntime({ arch: 'x64', isPackaged: false }), hasCode('EXTRACTOR_UNAVAILABLE'));
  await assert.rejects(getBundledArchiveRuntime({
    runtimeRoot: path.resolve('.'), arch: 'arm64', isPackaged: false
  }), hasCode('EXTRACTOR_UNAVAILABLE'));

  const runtimeRoot = path.resolve('.');
  const result = await getBundledArchiveRuntime({
    runtimeRoot,
    arch: 'x64',
    isPackaged: false,
    verifyRuntime: async root => {
      assert.equal(root, runtimeRoot);
      return { version: '26.02', architecture: 'x64', handlers: { zip: true, rar: true } };
    },
    verifyWorker: async () => ({ architecture: 'x64', runtimeIdentifier: 'win-x64' })
  });
  assert.equal(result.resourcesRoot, runtimeRoot);
  assert.equal(result.enginePath, path.join(runtimeRoot, 'vendor', '7zip', 'x64', '7z.exe'));
  assert.equal(result.workerPath, path.join(runtimeRoot, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe'));
});
