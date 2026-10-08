const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { computePlanFingerprint } = require('../artifacts/artifact-fingerprint.cjs');
const { isAppIssuedVerifiedArtifactSet } = require('../contracts.cjs');
const { ModpackError } = require('../errors.cjs');

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Archive workspace request is invalid', { details: { field } });
}

function stale() {
  throw new ModpackError('PLAN_STALE', 'Archive inspection is stale');
}

function changed(cause) {
  return new ModpackError('HASH_MISMATCH', 'Verified archive bytes changed during materialization', { cause });
}

class ArchiveInputMaterializer {
  constructor({ workspaceRegistry, workspaceRoot } = {}) {
    if (!workspaceRegistry || typeof workspaceRegistry.createPlanningSession !== 'function' ||
        typeof workspaceRegistry.registerVerifiedSet !== 'function' || typeof workspaceRegistry.materializeInput !== 'function' ||
        typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) invalid('workspace');
    this.workspaceRegistry = workspaceRegistry;
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  reviewedNames(verifiedArtifactSet) {
    const set = verifiedArtifactSet.artifactSet;
    return {
      kind: set.kind,
      groupingScheme: set.groupingScheme,
      primaryPartId: set.primaryPartId,
      parts: set.parts.map(part => ({ partId: part.partId, fileName: part.fileName }))
    };
  }

  async verifyMaterialized({ inputDirectoryId, verifiedArtifactSet }) {
    const inputDirectory = path.resolve(this.workspaceRoot, inputDirectoryId);
    if (path.dirname(inputDirectory) !== this.workspaceRoot) invalid('inputDirectoryId');
    const stat = await fsp.lstat(inputDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid('inputDirectoryId');
    const expected = [...verifiedArtifactSet.artifactSet.parts].map(part => part.fileName).sort();
    const children = await fsp.readdir(inputDirectory, { withFileTypes: true });
    const actual = children.map(child => child.name).sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]) ||
        children.some(child => !child.isFile() || child.isSymbolicLink())) invalid('inputDirectoryId');
    for (const part of verifiedArtifactSet.artifactSet.parts) {
      const partPath = path.join(inputDirectory, part.fileName);
      let handle;
      try {
        handle = await fsp.open(partPath, fs.constants.O_RDONLY);
        const before = await handle.stat();
        if (!before.isFile() || BigInt(before.size) !== BigInt(part.measuredSize)) throw changed();
        const sha256 = crypto.createHash('sha256');
        const sha512 = crypto.createHash('sha512');
        let measured = 0n;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          measured += BigInt(chunk.length);
          if (measured > BigInt(part.measuredSize)) throw changed();
          sha256.update(chunk);
          sha512.update(chunk);
        }
        const after = await handle.stat();
        if (measured !== BigInt(part.measuredSize) || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
            after.ino !== before.ino || after.dev !== before.dev ||
            sha256.digest('hex') !== part.calculatedDigests.sha256 ||
            sha512.digest('hex') !== part.calculatedDigests.sha512) throw changed();
      } catch (error) {
        if (error instanceof ModpackError) throw error;
        throw changed(error);
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    const primary = verifiedArtifactSet.artifactSet.parts.find(part => part.partId === verifiedArtifactSet.artifactSet.primaryPartId);
    const primaryPath = path.join(inputDirectory, primary.fileName);
    return { inputDirectory, primaryPath };
  }

  async prepare(verifiedArtifactSet) {
    if (!isAppIssuedVerifiedArtifactSet(verifiedArtifactSet)) invalid('verifiedArtifactSet');
    const fingerprint = computePlanFingerprint(verifiedArtifactSet);
    const ownerId = this.workspaceRegistry.createPlanningSession();
    try {
      const artifactSetId = this.workspaceRegistry.registerVerifiedSet({ ownerId, verifiedSet: verifiedArtifactSet });
      const inputDirectoryId = await this.workspaceRegistry.materializeInput({ ownerId, artifactSetId });
      const materialized = await this.verifyMaterialized({ inputDirectoryId, verifiedArtifactSet });
      if (computePlanFingerprint(verifiedArtifactSet) !== fingerprint) stale();
      return Object.freeze({
        ownerId,
        artifactSetId,
        inputDirectoryId,
        verifiedArtifactSet,
        fingerprint,
        reviewedNames: this.reviewedNames(verifiedArtifactSet),
        ...materialized
      });
    } catch (error) {
      try { await this.workspaceRegistry.releaseOwner(ownerId); } catch { /* preserve the primary failure */ }
      throw error;
    }
  }

  async readPrefix(context, maximumBytes = 64) {
    if (!context || typeof context.primaryPath !== 'string' || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 4096) invalid('prefix');
    const handle = await fsp.open(context.primaryPath, fs.constants.O_RDONLY);
    try {
      const bytes = Buffer.alloc(maximumBytes);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  promote(context, result) {
    const inspectionId = this.workspaceRegistry.createInspection({
      ownerId: context.ownerId,
      artifactSetId: context.artifactSetId,
      result
    });
    this.workspaceRegistry.transferOwnership({ fromOwnerId: context.ownerId, toOwnerId: inspectionId });
    return inspectionId;
  }

  loadInspection(inspectionId) {
    if (typeof inspectionId !== 'string') invalid('inspectionId');
    const inspection = this.workspaceRegistry.resolveOwnedId({ ownerId: inspectionId, id: inspectionId, kind: 'inspection' });
    const artifactSetId = inspection?.value?.artifactSetId;
    const result = inspection?.value?.result;
    if (typeof artifactSetId !== 'string' || !result || typeof result !== 'object') stale();
    const artifact = this.workspaceRegistry.resolveOwnedId({ ownerId: inspectionId, id: artifactSetId, kind: 'artifact-set' });
    const verifiedArtifactSet = artifact?.value;
    if (verifiedArtifactSet?.type !== 'verified-artifact-set' ||
        computePlanFingerprint(verifiedArtifactSet) !== result?.artifactSet?.fingerprint) stale();
    return { inspectionId, artifactSetId, result, verifiedArtifactSet };
  }

  async rematerialize(inspectionId) {
    const loaded = this.loadInspection(inspectionId);
    const inputDirectoryId = await this.workspaceRegistry.materializeInput({ ownerId: inspectionId, artifactSetId: loaded.artifactSetId });
    try {
      const materialized = await this.verifyMaterialized({ inputDirectoryId, verifiedArtifactSet: loaded.verifiedArtifactSet });
      return Object.freeze({ ...loaded, ownerId: inspectionId, inputDirectoryId, ...materialized });
    } catch (error) {
      try { await this.workspaceRegistry.releaseOwner(inspectionId); } catch { /* preserve the primary failure */ }
      throw error;
    }
  }
}

module.exports = { ArchiveInputMaterializer };
