import assert from 'node:assert/strict';

import {
  checkModDependencies,
  installWithDependencies,
  isDependencyRelevantToActiveLoader
} from '../src/utils/mods/modDependencyHelper.js';
import {
  currentDependencies,
  disabledMods,
  installedModInfo,
  loaderType,
  minecraftVersion,
  modToInstall
} from '../src/stores/modStore.js';

const API = 'https://api.modrinth.com/v2';
const MC_VERSION = '1.20.1';
const USER_AGENT = 'minecraft-core-dependency-matrix/1.0';
const TARGET_PER_LOADER = Number.parseInt(process.env.DEPENDENCY_MATRIX_CASES || '50', 10);
const EXTRA_EXCLUDED_SLUGS = (process.env.DEPENDENCY_MATRIX_EXCLUDE_SLUGS || '')
  .split(',')
  .map(slug => slug.trim().toLowerCase())
  .filter(Boolean);

const BASELINE_MATRIX = {
  fabric: [
    { slug: 'iris', title: 'Iris Shaders', versionId: 's5eFLITc', versionNumber: '1.7.6+1.20.1' },
    { slug: 'entityculling', title: 'Entity Culling', versionId: 'rpOQImBG', versionNumber: '1.10.2' },
    { slug: 'yacl', title: 'YetAnotherConfigLib (YACL)', versionId: 'dvS5DjUA', versionNumber: '3.6.6+1.20.1-fabric' },
    { slug: 'xaeros-minimap', title: "Xaero's Minimap", versionId: 'IAvIWG18', versionNumber: 'fabric-1.20.1-25.3.12' },
    { slug: 'architectury-api', title: 'Architectury API', versionId: 'WbL7MStR', versionNumber: '9.2.14+fabric' },
    { slug: 'entity-model-features', title: '[EMF] Entity Model Features', versionId: 'HLnLv1St', versionNumber: '3.2.4-fabric-1.20.1' },
    { slug: 'xaeros-world-map', title: "Xaero's World Map", versionId: '4iL1uj0g', versionNumber: 'fabric-1.20.1-1.40.16' },
    { slug: 'sodium-extra', title: 'Sodium Extra', versionId: 'mDbF0LZT', versionNumber: 'mc1.20.1-0.5.9' },
    { slug: 'appleskin', title: 'AppleSkin', versionId: 'N5XeV21r', versionNumber: '2.5.2+mc1.20.1' },
    { slug: 'not-enough-animations', title: 'Not Enough Animations', versionId: '77cUnpse', versionNumber: '1.12.3' },
    { slug: 'reeses-sodium-options', title: "Reese's Sodium Options", versionId: 'Rc9pkPug', versionNumber: 'mc1.20.1-1.7.2' },
    { slug: 'continuity', title: 'Continuity', versionId: 'qGTDcjHM', versionNumber: '3.0.0+1.20.1' },
    { slug: '3dskinlayers', title: '3D Skin Layers', versionId: 'V0AEyC8i', versionNumber: '1.11.1' },
    { slug: 'veinminer', title: 'VeinMiner', versionId: 'PSctVdKm', versionNumber: '2.0.7+1.20.1' },
    { slug: 'geckolib', title: 'Geckolib', versionId: 'PdrSPr53', versionNumber: '4.8.3' },
    { slug: 'dynamic-fps', title: 'Dynamic FPS', versionId: 'QwPQBhiQ', versionNumber: '3.11.4' },
    { slug: 'zoomify', title: 'Zoomify (Zoom)', versionId: 'PEJt9yRp', versionNumber: '2.15.2+1.20.1' },
    { slug: 'forge-config-api-port', title: 'Forge Config API Port', versionId: 'HvR3IdRE', versionNumber: 'v8.0.3-1.20.1-Fabric' },
    { slug: 'moreculling', title: 'More Culling', versionId: '3wkuUDPy', versionNumber: '1.20.1-0.24.5' },
    { slug: 'fancymenu', title: 'FancyMenu', versionId: 'CIMrqM91', versionNumber: '3.9.1-1.20.1-fabric' }
  ],
  forge: [
    { slug: 'entity-model-features', title: '[EMF] Entity Model Features', versionId: 'VSBDdOOY', versionNumber: '3.2.4-forge-1.20.1' },
    { slug: 'continuity', title: 'Continuity', versionId: '9KbAcWSO', versionNumber: '3.0.0+1.20.1.forge' },
    { slug: 'fancymenu', title: 'FancyMenu', versionId: 'NWQbGlsX', versionNumber: '3.9.3-1.20.1-forge' },
    { slug: 'enchantment-descriptions', title: 'Enchantment Descriptions', versionId: 'OPgBRfTQ', versionNumber: '17.1.21' },
    { slug: 'inventory-profiles-next', title: 'Inventory Profiles Next', versionId: 'CrtAI3P9', versionNumber: 'forge-1.20.1-1.10.20' },
    { slug: 'controlling', title: 'Controlling', versionId: 'LH6Bi6Am', versionNumber: '12.0.2' },
    { slug: 'ambientsounds', title: 'AmbientSounds', versionId: 'AuLdtrBY', versionNumber: '6.3.8' },
    { slug: 'shulkerboxtooltip', title: 'Shulker Box Tooltip', versionId: 'QMp2SF1u', versionNumber: '4.0.4+1.20.1-forge' },
    { slug: 'oculus', title: 'Oculus', versionId: 'iQ1SwGc3', versionNumber: '1.20.1-1.8.0' },
    { slug: 'cobblemon', title: 'Cobblemon', versionId: 'vm5zUZAg', versionNumber: '1.5.2' },
    { slug: 'libipn', title: 'libIPN', versionId: 'pdAXmKcS', versionNumber: 'forge-1.20-4.0.2' },
    { slug: 'betterf3', title: 'BetterF3', versionId: 'xo6HmgWj', versionNumber: '7.0.2' },
    { slug: 'fzzy-config', title: 'Fzzy Config', versionId: '7MmXhjWs', versionNumber: '0.7.6+1.20.1+forge' },
    { slug: 'biomes-o-plenty', title: "Biomes O' Plenty", versionId: 'jxUqRzSD', versionNumber: '19.0.0.96' },
    { slug: 'rei', title: 'Roughly Enough Items (REI)', versionId: 'IoS2AjPk', versionNumber: '12.1.785+forge' },
    { slug: 'visual-workbench', title: 'Visual Workbench', versionId: 'qaWEHDC3', versionNumber: 'v8.0.1-1.20.1-Forge' },
    { slug: 'supplementaries', title: 'Supplementaries', versionId: 'S0TIJ1hU', versionNumber: '1.20-3.1.43-forge' },
    { slug: 'handcrafted', title: 'Handcrafted', versionId: 'N7wZwOFy', versionNumber: '3.0.6' },
    { slug: 'waystones', title: 'Waystones', versionId: 'sKoHLGbK', versionNumber: '14.1.20+forge-1.20.1' },
    { slug: 'netherportalfix', title: 'NetherPortalFix', versionId: 'cWPAnu7u', versionNumber: '13.0.1+forge-1.20' }
  ]
};

