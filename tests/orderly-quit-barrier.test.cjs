const assert = require('node:assert/strict');
const test = require('node:test');

const { createOrderlyQuitBarrier } = require('../electron/utils/orderly-quit-barrier.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function eventRecorder() {
  let prevented = 0;
  return {
    event: { preventDefault() { prevented += 1; } },
    get prevented() { return prevented; }
  };
}

test('first quit is held until one cached disposal resolves and reentry passes without a loop', async () => {
  const disposal = deferred();
  let disposeCalls = 0;
  let quitCalls = 0;
  const barrier = createOrderlyQuitBarrier({
    dispose() { disposeCalls += 1; return disposal.promise; },
    quit() { quitCalls += 1; }
  });
  const first = eventRecorder();
  const repeated = eventRecorder();

  assert.equal(barrier.handleBeforeQuit(first.event), true);
  assert.equal(barrier.handleBeforeQuit(repeated.event), true);
  assert.equal(first.prevented, 1);
  assert.equal(repeated.prevented, 1);
  assert.equal(disposeCalls, 1);
  assert.equal(quitCalls, 0);

  disposal.resolve();
  await disposal.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quitCalls, 1);

  const reentry = eventRecorder();
  assert.equal(barrier.handleBeforeQuit(reentry.event), false);
  assert.equal(reentry.prevented, 0);
  assert.equal(disposeCalls, 1);
  assert.equal(quitCalls, 1);
});

test('a rejected disposal is reported but still re-enters quit exactly once', async () => {
  const failure = new Error('shutdown failed');
  const reported = [];
  let quitCalls = 0;
  const barrier = createOrderlyQuitBarrier({
    dispose() { return Promise.reject(failure); },
    quit() { quitCalls += 1; },
    onDisposeError(error) { reported.push(error); }
  });
  const first = eventRecorder();

  assert.equal(barrier.handleBeforeQuit(first.event), true);
  assert.equal(first.prevented, 1);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(reported, [failure]);
  assert.equal(quitCalls, 1);
  const reentry = eventRecorder();
  assert.equal(barrier.handleBeforeQuit(reentry.event), false);
  assert.equal(reentry.prevented, 0);
});

test('a synchronous disposal failure also re-enters quit instead of stranding shutdown', async () => {
  const failure = new Error('synchronous shutdown failed');
  let reported = null;
  let quitCalls = 0;
  const barrier = createOrderlyQuitBarrier({
    dispose() { throw failure; },
    quit() { quitCalls += 1; },
    onDisposeError(error) { reported = error; }
  });
  const first = eventRecorder();

  assert.equal(barrier.handleBeforeQuit(first.event), true);
  assert.equal(first.prevented, 1);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(reported, failure);
  assert.equal(quitCalls, 1);
});
