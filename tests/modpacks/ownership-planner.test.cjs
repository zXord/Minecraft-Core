const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeOwnershipManifest,
  planCrossProviderIdentity,
  planOwnership
} = require('../../electron/services/modpacks/planning/ownership-planner.cjs');

const hash = value => String(value).repeat(64).slice(0, 64);
const managed = (path, installedHash, extra = {}) => ({
  path, pathKey: path.toLocaleLowerCase('en-US'), origin: 'pack', managementPolicy: 'replaceable-managed',
  role: path.startsWith('mods/') ? 'mod' : 'configuration', installedHash, size: '1', priorBaseline: null, ...extra
});
const live = (path, sha256, extra = {}) => ({ path, pathKey: path.toLocaleLowerCase('en-US'), type: 'file', sha256, size: '1', ...extra });
const directory = (path, extra = {}) => ({ path, pathKey: path.toLocaleLowerCase('en-US'), type: 'directory', sha256: null, size: '0', ...extra });

test('similar provider names never merge source identity', () => {
  const modrinth = { provider: 'modrinth', projectId: 'same-name', title: 'Same Pack' };
  const github = { provider: 'github', repositoryId: '123', title: 'Same Pack' };
  assert.equal(planCrossProviderIdentity(modrinth, github, []), 'distinct');
  assert.equal(planCrossProviderIdentity(modrinth, github, [{
    type: 'provider-source-mapping', version: 1, modrinthProjectId: 'same-name', githubRepositoryId: '123',
    githubOwner: 'Owner', githubRepo: 'Repo'
  }]), 'same');
});

test('three-way ownership planning covers replace, preserve, conflict, remove, orphan, and missing-live repair', () => {
  const oldManifest = { schemaVersion: 1, installationId: 'old', entries: [
    managed('config/replace.toml', hash(1)),
    managed('config/mine.toml', hash(1)),
    managed('config/conflict.toml', hash(1)),
    managed('mods/remove.jar', hash(1)),
    managed('mods/orphan.jar', hash(1)),
    managed('mods/missing.jar', hash(1))
  ] };
  const liveSnapshot = { kind: 'existing', worldDirectories: ['world'], entries: [
    live('config/replace.toml', hash(1)),
    live('config/mine.toml', hash(2)),
    live('config/conflict.toml', hash(2)),
    live('mods/remove.jar', hash(1)),
    live('mods/orphan.jar', hash(2))
  ] };
  const incomingManifest = { schemaVersion: 1, installationId: 'new', entries: [
    managed('config/replace.toml', hash(3)),
    managed('config/mine.toml', hash(1)),
    managed('config/conflict.toml', hash(3)),
    managed('mods/missing.jar', hash(3)),
    managed('mods/new.jar', hash(4))
  ] };
  const plan = planOwnership({ oldManifest, liveSnapshot, incomingManifest, conflictChoices: {} });
  const actions = Object.fromEntries(plan.actions.map(item => [item.path, item.action]));
  assert.equal(actions['config/replace.toml'], 'replace');
  assert.equal(actions['config/mine.toml'], 'preserve-modified');
  assert.equal(actions['config/conflict.toml'], 'conflict');
  assert.equal(actions['mods/remove.jar'], 'remove');
  assert.equal(actions['mods/orphan.jar'], 'preserve-orphan');
  assert.equal(actions['mods/missing.jar'], 'restore-missing');
  assert.equal(actions['mods/new.jar'], 'add');
  assert.deepEqual(plan.conflicts.map(item => item.path), ['config/conflict.toml']);
  assert.deepEqual(plan.orphaned.map(item => item.path), ['mods/orphan.jar']);
  assert.equal(Object.isFrozen(plan), true);
});

test('every three-way hash row remains deterministic', () => {
  const rows = [
    { name: 'all-equal', liveHash: hash(1), incomingHash: hash(1), expected: 'unchanged' },
    { name: 'clean-update', liveHash: hash(1), incomingHash: hash(2), expected: 'replace' },
    { name: 'live-only-change', liveHash: hash(2), incomingHash: hash(1), expected: 'preserve-modified' },
    { name: 'same-converged-change', liveHash: hash(2), incomingHash: hash(2), expected: 'unchanged' },
    { name: 'divergent-change', liveHash: hash(2), incomingHash: hash(3), expected: 'conflict' }
  ];
  for (const row of rows) {
    const path = `config/${row.name}.toml`;
    const plan = planOwnership({
      oldManifest: { schemaVersion: 1, installationId: `old-${row.name}`, entries: [managed(path, hash(1))] },
      liveSnapshot: { kind: 'existing', entries: [live(path, row.liveHash)] },
      incomingManifest: { schemaVersion: 1, installationId: `new-${row.name}`, entries: [managed(path, row.incomingHash)] },
      conflictChoices: {}
    });
    assert.equal(plan.actions[0].action, row.expected, row.name);
  }
});

