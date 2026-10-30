const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const yaml = require('js-yaml');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const smokeModuleUrl = pathToFileURL(path.join(repositoryRoot, 'scripts', 'run-modpack-packaged-smoke.mjs')).href;
const smokeModule = import(smokeModuleUrl).catch(error => {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('run-modpack-packaged-smoke.mjs')) return {};
  throw error;
});

const DIGESTS = Object.freeze({
  mrpack: '1'.repeat(64),
  zip: '2'.repeat(64),
  zip64: '3'.repeat(64),
  rar4: '4'.repeat(64),
  rar5: '5'.repeat(64),
  rar4Multipart: '6'.repeat(64),
  rar5Multipart: '7'.repeat(64),
  canonical: '8'.repeat(64),
  worker: '9'.repeat(64)
});

function archiveProbeEvidence() {
  return {
    extracted: [
      { archiveId: 'mrpack', archiveFamily: 'mrpack', engineFamily: 'zip', groupingScheme: 'single', layer: 'packaged-worker-extraction', sha256: DIGESTS.mrpack, outcome: 'accepted' },
      { archiveId: 'zip', archiveFamily: 'zip', engineFamily: 'zip', groupingScheme: 'single', layer: 'packaged-worker-extraction', sha256: DIGESTS.zip, outcome: 'accepted' },
      { archiveId: 'zip64', archiveFamily: 'zip64', engineFamily: 'zip', groupingScheme: 'single', layer: 'packaged-worker-extraction', sha256: DIGESTS.zip64, outcome: 'accepted' },
      { archiveId: 'rar4', archiveFamily: 'rar4', engineFamily: 'rar4', groupingScheme: 'single', layer: 'packaged-worker-extraction', sha256: DIGESTS.rar4, outcome: 'accepted' },
      { archiveId: 'rar5', archiveFamily: 'rar5', engineFamily: 'rar5', groupingScheme: 'single', layer: 'packaged-worker-extraction', sha256: DIGESTS.rar5, outcome: 'accepted' },
      { archiveId: 'rar4-part-number', archiveFamily: 'multipart-rar', engineFamily: 'rar4', groupingScheme: 'part-number', layer: 'packaged-worker-extraction', sha256: DIGESTS.rar4Multipart, outcome: 'accepted' },
      { archiveId: 'rar5-part-number', archiveFamily: 'multipart-rar', engineFamily: 'rar5', groupingScheme: 'part-number', layer: 'packaged-worker-extraction', sha256: DIGESTS.rar5Multipart, outcome: 'accepted' }
    ],
    schemes: [{ groupingScheme: 'part-number', layer: 'packaged-worker-extraction', outcome: 'accepted' }],
    rejected: [
      { caseId: 'encrypted-entry', layer: 'packaged-worker-extraction', code: 'ENCRYPTED_ARCHIVE' },
      { caseId: 'incomplete-multipart', layer: 'packaged-worker-extraction', code: 'MULTIPART_VOLUME_MISSING' },
      { caseId: 'unsafe-traversal', layer: 'packaged-worker-extraction', code: 'UNSAFE_ARCHIVE_ENTRY' }
    ]
  };
}

function driverEvidence() {
  return {
    rendererLoaded: true,
    environment: {
      appIsPackaged: true,
      productionComposition: true,
      fixtureFactoryEnabled: false,
      isolatedUserData: true,
      pathSanitized: true,
      updaterEnabled: false,
      automaticReleaseChecksEnabled: false,
      publicManagementListenersEnabled: false,
      rendererPublicNetworkRequests: 0
    },
    startupHealth: { status: 'ready', modpackServices: 'ready' },
    fallbacksUsed: []
  };
}

function deterministicEvidence() {
  return {
    layer: 'non-packaged-test-composition',
    fixtureFactoryEnabled: true,
    schemes: [
      { groupingScheme: 'rar-rxx', layer: 'deterministic-grouping-download-materialization-validation', outcome: 'accepted' },
      { groupingScheme: 'numbered-volume', layer: 'deterministic-grouping-download-materialization-validation', outcome: 'accepted' }
    ],
    rejected: [{ caseId: 'encrypted-header', layer: 'deterministic-engine-evidence', code: 'ENCRYPTED_ARCHIVE' }],
    lifecycle: {
      operations: [
        { operation: 'create', outcome: 'succeeded' },
        { operation: 'update', outcome: 'succeeded' },
        { operation: 'verify', outcome: 'succeeded' },
        { operation: 'targeted-repair', outcome: 'succeeded' },
        { operation: 'detach', outcome: 'succeeded' }
      ],
      canonicalServer: { count: 1, sha256: DIGESTS.canonical, generation: 'managed-v2' },
      history: { durable: true, operationCount: 5, ownershipTransitionsRecorded: true },
      ownership: { verified: true, detached: true, unmanagedFilesPreserved: true },
      recovery: {
        crashPoints: ['before-live-rename', 'between-renames', 'after-candidate-rename'],
        startupBlockedUntilRecovered: true,
        canonicalServerCount: 1,
        idempotent: true,
        outcome: 'recovered'
      }
    }
  };
}

