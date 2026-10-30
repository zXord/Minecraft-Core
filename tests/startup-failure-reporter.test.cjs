const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  DATA_SAFETY_LINE,
  FATAL_DIALOG_BUTTONS,
  RELEASES_DOWNLOAD_URL,
  UPDATE_CHECK_TIMEOUT_MS,
  UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  createFatalStartupReporter,
  describeStartupFailure,
  runStandaloneUpdate
} = require('../electron/utils/startup-failure-reporter.cjs');
const startupHealth = require('../electron/bootstrap/startup-health.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');

const USER_DATA = 'C:\\Users\\fixture\\AppData\\Roaming\\Minecraft Core';
const WORKER = 'C:\\Program Files\\Minecraft Core\\resources\\archive\\worker\\ArchiveWorker.exe';
const LOG_DIRECTORY = `${USER_DATA}\\logs`;
const DATA_URL_PREFIX = 'data:text/html;charset=utf-8,';

function spawnFailure(code) {
  const error = new Error(`spawnSync ${WORKER} ${code}`);
  error.code = code;
  error.syscall = `spawnSync ${WORKER}`;
  error.path = WORKER;
  return error;
}

function recoveryChain(innermost, { extractor = true } = {}) {
  const inner = extractor
    ? new ModpackError('EXTRACTOR_UNAVAILABLE', 'The protected archive worker is unavailable', { cause: innermost })
    : innermost;
  const commit = new ModpackError('COMMIT_FAILED', 'Durable filesystem operation failed', { cause: inner });
  return new ModpackError('RECOVERY_REQUIRED', 'Startup recovery services could not be composed safely', { cause: commit });
}

function describe(error, { userDataPath = USER_DATA, workerPath = WORKER, workerExists = true } = {}) {
  return describeStartupFailure(error, { userDataPath, workerPath, existsSync: candidate => {
    assert.equal(candidate, workerPath);
    return workerExists;
  } });
}

function pageText(url) {
  assert.ok(url.startsWith(DATA_URL_PREFIX), url);
  return decodeURIComponent(url.slice(DATA_URL_PREFIX.length));
}

function scriptedDialog(fatalResponses, { onNotice = null } = {}) {
  const calls = [];
  return {
    calls,
    async showMessageBox(...args) {
      const [parent, options] = args.length >= 2 ? args : [null, args[0]];
      calls.push({ kind: 'message-box', parent, options });
      if (options.buttons?.length === FATAL_DIALOG_BUTTONS.length) {
        return { response: fatalResponses.length ? fatalResponses.shift() : FATAL_DIALOG_BUTTONS.indexOf('Quit') };
      }
      if (options.signal) {
        // Electron keeps the box open until the user answers or the signal
        // aborts, which closes it as if the user had cancelled it.
        return new Promise(resolve => {
          const cancel = () => resolve({ response: options.cancelId });
          if (options.signal.aborted) cancel();
          else options.signal.addEventListener('abort', cancel, { once: true });
          onNotice?.(response => resolve({ response }));
        });
      }
      return { response: 0 };
    },
    showErrorBox(title, content) {
      calls.push({ kind: 'error-box', title, content });
    }
  };
}

function fakeShell(events = []) {
  return {
    events,
    async openExternal(url) { events.push(['open-external', url]); },
    async openPath(target) { events.push(['open-path', target]); return ''; }
  };
}

function readyApp(ready = true) {
  return { isReady: () => ready };
}

function fakeSplash(events = []) {
  return {
    events,
    isDestroyed: () => false,
    loadURL(url) { events.push(['load', pageText(url)]); return Promise.resolve(); },
    setProgressBar(value) { events.push(['progress', value]); }
  };
}

class FakeUpdateService extends EventEmitter {
  constructor({ capability = { allowed: true }, check, download } = {}) {
    super();
    this.calls = [];
    this.capability = capability;
    this.check = check;
    this.download = download;
  }

