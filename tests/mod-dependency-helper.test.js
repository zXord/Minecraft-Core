import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkModDependencies,
  isDependencyRelevantToActiveLoader,
  shouldInjectFabricApiDependency,
  buildDependencyResolutionState,
  requiresDependencyInstallation,
  installWithDependencies
} from '../src/utils/mods/modDependencyHelper.js';
import {
  currentDependencies,
  disabledMods,
  installedModInfo,
  loaderType,
  minecraftVersion,
  modToInstall
} from '../src/stores/modStore.js';

test('Forge loader ignores Fabric API framework dependencies', () => {
  assert.equal(isDependencyRelevantToActiveLoader('fabric-api', 'forge'), false);
  assert.equal(isDependencyRelevantToActiveLoader('P7dR8mSH', 'forge'), false);
  assert.equal(isDependencyRelevantToActiveLoader('p7dkfbws', 'forge'), false);
  assert.equal(isDependencyRelevantToActiveLoader('fabric-rendering-v1', 'forge'), false);
});

test('Fabric-like loaders keep Fabric API framework dependencies', () => {
  assert.equal(isDependencyRelevantToActiveLoader('fabric-api', 'fabric'), true);
  assert.equal(isDependencyRelevantToActiveLoader('fabric-rendering-v1', 'fabric'), true);
  assert.equal(isDependencyRelevantToActiveLoader('fabric-api', 'quilt'), true);
});

