const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

// The friend's Mods tab draws its mod rows progressively: up to 80 rows at
// once, then 80 more per animation frame. With a host that had 2 required mods
// the Required Mods table showed "2 mods" and its column titles but no rows,
// and neither Refresh nor Hide List / Show List brought them back. These tests
// mount the real components in a small DOM and read the rows they draw.
const ROOT = path.resolve(__dirname, '..');

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// Just the DOM that Svelte's client runtime and these tests use.
let currentDocument = null;

class FakeNode extends EventTarget {
  constructor(nodeType, nodeName) {
    super();
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = currentDocument;
    this.parentNode = null;
    this.childNodes = [];
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }

  get nextSibling() {
    const siblings = this.parentNode?.childNodes;
    return siblings ? siblings[siblings.indexOf(this) + 1] ?? null : null;
  }

  get previousSibling() {
    const siblings = this.parentNode?.childNodes;
    return siblings ? siblings[siblings.indexOf(this) - 1] ?? null : null;
  }

  get textContent() {
    return this.childNodes.map(child => (child.nodeType === COMMENT_NODE ? '' : child.textContent)).join('');
  }

  set textContent(value) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (value) this.appendChild(new FakeText(value));
  }

  insertBefore(node, reference) {
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      for (const child of [...node.childNodes]) this.insertBefore(child, reference);
      return node;
    }
    node.parentNode?.removeChild(node);
    const index = reference == null ? this.childNodes.length : this.childNodes.indexOf(reference);
    if (index === -1) throw new Error('insertBefore: the reference node is not a child of this node');
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) throw new Error('removeChild: the node is not a child of this node');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(asNode(node));
  }

  before(...nodes) {
    for (const node of nodes) this.parentNode?.insertBefore(asNode(node), this);
  }

  after(...nodes) {
    const next = this.nextSibling;
    for (const node of nodes) this.parentNode?.insertBefore(asNode(node), next);
  }

  cloneNode(deep = false) {
    const copy = this.cloneShallow();
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }
}

class FakeText extends FakeNode {
  constructor(data = '') {
    super(TEXT_NODE, '#text');
    this.data = String(data);
  }

  get nodeValue() {
    return this.data;
  }

  set nodeValue(value) {
    this.data = String(value ?? '');
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value ?? '');
  }

  cloneShallow() {
    return new FakeText(this.data);
  }
}

class FakeComment extends FakeNode {
  constructor(data = '') {
    super(COMMENT_NODE, '#comment');
    this.data = String(data);
  }

  get nodeValue() {
    return this.data;
  }

  set nodeValue(value) {
    this.data = String(value ?? '');
  }

  get textContent() {
    return this.data;
  }

  cloneShallow() {
    return new FakeComment(this.data);
  }
}

class FakeElement extends FakeNode {
  constructor(name, namespaceURI = HTML_NAMESPACE) {
    super(ELEMENT_NODE, name.toUpperCase());
    this.localName = name.toLowerCase();
    this.tagName = this.nodeName;
    this.namespaceURI = namespaceURI;
    this.attributeValues = new Map();
  }

  getAttribute(name) {
    return this.attributeValues.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributeValues.has(name);
  }

  setAttribute(name, value) {
    this.attributeValues.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributeValues.delete(name);
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/u).filter(Boolean);
    return {
      contains: name => names().includes(name),
      toggle(name, force = !names().includes(name)) {
        const others = names().filter(other => other !== name);
        element.className = (force ? [...others, name] : others).join(' ');
        return force;
      }
    };
  }

  cloneShallow() {
    const copy = new FakeElement(this.localName, this.namespaceURI);
    for (const [name, value] of this.attributeValues) copy.attributeValues.set(name, value);
    return copy;
  }
}

class FakeMediaElement extends FakeElement {}

class FakeFragment extends FakeNode {
  constructor() {
    super(DOCUMENT_FRAGMENT_NODE, '#document-fragment');
  }

  cloneShallow() {
    return new FakeFragment();
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(DOCUMENT_NODE, '#document');
    this.contentType = 'text/html';
    this.head = new FakeElement('head');
    this.body = new FakeElement('body');
    this.activeElement = this.body;
  }

  createElement(name) {
    return new FakeElement(name);
  }

