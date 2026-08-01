const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { finalizeVerifiedArtifactSet } = require('../contracts.cjs');
const { validateCompleteArtifactSet } = require('./artifact-set.cjs');

const DIGEST_LENGTHS = Object.freeze({ sha1: 40, sha256: 64, sha512: 128 });

function limitExceeded(actual) {
  return new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Artifact download exceeded the configured byte limit', {
    details: { limit: 'maxArtifactSetBytes', actual: actual.toString() }
  });
}
function hashMismatch(algorithm, expected, actual) {
  return new ModpackError('HASH_MISMATCH', 'Artifact bytes did not match the reviewed identity', {
    details: algorithm && expected && actual ? { algorithm, expected, actual } : undefined
  });
}
function cancelled() { return new ModpackError('CANCELLED', 'Artifact download was cancelled'); }
function safeDownloadFailure() { return new ModpackError('INVALID_RELEASE_URL', 'Artifact download failed', { details: { reasonCode: 'host-not-allowed' } }); }
function decimalBytes(value) { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value); }
function isInside(parent, child) { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }

function strippedPlan(plan) {
  if (!plan || typeof plan !== 'object' || !plan.artifactSet || !Array.isArray(plan.artifactSet.parts)) return plan;
  return {
    type: plan.type, provider: plan.provider,
    ...(plan.project ? { project: plan.project } : {}), ...(plan.release ? { release: plan.release } : {}),
    artifactSet: {
      kind: plan.artifactSet.kind, primaryPartId: plan.artifactSet.primaryPartId, groupingScheme: plan.artifactSet.groupingScheme,
      parts: plan.artifactSet.parts.map(part => ({
        partId: part.partId, ...(part.providerAssetId === undefined ? {} : { providerAssetId: part.providerAssetId }),
        fileName: part.fileName, size: part.size, ...(part.updatedAt === undefined ? {} : { updatedAt: part.updatedAt }),
        ...(part.providerDigest === undefined ? {} : { providerDigest: part.providerDigest })
      })),
      setDigest: plan.artifactSet.setDigest, providerImmutable: plan.artifactSet.providerImmutable, attestationStatus: plan.artifactSet.attestationStatus
    }
  };
}

class ArtifactDownloader {
  constructor({ client, cache, partialRoot, fsApi = fs, randomUUID: idSource = randomUUID, maxSetBytes = BigInt(ARCHIVE_LIMITS.maxArtifactSetBytes) } = {}) {
    if (!client || typeof client.request !== 'function' || !cache || typeof cache.commitPart !== 'function' || typeof partialRoot !== 'string' || !partialRoot || typeof idSource !== 'function') throw new TypeError('Artifact downloader dependencies are invalid');
    const parsedLimit = typeof maxSetBytes === 'bigint' ? maxSetBytes : decimalBytes(maxSetBytes) ? BigInt(maxSetBytes) : -1n;
    if (parsedLimit < 0n) throw new TypeError('Artifact download limit is invalid');
    this.client = client; this.cache = cache; this.partialRoot = path.resolve(partialRoot); this.fs = fsApi; this.randomUUID = idSource; this.maxSetBytes = parsedLimit;
    if (!isInside(path.resolve(cache.root), this.partialRoot)) throw new TypeError('Artifact partial root must be inside the cache root');
  }

  async preparePartialRoot() {
    if (this.partialRoot === path.resolve(this.cache.root)) await this.cache.controlledRoot(this.partialRoot, 'partialPath');
    else await this.cache.ensureControlledDirectory(this.partialRoot, this.cache.root, 'partialPath');
  }

  async openUniquePartial() {
    await this.preparePartialRoot();
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = String(this.randomUUID());
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError('Artifact partial identifier is invalid');
      const partialPath = path.join(this.partialRoot, `download-${id}.partial`);
      try { return { partialPath, handle: await this.fs.open(partialPath, 'wx') }; }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    throw new ModpackError('OPERATION_IN_PROGRESS', 'Artifact download staging is busy');
  }