test('managed file type changes and file-ancestor collisions are explicit conflicts', () => {
  const oldManifest = { schemaVersion: 1, installationId: 'old', entries: [managed('config/managed.toml', hash(1))] };
  const incomingManifest = { schemaVersion: 1, installationId: 'new', entries: [managed('config/managed.toml', hash(1))] };
  const typeChanged = planOwnership({
    oldManifest,
    liveSnapshot: { kind: 'existing', entries: [directory('config/managed.toml')] },
    incomingManifest,
    conflictChoices: {}
  });
  assert.equal(typeChanged.actions[0].action, 'conflict');
  assert.equal(typeChanged.blocked[0].reason, 'managed-path-type-changed');

  const ancestorCollision = planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', entries: [live('config', hash(2), { origin: 'user' })] },
    incomingManifest: { schemaVersion: 1, installationId: 'new-ancestor', entries: [managed('config/new.toml', hash(3))] },
    conflictChoices: {}
  });
  assert.equal(ancestorCollision.actions.find(action => action.path === 'config/new.toml').action, 'conflict');
  assert.equal(ancestorCollision.blocked.some(action => action.reason === 'file-ancestor-collision'), true);
  assert.throws(() => planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', entries: [live('config', hash(2), { origin: 'user' })] },
    incomingManifest: { schemaVersion: 1, installationId: 'new-ancestor-choice', entries: [managed('config/new.toml', hash(3))] },
    conflictChoices: { paths: { 'config/new.toml': { choice: 'use-pack' } } }
  }), error => error.code === 'INVALID_REQUEST');

  const descendantCollision = planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', entries: [live('config/existing.toml', hash(2), { origin: 'user' })] },
    incomingManifest: { schemaVersion: 1, installationId: 'new-descendant', entries: [managed('config', hash(3))] },
    conflictChoices: {}
  });
  assert.equal(descendantCollision.actions.find(action => action.path === 'config').action, 'conflict');
  assert.equal(descendantCollision.blocked.some(action => action.reason === 'file-descendant-collision'), true);

  assert.throws(() => planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', entries: [directory('mods', { modId: 'not-a-file' })] },
    incomingManifest: { schemaVersion: 1, installationId: 'new-directory', entries: [] },
    conflictChoices: {}
  }), error => error.code === 'INVALID_REQUEST');
});

test('reserved state is rejected, pack EULA is ignored, and protected files seed only a new server', () => {
  const reserved = { schemaVersion: 1, installationId: 'incoming', entries: [managed('.minecraft-core-state/modpack.json', hash(1))] };
  assert.throws(() => planOwnership({ oldManifest: null, liveSnapshot: { kind: 'new', entries: [] }, incomingManifest: reserved, conflictChoices: {} }), error => error.code === 'INVALID_REQUEST');
  const incoming = { schemaVersion: 1, installationId: 'incoming', entries: [
    managed('eula.txt', hash(1)),
    managed('server.properties', hash(2), { managementPolicy: 'preserve-after-seed' }),
    managed('world/level.dat', hash(3), { managementPolicy: 'preserve-after-seed', role: 'world' })
  ] };
  const fresh = planOwnership({ oldManifest: null, liveSnapshot: { kind: 'new', worldDirectories: ['world'], entries: [] }, incomingManifest: incoming, conflictChoices: {} });
  assert.equal(fresh.actions.find(item => item.path === 'eula.txt').action, 'ignore-eula');
  assert.equal(fresh.actions.find(item => item.path === 'server.properties').action, 'seed-protected');
  const existing = planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', worldDirectories: ['world'], entries: [live('server.properties', hash(1)), live('world/level.dat', hash(1))] },
    incomingManifest: incoming,
    conflictChoices: {}
  });
  assert.equal(existing.actions.find(item => item.path === 'server.properties').action, 'conflict');
  assert.equal(existing.actions.find(item => item.path === 'world/level.dat').action, 'conflict');
});

