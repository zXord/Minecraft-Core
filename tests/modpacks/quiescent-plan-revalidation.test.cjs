const assert = require('node:assert/strict');
const test = require('node:test');

const {
  reconcileQuiescentOwnership
} = require('../../electron/services/modpacks/planning/quiescent-plan-revalidation.cjs');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function condition(path, sha256 = HASH_A) {
  return {
    path,
    pathKey: path.toLocaleLowerCase('en-US'),
    exists: true,
    type: 'file',
    size: '1',
    sha256,
    dev: '1',
    ino: '2',
    birthtime: '3'
  };
}

function action(path, actionName, role = 'other', extra = {}) {
  return {
    path,
    pathKey: path.toLocaleLowerCase('en-US'),
    action: actionName,
    reason: 'fixture',
    role,
    protected: role === 'world',
    ...extra
  };
}

function ownership(actions) {
  return { actions, blocked: actions.filter(item => item.action === 'conflict') };
}

function manifest(paths, origin = 'pack') {
  return {
    schemaVersion: 1,
    installationId: 'fixture-installation',
    entries: paths.map(path => ({ path, pathKey: path.toLocaleLowerCase('en-US'), origin }))
  };
}

test('graceful shutdown world rewrites and new world data are rebased as preservation-only changes', () => {
  const reviewed = ownership([
    action('world/level.dat', 'preserve-orphan', 'world'),
    action('world/session.lock', 'preserve-orphan', 'world')
  ]);
  const current = ownership([
    action('world/level.dat', 'preserve-orphan', 'world'),
    action('world/region/r.0.0.mca', 'preserve-user-addon', 'world')
  ]);

  assert.equal(reconcileQuiescentOwnership({
    reviewedOwnership: reviewed,
    currentOwnership: current,
    reviewedPathPreconditions: [condition('world/level.dat'), condition('world/session.lock')],
    currentPathPreconditions: [condition('world/level.dat', HASH_B), condition('world/region/r.0.0.mca', HASH_B)]
  }), current);
});

test('preserved user world entries recorded by an earlier lifecycle remain rebaseable', () => {
  const reviewed = ownership([
    action('world/level.dat', 'preserve-modified', 'world')
  ]);
  const current = ownership([
    action('world/level.dat', 'preserve-modified', 'world')
  ]);

  assert.equal(reconcileQuiescentOwnership({
    reviewedOwnership: reviewed,
    currentOwnership: current,
    reviewedPathPreconditions: [condition('world/level.dat')],
    currentPathPreconditions: [condition('world/level.dat', HASH_B)],
    oldManifest: manifest(['world/level.dat'], 'user')
  }), current);
});

test('post-review datapack changes remain strict while ordinary world saves are rebaseable', () => {
  for (const datapackPath of [
    'world/datapacks/admin-tools.zip',
    'world/datapacks/admin-tools/data/core/functions/load.mcfunction',
    'world/datapacks/admin-tools/data/minecraft/tags/functions/load.json'
  ]) {
    const reviewed = ownership([
      action(datapackPath, 'preserve-modified', 'world'),
      action('world/region/r.0.0.mca', 'preserve-modified', 'world')
    ]);
    const current = ownership([
      action(datapackPath, 'preserve-modified', 'world'),
      action('world/region/r.0.0.mca', 'preserve-modified', 'world')
    ]);

    assert.throws(() => reconcileQuiescentOwnership({
      reviewedOwnership: reviewed,
      currentOwnership: current,
      reviewedPathPreconditions: [condition(datapackPath), condition('world/region/r.0.0.mca')],
      currentPathPreconditions: [condition(datapackPath, HASH_B), condition('world/region/r.0.0.mca', HASH_B)],
      oldManifest: manifest([datapackPath, 'world/region/r.0.0.mca'], 'user')
    }), error => error?.code === 'PLAN_STALE', datapackPath);
  }
});

test('a post-review datapack is never admitted as passive world save churn', () => {
  const datapackPath = 'custom-level/datapacks/new-pack/data/core/functions/tick.mcfunction';

  assert.throws(() => reconcileQuiescentOwnership({
    worldDirectories: ['custom-level'],
    reviewedOwnership: ownership([]),
    currentOwnership: ownership([action(datapackPath, 'preserve-user-addon', 'world')]),
    reviewedPathPreconditions: [],
    currentPathPreconditions: [condition(datapackPath)]
  }), error => error?.code === 'PLAN_STALE');
});

test('datapacks-named and nested custom worlds can save while their actual datapacks remain strict', () => {
  for (const worldRoot of ['datapacks', 'saves/datapacks']) {
    const savePath = `${worldRoot}/region/r.0.0.mca`;
    const reviewed = ownership([action(savePath, 'preserve-modified', 'world')]);
    const current = ownership([action(savePath, 'preserve-modified', 'world')]);

    assert.equal(reconcileQuiescentOwnership({
      worldDirectories: [worldRoot],
      reviewedOwnership: reviewed,
      currentOwnership: current,
      reviewedPathPreconditions: [condition(savePath)],
      currentPathPreconditions: [condition(savePath, HASH_B)]
    }), current);

    const nestedPackPath = `${worldRoot}/datapacks/admin-tools.zip`;
    assert.throws(() => reconcileQuiescentOwnership({
      worldDirectories: [worldRoot],
      reviewedOwnership: ownership([action(nestedPackPath, 'preserve-modified', 'world')]),
      currentOwnership: ownership([action(nestedPackPath, 'preserve-modified', 'world')]),
      reviewedPathPreconditions: [condition(nestedPackPath)],
      currentPathPreconditions: [condition(nestedPackPath, HASH_B)]
    }), error => error?.code === 'PLAN_STALE', worldRoot);
  }
});

