import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchesInstalledContent,
  findInstalledContentEntry
} from '../src/utils/mods/modAPI.js';

test('matchesInstalledContent prefers project ID matches when available', () => {
  assert.equal(
    matchesInstalledContent(
      { id: 'P7dR8mSH', slug: 'fabric-api', name: 'Fabric API' },
      {
        installedIds: new Set(['P7dR8mSH']),
        installedInfoList: [],
        installedFilesList: []
      }
    ),
    true
  );
});

test('matchesInstalledContent falls back to installed filenames with version suffixes', () => {
  assert.equal(
    matchesInstalledContent(
      { id: 'cloth-config', slug: 'cloth-config', name: 'Cloth Config API' },
      {
        installedIds: new Set(),
        installedInfoList: [],
        installedFilesList: ['cloth-config-15.0.140-fabric.jar']
      }
    ),
    true
  );
});

test('findInstalledContentEntry resolves fuzzy asset name matches from installed info', () => {
  const installedInfo = [{
    fileName: 'complementary-reimagined_r5.2.2.zip',
    name: 'Complementary Reimagined',
    projectId: null
  }];

  const entry = findInstalledContentEntry(
    { id: 'shader-project', slug: 'complementary-reimagined', name: 'Complementary Reimagined' },
    { installedInfoList: installedInfo }
  );

  assert.equal(entry?.fileName, 'complementary-reimagined_r5.2.2.zip');
});
