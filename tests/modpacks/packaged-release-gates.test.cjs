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
      publicNetworkRequests: 0
    },
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
    worker: { runtimeIdentifier: 'win-x64', size: 67_744_371, sha256: DIGESTS.worker },
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

test('packaged archive probes keep the private .NET bundle extraction path below MAX_PATH', async () => {
  const { resolveArchiveWorkerProbeRoot } = await smokeModule;
  assert.equal(typeof resolveArchiveWorkerProbeRoot, 'function');
  const probeRoot = path.join(
    os.tmpdir(),
    'minecraft-core-packaged-smoke-XXXXXX',
    'minecraft-core-packaged-smoke-archive-XXXXXX'
  );

  const workerRoot = resolveArchiveWorkerProbeRoot(probeRoot);
  const longestBundledRuntimePath = path.join(
    workerRoot,
    'broker-bundles',
    'bundle-XXXXXX',
    'ArchiveWorker',
    'fffff',
    'System.Runtime.InteropServices.RuntimeInformation.dll'
  );

  assert.equal(path.dirname(workerRoot), path.resolve(probeRoot));
  assert.ok(longestBundledRuntimePath.length <= 259, `${longestBundledRuntimePath.length} exceeds MAX_PATH`);
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
  assert.equal(result.fallbacksUsed.length, 0);
  assert.equal(fs.existsSync(observed.userDataPath), false, 'isolated userData must be removed after the smoke');
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

test('release workflow makes every Windows x64 modpack gate mandatory and ordered before installer publication', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false);
  assert.match(String(workflow.concurrency?.group), /minecraft-core-release/u);
  const checkJob = workflow?.jobs?.['check-version'];
  const versionCheck = checkJob?.steps?.find(step => step.id === 'check');
  assert.match(String(versionCheck?.run), /GITHUB_REF/u);
  assert.match(String(versionCheck?.run), /refs\/heads\/main/u);
  assert.match(String(versionCheck?.run), /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
  assert.match(String(versionCheck?.run), /tag v\$CURRENT_VERSION already exists/u);
  assert.match(String(versionCheck?.run), /TAG_QUERY_STATUS=\$\?/u);
  assert.match(String(versionCheck?.run), /TAG_QUERY_STATUS" -ne 2/u);
  assert.doesNotMatch(String(versionCheck?.run), /Manual trigger - building/u);
  const job = workflow?.jobs?.['build-and-release'];
  assert.equal(job?.['runs-on'], 'windows-latest');
  assert.equal(job?.['timeout-minutes'], 120);
  assert.deepEqual(job?.permissions, { contents: 'write' });
  const steps = job.steps;
  assert.ok(Array.isArray(steps));

  const checkout = steps.find(step => step.uses === 'actions/checkout@v4');
  assert.equal(checkout?.with?.['persist-credentials'], false);

  const commandLine = (step, command) => String(step.run || '').split(/\r?\n/u).some(line => line.trim() === command);
  const required = [
    step => step.uses === 'actions/setup-dotnet@v4' && String(step.with?.['dotnet-version']) === '10.0.204',
    step => step.name === 'Require Windows x64 host' && /OSArchitecture/u.test(String(step.run)) && /X64/u.test(String(step.run)),
    step => commandLine(step, 'npm ci'),
    step => step.name === 'Verify or acquire pinned 7-Zip runtime' && /acquire-7zip\.ps1/u.test(String(step.run)) && commandLine(step, 'npm run verify:archive-runtime'),
    step => /build-archive-worker\.ps1/u.test(String(step.run)),
    step => commandLine(step, 'npm test'),
    step => commandLine(step, 'npm run test:modpacks'),
    step => commandLine(step, 'npm run test:failure-matrix'),
    step => commandLine(step, 'npm run build'),
    step => commandLine(step, 'npm run test:e2e:modpacks'),
    step => commandLine(step, 'npm run pack'),
    step => commandLine(step, 'npm run verify:packaged-archive'),
    step => commandLine(step, 'npm run smoke:packaged:modpacks'),
    step => commandLine(step, 'npm run dist'),
    step => step.name === 'Re-verify final installer payload' && commandLine(step, 'npm run verify:packaged-archive'),
    step => step.name === 'Re-smoke final installer payload' && commandLine(step, 'npm run smoke:packaged:modpacks'),
    step => step.name === 'Verify exact release artifacts' && /Minecraft-Core-Setup-/u.test(String(step.run)) &&
      /SHA512/u.test(String(step.run)) && /latest\.yml/u.test(String(step.run)),
    step => step.uses === 'softprops/action-gh-release@v3'
  ];

  let prior = -1;
  for (const predicate of required) {
    const index = steps.findIndex((step, current) => current > prior && predicate(step));
    assert.notEqual(index, -1, `missing required release gate after step ${prior}`);
    assert.notEqual(steps[index]['continue-on-error'], true);
    assert.equal(steps[index].if, undefined);
    prior = index;
  }
  assert.equal(steps.some(step => step['continue-on-error'] === true), false);
  assert.equal(steps.some(step => /\|\|\s*(?:true|exit\s+0)/iu.test(String(step.run || ''))), false);

  const releaseIndex = steps.findIndex(step => step.uses === 'softprops/action-gh-release@v3');
  assert.ok(releaseIndex > 0);
  for (const step of steps.slice(0, releaseIndex)) {
    assert.equal(Object.keys(step.env || {}).some(key => /(?:TOKEN|SECRET|PASSWORD)/iu.test(key)), false,
      `${step.name || step.uses} exposes release credentials before publication`);
  }
  const release = steps[releaseIndex];
  assert.equal(release.with?.['fail_on_unmatched_files'], true);
  assert.equal(release.with?.['overwrite_files'], false);
  assert.equal(release.with?.['target_commitish'], '${{ github.sha }}');
  assert.equal(release.with?.token, '${{ secrets.GITHUB_TOKEN }}');
  assert.equal(release.env, undefined);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['smoke:packaged:modpacks'], 'node scripts/run-modpack-packaged-smoke.mjs');
});
