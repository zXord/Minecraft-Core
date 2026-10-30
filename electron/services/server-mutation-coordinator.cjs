const path = require('node:path');

const { ModpackError } = require('./modpacks/errors.cjs');
const revisionApi = require('./server-content-revision.cjs');
const durableFs = require('../utils/durable-fs.cjs');
const {
  sharedServerMutationContext
} = require('./server-mutation-context.cjs');

const OPERATION_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const INSTANCE_ID_MAX_LENGTH = 512;
const SELECTOR_KEYS = new Set(['instanceId', 'serverPath']);
const MUTATION_OPTION_KEYS = new Set([
  'operation', 'operationId', 'quiesce', 'revisionMode', 'signal'
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

function staleRevision() {
  return new ModpackError('PLAN_STALE', 'The server content revision changed during the operation');
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

function normalizeServerPath(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw invalidRequest();

  const input = value.normalize('NFC');
  if (input.split(/[\\/]/u).some(segment => segment === '.' || segment === '..')) throw invalidRequest();
  const windowsShaped = path.win32.isAbsolute(input);
  let canonical;
  let flavor;

  if (windowsShaped) {
    const slashed = input.replace(/\//g, '\\');
    if (/^\\\\[?.]\\/.test(slashed)) throw invalidRequest();
    canonical = upperCaseDrive(path.win32.normalize(slashed));
    const root = upperCaseDrive(path.win32.parse(canonical).root);
    while (canonical.length > root.length && canonical.endsWith('\\')) canonical = canonical.slice(0, -1);
    if (canonical.toLocaleLowerCase('en-US') === root.toLocaleLowerCase('en-US')) throw invalidRequest();
    flavor = 'win32';
  } else {
    if (!path.isAbsolute(input)) throw invalidRequest();
    canonical = path.resolve(input).normalize('NFC');
    if (canonical === path.parse(canonical).root) throw invalidRequest();
    flavor = 'native';
  }

  return {
    canonical,
    flavor,
    key: canonical.toLocaleLowerCase('en-US')
  };
}

function normalizeSelector(value) {
  assertExactKeys(value, SELECTOR_KEYS);
  const instance = normalizeInstanceId(value.instanceId);
  const serverPath = normalizeServerPath(value.serverPath);
  if (!instance && !serverPath) throw invalidRequest();
  return { instance, serverPath };
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
  return Object.freeze({
    operation,
    operationId,
    quiesce: value.quiesce || null,
    revisionMode: value.revisionMode,
    signal: value.signal || null
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
    quiesce: null,
    revisionMode: 'none',
    signal: value.signal || null
  });
}

function normalizeRecoveryCompletionOptions(value = {}) {
  assertExactKeys(value, RECOVERY_COMPLETION_OPTION_KEYS);
  if (value.globalBlock !== undefined && typeof value.globalBlock !== 'boolean') throw invalidRequest();
  return Object.freeze({ globalBlock: value.globalBlock === true });
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

class ServerMutationCoordinator {
  constructor(options = {}) {
    assertExactKeys(options, new Set([
      'bumpContentRevision', 'context', 'durableFs', 'durableFsFactory', 'readContentRevision'
    ]));
    if (options.durableFs !== undefined && options.durableFsFactory !== undefined) throw invalidRequest();
    if (options.durableFsFactory !== undefined && typeof options.durableFsFactory !== 'function') throw invalidRequest();
    this.context = options.context || sharedServerMutationContext;
    this.readContentRevision = options.readContentRevision || revisionApi.readContentRevision;
    this.bumpContentRevision = options.bumpContentRevision || revisionApi.bumpContentRevision;
    this.durableFs = options.durableFs || (options.durableFsFactory ? null : durableFs);
    this.durableFsFactory = options.durableFsFactory || null;
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
    if (!state || !state.active || state.record.mutation?.active !== true || lease.kind !== 'mutation') throw invalidRequest();
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
    if (record.mutation || record.start) throw operationInProgress(record.mutation?.operationId || record.start.operationId);
    if (record.instanceKey === normalized.instance.key || record.newServerOperationId === operationId) throw invalidRequest();
    return true;
  }

  _retireAbandonedRecord(record) {
    if (!record.retirementOperationId || record.mutation || record.start || record.recoveryBlock || record.revisionFailure) return false;
    if (this.instanceAliases.get(record.instanceKey) !== record || this.pathAliases.get(record.pathKey) !== record) throw invalidRequest();
    this.instanceAliases.delete(record.instanceKey);
    this.pathAliases.delete(record.pathKey);
    this.records.delete(record);
    return true;
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
      if (record.mutation) throw operationInProgress(record.mutation.operationId);
      if (record.start) throw operationInProgress(record.start.operationId);

      const reservation = {
        active: true,
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
      const ambient = this.context.getCurrentLease();
      const parentState = this._validateParentLease(options.parentMutationLease, ambient);
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
          : this._readRevision(record, options.operationId);
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
      if (this.context.getCurrentLease()) throw invalidRequest();
      const options = normalizeMutationOptions(optionsValue);
      const normalizedSelectors = selectorValues.map(normalizeSelector);
      if (this.globalRecoveryBlock) throw recoveryRequired();
      const records = [];
      const seen = new Set();
      for (const normalized of normalizedSelectors) {
        const record = this._resolveRecord(normalized);
        if (!seen.has(record)) {
          seen.add(record);
          records.push(record);
        }
      }
      records.sort((left, right) => this._recordSortKey(left).localeCompare(this._recordSortKey(right), 'en-US'));

      for (const record of records) {
        this._assertAvailable(record);
        if (record.mutation) throw operationInProgress(record.mutation.operationId);
        if (record.start && !record.start.running) throw operationInProgress(record.start.operationId);
        if (record.start?.running && !options.quiesce) throw serverRunning(record.instanceId);
      }

      const reservation = {
        active: true,
        leases: [],
        many,
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
        record.mutation = reservation;
        record.newServerOperationId = ['install-new', 'import-files-only-new'].includes(options.operation) ? options.operationId : null;
      }
      return this._executeMutation(reservation, work);
    } catch (error) {
      return Promise.reject(error instanceof ModpackError ? error : invalidRequest(error));
    }
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
        if (record.start) await waitForAbortable(record.start.release.promise, options.signal);
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
    const baseRevision = reservation.recoveryMutation
      ? null
      : this._readRevision(record, reservation.operationId);
    const state = {
      active: true,
      baseRevision,
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
    const lease = Object.freeze({
      kind: 'mutation',
      operation: state.operation,
      operationId: state.operationId,
      instanceId: record.instanceId,
      serverPath: record.serverPath,
      baseRevision,
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
    this.groupStates.set(group, new Set(reservation.leases));
    return group;
  }

  _finalizeMutationRevisions(reservation, workError) {
    let firstError = null;
    for (const lease of reservation.leases) {
      const state = this.leaseStates.get(lease);
      if (!state) continue;
      try {
        if (state.dirty && publicationRequiresRecovery(workError)) {
          this._markRevisionFailure(state.record, state.operationId);
        } else if (reservation.options.revisionMode === 'auto' && state.dirty) {
          const next = this._bumpRevision(state.record, state.baseRevision, state.operationId);
          if (next !== state.baseRevision + 1) throw commitFailure();
        } else if (reservation.options.revisionMode === 'lifecycle' && (!workError || state.dirty)) {
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
        }
      } catch (error) {
        this._markRevisionFailure(state.record, state.operationId);
        if (!firstError) firstError = error instanceof ModpackError ? error : commitFailure(error);
      }
    }
    if (firstError) throw firstError;
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
      if (record.retirementOperationId === reservation.operationId) this._retireAbandonedRecord(record);
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
      baseRevision: state.baseRevision,
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
      const next = this._bumpRevision(state.record, state.baseRevision, state.operationId);
      if (next !== state.baseRevision + 1) throw commitFailure();
      state.revisionFinalized = true;
    } catch (error) {
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

  _validateParentLease(parentLease, ambient) {
    if (parentLease === null) return null;
    const state = this.leaseStates.get(parentLease);
    if (!state || state.kind !== 'mutation' || !state.active || !state.reservation.active) throw invalidRequest();
    const ambientMatches = ambient === parentLease || this.groupStates.get(ambient)?.has(parentLease);
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

  _bumpRevision(record, expectedRevision, operationId) {
    if (!record.serverPath) throw invalidRequest();
    try {
      const revisionDurableFs = this.durableFsFactory
        ? this.durableFsFactory([record.serverPath])
        : this.durableFs;
      const result = this.bumpContentRevision(record.serverPath, {
        expectedRevision,
        operationId,
        durableFs: revisionDurableFs
      });
      if (result && typeof result.then === 'function') throw new TypeError('Revision writes must be synchronous');
      return assertSafeRevision(result);
    } catch (error) {
      throw commitFailure(error);
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

  _recordSortKey(record) {
    return record.pathKey ? `p:${record.pathKey}` : `i:${record.instanceKey}`;
  }

  _newRecord() {
    const record = {
      instanceId: null,
      instanceKey: null,
      mutation: null,
      newServerOperationId: null,
      pathFlavor: null,
      pathKey: null,
      recoveryBlock: null,
      resolvedRecoveryOperationId: null,
      revisionFailure: null,
      retirementOperationId: null,
      serverPath: null,
      start: null
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
      }
    }
    if (!record.serverPath && !allowIncomplete) throw invalidRequest();
    return record;
  }
}

module.exports = {
  ServerMutationCoordinator
};
