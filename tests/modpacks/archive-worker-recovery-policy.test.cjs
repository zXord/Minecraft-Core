const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..', '..');

test('crash recovery never reclaims a live or ambiguous owner or child and preserves exact ACE baselines', () => {
  const result = spawnSync('dotnet', [
    'run', '--project', path.join(repositoryRoot, 'native', 'ArchiveWorker.RecoveryTests', 'ArchiveWorker.RecoveryTests.csproj'),
    '--configuration', 'Release'
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    shell: false
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
