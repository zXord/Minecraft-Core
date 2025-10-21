const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

async function withMockedFetch(sampleVersions, fn) {
  const originalLoad = Module._load;
  let fetchCalls = 0;
  const responseFactory = typeof sampleVersions === 'function'
    ? sampleVersions
    : async () => sampleVersions;

  const mockFetch = async () => {
    fetchCalls += 1;
    const payload = await responseFactory(fetchCalls);
    return {
      ok: true,
      status: 200,
      async json() {
        return payload;
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
    await fn(modApiService, { getFetchCalls: () => fetchCalls });
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

test('getModrinthVersions bypasses cache when forceRefresh is true', async () => {
  const responses = [
    [
      {
        id: 'architectury-1',
        version_number: '1.0.0',
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
        version_type: 'release',
        date_published: '2024-01-01T00:00:00Z',
        files: [{ size: 1024 }],
        downloads: 10
      }
    ],
    [
      {
        id: 'architectury-2',
        version_number: '2.0.0',
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
        version_type: 'release',
        date_published: '2024-02-01T00:00:00Z',
        files: [{ size: 2048 }],
        downloads: 20
      }
    ]
  ];

  await withMockedFetch(
    // Cycle through responses array based on call number (1-based)
    async call => responses[(call - 1) % responses.length],
    async (service, helpers) => {
      const initial = await service.getModrinthVersions('architectury', 'fabric', '1.21.1', false, false);
      assert.equal(initial[0].versionNumber, '1.0.0');
      assert.equal(helpers.getFetchCalls(), 1);

      const cached = await service.getModrinthVersions('architectury', 'fabric', '1.21.1', false, false);
      assert.equal(helpers.getFetchCalls(), 1, 'Second call should reuse cached data');
      assert.equal(cached[0].versionNumber, '1.0.0');

      const refreshed = await service.getModrinthVersions('architectury', 'fabric', '1.21.1', false, true);
      assert.equal(helpers.getFetchCalls(), 2, 'Force refresh should trigger a fresh fetch');
      assert.equal(refreshed[0].versionNumber, '2.0.0');
    }
  );
});

test('getModrinthVersions refreshes cached entries after the TTL expires', async () => {
  const responses = [
    [
      {
        id: 'architectury-1',
        version_number: '1.0.0',
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
        version_type: 'release',
        date_published: '2024-01-01T00:00:00Z',
        files: [{ size: 1024 }],
        downloads: 10
      }
    ],
    [
      {
        id: 'architectury-2',
        version_number: '2.0.0',
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
        version_type: 'release',
        date_published: '2024-02-01T00:00:00Z',
        files: [{ size: 2048 }],
        downloads: 20
      }
    ]
  ];

  await withMockedFetch(
    async call => responses[Math.min(call, responses.length) - 1],
    async (service, helpers) => {
      const realDateNow = Date.now;
      try {
        let currentTime = 0;
        Date.now = () => currentTime;

        currentTime = 0;
        const first = await service.getModrinthVersions('architectury', 'fabric', '1.21.1', false, false);
        assert.equal(first[0].versionNumber, '1.0.0');
        assert.equal(helpers.getFetchCalls(), 1);

        const ttl = service.getVersionCacheTtlMs();
        currentTime = ttl - 1000;
        const beforeExpiry = await service.getModrinthVersions('architectury', 'fabric', '1.21.1', false, false);
        assert.equal(helpers.getFetchCalls(), 1, 'Cache should still be valid before TTL expires');
        assert.equal(beforeExpiry[0].versionNumber, '1.0.0');

        currentTime = ttl + 1000;
        const afterExpiry = await service.getModrinthVersions('architectury', 'fabric', '1.21.1', false, false);
        assert.equal(helpers.getFetchCalls(), 2, 'Expired cache should trigger a fresh fetch');
        assert.equal(afterExpiry[0].versionNumber, '2.0.0');
      } finally {
        Date.now = realDateNow;
      }
    }
  );
});