  getInstallCapability() {
    this.calls.push('capability');
    if (this.capability instanceof Error) throw this.capability;
    return this.capability;
  }

  async checkForUpdates() {
    this.calls.push('check');
    return this.check;
  }

  async downloadUpdate(options) {
    this.calls.push(['download', options]);
    return this.download(this, options);
  }
}

function availableUpdate(download) {
  return new FakeUpdateService({
    check: { success: true, updateAvailable: true, currentVersion: '26.11.1', latestVersion: '26.12.1' },
    download
  });
}

function emitDownloaded(service) {
  service.emit('download-progress', { percent: 12.4 });
  service.emit('download-progress', { percent: 13 });
  service.emit('download-progress', { percent: 100 });
  service.emit('update-downloaded', { version: '26.12.1' });
  return { success: true, message: 'Download started' };
}

// An updater that started downloading and then never reports anything again.
function stalledDownload() {
  return new Promise(() => {});
}

// Lets real setImmediate callbacks and promise jobs run while only setTimeout is mocked.
async function settle(rounds = 8) {
  for (let round = 0; round < rounds; round += 1) await new Promise(resolve => setImmediate(resolve));
}

function track(promise) {
  const state = { settled: false, value: undefined };
  promise.then(value => { state.settled = true; state.value = value; });
  return state;
}

function assertUpdateListenersRemoved(service) {
  for (const name of ['download-progress', 'update-downloaded', 'update-error']) {
    assert.equal(service.listenerCount(name), 0, `${name} listener removed`);
  }
}

test('the reporter re-exports the health model describeStartupFailure', () => {
  assert.equal(describeStartupFailure, startupHealth.describeStartupFailure);
});

test('describeStartupFailure maps a quarantined worker, a blocked worker, a network profile and anything else', () => {
  const missing = describe(recoveryChain(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })), { workerExists: false });
  assert.equal(missing.reason, 'archive-worker-missing');
  assert.match(missing.summary, /ArchiveWorker\.exe/u);
  assert.match(missing.hint, /reinstall/iu);

  assert.equal(describe(recoveryChain(new Error('manifest digest mismatch')), { workerExists: true }).reason,
    'archive-worker-blocked');
  for (const code of ['EACCES', 'EPERM']) {
    assert.equal(describe(recoveryChain(spawnFailure(code), { extractor: false }), { workerExists: true }).reason,
      'archive-worker-blocked', code);
  }

  const share = describe(recoveryChain(new Error('allowed root rejected'), { extractor: false }), {
    userDataPath: '\\\\fileserver\\profiles$\\fixture\\AppData\\Roaming\\Minecraft Core'
  });
  assert.equal(share.reason, 'profile-on-network-share');
  assert.equal(describe(new Error('x'), { userDataPath: '\\\\?\\UNC\\fileserver\\profiles\\Minecraft Core' }).reason,
    'profile-on-network-share');
  assert.equal(describe(new Error('x'), { userDataPath: '\\\\?\\C:\\Users\\fixture\\Minecraft Core' }).reason, 'unexpected');

  const unexpected = describe(new TypeError('composition bug'));
  assert.equal(unexpected.reason, 'unexpected');
  assert.equal(unexpected.stage, null);
  for (const description of [missing, share, unexpected]) {
    assert.deepEqual(Object.keys(description), ['stage', 'reason', 'summary', 'hint', 'technical']);
    assert.equal(Object.isFrozen(description), true);
    for (const field of ['summary', 'hint', 'technical']) {
      assert.equal(typeof description[field], 'string');
      assert.notEqual(description[field].length, 0);
    }
  }
});

