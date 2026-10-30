const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// N2: the legacy Custom server setup fired update-settings and save-instances
// together. Both reserve the new server folder, so the registration could be
// refused while the settings write held it, and the new server was gone after
// the next restart without a word to the user. These tests run the component's
// own setup handler against stubbed IPC.
const APP_PATH = path.resolve(__dirname, '../src/App.svelte');
const app = fs.readFileSync(APP_PATH, 'utf8');

const EXISTING_SERVER = Object.freeze({
  id: 'server-existing',
  name: 'Existing Server',
  type: 'server',
  path: 'C:\\servers\\existing'
});
const NEW_SERVER_PATH = 'C:\\servers\\custom';
const REFUSAL = 'Another operation is already changing this server';

// The source of one top-level function of the component script, or null when
// the component does not define it.
function functionSource(name) {
  const match = new RegExp(`\\n {2}(?:async )?function ${name}\\(`, 'u').exec(app);
  if (!match) return null;
  const start = match.index + 1;
  const open = app.indexOf('{', app.indexOf(')', start));
  let depth = 0;
  for (let index = open; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}') depth -= 1;
    if (depth === 0) return app.slice(start, index + 1);
  }
  throw new Error(`${name} is not closed`);
}

// handleSetupComplete may hand the registry save and the failure text to these helpers.
const SETUP_FUNCTIONS = ['handleSetupComplete', 'saveInstancesAfterSetup', 'setupFailureText'];