test('user add-ons are preserved unless mod identity/runtime conflicts and choices are path-specific', () => {
  const incoming = { schemaVersion: 1, installationId: 'incoming', entries: [
    managed('mods/pack-a.jar', hash(3), { modId: 'shared-mod' }),
    managed('config/collision.toml', hash(3))
  ] };
  const snapshot = { kind: 'existing', worldDirectories: ['world'], entries: [
    live('mods/user.jar', hash(2), { origin: 'user', modId: 'shared-mod', runtimeCompatible: false }),
    live('config/collision.toml', hash(2), { origin: 'user' }),
    live('config/keep.toml', hash(2), { origin: 'user' })
  ] };
  const unresolved = planOwnership({ oldManifest: null, liveSnapshot: snapshot, incomingManifest: incoming, conflictChoices: {} });
  assert.equal(unresolved.actions.find(item => item.path === 'mods/user.jar').action, 'incompatible-user-addon');
  assert.equal(unresolved.actions.find(item => item.path === 'config/keep.toml').action, 'preserve-user-addon');
  const resolved = planOwnership({
    oldManifest: null,
    liveSnapshot: snapshot,
    incomingManifest: incoming,
    conflictChoices: {
      paths: { 'config/collision.toml': { choice: 'keep-both', alternatePath: 'config/pack-collision.toml' } }
    }
  });
  assert.equal(resolved.actions.find(item => item.path === 'config/collision.toml').action, 'keep-both');
  assert.equal(resolved.actions.find(item => item.path === 'config/collision.toml').incomingPath, 'config/pack-collision.toml');
  const worlds = { schemaVersion: 1, installationId: 'incoming-world', entries: [managed('world/level.dat', hash(3), { role: 'world' })] };
  assert.throws(() => planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', worldDirectories: ['world'], entries: [live('world/level.dat', hash(2))] },
    incomingManifest: worlds,
    conflictChoices: { categories: { world: 'use-pack' } }
  }), error => error.code === 'INVALID_REQUEST');
  const worldPlan = planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', worldDirectories: ['world'], entries: [live('world/level.dat', hash(2))] },
    incomingManifest: worlds,
    conflictChoices: {}
  });
  assert.equal(worldPlan.actions[0].action, 'conflict');
});

test('ownership schemas reject aliases, invalid policies, and accessor/coercion input', () => {
  assert.throws(() => normalizeOwnershipManifest({ schemaVersion: 1, installationId: 'x', entries: [managed('A/../b', hash(1))] }), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => normalizeOwnershipManifest({ schemaVersion: 1, installationId: 'x', entries: [managed('a', hash(1), { managementPolicy: 'anything' })] }), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => normalizeOwnershipManifest({
    schemaVersion: 1,
    installationId: 'x',
    entries: [managed('.minecraft-core-state/modpack.json', hash(1), { origin: 'application', managementPolicy: 'protected' })]
  }, { allowReserved: true }), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => normalizeOwnershipManifest({
    schemaVersion: 1,
    installationId: 'x',
    entries: [managed('config', hash(1)), managed('config/nested.toml', hash(2))]
  }), error => error.code === 'INVALID_REQUEST');
  for (const installationId of ['CON', 'manifest:stream']) {
    assert.throws(() => normalizeOwnershipManifest({ schemaVersion: 1, installationId, entries: [] }), error => error.code === 'INVALID_REQUEST');
  }
  let calls = 0;
  const manifest = { schemaVersion: 1, installationId: 'x', entries: [] };
  Object.defineProperty(manifest, 'entries', { enumerable: true, get() { calls += 1; return []; } });
  assert.throws(() => normalizeOwnershipManifest(manifest), error => error.code === 'INVALID_REQUEST');
  assert.equal(calls, 0);
});

