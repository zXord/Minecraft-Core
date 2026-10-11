const crypto = require('node:crypto');
const path = require('node:path');

const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { compactOperationIdFromRandomSource } = require('./operation-id.cjs');
const { normalizeRetirementCandidate } = require('./failed-restorepoint-retirement-evidence.cjs');
const { isSafeWindowsBasename } = require('../modpacks/windows-basename.cjs');
const { normalizeRecoveryTargetPath } = require('./recovery-target-envelope.cjs');
const {
  PREFLIGHT_PLAN_JSON_LIMITS,
  computePreflightPlanFingerprint
} = require('../modpacks/planning/plan-fingerprint.cjs');

const PLAN_TTL_MS = 2 * 60 * 60 * 1000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RANDOM_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_VIEW_KEY = /(?:path|url|uri|cache|workspace|directory|provider.?internal|raw|header|token|secret|password|command|argument|artifactSetId|inputDirectoryId|outputDirectoryId|inspectionId|planningSessionId)/i;
const INTERNAL_ID = /^(?:artifact-set|input|output|inspection|planning|workspace|cache)-/i;

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The reviewed modpack plan is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale', { cause });
}

function strictObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.some(name => !allowedKeys.includes(name)) || requiredKeys.some(name => !Object.hasOwn(descriptors, name))) throw invalid();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return descriptors;
}

function clone(value) {
  try { return strictJsonClone(value, PREFLIGHT_PLAN_JSON_LIMITS); }
  catch (error) { throw invalid(error); }
}

function isDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== Array.prototype) ||
      Object.getOwnPropertySymbols(value).length !== 0) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !isDeepFrozen(descriptor.value, seen)) return false;
  }
  return true;
}

function isIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function assertIdentifier(value) {
  if (!isIdentifier(value)) throw invalid();
  return value;
}

function fingerprint(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw invalid();
  return value;
}

function publicString(value) {
  if (typeof value !== 'string' || value.length > 4096 || value !== value.normalize('NFC') ||
      /\b(?:https?|file):\/\//iu.test(value) || /(?:^|\s)[A-Za-z]:[\\/]/u.test(value) ||
      /(?:^|\s)\\\\/u.test(value) || INTERNAL_ID.test(value)) throw invalid();
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) throw invalid();
  }
  return value;
}

function validatePlanView(value, field = 'planView', depth = 0) {
  if (depth > 12) throw invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (typeof value === 'string') return publicString(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000) throw invalid();
    return value.map((item, index) => validatePlanView(item, `${field}.${index}`, depth + 1));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 512) throw invalid();
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key) ||
        FORBIDDEN_VIEW_KEY.test(key)) throw invalid();
    result[key] = validatePlanView(descriptor.value, `${field}.${key}`, depth + 1);
  }
  return result;
}

function nowMilliseconds(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(milliseconds) || milliseconds < 0) throw invalid();
  return milliseconds;
}

function publicCreated(record) {
  return deepFreeze({
    planId: record.planId,
    fingerprint: record.fingerprint,
    planView: clone(record.planView),
    expiresAt: record.expiresAt
  });
}

function internalRecord(record) {
  return deepFreeze({
    planId: record.planId,
    fingerprint: record.fingerprint,
    plan: record.plan,
    planView: clone(record.planView),
    reservationInstanceId: record.reservationInstanceId ?? null,
    expiresAt: record.expiresAt
  });
}

