const assert = require('node:assert/strict');
const test = require('node:test');

const {
  compileAssetPattern,
  compileAssetPatternForInspection,
  matchAssetPattern,
  matchAssetPatternProvisional
} = require('../../electron/services/modpacks/providers/github-asset-pattern.cjs');

const runtime = Object.freeze({
  minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14',
  javaMajor: 21, os: 'win32', architecture: 'x64'
});
const rootFingerprint = 'a'.repeat(64);
const singleStructure = Object.freeze({ kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 });

function reviewed(overrides = {}) {
  return {
    filenameMatcher: 'server-pack-*.zip', reviewedRole: 'server-pack',
    archiveRootFingerprint: rootFingerprint, runtimeEvidence: runtime,
    multipartStructure: singleStructure, userOverrides: { selectedRoot: 'server' },
    ...overrides
  };
}

function candidate(assetId, overrides = {}) {
  return {
    assetIds: [assetId], fileNames: ['server-pack-2.0.0.zip'], reviewedRole: 'server-pack',
    archiveRootFingerprint: rootFingerprint, runtimeEvidence: runtime,
    multipartStructure: singleStructure, userOverrides: { selectedRoot: 'server' }, complete: true,
    ...overrides
  };
}

test('compiles a normalized versioned immutable asset pattern with every reviewed evidence field', () => {
  const pattern = compileAssetPattern(reviewed({ filenameMatcher: 'SERVER-PACK-*.ZIP' }));
  assert.deepEqual(pattern, {
    type: 'github-asset-pattern', version: 1,
    filenameMatchers: [{ kind: 'single-wildcard', prefix: 'server-pack-', suffix: '.zip' }],
    reviewedRole: 'server-pack', archiveRootFingerprint: rootFingerprint,
    runtimeEvidence: runtime, multipartStructure: singleStructure,
    userOverrides: { selectedRoot: 'server' }
  });
  assert.equal(Object.isFrozen(pattern), true);
  assert.equal(Object.isFrozen(pattern.filenameMatchers), true);
  assert.equal(Object.isFrozen(pattern.runtimeEvidence), true);
  assert.equal(Object.isFrozen(pattern.userOverrides), true);
});

test('rejects regex code evaluator and catastrophic or ambiguous user expressions', () => {
  for (const filenameMatcher of [
    /server-(.*)+\.zip/i,
    { regex: 'server-(.*)+\\.zip' },
    'server-**.zip',
    '*.zip',
    'server-[0-9]+.zip',
    'server-(.*)+.zip',
    'folder/server-*.zip',
    `server-${'a'.repeat(300)}*.zip`
  ]) {
    assert.throws(() => compileAssetPattern(reviewed({ filenameMatcher })), error => error.code === 'INVALID_REQUEST');
  }
  assert.throws(() => compileAssetPattern({ ...reviewed(), evaluator: 'return true' }), error => error.code === 'INVALID_REQUEST');
});

test('rejects Windows device aliases including superscript digits in reviewed and persisted matchers', () => {
  for (const filenameMatcher of ['COM¹.zip', 'LPT².rar', 'CONIN$.zip', 'CONOUT$.mrpack']) {
    assert.throws(() => compileAssetPattern(reviewed({ filenameMatcher })), error => error.code === 'INVALID_REQUEST');
  }
  const pattern = structuredClone(compileAssetPattern(reviewed()));
  pattern.filenameMatchers = [{ kind: 'literal', value: 'com¹.zip' }];
  assert.throws(() => matchAssetPattern(pattern, [candidate('301')]), error => error.code === 'INVALID_REQUEST');
});

test('returns high confidence only for exactly one complete exact-evidence asset set', () => {
  const result = matchAssetPattern(compileAssetPattern(reviewed()), [candidate('301')]);
  assert.deepEqual(result, { type: 'HIGH_CONFIDENCE', selectedAssetIds: ['301'] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.selectedAssetIds), true);
});

