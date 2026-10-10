const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { finalizeVerifiedArtifactSet } = require('../contracts.cjs');
const { validateCompleteArtifactSet } = require('./artifact-set.cjs');
const {
  GITHUB_ASSET_HEADERS,
  GITHUB_ASSET_HOSTS,
  getAppIssuedGitHubPlanEvidence
} = require('../providers/github-releases-source.cjs');
const { parsePublicGitHubUrl } = require('../providers/github-url.cjs');

const DIGEST_LENGTHS = Object.freeze({ sha1: 40, sha256: 64, sha512: 128 });
const PART_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL_ID = /^[1-9][0-9]*$/;
const GITHUB_DOWNLOAD_AUTHORITY = Symbol('github-download-authority');

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
function rateLimited() { return new ModpackError('RATE_LIMITED', 'GitHub request is rate limited', { retryable: true }); }
function decimalBytes(value) { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value); }
function isInside(parent, child) { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function validDigest(value, algorithm) { return typeof value === 'string' && new RegExp(`^[a-f0-9]{${DIGEST_LENGTHS[algorithm]}}$`).test(value); }
function invalidDownloadPlan() { return new ModpackError('INVALID_REQUEST', 'Artifact download plan is invalid', { details: { field: 'plan' } }); }

function isSafeDecimalId(value) {
  return typeof value === 'string' && DECIMAL_ID.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function githubAcquisitionEvidence(plan, reviewed) {
  const evidence = getAppIssuedGitHubPlanEvidence(plan);
  if (!evidence || !Object.isFrozen(plan) || !Object.isFrozen(evidence) || !Object.isFrozen(evidence.parts) ||
    !reviewed.project || !reviewed.release || !isSafeDecimalId(evidence.repositoryId) || !isSafeDecimalId(evidence.releaseId) ||
    reviewed.project.id !== evidence.repositoryId || reviewed.project.slug !== evidence.projectSlug || reviewed.project.title !== evidence.projectSlug ||
    reviewed.release.id !== evidence.releaseId || reviewed.artifactSet.setDigest !== evidence.setDigest ||
    reviewed.artifactSet.kind !== evidence.kind || reviewed.artifactSet.groupingScheme !== evidence.groupingScheme ||
    reviewed.artifactSet.primaryPartId !== evidence.primaryPartId || reviewed.artifactSet.parts.length !== evidence.parts.length) {
    throw invalidDownloadPlan();
  }
  let canonical;
  try { canonical = parsePublicGitHubUrl(`https://github.com/${evidence.owner}/${evidence.repo}`); }
  catch { throw invalidDownloadPlan(); }
  if (canonical.kind !== 'repository' || `${canonical.owner}/${canonical.repo}` !== evidence.projectSlug) throw invalidDownloadPlan();
  const publicEvidence = plan.sourceEvidence;
  if (!publicEvidence || typeof publicEvidence !== 'object' || !Object.isFrozen(publicEvidence) ||
    publicEvidence.repositoryId !== evidence.repositoryId || publicEvidence.releaseId !== evidence.releaseId ||
    !Array.isArray(publicEvidence.selectedAssetIds) || publicEvidence.selectedAssetIds.length !== evidence.parts.length) {
    throw invalidDownloadPlan();
  }
  const byPartId = new Map();
  for (let index = 0; index < evidence.parts.length; index += 1) {
    const issued = evidence.parts[index];
    const part = reviewed.artifactSet.parts[index];
    if (!issued || !Object.isFrozen(issued) || !isSafeDecimalId(issued.providerAssetId) ||
      issued.partId !== `asset-${issued.providerAssetId}` || part.partId !== issued.partId ||
      part.providerAssetId !== issued.providerAssetId || publicEvidence.selectedAssetIds[index] !== issued.providerAssetId ||
      byPartId.has(issued.partId)) throw invalidDownloadPlan();
    byPartId.set(issued.partId, issued);
  }
  return { ...evidence, byPartId };
}

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

  async downloadPartWithBudget(partPlan, { signal, onProgress, budget, githubAuthority }) {
    if (!partPlan || typeof partPlan !== 'object' || !decimalBytes(partPlan.size) || !PART_ID.test(partPlan.partId || '') || typeof partPlan.downloadUrl !== 'string') {
      throw invalidDownloadPlan();
    }
    if (!Array.isArray(partPlan.allowedHosts) || partPlan.allowedHosts.length === 0 || partPlan.allowedHosts.some(host => typeof host !== 'string' || !host)) {
      throw invalidDownloadPlan();
    }
    if (partPlan.provider === 'github' && githubAuthority !== GITHUB_DOWNLOAD_AUTHORITY) throw invalidDownloadPlan();
    if (signal?.aborted) throw cancelled();
    const provider = partPlan.provider;
    const providerDigest = partPlan.providerDigest;
    if (providerDigest) {
      if (!Object.hasOwn(DIGEST_LENGTHS, providerDigest.algorithm) || !validDigest(providerDigest.value, providerDigest.algorithm)) {
        throw new ModpackError('INVALID_REQUEST', 'Artifact provider digest is invalid', { details: { field: 'plan' } });
      }
    }
    if (provider === 'github' && providerDigest && providerDigest.algorithm !== 'sha256') {
      throw new ModpackError('INVALID_REQUEST', 'Artifact provider digest is invalid', { details: { field: 'plan' } });
    }
    let requiredProviderDigests;
    if (provider === 'modrinth') {
      requiredProviderDigests = partPlan.requiredProviderDigests;
      if (!requiredProviderDigests || typeof requiredProviderDigests !== 'object' || Array.isArray(requiredProviderDigests) ||
        !validDigest(requiredProviderDigests.sha1, 'sha1') || !validDigest(requiredProviderDigests.sha512, 'sha512')) {
        throw new ModpackError('MISSING_PROVIDER_DIGEST', 'Provider digest is required for this artifact', { details: { partId: partPlan.partId } });
      }
      if (Object.keys(requiredProviderDigests).length !== 2 || providerDigest?.algorithm !== 'sha512' || providerDigest.value !== requiredProviderDigests.sha512) {
        throw new ModpackError('INVALID_REQUEST', 'Artifact provider digest is invalid', { details: { field: 'plan' } });
      }
    } else if (partPlan.requiredProviderDigests !== undefined) {
      throw new ModpackError('INVALID_REQUEST', 'Artifact provider digest is invalid', { details: { field: 'plan' } });
    }
    let response; let partialPath; let handle;
    const expectedSize = BigInt(partPlan.size);
    if (budget.used + expectedSize > budget.max) throw limitExceeded(budget.used + expectedSize);
    const hashes = { sha256: crypto.createHash('sha256'), sha512: crypto.createHash('sha512') };
    if (providerDigest?.algorithm === 'sha1' || provider === 'modrinth') hashes.sha1 = crypto.createHash('sha1');
    let measured = 0n;
    try {
      response = await this.client.request(partPlan.downloadUrl, {
        signal, headers: partPlan.headers, allowedHosts: partPlan.allowedHosts, allowSubdomains: partPlan.allowSubdomains === true
      });
      const githubRateLimited = provider === 'github' && response && (
        response.statusCode === 429 ||
        (response.statusCode === 403 && response.headers?.['x-ratelimit-remaining'] === '0')
      );
      if (githubRateLimited) { response.destroy?.(); throw rateLimited(); }
      if (response && [404, 410].includes(response.statusCode)) {
        response.destroy?.();
        const fileName = partPlan.fileName ?? (typeof partPlan.targetPath === 'string' ? partPlan.targetPath.split('/').at(-1) : undefined);
        throw new ModpackError('ARTIFACT_UNAVAILABLE', 'The published file is unavailable', {
          details: { fileName, httpStatus: String(response.statusCode) }
        });
      }
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
          if (nextMeasured > expectedSize) { response.destroy(); throw hashMismatch(); }
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
      if (provider === 'modrinth') {
        const actualSha1 = hashes.sha1.digest('hex');
        if (actualSha1 !== requiredProviderDigests.sha1) throw hashMismatch('sha1', requiredProviderDigests.sha1, actualSha1);
        if (calculated.sha512 !== requiredProviderDigests.sha512) throw hashMismatch('sha512', requiredProviderDigests.sha512, calculated.sha512);
      } else if (providerDigest) {
        const actual = providerDigest.algorithm === 'sha1' ? hashes.sha1.digest('hex') : calculated[providerDigest.algorithm];
        if (actual !== providerDigest.value) throw hashMismatch(providerDigest.algorithm, providerDigest.value, actual);
      }
      await handle.sync(); await handle.close(); handle = null;
      await this.cache.commitPart({ partialPath, sha256: calculated.sha256, measuredSize: measured.toString() });
      partialPath = null;
      return deepFreeze({ partId: partPlan.partId, measuredSize: measured.toString(), sha256: calculated.sha256, sha512: calculated.sha512 });
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
    const githubEvidence = reviewed.provider === 'github' ? githubAcquisitionEvidence(artifactSetPlan, reviewed) : null;
    const sourceById = reviewed.provider === 'github' ? null : new Map(sourceParts.map(part => [part?.partId, part]));
    const totalPlanned = reviewed.artifactSet.parts.reduce((sum, part) => sum + BigInt(part.size), 0n);
    if (totalPlanned > this.maxSetBytes) throw limitExceeded(totalPlanned);
    if (reviewed.provider === 'modrinth') {
      const missing = reviewed.artifactSet.parts.find(part => !part.providerDigest);
      if (missing) throw new ModpackError('MISSING_PROVIDER_DIGEST', 'Provider digest is required for this artifact', { details: { partId: missing.partId } });
    }
    const warnings = reviewed.provider === 'github' ? reviewed.artifactSet.parts.filter(part => !part.providerDigest).map(part => ({ code: 'MISSING_PROVIDER_DIGEST', partId: part.partId })) : [];
    const budget = { used: 0n, max: this.maxSetBytes, total: totalPlanned }; const verifiedParts = [];
    for (const part of reviewed.artifactSet.parts) {
      let requestPolicy;
      if (reviewed.provider === 'github') {
        const issued = githubEvidence.byPartId.get(part.partId);
        if (!issued) throw invalidDownloadPlan();
        requestPolicy = {
          downloadUrl: `https://api.github.com/repos/${githubEvidence.owner}/${githubEvidence.repo}/releases/assets/${issued.providerAssetId}`,
          allowedHosts: [...GITHUB_ASSET_HOSTS],
          allowSubdomains: false,
          headers: { ...GITHUB_ASSET_HEADERS }
        };
      } else {
        const source = sourceById.get(part.partId);
        if (!source || typeof source.downloadUrl !== 'string') throw invalidDownloadPlan();
        requestPolicy = {
          downloadUrl: source.downloadUrl,
          allowedHosts: source.allowedHosts,
          allowSubdomains: source.allowSubdomains,
          headers: source.headers,
          requiredProviderDigests: source.requiredProviderDigests
        };
      }
      verifiedParts.push(await this.downloadPartWithBudget({ ...part, provider: reviewed.provider, ...requestPolicy }, {
        signal, onProgress, budget,
        ...(reviewed.provider === 'github' ? { githubAuthority: GITHUB_DOWNLOAD_AUTHORITY } : {})
      }));
    }
    return finalizeVerifiedArtifactSet(
      reviewed,
      verifiedParts.map(({ partId, measuredSize, sha256, sha512 }) => ({ partId, measuredSize, sha256, sha512 })),
      warnings
    );
  }
}

module.exports = { ArtifactDownloader };