function loadSetupHandler({ invoke, instances = [EXISTING_SERVER], instanceType = 'server' }) {
  const calls = { invoke: [], toastError: [], toastSuccess: [], loggerError: [], loggerWarn: [] };
  const dependencies = {
    instances: instances.map(instance => ({ ...instance })),
    instanceType,
    logger: {
      debug() {},
      info() {},
      warn(message) { calls.loggerWarn.push(message); },
      error(message) { calls.loggerError.push(message); }
    },
    toast: {
      info() {},
      error(title, options) { calls.toastError.push({ title, options }); },
      success(title, options) { calls.toastSuccess.push({ title, options }); }
    },
    window: {
      electron: {
        async invoke(channel, payload) {
          calls.invoke.push({ channel, payload: structuredClone(payload) });
          return invoke(channel, payload);
        }
      }
    },
    storeCurrentInstance() {},
    saveInstancesIfNeeded() {},
    updateServerPath() {},
    async loadServerSettingsForInstance() {},
    activateServerModContext() { return true; },
    async primeServerModState() {},
    refreshServerStatuses() {}
  };
  const sources = SETUP_FUNCTIONS.map(functionSource);
  assert.ok(sources[0], 'App.svelte defines handleSetupComplete');
  const factory = new Function('dependencies', `
    const {
      logger, toast, window, storeCurrentInstance, saveInstancesIfNeeded, updateServerPath,
      loadServerSettingsForInstance, activateServerModContext, primeServerModState, refreshServerStatuses
    } = dependencies;
    let instances = dependencies.instances;
    let instanceType = dependencies.instanceType;
    let currentInstance = null;
    let path = '';
    let step = 'chooseFolder';
    ${sources.filter(Boolean).join('\n')}
    return {
      run: handleSetupComplete,
      state: () => ({ instances, instanceType, currentInstance, path, step })
    };
  `);
  const harness = factory(dependencies);
  return {
    ...harness,
    calls,
    channels: () => calls.invoke.map(call => call.channel)
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

function settled() {
  return new Promise(resolve => setImmediate(resolve));
}

test('Custom server setup writes the server settings before it registers the server', async () => {
  const settingsWrite = deferred();
  const harness = loadSetupHandler({
    async invoke(channel) {
      if (channel === 'update-settings') return settingsWrite.promise;
      if (channel === 'save-instances') return { success: true };
      throw new Error(`Unexpected IPC channel ${channel}`);
    }
  });

  const setup = harness.run({ detail: { path: NEW_SERVER_PATH } });
  await settled();
  await settled();
  assert.deepEqual(harness.channels(), ['update-settings'], 'the registration waits for the settings write');

  settingsWrite.resolve({ success: true });
  await setup;
  assert.deepEqual(harness.channels(), ['update-settings', 'save-instances']);
  const [settings, registration] = harness.calls.invoke;
  assert.equal(settings.payload.serverPath, NEW_SERVER_PATH);
  assert.deepEqual(registration.payload.map(instance => instance.path), [EXISTING_SERVER.path, NEW_SERVER_PATH]);
  assert.equal(settings.payload.instanceId, registration.payload[1].id);
  assert.equal(harness.state().step, 'done');
  assert.deepEqual(harness.calls.toastError, []);
});

test('the first Custom server is registered only after its settings are written', async () => {
  const settingsWrite = deferred();
  const harness = loadSetupHandler({
    instances: [],
    async invoke(channel) {
      if (channel === 'update-settings') return settingsWrite.promise;
      if (channel === 'save-instances') return { success: true };
      throw new Error(`Unexpected IPC channel ${channel}`);
    }
  });

  const setup = harness.run({ detail: { path: NEW_SERVER_PATH } });
  await settled();
  await settled();
  assert.deepEqual(harness.channels(), ['update-settings']);

  settingsWrite.resolve({ success: true });
  await setup;
  assert.deepEqual(harness.channels(), ['update-settings', 'save-instances']);
  assert.deepEqual(harness.calls.invoke[1].payload, [{
    id: 'default-server',
    name: 'Default Server',
    type: 'server',
    path: NEW_SERVER_PATH
  }]);
  assert.equal(harness.state().step, 'done');
});

for (const [label, register, reason] of [
  ['refused', async () => ({ success: false, error: REFUSAL }), REFUSAL],
  ['rejected', async () => { throw new Error(`Error invoking remote method 'save-instances': ${REFUSAL}`); }, REFUSAL],
  // A rejection is not always an Error; the user still gets a readable reason.
  ['reasonless', () => Promise.reject(), 'The instance list could not be saved.'],
  ['bare-object', () => Promise.reject(Object.create(null)), 'The instance list could not be saved.']
]) {
  test(`a ${label} registration of the new server is reported to the user`, async () => {
    const harness = loadSetupHandler({
      async invoke(channel) {
        if (channel === 'update-settings') return { success: true };
        if (channel === 'save-instances') return register();
        throw new Error(`Unexpected IPC channel ${channel}`);
      }
    });

    await harness.run({ detail: { path: NEW_SERVER_PATH } });

    assert.deepEqual(harness.channels(), ['update-settings', 'save-instances']);
    assert.equal(harness.calls.toastError.length, 1, 'the user is told the server was not saved');
    const [{ title, options }] = harness.calls.toastError;
    assert.match(title, /not saved/iu);
    assert.ok(options.description.endsWith(` ${reason}`), options.description);
    assert.match(options.description, /restart/iu);
    assert.ok(harness.calls.loggerError.some(message => /Failed to save instances after setup/u.test(message)));
    assert.equal(harness.state().step, 'done');
  });
}

test('Try again saves the instance list once more and confirms it', async () => {
  const responses = [{ success: false, error: REFUSAL }, { success: true }];
  const harness = loadSetupHandler({
    async invoke(channel) {
      if (channel === 'update-settings') return { success: true };
      if (channel === 'save-instances') return responses.shift();
      throw new Error(`Unexpected IPC channel ${channel}`);
    }
  });

  await harness.run({ detail: { path: NEW_SERVER_PATH } });
  const [{ options }] = harness.calls.toastError;
  assert.equal(options.action?.label, 'Try again');

  options.action.onClick();
  await settled();
  await settled();

  assert.deepEqual(harness.channels(), ['update-settings', 'save-instances', 'save-instances']);
  assert.deepEqual(
    harness.calls.invoke[2].payload.map(instance => instance.path),
    [EXISTING_SERVER.path, NEW_SERVER_PATH]
  );
  assert.equal(harness.calls.toastError.length, 1);
  assert.equal(harness.calls.toastSuccess.length, 1);
});

for (const [label, writeSettings] of [
  ['refused', async () => ({ success: false, error: 'Invalid server path' })],
  ['rejected', async () => { throw new Error('settings write failed'); }],
  ['reasonless rejected', () => Promise.reject()],
  ['bare-object rejected', () => Promise.reject(Object.create(null))]
]) {
  test(`a ${label} settings write still registers the new server`, async () => {
    const harness = loadSetupHandler({
      async invoke(channel) {
        if (channel === 'update-settings') return writeSettings();
        if (channel === 'save-instances') return { success: true };
        throw new Error(`Unexpected IPC channel ${channel}`);
      }
    });

    await harness.run({ detail: { path: NEW_SERVER_PATH } });

    assert.deepEqual(harness.channels(), ['update-settings', 'save-instances']);
    assert.equal(harness.calls.loggerWarn.length, 1);
    assert.deepEqual(harness.calls.toastError, []);
    assert.equal(harness.state().step, 'done');
  });
}

test('a published modpack server is registered by the main process, never by the setup handler', async () => {
  const published = { id: 'server-modpack', name: 'Modpack Server', type: 'server', path: 'C:\\servers\\modpack' };
  const harness = loadSetupHandler({
    async invoke(channel) {
      if (channel === 'get-instances') return [EXISTING_SERVER, published];
      throw new Error(`Unexpected IPC channel ${channel}`);
    }
  });

  await harness.run({ detail: { instanceId: published.id, modpackJobId: 'job-1' } });

  assert.deepEqual(harness.channels(), ['get-instances']);
  assert.equal(harness.state().currentInstance.id, published.id);
  assert.equal(harness.state().step, 'done');
});

// Playwright specs that bundle the real App replace svelte-sonner with a stub
// module. A binding App imports that the stub lacks stops their esbuild step
// before any of their tests runs.
test('Playwright specs that bundle the real App stub every svelte-sonner binding App imports', () => {
  const imported = [...app.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']svelte-sonner["']/gu)]
    .flatMap(([, names]) => names.split(',').map(name => name.trim().split(/\s+as\s+/u)[0]).filter(Boolean));
  assert.ok(imported.includes('toast'), 'App reports a failed registration with a toast');

  const specDirectory = path.join(__dirname, 'e2e');
  const specs = fs.readdirSync(specDirectory)
    .filter(name => name.endsWith('.spec.js'))
    .map(name => ({ name, source: fs.readFileSync(path.join(specDirectory, name), 'utf8') }))
    .filter(({ source }) => /['"]\.\/src\/App\.svelte['"]/u.test(source) && source.includes('/^svelte-sonner$/'));
  for (const known of ['app-sidebar-status.spec.js', 'managed-server-mod-edits.spec.js']) {
    assert.ok(specs.some(({ name }) => name === known), `${known} is checked`);
  }

  for (const { name, source } of specs) {
    const stub = /namespace:\s*'toast-boundary'\s*\},\s*\(\)\s*=>\s*\(\{[\s\S]*?\.replace\('export default',\s*'([^']*)'\)/u
      .exec(source);
    assert.ok(stub, `${name} builds its svelte-sonner stub from a compiled component`);
    const exported = [...stub[1].matchAll(/export const ([A-Za-z_$][\w$]*)\s*=/gu)].map(([, binding]) => binding);
    for (const binding of imported) assert.ok(exported.includes(binding), `${name} stubs svelte-sonner's ${binding}`);
  }
});