const jsonCache = new Map();
const projectCache = new Map();
const versionListCache = new Map();

async function getJson(url) {
  if (jsonCache.has(url)) {
    return jsonCache.get(url);
  }

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  });

  if (!response.ok) {
    throw new Error(`Modrinth API ${response.status}: ${url}`);
  }

  const json = await response.json();
  jsonCache.set(url, json);
  return json;
}

async function getProjectInfo(projectIdOrSlug) {
  if (!projectCache.has(projectIdOrSlug)) {
    projectCache.set(projectIdOrSlug, getJson(`${API}/project/${projectIdOrSlug}`));
  }
  return await projectCache.get(projectIdOrSlug);
}

async function getVersionInfo(versionId) {
  return await getJson(`${API}/version/${versionId}`);
}

async function getVersions(projectIdOrSlug, loader) {
  const cacheKey = `${projectIdOrSlug}:${loader}:${MC_VERSION}`;
  if (!versionListCache.has(cacheKey)) {
    const loaders = encodeURIComponent(JSON.stringify([loader]));
    const gameVersions = encodeURIComponent(JSON.stringify([MC_VERSION]));
    versionListCache.set(
      cacheKey,
      getJson(`${API}/project/${projectIdOrSlug}/version?loaders=${loaders}&game_versions=${gameVersions}&include_changelog=false`)
    );
  }

  const versions = await versionListCache.get(cacheKey);
  return versions.map(version => ({
    id: version.id,
    name: version.name,
    versionNumber: version.version_number,
    versionType: version.version_type || 'release',
    gameVersions: version.game_versions,
    loaders: version.loaders,
    dependencies: version.dependencies || [],
    datePublished: version.date_published,
    isStable: version.version_type === 'release',
    fileSize: version.files?.[0]?.size,
    downloads: version.downloads || 0
  })).sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime());
}

