import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'fabric', loaderVersion: '0.16.10' };
let bundle;

test.beforeAll(async () => {
  const fixture = `
    <script>
      import Review from './src/components/setup/ArchiveGuidedReview.svelte';
      let props = null;
      export function show(value) { props = value; }
      export function update(value) { props = { ...props, ...value }; }
    </script>
    {#if props}<Review {...props}
      on:preflight={event => window.rootRequests.push({ kind: 'preflight', ...event.detail })}
      on:filesonly={event => window.rootRequests.push({ kind: 'filesonly', ...event.detail })}
    />{/if}
  `;
  const result = await build({
    absWorkingDir: ROOT,
    stdin: { resolveDir: ROOT, contents: `
      import Fixture from 'root-review-fixture';
      import { mount, flushSync } from 'svelte';
      const fixture = mount(Fixture, { target: document.querySelector('#fixture') });
      window.rootRequests = [];
      window.rootFixture = {
        show: props => flushSync(() => fixture.show(props)),
        update: props => flushSync(() => fixture.update(props))
      };
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', conditions: ['browser'],
    plugins: [{
      name: 'actual-archive-root-review',
      setup(builder) {
        builder.onResolve({ filter: /^root-review-fixture$/ }, () => ({
          path: 'RootReviewFixture.svelte', namespace: 'root-fixture'
        }));
        builder.onLoad({ filter: /./, namespace: 'root-fixture' }, () => ({
          contents: compile(fixture, {
            filename: path.join(ROOT, 'RootReviewFixture.svelte'), generate: 'client', css: 'external', dev: false
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
  await page.setContent('<!doctype html><title>Archive root review</title><main id="fixture"></main>');
  await page.addScriptTag({ content: bundle });
});

function inspection(kind, rootCandidates, selectedRoot = null, classification = {}) {
  return {
    inspectionId: `inspection-${kind}`, archiveFamily: kind === 'mrpack-server' ? 'mrpack' : 'zip',
    integrity: 'deferred-to-extraction', rootCandidates, selectedRoot, warnings: [],
    limitEvidence: { totals: { entryCount: 9, expandedBytes: '21063' } },
    classification: { kind, confidence: 'exact', blocked: false, runtime, ...classification }
  };
}

const reviewButton = page => page.getByRole('button', { name: 'Choose destination and review plan', exact: true });
const proposedRoot = page => page.locator('.mp-metric').filter({ hasText: 'Proposed root' }).locator('strong');
async function show(page, value) {
  await page.evaluate(inspection => window.rootFixture.show({ inspection, operationKind: 'install-new' }), value);
}
async function requests(page) {
  return page.evaluate(() => window.rootRequests);
}

for (const [kind, child] of [['mrpack-server', 'overrides'], ['prepared-server-pack', 'mods']]) {
  test(`${kind} emits archive root when one child directory accompanies root evidence`, async ({ page }, testInfo) => {
    // Catches replacing the inspector's valid null root with its sole child directory.
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await show(page, inspection(kind, [child]));
    await reviewButton(page).click();
    expect(await requests(page)).toEqual([{
      kind: 'preflight', selections: {
        optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
        acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: false,
        selectedRoot: null, runtimeChoice: null, maxRam: 4, serverPort: 25565, networkAccess: 'pack-default'
      }
    }]);
    await expect(proposedRoot(page)).toHaveText('Archive root');
    await expect(page.getByRole('group', { name: 'Choose the server root' })).toHaveCount(0);
    await expect(page.getByText(/Minecraft 1\.20\.1 · fabric 0\.16\.10/u)).toBeVisible();
    await expect(page).toHaveTitle('Archive root review');
    expect(page.url()).toBe('about:blank');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${kind}-archive-root.png`) });
  });
}

