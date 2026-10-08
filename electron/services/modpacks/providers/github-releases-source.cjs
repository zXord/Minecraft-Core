const { TextDecoder } = require('node:util');
const { createArtifactSetPlan } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { isSafeWindowsBasename } = require('../windows-basename.cjs');
const { groupMultipartCandidates } = require('../artifacts/multipart-names.cjs');
const { parsePublicGitHubUrl } = require('./github-url.cjs');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE = 10000;
const MAX_ASSET_PAGES = 10;
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_SECONDARY_LIMIT_BODY_BYTES = 16 * 1024;
const SECONDARY_LIMIT_BACKOFF_MS = 60 * 1000;
const SECONDARY_LIMIT_MESSAGE = 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
const SECONDARY_LIMIT_DOCUMENTATION_URL = 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api';
const RETRY_AFTER_HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u;
const MAX_ARTIFACT_SET_BYTES = BigInt(ARCHIVE_LIMITS.maxArtifactSetBytes);
const DECIMAL_ID = /^[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HTTP_TOKEN_SOURCE = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const HTTP_TOKEN = new RegExp(`^${HTTP_TOKEN_SOURCE}$`);
const HTTP_TOKEN_CHARACTER = new RegExp(HTTP_TOKEN_SOURCE.slice(0, -1));
const MEDIA_TYPE = new RegExp(`^(${HTTP_TOKEN_SOURCE})\\/(${HTTP_TOKEN_SOURCE})$`);

const GITHUB_API_HEADERS = deepFreeze({
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  'User-Agent': 'Minecraft-Core'
});
const GITHUB_ASSET_HOSTS = deepFreeze([
  'api.github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);
const GITHUB_ASSET_HEADERS = deepFreeze({
  Accept: 'application/octet-stream',
  'X-GitHub-Api-Version': '2026-03-10',
  'User-Agent': 'Minecraft-Core'
});
const APP_ISSUED_GITHUB_PLANS = new WeakMap();

function getAppIssuedGitHubPlanEvidence(plan) {
  return plan && typeof plan === 'object' ? APP_ISSUED_GITHUB_PLANS.get(plan) ?? null : null;
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function invalidResponse() {
  return new ModpackError('INVALID_REQUEST', 'GitHub returned an invalid response');
}

function invalidRequest(field) {
  return new ModpackError('INVALID_REQUEST', 'GitHub request is invalid', {
    details: field ? { field } : undefined
  });
}

function unavailable() {
  return new ModpackError('INVALID_RELEASE_URL', 'GitHub service is unavailable', { retryable: true });
}

function rateLimited() {
  return new ModpackError('RATE_LIMITED', 'GitHub request is rate limited', { retryable: true });
}

function repositoryNotFound() {
  return new ModpackError('REPOSITORY_NOT_FOUND', 'GitHub repository was not found', {
    details: { provider: 'github' }
  });
}

function releaseNotFound(releaseId) {
  return new ModpackError('RELEASE_NOT_FOUND', 'GitHub release was not found', {
    details: { provider: 'github', releaseId }
  });
}

function decimalIdFromResponse(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidResponse();
  return String(value);
}

function decimalIdFromRequest(value, field) {
  if (typeof value !== 'string' || !DECIMAL_ID.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidRequest(field);
  return value;
}

function countFromResponse(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidResponse();
  return String(value);
}

function hasControl(value) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function safeText(value, max, { nullable = false, empty = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length > max || (!empty && value.length < 1) || hasControl(value)) throw invalidResponse();
  return value;
}

function timestamp(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  safeText(value, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) throw invalidResponse();
  const parsed = new Date(value);
  if (parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() + 1 !== Number(match[2]) || parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCHours() !== Number(match[4]) || parsed.getUTCMinutes() !== Number(match[5]) || parsed.getUTCSeconds() !== Number(match[6])) throw invalidResponse();
  return parsed.toISOString();
}

function fileName(value) {
  safeText(value, 255);
  if (!isSafeWindowsBasename(value)) throw invalidResponse();
  return value;
}

function mediaType(value) {
  safeText(value, 128);
  const firstParameter = value.indexOf(';');
  const type = value.slice(0, firstParameter < 0 ? value.length : firstParameter).trim();
  if (!MEDIA_TYPE.test(type)) throw invalidResponse();
  const names = new Set();
  let cursor = firstParameter < 0 ? value.length : firstParameter;
  while (cursor < value.length) {
    if (value[cursor] !== ';') throw invalidResponse();
    cursor += 1;
    while (value[cursor] === ' ') cursor += 1;
    const nameStart = cursor;
    while (cursor < value.length && HTTP_TOKEN_CHARACTER.test(value[cursor])) cursor += 1;
    const rawName = value.slice(nameStart, cursor);
    if (!HTTP_TOKEN.test(rawName)) throw invalidResponse();
    while (value[cursor] === ' ') cursor += 1;
    if (value[cursor] !== '=') throw invalidResponse();
    cursor += 1;
    while (value[cursor] === ' ') cursor += 1;
    if (value[cursor] === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < value.length) {
        const character = value[cursor];
        if (character === '\\') {
          cursor += 1;
          if (cursor >= value.length || value.charCodeAt(cursor) < 32 || value.charCodeAt(cursor) > 126) throw invalidResponse();
        } else if (character === '"') {
          cursor += 1;
          closed = true;
          break;
        } else if (character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126) {
          throw invalidResponse();
        }
        cursor += 1;
      }
      if (!closed) throw invalidResponse();
    } else {
      const parameterStart = cursor;
      while (cursor < value.length && HTTP_TOKEN_CHARACTER.test(value[cursor])) cursor += 1;
      if (!HTTP_TOKEN.test(value.slice(parameterStart, cursor))) throw invalidResponse();
    }
    while (value[cursor] === ' ') cursor += 1;
    if (cursor < value.length && value[cursor] !== ';') throw invalidResponse();
    const name = rawName.toLocaleLowerCase('en-US');
    if (names.has(name)) throw invalidResponse();
    names.add(name);
  }
  return type.toLocaleLowerCase('en-US');
}

function isExactSecondaryLimitBody(body) {
  if (body.length < 1 || body.length > MAX_SECONDARY_LIMIT_BODY_BYTES) return false;
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return false; }
  if (!plain(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes('message') && keys.includes('documentation_url') &&
    value.message === SECONDARY_LIMIT_MESSAGE && value.documentation_url === SECONDARY_LIMIT_DOCUMENTATION_URL;
}

function providerDigest(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.startsWith('sha256:') || !SHA256.test(value.slice(7))) throw invalidResponse();
  return { algorithm: 'sha256', value: value.slice(7) };
}

function normalizeHeaders(value) {
  if (value === undefined) return {};
  if (!plain(value)) throw invalidResponse();
  const wanted = new Map([
    ['etag', 'etag'], ['link', 'link'], ['retry-after', 'retryAfter'],
    ['x-ratelimit-reset', 'rateLimitReset'], ['x-ratelimit-remaining', 'rateLimitRemaining']
  ]);
  const result = {};
  for (const [name, raw] of Object.entries(value)) {
    const key = wanted.get(name.toLocaleLowerCase('en-US'));
    if (!key) continue;
    if (typeof raw !== 'string' || raw.length > 8192 || hasControl(raw)) throw invalidResponse();
    if (Object.hasOwn(result, key)) throw invalidResponse();
    result[key] = raw;
  }
  if (result.etag !== undefined && !/^(?:W\/)?"[A-Za-z0-9._:+/=-]{1,200}"$/.test(result.etag)) throw invalidResponse();
  if (result.rateLimitRemaining !== undefined && !/^(0|[1-9][0-9]*)$/.test(result.rateLimitRemaining)) throw invalidResponse();
  if (result.rateLimitReset !== undefined && !/^[1-9][0-9]*$/.test(result.rateLimitReset)) throw invalidResponse();
  return result;
}

function retryAfterDelay(value, now) {
  if (/^(0|[1-9][0-9]*)$/.test(value)) {
    const milliseconds = BigInt(value) * 1000n;
    return Number(milliseconds > BigInt(MAX_RETRY_MS) ? BigInt(MAX_RETRY_MS) : milliseconds);
  }
  if (!RETRY_AFTER_HTTP_DATE.test(value)) throw invalidResponse();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toUTCString() !== value) throw invalidResponse();
  return Math.min(MAX_RETRY_MS, Math.max(0, parsed - now));
}

function rateLimitReset(value, now) {
  const resetMilliseconds = BigInt(value) * 1000n;
  const nowValue = BigInt(now);
  const rawDelay = resetMilliseconds > nowValue ? resetMilliseconds - nowValue : 0n;
  const delay = Number(rawDelay > BigInt(MAX_RETRY_MS) ? BigInt(MAX_RETRY_MS) : rawDelay);
  return { delay, at: new Date(now + delay).toISOString() };
}

function normalizedNow(clock) {
  const value = clock.now();
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new TypeError('GitHub source clock is invalid');
  return value;
}

function normalizeRepository(value) {
  if (!plain(value) || !plain(value.owner) || typeof value.private !== 'boolean' || typeof value.archived !== 'boolean' || typeof value.disabled !== 'boolean') throw invalidResponse();
  if (value.private || value.visibility !== 'public') throw repositoryNotFound();
  const repositoryId = decimalIdFromResponse(value.id);
  const owner = safeText(value.owner.login, 39);
  const repo = safeText(value.name, 100);
  const parsed = parsePublicGitHubUrl(`https://github.com/${owner}/${repo}`);
  if (parsed.kind !== 'repository' || value.full_name !== `${owner}/${repo}`) throw invalidResponse();
  return {
    repositoryId, owner, repo, fullName: `${owner}/${repo}`, visibility: 'public',
    archived: value.archived, disabled: value.disabled
  };
}

function normalizeRelease(value, repositoryId) {
  if (!plain(value) || typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean' || typeof value.immutable !== 'boolean') throw invalidResponse();
  const draft = value.draft;
  const publishedAt = timestamp(value.published_at, { nullable: true });
  if (!draft && publishedAt === null) throw invalidResponse();
  const tagName = safeText(value.tag_name, 255);
  return {
    repositoryId,
    releaseId: decimalIdFromResponse(value.id),
    tagName,
    name: safeText(value.name, 256, { nullable: true, empty: true }) ?? tagName,
    draft,
    prerelease: value.prerelease,
    channel: value.prerelease ? 'prerelease' : 'release',
    immutable: value.immutable,
    createdAt: timestamp(value.created_at),
    updatedAt: timestamp(value.updated_at),
    publishedAt
  };
}

function visibleRelease(value) {
  return {
    repositoryId: value.repositoryId,
    releaseId: value.releaseId,
    tagName: value.tagName,
    name: value.name,
    prerelease: value.prerelease,
    channel: value.channel,
    immutable: value.immutable,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    publishedAt: value.publishedAt
  };
}

function normalizeAsset(value, repositoryId, releaseId, etag) {
  if (!plain(value) || (value.state !== 'uploaded' && value.state !== 'new')) throw invalidResponse();
  const contentType = mediaType(value.content_type);
  const result = {
    repositoryId,
    releaseId,
    assetId: decimalIdFromResponse(value.id),
    fileName: fileName(value.name),
    label: safeText(value.label, 256, { nullable: true, empty: true }),
    contentType,
    state: value.state,
    role: 'provisional',
    size: countFromResponse(value.size),
    providerDigest: providerDigest(value.digest),
    createdAt: timestamp(value.created_at),
    updatedAt: timestamp(value.updated_at),
    ...(etag ? { etag } : {})
  };
  return result;
}

function pageFromLink(link, { kind, repository, releaseId }) {
  if (link === undefined) return null;
  let nextUrl = null;
  for (const segment of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([a-z]+)"\s*$/.exec(segment);
    if (!match) throw invalidResponse();
    if (match[2] === 'next') {
      if (nextUrl !== null) throw invalidResponse();
      nextUrl = match[1];
    }
  }
  if (nextUrl === null) return null;
  let parsed;
  try { parsed = new URL(nextUrl); } catch { throw invalidResponse(); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.github.com' || parsed.port || parsed.username || parsed.password || parsed.hash) throw invalidResponse();
  const ownerPath = `/repos/${repository.owner}/${repository.repo}/releases${kind === 'assets' ? `/${releaseId}/assets` : ''}`;
  const idPath = `/repositories/${repository.repositoryId}/releases${kind === 'assets' ? `/${releaseId}/assets` : ''}`;
  if (parsed.pathname !== ownerPath && parsed.pathname !== idPath) throw invalidResponse();
  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes('page') || !keys.includes('per_page') || parsed.searchParams.get('per_page') !== '100') throw invalidResponse();
  const rawPage = parsed.searchParams.get('page');
  if (!/^[1-9][0-9]*$/.test(rawPage)) throw invalidResponse();
  const page = Number(rawPage);
  if (!Number.isSafeInteger(page) || page > MAX_PAGE || (kind === 'assets' && page > MAX_ASSET_PAGES)) throw invalidResponse();
  return page;
}

class GitHubReleasesSource {
  constructor({ http, clock, maxResponseBytes = MAX_RESPONSE_BYTES, baseBackoffMs = 1000, maxBackoffMs = 60_000 } = {}) {
    if (!http || typeof http.request !== 'function' || !clock || typeof clock.now !== 'function' ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES ||
      !Number.isSafeInteger(baseBackoffMs) || baseBackoffMs < 1 || !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < baseBackoffMs || maxBackoffMs > MAX_RETRY_MS) {
      throw new TypeError('GitHub source dependencies are invalid');
    }
    this.http = http;
    this.clock = clock;
    this.maxResponseBytes = maxResponseBytes;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.repositories = new Map();
    this.repositoryNames = new Map();
    this.cursors = new Map();
    this.cursorSequence = 0;
    this.etags = new Map();
    this.responseCache = new Map();
    this.failureCounts = new Map();
  }

  retryError(key, headers, { minimumBackoffMs = 0 } = {}) {
    const now = normalizedNow(this.clock);
    const attempt = Math.min(31, (this.failureCounts.get(key) || 0) + 1);
    this.failureCounts.set(key, attempt);
    const exponent = BigInt(Math.min(attempt - 1, 30));
    const backoffBase = BigInt(Math.max(this.baseBackoffMs, minimumBackoffMs));
    const backoffLimit = BigInt(minimumBackoffMs > 0 ? MAX_RETRY_MS : this.maxBackoffMs);
    const exponentialBackoff = backoffBase * (1n << exponent);
    const backoffMs = Number(exponentialBackoff > backoffLimit ? backoffLimit : exponentialBackoff);
    let retryAfterMs = 0;
    if (headers.retryAfter !== undefined) {
      retryAfterMs = retryAfterDelay(headers.retryAfter, now);
    }
    let resetDelay = 0;
    let rateLimitResetAt;
    if (headers.rateLimitReset !== undefined && headers.rateLimitRemaining === '0') {
      const reset = rateLimitReset(headers.rateLimitReset, now);
      resetDelay = reset.delay;
      rateLimitResetAt = reset.at;
    }
    const retryMetadata = deepFreeze({
      retryAfterMs,
      ...(rateLimitResetAt ? { rateLimitResetAt } : {}),
      backoffMs,
      nextAttemptAfterMs: Math.max(retryAfterMs, resetDelay, backoffMs)
    });
    const error = rateLimited();
    Object.defineProperty(error, 'retryMetadata', {
      value: retryMetadata,
      enumerable: false,
      writable: false,
      configurable: false
    });
    return error;
  }

  async requestJson(path, options, { key, missingKind, missingId, allowNotModified = false } = {}) {
    let response;
    try { response = await this.http.request(path, options); }
    catch (error) {
      if (error instanceof ModpackError) throw error;
      throw unavailable();
    }
    if (!response || !Number.isSafeInteger(response.statusCode) || !Buffer.isBuffer(response.body)) throw invalidResponse();
    if (response.body.length > this.maxResponseBytes) {
      throw new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'GitHub response exceeded the configured byte limit', {
        details: { limit: 'maxTechnicalStdoutBytes', actual: String(response.body.length) }
      });
    }
    const headers = normalizeHeaders(response.headers);
    const secondaryLimited = response.statusCode === 403 && headers.retryAfter === undefined && headers.rateLimitRemaining !== '0' &&
      isExactSecondaryLimitBody(response.body);
    const rateLimited = response.statusCode === 429 || (response.statusCode === 403 &&
      (headers.retryAfter !== undefined || headers.rateLimitRemaining === '0' || secondaryLimited));
    const requiresSafeBackoff = secondaryLimited || (response.statusCode === 429 && headers.retryAfter === undefined && headers.rateLimitRemaining !== '0');
    if (response.statusCode === 404 || (response.statusCode === 403 && !rateLimited)) {
      throw missingKind === 'repository' ? repositoryNotFound(missingId) : missingKind === 'release' ? releaseNotFound(missingId) : unavailable();
    }
    if (rateLimited) {
      throw this.retryError(key, headers, { minimumBackoffMs: requiresSafeBackoff ? SECONDARY_LIMIT_BACKOFF_MS : 0 });
    }
    if (response.statusCode === 304) {
      if (!allowNotModified || response.body.length !== 0) throw invalidResponse();
      this.failureCounts.delete(key);
      return { notModified: true, headers };
    }
    if (response.statusCode < 200 || response.statusCode >= 300) throw unavailable();
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
    catch { throw invalidResponse(); }
    this.failureCounts.delete(key);
    return { notModified: false, headers, value };
  }

  repository(repositoryId) {
    repositoryId = decimalIdFromRequest(repositoryId, 'repositoryId');
    const repository = this.repositories.get(repositoryId);
    if (!repository) throw repositoryNotFound(repositoryId);
    return repository;
  }

  requestHeaders(key) {
    const etag = this.etags.get(key);
    return { ...GITHUB_API_HEADERS, ...(etag ? { 'If-None-Match': etag } : {}) };
  }

  rememberEtag(key, headers) {
    if (headers.etag) this.etags.set(key, headers.etag);
    else this.etags.delete(key);
  }

  async getRepositoryIdentity(input) {
    const hint = parsePublicGitHubUrl(input);
    const response = await this.requestJson(`/repos/${hint.owner}/${hint.repo}`, { headers: { ...GITHUB_API_HEADERS } }, {
      key: `repository:${hint.owner.toLocaleLowerCase('en-US')}/${hint.repo.toLocaleLowerCase('en-US')}`,
      missingKind: 'repository'
    });
    const repository = normalizeRepository(response.value);
    const nameKey = `${repository.owner}/${repository.repo}`.toLocaleLowerCase('en-US');
    const existingId = this.repositoryNames.get(nameKey);
    if (existingId && existingId !== repository.repositoryId) throw invalidResponse();
    this.repositoryNames.set(nameKey, repository.repositoryId);
    this.repositories.set(repository.repositoryId, deepFreeze({ ...repository }));
    return deepFreeze({ ...repository, ...(hint.kind === 'release-tag' ? { tagHint: hint.tag } : {}) });
  }

  async listReleases({ repositoryId, owner, repo, includePrereleases = false, cursor, etag } = {}) {
    const repository = this.repository(repositoryId);
    if (owner !== repository.owner || repo !== repository.repo || typeof includePrereleases !== 'boolean') throw invalidRequest('repositoryId');
    let page = 1;
    let priorReleaseIds = [];
    let priorTags = [];
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || !/^github-page-[1-9][0-9]*$/.test(cursor)) throw invalidRequest('cursor');
      const issued = this.cursors.get(cursor);
      if (!issued || issued.repositoryId !== repository.repositoryId || issued.includePrereleases !== includePrereleases) throw invalidRequest('cursor');
      page = issued.page;
      priorReleaseIds = issued.seenReleaseIds;
      priorTags = issued.seenTags;
    }
    const key = `releases:${repository.repositoryId}:${page}`;
    if (etag !== undefined) {
      if (cursor !== undefined || (etag !== null &&
          (typeof etag !== 'string' || !/^(?:W\/)?"[A-Za-z0-9._:+/=-]{1,200}"$/.test(etag)))) {
        throw invalidRequest('etag');
      }
      if (etag === null) this.etags.delete(key);
      else this.etags.set(key, etag);
    }
    const response = await this.requestJson(`/repos/${repository.owner}/${repository.repo}/releases`, {
      headers: this.requestHeaders(key),
      query: { per_page: '100', page: String(page) }
    }, { key, missingKind: 'repository', missingId: repository.repositoryId, allowNotModified: true });
    let pageData;
    if (response.notModified) {
      pageData = this.responseCache.get(key);
      if (!pageData) {
        pageData = deepFreeze({ releases: [], nextPage: null, etag: response.headers.etag ?? etag ?? null });
      }
    } else {
      if (!Array.isArray(response.value) || response.value.length > 100) throw invalidResponse();
      const releases = response.value.map(item => normalizeRelease(item, repository.repositoryId));
      const nextPage = pageFromLink(response.headers.link, { kind: 'releases', repository });
      if (nextPage !== null && nextPage !== page + 1) throw invalidResponse();
      this.rememberEtag(key, response.headers);
      pageData = deepFreeze({ releases, nextPage, etag: response.headers.etag ?? null });
      this.responseCache.set(key, pageData);
    }
    if (new Set(pageData.releases.map(item => item.releaseId)).size !== pageData.releases.length ||
      new Set(pageData.releases.map(item => item.tagName)).size !== pageData.releases.length ||
      pageData.releases.some(item => priorReleaseIds.includes(item.releaseId) || priorTags.includes(item.tagName))) throw invalidResponse();
    let nextCursor = null;
    if (pageData.nextPage !== null) {
      nextCursor = `github-page-${++this.cursorSequence}`;
      this.cursors.set(nextCursor, deepFreeze({
        repositoryId: repository.repositoryId, page: pageData.nextPage, includePrereleases,
        seenReleaseIds: [...priorReleaseIds, ...pageData.releases.map(item => item.releaseId)],
        seenTags: [...priorTags, ...pageData.releases.map(item => item.tagName)]
      }));
    }
    const visible = pageData.releases.filter(item => !item.draft && (includePrereleases || !item.prerelease)).map(visibleRelease);
    return deepFreeze({
      repositoryId: repository.repositoryId,
      releases: visible,
      pagination: { perPage: 100, nextCursor },
      ...(pageData.etag ? { etag: pageData.etag } : {}),
      notModified: response.notModified,
      checkedAt: new Date(normalizedNow(this.clock)).toISOString()
    });
  }

  async getRelease({ repositoryId, releaseId } = {}) {
    const repository = this.repository(repositoryId);
    releaseId = decimalIdFromRequest(releaseId, 'releaseId');
    const key = `release:${repository.repositoryId}:${releaseId}`;
    const response = await this.requestJson(`/repos/${repository.owner}/${repository.repo}/releases/${releaseId}`, {
      headers: this.requestHeaders(key)
    }, { key, missingKind: 'release', missingId: releaseId, allowNotModified: true });
    let release;
    if (response.notModified) {
      release = this.responseCache.get(key);
      if (!release) throw invalidResponse();
    } else {
      release = normalizeRelease(response.value, repository.repositoryId);
      if (release.releaseId !== releaseId) throw invalidResponse();
      if (release.draft) throw releaseNotFound(releaseId);
      this.rememberEtag(key, response.headers);
      release = deepFreeze({ ...visibleRelease(release), ...(response.headers.etag ? { etag: response.headers.etag } : {}) });
      this.responseCache.set(key, release);
    }
    return release;
  }

  async loadAssetPage(repository, releaseId, page) {
    const key = `assets:${repository.repositoryId}:${releaseId}:${page}`;
    const response = await this.requestJson(`/repos/${repository.owner}/${repository.repo}/releases/${releaseId}/assets`, {
      headers: this.requestHeaders(key),
      query: { per_page: '100', page: String(page) }
    }, { key, missingKind: 'release', missingId: releaseId, allowNotModified: true });
    if (response.notModified) {
      const cached = this.responseCache.get(key);
      if (!cached) throw invalidResponse();
      return cached;
    }
    if (!Array.isArray(response.value) || response.value.length > 100) throw invalidResponse();
    const assets = response.value.map(item => normalizeAsset(item, repository.repositoryId, releaseId, response.headers.etag));
    if (new Set(assets.map(item => item.assetId)).size !== assets.length) throw invalidResponse();
    const nextPage = pageFromLink(response.headers.link, { kind: 'assets', repository, releaseId });
    if (nextPage !== null && nextPage !== page + 1) throw invalidResponse();
    this.rememberEtag(key, response.headers);
    const pageData = deepFreeze({ assets, nextPage, etag: response.headers.etag ?? null });
    this.responseCache.set(key, pageData);
    return pageData;
  }

  async loadUploadedAssets({ repositoryId, releaseId } = {}) {
    const repository = this.repository(repositoryId);
    releaseId = decimalIdFromRequest(releaseId, 'releaseId');
    const pages = [];
    const seenPages = new Set();
    let page = 1;
    while (page !== null) {
      if (seenPages.has(page) || seenPages.size >= MAX_ASSET_PAGES) throw invalidResponse();
      seenPages.add(page);
      const pageData = await this.loadAssetPage(repository, releaseId, page);
      pages.push({ page, ...pageData });
      page = pageData.nextPage;
    }
    const all = pages.flatMap(item => item.assets);
    if (new Set(all.map(item => item.assetId)).size !== all.length) throw invalidResponse();
    const uploaded = all.filter(item => item.state === 'uploaded');
    const grouped = uploaded.length === 0 ? [] : groupMultipartCandidates(uploaded.map(item => ({
      assetId: item.assetId,
      providerAssetId: item.assetId,
      fileName: item.fileName,
      size: item.size,
      updatedAt: item.updatedAt,
      providerDigest: item.providerDigest,
      releaseId
    })));
    const installableIds = new Set(grouped.flatMap(choice => choice.parts.map(part => part.providerAssetId)));
    const assets = uploaded.map(item => deepFreeze({ ...item, installableCandidate: installableIds.has(item.assetId) }));
    const choices = grouped.map(choice => {
      const combinedSize = choice.parts.reduce((sum, part) => sum + BigInt(part.size), 0n);
      const overLimit = combinedSize > MAX_ARTIFACT_SET_BYTES;
      const structuralReason = choice.disabledReason || (choice.kind === 'multipart' && choice.parts.length < 2 ? 'missing-volume' : null);
      const disabledReason = structuralReason || (overLimit ? 'size-limit' : null);
      return deepFreeze({
        ...choice,
        role: 'provisional',
        combinedSize: combinedSize.toString(),
        complete: disabledReason === null,
        ...(disabledReason ? { disabled: true, disabledReason } : {})
      });
    });
    const status = choices.some(choice => choice.complete) ? 'ready' : 'NO_INSTALLABLE_ASSET';
    return deepFreeze({
      repositoryId: repository.repositoryId,
      releaseId,
      assets,
      choices,
      pageEtags: pages.filter(item => item.etag).map(item => ({ page: item.page, etag: item.etag })),
      status,
      ...(status === 'NO_INSTALLABLE_ASSET' ? { actions: ['import-local', 'create-empty'] } : {}),
      checkedAt: new Date(normalizedNow(this.clock)).toISOString()
    });
  }

  async listUploadedAssets({ repositoryId, releaseId } = {}) {
    const repository = this.repository(repositoryId);
    releaseId = decimalIdFromRequest(releaseId, 'releaseId');
    await this.getRelease({ repositoryId: repository.repositoryId, releaseId });
    return this.loadUploadedAssets({ repositoryId: repository.repositoryId, releaseId });
  }

  async buildArtifactSetPlan({ repositoryId, releaseId, selectedAssetIds } = {}) {
    const repository = this.repository(repositoryId);
    releaseId = decimalIdFromRequest(releaseId, 'releaseId');
    if (!Array.isArray(selectedAssetIds) || selectedAssetIds.length < 1 || selectedAssetIds.length > 1000) throw invalidRequest('selectedAssetIds');
    const selected = selectedAssetIds.map((id, index) => decimalIdFromRequest(id, `selectedAssetIds.${index}`));
    if (new Set(selected).size !== selected.length) throw invalidRequest('selectedAssetIds');

    const release = await this.getRelease({ repositoryId: repository.repositoryId, releaseId });
    const listing = await this.loadUploadedAssets({ repositoryId: repository.repositoryId, releaseId });
    const assetsById = new Map(listing.assets.map(item => [item.assetId, item]));
    if (selected.some(id => !assetsById.has(id))) throw invalidRequest('selectedAssetIds');
    const selectedSet = new Set(selected);
    const intersecting = listing.choices.filter(choice => choice.parts.some(part => selectedSet.has(part.providerAssetId)));
    if (intersecting.length === 0) {
      throw new ModpackError('ASSET_SELECTION_REQUIRED', 'An installable GitHub asset must be selected', { details: { count: '0' } });
    }
    if (intersecting.length > 1) {
      throw new ModpackError('ASSET_AMBIGUOUS', 'Selected GitHub assets span multiple packages', { details: { count: String(intersecting.length) } });
    }
    const choice = intersecting[0];
    const expectedIds = choice.parts.map(part => part.providerAssetId);
    const missing = expectedIds.filter(id => !selectedSet.has(id));
    if (missing.length || choice.disabledReason === 'missing-volume' || choice.disabledReason === 'duplicate-volume') {
      throw new ModpackError('MULTIPART_VOLUME_MISSING', 'The selected GitHub multipart archive is incomplete', {
        details: missing.length ? { partId: `asset-${missing[0]}` } : undefined
      });
    }
    if (selected.some(id => !expectedIds.includes(id))) {
      throw new ModpackError('ASSET_SELECTION_REQUIRED', 'Selected GitHub assets do not form one package', { details: { count: String(selected.length) } });
    }
    if (choice.disabledReason === 'size-limit') {
      throw new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'GitHub artifact set exceeded the configured byte limit', {
        details: { limit: 'maxArtifactSetBytes', actual: choice.combinedSize }
      });
    }
    const chosenAssets = expectedIds.map(id => assetsById.get(id));
    const totalSize = chosenAssets.reduce((sum, item) => sum + BigInt(item.size), 0n);
    if (totalSize > MAX_ARTIFACT_SET_BYTES) {
      throw new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'GitHub artifact set exceeded the configured byte limit', {
        details: { limit: 'maxArtifactSetBytes', actual: totalSize.toString() }
      });
    }
    const parts = chosenAssets.map(item => ({
      partId: `asset-${item.assetId}`,
      providerAssetId: item.assetId,
      fileName: item.fileName,
      size: item.size,
      updatedAt: item.updatedAt,
      ...(item.providerDigest ? { providerDigest: item.providerDigest } : {})
    }));
    const persisted = createArtifactSetPlan({
      provider: 'github',
      project: { id: repository.repositoryId, slug: repository.fullName, title: repository.fullName },
      release: {
        id: release.releaseId, version: release.tagName, channel: release.channel, publishedAt: release.publishedAt
      },
      artifactSet: {
        kind: choice.kind,
        primaryPartId: `asset-${choice.primaryPartId}`,
        groupingScheme: choice.groupingScheme,
        parts,
        providerImmutable: release.immutable,
        attestationStatus: chosenAssets.every(item => item.providerDigest) ? 'verified' : 'unavailable'
      }
    });
    const warnings = chosenAssets.filter(item => !item.providerDigest).map(item => ({
      code: 'MISSING_PROVIDER_DIGEST', partId: `asset-${item.assetId}`
    }));
    const plan = deepFreeze({
      ...persisted,
      sourceEvidence: {
        repositoryId: repository.repositoryId,
        releaseId: release.releaseId,
        releaseUpdatedAt: release.updatedAt,
        releaseImmutable: release.immutable,
        selectedAssetIds: expectedIds,
        pageEtags: listing.pageEtags
      },
      warnings
    });
    APP_ISSUED_GITHUB_PLANS.set(plan, deepFreeze({
      repositoryId: repository.repositoryId,
      owner: repository.owner,
      repo: repository.repo,
      releaseId: release.releaseId,
      projectSlug: repository.fullName,
      setDigest: persisted.artifactSet.setDigest,
      kind: persisted.artifactSet.kind,
      groupingScheme: persisted.artifactSet.groupingScheme,
      primaryPartId: persisted.artifactSet.primaryPartId,
      parts: persisted.artifactSet.parts.map(part => ({
        partId: part.partId,
        providerAssetId: part.providerAssetId
      }))
    }));
    return plan;
  }
}

module.exports = {
  GITHUB_API_HEADERS,
  GITHUB_ASSET_HEADERS,
  GITHUB_ASSET_HOSTS,
  GitHubReleasesSource,
  getAppIssuedGitHubPlanEvidence
};