class PlanRegistry {
  constructor({ workspaceRegistry, clock = () => Date.now(), randomUUID = crypto.randomUUID, ttlMs = PLAN_TTL_MS,
    allowNewServerLaunchBindings = false } = {}) {
    if (!workspaceRegistry || typeof workspaceRegistry.transferOwnership !== 'function' ||
        typeof workspaceRegistry.releaseOwner !== 'function' || typeof clock !== 'function' || typeof randomUUID !== 'function' ||
        typeof allowNewServerLaunchBindings !== 'boolean' || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw invalid();
    this.workspaceRegistry = workspaceRegistry;
    this.clock = clock;
    this.randomUUID = randomUUID;
    this.ttlMs = ttlMs;
    this.plans = new Map();
    this.allocatedIds = new Set();
    this.claimedJobIds = new Set();
    this.claimedPlans = new Map();
    this.allowNewServerLaunchBindings = allowNewServerLaunchBindings;
    this.invalidations = new Map();
    this.fenceGeneration = 0;
  }

  create(request) {
    const descriptors = strictObject(request, ['plan', 'sanitizedView', 'fingerprint', 'planningSessionId', 'preparationAttempt'],
      ['plan', 'sanitizedView', 'fingerprint', 'planningSessionId']);
    const suppliedPlan = descriptors.plan.value;
    const clonedPlan = clone(suppliedPlan);
    if (!clonedPlan || typeof clonedPlan !== 'object' || Array.isArray(clonedPlan) ||
        Object.getPrototypeOf(clonedPlan) !== Object.prototype) throw invalid();
    const reviewedFingerprint = fingerprint(descriptors.fingerprint.value);
    if (clonedPlan.fingerprint !== reviewedFingerprint ||
        computePreflightPlanFingerprint(clonedPlan) !== reviewedFingerprint) throw invalid();
    const plan = isDeepFrozen(suppliedPlan) ? suppliedPlan : deepFreeze(clonedPlan);
    const planningSessionId = assertIdentifier(descriptors.planningSessionId.value);
    const planView = validatePlanView(descriptors.sanitizedView.value);
    const planId = this.#newId(this.allowNewServerLaunchBindings && plan.operation?.serverKind === 'new' ? 'plan-launch-v1' : 'plan');
    const createdAtMs = nowMilliseconds(this.clock);
    const expiresAtMs = createdAtMs + this.ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw invalid();
    const record = {
      planId,
      fingerprint: reviewedFingerprint,
      plan,
      planView,
      planningSessionId,
      claimable: true,
      createdAtMs,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
    this.workspaceRegistry.transferOwnership({ fromOwnerId: planningSessionId, toOwnerId: planId,
      ...(descriptors.preparationAttempt ? { preparationAttempt: descriptors.preparationAttempt.value } : {}) });
    this.plans.set(planId, record);
    return publicCreated(record);
  }

  async get(request) {
    const record = await this.#resolveCredential(request);
    this.#assertClaimable(record);
    return internalRecord(record);
  }

  async claim(request) {
    const record = await this.#resolveCredential(request);
    this.#assertClaimable(record);
    const jobId = this.#newId('job');
    this.workspaceRegistry.transferOwnership({ fromOwnerId: record.planId, toOwnerId: jobId });
    this.claimedJobIds.add(jobId);
    this.claimedPlans.set(jobId, record);
    this.#fence(record);
    this.plans.delete(record.planId);
    return deepFreeze({
      jobId,
      ...internalRecord(record),
      claimedAt: new Date(nowMilliseconds(this.clock)).toISOString()
    });
  }

  async releaseClaim(jobId) {
    if (!isIdentifier(jobId) || !this.claimedJobIds.has(jobId)) return false;
    await this.workspaceRegistry.releaseOwner(jobId);
    this.claimedJobIds.delete(jobId);
    this.claimedPlans.delete(jobId);
    return true;
  }

  hasRestorePointReference(request) {
    strictObject(request, ['instanceId', 'candidate', 'excludingJobId']);
    const instanceId = assertIdentifier(request.instanceId);
    assertIdentifier(request.excludingJobId);
    const candidate = normalizeRetirementCandidate(request.candidate);
    let owned = false;
    const references = new Map();
    // Do not use get(): expiration releases ownership, which is forbidden in this query.
    for (const record of [...this.plans.values(), ...this.claimedPlans.values()]) {
      const plan = record.plan;
      if (plan.operation?.serverKind === 'new' && plan.operation.instanceId === null) continue;
      if (!plan.operation || !isIdentifier(plan.operation.instanceId)) throw invalid();
      if (plan.operation.instanceId !== instanceId) continue;
      if (!Array.isArray(plan.restorePoints) || plan.restorePoints.length > 10000) throw invalid();
      for (const point of plan.restorePoints) {
        if (!point || typeof point !== 'object' || Array.isArray(point) || Object.getPrototypeOf(point) !== Object.prototype ||
            !isIdentifier(point.id) || typeof point.sha256 !== 'string' || !SHA256.test(point.sha256)) throw invalid();
        const sameId = point.id === candidate.id;
        const prior = references.get(point.id);
        if (prior && (prior.sha256 !== point.sha256 || ['name', 'metadataName', 'archivePath', 'metadataPath'].some(key =>
          Object.hasOwn(prior, key) && Object.hasOwn(point, key) && prior[key] !== point[key]))) throw invalid();
        references.set(point.id, { ...prior, ...point });
        let sameLocator = false;
        for (const [key, expected] of [['name', candidate.name], ['metadataName', candidate.metadataName]]) {
          if (Object.hasOwn(point, key)) {
            if (typeof point[key] !== 'string' || !isSafeWindowsBasename(point[key])) throw invalid();
            if (point[key].toLocaleLowerCase('en-US') === expected.toLocaleLowerCase('en-US')) sameLocator = true;
            else if (sameId) throw invalid();
          }
        }
        // Private full references can also carry exact leaf paths.
        for (const [key, expected] of [['archivePath', candidate.name], ['metadataPath', candidate.metadataName]]) {
          if (Object.hasOwn(point, key)) {
            const canonical = normalizeRecoveryTargetPath(point[key]);
            if (path.win32.basename(canonical) === expected.toLocaleLowerCase('en-US')) sameLocator = true;
            else if (sameId) throw invalid();
          }
        }
        if ((sameId && point.sha256 !== candidate.sha256) || (sameLocator && !sameId)) throw invalid();
        // Exclusion never hides a selected rollback/downgrade point, even in the failed job's own plan.
        if (sameId || sameLocator) owned = true;
      }
    }
    return owned;
  }

  async invalidate(planId) {
    if (!isIdentifier(planId)) return false;
    const record = this.plans.get(planId);
    if (!record) return false;
    this.#fence(record);
    if (this.invalidations.has(planId)) return this.invalidations.get(planId);
    const cleanup = Promise.resolve().then(async () => {
      await this.workspaceRegistry.releaseOwner(planId);
      if (this.plans.get(planId) === record) this.plans.delete(planId);
      return true;
    }).finally(() => this.invalidations.delete(planId));
    this.invalidations.set(planId, cleanup);
    return cleanup;
  }

  bindNewServerReservation(planId, instanceId) {
    assertIdentifier(planId); assertIdentifier(instanceId);
    const record = this.plans.get(planId);
    this.#assertClaimable(record);
    if (record.plan.operation?.serverKind !== 'new' || record.plan.operation.instanceId !== instanceId ||
        (record.reservationInstanceId && record.reservationInstanceId !== instanceId)) throw stale();
    record.reservationInstanceId = instanceId;
    return true;
  }

  invalidateReservation(instanceId) {
    assertIdentifier(instanceId);
    const ids = [];
    for (const record of this.plans.values()) {
      if (record.reservationInstanceId === instanceId) { this.#fence(record); ids.push(record.planId); }
    }
    return Promise.all(ids.map(id => this.invalidate(id))).then(() => ids.length);
  }

  #assertClaimable(record) {
    if (!record || record.claimable !== true || this.plans.get(record.planId) !== record ||
        nowMilliseconds(this.clock) >= record.expiresAtMs) throw stale();
  }

  #fence(record) {
    if (record.claimable) { record.claimable = false; this.fenceGeneration++; }
  }

  async dispose() {
    const planIds = [...this.plans.keys()];
    for (const record of this.plans.values()) this.#fence(record);
    let firstFailure = null;
    for (const planId of planIds) {
      try {
        await this.invalidate(planId);
      }
      catch (error) { firstFailure ??= error; }
    }
    if (firstFailure) throw firstFailure;
    return planIds.length;
  }

  async #resolveCredential(request) {
    let descriptors;
    try { descriptors = strictObject(request, ['planId', 'fingerprint']); }
    catch (error) {
      if (error instanceof ModpackError && error.code === 'INVALID_REQUEST') throw stale(error);
      throw error;
    }
    const planId = descriptors.planId.value;
    const receivedFingerprint = descriptors.fingerprint.value;
    if (!isIdentifier(planId) || typeof receivedFingerprint !== 'string' || !SHA256.test(receivedFingerprint)) throw stale();
    const record = this.plans.get(planId);
    if (!record || !record.claimable || record.fingerprint !== receivedFingerprint) throw stale();
    if (nowMilliseconds(this.clock) >= record.expiresAtMs) {
      try { await this.invalidate(planId); }
      catch (error) { throw stale(error); }
      throw stale();
    }
    return record;
  }

  #newId(prefix) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const value = this.randomUUID();
      if (typeof value !== 'string' || !RANDOM_ID.test(value)) throw invalid();
      if (prefix === 'plan-launch-v1' && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw invalid();
      // Mutation IDs version the compact same-parent transaction namespace.
      // Plan IDs remain unchanged because they never become server-path leaves.
      const id = prefix === 'job' ? compactOperationIdFromRandomSource(value) : `${prefix}-${value}`;
      if (!this.allocatedIds.has(id) && !this.plans.has(id)) {
        this.allocatedIds.add(id);
        return id;
      }
    }
    throw stale();
  }
}

module.exports = { PLAN_TTL_MS, PlanRegistry };