function scenarioEvidence() {
  const probe = archiveProbeEvidence();
  const driver = driverEvidence();
  const deterministic = deterministicEvidence();
  return {
    environment: { ...driver.environment, fixtureRootUnchanged: true },
    startupHealth: driver.startupHealth,
    fallbacksUsed: driver.fallbacksUsed,
    archives: {
      extracted: probe.extracted,
      schemes: [...probe.schemes, ...deterministic.schemes],
      rejected: [...probe.rejected, ...deterministic.rejected]
    },
    lifecycle: {
      layer: deterministic.layer,
      fixtureFactoryEnabled: deterministic.fixtureFactoryEnabled,
      ...deterministic.lifecycle
    }
  };
}

function packagedEvidence() {
  return {
    type: 'packaged-archive-verification',
    version: 1,
    architecture: 'x64',
    runtime: { version: '26.02', handlers: { zip: true, rar: true } },
    worker: { runtimeIdentifier: 'win-x64', runtimeMode: 'in-memory-single-file', size: 67_744_371, sha256: DIGESTS.worker },
    containment: 'passed',
    fallbacksUsed: []
  };
}

test('packaged archive entrypoints load entirely from packaged production code', () => {
  const electronRoot = path.join(repositoryRoot, 'electron');
  const entryPath = path.join(electronRoot, 'services', 'modpacks', 'archive', 'archive-engine-paths.cjs');
  const probe = String.raw`
    const Module = require('node:module');
    const path = require('node:path');
    const entryPath = path.resolve(process.argv[1]);
    const electronRoot = path.resolve(process.argv[2]);
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function packagedResolve(request, parent, isMain, options) {
      const resolved = originalResolve.call(this, request, parent, isMain, options);
      if (typeof resolved === 'string' && path.isAbsolute(resolved)) {
        const relative = path.relative(electronRoot, resolved);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
          throw new Error('Production archive require escaped the packaged electron closure');
        }
      }
      return resolved;
    };
    require(entryPath);
    process.stdout.write('packaged-archive-entry-loaded');
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', probe, entryPath, electronRoot], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'packaged-archive-entry-loaded');
});

test('packaged smoke strips PATH and executable injection variables from the app environment', async () => {
  const { createSanitizedEnvironment } = await smokeModule;
  assert.equal(typeof createSanitizedEnvironment, 'function', 'packaged smoke environment builder is required');
  const userDataPath = path.join(os.tmpdir(), 'minecraft-smoke-user-data');
  const result = createSanitizedEnvironment({
    source: {
      Path: 'C:\\developer-bin',
      PATH: 'C:\\system-bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      NODE_OPTIONS: '--require C:\\untrusted.cjs',
      ELECTRON_RUN_AS_NODE: '1',
      MINECRAFT_CORE_USE_DEV_SERVER: '1',
      GH_TOKEN: 'secret'
    },
    userDataPath
  });

  assert.equal(result.Path, '');
  assert.equal(result.PATH, '');
  assert.equal(result.NODE_OPTIONS, '');
  assert.equal(result.ELECTRON_RUN_AS_NODE, '');
  assert.equal(result.MINECRAFT_CORE_USE_DEV_SERVER, '');
  assert.equal(result.GH_TOKEN, '');
  assert.equal(result.SystemRoot, 'C:\\Windows');
  assert.equal(result.TEMP, 'C:\\Temp');
  assert.equal(result.NODE_ENV, '');
  assert.equal(result.MINECRAFT_CORE_TEST_MODE, '');
  assert.equal(result.MINECRAFT_CORE_USER_DATA_DIR, userDataPath);
  assert.equal(result.MINECRAFT_CORE_TEST_MODPACK_FACTORY, '');
  assert.equal(Object.isFrozen(result), true);
});

test('packaged archive probes resolve one exact private worker-state root', async () => {
  const { resolveArchiveWorkerProbeRoot } = await smokeModule;
  assert.equal(typeof resolveArchiveWorkerProbeRoot, 'function');
  const probeRoot = path.join(
    os.tmpdir(),
    'minecraft-core-packaged-smoke-XXXXXX',
    'minecraft-core-packaged-smoke-archive-XXXXXX'
  );

  const workerRoot = resolveArchiveWorkerProbeRoot(probeRoot);
  assert.equal(path.dirname(workerRoot), path.resolve(probeRoot));
  assert.equal(path.basename(workerRoot), 'w');
});

test('packaged smoke requires closed containment, archive-layer, lifecycle, ownership, and recovery evidence', async () => {
  const { validateSmokeEvidence } = await smokeModule;
  assert.equal(typeof validateSmokeEvidence, 'function', 'packaged smoke evidence validator is required');
  const good = {
    type: 'minecraft-core-packaged-modpack-smoke',
    version: 1,
    platform: 'win32',
    architecture: 'x64',
    application: {
      version: '26.6.1',
      executableSize: 12,
      executableSha256: '7b5d2ffb87d6b7336aaea9bf55d2208f62e94588b57719ebd61188d204ba5e07',
      rendererLoaded: true
    },
    archiveWorker: {
      containment: 'passed',
      runtimeVersion: '26.02',
      runtimeMode: 'in-memory-single-file',
      handlers: { zip: true, rar: true },
      workerSize: 67_744_371,
      workerSha256: DIGESTS.worker
    },
    fallbacksUsed: [],
    ...scenarioEvidence()
  };
  delete good.environment.fallbacksUsed;
  const validated = validateSmokeEvidence(good);
  assert.deepEqual(validated, good);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.archives.extracted), true);

  for (const mutate of [
    value => { value.archiveWorker.containment = 'unavailable'; },
    value => { value.archiveWorker.runtimeMode = 'self-extracting'; },
    value => { value.fallbacksUsed.push('PATH'); },
    value => { value.archives.extracted = value.archives.extracted.filter(entry => entry.archiveId !== 'rar5-part-number'); },
    value => { value.archives.schemes.find(entry => entry.groupingScheme === 'rar-rxx').layer = 'packaged-worker-extraction'; },
    value => { value.archives.rejected = value.archives.rejected.filter(entry => entry.caseId !== 'unsafe-traversal'); },
    value => { value.lifecycle.operations = value.lifecycle.operations.filter(entry => entry.operation !== 'targeted-repair'); },
    value => { value.lifecycle.layer = 'packaged-production'; },
    value => { value.lifecycle.fixtureFactoryEnabled = false; },
    value => { value.lifecycle.recovery.canonicalServerCount = 2; },
    value => { value.environment.pathSanitized = false; },
    value => { value.environment.fixtureFactoryEnabled = true; },
    value => { value.environment.updaterEnabled = true; },
    value => { value.environment.automaticReleaseChecksEnabled = true; },
    value => { value.environment.publicManagementListenersEnabled = true; },
    value => { value.environment.rendererPublicNetworkRequests = 1; },
    value => { value.startupHealth.status = 'degraded'; },
    value => { value.startupHealth.modpackServices = 'unavailable'; },
    value => { delete value.startupHealth; },
    value => { value.privatePath = 'C:\\secret'; }
  ]) {
    const changed = structuredClone(good);
    mutate(changed);
    assert.throws(() => validateSmokeEvidence(changed), /Packaged modpack smoke evidence is incomplete/);
  }
});

test('packaged smoke combines real package verification with one isolated driver run', async (t) => {
  const { runPackagedSmoke } = await smokeModule;
  assert.equal(typeof runPackagedSmoke, 'function', 'packaged smoke runner is required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-smoke-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOutDir = path.join(root, 'win-unpacked');
  fs.mkdirSync(appOutDir);
  fs.writeFileSync(path.join(appOutDir, 'Minecraft Core.exe'), 'packaged-exe');
  let observed = null;

  const result = await runPackagedSmoke({
    repositoryRoot,
    appOutDir,
    temporaryBase: root,
    verifyPackage: async () => packagedEvidence(),
    archiveProbe: async () => archiveProbeEvidence(),
    deterministicProbe: async () => deterministicEvidence(),
    driver: async input => {
      observed = input;
      assert.equal(Object.entries(input.env).filter(([key]) => key.toUpperCase() === 'PATH').every(([, value]) => value === ''), true);
      assert.equal(path.isAbsolute(input.userDataPath), true);
      assert.equal(input.executablePath, path.join(appOutDir, 'Minecraft Core.exe'));
      assert.equal(input.fixtureRoot, path.join(repositoryRoot, 'tests', 'fixtures', 'archives'));
      return driverEvidence();
    }
  });

  assert.ok(observed);
  assert.equal(result.application.executableSize, 12);
  assert.equal(result.application.executableSha256, '7b5d2ffb87d6b7336aaea9bf55d2208f62e94588b57719ebd61188d204ba5e07');
  assert.equal(result.archiveWorker.containment, 'passed');
  assert.equal(result.archiveWorker.runtimeMode, 'in-memory-single-file');
  assert.deepEqual(result.startupHealth, { status: 'ready', modpackServices: 'ready' });
  assert.equal(result.fallbacksUsed.length, 0);
  assert.equal(fs.existsSync(observed.userDataPath), false, 'isolated userData must be removed after the smoke');
});

test('packaged smoke fails a packaged start that did not report ready modpack services', async (t) => {
  const { runPackagedSmoke } = await smokeModule;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-smoke-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOutDir = path.join(root, 'win-unpacked');
  fs.mkdirSync(appOutDir);
  fs.writeFileSync(path.join(appOutDir, 'Minecraft Core.exe'), 'packaged-exe');

  // A degraded start still opens the main window and loads the renderer.
  for (const startupHealth of [
    undefined,
    { status: 'degraded', modpackServices: 'unavailable' },
    { status: 'ready', modpackServices: 'unavailable' },
    { status: 'starting', modpackServices: 'pending' },
    { status: null, modpackServices: null }
  ]) {
    await assert.rejects(runPackagedSmoke({
      repositoryRoot,
      appOutDir,
      temporaryBase: root,
      verifyPackage: async () => packagedEvidence(),
      archiveProbe: async () => archiveProbeEvidence(),
      deterministicProbe: async () => deterministicEvidence(),
      driver: async () => {
        const evidence = driverEvidence();
        if (startupHealth === undefined) delete evidence.startupHealth;
        else evidence.startupHealth = startupHealth;
        return evidence;
      }
    }), /Packaged modpack smoke evidence is incomplete/u, JSON.stringify(startupHealth ?? 'missing'));
  }
});

// The packaged driver reads the health in the renderer, like the startup banner.
function rendererPage(answer) {
  const page = {
    reads: [],
    async evaluate(readInRenderer, ...args) {
      const priorWindow = globalThis.window;
      globalThis.window = { electron: { async invoke(...request) { page.reads.push(request); return answer(); } } };
      try {
        return await readInRenderer(...args);
      } finally {
        if (priorWindow === undefined) delete globalThis.window;
        else globalThis.window = priorWindow;
      }
    }
  };
  return page;
}

test('the packaged smoke driver waits out a settling start before it reports the startup health', async () => {
  const { readPackagedStartupHealth } = require('../e2e/fixtures/modpack-harness.cjs');
  assert.equal(typeof readPackagedStartupHealth, 'function', 'the packaged driver reads the startup health');
  const answers = [
    { status: 'starting', modpackServices: 'pending' },
    { status: 'starting', modpackServices: 'pending' },
    { status: 'ready', modpackServices: 'ready', legacyFallbacks: 'off', failure: null, recoveryGate: null, issues: [] }
  ];
  const settling = rendererPage(() => answers.shift());
  assert.deepEqual(
    await readPackagedStartupHealth(settling, { deadlineMs: Date.now() + 10_000, pollMs: 1 }),
    { status: 'ready', modpackServices: 'ready' }
  );
  assert.deepEqual(settling.reads, [['startup:get-health'], ['startup:get-health'], ['startup:get-health']]);

  // A degraded start is final; it is reported at once for the smoke to refuse.
  const degraded = rendererPage(() => ({ status: 'degraded', modpackServices: 'unavailable' }));
  assert.deepEqual(
    await readPackagedStartupHealth(degraded, { deadlineMs: Date.now() + 10_000, pollMs: 1 }),
    { status: 'degraded', modpackServices: 'unavailable' }
  );
  assert.equal(degraded.reads.length, 1);

  // At the startup deadline the last answer is reported, and the smoke refuses it.
  const stuck = rendererPage(() => ({ status: 'starting', modpackServices: 'pending' }));
  assert.deepEqual(
    await readPackagedStartupHealth(stuck, { deadlineMs: Date.now() + 30, pollMs: 5 }),
    { status: 'starting', modpackServices: 'pending' }
  );
  assert.ok(stuck.reads.length >= 2);

  for (const answer of [null, undefined, 'ready', { success: false, error: 'Channel not allowed' }]) {
    assert.deepEqual(
      await readPackagedStartupHealth(rendererPage(() => answer), { deadlineMs: Date.now() + 10_000, pollMs: 1 }),
      { status: null, modpackServices: null },
      JSON.stringify(answer ?? 'missing')
    );
  }
});

test('packaged smoke serializes heavyweight probes before launching the packaged application', async (t) => {
  const { runPackagedSmoke } = await smokeModule;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-smoke-serial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOutDir = path.join(root, 'win-unpacked');
  fs.mkdirSync(appOutDir);
  fs.writeFileSync(path.join(appOutDir, 'Minecraft Core.exe'), 'packaged-exe');
  const order = [];
  let archiveCompleted = false;

  await runPackagedSmoke({
    repositoryRoot,
    appOutDir,
    temporaryBase: root,
    verifyPackage: async () => packagedEvidence(),
    archiveProbe: async () => {
      order.push('archive-start');
      await new Promise(resolve => setTimeout(resolve, 25));
      archiveCompleted = true;
      order.push('archive-end');
      return archiveProbeEvidence();
    },
    deterministicProbe: async () => {
      assert.equal(archiveCompleted, true, 'native extraction and Electron lifecycle probes must not compete for memory');
      order.push('lifecycle');
      return deterministicEvidence();
    },
    driver: async () => {
      order.push('packaged-app');
      return driverEvidence();
    }
  });

  assert.deepEqual(order, ['archive-start', 'archive-end', 'lifecycle', 'packaged-app']);
});

test('packaged smoke preserves its isolated root when Electron process-tree exit cannot be proven', async (t) => {
  const { runPackagedSmoke } = await smokeModule;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-smoke-preservation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOutDir = path.join(root, 'win-unpacked');
  fs.mkdirSync(appOutDir);
  fs.writeFileSync(path.join(appOutDir, 'Minecraft Core.exe'), 'packaged-exe');
  let isolatedRoot = null;

  await assert.rejects(runPackagedSmoke({
    repositoryRoot,
    appOutDir,
    temporaryBase: root,
    verifyPackage: async () => packagedEvidence(),
    archiveProbe: async () => archiveProbeEvidence(),
    deterministicProbe: async () => deterministicEvidence(),
    driver: async ({ userDataPath }) => {
      isolatedRoot = path.dirname(userDataPath);
      fs.writeFileSync(path.join(userDataPath, 'cleanup-evidence.txt'), 'preserve me');
      const error = new Error('injected unproven process-tree exit');
      error.code = 'PACKAGED_STARTUP_FAILED';
      error.preservePackagedSmokeRoot = true;
      throw error;
    }
  }), /Packaged modpack smoke evidence is incomplete/u);

  assert.ok(isolatedRoot);
  assert.equal(fs.existsSync(isolatedRoot), true, 'the isolated smoke root must remain for diagnosis');
  assert.equal(
    fs.readFileSync(path.join(isolatedRoot, 'user-data', 'cleanup-evidence.txt'), 'utf8'),
    'preserve me'
  );
});

test('packaged smoke waits for every shared-root probe before failure cleanup', async (t) => {
  const { runPackagedSmoke } = await smokeModule;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-smoke-settlement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOutDir = path.join(root, 'win-unpacked');
  fs.mkdirSync(appOutDir);
  fs.writeFileSync(path.join(appOutDir, 'Minecraft Core.exe'), 'packaged-exe');
  let archiveRootExistedAtSettlement = false;
  let archiveFinished;
  const archiveSettled = new Promise(resolve => { archiveFinished = resolve; });

  await assert.rejects(runPackagedSmoke({
    repositoryRoot,
    appOutDir,
    temporaryBase: root,
    verifyPackage: async () => packagedEvidence(),
    archiveProbe: async ({ temporaryBase }) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      archiveRootExistedAtSettlement = fs.existsSync(temporaryBase);
      archiveFinished();
      return archiveProbeEvidence();
    },
    deterministicProbe: async () => { throw new Error('injected deterministic probe failure'); },
    driver: async () => { throw new Error('driver must not run after a probe failure'); }
  }), /Packaged modpack smoke evidence is incomplete/u);
  await archiveSettled;

  assert.equal(archiveRootExistedAtSettlement, true);
});

const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'release.yml');
const VERSION = '${{ needs.check-version.outputs.version }}';
const RELEASE_FILES = Object.freeze([
  `dist/Minecraft-Core-Setup-${VERSION}.exe`,
  `dist/Minecraft-Core-Setup-${VERSION}.exe.blockmap`,
  'dist/latest.yml'
]);
const CREDENTIAL_REFERENCE = /secrets\.|github\.token/u;
const PUBLISH_CONDITION = "needs.check-version.outputs.publish == 'true' && github.ref == 'refs/heads/main' && " +
  "!(github.event_name == 'workflow_dispatch' && inputs.dry_run)";

function loadWorkflow() {
  return yaml.load(fs.readFileSync(workflowPath, 'utf8'));
}

function loadPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
}

function commandLine(step, command) {
  return String(step.run || '').split(/\r?\n/u).some(line => line.trim() === command);
}

function lines(value) {
  return String(value || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
}

function credentialFree(step) {
  return !CREDENTIAL_REFERENCE.test(JSON.stringify(step)) &&
    !Object.keys(step.env || {}).some(key => /(?:TOKEN|SECRET|PASSWORD)/iu.test(key));
}

function checkoutWithoutCredentials(step) {
  return step.uses === 'actions/checkout@v4' && step.with?.['persist-credentials'] === false;
}

function pinnedNode(step) {
  return step.uses === 'actions/setup-node@v4' && String(step.with?.['node-version']) === '24.19.0';
}

function assertOrdered(steps, predicates, label) {
  let prior = -1;
  for (const [index, predicate] of predicates.entries()) {
    const found = steps.findIndex((step, current) => current > prior && predicate(step));
    assert.notEqual(found, -1, `${label}: missing required step #${index} after step ${prior}`);
    assert.equal(steps[found].if, undefined, `${label}: gated steps must be unconditional`);
    assert.notEqual(steps[found]['continue-on-error'], true, `${label}: gated steps must not be softened`);
    prior = found;
  }
  return prior;
}

