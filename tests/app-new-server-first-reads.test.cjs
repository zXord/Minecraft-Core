const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The main process answers a server's reads (modpack state, operation status,
// server properties, players) only once the server is in its instance list.
// A new Custom server, or an existing server folder added again, was opened
// before save-instances had landed: the echo of set-server-path switched App to
// the Dashboard or Settings while the registration was still pending, and App's
// one modpack state read failed, so the server showed "Operation status
// unavailable", "Version status unavailable" and "Server path is not a known
// server instance" until the user retried or switched servers. These tests run
// App's own setup handler, path-update listener, reactive statements and modpack
// state read against a stubbed main process that knows only registered servers.
const APP_PATH = path.resolve(__dirname, '../src/App.svelte');
const source = fs.readFileSync(APP_PATH, 'utf8');

const EXISTING = Object.freeze({ id: 'server-existing', name: 'Existing Server', type: 'server', path: 'C:\\servers\\existing' });
const NEW_PATH = 'C:\\servers\\custom';
const KEPT_PATH = 'C:\\servers\\kept-files';
const REFUSAL = 'Another operation is already changing this server';
const SETUP_FUNCTIONS = ['handleSetupComplete', 'saveInstancesAfterSetup', 'setupFailureText',
  'refreshCurrentServerModpackState', 'updateServerPath', 'saveInstancesIfNeeded'];

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

// The main process: it registers what save-instances saves, and every
// server-scoped read checks that registration first.
function createMainProcess(registered) {
  const registry = new Map(registered.map(instance => [instance.id, { ...instance }]));
  const calls = [];
  const gates = new Map();
  const answers = new Map();
  return {
    calls,
    registry,
    knows: instance => Boolean(instance) && registry.get(instance.id)?.path === instance.path,
    knowsPath: serverPath => [...registry.values()].some(instance => instance.path === serverPath),
    channels: () => calls.map(call => call.channel),
    gate(channel) {
      const gate = deferred();
      gates.set(channel, gate);
      return gate;
    },
    answerOnce(channel, answer) {
      answers.set(channel, [...(answers.get(channel) || []), answer]);
    },
    async invoke(channel, payload) {
      calls.push({ channel, payload: structuredClone(payload) });
      const gate = gates.get(channel);
      if (gate) {
        gates.delete(channel);
        await gate.promise;
      }
      const answer = answers.get(channel)?.shift();
      if (answer) return answer(payload);
      if (channel === 'update-settings') return { success: true };
      if (channel === 'save-instances') {
        registry.clear();
        for (const instance of payload) if (instance?.type === 'server') registry.set(instance.id, { ...instance });
        return { success: true };
      }
      if (channel === 'get-instances') return [...registry.values()].map(instance => ({ ...instance }));
      throw new Error(`Unexpected IPC channel ${channel}`);
    }
  };
}

let scriptPromise = null;

