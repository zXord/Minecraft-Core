const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// A server added a moment ago opened on a Dashboard that said "Operation status
// unavailable" with Start disabled until Retry check was pressed: its first
// operation check ran before the main process listed the server, and a failed
// check was never read again. These tests run the component's own check code,
// reactive statements, banner and teardown against stubbed modpack IPC and a
// manual clock.
const CONTROLS_PATH = path.resolve(__dirname, '../src/components/server/ServerControls.svelte');
const source = fs.readFileSync(CONTROLS_PATH, 'utf8');

const SERVER = Object.freeze({ id: 'server-new', type: 'server', path: 'C:\\servers\\new' });
const OTHER = Object.freeze({ id: 'server-other', type: 'server', path: 'C:\\servers\\other' });
const BANNER_TEST = 'currentInstanceId && serverPath && recoveryStartBlocked';
const CHECKING = 'Checking recovery status…';
const OPERATION_UNAVAILABLE = 'Operation status unavailable';
const RECOVERY_UNAVAILABLE = 'Recovery status could not be checked';
const OPERATION_RUNNING = 'Operation in progress. Starts remain blocked until the owned operation settles.';

// The main process answers PLAN_STALE for a server it does not list yet.
function unregistered() {
  throw Object.assign(new Error('The server instance is no longer available'), { code: 'PLAN_STALE' });
}

function servicesUnavailable() {
  throw Object.assign(new Error('Modpack features are turned off'), { code: 'MODPACK_SERVICES_UNAVAILABLE' });
}

const idle = serverId => ({ serverId, items: [] });
const running = serverId => ({ serverId, items: [{ ownership: 'running', job: { jobId: 'job-running', serverId } }] });
const noRecords = () => [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(callback, delay = 0) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending() { return [...timers.values()].sort((left, right) => left.due - right.due || left.id - right.id); },
    // Runs every timer that falls due within ms, in order, settling after each.
    async advance(ms, settle) {
      const end = now + ms;
      for (;;) {
        const next = this.pending().find(timer => timer.due <= end);
        if (!next) break;
        timers.delete(next.id);
        now = next.due;
        next.callback();
        await settle();
      }
      now = end;
    }
  };
}

// Each answer is a function of the request; queued answers are used first.
function createModpackApi() {
  const calls = { activity: [], recovery: 0 };
  const queued = { activity: [], recovery: [] };
  const defaults = { activity: idle, recovery: noRecords };
  return {
    calls,
    queued,
    defaults,
    api: {
      async getActiveJobs(serverId) {
        calls.activity.push(serverId);
        return (queued.activity.shift() || defaults.activity)(serverId);
      },
      async listRecovery() {
        calls.recovery += 1;
        return (queued.recovery.shift() || defaults.recovery)();
      }
    }
  };
}

function text(node) {
  return node.fragment.nodes.filter(child => child.type === 'Text').map(child => child.data).join('').trim();
}

function childNodes(node) {
  return ['fragment', 'consequent', 'alternate', 'body', 'pending', 'then', 'catch', 'fallback']
    .flatMap(key => node[key]?.nodes || []);
}

let scriptPromise = null;

// The script's declarations, the reactive statements that drive the recovery
// check, the onDestroy teardown, and the recovery banner of the template.
function loadScript() {
  scriptPromise ??= (async () => {
    const { parse } = await import('svelte/compiler');
    const ast = parse(source, { modern: true });
    const slice = node => source.slice(node.start, node.end);
    const body = ast.instance.content.body;
    const imports = body.filter(node => node.type === 'ImportDeclaration')
      .flatMap(node => node.specifiers.map(specifier => specifier.local.name));
    const declarations = [];
    const reactive = [];
    let teardown = null;
    const assigns = (node, name) => node.type === 'ExpressionStatement' &&
      node.expression.type === 'AssignmentExpression' && node.expression.left.name === name;
    const recoveryStatement = node => assigns(node, 'currentInstanceId') || assigns(node, 'recoveryScopeKey') ||
      assigns(node, 'recoveryStartBlocked') ||
      (node.type === 'IfStatement' && slice(node.test) === 'recoveryMounted && recoveryScopeKey !== loadedRecoveryScopeKey');
    for (const node of body) {
      const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
      if (declaration?.type === 'VariableDeclaration' || declaration?.type === 'FunctionDeclaration') {
        declarations.push(slice(declaration));
      } else if (node.type === 'LabeledStatement' && node.label.name === '$' && recoveryStatement(node.body)) {
        reactive.push(slice(node.body));
      } else if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' &&
          node.expression.callee.name === 'onDestroy') {
        teardown = slice(node.expression.arguments[0].body);
      }
    }
    assert.equal(reactive.length, 4, 'ServerControls derives its recovery scope and start gate reactively');
    assert.ok(teardown, 'ServerControls tears its checks down in onDestroy');

    const queue = [...ast.fragment.nodes];
    let banner = null;
    while (queue.length && !banner) {
      const node = queue.shift();
      if (node.type === 'IfBlock' && slice(node.test) === BANNER_TEST) banner = node;
      else queue.push(...childNodes(node));
    }
    assert.ok(banner, 'ServerControls shows a recovery banner while Start is blocked');
    return { imports, declarations, reactive, teardown, banner, slice };
  })();
  return scriptPromise;
}

