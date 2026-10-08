const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  getDefaultServerConfig,
  readServerConfig,
  updateServerConfig,
  writeServerConfig
} = require('../electron/utils/config-manager.cjs');
const {
  bumpContentRevision,
  readContentRevision
} = require('../electron/services/server-content-revision.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');

function fixture(t, { failFlush = false } = {}) {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-revision-'));
  const durableClient = {
    moveWriteThrough(sourcePath, destinationPath) {
      fs.renameSync(sourcePath, destinationPath);
    },
    replaceFileWriteThrough(sourcePath, destinationPath) {
      fs.renameSync(sourcePath, destinationPath);
    },
    flushDirectory() {
      if (failFlush) throw new Error('injected directory flush failure');
    }
  };
  let sequence = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient,
    allowedRoots: [serverPath],
    tempNameFactory: () => `revision-${++sequence}`
  });
  const configPath = path.join(serverPath, '.minecraft-core.json');
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  return { serverPath, configPath, durableFs };
}

test('missing legacy contentRevision normalizes to zero', (t) => {
  const { serverPath, configPath } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ version: '1.21.1', custom: 'kept' }));

  assert.equal(getDefaultServerConfig().contentRevision, 0);
  assert.equal(readServerConfig(serverPath).contentRevision, 0);
  assert.equal(readServerConfig(serverPath).custom, 'kept');
  assert.equal(readContentRevision(serverPath), 0);
});

test('server config persists only the supported network-access policy', (t) => {
  const { serverPath, configPath } = fixture(t);
  assert.equal(getDefaultServerConfig().networkAccess, 'pack-default');
  assert.equal(getDefaultServerConfig({ networkAccess: 'loopback' }).networkAccess, 'loopback');

  fs.writeFileSync(configPath, JSON.stringify({ networkAccess: 'loopback' }));
  assert.equal(readServerConfig(serverPath).networkAccess, 'loopback');

  fs.writeFileSync(configPath, JSON.stringify({ networkAccess: 'public' }));
  assert.equal(readServerConfig(serverPath).networkAccess, 'pack-default');
});

test('ordinary config writes preserve the current revision and unknown keys', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 4, custom: { keep: true }, maxRam: 4 }));

  const written = writeServerConfig(
    serverPath,
    { contentRevision: 4, custom: { keep: true }, maxRam: 8 },
    {},
    { durableFs }
  );

  assert.equal(written.contentRevision, 4);
  assert.deepEqual(written.custom, { keep: true });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).contentRevision, 4);
});

test('a semantically unchanged complete config update preserves the exact file bytes', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  const current = {
    ...getDefaultServerConfig(),
    contentRevision: 4,
    managementInviteHost: '',
    managementInviteSecret: 'existing-secret',
    custom: { keep: true }
  };
  const original = `${JSON.stringify(current, null, 2)}\n`;
  fs.writeFileSync(configPath, original);
  const oldTime = new Date('2020-01-02T03:04:05.000Z');
  fs.utimesSync(configPath, oldTime, oldTime);

  const result = updateServerConfig(serverPath, {
    managementInviteHost: '',
    managementInviteSecret: 'existing-secret'
  }, {}, { durableFs });

  assert.equal(result.contentRevision, 4);
  assert.deepEqual(result.custom, { keep: true });
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  assert.equal(fs.statSync(configPath).mtimeMs, oldTime.getTime());
});

test('a semantically unchanged config update rejects a target changed after its bounded read', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  const current = {
    ...getDefaultServerConfig(),
    contentRevision: 4,
    managementInviteHost: '',
    managementInviteSecret: 'existing-secret'
  };
  fs.writeFileSync(configPath, JSON.stringify(current));
  let raced = false;
  const racingDurableFs = {
    ...durableFs,
    readFileBounded(filePath, options) {
      const bytes = durableFs.readFileBounded(filePath, options);
      if (!raced) {
        raced = true;
        fs.writeFileSync(configPath, JSON.stringify({
          ...current,
          managementInviteHost: 'external.example'
        }));
      }
      return bytes;
    }
  };

  assert.throws(
    () => updateServerConfig(serverPath, {
      managementInviteHost: '',
      managementInviteSecret: 'existing-secret'
    }, {}, { durableFs: racingDurableFs }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).managementInviteHost, 'external.example');
});

