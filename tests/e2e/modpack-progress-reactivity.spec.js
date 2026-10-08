import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let bundle;

// Compile the real client components in memory: no application server, Electron,
// production build, IPC stub, or SSR render can satisfy these update assertions.
test.beforeAll(async () => {
  const fixture = `
    <script>
      import Archive from './src/components/setup/ArchiveGuidedReview.svelte';
      import Planning from './src/components/modpacks/ModpackPlanningProgress.svelte';
      let kind = null;
      let props = {};
      export function show(nextKind, nextProps) { kind = nextKind; props = nextProps; }
      export function update(nextProps) { props = { ...props, ...nextProps }; }
    </script>
    {#if kind === 'archive'}<Archive {...props} />
    {:else if kind === 'planning'}<Planning {...props} />{/if}
  `;
  const result = await build({
    absWorkingDir: ROOT,
    stdin: {
      resolveDir: ROOT,
      contents: `
        import Fixture from 'progress-test-fixture';
        import { mount, flushSync } from 'svelte';
        const fixture = mount(Fixture, { target: document.querySelector('#fixture') });
        window.progressFixture = {
          show: (kind, props) => flushSync(() => fixture.show(kind, props)),
          update: props => flushSync(() => fixture.update(props))
        };
      `
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    conditions: ['browser'],
    plugins: [{
      name: 'real-svelte-client-components',
      setup(builder) {
        builder.onResolve({ filter: /^progress-test-fixture$/ }, () => ({
          path: 'ProgressTestFixture.svelte', namespace: 'progress-fixture'
        }));
        builder.onLoad({ filter: /./, namespace: 'progress-fixture' }, () => ({
          contents: compile(fixture, {
            filename: path.join(ROOT, 'ProgressTestFixture.svelte'),
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
  await page.setContent('<!doctype html><title>Modpack progress reactivity</title><main id="fixture"></main>');
  await page.addScriptTag({ content: bundle });
});

function propsFor(kind, progress) {
  return kind === 'archive'
    ? { inspection: null, busy: true, preflightProgress: progress }
    : { progress };
}

async function show(page, kind, progress) {
  await page.evaluate(({ kind, props }) => window.progressFixture.show(kind, props), {
    kind, props: propsFor(kind, progress)
  });
}

async function update(page, kind, progress) {
  await page.evaluate(props => window.progressFixture.update(props), propsFor(kind, progress));
}

for (const kind of ['archive', 'planning']) {
  const suffix = kind === 'planning' ? ' checked' : '';
  const status = page => page.locator('.preflight-status');

  test(`${kind} replaces its unmeasured detail when byte totals arrive`, async ({ page }) => {
    await show(page, kind, { phase: 'preparing-candidate' });
    await expect(status(page).locator('progress')).toHaveCount(0);
    await update(page, kind, { phase: 'preparing-candidate', processedBytes: 256, totalBytes: 1024 });
    await expect(status(page).locator('progress')).toHaveAttribute('value', '25');
    await expect(status(page).locator('p')).toHaveText(`256 B of 1.0 KB${suffix}`);
  });

  test(`${kind} updates byte detail alongside an already visible percentage`, async ({ page }) => {
    await show(page, kind, { phase: 'preparing-candidate', processedBytes: 256, totalBytes: 1024 });
    await expect(status(page).locator('p')).toHaveText(`256 B of 1.0 KB${suffix}`);
    await update(page, kind, { phase: 'preparing-candidate', processedBytes: 768, totalBytes: 1024 });
    await expect(status(page).locator('progress')).toHaveAttribute('value', '75');
    await expect(status(page).locator('p')).toHaveText(`768 B of 1.0 KB${suffix}`);
  });

  test(`${kind} updates item detail when no byte totals are available`, async ({ page }) => {
    await show(page, kind, { phase: 'preparing-candidate', completedItems: 1, totalItems: 4 });
    await expect(status(page).locator('p')).toHaveText(`1 of 4 items${suffix}`);
    await update(page, kind, { phase: 'preparing-candidate', completedItems: 3, totalItems: 4 });
    await expect(status(page).locator('progress')).toHaveAttribute('value', '75');
    await expect(status(page).locator('p')).toHaveText(`3 of 4 items${suffix}`);
  });

  test(`${kind} exposes advancing file counts while byte progress stays unchanged`, async ({ page }) => {
    const progress = {
      phase: 'preparing-candidate', activity: 'assembling-files',
      completedItems: 1024, totalItems: 4150, processedBytes: 256, totalBytes: 1024
    };
    await show(page, kind, progress);
    await expect(status(page).locator('progress')).toHaveAttribute('value', '25');
    await expect(status(page).locator('p')).toHaveText('1,024 of 4,150 files · 256 B of 1.0 KB');

    await update(page, kind, { ...progress, completedItems: 2048 });
    await expect(status(page).locator('progress')).toHaveAttribute('value', '25');
    await expect(status(page).locator('p')).toHaveText('2,048 of 4,150 files · 256 B of 1.0 KB');

    await update(page, kind, { ...progress, completedItems: 2048, processedBytes: 768 });
    await expect(status(page).locator('progress')).toHaveAttribute('value', '75');
    await expect(status(page).locator('p')).toHaveText('2,048 of 4,150 files · 768 B of 1.0 KB');
  });

  test(`${kind} labels generic dual measurements as items and clears absent counts`, async ({ page }) => {
    await show(page, kind, {
      phase: 'scanning-server', completedItems: 3, totalItems: 4, processedBytes: 256, totalBytes: 1024
    });
    await expect(status(page).locator('progress')).toHaveAttribute('value', '25');
    await expect(status(page).locator('p')).toHaveText('3 of 4 items · 256 B of 1.0 KB');

    await update(page, kind, { phase: 'scanning-server', processedBytes: 768, totalBytes: 1024 });
    await expect(status(page).locator('progress')).toHaveAttribute('value', '75');
    await expect(status(page).locator('p')).toHaveText(`768 B of 1.0 KB${suffix}`);
  });
}

test('planning replaces stale counts with the next unmeasured phase explanation', async ({ page }) => {
  await show(page, 'planning', { phase: 'scanning-server', processedBytes: 256, totalBytes: 1024 });
  await expect(page.locator('.preflight-status p')).toHaveText('256 B of 1.0 KB checked');
  await update(page, 'planning', { phase: 'verifying-restore-point' });
  await expect(page.locator('.preflight-status progress')).toHaveCount(0);
  await expect(page.locator('.preflight-status p')).toHaveText(
    'Reading the selected restore archive before the plan can be reviewed.'
  );
});