test('zero or multiple complete matches require explicit asset selection', () => {
  const pattern = compileAssetPattern(reviewed());
  assert.deepEqual(matchAssetPattern(pattern, [candidate('301', { fileNames: ['client.zip'] })]), {
    type: 'ASSET_SELECTION_REQUIRED', count: '0'
  });
  assert.deepEqual(matchAssetPattern(pattern, [candidate('301'), candidate('302')]), {
    type: 'ASSET_SELECTION_REQUIRED', count: '2'
  });
});

test('role root runtime override and multipart mismatches cannot produce high confidence', () => {
  const pattern = compileAssetPattern(reviewed());
  const mismatches = [
    { reviewedRole: 'mrpack' },
    { archiveRootFingerprint: 'b'.repeat(64) },
    { runtimeEvidence: { ...runtime, loaderVersion: '0.16.15' } },
    { userOverrides: { selectedRoot: 'other' } },
    { multipartStructure: { kind: 'multipart', groupingScheme: 'part-number', partCount: 2, primaryIndex: 0 } }
  ];
  for (const changed of mismatches) {
    assert.equal(matchAssetPattern(pattern, [candidate('301', changed)]).type, 'ASSET_SELECTION_REQUIRED');
  }
});

test('incomplete sets and candidates missing recorded evidence are never matched', () => {
  const pattern = compileAssetPattern(reviewed());
  for (const changed of [
    { complete: false },
    { archiveRootFingerprint: undefined },
    { runtimeEvidence: undefined },
    { userOverrides: undefined }
  ]) {
    assert.deepEqual(matchAssetPattern(pattern, [candidate('301', changed)]), {
      type: 'ASSET_SELECTION_REQUIRED', count: '0'
    });
  }
});

test('multipart patterns require exact ordered matchers structure and one complete selected set', () => {
  const structure = { kind: 'multipart', groupingScheme: 'part-number', partCount: 2, primaryIndex: 0 };
  const pattern = compileAssetPattern(reviewed({
    filenameMatcher: undefined,
    filenameMatchers: ['pack-*.part1.rar', 'pack-*.part2.rar'],
    multipartStructure: structure
  }));
  const good = candidate('401', {
    assetIds: ['401', '402'], fileNames: ['pack-v2.part1.rar', 'pack-v2.part2.rar'],
    multipartStructure: structure
  });
  assert.deepEqual(matchAssetPattern(pattern, [good]), {
    type: 'HIGH_CONFIDENCE', selectedAssetIds: ['401', '402']
  });
  assert.equal(matchAssetPattern(pattern, [{ ...good, fileNames: good.fileNames.slice().reverse() }]).type, 'ASSET_SELECTION_REQUIRED');
  assert.equal(matchAssetPattern(pattern, [{ ...good, assetIds: ['401'], fileNames: ['pack-v2.part1.rar'], complete: false }]).type, 'ASSET_SELECTION_REQUIRED');
});

test('tampered persisted patterns and duplicate or unsafe candidate IDs fail closed', () => {
  const pattern = { ...compileAssetPattern(reviewed()), version: 2 };
  assert.throws(() => matchAssetPattern(pattern, [candidate('301')]), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => matchAssetPattern(compileAssetPattern(reviewed()), [candidate('301', { assetIds: ['301', '301'], fileNames: ['a.zip', 'b.zip'] })]), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => matchAssetPattern(compileAssetPattern(reviewed()), [candidate('../301')]), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => matchAssetPattern(compileAssetPattern(reviewed()), [candidate('301', { fileNames: ['CON.zip'] })]), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => matchAssetPattern(compileAssetPattern(reviewed()), [candidate('301', { fileNames: ['COM¹.zip'] })]), error => error.code === 'INVALID_REQUEST');
});

test('aggregate override node and UTF-8 budgets reject renderer-sized values', () => {
  let hundredThousandLeaves = true;
  for (let depth = 0; depth < 5; depth += 1) hundredThousandLeaves = Array(10).fill(hundredThousandLeaves);
  const oversizedUtf8 = Array.from({ length: 64 }, () => Array(8).fill('é'.repeat(256)));
  for (const userOverrides of [hundredThousandLeaves, oversizedUtf8]) {
    assert.throws(
      () => compileAssetPattern(reviewed({ userOverrides })),
      error => error.code === 'INVALID_REQUEST'
    );
  }
});

