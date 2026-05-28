export function createAsyncLatestQueue() {
  let running = false;
  let cancelled = false;
  let pendingTask = null;
  let activePromise = Promise.resolve();

  async function run(task) {
    if (cancelled || typeof task !== 'function') {
      return;
    }

    running = true;

    try {
      await task();
    } finally {
      running = false;

      if (!cancelled && pendingTask) {
        const nextTask = pendingTask;
        pendingTask = null;
        activePromise = run(nextTask);
        await activePromise;
      }
    }
  }

  function enqueue(task) {
    if (cancelled || typeof task !== 'function') {
      return activePromise;
    }

    if (running) {
      pendingTask = task;
      return activePromise;
    }

    activePromise = run(task);
    return activePromise;
  }

  function cancel() {
    cancelled = true;
    pendingTask = null;
  }

  function idle() {
    return activePromise;
  }

  return {
    enqueue,
    cancel,
    idle,
    get running() {
      return running;
    }
  };
}
