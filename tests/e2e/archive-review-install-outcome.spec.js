// What a reviewed plan's own Start press produced is shown right after the button that was pressed, scrolled into
// view and focused: a stale or not-started plan offers the fresh review there, and a Start that was not invoked is
// explained there instead of at the top of a long review. Real ArchiveGuidedReview and ModpackPlanReview components
// are mounted directly; startReviewedOperation is a page stub that returns the queued results.
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
    import Archive from './src/components/setup/ArchiveGuidedReview.svelte';
    import Plan from './src/components/modpacks/ModpackPlanReview.svelte';
    let kind = 'archive';
    let props = null;
    export function show(nextKind, value) { kind = nextKind; props = value; }
  </script>{#if props}{#if kind === 'plan'}<Plan {...props} on:stale={() => window.reviewEvents.push('stale')} />{:else}<Archive {...props} on:stale={() => window.reviewEvents.push('stale')} on:error={event => window.reviewEvents.push('error: ' + event.detail?.error?.message)} />{/if}{/if}`;
  const result = await build({
    absWorkingDir: ROOT, stdin: { resolveDir: ROOT, contents: `import Fixture from 'review-fixture'; import { mount, flushSync } from 'svelte';
      const fixture = mount(Fixture, { target: document.querySelector('#fixture') });
      window.reviewFixture = { show: (kind, props) => flushSync(() => fixture.show(kind, props)) };` },
    bundle: true, write: false, platform: 'browser', format: 'iife', conditions: ['browser'],
    plugins: [{ name: 'real-review-components', setup(builder) {
      builder.onResolve({ filter: /^review-fixture$/ }, () => ({ path: 'ReviewOutcomeFixture.svelte', namespace: 'fixture' }));
      builder.onLoad({ filter: /./, namespace: 'fixture' }, () => ({ contents: compile(fixture, { filename: path.join(ROOT, 'ReviewOutcomeFixture.svelte'), generate: 'client', css: 'external' }).js.code, resolveDir: ROOT }));
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
  await page.setContent('<!doctype html><title>Review install outcome fixture</title><main id="fixture"></main>');
  await page.addStyleTag({ content: `body { background: #17191d; color: #eee; font-family: system-ui; } #fixture { max-width: 1040px; margin: 24px auto; } ${componentCss}` });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  page.outcomeErrors = errors;
  await page.addScriptTag({ content: bundle });
});
test.afterEach(async ({ page }) => { expect(page.outcomeErrors).toEqual([]); });

const STALE = { status: 'not-invoked', error: { code: 'PLAN_STALE', message: 'The review changed before Start was invoked. Run a fresh preflight review.' } };
const CHANGED = 'The reviewed selection changed. Run a fresh preflight review.';

// Results are queued in the page; 'changed' becomes the plain Error that ModpackPage returns for a not-invoked Start.
async function show(page, kind, results) {
  await page.evaluate(({ kind, results, changed }) => {
    const reviewedPlan = { planId: 'plan-install-outcome-1', planFingerprint: 'a'.repeat(64), planView: {
      title: 'Reviewed install plan', source: { provider: 'local', version: 'Captured pack' },
      runtime: { minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.16.0', java: 21 },
      changes: { added: 3, changed: 1, removed: 0, preserved: 12 }, warnings: [], blockers: []
    } };
    window.reviewEvents = [];
    window.startRequests = [];
    window.startResults = results.map(result => result === 'changed' ? { status: 'not-invoked', error: new Error(changed) } : result);
    const startReviewedOperation = request => { window.startRequests.push(request); return Promise.resolve(window.startResults.shift()); };
    const common = { reviewedPlan, reviewContext: { plan: reviewedPlan }, startReviewedOperation };
    window.reviewFixture.show(kind, kind === 'plan' ? { ...common, operationKind: 'update', targetLabel: 'Disposable server' } : {
      ...common, operationKind: 'install-new',
      inspection: { inspectionId: 'inspection-install-outcome', archiveFamily: 'zip', integrity: 'tested', rootCandidates: [], selectedRoot: null, warnings: [],
        classification: { kind: 'prepared-server-pack', confidence: 'exact', blocked: false, runtime: { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.0' } } }
    });
  }, { kind, results, changed: CHANGED });
  await page.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }).check();
}

const events = page => page.evaluate(() => window.reviewEvents);
const startCount = page => page.evaluate(() => window.startRequests.length);
const follows = (page, anchor, selector) => page.evaluate(({ anchor, selector }) => {
  const button = document.querySelector(anchor);
  const target = document.querySelector(selector);
  return Boolean(button && target && (button.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING));
}, { anchor, selector });

test('archive review: a stale Start press relabels the button and offers the fresh review right after it, focused', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await show(page, 'archive', [STALE]);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  const install = page.locator('[data-launch-start]');
  await expect(install).toHaveText('Fresh review required');
  await expect(install).toBeDisabled();
  const outcome = page.getByRole('alert').filter({ hasText: 'Reviewed plan needs to be refreshed' });
  await expect(outcome).toBeFocused();
  await expect(outcome).toBeInViewport();
  expect(await follows(page, '[data-launch-start]', '[role="alert"]')).toBe(true);
  await expect(page.getByText('Reviewed plan needs to be refreshed', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Run a fresh preflight review' })).toHaveCount(1);
  await outcome.getByRole('button', { name: 'Run a fresh preflight review' }).click();
  expect(await events(page)).toEqual(['stale']);
  expect(await startCount(page)).toBe(1);
});

test('archive review: a Start that was not invoked is explained right after the button, once, without a top banner or a parent error', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await show(page, 'archive', ['changed', { status: 'started' }]);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  const outcome = page.getByRole('alert').filter({ hasText: CHANGED });
  await expect(outcome).toContainText('Could not start the reviewed plan');
  await expect(outcome).toBeFocused();
  await expect(outcome).toBeInViewport();
  expect(await follows(page, '[data-launch-start]', '[role="alert"]')).toBe(true);
  await expect(page.getByText(CHANGED, { exact: true })).toHaveCount(1);
  await expect(page.getByText('Review could not continue')).toHaveCount(0);
  expect(await events(page)).toEqual([]);
  // The parent did not run anything, so the same reviewed plan can be pressed again; the old outcome then clears.
  await expect(page.locator('[data-launch-start]')).toHaveText('Install this exact reviewed plan');
  await page.locator('[data-launch-start]').click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await startCount(page)).toBe(2);
  expect(await events(page)).toEqual([]);
});

test('archive review: a not-started Start requires a fresh review even before the parent reports it', async ({ page }) => {
  await show(page, 'archive', [{ status: 'not-started' }]);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  const outcome = page.getByRole('alert').filter({ hasText: 'Reviewed plan needs to be refreshed' });
  await expect(outcome).toBeFocused();
  expect(await follows(page, '[data-launch-start]', '[role="alert"]')).toBe(true);
  await expect(page.locator('[data-launch-start]')).toHaveText('Fresh review required');
  await expect(page.locator('[data-launch-start]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Run a fresh preflight review' })).toHaveCount(1);
  expect(await startCount(page)).toBe(1);
});

test('archive review: an unknown Start outcome stays fail-closed and offers no fresh review', async ({ page }) => {
  await show(page, 'archive', [{ status: 'unknown' }]);
  await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
  await expect(page.locator('[data-launch-start]')).toHaveText('Checking Start outcome…');
  await expect(page.locator('[data-launch-start]')).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run a fresh preflight review' })).toHaveCount(0);
  expect(await events(page)).toEqual([]);
});

test('plan review: a stale Start press offers the fresh review right after its button, focused', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await show(page, 'plan', [STALE]);
  await page.getByRole('button', { name: 'Start reviewed operation' }).click();
  const outcome = page.getByRole('alert').filter({ hasText: 'Reviewed plan needs a fresh preflight' });
  await expect(outcome).toBeFocused();
  await expect(outcome).toBeInViewport();
  expect(await follows(page, '.mp-actions > button', '[role="alert"]')).toBe(true);
  await expect(page.getByRole('button', { name: 'Start reviewed operation' })).toBeDisabled();
  await outcome.getByRole('button', { name: 'Run a fresh preflight review' }).click();
  expect(await events(page)).toEqual(['stale']);
  expect(await startCount(page)).toBe(1);
});

test('plan review: a Start that was not invoked is explained right after its button, once, and focused', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await show(page, 'plan', ['changed']);
  await page.getByRole('button', { name: 'Start reviewed operation' }).click();
  const outcome = page.getByRole('alert').filter({ hasText: CHANGED });
  await expect(outcome).toContainText('Could not start the reviewed plan');
  await expect(outcome).toBeFocused();
  await expect(outcome).toBeInViewport();
  expect(await follows(page, '.mp-actions > button', '[role="alert"]')).toBe(true);
  await expect(page.getByText(CHANGED, { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Start reviewed operation' })).toBeEnabled();
  expect(await startCount(page)).toBe(1);
});