test('matching rejects an excessive matcher-candidate product before deep normalization', () => {
  const partCount = 300;
  const multipartStructure = { kind: 'multipart', groupingScheme: 'part-number', partCount, primaryIndex: 0 };
  const filenameMatchers = Array.from({ length: partCount }, (_, index) => `part${String(index).padStart(3, '0')}-*.rar`);
  const fileNames = Array.from({ length: partCount }, (_, index) => `part${String(index).padStart(3, '0')}-v1.rar`);
  const assetIds = Array.from({ length: partCount }, (_, index) => String(index + 1));
  const pattern = compileAssetPattern(reviewed({ filenameMatcher: undefined, filenameMatchers, multipartStructure }));
  const oversizedCandidates = Array(300).fill({
    assetIds, fileNames, reviewedRole: 'server-pack', archiveRootFingerprint: rootFingerprint,
    runtimeEvidence: runtime, multipartStructure, userOverrides: { selectedRoot: 'server' }, complete: true
  });
  assert.throws(
    () => matchAssetPattern(pattern, oversizedCandidates),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('matching shares one aggregate override budget across every candidate', () => {
  const pattern = compileAssetPattern(reviewed());
  const perCandidateOverrides = Array(10).fill(Array(10).fill(true));
  const candidates = Array.from({ length: 100 }, (_, index) => candidate(String(index + 1), {
    userOverrides: perCandidateOverrides
  }));
  assert.throws(
    () => matchAssetPattern(pattern, candidates),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('compiles remembered review intent from the exact selected asset structure and inspected runtime', () => {
  const pattern = compileAssetPatternForInspection({
    seed: {
      fileNames: ['server-pack-v2.0.0.zip'],
      multipartStructure: singleStructure
    },
    version: 'v2.0.0',
    classificationKind: 'prepared-server-pack',
    inspectionResult: {
      selectedRoot: 'server',
      entries: [
        { canonicalName: 'server/mods/a.jar', type: 'file' },
        { canonicalName: 'server/config/a.toml', type: 'file' },
        { canonicalName: 'client/readme.txt', type: 'file' }
      ]
    },
    runtimeEvidence: runtime,
    userOverrides: { selectedRoot: 'server', runtimeChoice: null }
  });
  assert.deepEqual(pattern.filenameMatchers, [{
    kind: 'single-wildcard', prefix: 'server-pack-v', suffix: '.zip'
  }]);
  assert.equal(pattern.reviewedRole, 'server-pack');
  assert.match(pattern.archiveRootFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(pattern.userOverrides, { runtimeChoice: null, selectedRoot: 'server' });
});

test('provisional future matching requires exactly one complete filename and multipart-structure match', () => {
  const structure = { kind: 'multipart', groupingScheme: 'part-number', partCount: 2, primaryIndex: 0 };
  const pattern = compileAssetPattern(reviewed({
    filenameMatcher: undefined,
    filenameMatchers: ['pack-*.part1.rar', 'pack-*.part2.rar'],
    multipartStructure: structure
  }));
  const good = {
    assetIds: ['401', '402'], fileNames: ['pack-v3.part1.rar', 'pack-v3.part2.rar'],
    multipartStructure: structure, complete: true
  };
  assert.deepEqual(matchAssetPatternProvisional(pattern, [good]), {
    type: 'SINGLE_PROVISIONAL', selectedAssetIds: ['401', '402']
  });
  assert.deepEqual(matchAssetPatternProvisional(pattern, [good, { ...good, assetIds: ['501', '502'] }]), {
    type: 'ASSET_SELECTION_REQUIRED', count: '2'
  });
  assert.deepEqual(matchAssetPatternProvisional(pattern, [{
    ...good,
    multipartStructure: { ...structure, groupingScheme: 'numbered-volume' }
  }]), { type: 'ASSET_SELECTION_REQUIRED', count: '0' });
});