  createElementNS(namespaceURI, name) {
    return new FakeElement(name, namespaceURI);
  }

  createTextNode(data) {
    return new FakeText(data);
  }

  createComment(data) {
    return new FakeComment(data);
  }

  createDocumentFragment() {
    return new FakeFragment();
  }

  importNode(node, deep) {
    return node.cloneNode(deep);
  }
}

function asNode(value) {
  return value instanceof FakeNode ? value : new FakeText(value);
}

// requestAnimationFrame only queues; runFrame() plays one frame.
const frames = new Map();
let lastFrameId = 0;

function requestFrame(callback) {
  lastFrameId += 1;
  frames.set(lastFrameId, callback);
  return lastFrameId;
}

function cancelFrame(id) {
  frames.delete(id);
}

function installDom() {
  currentDocument = new FakeDocument();
  const fakeWindow = new EventTarget();
  fakeWindow.document = currentDocument;
  const globals = {
    window: fakeWindow,
    document: currentDocument,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLMediaElement: FakeMediaElement,
    Text: FakeText,
    Comment: FakeComment,
    DocumentFragment: FakeFragment,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame
  };
  const saved = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

let svelte;
let restoreDom;

// Compiles the real components for the browser, as the app's build does,
// except with fragments: 'tree' so templates are built with createElement and
// the DOM above needs no HTML parser. The component code is otherwise the same.
test.before(async () => {
  restoreDom = installDom();
  const { build } = require('esbuild');
  const { compile } = await import('svelte/compiler');
  const result = await build({
    absWorkingDir: ROOT,
    stdin: {
      resolveDir: ROOT,
      contents: `
        export { default as ClientModList } from './src/components/client/ClientModList.svelte';
        export { default as ClientManualModList } from './src/components/client/ClientManualModList.svelte';
        export { flushSync } from 'svelte';
        export { createClassComponent } from 'svelte/legacy';
      `
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    conditions: ['browser', 'production'],
    logLevel: 'silent',
    plugins: [{
      name: 'client-mod-list-components',
      setup(builder) {
        // The stores these lists import, without the app's IPC and logging.
        builder.onResolve({ filter: /\/stores\/(?:clientModManager\.js|modStore)$/ }, () => ({
          path: 'mod-stores',
          namespace: 'test-stub'
        }));
        builder.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({
          contents: `
            import { writable } from 'svelte/store';
            import { SvelteSet } from 'svelte/reactivity';
            export const modSyncStatus = writable(null);
            export const serverManagedFiles = writable(new SvelteSet());
            export const minecraftVersion = writable('1.20.1');
          `,
          resolveDir: ROOT
        }));
        builder.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => ({
          contents: compile(await fs.readFile(filename, 'utf8'), {
            filename, generate: 'client', css: 'external', dev: false, fragments: 'tree'
          }).js.code,
          resolveDir: path.dirname(filename)
        }));
      }
    }]
  });
  svelte = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

test.after(() => {
  restoreDom?.();
});

test.beforeEach(() => {
  frames.clear();
});

function descendants(node) {
  return node.childNodes.flatMap(child => [child, ...descendants(child)]);
}

function elements(root, name, className = null) {
  return descendants(root).filter(node => node.nodeType === ELEMENT_NODE
    && node.localName === name
    && (className === null || node.classList.contains(className)));
}

function textOf(node) {
  return node.textContent.replace(/\s+/gu, ' ').trim();
}

function mount(Component, props) {
  const target = currentDocument.createElement('div');
  currentDocument.body.appendChild(target);
  const component = svelte.createClassComponent({ component: Component, target, props });
  svelte.flushSync();
  // Each mod row has one name cell; dependency notes are rows of their own.
  const modRows = () => elements(target, 'tr').filter(row => elements(row, 'div', 'mod-name-cell').length > 0);
  return {
    target,
    set(next) {
      component.$set(next);
      svelte.flushSync();
    },
    rowNames: () => modRows().map(row => textOf(elements(row, 'div', 'mod-name-cell')[0])),
    rowCells: column => modRows().map(row => textOf(elements(row, 'td', column)[0])),
    count: () => elements(target, 'span', 'section-count').map(textOf),
    columnHeaderRows: () => elements(target, 'tr', 'column-headers').length,
    collapsedRows: () => elements(target, 'tr', 'collapsed-state').map(textOf),
    emptyRows: () => elements(target, 'tr', 'empty-state').map(textOf),
    toggleButton: () => elements(target, 'button').find(button => /^(?:Hide|Show) List$/u.test(textOf(button))),
    clickToggle() {
      this.toggleButton().dispatchEvent(new Event('click'));
      svelte.flushSync();
    },
    destroy() {
      component.$destroy();
      svelte.flushSync();
      target.remove();
    }
  };
}

function runFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
  svelte.flushSync();
}

function makeMods(count, prefix = 'Mod') {
  return Array.from({ length: count }, (_, index) => ({
    fileName: `${prefix.toLowerCase().replace(/\s+/gu, '-')}-${index + 1}.jar`,
    name: `${prefix} ${index + 1}`,
    versionNumber: `1.0.${index + 1}`
  }));
}

function namesOf(mods) {
  return mods.map(mod => mod.name);
}

// A friend whose required mods are all installed and match the host.
function syncedStatus(overrides = {}) {
  return {
    synchronized: true,
    totalRequired: 0,
    missingMods: [],
    outdatedMods: [],
    missingOptionalMods: [],
    outdatedOptionalMods: [],
    presentDisabledMods: [],
    requiredRemovals: [],
    optionalRemovals: [],
    acknowledgments: [],
    ...overrides
  };
}

function requiredProps(mods, extra = {}) {
  return {
    mods,
    type: 'required',
    modSyncStatus: syncedStatus({ totalRequired: mods.length }),
    serverManagedFiles: new Set(mods.map(mod => mod.fileName.toLowerCase())),
    ...extra
  };
}

test('a host with 2 required mods shows both rows on the Mods tab', () => {
  // A fresh mount is also what Refresh shows: when the host has no
  // server-only mods, ClientModManager swaps the list for "Loading Mods..."
  // during each sync and mounts it again afterwards.
  const mods = [
    { fileName: 'fabric-api-0.92.2+1.20.1.jar', name: 'Fabric API', versionNumber: '0.92.2+1.20.1' },
    { fileName: 'sodium-fabric-0.5.13+mc1.20.1.jar', name: 'Sodium', versionNumber: '0.5.13+mc1.20.1' }
  ];
  const view = mount(svelte.ClientModList, requiredProps(mods));

  assert.deepEqual(view.count(), ['2 mods']);
  assert.equal(view.columnHeaderRows(), 1);
  assert.deepEqual(view.rowNames(), ['Fabric API', 'Sodium']);
  assert.deepEqual(view.rowCells('status'), ['🔒 Server', '🔒 Server']);
  assert.deepEqual(view.rowCells('ver'), ['0.92.2+1.20.1', '0.5.13+mc1.20.1']);
  assert.deepEqual(view.rowCells('act'), ['Required', 'Required']);
  assert.equal(frames.size, 0, 'a short list is drawn without waiting for a frame');
  view.destroy();
});

test('an empty required list shows the empty row and no column titles', () => {
  const view = mount(svelte.ClientModList, requiredProps([]));

  assert.deepEqual(view.rowNames(), []);
  assert.deepEqual(view.count(), []);
  assert.equal(view.columnHeaderRows(), 0);
  assert.deepEqual(view.emptyRows(), ['No required mods found.']);
  assert.equal(frames.size, 0);
  view.destroy();
});

test('exactly 80 mods are all drawn at once', () => {
  const mods = makeMods(80);
  const view = mount(svelte.ClientModList, requiredProps(mods));

  assert.deepEqual(view.rowNames(), namesOf(mods));
  assert.deepEqual(view.count(), ['80 mods']);
  assert.equal(frames.size, 0, 'no frame is needed for 80 mods');
  view.destroy();
});

test('more than 80 mods start with 80 rows and fill in one chunk per frame', () => {
  const justOver = makeMods(81);
  const small = mount(svelte.ClientModList, requiredProps(justOver));
  assert.deepEqual(small.rowNames(), namesOf(justOver.slice(0, 80)));
  assert.equal(frames.size, 1);
  runFrame();
  assert.deepEqual(small.rowNames(), namesOf(justOver));
  assert.equal(frames.size, 0, 'the pump stops once every row is drawn');
  small.destroy();

  const large = makeMods(200);
  const view = mount(svelte.ClientModList, requiredProps(large));
  assert.deepEqual(view.count(), ['200 mods']);
  assert.deepEqual(view.rowNames(), namesOf(large.slice(0, 80)));
  runFrame();
  assert.deepEqual(view.rowNames(), namesOf(large.slice(0, 160)));
  runFrame();
  assert.deepEqual(view.rowNames(), namesOf(large));
  assert.equal(frames.size, 0);
  view.destroy();
});

test('a new mods list from a sync redraws exactly its rows', () => {
  // The list starts empty and fills in when the first sync answers.
  const view = mount(svelte.ClientModList, requiredProps([]));
  assert.deepEqual(view.emptyRows(), ['No required mods found.']);

  const first = makeMods(2, 'First');
  view.set(requiredProps(first));
  assert.deepEqual(view.rowNames(), namesOf(first));

  // Refresh: a new array with the same mods.
  view.set(requiredProps(first.map(mod => ({ ...mod }))));
  assert.deepEqual(view.rowNames(), namesOf(first));

  const longer = makeMods(5, 'Longer');
  view.set(requiredProps(longer));
  assert.deepEqual(view.rowNames(), namesOf(longer));

  const shorter = makeMods(3, 'Shorter');
  view.set(requiredProps(shorter));
  assert.deepEqual(view.rowNames(), namesOf(shorter));

  const many = makeMods(150, 'Many');
  view.set(requiredProps(many));
  assert.deepEqual(view.rowNames(), namesOf(many.slice(0, 80)));
  runFrame();
  assert.deepEqual(view.rowNames(), namesOf(many));

  // A long list that is replaced while it is still being drawn stops its pump.
  view.set(requiredProps(makeMods(150, 'Again')));
  assert.equal(frames.size, 1);
  view.set(requiredProps(first));
  assert.deepEqual(view.rowNames(), namesOf(first));
  assert.equal(frames.size, 0, 'the replaced list no longer schedules frames');

  view.set(requiredProps([]));
  assert.deepEqual(view.rowNames(), []);
  assert.deepEqual(view.emptyRows(), ['No required mods found.']);
  view.destroy();
});

test('Hide List and Show List hide and bring back the rows', () => {
  const mods = makeMods(2);
  const view = mount(svelte.ClientModList, requiredProps(mods));
  assert.equal(view.toggleButton().getAttribute('aria-expanded'), 'true');

  view.clickToggle();
  assert.equal(textOf(view.toggleButton()), 'Show List');
  assert.equal(view.toggleButton().getAttribute('aria-expanded'), 'false');
  assert.deepEqual(view.rowNames(), []);
  assert.equal(view.columnHeaderRows(), 0);
  assert.equal(view.collapsedRows().length, 1);

  view.clickToggle();
  assert.equal(textOf(view.toggleButton()), 'Hide List');
  assert.deepEqual(view.rowNames(), namesOf(mods));
  assert.equal(view.collapsedRows().length, 0);
  view.destroy();
});

test('a list that starts collapsed draws its rows when shown', () => {
  const mods = makeMods(2);
  const view = mount(svelte.ClientModList, requiredProps(mods, { startCollapsed: true }));
  assert.equal(textOf(view.toggleButton()), 'Show List');
  assert.deepEqual(view.count(), ['2 mods']);
  assert.deepEqual(view.rowNames(), []);
  assert.equal(view.columnHeaderRows(), 0);
  assert.deepEqual(view.collapsedRows(), ['List hidden to keep large modpacks responsive. Use "Show List" when needed.']);
  assert.equal(frames.size, 0, 'a collapsed list schedules no frames');

  view.clickToggle();
  assert.equal(view.columnHeaderRows(), 1);
  assert.deepEqual(view.rowNames(), namesOf(mods));

  view.clickToggle();
  assert.deepEqual(view.rowNames(), []);
  view.clickToggle();
  assert.deepEqual(view.rowNames(), namesOf(mods));
  view.destroy();

  // A long list still opens with 80 rows and fills in.
  const large = makeMods(200);
  const long = mount(svelte.ClientModList, requiredProps(large, { startCollapsed: true }));
  assert.deepEqual(long.rowNames(), []);
  long.clickToggle();
  assert.deepEqual(long.rowNames(), namesOf(large.slice(0, 80)));
  runFrame();
  runFrame();
  assert.deepEqual(long.rowNames(), namesOf(large));
  assert.equal(frames.size, 0);

  // Hide and show it again: it opens with 80 rows; hiding it while it fills
  // in stops the pump.
  long.clickToggle();
  long.clickToggle();
  assert.deepEqual(long.rowNames(), namesOf(large.slice(0, 80)));
  assert.equal(frames.size, 1);
  long.clickToggle();
  assert.equal(frames.size, 0, 'hiding the list stops drawing it');
  long.destroy();
});

test('changing startCollapsed after mount collapses and redraws the list', () => {
  const mods = makeMods(3);
  const view = mount(svelte.ClientModList, requiredProps(mods));
  assert.deepEqual(view.rowNames(), namesOf(mods));

  view.set({ startCollapsed: true });
  assert.deepEqual(view.rowNames(), []);
  assert.equal(view.collapsedRows().length, 1);

  view.set({ startCollapsed: false });
  assert.deepEqual(view.rowNames(), namesOf(mods));
  view.destroy();
});

test('the optional list draws its rows with their enable state', () => {
  const mods = [
    { fileName: 'journeymap-1.20.1-5.9.18-fabric.jar', name: 'JourneyMap', versionNumber: '5.9.18' },
    { fileName: 'zoomify-2.11.2.jar', name: 'Zoomify', versionNumber: '2.11.2' }
  ];
  const view = mount(svelte.ClientModList, {
    mods,
    type: 'optional',
    modSyncStatus: syncedStatus({ presentDisabledMods: ['zoomify-2.11.2.jar'] }),
    serverManagedFiles: new Set(mods.map(mod => mod.fileName.toLowerCase()))
  });

  assert.equal(textOf(elements(view.target, 'h3')[0]), 'Optional Mods');
  assert.deepEqual(view.count(), ['2 mods']);
  assert.deepEqual(view.rowNames(), ['JourneyMap', 'Zoomify']);
  assert.deepEqual(view.rowCells('status'), ['Enabled', 'Disabled']);
  assert.deepEqual(view.rowCells('act'), ['Disable 🗑️', 'Enable 🗑️']);

  const more = [...mods, { fileName: 'appleskin-2.5.1.jar', name: 'AppleSkin', versionNumber: '2.5.1' }];
  view.set({ mods: more });
  assert.deepEqual(view.rowNames(), ['JourneyMap', 'Zoomify', 'AppleSkin']);
  view.destroy();
});

// Lets the list's IPC read answer, then applies what it changed.
async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  svelte.flushSync();
}