for (const [name, kind, candidates, root] of [
  ['true wrapper', 'prepared-server-pack', ['server'], 'server'],
  ['no children', 'mrpack-server', [], null],
  ['multiple children', 'mrpack-server', ['overrides', 'server-overrides'], null],
  ['installer with payload child', 'loader-installer-bundle', ['mods'], null]
]) {
  test(`review preserves inspected root for ${name}`, async ({ page }) => {
    await show(page, inspection(kind, candidates, root));
    await reviewButton(page).click();
    expect((await requests(page))[0].selections).toMatchObject({ selectedRoot: root, runtimeChoice: null });
    await expect(proposedRoot(page)).toHaveText(root || 'Archive root');
    await expect(page.getByRole('group', { name: 'Choose the server root' })).toHaveCount(0);
  });
}

test('explicit ambiguous root survives same-inspection changes and resets only for fresh inspection authority', async ({ page }) => {
  const ambiguous = inspection('ambiguous-or-unknown', ['server-a', 'server-b'], null, {
    confidence: 'multiple-roots', blocked: true, runtime: null,
    candidates: [
      { kind: 'nested-runtime-candidate', entryName: 'server-a/server.jar' },
      { kind: 'nested-runtime-candidate', entryName: 'server-b/server.jar' }
    ]
  });
  await show(page, ambiguous);
  await expect(reviewButton(page)).toBeDisabled();
  await page.getByRole('radio', { name: /server-b/u }).check();
  await page.evaluate(() => window.rootFixture.update({ busy: true }));
  await expect(page.getByRole('button', { name: 'Starting plan review…', exact: true })).toBeDisabled();
  await page.evaluate(value => window.rootFixture.update({ busy: false, inspection: value }), {
    ...ambiguous, warnings: [{ code: 'INERT_TEST_WARNING' }]
  });
  await reviewButton(page).click();
  expect((await requests(page))[0].selections).toMatchObject({ selectedRoot: 'server-b', runtimeChoice: null });
  await page.evaluate(value => window.rootFixture.update({ inspection: value }), {
    ...ambiguous, inspectionId: 'inspection-fresh-ambiguous'
  });
  await expect(proposedRoot(page)).toHaveText('Archive root');
  await expect(reviewButton(page)).toBeDisabled();
  await page.evaluate(value => window.rootFixture.update({ inspection: value }), {
    ...inspection('mrpack-server', ['overrides']), inspectionId: 'inspection-fresh-root'
  });
  await reviewButton(page).click();
  expect((await requests(page))[1].selections).toMatchObject({ selectedRoot: null, runtimeChoice: null });
});

test('unknown archive keeps archive root and requires a complete manual runtime', async ({ page }) => {
  await show(page, inspection('ambiguous-or-unknown', ['config'], null, {
    confidence: 'insufficient', blocked: true, runtime: null, candidates: []
  }));
  await expect(reviewButton(page)).toBeDisabled();
  await page.getByRole('textbox', { name: /^Minecraft version/u }).fill('1.20.1');
  await page.getByRole('combobox', { name: /^Loader family/u }).selectOption('fabric');
  await expect(reviewButton(page)).toBeDisabled();
  await page.getByRole('textbox', { name: /^Loader version/u }).fill('0.16.10');
  await reviewButton(page).click();
  expect((await requests(page))[0].selections).toMatchObject({ selectedRoot: null, runtimeChoice: runtime });
});

for (const kind of ['mrpack-client-only', 'multimc-client-only', 'backup-archive']) {
  test(`${kind} stays blocked with one child directory`, async ({ page }) => {
    await show(page, inspection(kind, ['payload'], null, { blocked: true }));
    await expect(reviewButton(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Import reviewed data as files-only', exact: true })).toHaveCount(0);
    expect(await requests(page)).toEqual([]);
  });
}

for (const kind of ['unsupported-runtime-layout', 'files-only']) {
  test(`${kind} files-only event retains archive root and no runtime or managed resources`, async ({ page }) => {
    await show(page, inspection(kind, ['config'], null, { blocked: kind === 'unsupported-runtime-layout', runtime: null }));
    if (kind === 'unsupported-runtime-layout') await expect(reviewButton(page)).toBeDisabled();
    await page.getByRole('button', { name: 'Import reviewed data as files-only', exact: true }).click();
    expect((await requests(page))[0]).toMatchObject({ kind: 'filesonly', selections: {
      selectedRoot: null, runtimeChoice: null, maxRam: null, serverPort: null, networkAccess: null
    } });
  });
}
