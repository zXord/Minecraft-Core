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
      import Job from './src/components/modpacks/ModpackJobProgress.svelte';
      let kind = null;
      let props = {};
      export function show(nextKind, nextProps) { kind = nextKind; props = nextProps; }
      export function update(nextProps) { props = { ...props, ...nextProps }; }
    </script>
    {#if kind === 'archive'}<Archive {...props} />
    {:else if kind === 'planning'}<Planning {...props} />
    {:else if kind === 'job'}<Job {...props} on:return={() => window.jobTest.returns++} />{/if}
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
  await page.evaluate(() => {
    window.jobTest = { job: null, returns: 0, actions: [], requests: [] };
    window.electron = {
      on() {}, removeListener() {},
      async invoke(channel, request) {
        window.jobTest.requests.push({ channel, request });
        if (channel === 'modpacks:get-job') return { ok: true, value: window.jobTest.job };
        if (channel === 'modpacks:perform-safe-action') {
          window.jobTest.actions.push(request);
          return { ok: true, value: { status: 'opened' } };
        }
        throw new Error(`Unexpected IPC: ${channel}`);
      }
    };
  });
  await page.addScriptTag({ content: bundle });
});

async function showJob(page, phase, outcome, operationKind = 'repair') {
  await page.evaluate(({ phase, outcome, operationKind }) => {
    const job = { jobId: 'recovery-job', phase, operationKind, outcome };
    window.jobTest.job = job;
    window.progressFixture.show('job', { job });
  }, { phase, outcome, operationKind });
}

for (const [phase, outcome] of [
  ['failed', { retainedDownload: { verified: true } }],
  ['failed', {}],
  ['cancelled', {}],
  ['failed', { kind: 'nothing-changed', retainedDownload: true }],
  ['failed', { kind: 'retained-download', retainedDownload: true }],
  ['rolled-back', { kind: 'restored' }],
  ['recovery-required', { kind: 'automatic-recovery', automatic: true }],
  ['completed', { kind: 'completed' }]
]) {
  test(`terminal cleanup warning overrides ${phase}/${outcome.kind || (outcome.retainedDownload ? 'cache' : 'plain')}`, async ({ page }) => {
    await showJob(page, phase, { ...outcome, cleanupPending: true, errorCode: 'PLAN_STALE', cleanupErrorCode: 'RECOVERY_REQUIRED', actions: [
      { actionId: 'retry', opaqueRef: 'retry-ref' },
      { actionId: 'remove-retained-download', opaqueRef: 'remove-ref' },
      { actionId: 'choose-another-asset', opaqueRef: 'choose-ref' }
    ] });
    await expect(page.getByRole('heading', { name: 'Recovery needs review' })).toHaveCount(2);
    const result = page.locator('section.outcome');
    await expect(result).toContainText('This operation stopped before cleanup could finish. Open the Modpack page to check its current recovery status before retrying.');
    await expect(result).toContainText('Operation error: PLAN_STALE');
    await expect(result).toContainText('Cleanup error: RECOVERY_REQUIRED');
    await expect(result).not.toContainText(/No server files were changed|byte-for-byte|restored successfully|remains.*blocked/u);
    await expect(result.getByRole('button')).toHaveText(['Review recovery status']);
    await result.getByRole('button', { name: 'Review recovery status' }).click();
    expect(await page.evaluate(() => window.jobTest)).toMatchObject({ returns: 1, actions: [] });
    expect(await page.evaluate(() => window.jobTest.requests)).toEqual([{ channel: 'modpacks:get-job', request: { jobId: 'recovery-job' } }]);
  });
}

test('cleanup warning exposes only issued cache opening and omits malformed codes', async ({ page }) => {
  await showJob(page, 'failed', { cleanupPending: true, retainedDownload: true, errorCode: 'C:\\private\\bad', cleanupErrorCode: 'run command', actions: [{ actionId: 'open-retained-download-folder', opaqueRef: 'cache-ref' }] });
  const result = page.locator('section.outcome');
  await expect(result).toContainText('The verified download remains available in the controlled cache.');
  await expect(result).not.toContainText(/private|run command|Operation error:|Cleanup error:/u);
  await result.getByRole('button', { name: 'Open folder' }).click();
  expect(await page.evaluate(() => window.jobTest.actions)).toEqual([{ actionId: 'open-retained-download-folder', opaqueRef: 'cache-ref' }]);
});

test('cleanup warning does not repeat legacy safe-stop diagnostics or retry guidance', async ({ page }) => {
  await showJob(page, 'failed', { cleanupPending: true, kind: 'nothing-changed', failureReason: 'destination-recovery-required', failure: { stage: 'candidate-boot', boundary: 'readiness', category: 'process-exited' } }, 'install-new');
  await expect(page.locator('section.outcome')).not.toContainText('Try another pack version or asset, then retry.');
  await expect(page.locator('section.outcome')).not.toContainText('The existing server files were not touched.');
});

for (const code of ['', 'a', 'BAD-CODE', 'A'.repeat(65), 1, null]) {
  test(`cleanup warning omits unsafe diagnostic code ${JSON.stringify(code)}`, async ({ page }) => {
    await showJob(page, 'failed', { cleanupPending: true, errorCode: code, cleanupErrorCode: code });
    await expect(page.locator('section.outcome')).not.toContainText(/Operation error:|Cleanup error:/u);
  });
}

for (const cleanupPending of [false, 'true', 1, null]) {
  test(`nonboolean pending ${JSON.stringify(cleanupPending)} retains ordinary no-change result`, async ({ page }) => {
    await showJob(page, 'failed', { cleanupPending });
    await expect(page.getByRole('heading', { name: 'Stopped before server changes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review recovery status' })).toHaveCount(0);
  });
}

test('ordinary retained cache and completed Verify/result presentation remain intact', async ({ page }) => {
  await showJob(page, 'failed', { retainedDownload: true });
  await expect(page.getByRole('heading', { name: 'Downloaded file retained for manual use' })).toBeVisible();
  await showJob(page, 'completed', { result: { healthy: false, checkedFiles: 5, mismatchCount: 1, mismatches: [{ entryName: 'example.jar', status: 'modified' }], repairAvailable: true } }, 'verify');
  await expect(page.getByRole('heading', { name: 'Differences found' })).toBeVisible();
  await expect(page.locator('section.outcome')).toContainText('Checked files: 5 · Mismatches: 1');
  await showJob(page, 'completed', {});
  await expect(page.locator('section.outcome').getByRole('heading', { name: 'Completed' })).toBeVisible();
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
