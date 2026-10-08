const { ModpackError, FAILURE_CODES } = require('../modpacks/errors.cjs');
const { normalizeRecoveryTargetPath, JOB_ID_PATTERN } = require('./recovery-target-envelope.cjs');
const { waitForRuntimeWorkerQuiescence } = require('../runtime-worker-quiescence.cjs');
const { normalizeRuntimeDiagnostic } = require('../runtime-diagnostic.cjs');
function runtimeDiagnosticFromError(error) {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const diagnostic = Object.getOwnPropertyDescriptor(current, 'runtimeDiagnostic');
    if (diagnostic && Object.hasOwn(diagnostic, 'value')) {
      try { return normalizeRuntimeDiagnostic(diagnostic.value); } catch { /* informational metadata is optional */ }
    }
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value;
  }
  return null;
}
const failureCode = error => [error?.runtimeFailureCode, error?.code].find(code => typeof code === 'string' && FAILURE_CODES.includes(code)) || 'RUNTIME_INCOMPLETE';
const fail = cause => Object.assign(new ModpackError('RECOVERY_REQUIRED', 'Runtime shutdown is unproven; the candidate is retained for recovery', { cause }),
  { preserveWorkspace: true, runtimeWritersUnproven: true, runtimeFailureCode: failureCode(cause) });
async function boundedRuntimeSettlement(promise, timeoutMs = 5000, cause) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail(cause)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bootSequence = value => { if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) throw fail(); return value; };
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw fail();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !d.enumerable || !Object.hasOwn(d, 'value'))) throw fail();
}
function normalizeRuntimeWriterAuthority(value, record) {
  exact(value, ['schemaVersion', 'jobId', 'candidatePath', 'candidateIdentity', 'bootSequence', 'state']);
  exact(value.candidateIdentity, ['volumeSerial', 'fileId']);
  const identity = value.candidateIdentity;
  if (value.schemaVersion !== 1 || typeof value.jobId !== 'string' || !JOB_ID_PATTERN.test(value.jobId) ||
      typeof identity.volumeSerial !== 'string' || !/^[a-f0-9]{1,32}$/.test(identity.volumeSerial) ||
      typeof identity.fileId !== 'string' || !/^[a-f0-9]{1,64}$/.test(identity.fileId) ||
      !['unproven', 'settled'].includes(value.state)) throw fail();
  const candidatePath = normalizeRecoveryTargetPath(value.candidatePath);
  const result = { schemaVersion: 1, jobId: value.jobId, candidatePath, candidateIdentity: { ...identity },
    bootSequence: bootSequence(value.bootSequence), state: value.state };
  if (record && (result.jobId !== record.jobId || result.candidatePath !== record.candidatePath ||
      !equal(result.candidateIdentity, record.directoryIdentities?.candidate))) throw fail();
  return result;
}
function legacyMayHaveRuntimeWriters(record) {
  if (!['install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback'].includes(record.operationKind)) return false;
  if (['queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'preflight',
    'snapshotting', 'staging', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed'].includes(record.phase)) return false;
  return true;
}
class ServerRuntimeWriterAuthority {
  constructor({ registry, coordinator, getBootSequence, settlementTimeoutMs = 5000 } = {}) {
    if (!registry || typeof registry.load !== 'function' || typeof registry.updateRuntimeWriterAuthority !== 'function' ||
        typeof getBootSequence !== 'function' || !Number.isSafeInteger(settlementTimeoutMs) || settlementTimeoutMs < 1 || settlementTimeoutMs > 30000) throw fail();
    Object.assign(this, { registry, coordinator, getBootSequence, settlementTimeoutMs });
  }
  async _set(record, authority, failureCode = null, diagnostic = null) {
    return this.registry.updateRuntimeWriterAuthority(record.jobId, { expectedSequence: record.sequence, authority, failureCode,
      ...(diagnostic ? { diagnostic } : {}) });
  }
  async _begin(record) {
    if (record.outcome?.runtimeWriterAuthority) throw fail();
    const authority = normalizeRuntimeWriterAuthority({ schemaVersion: 1, jobId: record.jobId, candidatePath: record.candidatePath,
      candidateIdentity: record.directoryIdentities?.candidate, bootSequence: bootSequence(await this.getBootSequence()), state: 'unproven' }, record);
    return this._set(record, authority);
  }
  async _settle(jobId, expected) {
    const record = await this.registry.load(jobId);
    if (!record || !equal(record.outcome?.runtimeWriterAuthority, expected)) throw fail();
    return this._set(record, { ...expected, state: 'settled' });
  }
  _block(lease, cause, originalError = cause) {
    if (lease) {
      if (typeof this.coordinator?.quarantineMutation !== 'function') throw fail(cause);
      this.coordinator.quarantineMutation(lease);
    }
    const diagnostic = runtimeDiagnosticFromError(originalError);
    throw Object.assign(fail(cause), { runtimeFailureCode: failureCode(originalError),
      ...(diagnostic ? { runtimeDiagnostic: diagnostic } : {}) });
  }
  async run(jobId, work, { lease } = {}) {
    let record;
    try { record = await this._begin(await this.registry.load(jobId)); }
    catch (error) { return this._block(lease, error); }
    const authority = record.outcome.runtimeWriterAuthority;
    let result;
    try { result = await work(); }
    catch (error) {
      // Persist the initiating safe code before even starting the closure wait.
      try {
        const latest = await this.registry.load(jobId);
        const code = failureCode(error);
        await this._set(latest, latest.outcome.runtimeWriterAuthority, code, runtimeDiagnosticFromError(error));
      } catch (persistError) { return this._block(lease, persistError, error); }
      const settlement = waitForRuntimeWorkerQuiescence(error).then(() => this._settle(jobId, authority));
      // Late authenticated closure may settle only this exact marker. Failed CAS
      // retains authority; no timeout, PID absence, or UI action grants cleanup.
      settlement.catch(() => {});
      try {
        await boundedRuntimeSettlement(settlement, this.settlementTimeoutMs, error);
      } catch (closureError) { return this._block(lease, closureError, error); }
      throw error;
    }
    try { await this._settle(jobId, authority); }
    catch (error) { return this._block(lease, error); }
    return result;
  }
  async assertRecoveryAllowed(record, { lease } = {}) {
    try {
      const value = record.outcome?.runtimeWriterAuthority;
      if (!value) {
        if (record.outcome?.runtimeWriterProtocol === 1 || !legacyMayHaveRuntimeWriters(record)) return record;
        await this._begin(record); throw fail();
      }
      const authority = normalizeRuntimeWriterAuthority(value, record);
      if (authority.state === 'settled') return record;
      if (bootSequence(await this.getBootSequence()) <= authority.bootSequence) throw fail();
      return this._settle(record.jobId, authority);
    } catch (error) { return this._block(lease, error); }
  }
}
module.exports = { ServerRuntimeWriterAuthority, normalizeRuntimeWriterAuthority, legacyMayHaveRuntimeWriters, boundedRuntimeSettlement, runtimeDiagnosticFromError };
