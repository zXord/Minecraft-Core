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
const { computePlanFingerprint } = require('../../electron/services/modpacks/artifacts/artifact-fingerprint.cjs');
const { ARCHIVE_LIMITS, computePreflightReserve } = require('../../electron/services/modpacks/limits.cjs');
const {
  createArchiveExtractor,
  extractArchive
} = require('../../electron/services/modpacks/archive/archive-extractor.cjs');

function digest(algorithm, bytes) {
  return crypto.createHash(algorithm).update(bytes).digest('hex');
}

function verifiedZip(bytes = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(40)])) {
  const plan = createArtifactSetPlan({
    provider: 'local',
    artifactSet: {
      kind: 'single', primaryPartId: 'archive', groupingScheme: 'single',
      parts: [{
        partId: 'archive', fileName: 'pack.zip', size: String(bytes.length),
        providerDigest: { algorithm: 'sha256', value: digest('sha256', bytes) }
      }],
      providerImmutable: true, attestationStatus: 'verified'
    }
  });
  return {
    bytes,
    set: finalizeVerifiedArtifactSet(plan, [{
      partId: 'archive', measuredSize: String(bytes.length),
      sha256: digest('sha256', bytes), sha512: digest('sha512', bytes)
    }])
  };
}

function idFactory() {
  let next = 0;
  return () => `extract-${++next}`;
}

function inspectionResult(set, entries = [
  { entryName: 'server.jar', type: 'file', size: '3', packedSize: '3', canonicalName: 'server.jar', depth: 1 }
]) {
  const expandedBytes = entries.reduce((total, entry) => total + (entry.type === 'file' ? BigInt(entry.size) : 0n), 0n);
  const packedBytes = entries.reduce((total, entry) => total + BigInt(entry.packedSize), 0n);
  const roots = new Map();
  let rootFile = false;
  let nested = false;
  for (const entry of entries) {
    const components = entry.entryName.split('/');
    if (components.length === 1) {
      if (entry.type === 'file') rootFile = true;
      else roots.set(entry.canonicalName, entry.entryName);
    } else {
      nested = true;
      roots.set(components[0].normalize('NFC').toLocaleLowerCase('en-US'), components[0].normalize('NFC'));
    }
  }
  const rootCandidates = [...roots.entries()].sort(([left], [right]) => left.localeCompare(right, 'en-US')).map(([, name]) => name);
  return {
    type: 'archive-inspection',
    archiveFamily: 'zip',
    integrity: 'tested',
    artifactSet: {
      completeness: 'verified-complete-set',
      fingerprint: computePlanFingerprint(set)
    },
    engineEvidence: { family: 'zip', version: '26.02', tested: true },
    entries,
    rootCandidates,
    selectedRoot: !rootFile && nested && rootCandidates.length === 1 ? rootCandidates[0] : null,
    limitEvidence: {
      policyVersion: 1,
      totals: {
        entryCount: entries.length,
        fileCount: entries.filter(entry => entry.type === 'file').length,
        directoryCount: entries.filter(entry => entry.type === 'directory').length,
        expandedBytes: expandedBytes.toString(),
        packedBytes: packedBytes.toString(),
        maximumDepth: Math.max(...entries.map(entry => entry.depth), 0),
        maximumPathLength: Math.max(...entries.map(entry => entry.entryName.length), 0)
      }
    },
    classification: {
      kind: 'prepared-server-pack',
      confidence: 'exact',
      runtime: { minecraftVersion: null, loaderFamily: 'vanilla', loaderVersion: null },
      evidence: [{ kind: 'server-jar', entryName: 'server.jar' }]
    }
  };
}