test('Fabric API auto-injection only happens for Fabric API module dependencies on Fabric-like loaders', () => {
  assert.equal(shouldInjectFabricApiDependency(['fabric-rendering-v1'], 'forge'), false);
  assert.equal(shouldInjectFabricApiDependency(['fabric-rendering-v1'], 'fabric'), true);
  assert.equal(shouldInjectFabricApiDependency(['fabric-resource-loader-v0'], 'quilt'), true);
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

test('checkModDependencies uses Fabric Modrinth version metadata and ignores optional entries', async () => {
  const previousWindow = global.window;
  const calls = [];
  global.window = {
    electron: {
      async invoke(channel, payload) {
        calls.push(channel);
        if (channel === 'get-version-info') {
          if (payload.modId === 'litematica') {
            return {
              id: 'fabric-version',
              loaders: ['fabric'],
              dependencies: [
                { project_id: 'GcWjdA9I', dependency_type: 'required' },
                { project_id: 'mOgUt4GM', dependency_type: 'optional' }
              ]
            };
          }

          return {
            id: `${payload.modId}-version`,
            loaders: ['fabric'],
            dependencies: []
          };
        }

        if (channel === 'get-project-info') {
          const infoById = {
            'fabric-api': { id: 'P7dR8mSH', title: 'Fabric API' },
            P7dR8mSH: { id: 'P7dR8mSH', title: 'Fabric API' },
            GcWjdA9I: { id: 'GcWjdA9I', title: 'MaLiLib' },
            mOgUt4GM: { id: 'mOgUt4GM', title: 'Mod Menu' }
          };
          return infoById[payload.projectId] || null;
        }

        if (channel === 'get-mod-versions') {
          return [
            {
              id: `${payload.modId}-latest`,
              versionNumber: '1.0.0',
              datePublished: '2024-01-01T00:00:00Z'
            }
          ];
        }

        if (channel === 'extract-jar-dependencies' || channel === 'analyze-mod-from-url') {
          assert.fail(`JAR fallback should not run when version metadata has dependencies: ${channel}`);
        }

        return null;
      }
    }
  };

  try {
    loaderType.set('fabric');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([]);
    disabledMods.set(new Set());

    const dependencies = await checkModDependencies({
      id: 'litematica',
      name: 'Litematica',
      source: 'modrinth',
      selectedVersionId: 'fabric-version'
    });

    assert.deepEqual(
      dependencies.map(dep => ({
        projectId: dep.projectId,
        name: dep.name,
        dependencyType: dep.dependencyType
      })),
      [
        { projectId: 'GcWjdA9I', name: 'MaLiLib', dependencyType: 'required' }
      ]
    );
    assert.equal(calls.includes('extract-jar-dependencies'), false);
    assert.equal(calls.includes('analyze-mod-from-url'), false);
  } finally {
    global.window = previousWindow;
  }
});

test('checkModDependencies treats empty provider dependency metadata as authoritative', async () => {
  const previousWindow = global.window;
  global.window = {
    electron: {
      async invoke(channel) {
        if (channel === 'get-version-info') {
          return {
            id: 'empty-provider-version',
            loaders: ['fabric'],
            dependencies: [],
            files: [{ url: 'https://example.test/empty-provider.jar' }]
          };
        }

        if (channel === 'extract-jar-dependencies' || channel === 'analyze-mod-from-url') {
          assert.fail(`JAR fallback should not run when provider metadata is available: ${channel}`);
        }

        return null;
      }
    }
  };

  try {
    loaderType.set('fabric');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([
      {
        projectId: 'empty-provider-mod',
        fileName: 'empty-provider-mod.jar',
        filePath: 'test-fixtures/empty-provider-mod.jar'
      }
    ]);
    disabledMods.set(new Set());

    const dependencies = await checkModDependencies({
      id: 'empty-provider-mod',
      name: 'Empty Provider Mod',
      source: 'modrinth',
      selectedVersionId: 'empty-provider-version'
    });

    assert.deepEqual(dependencies, []);
  } finally {
    global.window = previousWindow;
  }
});

test('checkModDependencies converts Fabric API module dependencies from JAR fallback to Fabric API', async () => {
  const previousWindow = global.window;
  global.window = {
    electron: {
      async invoke(channel, payload) {
        if (channel === 'get-version-info') {
          return null;
        }

        if (channel === 'extract-jar-dependencies') {
          return [
            {
              id: 'fabric-rendering-v1',
              dependency_type: 'required',
              version_requirement: '*'
            },
            {
              id: 'cloth-config',
              dependency_type: 'required',
              version_requirement: '>=11.0.0'
            }
          ];
        }

        if (channel === 'get-project-info') {
          const infoById = {
            'fabric-api': { id: 'P7dR8mSH', title: 'Fabric API' },
            'fabric-rendering-v1': null,
            'cloth-config': { id: '9s6osm5g', title: 'Cloth Config API' },
            P7dR8mSH: { id: 'P7dR8mSH', title: 'Fabric API' }
          };
          return infoById[payload.projectId] || null;
        }

        if (channel === 'get-mod-versions') {
          return [
            {
              id: `${payload.modId}-latest`,
              versionNumber: '1.0.0',
              datePublished: '2024-01-01T00:00:00Z'
            }
          ];
        }

        return null;
      }
    }
  };

  try {
    loaderType.set('fabric');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([
      {
        projectId: 'jar-parent',
        fileName: 'jar-parent.jar',
        filePath: 'test-fixtures/jar-parent.jar'
      }
    ]);
    disabledMods.set(new Set());

    const dependencies = await checkModDependencies({
      id: 'jar-parent',
      name: 'Jar Parent',
      source: 'modrinth'
    });

    assert.deepEqual(
      dependencies.map(dep => ({
        projectId: dep.projectId,
        name: dep.name,
        dependencyType: dep.dependencyType
      })),
      [
        { projectId: '9s6osm5g', name: 'Cloth Config API', dependencyType: 'required' },
        { projectId: 'P7dR8mSH', name: 'Fabric API', dependencyType: 'required' }
      ]
    );
  } finally {
    global.window = previousWindow;
  }
});

test('checkModDependencies skips already installed required dependencies', async () => {
  const previousWindow = global.window;
  global.window = {
    electron: {
      async invoke(channel, payload) {
        if (channel === 'get-version-info') {
          if (payload.modId === 'parent-mod') {
            return {
              id: 'parent-version',
              loaders: ['forge'],
              dependencies: [
                { project_id: 'already-installed-lib', dependency_type: 'required' }
              ]
            };
          }

          return {
            id: `${payload.modId}-version`,
            loaders: ['forge'],
            dependencies: []
          };
        }

        return null;
      }
    }
  };

  try {
    loaderType.set('forge');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([
      {
        projectId: 'already-installed-lib',
        fileName: 'already-installed-lib.jar',
        versionNumber: '1.0.0'
      }
    ]);
    disabledMods.set(new Set());

    const dependencies = await checkModDependencies({
      id: 'parent-mod',
      name: 'Parent Mod',
      source: 'modrinth',
      selectedVersionId: 'parent-version'
    });

    assert.deepEqual(dependencies, []);
  } finally {
    global.window = previousWindow;
  }
});

test('checkModDependencies includes transitive required dependencies', async () => {
  const previousWindow = global.window;
  global.window = {
    electron: {
      async invoke(channel, payload) {
        if (channel === 'get-version-info') {
          if (payload.modId === 'parent-mod') {
            return {
              id: 'parent-version',
              loaders: ['forge'],
              dependencies: [
                { project_id: 'direct-lib', dependency_type: 'required' }
              ]
            };
          }

          if (payload.modId === 'direct-lib') {
            return {
              id: 'direct-lib-version',
              loaders: ['forge'],
              dependencies: [
                { project_id: 'transitive-lib', dependency_type: 'required' }
              ]
            };
          }

          return {
            id: `${payload.modId}-version`,
            loaders: ['forge'],
            dependencies: []
          };
        }

        if (channel === 'get-project-info') {
          const infoById = {
            'direct-lib': { id: 'direct-lib', title: 'Direct Library' },
            'transitive-lib': { id: 'transitive-lib', title: 'Transitive Library' }
          };
          return infoById[payload.projectId] || null;
        }

        if (channel === 'get-mod-versions') {
          return [
            {
              id: `${payload.modId}-latest`,
              versionNumber: '1.0.0',
              datePublished: '2024-01-01T00:00:00Z'
            }
          ];
        }

        return null;
      }
    }
  };

  try {
    loaderType.set('forge');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([]);
    disabledMods.set(new Set());

    const dependencies = await checkModDependencies({
      id: 'parent-mod',
      name: 'Parent Mod',
      source: 'modrinth',
      selectedVersionId: 'parent-version'
    });

    assert.deepEqual(
      dependencies.map(dep => ({
        projectId: dep.projectId,
        name: dep.name,
        dependencyType: dep.dependencyType
      })),
      [
        { projectId: 'direct-lib', name: 'Direct Library', dependencyType: 'required' },
        { projectId: 'transitive-lib', name: 'Transitive Library', dependencyType: 'required' }
      ]
    );
  } finally {
    global.window = previousWindow;
  }
});

test('checkModDependencies follows pinned dependency versions for transitive checks', async () => {
  const previousWindow = global.window;
  global.window = {
    electron: {
      async invoke(channel, payload) {
        if (channel === 'get-version-info') {
          if (payload.modId === 'parent-mod') {
            return {
              id: 'parent-version',
              loaders: ['fabric'],
              dependencies: [
                { project_id: 'direct-lib', version_id: 'direct-pinned-version', dependency_type: 'required' }
              ]
            };
          }

          if (payload.versionId === 'direct-pinned-version') {
            return {
              id: 'direct-pinned-version',
              loaders: ['fabric'],
              dependencies: []
            };
          }

          if (payload.modId === 'direct-lib') {
            return {
              id: 'direct-latest-version',
              loaders: ['fabric'],
              dependencies: [
                { project_id: 'latest-only-transitive-lib', dependency_type: 'required' }
              ]
            };
          }

          return {
            id: `${payload.modId || payload.versionId}-version`,
            loaders: ['fabric'],
            dependencies: []
          };
        }

        if (channel === 'get-project-info') {
          const infoById = {
            'direct-lib': { id: 'direct-lib', title: 'Direct Library' },
            'latest-only-transitive-lib': { id: 'latest-only-transitive-lib', title: 'Latest Only Transitive Library' }
          };
          return infoById[payload.projectId] || null;
        }

        if (channel === 'get-mod-versions') {
          return [
            {
              id: `${payload.modId}-latest`,
              versionNumber: '1.0.0',
              datePublished: '2024-01-01T00:00:00Z'
            }
          ];
        }

        return null;
      }
    }
  };

  try {
    loaderType.set('fabric');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([]);
    disabledMods.set(new Set());

    const dependencies = await checkModDependencies({
      id: 'parent-mod',
      name: 'Parent Mod',
      source: 'modrinth',
      selectedVersionId: 'parent-version'
    });

    assert.deepEqual(
      dependencies.map(dep => ({
        projectId: dep.projectId,
        currentVersionId: dep.currentVersionId || null
      })),
      [
        { projectId: 'direct-lib', currentVersionId: 'direct-pinned-version' }
      ]
    );
  } finally {
    global.window = previousWindow;
  }
});

test('checkModDependencies uses Forge Modrinth version metadata without Fabric injection', async () => {
  const previousWindow = global.window;
  const calls = [];
  global.window = {
    electron: {
      async invoke(channel, payload) {
        calls.push(channel);
        if (channel === 'get-version-info') {
          if (payload.modId === 'supplementaries') {
            return {
              id: 'forge-version',
              loaders: ['forge'],
              dependencies: [
                { project_id: 'twkfQtEc', dependency_type: 'required' },
                { project_id: 'u6dRKJwZ', dependency_type: 'optional' }
              ]
            };
          }

          return {
            id: `${payload.modId}-version`,
            loaders: ['forge'],
            dependencies: []
          };
        }

        if (channel === 'get-project-info') {
          const infoById = {
            twkfQtEc: { id: 'twkfQtEc', title: 'Moonlight Lib' },
            u6dRKJwZ: { id: 'u6dRKJwZ', title: 'Just Enough Items' }
          };
          return infoById[payload.projectId] || null;
        }

        if (channel === 'get-mod-versions') {
          return [
            {
              id: `${payload.modId}-latest`,
              versionNumber: '1.0.0',
              datePublished: '2024-01-01T00:00:00Z'
            }
          ];
        }

        if (channel === 'extract-jar-dependencies' || channel === 'analyze-mod-from-url') {
          assert.fail(`JAR fallback should not run when version metadata has dependencies: ${channel}`);
        }

        return null;
      }
    }
  };

  try {
    loaderType.set('forge');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([]);
    disabledMods.set(new Set());

    const dependencies = await checkModDependencies({
      id: 'supplementaries',
      name: 'Supplementaries',
      source: 'modrinth',
      selectedVersionId: 'forge-version'
    });

    assert.deepEqual(
      dependencies.map(dep => ({
        projectId: dep.projectId,
        name: dep.name,
        dependencyType: dep.dependencyType
      })),
      [
        { projectId: 'twkfQtEc', name: 'Moonlight Lib', dependencyType: 'required' }
      ]
    );
    assert.equal(dependencies.some(dep => dep.projectId === 'P7dR8mSH'), false);
    assert.equal(calls.includes('extract-jar-dependencies'), false);
    assert.equal(calls.includes('analyze-mod-from-url'), false);
  } finally {
    global.window = previousWindow;
  }
});

test('installWithDependencies stops before parent install when a required dependency fails', async () => {
  loaderType.set('fabric');
  minecraftVersion.set('1.20.1');
  installedModInfo.set([]);
  disabledMods.set(new Set());
  modToInstall.set({ id: 'parent-mod', name: 'Parent Mod', source: 'modrinth' });
  currentDependencies.set([
    {
      projectId: 'required-lib',
      name: 'Required Library',
      dependencyType: 'required'
    }
  ]);

  const calls = [];
  const result = await installWithDependencies('dependency-test-server-path', async (mod) => {
    calls.push(mod.id);
    return mod.id !== 'required-lib';
  });

  assert.equal(result, false);
  assert.deepEqual(calls, ['required-lib']);
});

test('installWithDependencies resolves generic dependency names before installing by project ID', async () => {
  const previousWindow = global.window;
  global.window = {
    electron: {
      async invoke(channel, payload) {
        if (channel === 'get-project-info') {
          assert.equal(payload.projectId, 'resolved-lib');
          return { id: 'resolved-lib', title: 'Resolved Library' };
        }
        return null;
      }
    }
  };

  try {
    loaderType.set('fabric');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([]);
    disabledMods.set(new Set());
    modToInstall.set({ id: 'parent-mod', name: 'Parent Mod', source: 'modrinth' });
    currentDependencies.set([
      {
        projectId: 'resolved-lib',
        name: 'Required Dependency',
        dependencyType: 'required'
      }
    ]);

    const calls = [];
    const result = await installWithDependencies('dependency-test-server-path', async (mod) => {
      calls.push({ id: mod.id, name: mod.name });
      return true;
    });

    assert.equal(result, true);
    assert.deepEqual(calls, [
      { id: 'resolved-lib', name: 'Resolved Library' },
      { id: 'parent-mod', name: 'Parent Mod' }
    ]);
  } finally {
    global.window = previousWindow;
  }
});

test('installWithDependencies stops when no compatible dependency version exists', async () => {
  const previousWindow = global.window;
  global.window = {
    electron: {
      async invoke(channel) {
        if (channel === 'get-mod-versions') {
          return [
            {
              id: 'old-version',
              versionNumber: '1.0.0',
              datePublished: '2023-01-01T00:00:00Z'
            }
          ];
        }
        return null;
      }
    }
  };

  try {
    loaderType.set('forge');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([]);
    disabledMods.set(new Set());
    modToInstall.set({ id: 'parent-mod', name: 'Parent Mod', source: 'modrinth' });
    currentDependencies.set([
      {
        projectId: 'versioned-lib',
        name: 'Versioned Library',
        dependencyType: 'required',
        versionRequirement: '>=2.0.0'
      }
    ]);

    const calls = [];
    const result = await installWithDependencies('dependency-test-server-path', async (mod) => {
      calls.push(mod.id);
      return true;
    });

    assert.equal(result, false);
    assert.deepEqual(calls, []);
  } finally {
    global.window = previousWindow;
  }
});

test('installWithDependencies selects a compatible dependency version instead of the installed version', async () => {
  const previousWindow = global.window;
  global.window = {
    electron: {
      async invoke(channel) {
        if (channel === 'get-mod-versions') {
          return [
            {
              id: 'old-version',
              versionNumber: '1.0.0',
              datePublished: '2023-01-01T00:00:00Z'
            },
            {
              id: 'new-version',
              versionNumber: '2.1.0',
              datePublished: '2024-01-01T00:00:00Z'
            }
          ];
        }
        return null;
      }
    }
  };

  try {
    loaderType.set('forge');
    minecraftVersion.set('1.20.1');
    installedModInfo.set([]);
    disabledMods.set(new Set());
    modToInstall.set({ id: 'parent-mod', name: 'Parent Mod', source: 'modrinth' });
    currentDependencies.set([
      {
        projectId: 'versioned-lib',
        name: 'Versioned Library',
        dependencyType: 'required',
        currentVersionId: 'old-version',
        versionRequirement: '>=2.0.0'
      }
    ]);

    const calls = [];
    const result = await installWithDependencies('dependency-test-server-path', async (mod) => {
      calls.push({
        id: mod.id,
        selectedVersionId: mod.selectedVersionId || null
      });
      return true;
    });

    assert.equal(result, true);
    assert.deepEqual(calls, [
      { id: 'versioned-lib', selectedVersionId: 'new-version' },
      { id: 'parent-mod', selectedVersionId: null }
    ]);
  } finally {
    global.window = previousWindow;
  }
});

test('installWithDependencies preserves pinned dependency version ids', async () => {
  loaderType.set('fabric');
  minecraftVersion.set('1.20.1');
  installedModInfo.set([]);
  disabledMods.set(new Set());
  modToInstall.set({ id: 'parent-mod', name: 'Parent Mod', source: 'modrinth' });
  currentDependencies.set([
    {
      projectId: 'direct-lib',
      name: 'Direct Library',
      dependencyType: 'required',
      currentVersionId: 'direct-pinned-version'
    }
  ]);

  const calls = [];
  const result = await installWithDependencies('dependency-test-server-path', async (mod) => {
    calls.push({
      id: mod.id,
      selectedVersionId: mod.selectedVersionId || null
    });
    return true;
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [
    { id: 'direct-lib', selectedVersionId: 'direct-pinned-version' },
    { id: 'parent-mod', selectedVersionId: null }
  ]);
});