test('without a known worker path an ENOENT under EXTRACTOR_UNAVAILABLE still reads as a missing worker', () => {
  assert.equal(describeStartupFailure(recoveryChain(Object.assign(new Error('gone'), { code: 'ENOENT' }))).reason,
    'archive-worker-missing');
  assert.equal(describeStartupFailure(recoveryChain(new Error('hash mismatch'))).reason, 'archive-worker-blocked');
  assert.equal(describeStartupFailure(recoveryChain(new Error('x')), {
    workerPath: WORKER,
    existsSync() { throw new Error('EPERM'); }
  }).reason, 'archive-worker-blocked');
});

test('the technical chain names each cause in order, stays on one line and is bounded', () => {
  const description = describe(recoveryChain(spawnFailure('EACCES')), { workerExists: true });
  assert.match(description.technical,
    /^ModpackError RECOVERY_REQUIRED: Startup recovery services could not be composed safely <- ModpackError COMMIT_FAILED: Durable filesystem operation failed <- ModpackError EXTRACTOR_UNAVAILABLE: The protected archive worker is unavailable <- Error EACCES: spawnSync /u);
  assert.doesNotMatch(description.technical, /[\r\n]/u);

  const noisy = new Error(`line one\nline two ${'x'.repeat(5000)}`);
  const bounded = describe(noisy);
  assert.doesNotMatch(bounded.technical, /[\r\n]/u);
  assert.ok(bounded.technical.length <= 2000, String(bounded.technical.length));
  assert.equal(describe('plain string failure').technical, 'plain string failure');
});

test('the cause walk stops after eight levels and survives cycles and hostile getters', () => {
  let deep = new ModpackError('EXTRACTOR_UNAVAILABLE', 'The protected archive worker is unavailable');
  for (let index = 0; index < 9; index += 1) deep = new Error(`wrapper ${index}`, { cause: deep });
  assert.equal(describe(deep, { workerExists: false }).reason, 'unexpected');

  let shallow = new ModpackError('EXTRACTOR_UNAVAILABLE', 'The protected archive worker is unavailable');
  for (let index = 0; index < 8; index += 1) shallow = new Error(`wrapper ${index}`, { cause: shallow });
  assert.equal(describe(shallow, { workerExists: false }).reason, 'archive-worker-missing');

  const cyclic = new Error('cyclic');
  cyclic.cause = cyclic;
  assert.equal(describe(cyclic).reason, 'unexpected');

  const hostile = {};
  Object.defineProperty(hostile, 'cause', { get() { throw new Error('hostile cause'); } });
  Object.defineProperty(hostile, 'code', { get() { throw new Error('hostile code'); } });
  Object.defineProperty(hostile, 'message', { get() { throw new Error('hostile message'); } });
  assert.equal(describe(hostile).reason, 'unexpected');
  assert.equal(describe(null).reason, 'unexpected');
});

test('the fatal dialog loop checks for updates, reports that none is available, then quits', async () => {
  const dialog = scriptedDialog([0, 3]);
  const splashEvents = [];
  const service = new FakeUpdateService({
    check: { success: true, updateAvailable: false, currentVersion: '26.11.1', latestVersion: '26.11.1' }
  });
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(),
    app: readyApp(),
    getUpdateService: () => service,
    logDirectory: LOG_DIRECTORY,
    interactive: true,
    userDataPath: USER_DATA,
    workerPath: WORKER,
    existsSync: () => false
  });
  const splash = fakeSplash(splashEvents);

  const outcome = await reporter.report(recoveryChain(Object.assign(new Error('gone'), { code: 'ENOENT' })), { splash });

  assert.equal(outcome, 'quit');
  assert.deepEqual(dialog.calls.map(call => call.options.type), ['error', 'info', 'error']);
  const [first, info, second] = dialog.calls;
  assert.equal(first.parent, splash, 'the fatal dialog is modal to the splash');
  assert.equal(first.options.title, 'Minecraft Core could not start');
  assert.match(first.options.message, /ArchiveWorker\.exe/u);
  assert.deepEqual(first.options.buttons, ['Check for updates', 'Open download page', 'Open log folder', 'Quit']);
  assert.equal(first.options.defaultId, 0);
  assert.equal(first.options.cancelId, 3);
  assert.equal(first.options.noLink, true);
  assert.ok(first.options.detail.includes(DATA_SAFETY_LINE), first.options.detail);
  assert.equal(DATA_SAFETY_LINE, 'Your servers, clients, worlds and settings were not changed.');
  assert.ok(first.options.detail.includes('EXTRACTOR_UNAVAILABLE'), 'the technical chain is shown');
  assert.ok(first.options.detail.includes(LOG_DIRECTORY), 'the log path is shown');
  assert.equal(info.parent, splash);
  assert.match(info.options.message, /No newer version is available yet/u);
  assert.equal(second.options.title, 'Minecraft Core could not start');
  assert.deepEqual(service.calls, ['capability', 'check']);
  assert.ok(splashEvents.some(([kind, text]) => kind === 'load' && text.includes('Minecraft Core could not start')));
  assert.ok(splashEvents.some(([kind, text]) => kind === 'load' && text.includes('Checking for updates')));
});