function loadScript() {
  scriptPromise ??= (async () => {
    const { parse } = await import('svelte/compiler');
    const ast = parse(source, { modern: true });
    const slice = node => source.slice(node.start, node.end);
    const body = ast.instance.content.body;
    const functions = new Map(body.filter(node => node.type === 'FunctionDeclaration')
      .map(node => [node.id.name, slice(node)]));
    for (const name of SETUP_FUNCTIONS) assert.ok(functions.has(name), `App.svelte defines ${name}`);

    const assigns = (node, name) => node.type === 'ExpressionStatement' &&
      node.expression.type === 'AssignmentExpression' && node.expression.left.name === name;
    const reactive = body.filter(node => node.type === 'LabeledStatement' && node.label.name === '$' && (
      assigns(node.body, 'activeServerPath') || assigns(node.body, 'activeServerId') ||
      (node.body.type === 'IfStatement' &&
        slice(node.body.test) === 'modpackStateTrackingReady && activeServerId !== trackedModpackServerId')
    )).map(node => slice(node.body));
    assert.equal(reactive.length, 3, 'App tracks the selected server and reads its modpack state reactively');

    // The renderer's listener for the main process's 'update-server-path'.
    const mount = body.find(node => node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' && node.expression.callee.name === 'onMount');
    const subscription = mount.expression.arguments[0].body.body.find(statement =>
      statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression' &&
      slice(statement.expression.callee) === 'window.electron.on' &&
      statement.expression.arguments[0].value === 'update-server-path');
    assert.ok(subscription, 'App listens for update-server-path');
    const listener = subscription.expression.arguments[1];
    // The listener is written inline or as a named function of the script.
    const namedListener = listener.type === 'Identifier' ? functions.get(listener.name) : null;
    assert.ok(listener.type !== 'Identifier' || namedListener, 'the update-server-path listener is defined in App');

    const prop = /modpackManaged=\{([^}]*)\}/u.exec(source);
    assert.ok(prop, 'App passes the selected server modpack ownership to its views');
    return {
      functions: [...SETUP_FUNCTIONS.map(name => functions.get(name)), ...(namedListener ? [namedListener] : [])],
      reactive,
      listenerSource: namedListener ? listener.name : slice(listener),
      modpackManagedProp: prop[1]
    };
  })();
  return scriptPromise;
}

async function loadApp({ main, instances, currentInstance = null, overrides = {} }) {
  const script = await loadScript();
  const records = { stateReads: [], views: [], primes: [], toastError: [], toastSuccess: [], legacySaves: [] };
  let echo = () => {};
  const dependencies = {
    instances: instances.map(instance => ({ ...instance })),
    currentInstance: currentInstance ? { ...currentInstance } : null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    toast: {
      error(title, options) { records.toastError.push({ title, options }); },
      success(title, options) { records.toastSuccess.push({ title, options }); }
    },
    window: {
      electron: { invoke: (channel, payload) => { scheduleFlush(); return main.invoke(channel, payload); } },
      // set-server-path answers by sending update-server-path back to the renderer.
      serverPath: {
        set(serverPath) {
          setImmediate(() => echo(serverPath));
          return Promise.resolve({ success: true, path: serverPath });
        }
      }
    },
    modpackApi: {
      async getState(serverId) {
        const registered = main.registry.has(serverId);
        records.stateReads.push({ serverId, registered });
        if (!registered) {
          throw Object.assign(new Error('The server instance is no longer available'), { code: 'PLAN_STALE' });
        }
        return { type: 'modpack-state', instanceId: serverId, modpackManaged: false };
      }
    },
    saveInstances(list) { records.legacySaves.push(list); },
    storeCurrentInstance() { scheduleFlush(); },
    async loadServerSettingsForInstance() { scheduleFlush(); },
    activateServerModContext() { scheduleFlush(); return false; },
    // Priming reads the server's mods and content through the main process.
    async primeServerModState(serverPath) { records.primes.push({ serverPath, registered: main.knowsPath(serverPath) }); },
    refreshServerStatuses() { scheduleFlush(); },
    ...overrides
  };
  const factory = new Function('dependencies', `
    const {
      logger, toast, window, modpackApi, saveInstances, storeCurrentInstance, loadServerSettingsForInstance,
      activateServerModContext, primeServerModState, refreshServerStatuses
    } = dependencies;
    let instances = dependencies.instances;
    let instanceType = 'server';
    let currentInstance = dependencies.currentInstance;
    let path = currentInstance?.path || '';
    let step = 'chooseFolder';
    let modpackStateTrackingReady = true;
    let trackedModpackServerId = '';
    let modpackStateRequestSequence = 0;
    let currentServerModpackManaged = false;
    let currentServerModpackStateKnown = false;
    let currentServerModpackStateGeneration = 0;
    let activeServerPath;
    let activeServerId;
    ${script.functions.join('\n')}
    const serverPathListener = ${script.listenerSource};
    return {
      run: handleSetupComplete,
      updateServerPathFromMain: serverPathListener,
      flushReactive() {
        ${script.reactive.join('\n')}
      },
      state: () => ({
        instances, instanceType, currentInstance, path, step, activeServerId,
        modpackStateGeneration: currentServerModpackStateGeneration,
        modpackManaged: ${script.modpackManagedProp}
      })
    };
  `);
  const app = factory(dependencies);

  // Svelte runs App's reactive statements after each change, and the selected
  // server's route view opens once the setup step is done. An opened view reads
  // its server through the main process at once.
  let openView = null;
  function flush() {
    app.flushReactive();
    const { step, currentInstance: selected } = app.state();
    if (step === 'done' && selected?.type === 'server') {
      if (openView !== selected.id) {
        openView = selected.id;
        records.views.push({ serverId: selected.id, serverPath: selected.path, registered: main.knows(selected) });
      }
    } else openView = null;
  }
  let flushScheduled = false;
  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      flush();
    });
  }
  echo = serverPath => {
    app.updateServerPathFromMain(serverPath);
    flush();
  };
  flush();

  return {
    ...app,
    ...records,
    async settle() {
      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
        flush();
      }
    }
  };
}

