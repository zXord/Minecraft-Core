const crypto = require('node:crypto');
const { ModpackError, deepFreeze } = require('./errors.cjs');
const { parseNonNegativeBytes } = require('./limits.cjs');

const PROVIDERS = new Set(['modrinth', 'github', 'local']);
const CHANNELS = new Set(['release', 'beta', 'alpha', 'prerelease']);
const GROUPING_SCHEMES = new Set(['single', 'part-number', 'rar-rxx', 'numbered-volume']);
const ATTESTATION_STATUSES = new Set(['unavailable', 'unverified', 'verified']);
const LOADER_FAMILIES = new Set(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);
const DIGEST_LENGTHS = Object.freeze({ sha1: 40, sha256: 64, sha512: 128 });

function invalidRequest(message, field) {
  throw new ModpackError('INVALID_REQUEST', message, { details: field ? { field } : undefined });
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalidRequest('Request value is invalid', field);
  }
  return value;
}

function assertKnownKeys(value, keys, field) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalidRequest('Request contains an unsupported field', `${field}.${key}`);
  }
}

function assertNonEmptyString(value, field, { maxLength = 256, pattern } = {}) {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\u0000-\u001f]/.test(value) || (pattern && !pattern.test(value))) {
    invalidRequest('Request string is invalid', field);
  }
  return value;
}

function assertIdentifier(value, field) {
  return assertNonEmptyString(value, field, { maxLength: 128, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ });
}

function assertDecimal(value, field) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) invalidRequest('Request byte value is invalid', field);
  try { parseNonNegativeBytes(value); } catch { invalidRequest('Request byte value is invalid', field); }
  return value;
}

function assertIsoTimestamp(value, field) {
  assertNonEmptyString(value, field, { maxLength: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) invalidRequest('Request timestamp is invalid', field);
  return value;
}

function assertDigest(value, algorithm, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]+$/.test(value) || value.length !== DIGEST_LENGTHS[algorithm]) {
    invalidRequest('Request digest is invalid', field);
  }
  return value;
}

function normalizeProviderDigest(value, field) {
  if (value === undefined || value === null) return null;
  assertPlainObject(value, field);
  assertKnownKeys(value, ['algorithm', 'value'], field);
  if (!Object.hasOwn(DIGEST_LENGTHS, value.algorithm)) invalidRequest('Request digest algorithm is invalid', `${field}.algorithm`);
  return { algorithm: value.algorithm, value: assertDigest(value.value, value.algorithm, `${field}.value`) };
}

function normalizeCalculatedDigests(value, field) {
  assertPlainObject(value, field);
  assertKnownKeys(value, ['sha256', 'sha512'], field);
  return {
    sha256: assertDigest(value.sha256, 'sha256', `${field}.sha256`),
    sha512: assertDigest(value.sha512, 'sha512', `${field}.sha512`)
  };
}

