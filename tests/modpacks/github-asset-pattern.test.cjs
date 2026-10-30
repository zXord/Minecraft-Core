const assert = require('node:assert/strict');
const test = require('node:test');

const {
  compileAssetPattern,
  compileAssetPatternForInspection,
  matchAssetPattern,
  matchAssetPatternProvisional
} = require('../../electron/services/modpacks/providers/github-asset-pattern.cjs');
const { GitHubReleasesSource } = require('../../electron/services/modpacks/providers/github-releases-source.cjs');
const { ProductionModpackSourceResolver } = require('../../electron/services/modpacks/providers/production-source-resolver.cjs');

const runtime = Object.freeze({
  minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14',
  javaMajor: 21, os: 'win32', architecture: 'x64'
});
const rootFingerprint = 'a'.repeat(64);
const singleStructure = Object.freeze({ kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 });
const ADRENALINE = 'Adrenaline-26.5.1+mc1.21.1.fabric.mrpack';
const mrpackInspection = Object.freeze({
  selectedRoot: null,
  entries: [
    { canonicalName: 'modrinth.index.json', type: 'file' },
    { canonicalName: 'overrides/config/sodium-options.json', type: 'file' }
  ]
});
const REAL_ASSETS = Object.freeze([
  {
    fileName: ADRENALINE, version: '26.5.1',
    matcher: { kind: 'single-wildcard', prefix: 'adrenaline-', suffix: '+mc1.21.1.fabric.mrpack' },
    nextRelease: 'Adrenaline-26.6.0+mc1.21.1.fabric.mrpack', sibling: 'Adrenaline-26.6.0+mc26.2.fabric.mrpack'
  },
  {
    fileName: 'Adrenaline-26.5.1+mc26.2.fabric.mrpack', version: 'v26.5.1',
    matcher: { kind: 'single-wildcard', prefix: 'adrenaline-', suffix: '+mc26.2.fabric.mrpack' },
    nextRelease: 'Adrenaline-26.6.0+mc26.2.fabric.mrpack', sibling: 'Adrenaline-26.6.0+mc1.21.1.fabric.mrpack'
  },
  {
    fileName: 'TerraFirmaGreg-Modern-0.13.4-ServerPack.zip', version: 'v0.13.4',
    matcher: { kind: 'single-wildcard', prefix: 'terrafirmagreg-modern-', suffix: '-serverpack.zip' },
    nextRelease: 'TerraFirmaGreg-Modern-0.13.5-ServerPack.zip', sibling: 'TerraFirmaGreg-Modern-0.13.5-ClientPack.zip'
  },
  {
    fileName: 'Create Above and Beyond (Server) [1.20.1] 1.6.2.zip', version: '1.6.2',
    matcher: { kind: 'single-wildcard', prefix: 'create above and beyond (server) [1.20.1] ', suffix: '.zip' },
    nextRelease: 'Create Above and Beyond (Server) [1.20.1] 1.7.0.zip', sibling: 'Create Above and Beyond (Client) [1.20.1] 1.7.0.zip'
  },
  {
    fileName: 'Skyblock {Fabric} ^Server$ 3.1.0.zip', version: '3.1.0',
    matcher: { kind: 'single-wildcard', prefix: 'skyblock {fabric} ^server$ ', suffix: '.zip' },
    nextRelease: 'Skyblock {Fabric} ^Server$ 3.2.0.zip', sibling: 'Skyblock {Fabric} ^Client$ 3.2.0.zip'
  }
]);

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

function singleProvisional(assetId, fileName) {
  return { assetIds: [assetId], fileNames: [fileName], multipartStructure: singleStructure, complete: true };
}

// The exact arguments ProductionPlanningAdapter passes when the reviewer opted in to remembering the asset.
function rememberedPattern(fileNames, version, multipartStructure = singleStructure) {
  return compileAssetPatternForInspection({
    seed: { fileNames, multipartStructure },
    version,
    classificationKind: 'mrpack-server',
    inspectionResult: mrpackInspection,
    runtimeEvidence: runtime,
    userOverrides: { selectedRoot: null, runtimeChoice: null }
  });
}

// modpack.json and the release tracking store keep the pattern as JSON and re-validate it on every read.
function persisted(pattern) {
  return JSON.parse(JSON.stringify(pattern));
}