test('the client downloaded mods list, drawn the same way, shows its rows too', async t => {
  // Its mods change block runs before its slice, so its rows were never lost.
  let answer = [];
  window.electron = {
    invoke: async channel => (channel === 'get-manual-mods-detailed' ? { success: true, mods: answer } : { success: false })
  };
  t.after(() => {
    delete window.electron;
  });
  const manualMods = count => makeMods(count, 'Manual').map(mod => ({ ...mod, enabled: true }));

  answer = manualMods(2);
  const short = mount(svelte.ClientManualModList, { clientPath: 'C:/Clients/Friend' });
  await settle();
  assert.deepEqual(short.rowNames(), namesOf(answer));
  short.destroy();

  answer = manualMods(120);
  const long = mount(svelte.ClientManualModList, { clientPath: 'C:/Clients/Friend' });
  await settle();
  assert.deepEqual(long.rowNames(), namesOf(answer.slice(0, 80)));
  runFrame();
  assert.deepEqual(long.rowNames(), namesOf(answer));
  long.destroy();

  // Collapsed, it reads its mods only when shown.
  answer = manualMods(2);
  const collapsed = mount(svelte.ClientManualModList, { clientPath: 'C:/Clients/Friend', startCollapsed: true });
  await settle();
  assert.deepEqual(collapsed.rowNames(), []);
  collapsed.clickToggle();
  await settle();
  assert.deepEqual(collapsed.rowNames(), namesOf(answer));
  collapsed.destroy();
});
