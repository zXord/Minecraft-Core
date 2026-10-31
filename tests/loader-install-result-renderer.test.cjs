const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

// 'download-and-install-loader' reports a failed loader install by resolving { success: false, error, code }
// (and sending 'install-error', which no renderer code listens to); it does not reject for that. The Custom
// server wizard and the Version Updater ignored the result, so a failed install completed setup, or was
// reported as a successful update. These tests run the components' own code against stubbed IPC, then render
// their real markup in the state that code left behind.
const ROOT = path.resolve(__dirname, '..');
const WIZARD_PATH = path.join(ROOT, 'src', 'components', 'setup', 'SetupWizard.svelte');
const UPDATER_PATH = path.join(ROOT, 'src', 'components', 'settings', 'VersionUpdater.svelte');
const HELPER_URL = pathToFileURL(path.join(ROOT, 'src', 'utils', 'server', 'loaderInstallResult.js')).href;
const SERVER_PATH = 'C:\\servers\\custom';
const MINECRAFT = '1.21.1';
const REJECTION = "Error invoking remote method 'download-and-install-loader': Error: Another operation is already changing this server";

// What electron/ipc/install-handlers.cjs resolves: every successful install, Vanilla included, carries
// success: true; every failure it catches is { success: false, error, code }.
const LOADERS = Object.freeze([
  { loader: 'vanilla', loaderVersion: null, name: 'Vanilla', failure: { error: 'Invalid target directory', code: 'LOADER_INSTALL_FAILED' } },
  { loader: 'fabric', loaderVersion: '0.16.14', name: 'Fabric', failure: { error: 'Fabric installer exited with code 1', code: 'LOADER_INSTALL_FAILED' } },
  { loader: 'forge', loaderVersion: '52.1.0', name: 'Forge', failure: { error: 'Java 21 is not available for Minecraft 1.21.1', code: 'LOADER_INSTALL_FAILED' } },
  { loader: 'neoforge', loaderVersion: '21.1.200', name: 'NeoForge', failure: { error: 'The NeoForge installer checksum did not match.', code: 'RUNTIME_INCOMPLETE' } },
  { loader: 'quilt', loaderVersion: '0.29.1', name: 'Quilt', failure: { error: 'An exact loader version is required.', code: 'LOADER_VERSION_REQUIRED' } }
]);
const FABRIC = LOADERS.find(selection => selection.loader === 'fabric');
const NEOFORGE = LOADERS.find(selection => selection.loader === 'neoforge');

const installed = ({ loader, loaderVersion }) => ({ success: true, loader, loaderVersion });
const refused = ({ failure }) => ({ success: false, ...failure });
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

let compilerModule = null;
const svelteCompiler = () => (compilerModule ??= import('svelte/compiler'));

function instanceBody(parse, source) {
  return parse(source, { modern: true }).instance.content.body;
}

function declaredNames(declaration) {
  return declaration.declarations.map(declarator => {
    assert.equal(declarator.id.type, 'Identifier', 'component state is declared one plain name at a time');
    return declarator.id.name;
  });
}

// Runs a component's own top-level declarations (props, state and functions) in a plain function. Imports
// bind to the given stand-ins; any other import loads the real module, so a helper the component starts to
// use is the real one. Reactive ($:) statements and lifecycle calls do not run: the test sets what they derive.
async function liftComponent(file, { imports, globals }) {
  const { parse } = await svelteCompiler();
  const source = fs.readFileSync(file, 'utf8');
  const parameters = new Map(Object.entries(globals));
  const declarations = [];
  const state = new Set();
  const reactive = new Set();
  const functions = [];
  for (const node of instanceBody(parse, source)) {
    if (node.type === 'ImportDeclaration') {
      const specifier = node.source.value;
      const module = Object.hasOwn(imports, specifier) ? imports[specifier]
        : specifier.endsWith('.svelte') ? { default: null }
          : await import(specifier.startsWith('.') ? pathToFileURL(path.resolve(path.dirname(file), specifier)).href : specifier);
      for (const item of node.specifiers) {
        parameters.set(item.local.name, item.type === 'ImportNamespaceSpecifier' ? module
          : module[item.type === 'ImportDefaultSpecifier' ? 'default' : item.imported.name]);
      }
      continue;
    }
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (declaration?.type === 'FunctionDeclaration') {
      declarations.push(source.slice(declaration.start, declaration.end));
      functions.push(declaration.id.name);
    } else if (declaration?.type === 'VariableDeclaration') {
      declarations.push(source.slice(declaration.start, declaration.end));
      if (declaration.kind !== 'const') declaredNames(declaration).forEach(name => state.add(name));
    } else if (node.type === 'LabeledStatement' && node.label.name === '$') {
      const expression = node.body.type === 'ExpressionStatement' ? node.body.expression : null;
      if (expression?.type === 'AssignmentExpression' && expression.left.type === 'Identifier') reactive.add(expression.left.name);
    }
  }
  const implicit = [...reactive].filter(name => !state.has(name));
  const names = [...state, ...implicit];
  const body = `'use strict';
    ${implicit.map(name => `let ${name};`).join('\n')}
    ${declarations.join('\n')}
    return {
      functions: { ${functions.join(', ')} },
      get: () => ({ ${names.join(', ')} }),
      set(__values) {
        for (const [__name, __value] of Object.entries(__values)) {
          switch (__name) {
            ${names.map(name => `case ${JSON.stringify(name)}: ${name} = __value; break;`).join('\n')}
            default: throw new Error('The component has no state named ' + __name);
          }
        }
      }
    };`;
  return new Function(...parameters.keys(), body)(...parameters.values());
}

