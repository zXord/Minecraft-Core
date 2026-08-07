const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const FACTORY_MODULE = path.resolve(__filename);
const FIXED_TIME = '2026-08-01T12:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);
const SERVER_ID = 'server-e2e';
const RUNTIME = Object.freeze({
  minecraftVersion: '1.21.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.10',
  javaMajor: 21,
  os: 'win32',
  architecture: 'x64'
});

const PACKAGED_ENVIRONMENT_ALLOWLIST = Object.freeze(new Map([
  ['SYSTEMROOT', 'SystemRoot'],
  ['WINDIR', 'WINDIR'],
  ['TEMP', 'TEMP'],
  ['TMP', 'TMP'],
  ['LOCALAPPDATA', 'LOCALAPPDATA'],
  ['APPDATA', 'APPDATA'],
  ['USERPROFILE', 'USERPROFILE'],
  ['HOMEDRIVE', 'HOMEDRIVE'],
  ['HOMEPATH', 'HOMEPATH'],
  ['COMSPEC', 'COMSPEC'],
  ['PATHEXT', 'PATHEXT'],
  ['OS', 'OS'],
  ['PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITECTURE'],
  ['PROCESSOR_IDENTIFIER', 'PROCESSOR_IDENTIFIER'],
  ['PROCESSOR_LEVEL', 'PROCESSOR_LEVEL'],
  ['PROCESSOR_REVISION', 'PROCESSOR_REVISION'],
  ['NUMBER_OF_PROCESSORS', 'NUMBER_OF_PROCESSORS'],
  ['USERNAME', 'USERNAME'],
  ['USERDOMAIN', 'USERDOMAIN'],
  ['SESSIONNAME', 'SESSIONNAME'],
  ['LANG', 'LANG'],
  ['TZ', 'TZ'],
  ['MINECRAFT_CORE_USER_DATA_DIR', 'MINECRAFT_CORE_USER_DATA_DIR']
]));

// Windows command shells reconstruct PATH from the host when it is absent.
// An explicit empty value removes that fallback without setting Electron's
// presence-sensitive injection variables in the packaged process.
const PACKAGED_ENVIRONMENT_TOMBSTONES = Object.freeze(['PATH']);

function createExclusivePackagedEnvironment(source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('Packaged Electron environment source must be an object');
  }
  const normalized = new Map();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') normalized.set(key.toUpperCase(), value);
  }
  const result = {};
  for (const [lookup, canonical] of PACKAGED_ENVIRONMENT_ALLOWLIST) {
    if (normalized.has(lookup)) result[canonical] = normalized.get(lookup);
  }
  for (const key of PACKAGED_ENVIRONMENT_TOMBSTONES) result[key] = '';
  return Object.freeze(result);
}