function evidenceCandidate(pattern, assetIds, fileNames) {
  return {
    assetIds, fileNames, reviewedRole: pattern.reviewedRole,
    archiveRootFingerprint: pattern.archiveRootFingerprint, runtimeEvidence: pattern.runtimeEvidence,
    multipartStructure: pattern.multipartStructure, userOverrides: pattern.userOverrides, complete: true
  };
}

// Mirrors how the release monitor and the GitHub asset step turn listed choices into provisional candidates.
function provisionalChoices(choices) {
  return choices.map(choice => ({
    assetIds: choice.parts.map(part => part.providerAssetId),
    fileNames: choice.parts.map(part => part.fileName),
    multipartStructure: {
      kind: choice.kind,
      groupingScheme: choice.groupingScheme,
      partCount: choice.parts.length,
      primaryIndex: choice.parts.findIndex(part => part.providerAssetId === choice.primaryPartId)
    },
    complete: choice.complete === true
  }));
}

function githubJson(value) {
  return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(value), 'utf8') };
}

function adrenalineGithubSource() {
  const releases = new Map([
    ['201', {
      tag: '26.5.1', publishedAt: '2026-10-01T00:00:00Z',
      assets: [[301, ADRENALINE], [302, 'Adrenaline-26.5.1+mc26.2.fabric.mrpack']]
    }],
    ['202', {
      tag: '26.6.0', publishedAt: '2026-10-20T00:00:00Z',
      assets: [[401, 'Adrenaline-26.6.0+mc26.2.fabric.mrpack'], [402, 'Adrenaline-26.6.0+mc1.21.1.fabric.mrpack']]
    }]
  ]);
  const http = {
    async request(requestPath) {
      if (requestPath === '/repos/Owner/Adrenaline') {
        return githubJson({
          id: 101, name: 'Adrenaline', full_name: 'Owner/Adrenaline', private: false, visibility: 'public',
          archived: false, disabled: false, owner: { login: 'Owner' }
        });
      }
      const match = /^\/repos\/Owner\/Adrenaline\/releases\/(\d+)(\/assets)?$/.exec(requestPath);
      const release = match && releases.get(match[1]);
      if (!release) throw new Error(`Unexpected GitHub request ${requestPath}`);
      if (!match[2]) {
        return githubJson({
          id: Number(match[1]), tag_name: release.tag, name: release.tag, draft: false, prerelease: false, immutable: false,
          created_at: release.publishedAt, updated_at: release.publishedAt, published_at: release.publishedAt
        });
      }
      return githubJson(release.assets.map(([id, name]) => ({
        id, name, label: null, content_type: 'application/octet-stream', state: 'uploaded', size: 4096, digest: null,
        created_at: release.publishedAt, updated_at: release.publishedAt
      })));
    }
  };
  return new GitHubReleasesSource({ http, clock: { now: () => Date.parse('2026-10-30T12:00:00.000Z') } });
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
    'server-*-*.zip',
    '*.zip',
    'server-?.zip',
    'server-*-v?.zip',
    'server-1|2.zip',
    'folder/server-*.zip',
    `server-${'a'.repeat(300)}*.zip`
  ]) {
    assert.throws(() => compileAssetPattern(reviewed({ filenameMatcher })), error => error.code === 'INVALID_REQUEST');
  }
  assert.throws(() => compileAssetPattern({ ...reviewed(), evaluator: 'return true' }), error => error.code === 'INVALID_REQUEST');
});

