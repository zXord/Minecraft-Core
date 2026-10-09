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
      export function hide() { shown = false; }
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
          update: props => flushSync(() => fixture.update(props)),
          hide: () => flushSync(() => fixture.hide())
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
    state.recovery = [];
    state.recoveryReplies = [];
    state.pendingRecovery = [];
    state.listeners = {};
    state.autoStart = false;
    state.holdManagementStart = false;
    state.pendingManagementStarts = [];
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
      on(channel, handler) { (state.listeners[channel] ||= []).push(handler); },
      removeListener(channel, handler) { state.listeners[channel] = (state.listeners[channel] || []).filter(value => value !== handler); },
      removeAllListeners(channel) { state.listeners[channel] = []; },
      async invoke(channel, request) {
        state.requests.push({ channel, request });
        if (channel === 'modpacks:list-recovery') {
          const reply = state.recoveryReplies.shift() || { value: state.recovery };
          if (reply.hold) await new Promise((resolve, reject) => state.pendingRecovery.push({ resolve, reject }));
          if (reply.error) throw new Error('recovery unavailable');
          return { ok: true, value: reply.value };
        }
        if (channel === 'start-management-server' && state.holdManagementStart) {
          await new Promise(resolve => state.pendingManagementStarts.push(resolve));
          return { success: true };
        }
        if (channel === 'start-server' || channel === 'start-management-server') return { success: true };
        if (channel === 'read-config') {
          const config = state.configs[request] || null;
          if (request === state.holdConfigPath) await new Promise(resolve => state.pendingConfigs.push(resolve));
          if (request === state.failConfigPath) throw new Error('config unavailable');
          return config;
        }
        if (channel === 'get-settings') return { success: true, settings: { port: 25565, maxRam: 4, managementPort: 8080, autoStartMinecraft: state.autoStart, autoStartManagement: state.autoStart } };
        if (channel === 'get-server-status') return { status: state.serverStatus || 'Stopped', instanceId: request.instanceId, playersInfo: { names: [] } };
        if (channel === 'get-management-server-status') return { success: true, status: { isRunning: Boolean(state.managementRunning), clientCount: 0 } };
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
const starts = page => page.locator('.server-controls').getByRole('button', { name: 'Start', exact: true });
const recoveryStatus = page => page.getByRole('status', { name: 'Server recovery status' });
const startCalls = page => page.evaluate(() => window.controlsTest.requests.filter(value => ['start-server', 'start-management-server'].includes(value.channel)));

async function forceStartHandlers(page) {
  await starts(page).evaluateAll(buttons => buttons.forEach(button => {
    button.disabled = false;
    button.click();
  }));
}

test('Dashboard checks recovery before either ordinary Start handler can change stopped status', async ({ page }) => {
  await page.evaluate(() => window.controlsTest.recoveryReplies.push({ hold: true, value: [] }));
  await show(page, 'alpha', true, true);
  await expect(recoveryStatus(page)).toHaveText('Checking recovery status…');
  await expect(starts(page).nth(0)).toBeDisabled();
  await expect(starts(page).nth(1)).toBeDisabled();
  await forceStartHandlers(page);
  expect(await startCalls(page)).toEqual([]);
  await expect(page.locator('.status-compact')).toContainText('Stopped');
  await expect(page.locator('.management-status-compact')).toContainText('Stopped');
  await page.evaluate(() => window.controlsTest.pendingRecovery.shift().resolve());
  await expect(starts(page).nth(0)).toBeEnabled();
  await expect(starts(page).nth(1)).toBeEnabled();
});

for (const managed of [true, false]) {
  test(`matching recovery guards both Starts and offers normal navigation (managed=${managed})`, async ({ page }) => {
    await page.evaluate(() => window.controlsTest.recovery = [{ serverId: 'alpha', phase: 'failed' }]);
    await show(page, 'alpha', managed);
    await expect(recoveryStatus(page)).toContainText('Recovery is pending for this server. Review Modpack recovery before starting.');
    await expect(starts(page).nth(0)).toBeDisabled();
    await expect(starts(page).nth(1)).toBeDisabled();
    await forceStartHandlers(page);
    expect(await startCalls(page)).toEqual([]);
    await recoveryStatus(page).getByRole('button', { name: 'Review Modpack' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/modpack');
  });

  test(`empty or unrelated records keep ordinary stopped Starts available (managed=${managed})`, async ({ page }) => {
    await page.evaluate(() => window.controlsTest.recovery = [{ serverId: 'beta' }]);
    await show(page, 'alpha', managed);
    await expect(starts(page).nth(0)).toBeEnabled();
    await expect(starts(page).nth(1)).toBeEnabled();
    await starts(page).nth(0).click();
    await starts(page).nth(1).click();
    expect((await startCalls(page)).map(value => value.channel)).toEqual(['start-server', 'start-management-server']);
  });
}

for (const reply of [{ error: true }, { value: {} }, { value: { items: 'bad' } }, { value: null }]) {
  test(`unavailable/malformed recovery stays guarded and explicit: ${JSON.stringify(reply)}`, async ({ page }) => {
    await page.evaluate(reply => window.controlsTest.recoveryReplies.push(reply), reply);
    await show(page, 'alpha', true);
    await expect(recoveryStatus(page)).toContainText('Recovery status could not be checked');
    await expect(starts(page).nth(0)).toBeDisabled();
    await expect(starts(page).nth(1)).toBeDisabled();
    await forceStartHandlers(page);
    expect(await startCalls(page)).toEqual([]);
    await recoveryStatus(page).getByRole('button', { name: 'Retry check' }).click();
    await expect(starts(page).nth(0)).toBeEnabled();
    await expect(starts(page).nth(1)).toBeEnabled();
  });
}

for (const scope of ['server', 'generation', 'path']) {
  for (const staleResult of ['success', 'rejection']) {
    test(`stale ${staleResult}/finally cannot release the newer ${scope} recovery read`, async ({ page }) => {
      await page.evaluate(() => window.controlsTest.recoveryReplies.push({ hold: true, value: [] }, { hold: true, value: [{ serverId: 'beta' }, { serverId: 'alpha' }] }));
      await show(page, 'alpha', true);
      await expect(recoveryStatus(page)).toContainText('Checking recovery status…');
      if (scope === 'server') await update(page, 'beta', true);
      if (scope === 'generation') await page.evaluate(() => window.controlsFixture.update({ modpackStateGeneration: 1 }));
      if (scope === 'path') await page.evaluate(() => window.controlsFixture.update({ serverPath: 'gamma' }));
      await expect.poll(() => page.evaluate(() => window.controlsTest.pendingRecovery.length)).toBe(2);
      await page.evaluate(result => {
        const pending = window.controlsTest.pendingRecovery[0];
        if (result === 'rejection') pending.reject(new Error('stale')); else pending.resolve();
      }, staleResult);
      await page.waitForTimeout(20);
      await expect(recoveryStatus(page)).toHaveText('Checking recovery status…');
      await expect(starts(page).nth(0)).toBeDisabled();
      await page.evaluate(() => window.controlsTest.pendingRecovery[1].resolve());
      await expect(recoveryStatus(page)).toContainText('Recovery is pending for this server.');
    });
  }
}

test('only exact-server terminal events refresh once and refreshed empty recovery clears restriction', async ({ page }) => {
  await show(page, 'alpha', true);
  await expect(starts(page).nth(0)).toBeEnabled();
  await page.evaluate(() => {
    const state = window.controlsTest;
    state.recovery = [{ stableServerId: 'alpha' }];
    const emit = value => state.listeners['modpacks:job-progress'].forEach(handler => handler(value));
    emit({ jobId: 'other', serverId: 'beta', phase: 'failed' });
    emit({ jobId: 'missing', phase: 'failed' });
    emit({ jobId: 'working', serverId: 'alpha', phase: 'staging' });
  });
  expect(await page.evaluate(() => window.controlsTest.requests.filter(value => value.channel === 'modpacks:list-recovery').length)).toBe(1);
  await page.evaluate(() => {
    const state = window.controlsTest;
    const event = { jobId: 'failed-cleanup', serverId: 'alpha', phase: 'failed' };
    state.listeners['modpacks:job-progress'].forEach(handler => { handler(event); handler(event); });
  });
  await expect(recoveryStatus(page)).toContainText('Recovery is pending');
  expect(await page.evaluate(() => window.controlsTest.requests.filter(value => value.channel === 'modpacks:list-recovery').length)).toBe(2);
  await page.evaluate(() => {
    window.controlsFixture.hide();
    window.controlsTest.recovery = [];
    window.controlsFixture.show({ serverPath: 'alpha', currentInstance: { id: 'alpha', type: 'server' }, modpackManaged: true });
  });
  await expect(starts(page).nth(0)).toBeEnabled();
});

for (const scope of ['server', 'generation']) {
  for (const staleResult of ['success', 'rejection']) {
    test(`out-of-order old ${staleResult} cannot overwrite ready recovery for newer ${scope}`, async ({ page }) => {
      await page.evaluate(() => window.controlsTest.recoveryReplies.push(
        { hold: true, value: [] },
        { hold: true, value: { items: [{ serverId: 'alpha' }, { serverId: 'beta' }] } }
      ));
      await show(page, 'alpha', true, true);
      await expect(recoveryStatus(page)).toContainText('Checking recovery status');
      if (scope === 'server') await update(page, 'beta', true);
      else await page.evaluate(() => window.controlsFixture.update({ modpackStateGeneration: 1 }));
      await expect.poll(() => page.evaluate(() => window.controlsTest.pendingRecovery.length)).toBe(2);
      await page.evaluate(() => window.controlsTest.pendingRecovery[1].resolve());
      await expect(recoveryStatus(page)).toContainText('Recovery is pending');
      await page.evaluate(result => {
        const pending = window.controlsTest.pendingRecovery[0];
        if (result === 'rejection') pending.reject(new Error('old rejection')); else pending.resolve();
      }, staleResult);
      await page.waitForTimeout(20);
      await expect(recoveryStatus(page)).toContainText('Recovery is pending');
      await expect(starts(page).nth(0)).toBeDisabled();
      await expect(starts(page).nth(1)).toBeDisabled();
    });
  }
}

test('destroy invalidates reads and saved terminal callbacks without IPC or status writes', async ({ page }) => {
  await page.evaluate(() => window.controlsTest.recoveryReplies.push({ hold: true, value: [{ serverId: 'alpha' }] }));
  await show(page, 'alpha', true);
  await expect(recoveryStatus(page)).toContainText('Checking recovery status');
  await page.evaluate(() => {
    const state = window.controlsTest;
    const saved = state.listeners['modpacks:job-progress'][0];
    window.controlsFixture.hide();
    saved({ serverId: 'alpha', jobId: 'late', phase: 'failed' });
    state.pendingRecovery[0].resolve();
  });
  await expect(page.locator('.server-controls')).toHaveCount(0);
  expect(await page.evaluate(() => window.controlsTest.listeners['modpacks:job-progress'].length)).toBe(0);
  expect(await page.evaluate(() => window.controlsTest.requests.filter(value => value.channel === 'modpacks:list-recovery').length)).toBe(1);
});

test('pending recovery keeps existing running-server Stop and Kill available', async ({ page }) => {
  await page.evaluate(() => {
    window.controlsTest.serverStatus = 'Running';
    window.controlsTest.managementRunning = true;
    window.controlsTest.recovery = [{ serverId: 'alpha' }];
  });
  await show(page, 'alpha', true);
  await expect(recoveryStatus(page)).toContainText('Recovery is pending');
  await expect(page.locator('.minecraft-server-section').getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expect(page.locator('.minecraft-server-section').getByRole('button', { name: 'Kill', exact: true })).toBeEnabled();
  await expect(page.locator('.management-compact').getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
});

for (const initial of ['empty', 'pending', 'error', 'switch', 'destroy']) {
  test(`one-time local auto-start waits for fresh initial recovery: ${initial}`, async ({ page }) => {
    await page.evaluate(initial => {
      window.appStartupCompleted = false;
      window.controlsTest.autoStart = true;
      window.controlsTest.recoveryReplies.push({ hold: true, value: initial === 'pending' ? [{ instanceId: 'alpha' }] : [], error: initial === 'error' });
    }, initial);
    await show(page, 'alpha', true);
    await expect.poll(() => page.evaluate(() => window.controlsTest.requests.some(value => value.channel === 'get-management-server-status'))).toBe(true);
    expect(await startCalls(page)).toEqual([]);
    if (initial === 'switch') await update(page, 'beta', true);
    if (initial === 'destroy') await page.evaluate(() => window.controlsFixture.hide());
    await page.evaluate(() => window.controlsTest.pendingRecovery[0].resolve());
    if (initial === 'empty') {
      await expect.poll(async () => (await startCalls(page)).length).toBe(2);
      expect((await startCalls(page)).map(value => value.request.instanceId)).toEqual(['alpha', 'alpha']);
      await page.evaluate(() => window.controlsTest.listeners['modpacks:job-progress'].forEach(handler => handler({ serverId: 'alpha', jobId: 'later', phase: 'completed' })));
      await page.waitForTimeout(100);
      expect((await startCalls(page)).length).toBe(2);
    } else {
      if (initial === 'pending') {
        await expect(recoveryStatus(page)).toContainText('Recovery is pending');
        await page.evaluate(() => {
          window.controlsTest.recovery = [];
          window.controlsTest.listeners['modpacks:job-progress'].forEach(handler => handler({ serverId: 'alpha', jobId: 'later', phase: 'completed' }));
        });
        await expect(starts(page).nth(0)).toBeEnabled();
      }
      if (initial === 'error') {
        await expect(recoveryStatus(page)).toContainText('Recovery status could not be checked');
        await recoveryStatus(page).getByRole('button', { name: 'Retry check' }).click();
        await expect(starts(page).nth(0)).toBeEnabled();
      }
      await page.waitForTimeout(100);
      expect(await startCalls(page)).toEqual([]);
    }
  });
}

test('missing selector has setup/no-start rather than an endless recovery spinner', async ({ page }) => {
  await page.evaluate(() => window.controlsFixture.show({ serverPath: '', currentInstance: null, modpackManaged: false }));
  await expect(starts(page).nth(0)).toBeDisabled();
  await expect(starts(page).nth(1)).toBeDisabled();
  await expect(recoveryStatus(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.controlsTest.requests.filter(value => value.channel === 'modpacks:list-recovery'))).toEqual([]);
});

for (const invalidation of ['server', 'path', 'generation', 'destroy']) {
  test(`in-flight local auto-start cannot cross ${invalidation} while first management Start is pending`, async ({ page }) => {
    await page.evaluate(() => {
      window.appStartupCompleted = false;
      window.controlsTest.autoStart = true;
      window.controlsTest.holdManagementStart = true;
    });
    await show(page, 'alpha', true);
    await expect.poll(() => page.evaluate(() => window.controlsTest.pendingManagementStarts.length)).toBe(1);
    expect((await startCalls(page)).map(call => [call.channel, call.request.instanceId])).toEqual([['start-management-server', 'alpha']]);
    if (invalidation === 'server') await update(page, 'beta', true);
    if (invalidation === 'path') await page.evaluate(() => window.controlsFixture.update({ serverPath: 'gamma' }));
    if (invalidation === 'generation') await page.evaluate(() => window.controlsFixture.update({ modpackStateGeneration: 1 }));
    if (invalidation === 'destroy') await page.evaluate(() => window.controlsFixture.hide());
    else await expect(starts(page).nth(0)).toBeEnabled();
    await page.evaluate(() => window.controlsTest.pendingManagementStarts[0]());
    await page.waitForTimeout(100);
    expect((await startCalls(page)).map(call => [call.channel, call.request.instanceId])).toEqual([['start-management-server', 'alpha']]);
    expect(await page.evaluate(() => window.appStartupCompleted)).toBe(false);
  });
}

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
