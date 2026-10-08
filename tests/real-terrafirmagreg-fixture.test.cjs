const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_REAL_TFG_RELEASE,
  REAL_TFG_RELEASE_ENV,
  selectRealTfgRelease
} = require('./e2e/fixtures/real-terrafirmagreg-fixture.cjs');

test('the default real TerraFirmaGreg run retains the 0.13.9 server and client-only coverage', () => {
  const release = selectRealTfgRelease({});

  assert.equal(DEFAULT_REAL_TFG_RELEASE, '0.13.9');
  assert.equal(release.tagName, '0.13.9');
  assert.deepEqual(release.assets.map(asset => asset.kind), ['serverpack', 'multimc']);
});

test('an explicit 0.13.4 run selects the exact serverpack that reproduced the user failure', () => {
  const release = selectRealTfgRelease({ [REAL_TFG_RELEASE_ENV]: ' 0.13.4 ' });

  assert.deepEqual({
    releaseId: release.releaseId,
    tagName: release.tagName,
    runtime: release.runtime,
    assets: release.assets
  }, {
    releaseId: '354323729',
    tagName: '0.13.4',
    runtime: {
      minecraftVersion: '1.20.1',
      loaderFamily: 'forge',
      loaderVersion: '47.4.13'
    },
    assets: [{
      kind: 'serverpack',
      assetId: '477754820',
      fileName: 'TerraFirmaGreg-Modern-0.13.4-serverpack.zip',
      size: 519_260_266,
      sha256: '2e36fb62f8bb30f95ed244a03a0e01050c7e9f443211b14d35203a6126a6fdbf',
      expectedEntryCount: 4_794
    }]
  });
});

test('an unsupported explicit release fails closed instead of silently falling back', () => {
  assert.throws(
    () => selectRealTfgRelease({ [REAL_TFG_RELEASE_ENV]: '0.13.8' }),
    /Unsupported real TerraFirmaGreg release: 0\.13\.8/u
  );
});