async function loadControls({ api }) {
  const [{ imports, declarations, reactive, teardown, banner, slice }, scope, notifications] = await Promise.all([
    loadScript(),
    import('../src/utils/modpacks/serverRequestScope.js'),
    import('../src/stores/modpackNotificationStore.js')
  ]);
  const clock = createClock();
  const runtime = ['setTimeout', 'clearTimeout', 'clearInterval', 'window', 'document'];
  const factory = new Function('dependencies', `
    const { ${[...imports, ...runtime].join(', ')} } = dependencies;
    let currentInstanceId, recoveryScopeKey, recoveryStartBlocked;
    ${declarations.join('\n')}
    function flushReactive() {
      ${reactive.join('\n')}
    }
    return {
      setProps(next) {
        if (Object.hasOwn(next, 'serverPath')) serverPath = next.serverPath;
        if (Object.hasOwn(next, 'currentInstance')) currentInstance = next.currentInstance;
        if (Object.hasOwn(next, 'modpackStateGeneration')) modpackStateGeneration = next.modpackStateGeneration;
        flushReactive();
      },
      // ServerControls' onMount marks the checks mounted and reads them once.
      mount() {
        recoveryMounted = true;
        const initialRead = refreshRecovery();
        flushReactive();
        return initialRead;
      },
      destroy() ${teardown},
      flush: flushReactive,
      evaluate(expression) { return eval(expression); }
    };
  `);
  const controls = factory({
    modpackApi: api,
    createServerRequestScope: scope.createServerRequestScope,
    filterRecoveryRecordsForServer: notifications.filterRecoveryRecordsForServer,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
    clearTimeout: id => clock.clearTimeout(id),
    clearInterval() {},
    window: { electron: { removeListener() {}, removeAllListeners() {} } },
    document: { removeEventListener() {} }
  });

  async function settle() {
    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise(resolve => setImmediate(resolve));
      controls.flush();
    }
  }

  // The banner as the template renders it: its message and its buttons.
  function bannerView() {
    if (!controls.evaluate(BANNER_TEST)) return null;
    const container = banner.consequent.nodes.find(node => node.type === 'RegularElement');
    let branch = container.fragment.nodes.find(node => node.type === 'IfBlock');
    let fragment = null;
    while (branch && !fragment) {
      if (controls.evaluate(slice(branch.test))) fragment = branch.consequent;
      else {
        const next = branch.alternate?.nodes.find(node => node.type === 'IfBlock' && node.elseif);
        if (next) branch = next;
        else fragment = branch.alternate;
      }
    }
    const elements = fragment.nodes.filter(node => node.type === 'RegularElement');
    return {
      message: text(elements.find(element => element.name === 'p')),
      buttons: Object.fromEntries(elements.filter(element => element.name === 'button').map(button => {
        const click = button.attributes.find(attribute => attribute.type === 'OnDirective' && attribute.name === 'click');
        return [text(button), () => controls.evaluate(`(${slice(click.expression)})`)()];
      }))
    };
  }

  return {
    clock,
    settle,
    show(instance) {
      controls.setProps({ serverPath: instance.path, currentInstance: instance, modpackStateGeneration: 0 });
    },
    switchTo(instance) {
      controls.setProps({ serverPath: instance.path, currentInstance: instance });
    },
    async mount() {
      await controls.mount();
      await settle();
    },
    destroy() { controls.destroy(); },
    advance: ms => clock.advance(ms, settle),
    banner: bannerView,
    // The Minecraft Start button is disabled by the gate, and startServer()
    // and the auto-start run only when the check allows a start.
    startBlocked: () => controls.evaluate('recoveryStartBlocked'),
    canStart: () => controls.evaluate('canStartAfterRecoveryCheck()'),
    state: () => controls.evaluate('({ activityStatus, recoveryStatus, activeOperationCount, recoveryPendingCount })')
  };
}

async function mounted(api, instance = SERVER) {
  const controls = await loadControls({ api: api.api });
  controls.show(instance);
  await controls.mount();
  return controls;
}

function assertBlocked(controls, message) {
  assert.equal(controls.banner()?.message, message);
  assert.equal(controls.startBlocked(), true, 'Start is disabled');
  assert.equal(controls.canStart(), false, 'a start request is refused');
}

function assertReady(controls) {
  assert.equal(controls.banner(), null, 'no recovery banner is shown');
  assert.equal(controls.startBlocked(), false, 'Start is enabled');
  assert.equal(controls.canStart(), true, 'a start request is allowed');
}

