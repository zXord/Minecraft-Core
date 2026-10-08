const REAL_TFG_RELEASE_ENV = 'MINECRAFT_CORE_REAL_TFG_RELEASE';
const DEFAULT_REAL_TFG_RELEASE = '0.13.9';
const REPOSITORY_URL = 'https://github.com/TerraFirmaGreg-Team/Modpack-Modern';
const REPOSITORY_ID = '535906412';
const FORGE_1_20_1 = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'forge',
  loaderVersion: '47.4.13'
});

function release({ releaseId, tagName, assets }) {
  return Object.freeze({
    repositoryUrl: REPOSITORY_URL,
    repositoryId: REPOSITORY_ID,
    releaseId,
    tagName,
    runtime: FORGE_1_20_1,
    assets: Object.freeze(assets.map(asset => Object.freeze({ ...asset })))
  });
}

const REAL_TFG_RELEASES = Object.freeze({
  '0.13.9': release({
    releaseId: '379048648',
    tagName: '0.13.9',
    assets: [
      {
        kind: 'serverpack',
        assetId: '535498017',
        fileName: 'TerraFirmaGreg-Modern-0.13.9-serverpack.zip',
        size: 525_413_976,
        sha256: '67272bb2cef53f19b7c69bcccbd2f1a068fa01976ce9205c172746315f2db0e3',
        expectedEntryCount: 4_913
      },
      {
        kind: 'multimc',
        assetId: '535498018',
        fileName: 'TerraFirmaGreg-Modern-0.13.9-multimc.zip',
        size: 709_391_665,
        sha256: '2727c1f09b0547ef782e9cd7f7bdc0051b5012e28ddbebbc0e44994e8f656d5b',
        expectedEntryCount: 18_541
      }
    ]
  }),
  '0.13.4': release({
    releaseId: '354323729',
    tagName: '0.13.4',
    assets: [{
      kind: 'serverpack',
      assetId: '477754820',
      fileName: 'TerraFirmaGreg-Modern-0.13.4-serverpack.zip',
      size: 519_260_266,
      sha256: '2e36fb62f8bb30f95ed244a03a0e01050c7e9f443211b14d35203a6126a6fdbf',
      expectedEntryCount: 4_794
    }]
  })
});

function selectRealTfgRelease(environment = process.env) {
  const requested = String(environment?.[REAL_TFG_RELEASE_ENV] || DEFAULT_REAL_TFG_RELEASE).trim();
  const selected = REAL_TFG_RELEASES[requested];
  if (!selected) throw new Error(`Unsupported real TerraFirmaGreg release: ${requested}`);
  return selected;
}

module.exports = {
  DEFAULT_REAL_TFG_RELEASE,
  REAL_TFG_RELEASE_ENV,
  REAL_TFG_RELEASES,
  selectRealTfgRelease
};
