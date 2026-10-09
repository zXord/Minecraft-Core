import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let bundle;
test.beforeAll(async () => {
  const fixture = `<script>
    import ModsPage from './src/routes/ModsPage.svelte';
    import App from './src/App.svelte';
    import { installWithDependencies } from './src/utils/mods/modDependencyHelper.js';
    import { setActiveModServerPath, loadContent } from './src/utils/mods/modAPI.js';
    import { installedMods, installedModInfo, disabledMods, activeContentType, CONTENT_TYPES,
      successMessage, errorMessage, currentDependencies, modToInstall, modCategories, modsWithUpdates, disabledModUpdates, searchResults, isLoading, installingModIds } from './src/stores/modStore.js';
    let props = { serverPath: 'alpha', modpackManaged: null, modpackStateGeneration: 1 };
    let shown = false; let appShown = false; let navigations = 0;
    const successes = []; const errors = [];
    const contentLoads = {};
    export function beginContentLoad(key, contentType = 'mods') {
      const targetPath = props.serverPath; const generation = props.modpackStateGeneration;
      contentLoads[key] = loadContent(targetPath, contentType, { isCurrent: () => targetPath === props.serverPath && generation === props.modpackStateGeneration });
    }
    export function awaitContentLoad(key) { return contentLoads[key]; }
    successMessage.subscribe(value => { if (value) successes.push(value); });
    errorMessage.subscribe(value => { if (value) errors.push(value); });
    export function showApp() { isLoading.set(true); appShown = true; }
    export function show(next) { isLoading.set(true); props = { ...props, ...next }; shown = true; }
    export function update(next) {
      if (next.serverPath && next.serverPath !== props.serverPath) {
        isLoading.set(true); window.modTest.path = next.serverPath;
        installingModIds.set(new Set());
        localStorage.setItem('currentInstance', JSON.stringify({ id: next.serverPath, type: 'server', path: next.serverPath }));
        setActiveModServerPath(next.serverPath);
      }
      props = { ...props, ...next };
    }
    export function hide() { shown = false; }
    export function seed() {
      installedMods.set(['addon.jar']); installedModInfo.set([{ fileName: 'addon.jar', name: 'Addon', projectId: 'addon', versionId: 'v1', versionNumber: '1.0', category: 'both' }]);
      modsWithUpdates.set(new Map([['addon.jar', { latestVersionId: 'v2', versionId: 'v2', versionNumber: '2.0', projectId: 'addon' }]]));
      searchResults.set([{ id: 'new-mod', title: 'New Mod', description: 'Fixture provider result', source: 'modrinth', versions: [] }]);
      isLoading.set(false);
    }
    export function seedDisabled() {
      disabledMods.set(new Set(['addon.jar']));
      disabledModUpdates.set(new Map([['addon.jar', { fileName: 'addon.jar', projectId: 'addon', latestVersion: '2.0', latestVersionId: 'v2', currentVersion: '1.0' }]]));
    }
    export function seedNextContext() {
      successMessage.set(''); errorMessage.set('');
      installedMods.set(['beta.jar']); installedModInfo.set([{ fileName: 'beta.jar', name: 'Beta', projectId: 'beta', category: 'both', versionId: 'beta-v1', versionNumber: '1.0' }]);
      modCategories.set(new Map([['addon.jar', { category: 'client-only', required: true }]]));
      installingModIds.set(new Set(['new-mod'])); seedDisabled();
    }
    export async function beginDependencies() {
      const targetPath = props.serverPath; const generation = props.modpackStateGeneration;
      modToInstall.set({ id: 'new-mod', name: 'New Mod' }); currentDependencies.set([]);
      await installWithDependencies(targetPath, undefined, 'mods', { isCurrent: () => shown && targetPath === props.serverPath && generation === props.modpackStateGeneration });
    }
    export function seedDependencyContext() { modToInstall.set({ id: 'beta', name: 'Beta' }); currentDependencies.set([{ projectId: 'beta-dependency' }]); successMessage.set('Beta notice'); }
    export function seedTwoUpdates() {
      installedMods.set(['addon.jar', 'second.jar']);
      installedModInfo.set([{ fileName: 'addon.jar', name: 'Addon', projectId: 'addon', category: 'both' }, { fileName: 'second.jar', name: 'Second', projectId: 'second', category: 'both' }]);
      modsWithUpdates.set(new Map([['addon.jar', { id: 'v2' }], ['second.jar', { id: 'v3' }]]));
    }
    export function state() { let disabled; let success; let installing; let updates; let disabledUpdates; let error;
      disabledMods.subscribe(v => disabled = [...v])(); successMessage.subscribe(v => success = v)();
      installingModIds.subscribe(v => installing = [...v])(); modsWithUpdates.subscribe(v => updates = [...v.keys()])();
      disabledModUpdates.subscribe(v => disabledUpdates = [...v.keys()])(); errorMessage.subscribe(v => error = v)();
      let installed; let categories; installedMods.subscribe(v => installed = v)(); modCategories.subscribe(v => categories = [...v])();
      let pendingMod; let dependencies; let loading; modToInstall.subscribe(v => pendingMod = v)(); currentDependencies.subscribe(v => dependencies = v)(); isLoading.subscribe(v => loading = v)();
      return { disabled, success, installing, navigations, updates, disabledUpdates, error, installed, categories, pendingMod, dependencies, successes, errors, loading }; }
    export function selectContent(value) { activeContentType.set(value); }
  </script>
  <output aria-label="Content load state">{$isLoading ? 'Loading' : 'Ready'}</output>
  {#if appShown}<App />{:else if shown}<ModsPage {...props} on:openModpack={() => navigations++} />{/if}`;
  const result = await build({ absWorkingDir: ROOT, stdin: { resolveDir: ROOT, contents: `
    import Fixture from 'managed-mod-fixture'; import { mount, flushSync } from 'svelte';
    const fixture = mount(Fixture, { target: document.querySelector('#fixture') });
    window.modFixture = { show: props => flushSync(() => fixture.show(props)), update: props => flushSync(() => fixture.update(props)),
      showApp: () => flushSync(() => fixture.showApp()),
      beginContentLoad: (key, type) => fixture.beginContentLoad(key, type), awaitContentLoad: key => fixture.awaitContentLoad(key),
      beginDependencies: () => fixture.beginDependencies(), seedDependencyContext: () => flushSync(() => fixture.seedDependencyContext()), seedTwoUpdates: () => flushSync(() => fixture.seedTwoUpdates()),
      hide: () => flushSync(() => fixture.hide()),
      seed: () => flushSync(() => fixture.seed()), seedNextContext: () => flushSync(() => fixture.seedNextContext()), seedDisabled: () => flushSync(() => fixture.seedDisabled()), state: () => fixture.state(), selectContent: type => flushSync(() => fixture.selectContent(type)) };
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', conditions: ['browser'],
  loader: { '.css': 'empty' }, plugins: [{ name: 'real-managed-mod-components', setup(builder) {
    builder.onResolve({ filter: /^managed-mod-fixture$/ }, () => ({ path: 'ManagedModFixture.svelte', namespace: 'fixture' }));
    builder.onResolve({ filter: /^svelte-sonner$/ }, () => ({ path: 'Toaster.svelte', namespace: 'toast-boundary' }));
    builder.onLoad({ filter: /./, namespace: 'toast-boundary' }, () => ({ contents: compile('<span></span>', { filename: 'Toaster.svelte', generate: 'client', css: 'external', dev: false }).js.code.replace('export default', 'export const Toaster ='), resolveDir: ROOT }));
    builder.onLoad({ filter: /./, namespace: 'fixture' }, () => ({ contents: compile(fixture, { filename: path.join(ROOT, 'ManagedModFixture.svelte'), generate: 'client', css: 'external', dev: false }).js.code, resolveDir: ROOT }));
    builder.onLoad({ filter: /[/\\]utils[/\\]logger\.js$/ }, () => ({ contents: 'export default { debug() {}, info() {}, warn() {}, error() {}, refreshInstanceDetection() {}, setInstance() {} };' }));
    builder.onLoad({ filter: /[/\\]modules[/\\]serverListeners\.js$/ }, () => ({ contents: 'export function setupIpcListeners() {}' }));
    builder.onResolve({ filter: /^\.\/utils\/mods\/modAPI\.js$/ }, ({ importer }) => importer.endsWith('App.svelte') ? { path: 'AppContentPrimingBoundary', namespace: 'app-prime' } : undefined);
    builder.onLoad({ filter: /./, namespace: 'app-prime' }, () => ({ contents: `export { setActiveModServerPath } from './src/utils/mods/modAPI.js'; export const checkForUpdates = async () => {}; export const loadServerConfig = async () => {}; export const loadMods = async () => {}; export const loadContent = async () => {};`, resolveDir: ROOT }));
    builder.onLoad({ filter: /[/\\](?:routes[/\\](?:ServerDashboard|ModpackPage|SettingsPage)|components[/\\](?:setup[/\\]ServerSetupWizard|client[/\\](?:ClientSetupWizard|ClientInterface)|players[/\\]PlayerList|Backups|common[/\\](?:UpdateNotification|ModAvailabilityNotifications|AppSettingsModal)))\.svelte$/ }, ({ path: filename }) => ({ contents: compile('<p>Unrelated route boundary</p>', { filename, generate: 'client', css: 'external', dev: false }).js.code, resolveDir: path.dirname(filename) }));
    builder.onLoad({ filter: /\.svelte$/, namespace: 'file' }, async ({ path: filename }) => ({ contents: compile(await fs.readFile(filename, 'utf8'), { filename, generate: 'client', css: 'external', dev: false }).js.code, resolveDir: path.dirname(filename) }));
  } }] });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  page.managedModsErrors = [];
  page.on('pageerror', error => page.managedModsErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') page.managedModsErrors.push(message.text()); });
  await page.route('**/*', route => route.request().url() === 'https://managed-mods.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Managed Mods test</title><main id="fixture"></main>' }) : route.abort());
  await page.goto('https://managed-mods.test/');
  await page.evaluate(() => {
    window.appStartupCompleted = true;
    window.modTest = { requests: [], failSave: false, holdSave: false, pendingSave: null, holdVersion: false, pendingVersion: null };
    localStorage.setItem('currentInstance', JSON.stringify({ id: 'alpha', type: 'server', path: 'alpha' }));
    window.modTest.path = 'alpha';
    window.serverPath = { get: () => window.modTest.path, set(path) { window.modTest.path = path; } };
    window.getInitialInstances = () => ({ loaded: true, instances: [{ id: 'alpha', path: 'alpha', type: 'server', name: 'Alpha' }] });
    window.modTest.listeners = {};
    window.electron = { on(channel, callback) { (window.modTest.listeners[channel] ||= []).push(callback); }, removeListener() {}, invoke: async (channel, ...args) => {
      const state = window.modTest; state.requests.push([channel, ...args]);
      if (channel === 'modpacks:get-state') {
        if (state.holdState) return new Promise(resolve => state.pendingState = resolve);
        return { ok: true, value: { instanceId: 'alpha', modpackManaged: state.managed !== false } };
      }
      if (channel === 'modpacks:list-notifications') return { ok: true, value: [] };
      if (channel === 'get-instance-status') return { minecraftServer: false, managementServer: false };
      if (channel === 'read-config') return { version: '1.20.1', loader: 'fabric', autoCheckModUpdates: false };
      if (state.holdContentLists && ['list-mods', 'list-shaders', 'list-resourcepacks'].includes(channel)) {
        return new Promise(resolve => state.pendingContentLists.push({ channel, path: args[0], resolve }));
      }
      if (channel === 'list-mods') {
        if (state.holdList) return new Promise(resolve => state.pendingList = resolve);
        return { modFiles: ['addon.jar'], mods: [{ fileName: 'addon.jar', name: 'Addon', category: 'both', projectId: 'addon', versionId: 'v1', versionNumber: '1.0' }] };
      }
      if (channel === 'move-mod-file' && state.holdMove) return new Promise(resolve => state.pendingMove = resolve);
      if (channel === 'delete-mod' && state.holdDelete) return new Promise(resolve => state.pendingDelete = resolve);
      if (channel === 'add-mod') {
        if (state.holdAdd) return new Promise(resolve => state.pendingAdd = resolve);
        return { success: false, error: 'MANAGED_MOD_EDIT_BLOCKED' };
      }
      if (channel === 'get-installed-mod-info') return [{ fileName: 'addon.jar', name: 'Addon', category: 'both', projectId: 'addon', versionId: 'v1', versionNumber: '1.0' }];
      if (channel === 'get-disabled-mods') {
        if (state.holdDisabledRead) return new Promise(resolve => state.pendingDisabledRead = resolve);
        return [];
      }
      if (channel === 'save-disabled-mods') {
        if (state.holdSave) return new Promise(resolve => state.pendingSave = resolve);
        if (state.failSave) throw new Error('MANAGED_MOD_EDIT_BLOCKED: Individual mod changes are disabled while this server is managed.');
        return true;
      }
      if (channel === 'enable-and-update-mod') {
        if (state.holdEnableUpdate) return new Promise(resolve => state.pendingEnableUpdate = resolve);
        return state.refuseUpdate ? { success: false, error: 'MANAGED_MOD_EDIT_BLOCKED' } : { success: true };
      }
      if (channel === 'install-mod') {
        if (state.holdInstall) return new Promise(resolve => state.pendingInstall = resolve);
        return state.refuseUpdate || args[1]?.id === state.refuseProject ? { success: false, error: 'MANAGED_MOD_EDIT_BLOCKED' } : { success: true };
      }
      if (channel === 'get-project-info') return { id: 'addon', title: 'Addon', project_type: 'mod', client_side: 'required', server_side: 'required' };
      if (channel === 'get-mod-versions') return [{ id: 'v2', version_number: '2.0', game_versions: ['1.20.1'], loaders: ['fabric'] }];
      if (channel === 'get-version-info') {
        if (state.holdVersion) return new Promise(resolve => state.pendingVersion = resolve);
        return { id: 'v2', dependencies: [], game_versions: ['1.20.1'], loaders: ['fabric'] };
      }
      if (channel === 'get-mod-dependencies') return [];
      if (channel === 'list-shaders') return { shaderFiles: ['shader.zip'], mods: [] };
      if (channel === 'list-resourcepacks') return { resourcePackFiles: ['resource.zip'], mods: [] };
      if (channel === 'get-mod-categories' || channel === 'load-mod-categories') return [];
      return { success: true, data: {}, modFiles: [], updates: [] };
    } };
  });
  await page.addScriptTag({ content: bundle });
});
test.afterEach(async ({ page }) => {
  expect(page.managedModsErrors).toEqual([]);
});

async function show(page, modpackManaged) {
  await page.evaluate(value => window.modFixture.show({ modpackManaged: value }), modpackManaged);
  await expect(page.getByRole('button', { name: /Disable$/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.modFixture.state().loading)).toBe(false);
  await page.evaluate(() => window.modFixture.seed());
}
async function settleRenderedCompletion(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
for (const invalidation of ['server', 'generation', 'superseded']) for (const completionOrder of ['current-first', 'stale-first']) test(`actual content loads settle loading after overlapping ${invalidation} requests: ${completionOrder}`, async ({ page }) => {
  await page.evaluate(invalidation => {
    window.modTest.holdContentLists = true; window.modTest.pendingContentLists = [];
    window.modFixture.beginContentLoad('stale');
    if (invalidation === 'server') window.modFixture.update({ serverPath: 'beta', modpackStateGeneration: 2 });
    if (invalidation === 'generation') window.modFixture.update({ modpackStateGeneration: 2 });
    window.modFixture.beginContentLoad('current');
  }, invalidation);
  await expect.poll(() => page.evaluate(() => window.modTest.pendingContentLists.length)).toBe(2);
  await expect(page.getByRole('status', { name: 'Content load state' })).toHaveText('Loading');
  const finish = async (key, index, filename) => page.evaluate(async ({ key, index, filename }) => {
    window.modTest.pendingContentLists[index].resolve({ modFiles: [filename], mods: [] });
    return await window.modFixture.awaitContentLoad(key);
  }, { key, index, filename });
  if (completionOrder === 'current-first') {
    expect(await finish('current', 1, 'beta.jar')).toBe(true);
    await expect(page.getByRole('status', { name: 'Content load state' })).toHaveText('Ready');
    expect(await finish('stale', 0, 'alpha.jar')).toBe(false);
  } else {
    expect(await finish('stale', 0, 'alpha.jar')).toBe(false);
    await expect(page.getByRole('status', { name: 'Content load state' })).toHaveText('Loading');
    expect(await finish('current', 1, 'beta.jar')).toBe(true);
  }
  await expect(page.getByRole('status', { name: 'Content load state' })).toHaveText('Ready');
  expect((await page.evaluate(() => window.modFixture.state())).installed).toEqual(['beta.jar']);
});

test('a lone actual content load retires its busy state after ownership generation invalidates it', async ({ page }) => {
  await page.evaluate(() => {
    window.modTest.holdContentLists = true; window.modTest.pendingContentLists = [];
    window.modFixture.beginContentLoad('stale');
    window.modFixture.update({ modpackStateGeneration: 2 });
    window.modFixture.seedNextContext();
  });
  await expect(page.getByRole('status', { name: 'Content load state' })).toHaveText('Loading');
  expect(await page.evaluate(async () => {
    window.modTest.pendingContentLists[0].resolve({ modFiles: ['alpha.jar'], mods: [] });
    return await window.modFixture.awaitContentLoad('stale');
  })).toBe(false);
  await expect(page.getByRole('status', { name: 'Content load state' })).toHaveText('Ready');
  expect((await page.evaluate(() => window.modFixture.state())).installed).toEqual(['beta.jar']);
});

test('actual overlapping generation loads keep the current content load visible until it finishes', async ({ page }) => {
  await page.evaluate(() => {
    window.modTest.holdContentLists = true; window.modTest.pendingContentLists = [];
    window.modFixture.beginContentLoad('stale');
    window.modFixture.update({ modpackStateGeneration: 2 });
    window.modFixture.beginContentLoad('current');
    window.modFixture.beginContentLoad('other-type', 'shaders');
  });
  await expect.poll(() => page.evaluate(() => window.modTest.pendingContentLists.length)).toBe(3);
  await page.evaluate(async () => {
    window.modTest.pendingContentLists[1].resolve({ modFiles: ['beta.jar'], mods: [] });
    await window.modFixture.awaitContentLoad('current');
    window.modTest.pendingContentLists[0].resolve({ modFiles: ['alpha.jar'], mods: [] });
    await window.modFixture.awaitContentLoad('stale');
  });
  await expect(page.getByRole('status', { name: 'Content load state' })).toHaveText('Loading');
  expect((await page.evaluate(() => window.modFixture.state())).installed).toEqual(['beta.jar']);
  await page.evaluate(async () => {
    window.modTest.pendingContentLists[2].resolve({ shaderFiles: ['shader.zip'], mods: [] });
    await window.modFixture.awaitContentLoad('other-type');
  });
  await expect(page.getByRole('status', { name: 'Content load state' })).toHaveText('Ready');
});

test('managed and unknown ownership block JAR controls but preserve read controls and normal Modpack navigation', async ({ page }, testInfo) => {
  await show(page, true);
  await expect(page.getByRole('button', { name: /Disable$/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Add Mods/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Disable$/ })).toHaveAttribute('title', /Individual mod changes are disabled/);
  await expect(page.locator('tbody button.danger')).toHaveAttribute('title', /Individual mod changes are disabled/);
  await expect(page.getByRole('button', { name: 'Ignore this version' })).toBeEnabled();
  await expect(page.getByTitle('Check for Updates', { exact: true })).toBeEnabled();
  await expect(page.getByText('Individual mod changes are disabled while this server is managed.', { exact: false })).toBeVisible();
  await expect(page).toHaveTitle('Managed Mods test');
  await page.screenshot({ path: testInfo.outputPath('managed-mod-policy.png') });
  await page.getByRole('button', { name: 'Open Modpack', exact: true }).click();
  expect(await page.evaluate(() => window.modFixture.state().navigations)).toBe(1);
  await page.evaluate(() => window.modFixture.update({ modpackManaged: null }));
  await expect(page.getByRole('button', { name: /Disable$/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Disable$/ })).toHaveAttribute('title', /Checking modpack ownership/);
  await page.evaluate(() => window.modFixture.update({ modpackManaged: false, modpackStateGeneration: 2 }));
  await expect(page.getByRole('button', { name: /Disable$/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Add Mods/ })).toBeEnabled();
});
test('shader and resource pack actions are not locked by managed mod ownership', async ({ page }) => {
  await show(page, true);
  await page.getByRole('tab', { name: /Shaders/ }).click();
  await expect(page.getByRole('button', { name: /Add Shaders/ })).toBeEnabled();
  await page.getByRole('tab', { name: /Resource Packs/ }).click();
  await expect(page.getByRole('button', { name: /Add Resource Packs/ })).toBeEnabled();
});
test('main refusal restores prior disabled state and does not report success', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => window.modTest.failSave = true);
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.modTest.requests.filter(([channel]) => channel === 'save-disabled-mods').length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.modFixture.state().disabled)).toEqual([]);
  expect(await page.evaluate(() => window.modFixture.state().success)).not.toContain('successfully');
});
test('pending toggle cannot apply alpha response after server or generation changes', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => window.modTest.holdSave = true);
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingSave))).toBe(true);
  await page.evaluate(() => { window.modFixture.update({ serverPath: 'beta', modpackManaged: true, modpackStateGeneration: 2 }); window.modTest.pendingSave(true); });
  await expect(page.getByRole('button', { name: /Disable$/ })).toBeDisabled();
  expect(await page.evaluate(() => window.modFixture.state().success)).not.toContain('successfully');
});
test('provider installs stay locked but provider search is usable', async ({ page }) => {
  await show(page, true);
  await page.getByRole('tab', { name: 'Find Mods', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
  await page.evaluate(() => window.modFixture.update({ modpackManaged: false, modpackStateGeneration: 2 }));
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeEnabled();
});
test('managed bulk writes, location moves and stale drop events do not mutate JARs', async ({ page }) => {
  await show(page, true);
  await page.locator('tbody input[type="checkbox"]').first().check();
  await expect(page.getByRole('button', { name: /Delete Selected/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Disable Selected \(1\)/ })).toBeDisabled();
  await expect(page.locator('tbody select').first()).toBeDisabled();
  await expect(page.getByRole('button', { name: /Update All/ })).toBeDisabled();
  await page.locator('.add-mods-btn-outline').evaluate(button => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [{ name: 'unsafe.jar', path: 'unsafe.jar' }] } });
    button.dispatchEvent(event);
  });
  expect(await page.evaluate(() => window.modTest.requests.filter(([channel]) => ['add-mod', 'delete-mod', 'save-disabled-mods', 'move-mod-file', 'install-mod-with-fallback'].includes(channel)))).toEqual([]);
});
test('same-server generation change ignores a delayed accepted toggle', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => window.modTest.holdSave = true);
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingSave))).toBe(true);
  await page.evaluate(() => { window.modFixture.update({ modpackManaged: false, modpackStateGeneration: 2 }); window.modTest.pendingSave(true); });
  expect(await page.evaluate(() => window.modFixture.state().disabled)).toEqual([]);
  expect(await page.evaluate(() => window.modFixture.state().success)).not.toContain('successfully');
});
test('provider metadata response cannot install into a different server context', async ({ page }) => {
  await show(page, false);
  await page.getByRole('tab', { name: 'Find Mods', exact: true }).click();
  await page.evaluate(() => window.modTest.holdVersion = true);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingVersion))).toBe(true);
  await page.evaluate(() => {
    window.modFixture.update({ serverPath: 'beta', modpackManaged: true, modpackStateGeneration: 2 });
    window.modTest.holdVersion = false;
    window.modTest.pendingVersion({ id: 'v2', dependencies: [], game_versions: ['1.20.1'], loaders: ['fabric'] });
  });
  await expect.poll(() => page.evaluate(() => window.modFixture.state().installing)).toEqual([]);
  expect(await page.evaluate(() => window.modTest.requests.filter(([channel]) => ['install-mod', 'install-mod-with-fallback', 'download-mod-with-fallback'].includes(channel)))).toEqual([]);
});
test('disabled-state hydration from a prior server generation cannot replace the current set', async ({ page }) => {
  await page.evaluate(() => window.modTest.holdDisabledRead = true);
  await show(page, false);
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingDisabledRead))).toBe(true);
  await page.evaluate(() => {
    window.modFixture.update({ serverPath: 'beta', modpackManaged: true, modpackStateGeneration: 2 });
    window.modTest.holdDisabledRead = false; window.modTest.pendingDisabledRead(['addon.jar']);
  });
  await expect(page.getByRole('button', { name: /Disable$/ })).toBeDisabled();
  expect(await page.evaluate(() => window.modFixture.state().disabled)).toEqual([]);
});
test('destroyed server component cannot commit a delayed toggle into the next route', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => window.modTest.holdSave = true);
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingSave))).toBe(true);
  await page.evaluate(() => { window.modFixture.hide(); window.modTest.pendingSave(true); });
  await expect.poll(() => page.evaluate(() => window.modFixture.state().disabled)).toEqual([]);
  expect(await page.evaluate(() => window.modFixture.state().success)).not.toContain('successfully');
});

for (const change of ['server', 'generation', 'destroy']) test(`actual enable-and-update helper cannot commit after ${change} changes`, async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => { window.modFixture.seedDisabled(); window.modTest.holdEnableUpdate = true; });
  await page.getByTitle('Enable and update to 2.0', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingEnableUpdate))).toBe(true);
  await page.evaluate(change => {
    if (change === 'destroy') window.modFixture.hide();
    else window.modFixture.update({ ...(change === 'server' ? { serverPath: 'beta' } : {}), modpackStateGeneration: 2 });
    window.modFixture.seedDisabled();
    window.modTest.pendingEnableUpdate({ success: true });
  }, change);
  await settleRenderedCompletion(page);
  await expect.poll(() => page.evaluate(() => window.modFixture.state().disabled)).toEqual(['addon.jar']);
  expect((await page.evaluate(() => window.modFixture.state())).disabledUpdates).toEqual(['addon.jar']);
  expect((await page.evaluate(() => window.modFixture.state())).success).toBe('');
});

test('actual enable-and-update refusal preserves disabled state and pending update', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => { window.modFixture.seedDisabled(); window.modTest.refuseUpdate = true; });
  await page.getByTitle('Enable and update to 2.0', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.modFixture.state().errors.join(' '))).toContain('MANAGED_MOD_EDIT_BLOCKED');
  const state = await page.evaluate(() => window.modFixture.state());
  expect(state.disabled).toEqual(['addon.jar']); expect(state.disabledUpdates).toEqual(['addon.jar']);
  expect(state.success).toBe('');
});

test('bulk main refusal preserves pending enabled updates and never reports zero-success', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => window.modTest.refuseUpdate = true);
  await page.getByRole('button', { name: /Update All/ }).click();
  await expect.poll(() => page.evaluate(() => window.modTest.requests.filter(([channel]) => channel === 'install-mod').length)).toBe(1);
  await expect(page.getByRole('button', { name: /Update All/ })).toBeEnabled();
  const state = await page.evaluate(() => window.modFixture.state());
  expect(state.successes).toEqual([]); expect(state.updates).toEqual(['addon.jar']);
  expect(state.errors.join(' ')).toContain('1');
});

test('actual App Mods route propagates authoritative ownership and normal navigation', async ({ page }) => {
  await page.evaluate(() => { location.hash = '/mods'; window.modTest.holdState = true; window.modFixture.showApp(); });
  await expect(page.getByRole('status', { name: 'Managed mod editing policy' })).toContainText('Checking modpack ownership');
  await expect(page.getByRole('button', { name: /Add Mods/ })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingState))).toBe(true);
  await page.evaluate(() => { window.modTest.holdState = false; window.modTest.pendingState({ ok: true, value: { modpackManaged: true } }); });
  await expect(page.getByRole('status', { name: 'Managed mod editing policy' })).toContainText('Individual mod changes are disabled');
  await page.getByRole('button', { name: 'Open Modpack', exact: true }).click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/modpack');
  await page.evaluate(() => { location.hash = '/mods'; });
  await expect(page.getByRole('button', { name: /Add Mods/ })).toBeDisabled();
  await page.evaluate(() => {
    window.modTest.managed = false; window.modTest.holdState = true;
    for (const callback of window.modTest.listeners['modpacks:state-changed']) callback({ instanceId: 'alpha', modpackManaged: false });
  });
  await expect(page.getByRole('status', { name: 'Managed mod editing policy' })).toContainText('Checking modpack ownership');
  await expect(page.getByRole('button', { name: /Add Mods/ })).toBeDisabled();
  await page.evaluate(() => { window.modTest.holdState = false; window.modTest.pendingState({ ok: true, value: { modpackManaged: false } }); });
  await expect(page.getByRole('button', { name: /Add Mods/ })).toBeEnabled();
});

test('App allows an authoritatively unmanaged server on initial Mods navigation', async ({ page }) => {
  await page.evaluate(() => { window.modTest.managed = false; location.hash = '/mods'; window.modFixture.showApp(); });
  await expect(page.getByRole('button', { name: /Add Mods/ })).toBeEnabled();
  await expect(page.getByRole('status', { name: 'Managed mod editing policy' })).toHaveCount(0);
});

for (const outcome of ['failed', 'cancelled']) test(`App keeps Mods locked after ${outcome} detach and does not trust event ownership`, async ({ page }) => {
  await page.evaluate(() => { location.hash = '/mods'; window.modFixture.showApp(); });
  await expect(page.getByRole('status', { name: 'Managed mod editing policy' })).toContainText('Individual mod changes are disabled');
  await page.evaluate(outcome => {
    // Failure/cancellation notifications cannot replace fresh persisted ownership.
    for (const callback of window.modTest.listeners['modpacks:state-changed']) callback({ instanceId: 'alpha', outcome, modpackManaged: false });
  }, outcome);
  await expect(page.getByRole('status', { name: 'Managed mod editing policy' })).toContainText('Individual mod changes are disabled');
  await expect(page.getByRole('button', { name: /Add Mods/ })).toBeDisabled();
});

test('accepted enable-and-update cannot finish its reload after generation changes', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => { window.modFixture.seedDisabled(); window.modTest.holdList = true; });
  await page.getByTitle('Enable and update to 2.0', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingList))).toBe(true);
  await page.evaluate(() => {
    window.modFixture.update({ modpackStateGeneration: 2 }); window.modFixture.seedNextContext();
    window.modTest.pendingList({ modFiles: ['alpha.jar'], mods: [] });
  });
  await settleRenderedCompletion(page);
  await expect.poll(() => page.evaluate(() => window.modFixture.state().installed)).toEqual(['beta.jar']);
  expect((await page.evaluate(() => window.modFixture.state())).success).toBe('');
});

test('provider accepted response cannot clear next context installing state or reload it', async ({ page }) => {
  await show(page, false);
  await page.getByRole('tab', { name: 'Find Mods', exact: true }).click();
  await page.evaluate(() => window.modTest.holdInstall = true);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingInstall))).toBe(true);
  await page.evaluate(() => {
    window.modFixture.update({ modpackStateGeneration: 2 }); window.modFixture.seedNextContext();
    window.modTest.pendingInstall({ success: true });
  });
  await settleRenderedCompletion(page);
  await expect.poll(() => page.evaluate(() => window.modFixture.state().installing)).toEqual(['new-mod']);
  expect((await page.evaluate(() => window.modFixture.state())).installed).toEqual(['beta.jar']);
});

test('location response cannot persist or apply category into a different generation', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => { window.modTest.requests = []; window.modTest.holdMove = true; });
  await page.locator('tbody select').first().selectOption('server-only');
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingMove))).toBe(true);
  await page.evaluate(() => {
    window.modFixture.update({ modpackStateGeneration: 2 }); window.modFixture.seedNextContext();
    window.modTest.pendingMove({ success: true });
  });
  await settleRenderedCompletion(page);
  await expect.poll(() => page.evaluate(() => window.modFixture.state().categories)).toEqual([['addon.jar', { category: 'client-only', required: true }]]);
  expect(await page.evaluate(() => window.modTest.requests.filter(([channel]) => channel === 'save-mod-categories'))).toEqual([]);
});

test('delete response cannot touch a different generations disabled set or success state', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => { window.modFixture.seedDisabled(); window.modTest.holdDelete = true; });
  await page.getByTitle('Delete mod', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingDelete))).toBe(true);
  await page.evaluate(() => {
    window.modFixture.update({ modpackStateGeneration: 2 }); window.modFixture.seedNextContext();
    window.modTest.pendingDelete({ success: true });
  });
  await settleRenderedCompletion(page);
  await expect.poll(() => page.evaluate(() => window.modFixture.state().disabled)).toEqual(['addon.jar']);
  expect((await page.evaluate(() => window.modFixture.state())).success).toBe('');
  expect(await page.evaluate(() => window.modTest.requests.filter(([channel]) => channel === 'save-disabled-mods'))).toEqual([]);
});

test('actual dependency helper cannot clear next generation modal or success state', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => { window.modTest.holdInstall = true; window.modTest.pendingDependencies = window.modFixture.beginDependencies(); });
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingInstall))).toBe(true);
  await page.evaluate(async () => {
    window.modFixture.update({ modpackStateGeneration: 2 }); window.modFixture.seedDependencyContext();
    window.modTest.pendingInstall({ success: true });
    await window.modTest.pendingDependencies;
  });
  await settleRenderedCompletion(page);
  const state = await page.evaluate(() => window.modFixture.state());
  expect(state.pendingMod).toEqual({ id: 'beta', name: 'Beta' });
  expect(state.dependencies).toEqual([{ projectId: 'beta-dependency' }]); expect(state.success).toBe('Beta notice');
});

test('mixed bulk result counts only accepted updates and retains refused pending items', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => { window.modFixture.seedTwoUpdates(); window.modTest.refuseProject = 'second'; });
  await page.getByRole('button', { name: /Update All/ }).click();
  await expect.poll(() => page.evaluate(() => window.modFixture.state().successes.join(' '))).toContain('1 mods (1 updated)');
  const state = await page.evaluate(() => window.modFixture.state());
  expect(state.updates).toEqual(['second.jar']); expect(state.errors.join(' ')).toContain('1 mod update');
});

async function dropMod(page) {
  await page.locator('.add-mods-btn-outline').evaluate(button => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [{ name: 'addon.jar', path: 'addon.jar' }] } });
    button.dispatchEvent(event);
  });
}
test('delayed add response cannot reload or announce success in next generation', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => window.modTest.holdAdd = true);
  await dropMod(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.modTest.pendingAdd))).toBe(true);
  await page.evaluate(() => {
    window.modFixture.update({ modpackStateGeneration: 2 }); window.modFixture.seedNextContext();
    window.modTest.pendingAdd({ success: true, fileName: 'alpha.jar', targetPath: 'alpha/alpha.jar' });
  });
  await settleRenderedCompletion(page);
  expect((await page.evaluate(() => window.modFixture.state())).installed).toEqual(['beta.jar']);
  expect((await page.evaluate(() => window.modFixture.state())).success).toBe('');
});
test('refused drop does not announce successful installation', async ({ page }) => {
  await show(page, false);
  await dropMod(page);
  await expect.poll(() => page.evaluate(() => window.modFixture.state().errors.join(' '))).toContain('refused');
  expect((await page.evaluate(() => window.modFixture.state())).successes.join(' ')).not.toContain('Successfully');
});

test('bulk refusal preserves disabled updates and disabled state without a success toast', async ({ page }) => {
  await show(page, false);
  await page.evaluate(() => { window.modFixture.seedDisabled(); window.modTest.refuseUpdate = true; });
  await page.getByRole('button', { name: /Update All/ }).click();
  await expect.poll(() => page.evaluate(() => window.modFixture.state().errors.join(' '))).toContain('1 mod update');
  const state = await page.evaluate(() => window.modFixture.state());
  expect(state.disabled).toEqual(['addon.jar']); expect(state.disabledUpdates).toEqual(['addon.jar']);
  expect(state.successes).toEqual([]);
});
