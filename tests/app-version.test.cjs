const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '../electron/utils/app-version.cjs');
const RELATION_PATH = path.resolve(__dirname, '../src/utils/version/appVersionRelation.js');
const { compareAppVersions, parseAppVersion } = require(MODULE_PATH);

const RELATION_BY_ORDER = new Map([[-1, 'client-older'], [0, 'equal'], [1, 'client-newer'], [null, 'unknown']]);
const SPAWN_METHODS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const WRITE_METHODS = ['appendFile', 'chmod', 'copyFile', 'cp', 'link', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir',
  'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'];

// [client version, host version, compareAppVersions(client, host)]
const VECTORS = [
  ['26.11.1', '26.6.1', 1],
  ['26.6.1', '26.11.1', -1],
  ['26.6.1', '26.6.1', 0],
  ['26.11.1', '26.11.1', 0],
  ['26.7.0-beta.1', '26.7.0', -1],
  ['26.7.0', '26.7.0-beta.1', 1],
  ['26.7.0-beta.1', '26.7.0-beta.1', 0],
  ['26.7.0-beta.2', '26.7.0-beta.10', -1],
  ['26.7.0-alpha', '26.7.0-beta', -1],
  ['26.7.0-1', '26.7.0-alpha', -1],
  ['26.7.0-beta', '26.7.0-beta.1', -1],
  ['26.10.1', '26.9.9', 1],
  ['26.12.1', '27.1.1', -1],
  ['26.6.10', '26.6.9', 1],
  ['0.0.0', '0.0.0', 0],
  ['26.06.1', '26.6.1', null],
  ['26.6.1', '26.06.1', null],
  ['v26.11.1', '26.11.1', null],
  ['26.11.1', 'v26.11.1', null],
  ['26.11', '26.11.1', null],
  ['26.11.1', '26.11', null],
  ['26.11.1.0', '26.11.1', null],
  ['026.11.1', '26.11.1', null],
  ['26.11.1+build.7', '26.11.1', null],
  ['26.11.1-', '26.11.1', null],
  ['26.11.1-beta..1', '26.11.1', null],
  ['26.11.1-beta.01', '26.11.1', null],
  ['26.11.1-beta_1', '26.11.1', null],
  [' 26.11.1', '26.11.1', null],
  ['26.11.1\n', '26.11.1', null],
  ['\uFF12\uFF16.11.1', '26.11.1', null],
  ['9007199254740992.0.0', '1.0.0', null],
  [`26.11.1-${'a'.repeat(300)}`, '26.11.1', null],
  ['', '26.11.1', null],
  [null, '26.11.1', null],
  ['26.11.1', undefined, null],
  [26.11, '26.11.1', null]
];

// Ascending precedence, including the Semantic Versioning 2.0.0 prerelease examples.
const ASCENDING = [
  '0.0.0', '0.0.1', '0.1.0', '1.0.0-0', '1.0.0-1', '1.0.0-2', '1.0.0-10', '1.0.0-alpha', '1.0.0-alpha.1',
  '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '26.6.1',
  '26.7.0-beta.1', '26.7.0', '26.9.1', '26.10.1', '26.11.1', '26.12.1', '27.1.1'
];

function loadRelation(query = '') {
  return import(`${pathToFileURL(RELATION_PATH).href}${query}`);
}

function spyOnSideEffects(t) {
  const effects = [];
  const refuse = label => () => {
    effects.push(label);
    throw new Error(`${label} is not allowed here`);
  };
  for (const name of SPAWN_METHODS) t.mock.method(childProcess, name, refuse(`child_process.${name}`));
  for (const name of WRITE_METHODS) {
    t.mock.method(fs, name, refuse(`fs.${name}`));
    t.mock.method(fs, `${name}Sync`, refuse(`fs.${name}Sync`));
    t.mock.method(fs.promises, name, refuse(`fs.promises.${name}`));
  }
  t.mock.method(fs, 'createWriteStream', refuse('fs.createWriteStream'));
  return effects;
}

test('one vector table drives the main-process comparison and the renderer relation', async () => {
  const { relateAppVersions } = await loadRelation();
  for (const [client, host, expected] of VECTORS) {
    const label = `${JSON.stringify(client)} vs ${JSON.stringify(host)}`;
    assert.equal(compareAppVersions(client, host), expected, label);
    assert.equal(relateAppVersions(client, host), RELATION_BY_ORDER.get(expected), label);
  }
});

test('the precedence ladder is ordered identically by both helpers', async () => {
  const { relateAppVersions } = await loadRelation();
  for (let left = 0; left < ASCENDING.length; left += 1) {
    for (let right = 0; right < ASCENDING.length; right += 1) {
      const expected = Math.sign(left - right);
      const label = `${ASCENDING[left]} vs ${ASCENDING[right]}`;
      assert.equal(compareAppVersions(ASCENDING[left], ASCENDING[right]), expected, label);
      assert.equal(relateAppVersions(ASCENDING[left], ASCENDING[right]), RELATION_BY_ORDER.get(expected), label);
    }
  }
});

test('parseAppVersion returns frozen numeric parts and prerelease identifiers', () => {
  const release = parseAppVersion('26.11.1');
  assert.deepEqual(release, { version: '26.11.1', major: 26, minor: 11, patch: 1, prerelease: [] });
  assert.equal(Object.isFrozen(release), true);
  assert.equal(Object.isFrozen(release.prerelease), true);
  assert.deepEqual(parseAppVersion('26.7.0-beta.1'), {
    version: '26.7.0-beta.1', major: 26, minor: 7, patch: 0, prerelease: ['beta', '1']
  });
  for (const [client, host, expected] of VECTORS) {
    if (expected !== null) continue;
    assert.equal(parseAppVersion(client) === null || parseAppVersion(host) === null, true, `${client} / ${host}`);
  }
  for (const invalid of ['26.06.1', 'v26.11.1', '26.11', '', null, {}, ['26.11.1']]) {
    assert.equal(parseAppVersion(invalid), null, JSON.stringify(invalid));
  }
});

test('the renderer helper is self-contained and imports no logger', () => {
  const source = fs.readFileSync(RELATION_PATH, 'utf8');
  assert.doesNotMatch(source, /^\s*import\b/mu);
  assert.doesNotMatch(source, /\bimport\s*\(/u);
  assert.doesNotMatch(source, /\brequire\s*\(/u);
  assert.doesNotMatch(source, /logger/iu);
});

test('loading either helper spawns no process and writes nothing', async t => {
  const effects = spyOnSideEffects(t);
  delete require.cache[MODULE_PATH];
  const fresh = require(MODULE_PATH);
  const relation = await loadRelation(`?side-effects=${process.pid}-${Date.now()}`);
  assert.equal(fresh.compareAppVersions('26.11.1', '26.6.1'), 1);
  assert.equal(relation.relateAppVersions('26.11.1', '26.6.1'), 'client-newer');
  assert.deepEqual(effects, []);
});
