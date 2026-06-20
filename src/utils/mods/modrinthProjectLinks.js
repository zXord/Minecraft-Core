const PROJECT_TYPE_PATHS = {
  mod: 'mod',
  shader: 'shader',
  resourcepack: 'resourcepack',
  modpack: 'modpack',
  plugin: 'plugin',
  datapack: 'datapack'
};

const EXPLICIT_PROJECT_URL_FIELDS = [
  'projectUrl',
  'project_url',
  'pageUrl',
  'page_url',
  'websiteUrl',
  'website_url',
  'homepage',
  'homePage',
  'url'
];

function normalizeSource(source) {
  const normalized = String(source || '').trim().toLowerCase();
  if (normalized === 'modrinth') return 'modrinth';
  if (normalized === 'curseforge' || normalized === 'curse-forge') return 'curseforge';
  if (normalized === 'server') return 'server';
  if (normalized === 'manual') return 'manual';
  return '';
}

function readNestedValue(source, path) {
  return path.split('.').reduce((value, key) => value?.[key], source);
}

function getExplicitProjectUrl(mod = {}, projectInfo = {}) {
  for (const field of EXPLICIT_PROJECT_URL_FIELDS) {
    const value = mod[field] || projectInfo[field];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      return value;
    }
  }

  for (const field of ['links.websiteUrl', 'links.website_url', 'links.projectUrl', 'links.project_url']) {
    const value = readNestedValue(mod, field) || readNestedValue(projectInfo, field);
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      return value;
    }
  }

  return '';
}

export function getProjectSource(mod = {}, projectInfo = {}) {
  const source = normalizeSource(
    mod.source
    || mod.provider
    || mod.platform
    || projectInfo.source
    || projectInfo.provider
    || projectInfo.platform
  );

  if (source) return source;
  if (mod.modrinthId || projectInfo.modrinthId || projectInfo.modrinth_id) return 'modrinth';
  if (mod.curseforgeId || mod.curseForgeId || projectInfo.curseforgeId || projectInfo.curseForgeId) return 'curseforge';
  return '';
}

export function getProjectSourceLabel(mod = {}, projectInfo = {}) {
  const source = getProjectSource(mod, projectInfo);
  if (source === 'modrinth') return 'Modrinth';
  if (source === 'curseforge') return 'CurseForge';
  if (source === 'server') return 'server';
  if (source === 'manual') return 'manual install';
  return 'unknown source';
}

export function normalizeModrinthProjectDetails(projectInfo = {}) {
  if (!projectInfo || typeof projectInfo !== 'object') {
    return {};
  }

  return {
    id: projectInfo.id || projectInfo.projectId || projectInfo.project_id || null,
    slug: projectInfo.slug || null,
    title: projectInfo.title || projectInfo.name || null,
    description: projectInfo.description || null,
    downloads: projectInfo.downloads || 0,
    followers: projectInfo.followers || projectInfo.follows || 0,
    projectType: projectInfo.projectType || projectInfo.project_type || null,
    clientSide: projectInfo.clientSide || projectInfo.client_side || null,
    serverSide: projectInfo.serverSide || projectInfo.server_side || null,
    categories: Array.isArray(projectInfo.categories) ? projectInfo.categories : []
  };
}

export function getModrinthProjectPageUrl(mod = {}, projectInfo = {}) {
  const details = normalizeModrinthProjectDetails(projectInfo);
  const projectId = details.id || mod.projectId || mod.id || mod.project_id;

  if (!projectId) {
    return '';
  }

  const projectType = details.projectType || mod.projectType || mod.project_type || null;
  const pathSegment = PROJECT_TYPE_PATHS[String(projectType || '').toLowerCase()];
  const slugOrId = details.slug || mod.slug || projectId;

  if (!pathSegment) {
    return `https://modrinth.com/project/${encodeURIComponent(projectId)}`;
  }

  return `https://modrinth.com/${pathSegment}/${encodeURIComponent(slugOrId)}`;
}

export function getProjectPageAction(mod = {}, projectInfo = {}) {
  const source = getProjectSource(mod, projectInfo);
  const explicitUrl = getExplicitProjectUrl(mod, projectInfo);

  if (source === 'modrinth') {
    const url = explicitUrl || getModrinthProjectPageUrl(mod, projectInfo);
    return url ? { url, label: 'Modrinth page', source } : null;
  }

  if (explicitUrl) {
    return {
      url: explicitUrl,
      label: source === 'curseforge' ? 'CurseForge page' : 'project page',
      source: source || 'external'
    };
  }

  return null;
}
