const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

test('logger entry only mounts when the logger root exists', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'logger.js'), 'utf8');

  assert.match(
    source,
    /document\.getElementById\(['"]logger-root['"]\)/,
    'logger entry should look up the logger window mount target'
  );
  assert.match(
    source,
    /if\s*\(\s*loggerRoot\s*\)/,
    'logger entry should guard the mount when loaded by the main app page'
  );
  assert.doesNotMatch(
    source,
    /target:\s*document\.getElementById\(['"]logger-root['"]\)/,
    'logger entry should not pass a possibly null target directly to Svelte mount'
  );
});