test('star is the only wildcard and regex or glob syntax in a file name is compared as plain text', () => {
  const regexLooking = persisted(compileAssetPattern(reviewed({ filenameMatcher: 'server-[0-9]+.zip' })));
  assert.deepEqual(regexLooking.filenameMatchers, [{ kind: 'literal', value: 'server-[0-9]+.zip' }]);
  assert.deepEqual(matchAssetPattern(regexLooking, [
    candidate('301', { fileNames: ['server-5.zip'] }),
    candidate('302', { fileNames: ['server-55.zip'] })
  ]), { type: 'ASSET_SELECTION_REQUIRED', count: '0' });
  assert.deepEqual(matchAssetPattern(regexLooking, [candidate('303', { fileNames: ['Server-[0-9]+.zip'] })]), {
    type: 'HIGH_CONFIDENCE', selectedAssetIds: ['303']
  });

  const groupLooking = persisted(compileAssetPattern(reviewed({ filenameMatcher: 'server-(.*)+.zip' })));
  assert.deepEqual(groupLooking.filenameMatchers, [{ kind: 'single-wildcard', prefix: 'server-(.', suffix: ')+.zip' }]);
  assert.deepEqual(matchAssetPattern(groupLooking, [candidate('301', { fileNames: ['server-1.zip'] })]), {
    type: 'ASSET_SELECTION_REQUIRED', count: '0'
  });
  assert.deepEqual(matchAssetPattern(groupLooking, [candidate('302', { fileNames: ['server-(.v2)+.zip'] })]), {
    type: 'HIGH_CONFIDENCE', selectedAssetIds: ['302']
  });

  for (const matcher of [
    { kind: 'literal', value: 'server-?.zip' },
    { kind: 'literal', value: 'server-1|2.zip' },
    { kind: 'literal', value: 'server-*.zip' },
    { kind: 'single-wildcard', prefix: 'server-?', suffix: '.zip' },
    { kind: 'single-wildcard', prefix: 'server-', suffix: '*.zip' }
  ]) {
    assert.throws(
      () => matchAssetPattern({ ...regexLooking, filenameMatchers: [matcher] }, []),
      error => error.code === 'INVALID_REQUEST',
      JSON.stringify(matcher)
    );
  }
});

test('real GitHub asset names with plus, parentheses, brackets, braces, caret and dollar compile as exact literal patterns', () => {
  for (const { fileName, nextRelease, sibling } of REAL_ASSETS) {
    const pattern = persisted(compileAssetPattern(reviewed({ filenameMatcher: fileName })));
    assert.deepEqual(pattern.filenameMatchers, [{ kind: 'literal', value: fileName.toLocaleLowerCase('en-US') }], fileName);
    assert.deepEqual(matchAssetPattern(pattern, [
      candidate('301', { fileNames: [nextRelease] }),
      candidate('302', { fileNames: [fileName] }),
      candidate('303', { fileNames: [sibling] })
    ]), { type: 'HIGH_CONFIDENCE', selectedAssetIds: ['302'] }, fileName);
  }
});

test('remembered patterns for real GitHub asset names replace only the release version and select the next equivalent asset', () => {
  for (const { fileName, version, matcher, nextRelease, sibling } of REAL_ASSETS) {
    const pattern = persisted(rememberedPattern([fileName], version));
    assert.deepEqual(pattern.filenameMatchers, [matcher], fileName);
    assert.deepEqual(matchAssetPattern(pattern, []), { type: 'ASSET_SELECTION_REQUIRED', count: '0' }, fileName);
    assert.deepEqual(matchAssetPatternProvisional(pattern, [singleProvisional('400', fileName)]), {
      type: 'SINGLE_PROVISIONAL', selectedAssetIds: ['400']
    }, fileName);
    assert.deepEqual(matchAssetPatternProvisional(pattern, [
      singleProvisional('401', sibling),
      singleProvisional('402', nextRelease)
    ]), { type: 'SINGLE_PROVISIONAL', selectedAssetIds: ['402'] }, fileName);
    assert.deepEqual(matchAssetPattern(pattern, [
      evidenceCandidate(pattern, ['501'], [sibling]),
      evidenceCandidate(pattern, ['502'], [nextRelease])
    ]), { type: 'HIGH_CONFIDENCE', selectedAssetIds: ['502'] }, fileName);

    const typed = compileAssetPattern(reviewed({ filenameMatcher: fileName.replace(version.replace(/^v/, ''), '*') }));
    assert.deepEqual(typed.filenameMatchers, [matcher], fileName);
  }

  const multipartStructure = { kind: 'multipart', groupingScheme: 'part-number', partCount: 2, primaryIndex: 0 };
  const multipart = persisted(rememberedPattern(
    ['Pack-1.2.3+mc1.20.1 (Server).part1.rar', 'Pack-1.2.3+mc1.20.1 (Server).part2.rar'],
    'v1.2.3',
    multipartStructure
  ));
  assert.deepEqual(multipart.filenameMatchers, [
    { kind: 'single-wildcard', prefix: 'pack-', suffix: '+mc1.20.1 (server).part1.rar' },
    { kind: 'single-wildcard', prefix: 'pack-', suffix: '+mc1.20.1 (server).part2.rar' }
  ]);
  assert.deepEqual(matchAssetPatternProvisional(multipart, [{
    assetIds: ['601', '602'],
    fileNames: ['Pack-1.3.0+mc1.20.1 (Server).part1.rar', 'Pack-1.3.0+mc1.20.1 (Server).part2.rar'],
    multipartStructure, complete: true
  }]), { type: 'SINGLE_PROVISIONAL', selectedAssetIds: ['601', '602'] });
});