// The component source with the initial values of the named top-level declarations replaced.
function withInitialState(parse, source, state) {
  const edits = [];
  for (const node of instanceBody(parse, source)) {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (declaration?.type !== 'VariableDeclaration') continue;
    for (const declarator of declaration.declarations) {
      if (declarator.init && Object.hasOwn(state, declarator.id.name)) {
        edits.push({ start: declarator.init.start, end: declarator.init.end, text: JSON.stringify(state[declarator.id.name]) });
      }
    }
  }
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}

// Server-renders the real component, starting in the given state, with the named modules replaced.
async function renderComponent(file, { state = {}, props = {}, stubs = {} } = {}) {
  const { compile, parse } = await svelteCompiler();
  const { build } = require('esbuild');
  const target = path.resolve(file);
  const stubbed = Object.keys(stubs);
  const result = await build({
    absWorkingDir: ROOT,
    stdin: {
      resolveDir: ROOT,
      contents: `import Component from ${JSON.stringify(target)};
        import { render } from 'svelte/server';
        export default props => render(Component, { props }).body;`
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    // esbuild filters are Go regular expressions, which take no 'u' flag.
    plugins: [{
      name: 'component-in-state',
      setup(builder) {
        if (stubbed.length) {
          const filter = new RegExp(`^(?:${stubbed.map(escapeRegExp).join('|')})$`);
          builder.onResolve({ filter }, args => ({ path: args.path, namespace: 'stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js', resolveDir: ROOT }));
        }
        builder.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => {
          let source = await fs.promises.readFile(filename, 'utf8');
          if (path.resolve(filename) === target) source = withInitialState(parse, source, state);
          return {
            contents: compile(source, { filename, generate: 'server', css: 'external', dev: false }).js.code,
            resolveDir: path.dirname(filename)
          };
        });
      }
    }]
  });
  const { default: renderBody } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  return renderBody(props);
}

function textOf(html) {
  return html
    .replace(/<[^>]+>/gu, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/gu, ' ')
    .trim();
}

// The pressed button and the element rendered right after it.
function outcomeAfterButton(html, label) {
  const markup = html.replace(/<!--[\s\S]*?-->/gu, '');
  const button = new RegExp(`<button\\b([^>]*)>\\s*(${label})\\s*</button>`, 'u').exec(markup);
  assert.ok(button, `the ${label} button is shown`);
  const following = markup.slice(button.index + button[0].length).trimStart();
  const region = /^<section\b([^>]*)>([\s\S]*?)<\/section>/u.exec(following);
  return {
    buttonDisabled: /\sdisabled(?:[\s=>]|$)/u.test(button[1]),
    region: region ? { attributes: region[1], text: textOf(region[2]) } : null
  };
}

function assertShownNextToButton(outcome, message) {
  assert.ok(outcome.region, 'the failure is shown right after the button that was pressed');
  assert.match(outcome.region.attributes, /\brole="alert"/u, 'the failure is announced');
  assert.match(outcome.region.attributes, /\btabindex="-1"/u, 'the failure can take focus');
  assert.ok(outcome.region.text.includes(message), `${outcome.region.text} names ${message}`);
  assert.equal(outcome.buttonDisabled, false, 'the button can be pressed again to retry');
}