// While the new server is registered, App shows a progress view in place of the
// finished setup view, which could otherwise start a second setup.
const REGISTERING_VIEW = /\{#if step === "chooseFolder"\}[\s\S]*?\{:else if step === "registering"\}\s*<div class="route-loading">/u;

function assertNotOpened(app, serverPath) {
  const { currentInstance, step } = app.state();
  assert.notEqual(currentInstance?.path, serverPath, 'the new server is not selected before it is registered');
  assert.equal(step, 'registering', 'no server view is open while the new server is registered');
  assert.match(source, REGISTERING_VIEW, 'the registration shows a progress view instead of the setup view');
  assert.equal(app.state().instances.some(instance => instance.path === serverPath), false,
    'the sidebar cannot select the new server before it is registered');
  assert.deepEqual(app.views.filter(view => view.serverPath === serverPath), [], 'no view of the new server opened');
  assert.deepEqual(app.stateReads.filter(read => !read.registered), [], 'no modpack state read reached an unregistered server');
  assert.deepEqual(app.primes, [], 'the new server content is not read yet');
}

function assertOpenedRegistered(app, main, serverPath) {
  const { currentInstance, step, modpackManaged } = app.state();
  assert.equal(currentInstance?.path, serverPath);
  assert.equal(step, 'done');
  assert.ok(main.knows(currentInstance), 'the opened server is registered in the main process');
  assert.deepEqual(app.views, [{ serverId: currentInstance.id, serverPath, registered: true }],
    'the Dashboard or Settings of the new server opens once, after the registration');
  assert.ok(app.stateReads.some(read => read.serverId === currentInstance.id), 'App reads the new server modpack state');
  assert.deepEqual(app.stateReads.filter(read => !read.registered), [], 'every modpack state read finds the server');
  assert.equal(modpackManaged, false, 'the views know the server is unmanaged (Check Updates, loose mod edits)');
  assert.deepEqual(app.primes, [{ serverPath, registered: true }]);
  assert.deepEqual(app.legacySaves, [], 'the instance list is saved once, by the setup');
}

for (const [label, instances, currentInstance, detail] of [
  ['a new Custom server', [EXISTING], EXISTING, { path: NEW_PATH }],
  ['the first Custom server', [], null, { path: NEW_PATH }],
  // Delete Instance with "Delete all server files" unticked, then Choose Folder
  // on the same folder: its config is found and setup completes at once.
  ['an existing server folder added again', [EXISTING], EXISTING,
    { path: KEPT_PATH, mcVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.13', fabricVersion: '47.4.13' }]
]) {
  test(`${label} opens only after the main process has registered it`, async () => {
    const main = createMainProcess(instances);
    const settings = main.gate('update-settings');
    const registration = main.gate('save-instances');
    const app = await loadApp({ main, instances, currentInstance });

    const setup = app.run({ detail });
    await app.settle();
    assert.deepEqual(main.channels(), ['update-settings']);
    assertNotOpened(app, detail.path);

    settings.resolve();
    await app.settle();
    assert.deepEqual(main.channels(), ['update-settings', 'save-instances'], 'the settings are written first');
    assertNotOpened(app, detail.path);

    registration.resolve();
    await setup;
    await app.settle();
    assertOpenedRegistered(app, main, detail.path);
    const saved = main.calls.find(call => call.channel === 'save-instances').payload;
    assert.deepEqual(saved.map(instance => instance.path), [...instances.map(instance => instance.path), detail.path]);
    assert.equal(app.state().instances.at(-1).id, app.state().currentInstance.id);
  });
}

test('a server published by a modpack setup opens with every read finding it registered', async () => {
  const published = { id: 'server-modpack', name: 'Modpack Server', type: 'server', path: 'C:\\servers\\modpack' };
  const main = createMainProcess([EXISTING, published]);
  const app = await loadApp({ main, instances: [EXISTING], currentInstance: EXISTING });

  await app.run({ detail: { instanceId: published.id, modpackJobId: 'job-1' } });
  await app.settle();

  assert.deepEqual(main.channels(), ['get-instances']);
  assertOpenedRegistered(app, main, published.path);
});

// Each failure is injected once: the setup's own call fails, later calls work.
function failOnce(message) {
  let failed = false;
  return () => {
    if (failed) return false;
    failed = true;
    throw new Error(message);
  };
}

for (const [label, overrides] of [
  ['opening the registered server', { storeCurrentInstance: failOnce('injected selection failure') }],
  ['loading the new server mod state', { activateServerModContext: failOnce('injected mod state failure') }]
]) {
  test(`a failure while ${label} never leaves the "Adding the server..." view up`, async () => {
    const main = createMainProcess([EXISTING]);
    const app = await loadApp({ main, instances: [EXISTING], currentInstance: EXISTING, overrides });

    await assert.rejects(app.run({ detail: { path: NEW_PATH } }), /injected/);
    await app.settle();

    assert.equal(app.state().step, 'done');
    assert.ok(main.knowsPath(NEW_PATH), 'the new server was registered before the failure');
  });
}

test('the sidebar cannot switch servers or start another setup while a new server is registered', async () => {
  const { parse } = await import('svelte/compiler');
  const ast = parse(source, { modern: true });
  const declared = new Map(ast.instance.content.body.filter(node => node.type === 'FunctionDeclaration')
    .map(node => [node.id.name, node]));
  for (const name of ['switchInstance', 'showAddInstanceScreen']) {
    const first = declared.get(name)?.body.body[0];
    assert.ok(first, `App.svelte defines ${name}`);
    assert.equal(source.slice(first.start, first.end), 'if (step === "registering") return;',
      `${name} does nothing while a new server is registered`);
  }
});

test('a refused registration still opens the server, and Try again reads its modpack state once it is saved', async () => {
  const main = createMainProcess([EXISTING]);
  main.answerOnce('save-instances', () => ({ success: false, error: REFUSAL }));
  const app = await loadApp({ main, instances: [EXISTING], currentInstance: EXISTING });

  await app.run({ detail: { path: NEW_PATH } });
  await app.settle();
  const { currentInstance } = app.state();
  assert.equal(currentInstance.path, NEW_PATH, 'the new server is usable for this session, as before');
  assert.equal(app.state().step, 'done');
  assert.equal(main.knows(currentInstance), false);
  assert.equal(app.state().modpackManaged, null, 'its ownership stays unknown while it is not registered');
  assert.equal(app.toastError.length, 1);
  const generation = app.state().modpackStateGeneration;

  app.toastError[0].options.action.onClick();
  await app.settle();
  assert.ok(main.knows(currentInstance), 'Try again registers the server');
  assert.equal(app.toastSuccess.length, 1);
  assert.equal(app.state().modpackManaged, false, 'the server ownership is read again once it is registered');
  assert.ok(app.state().modpackStateGeneration > generation, 'the Dashboard is told to check the server again');
});
