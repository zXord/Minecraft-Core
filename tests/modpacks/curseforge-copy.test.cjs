const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

test('provider controls use only the approved CurseForge unavailable wording', () => {
  const files = [
    'src/components/setup/ModpackSourceChoice.svelte',
    'src/components/mods/components/ModSearch.svelte'
  ];
  for (const relativePath of files) {
    const content = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(content, /CurseForge \(Unavailable\)/, relativePath);
    assert.match(content, /CurseForge browsing is unavailable in this build\./, relativePath);
    assert.doesNotMatch(content, /Coming Soon|coming soon|roadmap|planned for|available in (?:a )?future/i, relativePath);
  }
});
