import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isDependencyRelevantToActiveLoader,
  shouldInjectFabricApiDependency,
  buildDependencyResolutionState,
  requiresDependencyInstallation
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

test('Disabled installed dependencies still require action', () => {
  const dependencyState = buildDependencyResolutionState({
    installedInfo: [{
      projectId: 'fabric-api',
      fileName: 'fabric-api.jar',
      versionNumber: '1.0.0'
    }],
    disabledSet: new Set(['fabric-api.jar'])
  });

  assert.equal(
    requiresDependencyInstallation(
      { projectId: 'fabric-api', versionRequirement: '>=1.0.0' },
      dependencyState
    ),
    true
  );
});

test('Queued dependency installs are treated as already satisfied', () => {
  const dependencyState = buildDependencyResolutionState({
    installedInfo: [],
    pendingProjectIds: ['cloth-config']
  });

  assert.equal(
    requiresDependencyInstallation(
      { projectId: 'cloth-config', versionRequirement: '>=15.0.0' },
      dependencyState
    ),
    false
  );
});

test('Installed dependency version mismatches still require installation', () => {
  const dependencyState = buildDependencyResolutionState({
    installedInfo: [{
      projectId: 'architectury-api',
      fileName: 'architectury-api.jar',
      versionNumber: '8.0.0'
    }]
  });

  assert.equal(
    requiresDependencyInstallation(
      { projectId: 'architectury-api', versionRequirement: '>=9.0.0' },
      dependencyState
    ),
    true
  );
});