// bind:this target that records how the component reveals it.
function fakeRegion() {
  const region = { scrolled: [], focused: [] };
  region.scrollIntoView = options => region.scrolled.push(options);
  region.focus = options => region.focused.push(options ?? null);
  return region;
}

function assertRevealed(region) {
  assert.deepEqual(region.scrolled, [{ block: 'nearest' }], 'the failure is scrolled into view');
  assert.equal(region.focused.length, 1, 'the failure receives focus once');
}

// --- Custom server wizard (src/components/setup/SetupWizard.svelte) ---

const WIZARD_STATE = ['step', 'path', 'mcVersions', 'fabricVersions', 'selectedLoader', 'selectedMC', 'selectedFabric', 'acceptEula',
  'installing', 'installProgress', 'installSpeed', 'installLogs', 'installError'];
const WIZARD_STEPS = ['save-version-selection', 'download-minecraft-server', 'write-eula', 'download-and-install-loader', 'server-java-ensure'];

async function loadWizard(loaderAnswers) {
  const answers = [...loaderAnswers];
  const calls = [];
  const events = [];
  const timers = [];
  const region = fakeRegion();
  const respond = {
    'save-version-selection': () => true,
    'download-minecraft-server': () => true,
    'write-eula': () => true,
    'download-and-install-loader': () => {
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    'server-java-ensure': () => ({ success: true })
  };
  let wizard = null;
  wizard = await liftComponent(WIZARD_PATH, {
    imports: {
      svelte: {
        createEventDispatcher: () => (type, detail) => events.push({ type, detail: structuredClone(detail) }),
        onMount() {},
        onDestroy() {},
        // A state change is rendered before tick() resolves, and the shown failure binds its region.
        async tick() {
          if (wizard.get().installError) wizard.set({ installErrorRegion: region });
        }
      },
      '../../utils/logger.js': { default: { debug() {}, info() {}, warn() {}, error() {} } }
    },
    globals: {
      window: {
        electron: {
          async invoke(channel, payload) {
            calls.push({ channel, payload: structuredClone(payload) });
            if (!Object.hasOwn(respond, channel)) throw new Error(`Unexpected IPC channel ${channel}`);
            return respond[channel]();
          },
          on() {},
          removeAllListeners() {}
        }
      },
      setTimeout: callback => timers.push(callback),
      fetch: async () => { throw new Error('No network in tests'); }
    }
  });
  return {
    calls,
    events,
    region,
    channels: () => calls.map(call => call.channel),
    state: () => wizard.get(),
    // Picks the version, loader and EULA, then presses Install.
    async install({ loader, loaderVersion }) {
      wizard.set({ step: 'chooseVersion', path: SERVER_PATH, selectedMC: MINECRAFT, selectedLoader: loader, selectedFabric: loaderVersion, acceptEula: true });
      await wizard.functions.saveVersionSelection();
      // dispatchSetupComplete defers its event with setTimeout(0).
      for (const callback of timers.splice(0)) callback();
    }
  };
}

function renderWizard(state) {
  return renderComponent(WIZARD_PATH, {
    state: Object.fromEntries(WIZARD_STATE.filter(name => state[name] !== undefined).map(name => [name, state[name]]))
  });
}

function setupCompleted({ loader, loaderVersion }) {
  return [{
    type: 'setup-complete',
    detail: { path: SERVER_PATH, mcVersion: MINECRAFT, loader, loaderVersion, fabricVersion: loaderVersion }
  }];
}

test('only an explicit success:false result is a failed loader install', async () => {
  const { loaderInstallFailure } = await import(HELPER_URL);
  for (const selection of LOADERS) {
    assert.equal(loaderInstallFailure(installed(selection), selection.loader), null, `${selection.name} success`);
    const failure = loaderInstallFailure(refused(selection), selection.loader);
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, `${selection.name} installation failed: ${selection.failure.error}`);
    assert.equal(failure.code, selection.failure.code);
  }
  // Anything else keeps the earlier behaviour: it was never checked, so it counted as installed.
  for (const answer of [undefined, null, true, {}, { loader: 'fabric' }]) {
    assert.equal(loaderInstallFailure(answer, 'fabric'), null, JSON.stringify(answer));
  }
  assert.equal(loaderInstallFailure({ success: false }, 'quilt').message, 'Quilt installation failed.');
  assert.equal(loaderInstallFailure({ success: false, error: '  ' }, 'FORGE').message, 'Forge installation failed.');
  const unnamed = loaderInstallFailure({ success: false, error: 'Unsupported loader: paper' }, 'constructor');
  assert.equal(unnamed.message, 'Loader installation failed: Unsupported loader: paper');
  assert.equal(unnamed.code, undefined);
});

