import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const ROOT = process.cwd();
let bundle;

test.beforeAll(async () => {
  // Keep App's actual sidebar, startup, IPC subscription and status rendering.
  // Unrelated route/notification views and content IO are outside this regression.
  const result = await build({
    absWorkingDir: ROOT,
    stdin: { resolveDir: ROOT, contents: `
      import App from './src/App.svelte';
      import { mount, flushSync } from 'svelte';
      flushSync(() => mount(App, { target: document.querySelector('#fixture') }));
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    conditions: ['browser'], loader: { '.css': 'empty' },
    plugins: [{ name: 'actual-app-sidebar', setup(builder) {
      builder.onResolve({ filter: /^svelte-sonner$/ }, () => ({ path: 'Toaster', namespace: 'toast-boundary' }));
      builder.onLoad({ filter: /./, namespace: 'toast-boundary' }, () => ({
        contents: compile('<span></span>', { filename: 'Toaster.svelte', generate: 'client', css: 'external' }).js.code.replace('export default', 'export const toast = Object.assign(() => {}, { success() {}, error() {}, info() {}, warning() {} }); export const Toaster ='),
        resolveDir: ROOT
      }));
      builder.onLoad({ filter: /[/\\]utils[/\\]logger\.js$/ }, () => ({
        contents: 'export default { debug() {}, info() {}, warn() {}, error() {}, refreshInstanceDetection() {} };'
      }));
      builder.onLoad({ filter: /[/\\]utils[/\\]mods[/\\]modAPI\.js$/ }, () => ({
        contents: 'export const setActiveModServerPath = () => {}; export const checkForUpdates = async () => {}; export const loadServerConfig = async () => {}; export const loadMods = async () => {}; export const loadContent = async () => {};'
      }));
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => ({
        contents: compile(filename === path.join(ROOT, 'src', 'App.svelte')
          ? await fs.readFile(filename, 'utf8') : '<span></span>', {
          filename, generate: 'client', css: 'external', dev: false
        }).js.code,
        resolveDir: path.dirname(filename)
      }));
    } }]
  });
  bundle = result.outputFiles[0].text;
});

test('sidebar follows Running to Stopped events without reselecting the instance or route', async ({ page }) => {
  // Removing App's explicit status dependency must leave this badge stale.
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', request => request.request().url() === 'https://sidebar-status.test/'
    ? request.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="fixture"></main>' })
    : request.abort());
  await page.goto('https://sidebar-status.test/');
  await page.evaluate(() => {
    window.location.hash = '/modpack';
    const instances = [
      { id: 'c1', type: 'server', path: 'fixture-c1', name: 'Disposable c1' },
      { id: 'b1', type: 'server', path: 'fixture-b1', name: 'Disposable b1' }
    ];
    const statuses = instances.map(instance => ({
      instanceId: instance.id, targetPath: instance.path,
      isRunning: instance.id === 'c1', status: instance.id === 'c1' ? 'running' : 'stopped'
    }));
    const listeners = new Map();
    const requests = [];
    window.getInitialInstances = () => ({ loaded: true, instances });
    let serverPath = instances[0].path;
    window.serverPath = { get: () => serverPath, set: value => { serverPath = value; } };
    window.electron = {
      on(channel, callback) {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel).add(callback);
      },
      removeListener(channel, callback) { listeners.get(channel)?.delete(callback); },
      removeAllListeners(channel) { listeners.delete(channel); },
      async invoke(channel, ...args) {
        requests.push([channel, ...args]);
        if (channel === 'get-settings') return { success: true, settings: {
          port: 25576, managementPort: 8081, maxRam: 4,
          autoStartManagement: false, autoStartMinecraft: false
        } };
        if (channel === 'get-all-server-statuses') return statuses;
        if (channel === 'modpacks:get-state') return { ok: true, value: { instanceId: args[0].serverId, modpackManaged: true } };
        if (channel === 'modpacks:list-notifications') return { ok: true, value: [] };
        if (channel === 'get-ignored-mod-updates') return { success: true, data: [] };
        if (channel === 'set-current-instance' || channel === 'save-instances' || channel === 'start-periodic-checks') return { success: true };
        throw new Error(`Unexpected fixture IPC: ${channel}`);
      }
    };
    window.sidebarFixture = {
      emit(isRunning) {
        const payload = { instanceId: 'c1', targetPath: 'fixture-c1', isRunning, status: isRunning ? 'running' : 'stopped' };
        for (const callback of listeners.get('server-status') || []) callback(payload);
      },
      context: () => ({
        selection: JSON.parse(localStorage.getItem('currentInstance')).id,
        route: window.location.hash,
        refreshes: requests.filter(([channel]) => channel === 'get-all-server-statuses').length
      })
    };
  });
  await page.addScriptTag({ content: bundle });
  await expect(page.locator('.instance-item')).toHaveCount(2);
  await page.locator('.sidebar-toggle').click();
  const c1 = page.locator('.instance-item').filter({ hasText: 'Disposable c1' });
  const b1 = page.locator('.instance-item').filter({ hasText: 'Disposable b1' });
  const badge = c1.locator('.instance-status-badge');
  // Establish the native precondition: c1 is already displayed Running.
  // Initial status reads share the same bug, so select once during setup only.
  await expect.poll(() => page.evaluate(() => window.sidebarFixture.context().refreshes)).toBe(2);
  await c1.click();
  await expect(badge).toHaveText('Running');
  await expect(b1.locator('.instance-status-badge')).toHaveText('Stopped');
  const context = await page.evaluate(() => window.sidebarFixture.context());
  expect(context.selection).toBe('c1');
  expect(context.route).toBe('#/modpack');

  await page.evaluate(() => window.sidebarFixture.emit(true));
  await expect(badge).toHaveText('Running');
  await page.evaluate(() => window.sidebarFixture.emit(false));
  await expect(badge).toHaveText('Stopped');
  await expect(badge).not.toHaveClass(/running/);
  await expect(b1.locator('.instance-status-badge')).toHaveText('Stopped');
  await page.evaluate(() => window.sidebarFixture.emit(true));
  await expect(badge).toHaveText('Running');
  await expect(badge).toHaveClass(/running/);
  await expect(b1.locator('.instance-status-badge')).toHaveText('Stopped');
  expect(await page.evaluate(() => window.sidebarFixture.context())).toEqual(context);
  await expect(c1).toHaveClass(/active/);
  expect(errors).toEqual([]);
});