async function extractionFixture({ entries, workerAction, diskProbe, reparseInspector, clock, removeStaging, watchdogIntervalMs = 5 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-archive-extractor-'));
  const verified = verifiedZip();
  const cache = {
    retain() {},
    release() {},
    async materializeSet(set, destination, { onDestinationCreated }) {
      await fsp.mkdir(destination);
      onDestinationCreated();
      await fsp.writeFile(path.join(destination, set.artifactSet.parts[0].fileName), verified.bytes);
      return path.join(destination, set.artifactSet.parts[0].fileName);
    }
  };
  const registry = new ArtifactWorkspaceRegistry({ root, artifactCache: cache, idFactory: idFactory() });
  const planningId = registry.createPlanningSession();
  const artifactSetId = registry.registerVerifiedSet({ ownerId: planningId, verifiedSet: verified.set });
  await registry.materializeInput({ ownerId: planningId, artifactSetId });
  const result = inspectionResult(verified.set, entries);
  const inspectionId = registry.createInspection({ ownerId: planningId, artifactSetId, result });
  registry.transferOwnership({ fromOwnerId: planningId, toOwnerId: inspectionId });
  const destinationId = registry.createStagingOutput({ ownerId: inspectionId });
  const calls = [];
  const worker = {
    async run(request, options = {}) {
      calls.push(request);
      assert.equal(request.operation, 'extract');
      return workerAction
        ? workerAction({ request, ...options, output: path.join(root, request.outputDirectoryId) })
        : defaultWorker({ output: path.join(root, request.outputDirectoryId) });
    }
  };
  const service = createArchiveExtractor({
    workspaceRegistry: registry,
    workspaceRoot: root,
    workerClient: worker,
    diskProbe: diskProbe ?? (async () => ({ availableBytes: (100n * 1024n * 1024n * 1024n).toString() })),
    reparseInspector: reparseInspector ?? { isReparsePoint: async () => false },
    clock: clock ?? (() => Date.now()),
    ...(removeStaging ? { removeStaging } : {}),
    watchdogIntervalMs
  });
  return {
    root, verified, registry, inspectionId, destinationId, calls, service, result,
    cleanup: () => fsp.rm(root, { recursive: true, force: true })
  };
}

async function defaultWorker({ output }) {
  await fsp.writeFile(path.join(output, 'server.jar'), Buffer.from('jar'));
  return Object.freeze({ type: 'status', ok: true, exitCode: 0, metrics: {
    stdoutBytes: '0', stderrBytes: '0', dataBytes: '0', elapsedMs: 1
  } });
}

function hasCode(code) {
  return error => error?.code === code && !/[A-Z]:\\|https?:|archive-worker|server\.jar/i.test(error.message);
}

function pathFree(value) {
  if (!value || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(pathFree);
  return Object.entries(value).every(([key, child]) => !/(?:^path|path$|directory$)/i.test(key) && pathFree(child));
}

test('preflight requires declared bytes plus max of 2 GiB or ten percent before worker launch', async t => {
  const fixture = await extractionFixture({
    diskProbe: async () => ({ availableBytes: (2n * 1024n * 1024n * 1024n).toString() })
  });
  t.after(fixture.cleanup);
  assert.equal(computePreflightReserve('3'), ARCHIVE_LIMITS.minPreflightReserveBytes);
  await assert.rejects(fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId
  }), hasCode('INSUFFICIENT_DISK'));
  assert.equal(fixture.calls.length, 0);
  assert.equal(fs.existsSync(path.join(fixture.root, fixture.destinationId)), false);
});

test('extracts only through the forced family into the exact fresh opaque output ID', async t => {
  const fixture = await extractionFixture();
  t.after(fixture.cleanup);
  const progress = [];
  const result = await fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId,
    onProgress: value => progress.push(value)
  });
  assert.equal(result.type, 'verified-extraction');
  assert.equal(result.inspectionId, fixture.inspectionId);
  assert.equal(result.destinationId, fixture.destinationId);
  assert.deepEqual(result.measured, { entryCount: 1, fileCount: 1, directoryCount: 0, expandedBytes: '3' });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(pathFree(result), true);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].archiveFamily, 'zip');
  assert.equal(fixture.calls[0].outputDirectoryId, fixture.destinationId);
  assert.deepEqual(progress.map(item => item.phase), ['preflight', 'extract', 'postwalk', 'complete']);
  assert.ok(progress.every(pathFree));
});

test('deferred archive integrity is enforced by quarantined extraction and failed output is removed', async t => {
  const fixture = await extractionFixture({
    workerAction: async () => {
      const error = new Error('corrupt compressed stream');
      error.code = 'EXTRACTOR_FAILED';
      throw error;
    }
  });
  t.after(fixture.cleanup);
  const raw = fixture.registry.records.get(fixture.inspectionId);
  raw.value.result.integrity = 'deferred-to-extraction';
  raw.value.result.engineEvidence.tested = false;

  await assert.rejects(fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId
  }), hasCode('EXTRACTOR_FAILED'));

  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].operation, 'extract');
  assert.equal(fs.existsSync(path.join(fixture.root, fixture.destinationId)), false);
});

test('extracts a ZIP whose zero-byte directory entries carry nonzero packed metadata', async t => {
  const entries = [
    { entryName: 'config', type: 'directory', size: '0', packedSize: '9', canonicalName: 'config', depth: 1 },
    { entryName: 'config/server.properties', type: 'file', size: '1', packedSize: '1', canonicalName: 'config/server.properties', depth: 2 }
  ];
  const fixture = await extractionFixture({
    entries,
    workerAction: async ({ output }) => {
      await fsp.mkdir(path.join(output, 'config'));
      await fsp.writeFile(path.join(output, 'config', 'server.properties'), 'x');
    }
  });
  t.after(fixture.cleanup);

  const result = await fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId
  });

  assert.deepEqual(result.measured, {
    entryCount: 2,
    fileCount: 1,
    directoryCount: 1,
    expandedBytes: '1'
  });
});

