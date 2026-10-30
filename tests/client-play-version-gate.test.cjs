const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

// The Play tab's app-version gate. Play needs exactly equal app versions (as
// in v26.6.1); this checks what a friend is told and offered when the versions
// differ, especially when the friend is newer than the host (A6).
const PLAY_TAB_PATH = path.resolve(__dirname, '../src/components/client/PlayTab.svelte');

function moduleUrl(specifier) {
  return pathToFileURL(require.resolve(specifier)).href;
}

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

let playTabPromise = null;

// Compiles the real component for server rendering with its store, toast and
// child-component imports replaced by inert stand-ins.
function loadPlayTab() {
  playTabPromise ??= (async () => {
    const { compile } = await import('svelte/compiler');
    const storeUrl = moduleUrl('svelte/store');
    const clientStoreUrl = dataUrl(
      `import { writable } from '${storeUrl}'; export const clientState = writable({}); export function setAppVersions() {}`
    );
    const stubs = new Map([
      ['../../stores/clientStore.js', clientStoreUrl],
      ['../../stores/modStore.js', dataUrl(`import { writable } from '${storeUrl}'; export const showDownloads = writable(false);`)],
      ['svelte-sonner', dataUrl('export const toast = { info() {}, success() {}, error() {} };')],
      ['../mods/components/DownloadProgress.svelte', dataUrl('export default function DownloadProgress() {}')],
      ['../../utils/mods/modDownloadManager.js', dataUrl('export function initDownloadManager() { return () => {}; }')]
    ]);
    const source = fs.readFileSync(PLAY_TAB_PATH, 'utf8');
    const code = compile(source, { filename: PLAY_TAB_PATH, generate: 'server', dev: false }).js.code
      .replace(/^(\s*import\b[^'\n]*?from\s*)'([^']+)'/gmu, (match, head, specifier) => {
        if (stubs.has(specifier)) return `${head}'${stubs.get(specifier)}'`;
        if (specifier === 'svelte' || specifier.startsWith('svelte/')) return `${head}'${moduleUrl(specifier)}'`;
        if (specifier.startsWith('.')) {
          return `${head}'${pathToFileURL(path.resolve(path.dirname(PLAY_TAB_PATH), specifier)).href}'`;
        }
        return match;
      });
    const [{ default: Component }, { clientState }, { render }] = await Promise.all([
      import(dataUrl(code)),
      import(clientStoreUrl),
      import('svelte/server')
    ]);
    return { Component, clientState, render };
  })();
  return playTabPromise;
}

// A signed-in friend whose client files and mods are ready, so only the app
// version decides what the Play area shows.
async function renderPlayTab(clientVersion, hostVersion) {
  const { Component, clientState, render } = await loadPlayTab();
  const compatible = clientVersion === hostVersion;
  clientState.set({
    connectionStatus: 'connected',
    minecraftServerStatus: 'running',
    activeTab: 'play',
    clientAppVersion: clientVersion,
    serverAppVersion: hostVersion,
    appVersionCompatible: compatible,
    appVersionMismatch: Boolean(clientVersion && hostVersion && !compatible)
  });
  const html = render(Component, {
    props: {
      authStatus: 'authenticated',
      username: 'Steve',
      authData: { name: 'Steve' },
      packState: { status: 'unmanaged' },
      launchStatus: 'ready',
      clientSyncStatus: 'ready',
      downloadStatus: 'ready',
      requiredMods: [],
      serverInfo: null,
      handleRefreshFromDashboard() {},
      isChecking: false,
      lastCheck: null
    }
  }).body;
  const text = html.replace(/<!--[\s\S]*?-->/gu, '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
  return { html, text };
}

function versionBlock(html) {
  const start = html.indexOf('version-mismatch');
  assert.notEqual(start, -1, 'expected the app version message block');
  const end = html.indexOf('class="last-check', start);
  return html.slice(start, end === -1 ? undefined : end);
}

// Lists every element of the template with the {#if} branches around it.
async function templateElements() {
  const { parse } = await import('svelte/compiler');
  const source = fs.readFileSync(PLAY_TAB_PATH, 'utf8');
  const ast = parse(source, { modern: true });
  const slice = node => source.slice(node.start, node.end);
  const elements = [];

  function textOf(node) {
    return node.type === 'Text' ? node.data : `{${slice(node.expression)}}`;
  }

  function childFragments(node) {
    return Object.values(node).filter(value => value && typeof value === 'object' && value.type === 'Fragment');
  }

  function visit(node, conditions) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Fragment') {
      for (const child of node.nodes) visit(child, conditions);
      return;
    }
    if (node.type === 'IfBlock') {
      const test = slice(node.test);
      visit(node.consequent, [...conditions, { test, branch: 'then' }]);
      if (node.alternate) visit(node.alternate, [...conditions, { test, branch: 'else' }]);
      return;
    }
    if (node.type === 'RegularElement') {
      // Only the element's own text, so a wrapper never stands in for the
      // element that actually shows the words.
      const ownText = node.fragment.nodes
        .filter(child => child.type === 'Text' || child.type === 'ExpressionTag')
        .map(textOf)
        .join('');
      elements.push({ name: node.name, text: ownText.replace(/\s+/gu, ' ').trim(), conditions, source: slice(node) });
    }
    for (const fragment of childFragments(node)) visit(fragment, conditions);
  }

  visit(ast.fragment, []);
  return { source, elements };
}

function thenTests(element) {
  return element.conditions.filter(condition => condition.branch === 'then').map(condition => condition.test);
}

function elementsWithText(elements, name, fragment) {
  return elements.filter(element => element.name === name && element.text.includes(fragment));
}

test('a friend newer than the host is told to wait for the host, with Refresh and no download', async () => {
  const { html, text } = await renderPlayTab('26.11.1', '26.6.1');

  assert.match(text, /Host Update Required/u);
  assert.match(text, /HOST UPDATE REQUIRED/u);
  assert.match(text, /The host is running Minecraft Core 26\.6\.1; you have 26\.11\.1\. You both need the same version to play\. Ask the host to update Minecraft Core, then press Refresh\./u);
  assert.match(versionBlock(html), /<button[^>]*>[^<]*Refresh/u, 'the message offers its own Refresh button');

  for (const absent of ['Please update your app', 'App Update Required', 'Download Server Version', 'Retry Download', 'Use version']) {
    assert.equal(text.includes(absent), false, `${absent} must not render for a host on an older version`);
  }
  assert.doesNotMatch(text, /(?<!HOST )UPDATE REQUIRED/u);
  assert.equal(text.includes('PLAY MINECRAFT'), false, 'the play gate still needs equal versions');
});

test('a friend older than the host keeps the v26.6.1 upgrade flow', async () => {
  const { text } = await renderPlayTab('26.6.1', '26.11.1');

  assert.match(text, /App Update Required/u);
  assert.match(text, /🔄 UPDATE REQUIRED/u);
  assert.match(text, /Your app version \(26\.6\.1\) doesn't match the server version \(26\.11\.1\)\./u);
  assert.match(text, /Please update your app to continue playing\./u);
  assert.match(text, /Download Server Version \(26\.11\.1\)/u);
  assert.equal(text.includes('Host Update Required'), false);
  assert.equal(text.includes('Use version'), false);
  assert.equal(text.includes('PLAY MINECRAFT'), false);
});

test('versions that cannot be compared get generic text and no download or switch button', async () => {
  for (const [clientVersion, hostVersion] of [['26.11.1', '26.11'], ['v26.6.1', '26.11.1'], ['26.11.1', 'custom-build']]) {
    const { text } = await renderPlayTab(clientVersion, hostVersion);

    assert.match(text, /You both need the same version of Minecraft Core to play\./u, `${clientVersion} vs ${hostVersion}`);
    for (const absent of ['Please update your app', 'Download Server Version', 'Retry Download', 'Use version', 'Host Update Required']) {
      assert.equal(text.includes(absent), false, `${absent} must not render for ${clientVersion} vs ${hostVersion}`);
    }
    assert.equal(text.includes('PLAY MINECRAFT'), false);
  }
});

test('equal versions keep Play available', async () => {
  const { text } = await renderPlayTab('26.11.1', '26.11.1');

  assert.match(text, /PLAY MINECRAFT/u);
  assert.equal(/Update Required|UPDATE REQUIRED|Version Mismatch/u.test(text), false);
});

test('the download and upgrade buttons are gated on client-older', async () => {
  const { elements } = await templateElements();
  const upgradeElements = [
    ...elementsWithText(elements, 'button', 'Download Server Version'),
    ...elementsWithText(elements, 'button', 'Retry Download'),
    ...elementsWithText(elements, 'div', 'Please update your app')
  ];

  assert.equal(upgradeElements.length >= 3, true, 'expected the upgrade buttons and text');
  for (const element of upgradeElements) {
    assert.equal(
      thenTests(element).some(test => /appVersionRelation\s*===\s*'client-older'/u.test(test)),
      true,
      `"${element.text}" must only render when the client is older than the host`
    );
  }
});

test('the client-newer branch offers Refresh and gates the switch on the main process answer', async () => {
  const { source, elements } = await templateElements();
  const insideClientNewer = element => thenTests(element).some(test => /appVersionRelation\s*===\s*'client-newer'/u.test(test));

  const refresh = elementsWithText(elements, 'button', 'Refresh').filter(insideClientNewer);
  assert.equal(refresh.length, 1, 'expected one Refresh button in the client-newer message');
  assert.match(refresh[0].source, /on:click=\{refreshHostVersion\}/u);

  const switchButtons = elementsWithText(elements, 'button', 'Use version');
  assert.equal(switchButtons.length, 1);
  assert.equal(insideClientNewer(switchButtons[0]), true);
  assert.equal(thenTests(switchButtons[0]).some(test => /\bhostVersionSwitch\.allowed\b/u.test(test)), true,
    'the switch button must only render when the main process reports the downgrade allowed');
  assert.match(switchButtons[0].text, /Use version \{\$clientState\.serverAppVersion\} on this PC/u);
  assert.match(switchButtons[0].source, /downloadServerVersion\(\$clientState\.serverAppVersion\)/u);

  // The flag only comes from the main process, asked without a network lookup.
  assert.match(source, /import\s*\{\s*relateAppVersions\s*\}\s*from\s*'\.\.\/\.\.\/utils\/version\/appVersionRelation\.js'/u);
  assert.match(source, /\$:\s*appVersionRelation\s*=\s*relateAppVersions\(\s*\$clientState\.clientAppVersion\s*,\s*\$clientState\.serverAppVersion\s*\)/u);
  assert.match(source, /invoke\(\s*'check-for-specific-version'\s*,\s*hostVersion\s*,\s*\{\s*lookupRelease:\s*false\s*\}\s*\)/u);
  assert.match(source, /hostVersionSwitch\s*=\s*\{\s*allowed:\s*true\b/u);
  assert.equal((source.match(/allowed:\s*true/gu) || []).length, 1, 'only the main process answer may allow the switch');
});

// Runs the component's own requestHostVersionSwitch against a fake main process.
async function loadHostVersionSwitchRequest(invoke) {
  const { parse } = await import('svelte/compiler');
  const source = fs.readFileSync(PLAY_TAB_PATH, 'utf8');
  const declaration = parse(source, { modern: true }).instance.content.body
    .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'requestHostVersionSwitch');
  assert.ok(declaration, 'expected requestHostVersionSwitch in the Play tab script');
  const context = vm.createContext({ window: { electron: { invoke } } });
  vm.runInContext(`let hostVersionSwitch = null;\nlet hostVersionSwitchRequest = 0;\n${source.slice(declaration.start, declaration.end)}`, context);
  return {
    request: hostVersion => vm.runInContext(`requestHostVersionSwitch(${JSON.stringify(hostVersion)})`, context),
    state: () => ({ ...vm.runInContext('hostVersionSwitch', context) })
  };
}

const NO_SWITCH = { allowed: false, warning: null, reason: null };

test('only the main process answer offers the switch, with its warning or its refusal reason', async () => {
  const calls = [];
  let answer = null;
  const { request, state } = await loadHostVersionSwitchRequest(async (...args) => {
    calls.push(JSON.parse(JSON.stringify(args)));
    if (answer instanceof Error) throw answer;
    return answer;
  });

  answer = { success: true, needsUpdate: true, isDowngrade: true, warning: 'Older version warning' };
  await request('26.6.1');
  assert.deepEqual(calls, [['check-for-specific-version', '26.6.1', { lookupRelease: false }]]);
  assert.deepEqual(state(), { allowed: true, warning: 'Older version warning', reason: null });

  answer = { success: false, needsUpdate: false, olderThanCurrent: true, code: 'DOWNGRADE_REFUSED', error: 'Refusal reason' };
  await request('26.6.1');
  assert.deepEqual(state(), { allowed: false, warning: null, reason: 'Refusal reason' });

  for (const other of [
    { success: true, needsUpdate: false, developmentMode: true },
    { success: true, needsUpdate: true },
    { success: false, needsUpdate: false, code: 'VERSION_UNCOMPARABLE', error: 'Cannot compare' },
    null,
    new Error('IPC_UNAVAILABLE')
  ]) {
    answer = other;
    await request('26.6.1');
    assert.deepEqual(state(), NO_SWITCH, JSON.stringify(other?.message || other));
  }

  calls.length = 0;
  await request(null);
  assert.deepEqual(calls, [], 'no question is asked when the friend is not newer than the host');
  assert.deepEqual(state(), NO_SWITCH);
});

test('an answer for an earlier host version never offers the switch', async () => {
  const pending = [];
  const { request, state } = await loadHostVersionSwitchRequest(() => new Promise(resolve => pending.push(resolve)));

  const first = request('26.6.1');
  const second = request('26.9.0');
  pending[1]({ success: false, code: 'DOWNGRADE_REFUSED', error: 'Refused for 26.9.0' });
  await second;
  pending[0]({ success: true, needsUpdate: true, isDowngrade: true, warning: 'stale' });
  await first;

  assert.deepEqual(state(), { allowed: false, warning: null, reason: 'Refused for 26.9.0' });
});

test('pressing Refresh re-reads the app versions while they differ', async () => {
  const { source } = await templateElements();
  assert.match(source, /async function refreshHostVersion\(\)\s*\{[^}]*?await handleRefreshFromDashboard\?\.\(\);/u);

  // Versions are otherwise only read on connect, so without this a host that
  // updated while the friend stayed connected would never be noticed.
  const clientInterface = fs.readFileSync(path.resolve(__dirname, '../src/components/client/ClientInterface.svelte'), 'utf8')
    .replace(/\r\n/gu, '\n');
  const start = clientInterface.indexOf('async function handleRefreshFromDashboard()');
  assert.notEqual(start, -1);
  const body = clientInterface.slice(start, clientInterface.indexOf('\n  }\n', start));
  assert.match(body, /if \(\$clientState\.appVersionMismatch\) \{\s*await checkAppVersionCompatibility\(scope\);\s*\}/u);
});

test('the play gate still requires exactly equal app versions', async () => {
  const { source } = await templateElements();

  assert.match(source, /\$:\s*canLaunchMinecraft\s*=[\s\S]*?\$clientState\.appVersionCompatible;/u);
});
