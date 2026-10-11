import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let bundle;
let componentCss = '';
// Browser plugin not available. Real parent/child validation only, without a server.
test.beforeAll(async () => {
  const styles = [];
  const fixture = `<script>
    import Setup from './src/components/setup/ServerSetupWizard.svelte';
    import Page from './src/routes/ModpackPage.svelte';
    let visible = true;
    let mode = 'setup';
    let targetId = '';
    let server = { id: 'existing-server', type: 'server', name: 'Existing server' };
    export function show(value) { visible = value; }
    export function target(value) { targetId = value; }
    export function page(value) { mode = 'page'; server = { ...server, ...value }; }
  </script>{#if visible}{#if mode === 'page'}<Page currentInstance={server} />{:else}<Setup instanceId={targetId} on:setup-complete={event => window.launchTest.completions.push(event.detail)} />{/if}{/if}`;
  const result = await build({
    absWorkingDir: ROOT, stdin: { resolveDir: ROOT, contents: `import Fixture from 'launch-fixture'; import { mount, flushSync } from 'svelte';
      const fixture = mount(Fixture, { target: document.querySelector('#fixture') });
      window.launchFixture = { show: value => flushSync(() => fixture.show(value)), target: value => flushSync(() => fixture.target(value)), page: value => flushSync(() => fixture.page(value)) };` },
    bundle: true, write: false, platform: 'browser', format: 'iife', conditions: ['browser'],
    plugins: [{ name: 'real-components', setup(builder) {
      builder.onResolve({ filter: /^launch-fixture$/ }, () => ({ path: 'LaunchFixture.svelte', namespace: 'fixture' }));
      builder.onLoad({ filter: /./, namespace: 'fixture' }, () => ({ contents: compile(fixture, { filename: path.join(ROOT, 'LaunchFixture.svelte'), generate: 'client', css: 'external' }).js.code, resolveDir: ROOT }));
      builder.onLoad({ filter: /\.svelte$/, namespace: 'file' }, async ({ path: filename }) => {
        const component = compile(await fs.readFile(filename, 'utf8'), { filename, generate: 'client', css: 'external' });
        if (component.css) styles.push(component.css.code.replace(/@import[^;]+;/gu, ''));
        return { contents: component.js.code, resolveDir: path.dirname(filename) };
      });
    } }]
  });
  bundle = result.outputFiles[0].text;
  componentCss = await fs.readFile(path.join(ROOT, 'src/components/modpacks/modpack-ui.css'), 'utf8') + styles.join('\n');
});

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => route.abort());
  await page.setContent('<!doctype html><title>Launch reconciliation fixture</title><main id="fixture"></main>');
  await page.addStyleTag({ content: `body { background: #17191d; color: #eee; font-family: system-ui; } #fixture { max-width: 1040px; margin: 24px auto; } ${componentCss}` });
  await page.evaluate(() => {
    const fingerprint = 'a'.repeat(64);
    const planId = 'plan-launch-v1-11111111-1111-4111-8111-111111111111';
    const job = { type: 'minecraft-core-modpack-job', schemaVersion: 1, sequence: 1,
      jobId: 'launch-job', serverId: 'pending-launch', operationKind: 'install-new', planFingerprint: fingerprint,
      phase: 'queued', swapStep: 'none', progress: null, cancellationRequested: false,
      createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', terminalAt: null, outcome: null, events: [] };
    window.launchTest = { planId, fingerprint, job, requests: [], completions: [], mode: 'success',
      reconciliation: { status: 'started', planId, planFingerprint: fingerprint, job, settlement: { status: 'active', destinationDisposition: 'held', recoveryAvailable: false } },
      items: [], nextCursor: null, callbacks: {}, errors: [], pending: [], listError: null };
    window.electron = { on(channel, callback) { (window.launchTest.callbacks[channel] ||= []).push(callback); }, removeListener() {},
      async invoke(channel, request) {
        const state = window.launchTest;
        state.requests.push({ channel, request });
        if (state.defer === channel) return new Promise((resolve, reject) => { const pending = { channel, request, resolve: value => resolve({ ok: true, value }), reject }; state.pending.push(pending); state.resolve = pending.resolve; });
        if (channel === 'modpacks:select-local-archive') return { ok: true, value: { selectionId: 'local-selection', displayName: 'Captured pack' } };
        if (channel === 'modpacks:inspect') return { ok: true, value: { inspectionId: 'launch-inspection', classification: state.inspectionClassification || { kind: 'server-pack', runtime: { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.0' } }, rootCandidates: [], entries: [] } };
        if (channel === 'modpacks:reserve-server-destination') return { ok: true, value: { instanceId: 'pending-launch', displayName: 'Captured destination' } };
        if (channel === 'modpacks:preflight') return { ok: true, value: { planId: state.planId, planFingerprint: state.fingerprint, planView: { operationKind: request.operationKind, server: { id: request.instanceId }, title: 'Captured reviewed plan', blockers: [] } } };
        if (channel === 'modpacks:start-operation') {
          if (state.reentrant) {
            document.querySelector('button[data-launch-start]')?.click();
            [...document.querySelectorAll('button')].find(button => button.textContent === 'Choose another asset')?.click();
          }
          if (state.mode === 'transport') throw new Error('Dropped response');
          if (state.mode === 'structured') return { ok: false, error: { code: 'PLAN_STALE', message: 'Stale response' } };
          if (state.mode === 'malformed') return { ok: true, value: { ...state.job, serverId: 'unrelated-server' } };
          return { ok: true, value: state.job };
        }
        if (channel === 'modpacks:reconcile-new-server-launch') return { ok: true, value: state.reconciliation };
        if (channel === 'modpacks:list-new-server-launches') {
          if (state.listError) { const error = state.listError; if (state.listErrorOnce) state.listError = null; return { ok: false, error }; }
          return { ok: true, value: state.listOverride || { items: state.items, nextCursor: state.nextCursor } };
        }
        if (channel === 'modpacks:get-job') return { ok: true, value: state.jobOverride || state.job };
        if (channel === 'modpacks:list-recovery') return { ok: true, value: { items: [] } };
        if (channel === 'modpacks:get-state') return { ok: true, value: state.managedState || { modpackManaged: false, lifecycleMode: 'unmanaged' } };
        if (channel === 'modpacks:list-notifications') return { ok: true, value: { items: [], nextCursor: null } };
        if (channel === 'modpacks:list-history') return { ok: true, value: { items: [], nextCursor: null } };
        if (channel === 'modpacks:get-active-jobs') return { ok: true, value: { serverId: request.serverId, items: state.activeItems || [] } };
        if (channel === 'modpacks:preflight-management') return { ok: true, value: { planId: state.planId, planFingerprint: state.fingerprint, planView: { operationKind: request.operationKind, title: 'Management plan', blockers: [] } } };
        if (channel === 'modpacks:cancel-inspection' || channel === 'modpacks:release-server-destination') return { ok: true, value: state.releaseResult !== false };
        if (channel === 'modpacks:perform-safe-action') return { ok: true, value: { type: 'outcome-action-result', destination: { kind: 'selection' } } };
        throw new Error('Unexpected IPC: ' + channel);
      } };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  page.launchErrors = errors;
  await page.addScriptTag({ content: bundle });
});
test.afterEach(async ({ page }) => { expect(page.launchErrors).toEqual([]); });

async function review(page) {
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
}
const starts = page => page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:start-operation').length);
const releases = page => page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:release-server-destination').length);

test('an explicit initial destination retains its review owner without reserving another target', async ({ page }) => {
  await page.evaluate(() => { window.launchFixture.show(false); window.launchFixture.target('pending-launch'); window.launchFixture.show(true); });
  await review(page);
  await expect(page.getByRole('button', { name: 'Install this exact reviewed plan' })).toBeEnabled();
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:reserve-server-destination').length)).toBe(0);
  expect(await starts(page)).toBe(1); expect(await releases(page)).toBe(0);
});

async function terminalEvent(page, phase = 'completed', sequence = 7) {
  await page.evaluate(({ phase, sequence }) => {
    const s = window.launchTest;
    s.job = { ...s.job, phase, sequence, terminalAt: s.job.createdAt, outcome: { status: phase, kind: phase, actions: [] } };
    const { jobId, operationKind, serverId, progress, cancellationRequested, outcome } = s.job;
    for (const callback of s.callbacks['modpacks:job-progress'] || []) callback({ channel: 'progress', jobId, operationKind, serverId, sequence, phase, progress, cancellationRequested, outcome, terminal: true });
  }, { phase, sequence });
}

for (const mode of ['transport', 'structured', 'malformed']) test(`${mode} Start reconciles captured credentials without another Start or release`, async ({ page }) => {
  await review(page);
  await page.evaluate(mode => window.launchTest.mode = mode, mode);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  expect(await starts(page)).toBe(1);
  expect(await releases(page)).toBe(0);
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:reconcile-new-server-launch').map(value => value.request)))
    .toEqual([{ planId: 'plan-launch-v1-11111111-1111-4111-8111-111111111111', planFingerprint: 'a'.repeat(64) }]);
});

test('Start owns destination synchronously before reentrant Back and duplicate click', async ({ page }) => {
  await review(page);
  await page.evaluate(() => window.launchTest.reentrant = true);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  expect(await starts(page)).toBe(1);
  expect(await releases(page)).toBe(0);
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toHaveCount(0);
});

test('reload discovery requires explicit exact selection and hydrated completion emits once', async ({ page }) => {
  await page.evaluate(() => {
    const s = window.launchTest;
    s.job = { ...s.job, sequence: 5, phase: 'completed', terminalAt: s.job.createdAt, outcome: { status: 'completed', kind: 'completed', actions: [] } };
    s.reconciliation = { ...s.reconciliation, job: s.job, settlement: { status: 'settled', destinationDisposition: 'consumed', recoveryAvailable: false } };
    s.items = [{ planId: s.planId, planFingerprint: s.fingerprint, status: 'started', createdAt: s.job.createdAt, serverId: s.job.serverId, operationKind: s.job.operationKind, displayName: 'Prior setup', jobId: s.job.jobId, settlement: s.reconciliation.settlement }];
    window.launchFixture.show(false); window.launchFixture.show(true);
  });
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await expect(page.getByRole('button', { name: /Prior setup/ })).toBeVisible();
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
  await page.getByRole('button', { name: /Prior setup/ }).click();
  await expect.poll(() => page.evaluate(() => window.launchTest.completions)).toEqual([{ instanceId: 'pending-launch', modpackJobId: 'launch-job', source: 'Prior setup' }]);
  await page.evaluate(() => { const s = window.launchTest; for (const callback of s.callbacks['modpacks:job-progress'] || []) callback({ ...s.job, terminal: true }); });
  expect(await page.evaluate(() => window.launchTest.completions.length)).toBe(1);
  expect(await starts(page)).toBe(0);
});

test('pending reconciliation retries at 1200ms and never releases on stalled admission', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T00:00:01Z'));
  await review(page);
  await page.evaluate(() => { const s = window.launchTest; s.mode = 'transport'; s.reconciliation = { status: 'pending', planId: s.planId, planFingerprint: s.fingerprint, reason: 'admission-unresolved' }; });
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  const reads = () => page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:reconcile-new-server-launch').length);
  expect(await reads()).toBe(1);
  await page.clock.runFor(1199); expect(await reads()).toBe(1);
  await page.clock.runFor(1); expect(await reads()).toBe(2);
  expect(await releases(page)).toBe(0); expect(await starts(page)).toBe(1);
});

test('realistic terminal progress is a hint, confirmation hydrates and completes once', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  await page.evaluate(() => {
    const s = window.launchTest;
    s.job = { ...s.job, phase: 'completed', sequence: 7, terminalAt: s.job.createdAt, outcome: { status: 'completed', kind: 'completed' } };
    const { jobId, operationKind, serverId, sequence, phase, progress, cancellationRequested, outcome } = s.job;
    for (const callback of s.callbacks['modpacks:job-progress'] || []) callback({ channel: 'progress', jobId, operationKind, serverId, sequence, phase, progress, cancellationRequested, outcome, terminal: true });
  });
  await expect.poll(() => page.evaluate(() => window.launchTest.completions.length)).toBe(1);
  expect(await releases(page)).toBe(0);
});

test('deferred reservation captures selections and late old reservation releases only itself', async ({ page }) => {
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.evaluate(() => window.launchTest.defer = 'modpacks:reserve-server-destination');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await page.getByRole('spinbutton').first().fill('12');
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await page.evaluate(() => { window.launchTest.defer = ''; window.launchTest.resolve({ instanceId: 'old-reservation', displayName: 'Old destination' }); });
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  await expect.poll(() => releases(page)).toBe(1);
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:release-server-destination').map(value => value.request.instanceId))).toEqual(['old-reservation']);
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:preflight').length)).toBe(0);
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.getByText('Chosen destination:')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Old destination');
});

test('reservation wait seals the original selections instead of reading changed inputs', async ({ page }) => {
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('spinbutton').first().fill('6');
  await page.evaluate(() => window.launchTest.defer = 'modpacks:reserve-server-destination');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await page.getByRole('spinbutton').first().fill('12');
  await page.evaluate(() => { window.launchTest.defer = ''; window.launchTest.resolve({ instanceId: 'pending-launch', displayName: 'Captured destination' }); });
  await expect(page.getByRole('button', { name: 'Install this exact reviewed plan' })).toBeVisible();
  expect(await page.evaluate(() => window.launchTest.requests.find(value => value.channel === 'modpacks:preflight').request.selections.maxRam)).toBe(6);
});

test('old preflight and release completions cannot replace a newer same-server review', async ({ page }) => {
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.evaluate(() => window.launchTest.defer = 'modpacks:preflight');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await page.evaluate(() => window.launchTest.defer = 'modpacks:release-server-destination');
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await page.evaluate(() => {
    const s = window.launchTest;
    s.pending.find(value => value.channel === 'modpacks:preflight').resolve({ planId: 'old-plan', planFingerprint: s.fingerprint, planView: { title: 'Obsolete plan', blockers: [] } });
    s.defer = '';
    s.pending.find(value => value.channel === 'modpacks:release-server-destination').resolve(false);
  });
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.getByRole('heading', { name: 'Captured reviewed plan' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Obsolete plan');
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:reserve-server-destination').length)).toBe(1);
});

test('destroying the parent during Start settles bookkeeping without release or completion', async ({ page }) => {
  await review(page);
  await page.evaluate(() => window.launchTest.defer = 'modpacks:start-operation');
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await page.evaluate(() => { const s = window.launchTest; window.launchFixture.show(false); s.defer = ''; s.resolve(s.job); window.launchFixture.show(true); });
  await expect(page.getByRole('heading', { name: 'How do you want to set it up?' })).toBeVisible();
  expect(await releases(page)).toBe(0);
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
});

test('discovery refresh races retain the newest snapshot without automatic adoption', async ({ page }) => {
  await page.evaluate(() => window.launchTest.defer = 'modpacks:list-new-server-launches');
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.evaluate(() => {
    const s = window.launchTest;
    const base = { planFingerprint: s.fingerprint, status: 'pending', createdAt: s.job.createdAt };
    s.pending[1].resolve({ items: [{ ...base, planId: 'new-candidate', displayName: 'Newest snapshot' }], nextCursor: null });
    s.pending[0].resolve({ items: [{ ...base, planId: 'old-candidate', displayName: 'Obsolete snapshot' }], nextCursor: null });
    s.defer = '';
  });
  await expect(page.getByRole('button', { name: /Newest snapshot/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Obsolete snapshot/ })).toHaveCount(0);
  expect(await starts(page)).toBe(0);
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:get-job').length)).toBe(0);
});

test('selected pending reload candidate stays exact across publication without restarting', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T00:00:01Z'));
  await page.evaluate(() => {
    const s = window.launchTest;
    s.items = [{ planId: s.planId, planFingerprint: s.fingerprint, status: 'pending', createdAt: s.job.createdAt }];
    s.reconciliation = { status: 'pending', planId: s.planId, planFingerprint: s.fingerprint };
  });
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.getByRole('button', { name: /Unresolved setup/ }).click();
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  await page.evaluate(() => { const s = window.launchTest; s.reconciliation = { status: 'started', planId: s.planId, planFingerprint: s.fingerprint, job: s.job, settlement: { status: 'active', destinationDisposition: 'held', recoveryAvailable: false } }; });
  await page.clock.runFor(1200);
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  expect(await starts(page)).toBe(0); expect(await releases(page)).toBe(0);
});

for (const field of ['serverId', 'operationKind', 'planFingerprint', 'jobId']) test(`wrong ${field} authoritative lookup never adopts or completes`, async ({ page }) => {
  await review(page);
  await page.evaluate(field => { const s = window.launchTest; s.defer = 'modpacks:get-job'; s.badField = field; }, field);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect.poll(() => page.evaluate(() => window.launchTest.pending.length)).toBe(1);
  await page.evaluate(() => { const s = window.launchTest; s.resolve({ ...s.job, [s.badField]: s.badField === 'planFingerprint' ? 'b'.repeat(64) : 'other' }); });
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toHaveCount(0);
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
  expect(await starts(page)).toBe(1); expect(await releases(page)).toBe(0);
});

test('existing page real review callback adopts the captured existing-server job', async ({ page }) => {
  await page.evaluate(() => { const s = window.launchTest; s.job = { ...s.job, serverId: 'existing-server', operationKind: 'install-existing' }; window.launchFixture.page({}); });
  await page.getByRole('button', { name: 'Install modpack', exact: true }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('button', { name: 'Review planned changes' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
  await page.getByRole('button', { name: 'Start reviewed operation' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  expect(await starts(page)).toBe(1);
  expect(await releases(page)).toBe(0);
});

for (const kind of ['uninstall-managed', 'detach']) test(`R1 management uninstall accepts only canonical public kind, returned ${kind}`, async ({ page }) => {
  await page.evaluate(kind => {
    const s = window.launchTest;
    s.managedState = { modpackManaged: true, lifecycleMode: 'managed', source: { provider: 'local' } };
    s.job = { ...s.job, serverId: 'existing-server', operationKind: kind };
    window.launchFixture.page({});
  }, kind);
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Review uninstall', exact: true }).click();
  await page.getByRole('button', { name: 'Remove managed pack files', exact: true }).click();
  await page.getByRole('button', { name: 'Remove managed files', exact: true }).click();
  if (kind === 'uninstall-managed') await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  else {
    await expect(page.getByText(/Start outcome is unknown/).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toHaveCount(0);
  }
  expect(await starts(page)).toBe(1); expect(await releases(page)).toBe(0);
});

async function existingReview(page) {
  await page.getByRole('button', { name: 'Install modpack', exact: true }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('button', { name: 'Review planned changes' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
}

for (const discovery of ['exact', 'unrelated', 'empty']) test(`R2 lost existing Start settles only through exact authoritative discovery: ${discovery}`, async ({ page }) => {
  await page.evaluate(() => { const s = window.launchTest; s.mode = 'transport'; s.job = { ...s.job, serverId: 'existing-server', operationKind: 'install-existing' }; window.launchFixture.page({}); });
  await existingReview(page);
  await page.getByRole('button', { name: 'Start reviewed operation' }).click();
  await expect(page.getByText(/Start outcome is unknown/).first()).toBeVisible();
  await page.evaluate(discovery => {
    const s = window.launchTest;
    if (discovery === 'unrelated') s.job = { ...s.job, jobId: 'unrelated-job', planFingerprint: 'c'.repeat(64) };
    s.activeItems = discovery === 'empty' ? [] : [{ ownership: 'running', job: s.job }];
    for (const callback of s.callbacks['modpacks:state-changed'] || []) callback({ serverId: 'existing-server' });
  }, discovery);
  if (discovery !== 'empty') {
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
    await page.evaluate(() => { window.launchTest.activeItems = []; });
    await terminalEvent(page);
    await page.getByRole('button', { name: 'Return to server' }).click();
  } else await page.getByRole('button', { name: 'Back to Modpack overview' }).click();
  await page.evaluate(() => {
    const s = window.launchTest; s.mode = 'success'; s.planId = 'plan-fresh-review'; s.fingerprint = 'b'.repeat(64);
    s.job = { ...s.job, jobId: 'fresh-operation', planFingerprint: s.fingerprint, phase: 'queued', sequence: 1, terminalAt: null, outcome: null };
  });
  await existingReview(page);
  await page.getByRole('button', { name: 'Start reviewed operation' }).click();
  if (discovery === 'exact') {
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
    expect(await starts(page)).toBe(2);
  } else {
    await expect(page.getByText(/reviewed selection changed/)).toBeVisible();
    expect(await starts(page)).toBe(1);
  }
  expect(await releases(page)).toBe(0);
});

test('completion rejects wrong confirmation then retries at bounded cadence', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T00:00:01Z'));
  await review(page);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  await page.evaluate(() => window.launchTest.defer = 'modpacks:get-job');
  await terminalEvent(page);
  await expect.poll(() => page.evaluate(() => window.launchTest.pending.length)).toBe(1);
  await page.evaluate(() => { const s = window.launchTest; s.pending[0].resolve({ ...s.job, serverId: 'unrelated' }); });
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
  await page.evaluate(() => window.launchTest.defer = '');
  await page.clock.runFor(1199);
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
  await page.clock.runFor(1);
  await expect.poll(() => page.evaluate(() => window.launchTest.completions.length)).toBe(1);
});

for (const boundary of ['Start', 'reconciliation', 'completion']) for (const location of ['outcome', 'events']) test(`R3 private ${location} data at ${boundary} preserves uncertainty and never completes`, async ({ page }) => {
  await review(page);
  if (boundary === 'completion') {
    await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  }
  await page.evaluate(({ boundary, location }) => {
    const s = window.launchTest;
    const value = { ...s.job, phase: 'completed', sequence: 7, terminalAt: s.job.createdAt, outcome: { status: 'completed', kind: 'completed' } };
    const privateData = { nested: [{ recordRevision: { sequence: 1 }, rawError: 'private failure', snapshot: { capturedEpoch: 1 } }] };
    if (location === 'outcome') value.outcome = { ...value.outcome, ...privateData };
    else value.events = [{ sequence: 1, jobId: value.jobId, channel: 'log', phase: 'completed', timestamp: value.createdAt, message: 'Complete', progress: null, currentItem: null, details: privateData }];
    if (boundary === 'completion') s.jobOverride = value;
    else {
      s.job = value;
      s.mode = boundary === 'reconciliation' ? 'transport' : 'success';
      s.reconciliation = boundary === 'reconciliation' ? { ...s.reconciliation, job: value } : { status: 'pending', planId: s.planId, planFingerprint: s.fingerprint };
    }
  }, { boundary, location });
  if (boundary === 'completion') {
    const priorReads = await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:get-job').length);
    await terminalEvent(page);
    await expect.poll(() => page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:get-job').length)).toBeGreaterThan(priorReads);
  } else {
    await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
    await expect(page.getByText(/Start outcome is unknown/).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
  expect(await starts(page)).toBe(1); expect(await releases(page)).toBe(0);
});

test('late terminal confirmation after Return or destroy cannot complete a new setup', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T00:00:01Z'));
  await review(page);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  await page.evaluate(() => window.launchTest.defer = 'modpacks:get-job');
  await terminalEvent(page);
  await expect.poll(() => page.evaluate(() => window.launchTest.pending.length)).toBe(1);
  await page.getByRole('button', { name: 'Return to server' }).click();
  await page.evaluate(() => { const s = window.launchTest; window.launchFixture.show(false); window.launchFixture.show(true); s.defer = ''; s.pending[0].resolve(s.job); });
  await page.clock.runFor(5000);
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'How do you want to set it up?' })).toBeVisible();
  expect(await releases(page)).toBe(0);
});

test('recovered terminal completion emits once and duplicate hints coalesce confirmation', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T00:00:01Z'));
  await review(page);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  await terminalEvent(page, 'recovery-required', 6);
  await expect(page.getByRole('heading', { name: 'Manual recovery required' })).toBeVisible();
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
  await page.evaluate(() => window.launchTest.defer = 'modpacks:get-job');
  await terminalEvent(page, 'completed', 7);
  await expect.poll(() => page.evaluate(() => window.launchTest.pending.length)).toBe(1);
  await terminalEvent(page, 'completed', 7);
  expect(await page.evaluate(() => window.launchTest.pending.length)).toBe(1);
  await page.evaluate(() => { const s = window.launchTest; s.defer = ''; s.pending[0].resolve(s.job); });
  await expect.poll(() => page.evaluate(() => window.launchTest.completions.length)).toBe(1);
  await terminalEvent(page, 'completed', 8);
  expect(await page.evaluate(() => window.launchTest.completions.length)).toBe(1);
});

test('old release finally cannot clear a newer reservation or its busy planning owner', async ({ page }) => {
  await review(page);
  await page.evaluate(() => window.launchTest.defer = 'modpacks:release-server-destination');
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.evaluate(() => window.launchTest.defer = 'modpacks:preflight');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.getByText('Validating the selected destination', { exact: true })).toBeVisible();
  await page.evaluate(() => window.launchTest.pending.find(value => value.channel === 'modpacks:release-server-destination').resolve(true));
  await expect(page.getByText('Validating the selected destination', { exact: true })).toBeVisible();
  await expect(page.getByText('Chosen destination:')).toBeVisible();
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:reserve-server-destination').length)).toBe(2);
});

test('existing page same-server review replacement ignores late old Start and child finally', async ({ page }) => {
  await page.evaluate(() => { const s = window.launchTest; s.job = { ...s.job, serverId: 'existing-server', operationKind: 'install-existing' }; window.launchFixture.page({}); });
  await page.getByRole('button', { name: 'Install modpack', exact: true }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('button', { name: 'Review planned changes' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
  await page.evaluate(() => window.launchTest.defer = 'modpacks:start-operation');
  await page.getByRole('button', { name: 'Start reviewed operation' }).click();
  await page.getByRole('button', { name: 'Change selection', exact: true }).click();
  await page.evaluate(() => { window.launchTest.defer = ''; window.launchTest.planId = 'plan-replacement'; });
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('button', { name: 'Review planned changes' }).click();
  await page.evaluate(() => window.launchTest.pending[0].resolve(window.launchTest.job));
  await expect(page.getByRole('button', { name: 'Start reviewed operation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toHaveCount(0);
  expect(await starts(page)).toBe(1);
});

test('Back from unknown Start permits explicit exact discovery, never another destination', async ({ page }) => {
  await review(page);
  await page.evaluate(() => { const s = window.launchTest; s.mode = 'transport'; s.reconciliation = { status: 'pending', planId: s.planId, planFingerprint: s.fingerprint }; });
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await page.evaluate(() => {
    const s = window.launchTest;
    s.items = [{ planId: s.planId, planFingerprint: s.fingerprint, status: 'pending', createdAt: s.job.createdAt }];
    s.reconciliation = { status: 'started', planId: s.planId, planFingerprint: s.fingerprint, job: s.job, settlement: { status: 'active', destinationDisposition: 'held', recoveryAvailable: false } };
  });
  await page.getByRole('button', { name: /Local archive/ }).click();
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:reserve-server-destination').length)).toBe(1);
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.getByRole('button', { name: /Unresolved setup/ }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  expect(await starts(page)).toBe(1); expect(await releases(page)).toBe(0);
});

test('destination-recovery action rehydrates the exact captured outcome before guarded release', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  await page.evaluate(() => {
    const s = window.launchTest;
    s.job = { ...s.job, sequence: 7, phase: 'failed', terminalAt: s.job.createdAt, outcome: { status: 'failed', kind: 'retained-download', retainedDownload: true, errorCode: 'RECOVERY_REQUIRED', failureReason: 'destination-recovery', actions: [{ actionId: 'choose-another-asset', opaqueRef: 'captured-action' }] } };
    const { jobId, operationKind, serverId, sequence, phase, progress, cancellationRequested, outcome } = s.job;
    for (const callback of s.callbacks['modpacks:job-progress'] || []) callback({ channel: 'progress', jobId, operationKind, serverId, sequence, phase, progress, cancellationRequested, outcome, terminal: true });
  });
  await page.getByRole('button', { name: 'Start setup again' }).click();
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  expect(await releases(page)).toBe(1);
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:release-server-destination').map(value => value.request.instanceId))).toEqual(['pending-launch']);
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
});

for (const [status, reason, expected] of [
  ['repair-pending', 'settlement-repair-required', 'Settlement repair is pending'],
  ['recovery-required', 'destination-recovery', 'Recovery is required'],
  ['support-required', 'conflicting-evidence', 'Support is required']
]) test(`known held terminal stays started beside honest ${status} copy`, async ({ page }) => {
  await review(page);
  await page.evaluate(({ status, reason }) => {
    const s = window.launchTest;
    s.mode = 'transport';
    s.job = { ...s.job, sequence: 5, phase: 'failed', terminalAt: s.job.createdAt, outcome: { status: 'failed', kind: 'nothing-changed', actions: [] } };
    s.reconciliation = { ...s.reconciliation, job: s.job, settlement: { status, reason, destinationDisposition: 'held', recoveryAvailable: status === 'recovery-required' } };
  }, { status, reason });
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  await expect(page.getByText(new RegExp(expected)).first()).toBeVisible();
  expect(await releases(page)).toBe(0);
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
});

for (const [status, expected] of [['not-observed', /absence is not permission/], ['not-started', /This exact launch did not start/], ['unavailable', /correlation is unavailable/], ['recovery-required', /correlation requires recovery or support/]]) test(`uncertain launch renders closed ${status} meaning without claiming release`, async ({ page }) => {
  await review(page);
  await page.evaluate(status => { const s = window.launchTest; s.mode = 'structured'; s.reconciliation = { status, planId: s.planId, planFingerprint: s.fingerprint, ...(status === 'unavailable' ? { reason: 'legacy-correlation-unavailable' } : status === 'recovery-required' ? { reason: 'invalid-durable-evidence' } : {}) }; }, status);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByText(expected)).toBeVisible();
  expect(await starts(page)).toBe(1); expect(await releases(page)).toBe(0);
});

test('expired pagination requests a fresh snapshot and discovery limits never auto-loop', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T00:00:01Z'));
  await page.evaluate(() => { const s = window.launchTest; s.nextCursor = 'launch-cursor-v1-22222222-2222-4222-8222-222222222222'; });
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.clock.runFor(120000);
  await page.evaluate(() => { const s = window.launchTest; s.nextCursor = null; s.listError = { code: 'LAUNCH_CURSOR_EXPIRED', message: 'The setup list expired. Refresh it to continue.', retryable: true }; s.listErrorOnce = true; });
  await page.getByRole('button', { name: 'Load more previous setups' }).click();
  await expect(page.getByText(/fresh snapshot/)).toBeVisible();
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:list-new-server-launches').map(value => value.request))).toEqual([{ limit: 50 }, { limit: 50, cursor: 'launch-cursor-v1-22222222-2222-4222-8222-222222222222' }, { limit: 50 }]);
  await page.evaluate(() => { const s = window.launchTest; s.listErrorOnce = false; s.listError = { code: 'LAUNCH_LIST_LIMIT_EXCEEDED', message: 'Too many setups are available to list. Use an exact setup reference.', retryable: false }; });
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await expect(page.getByText(/list is not complete/)).toBeVisible();
  await page.clock.runFor(120000);
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:list-new-server-launches').length)).toBe(4);
});

for (const malformed of ['items-object', 'extra-top-level', 'private-summary']) test(`bounded malformed launch list is rejected without adoption: ${malformed}`, async ({ page }) => {
  await page.evaluate(malformed => {
    const s = window.launchTest;
    const item = { planId: s.planId, planFingerprint: s.fingerprint, status: 'pending', createdAt: s.job.createdAt };
    s.listOverride = malformed === 'items-object' ? { items: {}, nextCursor: null } : malformed === 'extra-top-level' ?
      { items: [item], nextCursor: null, snapshot: 'private' } : { items: [{ ...item, recordRevision: 1 }], nextCursor: null };
  }, malformed);
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await expect(page.getByText(/could not be listed safely/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Unresolved setup/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toHaveCount(0);
  expect(await starts(page)).toBe(0); expect(await releases(page)).toBe(0);
});

test('bounded launch discovery capacity reports retry guidance without an automatic loop', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T00:00:01Z'));
  await page.evaluate(() => { window.launchTest.listError = { code: 'LAUNCH_DISCOVERY_CAPACITY', message: 'Discovery is at capacity.', retryable: true }; });
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await expect(page.getByText(/discovery is at capacity/)).toBeVisible();
  await page.clock.runFor(120000);
  expect(await page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:list-new-server-launches').length)).toBe(1);
  expect(await starts(page)).toBe(0); expect(await releases(page)).toBe(0);
});

test('files-only new-server review reconciles its exact public kind and completes once', async ({ page }) => {
  await page.evaluate(() => { const s = window.launchTest; s.inspectionClassification = { kind: 'files-only' }; s.job = { ...s.job, operationKind: 'import-files-only-new', phase: 'completed', sequence: 5, terminalAt: s.job.createdAt, outcome: { status: 'completed', kind: 'files-only' } }; s.mode = 'transport'; s.reconciliation = { ...s.reconciliation, job: s.job, settlement: { status: 'settled', destinationDisposition: 'consumed', recoveryAvailable: false } }; });
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('button', { name: 'Import reviewed data as files-only' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect.poll(() => page.evaluate(() => window.launchTest.completions.length)).toBe(1);
  expect(await page.evaluate(() => window.launchTest.requests.find(value => value.channel === 'modpacks:preflight').request.operationKind)).toBe('import-files-only-new');
  expect(await page.evaluate(() => window.launchTest.requests.find(value => value.channel === 'modpacks:preflight').request.selections)).toMatchObject({ maxRam: null, serverPort: null, networkAccess: null, runtimeChoice: null });
  expect(await starts(page)).toBe(1); expect(await releases(page)).toBe(0);
});

test('reverse candidate hydration selects only the explicit latest identity', async ({ page }) => {
  await page.evaluate(() => {
    const s = window.launchTest;
    const base = { status: 'started', createdAt: s.job.createdAt, operationKind: 'install-new', settlement: s.reconciliation.settlement };
    s.items = [{ ...base, planId: s.planId, planFingerprint: s.fingerprint, serverId: s.job.serverId, jobId: s.job.jobId, displayName: 'Candidate A' },
      { ...base, planId: 'plan-candidate-b', planFingerprint: 'b'.repeat(64), serverId: 'pending-b', jobId: 'job-b', displayName: 'Candidate B' }];
    s.defer = 'modpacks:get-job';
  });
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.getByRole('button', { name: /Candidate A/ }).click();
  await expect.poll(() => page.evaluate(() => window.launchTest.pending.length)).toBe(1);
  await page.evaluate(() => {
    const s = window.launchTest;
    s.jobA = { ...s.job, sequence: 5, phase: 'completed', terminalAt: s.job.createdAt, outcome: { status: 'completed', kind: 'completed' } };
    s.job = { ...s.jobA, serverId: 'pending-b', jobId: 'job-b', planFingerprint: 'b'.repeat(64) };
    s.reconciliation = { ...s.reconciliation, planId: 'plan-candidate-b', planFingerprint: 'b'.repeat(64), job: s.job };
  });
  await page.getByRole('button', { name: /Candidate B/ }).click();
  await expect.poll(() => page.evaluate(() => window.launchTest.pending.length)).toBe(2);
  await page.evaluate(() => { const s = window.launchTest; s.defer = ''; s.pending[1].resolve(s.job); s.pending[0].resolve(s.jobA); });
  await expect.poll(() => page.evaluate(() => window.launchTest.completions)).toEqual([{ instanceId: 'pending-b', modpackJobId: 'job-b', source: 'Candidate B' }]);
  expect(await starts(page)).toBe(0); expect(await releases(page)).toBe(0);
});

test('reselecting the same completed launch cannot emit completion twice', async ({ page }) => {
  await review(page);
  await page.evaluate(() => { const s = window.launchTest; s.job = { ...s.job, sequence: 5, phase: 'completed', terminalAt: s.job.createdAt, outcome: { status: 'completed', kind: 'completed' } }; });
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect.poll(() => page.evaluate(() => window.launchTest.completions.length)).toBe(1);
  await page.getByRole('button', { name: 'Return to server' }).click();
  await page.evaluate(() => { const s = window.launchTest; s.items = [{ planId: s.planId, planFingerprint: s.fingerprint, status: 'started', createdAt: s.job.createdAt, serverId: s.job.serverId, operationKind: s.job.operationKind, jobId: s.job.jobId, displayName: 'Same completed setup', settlement: { status: 'settled', destinationDisposition: 'consumed', recoveryAvailable: false } }]; s.reconciliation = { ...s.reconciliation, job: s.job, settlement: s.items[0].settlement }; });
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.getByRole('button', { name: /Same completed setup/ }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  expect(await page.evaluate(() => window.launchTest.completions.length)).toBe(1);
});

test('unknown Start recovered through explicit selection completes only once across later reselection', async ({ page }) => {
  await review(page);
  await page.evaluate(() => { const s = window.launchTest; s.mode = 'transport'; s.reconciliation = { status: 'pending', planId: s.planId, planFingerprint: s.fingerprint }; });
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await page.evaluate(() => {
    const s = window.launchTest;
    s.job = { ...s.job, sequence: 5, phase: 'completed', terminalAt: s.job.createdAt, outcome: { status: 'completed', kind: 'completed' } };
    s.items = [{ planId: s.planId, planFingerprint: s.fingerprint, status: 'started', createdAt: s.job.createdAt, serverId: s.job.serverId, operationKind: s.job.operationKind, jobId: s.job.jobId, displayName: 'Recovered completed setup', settlement: { status: 'settled', destinationDisposition: 'consumed', recoveryAvailable: false } }];
    s.reconciliation = { status: 'started', planId: s.planId, planFingerprint: s.fingerprint, job: s.job, settlement: s.items[0].settlement };
  });
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.getByRole('button', { name: /Recovered completed setup/ }).click();
  await expect.poll(() => page.evaluate(() => window.launchTest.completions.length)).toBe(1);
  await page.getByRole('button', { name: 'Return to server' }).click();
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.getByRole('button', { name: /Recovered completed setup/ }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  expect(await page.evaluate(() => window.launchTest.completions.length)).toBe(1);
  expect(await starts(page)).toBe(1); expect(await releases(page)).toBe(0);
});

test('settlement UI evidence is meaningful at desktop and narrow widths without console errors', async ({ page }) => {
  await review(page);
  await page.evaluate(() => { const s = window.launchTest; s.mode = 'transport'; s.job = { ...s.job, phase: 'failed', sequence: 5, terminalAt: s.job.createdAt, outcome: { status: 'failed', kind: 'nothing-changed' } }; s.reconciliation = { ...s.reconciliation, job: s.job, settlement: { status: 'support-required', reason: 'conflicting-evidence', destinationDisposition: 'released', recoveryAvailable: false } }; });
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.getByText(/Support is required/)).toBeVisible();
  await expect(page).toHaveTitle('Launch reconciliation fixture');
  expect(page.url()).toBe('about:blank');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const screenshot = path.join(os.tmpdir(), `minecraft-launch-support-${Date.now()}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  test.info().annotations.push({ type: 'visual-evidence', description: screenshot });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