test('remembering the reviewed Adrenaline asset survives review and later validation and selects the next release asset', async () => {
  const github = adrenalineGithubSource();
  await github.getRepositoryIdentity('https://github.com/Owner/Adrenaline');
  const resolver = new ProductionModpackSourceResolver({
    providers: { github, modrinth: { async getVersion() {}, async resolveArtifactSetPlan() {} } },
    localArtifactSource: { async ingestSelection() {} }
  });
  const reviewedRelease = await github.loadUploadedAssets({ repositoryId: '101', releaseId: '201' });
  const reviewedChoice = reviewedRelease.choices.find(choice => choice.parts[0].fileName === ADRENALINE);
  const resolved = await resolver.resolveArtifactSetPlan({
    provider: 'github', repositoryId: '101', releaseId: '201',
    assetIds: reviewedChoice.parts.map(part => part.providerAssetId), rememberAssetPattern: true
  });
  assert.deepEqual(resolved.source.assetPatternSeed, { fileNames: [ADRENALINE], multipartStructure: singleStructure });

  // Review: the planning adapter compiles the remembered pattern from the seed with these exact inputs.
  const pattern = compileAssetPatternForInspection({
    seed: resolved.source.assetPatternSeed,
    version: resolved.source.version,
    classificationKind: 'mrpack-server',
    inspectionResult: mrpackInspection,
    runtimeEvidence: runtime,
    userOverrides: { selectedRoot: null, runtimeChoice: null }
  });
  assert.deepEqual(pattern.filenameMatchers, [{
    kind: 'single-wildcard', prefix: 'adrenaline-', suffix: '+mc1.21.1.fabric.mrpack'
  }]);

  // The preflight planner, the modpack state and the release tracking store re-validate the saved copy.
  const saved = persisted(pattern);
  assert.deepEqual(matchAssetPattern(saved, []), { type: 'ASSET_SELECTION_REQUIRED', count: '0' });

  // The next release lists both loader variants; only the reviewed variant is preselected.
  const nextRelease = await github.loadUploadedAssets({ repositoryId: '101', releaseId: '202' });
  assert.deepEqual(matchAssetPatternProvisional(saved, provisionalChoices(nextRelease.choices)), {
    type: 'SINGLE_PROVISIONAL', selectedAssetIds: ['402']
  });
});

test('a wildcard still needs three literal characters on each side, otherwise the exact asset name is remembered', () => {
  for (const filenameMatcher of [
    '*+mc1.21.1.fabric.mrpack',
    'ad*+mc1.21.1.fabric.mrpack',
    'Adrenaline-*',
    'Adrenaline-*.z',
    'pac*.zi'
  ]) {
    assert.throws(() => compileAssetPattern(reviewed({ filenameMatcher })), error => error.code === 'INVALID_REQUEST', filenameMatcher);
  }
  const pattern = persisted(compileAssetPattern(reviewed()));
  for (const matcher of [
    { kind: 'single-wildcard', prefix: 'ad', suffix: '+mc1.21.1.fabric.mrpack' },
    { kind: 'single-wildcard', prefix: 'adrenaline-', suffix: '.z' },
    { kind: 'single-wildcard', prefix: 'pac', suffix: '.zi' }
  ]) {
    assert.throws(
      () => matchAssetPattern({ ...pattern, filenameMatchers: [matcher] }, []),
      error => error.code === 'INVALID_REQUEST',
      JSON.stringify(matcher)
    );
  }
  for (const [fileName, version] of [
    // Replacing the version would leave too little literal text on one side.
    ['26.5.1+mc1.21.1.fabric.mrpack', '26.5.1'],
    ['p-26.5.1+mc1.21.1.fabric.mrpack', 'v26.5.1'],
    ['Adrenaline-26.5.1', '26.5.1'],
    // The version appears twice, or not at all, so no single place can be replaced.
    ['Adrenaline-26.2+mc26.2.fabric.mrpack', '26.2'],
    ['Adrenaline+mc1.21.1.fabric.mrpack', '26.5.1']
  ]) {
    const remembered = persisted(rememberedPattern([fileName], version));
    assert.deepEqual(remembered.filenameMatchers, [{ kind: 'literal', value: fileName.toLocaleLowerCase('en-US') }], fileName);
    assert.deepEqual(matchAssetPatternProvisional(remembered, [singleProvisional('701', fileName)]), {
      type: 'SINGLE_PROVISIONAL', selectedAssetIds: ['701']
    }, fileName);
  }
});

