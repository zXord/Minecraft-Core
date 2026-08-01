const { createArtifactSetPlan } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');

function stale() {
  throw new ModpackError('PLAN_STALE', 'The reviewed artifact set has changed');
}

function aliasKey(fileName) {
  return fileName.normalize('NFC').toLocaleLowerCase('en-US');
}

function validateCompleteArtifactSet(plan) {
  if (!plan || typeof plan !== 'object' || plan.type !== 'artifact-set-plan') {
    throw new ModpackError('INVALID_REQUEST', 'Artifact plan is invalid', { details: { field: 'plan' } });
  }
  const sourceSet = plan.artifactSet || {};
  const input = {
    provider: plan.provider,
    ...(plan.project ? { project: plan.project } : {}),
    ...(plan.release ? { release: plan.release } : {}),
    artifactSet: {
      kind: sourceSet.kind,
      primaryPartId: sourceSet.primaryPartId,
      groupingScheme: sourceSet.groupingScheme,
      parts: sourceSet.parts,
      providerImmutable: sourceSet.providerImmutable,
      attestationStatus: sourceSet.attestationStatus
    }
  };
  const normalized = createArtifactSetPlan(input);
  if (sourceSet.setDigest !== normalized.artifactSet.setDigest) stale();
  const aliases = new Set();
  for (const part of normalized.artifactSet.parts) {
    const key = aliasKey(part.fileName);
    if (aliases.has(key)) {
      throw new ModpackError('INVALID_REQUEST', 'Artifact parts have conflicting basenames', { details: { field: 'artifactSet.parts' } });
    }
    aliases.add(key);
  }
  return deepFreeze({ type: 'provisional-artifact-set', verificationState: 'provisional', plan: normalized });
}

module.exports = { validateCompleteArtifactSet };
