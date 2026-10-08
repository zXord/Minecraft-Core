const crypto = require('node:crypto');

const { ModpackError, deepFreeze } = require('../errors.cjs');
const { matchAssetPatternProvisional } = require('../providers/github-asset-pattern.cjs');

const BASE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MIN_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = BASE_INTERVAL_MS;
const MAX_PROVIDER_RETRY_MS = 24 * 60 * 60 * 1000;
const SOURCE_CHANGED = 'source-changed';

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The release monitor request is invalid', { cause });
}

function nowMilliseconds(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : NaN;
  if (!Number.isFinite(milliseconds)) throw invalid();
  return milliseconds;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function deterministicInterval(trackingId) {
  const digest = crypto.createHash('sha256').update(`release-jitter-v1\0${trackingId}`, 'utf8').digest();
  const unit = digest.readUInt32BE(0) / 0xffffffff;
  return Math.round(BASE_INTERVAL_MS * (0.9 + (unit * 0.2)));
}

function fingerprintAssets(value) {
  const assets = Array.isArray(value.assets) ? value.assets : [];
  const normalized = assets.map(asset => ({
    assetId: asset.assetId,
    fileName: asset.fileName,
    providerDigest: asset.providerDigest || null,
    size: asset.size,
    state: asset.state,
    updatedAt: asset.updatedAt
  })).sort((left, right) => String(left.assetId).localeCompare(String(right.assetId), 'en-US'));
  return crypto.createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

function snapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const keys = ['releaseId', 'version', 'prerelease', 'publishedAt', 'assetFingerprint', 'installable'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) ||
      typeof value.releaseId !== 'string' || typeof value.version !== 'string' || typeof value.prerelease !== 'boolean' ||
      typeof value.publishedAt !== 'string' || typeof value.installable !== 'boolean' ||
      (value.assetFingerprint !== null && (typeof value.assetFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.assetFingerprint)))) {
    throw invalid();
  }
  if (new Date(value.publishedAt).toISOString() !== value.publishedAt) throw invalid();
  return {
    releaseId: value.releaseId,
    version: value.version,
    prerelease: value.prerelease,
    publishedAt: value.publishedAt,
    assetFingerprint: value.assetFingerprint,
    installable: value.installable
  };
}

function newest(items) {
  return items.slice().sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) ||
    right.releaseId.localeCompare(left.releaseId, 'en-US'))[0] || null;
}

function normalizeCheckResult(value, prior) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      typeof value.notModified !== 'boolean') throw invalid();
  if (value.notModified) {
    if (Object.keys(value).some(key => !['notModified', 'etag'].includes(key))) throw invalid();
    return { notModified: true, etag: value.etag ?? prior.etag, snapshot: prior.lastSnapshot };
  }
  if (Object.keys(value).some(key => !['notModified', 'etag', 'snapshot'].includes(key)) || !value.snapshot) throw invalid();
  return { notModified: false, etag: value.etag ?? null, snapshot: snapshot(value.snapshot) };
}

function isDue(record, now) {
  const next = Date.parse(record.nextDueAt);
  const last = record.lastSuccessfulCheck === null ? null : Date.parse(record.lastSuccessfulCheck);
  if (!Number.isFinite(next) || (last !== null && !Number.isFinite(last))) throw invalid();
  if (last !== null && now < last) return true;
  return now >= next;
}

