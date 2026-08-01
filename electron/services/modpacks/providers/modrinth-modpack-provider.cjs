const { TextDecoder } = require('node:util');
const { createArtifactSetPlan } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { validateRemoteUrl } = require('../network/remote-url-policy.cjs');

const MODRINTH_ARTIFACT_HOSTS = Object.freeze(['cdn.modrinth.com']);
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHANNELS = new Set(['release', 'beta', 'alpha']);
const LOADERS = new Set(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);
const SERVER_COMPATIBILITY = new Set(['required', 'optional', 'unsupported', 'unknown']);

function invalidResponse() {
  return new ModpackError('INVALID_REQUEST', 'Modrinth returned an invalid response');
}

function invalidRequest(field) {
  return new ModpackError('INVALID_REQUEST', 'Modrinth request is invalid', { details: field ? { field } : undefined });
}

function unavailable() {
  return new ModpackError('INVALID_RELEASE_URL', 'Modrinth service is unavailable', { retryable: true });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasUnsafeControl(value, multiline = false) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    if (code === 127) return true;
    if (code >= 32) return false;
    return !multiline || (code !== 9 && code !== 10 && code !== 13);
  });
}

function text(value, max = 1024, { multiline = false, empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && value.length === 0) || hasUnsafeControl(value, multiline)) throw invalidResponse();
  return value;
}

function candidateUrl(value) {
  return text(value, 4096);
}

function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw invalidResponse();
  return value;
}

function requestIdentifier(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw invalidRequest(field);
  return value;
}

function timestamp(value) {
  text(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) throw invalidResponse();
  return value;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidResponse();
  return value;
}

