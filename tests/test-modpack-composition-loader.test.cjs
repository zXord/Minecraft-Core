const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const harness = require('./e2e/fixtures/modpack-harness.cjs');

let subject = {};
try {
  subject = require('../electron/bootstrap/load-test-modpack-factory.cjs');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('load-test-modpack-factory.cjs')) throw error;
}

test('test modpack factory loader is dual-flag gated and requires an absolute reviewed module', () => {
  assert.equal(typeof subject.loadTestModpackFactory, 'function', 'test factory loader is required');
  const fixtureModule = path.join(os.tmpdir(), 'minecraft-core-e2e-factory.cjs');
  let loads = 0;
  const requireModule = requested => {
    loads += 1;
    assert.equal(requested, path.resolve(fixtureModule));
    return { createModpackFactory: () => async () => ({ id: 'fixture-composition' }) };
  };

  for (const env of [
    { NODE_ENV: 'production', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_TEST_MODPACK_FACTORY: fixtureModule },
    { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '0', MINECRAFT_CORE_TEST_MODPACK_FACTORY: fixtureModule },
    { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODPACK_FACTORY: fixtureModule }
  ]) {
    assert.equal(subject.loadTestModpackFactory({ env, requireModule }), null);
  }
  assert.equal(loads, 0, 'production and partially enabled modes must never load a fixture module');

  assert.throws(() => subject.loadTestModpackFactory({
    env: {
      NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1',
      MINECRAFT_CORE_TEST_MODPACK_FACTORY: 'relative-fixture.cjs'
    },
    requireModule
  }), /absolute/i);
  assert.equal(loads, 0);

  const factory = subject.loadTestModpackFactory({
    env: {
      NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1',
      MINECRAFT_CORE_TEST_MODPACK_FACTORY: fixtureModule
    },
    requireModule
  });
  assert.equal(typeof factory, 'function');
  assert.equal(loads, 1);
});

test('packaged Electron never loads test composition or IPC modules even when all env flags are present', () => {
  const fixtureModule = path.join(os.tmpdir(), 'minecraft-core-packaged-injection.cjs');
  const env = {
    NODE_ENV: 'test',
    MINECRAFT_CORE_TEST_MODE: '1',
    MINECRAFT_CORE_TEST_MODPACK_FACTORY: fixtureModule
  };
  let loads = 0;
  const requireModule = () => {
    loads += 1;
    return {
      createModpackFactory: () => async () => ({}),
      createRecoveryFactory: () => async () => ({}),
      createIpcOverrides: () => ({})
    };
  };

  assert.equal(subject.loadTestModpackFactory({ env, requireModule, isPackaged: true }), null);
  assert.equal(subject.loadTestRecoveryFactory({ env, requireModule, isPackaged: true }), null);
  assert.equal(subject.loadTestIpcOverrides({ env, requireModule, isPackaged: true }), null);
  assert.equal(loads, 0, 'a packaged binary must never require a caller-selected test module');
});

test('packaged Electron launcher uses an exclusive runtime allowlist without test or executable injection variables', () => {
  assert.equal(typeof harness.createExclusivePackagedEnvironment, 'function');
  const environment = harness.createExclusivePackagedEnvironment({
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    Path: 'C:\\developer-bin',
    PATH: 'C:\\system-bin',
    NODE_OPTIONS: '--require C:\\untrusted.cjs',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'test',
    MINECRAFT_CORE_TEST_MODE: '1',
    MINECRAFT_CORE_TEST_MODPACK_FACTORY: 'C:\\untrusted.cjs',
    MINECRAFT_CORE_USER_DATA_DIR: 'C:\\isolated-smoke-data',
    GH_TOKEN: 'secret'
  });

  assert.deepEqual(environment, {
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    MINECRAFT_CORE_USER_DATA_DIR: 'C:\\isolated-smoke-data',
    PATH: ''
  });
  assert.equal(Object.isFrozen(environment), true);
});

test('service graph userData resolves to the isolated test directory before app readiness', () => {
  assert.equal(typeof subject.resolveServiceGraphUserData, 'function', 'service graph userData resolver is required');
  const isolated = path.join(os.tmpdir(), 'minecraft-core-e2e-isolated');
  const production = path.join(os.tmpdir(), 'minecraft-core-production');
  const runtimeRoot = path.join(os.tmpdir(), 'minecraft-core-runtime');
  let productionReads = 0;
  const app = {
    getPath(name) {
      assert.equal(name, 'userData');
      productionReads += 1;
      return production;
    }
  };

  assert.equal(subject.resolveServiceGraphUserData({
    runtimeFlags: { testMode: true, isolatedUserDataPath: isolated }, app, runtimeRoot
  }), path.resolve(isolated));
  assert.equal(productionReads, 0, 'test composition must not read or reuse production userData');

  assert.equal(subject.resolveServiceGraphUserData({
    runtimeFlags: { testMode: false, isolatedUserDataPath: null }, app, runtimeRoot
  }), production);
  assert.equal(productionReads, 1);
});

test('test recovery factory uses the same dual-flag and absolute-module authority', () => {
  assert.equal(typeof subject.loadTestRecoveryFactory, 'function', 'test recovery factory loader is required');
  const fixtureModule = path.join(os.tmpdir(), 'minecraft-core-e2e-recovery.cjs');
  let loads = 0;
  const recoveryFactory = async () => ({ id: 'fixture-recovery' });
  const requireModule = requested => {
    loads += 1;
    assert.equal(requested, path.resolve(fixtureModule));
    return { createRecoveryFactory: () => recoveryFactory };
  };
  assert.equal(subject.loadTestRecoveryFactory({
    env: { NODE_ENV: 'production', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_TEST_MODPACK_FACTORY: fixtureModule },
    requireModule
  }), null);
  assert.equal(loads, 0);
  assert.equal(subject.loadTestRecoveryFactory({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_TEST_MODPACK_FACTORY: fixtureModule },
    requireModule
  }), recoveryFactory);
  assert.equal(loads, 1);
});

test('test IPC overrides are loaded only through the authorized fixture module', () => {
  assert.equal(typeof subject.loadTestIpcOverrides, 'function', 'test IPC override loader is required');
  const fixtureModule = path.join(os.tmpdir(), 'minecraft-core-e2e-ipc.cjs');
  const overrides = { handlerFactories: { createFileHandlers() {} } };
  const requireModule = () => ({ createIpcOverrides: () => overrides });
  assert.equal(subject.loadTestIpcOverrides({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '0', MINECRAFT_CORE_TEST_MODPACK_FACTORY: fixtureModule },
    requireModule
  }), null);
  assert.equal(subject.loadTestIpcOverrides({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_TEST_MODPACK_FACTORY: fixtureModule },
    requireModule
  }), overrides);
});