test('a datapacks-named custom dimension is ordinary world churn, not a world datapack root', () => {
  const regionPath = 'world/dimensions/datapacks/my_dimension/region/r.0.0.mca';
  const reviewed = ownership([action(regionPath, 'preserve-modified', 'world')]);
  const current = ownership([action(regionPath, 'preserve-modified', 'world')]);

  assert.equal(reconcileQuiescentOwnership({
    worldDirectories: ['world'],
    reviewedOwnership: reviewed,
    currentOwnership: current,
    reviewedPathPreconditions: [condition(regionPath)],
    currentPathPreconditions: [condition(regionPath, HASH_B)]
  }), current);
});

test('changing the level root cannot make a reviewed old-root datapack rebaseable', () => {
  const propertiesPath = 'server.properties';
  const datapackPath = 'old-world/datapacks/admin-tools.zip';
  const reviewed = ownership([
    action(propertiesPath, 'preserve-modified', 'configuration'),
    action(datapackPath, 'preserve-modified', 'world')
  ]);
  const current = ownership([
    action(propertiesPath, 'preserve-modified', 'configuration'),
    action(datapackPath, 'preserve-modified', 'world')
  ]);

  assert.throws(() => reconcileQuiescentOwnership({
    worldDirectories: ['new-world'],
    reviewedOwnership: reviewed,
    currentOwnership: current,
    reviewedPathPreconditions: [condition(propertiesPath), condition(datapackPath)],
    currentPathPreconditions: [condition(propertiesPath, HASH_B), condition(datapackPath, HASH_B)],
    oldManifest: manifest([propertiesPath, datapackPath], 'user')
  }), error => error?.code === 'PLAN_STALE');
});

test('incoming paths remain strict even if malformed provenance labels them as user data', () => {
  const reviewed = ownership([
    action('world/level.dat', 'preserve-modified', 'world')
  ]);
  const current = ownership([
    action('world/level.dat', 'preserve-modified', 'world')
  ]);

  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: reviewed,
    currentOwnership: current,
    reviewedPathPreconditions: [condition('world/level.dat')],
    currentPathPreconditions: [condition('world/level.dat', HASH_B)],
    oldManifest: manifest(['world/level.dat'], 'user'),
    incomingManifest: manifest(['world/level.dat'], 'user')
  }), error => error?.code === 'PLAN_STALE');
});

test('a changed or newly introduced executable is never silently rebased', () => {
  const reviewed = ownership([action('mods/pack.jar', 'preserve-user-addon', 'mod')]);
  const current = ownership([action('mods/pack.jar', 'preserve-user-addon', 'mod')]);
  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: reviewed,
    currentOwnership: current,
    reviewedPathPreconditions: [condition('mods/pack.jar')],
    currentPathPreconditions: [condition('mods/pack.jar', HASH_B)]
  }), error => error?.code === 'PLAN_STALE');

  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: ownership([]),
    currentOwnership: ownership([action('plugins/new-plugin.jar', 'preserve-user-addon', 'other')]),
    reviewedPathPreconditions: [],
    currentPathPreconditions: [condition('plugins/new-plugin.jar')]
  }), error => error?.code === 'PLAN_STALE');
});

test('a newly blocked conflict or a newly destructive decision requires a fresh review', () => {
  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: ownership([action('config/pack.toml', 'unchanged', 'configuration')]),
    currentOwnership: ownership([action('config/pack.toml', 'conflict', 'configuration')]),
    reviewedPathPreconditions: [condition('config/pack.toml')],
    currentPathPreconditions: [condition('config/pack.toml', HASH_B)]
  }), error => error?.code === 'PLAN_STALE');

  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: ownership([action('config/user.toml', 'preserve-modified', 'configuration')]),
    currentOwnership: ownership([action('config/user.toml', 'replace', 'configuration')]),
    reviewedPathPreconditions: [condition('config/user.toml')],
    currentPathPreconditions: [condition('config/user.toml', HASH_B)]
  }), error => error?.code === 'PLAN_STALE');
});

test('managed paths stay strict even when their decision is unchanged, and preservation is never broadened to scripts', () => {
  const reviewedReplace = ownership([action('config/pack.toml', 'replace', 'configuration')]);
  const currentReplace = ownership([action('config/pack.toml', 'replace', 'configuration')]);
  const sameBytesNewIdentity = { ...condition('config/pack.toml'), ino: '9', birthtime: '9' };
  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: reviewedReplace,
    currentOwnership: currentReplace,
    reviewedPathPreconditions: [condition('config/pack.toml')],
    currentPathPreconditions: [sameBytesNewIdentity],
    incomingManifest: manifest(['config/pack.toml'])
  }), error => error?.code === 'PLAN_STALE');

  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: ownership([action('kubejs/server_scripts/rules.js', 'preserve-user-addon')]),
    currentOwnership: ownership([action('kubejs/server_scripts/rules.js', 'preserve-user-addon')]),
    reviewedPathPreconditions: [condition('kubejs/server_scripts/rules.js')],
    currentPathPreconditions: [condition('kubejs/server_scripts/rules.js', HASH_B)]
  }), error => error?.code === 'PLAN_STALE');
});