test('an available update downloads with progress on the splash and ends the dialog loop as installing', async () => {
  const dialog = scriptedDialog([0]);
  const splashEvents = [];
  const service = availableUpdate(emitDownloaded);
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(),
    app: readyApp(),
    getUpdateService: () => service,
    logDirectory: LOG_DIRECTORY,
    interactive: true,
    now: () => 0
  });

  const outcome = await reporter.report(new Error('composition failed'), { splash: fakeSplash(splashEvents) });

  assert.equal(outcome, 'installing');
  assert.equal(dialog.calls.length, 1, 'no further dialog once the installer takes over');
  assert.deepEqual(service.calls, ['capability', 'check', ['download', { installAfterDownload: true }]]);
  const pages = splashEvents.filter(([kind]) => kind === 'load').map(([, text]) => text);
  assert.ok(pages.some(text => text.includes('Downloading Minecraft Core 26.12.1') && text.includes('12%')), pages.join('\n'));
  assert.equal(pages.some(text => text.includes('13%')), false, 'progress pages are throttled');
  assert.ok(pages.some(text => text.includes('100%')));
  assert.ok(pages.some(text => text.includes('Installing the update')));
  const progress = splashEvents.filter(([kind]) => kind === 'progress').map(([, value]) => value);
  assert.ok(progress.includes(0.12), progress.join(','));
  assert.ok(progress.includes(1));
  for (const name of ['download-progress', 'update-downloaded', 'update-error']) {
    assert.equal(service.listenerCount(name), 0, `${name} listener removed`);
  }
});

test('the download page and log folder buttons act and return to the dialog until Quit', async () => {
  const shellEvents = [];
  const dialog = scriptedDialog([1, 2, 3]);
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(shellEvents),
    app: readyApp(),
    getUpdateService: () => { throw new Error('update service must not be loaded'); },
    logDirectory: LOG_DIRECTORY,
    interactive: true
  });

  assert.equal(await reporter.report(new Error('failed')), 'quit');
  assert.equal(RELEASES_DOWNLOAD_URL, 'https://github.com/zXord/Minecraft-Core/releases/latest');
  assert.deepEqual(shellEvents, [['open-external', RELEASES_DOWNLOAD_URL], ['open-path', LOG_DIRECTORY]]);
  assert.equal(dialog.calls.length, 3);
  assert.equal(dialog.calls[0].parent, null, 'without a splash the dialog has no parent');
});

test('an unavailable update service is explained and the dialog loop continues', async () => {
  const dialog = scriptedDialog([0, 3]);
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(),
    app: readyApp(),
    getUpdateService: () => { throw new Error('update module failed to load'); },
    logDirectory: LOG_DIRECTORY,
    interactive: true
  });

  assert.equal(await reporter.report(new Error('failed')), 'quit');
  assert.deepEqual(dialog.calls.map(call => call.options.type), ['error', 'info', 'error']);
  assert.match(dialog.calls[1].options.message, /could not check for updates/iu);
});

