import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncLatestQueue } from '../src/utils/asyncLatestQueue.js';

test('async latest queue runs the active task and only the newest pending task', async () => {
  const calls = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    releaseFirst = () => {
      calls.push('finish:first');
      resolve();
    };
  });

  const queue = createAsyncLatestQueue();
  const first = queue.enqueue(async () => {
    calls.push('start:first');
    await firstStarted;
  });

  queue.enqueue(async () => {
    calls.push('start:stale');
  });

  queue.enqueue(async () => {
    calls.push('start:latest');
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseFirst();
  await first;
  await queue.idle();

  assert.deepEqual(calls, [
    'start:first',
    'finish:first',
    'start:latest'
  ]);
});

test('async latest queue ignores work after cancellation', async () => {
  const calls = [];
  const queue = createAsyncLatestQueue();

  queue.cancel();
  await queue.enqueue(async () => {
    calls.push('start:cancelled');
  });

  await queue.idle();

  assert.deepEqual(calls, []);
});