test('protected conflict choices produce only actions backed by available file sources', () => {
  const protectedOld = { schemaVersion: 1, installationId: 'old', entries: [
    managed('server.properties', hash(1), { managementPolicy: 'protected' })
  ] };
  const removedUpstream = { schemaVersion: 1, installationId: 'new', entries: [] };
  const livePresent = { kind: 'existing', entries: [live('server.properties', hash(1))] };
  const acceptRemoval = planOwnership({
    oldManifest: protectedOld, liveSnapshot: livePresent, incomingManifest: removedUpstream,
    conflictChoices: { paths: { 'server.properties': { choice: 'use-pack' } } }
  });
  assert.equal(acceptRemoval.actions[0].action, 'remove');
  assert.throws(() => planOwnership({
    oldManifest: protectedOld, liveSnapshot: livePresent, incomingManifest: removedUpstream,
    conflictChoices: { paths: { 'server.properties': { choice: 'keep-both', alternatePath: 'server-pack.properties' } } }
  }), error => error.code === 'INVALID_REQUEST');

  const incomingPresent = { schemaVersion: 1, installationId: 'new', entries: [
    managed('server.properties', hash(2), { managementPolicy: 'protected' })
  ] };
  const liveMissing = { kind: 'existing', entries: [] };
  const acceptRestore = planOwnership({
    oldManifest: protectedOld, liveSnapshot: liveMissing, incomingManifest: incomingPresent,
    conflictChoices: { paths: { 'server.properties': { choice: 'use-pack' } } }
  });
  assert.equal(acceptRestore.actions[0].action, 'restore-missing');
  assert.throws(() => planOwnership({
    oldManifest: protectedOld, liveSnapshot: liveMissing, incomingManifest: incomingPresent,
    conflictChoices: { paths: { 'server.properties': { choice: 'keep-both', alternatePath: 'server-pack.properties' } } }
  }), error => error.code === 'INVALID_REQUEST');
});

test('user-owned protected files omitted by the next pack are preserved without a destructive conflict', () => {
  const oldManifest = { schemaVersion: 1, installationId: 'old', entries: [
    managed('world/minecraft-core-user.keep', hash(1), {
      origin: 'user', managementPolicy: 'protected', role: 'world'
    }),
    managed('config/user-added.toml', hash(2), {
      origin: 'user', managementPolicy: 'protected', role: 'configuration'
    })
  ] };
  const liveSnapshot = {
    kind: 'existing',
    worldDirectories: ['world'],
    entries: [
      live('world/minecraft-core-user.keep', hash(1), { origin: 'user' }),
      live('config/user-added.toml', hash(2), { origin: 'user' })
    ]
  };
  const incomingManifest = { schemaVersion: 1, installationId: 'new', entries: [] };

  const plan = planOwnership({ oldManifest, liveSnapshot, incomingManifest, conflictChoices: {} });

  assert.deepEqual(plan.actions.map(action => [action.path, action.action]), [
    ['config/user-added.toml', 'preserve-orphan'],
    ['world/minecraft-core-user.keep', 'preserve-orphan']
  ]);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.confirmation.worldsRetained, true);
  assert.throws(() => planOwnership({
    oldManifest,
    liveSnapshot,
    incomingManifest,
    conflictChoices: { paths: { 'world/minecraft-core-user.keep': { choice: 'use-pack' } } }
  }), error => error.code === 'INVALID_REQUEST');
});

test('application origin, default JVM arguments, and registered custom launch material stay protected', () => {
  const oldManifest = { schemaVersion: 1, installationId: 'old', entries: [
    managed('config/app-owned.json', hash(1), { origin: 'application', managementPolicy: 'replaceable-managed' }),
    managed('user_jvm_args.txt', hash(1)),
    managed('bin/custom-bootstrap.ps1', hash(1))
  ] };
  const liveSnapshot = {
    kind: 'existing',
    protectedPaths: ['bin/custom-bootstrap.ps1'],
    entries: [
      live('config/app-owned.json', hash(1)),
      live('user_jvm_args.txt', hash(1)),
      live('bin/custom-bootstrap.ps1', hash(1))
    ]
  };
  const plan = planOwnership({
    oldManifest, liveSnapshot,
    incomingManifest: { schemaVersion: 1, installationId: 'new', entries: [] },
    conflictChoices: {}
  });
  assert.deepEqual(plan.actions.map(action => action.action), ['conflict', 'conflict', 'conflict']);
  assert.equal(plan.actions.every(action => action.protected), true);
});