test('release browser gates discover launch reconciliation before packaging', () => {
  const workflow = loadWorkflow();
  const steps = workflow.jobs.build.steps;
  const packagingIndex = steps.findIndex(step => String(step.run || '').trim() === 'npm run pack');
  assert.ok(packagingIndex >= 0, 'the release must have a packaging boundary');
  const scriptNames = steps.slice(0, packagingIndex)
    .filter(step => step.if === undefined && step['continue-on-error'] !== true)
    .flatMap(step => String(step.run || '').split(/\r?\n/u)
      .map(line => /^npm run (test:e2e:[a-z0-9:-]+)$/u.exec(line.trim())?.[1])
      .filter(Boolean));
  const discovered = new Set();
  for (const scriptName of scriptNames) {
    const args = ['--silent', 'run', scriptName, '--', '--list', '--reporter=json'];
    const result = childProcess.spawnSync(
      process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm',
      process.platform === 'win32' ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] : args,
      { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
    );
    assert.equal(result.status, 0, `${scriptName}: ${result.error || result.stderr || result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.errors, [], `${scriptName} must discover without errors`);
    const collect = suite => {
      for (const spec of suite.specs || []) discovered.add(`${spec.file}:${spec.title}`);
      for (const child of suite.suites || []) collect(child);
    };
    for (const suite of report.suites) collect(suite);
  }
  for (const title of [
    'transport Start reconciles captured credentials without another Start or release',
    'Back from unknown Start permits explicit exact discovery, never another destination',
    'destination-recovery action rehydrates the exact captured outcome before guarded release',
    'R1 management uninstall accepts only canonical public kind, returned uninstall-managed'
  ]) {
    assert.ok(discovered.has(`modpack-launch-reconciliation.spec.js:${title}`),
      `mandatory pre-packaging gates must discover: ${title}`);
  }
});

test('release dry runs are a default-on dispatch input and one plan decides whether to build and publish', () => {
  const workflow = loadWorkflow();
  assert.deepEqual(workflow.on.push, { branches: ['main'], paths: ['package.json', '.github/workflows/release.yml'] });
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['dry_run']);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.type, 'boolean');
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false);
  assert.match(String(workflow.concurrency?.group), /minecraft-core-release/u);
  assert.deepEqual(Object.keys(workflow.jobs), ['check-version', 'build', 'stage', 'publish']);

  const check = workflow.jobs['check-version'];
  assert.equal(check.permissions, undefined, 'check-version keeps the read-only workflow permissions');
  assert.equal(check.if, undefined);
  assert.deepEqual(check.outputs, {
    version: '${{ steps.plan.outputs.version }}',
    build: '${{ steps.plan.outputs.build }}',
    publish: '${{ steps.plan.outputs.publish }}'
  });
  assert.equal(check.steps.every(credentialFree), true);
  const planIndex = assertOrdered(check.steps, [
    checkoutWithoutCredentials,
    pinnedNode,
    step => step.id === 'plan' && commandLine(step, 'node scripts/release-plan.cjs plan')
  ], 'check-version');
  assert.deepEqual(check.steps[planIndex].env, { DRY_RUN: "${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}" });
});

test('the build job runs every gate in order, read-only and without credentials, and keeps exactly the release files', () => {
  const build = loadWorkflow().jobs.build;
  assert.equal(build.needs, 'check-version');
  assert.equal(build.if, "needs.check-version.outputs.build == 'true'");
  assert.deepEqual(build.permissions, { contents: 'read' });
  assert.equal(build['runs-on'], 'windows-latest');
  assert.equal(build['timeout-minutes'], 180);
  for (const step of build.steps) {
    assert.equal(credentialFree(step), true, `${step.name || step.uses} must not see credentials`);
    assert.doesNotMatch(String(step.run || ''), /build-archive-worker\.ps1|dotnet\s+publish/u,
      'CI ships the committed, natively tested worker instead of rebuilding it');
  }
  const testStep = command => step => commandLine(step, command) && Number.isInteger(step['timeout-minutes']) &&
    step['timeout-minutes'] > 0 && step['timeout-minutes'] < build['timeout-minutes'];
  const last = assertOrdered(build.steps, [
    checkoutWithoutCredentials,
    step => pinnedNode(step) && step.with?.cache === 'npm',
    step => /realpathSync\.native\(process\.env\.TEMP\)/u.test(String(step.run)) && /Contains\('~'\)/u.test(String(step.run)) &&
      /"TEMP=\$long"/u.test(String(step.run)) && /"TMP=\$long"/u.test(String(step.run)) && /GITHUB_ENV/u.test(String(step.run)),
    step => commandLine(step, 'npm install -g npm@12.0.2') && /npm --version/u.test(String(step.run)) && /'12\.0\.2'/u.test(String(step.run)),
    step => step.uses === 'actions/setup-dotnet@v4' && lines(step.with?.['dotnet-version']).join(',') === '8.0.x,10.0.204',
    step => step.name === 'Require Windows x64 host' && /OSArchitecture/u.test(String(step.run)) && /X64/u.test(String(step.run)),
    step => commandLine(step, 'npm ci'),
    step => step.name === 'Verify or acquire pinned 7-Zip runtime' && /acquire-7zip\.ps1/u.test(String(step.run)) &&
      commandLine(step, 'npm run verify:archive-runtime'),
    step => commandLine(step, 'npm run verify:archive-worker'),
    step => commandLine(step, 'dotnet build native/ArchiveWorker.RecoveryTests/ArchiveWorker.RecoveryTests.csproj --configuration Release --nologo'),
    testStep('npm test'),
    testStep('npm run test:modpacks'),
    testStep('npm run test:failure-matrix'),
    step => commandLine(step, 'npm run build'),
    step => commandLine(step, 'npm run test:e2e:modpacks'),
    step => commandLine(step, 'node node_modules/playwright/cli.js install chromium'),
    step => commandLine(step, 'npm run test:e2e:modpack-launch-reconciliation'),
    step => commandLine(step, 'npm run pack'),
    step => commandLine(step, 'npm run verify:packaged-archive'),
    step => commandLine(step, 'npm run smoke:packaged:modpacks'),
    step => commandLine(step, 'npm run dist'),
    step => commandLine(step, 'node scripts/verify-release-artifacts.cjs --app-update dist/win-unpacked'),
    step => step.name === 'Re-verify final installer payload' && commandLine(step, 'npm run verify:packaged-archive'),
    step => step.name === 'Re-smoke final installer payload' && commandLine(step, 'npm run smoke:packaged:modpacks'),
    step => commandLine(step, `node scripts/verify-release-artifacts.cjs dist ${VERSION}`),
    step => step.uses === 'actions/upload-artifact@v7'
  ], 'build');
  assert.equal(last, build.steps.length - 1, 'keeping the verified files is the last build step');
  const upload = build.steps[last];
  assert.deepEqual(lines(upload.with.path), RELEASE_FILES);
  assert.deepEqual({ ...upload.with, path: undefined }, {
    name: `release-files-v${VERSION}`,
    path: undefined,
    'if-no-files-found': 'error',
    'retention-days': 7,
    'compression-level': 0,
    overwrite: true
  });
  const packageJson = loadPackageJson();
  assert.equal(packageJson.packageManager, 'npm@12.0.2', 'CI installs the npm that wrote package-lock.json');
});

test('the stage job re-verifies the kept release files in dry runs too, without credentials', () => {
  const stage = loadWorkflow().jobs.stage;
  assert.deepEqual(stage.needs, ['check-version', 'build']);
  assert.equal(stage.if, undefined, 'staging is not skipped by dry runs');
  assert.deepEqual(stage.permissions, { contents: 'read' });
  assert.equal(stage['runs-on'], 'ubuntu-latest');
  assert.equal(stage.steps.every(credentialFree), true);
  const last = assertOrdered(stage.steps, [
    checkoutWithoutCredentials,
    pinnedNode,
    step => step.uses === 'actions/download-artifact@v8' && step.with?.name === `release-files-v${VERSION}` && step.with?.path === 'dist',
    step => commandLine(step, `node scripts/verify-release-artifacts.cjs dist ${VERSION}`)
  ], 'stage');
  assert.equal(last, stage.steps.length - 1);
});

test('only an untagged main release reaches the credentialed publish job, which publishes a verified draft', () => {
  const publish = loadWorkflow().jobs.publish;
  assert.deepEqual(publish.needs, ['check-version', 'build', 'stage']);
  assert.equal(publish.if, PUBLISH_CONDITION);
  assert.deepEqual(publish.permissions, { contents: 'write' });
  assert.equal(publish['runs-on'], 'ubuntu-latest');
  for (const step of publish.steps) {
    assert.doesNotMatch(String(step.run || ''), /\bnpm\b|\bnpx\b/u, 'the publish job never runs project dependencies');
  }
  assert.deepEqual(publish.steps.filter(step => !credentialFree(step)).map(step => step.name), [
    'Discard unpublished drafts from an earlier attempt',
    'Create the draft release',
    'Verify the draft and publish it'
  ]);
  const last = assertOrdered(publish.steps, [
    checkoutWithoutCredentials,
    pinnedNode,
    step => step.uses === 'actions/download-artifact@v8' && step.with?.name === `release-files-v${VERSION}` && step.with?.path === 'dist',
    step => commandLine(step, `node scripts/verify-release-artifacts.cjs dist ${VERSION}`) && credentialFree(step),
    step => commandLine(step, 'node scripts/release-plan.cjs discard-stale-drafts'),
    step => step.uses === 'softprops/action-gh-release@v3' && step.id === 'draft',
    step => commandLine(step, 'node scripts/release-plan.cjs verify-and-publish'),
    step => commandLine(step, 'node scripts/release-plan.cjs confirm-feed') && step.env === undefined
  ], 'publish');
  assert.equal(last, publish.steps.length - 1);

  const discard = publish.steps.find(step => commandLine(step, 'node scripts/release-plan.cjs discard-stale-drafts'));
  assert.deepEqual(discard.env, { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' });
  const verify = publish.steps.find(step => commandLine(step, 'node scripts/release-plan.cjs verify-and-publish'));
  assert.deepEqual(verify.env, { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}', RELEASE_ID: '${{ steps.draft.outputs.id }}' });

  const release = publish.steps.find(step => step.uses === 'softprops/action-gh-release@v3');
  assert.equal(release.with.draft, true, 'the release stays a draft until its uploaded bytes are proven');
  assert.equal(release.with.prerelease, false);
  assert.equal(release.with.make_latest, undefined, 'only the verified publication marks the release latest');
  assert.equal(release.with.overwrite_files, false);
  assert.equal(release.with.fail_on_unmatched_files, true);
  assert.equal(release.with.target_commitish, '${{ github.sha }}');
  assert.equal(release.with.tag_name, `v${VERSION}`);
  assert.equal(release.with.token, '${{ secrets.GITHUB_TOKEN }}');
  assert.equal(release.env, undefined);
  assert.deepEqual(lines(release.with.files), RELEASE_FILES);
});

test('no job can soften or skip a release gate', () => {
  const workflow = loadWorkflow();
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.notEqual(job['continue-on-error'], true, name);
    for (const step of job.steps) {
      assert.equal(step.if, undefined, `${name}: ${step.name || step.uses} must not be conditional`);
      assert.notEqual(step['continue-on-error'], true, `${name}: ${step.name || step.uses}`);
      assert.doesNotMatch(String(step.run || ''), /\|\||\bexit\s+0\b/iu, `${name}: ${step.name || step.uses} must not swallow a failure`);
      assert.doesNotMatch(String(step.run || ''), /--test-timeout/u);
    }
  }
  assert.equal(workflow.jobs['check-version'].if, undefined);
  assert.equal(workflow.jobs.stage.if, undefined);
  assert.equal(workflow.jobs.publish.if, PUBLISH_CONDITION, 'the publication condition is the only new condition');
});

test('electron-builder scripts never publish implicitly and the release scripts stay exact', () => {
  const { scripts } = loadPackageJson();
  const builderScripts = Object.entries(scripts).filter(([, command]) => /\belectron-builder\b/u.test(command));
  assert.deepEqual(builderScripts.map(([name]) => name).sort(), ['dist', 'pack', 'release']);
  for (const [name, command] of builderScripts) {
    assert.match(command, /\belectron-builder\b[^&|;]*\s--publish(?:=|\s)(?:never|always)$/u, `${name} must pass an explicit publish flag`);
  }
  assert.match(scripts.pack, / && electron-builder --dir --publish never$/u);
  assert.match(scripts.dist, / && electron-builder --publish never$/u);
  assert.match(scripts.release, / && electron-builder --publish=always$/u);
  assert.equal(scripts['verify:archive-worker'], 'node scripts/verify-packaged-archive.cjs --source-identity');
  assert.equal(scripts['verify:packaged-archive'], 'node scripts/verify-packaged-archive.cjs');
  assert.equal(scripts['smoke:packaged:modpacks'], 'node scripts/run-modpack-packaged-smoke.mjs');
  for (const name of ['test', 'test:modpacks', 'test:failure-matrix']) {
    assert.doesNotMatch(scripts[name], /--test-timeout/u, `${name} must not impose a global per-test timeout`);
  }
});