function retryAfterFrom(error, now) {
  if (error?.code !== 'RATE_LIMITED') return null;
  const value = error.retryMetadata;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  const required = ['retryAfterMs', 'backoffMs', 'nextAttemptAfterMs'];
  if (keys.some(key => ![...required, 'rateLimitResetAt'].includes(key)) || required.some(key => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) throw invalid();
  const retryAfterMs = descriptors.retryAfterMs.value;
  const backoffMs = descriptors.backoffMs.value;
  const nextAttemptAfterMs = descriptors.nextAttemptAfterMs.value;
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > MAX_PROVIDER_RETRY_MS ||
      !Number.isSafeInteger(backoffMs) || backoffMs < 1 || backoffMs > MAX_PROVIDER_RETRY_MS ||
      !Number.isSafeInteger(nextAttemptAfterMs) || nextAttemptAfterMs < Math.max(retryAfterMs, backoffMs) ||
      nextAttemptAfterMs > MAX_PROVIDER_RETRY_MS) throw invalid();
  if (descriptors.rateLimitResetAt) {
    const rateLimitResetAt = descriptors.rateLimitResetAt.value;
    if (typeof rateLimitResetAt !== 'string' || rateLimitResetAt.length > 64) throw invalid();
    let canonical;
    try { canonical = new Date(rateLimitResetAt).toISOString(); } catch { throw invalid(); }
    if (canonical !== rateLimitResetAt) throw invalid();
  }
  return now + nextAttemptAfterMs;
}

function sourceId(record) {
  return record.provider === 'github' ? record.repositoryId : record.projectId;
}

function repositoryNotFound(repositoryId) {
  return new ModpackError('REPOSITORY_NOT_FOUND', 'GitHub repository was not found', {
    details: { provider: 'github', repositoryId }
  });
}

function provisionalAssetChoices(value) {
  if (!Array.isArray(value)) throw invalid();
  return value.map(choice => {
    const parts = Array.isArray(choice?.parts) ? choice.parts : [];
    const primaryIndex = parts.findIndex(part => part?.providerAssetId === choice?.primaryPartId);
    return {
      assetIds: parts.map(part => part?.providerAssetId),
      fileNames: parts.map(part => part?.fileName),
      multipartStructure: {
        kind: choice?.kind,
        groupingScheme: choice?.groupingScheme,
        partCount: parts.length,
        primaryIndex
      },
      complete: choice?.complete === true
    };
  });
}

class ReleaseMonitor {
  constructor({
    clock = () => new Date(), notificationStore, trackingStore, providers,
    setIntervalFn = setInterval, clearIntervalFn = clearInterval
  } = {}) {
    if (typeof clock !== 'function' || !notificationStore || typeof notificationStore.create !== 'function' ||
        !trackingStore || typeof trackingStore.list !== 'function' || typeof trackingStore.recordSuccess !== 'function' ||
        typeof trackingStore.recordFailure !== 'function' || !providers || typeof providers !== 'object' ||
        !providers.github || !providers.modrinth || typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') throw invalid();
    this.clock = clock;
    this.notificationStore = notificationStore;
    this.trackingStore = trackingStore;
    this.providers = providers;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.timer = null;
    this.running = false;
    this.inFlight = new Map();
  }

  async start() {
    if (this.timer !== null) return;
    await this.checkAll();
    this.timer = this.setIntervalFn(() => { this.checkAll().catch(() => {}); }, BASE_INTERVAL_MS);
  }

  stop() {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  async checkAll({ force = false } = {}) {
    if (typeof force !== 'boolean' || this.running) return deepFreeze([]);
    const now = nowMilliseconds(this.clock);
    this.running = true;
    const outcomes = [];
    try {
      const records = await this.trackingStore.list();
      for (const record of records) {
        if (!force && !isDue(record, now)) continue;
        outcomes.push(await this.#checkRecordOnce(record, now));
      }
      return deepFreeze(outcomes);
    } finally {
      this.running = false;
    }
  }

  async checkOne(trackingId, { force = false } = {}) {
    if (typeof trackingId !== 'string' || typeof force !== 'boolean') throw invalid();
    const record = await this.trackingStore.get(trackingId);
    if (!record) throw invalid();
    const now = nowMilliseconds(this.clock);
    if (!force && !isDue(record, now)) return deepFreeze({ checked: false, trackingId });
    return this.#checkRecordOnce(record, now);
  }

  #checkRecordOnce(record, now) {
    const existing = this.inFlight.get(record.trackingId);
    if (existing) return existing;
    const pending = this.#checkRecord(record, now).finally(() => {
      if (this.inFlight.get(record.trackingId) === pending) this.inFlight.delete(record.trackingId);
    });
    this.inFlight.set(record.trackingId, pending);
    return pending;
  }

