const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const { createStartupHealth, describeStartupFailure } = require('../electron/bootstrap/startup-health.cjs');

// A5/A44: a start with modpack services turned off must open the app with a
// banner that says what happened, that nothing was changed, and how to get a
// fixed version, in the server and the client views alike.
const ROOT = path.resolve(__dirname, '..');
const BANNER_PATH = path.join(ROOT, 'src', 'components', 'common', 'StartupHealthBanner.svelte');
const APP_PATH = path.join(ROOT, 'src', 'App.svelte');
const DATA_SAFETY_LINE = 'Your servers, clients and worlds were not changed.';
const WORKER_PATH = 'C:\\Program Files\\Minecraft Core\\resources\\archive\\worker\\ArchiveWorker.exe';

function readBanner() {
  return fs.readFileSync(BANNER_PATH, 'utf8');
}

function moduleUrl(specifier) {
  return pathToFileURL(require.resolve(specifier)).href;
}

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

let bannerPromise = null;

// Compiles the real banner for server rendering, with its relative imports
// resolved against the source tree.
function loadBanner() {
  bannerPromise ??= (async () => {
    const { compile } = await import('svelte/compiler');
    const code = compile(readBanner(), { filename: BANNER_PATH, generate: 'server', dev: false }).js.code
      .replace(/^(\s*import\b[^'\n]*?from\s*)'([^']+)'/gmu, (match, head, specifier) => {
        if (specifier === 'svelte' || specifier.startsWith('svelte/')) return `${head}'${moduleUrl(specifier)}'`;
        if (specifier.startsWith('.')) {
          return `${head}'${pathToFileURL(path.resolve(path.dirname(BANNER_PATH), specifier)).href}'`;
        }
        return match;
      });
    const [{ default: Component }, { render }] = await Promise.all([import(dataUrl(code)), import('svelte/server')]);
    return { Component, render };
  })();
  return bannerPromise;
}

function decodeHtml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

async function renderBanner(health) {
  const { Component, render } = await loadBanner();
  return decodeHtml(render(Component, { props: { health } }).body);
}

function workerFailure(stage = 'recovery') {
  const unavailable = Object.assign(new Error('The protected archive worker is unavailable'), {
    code: 'EXTRACTOR_UNAVAILABLE'
  });
  return describeStartupFailure(unavailable, { workerPath: WORKER_PATH, existsSync: () => false, stage });
}

function blockedWorkerFailure(stage = 'recovery') {
  const blocked = Object.assign(new Error('spawn EACCES'), { code: 'EACCES', syscall: 'spawn' });
  return describeStartupFailure(blocked, { workerPath: WORKER_PATH, existsSync: () => true, stage });
}

function readyHealth(issues = []) {
  return createStartupHealth({
    status: 'ready',
    modpackServices: 'ready',
    recoveryGate: { basis: 'boundary', globalBlock: false, blockedServers: [] },
    issues
  });
}

function degradedHealth({ failure = workerFailure(), recoveryGate, issues = [] } = {}) {
  return createStartupHealth({
    status: 'degraded',
    modpackServices: 'unavailable',
    legacyFallbacks: 'active',
    failure,
    recoveryGate: recoveryGate ?? { basis: 'no-recovery-records', globalBlock: false, blockedServers: [] },
    issues
  });
}

// Lifts the banner's own declarations out of its script so its actions run
// against stubbed IPC. Imports, the prop, reactive statements and lifecycle
// registrations stay behind.
async function loadBannerActions({ invoke, clipboard = null, health = null }) {
  const { parse } = await import('svelte/compiler');
  const source = readBanner();
  const declarations = parse(source, { modern: true }).instance.content.body
    .filter(node => node.type === 'VariableDeclaration' || node.type === 'FunctionDeclaration')
    .map(node => source.slice(node.start, node.end));
  const calls = [];
  const listeners = new Map();
  const timers = [];
  const debugLogs = [];
  const fakeWindow = {
    electron: {
      async invoke(channel, ...args) {
        calls.push([channel, ...args]);
        return invoke(channel, ...args);
      },
      on(channel, listener) { listeners.set(channel, listener); },
      removeListener(channel, listener) {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      }
    }
  };
  const fakeLogger = { debug(message) { debugLogs.push(message); } };
  const factory = new Function('window', 'navigator', 'logger', 'setTimeout', 'clearTimeout', 'initialHealth', `
    let health = initialHealth;
    ${declarations.join('\n')}
    return {
      readHealth, checkForUpdates, downloadAndInstall, stopListeningForUpdateEvents, restartApp, openLogFolder, copyDetails,
      state: () => ({ health, updateState, updateVersion, updatePercent, statusMessage, statusIsError, restarting })
    };
  `);
  // A timer's id is its 1-based position in timers.
  const actions = factory(
    fakeWindow,
    { clipboard },
    fakeLogger,
    (callback, delay) => timers.push({ callback, delay, cleared: false }),
    id => {
      if (timers[id - 1]) timers[id - 1].cleared = true;
    },
    health
  );
  return {
    ...actions,
    calls,
    listeners,
    timers,
    debugLogs,
    emit(channel, payload) {
      const listener = listeners.get(channel);
      assert.equal(typeof listener, 'function', `${channel} is observed`);
      listener(payload);
    }
  };
}

test('the update flow checks, downloads with installAfterDownload, follows progress and hands over to the installer', async () => {
  const banner = await loadBannerActions({
    async invoke(channel) {
      if (channel === 'check-for-updates') {
        return { success: true, currentVersion: '26.11.1', updateAvailable: true, latestVersion: '26.11.2' };
      }
      if (channel === 'download-update') return { success: true, message: 'Download started' };
      throw new Error(`Unexpected IPC channel ${channel}`);
    }
  });

  await banner.checkForUpdates();
  assert.equal(banner.state().updateState, 'available');
  assert.equal(banner.state().updateVersion, '26.11.2');
  assert.equal(banner.state().statusMessage, 'Minecraft Core v26.11.2 is available.');
  assert.equal(banner.listeners.size, 0, 'nothing is observed before a download starts');

  await banner.downloadAndInstall();
  assert.deepEqual(banner.calls, [['check-for-updates'], ['download-update', { installAfterDownload: true }]]);
  banner.emit('update-download-progress', { percent: 42.7, bytesPerSecond: 1024, transferred: 427, total: 1000 });
  assert.equal(banner.state().updateState, 'downloading');
  assert.equal(banner.state().updatePercent, 42);

  banner.emit('update-downloaded', { version: '26.11.2' });
  assert.equal(banner.state().updateState, 'installing');
  assert.equal(banner.state().updatePercent, 100);

  // The update service refuses the install while servers run and says why.
  banner.emit('update-error', { message: 'Stop every running server, then install the update.' });
  assert.equal(banner.state().updateState, 'available', 'the update stays on offer');
  assert.equal(banner.state().statusMessage, 'Stop every running server, then install the update.');
  assert.equal(banner.state().statusIsError, true);

  banner.stopListeningForUpdateEvents();
  assert.equal(banner.listeners.size, 0);
});

// The download can finish without an install starting and without an error,
// for example when another download request turned the install off.
test('an install that never starts gives the update back with Restart usable again', async () => {
  const banner = await loadBannerActions({
    async invoke(channel) {
      if (channel === 'check-for-updates') return { success: true, updateAvailable: true, latestVersion: '26.11.2' };
      if (channel === 'download-update') return { success: true, message: 'Download started' };
      throw new Error(`Unexpected IPC channel ${channel}`);
    }
  });
  await banner.checkForUpdates();
  await banner.downloadAndInstall();
  banner.emit('update-downloaded', { version: '26.11.2' });
  assert.equal(banner.state().updateState, 'installing');
  assert.equal(banner.timers.length, 1, 'the install start is watched');
  const [installWait] = banner.timers;
  assert.ok(installWait.delay >= 15_000, 'the installer gets time to take over');

  installWait.callback();
  assert.equal(banner.state().updateState, 'available', 'Restart and the download are usable again');
  assert.equal(banner.state().statusMessage, 'The update was downloaded but did not start installing. Try again.');
  assert.equal(banner.state().statusIsError, true);

  // A refused install ends the wait at once, so its timer cannot cut a later
  // attempt short.
  await banner.downloadAndInstall();
  banner.emit('update-downloaded', { version: '26.11.2' });
  assert.equal(banner.state().updateState, 'installing');
  assert.equal(banner.timers.length, 2, 'the second attempt is watched by its own timer');
  banner.emit('update-error', { message: 'Stop every running server, then install the update.' });
  assert.equal(banner.state().updateState, 'available');
  assert.equal(banner.state().statusMessage, 'Stop every running server, then install the update.');
  assert.equal(banner.timers[1].cleared, true);
  assert.deepEqual(banner.calls, [
    ['check-for-updates'],
    ['download-update', { installAfterDownload: true }],
    ['download-update', { installAfterDownload: true }]
  ]);
});

test('update check outcomes and refused downloads are reported in the banner', async () => {
  const outcomes = [
    [{ success: true, updateAvailable: false, latestVersion: '26.11.1' }, 'No newer version is available yet.', false],
    [{ success: true, updateAvailable: false, developmentMode: true }, 'This development copy does not check for app updates.', false],
    [{ checking: true }, 'An update check is already running. Try again in a moment.', true],
    [{ success: false, error: 'Unable to connect to the update server.' }, 'Unable to connect to the update server.', true],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), 'net::ERR_INTERNET_DISCONNECTED', true]
  ];
  for (const [answer, message, isError] of outcomes) {
    const banner = await loadBannerActions({
      async invoke() {
        if (answer instanceof Error) throw answer;
        return answer;
      }
    });
    await banner.checkForUpdates();
    assert.equal(banner.state().updateState, 'idle', message);
    assert.equal(banner.state().statusMessage, message);
    assert.equal(banner.state().statusIsError, isError, message);
  }

  const refused = 'This copy of Minecraft Core is not the installed app, so it cannot install updates.';
  const banner = await loadBannerActions({
    async invoke(channel) {
      if (channel === 'check-for-updates') return { success: true, updateAvailable: true, latestVersion: '26.11.2' };
      return { success: false, code: 'NOT_INSTALLED_COPY', error: refused };
    }
  });
  await banner.checkForUpdates();
  await banner.downloadAndInstall();
  assert.equal(banner.state().updateState, 'available');
  assert.equal(banner.state().statusMessage, refused);
  assert.equal(banner.state().statusIsError, true);
});

test('restart, the log folder and copy details report their outcome in the banner', async () => {
  const health = degradedHealth();
  const restartRefused = await loadBannerActions({ health, async invoke() { return { success: false, error: 'Relaunch refused' }; } });
  await restartRefused.restartApp();
  assert.deepEqual(restartRefused.calls, [['startup:relaunch']]);
  assert.equal(restartRefused.state().restarting, false);
  assert.equal(restartRefused.state().statusMessage, 'Relaunch refused');

  const restarting = await loadBannerActions({ health, async invoke() { return { success: true }; } });
  await restarting.restartApp();
  assert.equal(restarting.state().restarting, true);
  assert.equal(restarting.state().statusMessage, 'Restarting Minecraft Core…');

  const logsRefused = await loadBannerActions({ health, async invoke() { return { success: false }; } });
  await logsRefused.openLogFolder();
  assert.deepEqual(logsRefused.calls, [['startup:open-logs']]);
  assert.equal(logsRefused.state().statusMessage, 'The log folder could not be opened.');
  const logsOpened = await loadBannerActions({ health, async invoke() { return { success: true }; } });
  await logsOpened.openLogFolder();
  assert.equal(logsOpened.state().statusMessage, '');

  const copied = [];
  const copy = await loadBannerActions({
    health,
    clipboard: { async writeText(text) { copied.push(text); } },
    async invoke() { throw new Error('no IPC expected'); }
  });
  await copy.copyDetails();
  assert.equal(copy.state().statusMessage, 'Details copied.');
  assert.match(copied[0], /^Minecraft Core startup health\nStatus: degraded\nModpack services: unavailable\n/u);
  assert.ok(copied[0].includes(`Problem: ${health.failure.summary}`));
  assert.ok(copied[0].includes(`Technical details: ${health.failure.technical}`));
  assert.ok(copied[0].includes('Recovery check: no-recovery-records; global block off; 0 blocked servers'));

  const copyRefused = await loadBannerActions({
    health,
    clipboard: { async writeText() { throw new Error('Document is not focused.'); } },
    async invoke() { throw new Error('no IPC expected'); }
  });
  await copyRefused.copyDetails();
  assert.equal(copyRefused.state().statusMessage, 'The details could not be copied.');
  assert.equal(copyRefused.state().statusIsError, true);
});

test('the health read keeps the reported snapshot and reads again only while startup is settling', async () => {
  const answers = [createStartupHealth(), degradedHealth()];
  const settling = await loadBannerActions({ async invoke() { return answers.shift(); } });
  await settling.readHealth();
  assert.equal(settling.state().health.status, 'starting');
  assert.equal(settling.timers.length, 1);
  settling.timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settling.state().health.status, 'degraded');
  assert.equal(settling.timers.length, 1, 'a settled snapshot is not read again');
  assert.deepEqual(settling.calls, [['startup:get-health'], ['startup:get-health']]);

  const unavailable = await loadBannerActions({ async invoke() { throw new Error('Channel not allowed: startup:get-health'); } });
  await unavailable.readHealth();
  assert.equal(unavailable.state().health, null);
  assert.equal(unavailable.debugLogs.length, 1);

  for (const answer of [null, { success: false, error: 'Unsupported in browser panel: startup:get-health' }]) {
    const ignored = await loadBannerActions({ async invoke() { return answer; } });
    await ignored.readHealth();
    assert.equal(ignored.state().health, null);
    assert.equal(ignored.timers.length, 0);
  }
});

test('the banner stays hidden for a ready start without a file safety helper problem', async () => {
  const otherIssue = describeStartupFailure(new Error('tray icon missing'), { stage: 'updater:start' });
  for (const health of [null, readyHealth(), readyHealth([otherIssue]), createStartupHealth()]) {
    const html = await renderBanner(health);
    assert.equal(html.includes('startup-health-banner'), false, JSON.stringify(health));
    assert.equal(html.includes(DATA_SAFETY_LINE), false);
  }
});

test('a degraded start shows its failure, the data-safety line, the recovery gate and every action', async () => {
  const failure = workerFailure();
  const html = await renderBanner(degradedHealth({ failure }));

  assert.match(html, /class="startup-health-banner[^"]*"/u);
  assert.ok(html.includes('Some Minecraft Core features are turned off'));
  assert.ok(html.includes(failure.summary));
  assert.ok(html.includes('ArchiveWorker.exe'), 'the banner names the missing helper');
  assert.ok(html.includes(failure.hint));
  assert.ok(html.includes(DATA_SAFETY_LINE));
  assert.ok(html.includes('Servers and clients that do not use modpacks keep working.'));
  for (const action of ['Check for updates', 'Restart', 'Open log folder', 'Copy details']) {
    assert.match(html, new RegExp(`<button[^>]*>\\s*${action}\\s*</button>`, 'u'), action);
  }
});

test('the gate line explains a global block and the servers that stay blocked', async () => {
  const globalBlock = await renderBanner(degradedHealth({
    recoveryGate: { basis: 'unreadable', globalBlock: true, blockedServers: [] }
  }));
  assert.ok(globalBlock.includes('Server starts and server changes are paused'));
  assert.equal(globalBlock.includes('keep working'), false);

  const one = await renderBanner(degradedHealth({
    recoveryGate: { basis: 'read-only-scan', globalBlock: false, blockedServers: [{ instanceId: 'alpha' }] }
  }));
  assert.ok(one.includes('One server with unfinished modpack work stays blocked'));
  assert.ok(one.includes('Servers and clients that do not use modpacks keep working.'));

  const two = await renderBanner(degradedHealth({
    recoveryGate: { basis: 'read-only-scan', globalBlock: false, blockedServers: ['alpha', { instanceId: 'beta' }] }
  }));
  assert.ok(two.includes('2 servers with unfinished modpack work stay blocked'));
});

test('a ready start warns when the file safety helper is missing or blocked', async () => {
  for (const issue of [workerFailure('archive-worker'), blockedWorkerFailure('archive-worker')]) {
    const html = await renderBanner(readyHealth([issue]));
    assert.ok(html.includes('Modpack features need attention'), issue.reason);
    assert.ok(html.includes(issue.summary));
    assert.ok(html.includes(issue.hint));
    assert.ok(html.includes(DATA_SAFETY_LINE));
    assert.equal(html.includes('Some Minecraft Core features are turned off'), false);
    assert.match(html, /<button[^>]*>\s*Check for updates\s*<\/button>/u);
  }
});

test('the banner checks for updates, then downloads and installs through the update IPC', () => {
  const banner = readBanner();
  assert.match(banner, /window\.electron\.invoke\(\s*['"]check-for-updates['"]\s*\)/u);
  assert.match(
    banner,
    /window\.electron\.invoke\(\s*['"]download-update['"]\s*,\s*\{\s*installAfterDownload:\s*true\s*\}\s*\)/u
  );
  assert.match(banner, /on:click=\{checkForUpdates\}/u);
  assert.match(banner, /on:click=\{downloadAndInstall\}[^>]*>\s*Download and install \{/u);

  // Progress and failures come from the same update events the updater sends;
  // every listener is a named function that the banner removes again.
  const registered = [...banner.matchAll(/window\.electron\.on\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/gu)]
    .map(([, channel, handler]) => `${channel}:${handler}`);
  const removed = [...banner.matchAll(/window\.electron\.removeListener\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/gu)]
    .map(([, channel, handler]) => `${channel}:${handler}`);
  for (const channel of ['update-download-progress', 'update-error']) {
    assert.ok(registered.some(entry => entry.startsWith(`${channel}:`)), `${channel} is observed`);
  }
  assert.deepEqual([...removed].sort(), [...registered].sort());
  assert.doesNotMatch(banner, /window\.electron\.on\(\s*['"][^'"]+['"]\s*,\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u);
});

test('restart, the log folder, the details and the health read use the startup IPC', () => {
  const banner = readBanner();
  assert.match(banner, /window\.electron\.invoke\(\s*['"]startup:get-health['"]\s*\)/u);
  assert.match(banner, /window\.electron\.invoke\(\s*['"]startup:relaunch['"]\s*\)/u);
  assert.match(banner, /window\.electron\.invoke\(\s*['"]startup:open-logs['"]\s*\)/u);
  assert.match(banner, /navigator\.clipboard\.writeText\(/u);
  // The browser panel has no startup channels of its own.
  assert.match(banner, /window\.IS_BROWSER_PANEL/u);
});

test('App shows the banner above the setup, server and client views', () => {
  const app = fs.readFileSync(APP_PATH, 'utf8');
  assert.match(app, /import StartupHealthBanner from ["']\.\/components\/common\/StartupHealthBanner\.svelte["'];/u);
  const mainContent = app.indexOf('<div class="main-content"');
  assert.notEqual(mainContent, -1);
  const banner = app.indexOf('<StartupHealthBanner', mainContent);
  const firstView = app.indexOf('{#if step === "chooseFolder"}', mainContent);
  assert.ok(banner > mainContent && banner < firstView, 'the banner is the first thing in the main content');
  assert.equal(app.match(/<StartupHealthBanner\b/gu).length, 1);
});

test('the banner compiles without Svelte warnings', async () => {
  const { compile } = await import('svelte/compiler');
  for (const generate of ['client', 'server']) {
    const { warnings } = compile(readBanner(), { filename: BANNER_PATH, generate, dev: false });
    assert.deepEqual(warnings.map(warning => `${warning.code}: ${warning.message}`), [], generate);
  }
});
