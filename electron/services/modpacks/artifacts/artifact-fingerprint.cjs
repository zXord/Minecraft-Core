const crypto = require('node:crypto');
const { canonicalPartIdentity: contractPartIdentity, computeArtifactSetDigest, createArtifactSetPlan } = require('../contracts.cjs');
const { ModpackError } = require('../errors.cjs');
const { validateCompleteArtifactSet } = require('./artifact-set.cjs');

const SHA256 = /^[a-f0-9]{64}$/; const SHA512 = /^[a-f0-9]{128}$/;
function canonicalPartIdentity(part) { return contractPartIdentity(part); }
function canonicalVerifiedPartIdentity(part) {
  const { calculatedDigests, ...base } = canonicalPartIdentity(part);
  return { ...base, measuredSize: part.measuredSize, calculatedDigests: { sha256: part.calculatedDigests.sha256, sha512: part.calculatedDigests.sha512 } };
}
function invalid() { throw new ModpackError('INVALID_REQUEST', 'Artifact plan is invalid', { details: { field: 'plan' } }); }
function verifiedCanonical(value) {
  if (!value || value.type !== 'verified-artifact-set' || !value.artifactSet || !Array.isArray(value.artifactSet.parts)) invalid();
  const set = value.artifactSet;
  const planParts = set.parts.map((part) => ({ partId: part?.partId, ...(part?.providerAssetId === undefined ? {} : { providerAssetId: part.providerAssetId }), fileName: part?.fileName, size: part?.size, ...(part?.updatedAt === undefined ? {} : { updatedAt: part.updatedAt }), ...(part?.providerDigest === undefined ? {} : { providerDigest: part.providerDigest }) }));
  createArtifactSetPlan({ provider: value.provider, ...(value.project ? { project: value.project } : {}), ...(value.release ? { release: value.release } : {}), artifactSet: { kind: set.kind, primaryPartId: set.primaryPartId, groupingScheme: set.groupingScheme, parts: planParts, providerImmutable: set.providerImmutable, attestationStatus: set.attestationStatus } });
  for (const part of set.parts) if (!/^(0|[1-9][0-9]*)$/.test(part.measuredSize || '') || part.measuredSize !== part.size || !SHA256.test(part.calculatedDigests?.sha256 || '') || !SHA512.test(part.calculatedDigests?.sha512 || '')) invalid();
  if (!SHA256.test(set.setDigest || '') || computeArtifactSetDigest(set.parts) !== set.setDigest) invalid();
  return { type: value.type, provider: value.provider, project: value.project || null, release: value.release || null, selectionId: value.selectionId || null,
    artifactSet: { kind: set.kind, primaryPartId: set.primaryPartId, groupingScheme: set.groupingScheme, parts: set.parts.map(canonicalVerifiedPartIdentity), setDigest: set.setDigest, providerImmutable: set.providerImmutable, attestationStatus: set.attestationStatus } };
}
function computePlanFingerprint(plan) {
  const canonical = plan?.type === 'verified-artifact-set' ? verifiedCanonical(plan) : (() => { const reviewed = validateCompleteArtifactSet(plan).plan; return { type: reviewed.type, provider: reviewed.provider, project: reviewed.project || null, release: reviewed.release || null, selectionId: reviewed.selectionId || null, artifactSet: { kind: reviewed.artifactSet.kind, primaryPartId: reviewed.artifactSet.primaryPartId, groupingScheme: reviewed.artifactSet.groupingScheme, parts: reviewed.artifactSet.parts.map(canonicalPartIdentity), setDigest: reviewed.artifactSet.setDigest, providerImmutable: reviewed.artifactSet.providerImmutable, attestationStatus: reviewed.artifactSet.attestationStatus } }; })();
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
module.exports = { canonicalPartIdentity, computePlanFingerprint };
