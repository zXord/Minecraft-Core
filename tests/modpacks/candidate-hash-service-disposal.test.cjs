'use strict';

// Exercise the real service with controlled worker termination boundaries.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { PersistentCandidateHashService } = require('../../electron/services/modpacks/planning/candidate-hash-service.cjs');

const filePath = path.resolve(process.cwd(), 'inert-lifecycle-fixture.dat');
const expectedIdentity = Object.freeze({
  dev: '1', ino: '2', birthtimeNs: '3', mtimeNs: '4', size: '0', nlink: '1', type: 'file'
});
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const options = { timeout: 2000 };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bounded wait exceeded: ${label}`)), 750);
      })
    ]);
  } finally { clearTimeout(timer); }
}

function observe(promise) {
  const state = { status: 'pending' };
  state.done = promise.then(
    value => { state.status = 'fulfilled'; state.value = value; },
    error => { state.status = 'rejected'; state.error = error; }
  );
  return state;
}

class ControlledWorker extends EventEmitter {
  constructor(terminationMode = 'delayed') {
    super();
    this.terminationMode = terminationMode;
    this.startedTermination = deferred();
    this.termination = deferred();
    // The real service must attach a rejection handler to terminate's promise.
    // Do not pre-handle it here: that would hide an unhandled-rejection regression.
    this.requests = [];
  }
  ref() {}
  unref() {}
  postMessage(request) { this.requests.push(request); }
  terminate() {
    this.startedTermination.resolve();
    if (this.terminationMode === 'throw') throw new Error('synthetic termination throw');
    return this.termination.promise;
  }
  complete(index = 0) {
    const request = this.requests[index];
    assert.ok(request, 'real service must issue a hash request');
    this.emit('message', {
      version: 1, id: request.id, ok: true,
      result: { sha256: EMPTY_SHA256, size: '0', identity: { ...expectedIdentity } }
    });
  }
}

function harness(t, { idleTimeoutMs = 60_000, terminationMode = 'delayed' } = {}) {
  const workers = [];
  const service = new PersistentCandidateHashService({
    idleTimeoutMs,
    workerFactory() {
      const worker = new ControlledWorker(terminationMode);
      workers.push(worker);
      return worker;
    }
  });
  t.after(async () => {
    for (const worker of workers) worker.termination.resolve(0);
    await bounded(Promise.resolve(service.dispose()).catch(() => {}), 'cleanup disposal');
  });
  return { service, workers };
}

function request(service, signal) {
  return service.hashFile(filePath, { expectedIdentity, ...(signal ? { signal } : {}) });
}

async function assertPending(state, message) {
  await nextTurn();
  assert.equal(state.status, 'pending', message);
}

test('control: disposing a current worker waits for its termination', options, async t => {
  const { service, workers } = harness(t);
  const hash = observe(request(service));
  const drain = observe(service.dispose());
  await bounded(hash.done, 'pending hash rejected by disposal');
  assert.equal(hash.error?.code, 'CANDIDATE_HASH_SERVICE_DISPOSED');
  await assertPending(drain, 'current worker remains active until termination resolves');
  workers[0].termination.resolve(0);
  await bounded(drain.done, 'current worker disposal');
  assert.equal(drain.status, 'fulfilled');
});

for (const retirement of ['abort', 'error', 'idle']) {
  test(`dispose waits for pending termination after ${retirement} retirement`, options, async t => {
    const { service, workers } = harness(t, { idleTimeoutMs: retirement === 'idle' ? 1 : 60_000 });
    const controller = new AbortController();
    const hash = observe(request(service, controller.signal));
    const worker = workers[0];
    if (retirement === 'abort') controller.abort();
    else if (retirement === 'error') worker.emit('error', new Error('synthetic worker failure'));
    else worker.complete();
    await bounded(hash.done, 'hash outcome');
    if (retirement === 'idle') {
      assert.equal(hash.status, 'fulfilled');
      assert.equal(hash.value.sha256, EMPTY_SHA256);
    } else {
      assert.equal(hash.status, 'rejected');
      assert.equal(hash.error.code, retirement === 'abort' ? 'ABORT_ERR' : 'CANDIDATE_HASH_WORKER_UNAVAILABLE');
    }
    await bounded(worker.startedTermination.promise, 'retirement starts termination');
    const drain = observe(service.dispose());
    await assertPending(drain, `${retirement}-retired worker still has unresolved termination`);
    worker.termination.resolve(0);
    await bounded(drain.done, 'retired worker disposal');
    assert.equal(drain.status, 'fulfilled');
  });
}

test('dispose drains a retired worker as well as a replacement current worker', options, async t => {
  const { service, workers } = harness(t);
  const firstHash = observe(request(service));
  workers[0].emit('error', new Error('retire first worker'));
  await bounded(firstHash.done, 'first hash failure');
  assert.equal(firstHash.error?.code, 'CANDIDATE_HASH_WORKER_UNAVAILABLE');
  const secondHash = observe(request(service));
  const drain = observe(service.dispose());
  await bounded(secondHash.done, 'replacement hash rejected by disposal');
  assert.equal(secondHash.error?.code, 'CANDIDATE_HASH_SERVICE_DISPOSED');
  workers[1].termination.resolve(0);
  await assertPending(drain, 'finishing current worker cannot hide a still-retiring predecessor');
  workers[0].termination.resolve(0);
  await bounded(drain.done, 'all generations drained');
  assert.equal(drain.status, 'fulfilled');
});

test('repeated dispose callers await the same ongoing drain', options, async t => {
  const { service, workers } = harness(t);
  const hash = observe(request(service));
  const first = observe(service.dispose());
  const repeated = observe(service.dispose());
  await bounded(hash.done, 'pending hash disposal');
  assert.equal(hash.error?.code, 'CANDIDATE_HASH_SERVICE_DISPOSED');
  await assertPending(first, 'initial caller waits');
  await assertPending(repeated, 'repeated caller cannot report early quiescence');
  workers[0].termination.resolve(0);
  await bounded(Promise.all([first.done, repeated.done]), 'both dispose callers');
  assert.equal(first.status, 'fulfilled');
  assert.equal(repeated.status, 'fulfilled');
});

for (const failure of ['reject', 'throw']) {
  for (const retirement of ['current', 'error-retired']) {
    test(`dispose refuses quiescence if ${retirement} worker termination ${failure}s`, options, async t => {
      const { service, workers } = harness(t, { terminationMode: failure === 'throw' ? 'throw' : 'delayed' });
      const hash = observe(request(service));
      if (retirement === 'error-retired') workers[0].emit('error', new Error('retire before disposal'));
      const first = observe(service.dispose());
      if (failure === 'reject') workers[0].termination.reject(new Error('synthetic termination rejection'));
      await bounded(hash.done, 'hash failure consumed');
      assert.equal(hash.status, 'rejected');
      assert.equal(hash.error.code, retirement === 'current' ? 'CANDIDATE_HASH_SERVICE_DISPOSED' : 'CANDIDATE_HASH_WORKER_UNAVAILABLE');
      await bounded(first.done, 'failed termination disposal');
      assert.equal(first.status, 'rejected', 'termination failure must not be converted to successful quiescence');
      const repeated = observe(service.dispose());
      await bounded(repeated.done, 'repeat failed disposal');
      assert.equal(repeated.status, 'rejected', 'later dispose must retain the failed-quiescence result');
    });
  }
}

for (const failure of ['reject', 'throw']) {
  test(`dispose retains idle-retired termination ${failure} before first and repeated disposal`, options, async t => {
    const { service, workers } = harness(t, { idleTimeoutMs: 1, terminationMode: failure === 'throw' ? 'throw' : 'delayed' });
    const hash = observe(request(service));
    workers[0].complete();
    await bounded(hash.done, 'successful hash before idle retirement');
    assert.equal(hash.status, 'fulfilled');
    assert.equal(hash.value.sha256, EMPTY_SHA256);
    await bounded(workers[0].startedTermination.promise, 'idle termination starts');
    if (failure === 'reject') workers[0].termination.reject(new Error('idle termination failed'));
    await nextTurn();
    const first = observe(service.dispose());
    const repeated = observe(service.dispose());
    await bounded(Promise.all([first.done, repeated.done]), 'both idle failure disposal results');
    assert.deepEqual([first.status, repeated.status], ['rejected', 'rejected'],
      'idle close failure must survive settlement and every disposal call');
  });
}

test('dispose remembers a retired termination failure settled before disposal starts', options, async t => {
  const { service, workers } = harness(t);
  const hash = observe(request(service));
  workers[0].emit('error', new Error('retired worker'));
  await bounded(hash.done, 'hash rejection consumed');
  assert.equal(hash.error?.code, 'CANDIDATE_HASH_WORKER_UNAVAILABLE');
  workers[0].termination.reject(new Error('termination already failed'));
  await nextTurn();
  const drain = observe(service.dispose());
  await bounded(drain.done, 'remembered failed retirement');
  assert.equal(drain.status, 'rejected', 'removing settled retirements must not erase failed quiescence');
});

test('failed termination does not settle disposal while another worker still retires', options, async t => {
  const { service, workers } = harness(t);
  const firstHash = observe(request(service));
  workers[0].emit('error', new Error('retire first worker'));
  await bounded(firstHash.done, 'first hash rejection consumed');
  assert.equal(firstHash.error?.code, 'CANDIDATE_HASH_WORKER_UNAVAILABLE');
  const secondHash = observe(request(service));
  const drain = observe(service.dispose());
  await bounded(secondHash.done, 'second hash rejection consumed');
  assert.equal(secondHash.error?.code, 'CANDIDATE_HASH_SERVICE_DISPOSED');
  workers[1].termination.reject(new Error('current termination failed'));
  await assertPending(drain, 'failure must still drain the other outstanding retirement');
  workers[0].termination.resolve(0);
  await bounded(drain.done, 'drain then refuse quiescence');
  assert.equal(drain.status, 'rejected');
});
