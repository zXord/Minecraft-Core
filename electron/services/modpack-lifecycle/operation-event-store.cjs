const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The modpack operation event store is invalid', { cause });
}

function safeTransition(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.jobId !== 'string' || typeof record.operationKind !== 'string' ||
      typeof record.serverId !== 'string' || typeof record.phase !== 'string' ||
      !Number.isSafeInteger(record.sequence) || typeof record.cancellationRequested !== 'boolean') throw invalid();
  return deepFreeze({
    channel: 'progress',
    jobId: record.jobId,
    operationKind: record.operationKind,
    serverId: record.serverId,
    sequence: record.sequence,
    phase: record.phase,
    progress: record.progress,
    cancellationRequested: record.cancellationRequested,
    terminal: record.terminalAt !== null,
    outcome: record.outcome
  });
}

class OperationEventStore {
  constructor({ operationStore, nativeNotificationBridge } = {}) {
    const methods = ['initialize', 'create', 'get', 'load', 'transition', 'requestCancellation', 'appendEvent'];
    if (!operationStore || methods.some(method => typeof operationStore[method] !== 'function') ||
        !nativeNotificationBridge || typeof nativeNotificationBridge.publishJobEvent !== 'function') throw invalid();
    this.operationStore = operationStore;
    this.nativeNotificationBridge = nativeNotificationBridge;
  }

  initialize() { return this.operationStore.initialize(); }
  get(jobId) { return this.operationStore.get(jobId); }
  load(jobId) { return this.operationStore.load(jobId); }

  async create(request) {
    return this.#publish(await this.operationStore.create(request));
  }

  async transition(jobId, request) {
    return this.#publish(await this.operationStore.transition(jobId, request));
  }

  async requestCancellation(jobId) {
    return this.#publish(await this.operationStore.requestCancellation(jobId));
  }

  async appendEvent(jobId, event) {
    return this.#publish(await this.operationStore.appendEvent(jobId, event));
  }

  #publish(record) {
    try { this.nativeNotificationBridge.publishJobEvent(safeTransition(record)); }
    catch { /* the durable operation record remains authoritative */ }
    return record;
  }
}

module.exports = { OperationEventStore, safeTransition };