function snapshotReadOnlyFixture(root) {
  if (root === null || root === undefined) return null;
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('Packaged fixtureRoot must be an absolute read-only directory');
  }
  const resolved = path.resolve(root);
  if (!fs.statSync(resolved).isDirectory()) throw new TypeError('Packaged fixtureRoot must be a directory');
  const records = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(resolved, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (entry.isDirectory()) {
        records.push(`d:${relative}`);
        visit(absolute);
      } else if (entry.isFile()) {
        records.push(`f:${relative}:${stat.size}:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`);
      } else if (entry.isSymbolicLink()) {
        records.push(`l:${relative}:${fs.readlinkSync(absolute)}`);
      } else {
        records.push(`o:${relative}:${stat.mode}`);
      }
    }
  };
  visit(resolved);
  return crypto.createHash('sha256').update(records.join('\n')).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.temporary`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function ensureServerTree(serverRoot, generation = 'managed-v1') {
  fs.mkdirSync(path.join(serverRoot, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(serverRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(serverRoot, 'world'), { recursive: true });
  fs.writeFileSync(path.join(serverRoot, 'server.jar'), `${generation}\n`);
  fs.writeFileSync(path.join(serverRoot, 'mods', 'managed.jar'), `managed:${generation}\n`);
  if (!fs.existsSync(path.join(serverRoot, 'mods', 'user-added.jar'))) {
    fs.writeFileSync(path.join(serverRoot, 'mods', 'user-added.jar'), 'user-added\n');
  }
  if (!fs.existsSync(path.join(serverRoot, 'config', 'user.cfg'))) {
    fs.writeFileSync(path.join(serverRoot, 'config', 'user.cfg'), 'user-config=true\n');
  }
  if (!fs.existsSync(path.join(serverRoot, 'world', 'level.dat'))) {
    fs.writeFileSync(path.join(serverRoot, 'world', 'level.dat'), 'protected-world\n');
  }
  fs.writeFileSync(path.join(serverRoot, 'server.properties'), 'server-port=25565\nmotd=E2E Fixture\n');
  fs.writeFileSync(path.join(serverRoot, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(serverRoot, '.minecraft-core.json'), JSON.stringify({
    version: 1,
    contentRevision: 1,
    minecraftVersion: '1.21.1',
    serverType: 'fabric',
    loaderVersion: '0.16.10',
    javaMajor: 21,
    port: 25565,
    maxRam: 4096,
    autoRestart: { enabled: false }
  }, null, 2));
}

function managedState() {
  return {
    schemaVersion: 1,
    modpackManaged: true,
    lifecycleMode: 'managed',
    source: {
      provider: 'modrinth',
      projectId: 'fixture-pack',
      versionId: 'version-current',
      version: '1.0.0',
      title: 'Fixture Factory Pack'
    },
    runtime: clone(RUNTIME),
    installedAt: FIXED_TIME,
    contentRevision: 1,
    managedFileCount: 2
  };
}

function initialHistory() {
  return [{
    schemaVersion: 1,
    operationId: 'operation-initial-install',
    sequence: 1,
    kind: 'install-existing',
    outcome: 'completed',
    timestamp: FIXED_TIME,
    sourceRevision: 0,
    targetRevision: 1,
    restorePointId: 'restore-point-v1'
  }];
}

function initialNotifications() {
  return [{
    notificationId: 'notification-update-1',
    serverId: SERVER_ID,
    title: 'Exact modpack update available',
    message: 'Fixture Factory Pack 2.0.0 is ready for reviewed installation.',
    timestamp: FIXED_TIME,
    read: false,
    source: { provider: 'modrinth' },
    release: { version: '2.0.0' },
    action: { actionId: 'open-details', opaqueRef: 'action-reference-1' }
  }];
}

function makeScenario({ profile, root, crashPoint = null, userDataOverride = null }) {
  const userData = userDataOverride ? path.resolve(userDataOverride) : path.join(root, 'user-data');
  const serverRoot = path.join(root, 'servers', 'fixture-server');
  const scenarioFile = path.join(root, 'scenario.json');
  const hasServer = profile !== 'empty';
  if (hasServer) ensureServerTree(serverRoot);
  else fs.mkdirSync(serverRoot, { recursive: true });
  const instances = hasServer ? [{
    id: SERVER_ID,
    name: 'E2E Fixture Server',
    type: 'server',
    path: serverRoot,
    autoStart: false
  }] : [];
  writeJson(path.join(userData, 'config', 'minecraft-core-config.json'), {
    instances,
    ...(hasServer ? { lastServerPath: serverRoot } : {})
  });

  const managedProfile = ['managed', 'recovery', 'packaged-smoke'].includes(profile);
  const state = managedProfile ? managedState() : {
    schemaVersion: 1,
    modpackManaged: false,
    lifecycleMode: 'unmanaged',
    source: null,
    runtime: null,
    installedAt: null,
    contentRevision: 0,
    managedFileCount: 0
  };
  const scenario = {
    schemaVersion: 1,
    profile,
    root,
    userData,
    serverRoot,
    serverId: SERVER_ID,
    state,
    history: managedProfile ? initialHistory() : [],
    notifications: initialNotifications(),
    recovery: [],
    crashPoint,
    crashMarker: null,
    operationSequence: 1,
    providerCalls: [],
    lifecycleCalls: [],
    safeActions: [],
    safeActionResults: [],
    priorStates: [],
    ambientNetworkRequests: 0,
    linkedRepositoryAccepted: false,
    assetPatternRemembered: false,
    startupBlockedObserved: false,
    recoveryRuns: 0,
    initializedCount: 0
  };
  writeJson(scenarioFile, scenario);
  return { root, userData, serverRoot, scenarioFile };
}

function prepareProfile({ profile = 'managed', crashPoint = null, root = null, userDataPath = null } = {}) {
  const selectedRoot = root || fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-e2e-'));
  const scenarioFile = path.join(selectedRoot, 'scenario.json');
  return fs.existsSync(scenarioFile)
    ? { root: selectedRoot, ...(() => {
      const existing = readJson(scenarioFile);
      return { userData: existing.userData, serverRoot: existing.serverRoot, scenarioFile };
    })() }
    : makeScenario({ profile, root: selectedRoot, crashPoint, userDataOverride: userDataPath });
}

async function launchElectron(prepared, { executablePath = null, env = {} } = {}) {
  const { _electron: electron } = require('@playwright/test');
  const explicitEnv = Object.fromEntries(Object.entries(env || {}).filter(([, value]) => typeof value === 'string'));
  const electronApp = await electron.launch({
    ...(executablePath ? { executablePath: path.resolve(executablePath) } : {}),
    args: executablePath ? [] : ['.'],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...explicitEnv,
      NODE_ENV: 'test',
      MINECRAFT_CORE_TEST_MODE: '1',
      MINECRAFT_CORE_USER_DATA_DIR: prepared.userData,
      MINECRAFT_CORE_TEST_MODPACK_FACTORY: FACTORY_MODULE,
      MINECRAFT_CORE_E2E_SCENARIO_FILE: prepared.scenarioFile,
      npm_lifecycle_event: 'test:e2e:modpacks',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  const page = await electronApp.firstWindow();
  await page.route(/^https?:\/\//u, route => route.abort('blockedbyclient'));
  await electronApp.evaluate(({ BrowserWindow, dialog }, target) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setSize(1440, 1000);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, prepared.serverRoot);
  await page.waitForLoadState('domcontentloaded');
  return { electronApp, page };
}

async function launchModpackApp(options = {}) {
  const prepared = prepareProfile(options);
  const launchOptions = { executablePath: options.executablePath || null, env: options.env || {} };
  let running = await launchElectron(prepared, launchOptions);
  let removed = false;

  const fixture = {
    ...prepared,
    get electronApp() { return running.electronApp; },
    get page() { return running.page; },
    readState() { return readJson(prepared.scenarioFile); },
    readEvidence() { return readJson(prepared.scenarioFile); },
    readServerFile(relativeName) { return fs.readFileSync(path.join(prepared.serverRoot, ...relativeName.split('/')), 'utf8'); },
    serverFileExists(relativeName) { return fs.existsSync(path.join(prepared.serverRoot, ...relativeName.split('/'))); },
    canonicalCount() { return fs.existsSync(prepared.serverRoot) ? 1 : 0; },
    serverTreeHash() { return snapshotReadOnlyFixture(prepared.serverRoot); },
    async openModpack() {
      await running.page.getByRole('button', { name: '📦 Modpack', exact: true }).click();
      await running.page.getByRole('heading', { name: 'Modpack', exact: true }).waitFor();
    },
    async kill() {
      const child = running.electronApp.process();
      if (child && !child.killed) child.kill('SIGKILL');
      await running.electronApp.close().catch(() => {});
    },
    async relaunch() {
      await running.electronApp.close().catch(() => {});
      running = await launchElectron(prepared, launchOptions);
      return running.page;
    },
    async close({ preserveRoot = false } = {}) {
      await running.electronApp.close().catch(() => {});
      if (!preserveRoot && !removed) {
        fs.rmSync(prepared.root, { recursive: true, force: true });
        removed = true;
      }
    }
  };
  return fixture;
}

async function runPackagedModpackSmoke({ executablePath, userDataPath, env = {}, fixtureRoot = null } = {}) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath) ||
      typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    throw new TypeError('Packaged smoke requires absolute executablePath and userDataPath');
  }
  const executable = path.resolve(executablePath);
  const isolatedUserData = path.resolve(userDataPath);
  if (!fs.statSync(executable).isFile()) throw new TypeError('Packaged smoke executable does not exist');
  fs.mkdirSync(isolatedUserData, { recursive: true });
  const fixtureSnapshot = snapshotReadOnlyFixture(fixtureRoot);
  const exclusiveEnvironment = Object.freeze({
    ...createExclusivePackagedEnvironment(env),
    MINECRAFT_CORE_USER_DATA_DIR: isolatedUserData
  });
  const { _electron: electron } = require('@playwright/test');
  let electronApp = null;
  try {
    electronApp = await electron.launch({
      executablePath: executable,
      args: [
        `--user-data-dir=${isolatedUserData}`,
        '--disable-background-networking',
        '--no-proxy-server'
      ],
      cwd: path.dirname(executable),
      env: exclusiveEnvironment
    });
    const page = await electronApp.firstWindow();
    const publicRequests = [];
    await page.route(/^https?:\/\//u, route => {
      publicRequests.push(route.request().url());
      return route.abort('blockedbyclient');
    });
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#app').waitFor({ state: 'attached' });
    const rendererLoaded = await page.locator('#app').evaluate(node => Boolean(node && node.childElementCount > 0));
    const observed = await electronApp.evaluate(({ app }) => ({
      appIsPackaged: Boolean(app.isPackaged),
      userDataPath: app.getPath('userData'),
      environment: Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]))
    }));
    const fixtureFactoryEnabled = Boolean(
      observed.environment.MINECRAFT_CORE_TEST_MODPACK_FACTORY ||
      observed.environment.MINECRAFT_CORE_TEST_MODE === '1'
    );
    const pathSanitized = !observed.environment.PATH;
    const fallbacksUsed = [];
    if (!observed.appIsPackaged) fallbacksUsed.push('unpackaged-application');
    if (fixtureFactoryEnabled) fallbacksUsed.push('test-composition-factory');
    if (!pathSanitized) fallbacksUsed.push('PATH');
    if (observed.environment.NODE_OPTIONS) fallbacksUsed.push('NODE_OPTIONS');
    if (observed.environment.ELECTRON_RUN_AS_NODE) fallbacksUsed.push('ELECTRON_RUN_AS_NODE');
    if (observed.environment.MINECRAFT_CORE_USE_DEV_SERVER) fallbacksUsed.push('development-server');
    const actualUserData = path.resolve(observed.userDataPath);
    const isIsolated = actualUserData.toLowerCase() === isolatedUserData.toLowerCase();
    if (!isIsolated) fallbacksUsed.push('non-isolated-user-data');
    if (snapshotReadOnlyFixture(fixtureRoot) !== fixtureSnapshot) {
      throw new Error('Packaged smoke modified the reviewed read-only fixture directory');
    }
    return {
      rendererLoaded,
      environment: {
        appIsPackaged: observed.appIsPackaged,
        productionComposition: observed.appIsPackaged && !fixtureFactoryEnabled,
        fixtureFactoryEnabled,
        isolatedUserData: isIsolated,
        pathSanitized,
        publicNetworkRequests: publicRequests.length
      },
      fallbacksUsed
    };
  } finally {
    await electronApp?.close().catch(() => {});
  }
}

async function waitUntil(read, predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for deterministic modpack evidence');
}

async function reviewAndStartArchivePlan(page, { downgrade = false } = {}) {
  if (downgrade) {
    const acknowledgement = page.getByLabel('I understand a world downgrade requires a compatible verified restore point.');
    if (await acknowledgement.isVisible().catch(() => false)) await acknowledgement.check();
  }
  await page.getByRole('button', { name: 'Run preflight review' }).click();
  const conflictReview = page.getByRole('button', { name: 'Re-run preflight with conflict choices' });
  const terminalReviewAction = page.getByRole('button', {
    name: /^(?:Re-run preflight with conflict choices|Install this exact reviewed plan|Start reviewed operation)$/u
  });
  await terminalReviewAction.first().waitFor({ state: 'visible' });
  if (await conflictReview.isVisible().catch(() => false)) {
    const resolutions = page.getByLabel(/^Resolution for /u);
    const resolutionCount = await resolutions.count();
    if (resolutionCount < 1) throw new Error('Conflict review exposed no selectable resolution');
    for (let index = 0; index < resolutionCount; index += 1) {
      await resolutions.nth(index).selectOption('keep-mine');
    }
    await conflictReview.click();
    await terminalReviewAction.first().waitFor({ state: 'visible' });
  }
  const eula = page.getByLabel('I accept the Minecraft EULA');
  if (await eula.isVisible().catch(() => false)) {
    await eula.check();
    await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  } else {
    await page.getByRole('button', { name: 'Start reviewed operation' }).click();
  }
  await page.locator('section.outcome').waitFor();
}

async function returnFromCompletedOperation(page) {
  await page.getByRole('button', { name: 'Return to server' }).click();
  await page.getByRole('heading', { name: 'Modpack', exact: true }).waitFor();
}

async function selectModrinthFromOverview(page, version) {
  await page.getByRole('button', { name: 'Install modpack' }).click();
  await page.getByRole('radio', { name: /Modrinth/u }).click();
  await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
  await page.getByRole('button', { name: new RegExp(`^${version.replaceAll('.', '\\.')}`, 'u') }).click();
}

async function selectManagedVersion(page, version) {
  await page.getByRole('button', { name: 'Versions' }).click();
  await page.getByRole('button', { name: 'Load exact version history' }).click();
  await page.getByRole('button', { name: new RegExp(`^${version.replaceAll('.', '\\.')}`, 'u') }).click();
}

async function driveManagementOperation(page, reviewButton, startButton, confirmButton = null) {
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('button', { name: reviewButton }).click();
  if (reviewButton === 'Choose restore point') {
    await page.getByRole('button', { name: /install existing restore point/u }).click();
  }
  await page.getByRole('button', { name: startButton }).click();
  if (confirmButton) await page.getByRole('button', { name: confirmButton, exact: true }).click();
}

async function openGithubAssetFromOverview(page, assetName) {
  const back = page.getByRole('button', { name: 'Back to Modpack overview' });
  if (await back.isVisible().catch(() => false)) await back.click();
  await page.getByRole('button', { name: 'Install modpack' }).click();
  await page.getByRole('radio', { name: /GitHub Releases/u }).click();
  await page.getByLabel('Public repository or release URL').fill('https://github.com/FixtureOrg/FixturePack');
  await page.getByRole('button', { name: 'Load releases' }).click();
  await page.getByRole('button', { name: /Fixture Release v2/u }).click();
  await page.getByRole('radio', { name: new RegExp(assetName.replaceAll('.', '\\.'), 'u') }).click();
  await page.getByRole('button', { name: 'Download and inspect selected asset' }).click();
}

async function runDeterministicModpackLifecycleEvidence({ fixtureRoot = null } = {}) {
  const fixtureSnapshot = snapshotReadOnlyFixture(fixtureRoot);
  const fixture = await launchModpackApp({ profile: 'unmanaged' });
  let lifecycleEvidence;
  try {
    await fixture.openModpack();
    await selectModrinthFromOverview(fixture.page, '1.0.0');
    await reviewAndStartArchivePlan(fixture.page);
    await returnFromCompletedOperation(fixture.page);

    await selectManagedVersion(fixture.page, '2.0.0');
    await reviewAndStartArchivePlan(fixture.page);
    await returnFromCompletedOperation(fixture.page);

    await fixture.page.getByRole('button', { name: 'Actions' }).click();
    await fixture.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await fixture.page.locator('section.outcome').waitFor();
    await returnFromCompletedOperation(fixture.page);

    await fixture.page.getByRole('button', { name: 'Actions' }).click();
    await fixture.page.getByRole('button', { name: 'Repair', exact: true }).click();
    await fixture.page.getByRole('radio', { name: /Modrinth/u }).click();
    await fixture.page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await fixture.page.getByRole('button', { name: /^2\.0\.0/u }).click();
    await reviewAndStartArchivePlan(fixture.page);
    await returnFromCompletedOperation(fixture.page);

    await driveManagementOperation(fixture.page, 'Review detach', 'Detach and keep all files', 'Detach');
    await fixture.page.locator('section.outcome').waitFor();
    await returnFromCompletedOperation(fixture.page);

    const beforeRelaunch = fixture.readEvidence();
    const preserved = ['mods/user-added.jar', 'config/user.cfg', 'world/level.dat']
      .every(relativeName => fixture.serverFileExists(relativeName));
    const generation = fixture.readServerFile('server.jar').trim();
    const canonicalHash = snapshotReadOnlyFixture(fixture.serverRoot);
    await fixture.relaunch();
    await fixture.openModpack();
    await fixture.page.getByRole('button', { name: 'History' }).click();
    await fixture.page.getByRole('heading', { name: 'Lifecycle operations' }).waitFor();
    const afterRelaunch = fixture.readEvidence();
    const historyDurable = JSON.stringify(afterRelaunch.history) === JSON.stringify(beforeRelaunch.history);
    const requiredKinds = ['install-existing', 'update', 'verify', 'repair', 'detach'];
    lifecycleEvidence = {
      operations: [
        { operation: 'create', outcome: beforeRelaunch.history.some(item => item.kind === 'install-existing') ? 'succeeded' : 'missing' },
        { operation: 'update', outcome: beforeRelaunch.history.some(item => item.kind === 'update') ? 'succeeded' : 'missing' },
        { operation: 'verify', outcome: beforeRelaunch.history.some(item => item.kind === 'verify') ? 'succeeded' : 'missing' },
        { operation: 'targeted-repair', outcome: beforeRelaunch.history.some(item => item.kind === 'repair') ? 'succeeded' : 'missing' },
        { operation: 'detach', outcome: beforeRelaunch.history.some(item => item.kind === 'detach') ? 'succeeded' : 'missing' }
      ],
      canonicalServer: { count: fixture.canonicalCount(), sha256: canonicalHash, generation },
      history: {
        durable: historyDurable,
        operationCount: beforeRelaunch.history.length,
        ownershipTransitionsRecorded: requiredKinds.every(kind => beforeRelaunch.history.some(item => item.kind === kind))
      },
      ownership: {
        verified: beforeRelaunch.history.some(item => item.kind === 'verify'),
        detached: afterRelaunch.state.lifecycleMode === 'unmanaged' && afterRelaunch.state.modpackManaged === false,
        unmanagedFilesPreserved: preserved
      }
    };
  } finally {
    await fixture.close();
  }

  const crashPoints = ['before-live-rename', 'between-renames', 'after-candidate-rename'];
  const recoveredPoints = [];
  let allBlocked = true;
  let allCanonical = true;
  let allIdempotent = true;
  for (const crashPoint of crashPoints) {
    const recoveryFixture = await launchModpackApp({ profile: 'recovery', crashPoint });
    try {
      await recoveryFixture.openModpack();
      await driveManagementOperation(recoveryFixture.page, 'Choose restore point', 'Start reviewed operation');
      await waitUntil(recoveryFixture.readState, state => state.crashMarker === crashPoint);
      await recoveryFixture.kill();
      await recoveryFixture.relaunch();
      await recoveryFixture.openModpack();
      const blocked = recoveryFixture.readState().startupBlockedObserved === true && recoveryFixture.readState().recovery.length === 1;
      allBlocked = allBlocked && blocked;
      await recoveryFixture.page.getByRole('button', { name: 'Recover safely' }).click();
      await waitUntil(recoveryFixture.readState, state => state.recovery.length === 0);
      const afterRecovery = recoveryFixture.readState();
      allCanonical = allCanonical && recoveryFixture.canonicalCount() === 1;
      await recoveryFixture.relaunch();
      await recoveryFixture.openModpack();
      const afterSecondLaunch = recoveryFixture.readState();
      allIdempotent = allIdempotent && afterRecovery.recoveryRuns === 1 && afterSecondLaunch.recoveryRuns === 1 && afterSecondLaunch.recovery.length === 0;
      recoveredPoints.push(crashPoint);
    } finally {
      await recoveryFixture.close();
    }
  }
  lifecycleEvidence.recovery = {
    crashPoints: recoveredPoints,
    startupBlockedUntilRecovered: allBlocked,
    canonicalServerCount: allCanonical ? 1 : 0,
    idempotent: allIdempotent,
    outcome: recoveredPoints.length === crashPoints.length ? 'recovered' : 'incomplete'
  };

  const sourceFixture = await launchModpackApp({ profile: 'unmanaged' });
  let archiveEvidence;
  try {
    await sourceFixture.openModpack();
    await openGithubAssetFromOverview(sourceFixture.page, 'fixture-rxx.rar');
    await sourceFixture.page.getByRole('heading', { name: 'Inspect evidence before installation' }).waitFor();
    await openGithubAssetFromOverview(sourceFixture.page, 'fixture-numbered.001');
    await sourceFixture.page.getByRole('heading', { name: 'Inspect evidence before installation' }).waitFor();
    await openGithubAssetFromOverview(sourceFixture.page, 'fixture-header-encrypted.rar');
    await sourceFixture.page.getByText('ENCRYPTED_ARCHIVE', { exact: true }).waitFor();
    const calls = sourceFixture.readEvidence().lifecycleCalls;
    archiveEvidence = {
      schemes: [
        {
          groupingScheme: 'rar-rxx',
          layer: 'deterministic-grouping-download-materialization-validation',
          outcome: calls.some(item => item.method === 'inspectSource' && item.kind === 'rar-rxx') ? 'accepted' : 'missing'
        },
        {
          groupingScheme: 'numbered-volume',
          layer: 'deterministic-grouping-download-materialization-validation',
          outcome: calls.some(item => item.method === 'inspectSource' && item.kind === 'numbered-volume') ? 'accepted' : 'missing'
        }
      ],
      rejected: [{
        caseId: 'encrypted-header',
        layer: 'deterministic-engine-evidence',
        code: calls.some(item => item.method === 'inspectSource' && item.kind === 'encrypted-header') ? 'ENCRYPTED_ARCHIVE' : 'MISSING_EVIDENCE'
      }]
    };
  } finally {
    await sourceFixture.close();
  }

  if (snapshotReadOnlyFixture(fixtureRoot) !== fixtureSnapshot) {
    throw new Error('Deterministic modpack evidence modified the reviewed read-only fixture directory');
  }
  const complete = lifecycleEvidence.operations.every(item => item.outcome === 'succeeded') &&
    lifecycleEvidence.canonicalServer.count === 1 && lifecycleEvidence.history.durable &&
    lifecycleEvidence.ownership.unmanagedFilesPreserved && lifecycleEvidence.recovery.outcome === 'recovered' &&
    archiveEvidence.schemes.every(item => item.outcome === 'accepted') &&
    archiveEvidence.rejected[0].code === 'ENCRYPTED_ARCHIVE';
  if (!complete) throw new Error('Deterministic non-packaged modpack evidence is incomplete');
  return {
    layer: 'non-packaged-test-composition',
    fixtureFactoryEnabled: true,
    schemes: archiveEvidence.schemes,
    rejected: archiveEvidence.rejected,
    lifecycle: lifecycleEvidence,
  };
}

function createModpackFactory() {
  return async function createE2eComposition(input) {
    const scenarioFile = process.env.MINECRAFT_CORE_E2E_SCENARIO_FILE;
    if (process.env.NODE_ENV !== 'test' || process.env.MINECRAFT_CORE_TEST_MODE !== '1' ||
        typeof scenarioFile !== 'string' || !path.isAbsolute(scenarioFile)) {
      throw new TypeError('E2E modpack composition is not authorized');
    }
    return createComposition({ input, scenarioFile });
  };
}

function createRecoveryFactory() {
  return async function createE2eRecoveryComposition() {
    if (process.env.NODE_ENV !== 'test' || process.env.MINECRAFT_CORE_TEST_MODE !== '1') {
      throw new TypeError('E2E recovery composition is not authorized');
    }
    const emptyScan = () => ({ records: [], corrupt: [], blocks: [], globalBlock: false });
    return {
      registry: { async initialize() { return emptyScan(); } },
      recoveryService: { async recoverAll() { return { recovered: [], unresolved: [] }; } },
      runtimeVerifier: async () => ({ quiescent: true })
    };
  };
}

function createIpcOverrides() {
  if (process.env.NODE_ENV !== 'test' || process.env.MINECRAFT_CORE_TEST_MODE !== '1') {
    throw new TypeError('E2E IPC composition is not authorized');
  }
  const scenarioFile = process.env.MINECRAFT_CORE_E2E_SCENARIO_FILE;
  if (typeof scenarioFile !== 'string' || !path.isAbsolute(scenarioFile)) {
    throw new TypeError('E2E IPC scenario is invalid');
  }
  const { createFileHandlers } = require(path.join(PROJECT_ROOT, 'electron', 'ipc', 'file-handlers.cjs'));
  return {
    handlerFactories: {
      createFileHandlers(window) {
        return {
          ...createFileHandlers(window),
          'select-folder': async () => readJson(scenarioFile).serverRoot
        };
      }
    }
  };
}

function createComposition({ input, scenarioFile }) {
  const { ModpackError } = require(path.join(PROJECT_ROOT, 'electron', 'services', 'modpacks', 'errors.cjs'));
  const inspections = new Map();
  const plans = new Map();
  const jobs = new Map();
  const destinationReservations = new Map();
  let inspectionSequence = 0;
  let planSequence = 0;
  let jobSequence = 0;

  const scenario = () => readJson(scenarioFile);
  const save = value => writeJson(scenarioFile, value);
  const update = mutator => {
    const value = scenario();
    const result = mutator(value);
    save(value);
    return result;
  };
  const record = (bucket, entry) => update(value => value[bucket].push({ at: FIXED_TIME, ...clone(entry) }));
  const blocked = () => scenario().recovery.length > 0;
  const assertNotBlocked = () => {
    if (blocked()) throw new ModpackError('RECOVERY_REQUIRED', 'This server remains blocked until durable recovery is reviewed.');
  };

  const versions = [
    { versionId: 'version-upgrade', version: '2.0.0', name: '2.0.0 upgrade', channel: 'release', publishedAt: '2026-08-01T10:00:00.000Z', minecraftVersions: ['1.21.1'], loaders: ['fabric'] },
    { versionId: 'version-current', version: '1.0.0', name: '1.0.0 installed', channel: 'release', publishedAt: '2026-06-01T10:00:00.000Z', minecraftVersions: ['1.21.1'], loaders: ['fabric'] },
    { versionId: 'version-downgrade-safe', version: '0.9.0', name: '0.9.0 safe downgrade', channel: 'release', publishedAt: '2026-05-01T10:00:00.000Z', minecraftVersions: ['1.21.1'], loaders: ['fabric'] },
    { versionId: 'version-downgrade-blocked', version: '0.8.0', name: '0.8.0 blocked downgrade', channel: 'release', publishedAt: '2026-04-01T10:00:00.000Z', minecraftVersions: ['1.21.1'], loaders: ['fabric'] },
    { versionId: 'version-client-only', version: '3.0.0-client', name: 'Client-only fixture', channel: 'release', publishedAt: '2026-07-01T10:00:00.000Z', minecraftVersions: ['1.21.1'], loaders: ['fabric'] }
  ];

  const providers = {
    modrinth: {
      async searchProjects(request) {
        record('providerCalls', { provider: 'modrinth', method: 'searchProjects', query: request.query || '' });
        return {
          items: [{
            projectId: 'fixture-pack',
            title: 'Fixture Factory Pack',
            summary: 'A deterministic offline server pack used by Electron E2E.',
            categories: ['technology'],
            minecraftVersions: ['1.21.1'],
            loaders: ['fabric'],
            serverCompatibility: 'required',
            updatedAt: FIXED_TIME,
            downloads: 4242
          }],
          pagination: { offset: request.offset || 0, limit: request.limit || 20, total: 1 }
        };
      },
      async getProject(projectId) {
        record('providerCalls', { provider: 'modrinth', method: 'getProject', projectId });
        return {
          projectId,
          title: 'Fixture Factory Pack',
          description: 'Deterministic server pack with an explicitly linked public repository.',
          serverCompatibility: 'required',
          runtimes: { minecraftVersions: ['1.21.1'], loaders: ['fabric'] },
          galleryCandidates: [],
          upstreamLinkCandidates: [{ kind: 'source', urlCandidate: 'https://github.com/FixtureOrg/FixturePack' }]
        };
      },
      async listVersions(request) {
        record('providerCalls', { provider: 'modrinth', method: 'listVersions', projectId: request.projectId });
        return clone(versions);
      }
    },
    github: {
      async getRepositoryIdentity(repositoryUrl) {
        record('providerCalls', { provider: 'github', method: 'getRepositoryIdentity', repositoryUrl });
        return { repositoryId: '1001', owner: 'FixtureOrg', repo: 'FixturePack' };
      },
      async listReleases(request) {
        record('providerCalls', { provider: 'github', method: 'listReleases', repositoryId: request.repositoryId });
        return {
          releases: [
            { repositoryId: '1001', releaseId: '2001', name: 'Fixture Release v2', tagName: 'v2.0.0', prerelease: false, publishedAt: FIXED_TIME },
            { repositoryId: '1001', releaseId: '2002', name: 'Source-only Release', tagName: 'v2.0.1-source', prerelease: false, publishedAt: '2026-08-01T11:00:00.000Z' }
          ],
          pagination: { nextCursor: null }
        };
      },
      async loadUploadedAssets({ repositoryId, releaseId }) {
        record('providerCalls', { provider: 'github', method: 'loadUploadedAssets', repositoryId, releaseId });
        if (releaseId === '2002') return { status: 'NO_INSTALLABLE_ASSET', assets: [], choices: [] };
        const definitions = [
          ['asset-mrpack', 'fixture-server.mrpack', 'mrpack'],
          ['asset-zip', 'fixture-server.zip', 'zip'],
          ['asset-rar', 'fixture-server.rar', 'rar'],
          ['asset-missing-digest', 'fixture-missing-digest.zip', 'zip'],
          ['asset-ambiguous', 'fixture-ambiguous.zip', 'zip'],
          ['asset-client-only', 'fixture-client-only.mrpack', 'mrpack'],
          ['asset-encrypted', 'fixture-encrypted.zip', 'zip'],
          ['asset-header-encrypted', 'fixture-header-encrypted.rar', 'rar'],
          ['asset-files-only', 'fixture-files-only.zip', 'zip'],
          ['asset-changed', 'fixture-republished.zip', 'zip']
        ];
        const assets = definitions.map(([assetId, fileName]) => ({
          assetId,
          fileName,
          size: '2048',
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME,
          providerDigest: assetId === 'asset-missing-digest' ? null : { algorithm: 'sha256', digest: 'b'.repeat(64) },
          installableCandidate: true
        }));
        for (const [assetId, fileName] of [
          ['asset-part-1', 'fixture.part01.rar'], ['asset-part-2', 'fixture.part02.rar'], ['asset-part-3', 'fixture.part03.rar'],
          ['asset-rxx-rar', 'fixture-rxx.rar'], ['asset-rxx-r00', 'fixture-rxx.r00'], ['asset-rxx-r01', 'fixture-rxx.r01'],
          ['asset-numbered-1', 'fixture-numbered.001'], ['asset-numbered-2', 'fixture-numbered.002']
        ]) assets.push({ assetId, fileName, size: '1024', createdAt: FIXED_TIME, updatedAt: FIXED_TIME, providerDigest: { algorithm: 'sha256', digest: 'c'.repeat(64) }, installableCandidate: true });
        const choices = definitions.map(([assetId, fileName, role]) => ({ id: `choice-${assetId}`, assetIds: [assetId], fileName, size: '2048', role, complete: true, missingVolumes: [] }));
        choices.splice(3, 0, {
          id: 'choice-multipart',
          fileName: 'fixture.part01.rar',
          combinedSize: '3072',
          role: 'multipart-rar',
          complete: true,
          missingVolumes: [],
          parts: [
            { providerAssetId: 'asset-part-1', fileName: 'fixture.part01.rar' },
            { providerAssetId: 'asset-part-2', fileName: 'fixture.part02.rar' },
            { providerAssetId: 'asset-part-3', fileName: 'fixture.part03.rar' }
          ]
        });
        choices.splice(4, 0, {
          id: 'choice-rar-rxx', fileName: 'fixture-rxx.rar', combinedSize: '3072', role: 'multipart-rar',
          groupingScheme: 'rar-rxx', complete: true, missingVolumes: [],
          parts: [
            { providerAssetId: 'asset-rxx-rar', fileName: 'fixture-rxx.rar' },
            { providerAssetId: 'asset-rxx-r00', fileName: 'fixture-rxx.r00' },
            { providerAssetId: 'asset-rxx-r01', fileName: 'fixture-rxx.r01' }
          ]
        });
        choices.splice(5, 0, {
          id: 'choice-numbered-volume', fileName: 'fixture-numbered.001', combinedSize: '2048', role: 'multipart-rar',
          groupingScheme: 'numbered-volume', complete: true, missingVolumes: [],
          parts: [
            { providerAssetId: 'asset-numbered-1', fileName: 'fixture-numbered.001' },
            { providerAssetId: 'asset-numbered-2', fileName: 'fixture-numbered.002' }
          ]
        });
        return { status: 'ready', assets, choices };
      }
    }
  };

  const localArtifactSource = {
    async selectWithNativeDialog() {
      record('providerCalls', { provider: 'local', method: 'selectWithNativeDialog' });
      return {
        selectionId: 'selection-local-001',
        displayName: 'fixture-local.zip',
        parts: [{ partId: 'local-part-1', fileName: 'fixture-local.zip', size: '2048' }]
      };
    }
  };

  function sourceFor(request) {
    if (request.provider === 'modrinth') {
      const selected = versions.find(version => version.versionId === request.versionId) || versions[1];
      return { provider: 'modrinth', projectId: request.projectId, versionId: request.versionId, version: selected.version, title: 'Fixture Factory Pack' };
    }
    if (request.provider === 'github') {
      return {
        provider: 'github', repositoryId: request.repositoryId, releaseId: request.releaseId,
        githubOwner: 'FixtureOrg', githubRepo: 'FixturePack', version: 'v2.0.0', title: 'Fixture GitHub Server Pack'
      };
    }
    return { provider: 'local', importId: 'import-local-001', artifactSha256: 'd'.repeat(64), version: 'local-1', title: 'Fixture Local Archive' };
  }

  function inspectKind(request) {
    const ids = new Set(request.assetIds || []);
    if (request.versionId === 'version-client-only' || ids.has('asset-client-only')) return 'client-only';
    if (ids.has('asset-encrypted')) return 'encrypted';
    if (ids.has('asset-header-encrypted')) return 'encrypted-header';
    if (ids.has('asset-changed')) return 'changed';
    if (ids.has('asset-ambiguous')) return 'ambiguous';
    if (ids.has('asset-files-only')) return 'files-only';
    if (ids.has('asset-missing-digest')) return 'missing-digest';
    if (ids.has('asset-mrpack')) return 'mrpack';
    if (ids.has('asset-rar')) return 'rar5';
    if (ids.has('asset-part-1')) return 'multipart-rar';
    if (ids.has('asset-rxx-rar')) return 'rar-rxx';
    if (ids.has('asset-numbered-1')) return 'numbered-volume';
    if (request.provider === 'modrinth') return 'mrpack';
    return 'zip';
  }

  const lifecycleService = {
    async inspectSource(request) {
      assertNotBlocked();
      const kind = inspectKind(request);
      record('lifecycleCalls', { method: 'inspectSource', provider: request.provider, kind });
      if (kind === 'client-only') throw new ModpackError('CLIENT_ONLY_PACK', 'This archive is client-only and cannot create a server.');
      if (kind === 'encrypted' || kind === 'encrypted-header') throw new ModpackError('ENCRYPTED_ARCHIVE', 'Encrypted archives are not supported for unattended server setup.');
      if (kind === 'changed') throw new ModpackError('ASSET_CHANGED', 'The selected GitHub asset was republished with different bytes.');
      if (request.linkedModrinthProjectId) update(value => { value.linkedRepositoryAccepted = true; });
      if (request.rememberAssetPattern) update(value => { value.assetPatternRemembered = true; });
      const inspectionId = `inspection-${++inspectionSequence}`;
      const ambiguous = kind === 'ambiguous';
      const filesOnly = kind === 'files-only';
      const archiveFamily = ['mrpack', 'rar5', 'multipart-rar'].includes(kind) || ['rar-rxx', 'numbered-volume'].includes(kind) ? (['rar-rxx', 'numbered-volume'].includes(kind) ? 'multipart-rar' : kind) : 'zip';
      const inspection = {
        inspectionId,
        integrity: 'Verified',
        archiveFamily,
        classification: {
          kind: ambiguous ? 'ambiguous-or-unknown' : filesOnly ? 'files-only' : archiveFamily === 'mrpack' ? 'mrpack-server' : 'prepared-server-pack',
          confidence: ambiguous ? 'multiple-roots' : 'exact',
          blocked: ambiguous,
          ...(ambiguous
            ? { candidates: [
                { kind: 'nested-runtime-candidate', entryName: 'server-a/server.jar' },
                { kind: 'nested-runtime-candidate', entryName: 'server-b/server.jar' }
              ] }
            : { runtime: clone(RUNTIME) }),
          optionalFiles: archiveFamily === 'mrpack' ? [
            { id: 'optional-server-utilities', label: 'Server utilities', defaultSelected: true },
            { id: 'optional-example-config', label: 'Example configuration', defaultSelected: false }
          ] : []
        },
        rootCandidates: ambiguous ? ['server-a', 'server-b'] : ['server'],
        selectedRoot: ambiguous ? null : 'server',
        limitEvidence: { totals: { entryCount: 42, expandedBytes: '8192' } },
        warnings: kind === 'missing-digest' ? [{ code: 'MISSING_PROVIDER_DIGEST', message: 'GitHub did not publish a trustworthy digest.' }] : []
      };
      inspections.set(inspectionId, { request: clone(request), kind, inspection: clone(inspection), source: sourceFor(request) });
      return inspection;
    },

    async createPlan(request) {
      assertNotBlocked();
      const inspected = inspections.get(request.inspectionId);
      if (!inspected) throw new ModpackError('PLAN_STALE', 'The reviewed inspection has expired.');
      if (request.operationKind === 'install-new' || request.operationKind === 'import-files-only-new') {
        const reservation = destinationReservations.get(request.instanceId);
        if (!reservation) throw new ModpackError('PLAN_STALE', 'The reserved server destination has expired.');
      }
      const needsFixtureConflict = request.operationKind === 'install-existing' &&
        inspected.request.versionId === 'version-current' &&
        !request.selections?.conflictChoices?.paths?.['conflict-user-config'];
      if (needsFixtureConflict) {
        const conflictReview = {
          requiresConflictReview: true,
          conflicts: [{
            id: 'conflict-user-config',
            label: 'User configuration override',
            role: 'configuration',
            reason: 'both-changed',
            protected: true,
            allowedChoices: ['keep-mine', 'use-pack', 'keep-both'],
            alternateOptions: [{ id: 'alternate-pack-config', label: 'Keep pack copy as config/pack-example.toml' }]
          }]
        };
        record('lifecycleCalls', { method: 'createPlan', operationKind: request.operationKind, requiresConflictReview: true });
        return conflictReview;
      }
      const planId = `plan-${++planSequence}`;
      const operationKind = request.operationKind;
      const blockedDowngrade = inspected.request.versionId === 'version-downgrade-blocked';
      const warnings = inspected.kind === 'missing-digest' ? [{ code: 'MISSING_PROVIDER_DIGEST', message: 'Missing provider digest was explicitly acknowledged.' }] : [];
      const blockers = blockedDowngrade ? [{ code: 'RECOVERY_REQUIRED', message: 'No compatible verified world restore point exists for this downgrade.' }] : [];
      const plan = {
        planId,
        planFingerprint: FINGERPRINT,
        instanceId: request.instanceId,
        operationKind,
        source: inspected.source,
        inspection: inspected,
        selections: clone(request.selections),
        planView: {
          title: `${operationKind.replaceAll('-', ' ')} Fixture Factory Pack`,
          source: clone(inspected.source),
          runtime: { minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.16.10', java: 21 },
          server: { contentRevision: scenario().state.contentRevision, priorState: scenario().operationSequence % 2 ? 'running' : 'stopped' },
          changes: { added: 3, changed: 2, removed: operationKind === 'switch' ? 1 : 0, preserved: 4 },
          warnings,
          blockers
        }
      };
      plans.set(planId, plan);
      record('lifecycleCalls', {
        method: 'createPlan', operationKind, requestedOperationKind: request.operationKind, planId,
        selections: clone(request.selections)
      });
      return { planId, planFingerprint: FINGERPRINT, planView: clone(plan.planView) };
    },

    async createManagementPlan({ instanceId, operationKind, selectionRef = null }) {
      assertNotBlocked();
      const planId = `plan-${++planSequence}`;
      const titles = {
        detach: 'Detach management and keep every file',
        uninstall: 'Remove unchanged managed pack files',
        repair: 'Repair exact managed mismatches',
        'rollback-restore-point': 'Restore exact verified restore point'
      };
      const plan = {
        planId,
        planFingerprint: FINGERPRINT,
        instanceId,
        operationKind,
        selectionRef,
        planView: {
          title: titles[operationKind],
          source: clone(scenario().state.source),
          runtime: clone(RUNTIME),
          server: { contentRevision: scenario().state.contentRevision, priorState: scenario().operationSequence % 2 ? 'running' : 'stopped' },
          changes: { added: operationKind === 'repair' ? 1 : 0, changed: operationKind === 'repair' ? 1 : 0, removed: operationKind === 'uninstall' ? 2 : 0, preserved: 4 },
          confirmation: { unchangedManagedRemovalCount: operationKind === 'uninstall' ? 2 : 0 },
          warnings: [],
          blockers: []
        }
      };
      plans.set(planId, plan);
      record('lifecycleCalls', { method: 'createManagementPlan', operationKind, selectionRef });
      return { planId, planFingerprint: FINGERPRINT, planView: clone(plan.planView) };
    },

    async startOperation(request) {
      assertNotBlocked();
      const plan = plans.get(request.planId);
      if (!plan || request.planFingerprint !== FINGERPRINT) throw new ModpackError('PLAN_STALE', 'The reviewed plan is no longer current.');
      if (plan.planView.blockers.length) throw new ModpackError('RECOVERY_REQUIRED', 'A required compatible restore point is missing.');
      const jobId = `job-${++jobSequence}`;
      const crash = scenario().crashPoint && plan.operationKind === 'rollback-restore-point';
      const deferred = !crash && !['detach', 'uninstall', 'repair', 'rollback-restore-point'].includes(plan.operationKind);
      const job = {
        jobId,
        operationKind: plan.operationKind,
        phase: crash ? 'committing' : deferred ? 'downloading' : 'completed',
        progress: {
          percent: crash ? 82 : deferred ? 35 : 100,
          message: crash ? 'Publishing the durable candidate directory' : deferred ? 'Verifying exact offline fixture bytes' : 'Final server state validated'
        },
        cancellationRequested: false,
        outcome: crash || deferred ? null : completeOperation(plan)
      };
      jobs.set(jobId, { job, plan, reads: 0 });
      record('lifecycleCalls', { method: 'startOperation', operationKind: plan.operationKind, jobId });
      if (crash) beginCrashBoundary(plan);
      return clone(job);
    },

    async cancelJob(jobId) {
      const stored = jobs.get(jobId);
      if (!stored) throw new ModpackError('PLAN_STALE', 'The operation record is unavailable.');
      if (!['queued', 'downloading', 'inspecting', 'planning', 'preflight'].includes(stored.job.phase)) return clone(stored.job);
      stored.job.phase = 'cancelled';
      stored.job.cancellationRequested = true;
      stored.job.progress = { percent: stored.job.progress.percent, message: 'Cancelled before commit; nothing changed' };
      stored.job.outcome = { status: 'cancelled', kind: 'nothing-changed', result: { serverUnchanged: true } };
      record('lifecycleCalls', { method: 'cancelJob', jobId });
      return clone(stored.job);
    },

    async getJob(jobId) {
      const stored = jobs.get(jobId);
      if (!stored) throw new ModpackError('PLAN_STALE', 'The operation record is unavailable.');
      stored.reads += 1;
      if (stored.job.phase === 'downloading' && stored.reads >= 1) {
        stored.job.phase = 'completed';
        stored.job.progress = { percent: 100, message: 'Final server state validated' };
        stored.job.outcome = completeOperation(stored.plan);
      }
      return clone(stored.job);
    },

    async getState(instanceId) {
      record('lifecycleCalls', { method: 'getState', instanceId });
      return clone(scenario().state);
    },

    async listHistory(instanceId, { cursor = null } = {}) {
      record('lifecycleCalls', { method: 'listHistory', instanceId, cursor });
      return { items: clone(scenario().history), nextCursor: null };
    },

    async verify(instanceId) {
      assertNotBlocked();
      record('lifecycleCalls', { method: 'verify', instanceId });
      update(value => appendHistory(value, { operationKind: 'verify' }));
      return {
        jobId: `verify-${++jobSequence}`,
        operationKind: 'verify',
        phase: 'completed',
        progress: { percent: 100, message: 'Managed and runtime hashes verified' },
        cancellationRequested: false,
        outcome: {
          status: 'completed',
          kind: 'completed',
          result: { repairAvailable: true, mismatches: [{ role: 'managed', status: 'modified' }] }
        }
      };
    }
  };

  function appendHistory(value, plan, outcome = 'completed') {
    const sequence = value.history.length + 1;
    value.history.unshift({
      schemaVersion: 1,
      operationId: `operation-${sequence}`,
      sequence,
      kind: plan.operationKind,
      outcome,
      timestamp: FIXED_TIME,
      sourceRevision: value.state.contentRevision,
      targetRevision: value.state.contentRevision + (['detach', 'verify'].includes(plan.operationKind) ? 0 : 1),
      ...(['install-existing', 'update', 'downgrade', 'switch', 'repair', 'rollback-restore-point'].includes(plan.operationKind)
        ? { restorePointId: plan.selectionRef || `restore-point-${sequence}` }
        : {})
    });
  }

  function completeOperation(plan) {
    update(value => {
      const priorState = value.operationSequence % 2 ? 'running' : 'stopped';
      value.priorStates.push({ operationKind: plan.operationKind, priorState, restoredState: priorState });
      appendHistory(value, plan);
      value.operationSequence += 1;
      if (plan.operationKind === 'detach') {
        value.state.modpackManaged = false;
        value.state.lifecycleMode = 'unmanaged';
      } else if (plan.operationKind === 'uninstall') {
        fs.rmSync(path.join(value.serverRoot, 'mods', 'managed.jar'), { force: true });
        value.state.modpackManaged = false;
        value.state.lifecycleMode = 'files-only';
        value.state.managedFileCount = 0;
        value.state.contentRevision += 1;
      } else if (plan.operationKind === 'repair') {
        fs.writeFileSync(path.join(value.serverRoot, 'mods', 'managed.jar'), 'managed:repaired\n');
        value.state.contentRevision += 1;
      } else if (plan.operationKind === 'rollback-restore-point') {
        fs.writeFileSync(path.join(value.serverRoot, 'server.jar'), 'managed-v1\n');
        value.state.source.version = '1.0.0';
        value.state.source.versionId = 'version-current';
        value.state.contentRevision += 1;
      } else if (plan.inspection?.kind === 'files-only' || plan.operationKind === 'import-files-only-new') {
        value.state = {
          schemaVersion: 1, modpackManaged: false, lifecycleMode: 'files-only', source: clone(plan.source), runtime: null,
          installedAt: FIXED_TIME, contentRevision: value.state.contentRevision + 1, managedFileCount: 0
        };
      } else {
        const generation = plan.source?.version === '2.0.0' ? 'managed-v2' : `managed-${plan.source?.version || 'exact'}`;
        ensureServerTree(value.serverRoot, generation);
        value.state = {
          schemaVersion: 1,
          modpackManaged: true,
          lifecycleMode: 'managed',
          source: clone(plan.source),
          runtime: clone(RUNTIME),
          installedAt: FIXED_TIME,
          contentRevision: value.state.contentRevision + 1,
          managedFileCount: 2
        };
      }
      if (['install-new', 'import-files-only-new'].includes(plan.operationKind)) {
        const reservation = destinationReservations.get(plan.instanceId);
        if (!reservation) throw new ModpackError('PLAN_STALE', 'The reserved server destination has expired.');
        const existing = input.store.get('instances') || [];
        const record = {
          id: plan.instanceId,
          name: reservation.displayName,
          type: 'server',
          path: reservation.serverPath,
          autoStart: false
        };
        input.store.set('instances', [
          ...existing.filter(instance => instance?.id !== record.id && instance?.path !== record.path),
          record
        ]);
        destinationReservations.delete(plan.instanceId);
      }
    });
    return {
      status: 'completed',
      kind: 'completed',
      result: { committed: true, preservedUserFiles: true },
      actions: [{ actionId: 'open-details', opaqueRef: `outcome-${plan.operationKind}-${scenario().operationSequence}` }]
    };
  }

  function beginCrashBoundary(plan) {
    update(value => {
      const candidate = `${value.serverRoot}.candidate`;
      const rollback = `${value.serverRoot}.rollback`;
      fs.rmSync(candidate, { recursive: true, force: true });
      fs.rmSync(rollback, { recursive: true, force: true });
      fs.cpSync(value.serverRoot, candidate, { recursive: true });
      fs.writeFileSync(path.join(candidate, 'server.jar'), 'managed-recovered-new\n');
      const journal = { point: value.crashPoint, candidate, rollback, canonical: value.serverRoot, operationKind: plan.operationKind };
      writeJson(path.join(value.root, 'crash-journal.json'), journal);
      if (value.crashPoint === 'between-renames' || value.crashPoint === 'after-candidate-rename') {
        fs.renameSync(value.serverRoot, rollback);
      }
      if (value.crashPoint === 'after-candidate-rename') fs.renameSync(candidate, value.serverRoot);
      value.crashMarker = value.crashPoint;
    });
  }

  function initializeRecoveryFixture() {
    const value = scenario();
    value.initializedCount += 1;
    const journalFile = path.join(value.root, 'crash-journal.json');
    if (fs.existsSync(journalFile)) {
      const journal = readJson(journalFile);
      if (!fs.existsSync(journal.canonical) && fs.existsSync(journal.rollback)) {
        fs.cpSync(journal.rollback, journal.canonical, { recursive: true });
      }
      value.startupBlockedObserved = true;
      value.recovery = [{
        recoveryId: 'recovery-directory-swap',
        serverId: value.serverId,
        title: 'Interrupted directory publication',
        summary: `Startup found the ${journal.point} durable rename boundary. Starts and writes remain blocked.`,
        phase: 'recovery-required',
        automaticPossible: true,
        actions: [{ actionId: 'recover-safely', label: 'Recover safely', recommended: true }]
      }];
    }
    save(value);
  }

  const recoveryService = {
    async listRecovery() { return clone(scenario().recovery); },
    async recover({ recoveryId, actionId }) {
      if (recoveryId !== 'recovery-directory-swap' || actionId !== 'recover-safely') {
        throw new ModpackError('INVALID_REQUEST', 'The recovery action is not available.');
      }
      return update(value => {
        const journalFile = path.join(value.root, 'crash-journal.json');
        if (fs.existsSync(journalFile)) {
          const journal = readJson(journalFile);
          if (fs.existsSync(journal.rollback)) {
            fs.rmSync(journal.canonical, { recursive: true, force: true });
            fs.renameSync(journal.rollback, journal.canonical);
          }
          fs.rmSync(journal.candidate, { recursive: true, force: true });
          fs.rmSync(journal.rollback, { recursive: true, force: true });
          fs.rmSync(journalFile, { force: true });
        }
        value.recovery = [];
        value.recoveryRuns += 1;
        value.crashMarker = 'recovered';
        return { status: 'recovered', canonicalCount: fs.existsSync(value.serverRoot) ? 1 : 0, idempotent: true };
      });
    }
  };

  const notificationStore = {
    async list({ unreadOnly = false } = {}) {
      const items = scenario().notifications.filter(item => !unreadOnly || !item.read);
      return { items: clone(items) };
    },
    async acknowledge(notificationId) {
      return update(value => {
        const item = value.notifications.find(entry => entry.notificationId === notificationId);
        if (item) item.read = true;
        return item ? clone(item) : null;
      });
    }
  };
  const releaseMonitor = {
    async start() { record('lifecycleCalls', { method: 'releaseMonitor.start' }); },
    stop() { record('lifecycleCalls', { method: 'releaseMonitor.stop' }); },
    async checkAll() { return { checked: 1, updates: 1 }; },
    async checkOne(trackingId) { return { trackingId, status: 'update-available' }; }
  };
  const releaseTrackingRecords = [];
  const releaseTrackingStore = {
    async upsert(value) {
      const index = releaseTrackingRecords.findIndex(record => record.trackingId === value.trackingId);
      if (index >= 0) releaseTrackingRecords[index] = clone(value);
      else releaseTrackingRecords.push(clone(value));
      return clone(value);
    },
    async list() { return clone(releaseTrackingRecords); }
  };
  const outcomeActionService = {
    async performSafeAction(request) {
      record('safeActions', request);
      const matchingJob = [...jobs.values()].find(entry => entry.job?.outcome?.actions?.some(action =>
        action.actionId === request.actionId && action.opaqueRef === request.opaqueRef));
      const targetIds = {
        'change-selection': SERVER_ID,
        'open-details': matchingJob?.job?.jobId || SERVER_ID,
        'choose-another-asset': SERVER_ID,
        'return-to-server': SERVER_ID,
        'review-restore-point': 'restore-point-v1',
        'review-recovery': 'recovery-directory-swap'
      };
      const destinationKinds = {
        'change-selection': 'selection',
        'open-details': 'details',
        'choose-another-asset': 'asset-selection',
        'return-to-server': 'server',
        'review-restore-point': 'restore-point',
        'review-recovery': 'recovery'
      };
      let result;
      if (destinationKinds[request.actionId]) {
        result = {
          type: 'outcome-action-result',
          actionId: request.actionId,
          status: 'ready',
          destination: { kind: destinationKinds[request.actionId], targetId: targetIds[request.actionId] }
        };
      } else if (request.actionId === 'open-retained-download-folder') {
        result = {
          type: 'outcome-action-result', actionId: request.actionId, status: 'opened',
          destination: { kind: 'controlled-cache-parent' }
        };
      } else if (request.actionId === 'remove-retained-download') {
        result = { type: 'outcome-action-result', actionId: request.actionId, status: 'removed', removed: true };
      } else {
        result = {
          type: 'outcome-action-result', actionId: request.actionId, status: 'started',
          operationRef: matchingJob?.job?.jobId || 'job-safe-action'
        };
      }
      record('safeActionResults', result);
      return result;
    }
  };
  const destinationReservationService = {
    async reserveWithNativeDialog() {
      const selection = await input.dialog.showOpenDialog({
        title: 'Choose an empty destination for the new modpack server',
        properties: ['openDirectory', 'createDirectory']
      });
      if (selection?.canceled || !Array.isArray(selection?.filePaths) || selection.filePaths.length !== 1) return null;
      const serverPath = path.resolve(selection.filePaths[0]);
      const displayName = path.basename(serverPath) || 'New modpack server';
      destinationReservations.set(SERVER_ID, { serverPath, displayName });
      return { instanceId: SERVER_ID, displayName };
    }
  };

  return {
    providers,
    localArtifactSource,
    lifecycleService,
    recoveryService,
    notificationStore,
    releaseMonitor,
    releaseTrackingStore,
    outcomeActionService,
    destinationReservationService,
    async initialize() { initializeRecoveryFixture(); },
    async dispose() {}
  };
}

module.exports = {
  FIXED_TIME,
  PROJECT_ROOT,
  SERVER_ID,
  createIpcOverrides,
  createExclusivePackagedEnvironment,
  createModpackFactory,
  createRecoveryFactory,
  launchModpackApp,
  prepareProfile,
  runDeterministicModpackLifecycleEvidence,
  runPackagedModpackSmoke
};
