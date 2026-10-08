const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const component = fs.readFileSync(
  path.resolve(__dirname, '../src/components/server/ServerControls.svelte'),
  'utf8'
);

test('server controls reject an unsuccessful stop response and keep status sourced from the backend', () => {
  const start = component.indexOf('async function stopServer()');
  const end = component.indexOf('async function killServer()', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const stopServer = component.slice(start, end);

  assert.match(stopServer, /const\s+stopResult\s*=\s*await\s+window\.electron\.invoke\(['"]stop-server['"]/u);
  assert.match(stopServer, /if\s*\(stopResult\?\.success\s*!==\s*true\)/u);
  assert.match(stopServer, /await\s+checkServerStatus\(\)/u);
  assert.match(stopServer, /errorMessage\.set\(/u);
  assert.doesNotMatch(stopServer, /applyServerStatus\(['"]Stopped['"]/u);
});