test('rejects stale, wrong-owner, tampered, and path-shaped inspection/output references', async t => {
  const fixture = await extractionFixture();
  t.after(fixture.cleanup);
  for (const request of [
    { inspectionId: 'inspection-missing', destinationId: fixture.destinationId },
    { inspectionId: fixture.inspectionId, destinationId: 'output-missing' },
    { inspectionId: fixture.inspectionId, destinationId: '../output' },
    { inspectionId: path.resolve(fixture.root), destinationId: fixture.destinationId }
  ]) {
    await assert.rejects(fixture.service.extractArchive(request), error =>
      error?.code === 'PLAN_STALE' || error?.code === 'INVALID_REQUEST');
  }
  assert.equal(fixture.calls.length, 0);
});

test('revalidates the inspection fingerprint, root evidence, and exact app-issued artifact identity', async t => {
  const fixture = await extractionFixture();
  t.after(fixture.cleanup);
  const raw = fixture.registry.records.get(fixture.inspectionId);
  raw.value.result.artifactSet.fingerprint = '0'.repeat(64);
  await assert.rejects(fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId
  }), hasCode('PLAN_STALE'));
  assert.equal(fixture.calls.length, 0);

  const rootFixture = await extractionFixture();
  t.after(rootFixture.cleanup);
  const rootRaw = rootFixture.registry.records.get(rootFixture.inspectionId);
  rootRaw.value.result.rootCandidates = ['wrapper'];
  rootRaw.value.result.selectedRoot = 'wrapper';
  await assert.rejects(rootFixture.service.extractArchive({
    inspectionId: rootFixture.inspectionId,
    destinationId: rootFixture.destinationId
  }), hasCode('PLAN_STALE'));
  assert.equal(rootFixture.calls.length, 0);
});

test('revalidates the full closed entry policy before extraction', async t => {
  const fixture = await extractionFixture();
  t.after(fixture.cleanup);
  const raw = fixture.registry.records.get(fixture.inspectionId);
  const oversized = (17n * 1024n * 1024n * 1024n).toString();
  raw.value.result.entries[0].size = oversized;
  raw.value.result.limitEvidence.totals.expandedBytes = oversized;
  await assert.rejects(fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId
  }), hasCode('PLAN_STALE'));
  assert.equal(fixture.calls.length, 0);
});

test('measured watchdog aborts the contained job when bytes exceed declarations and removes staging', async t => {
  const fixture = await extractionFixture({
    workerAction: async ({ output, signal }) => {
      await fsp.writeFile(path.join(output, 'server.jar'), Buffer.from('too large'));
      await new Promise((resolve, reject) => {
        const onAbort = () => { const error = new Error('cancelled'); error.code = 'CANCELLED'; reject(error); };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  });
  t.after(fixture.cleanup);
  await assert.rejects(fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId
  }), error => error?.code === 'ARCHIVE_LIMIT_EXCEEDED' || error?.code === 'EXTRACTOR_FAILED');
  assert.equal(fs.existsSync(path.join(fixture.root, fixture.destinationId)), false);
});

test('measured watchdog enforces free-space reserve during extraction', async t => {
  let probes = 0;
  const fixture = await extractionFixture({
    diskProbe: async () => ({ availableBytes: (++probes === 1 ? 100n * 1024n ** 3n : 0n).toString() }),
    workerAction: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.code = 'CANCELLED'; reject(error); }, { once: true });
    })
  });
  t.after(fixture.cleanup);
  await assert.rejects(fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId
  }), hasCode('INSUFFICIENT_DISK'));
  assert.ok(probes >= 2);
  assert.equal(fs.existsSync(path.join(fixture.root, fixture.destinationId)), false);
});

test('measured watchdog enforces elapsed deadline independent of engine switches', async t => {
  let reads = 0;
  const fixture = await extractionFixture({
    clock: () => (++reads === 1 ? 0 : ARCHIVE_LIMITS.maxExtractionMs + 1),
    workerAction: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.code = 'CANCELLED'; reject(error); }, { once: true });
    })
  });
  t.after(fixture.cleanup);
  await assert.rejects(fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId
  }), hasCode('EXTRACTOR_FAILED'));
  assert.equal(fs.existsSync(path.join(fixture.root, fixture.destinationId)), false);
});