async function searchProjects(loader, offset) {
  const facets = encodeURIComponent(JSON.stringify([
    ['project_type:mod'],
    [`versions:${MC_VERSION}`],
    [`categories:${loader}`]
  ]));
  return await getJson(`${API}/search?facets=${facets}&index=downloads&limit=100&offset=${offset}`);
}

function hasRequiredProjectDependency(version) {
  return (version.dependencies || []).some(dep => dep.dependency_type === 'required' && dep.project_id);
}

async function selectVersionWithRequiredDependency(projectIdOrSlug, loader) {
  const versions = await getVersions(projectIdOrSlug, loader);
  return versions.find(hasRequiredProjectDependency) || null;
}

function sortedUnique(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

async function collectExpectedDependencies(root, loader, visited = new Set()) {
  const expected = new Map();
  const optional = new Set();

  async function visit(projectIdOrSlug, versionId, depth) {
    const key = `${projectIdOrSlug}:${versionId || 'latest'}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);

    let version;
    if (versionId) {
      version = await getVersionInfo(versionId);
    } else {
      const versions = await getVersions(projectIdOrSlug, loader);
      version = versions[0] ? await getVersionInfo(versions[0].id) : null;
    }

    if (!version) {
      return;
    }

    for (const dep of version.dependencies || []) {
      if (!isDependencyRelevantToActiveLoader(dep.project_id, loader)) {
        continue;
      }

      if (dep.dependency_type === 'optional' && dep.project_id) {
        optional.add(dep.project_id);
      }

      if (dep.dependency_type !== 'required' || !dep.project_id) {
        continue;
      }

      if (!expected.has(dep.project_id)) {
        const projectInfo = await getProjectInfo(dep.project_id);
        expected.set(dep.project_id, {
          projectId: dep.project_id,
          name: projectInfo.title || dep.project_id,
          via: depth === 0 ? 'direct' : 'transitive'
        });
      }

      await visit(dep.project_id, dep.version_id || null, depth + 1);
    }
  }

  await visit(root.slug, root.versionId, 0);
  return {
    expected: Array.from(expected.values()).sort((a, b) => a.projectId.localeCompare(b.projectId)),
    optional: sortedUnique(Array.from(optional))
  };
}

async function discoverMatrix(loader, count, excludedSlugs) {
  const selected = [];
  const seen = new Set(excludedSlugs);
  let offset = 0;

  while (selected.length < count && offset < 1000) {
    const search = await searchProjects(loader, offset);
    const hits = search.hits || [];

    if (hits.length === 0) {
      break;
    }

    for (const hit of hits) {
      const slug = hit.slug || hit.project_id;
      const normalizedSlug = slug.toLowerCase();

      if (seen.has(normalizedSlug)) {
        continue;
      }

      seen.add(normalizedSlug);

      try {
        const version = await selectVersionWithRequiredDependency(slug, loader);
        if (!version) {
          continue;
        }

        const root = {
          slug,
          title: hit.title || slug,
          versionId: version.id,
          versionNumber: version.versionNumber
        };
        const { expected } = await collectExpectedDependencies(root, loader, new Set());

        if (expected.length === 0) {
          continue;
        }

        selected.push(root);
        console.log(`SELECT\t${loader}\t${slug}\t${version.versionNumber}`);

        if (selected.length >= count) {
          break;
        }
      } catch (error) {
        console.warn(`SKIP\t${loader}\t${slug}\t${error.message}`);
      }
    }

    offset += hits.length;
  }

  if (selected.length < count) {
    throw new Error(`Only found ${selected.length}/${count} ${loader} projects with required dependencies outside the baseline matrix`);
  }

  return selected;
}

globalThis.window = {
  electron: {
    async invoke(channel, payload) {
      if (channel === 'get-version-info') {
        if (payload.versionId) {
          return await getVersionInfo(payload.versionId);
        }

        const versions = await getVersions(payload.modId, payload.loader, payload.gameVersion || MC_VERSION);
        return versions[0] ? await getVersionInfo(versions[0].id) : null;
      }

      if (channel === 'get-project-info') {
        return await getProjectInfo(payload.projectId);
      }

      if (channel === 'get-mod-info') {
        return await getProjectInfo(payload.modId);
      }

      if (channel === 'get-mod-versions') {
        return await getVersions(payload.modId, payload.loader, payload.mcVersion || MC_VERSION);
      }

      throw new Error(`Unexpected IPC channel in dependency matrix: ${channel}`);
    }
  }
};

async function runCase(root, loader) {
  loaderType.set(loader);
  minecraftVersion.set(MC_VERSION);
  installedModInfo.set([]);
  disabledMods.set(new Set());
  currentDependencies.set([]);
  modToInstall.set(null);

  const { expected, optional } = await collectExpectedDependencies(root, loader);
  assert.ok(expected.length > 0, `${loader}/${root.slug} no longer has required dependencies in locked version metadata`);

  const detected = await checkModDependencies({
    id: root.slug,
    name: root.title,
    source: 'modrinth',
    selectedVersionId: root.versionId
  }, new Set(), { interactive: false });

  const detectedIds = sortedUnique(detected.map(dep => dep.projectId));
  const expectedIds = sortedUnique(expected.map(dep => dep.projectId));
  const forcedOptionalIds = optional.filter(projectId =>
    detectedIds.includes(projectId) && !expectedIds.includes(projectId)
  );

  modToInstall.set({
    id: root.slug,
    name: root.title,
    source: 'modrinth',
    selectedVersionId: root.versionId
  });
  currentDependencies.set(detected);

  const installCalls = [];
  const installResult = await installWithDependencies('dependency-matrix-server-path', async (mod) => {
    installCalls.push(mod.id);
    return true;
  }, 'mods');

  const dependencyInstallIds = installCalls.filter(id => id !== root.slug);

  return {
    loader,
    slug: root.slug,
    title: root.title,
    versionId: root.versionId,
    versionNumber: root.versionNumber,
    expected,
    detected: detected
      .map(dep => ({
        projectId: dep.projectId,
        name: dep.name,
        dependencyType: dep.dependencyType
      }))
      .sort((a, b) => a.projectId.localeCompare(b.projectId)),
    expectedIds,
    detectedIds,
    installDependencyIds: sortedUnique(dependencyInstallIds),
    optionalIds: optional,
    forcedOptionalIds,
    installResult,
    pass:
      installResult === true &&
      forcedOptionalIds.length === 0 &&
      JSON.stringify(expectedIds) === JSON.stringify(detectedIds) &&
      JSON.stringify(expectedIds) === JSON.stringify(sortedUnique(dependencyInstallIds))
  };
}

const results = [];
const baselineSlugs = new Set(
  Object.values(BASELINE_MATRIX)
    .flat()
    .map(root => root.slug.toLowerCase())
);
for (const slug of EXTRA_EXCLUDED_SLUGS) {
  baselineSlugs.add(slug);
}
const matrix = {
  fabric: await discoverMatrix('fabric', TARGET_PER_LOADER, baselineSlugs),
  forge: await discoverMatrix('forge', TARGET_PER_LOADER, baselineSlugs)
};

for (const loader of ['fabric', 'forge']) {
  for (const root of matrix[loader]) {
    const result = await runCase(root, loader);
    results.push(result);
    const status = result.pass ? 'PASS' : 'FAIL';
    console.log(`${status}\t${loader}\t${root.slug}\texpected=${result.expectedIds.join(',')}\tdetected=${result.detectedIds.join(',')}\tinstall=${result.installDependencyIds.join(',')}`);
  }
}

const failures = results.filter(result => !result.pass);
const summary = {
  minecraftVersion: MC_VERSION,
  targetPerLoader: TARGET_PER_LOADER,
  excludedBaselineCount: baselineSlugs.size,
  extraExcludedCount: EXTRA_EXCLUDED_SLUGS.length,
  fabricCount: results.filter(result => result.loader === 'fabric').length,
  forgeCount: results.filter(result => result.loader === 'forge').length,
  passCount: results.filter(result => result.pass).length,
  failCount: failures.length,
  failures: failures.map(result => ({
    loader: result.loader,
    slug: result.slug,
    expectedIds: result.expectedIds,
    detectedIds: result.detectedIds,
    installDependencyIds: result.installDependencyIds,
    forcedOptionalIds: result.forcedOptionalIds,
    installResult: result.installResult
  })),
  results
};

console.log(`MATRIX_JSON ${JSON.stringify(summary)}`);

if (failures.length > 0) {
  process.exitCode = 1;
}
