const path = require('node:path');

const { ModpackError } = require('./modpacks/errors.cjs');
const revisionApi = require('./server-content-revision.cjs');
const durableFs = require('../utils/durable-fs.cjs');
const {
  LEGACY_INSTANCE_CONFIG_ADVISORY,
  isLegacyInstanceConfigFs
} = require('../utils/instance-config-fs.cjs');
const {
  sharedServerMutationContext
} = require('./server-mutation-context.cjs');

// Two classes of work share this coordinator.
//
// Modpack lifecycle, recovery, companion pairing and failed-restorepoint
// retirement (every caller that does not pass `ordinary`) are exclusive per
// folder: they fail fast against any other holder, quiesce a running server and
// pin the content revision.
//
// Ordinary writers ({ordinary: true}, every policy-wrapped writer) behave like
// v26.6.1: they share a folder with each other and with a running server, and
// wait (bounded) behind an exclusive ordinary writer instead of failing. A
// `stoppedOnly` writer or an ordinary group is exclusive among ordinary writers.
// Ordinary writers fail fast against lifecycle or recovery work and never
// overlap it, so modpack operations keep their exclusive, quiesced view.
const OPERATION_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const INSTANCE_ID_MAX_LENGTH = 512;
const SELECTOR_KEYS = new Set(['instanceId', 'serverPath']);
const MUTATION_OPTION_KEYS = new Set([
  'operation', 'operationId', 'ordinary', 'quiesce', 'revisionMode', 'signal', 'stoppedOnly'
]);
const START_OPTION_KEYS = new Set([
  'operation', 'operationId', 'parentMutationLease'
]);
const RECOVERY_MUTATION_OPTION_KEYS = new Set(['operationId', 'signal']);
const RECOVERY_RECORD_KEYS = new Set(['operationId', 'selector']);
const RECOVERY_OUTCOME_KEYS = new Set(['resolved', 'selector']);
const RECOVERY_COMPLETION_OPTION_KEYS = new Set(['globalBlock']);
const REVISION_MODES = new Set(['auto', 'lifecycle', 'none']);
const RECOVERY_COMMIT_PHASES = new Set(['post-publication', 'post-publication-uncertain']);
const NEW_SERVER_OPERATIONS = new Set(['install-new', 'import-files-only-new']);
const HOLDER_LIFECYCLE = 'lifecycle';
const HOLDER_ORDINARY_EXCLUSIVE = 'ordinary-exclusive';
const HOLDER_ORDINARY_SHARED = 'ordinary-shared';
const DEFAULT_ORDINARY_WAIT_TIMEOUT_MS = 120000;
const MAX_TIMER_DELAY_MS = 2147483647;
// A drive root (E:\) or a share root (\\nas\share\) may hold a server.
const SERVER_ROOT_PATTERN = /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)$/;
const DEVICE_NAMESPACE_PATTERN = /^\\\\[?.]\\/;
const UNC_SHARE_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function invalidRequest(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The server mutation request is invalid', { cause });
}

function operationInProgress(operationId) {
  return new ModpackError('OPERATION_IN_PROGRESS', 'Another operation is already changing this server', {
    details: { operationId }
  });
}

function serverRunning(instanceId) {
  return new ModpackError('SERVER_RUNNING', 'The server must be stopped before this operation can continue', {
    details: instanceId ? { serverId: instanceId } : undefined
  });
}

function recoveryRequired(operationId) {
  return new ModpackError('RECOVERY_REQUIRED', 'Server recovery must be completed before this operation can continue', {
    details: operationId ? { operationId } : undefined
  });
}

function cancelled() {
  return new ModpackError('CANCELLED', 'The operation was cancelled');
}

function commitFailure(cause) {
  if (cause instanceof ModpackError && (cause.code === 'COMMIT_FAILED' || cause.code === 'PLAN_STALE')) {
    return cause;
  }
  return new ModpackError('COMMIT_FAILED', 'Unable to finalize the server content revision', { cause });
}

// A revision write refused before anything was written: the instance keeps the
// change its writer made and only its change counter lags.
function prePublicationFailure(cause) {
  const error = new ModpackError('COMMIT_FAILED', 'Unable to finalize the server content revision', { cause });
  Object.defineProperty(error, 'commitPhase', {
    value: 'pre-publication',
    enumerable: true,
    configurable: false,
    writable: false
  });
  return error;
}

// Every failure of the legacy instance-config writer (folders without modpack
// lifecycle evidence) is advisory: it can fence modpack work, never quarantine.
function advisoryFailure(cause) {
  const error = prePublicationFailure(cause);
  Object.defineProperty(error, LEGACY_INSTANCE_CONFIG_ADVISORY, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return error;
}

function isPrePublicationFailure(error) {
  return error instanceof ModpackError && error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication';
}

// A strict writer's tagged refusal keeps its tag through the wrap, except a
// compare-and-set mismatch, which is a genuine external change.
function strictRevisionFailure(error) {
  const tagged = error && typeof error === 'object' && error.commitPhase === 'pre-publication';
  if (!tagged || (error instanceof ModpackError && error.code === 'PLAN_STALE')) return commitFailure(error);
  return isPrePublicationFailure(error) ? error : prePublicationFailure(error);
}

function staleRevision() {
  return new ModpackError('PLAN_STALE', 'The server content revision changed during the operation');
}

function fencedRevision() {
  return new ModpackError(
    'PLAN_STALE',
    'The server changed while its change counter could not be saved; review the modpack change again'
  );
}

function aliasConflict(...records) {
  for (const record of records) {
    const block = record?.recoveryBlock || record?.revisionFailure;
    if (block) throw recoveryRequired(block.operationId);
  }
  throw invalidRequest();
}

function publicationRequiresRecovery(error) {
  return error instanceof ModpackError &&
    (error.code === 'COMMIT_FAILED' || error.code === 'PLAN_STALE') &&
    RECOVERY_COMMIT_PHASES.has(error.commitPhase);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, allowed) {
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) throw invalidRequest();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !allowed.has(key))) throw invalidRequest();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidRequest();
  }
  return value;
}

function assertOperation(value) {
  if (typeof value !== 'string' || !OPERATION_PATTERN.test(value)) throw invalidRequest();
  return value;
}

function assertOperationId(value) {
  try {
    return revisionApi.assertOperationId(value);
  } catch (error) {
    throw invalidRequest(error);
  }
}

function normalizeInstanceId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidRequest();
  const display = value.trim().normalize('NFC');
  const hasControl = Array.from(display).some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (display.length === 0 || display.length > INSTANCE_ID_MAX_LENGTH || hasControl) {
    throw invalidRequest();
  }
  return {
    display,
    key: display.toLocaleLowerCase('en-US')
  };
}

