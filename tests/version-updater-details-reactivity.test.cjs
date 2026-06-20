const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.resolve(__dirname, '../src/components/settings/VersionUpdater.svelte');

test('VersionUpdater mod details bindings expose state objects to Svelte template reactivity', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const template = source.split('</script>')[1] || '';

  assert.ok(
    template.includes('isModDetailsExpanded(mod, expandedModDetails)'),
    'expanded details state must be passed in template expressions'
  );
  assert.ok(
    template.includes('isModDetailsLoading(mod, modDetailsLoading)'),
    'loading state must be passed in template expressions'
  );
  assert.ok(
    template.includes('getModProjectDetails(mod, modProjectDetails)'),
    'project detail state must be passed in template expressions'
  );
  assert.ok(
    template.includes('getModDetailError(mod, modProjectDetailErrors)'),
    'detail error state must be passed in template expressions'
  );

  assert.equal(
    /isModDetailsExpanded\(mod\)/.test(template),
    false,
    'template must not hide expanded state inside a zero-argument helper call'
  );
});
