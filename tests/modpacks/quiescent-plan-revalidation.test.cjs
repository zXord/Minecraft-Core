const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPassivePathFilter,
  exactWorldPathKeys,
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

test('user data a running-server review could not read is rebased once the stopped server preserves it', () => {
  // A review of a running server leaves out the world lock the server holds and
  // a level.dat it is saving. An earlier lifecycle recorded both as the user's
  // files, so the review decides `absent`; after the stop both are present again.
  const reviewed = ownership([
    action('world/level.dat', 'absent', 'world'),
    action('world/session.lock', 'absent', 'world')
  ]);
  const current = ownership([
    action('world/level.dat', 'preserve-orphan', 'world'),
    action('world/session.lock', 'preserve-orphan', 'world')
  ]);

  assert.equal(reconcileQuiescentOwnership({
    reviewedOwnership: reviewed,
    currentOwnership: current,
    reviewedPathPreconditions: [],
    currentPathPreconditions: [condition('world/level.dat', HASH_B), condition('world/session.lock')],
    oldManifest: manifest(['world/level.dat', 'world/session.lock'], 'user')
  }), current);
});

test('a repair keeps every recorded path exact, the user world included', () => {
  // A repair's desired manifest names every installed entry, so a recorded world
  // file its review could not read, or read before a save, is never rebased.
  const recorded = manifest(['world/region/r.0.0.mca', 'world/session.lock'], 'user');
  for (const [pathKey, reviewedAction, currentAction] of [
    ['world/session.lock', 'absent', 'unchanged'],
    ['world/region/r.0.0.mca', 'unchanged', 'preserve-modified']
  ]) {
    assert.throws(() => reconcileQuiescentOwnership({
      reviewedOwnership: ownership([action(pathKey, reviewedAction, 'world')]),
      currentOwnership: ownership([action(pathKey, currentAction, 'world')]),
      reviewedPathPreconditions: reviewedAction === 'absent' ? [] : [condition(pathKey)],
      currentPathPreconditions: [condition(pathKey, HASH_B)],
      oldManifest: recorded,
      incomingManifest: recorded
    }), error => error?.code === 'PLAN_STALE', pathKey);
  }
});

test('an unchanged decision is never rebased, since only a repair makes one for user data', () => {
  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: ownership([action('world/region/r.0.0.mca', 'unchanged', 'world')]),
    currentOwnership: ownership([action('world/region/r.0.0.mca', 'preserve-modified', 'world')]),
    reviewedPathPreconditions: [condition('world/region/r.0.0.mca')],
    currentPathPreconditions: [condition('world/region/r.0.0.mca', HASH_B)],
    oldManifest: manifest(['world/region/r.0.0.mca'], 'user')
  }), error => error?.code === 'PLAN_STALE');
});

test('an unread path never rebases into a removal, a managed decision or a datapack', () => {
  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: ownership([action('mods/pack.jar', 'absent', 'mod')]),
    currentOwnership: ownership([action('mods/pack.jar', 'remove', 'mod')]),
    reviewedPathPreconditions: [],
    currentPathPreconditions: [condition('mods/pack.jar')],
    oldManifest: manifest(['mods/pack.jar'])
  }), error => error?.code === 'PLAN_STALE');

  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: ownership([action('config/pack.toml', 'absent', 'configuration')]),
    currentOwnership: ownership([action('config/pack.toml', 'unchanged', 'configuration')]),
    reviewedPathPreconditions: [],
    currentPathPreconditions: [condition('config/pack.toml')],
    incomingManifest: manifest(['config/pack.toml'])
  }), error => error?.code === 'PLAN_STALE');

  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: ownership([action('world/datapacks/tools.zip', 'absent', 'world')]),
    currentOwnership: ownership([action('world/datapacks/tools.zip', 'preserve-orphan', 'world')]),
    reviewedPathPreconditions: [],
    currentPathPreconditions: [condition('world/datapacks/tools.zip')],
    oldManifest: manifest(['world/datapacks/tools.zip'], 'user')
  }), error => error?.code === 'PLAN_STALE');

  assert.throws(() => reconcileQuiescentOwnership({
    reviewedOwnership: ownership([action('world/level.dat', 'absent', 'world')]),
    currentOwnership: ownership([action('world/level.dat', 'replace', 'world')]),
    reviewedPathPreconditions: [],
    currentPathPreconditions: [condition('world/level.dat')],
    oldManifest: manifest(['world/level.dat'], 'user')
  }), error => error?.code === 'PLAN_STALE');
});

