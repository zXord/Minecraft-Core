import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let bundle;

test.beforeAll(async () => {
  const fixture = `
    <script>
      import Controls from './src/components/server/ServerControls.svelte';
      import Dashboard from './src/routes/ServerDashboard.svelte';
      let shown = false;
      let dashboard = false;
      let props = {};
      export function show(nextProps, useDashboard) {
        props = nextProps; dashboard = useDashboard; shown = true;
      }
      export function update(nextProps) { props = { ...props, ...nextProps }; }
    </script>
    {#if shown}
      {#if dashboard}<Dashboard {...props} />{:else}<Controls {...props} />{/if}
    {/if}
  `;
  const result = await build({
    absWorkingDir: ROOT,
    stdin: {
      resolveDir: ROOT,
      contents: `
        import Fixture from 'server-controls-test-fixture';
        import { mount, flushSync } from 'svelte';
        const fixture = mount(Fixture, { target: document.querySelector('#fixture') });
        window.controlsFixture = {
          show: (props, dashboard = false) => flushSync(() => fixture.show(props, dashboard)),
          update: props => flushSync(() => fixture.update(props))
        };
      `
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', conditions: ['browser'],
    plugins: [{
      name: 'isolated-real-server-controls',
      setup(builder) {
        builder.onResolve({ filter: /^server-controls-test-fixture$/ }, () => ({
          path: 'ServerControlsTestFixture.svelte', namespace: 'controls-fixture'
        }));
        builder.onLoad({ filter: /./, namespace: 'controls-fixture' }, () => ({
          contents: compile(fixture, {
            filename: path.join(ROOT, 'ServerControlsTestFixture.svelte'),
            generate: 'client', css: 'external', dev: false
          }).js.code,
          resolveDir: ROOT
        }));
        // Logging and the unrelated mod-list store have desktop side effects.
        // Runtime config, version fetching, Svelte stores, and Controls stay real.
        builder.onLoad({ filter: /[/\\]utils[/\\]logger\.js$/ }, () => ({
          contents: 'export default { debug() {}, info() {}, warn() {}, error() {} };'
        }));
        builder.onLoad({ filter: /[/\\]stores[/\\]modStore\.js$/ }, ({ path: filename }) => ({
          contents: "import { writable } from 'svelte/store'; export const errorMessage = writable('');",
          resolveDir: path.dirname(filename)
        }));
        builder.onLoad({ filter: /\.svelte$/, namespace: 'file' }, async ({ path: filename }) => ({
          contents: compile(/Server(?:Metrics|Console)\.svelte$/.test(filename)
            ? '<div></div>' : await fs.readFile(filename, 'utf8'), {
            filename, generate: 'client', css: 'external', dev: false
          }).js.code,
          resolveDir: path.dirname(filename)
        }));
      }
    }]
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => route.request().url() === 'https://controls.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="fixture"></main>' })
    : route.abort());
  await page.goto('https://controls.test/');
  await page.evaluate(() => {
    window.appStartupCompleted = true;
    window.controlsTest = {
      configs: {
        alpha: { version: '1.20.1', loader: 'forge', loaderVersion: '47.4.13', port: 25565, maxRam: 4 },
        beta: { version: '1.21.1', loader: 'fabric', loaderVersion: '0.16.10', port: 25566, maxRam: 4 },
        gamma: { version: '1.21.5', loader: 'vanilla', port: 25567, maxRam: 4 }
      },
      requests: [], fetches: [], pendingFetches: [], pendingConfigs: [],
      holdNextFetch: false, holdConfigPath: null, failConfigPath: null,
      latestMc: '26.3'
    };
    const state = window.controlsTest;
    window.fetch = async url => {
      if (url !== 'https://meta.fabricmc.net/v2/versions/game') throw new Error(`Unexpected fetch: ${url}`);
      state.fetches.push(url);
      const latest = state.latestMc;
      if (state.holdNextFetch) {
        state.holdNextFetch = false;
        await new Promise(resolve => state.pendingFetches.push(resolve));
      }
      return new Response(JSON.stringify([{ version: latest, stable: true }]), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    };
    window.electron = {
      on() {}, removeListener() {}, removeAllListeners() {},
      async invoke(channel, request) {
        state.requests.push({ channel, request });
        if (channel === 'read-config') {
          const config = state.configs[request] || null;
          if (request === state.holdConfigPath) await new Promise(resolve => state.pendingConfigs.push(resolve));
          if (request === state.failConfigPath) throw new Error('config unavailable');
          return config;
        }
        if (channel === 'get-settings') return { success: true, settings: { port: 25565, maxRam: 4, managementPort: 8080, autoStartMinecraft: false, autoStartManagement: false } };
        if (channel === 'get-server-status') return { status: 'Stopped', instanceId: request.instanceId, playersInfo: { names: [] } };
        if (channel === 'get-management-server-status') return { success: true, status: { isRunning: false, clientCount: 0 } };
        if (channel === 'get-management-invite-info') return { success: true, configured: false, requiresSetup: true };
        if (channel === 'server-java-check-requirements') return { success: true, isAvailable: true, requiredJavaVersion: 17 };
        if (channel === 'get-loader-versions') return { success: true, versions: [request.mcVersion === '26.3' ? '66.0.0' : '47.4.20'] };
        throw new Error(`Unexpected IPC: ${channel}`);
      }
    };
  });
  await page.addScriptTag({ content: bundle });
});

function props(serverPath, modpackManaged) {
  return { serverPath, currentInstance: { id: serverPath, type: 'server', path: serverPath }, modpackManaged };
}

async function show(page, serverPath, modpackManaged, dashboard = false) {
  await page.evaluate(({ value, dashboard }) => window.controlsFixture.show(value, dashboard), {
    value: props(serverPath, modpackManaged), dashboard
  });
}

async function update(page, serverPath, modpackManaged) {
  await page.evaluate(value => window.controlsFixture.update(value), props(serverPath, modpackManaged));
}

const header = page => page.locator('.server-controls .compact-header');

async function expectNoGenericCheck(page) {
  await expect(header(page).getByRole('button', { name: 'Check Updates', exact: true })).toHaveCount(0);
  await expect(header(page)).not.toContainText('→');
  await expect(header(page)).not.toContainText('All versions are up to date');
  expect(await page.evaluate(() => window.controlsTest.fetches.length)).toBe(0);
  expect(await page.evaluate(() => window.controlsTest.requests.filter(value => value.channel === 'get-loader-versions'))).toEqual([]);
}

test('managed dashboard renders its installed runtime and routes updates to the pack without generic fetches', async ({ page }) => {
  await show(page, 'alpha', true, true);
  await expect(header(page)).toContainText('Managed by modpack');
  await expect(header(page)).toContainText('MC 1.20.1');
  await expect(header(page)).toContainText('Forge 47.4.13');
  await expectNoGenericCheck(page);
  await header(page).getByRole('button', { name: 'Modpack versions', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/modpack');
});

test('unknown managed state does not request or recommend independent runtime updates', async ({ page }) => {
  await show(page, 'alpha', null);
  await expect(header(page)).toBeVisible();
  await expectNoGenericCheck(page);
  await expect(header(page)).not.toContainText('Managed by modpack');
});

test('unmanaged server keeps the generic update check and runtime recommendation', async ({ page }) => {
  await show(page, 'alpha', false);
  await expect(header(page).getByRole('button', { name: 'Check Updates', exact: true })).toBeVisible();
  await expect(header(page)).toContainText('MC 1.20.1 → 26.3');
  await expect(header(page)).toContainText('Forge 47.4.13 → 66.0.0');
  await expect(header(page)).not.toContainText('Managed by modpack');
});

test('switching from managed to unmanaged enables a fresh check on the same mounted controls', async ({ page }) => {
  await show(page, 'alpha', true);
  await expect(header(page)).toContainText('Managed by modpack');
  await expectNoGenericCheck(page);
  await update(page, 'gamma', false);
  await expect(header(page)).toContainText('MC 1.21.5 → 26.3');
  await expect(header(page).getByRole('button', { name: 'Check Updates', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.controlsTest.fetches.length)).toBe(1);
});

test('a delayed old generic response cannot overwrite a newer server or a managed header', async ({ page }) => {
  await page.evaluate(() => { window.controlsTest.holdNextFetch = true; });
  await show(page, 'alpha', false);
  await expect.poll(() => page.evaluate(() => window.controlsTest.pendingFetches.length)).toBe(1);
  await update(page, 'beta', true);
  await expect(header(page)).toContainText('Managed by modpack');
  await expect(header(page)).toContainText('Fabric 0.16.10');
  await expect(header(page)).not.toContainText('→');
  await page.evaluate(() => { window.controlsTest.latestMc = '1.21.6'; });
  await update(page, 'gamma', false);
  await expect(header(page)).toContainText('MC 1.21.5 → 1.21.6');
  await page.evaluate(() => window.controlsTest.pendingFetches.shift()());
  await expect.poll(() => page.evaluate(() => window.controlsTest.requests.filter(value => value.channel === 'get-loader-versions').length)).toBe(2);
  await expect(header(page)).toContainText('MC 1.21.5 → 1.21.6');
  await expect(header(page)).not.toContainText('26.3');
});

test('a config read started before switching to managed cannot start a generic version fetch', async ({ page }) => {
  await page.evaluate(() => { window.controlsTest.holdConfigPath = 'alpha'; });
  await show(page, 'alpha', false);
  await expect.poll(() => page.evaluate(() => window.controlsTest.pendingConfigs.length)).toBeGreaterThan(0);
  await update(page, 'beta', true);
  await expect(header(page)).toContainText('Fabric 0.16.10');
  await page.evaluate(() => window.controlsTest.pendingConfigs.splice(0).forEach(resolve => resolve()));
  await expect(header(page)).toContainText('Managed by modpack');
  await expectNoGenericCheck(page);
});

test('a failed managed config read cannot label the previous server runtime as installed', async ({ page }) => {
  await show(page, 'alpha', true);
  await expect(header(page)).toContainText('Forge 47.4.13');
  await page.evaluate(() => { window.controlsTest.failConfigPath = 'beta'; });
  await update(page, 'beta', true);
  await expect(header(page)).toContainText('Managed by modpack');
  await expect(header(page)).toContainText('Installed runtime unavailable');
  await expect(header(page)).not.toContainText('1.20.1');
  await expectNoGenericCheck(page);
});

test('a managed state change refreshes the installed runtime for the same mounted dashboard instance', async ({ page }) => {
  await show(page, 'alpha', true, true);
  await expect(header(page)).toContainText('Forge 47.4.13');

  await page.evaluate(() => {
    window.controlsTest.configs.alpha = window.controlsTest.configs.beta;
    window.controlsFixture.update({ modpackStateGeneration: 1 });
  });

  await expect(header(page)).toContainText('MC 1.21.1');
  await expect(header(page)).toContainText('Fabric 0.16.10');
  await expect(header(page)).not.toContainText('Forge 47.4.13');
  await expectNoGenericCheck(page);
});

test('an older same-instance config refresh cannot overwrite a newer managed runtime', async ({ page }) => {
  await show(page, 'alpha', true, true);
  await expect(header(page)).toContainText('Forge 47.4.13');
  await page.evaluate(() => {
    window.controlsTest.configs.alpha = window.controlsTest.configs.beta;
    window.controlsTest.holdConfigPath = 'alpha';
    window.controlsFixture.update({ modpackStateGeneration: 1 });
  });
  await expect.poll(() => page.evaluate(() => window.controlsTest.pendingConfigs.length)).toBe(1);
  await expect(header(page)).toContainText('Loading installed runtime');
  await expect(header(page)).not.toContainText('Forge 47.4.13');

  await page.evaluate(() => {
    window.controlsTest.holdConfigPath = null;
    window.controlsTest.configs.alpha = window.controlsTest.configs.gamma;
    window.controlsFixture.update({ modpackStateGeneration: 2 });
  });
  await expect(header(page)).toContainText('MC 1.21.5');
  await page.evaluate(() => window.controlsTest.pendingConfigs.shift()());
  await expect(header(page)).toContainText('MC 1.21.5');
  await expect(header(page)).not.toContainText('Fabric 0.16.10');
  await expectNoGenericCheck(page);
});