test('renderer-style writes cannot raise or lower contentRevision directly', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 4, maxRam: 4 }));

  assert.throws(
    () => writeServerConfig(serverPath, { contentRevision: 5, maxRam: 8 }, {}, { durableFs }),
    error => error.code === 'PLAN_STALE'
  );
  assert.throws(
    () => updateServerConfig(serverPath, { contentRevision: 3 }, {}, { durableFs }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).contentRevision, 4);
});

test('compare-and-set rejects a stale expected revision without writing', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  const original = JSON.stringify({ contentRevision: 7, maxRam: 4 });
  fs.writeFileSync(configPath, original);

  assert.throws(
    () => updateServerConfig(serverPath, { maxRam: 8 }, {}, {
      durableFs,
      expectedContentRevision: 6
    }),
    error => error.code === 'PLAN_STALE'
  );

  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('lifecycle override requires exact old plus one', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 2, custom: 'kept' }));

  for (const nextContentRevision of [2, 4, -1, 1.5, '3']) {
    assert.throws(
      () => updateServerConfig(serverPath, { maxRam: 8 }, {}, {
        durableFs,
        expectedContentRevision: 2,
        nextContentRevision,
        allowRevisionOverride: true
      }),
      error => error.code === 'INVALID_REQUEST'
    );
  }

  const updated = updateServerConfig(serverPath, { maxRam: 8 }, {}, {
    durableFs,
    expectedContentRevision: 2,
    nextContentRevision: 3,
    allowRevisionOverride: true
  });
  assert.equal(updated.contentRevision, 3);
  assert.equal(updated.custom, 'kept');
});

test('nextContentRevision is rejected unless the internal override is enabled', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 0 }));

  assert.throws(
    () => writeServerConfig(serverPath, { maxRam: 8 }, {}, {
      durableFs,
      expectedContentRevision: 0,
      nextContentRevision: 1
    }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('bumpContentRevision performs a durable compare-and-set and preserves config', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 9, custom: ['kept'] }));

  const next = bumpContentRevision(serverPath, {
    expectedRevision: 9,
    operationId: 'operation-123',
    durableFs
  });

  assert.equal(next, 10);
  assert.equal(readContentRevision(serverPath), 10);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).custom, ['kept']);
  assert.throws(
    () => bumpContentRevision(serverPath, {
      expectedRevision: 9,
      operationId: 'operation-124',
      durableFs
    }),
    error => error.code === 'PLAN_STALE'
  );
});

test('invalid revisions and operation IDs are rejected before publication', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 0 }));

  for (const expectedRevision of [-1, 1.2, '0', Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => bumpContentRevision(serverPath, {
        expectedRevision,
        operationId: 'operation-1',
        durableFs
      }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  for (const operationId of ['', '../operation', 'operation:stream']) {
    assert.throws(
      () => bumpContentRevision(serverPath, {
        expectedRevision: 0,
        operationId,
        durableFs
      }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  assert.equal(readContentRevision(serverPath), 0);
});

test('injected publication failures never leave partial JSON or a temp file', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t, { failFlush: true });
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 3, stable: true }));

  assert.throws(
    () => updateServerConfig(serverPath, { stable: false }, {}, { durableFs }),
    error => error.code === 'COMMIT_FAILED'
  );

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(parsed.contentRevision, 3);
  assert.equal(typeof parsed.stable, 'boolean');
  assert.equal(fs.readdirSync(serverPath).some(name => name.includes('.minecraft-core-tmp-')), false);
});

test('malformed existing config fails closed and preserves its exact bytes', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  const malformed = Buffer.from('{"contentRevision": 4,', 'utf8');
  fs.writeFileSync(configPath, malformed);

  assert.equal(readContentRevision(serverPath), 0);

  assert.throws(
    () => writeServerConfig(serverPath, { maxRam: 8 }, {}, { durableFs }),
    error => error.code === 'COMMIT_FAILED'
  );
  assert.deepEqual(fs.readFileSync(configPath), malformed);
});

