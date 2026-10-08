const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('the shipped Electron runtime verifies a large deflated ZIP entry without stalling', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-electron-zip-runtime-'));
  t.after(() => {
    const canonicalRoot = path.resolve(root);
    const canonicalTemp = path.resolve(os.tmpdir());
    if (path.dirname(canonicalRoot) !== canonicalTemp ||
        !path.basename(canonicalRoot).startsWith('minecraft-core-electron-zip-runtime-')) {
      throw new TypeError('Unsafe Electron ZIP runtime cleanup target');
    }
    fs.rmSync(canonicalRoot, { recursive: true, force: true });
  });
  const electronBinary = require('electron');
  const fixturePath = path.join(__dirname, 'fixtures', 'electron-large-zip-verifier.cjs');
  const result = childProcess.spawnSync(electronBinary, [fixturePath, root], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 12_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `Electron ZIP verifier failed (${result.status}): ${result.stderr || result.stdout}`);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.totalBytes, 4 * 1024 * 1024);
  assert.equal(evidence.fileCount, 1);
  assert.ok(evidence.archiveSize > 0);
  assert.match(evidence.electron, /^42\./u);
});
