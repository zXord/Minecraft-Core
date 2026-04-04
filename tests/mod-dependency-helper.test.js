import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDependencyRelevantToActiveLoader,
  shouldInjectFabricApiDependency
} from '../src/utils/mods/modDependencyHelper.js';

test('Forge loader ignores Fabric API framework dependencies', () => {
  assert.equal(isDependencyRelevantToActiveLoader('fabric-api', 'forge'), false);
  assert.equal(isDependencyRelevantToActiveLoader('p7dkfbws', 'forge'), false);
  assert.equal(isDependencyRelevantToActiveLoader('fabric-rendering-v1', 'forge'), false);
});

test('Fabric-like loaders keep Fabric API framework dependencies', () => {
  assert.equal(isDependencyRelevantToActiveLoader('fabric-api', 'fabric'), true);
  assert.equal(isDependencyRelevantToActiveLoader('fabric-rendering-v1', 'fabric'), true);
  assert.equal(isDependencyRelevantToActiveLoader('fabric-api', 'quilt'), true);
});

test('Fabric API auto-injection only happens for Fabric-like active loaders', () => {
  assert.equal(shouldInjectFabricApiDependency(['fabric', 'forge'], 'forge'), false);
  assert.equal(shouldInjectFabricApiDependency(['fabric', 'forge'], 'fabric'), true);
  assert.equal(shouldInjectFabricApiDependency(['fabric'], 'quilt'), true);
  assert.equal(shouldInjectFabricApiDependency(['forge'], 'fabric'), false);
});
