const crypto = require('node:crypto');
const { canonicalPartIdentity: contractPartIdentity } = require('../contracts.cjs');
const { validateCompleteArtifactSet } = require('./artifact-set.cjs');

function canonicalPartIdentity(part) {
  return contractPartIdentity(part);
}

function computePlanFingerprint(plan) {
  const reviewed = validateCompleteArtifactSet(plan).plan;
  const canonical = {
    type: reviewed.type,
    provider: reviewed.provider,
    project: reviewed.project || null,
    release: reviewed.release || null,
    artifactSet: {
      kind: reviewed.artifactSet.kind,
      primaryPartId: reviewed.artifactSet.primaryPartId,
      groupingScheme: reviewed.artifactSet.groupingScheme,
      parts: reviewed.artifactSet.parts.map(canonicalPartIdentity),
      setDigest: reviewed.artifactSet.setDigest,
      providerImmutable: reviewed.artifactSet.providerImmutable,
      attestationStatus: reviewed.artifactSet.attestationStatus
    }
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

module.exports = { canonicalPartIdentity, computePlanFingerprint };