for (const selection of LOADERS) {
  test(`wizard: a ${selection.name} install that succeeds still completes setup`, async () => {
    const wizard = await loadWizard([installed(selection)]);
    await wizard.install(selection);

    assert.deepEqual(wizard.channels(), WIZARD_STEPS);
    assert.deepEqual(wizard.calls[3].payload, {
      path: SERVER_PATH, mcVersion: MINECRAFT, loader: selection.loader, loaderVersion: selection.loaderVersion, fabricVersion: selection.loaderVersion
    });
    assert.deepEqual(wizard.events, setupCompleted(selection));
    const state = wizard.state();
    assert.equal(state.installing, false);
    assert.ok(!state.installError);
    assert.equal(state.installLogs.at(-1), 'Setup completed successfully!');
    assert.deepEqual(wizard.region.focused, [], 'nothing is revealed for a success');
  });

  test(`wizard: a ${selection.name} install reported as failed stops setup and shows why next to Install`, async () => {
    const wizard = await loadWizard([refused(selection)]);
    await wizard.install(selection);

    assert.deepEqual(wizard.channels(), WIZARD_STEPS.slice(0, 4), 'nothing runs after the failed install, and nothing is deleted');
    assert.deepEqual(wizard.events, [], 'setup is not completed, so the server is not registered');
    const state = wizard.state();
    assert.equal(state.installing, false);
    assert.equal(state.step, 'chooseVersion', 'the wizard stays on the version step');
    const message = `${selection.name} installation failed: ${selection.failure.error}`;
    assert.equal(state.installError, message);
    assert.equal(state.installLogs.at(-1), `Error: ${message}`);
    assert.ok(!state.installLogs.includes('Setup completed successfully!'));
    assertRevealed(wizard.region);

    const html = await renderWizard(state);
    const outcome = outcomeAfterButton(html, 'Install[^<]*');
    assertShownNextToButton(outcome, message);
    assert.match(outcome.region.text, /not added/u);
    assert.match(textOf(html), /Installation Logs/u, 'the installation log stays readable after the failure');
  });
}

test('wizard: a loader install that rejects still stops setup as before, and its reason is shown next to Install', async () => {
  const wizard = await loadWizard([new Error(REJECTION)]);
  await wizard.install(FABRIC);

  // As before: setup stops at the failed step, is not completed, and logs the reason.
  assert.deepEqual(wizard.channels(), WIZARD_STEPS.slice(0, 4));
  assert.deepEqual(wizard.events, []);
  const state = wizard.state();
  assert.equal(state.installing, false);
  assert.equal(state.installLogs.at(-1), `Error: ${REJECTION}`);

  assert.equal(state.installError, REJECTION);
  assertRevealed(wizard.region);
  assertShownNextToButton(outcomeAfterButton(await renderWizard(state), 'Install[^<]*'), REJECTION);
});

test('wizard: Install retries after a failed loader install, and a successful retry completes setup', async () => {
  const wizard = await loadWizard([refused(NEOFORGE), installed(NEOFORGE)]);
  await wizard.install(NEOFORGE);
  assert.deepEqual(wizard.events, []);

  await wizard.install(NEOFORGE);
  assert.deepEqual(wizard.channels(), [...WIZARD_STEPS.slice(0, 4), ...WIZARD_STEPS]);
  assert.deepEqual(wizard.events, setupCompleted(NEOFORGE));
  const state = wizard.state();
  assert.ok(!state.installError, 'the earlier failure is cleared');
  assert.equal(outcomeAfterButton(await renderWizard(state), 'Install[^<]*').region, null);
});

test('wizard: an install result without success:false still completes setup', async () => {
  for (const answer of [undefined, true, {}]) {
    const wizard = await loadWizard([answer]);
    await wizard.install(FABRIC);
    assert.deepEqual(wizard.events, setupCompleted(FABRIC), JSON.stringify(answer));
    assert.ok(!wizard.state().installError);
  }
});