test('control characters stay refused in reviewed, remembered and persisted matchers', () => {
  for (const filenameMatcher of [
    'Adrenaline-26.5.1+mc1.21.1\u0000.fabric.mrpack',
    'Adrenaline-*+mc1.21.1\u0007.fabric.mrpack',
    'Adrenaline-\u001b*+mc1.21.1.fabric.mrpack',
    'Adrenaline-26.5.1+mc1.21.1.fabric\u007f.mrpack'
  ]) {
    assert.throws(() => compileAssetPattern(reviewed({ filenameMatcher })), error => error.code === 'INVALID_REQUEST', JSON.stringify(filenameMatcher));
  }
  const pattern = persisted(compileAssetPattern(reviewed({ filenameMatcher: 'Adrenaline-*+mc1.21.1.fabric.mrpack' })));
  for (const matcher of [
    { kind: 'literal', value: 'adrenaline-26.5.1+mc1.21.1\u0000.fabric.mrpack' },
    { kind: 'single-wildcard', prefix: 'adrenaline-\u0007', suffix: '+mc1.21.1.fabric.mrpack' },
    { kind: 'single-wildcard', prefix: 'adrenaline-', suffix: '+mc1.21.1\u001f.fabric.mrpack' }
  ]) {
    assert.throws(
      () => matchAssetPattern({ ...pattern, filenameMatchers: [matcher] }, []),
      error => error.code === 'INVALID_REQUEST',
      JSON.stringify(matcher)
    );
  }
  assert.throws(
    () => matchAssetPatternProvisional(pattern, [singleProvisional('801', 'Adrenaline-26.6.0+mc1.21.1\u0000.fabric.mrpack')]),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.throws(() => rememberedPattern(['Adrenaline-26.5.1+mc1.21.1\u0000.fabric.mrpack'], '26.5.1'), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => rememberedPattern([ADRENALINE], '26.5.1\u0000'), error => error.code === 'INVALID_REQUEST');
});

test('a remembered wildcard replaces the version where it really is when lowercasing changes the name length', () => {
  const fileName = 'İstanbul-Pack-1.0.0.zip';
  const pattern = persisted(rememberedPattern([fileName], '1.0.0'));
  assert.deepEqual(pattern.filenameMatchers, [{
    kind: 'single-wildcard', prefix: 'İstanbul-Pack-'.toLocaleLowerCase('en-US'), suffix: '.zip'
  }]);
  assert.deepEqual(matchAssetPatternProvisional(pattern, [singleProvisional('901', fileName)]), {
    type: 'SINGLE_PROVISIONAL', selectedAssetIds: ['901']
  });
  assert.deepEqual(matchAssetPatternProvisional(pattern, [singleProvisional('902', 'İstanbul-Pack-2.0.0.zip')]), {
    type: 'SINGLE_PROVISIONAL', selectedAssetIds: ['902']
  });
});

test('an asset name that cannot be stored as a pattern is refused with guidance instead of saving one later validation rejects', () => {
  // 254 UTF-16 units is a valid Windows name, but its lowercase key is longer than a stored name may be.
  const fileName = `${'İ'.repeat(12)}${'a'.repeat(238)}.zip`;
  assert.equal(fileName.length, 254);
  assert.throws(() => rememberedPattern([fileName], 'v1.0.0'), error => {
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.match(error.message, /Use this asset pattern for future releases/);
    assert.doesNotThrow(() => error.toPublicResult());
    return true;
  });
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