test('a main window that already exists is hidden before the fatal dialog appears', async () => {
  const events = [];
  const mainWindow = { isDestroyed: () => false, hide() { events.push('main:hide'); } };
  const dialog = scriptedDialog([3]);
  const original = dialog.showMessageBox;
  dialog.showMessageBox = async (...args) => { events.push('dialog'); return original(...args); };
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(),
    app: readyApp(),
    getUpdateService: () => null,
    logDirectory: LOG_DIRECTORY,
    interactive: true
  });

  await reporter.report(new Error('after-window hook failed'), { mainWindow });

  assert.deepEqual(events, ['main:hide', 'dialog']);
});

test('before Electron is ready the reporter uses a plain error box and quits', async () => {
  const dialog = scriptedDialog([]);
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(),
    app: readyApp(false),
    getUpdateService: () => { throw new Error('not before ready'); },
    logDirectory: LOG_DIRECTORY,
    interactive: true
  });

  assert.equal(await reporter.report(new Error('userData override failed')), 'quit');
  assert.equal(dialog.calls.length, 1);
  assert.equal(dialog.calls[0].kind, 'error-box');
  assert.equal(dialog.calls[0].title, 'Minecraft Core could not start');
  assert.ok(dialog.calls[0].content.includes(DATA_SAFETY_LINE));
  assert.ok(dialog.calls[0].content.includes(LOG_DIRECTORY));
  assert.ok(dialog.calls[0].content.includes(RELEASES_DOWNLOAD_URL));
});

test('non-interactive mode logs, sets a failing exit code and returns without any dialog', async () => {
  const logged = [];
  const processLike = { exitCode: undefined };
  const reporter = createFatalStartupReporter({
    interactive: false,
    logger: { error(...args) { logged.push(args); } },
    processLike,
    userDataPath: USER_DATA,
    workerPath: WORKER,
    existsSync: () => false
  });
  const mainWindow = { isDestroyed: () => false, hide() { logged.push('hide'); } };

  const outcome = await reporter.report(recoveryChain(Object.assign(new Error('gone'), { code: 'ENOENT' })), { mainWindow });

  assert.equal(outcome, 'quit');
  assert.equal(processLike.exitCode, 1);
  assert.equal(logged[0], 'hide');
  assert.equal(logged.length, 2);
  assert.match(String(logged[1][0]), /could not start/iu);
  assert.ok(JSON.stringify(logged[1]).includes('archive-worker-missing'));
});

test('an interactive reporter requires the Electron dialog, shell and app APIs', () => {
  const complete = {
    dialog: scriptedDialog([]),
    shell: fakeShell(),
    app: readyApp(),
    getUpdateService: () => null,
    logDirectory: LOG_DIRECTORY,
    interactive: true
  };
  assert.doesNotThrow(() => createFatalStartupReporter(complete));
  for (const missing of ['dialog', 'shell', 'app', 'getUpdateService']) {
    assert.throws(() => createFatalStartupReporter({ ...complete, [missing]: undefined }), TypeError, missing);
  }
  assert.throws(() => createFatalStartupReporter({ ...complete, interactive: 'yes' }), TypeError);
});

test('runStandaloneUpdate resolves installing after update-downloaded and reports each phase', async () => {
  const statuses = [];
  const service = availableUpdate(emitDownloaded);

  const result = await runStandaloneUpdate({ updateService: service, onStatus: status => statuses.push(status) });

  assert.deepEqual(result, { status: 'installing', version: '26.12.1', message: result.message });
  assert.match(result.message, /restart/iu);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(statuses.map(status => status.phase), [
    'checking', 'downloading', 'downloading', 'downloading', 'downloading', 'installing'
  ]);
  assert.deepEqual(statuses.filter(status => status.phase === 'downloading').map(status => status.percent), [0, 12, 13, 100]);
  for (const name of ['download-progress', 'update-downloaded', 'update-error']) {
    assert.equal(service.listenerCount(name), 0);
  }
});