// --- Version Updater (src/components/settings/VersionUpdater.svelte) ---

const UPDATER_STATE = ['selectedMC', 'selectedLoader', 'selectedFabric', 'compatChecked', 'updating', 'updateProgress', 'currentTask',
  'updateStatus', 'updateSummary', 'completedUpdates', 'updateError'];
const UPDATE_STEPS = ['backups:safe-create', 'download-minecraft-server', 'download-and-install-loader', 'server-java-ensure', 'update-config'];
const PREVIOUS = Object.freeze({ path: SERVER_PATH, mcVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.15.11', fabricVersion: '0.15.11' });

async function loadUpdater(loaderAnswers) {
  const { writable, get } = await import('svelte/store');
  const answers = [...loaderAnswers];
  const calls = [];
  const effects = { versions: [], indicatorsCleared: 0, watchesCleared: [] };
  const region = fakeRegion();
  const respond = {
    'backups:safe-create': () => ({ success: true, name: 'pre-update' }),
    'download-minecraft-server': () => true,
    'download-and-install-loader': () => {
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    'server-java-ensure': () => ({ success: true, requiredJavaVersion: 21 }),
    'update-config': () => ({ success: true })
  };
  let updater = null;
  updater = await liftComponent(UPDATER_PATH, {
    imports: {
      svelte: {
        onMount() {},
        onDestroy() {},
        async tick() {
          if (updater.get().updateError) updater.set({ updateErrorRegion: region });
        }
      },
      'svelte/reactivity': { SvelteSet: Set },
      'svelte/store': { get },
      'lucide-svelte/icons/chevron-down': { default: null },
      'lucide-svelte/icons/chevron-right': { default: null },
      'lucide-svelte/icons/external-link': { default: null },
      '../../stores/serverState.js': { serverState: writable({ status: 'Stopped' }) },
      '../../stores/settingsStore.js': {
        settingsStore: writable({ ...PREVIOUS }),
        updateVersions: (...args) => effects.versions.push(args)
      },
      '../../utils/ipcUtils.js': {
        async safeInvoke(channel, ...args) {
          calls.push({ channel, args: structuredClone(args) });
          if (!Object.hasOwn(respond, channel)) throw new Error(`Unexpected IPC channel ${channel}`);
          return respond[channel]();
        }
      },
      '../../utils/mods/modAPI.js': { clearModUpdateIndicators: () => { effects.indicatorsCleared += 1; } },
      '../../utils/mods/modrinthProjectLinks.js': {},
      '../../stores/modAvailabilityWatchStore.js': {
        modAvailabilityWatchStore: { async clear(serverPath) { effects.watchesCleared.push(serverPath); } }
      },
      '../../router.js': { navigate() {} }
    },
    globals: {
      window: {},
      setTimeout: () => 0,
      fetch: async () => { throw new Error('No network in tests'); }
    }
  });
  return {
    calls,
    effects,
    region,
    channels: () => calls.map(call => call.channel),
    state: () => updater.get(),
    // Picks the target after a compatibility check without mods, presses Update Server Version and confirms.
    async update({ loader, loaderVersion }) {
      updater.set({
        resolvedPath: SERVER_PATH, selectedMC: MINECRAFT, selectedLoader: loader, selectedFabric: loaderVersion,
        compatChecked: true, compatibleMods: [], incompatibleMods: [], modsWithUpdates: []
      });
      updater.functions.updateServerVersion();
      assert.equal(updater.get().showUpdateConfirmation, true);
      await updater.functions.confirmUpdate();
    }
  };
}

function renderUpdater(state) {
  return renderComponent(UPDATER_PATH, {
    props: { serverPath: '' },
    state: Object.fromEntries(UPDATER_STATE.filter(name => state[name] !== undefined).map(name => [name, state[name]])),
    // These modules reach for window when they load.
    stubs: {
      '../../router.js': 'export function navigate() {}',
      '../../utils/mods/modAPI.js': 'export function clearModUpdateIndicators() {}',
      '../../stores/modAvailabilityWatchStore.js': `import { writable } from 'svelte/store';
        const { subscribe } = writable({ watches: [], history: [], config: { intervalHours: 12 }, loaded: false, error: null, notifications: [] });
        export const modAvailabilityWatchStore = { subscribe, refresh() {}, add() {}, remove() {}, clear() {}, clearHistory() {} };`
    }
  });
}

function assertNotReportedAsUpdated(updater) {
  assert.deepEqual(updater.channels(), UPDATE_STEPS.slice(0, 3), 'Java, mods and the server settings are left alone');
  assert.deepEqual(updater.effects.versions, [], 'the app keeps the previous version');
  assert.equal(updater.effects.indicatorsCleared, 0);
  assert.deepEqual(updater.effects.watchesCleared, []);
  const state = updater.state();
  assert.equal(state.updateSummary, null, 'no update summary is shown');
  assert.equal(state.updating, false);
  assert.equal(state.compatChecked, true, 'Update Server Version stays available for a retry');
  return state;
}

for (const selection of LOADERS) {
  test(`updater: a ${selection.name} install that succeeds still completes the update`, async () => {
    const updater = await loadUpdater([installed(selection)]);
    await updater.update(selection);

    assert.deepEqual(updater.channels(), UPDATE_STEPS);
    assert.deepEqual(updater.calls[2].args, [{
      path: SERVER_PATH, mcVersion: MINECRAFT, loader: selection.loader, loaderVersion: selection.loaderVersion, fabricVersion: selection.loaderVersion
    }]);
    assert.deepEqual(updater.calls[4].args, [{
      serverPath: SERVER_PATH,
      updates: {
        version: MINECRAFT,
        loader: selection.loader,
        loaderVersion: selection.loaderVersion,
        fabric: selection.loader === 'fabric' ? selection.loaderVersion : null
      }
    }]);
    assert.deepEqual(updater.effects.versions, [[MINECRAFT, selection.loaderVersion, selection.loader]]);
    const state = updater.state();
    assert.equal(state.updateSummary?.loader, selection.loader);
    assert.equal(state.currentTask, 'Update completed successfully!');
    assert.ok(!state.updateError);
    assert.deepEqual(updater.region.focused, []);
  });

  test(`updater: a ${selection.name} install reported as failed is not reported as an update and shows why`, async () => {
    const updater = await loadUpdater([refused(selection)]);
    await updater.update(selection);

    const state = assertNotReportedAsUpdated(updater);
    const message = `${selection.name} installation failed: ${selection.failure.error}`;
    assert.equal(state.updateError, message);
    assert.equal(state.currentTask, `Update failed: ${message}`);
    assertRevealed(updater.region);

    const html = await renderUpdater(state);
    assertShownNextToButton(outcomeAfterButton(html, 'Update Server Version'), message);
    assert.doesNotMatch(textOf(html), /Update Complete/u);
  });
}

test('updater: a loader install that rejects still stops the update as before, and its reason is shown', async () => {
  const updater = await loadUpdater([new Error(REJECTION)]);
  await updater.update(FABRIC);

  // As before: the update stops at the failed step and says so in its task line.
  const state = assertNotReportedAsUpdated(updater);
  assert.equal(state.currentTask, `Update failed: ${REJECTION}`);

  assert.equal(state.updateError, REJECTION);
  assertRevealed(updater.region);
  assertShownNextToButton(outcomeAfterButton(await renderUpdater(state), 'Update Server Version'), REJECTION);
});

test('updater: Update Server Version retries after a failed loader install, and a successful retry completes', async () => {
  const updater = await loadUpdater([refused(NEOFORGE), installed(NEOFORGE)]);
  await updater.update(NEOFORGE);
  assert.ok(updater.state().updateError);

  await updater.update(NEOFORGE);
  assert.deepEqual(updater.channels(), [...UPDATE_STEPS.slice(0, 3), ...UPDATE_STEPS]);
  assert.deepEqual(updater.effects.versions, [[MINECRAFT, NEOFORGE.loaderVersion, NEOFORGE.loader]]);
  const state = updater.state();
  assert.ok(!state.updateError, 'the earlier failure is cleared');
  assert.equal(state.updateSummary?.loader, 'neoforge');
});

test('updater: an install result without success:false still completes the update', async () => {
  for (const answer of [undefined, true, {}]) {
    const updater = await loadUpdater([answer]);
    await updater.update(FABRIC);
    assert.deepEqual(updater.channels(), UPDATE_STEPS, JSON.stringify(answer));
    assert.ok(updater.state().updateSummary);
    assert.ok(!updater.state().updateError);
  }
});