function upperCaseDrive(value) {
  return /^[a-z]:/.test(value) ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

// `canonical` keeps the caller's filesystem spelling (only slashes, trailing
// separators and the drive letter change), so a folder whose name is NFD on
// disk is still found. Only the alias `key` is NFC and lower case.
function normalizeServerPath(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw invalidRequest();
  if (value.split(/[\\/]/u).some(segment => segment === '.' || segment === '..')) throw invalidRequest();
  let canonical;
  let flavor;

  if (path.win32.isAbsolute(value)) {
    const slashed = value.replace(/\//g, '\\');
    if (DEVICE_NAMESPACE_PATTERN.test(slashed) || (slashed.startsWith('\\\\') && !UNC_SHARE_PATTERN.test(slashed))) {
      throw invalidRequest();
    }
    canonical = upperCaseDrive(path.win32.normalize(slashed));
    const root = path.win32.parse(canonical).root;
    while (canonical.length > root.length && canonical.endsWith('\\')) canonical = canonical.slice(0, -1);
    if (canonical === root && !SERVER_ROOT_PATTERN.test(canonical)) throw invalidRequest();
    flavor = 'win32';
  } else {
    if (!path.isAbsolute(value)) throw invalidRequest();
    canonical = path.resolve(value);
    if (canonical === path.parse(canonical).root) throw invalidRequest();
    flavor = 'native';
  }

  return {
    canonical,
    flavor,
    key: canonical.normalize('NFC').toLocaleLowerCase('en-US')
  };
}

function normalizeSelector(value) {
  assertExactKeys(value, SELECTOR_KEYS);
  const instance = normalizeInstanceId(value.instanceId);
  const serverPath = normalizeServerPath(value.serverPath);
  if (!instance && !serverPath) throw invalidRequest();
  return { instance, serverPath };
}

/** The coordinator's alias key for a server folder, or null when it is not one. */
function coordinatorPathKey(value) {
  try {
    return normalizeServerPath(value)?.key ?? null;
  } catch {
    return null;
  }
}

/** The coordinator's alias key for an instance id, or null when it is not one. */
function coordinatorInstanceKey(value) {
  try {
    return normalizeInstanceId(value)?.key ?? null;
  } catch {
    return null;
  }
}

function isAbortSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' && typeof value.removeEventListener === 'function';
}

function normalizeMutationOptions(value) {
  assertExactKeys(value, MUTATION_OPTION_KEYS);
  const operation = assertOperation(value.operation);
  const operationId = assertOperationId(value.operationId);
  if (!REVISION_MODES.has(value.revisionMode)) throw invalidRequest();
  if (value.quiesce !== undefined && value.quiesce !== null && typeof value.quiesce !== 'function') {
    throw invalidRequest();
  }
  if (value.signal !== undefined && !isAbortSignal(value.signal)) throw invalidRequest();
  for (const flag of ['ordinary', 'stoppedOnly']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw invalidRequest();
  }
  const ordinary = value.ordinary === true;
  const stoppedOnly = value.stoppedOnly === true;
  // An ordinary writer never stops a server or pins a lifecycle revision.
  if ((stoppedOnly && !ordinary) || (ordinary && (value.quiesce || value.revisionMode === 'lifecycle'))) {
    throw invalidRequest();
  }
  return Object.freeze({
    operation,
    operationId,
    ordinary,
    quiesce: value.quiesce || null,
    revisionMode: value.revisionMode,
    signal: value.signal || null,
    stoppedOnly
  });
}

function normalizeStartOptions(value) {
  assertExactKeys(value, START_OPTION_KEYS);
  return Object.freeze({
    operation: assertOperation(value.operation),
    operationId: assertOperationId(value.operationId),
    parentMutationLease: value.parentMutationLease ?? null
  });
}

function normalizeRecoveryMutationOptions(value) {
  assertExactKeys(value, RECOVERY_MUTATION_OPTION_KEYS);
  if (value.signal !== undefined && !isAbortSignal(value.signal)) throw invalidRequest();
  return Object.freeze({
    operation: 'modpack-recovery',
    operationId: assertOperationId(value.operationId),
    ordinary: false,
    quiesce: null,
    revisionMode: 'none',
    signal: value.signal || null,
    stoppedOnly: false
  });
}

function normalizeRecoveryCompletionOptions(value = {}) {
  assertExactKeys(value, RECOVERY_COMPLETION_OPTION_KEYS);
  if (value.globalBlock !== undefined && typeof value.globalBlock !== 'boolean') throw invalidRequest();
  return Object.freeze({ globalBlock: value.globalBlock === true });
}

function holderFor(options, many) {
  if (!options.ordinary) return HOLDER_LIFECYCLE;
  return options.stoppedOnly || many ? HOLDER_ORDINARY_EXCLUSIVE : HOLDER_ORDINARY_SHARED;
}

// Ordinary writers that are not stopped-only may run beside a server start.
function overlapsStart(options) {
  return options.ordinary === true && options.stoppedOnly !== true;
}

function assertSafeRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw commitFailure();
  return value;
}