  async downloadPart(partPlan, { signal, onProgress } = {}) {
    const total = decimalBytes(partPlan?.size) ? BigInt(partPlan.size) : this.maxSetBytes;
    return this.downloadPartWithBudget(partPlan, { signal, onProgress, budget: { used: 0n, max: this.maxSetBytes, total } });
  }

  async downloadPartWithBudget(partPlan, { signal, onProgress, budget }) {
    if (!partPlan || typeof partPlan !== 'object' || !decimalBytes(partPlan.size) || typeof partPlan.partId !== 'string' || !partPlan.partId || typeof partPlan.downloadUrl !== 'string') {
      throw new ModpackError('INVALID_REQUEST', 'Artifact download plan is invalid', { details: { field: 'plan' } });
    }
    if (!Array.isArray(partPlan.allowedHosts) || partPlan.allowedHosts.length === 0 || partPlan.allowedHosts.some(host => typeof host !== 'string' || !host)) {
      throw new ModpackError('INVALID_REQUEST', 'Artifact download plan is invalid', { details: { field: 'plan' } });
    }
    if (signal?.aborted) throw cancelled();
    const provider = partPlan.provider;
    if (provider === 'modrinth' && !partPlan.providerDigest) {
      throw new ModpackError('MISSING_PROVIDER_DIGEST', 'Provider digest is required for this artifact', { details: { partId: partPlan.partId } });
    }
    const providerDigest = partPlan.providerDigest;
    if (providerDigest) {
      if (!Object.hasOwn(DIGEST_LENGTHS, providerDigest.algorithm) || typeof providerDigest.value !== 'string' || !new RegExp(`^[a-f0-9]{${DIGEST_LENGTHS[providerDigest.algorithm]}}$`).test(providerDigest.value)) {
        throw new ModpackError('INVALID_REQUEST', 'Artifact provider digest is invalid', { details: { field: 'plan' } });
      }
    }
    let response; let partialPath; let handle;
    const expectedSize = BigInt(partPlan.size);
    const hashes = { sha256: crypto.createHash('sha256'), sha512: crypto.createHash('sha512') };
    if (providerDigest?.algorithm === 'sha1') hashes.sha1 = crypto.createHash('sha1');
    let measured = 0n;
    try {
      response = await this.client.request(partPlan.downloadUrl, {
        signal, headers: partPlan.headers, allowedHosts: partPlan.allowedHosts, allowSubdomains: partPlan.allowSubdomains === true
      });
      if (!response || typeof response[Symbol.asyncIterator] !== 'function' || !Number.isSafeInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300) {
        response?.destroy?.(); throw safeDownloadFailure();
      }
      const rawLength = response.headers?.['content-length'];
      if (rawLength !== undefined) {
        if (Array.isArray(rawLength) || !decimalBytes(String(rawLength))) { response.destroy(); throw safeDownloadFailure(); }
        const declared = BigInt(rawLength);
        if (budget.used + declared > budget.max) { response.destroy(); throw limitExceeded(budget.used + declared); }
        if (declared !== expectedSize) { response.destroy(); throw hashMismatch(); }
      }
      ({ partialPath, handle } = await this.openUniquePartial());
      const onAbort = () => response.destroy(cancelled());
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        for await (const value of response) {
          if (signal?.aborted) throw cancelled();
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          const nextMeasured = measured + BigInt(chunk.length); const nextSet = budget.used + BigInt(chunk.length);
          if (nextSet > budget.max) { response.destroy(); throw limitExceeded(nextSet); }
          for (const hash of Object.values(hashes)) hash.update(chunk);
          let written = 0;
          while (written < chunk.length) {
            const result = await handle.write(chunk, written, chunk.length - written, null);
            if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw new Error('Artifact write made no progress');
            written += result.bytesWritten;
          }
          measured = nextMeasured; budget.used = nextSet;
          if (onProgress) onProgress({ partId: partPlan.partId, partBytes: measured.toString(), setBytes: budget.used.toString(), totalBytes: budget.total.toString() });
        }
      } finally { signal?.removeEventListener('abort', onAbort); }
      if (signal?.aborted) throw cancelled();
      if (measured !== expectedSize) throw hashMismatch();
      const calculated = { sha256: hashes.sha256.digest('hex'), sha512: hashes.sha512.digest('hex') };
      if (providerDigest) {
        const actual = providerDigest.algorithm === 'sha1' ? hashes.sha1.digest('hex') : calculated[providerDigest.algorithm];
        if (actual !== providerDigest.value) throw hashMismatch(providerDigest.algorithm, providerDigest.value, actual);
      }
      await handle.sync(); await handle.close(); handle = null;
      const cachePath = await this.cache.commitPart({ partialPath, sha256: calculated.sha256, measuredSize: measured.toString() });
      partialPath = null;
      return deepFreeze({ partId: partPlan.partId, measuredSize: measured.toString(), sha256: calculated.sha256, sha512: calculated.sha512, cachePath });
    } catch (error) {
      response?.destroy?.();
      if (handle) await handle.close().catch(() => {});
      if (partialPath) await this.fs.rm(partialPath, { force: true }).catch(() => {});
      if (error instanceof ModpackError) throw error;
      if (signal?.aborted || error?.code === 'ABORT_ERR') throw cancelled();
      throw safeDownloadFailure();
    }
  }

  async downloadSet(artifactSetPlan, { signal, onProgress } = {}) {
    const sourceParts = artifactSetPlan?.artifactSet?.parts;
    const reviewed = validateCompleteArtifactSet(strippedPlan(artifactSetPlan)).plan;
    if (!Array.isArray(sourceParts) || sourceParts.length !== reviewed.artifactSet.parts.length) throw new ModpackError('INVALID_REQUEST', 'Artifact download plan is invalid', { details: { field: 'plan' } });
    const sourceById = new Map(sourceParts.map(part => [part?.partId, part]));
    const totalPlanned = reviewed.artifactSet.parts.reduce((sum, part) => sum + BigInt(part.size), 0n);
    if (totalPlanned > this.maxSetBytes) throw limitExceeded(totalPlanned);
    if (reviewed.provider === 'modrinth') {
      const missing = reviewed.artifactSet.parts.find(part => !part.providerDigest);
      if (missing) throw new ModpackError('MISSING_PROVIDER_DIGEST', 'Provider digest is required for this artifact', { details: { partId: missing.partId } });
    }
    const warnings = reviewed.provider === 'github' ? reviewed.artifactSet.parts.filter(part => !part.providerDigest).map(part => ({ code: 'MISSING_PROVIDER_DIGEST', partId: part.partId })) : [];
    const budget = { used: 0n, max: this.maxSetBytes, total: totalPlanned }; const verifiedParts = [];
    for (const part of reviewed.artifactSet.parts) {
      const source = sourceById.get(part.partId);
      if (!source || typeof source.downloadUrl !== 'string') throw new ModpackError('INVALID_REQUEST', 'Artifact download plan is invalid', { details: { field: 'plan' } });
      verifiedParts.push(await this.downloadPartWithBudget({ ...part, provider: reviewed.provider, downloadUrl: source.downloadUrl, allowedHosts: source.allowedHosts, allowSubdomains: source.allowSubdomains, headers: source.headers }, { signal, onProgress, budget }));
    }
    const verifiedSet = finalizeVerifiedArtifactSet(reviewed, verifiedParts.map(({ partId, measuredSize, sha256, sha512 }) => ({ partId, measuredSize, sha256, sha512 })));
    return deepFreeze({ ...verifiedSet, warnings });
  }
}

module.exports = { ArtifactDownloader };