for (const [label, fail] of [['operation', 'activity'], ['recovery', 'recovery']]) {
  test(`a failed first ${label} check is read again and opens the server ready to start without Retry`, async () => {
    const api = createModpackApi();
    api.queued[fail].push(fail === 'activity' ? unregistered : servicesUnavailable);
    const controls = await mounted(api);

    assert.deepEqual(controls.state(), {
      activityStatus: fail === 'activity' ? 'loading' : 'ready',
      recoveryStatus: fail === 'recovery' ? 'loading' : 'ready',
      activeOperationCount: 0,
      recoveryPendingCount: 0
    }, 'one failed read is not reported as unavailable yet');
    assertBlocked(controls, CHECKING);

    await controls.advance(10_000);

    assertReady(controls);
    assert.deepEqual(api.calls.activity, [SERVER.id, SERVER.id]);
    assert.equal(api.calls.recovery, 2);
    assert.deepEqual(controls.clock.pending(), [], 'nothing is read again after a successful check');
  });
}

for (const [label, fail, banner] of [
  ['operation', 'activity', OPERATION_UNAVAILABLE],
  ['recovery', 'recovery', RECOVERY_UNAVAILABLE]
]) {
  test(`a persistent ${label} check failure still blocks Start and shows the banner with Retry check`, async () => {
    const api = createModpackApi();
    api.defaults[fail] = fail === 'activity' ? unregistered : servicesUnavailable;
    const controls = await mounted(api);

    let shownAt = null;
    while (shownAt === null && controls.clock.now <= 15_000) {
      assert.equal(controls.startBlocked(), true, 'Start stays disabled while the check is read again');
      assert.equal(controls.canStart(), false);
      if (controls.banner()?.message === banner) shownAt = controls.clock.now;
      else await controls.advance(100);
    }
    const attempts = fail === 'activity' ? api.calls.activity.length : api.calls.recovery;
    assert.ok(shownAt !== null && shownAt <= 10_000, `the banner is shown within about ten seconds (${shownAt} ms)`);
    assert.ok(attempts >= 3 && attempts <= 6, `the check is read a few times (${attempts})`);
    assertBlocked(controls, banner);
    assert.ok(controls.banner().buttons['Retry check'], 'the banner offers Retry check');

    await controls.advance(30_000);
    assert.equal(fail === 'activity' ? api.calls.activity.length : api.calls.recovery, attempts,
      'the check is not read again until the user retries');
    assertBlocked(controls, banner);

    api.defaults[fail] = fail === 'activity' ? idle : noRecords;
    controls.banner().buttons['Retry check']();
    await controls.settle();
    assertReady(controls);
  });
}

test('a real unsettled operation still blocks Start until the operation settles', async () => {
  const api = createModpackApi();
  api.defaults.activity = running;
  const controls = await mounted(api);
  assertBlocked(controls, OPERATION_RUNNING);
  assert.deepEqual(controls.clock.pending().map(timer => timer.due), [1200], 'only the owner settlement is polled');

  await controls.advance(1200);
  assertBlocked(controls, OPERATION_RUNNING);

  api.defaults.activity = idle;
  await controls.advance(1200);
  assertReady(controls);
});

test('switching servers while a failed check waits to be read again never reads or applies the old server', async () => {
  const api = createModpackApi();
  api.queued.activity.push(unregistered);
  const controls = await mounted(api);
  assertBlocked(controls, CHECKING);

  const otherRead = deferred();
  api.queued.activity.push(() => otherRead.promise);
  controls.switchTo(OTHER);
  await controls.settle();
  await controls.advance(10_000);
  assert.deepEqual(api.calls.activity, [SERVER.id, OTHER.id], 'the old server is not read again');
  assertBlocked(controls, CHECKING);

  otherRead.resolve(idle(OTHER.id));
  await controls.settle();
  assertReady(controls);
});

for (const late of ['answer', 'rejection']) {
  test(`a late old-server ${late} from a repeated check cannot change the newly selected server`, async () => {
    const api = createModpackApi();
    api.queued.activity.push(unregistered);
    const controls = await mounted(api);
    const oldRead = deferred();
    api.queued.activity.push(() => oldRead.promise);
    await controls.advance(10_000);
    assert.deepEqual(api.calls.activity, [SERVER.id, SERVER.id], 'the failed check is read again');

    controls.switchTo(OTHER);
    await controls.settle();
    assertReady(controls);

    if (late === 'answer') oldRead.resolve(running(SERVER.id));
    else oldRead.reject(Object.assign(new Error('late'), { code: 'PLAN_STALE' }));
    await controls.settle();
    await controls.advance(10_000);
    assertReady(controls);
    assert.equal(controls.state().activeOperationCount, 0);
    assert.deepEqual(api.calls.activity, [SERVER.id, SERVER.id, OTHER.id]);
  });
}

test('closing the Dashboard while a failed check waits stops the check', async () => {
  const api = createModpackApi();
  api.queued.activity.push(unregistered);
  const controls = await mounted(api);
  assertBlocked(controls, CHECKING);

  controls.destroy();
  assert.deepEqual(controls.clock.pending(), [], 'no check waits to be read again');
  await controls.advance(10_000);
  assert.deepEqual(api.calls.activity, [SERVER.id]);
  assert.equal(api.calls.recovery, 1);
});
