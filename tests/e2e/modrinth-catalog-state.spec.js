import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';

let bundle;
test.beforeAll(async () => {
  const root = process.cwd();
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `import Browser from './src/components/setup/ModrinthPackBrowser.svelte'; import { mount } from 'svelte'; mount(Browser, { target: document.querySelector('#fixture') });` },
    bundle: true, write: false, platform: 'browser', format: 'iife', conditions: ['browser'],
    plugins: [{ name: 'real-modrinth-browser', setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => ({
        contents: compile(await fs.readFile(filename, 'utf8'), { filename, generate: 'client', css: 'injected' }).js.code,
        resolveDir: path.dirname(filename)
      }));
    } }]
  });
  bundle = result.outputFiles[0].text;
});

const failure = { ok: false, error: { code: 'INVALID_REQUEST', message: 'Modrinth returned an invalid response' } };
const empty = { ok: true, value: { items: [], pagination: { offset: 0, limit: 20, total: 0 } } };
const results = (offset = 0, title = 'Retained Pack') => ({ ok: true, value: {
  items: [{ projectId: 'project-exact', slug: 'retained-pack', title, summary: 'Published summary', iconUrlCandidate: null,
    galleryUrlCandidates: [], categories: ['fabric'], minecraftVersions: ['1.21.1'], loaders: ['fabric'],
    serverCompatibility: 'required', updatedAt: '2026-01-01T00:00:00.000Z', downloads: 1 }],
  pagination: { offset, limit: 20, total: 60 }
} });

async function start(page) {
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="fixture"></div>');
  await page.evaluate(() => {
    window.requests = [];
    window.electron = { invoke: (channel, input) => {
      if (channel !== 'modpacks:search-catalog') throw new Error(`Unexpected IPC ${channel}`);
      return new Promise(resolve => window.requests.push({ input, resolve }));
    } };
  });
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('heading', { name: 'Browse server modpacks' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(1);
}

async function settle(page, index, response) {
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(index + 1);
  await page.evaluate(({ index, response }) => window.requests[index].resolve(response), { index, response });
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
}

const emptyMessage = page => page.getByText(/No server modpacks match these filters/);

test('initial catalog failure shows the actual error and Retry without a successful empty state', async ({ page }) => {
  await start(page);
  await settle(page, 0, failure);
  await expect(page.getByText('Modrinth returned an invalid response', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await expect(emptyMessage(page)).toHaveCount(0);
});

test('successful empty catalog shows the empty state without an error or Retry', async ({ page }) => {
  await start(page);
  await settle(page, 0, empty);
  await expect(emptyMessage(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
});

test('failed Retry after success preserves results filters and pagination then successful Retry clears the error', async ({ page }) => {
  await start(page);
  await settle(page, 0, results());
  await page.getByLabel('Search', { exact: true }).fill('factory');
  await page.getByLabel('Categories', { exact: true }).fill('technology, quests');
  await page.getByLabel('Minecraft version', { exact: true }).fill('1.21.1');
  await page.getByRole('combobox', { name: /^Loader/ }).selectOption('fabric');
  await page.getByRole('combobox', { name: /^Server compatibility/ }).selectOption('required');
  await page.getByRole('combobox', { name: /^Sort/ }).selectOption('downloads');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await settle(page, 1, results());
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await settle(page, 2, results(20));
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await settle(page, 3, failure);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await settle(page, 4, failure);

  await expect(page.getByRole('button', { name: /Retained Pack/ })).toBeVisible();
  await expect(page.getByText('Page 2 of 3', { exact: true })).toBeVisible();
  await expect(page.getByText('60 matching modpacks', { exact: true })).toBeVisible();
  await expect(page.getByText('Modrinth returned an invalid response', { exact: true })).toBeVisible();
  await expect(emptyMessage(page)).toHaveCount(0);
  await expect(page.getByLabel('Search', { exact: true })).toHaveValue('factory');
  await expect(page.getByLabel('Categories', { exact: true })).toHaveValue('technology, quests');
  await expect(page.getByLabel('Minecraft version', { exact: true })).toHaveValue('1.21.1');
  await expect(page.getByRole('combobox', { name: /^Loader/ })).toHaveValue('fabric');
  await expect(page.getByRole('combobox', { name: /^Server compatibility/ })).toHaveValue('required');
  await expect(page.getByRole('combobox', { name: /^Sort/ })).toHaveValue('downloads');
  expect(await page.evaluate(() => window.requests[4].input)).toEqual({
    query: 'factory', categories: ['technology', 'quests'], gameVersion: '1.21.1', loader: 'fabric',
    serverCompatibility: 'required', sort: 'downloads', offset: 40, limit: 20
  });

  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await settle(page, 5, results(40, 'Recovered Pack'));
  await expect(page.getByRole('button', { name: /Recovered Pack/ })).toBeVisible();
  await expect(page.getByText('Page 3 of 3', { exact: true })).toBeVisible();
  await expect(page.getByText('Modrinth returned an invalid response', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(emptyMessage(page)).toHaveCount(0);
});