test('the passive-path filter a running-server review uses is the rebase rule before any decision exists', () => {
  const passive = createPassivePathFilter({
    oldManifest: {
      schemaVersion: 1,
      installationId: 'installed-one',
      entries: [
        { path: 'config/pack.json', pathKey: 'config/pack.json', origin: 'pack', role: 'configuration' },
        { path: 'world/level.dat', pathKey: 'world/level.dat', origin: 'user', role: 'world' },
        // A recorded runtime role stays strict wherever an earlier lifecycle kept it.
        { path: 'shared/loader.bin', pathKey: 'shared/loader.bin', origin: 'user', role: 'runtime' }
      ]
    },
    incomingManifest: manifest(['config/next.json']),
    worldDirectories: ['adventure', 'world', 'world_nether', 'world_the_end']
  });

  for (const pathKey of [
    'world/level.dat', 'world/session.lock', 'world/region/r.0.0.mca', 'world/dimensions/datapacks/x/region/r.0.0.mca',
    'logs/latest.log', 'crash-reports/crash.txt', 'usercache.json', 'config/runtime-cache.json', 'adventure/level.dat'
  ]) assert.equal(passive(pathKey), true, pathKey);
  for (const pathKey of [
    'config', 'config/pack.json', 'config/next.json', 'shared/loader.bin', 'mods/user.jar', 'libraries/x/y.jar',
    '.fabric/remapped.jar', 'server.properties', 'start.bat', 'world/datapacks', 'world/datapacks/tools.zip',
    'adventure/datapacks/tools.zip', 'kubejs/server_scripts/rules.js', 'eula.txt'
  ]) assert.equal(passive(pathKey), false, pathKey);
});

test('the recorded world files a commit holds exact are the pack ones and every incoming one, never the user ones', () => {
  const worldDirectories = ['adventure', 'world', 'world_nether', 'world_the_end'];
  const installed = {
    schemaVersion: 1,
    installationId: 'installed-one',
    entries: [
      { path: 'Adventure/region/r.0.0.mca', pathKey: 'adventure/region/r.0.0.mca', origin: 'pack' },
      { path: 'config/pack.json', pathKey: 'config/pack.json', origin: 'pack' },
      { path: 'world/level.dat', pathKey: 'world/level.dat', origin: 'pack' },
      { path: 'world/session.lock', pathKey: 'world/session.lock', origin: 'user' },
      { path: 'world_backup/level.dat', pathKey: 'world_backup/level.dat', origin: 'pack' }
    ]
  };
  const userWorld = manifest(['world/level.dat', 'world/session.lock'], 'user');

  // An uninstall holds the files the pack seeded in its worlds exact.
  assert.deepEqual(exactWorldPathKeys({ oldManifest: installed, worldDirectories }),
    ['adventure/region/r.0.0.mca', 'world/level.dat']);
  // A repair names every installed entry, the user world included.
  assert.deepEqual(exactWorldPathKeys({ oldManifest: installed, incomingManifest: installed, worldDirectories }),
    ['adventure/region/r.0.0.mca', 'world/level.dat', 'world/session.lock']);
  // An update holds exact a world file the release ships, whoever recorded it before.
  assert.deepEqual(exactWorldPathKeys({
    oldManifest: userWorld, incomingManifest: manifest(['config/next.json', 'world_nether/DIM-1/level.dat']), worldDirectories
  }), ['world_nether/dim-1/level.dat']);
  assert.deepEqual(exactWorldPathKeys({ oldManifest: userWorld, incomingManifest: manifest(['config/next.json']), worldDirectories }), []);
  assert.deepEqual(exactWorldPathKeys({ worldDirectories }), []);
});
