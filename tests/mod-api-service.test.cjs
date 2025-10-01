const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

async function withMockedFetch(sampleVersions, fn) {
  const originalLoad = Module._load;
  let fetchCalls = 0;

  const mockFetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return sampleVersions;
      }
    };
  };

  const loggerStub = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {}
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'node-fetch') {
      return mockFetch;
    }
    if (typeof request === 'string' && request.endsWith('logger-handlers.cjs')) {
      return {
        getLoggerHandlers() {
          return loggerStub;
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  const servicePath = path.resolve(__dirname, '../electron/services/mod-api-service.cjs');
  delete require.cache[servicePath];
  const modApiService = require(servicePath);

  try {
    modApiService.clearVersionCache();
    await fn(modApiService, { fetchCalls });
  } finally {
    Module._load = originalLoad;
    delete require.cache[servicePath];
  }
}

test('getModrinthVersions ignores versions with mismatched loaders during fallback', async () => {
  const sampleVersions = [
    {
      id: 'fabric-build',
      version_number: '17.0.8+fabric',
      game_versions: ['1.21.8'],
      loaders: ['fabric'],
      version_type: 'release',
      date_published: '2024-09-01T00:00:00Z',
      files: [{ size: 1024 }],
      downloads: 100
    },
    {
      id: 'neoforge-build',
      version_number: '17.0.8+neoforge',
      game_versions: ['1.21.9'],
      loaders: ['neoforge'],
      version_type: 'release',
      date_published: '2024-09-15T00:00:00Z',
      files: [{ size: 1024 }],
      downloads: 150
    }
  ];

  await withMockedFetch(sampleVersions, async (service) => {
    const results = await service.getModrinthVersions('architectury', 'fabric', '1.21.9', false);
    assert.equal(results.length, 0, 'Should not surface versions from other loaders');
  });
});

test('getModrinthVersions accepts wildcard Minecraft version tags for compatibility', async () => {
  const sampleVersions = [
    {
      id: 'wildcard-build',
      version_number: '3.0.0',
      game_versions: ['1.21.x'],
      loaders: ['fabric'],
      version_type: 'release',
      date_published: '2024-09-10T00:00:00Z',
      files: [{ size: 2048 }],
      downloads: 50
    },
    {
      id: 'older-build',
      version_number: '2.9.9',
      game_versions: ['1.20.5'],
      loaders: ['fabric'],
      version_type: 'release',
      date_published: '2024-05-01T00:00:00Z',
      files: [{ size: 2048 }],
      downloads: 40
    }
  ];

  await withMockedFetch(sampleVersions, async (service) => {
    const results = await service.getModrinthVersions('sample-mod', 'fabric', '1.21.9', true);
    assert.equal(results.length, 1, 'Wildcard entry should satisfy compatibility');
    assert.equal(results[0].id, 'wildcard-build', 'Wildcard build should be selected');
  });
});

test('getModrinthVersions rejects broad major/minor tags for higher patch upgrades', async () => {
  const sampleVersions = [
    {
      id: 'broad-build',
      version_number: '13.0.8+fabric',
      game_versions: ['1.21', '1.21.1'],
      loaders: ['fabric'],
      version_type: 'release',
      date_published: '2024-08-01T00:00:00Z',
      files: [{ size: 1024 }],
      downloads: 80
    }
  ];

  await withMockedFetch(sampleVersions, async (service) => {
    const results = await service.getModrinthVersions('architectury', 'fabric', '1.21.9', false);
    assert.equal(results.length, 0, 'Versions lacking explicit 1.21.9 support should be ignored');
  });
});