test('runStandaloneUpdate refuses a copy that is not the installed app before any check', async () => {
  const denied = new FakeUpdateService({ capability: { allowed: false, message: 'This copy of Minecraft Core is not the installed app.' } });
  const deniedResult = await runStandaloneUpdate({ updateService: denied });
  assert.equal(deniedResult.status, 'not-installed-copy');
  assert.equal(deniedResult.message, 'This copy of Minecraft Core is not the installed app.');
  assert.deepEqual(denied.calls, ['capability']);

  for (const capability of [{ installed: false, reason: 'not-installed-copy' }, null, new Error('identity failed')]) {
    const service = new FakeUpdateService({ capability });
    const result = await runStandaloneUpdate({ updateService: service });
    assert.equal(result.status, 'not-installed-copy');
    assert.equal(service.calls.includes('check'), false);
  }

  const legacy = new FakeUpdateService();
  legacy.getInstallCapability = undefined;
  const legacyResult = await runStandaloneUpdate({ updateService: legacy });
  assert.equal(legacyResult.status, 'not-installed-copy', 'a service without the identity API counts as not installed');
  assert.match(legacyResult.message, /download/iu);

  const installed = new FakeUpdateService({
    capability: { installed: true, reason: 'uninstaller-present' },
    check: { success: true, updateAvailable: false }
  });
  assert.equal((await runStandaloneUpdate({ updateService: installed })).status, 'no-update');
});

test('runStandaloneUpdate reports check, download and refused-install failures without hanging', async () => {
  const unavailable = await runStandaloneUpdate({ updateService: null });
  assert.equal(unavailable.status, 'update-unavailable');

  const failedCheck = new FakeUpdateService({ check: { success: false, error: 'Unable to connect to the update server.' } });
  assert.deepEqual(await runStandaloneUpdate({ updateService: failedCheck }), {
    status: 'check-failed', message: 'Unable to connect to the update server.'
  });

  const busy = new FakeUpdateService({ check: { checking: true } });
  assert.equal((await runStandaloneUpdate({ updateService: busy })).status, 'check-failed');

  const failedDownload = availableUpdate(() => ({ success: false, error: 'Download failed: ECONNRESET' }));
  assert.deepEqual(await runStandaloneUpdate({ updateService: failedDownload }), {
    status: 'download-failed', message: 'Download failed: ECONNRESET', version: '26.12.1'
  });

  const erroredDownload = availableUpdate(service => {
    service.emit('update-error', { title: 'Network Connection Error', message: 'Unable to connect to the update server.' });
    return { success: false, error: 'net::ERR_INTERNET_DISCONNECTED' };
  });
  assert.equal((await runStandaloneUpdate({ updateService: erroredDownload })).message, 'Unable to connect to the update server.');

  const refusedInstall = availableUpdate(service => {
    service.emit('update-downloaded', { version: '26.12.1' });
    service.emit('update-error', { title: 'Cannot Install Update', message: 'A Minecraft server is running.' });
    return { success: true };
  });
  assert.deepEqual(await runStandaloneUpdate({ updateService: refusedInstall }), {
    status: 'install-refused', message: 'A Minecraft server is running.', version: '26.12.1'
  });

  const thrownDownload = availableUpdate(() => { throw new Error('autoUpdater exploded'); });
  assert.equal((await runStandaloneUpdate({ updateService: thrownDownload })).status, 'download-failed');
  for (const service of [refusedInstall, thrownDownload, erroredDownload]) {
    assert.equal(service.listenerCount('update-error'), 0);
  }
});

