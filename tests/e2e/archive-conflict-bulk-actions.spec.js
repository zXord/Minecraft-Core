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
      import Review from './src/components/setup/ArchiveGuidedReview.svelte';
      let props = null;
      export function show(value) { props = value; }
      export function update(value) { props = { ...props, ...value }; }
    </script>
    {#if props}<Review {...props} on:preflight={event => window.preflightRequests.push(event.detail)} />{/if}
  `;
  const result = await build({
    absWorkingDir: ROOT,
    stdin: {
      resolveDir: ROOT,
      contents: `
        import Fixture from 'conflict-test-fixture';
        import { mount, flushSync } from 'svelte';
        const fixture = mount(Fixture, { target: document.querySelector('#fixture') });
        window.preflightRequests = [];
        window.conflictFixture = {
          show: props => flushSync(() => fixture.show(props)),
          update: props => flushSync(() => fixture.update(props))
        };
      `
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', conditions: ['browser'],
    plugins: [{
      name: 'real-guided-conflict-review',
      setup(builder) {
        builder.onResolve({ filter: /^conflict-test-fixture$/ }, () => ({
          path: 'ConflictTestFixture.svelte', namespace: 'conflict-fixture'
        }));
        builder.onLoad({ filter: /./, namespace: 'conflict-fixture' }, () => ({
          contents: compile(fixture, {
            filename: path.join(ROOT, 'ConflictTestFixture.svelte'),
            generate: 'client', css: 'external', dev: false
          }).js.code,
          resolveDir: ROOT
        }));
        builder.onLoad({ filter: /\.svelte$/, namespace: 'file' }, async ({ path: filename }) => ({
          contents: compile(await fs.readFile(filename, 'utf8'), {
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
  await page.route('**/*', route => route.abort());
  await page.setContent('<!doctype html><title>Conflict choices</title><main id="fixture"></main>');
  await page.addScriptTag({ content: bundle });
});

const inspection = {
  inspectionId: 'inspection-first', archiveFamily: 'zip', integrity: 'tested',
  rootCandidates: [], selectedRoot: null, warnings: [],
  classification: {
    kind: 'prepared-server-pack', confidence: 'exact', blocked: false,
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13' }
  }
};

// Mirror the public DTO: identity is opaque and distinct from the display path.
const config = {
  id: 'conflict-a7c031', label: 'config/quests.snbt', role: 'configuration',
  reason: 'both-changed', protected: false,
  allowedChoices: ['keep-mine', 'use-pack', 'keep-both'],
  alternateOptions: [{ id: 'alternate-b981fa', label: 'config/quests.pack.snbt' }]
};
const protectedConfig = {
  id: 'conflict-99d312', label: 'server.properties', role: 'configuration',
  reason: 'protected-managed-path', protected: true,
  allowedChoices: ['keep-mine', 'use-pack', 'keep-both'],
  alternateOptions: [{ id: 'alternate-72d35b', label: 'server.pack.properties' }]
};
const startup = {
  id: 'conflict-e6d105', label: 'run.bat', role: 'runtime',
  reason: 'protected-existing-server', protected: true,
  allowedChoices: ['keep-mine'], alternateOptions: []
};
const addon = {
  id: 'conflict-d047fb', label: 'mods/addon.jar', role: 'mod',
  reason: 'mod-or-runtime-conflict', protected: false,
  allowedChoices: ['disable-addon', 'remove-addon'], alternateOptions: []
};

async function show(page, conflicts, extra = {}) {
  await page.evaluate(props => window.conflictFixture.show(props), {
    inspection, reviewedPlan: { requiresConflictReview: true, conflicts }, operationKind: 'upgrade', ...extra
  });
}
const resolution = (page, label) => page.getByRole('combobox', { name: `Resolution for ${label}`, exact: true });
const keepExisting = page => page.getByRole('button', { name: 'Keep existing files', exact: true });
const useConfigs = page => page.getByRole('button', { name: 'Use pack files for configs', exact: true });
const review = page => page.getByRole('button', { name: 'Re-run review with conflict choices', exact: true });
const progress = page => page.getByRole('status').filter({ hasText: 'files decided' });

test('keeping existing files is explicit, respects allowed choices, and leaves unresolved conflicts blocking review', async ({ page }) => {
  await show(page, [config, startup, addon]);
  await expect(resolution(page, 'config/quests.snbt')).toHaveValue('');
  await expect(resolution(page, 'run.bat')).toHaveValue('');
  await expect(review(page)).toBeDisabled();
  await expect(progress(page)).toContainText('0 of 3 files decided');
  await keepExisting(page).click();
  await expect(resolution(page, 'config/quests.snbt')).toHaveValue('keep-mine');
  await expect(resolution(page, 'run.bat')).toHaveValue('keep-mine');
  await expect(resolution(page, 'mods/addon.jar')).toHaveValue('');
  await expect(progress(page)).toContainText('1 remaining');
  await expect(review(page)).toBeDisabled();
  await resolution(page, 'mods/addon.jar').selectOption('disable-addon');
  await review(page).click();
  expect(await page.evaluate(() => window.preflightRequests[0].selections.conflictChoices)).toEqual({
    paths: {
      'conflict-a7c031': { choice: 'keep-mine' },
      'conflict-e6d105': { choice: 'keep-mine' },
      'conflict-d047fb': { choice: 'disable-addon' }
    },
    categories: {}
  });
});

test('pack config bulk choices never replace protected files or files outside the configuration role', async ({ page }) => {
  const other = {
    id: 'conflict-cf8132', label: 'notes.txt', role: 'other', reason: 'both-changed',
    protected: false, allowedChoices: ['keep-mine', 'use-pack'], alternateOptions: []
  };
  await show(page, [config, protectedConfig, startup, other]);
  await useConfigs(page).click();
  await expect(resolution(page, 'config/quests.snbt')).toHaveValue('use-pack');
  await expect(resolution(page, 'server.properties')).toHaveValue('');
  await expect(resolution(page, 'run.bat')).toHaveValue('');
  await expect(resolution(page, 'notes.txt')).toHaveValue('');
  await expect(progress(page)).toContainText('3 remaining');
  await expect(review(page)).toBeDisabled();
  await keepExisting(page).click();
  await expect(resolution(page, 'server.properties')).toHaveValue('keep-mine');
  await expect(resolution(page, 'run.bat')).toHaveValue('keep-mine');
  await review(page).click();
  expect(await page.evaluate(() => window.preflightRequests[0].selections.conflictChoices)).toEqual({
    paths: {
      'conflict-a7c031': { choice: 'use-pack' },
      'conflict-99d312': { choice: 'keep-mine' },
      'conflict-e6d105': { choice: 'keep-mine' },
      'conflict-cf8132': { choice: 'keep-mine' }
    },
    categories: {}
  });
});

test('config bulk choices skip forbidden replacements and preserve individual choices before and after a bulk action', async ({ page }) => {
  const keepOnly = {
    ...config, id: 'conflict-c15a88', label: 'config/local.toml',
    allowedChoices: ['keep-mine'], alternateOptions: []
  };
  const second = { ...config, id: 'conflict-738ad1', label: 'config/other.toml' };
  await show(page, [config, keepOnly, second]);
  await resolution(page, 'config/quests.snbt').selectOption('keep-mine');
  await useConfigs(page).click();
  await expect(resolution(page, 'config/quests.snbt')).toHaveValue('keep-mine');
  await expect(resolution(page, 'config/local.toml')).toHaveValue('');
  await expect(resolution(page, 'config/other.toml')).toHaveValue('use-pack');
  await keepExisting(page).click();
  await expect(resolution(page, 'config/other.toml')).toHaveValue('use-pack');
  await resolution(page, 'config/other.toml').selectOption('keep-mine');
  await expect(resolution(page, 'config/other.toml')).toHaveValue('keep-mine');
  await expect(progress(page)).toContainText('3 of 3 files decided');
  await expect(review(page)).toBeEnabled();
});

test('bulk actions preserve an unfinished keep-both choice and require its approved opaque alternate', async ({ page }) => {
  await show(page, [config, startup]);
  await resolution(page, 'config/quests.snbt').selectOption('keep-both');
  await keepExisting(page).click();
  await expect(resolution(page, 'config/quests.snbt')).toHaveValue('keep-both');
  await expect(progress(page)).toContainText('1 remaining');
  await expect(review(page)).toBeDisabled();
  await page.getByRole('combobox', { name: 'Alternate destination for config/quests.snbt', exact: true }).selectOption('alternate-b981fa');
  await review(page).click();
  expect(await page.evaluate(() => window.preflightRequests[0].selections.conflictChoices)).toEqual({
    paths: {
      'conflict-a7c031': { choice: 'keep-both', alternateId: 'alternate-b981fa' },
      'conflict-e6d105': { choice: 'keep-mine' }
    },
    categories: {}
  });
});

test('bulk actions cannot resolve a structural blocker with no allowed choices', async ({ page }) => {
  const blocker = {
    ...config, id: 'conflict-c0128d', label: 'config/blocked.toml',
    reason: 'file-ancestor-collision', allowedChoices: [], alternateOptions: []
  };
  await show(page, [config, blocker]);
  await keepExisting(page).click();
  await expect(page.getByText('Structural conflict cannot be overridden', { exact: true })).toBeVisible();
  await expect(progress(page)).toContainText('1 remaining');
  await expect(review(page)).toBeDisabled();
  expect(await page.evaluate(() => window.preflightRequests)).toEqual([]);
});

test('busy review disables bulk and individual changes without losing the decisions', async ({ page }) => {
  await show(page, [config, startup]);
  await resolution(page, 'config/quests.snbt').selectOption('keep-both');
  await page.evaluate(() => window.conflictFixture.update({ busy: true }));
  await expect(keepExisting(page)).toBeDisabled();
  await expect(useConfigs(page)).toBeDisabled();
  await expect(resolution(page, 'config/quests.snbt')).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Alternate destination for config/quests.snbt', exact: true })).toBeDisabled();
  await page.evaluate(() => window.conflictFixture.update({ busy: false }));
  await expect(keepExisting(page)).toBeEnabled();
  await expect(resolution(page, 'config/quests.snbt')).toHaveValue('keep-both');
});

test('stale review cannot apply bulk choices and a fresh inspection clears earlier decisions', async ({ page }) => {
  await show(page, [config, startup]);
  await keepExisting(page).click();
  await expect(progress(page)).toContainText('2 of 2 files decided');
  await page.evaluate(() => window.conflictFixture.update({ error: { code: 'PLAN_STALE', message: 'Review again' } }));
  await expect(keepExisting(page)).toBeDisabled();
  await expect(useConfigs(page)).toBeDisabled();
  await expect(review(page)).toBeDisabled();
  await page.evaluate(nextInspection => window.conflictFixture.update({ inspection: nextInspection, error: null }), {
    ...inspection, inspectionId: 'inspection-fresh'
  });
  await expect(resolution(page, 'config/quests.snbt')).toHaveValue('');
  await expect(resolution(page, 'run.bat')).toHaveValue('');
  await expect(progress(page)).toContainText('0 of 2 files decided');
  await expect(review(page)).toBeDisabled();
  await expect(keepExisting(page)).toBeEnabled();
});