test('caller cancellation aborts the entire contained job, closes listeners, and removes staging', async t => {
  const controller = new AbortController();
  let observedAbort = false;
  const fixture = await extractionFixture({
    workerAction: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        observedAbort = true;
        const error = new Error('cancelled'); error.code = 'CANCELLED'; reject(error);
      }, { once: true });
      controller.abort();
    })
  });
  t.after(fixture.cleanup);
  await assert.rejects(fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId,
    signal: controller.signal
  }), hasCode('CANCELLED'));
  assert.equal(observedAbort, true);
  assert.equal(fs.existsSync(path.join(fixture.root, fixture.destinationId)), false);
});

test('complete postwalk rejects reparse points, nonregular objects, escapes, and unexpected entries', async () => {
  const scenarios = [
    {
      reparseInspector: { isReparsePoint: async candidate => candidate.endsWith('server.jar') },
      workerAction: ({ output }) => defaultWorker({ output })
    },
    {
      workerAction: async ({ output }) => {
        await defaultWorker({ output });
        await fsp.writeFile(path.join(output, 'unexpected.txt'), 'x');
      }
    }
  ];
  for (const scenario of scenarios) {
    const fixture = await extractionFixture(scenario);
    try {
      await assert.rejects(fixture.service.extractArchive({
        inspectionId: fixture.inspectionId,
        destinationId: fixture.destinationId
      }), error => error?.code === 'UNSAFE_ARCHIVE_ENTRY' || error?.code === 'ARCHIVE_ENTRY_COLLISION' || error?.code === 'EXTRACTOR_FAILED');
      assert.equal(fs.existsSync(path.join(fixture.root, fixture.destinationId)), false);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('postwalk rejects declared-versus-measured size/type mismatches and missing entries', async () => {
  const scenarios = [
    async output => fsp.writeFile(path.join(output, 'server.jar'), 'wrong-size'),
    async output => fsp.mkdir(path.join(output, 'server.jar')),
    async () => {}
  ];
  for (const action of scenarios) {
    const fixture = await extractionFixture({ workerAction: ({ output }) => action(output) });
    try {
      await assert.rejects(fixture.service.extractArchive({
        inspectionId: fixture.inspectionId,
        destinationId: fixture.destinationId
      }), hasCode('EXTRACTOR_FAILED'));
      assert.equal(fs.existsSync(path.join(fixture.root, fixture.destinationId)), false);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('implicit parent directories are allowed only when they are canonical and expected by a declared file', async t => {
  const entries = [{ entryName: 'config/server.properties', type: 'file', size: '1', packedSize: '1', canonicalName: 'config/server.properties', depth: 2 }];
  const fixture = await extractionFixture({
    entries,
    workerAction: async ({ output }) => {
      await fsp.mkdir(path.join(output, 'config'));
      await fsp.writeFile(path.join(output, 'config', 'server.properties'), 'x');
    }
  });
  t.after(fixture.cleanup);
  const result = await fixture.service.extractArchive({ inspectionId: fixture.inspectionId, destinationId: fixture.destinationId });
  assert.deepEqual(result.measured, { entryCount: 2, fileCount: 1, directoryCount: 1, expandedBytes: '1' });
});

test('worker failures are stable, path-redacted, and clean staging on repeated runs', async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fixture = await extractionFixture({
      workerAction: async () => {
        const error = new Error('C:\\private\\archive.zip');
        error.code = 'EXTRACTOR_FAILED';
        throw error;
      }
    });
    try {
      await assert.rejects(fixture.service.extractArchive({
        inspectionId: fixture.inspectionId,
        destinationId: fixture.destinationId
      }), hasCode('EXTRACTOR_FAILED'));
      assert.equal(fs.existsSync(path.join(fixture.root, fixture.destinationId)), false);
    } finally {
      await fixture.cleanup();
    }
  }
});

test('a staging cleanup failure is never hidden behind the original worker failure', async t => {
  const fixture = await extractionFixture({
    workerAction: async () => { throw new Error('worker failed'); },
    removeStaging: async () => { throw new Error('C:\\private\\staging'); }
  });
  t.after(fixture.cleanup);
  await assert.rejects(fixture.service.extractArchive({
    inspectionId: fixture.inspectionId,
    destinationId: fixture.destinationId
  }), hasCode('CLEANUP_FAILED'));
});

test('standalone extractArchive rejects unconfigured opaque references without accepting a path', async () => {
  await assert.rejects(extractArchive({ inspectionId: 'inspection-x', destinationId: 'output-x' }), error =>
    error?.code === 'PLAN_STALE' || error?.code === 'INVALID_REQUEST');
});
