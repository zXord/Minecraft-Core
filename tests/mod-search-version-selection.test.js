import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchCardVersionSelectionContext,
  resolveSearchCardVersionSelection,
  selectSearchCardVersionForFilter
} from '../src/utils/mods/searchVersionSelection.js';

const sampleVersions = [
  {
    id: 'old-version',
    versionNumber: '1.20.1-0.1.16.97',
    gameVersions: ['1.20.1'],
    isStable: true,
    datePublished: '2023-08-01T00:00:00.000Z'
  },
  {
    id: 'new-version',
    versionNumber: '1.20.1-1.4.33.1593',
    gameVersions: ['1.20.1'],
    isStable: true,
    datePublished: '2024-07-01T00:00:00.000Z'
  }
];

test('selectSearchCardVersionForFilter prefers the newest compatible stable version', () => {
  const selectedVersion = selectSearchCardVersionForFilter(sampleVersions, '1.20.1');

  assert.ok(selectedVersion);
  assert.equal(selectedVersion.id, 'new-version');
  assert.equal(selectedVersion.versionNumber, '1.20.1-1.4.33.1593');
});

test('resolveSearchCardVersionSelection replaces stale automatic selections after the version list changes', () => {
  const selectionContextKey = buildSearchCardVersionSelectionContext({
    modId: 'sophisticated-storage',
    activeContentType: 'mods',
    filterMinecraftVersion: '1.20.1',
    versions: sampleVersions
  });

  const resolvedSelection = resolveSearchCardVersionSelection({
    versions: sampleVersions,
    filterMinecraftVersion: '1.20.1',
    currentSelectedVersionId: 'old-version',
    manualSelectionContextKey: '',
    selectionContextKey
  });

  assert.equal(resolvedSelection.selectedVersionId, 'new-version');
  assert.equal(resolvedSelection.manualSelectionContextKey, '');
});

test('resolveSearchCardVersionSelection preserves a manual selection while the context stays the same', () => {
  const selectionContextKey = buildSearchCardVersionSelectionContext({
    modId: 'sophisticated-storage',
    activeContentType: 'mods',
    filterMinecraftVersion: '1.20.1',
    versions: sampleVersions
  });

  const resolvedSelection = resolveSearchCardVersionSelection({
    versions: sampleVersions,
    filterMinecraftVersion: '1.20.1',
    currentSelectedVersionId: 'old-version',
    manualSelectionContextKey: selectionContextKey,
    selectionContextKey
  });

  assert.equal(resolvedSelection.selectedVersionId, 'old-version');
  assert.equal(resolvedSelection.manualSelectionContextKey, selectionContextKey);
});

test('resolveSearchCardVersionSelection prefers the installed version when it exists in the current list', () => {
  const selectionContextKey = buildSearchCardVersionSelectionContext({
    modId: 'sophisticated-storage',
    activeContentType: 'mods',
    filterMinecraftVersion: '1.20.1',
    installedVersionId: 'old-version',
    versions: sampleVersions
  });

  const resolvedSelection = resolveSearchCardVersionSelection({
    versions: sampleVersions,
    filterMinecraftVersion: '1.20.1',
    installedVersionId: 'old-version',
    isInstalled: true,
    currentSelectedVersionId: 'new-version',
    manualSelectionContextKey: '',
    selectionContextKey
  });

  assert.equal(resolvedSelection.selectedVersionId, 'old-version');
  assert.equal(resolvedSelection.manualSelectionContextKey, '');
});