function canonicalPathWithin(rootRecord, candidateValue) {
  const candidate = normalizeServerPath(candidateValue);
  if (!rootRecord.serverPath || candidate.flavor !== rootRecord.pathFlavor) throw invalidRequest();
  const pathApi = candidate.flavor === 'win32' ? path.win32 : path;
  const relative = pathApi.relative(rootRecord.pathKey, candidate.key);
  if (relative === '' || (!pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`))) {
    return candidate.canonical;
  }
  throw invalidRequest();
}

function createReleasePromise() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForAbortable(promise, signal) {
  if (!signal) {
    await promise;
    return;
  }
  if (signal.aborted) throw cancelled();
  let onAbort;
  try {
    await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        onAbort = () => reject(cancelled());
        signal.addEventListener('abort', onAbort, { once: true });
      })
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

// Resolves when the admission state changes or the deadline passes; rejects
// with CANCELLED when the signal aborts.
async function waitForAdmissionChange(changed, deadline, signal) {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(resolve, Math.min(Math.max(0, deadline - Date.now()), MAX_TIMER_DELAY_MS));
  });
  try {
    await waitForAbortable(Promise.race([changed, timeout]), signal);
  } finally {
    clearTimeout(timer);
  }
}

class ServerMutationCoordinator {
  constructor(options = {}) {
    assertExactKeys(options, new Set([
      'bumpContentRevision', 'context', 'durableFs', 'durableFsFactory', 'ordinaryWaitTimeoutMs', 'readContentRevision'
    ]));
    if (options.durableFs !== undefined && options.durableFsFactory !== undefined) throw invalidRequest();
    if (options.durableFsFactory !== undefined && typeof options.durableFsFactory !== 'function') throw invalidRequest();
    if (options.ordinaryWaitTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.ordinaryWaitTimeoutMs) || options.ordinaryWaitTimeoutMs < 0)) {
      throw invalidRequest();
    }
    this.context = options.context || sharedServerMutationContext;
    this.readContentRevision = options.readContentRevision || revisionApi.readContentRevision;
    this.bumpContentRevision = options.bumpContentRevision || revisionApi.bumpContentRevision;
    this.durableFs = options.durableFs || (options.durableFsFactory ? null : durableFs);
    this.durableFsFactory = options.durableFsFactory || null;
    this.ordinaryWaitTimeoutMs = options.ordinaryWaitTimeoutMs ?? DEFAULT_ORDINARY_WAIT_TIMEOUT_MS;
    if (!this.context || typeof this.context.getCurrentLease !== 'function' ||
        typeof this.context.runWithLease !== 'function' ||
        typeof this.readContentRevision !== 'function' || typeof this.bumpContentRevision !== 'function') {
      throw invalidRequest();
    }

    this.instanceAliases = new Map();
    this.pathAliases = new Map();
    this.records = new Set();
    this.leaseStates = new WeakMap();
    this.groupStates = new WeakMap();
    // Lifecycle fences of retired records, re-applied when the folder is bound again.
    this.retiredPathFences = new Map();
    this.admissionChange = createReleasePromise();
    this.waitTickets = 0;
    this.recoveryOpen = true;
    this.globalRecoveryBlock = true;
  }

  beginStartupRecovery() {
    this.recoveryOpen = true;
    this.globalRecoveryBlock = true;
    return true;
  }

  installRecoveryBlocks(records) {
    if (!this.recoveryOpen || !Array.isArray(records)) throw invalidRequest();
    const prepared = records.map(record => {
      assertExactKeys(record, RECOVERY_RECORD_KEYS);
      const operationId = assertOperationId(record.operationId);
      const normalized = normalizeSelector(record.selector);
      return { normalized, operationId };
    });

    for (const item of prepared) {
      const record = this._resolveRecord(item.normalized, { allowIncomplete: true });
      if (record.recoveryBlock && record.recoveryBlock.operationId !== item.operationId) throw invalidRequest();
      record.recoveryBlock = Object.freeze({ operationId: item.operationId });
    }
    return prepared.length;
  }

  quarantineMutation(lease) {
    const state = this.leaseStates.get(lease);
    if (!state || !state.active || state.kind !== 'mutation' || lease.kind !== 'mutation' ||
        state.reservation.holder !== HOLDER_LIFECYCLE || state.record.mutation !== state.reservation) {
      throw invalidRequest();
    }
    if (state.record.recoveryBlock && state.record.recoveryBlock.operationId !== state.operationId) throw invalidRequest();
    state.record.recoveryBlock = Object.freeze({ operationId: state.operationId });
    return true;
  }

  completeStartupRecovery(outcomes, optionsValue = {}) {
    if (!this.recoveryOpen || !Array.isArray(outcomes)) throw invalidRequest();
    const options = normalizeRecoveryCompletionOptions(optionsValue);
    const prepared = outcomes.map(outcome => {
      assertExactKeys(outcome, RECOVERY_OUTCOME_KEYS);
      if (typeof outcome.resolved !== 'boolean') throw invalidRequest();
      return { normalized: normalizeSelector(outcome.selector), resolved: outcome.resolved };
    });

    for (const outcome of prepared) {
      const record = this._findRecord(outcome.normalized);
      if (!record || (!record.recoveryBlock && !record.revisionFailure)) throw invalidRequest();
      if (outcome.resolved) {
        record.resolvedRecoveryOperationId = record.recoveryBlock?.operationId || record.revisionFailure?.operationId;
        record.recoveryBlock = null;
        record.revisionFailure = null;
      }
    }

    this.recoveryOpen = false;
    this.globalRecoveryBlock = options.globalBlock;
    return Object.freeze({
      resolved: prepared.filter(outcome => outcome.resolved).length,
      unresolved: Array.from(this.records).filter(record => record.recoveryBlock || record.revisionFailure).length,
      globalBlocked: this.globalRecoveryBlock
    });
  }

  runMutation(selectorValue, optionsValue, work) {
    return this._startMutationRun([selectorValue], optionsValue, work, false);
  }

  // Internal lifecycle boundary: the caller must first authenticate an abandoned
  // new-server closure and absence of registration. Ordinary lease release never
  // permits rebinding an instance/path pair.
  retireAbandonedIncarnation(selectorValue, optionsValue) {
    const normalized = normalizeSelector(selectorValue);
    assertExactKeys(optionsValue, new Set(['operationId']));
    const operationId = assertOperationId(optionsValue.operationId);
    if (!normalized.instance || !normalized.serverPath) throw invalidRequest();
    const record = this.instanceAliases.get(normalized.instance.key);
    if (!record) return false; // Already retired; never touch a newer path owner.
    if (record.pathKey !== normalized.serverPath.key || this.pathAliases.get(record.pathKey) !== record ||
        (record.newServerOperationId !== operationId && record.resolvedRecoveryOperationId !== operationId)) throw invalidRequest();
    this._assertAvailable(record);
    if (record.start) throw operationInProgress(record.start.operationId);
    const ordinaryClaim = this._ordinaryClaimOperationId(record);
    if (ordinaryClaim) throw operationInProgress(ordinaryClaim);
    if (record.mutation && record.mutation.operationId !== operationId) throw operationInProgress(record.mutation.operationId);
    record.retirementOperationId = operationId;
    if (!record.mutation) this._retireAbandonedRecord(record);
    return true;
  }

  assertUnstartedMutation(selectorValue, optionsValue) {
    const normalized = normalizeSelector(selectorValue);
    assertExactKeys(optionsValue, new Set(['operationId']));
    const operationId = assertOperationId(optionsValue.operationId);
    if (!normalized.instance || !normalized.serverPath) throw invalidRequest();
    const record = this._findRecord(normalized);
    if (!record) { if (this.globalRecoveryBlock) throw recoveryRequired(); return true; }
    this._assertAvailable(record);
    const busy = this._activeOperationId(record) || record.start?.operationId;
    if (busy) throw operationInProgress(busy);
    if (record.instanceKey === normalized.instance.key || record.newServerOperationId === operationId) throw invalidRequest();
    return true;
  }

  /**
   * Arms retirement of the registration an ordinary exclusive writer (a delete
   * or a registry save) has just removed. The record is forgotten when that
   * reservation is released, only if it is then idle and unblocked; a lifecycle
   * fence is carried over by path. Returns false when the alias must stay.
   */
  retireRegistrationOnRelease(lease) {
    const state = this.leaseStates.get(lease);
    if (!state || state.kind !== 'mutation' || !state.active || !state.reservation.active ||
        state.reservation.holder !== HOLDER_ORDINARY_EXCLUSIVE || state.record.mutation !== state.reservation ||
        !state.record.instanceKey || !state.record.pathKey ||
        this.instanceAliases.get(state.record.instanceKey) !== state.record ||
        this.pathAliases.get(state.record.pathKey) !== state.record) throw invalidRequest();
    if (this.globalRecoveryBlock || state.record.start || state.record.recoveryBlock || state.record.revisionFailure) {
      return false;
    }
    state.record.retirementOperationId = state.operationId;
    return true;
  }

  /**
   * Forgets a registration removed outside a coordinated writer: only a record
   * bound to exactly this id and folder that is idle, unblocked and not reserved
   * by a new-server install. Never throws for state; returns whether it retired.
   */
  retireIdleRegistration(selectorValue) {
    assertExactKeys(selectorValue, SELECTOR_KEYS);
    let normalized;
    try {
      normalized = normalizeSelector(selectorValue);
    } catch {
      return false;
    }
    if (!normalized.instance || !normalized.serverPath || this.globalRecoveryBlock) return false;
    const record = this.instanceAliases.get(normalized.instance.key);
    if (!record || record.pathKey !== normalized.serverPath.key || this.pathAliases.get(record.pathKey) !== record ||
        !this._isIdle(record) || record.recoveryBlock || record.revisionFailure || record.newServerOperationId) {
      return false;
    }
    this._forgetRecord(record);
    return true;
  }

  /** The instance id bound to a server folder, or null. Read-only. */
  pathBinding(serverPath) {
    let normalized;
    try {
      normalized = normalizeServerPath(serverPath);
    } catch {
      return null;
    }
    const record = normalized ? this.pathAliases.get(normalized.key) : null;
    return record ? Object.freeze({ instanceId: record.instanceId }) : null;
  }

  /** True only for a lease this coordinator issued that has not been released. */
  isLiveLease(lease) {
    const state = this.leaseStates.get(lease);
    if (state) return state.active === true && (state.kind === 'start' || state.reservation.active === true);
    const group = this.groupStates.get(lease);
    return Boolean(group && group.reservation.active);
  }

  /**
   * Every operation that currently holds a folder: lifecycle and recovery work,
   * exclusive and shared ordinary writers, and starts that are not running yet.
   * A group is listed once. Read-only.
   */
  listActiveOperations() {
    const records = [...this.records].sort((left, right) =>
      this._recordSortKey(left).localeCompare(this._recordSortKey(right), 'en-US'));
    const seen = new Set();
    const operations = [];
    const add = (entry, holder, serverPath) => {
      if (seen.has(entry)) return;
      seen.add(entry);
      operations.push(Object.freeze({
        operationId: entry.operationId,
        operation: entry.operation,
        holder,
        serverPath
      }));
    };
    for (const record of records) {
      const reservation = record.mutation;
      if (reservation?.active) add(reservation, reservation.holder, reservation.records[0]?.serverPath || record.serverPath);
    }
    for (const record of records) {
      for (const reservation of record.shared) {
        if (reservation.active) add(reservation, HOLDER_ORDINARY_SHARED, record.serverPath);
      }
    }
    for (const record of records) {
      const start = record.start;
      if (start?.active && !start.running) add(start, 'start-pending', start.ownedRoot.serverPath || record.serverPath);
    }
    return Object.freeze(operations);
  }

  _retireAbandonedRecord(record) {
    if (!record.retirementOperationId || !this._isIdle(record) || record.recoveryBlock || record.revisionFailure) return false;
    if (this.instanceAliases.get(record.instanceKey) !== record || this.pathAliases.get(record.pathKey) !== record) throw invalidRequest();
    this._forgetRecord(record);
    return true;
  }

  // Retirement armed by an ordinary writer is best-effort: any doubt keeps the alias.
  _retireReleasedRegistration(record) {
    try {
      if (!this.globalRecoveryBlock && this._retireAbandonedRecord(record)) return true;
    } catch {
      // Keep the alias: fail closed.
    }
    record.retirementOperationId = null;
    return false;
  }

  _forgetRecord(record) {
    if (record.lifecycleFence && record.pathKey) this.retiredPathFences.set(record.pathKey, record.lifecycleFence);
    if (record.instanceKey && this.instanceAliases.get(record.instanceKey) === record) this.instanceAliases.delete(record.instanceKey);
    if (record.pathKey && this.pathAliases.get(record.pathKey) === record) this.pathAliases.delete(record.pathKey);
    this.records.delete(record);
  }

  runManyMutations(selectorValues, optionsValue, work) {
    if (!Array.isArray(selectorValues) || selectorValues.length === 0) {
      return Promise.reject(invalidRequest());
    }
    return this._startMutationRun(selectorValues, optionsValue, work, true);
  }

  assertMutationLease(lease, selectorValue, operationId) {
    const state = this._validateParentLease(lease, this.context.getCurrentLease());
    const normalized = normalizeSelector(selectorValue);
    if (!state || state.record.mutation !== state.reservation || state.operationId !== assertOperationId(operationId) ||
        !normalized.instance || normalized.instance.key !== state.record.instanceKey ||
        !normalized.serverPath || normalized.serverPath.key !== state.record.pathKey) throw invalidRequest();
    return true;
  }

  runRecoveryMutation(selectorValue, optionsValue, work) {
    try {
      if (typeof work !== 'function') throw invalidRequest();
      if (this.context.getCurrentLease()) throw invalidRequest();
      const normalized = normalizeSelector(selectorValue);
      const options = normalizeRecoveryMutationOptions(optionsValue);
      const record = this._findRecord(normalized);
      if (!record || !record.recoveryBlock || record.recoveryBlock.operationId !== options.operationId) {
        throw recoveryRequired(record?.recoveryBlock?.operationId);
      }
      if (record.revisionFailure && record.revisionFailure.operationId !== options.operationId) {
        throw recoveryRequired(record.revisionFailure.operationId);
      }
      const busy = this._activeOperationId(record);
      if (busy) throw operationInProgress(busy);
      if (record.start) throw operationInProgress(record.start.operationId);

      const reservation = {
        active: true,
        holder: HOLDER_LIFECYCLE,
        leases: [],
        many: false,
        operation: options.operation,
        operationId: options.operationId,
        options,
        records: [record],
        recoveryMutation: true,
        recoveryOperationId: options.operationId,
        startupRecovery: this.recoveryOpen,
        workSettled: false
      };
      record.mutation = reservation;
      return this._executeMutation(reservation, work);
    } catch (error) {
      return Promise.reject(error instanceof ModpackError ? error : invalidRequest(error));
    }
  }

  acquireStart(selectorValue, optionsValue) {
    try {
      const normalized = normalizeSelector(selectorValue);
      const options = normalizeStartOptions(optionsValue);
      const currentLease = this.context.getCurrentLease();
      const ambient = this._liveAmbientLease();
      // Callers pass their ambient lease as the parent (the server manager
      // does). A released start or ordinary ambient lease is no parent, so an
      // auto-restart from a server's exit handler is a plain start.
      const parentLease = !ambient && currentLease && options.parentMutationLease !== null &&
        (options.parentMutationLease === currentLease ||
          this.groupStates.get(currentLease)?.members.has(options.parentMutationLease))
        ? null
        : options.parentMutationLease;
      const parentState = this._validateParentLease(parentLease, ambient);
      if (ambient && !parentState) throw invalidRequest();
      const recoveryParent = Boolean(parentState?.reservation?.recoveryMutation);
      if (this.globalRecoveryBlock && !recoveryParent) throw recoveryRequired();

      const { ownedRoot, record } = parentState
        ? this._resolveNestedStartRecord(normalized, parentState)
        : { ownedRoot: null, record: this._resolveRecord(normalized) };
      if (recoveryParent) {
        if (parentState.reservation.recoveryOperationId !== parentState.operationId ||
            !record.recoveryBlock || record.recoveryBlock.operationId !== parentState.operationId) {
          throw recoveryRequired(record.recoveryBlock?.operationId);
        }
      } else {
        this._assertAvailable(record);
      }
      // A plain start may share a folder with shared ordinary writers, never
      // with an exclusive holder.
      if (record.mutation && (!parentState || !parentState.records.includes(record))) {
        throw operationInProgress(record.mutation.operationId);
      }
      if (parentState && (!record.mutation || record.mutation !== parentState.reservation)) {
        throw invalidRequest();
      }
      if (record.start) throw operationInProgress(record.start.operationId);

      const release = createReleasePromise();
      const state = {
        active: true,
        baseRevision: null,
        dirty: false,
        kind: 'start',
        lease: null,
        nestedParentState: parentState,
        operation: options.operation,
        operationId: options.operationId,
        ownedRoot: ownedRoot || record,
        pid: null,
        record,
        release,
        revisionAttempted: false,
        revisionFinalized: false,
        running: false
      };
      record.start = state;

      try {
        state.baseRevision = parentState
          ? parentState.baseRevision
          : this._readLeaseRevision(record, options.operationId);
        state.lease = this._createStartLease(state);
        this.leaseStates.set(state.lease, state);
        return Promise.resolve(state.lease);
      } catch (error) {
        record.start = null;
        state.active = false;
        release.resolve();
        if (!(error instanceof ModpackError && error.code === 'INVALID_REQUEST')) {
          this._markRevisionFailure(record, options.operationId);
        }
        return Promise.reject(error instanceof ModpackError ? error : commitFailure(error));
      }
    } catch (error) {
      return Promise.reject(error instanceof ModpackError ? error : invalidRequest(error));
    }
  }

  _startMutationRun(selectorValues, optionsValue, work, many) {
    try {
      if (typeof work !== 'function') throw invalidRequest();
      if (this._liveAmbientLease()) throw invalidRequest();
      const options = normalizeMutationOptions(optionsValue);
      const normalizedSelectors = selectorValues.map(normalizeSelector);
      return this._attemptAdmission({
        deadline: options.ordinary ? Date.now() + this.ordinaryWaitTimeoutMs : 0,
        holder: holderFor(options, many),
        many,
        normalizedSelectors,
        options,
        queuedRecords: [],
        ticket: null,
        work
      });
    } catch (error) {
      return Promise.reject(error instanceof ModpackError ? error : invalidRequest(error));
    }
  }

  // Admission re-runs from scratch over every selector after each wait, and a
  // waiter holds nothing while it waits, so waits cannot deadlock.
  _attemptAdmission(admission) {
    let outcome;
    try {
      this._removeWaiterEntries(admission);
      outcome = this._tryReserve(admission);
    } catch (error) {
      this._leaveWaitQueue(admission);
      return Promise.reject(error instanceof ModpackError ? error : invalidRequest(error));
    }
    if (outcome.reservation) return this._executeMutation(outcome.reservation, admission.work);
    if (Date.now() >= admission.deadline) {
      this._leaveWaitQueue(admission);
      return Promise.reject(operationInProgress(outcome.blockingOperationId));
    }
    return waitForAdmissionChange(this.admissionChange.promise, admission.deadline, admission.options.signal).then(
      () => this._attemptAdmission(admission),
      error => {
        this._leaveWaitQueue(admission);
        throw error;
      }
    );
  }

  _tryReserve(admission) {
    const { holder, options } = admission;
    if (this.globalRecoveryBlock) throw recoveryRequired();
    const records = [];
    const seen = new Set();
    for (const normalized of admission.normalizedSelectors) {
      const record = this._resolveRecord(normalized);
      if (!seen.has(record)) {
        seen.add(record);
        records.push(record);
      }
    }
    records.sort((left, right) => this._recordSortKey(left).localeCompare(this._recordSortKey(right), 'en-US'));

    for (const record of records) {
      this._assertAvailable(record);
      if (holder === HOLDER_LIFECYCLE) {
        const busy = this._activeOperationId(record);
        if (busy) throw operationInProgress(busy);
        if (record.start && !record.start.running) throw operationInProgress(record.start.operationId);
        if (record.start?.running && !options.quiesce) throw serverRunning(record.instanceId);
      } else {
        // Ordinary writers never wait for lifecycle or recovery work.
        if (record.mutation?.holder === HOLDER_LIFECYCLE) throw operationInProgress(record.mutation.operationId);
        if (options.stoppedOnly && record.start) {
          if (!record.start.running) throw operationInProgress(record.start.operationId);
          throw serverRunning(record.instanceId);
        }
      }
    }

    if (holder === HOLDER_LIFECYCLE) {
      if (options.revisionMode === 'lifecycle') this._consumeLifecycleFences(records, options.operationId);
    } else {
      const blockingOperationId = this._ordinaryBlocker(records, admission);
      if (blockingOperationId) {
        this._enqueueWaiter(admission, records);
        return { blockingOperationId };
      }
    }

    const reservation = {
      active: true,
      holder,
      leases: [],
      many: admission.many,
      operation: options.operation,
      operationId: options.operationId,
      options,
      records,
      recoveryMutation: false,
      recoveryOperationId: null,
      startupRecovery: false,
      workSettled: false
    };
    for (const record of records) {
      if (holder === HOLDER_ORDINARY_SHARED) record.shared.add(reservation);
      else record.mutation = reservation;
      record.newServerOperationId = NEW_SERVER_OPERATIONS.has(options.operation) ? options.operationId : null;
    }
    return { reservation };
  }

  // The operation an ordinary admission must wait for, or null. Shared writers
  // wait for an exclusive ordinary holder and for earlier exclusive waiters;
  // exclusive ones wait for every holder and every earlier waiter (FIFO).
  _ordinaryBlocker(records, { holder, ticket }) {
    const exclusive = holder === HOLDER_ORDINARY_EXCLUSIVE;
    for (const record of records) {
      if (record.mutation) return record.mutation.operationId;
      const shared = record.shared.values().next().value;
      if (exclusive && shared) return shared.operationId;
      for (const waiter of record.waiters) {
        if (ticket !== null && waiter.ticket > ticket) break;
        if (exclusive || waiter.holder === HOLDER_ORDINARY_EXCLUSIVE) return waiter.operationId;
      }
    }
    return null;
  }

  _enqueueWaiter(admission, records) {
    if (admission.ticket === null) admission.ticket = ++this.waitTickets;
    const entry = Object.freeze({
      admission,
      holder: admission.holder,
      operationId: admission.options.operationId,
      ticket: admission.ticket
    });
    for (const record of records) {
      const index = record.waiters.findIndex(waiter => waiter.ticket > entry.ticket);
      if (index === -1) record.waiters.push(entry);
      else record.waiters.splice(index, 0, entry);
    }
    admission.queuedRecords = records;
  }

  _removeWaiterEntries(admission) {
    for (const record of admission.queuedRecords) {
      const index = record.waiters.findIndex(waiter => waiter.admission === admission);
      if (index !== -1) record.waiters.splice(index, 1);
    }
    admission.queuedRecords = [];
  }

  _leaveWaitQueue(admission) {
    this._removeWaiterEntries(admission);
    if (admission.ticket === null) return;
    admission.ticket = null;
    this._notifyAdmissionChange();
  }

  _notifyAdmissionChange() {
    const changed = this.admissionChange;
    this.admissionChange = createReleasePromise();
    changed.resolve();
  }

  // A lifecycle admission on a fenced record re-arms plan staleness: one repair
  // bump through the record's own writer, then PLAN_STALE either way, so every
  // plan reviewed before the unrecorded change is reviewed again.
  _consumeLifecycleFences(records, operationId) {
    const fenced = records.filter(record => record.lifecycleFence);
    if (fenced.length === 0) return;
    for (const record of fenced) this._repairFencedRevision(record, operationId);
    throw fencedRevision();
  }

  _repairFencedRevision(record, operationId) {
    let base;
    let next;
    try {
      base = assertSafeRevision(this.readContentRevision(record.serverPath));
      if (base >= Number.MAX_SAFE_INTEGER) return false;
      next = this._bumpRevision(record, base, operationId);
    } catch {
      return false; // The fence stays; a failed repair never quarantines.
    }
    if (next !== base + 1) return false;
    record.lifecycleFence = null;
    this._afterRevisionPublished(record, base, next, null);
    record.highestRevision = next;
    return true;
  }

  async _executeMutation(reservation, work) {
    let workError = null;
    let workResult;
    let revisionError = null;
    const { options, records } = reservation;

    try {
      if (options.signal?.aborted) throw cancelled();
      if (options.quiesce) {
        try {
          await options.quiesce(Object.freeze({
            operation: options.operation,
            operationId: options.operationId,
            selectors: Object.freeze(records.map(record => Object.freeze({
              instanceId: record.instanceId,
              serverPath: record.serverPath
            }))),
            signal: options.signal || null
          }));
        } catch (error) {
          if (options.signal?.aborted) throw cancelled();
          throw error;
        }
      }
      if (options.signal?.aborted) throw cancelled();
      for (const record of records) {
        if (record.start && !overlapsStart(options)) await waitForAbortable(record.start.release.promise, options.signal);
      }
      if (options.signal?.aborted) throw cancelled();

      reservation.leases = records.map(record => this._createMutationLease(reservation, record));
      const callbackLease = reservation.many
        ? this._createMutationGroupLease(reservation)
        : reservation.leases[0];
      const callbackValue = reservation.many
        ? Object.freeze([...reservation.leases])
        : reservation.leases[0];
      workResult = await this.context.runWithLease(callbackLease, () => work(callbackValue));
      if (options.signal?.aborted) throw cancelled();
      if (reservation.recoveryMutation && !reservation.startupRecovery && workResult?.resolved === true) {
        for (const record of records) {
          if (record.recoveryBlock?.operationId !== reservation.recoveryOperationId) {
            throw recoveryRequired(record.recoveryBlock?.operationId);
          }
          if (record.revisionFailure && record.revisionFailure.operationId !== reservation.recoveryOperationId) {
            throw recoveryRequired(record.revisionFailure.operationId);
          }
          record.recoveryBlock = null;
          record.revisionFailure = null;
          record.resolvedRecoveryOperationId = reservation.operationId;
        }
      }
    } catch (error) {
      workError = error;
    } finally {
      reservation.workSettled = true;
      try {
        this._finalizeMutationRevisions(reservation, workError);
      } catch (error) {
        revisionError = error;
      } finally {
        this._releaseMutationReservation(reservation);
      }
    }

    if (revisionError) throw revisionError;
    if (workError) throw workError;
    return workResult;
  }

  _createMutationLease(reservation, record) {
    const state = {
      active: true,
      baseRevision: null,
      dirty: false,
      kind: 'mutation',
      lease: null,
      operation: reservation.operation,
      operationId: reservation.operationId,
      record,
      records: [record],
      reservation,
      startupRecovery: reservation.startupRecovery
    };
    state.baseRevision = reservation.recoveryMutation
      ? null
      : this._readLeaseRevision(record, reservation.operationId);
    const lease = Object.freeze({
      kind: 'mutation',
      operation: state.operation,
      operationId: state.operationId,
      instanceId: record.instanceId,
      serverPath: record.serverPath,
      // An ordinary writer's base follows revisions the coordinator publishes
      // for other leases on the same folder.
      get baseRevision() {
        return state.baseRevision;
      },
      assertOwnedPath: candidate => canonicalPathWithin(record, candidate),
      markDirty: () => {
        if (!state.active) throw invalidRequest();
        state.dirty = true;
        return true;
      },
      release: () => {
        if (!state.active || !reservation.workSettled) return false;
        return this._releaseMutationReservation(reservation);
      }
    });
    state.lease = lease;
    this.leaseStates.set(lease, state);
    return lease;
  }

  _createMutationGroupLease(reservation) {
    const group = Object.freeze({
      kind: 'mutation-group',
      operation: reservation.operation,
      operationId: reservation.operationId,
      assertOwnedPath: candidate => {
        let lastError = null;
        for (const lease of reservation.leases) {
          try {
            return lease.assertOwnedPath(candidate);
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || invalidRequest();
      },
      markDirtyPath: candidate => {
        let lastError = null;
        for (const lease of reservation.leases) {
          try {
            lease.assertOwnedPath(candidate);
            lease.markDirty();
            return true;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || invalidRequest();
      },
      markDirty: () => {
        throw invalidRequest();
      },
      release: () => {
        if (!reservation.workSettled) return false;
        return this._releaseMutationReservation(reservation);
      }
    });
    this.groupStates.set(group, { members: new Set(reservation.leases), reservation });
    return group;
  }

  _finalizeMutationRevisions(reservation, workError) {
    let firstError = null;
    const { options } = reservation;
    for (const lease of reservation.leases) {
      const state = this.leaseStates.get(lease);
      if (!state) continue;
      try {
        if (state.dirty && publicationRequiresRecovery(workError)) {
          this._markRevisionFailure(state.record, state.operationId);
        } else if (options.revisionMode === 'auto' && state.dirty) {
          const previous = state.baseRevision;
          const next = this._bumpRevision(state.record, previous, state.operationId);
          if (next !== previous + 1) throw commitFailure();
          this._afterRevisionPublished(state.record, previous, next, state);
        } else if (options.revisionMode === 'lifecycle' && (!workError || state.dirty)) {
          const current = this._readRevision(state.record, state.operationId);
          // Lifecycle publication owns the revision increment. A failed
          // operation that leaves the exact base revision intact never
          // published, even if candidate cleanup or policy restoration marked
          // the lease dirty. Preserve that primary failure; publication-phase
          // failures were quarantined above before reaching this branch.
          if (workError && current === state.baseRevision) continue;
          if (state.baseRevision >= Number.MAX_SAFE_INTEGER || current !== state.baseRevision + 1) {
            throw staleRevision();
          }
          this._raiseHighestRevision(state.record, current);
        }
      } catch (error) {
        if (options.ordinary && options.revisionMode === 'auto' && isPrePublicationFailure(error)) {
          // Nothing was written: the writer's change stands and only the
          // change counter lags, so only modpack lifecycle work is fenced.
          this._setLifecycleFence(state.record, state.operationId, 'revision-not-recorded');
          continue;
        }
        this._markRevisionFailure(state.record, state.operationId);
        if (!firstError) firstError = error instanceof ModpackError ? error : commitFailure(error);
      }
    }
    if (firstError) throw firstError;
  }

  // The coordinator owns each folder's revision chain. When it publishes N to
  // N+1 for one lease, every other live ordinary or start lease on that folder
  // based on N moves to N+1 instead of failing its own compare-and-set later.
  // A lease based on anything else saw a genuine external change.
  _afterRevisionPublished(record, previous, next, publisher) {
    const start = record.start;
    if (start && start !== publisher && start.active && !start.nestedParentState &&
        !start.revisionFinalized && start.baseRevision === previous) {
      start.baseRevision = next;
    }
    const reservations = record.mutation ? [record.mutation, ...record.shared] : [...record.shared];
    for (const reservation of reservations) {
      if (!reservation.active || !reservation.options.ordinary) continue;
      for (const lease of reservation.leases) {
        const state = this.leaseStates.get(lease);
        if (state && state !== publisher && state.active && state.record === record && state.baseRevision === previous) {
          state.baseRevision = next;
        }
      }
    }
    this._raiseHighestRevision(record, next);
  }

  _releaseMutationReservation(reservation) {
    if (!reservation.active) return false;
    reservation.active = false;
    for (const lease of reservation.leases) {
      const state = this.leaseStates.get(lease);
      if (state) state.active = false;
    }
    for (const record of reservation.records) {
      if (record.mutation === reservation) record.mutation = null;
      record.shared.delete(reservation);
    }
    try {
      for (const record of reservation.records) {
        if (record.retirementOperationId !== reservation.operationId) continue;
        if (reservation.options.ordinary) this._retireReleasedRegistration(record);
        else this._retireAbandonedRecord(record);
      }
    } finally {
      this._notifyAdmissionChange();
    }
    return true;
  }

  _createStartLease(state) {
    const { ownedRoot, record } = state;
    const lease = Object.freeze({
      kind: 'start',
      operation: state.operation,
      operationId: state.operationId,
      instanceId: record.instanceId,
      serverPath: ownedRoot.serverPath,
      get baseRevision() {
        return state.baseRevision;
      },
      assertOwnedPath: candidate => canonicalPathWithin(ownedRoot, candidate),
      markDirty: () => {
        if (!state.active) throw invalidRequest();
        if (state.nestedParentState) {
          state.nestedParentState.lease.markDirty();
        } else {
          state.dirty = true;
        }
        return true;
      },
      markRunning: value => {
        assertExactKeys(value, new Set(['pid']));
        const pid = value.pid;
        if (!Number.isSafeInteger(pid) || pid <= 0) throw invalidRequest();
        if (!state.active) throw invalidRequest();
        if (state.running) {
          if (state.pid !== pid) throw invalidRequest();
          return lease;
        }
        try {
          if (!state.nestedParentState) this._finalizeStartRevision(state);
        } catch (error) {
          this._releaseStartState(state, { skipRevision: true });
          throw error;
        }
        state.running = true;
        state.pid = pid;
        return lease;
      },
      release: () => this._releaseStartState(state)
    });
    return lease;
  }

  _finalizeStartRevision(state) {
    if (state.revisionFinalized || !state.dirty) return;
    if (state.revisionAttempted) throw commitFailure();
    state.revisionAttempted = true;
    try {
      const previous = state.baseRevision;
      const next = this._bumpRevision(state.record, previous, state.operationId);
      if (next !== previous + 1) throw commitFailure();
      state.revisionFinalized = true;
      this._afterRevisionPublished(state.record, previous, next, state);
    } catch (error) {
      if (isPrePublicationFailure(error)) {
        // Refused before anything was written: the server keeps running as in
        // v26.6.1, and only modpack lifecycle work is fenced.
        this._setLifecycleFence(state.record, state.operationId, 'revision-not-recorded');
        state.revisionFinalized = true;
        return;
      }
      this._markRevisionFailure(state.record, state.operationId);
      throw error instanceof ModpackError ? error : commitFailure(error);
    }
  }

  _releaseStartState(state, { skipRevision = false } = {}) {
    if (!state.active) return false;
    let revisionError = null;
    try {
      if (!skipRevision && !state.nestedParentState) this._finalizeStartRevision(state);
    } catch (error) {
      revisionError = error;
    } finally {
      state.active = false;
      if (state.record.start === state) state.record.start = null;
      state.release.resolve();
    }
    if (revisionError) throw revisionError;
    return true;
  }

  // A released lease can stay in AsyncLocalStorage for callbacks registered
  // while it was live (a server's exit handler, timers). A released start or
  // ordinary lease holds and grants nothing, so it is no enclosing lease. A
  // released lifecycle or recovery lease still is: late validation boots and
  // lifecycle callbacks stay fail-closed.
  _liveAmbientLease() {
    const ambient = this.context.getCurrentLease();
    if (!ambient) return null;
    const state = this.leaseStates.get(ambient);
    if (state) {
      const ignorable = !state.active && (state.kind === 'start' || state.reservation.options.ordinary === true);
      return ignorable ? null : ambient;
    }
    const group = this.groupStates.get(ambient);
    if (group && !group.reservation.active && group.reservation.options.ordinary === true) return null;
    return ambient; // Unknown lease shapes stay fail-closed.
  }

  _validateParentLease(parentLease, ambient) {
    if (parentLease === null) return null;
    const state = this.leaseStates.get(parentLease);
    // Only a live lifecycle or recovery reservation can parent a nested start.
    if (!state || state.kind !== 'mutation' || !state.active || !state.reservation.active ||
        state.reservation.holder !== HOLDER_LIFECYCLE) throw invalidRequest();
    const ambientMatches = ambient === parentLease || this.groupStates.get(ambient)?.members.has(parentLease);
    if (!ambientMatches) throw invalidRequest();
    return state;
  }

  _resolveNestedStartRecord(normalized, parentState) {
    const record = parentState.record;
    if (normalized.instance && normalized.instance.key !== record.instanceKey) throw invalidRequest();
    if (!normalized.serverPath) return { ownedRoot: record, record };
    if (normalized.serverPath.key === record.pathKey) return { ownedRoot: record, record };
    if (!normalized.instance || !record.instanceKey) throw invalidRequest();
    return {
      ownedRoot: {
        pathFlavor: normalized.serverPath.flavor,
        pathKey: normalized.serverPath.key,
        serverPath: normalized.serverPath.canonical
      },
      record
    };
  }

  _readRevision(record, operationId) {
    if (!record.serverPath) throw invalidRequest();
    try {
      const result = this.readContentRevision(record.serverPath);
      if (result && typeof result.then === 'function') throw new TypeError('Revision reads must be synchronous');
      return assertSafeRevision(result);
    } catch (error) {
      this._markRevisionFailure(record, operationId);
      throw error instanceof ModpackError ? error : commitFailure(error);
    }
  }

  // Lease bases are read here. A value below the highest revision this folder
  // has shown means its counter went backwards (a restored or replaced config),
  // so plans reviewed before can no longer be trusted.
  _readLeaseRevision(record, operationId) {
    const revision = this._readRevision(record, operationId);
    if (record.highestRevision !== null && revision < record.highestRevision) {
      this._setLifecycleFence(record, operationId, 'revision-rolled-back');
    }
    this._raiseHighestRevision(record, revision);
    return revision;
  }

  _raiseHighestRevision(record, revision) {
    if (record.highestRevision === null || revision > record.highestRevision) record.highestRevision = revision;
  }

  // Ordinary writers and plain starts ignore the fence; only an admission with
  // revisionMode 'lifecycle' consumes it.
  _setLifecycleFence(record, operationId, reason) {
    if (!record.lifecycleFence) record.lifecycleFence = Object.freeze({ operationId, reason });
  }

  _bumpRevision(record, expectedRevision, operationId) {
    if (!record.serverPath) throw invalidRequest();
    let capability;
    try {
      capability = this.durableFsFactory
        ? this.durableFsFactory([record.serverPath])
        : this.durableFs;
    } catch (error) {
      throw prePublicationFailure(error); // The writer was refused before any I/O.
    }
    try {
      const result = this.bumpContentRevision(record.serverPath, {
        expectedRevision,
        operationId,
        durableFs: capability
      });
      if (result && typeof result.then === 'function') throw new TypeError('Revision writes must be synchronous');
      return assertSafeRevision(result);
    } catch (error) {
      if (isLegacyInstanceConfigFs(capability)) throw advisoryFailure(error);
      throw strictRevisionFailure(error);
    }
  }

  _markRevisionFailure(record, operationId) {
    record.revisionFailure = Object.freeze({ operationId });
  }

  _assertAvailable(record) {
    if (this.globalRecoveryBlock) throw recoveryRequired();
    const block = record.recoveryBlock || record.revisionFailure;
    if (block) throw recoveryRequired(block.operationId);
  }

  // The first exclusive holder, shared holder or waiting writer on a record.
  _activeOperationId(record) {
    return record.mutation?.operationId || this._ordinaryClaimOperationId(record);
  }

  _ordinaryClaimOperationId(record) {
    return record.shared.values().next().value?.operationId || record.waiters[0]?.operationId || null;
  }

  _isIdle(record) {
    return !record.mutation && record.shared.size === 0 && record.waiters.length === 0 && !record.start;
  }

  _recordSortKey(record) {
    return record.pathKey ? `p:${record.pathKey}` : `i:${record.instanceKey}`;
  }

  _newRecord() {
    const record = {
      highestRevision: null,
      instanceId: null,
      instanceKey: null,
      lifecycleFence: null,
      mutation: null,
      newServerOperationId: null,
      pathFlavor: null,
      pathKey: null,
      recoveryBlock: null,
      resolvedRecoveryOperationId: null,
      revisionFailure: null,
      retirementOperationId: null,
      serverPath: null,
      shared: new Set(),
      start: null,
      waiters: []
    };
    this.records.add(record);
    return record;
  }

  _findRecord(normalized) {
    const byInstance = normalized.instance ? this.instanceAliases.get(normalized.instance.key) : null;
    const byPath = normalized.serverPath ? this.pathAliases.get(normalized.serverPath.key) : null;
    if (byInstance && byPath && byInstance !== byPath) aliasConflict(byPath, byInstance);
    return byInstance || byPath || null;
  }

  _resolveRecord(normalized, { allowIncomplete = false } = {}) {
    const byInstance = normalized.instance ? this.instanceAliases.get(normalized.instance.key) : null;
    const byPath = normalized.serverPath ? this.pathAliases.get(normalized.serverPath.key) : null;
    if (byInstance && byPath && byInstance !== byPath) aliasConflict(byPath, byInstance);
    let record = byInstance || byPath;
    if (!record) {
      if (!normalized.serverPath && !allowIncomplete) throw invalidRequest();
      record = this._newRecord();
    }

    if (normalized.instance) {
      if (record.instanceKey && record.instanceKey !== normalized.instance.key) aliasConflict(record);
      if (!record.instanceKey) {
        record.instanceId = normalized.instance.display;
        record.instanceKey = normalized.instance.key;
        this.instanceAliases.set(record.instanceKey, record);
      }
    }
    if (normalized.serverPath) {
      if (record.pathKey && record.pathKey !== normalized.serverPath.key) aliasConflict(record);
      if (!record.pathKey) {
        record.serverPath = normalized.serverPath.canonical;
        record.pathKey = normalized.serverPath.key;
        record.pathFlavor = normalized.serverPath.flavor;
        this.pathAliases.set(record.pathKey, record);
        const retiredFence = this.retiredPathFences.get(record.pathKey);
        if (retiredFence) {
          this.retiredPathFences.delete(record.pathKey);
          if (!record.lifecycleFence) record.lifecycleFence = retiredFence;
        }
      }
    }
    if (!record.serverPath && !allowIncomplete) throw invalidRequest();
    return record;
  }
}

module.exports = {
  DEFAULT_ORDINARY_WAIT_TIMEOUT_MS,
  ServerMutationCoordinator,
  coordinatorInstanceKey,
  coordinatorPathKey
};