test('incompatible add-on decisions remain visible and can make the resulting server non-runnable', () => {
  const result = planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', entries: [live('mods/user-core.jar', hash(1), { origin: 'user', modId: 'core', runtimeCompatible: false })] },
    incomingManifest: { schemaVersion: 1, installationId: 'new', entries: [] },
    conflictChoices: { paths: { 'mods/user-core.jar': { choice: 'remove-addon' } } }
  });
  assert.equal(result.actions[0].action, 'remove-user-addon');
  assert.equal(result.userAddons[0].action, 'remove-user-addon');
  assert.equal(result.removed[0].action, 'remove-user-addon');
  assert.equal(result.confirmation.possibleNonRunnable, true);

  const disabled = planOwnership({
    oldManifest: null,
    liveSnapshot: { kind: 'existing', entries: [live('mods/user-core.jar', hash(1), { origin: 'user', modId: 'core', runtimeCompatible: false })] },
    incomingManifest: { schemaVersion: 1, installationId: 'new-disabled', entries: [] },
    conflictChoices: { paths: { 'mods/user-core.jar': { choice: 'disable-addon' } } }
  });
  assert.equal(disabled.actions[0].action, 'disable-user-addon');
  assert.equal(disabled.changed[0].action, 'disable-user-addon');
  assert.equal(disabled.userAddons[0].action, 'disable-user-addon');
  assert.equal(disabled.confirmation.possibleNonRunnable, true);
});

test('source identity validates all supplied mappings and rejects provider-inapplicable identity fields', () => {
  const modrinth = { provider: 'modrinth', projectId: 'project-1', title: 'Pack' };
  assert.throws(() => planCrossProviderIdentity(modrinth, { ...modrinth }, [{ bad: true }]), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => planCrossProviderIdentity(
    { provider: 'github', repositoryId: '123', projectId: 'not-applicable', title: 'Pack' },
    { provider: 'github', repositoryId: '123', title: 'Pack' },
    []
  ), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => planCrossProviderIdentity(
    { provider: 'modrinth', projectId: 'project-1', title: 'https://example.invalid' },
    { provider: 'modrinth', projectId: 'project-1', title: 'Pack' },
    []
  ), error => error.code === 'INVALID_REQUEST');
});

test('origin and management policy remain independent across every valid combination', () => {
  for (const origin of ['pack', 'runtime', 'user', 'application']) {
    for (const managementPolicy of ['replaceable-managed', 'preserve-after-seed', 'protected', 'ignored-rejected']) {
      const manifest = normalizeOwnershipManifest({
        schemaVersion: 1,
        installationId: `${origin}-${managementPolicy}`,
        entries: [managed(`config/${origin}-${managementPolicy}.toml`, hash(1), { origin, managementPolicy })]
      });
      assert.equal(manifest.entries[0].origin, origin);
      assert.equal(manifest.entries[0].managementPolicy, managementPolicy);
    }
  }
});

test('new equal-byte collisions stay user-owned until explicitly adopted', () => {
  const incoming = { schemaVersion: 1, installationId: 'new', entries: [managed('mods/shared.jar', hash(1))] };
  const snapshot = { kind: 'existing', entries: [live('mods/shared.jar', hash(1), { origin: 'user' })] };
  const unresolved = planOwnership({ oldManifest: null, liveSnapshot: snapshot, incomingManifest: incoming, conflictChoices: {} });
  assert.equal(unresolved.actions[0].action, 'conflict');
  const adopted = planOwnership({
    oldManifest: null, liveSnapshot: snapshot, incomingManifest: incoming,
    conflictChoices: { paths: { 'mods/shared.jar': { choice: 'use-pack' } } }
  });
  assert.equal(adopted.actions[0].action, 'replace');
});