test('config writes refuse a missing server directory instead of creating it', (t) => {
  const { serverPath, durableFs } = fixture(t);
  const missing = path.join(serverPath, 'missing-server');

  assert.throws(
    () => writeServerConfig(missing, { maxRam: 8 }, {}, { durableFs }),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.equal(fs.existsSync(missing), false);
});

test('revision options are closed and defaults cannot seed a nonzero revision', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, '{}');

  assert.equal(getDefaultServerConfig({ contentRevision: 99 }).contentRevision, 0);
  for (const options of [
    { durableFs, unknown: true },
    { durableFs, allowRevisionOverride: true },
    { durableFs, allowRevisionOverride: false, nextContentRevision: 1, expectedContentRevision: 0 },
    { durableFs, operationId: '../unsafe' }
  ]) {
    assert.throws(
      () => writeServerConfig(serverPath, { maxRam: 8 }, {}, options),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  assert.throws(
    () => writeServerConfig(serverPath, { contentRevision: 1 }, {}, { durableFs }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).contentRevision, undefined);
});

test('updaters must synchronously return a plain object', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 1, stable: true }));

  for (const updater of [
    () => Promise.resolve({ stable: false }),
    () => null,
    () => new (class Update { constructor() { this.stable = false; } })()
  ]) {
    assert.throws(
      () => updateServerConfig(serverPath, updater, {}, { durableFs }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { contentRevision: 1, stable: true });
});

test('reentrant compare-and-set is blocked before a second publication', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 0 }));
  let attempted = false;
  const reentrantDurableFs = {
    ...durableFs,
    writeJsonAtomic(filePath, value, options) {
      if (!attempted) {
        attempted = true;
        assert.throws(
          () => bumpContentRevision(serverPath, {
            expectedRevision: 0,
            operationId: 'operation-inner',
            durableFs
          }),
          error => error.code === 'OPERATION_IN_PROGRESS'
        );
      }
      return durableFs.writeJsonAtomic(filePath, value, options);
    }
  };

  assert.equal(bumpContentRevision(serverPath, {
    expectedRevision: 0,
    operationId: 'operation-outer',
    durableFs: reentrantDurableFs
  }), 1);
  assert.equal(readContentRevision(serverPath), 1);
});

test('config publication rejects a target changed after the planning read', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 2, stable: true }));
  let mutated = false;
  const racingDurableFs = {
    ...durableFs,
    writeJsonAtomic(filePath, value, options) {
      if (!mutated) {
        mutated = true;
        fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 3, external: true }));
      }
      return durableFs.writeJsonAtomic(filePath, value, options);
    }
  };

  assert.throws(
    () => updateServerConfig(serverPath, { maxRam: 8 }, {}, {
      durableFs: racingDurableFs,
      expectedContentRevision: 2,
      nextContentRevision: 3,
      allowRevisionOverride: true,
      operationId: 'operation-race'
    }),
    error => error.code === 'PLAN_STALE'
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { contentRevision: 3, external: true });
});

test('functional updater executes inside the per-server revision lock', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 0, stable: true }));
  let nestedAttempted = false;

  const result = updateServerConfig(serverPath, current => {
    nestedAttempted = true;
    assert.throws(
      () => writeServerConfig(serverPath, { ...current, nested: true }, {}, {
        durableFs,
        operationId: 'operation-nested'
      }),
      error => error.code === 'OPERATION_IN_PROGRESS'
    );
    return { ...current, outer: true };
  }, {}, {
    durableFs,
    operationId: 'operation-outer-updater'
  });

  assert.equal(nestedAttempted, true);
  assert.equal(result.outer, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).nested, undefined);
});

test('all mutation reads use the bounded durable capability', (t) => {
  const { serverPath, configPath, durableFs } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 2, stable: true }));
  let boundedReadCalls = 0;
  const trackedDurableFs = {
    ...durableFs,
    readFileBounded(filePath, options) {
      boundedReadCalls += 1;
      return durableFs.readFileBounded(filePath, options);
    }
  };

  updateServerConfig(serverPath, current => ({ ...current, stable: false }), {}, {
    durableFs: trackedDurableFs,
    operationId: 'operation-bounded-read'
  });

  assert.equal(boundedReadCalls, 1);
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).stable, false);
});
