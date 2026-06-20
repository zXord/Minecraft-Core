import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getProjectPageAction,
  getProjectSourceLabel,
  getModrinthProjectPageUrl,
  normalizeModrinthProjectDetails
} from '../src/utils/mods/modrinthProjectLinks.js';

test('getModrinthProjectPageUrl uses typed slug URLs when project details are available', () => {
  const url = getModrinthProjectPageUrl(
    { projectId: 'P7dR8mSH' },
    { id: 'P7dR8mSH', slug: 'fabric-api', project_type: 'mod' }
  );

  assert.equal(url, 'https://modrinth.com/mod/fabric-api');
});

test('getModrinthProjectPageUrl falls back to project id URL without project type details', () => {
  const url = getModrinthProjectPageUrl({ projectId: 'P7dR8mSH' });

  assert.equal(url, 'https://modrinth.com/project/P7dR8mSH');
});

test('normalizeModrinthProjectDetails keeps the short project summary fields used by the UI', () => {
  const details = normalizeModrinthProjectDetails({
    id: 'AABBCCDD',
    slug: 'example-mod',
    title: 'Example Mod',
    description: 'A compact description',
    project_type: 'mod',
    client_side: 'required',
    server_side: 'optional',
    categories: ['fabric', 'utility']
  });

  assert.deepEqual(details, {
    id: 'AABBCCDD',
    slug: 'example-mod',
    title: 'Example Mod',
    description: 'A compact description',
    downloads: 0,
    followers: 0,
    projectType: 'mod',
    clientSide: 'required',
    serverSide: 'optional',
    categories: ['fabric', 'utility']
  });
});

test('getProjectPageAction only creates Modrinth URLs for Modrinth sourced mods', () => {
  const action = getProjectPageAction(
    { projectId: 'P7dR8mSH', source: 'modrinth' },
    { project_type: 'mod', slug: 'fabric-api', title: 'Fabric API' }
  );

  assert.deepEqual(action, {
    url: 'https://modrinth.com/mod/fabric-api',
    label: 'Modrinth page',
    source: 'modrinth'
  });
});

test('getProjectPageAction uses explicit non-Modrinth project URLs when present', () => {
  const action = getProjectPageAction({
    name: 'Example Mod',
    source: 'curseforge',
    projectUrl: 'https://www.curseforge.com/minecraft/mc-mods/example-mod'
  });

  assert.deepEqual(action, {
    url: 'https://www.curseforge.com/minecraft/mc-mods/example-mod',
    label: 'CurseForge page',
    source: 'curseforge'
  });
});

test('getProjectPageAction does not invent provider pages for unknown sources', () => {
  assert.equal(getProjectPageAction({ projectId: 'local-mod-id', source: 'server' }), null);
  assert.equal(getProjectPageAction({ projectId: 'local-mod-id' }), null);
});

test('getProjectSourceLabel provides safe user-facing source names', () => {
  assert.equal(getProjectSourceLabel({ source: 'modrinth' }), 'Modrinth');
  assert.equal(getProjectSourceLabel({ source: 'curseforge' }), 'CurseForge');
  assert.equal(getProjectSourceLabel({ source: 'server' }), 'server');
  assert.equal(getProjectSourceLabel({}), 'unknown source');
});