function normalizeFileName(value, field) {
  assertNonEmptyString(value, field, { maxLength: 255 });
  const windowsStem = value.split('.', 1)[0].replace(/[ .]+$/g, '').toUpperCase();
  const windowsDeviceNames = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']);
  if (
    value !== value.trim() || value === '.' || value === '..' || /[<>:"/\\|?*]/.test(value) || /[. ]$/.test(value) ||
    windowsDeviceNames.has(windowsStem)
  ) {
    invalidRequest('Request file name is invalid', field);
  }
  return value;
}

function canonicalPartIdentity(part) {
  const identity = {
    partId: part.partId,
    providerAssetId: part.providerAssetId ?? null,
    fileName: part.fileName,
    size: part.size,
    updatedAt: part.updatedAt ?? null,
    providerDigest: part.providerDigest ?? null
  };
  if (part.calculatedDigests) identity.calculatedDigests = part.calculatedDigests;
  return identity;
}

function computeArtifactSetDigest(parts) {
  if (!Array.isArray(parts) || parts.length === 0) invalidRequest('Artifact set parts are required', 'parts');
  const canonical = parts.map((part, index) => {
    assertPlainObject(part, `parts.${index}`);
    return canonicalPartIdentity({
      partId: assertIdentifier(part.partId, `parts.${index}.partId`),
      providerAssetId: part.providerAssetId === undefined || part.providerAssetId === null ? null : assertIdentifier(part.providerAssetId, `parts.${index}.providerAssetId`),
      fileName: normalizeFileName(part.fileName, `parts.${index}.fileName`),
      size: assertDecimal(part.size, `parts.${index}.size`),
      updatedAt: part.updatedAt === undefined || part.updatedAt === null ? null : assertIsoTimestamp(part.updatedAt, `parts.${index}.updatedAt`),
      providerDigest: normalizeProviderDigest(part.providerDigest, `parts.${index}.providerDigest`),
      calculatedDigests: part.calculatedDigests === undefined ? undefined : normalizeCalculatedDigests(part.calculatedDigests, `parts.${index}.calculatedDigests`)
    });
  });
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function normalizePlanPart(value, index) {
  const field = `artifactSet.parts.${index}`;
  assertPlainObject(value, field);
  assertKnownKeys(value, ['partId', 'providerAssetId', 'fileName', 'size', 'updatedAt', 'providerDigest'], field);
  return {
    partId: assertIdentifier(value.partId, `${field}.partId`),
    ...(value.providerAssetId === undefined || value.providerAssetId === null ? {} : { providerAssetId: assertIdentifier(value.providerAssetId, `${field}.providerAssetId`) }),
    fileName: normalizeFileName(value.fileName, `${field}.fileName`),
    size: assertDecimal(value.size, `${field}.size`),
    ...(value.updatedAt === undefined ? {} : { updatedAt: assertIsoTimestamp(value.updatedAt, `${field}.updatedAt`) }),
    ...(value.providerDigest === undefined ? {} : { providerDigest: normalizeProviderDigest(value.providerDigest, `${field}.providerDigest`) })
  };
}

function normalizeArtifactSet(value) {
  assertPlainObject(value, 'artifactSet');
  assertKnownKeys(value, ['kind', 'primaryPartId', 'groupingScheme', 'parts', 'providerImmutable', 'attestationStatus'], 'artifactSet');
  if (value.kind !== 'single' && value.kind !== 'multipart') invalidRequest('Artifact set kind is invalid', 'artifactSet.kind');
  if (!GROUPING_SCHEMES.has(value.groupingScheme)) invalidRequest('Artifact grouping scheme is invalid', 'artifactSet.groupingScheme');
  if (!Array.isArray(value.parts) || value.parts.length === 0) invalidRequest('Artifact set parts are required', 'artifactSet.parts');
  if (value.kind === 'single' && (value.parts.length !== 1 || value.groupingScheme !== 'single')) invalidRequest('Single artifact sets require one single part', 'artifactSet');
  if (value.kind === 'multipart' && (value.parts.length < 2 || value.groupingScheme === 'single')) invalidRequest('Multipart artifact sets require multiple grouped parts', 'artifactSet');
  const parts = value.parts.map(normalizePlanPart);
  const partIds = new Set(parts.map((part) => part.partId));
  const fileNames = new Set(parts.map((part) => part.fileName.toLocaleLowerCase('en-US')));
  if (partIds.size !== parts.length || fileNames.size !== parts.length) invalidRequest('Artifact parts must be unique', 'artifactSet.parts');
  const primaryPartId = assertIdentifier(value.primaryPartId, 'artifactSet.primaryPartId');
  if (!partIds.has(primaryPartId)) invalidRequest('Artifact primary part is invalid', 'artifactSet.primaryPartId');
  if (typeof value.providerImmutable !== 'boolean') invalidRequest('Artifact provider immutable is invalid', 'artifactSet.providerImmutable');
  if (!ATTESTATION_STATUSES.has(value.attestationStatus)) invalidRequest('Artifact attestation status is invalid', 'artifactSet.attestationStatus');
  return {
    kind: value.kind,
    primaryPartId,
    groupingScheme: value.groupingScheme,
    parts,
    setDigest: computeArtifactSetDigest(parts),
    providerImmutable: value.providerImmutable,
    attestationStatus: value.attestationStatus
  };
}

function normalizeProject(value) {
  assertPlainObject(value, 'project');
  assertKnownKeys(value, ['id', 'slug', 'title'], 'project');
  return { id: assertIdentifier(value.id, 'project.id'), slug: assertNonEmptyString(value.slug, 'project.slug'), title: assertNonEmptyString(value.title, 'project.title') };
}

function normalizeRelease(value) {
  assertPlainObject(value, 'release');
  assertKnownKeys(value, ['id', 'version', 'channel', 'publishedAt'], 'release');
  if (!CHANNELS.has(value.channel)) invalidRequest('Release channel is invalid', 'release.channel');
  return {
    id: assertIdentifier(value.id, 'release.id'),
    version: assertNonEmptyString(value.version, 'release.version'),
    channel: value.channel,
    publishedAt: assertIsoTimestamp(value.publishedAt, 'release.publishedAt')
  };
}

function createArtifactSetPlan(input) {
  assertPlainObject(input, 'input');
  assertKnownKeys(input, ['provider', 'project', 'release', 'artifactSet'], 'input');
  if (!PROVIDERS.has(input.provider)) invalidRequest('Artifact provider is invalid', 'provider');
  if (input.provider !== 'local' && (!input.project || !input.release)) invalidRequest('Provider artifact identity is incomplete', 'input');
  return deepFreeze({
    type: 'artifact-set-plan',
    provider: input.provider,
    ...(input.project === undefined ? {} : { project: normalizeProject(input.project) }),
    ...(input.release === undefined ? {} : { release: normalizeRelease(input.release) }),
    artifactSet: normalizeArtifactSet(input.artifactSet)
  });
}

function finalizeVerifiedArtifactSet(plan, verifiedParts) {
  const reviewedPlan = revalidateArtifactSetPlan(plan);
  if (!Array.isArray(verifiedParts) || verifiedParts.length !== reviewedPlan.artifactSet.parts.length) invalidRequest('Verified artifact parts are invalid', 'verifiedParts');
  const verifiedById = new Map();
  for (let index = 0; index < verifiedParts.length; index += 1) {
    const part = verifiedParts[index];
    assertPlainObject(part, `verifiedParts.${index}`);
    assertKnownKeys(part, ['partId', 'measuredSize', 'sha256', 'sha512'], `verifiedParts.${index}`);
    const partId = assertIdentifier(part.partId, `verifiedParts.${index}.partId`);
    if (verifiedById.has(partId)) invalidRequest('Verified artifact parts are duplicated', 'verifiedParts');
    verifiedById.set(partId, {
      measuredSize: assertDecimal(part.measuredSize, `verifiedParts.${index}.measuredSize`),
      calculatedDigests: {
        sha256: assertDigest(part.sha256, 'sha256', `verifiedParts.${index}.sha256`),
        sha512: assertDigest(part.sha512, 'sha512', `verifiedParts.${index}.sha512`)
      }
    });
  }
  const parts = reviewedPlan.artifactSet.parts.map((plannedPart) => {
    const measured = verifiedById.get(plannedPart.partId);
    if (!measured) invalidRequest('Verified artifact part is missing', 'verifiedParts');
    if (measured.measuredSize !== plannedPart.size) throw new ModpackError('HASH_MISMATCH', 'Artifact size did not match the reviewed plan');
    return { ...plannedPart, measuredSize: measured.measuredSize, calculatedDigests: measured.calculatedDigests };
  });
  const artifactSet = { ...reviewedPlan.artifactSet, parts, setDigest: computeArtifactSetDigest(parts) };
  return deepFreeze({
    type: 'verified-artifact-set',
    provider: reviewedPlan.provider,
    ...(reviewedPlan.project ? { project: reviewedPlan.project } : {}),
    ...(reviewedPlan.release ? { release: reviewedPlan.release } : {}),
    artifactSet
  });
}

function assertArtifactSetUnchanged(expected, actual) {
  const expectedIdentity = expected && expected.artifactSet && {
    kind: expected.artifactSet.kind,
    primaryPartId: expected.artifactSet.primaryPartId,
    groupingScheme: expected.artifactSet.groupingScheme,
    setDigest: expected.artifactSet.setDigest
  };
  const actualIdentity = actual && actual.artifactSet && {
    kind: actual.artifactSet.kind,
    primaryPartId: actual.artifactSet.primaryPartId,
    groupingScheme: actual.artifactSet.groupingScheme,
    setDigest: actual.artifactSet.setDigest
  };
  if (!expectedIdentity || !actualIdentity || JSON.stringify(expectedIdentity) !== JSON.stringify(actualIdentity)) {
    throw new ModpackError('PLAN_STALE', 'The reviewed artifact set has changed');
  }
  return actual;
}

function revalidateArtifactSetPlan(plan) {
  if (!plan || typeof plan !== 'object' || plan.type !== 'artifact-set-plan') invalidRequest('Artifact plan is invalid', 'plan');
  const artifactSet = plan.artifactSet;
  if (!artifactSet || typeof artifactSet !== 'object' || !Array.isArray(artifactSet.parts)) invalidRequest('Artifact plan is invalid', 'plan.artifactSet');
  const project = plan.project && typeof plan.project === 'object' ? {
    id: plan.project.id,
    slug: plan.project.slug,
    title: plan.project.title
  } : undefined;
  const release = plan.release && typeof plan.release === 'object' ? {
    id: plan.release.id,
    version: plan.release.version,
    channel: plan.release.channel,
    publishedAt: plan.release.publishedAt
  } : undefined;
  return createArtifactSetPlan({
    provider: plan.provider,
    ...(project ? { project } : {}),
    ...(release ? { release } : {}),
    artifactSet: {
      kind: artifactSet.kind,
      primaryPartId: artifactSet.primaryPartId,
      groupingScheme: artifactSet.groupingScheme,
      parts: artifactSet.parts.map((part) => ({
        partId: part && part.partId,
        ...(part && part.providerAssetId === undefined ? {} : { providerAssetId: part && part.providerAssetId }),
        fileName: part && part.fileName,
        size: part && part.size,
        ...(part && part.updatedAt === undefined ? {} : { updatedAt: part && part.updatedAt }),
        ...(part && part.providerDigest === undefined ? {} : { providerDigest: part && part.providerDigest })
      })),
      providerImmutable: artifactSet.providerImmutable,
      attestationStatus: artifactSet.attestationStatus
    }
  });
}

function normalizeRuntimeTuple(input) {
  assertPlainObject(input, 'runtime');
  assertKnownKeys(input, ['minecraftVersion', 'loaderFamily', 'loaderVersion', 'javaMajor', 'os', 'architecture'], 'runtime');
  const minecraftVersion = assertNonEmptyString(input.minecraftVersion, 'runtime.minecraftVersion', { maxLength: 64, pattern: /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/ });
  if (!LOADER_FAMILIES.has(input.loaderFamily)) invalidRequest('Runtime loader family is invalid', 'runtime.loaderFamily');
  const loaderVersion = assertNonEmptyString(input.loaderVersion, 'runtime.loaderVersion', { maxLength: 128 });
  if (!Number.isSafeInteger(input.javaMajor) || input.javaMajor < 8 || input.javaMajor > 99) invalidRequest('Runtime Java major is invalid', 'runtime.javaMajor');
  if (input.os !== 'win32') invalidRequest('Runtime operating system is invalid', 'runtime.os');
  if (input.architecture !== 'x64') invalidRequest('Runtime architecture is invalid', 'runtime.architecture');
  return deepFreeze({ minecraftVersion, loaderFamily: input.loaderFamily, loaderVersion, javaMajor: input.javaMajor, os: input.os, architecture: input.architecture });
}

module.exports = {
  assertArtifactSetUnchanged,
  canonicalPartIdentity,
  computeArtifactSetDigest,
  createArtifactSetPlan,
  finalizeVerifiedArtifactSet,
  normalizeRuntimeTuple
};
