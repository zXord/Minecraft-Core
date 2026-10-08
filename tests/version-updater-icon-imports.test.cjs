const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.resolve(__dirname, '../src/components/settings/VersionUpdater.svelte');
const iconImports = Object.freeze([
  ['ChevronDown', 'lucide-svelte/icons/chevron-down'],
  ['ChevronRight', 'lucide-svelte/icons/chevron-right'],
  ['ExternalLink', 'lucide-svelte/icons/external-link']
]);

test('VersionUpdater keeps its three icons on direct package exports instead of the full Lucide barrel', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';

  assert.doesNotMatch(script, /from\s+['"]lucide-svelte['"]/u);
  for (const [localName, specifier] of iconImports) {
    assert.doesNotThrow(() => require.resolve(specifier));
    assert.match(
      script,
      new RegExp(`import\\s+${localName}\\s+from\\s+['"]${specifier}['"]`, 'u')
    );
  }
});