test('targeted repair never replaces or restores pack files inside a custom-named world or a protected path', () => {
  // An earlier build recorded the files of a world named by level-name (and a
  // registered protected path) as replaceable pack files.
  const oldManifest = { schemaVersion: 1, installationId: 'installed', entries: [
    managed('bin/custom-bootstrap.cfg', hash(1), { role: 'other' }),
    managed('custom/region/r.0.0.mca', hash(1), { role: 'other' }),
    managed('mods/corrupt.jar', hash(1)),
    managed('worlds/survival-notes.txt', hash(1), { role: 'other' }),
    managed('worlds/survival/level.dat', hash(1), { role: 'other' })
  ] };
  const repair = entries => planOwnership({
    oldManifest,
    liveSnapshot: {
      kind: 'existing',
      worldDirectories: ['custom', 'world', 'world_nether', 'world_the_end', 'worlds/survival'],
      protectedPaths: ['bin/custom-bootstrap.cfg'],
      entries
    },
    incomingManifest: { ...oldManifest, installationId: 'repair-desired' },
    operationKind: 'repair',
    conflictChoices: {}
  });
  const decision = (plan, pathValue) => {
    const action = plan.actions.find(item => item.path === pathValue);
    return [action.action, action.reason, action.protected];
  };

  const played = repair([
    live('bin/custom-bootstrap.cfg', hash(2)),
    live('custom/region/r.0.0.mca', hash(2)),
    live('mods/corrupt.jar', hash(2)),
    live('worlds/survival-notes.txt', hash(2)),
    live('worlds/survival/level.dat', hash(2))
  ]);
  for (const pathValue of ['bin/custom-bootstrap.cfg', 'custom/region/r.0.0.mca', 'worlds/survival/level.dat']) {
    assert.deepEqual(decision(played, pathValue), ['preserve-modified', 'user-content-preserved', true], pathValue);
  }
  assert.deepEqual(decision(played, 'mods/corrupt.jar'), ['replace', 'managed-file-corrupt', false]);
  // Only the world folder itself and what sits under it; a sibling that shares its name prefix stays managed.
  assert.deepEqual(decision(played, 'worlds/survival-notes.txt'), ['replace', 'managed-file-corrupt', false]);
  assert.deepEqual(played.blocked, []);

  const missing = repair([live('mods/corrupt.jar', hash(2))]);
  for (const pathValue of ['bin/custom-bootstrap.cfg', 'custom/region/r.0.0.mca', 'worlds/survival/level.dat']) {
    assert.deepEqual(decision(missing, pathValue), ['absent', 'user-content-absent', true], pathValue);
  }
  assert.deepEqual(decision(missing, 'worlds/survival-notes.txt'), ['restore-missing', 'managed-file-missing', false]);

  const unchanged = repair([
    live('bin/custom-bootstrap.cfg', hash(1)),
    live('custom/region/r.0.0.mca', hash(1)),
    live('mods/corrupt.jar', hash(2)),
    live('worlds/survival-notes.txt', hash(1)),
    live('worlds/survival/level.dat', hash(1))
  ]);
  for (const pathValue of ['bin/custom-bootstrap.cfg', 'custom/region/r.0.0.mca', 'worlds/survival/level.dat']) {
    assert.deepEqual(decision(unchanged, pathValue), ['unchanged', 'user-content-unchanged', true], pathValue);
  }
  assert.deepEqual(decision(unchanged, 'worlds/survival-notes.txt'), ['unchanged', 'live-equals-installed-baseline', false]);
  assert.deepEqual(decision(unchanged, 'mods/corrupt.jar'), ['replace', 'managed-file-corrupt', false]);
});

test('keep-both rejects protected, cross-directory, extension-changing, occupied, and alias targets', () => {
  const incoming = { schemaVersion: 1, installationId: 'new', entries: [managed('config/collision.toml', hash(2))] };
  const snapshot = { kind: 'existing', entries: [
    live('config/collision.toml', hash(1), { origin: 'user' }),
    live('config/existing.toml', hash(1), { origin: 'user' })
  ] };
  for (const alternatePath of [
    'server.properties', 'mods/collision.toml', 'config/collision.json', 'config/existing.toml',
    '.minecraft-core-state/collision.toml', 'eula.txt', 'world/collision.toml'
  ]) {
    assert.throws(() => planOwnership({
      oldManifest: null, liveSnapshot: snapshot, incomingManifest: incoming,
      conflictChoices: { paths: { 'config/collision.toml': { choice: 'keep-both', alternatePath } } }
    }), error => error.code === 'INVALID_REQUEST');
  }
  assert.throws(() => planOwnership({
    oldManifest: null, liveSnapshot: snapshot, incomingManifest: incoming,
    conflictChoices: {
      paths: {
        'config/collision.toml': { choice: 'keep-mine' },
        'CONFIG/COLLISION.TOML': { choice: 'use-pack' }
      }
    }
  }), error => error.code === 'INVALID_REQUEST');
});