test('runStandaloneUpdate ends a download the updater stops reporting on after the idle bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = availableUpdate(stalledDownload);
  const result = track(runStandaloneUpdate({ updateService: service }));
  await settle();
  assert.deepEqual(service.calls, ['capability', 'check', ['download', { installAfterDownload: true }]]);

  t.mock.timers.tick(UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS - 1);
  await settle();
  assert.equal(result.settled, false, 'the wait is not cut short');

  t.mock.timers.tick(1);
  await settle();
  assert.equal(result.settled, true, 'the download wait is bounded');
  assert.deepEqual(result.value, { status: 'download-timed-out', message: result.value.message, version: '26.12.1' });
  assert.match(result.value.message, /did not finish downloading/u);
  assert.match(result.value.message, /Open download page/u);
  assertUpdateListenersRemoved(service);
});

test('download progress extends the idle bound, but the overall bound still ends the wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = availableUpdate(stalledDownload);
  const result = track(runStandaloneUpdate({ updateService: service }));
  await settle();
  const step = UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS - 1000;
  let elapsed = 0;
  let percent = 0;
  while (elapsed + step < UPDATE_DOWNLOAD_TIMEOUT_MS) {
    t.mock.timers.tick(step);
    elapsed += step;
    percent += 1;
    service.emit('download-progress', { percent });
    await settle();
    assert.equal(result.settled, false, `a download still reporting progress after ${elapsed} ms keeps going`);
  }
  assert.ok(elapsed > UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS, 'the download outlived one idle bound');

  t.mock.timers.tick(UPDATE_DOWNLOAD_TIMEOUT_MS - elapsed - 1);
  await settle();
  assert.equal(result.settled, false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(result.value.status, 'download-timed-out');
  assertUpdateListenersRemoved(service);
});

test('an update check that never answers ends after its bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = new FakeUpdateService();
  service.checkForUpdates = () => {
    service.calls.push('check');
    return new Promise(() => {});
  };
  const result = track(runStandaloneUpdate({ updateService: service }));
  await settle();

  t.mock.timers.tick(UPDATE_CHECK_TIMEOUT_MS - 1);
  await settle();
  assert.equal(result.settled, false);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(result.value, { status: 'check-timed-out', message: result.value.message });
  assert.match(result.value.message, /Open download page/u);
  assert.deepEqual(service.calls, ['capability', 'check']);
});

test('a stalled download over the splash returns to the fatal dialog, so the download page and Quit stay available', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dialog = scriptedDialog([0, 3]);
  const splashEvents = [];
  const splash = fakeSplash(splashEvents);
  const service = availableUpdate(stalledDownload);
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(),
    app: readyApp(),
    getUpdateService: () => service,
    logDirectory: LOG_DIRECTORY,
    interactive: true,
    now: () => 0
  });

  const outcome = track(reporter.report(new Error('composition failed'), { splash }));
  await settle();
  assert.equal(outcome.settled, false);
  assert.equal(dialog.calls.length, 1, 'the splash shows the download, so no notice opens');

  t.mock.timers.tick(UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS);
  await settle();

  assert.equal(outcome.value, 'quit');
  assert.deepEqual(dialog.calls.map(call => call.options.type), ['error', 'info', 'error']);
  assert.equal(dialog.calls[1].parent, splash);
  assert.match(dialog.calls[1].options.message, /did not finish downloading/u);
  assert.deepEqual(dialog.calls[2].options.buttons, [...FATAL_DIALOG_BUTTONS], 'the fatal dialog is offered again');
  const pages = splashEvents.filter(([kind]) => kind === 'load').map(([, text]) => text);
  assert.ok(pages.some(text => text.includes('Downloading Minecraft Core 26.12.1')), pages.join('\n'));
  assert.ok(pages.at(-1).includes('Minecraft Core could not start'), 'the splash shows the failure again');
  assertUpdateListenersRemoved(service);
});

