// New-server setup wizard: launch outcomes after Start (R4, R5, R12, R13, R14), the C7 amendments, and how the
// review reports its own destination and preflight outcome. Real ServerSetupWizard and ArchiveGuidedReview
// components; the bridge models a destination reservation table, one plan per preflight and deferrable channels.
import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let bundle;
let componentCss = '';

test.beforeAll(async () => {
  const styles = [];
  const fixture = `<script>
    import Setup from './src/components/setup/ServerSetupWizard.svelte';
    let visible = true;
    export function show(value) { visible = value; }
  </script>{#if visible}<Setup on:setup-complete={event => window.launchTest.completions.push(event.detail)} />{/if}`;
  const result = await build({
    absWorkingDir: ROOT, stdin: { resolveDir: ROOT, contents: `import Fixture from 'launch-fixture'; import { mount, flushSync } from 'svelte';
      const fixture = mount(Fixture, { target: document.querySelector('#fixture') });
      window.launchFixture = { show: value => flushSync(() => fixture.show(value)) };` },
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
  await page.setContent('<!doctype html><title>Launch outcomes fixture</title><main id="fixture"></main>');
  await page.addStyleTag({ content: `body { background: #17191d; color: #eee; font-family: system-ui; } #fixture { max-width: 1040px; margin: 24px auto; } ${componentCss}` });
  await page.evaluate(() => {
    const hex = n => n.toString(16).padStart(12, '0');
    const s = window.launchTest = {
      requests: [], completions: [], callbacks: {}, deferred: [], defer: new Set(), statusByPlan: {},
      mode: 'structured', reconcileStatus: 'not-started', reconcileReason: undefined,
      reservations: new Map(), reserveCount: 0, pickPath: 'C:\\QA\\Pack', releaseResult: true, releaseError: null,
      reserveErrors: [], preflightErrors: [], inspections: 0, plans: [], items: [],
      flush(channel) {
        const index = s.deferred.findIndex(item => item.channel === channel);
        if (index < 0) throw new Error('nothing deferred on ' + channel);
        const [item] = s.deferred.splice(index, 1);
        s.defer.delete(channel);
        item.run();
      }
    };
    const job = plan => ({ type: 'minecraft-core-modpack-job', schemaVersion: 1, sequence: s.jobPhase ? 5 : 1, jobId: 'launch-job', serverId: plan.serverId,
      operationKind: 'install-new', planFingerprint: plan.planFingerprint, phase: s.jobPhase || 'queued', swapStep: 'none', progress: null,
      cancellationRequested: false, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z',
      terminalAt: s.jobPhase ? '2026-10-11T00:00:00.000Z' : null, outcome: s.jobPhase ? { status: s.jobPhase, kind: s.jobPhase === 'completed' ? 'completed' : 'nothing-changed', actions: [] } : null, events: [] });
    const compute = (channel, request) => {
      if (channel === 'modpacks:select-local-archive') return { ok: true, value: { selectionId: 'local-selection', displayName: 'Captured pack' } };
      if (channel === 'modpacks:inspect') return { ok: true, value: { inspectionId: 'inspection-' + (++s.inspections), classification: { kind: 'server-pack', runtime: { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.0' } }, rootCandidates: [], entries: [] } };
      if (channel === 'modpacks:reserve-server-destination') {
        if (s.reserveErrors.length) return { ok: false, error: s.reserveErrors.shift() };
        if (s.pickCancel) return { ok: true, value: null };
        if ([...s.reservations.values()].includes(s.pickPath)) return { ok: false, error: { code: 'TARGET_EXISTS', message: 'The selected server destination is already reserved' } };
        const n = ++s.reserveCount; s.reservations.set('dest-' + n, s.pickPath);
        return { ok: true, value: { instanceId: 'dest-' + n, displayName: 'Destination ' + n } };
      }
      if (channel === 'modpacks:release-server-destination') {
        if (s.releaseError) return { ok: false, error: s.releaseError };
        const released = s.releaseResult !== false && s.reservations.delete(request.instanceId);
        return { ok: true, value: released };
      }
      if (channel === 'modpacks:preflight') {
        if (s.preflightErrors.length) return { ok: false, error: s.preflightErrors.shift() };
        const n = s.plans.length + 1;
        const plan = { planId: 'plan-launch-v1-0000000' + n + '-0000-4000-8000-' + hex(n), planFingerprint: String(n % 10).repeat(64), serverId: request.instanceId };
        s.plans.push(plan);
        return { ok: true, value: { planId: plan.planId, planFingerprint: plan.planFingerprint, planView: { operationKind: request.operationKind, server: { id: request.instanceId }, title: 'Reviewed plan ' + n, blockers: [] } } };
      }
      if (channel === 'modpacks:start-operation') {
        const plan = s.plans.find(item => item.planId === request.planId);
        if (s.mode === 'transport') throw new Error('Dropped response');
        if (s.mode === 'structured') return { ok: false, error: { code: 'PLAN_STALE', message: 'The reserved server destination is no longer available' } };
        return { ok: true, value: job(plan) };
      }
      if (channel === 'modpacks:reconcile-new-server-launch') {
        const plan = s.plans.find(item => item.planId === request.planId) || { serverId: 'dest-x', planFingerprint: request.planFingerprint };
        const status = s.statusByPlan[request.planId] || s.reconcileStatus;
        const value = { status, planId: request.planId, planFingerprint: request.planFingerprint };
        if (status === 'pending' && s.reconcileReason) value.reason = s.reconcileReason;
        if (status === 'recovery-required') value.reason = 'invalid-durable-evidence';
        if (status === 'unavailable') value.reason = 'legacy-correlation-unavailable';
        if (status === 'started') Object.assign(value, { job: job(plan), settlement: s.settlement || { status: 'active', destinationDisposition: 'held', recoveryAvailable: false } });
        return { ok: true, value };
      }
      if (channel === 'modpacks:list-new-server-launches') return { ok: true, value: { items: s.items, nextCursor: null } };
      if (channel === 'modpacks:get-job') { const plan = s.plans.find(item => item.planId === s.lastStartedPlan) || s.plans.at(-1); return { ok: true, value: job(plan) }; }
      if (channel === 'modpacks:list-recovery') return { ok: true, value: { items: [] } };
      if (channel === 'modpacks:cancel-inspection') return { ok: true, value: true };
      throw new Error('Unexpected IPC: ' + channel);
    };
    window.electron = { on(channel, callback) { (s.callbacks[channel] ||= []).push(callback); }, removeListener() {}, removeAllListeners() {},
      async invoke(channel, request) {
        s.requests.push({ channel, request });
        if (s.defer.has(channel)) return new Promise((resolve, reject) => s.deferred.push({ channel, request, run: () => { try { resolve(compute(channel, request)); } catch (error) { reject(error); } } }));
        return compute(channel, request);
      } };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  page.outcomeErrors = errors;
  await page.addScriptTag({ content: bundle });
});
test.afterEach(async ({ page }) => { expect(page.outcomeErrors).toEqual([]); });

const calls = (page, channel) => page.evaluate(channel => window.launchTest.requests.filter(value => value.channel === channel).length, channel);
const starts = page => calls(page, 'modpacks:start-operation');
const released = page => page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:release-server-destination').map(value => value.request.instanceId));
const reconciledPlans = page => page.evaluate(() => window.launchTest.requests.filter(value => value.channel === 'modpacks:reconcile-new-server-launch').map(value => value.request.planId));
const set = (page, values) => page.evaluate(values => Object.assign(window.launchTest, values), values);
const defer = (page, channel) => page.evaluate(channel => window.launchTest.defer.add(channel), channel);
const flush = (page, channel) => page.evaluate(channel => window.launchTest.flush(channel), channel);
const deferredCount = page => page.evaluate(() => window.launchTest.deferred.length);
const followsReviewButton = (page, selector) => page.evaluate(selector => {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Choose destination and review plan');
  const target = document.querySelector(selector);
  return Boolean(button && target && (button.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING));
}, selector);
const NOT_STARTED = /This exact launch did not start/;
const FIRST_PLAN = 'plan-launch-v1-00000001-0000-4000-8000-000000000001';
const DISCOVERED_PLAN = 'plan-launch-v1-00000009-0000-4000-8000-000000000009';

async function openLocalReview(page) {
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await expect(page.getByRole('button', { name: 'Choose destination and review plan' })).toBeEnabled();
}

async function review(page) {
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
}

async function startWith(page, reconcileStatus, mode = 'structured') {
  await set(page, { mode, reconcileStatus });
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
}

async function expectFreshReview(page) {
  await expect(page.locator('[data-launch-start]')).toHaveText('Fresh review required');
  await expect(page.locator('[data-launch-start]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Run a fresh preflight review' })).toBeEnabled();
}

async function expectSourceWorks(page, inspections) {
  await page.getByRole('button', { name: /Local archive/ }).click();
  await expect(page.getByRole('button', { name: 'Choose destination and review plan' })).toBeVisible();
  expect(await calls(page, 'modpacks:inspect')).toBe(inspections);
}

async function selectDiscoveredLaunch(page) {
  await page.locator('summary').filter({ hasText: 'Previous server setups' }).click();
  await page.getByRole('button', { name: 'Refresh previous setups' }).click();
  await page.getByRole('button', { name: /Unresolved setup/ }).click();
}

// ---------------- R4: a settled not-started destination is released and never shown again ----------------
for (const exit of ['Run a fresh preflight review', 'Choose another asset']) test(`R4 ${exit} after not-started releases the abandoned reservation and shows no stale destination`, async ({ page }) => {
  await review(page);
  await startWith(page, 'not-started');
  await expectFreshReview(page);
  await expect(page.getByText('Chosen destination:')).toBeVisible(); // accurate for its own review
  await page.getByRole('button', { name: exit }).click();
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  await expect.poll(() => released(page)).toEqual(['dest-1']);
  await expectSourceWorks(page, 2);
  await expect(page.locator('body')).not.toContainText('Chosen destination');
  await defer(page, 'modpacks:reserve-server-destination');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.getByRole('button', { name: 'Waiting for destination…' })).toBeVisible();
  await expect(page.getByText('Choose the server destination')).toBeVisible();
  await flush(page, 'modpacks:reserve-server-destination'); // same folder: free again
  await expect(page.getByRole('heading', { name: 'Reviewed plan 2' })).toBeVisible();
  await expect(page.locator('body')).toContainText('Chosen destination: Destination 2');
  await expect(page.locator('body')).not.toContainText('Destination 1');
  expect(await starts(page)).toBe(1);
});

test('R4 a refused release still detaches the stale record; the backend keeps refusing only that folder', async ({ page }) => {
  await review(page);
  await set(page, { releaseResult: false });
  await startWith(page, 'not-started');
  await expectFreshReview(page);
  await page.getByRole('button', { name: 'Run a fresh preflight review' }).click();
  await expect.poll(() => released(page)).toEqual(['dest-1']);
  await expectSourceWorks(page, 2);
  await expect(page.locator('body')).not.toContainText('Chosen destination');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.getByText('The selected server destination is already reserved')).toBeVisible();
  await set(page, { pickPath: 'C:\\QA\\Other' });
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.locator('body')).toContainText('Chosen destination: Destination 2');
  expect(await starts(page)).toBe(1);
});

test('R4 a failing release IPC never blocks the fresh review after not-started', async ({ page }) => {
  await review(page);
  await set(page, { releaseError: { code: 'COMMIT_FAILED', message: 'Release transport failed' } });
  await startWith(page, 'not-started');
  await expectFreshReview(page);
  await page.getByRole('button', { name: 'Run a fresh preflight review' }).click();
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  await expect.poll(() => released(page)).toEqual(['dest-1']);
  await expect(page.getByText('Release transport failed')).toHaveCount(0);
  await expectSourceWorks(page, 2);
  await expect(page.locator('body')).not.toContainText('Chosen destination');
  expect(await starts(page)).toBe(1);
});

// ---------------- R5: the wizard's own not-observed Start was not admitted ----------------
test('R5 not-observed after a settled Start offers a fresh review instead of a permanent Checking state', async ({ page }) => {
  await review(page);
  await startWith(page, 'not-observed');
  await expectFreshReview(page);
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await expect(page.getByRole('button', { name: /Checking Start outcome/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Run a fresh preflight review' }).click();
  await expect.poll(() => released(page)).toEqual(['dest-1']);
  await expectSourceWorks(page, 2);
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
  await expect(page.getByRole('button', { name: 'Install this exact reviewed plan' })).toBeEnabled();
  expect(await starts(page)).toBe(1);
});

test('R5 not-observed then Choose another asset leaves sources usable', async ({ page }) => {
  await review(page);
  await startWith(page, 'not-observed');
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await expectSourceWorks(page, 2);
});

test('R5 a discovered setup that reads not-observed does not lock new setups', async ({ page }) => {
  await set(page, { reconcileStatus: 'not-observed', items: [{ planId: DISCOVERED_PLAN, planFingerprint: '9'.repeat(64), status: 'pending', createdAt: '2026-10-11T00:00:00.000Z' }] });
  await selectDiscoveredLaunch(page);
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await expectSourceWorks(page, 1);
  expect(await starts(page)).toBe(0); expect(await released(page)).toEqual([]);
});

// ---------------- R12: not-started is monotonic ----------------
test('R12 a later pending re-check cannot demote not-started or start a retry loop', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T00:00:01Z'));
  await review(page);
  await startWith(page, 'not-started');
  await expectFreshReview(page);
  await set(page, { reconcileStatus: 'pending' });
  await page.getByRole('button', { name: 'Check exact launch status' }).click();
  await expect.poll(() => calls(page, 'modpacks:reconcile-new-server-launch')).toBe(2);
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await expect(page.getByText(/may already have started/)).toHaveCount(0);
  await page.clock.runFor(6000);
  expect(await calls(page, 'modpacks:reconcile-new-server-launch')).toBe(2);
  await page.getByRole('button', { name: 'Run a fresh preflight review' }).click();
  await expectSourceWorks(page, 2);
});

test('R12 refreshing while a re-check is in flight never lets a late pending lock the wizard', async ({ page }) => {
  await review(page);
  await startWith(page, 'not-started');
  await expectFreshReview(page);
  await defer(page, 'modpacks:reconcile-new-server-launch');
  await page.getByRole('button', { name: 'Check exact launch status' }).click();
  await expect.poll(() => deferredCount(page)).toBe(1);
  await page.getByRole('button', { name: 'Run a fresh preflight review' }).click();
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  await set(page, { reconcileStatus: 'pending' });
  await flush(page, 'modpacks:reconcile-new-server-launch');
  await expectSourceWorks(page, 2);
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
  await expect(page.getByRole('button', { name: 'Install this exact reviewed plan' })).toBeEnabled();
  expect(await starts(page)).toBe(1);
});

test('R12 re-selecting a not-started launch through discovery stays not-started on an unstable read', async ({ page }) => {
  await review(page);
  await startWith(page, 'not-started');
  await expectFreshReview(page);
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await page.evaluate(() => { const s = window.launchTest; const plan = s.plans[0];
    s.items = [{ planId: plan.planId, planFingerprint: plan.planFingerprint, status: 'pending', createdAt: '2026-10-11T00:00:00.000Z' }]; s.reconcileStatus = 'pending'; });
  await selectDiscoveredLaunch(page);
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await expect(page.getByText(/may already have started|checking the explicitly selected/)).toHaveCount(0);
  await expectSourceWorks(page, 2);
});

test('R12 re-selecting a not-started launch keeps new setups unlocked while its read is stalled', async ({ page }) => {
  await review(page);
  await startWith(page, 'not-started');
  await expectFreshReview(page);
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await page.evaluate(() => { const s = window.launchTest; const plan = s.plans[0];
    s.items = [{ planId: plan.planId, planFingerprint: plan.planFingerprint, status: 'pending', createdAt: '2026-10-11T00:00:00.000Z' }]; });
  await defer(page, 'modpacks:reconcile-new-server-launch');
  await selectDiscoveredLaunch(page);
  await expect.poll(() => deferredCount(page)).toBe(1);
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await expect(page.getByText(/may already have started|checking the explicitly selected/)).toHaveCount(0);
  await expectSourceWorks(page, 2);
  await set(page, { reconcileStatus: 'pending' });
  await flush(page, 'modpacks:reconcile-new-server-launch');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
  await expect(page.getByRole('button', { name: 'Install this exact reviewed plan' })).toBeEnabled();
  expect(await starts(page)).toBe(1);
  expect(await released(page)).toEqual(['dest-1']);
});

// ---------------- R13: notices belong to the launch they describe ----------------
test('R13 Choose another asset clears the not-started notice for the next review', async ({ page }) => {
  await review(page);
  await startWith(page, 'not-started');
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  await expect(page.getByText(NOT_STARTED)).toHaveCount(0);
  await expectSourceWorks(page, 2);
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
  await expect(page.getByRole('button', { name: 'Install this exact reviewed plan' })).toBeEnabled();
  await expect(page.getByText(NOT_STARTED)).toHaveCount(0);
});

test('R13 a discovered not-started notice does not follow the user into a new setup', async ({ page }) => {
  await set(page, { reconcileStatus: 'not-started', items: [{ planId: DISCOVERED_PLAN, planFingerprint: '9'.repeat(64), status: 'pending', createdAt: '2026-10-11T00:00:00.000Z' }] });
  await selectDiscoveredLaunch(page);
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await page.getByRole('button', { name: /Install Modpack/ }).click();
  await expectSourceWorks(page, 1);
  await expect(page.getByText(NOT_STARTED)).toHaveCount(0);
});

test('R13 the settlement warning does not follow the user after Return', async ({ page }) => {
  await review(page);
  await set(page, { jobPhase: 'completed', settlement: { status: 'repair-pending', reason: 'settlement-repair-required', destinationDisposition: 'held', recoveryAvailable: false } });
  await startWith(page, 'started', 'transport');
  await expect(page.getByText(/Settlement repair is pending/)).toBeVisible();
  await page.getByRole('button', { name: 'Return to server' }).click();
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  await expect(page.getByText(/Settlement repair is pending/)).toHaveCount(0);
});

// ---------------- R14: the status check keeps focus ----------------
test('R14 Check exact launch status keeps keyboard focus during and after the read, and reports the check', async ({ page }) => {
  await review(page);
  await startWith(page, 'not-started');
  await expectFreshReview(page);
  const check = page.getByRole('button', { name: 'Check exact launch status' });
  await check.focus();
  await defer(page, 'modpacks:reconcile-new-server-launch');
  await page.keyboard.press('Enter');
  await expect.poll(() => deferredCount(page)).toBe(1);
  await expect(check).toHaveCount(1);
  await expect(check).toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Check exact launch status');
  await flush(page, 'modpacks:reconcile-new-server-launch');
  await expect(check).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Check exact launch status');
  await expect(page.getByText('Exact launch status checked.')).toBeAttached();
});

test('R14 automatic pending retries do not steal focus from the status button', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-11T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-11T00:00:01Z'));
  await review(page);
  await startWith(page, 'pending', 'transport');
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  const check = page.getByRole('button', { name: 'Check exact launch status' });
  await check.focus();
  for (let cycle = 2; cycle <= 4; cycle += 1) {
    await page.clock.runFor(1200);
    await expect.poll(() => calls(page, 'modpacks:reconcile-new-server-launch')).toBe(cycle);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Check exact launch status');
  }
  expect(await released(page)).toEqual([]);
});

test('R14 the protected-launch status button keeps focus when its check starts a fresh exact read', async ({ page }) => {
  await review(page);
  await startWith(page, 'pending', 'transport');
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  const check = page.getByRole('button', { name: 'Check exact launch status' });
  await check.focus();
  await defer(page, 'modpacks:reconcile-new-server-launch');
  await page.keyboard.press('Enter');
  await expect.poll(() => deferredCount(page)).toBe(1);
  await expect(check).toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Check exact launch status');
  await flush(page, 'modpacks:reconcile-new-server-launch');
  await expect(check).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Check exact launch status');
  expect(await released(page)).toEqual([]);
});

// ---------------- A protected launch never strands the wizard, and never weakens fail-closed ----------------
test('protected launch: unknown Start then Choose another asset keeps the lock, explains it and offers an exact re-check that unlocks', async ({ page }) => {
  await review(page);
  await startWith(page, 'pending', 'transport');
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  await expect(page.getByText(/New modpack setups wait until its exact status is known/)).toBeVisible();
  await page.getByRole('button', { name: /Local archive/ }).click();
  expect(await calls(page, 'modpacks:inspect')).toBe(1); // still fail-closed while unknown
  expect(await released(page)).toEqual([]);
  await set(page, { reconcileStatus: 'not-started' });
  await page.getByRole('button', { name: 'Check exact launch status' }).click();
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await expect.poll(() => released(page)).toEqual(['dest-1']);
  await expectSourceWorks(page, 2);
  await expect(page.getByText(NOT_STARTED)).toHaveCount(0);
  expect(await starts(page)).toBe(1);
});

test('protected launch: a re-check after navigation adopts the exact started job without another Start', async ({ page }) => {
  await review(page);
  await startWith(page, 'pending', 'transport');
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await set(page, { reconcileStatus: 'started' });
  await page.getByRole('button', { name: 'Check exact launch status' }).click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
  expect(await starts(page)).toBe(1); expect(await released(page)).toEqual([]);
});

test('protected launch: its notice and exact re-check stay while another discovered launch is selected', async ({ page }) => {
  await review(page);
  await startWith(page, 'pending', 'transport');
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await page.evaluate(plan => { const s = window.launchTest; s.statusByPlan[plan] = 'not-started';
    s.items = [{ planId: plan, planFingerprint: '9'.repeat(64), status: 'pending', createdAt: '2026-10-11T00:00:00.000Z' }]; }, DISCOVERED_PLAN);
  await selectDiscoveredLaunch(page);
  await expect.poll(async () => (await reconciledPlans(page)).at(-1)).toBe(DISCOVERED_PLAN);
  await expect(page.getByText(/New modpack setups wait until its exact status is known/)).toBeVisible();
  await page.getByRole('button', { name: /Local archive/ }).click();
  expect(await calls(page, 'modpacks:inspect')).toBe(1); // launch A still protects its destination
  const reads = (await reconciledPlans(page)).length;
  await page.getByRole('button', { name: 'Check exact launch status' }).click();
  await expect.poll(async () => (await reconciledPlans(page)).length).toBeGreaterThan(reads);
  expect((await reconciledPlans(page)).at(-1)).toBe(FIRST_PLAN);
  await set(page, { reconcileStatus: 'not-started' });
  await page.getByRole('button', { name: 'Check exact launch status' }).click();
  await expect(page.getByText(NOT_STARTED)).toBeVisible();
  await expect.poll(() => released(page)).toEqual(['dest-1']);
  await expectSourceWorks(page, 2);
});

test('protected launch: the v26.6.1 custom setup shows no launch status and stays mounted when a re-check finds the launch started', async ({ page }) => {
  await review(page);
  await startWith(page, 'pending', 'transport');
  await expect(page.getByText(/Start outcome is unknown/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await defer(page, 'modpacks:reconcile-new-server-launch');
  await page.getByRole('button', { name: 'Check exact launch status' }).click();
  await expect.poll(() => deferredCount(page)).toBe(1);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: /Empty\/Custom Server/ }).click();
  await expect(page.getByText('Select a folder to set up Minecraft Core')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check exact launch status' })).toHaveCount(0);
  await expect(page.getByText(/Start outcome is unknown/)).toHaveCount(0);
  await set(page, { reconcileStatus: 'started' });
  await flush(page, 'modpacks:reconcile-new-server-launch');
  await expect(page.getByText('Select a folder to set up Minecraft Core')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toHaveCount(0);
  expect(await calls(page, 'modpacks:get-job')).toBe(0);
  // The late read still settled ownership: the adopted launch no longer holds new setups back.
  await page.getByRole('button', { name: 'Back to setup method' }).click();
  await expect(page.getByRole('heading', { name: 'How do you want to set it up?' })).toBeVisible();
  await expect(page.getByText(/New modpack setups wait until its exact status is known/)).toHaveCount(0);
  expect(await starts(page)).toBe(1); expect(await released(page)).toEqual([]);
});

for (const status of ['pending', 'recovery-required', 'unavailable']) test(`protected launch: fail-closed ${status} never releases or unlocks`, async ({ page }) => {
  await review(page);
  await startWith(page, status);
  await expect(page.getByText(/Start outcome is unknown|correlation/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Checking Start outcome/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await page.getByRole('button', { name: /Local archive/ }).click();
  expect(await calls(page, 'modpacks:inspect')).toBe(1);
  expect(await released(page)).toEqual([]);
});

test('protected launch: a destroyed wizard whose late Start reads not-started releases only that reservation', async ({ page }) => {
  await review(page);
  await set(page, { mode: 'structured', reconcileStatus: 'not-started' });
  await defer(page, 'modpacks:start-operation');
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect.poll(() => deferredCount(page)).toBe(1);
  await page.evaluate(() => window.launchFixture.show(false));
  expect(await released(page)).toEqual([]); // launch-pending is never released by cleanup
  await flush(page, 'modpacks:start-operation');
  await expect.poll(() => released(page)).toEqual(['dest-1']);
  expect(await starts(page)).toBe(1);
  expect(await page.evaluate(() => window.launchTest.completions)).toEqual([]);
});

// ---------------- The review reports its own destination and preflight outcome next to its button ----------------
test('review action: a failed preflight is shown next to its button, focused and announced', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await openLocalReview(page);
  await set(page, { preflightErrors: [{ code: 'INVALID_REQUEST', message: 'GitHub asset pattern is invalid' }] });
  const reviewButton = page.getByRole('button', { name: 'Choose destination and review plan' });
  await reviewButton.click();
  const failure = page.getByRole('alert').filter({ hasText: 'GitHub asset pattern is invalid' });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('Review could not continue');
  await expect(failure).toBeFocused();
  await expect(failure).toBeInViewport();
  expect(await followsReviewButton(page, '[role="alert"]')).toBe(true);
  await expect(page.getByText('GitHub asset pattern is invalid')).toHaveCount(1);
  await expect(reviewButton).toBeEnabled();
  await reviewButton.click();
  await expect(page.getByRole('heading', { name: 'Reviewed plan 1' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await calls(page, 'modpacks:reserve-server-destination')).toBe(1);
  expect(await calls(page, 'modpacks:preflight')).toBe(2);
});

test('review action: a stale preflight offers the fresh review next to its button', async ({ page }) => {
  await openLocalReview(page);
  await set(page, { preflightErrors: [{ code: 'PLAN_STALE', message: 'The archive inspection expired' }] });
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  const failure = page.getByRole('alert').filter({ hasText: 'The archive inspection expired' });
  await expect(failure).toBeFocused();
  expect(await followsReviewButton(page, '[role="alert"]')).toBe(true);
  await expect(page.getByRole('button', { name: 'Choose destination and review plan' })).toBeDisabled();
  await failure.getByRole('button', { name: 'Run a fresh preflight review' }).click();
  await expect(page.getByRole('button', { name: /Local archive/ })).toBeVisible();
  await expect.poll(() => released(page)).toEqual(['dest-1']);
  await expectSourceWorks(page, 2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Chosen destination');
});

test('review action: a destination the picker cannot reserve is reported next to its button', async ({ page }) => {
  await openLocalReview(page);
  await set(page, { reserveErrors: [{ code: 'TARGET_EXISTS', message: 'The selected server destination is not empty and is not a managed modpack server' }] });
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  const failure = page.getByRole('alert').filter({ hasText: 'is not empty' });
  await expect(failure).toBeFocused();
  expect(await followsReviewButton(page, '[role="alert"]')).toBe(true);
  await expect(page.locator('body')).not.toContainText('Chosen destination');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.getByRole('heading', { name: 'Reviewed plan 1' })).toBeVisible();
  await expect(page.locator('body')).toContainText('Chosen destination: Destination 1');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('review action: a cancelled destination pick is explained next to its button', async ({ page }) => {
  await openLocalReview(page);
  await set(page, { pickCancel: true });
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.getByText('No destination was selected. Choose a folder to continue.', { exact: true })).toBeVisible();
  expect(await followsReviewButton(page, '.destination-notice')).toBe(true);
  await expect(page.getByRole('button', { name: 'Choose destination and review plan' })).toBeEnabled();
  expect(await calls(page, 'modpacks:preflight')).toBe(0);
});

test('review action: a successful pick starts the review at once and shows its progress', async ({ page }) => {
  await openLocalReview(page);
  await defer(page, 'modpacks:reserve-server-destination');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.getByRole('button', { name: 'Waiting for destination…' })).toBeDisabled();
  await expect(page.getByText('Choose the server destination')).toBeVisible();
  await defer(page, 'modpacks:preflight');
  await flush(page, 'modpacks:reserve-server-destination');
  await expect(page.getByText('Preparing review')).toBeVisible();
  await expect(page.getByText('Validating the selected destination', { exact: true })).toBeVisible();
  await expect(page.locator('body')).toContainText('Chosen destination: Destination 1');
  expect(await calls(page, 'modpacks:preflight')).toBe(1);
  await flush(page, 'modpacks:preflight');
  await expect(page.getByRole('heading', { name: 'Reviewed plan 1' })).toBeVisible();
  expect(await calls(page, 'modpacks:reserve-server-destination')).toBe(1);
});

test('review action: a pick made while the previous reservation is still being released shows the picker and starts the review', async ({ page }) => {
  await review(page);
  await defer(page, 'modpacks:release-server-destination');
  await page.getByRole('button', { name: 'Choose another asset' }).click();
  await expect.poll(() => released(page)).toEqual(['dest-1']);
  await page.getByRole('button', { name: /Local archive/ }).click();
  await defer(page, 'modpacks:reserve-server-destination');
  await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
  await expect(page.getByRole('button', { name: 'Waiting for destination…' })).toBeDisabled();
  await expect(page.getByText('Choose the server destination')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Chosen destination');
  await set(page, { pickPath: 'C:\\QA\\Other' });
  await defer(page, 'modpacks:preflight');
  await flush(page, 'modpacks:reserve-server-destination');
  await expect(page.getByText('Preparing review')).toBeVisible();
  await expect(page.locator('body')).toContainText('Chosen destination: Destination 2');
  await flush(page, 'modpacks:release-server-destination');
  await flush(page, 'modpacks:preflight');
  await expect(page.getByRole('heading', { name: 'Reviewed plan 2' })).toBeVisible();
  await expect(page.locator('body')).toContainText('Chosen destination: Destination 2');
  expect(await calls(page, 'modpacks:reserve-server-destination')).toBe(2);
  expect(await starts(page)).toBe(0);
});