  async #checkRecord(record, now) {
    const provider = this.providers[record.provider];
    try {
      const raw = typeof provider.checkLatest === 'function'
        ? await provider.checkLatest(record)
        : await this.#checkProvider(provider, record);
      const result = normalizeCheckResult(raw, record);
      const orderingBaselineKnown = record.provider === 'github' || record.lastSuccessfulCheck !== null ||
        record.lastSnapshot?.orderingKnown === true;
      const olderDifferentRelease = orderingBaselineKnown && result.snapshot !== null && record.lastSnapshot !== null &&
        result.snapshot.releaseId !== record.lastSnapshot.releaseId &&
        result.snapshot.publishedAt <= record.lastSnapshot.publishedAt;
      const snapshotToPersist = olderDifferentRelease ? record.lastSnapshot : result.snapshot;
      const normalizingInstalledGitHubBaseline = record.provider === 'github' && record.lastSuccessfulCheck === null &&
        record.lastSnapshot?.releaseId === result.snapshot?.releaseId;
      if (!result.notModified && result.snapshot && !normalizingInstalledGitHubBaseline && !olderDifferentRelease) {
        await this.#notifyChange(record, result.snapshot);
      }
      const nextDueAt = iso(now + deterministicInterval(record.trackingId));
      await this.trackingStore.recordSuccess(record.trackingId, {
        checkedAt: iso(now),
        etag: result.etag,
        nextDueAt,
        snapshot: snapshotToPersist
      });
      return deepFreeze({ checked: true, changed: !result.notModified && !olderDifferentRelease, nextDueAt, trackingId: record.trackingId });
    } catch (error) {
      const priorAttempts = record.lastFailure?.attempt || 0;
      const attempt = Math.min(64, priorAttempts + 1);
      const exponential = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * (2 ** Math.min(10, attempt - 1)));
      let code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
        ? error.code
        : 'PROVIDER_UNAVAILABLE';
      let retryAfter = null;
      if (code === 'RATE_LIMITED') {
        try { retryAfter = retryAfterFrom(error, now); }
        catch { code = 'PROVIDER_UNAVAILABLE'; }
      }
      const next = Math.max(now + exponential, retryAfter || 0);
      await this.trackingStore.recordFailure(record.trackingId, {
        code,
        at: iso(now),
        attempt,
        retryAfterAt: retryAfter === null ? null : iso(retryAfter),
        nextDueAt: iso(next)
      });
      await this.notificationStore.create({
        type: code === 'RATE_LIMITED' ? 'rate-limit' : 'integrity-warning',
        serverId: record.serverId,
        source: { provider: record.provider, sourceId: sourceId(record) },
        release: record.lastSnapshot === null ? null : {
          releaseId: record.lastSnapshot.releaseId,
          version: record.lastSnapshot.version,
          prerelease: record.lastSnapshot.prerelease
        },
        title: code === 'RATE_LIMITED' ? 'Modpack update check delayed' : 'Modpack update check failed',
        message: code === 'RATE_LIMITED'
          ? 'The provider asked Minecraft Core to retry this update check later.'
          : 'Minecraft Core could not safely complete this update check.',
        action: { actionId: 'retry', opaqueRef: `release-check:${record.trackingId}` },
        dedupeKey: `${record.trackingId}:failure:${code}:${attempt}`
      });
      return deepFreeze({ checked: false, errorCode: code, nextDueAt: iso(next), trackingId: record.trackingId });
    }
  }

  async #checkProvider(provider, record) {
    if (record.provider === 'github') {
      if (typeof provider.listReleases !== 'function' || typeof provider.loadUploadedAssets !== 'function') throw invalid();
      let owner = record.githubOwner;
      let repo = record.githubRepo;
      if (typeof provider.getRepositoryIdentity === 'function') {
        const repository = await provider.getRepositoryIdentity(`https://github.com/${owner}/${repo}`);
        if (!repository || repository.repositoryId !== record.repositoryId || repository.visibility !== 'public' ||
            typeof repository.owner !== 'string' || typeof repository.repo !== 'string') {
          throw repositoryNotFound(record.repositoryId);
        }
        owner = repository.owner;
        repo = repository.repo;
      }
      const releases = await provider.listReleases({
        repositoryId: record.repositoryId,
        owner,
        repo,
        includePrereleases: record.includePrereleases,
        etag: record.etag
      });
      if (releases.notModified) return { notModified: true, etag: releases.etag ?? record.etag };
      const release = newest(releases.releases.map(item => ({
        releaseId: item.releaseId,
        version: item.tagName,
        prerelease: item.prerelease,
        publishedAt: item.publishedAt
      })));
      if (!release) return { notModified: true, etag: releases.etag ?? record.etag };
      const assets = await provider.loadUploadedAssets({ repositoryId: record.repositoryId, releaseId: release.releaseId });
      const installable = record.assetPattern === null
        ? Array.isArray(assets.choices) && assets.choices.some(choice => choice.complete === true)
        : matchAssetPatternProvisional(record.assetPattern, provisionalAssetChoices(assets.choices)).type === 'SINGLE_PROVISIONAL';
      return {
        notModified: false,
        etag: releases.etag ?? record.etag,
        snapshot: {
          ...release,
          assetFingerprint: fingerprintAssets(assets),
          installable
        }
      };
    }
    if (typeof provider.listVersions !== 'function') throw invalid();
    const versions = await provider.listVersions({
      projectId: record.projectId,
      channels: record.includePrereleases ? [] : ['release']
    });
    const release = newest(versions.map(item => ({
      releaseId: item.versionId,
      version: item.version,
      prerelease: item.channel !== 'release',
      publishedAt: item.publishedAt
    })));
    if (!release) return { notModified: true, etag: null };
    return { notModified: false, etag: null, snapshot: { ...release, assetFingerprint: null, installable: true } };
  }

  async #notifyChange(record, next) {
    const prior = record.lastSnapshot;
    if (!prior) return;
    if (record.provider === 'modrinth' && record.lastSuccessfulCheck === null && next.releaseId === prior.releaseId) return;
    let type = null;
    if (next.releaseId === prior.releaseId) {
      if (next.version !== prior.version || next.prerelease !== prior.prerelease ||
          next.publishedAt !== prior.publishedAt || next.assetFingerprint !== prior.assetFingerprint ||
          next.installable !== prior.installable) type = SOURCE_CHANGED;
    } else if (next.prerelease) {
      if (record.includePrereleases) type = 'prerelease-available';
    } else if (record.provider === 'github' && !next.installable) {
      type = 'github-asset-selection-required';
    } else {
      type = 'update-available';
    }
    if (!type) return;
    const title = {
      'update-available': 'Modpack update available',
      'prerelease-available': 'Modpack prerelease available',
      'github-asset-selection-required': 'GitHub asset selection required',
      'source-changed': 'Modpack release source changed'
    }[type];
    await this.notificationStore.create({
      type,
      serverId: record.serverId,
      source: { provider: record.provider, sourceId: sourceId(record) },
      release: { releaseId: next.releaseId, version: next.version, prerelease: next.prerelease },
      title,
      message: type === SOURCE_CHANGED
        ? `Release ${next.version} changed after it was first observed. Review it before updating.`
        : `Release ${next.version} is ready to review.`,
      action: {
        actionId: type === 'github-asset-selection-required' ? 'choose-another-asset' : 'open-details',
        opaqueRef: `release-review:${record.trackingId}:${next.releaseId}`
      },
      dedupeKey: `${record.trackingId}:${next.releaseId}:${type}:${next.assetFingerprint || 'no-assets'}`
    });
  }
}

module.exports = { BASE_INTERVAL_MS, ReleaseMonitor, deterministicInterval };