function strings(value, { maxItems = 256, maxLength = 128 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw invalidResponse();
  return value.map(item => text(item, maxLength));
}

function optionalString(value, max = 1024, options) {
  return value === null || value === undefined ? null : text(value, max, options);
}

function normalizeCompatibility(value) {
  return SERVER_COMPATIBILITY.has(value) ? value : 'unknown';
}

function normalizeSearchHit(hit) {
  if (!plain(hit)) throw invalidResponse();
  const categories = strings(hit.categories, { maxItems: 128 });
  const gallery = hit.gallery === undefined ? [] : strings(hit.gallery, { maxItems: 32, maxLength: 4096 }).map(candidateUrl);
  return {
    projectId: identifier(hit.project_id),
    slug: text(hit.slug, 256),
    title: text(hit.title, 256),
    summary: text(hit.description, 4096, { multiline: true, empty: true }),
    iconUrlCandidate: optionalString(hit.icon_url, 4096),
    galleryUrlCandidates: gallery,
    categories,
    minecraftVersions: strings(hit.versions, { maxItems: 256, maxLength: 64 }),
    loaders: categories.filter(category => LOADERS.has(category)),
    serverCompatibility: normalizeCompatibility(hit.server_side),
    updatedAt: timestamp(hit.date_modified),
    downloads: count(hit.downloads)
  };
}

function normalizeGallery(value) {
  if (!Array.isArray(value) || value.length > 128) throw invalidResponse();
  return value.map(entry => {
    if (!plain(entry) || typeof entry.featured !== 'boolean') throw invalidResponse();
    return {
      urlCandidate: candidateUrl(entry.url),
      featured: entry.featured,
      ...(entry.title === null || entry.title === undefined ? {} : { title: text(entry.title, 256) }),
      ...(entry.description === null || entry.description === undefined ? {} : { description: text(entry.description, 4096, { multiline: true, empty: true }) })
    };
  });
}

function normalizeProject(project) {
  if (!plain(project) || project.project_type !== 'modpack') throw invalidResponse();
  const links = [];
  for (const [field, kind] of [['source_url', 'source'], ['issues_url', 'issues'], ['wiki_url', 'wiki'], ['discord_url', 'discord']]) {
    if (project[field] !== null && project[field] !== undefined) links.push({ kind, urlCandidate: candidateUrl(project[field]) });
  }
  if (project.donation_urls !== undefined) {
    if (!Array.isArray(project.donation_urls) || project.donation_urls.length > 64) throw invalidResponse();
    for (const donation of project.donation_urls) {
      if (!plain(donation)) throw invalidResponse();
      links.push({ kind: 'donation', label: text(donation.platform, 128), urlCandidate: candidateUrl(donation.url) });
    }
  }
  return deepFreeze({
    projectId: identifier(project.id),
    slug: text(project.slug, 256),
    title: text(project.title, 256),
    summary: text(project.description, 4096, { multiline: true, empty: true }),
    body: text(project.body, 1024 * 1024, { multiline: true, empty: true }),
    iconUrlCandidate: optionalString(project.icon_url, 4096),
    galleryCandidates: normalizeGallery(project.gallery ?? []),
    runtimes: {
      minecraftVersions: strings(project.game_versions, { maxItems: 256, maxLength: 64 }),
      loaders: strings(project.loaders, { maxItems: 64 }).map(loader => loader === 'fabric-loader' ? 'fabric' : loader === 'quilt-loader' ? 'quilt' : loader)
    },
    serverCompatibility: normalizeCompatibility(project.server_side),
    updatedAt: timestamp(project.updated),
    downloads: count(project.downloads),
    upstreamLinkCandidates: links
  });
}

function normalizeFile(file) {
  if (!plain(file) || !plain(file.hashes) || typeof file.primary !== 'boolean') throw invalidResponse();
  if (!/^[a-f0-9]{40}$/.test(file.hashes.sha1 || '') || !/^[a-f0-9]{128}$/.test(file.hashes.sha512 || '')) throw invalidResponse();
  return {
    hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
    downloadUrlCandidate: candidateUrl(file.url),
    fileName: text(file.filename, 255),
    primary: file.primary,
    size: String(count(file.size)),
    ...(file.file_type === null || file.file_type === undefined ? {} : { fileType: text(file.file_type, 128) })
  };
}

function normalizeVersion(value) {
  if (!plain(value) || !CHANNELS.has(value.version_type) || !Array.isArray(value.files) || value.files.length > 1024 || !Array.isArray(value.dependencies)) throw invalidResponse();
  return deepFreeze({
    versionId: identifier(value.id),
    projectId: identifier(value.project_id),
    name: text(value.name, 256),
    version: text(value.version_number, 256),
    changelog: optionalString(value.changelog, 1024 * 1024, { multiline: true, empty: true }),
    channel: value.version_type,
    minecraftVersions: strings(value.game_versions, { maxItems: 256, maxLength: 64 }),
    loaders: strings(value.loaders, { maxItems: 64 }).map(loader => loader === 'fabric-loader' ? 'fabric' : loader === 'quilt-loader' ? 'quilt' : loader),
    publishedAt: timestamp(value.date_published),
    downloads: count(value.downloads),
    files: value.files.map(normalizeFile)
  });
}

function requestFilterStrings(value, field, { maxItems = 32, pattern = /^[A-Za-z0-9._-]{1,128}$/ } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw invalidRequest(field);
  const seen = new Set();
  return value.map(item => {
    if (typeof item !== 'string' || !pattern.test(item) || seen.has(item)) throw invalidRequest(field);
    seen.add(item);
    return item;
  });
}

class ModrinthModpackProvider {
  constructor({ http, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
    if (!http || typeof http.request !== 'function' || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new TypeError('Modrinth provider dependencies are invalid');
    this.http = http;
    this.maxResponseBytes = maxResponseBytes;
  }

  async requestJson(path, options, { missingCode, missingId } = {}) {
    let response;
    try { response = await this.http.request(path, options); }
    catch (error) { if (error instanceof ModpackError) throw error; throw unavailable(); }
    if (!response || !Number.isSafeInteger(response.statusCode) || (!Buffer.isBuffer(response.body) && typeof response.body !== 'string')) throw invalidResponse();
    if (response.statusCode === 404 && missingCode) {
      const details = missingCode === 'REPOSITORY_NOT_FOUND'
        ? { provider: 'modrinth', repositoryId: missingId }
        : { provider: 'modrinth', releaseId: missingId };
      throw new ModpackError(missingCode, missingCode === 'REPOSITORY_NOT_FOUND' ? 'Modrinth project was not found' : 'Modrinth version was not found', { details });
    }
    if (response.statusCode < 200 || response.statusCode >= 300) throw unavailable();
    const bytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body, 'utf8');
    if (bytes.length > this.maxResponseBytes) {
      throw new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Modrinth response exceeded the configured byte limit', {
        details: { limit: 'maxTechnicalStdoutBytes', actual: String(bytes.length) }
      });
    }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw invalidResponse(); }
    return value;
  }

  async searchProjects({ query = '', categories = [], gameVersion, loader, channel, serverCompatibility, sort = 'updated', offset = 0, limit = 20 } = {}) {
    if (typeof query !== 'string' || query.length > 256 || hasUnsafeControl(query)) throw invalidRequest('query');
    categories = requestFilterStrings(categories, 'categories');
    if (gameVersion !== undefined && (typeof gameVersion !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(gameVersion))) throw invalidRequest('gameVersion');
    if (loader !== undefined && !LOADERS.has(loader)) throw invalidRequest('loader');
    if (channel !== undefined && !CHANNELS.has(channel)) throw invalidRequest('channel');
    if (serverCompatibility !== undefined && serverCompatibility !== 'compatible' && !SERVER_COMPATIBILITY.has(serverCompatibility)) throw invalidRequest('serverCompatibility');
    if (sort !== 'updated' && sort !== 'downloads') throw invalidRequest('sort');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidRequest('offset');

    const facets = [['project_type:modpack']];
    if (categories.length) facets.push(categories.map(category => `categories:${category}`));
    if (gameVersion) facets.push([`versions:${gameVersion}`]);
    if (loader) facets.push([`categories:${loader}`]);
    if (serverCompatibility === 'compatible') facets.push(['server_side:required', 'server_side:optional']);
    else if (serverCompatibility) facets.push([`server_side:${serverCompatibility}`]);
    const value = await this.requestJson('/search', { query: {
      query,
      facets: JSON.stringify(facets),
      index: sort,
      offset: String(offset),
      limit: String(limit)
    } });
    if (!plain(value) || !Array.isArray(value.hits) || value.hits.length > 100) throw invalidResponse();
    return deepFreeze({
      items: value.hits.map(normalizeSearchHit),
      pagination: { offset: count(value.offset), limit: count(value.limit), total: count(value.total_hits) }
    });
  }

  async getProject(projectId) {
    projectId = requestIdentifier(projectId, 'projectId');
    return normalizeProject(await this.requestJson(`/project/${projectId}`, undefined, { missingCode: 'REPOSITORY_NOT_FOUND', missingId: projectId }));
  }

  async listVersions({ projectId, gameVersions, loaders, channels } = {}) {
    projectId = requestIdentifier(projectId, 'projectId');
    gameVersions = requestFilterStrings(gameVersions, 'gameVersions');
    loaders = requestFilterStrings(loaders, 'loaders');
    channels = requestFilterStrings(channels, 'channels', { pattern: /^(?:release|beta|alpha)$/ });
    const query = {};
    if (gameVersions.length) query.game_versions = JSON.stringify(gameVersions);
    if (loaders.length) query.loaders = JSON.stringify(loaders);
    const value = await this.requestJson(`/project/${projectId}/version`, { query }, { missingCode: 'REPOSITORY_NOT_FOUND', missingId: projectId });
    if (!Array.isArray(value) || value.length > 1000) throw invalidResponse();
    const versions = value.map(normalizeVersion);
    return deepFreeze(channels.length ? versions.filter(item => channels.includes(item.channel)) : versions);
  }

  async getVersion(versionId) {
    versionId = requestIdentifier(versionId, 'versionId');
    return normalizeVersion(await this.requestJson(`/version/${versionId}`, undefined, { missingCode: 'RELEASE_NOT_FOUND', missingId: versionId }));
  }

  async resolveArtifactSetPlan(versionId) {
    const release = await this.getVersion(versionId);
    const candidates = release.files.filter(file => file.primary && file.fileName.toLocaleLowerCase('en-US').endsWith('.mrpack'));
    if (candidates.length === 0) throw new ModpackError('NO_INSTALLABLE_ASSET', 'Modrinth version has no primary pack artifact');
    if (candidates.length !== 1) throw new ModpackError('ASSET_AMBIGUOUS', 'Modrinth version has multiple primary pack artifacts', { details: { count: String(candidates.length) } });
    const file = candidates[0];
    const url = validateRemoteUrl(file.downloadUrlCandidate, { allowedHosts: MODRINTH_ARTIFACT_HOSTS, allowSubdomains: false });
    if (url.port && url.port !== '443') throw new ModpackError('INVALID_RELEASE_URL', 'Modrinth artifact address is not allowed', { details: { reasonCode: 'host-not-allowed' } });
    const partId = `file-${file.hashes.sha1}`;
    const persisted = createArtifactSetPlan({
      provider: 'modrinth',
      project: { id: release.projectId, slug: release.projectId, title: release.projectId },
      release: { id: release.versionId, version: release.version, channel: release.channel, publishedAt: release.publishedAt },
      artifactSet: {
        kind: 'single', primaryPartId: partId, groupingScheme: 'single', providerImmutable: true, attestationStatus: 'verified',
        parts: [{
          partId,
          fileName: file.fileName,
          size: file.size,
          updatedAt: release.publishedAt,
          providerDigest: { algorithm: 'sha512', value: file.hashes.sha512 }
        }]
      }
    });
    return deepFreeze({
      ...persisted,
      artifactSet: {
        ...persisted.artifactSet,
        parts: [{
          ...persisted.artifactSet.parts[0],
          downloadUrl: url.href,
          allowedHosts: [...MODRINTH_ARTIFACT_HOSTS],
          allowSubdomains: false,
          requiredProviderDigests: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 }
        }]
      }
    });
  }
}

module.exports = { MODRINTH_ARTIFACT_HOSTS, ModrinthModpackProvider };
