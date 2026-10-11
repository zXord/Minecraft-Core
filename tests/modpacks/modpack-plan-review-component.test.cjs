const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
let renderReview;
test.before(async () => {
  const { build } = require('esbuild');
  const { compile } = await import('svelte/compiler');
  const result = await build({
    absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      import Review from './src/components/modpacks/ModpackPlanReview.svelte';
      import { render } from 'svelte/server';
      export const renderReview = props => render(Review, { props }).body;
    ` },
    bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'actual-review-component', setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => ({
        contents: compile(await fs.readFile(filename, 'utf8'), {
          filename, generate: 'server', css: 'external', dev: false
        }).js.code,
        resolveDir: path.dirname(filename)
      }));
    } }]
  });
  ({ renderReview } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`));
});

function props(planView = {}) {
  return {
    operationKind: 'update', targetLabel: 'Disposable b1',
    reviewedPlan: { planId: 'plan-example', planFingerprint: 'a'.repeat(64), planView: {
      title: 'Modpack-Modern', source: { provider: 'github', version: '0.13.5', releaseId: 'release-0135' },
      runtime: { minecraft: '1.20.1', loader: 'forge', loaderVersion: '47.4.13', java: 17 },
      changes: { added: 50, changed: 121, removed: 496, preserved: 8564 },
      warnings: [], blockers: [], ...planView
    } }
  };
}

test('review identifies the selected server and exact release before accepting file changes', () => {
  // Dropping the sealed source version or target label recreates the ambiguous native review.
  const html = renderReview(props());
  assert.match(html, /aria-label="Reviewed operation details"/);
  assert.match(html, /Disposable b1/);
  assert.match(html, /GitHub Releases/);
  assert.match(html, /0\.13\.5/);
  assert.match(html, /1\.20\.1/);
  assert.match(html, /forge 47\.4\.13/);
  assert.match(html, /Java 17/);
  assert.match(html, /496/);
  assert.match(html, /disabled[^>]*>Start reviewed operation/);
});

test('files-only review never invents a runnable Java or Minecraft runtime', () => {
  const value = props({ runtime: null, source: { provider: 'local', version: 'Imported archive' } });
  value.operationKind = 'files-only';
  const html = renderReview(value);
  assert.match(html, /Local archive/);
  assert.match(html, /Imported archive/);
  assert.match(html, /Files only/);
  assert.doesNotMatch(html, /Java 17|forge 47|Minecraft 1\./);
});

test('unknown optional context is omitted without undefined values or stale assumptions', () => {
  const value = props({ source: null, runtime: null });
  value.targetLabel = '';
  const html = renderReview(value);
  assert.doesNotMatch(html, /undefined|null|Disposable b1|GitHub Releases|0\.13\.5/);
});

test('review context is escaped as text, never markup from provider or server names', () => {
  const value = props({ source: { provider: 'modrinth', version: '<script>release</script>' } });
  value.targetLabel = '<img src=x onerror=alert(1)>';
  const html = renderReview(value);
  assert.match(html, /Modrinth/);
  assert.match(html, /&lt;script/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
});

test('rollback distinguishes the current release from the selected restore point and its runtime', () => {
  const value = props({
    source: { provider: 'github', version: '0.13.5' },
    runtime: { minecraft: '1.20.1', loader: 'forge', loaderVersion: '47.4.10', java: 17 },
    rollback: { id: 'restore-previous', sourceRevision: 6, worldIncluded: true }
  });
  value.operationKind = 'rollback-restore-point';
  const html = renderReview(value);
  assert.match(html, /<dt[^>]*>Current release<\/dt><dd[^>]*>GitHub Releases.*0\.13\.5/);
  assert.match(html, /<dt[^>]*>Restore point<\/dt><dd[^>]*>restore-previous/);
  assert.match(html, /<dt[^>]*>Restored runtime<\/dt><dd[^>]*>Minecraft 1\.20\.1.*forge 47\.4\.10/);
  assert.doesNotMatch(html, /Selected release/);
});

test('detach and uninstall identify the current release without suggesting another release was selected', () => {
  for (const operationKind of ['detach', 'uninstall-managed']) {
    const html = renderReview({ ...props(), operationKind });
    assert.match(html, /<dt[^>]*>Current release<\/dt>/);
    assert.doesNotMatch(html, /Selected release|Restored runtime/);
  }
});
