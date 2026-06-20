const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

test('Play tab waits for staged update hydration before enabling launch', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'client', 'PlayTab.svelte'),
    'utf8'
  );

  assert.match(source, /let\s+stagedVersionHydrationPending\s*=/);
  assert.match(source, /canLaunchMinecraft\s*=[\s\S]*!\s*stagedVersionHydrationPending/);
  assert.match(source, /stagedVersionHydrationPending\s*=\s*false/);
  assert.match(source, /Checking App Update/i);
});