test('without a visible window a notice shows the update is under way and closes itself when the wait ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hiddenSplash = { ...fakeSplash(), isVisible: () => false };
  for (const splash of [null, hiddenSplash]) {
    const dialog = scriptedDialog([0, 3]);
    const service = availableUpdate(stalledDownload);
    const reporter = createFatalStartupReporter({
      dialog,
      shell: fakeShell(),
      app: readyApp(),
      getUpdateService: () => service,
      logDirectory: LOG_DIRECTORY,
      interactive: true
    });

    const outcome = track(reporter.report(new Error('main import failed'), { splash }));
    await settle();

    assert.equal(outcome.settled, false);
    assert.equal(dialog.calls.length, 2);
    const notice = dialog.calls[1];
    assert.equal(notice.parent, null, 'the notice needs no window');
    assert.equal(notice.options.title, 'Minecraft Core could not start');
    assert.match(notice.options.message, /checking for updates/iu);
    assert.match(notice.options.detail, /Quit/u);
    assert.deepEqual(notice.options.buttons, ['Quit']);
    assert.equal(notice.options.cancelId, 0);
    assert.equal(notice.options.signal.aborted, false, 'the notice stays open while the update runs');

    t.mock.timers.tick(UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS);
    await settle();

    assert.equal(notice.options.signal.aborted, true, 'the notice closes itself once the wait ends');
    assert.equal(outcome.value, 'quit');
    assert.deepEqual(dialog.calls.map(call => call.options.type), ['error', 'info', 'info', 'error']);
    assert.match(dialog.calls[2].options.message, /did not finish downloading/u);
    assert.deepEqual(dialog.calls[3].options.buttons, [...FATAL_DIALOG_BUTTONS]);
    assertUpdateListenersRemoved(service);
  }
});

test('without a visible window, Quit on the update notice ends the report at once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answerNotice = null;
  const dialog = scriptedDialog([0], { onNotice: answer => { answerNotice = answer; } });
  const service = availableUpdate(stalledDownload);
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(),
    app: readyApp(),
    getUpdateService: () => service,
    logDirectory: LOG_DIRECTORY,
    interactive: true
  });

  const outcome = track(reporter.report(new Error('main import failed')));
  await settle();
  assert.equal(typeof answerNotice, 'function', 'the notice is open');
  assert.equal(outcome.settled, false);

  answerNotice(0);
  await settle();

  assert.equal(outcome.value, 'quit');
  assert.equal(dialog.calls.length, 2, 'no further dialog after Quit');
});

test('without a visible window a downloaded update still hands over to the installer and closes the notice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dialog = scriptedDialog([0]);
  const service = availableUpdate(emitDownloaded);
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(),
    app: readyApp(),
    getUpdateService: () => service,
    logDirectory: LOG_DIRECTORY,
    interactive: true
  });

  assert.equal(await reporter.report(new Error('main import failed')), 'installing');

  assert.equal(dialog.calls.length, 2);
  assert.deepEqual(dialog.calls[1].options.buttons, ['Quit']);
  assert.equal(dialog.calls[1].options.signal.aborted, true, 'the notice is closed for the installer');
  assertUpdateListenersRemoved(service);
});

test('without a visible window no notice opens when no update check starts', async () => {
  const dialog = scriptedDialog([0, 3]);
  const service = new FakeUpdateService({ capability: { allowed: false, message: 'This copy of Minecraft Core is not the installed app.' } });
  const reporter = createFatalStartupReporter({
    dialog,
    shell: fakeShell(),
    app: readyApp(),
    getUpdateService: () => service,
    logDirectory: LOG_DIRECTORY,
    interactive: true
  });

  assert.equal(await reporter.report(new Error('main import failed')), 'quit');

  assert.deepEqual(dialog.calls.map(call => call.options.type), ['error', 'info', 'error']);
  assert.equal(dialog.calls[1].options.message, 'This copy of Minecraft Core is not the installed app.');
  assert.equal(dialog.calls.some(call => call.options.signal), false);
});
