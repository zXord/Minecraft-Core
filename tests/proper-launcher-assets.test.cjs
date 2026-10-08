const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { stream: undiciStream } = require('undici');

const {
  installMinecraftAssetsWithRetry,
  runBoundedXmclTask
} = require('../electron/services/minecraft-launcher/proper-launcher.cjs');

function createPendingTask() {
  let rejectTask;
  let context;
  const task = {
    cancelCalls: 0,
    startAndWait(taskContext) {
      context = taskContext;
      return new Promise((resolve, reject) => {
        rejectTask = reject;
      });
    },
    emitProgress(chunkSize) {
      context?.onUpdate?.(task, chunkSize);
    },
    async cancel() {
      task.cancelCalls += 1;
      rejectTask?.(new Error('cancelled by test'));
    }
  };
  return task;
}

function createTask(run = async () => undefined) {
  return {
    cancelCalls: 0,
    startAndWait(context) {
      context?.onStart?.(this);
      return Promise.resolve().then(() => run(context));
    },
    async cancel() {
      this.cancelCalls += 1;
    }
  };
}

function sha1(bytes) {
  return crypto.createHash('sha1').update(bytes).digest('hex');
}

async function writeAsset(clientPath, hash, bytes) {
  const destination = path.join(clientPath, 'assets', 'objects', hash.slice(0, 2), hash);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, bytes);
  return destination;
}

test('asset installer dispatcher accepts the XMCL maxRedirections request contract', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-assets-dispatcher-'));
  const clientPath = path.join(root, 'client');
  const bytes = Buffer.from('locally served Minecraft asset');
  const hash = sha1(bytes);
  const index = { objects: { 'minecraft/asset.bin': { hash, size: bytes.length } } };
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-length': bytes.length });
    response.end(bytes);
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.equal(typeof address, 'object');
    await fsp.mkdir(path.join(clientPath, 'assets', 'indexes'), { recursive: true });
    await fsp.writeFile(path.join(clientPath, 'assets', 'indexes', 'test.json'), JSON.stringify(index));

    const result = await installMinecraftAssetsWithRetry({
      version: { assets: 'test', assetIndex: { sha1: '0123456789012345678901234567890123456789' } },
      clientPath,
      maxAttempts: 1,
      idleTimeoutMs: 1_000,
      hardTimeoutMs: 5_000,
      cancelTimeoutMs: 100,
      createAssetIndexTask: () => createTask(),
      createAssetDownloadTask: ({ assets, downloadOptions }) => createTask(async context => {
        const chunks = [];
        await undiciStream(
          `http://127.0.0.1:${address.port}/asset`,
          {
            dispatcher: downloadOptions.dispatcher,
            maxRedirections: 5
          },
          () => new Writable({
            write(chunk, _encoding, callback) {
              chunks.push(Buffer.from(chunk));
              context?.onUpdate?.({ progress: chunk.length, total: bytes.length }, chunk.length);
              callback();
            }
          })
        );
        await writeAsset(clientPath, assets[0].hash, Buffer.concat(chunks));
      })
    });

    assert.deepEqual(result, { total: 1, verified: 1, attempts: 1 });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('bounded XMCL task cancels the live task after an idle timeout', async () => {
  assert.equal(typeof runBoundedXmclTask, 'function');
  const task = createPendingTask();

  await assert.rejects(
    runBoundedXmclTask(task, {
      idleTimeoutMs: 20,
      hardTimeoutMs: 500,
      cancelTimeoutMs: 100
    }),
    error => error?.code === 'MINECRAFT_ASSET_IDLE_TIMEOUT' &&
      error.message === 'Minecraft asset download stopped because no progress was received.'
  );
  assert.equal(task.cancelCalls, 1);
});

test('bounded XMCL task keeps the idle window alive on byte progress but enforces the hard timeout', async () => {
  const task = createPendingTask();
  const progressTimer = setInterval(() => task.emitProgress(1), 8);
  try {
    await assert.rejects(
      runBoundedXmclTask(task, {
        idleTimeoutMs: 25,
        hardTimeoutMs: 80,
        cancelTimeoutMs: 100
      }),
      error => error?.code === 'MINECRAFT_ASSET_HARD_TIMEOUT' &&
        error.message === 'Minecraft asset download exceeded its maximum allowed time.'
    );
  } finally {
    clearInterval(progressTimer);
  }
  assert.equal(task.cancelCalls, 1);
});

test('bounded XMCL task reports only numeric progress from the live task', async () => {
  const task = createPendingTask();
  const controller = new AbortController();
  const progress = [];
  task.progress = 12;
  task.total = 50;
  task._from = 'C:\\private\\asset.bin';
  const result = runBoundedXmclTask(task, {
    idleTimeoutMs: 500,
    hardTimeoutMs: 1_000,
    cancelTimeoutMs: 100,
    signal: controller.signal,
    onProgress: event => progress.push(event)
  });

  await new Promise(resolve => setImmediate(resolve));
  task.emitProgress(12);
  controller.abort();
  await assert.rejects(result, error => error?.code === 'MINECRAFT_ASSET_CANCELLED');

  assert.deepEqual(progress, [{ current: 12, total: 50 }]);
  assert.equal(JSON.stringify(progress).includes('private'), false);
});

test('bounded XMCL task propagates an external launch cancellation to the live task', async () => {
  const task = createPendingTask();
  const controller = new AbortController();
  const result = runBoundedXmclTask(task, {
    idleTimeoutMs: 500,
    hardTimeoutMs: 1_000,
    cancelTimeoutMs: 100,
    signal: controller.signal
  });

  await new Promise(resolve => setImmediate(resolve));
  controller.abort();

  await assert.rejects(
    result,
    error => error?.code === 'MINECRAFT_ASSET_CANCELLED' &&
      error.message === 'Minecraft asset preparation was cancelled.'
  );
  assert.equal(task.cancelCalls, 1);
});

test('bounded XMCL task does not start work for an already-cancelled launch', async () => {
  const controller = new AbortController();
  controller.abort();
  let startCalls = 0;
  const task = {
    startAndWait() {
      startCalls += 1;
      return Promise.resolve();
    },
    async cancel() {}
  };

  await assert.rejects(
    runBoundedXmclTask(task, { signal: controller.signal }),
    error => error?.code === 'MINECRAFT_ASSET_CANCELLED'
  );
  assert.equal(startCalls, 0);
});

test('asset installer preserves verified files and retries only the still-invalid asset set', async () => {
  assert.equal(typeof installMinecraftAssetsWithRetry, 'function');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-assets-'));
  const clientPath = path.join(root, 'client');
  const validBytes = Buffer.from('already valid');
  const retryBytes = Buffer.from('retry me');
  const recoveredBytes = Buffer.from('completed before the first attempt failed');
  const validHash = sha1(validBytes);
  const retryHash = sha1(retryBytes);
  const recoveredHash = sha1(recoveredBytes);
  const index = {
    objects: {
      'minecraft/valid.bin': { hash: validHash, size: validBytes.length },
      'minecraft/retry.bin': { hash: retryHash, size: retryBytes.length },
      'minecraft/recovered.bin': { hash: recoveredHash, size: recoveredBytes.length }
    }
  };
  const calls = [];
  const progress = [];
  let dispatcherClosed = false;

  try {
    await fsp.mkdir(path.join(clientPath, 'assets', 'indexes'), { recursive: true });
    await fsp.writeFile(path.join(clientPath, 'assets', 'indexes', 'test.json'), JSON.stringify(index));
    const validPath = await writeAsset(clientPath, validHash, validBytes);
    await writeAsset(clientPath, retryHash, Buffer.from('partial'));

    const result = await installMinecraftAssetsWithRetry({
      version: { assets: 'test', assetIndex: { sha1: '1111111111111111111111111111111111111111' } },
      clientPath,
      maxAttempts: 3,
      idleTimeoutMs: 1_000,
      hardTimeoutMs: 5_000,
      cancelTimeoutMs: 100,
      createDispatcher: () => ({
        async close() { dispatcherClosed = true; }
      }),
      createAssetIndexTask: () => createTask(),
      createAssetDownloadTask: ({ assets }) => createTask(async context => {
        calls.push(assets.map(asset => asset.hash));
        context?.onUpdate?.({ progress: 2, total: recoveredBytes.length + retryBytes.length }, 2);
        if (calls.length === 1) {
          await writeAsset(clientPath, retryHash, Buffer.from('partial again'));
          await writeAsset(clientPath, recoveredHash, recoveredBytes);
          throw new Error(`external downloader leaked ${root}`);
        }
        await writeAsset(clientPath, retryHash, retryBytes);
      }),
      onProgress: event => progress.push(event)
    });

    assert.deepEqual(calls, [
      [recoveredHash, retryHash].sort(),
      [retryHash]
    ]);
    assert.deepEqual(result, { total: 3, verified: 3, attempts: 2 });
    assert.deepEqual(await fsp.readFile(validPath), validBytes);
    assert.equal(dispatcherClosed, true);
    const publicProgress = JSON.stringify(progress);
    assert.equal(publicProgress.includes(root), false);
    assert.equal(publicProgress.includes(validHash), false);
    assert.equal(publicProgress.includes(retryHash), false);
    assert.equal(publicProgress.includes('external downloader leaked'), false);
    assert.equal(progress.some(event =>
      event.type === 'Downloading' &&
      event.total === validBytes.length + retryBytes.length + recoveredBytes.length &&
      event.current === validBytes.length + 2
    ), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset installer never cleans or retries while XMCL cancellation is unconfirmed', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-assets-cancel-'));
  const clientPath = path.join(root, 'client');
  const finalBytes = Buffer.from('complete asset');
  const hash = sha1(finalBytes);
  const index = { objects: { 'minecraft/asset.bin': { hash, size: finalBytes.length } } };
  let attempts = 0;
  let dispatcherDestroyed = false;

  try {
    await fsp.mkdir(path.join(clientPath, 'assets', 'indexes'), { recursive: true });
    await fsp.writeFile(path.join(clientPath, 'assets', 'indexes', 'test.json'), JSON.stringify(index));
    const assetPath = path.join(clientPath, 'assets', 'objects', hash.slice(0, 2), hash);

    await assert.rejects(
      installMinecraftAssetsWithRetry({
        version: { assets: 'test', assetIndex: { sha1: '2222222222222222222222222222222222222222' } },
        clientPath,
        maxAttempts: 2,
        idleTimeoutMs: 20,
        hardTimeoutMs: 1_000,
        cancelTimeoutMs: 20,
        createDispatcher: () => ({
          async destroy() { dispatcherDestroyed = true; },
          async close() { throw new Error('graceful close must not wait on a stalled request'); }
        }),
        createAssetIndexTask: () => createTask(),
        createAssetDownloadTask: () => ({
          async startAndWait() {
            attempts += 1;
            await writeAsset(clientPath, hash, Buffer.from('partial'));
            return new Promise(() => {});
          },
          cancel() {
            return new Promise(() => {});
          }
        })
      }),
      error => error?.code === 'MINECRAFT_ASSET_CANCEL_TIMEOUT' &&
        error.message === 'Minecraft asset download could not be cancelled safely.'
    );

    assert.equal(attempts, 1);
    assert.equal(dispatcherDestroyed, true);
    assert.deepEqual(await fsp.readFile(assetPath), Buffer.from('partial'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset installer preserves an unconfirmed asset-index cancellation', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-index-cancel-'));
  const clientPath = path.join(root, 'client');
  let dispatcherDestroyed = false;

  try {
    await fsp.mkdir(clientPath, { recursive: true });
    await assert.rejects(
      installMinecraftAssetsWithRetry({
        version: { assets: 'test', assetIndex: { sha1: '7777777777777777777777777777777777777777' } },
        clientPath,
        idleTimeoutMs: 20,
        hardTimeoutMs: 1_000,
        cancelTimeoutMs: 20,
        createDispatcher: () => ({
          async destroy() { dispatcherDestroyed = true; }
        }),
        createAssetIndexTask: () => ({
          startAndWait() { return new Promise(() => {}); },
          cancel() { return new Promise(() => {}); }
        })
      }),
      error => error?.code === 'MINECRAFT_ASSET_CANCEL_TIMEOUT' &&
        error.message === 'Minecraft asset download could not be cancelled safely.'
    );
    assert.equal(dispatcherDestroyed, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset verification is included in the asset-stage hard deadline', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-verify-timeout-'));
  const clientPath = path.join(root, 'client');
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  const hash = sha1(bytes);

  try {
    await fsp.mkdir(path.join(clientPath, 'assets', 'indexes'), { recursive: true });
    await fsp.writeFile(
      path.join(clientPath, 'assets', 'indexes', 'test.json'),
      JSON.stringify({ objects: { 'minecraft/large.bin': { hash, size: bytes.length } } })
    );
    await writeAsset(clientPath, hash, bytes);

    await assert.rejects(
      installMinecraftAssetsWithRetry({
        version: { assets: 'test', assetIndex: { sha1: '9999999999999999999999999999999999999999' } },
        clientPath,
        hardTimeoutMs: 1,
        idleTimeoutMs: 1_000,
        createDispatcher: () => ({ async close() {} }),
        createAssetIndexTask: () => createTask()
      }),
      error => error?.code === 'MINECRAFT_ASSET_HARD_TIMEOUT' &&
        error.message === 'Minecraft asset download exceeded its maximum allowed time.'
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset verification deadline is not defeated by a stalled file stat', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-stat-timeout-'));
  const clientPath = path.join(root, 'client');
  const bytes = Buffer.from('asset');
  const hash = sha1(bytes);
  const assetPath = path.join(clientPath, 'assets', 'objects', hash.slice(0, 2), hash);
  const originalLstat = fs.promises.lstat;

  try {
    await fsp.mkdir(path.join(clientPath, 'assets', 'indexes'), { recursive: true });
    await fsp.writeFile(
      path.join(clientPath, 'assets', 'indexes', 'test.json'),
      JSON.stringify({ objects: { 'minecraft/stalled.bin': { hash, size: bytes.length } } })
    );
    await writeAsset(clientPath, hash, bytes);
    fs.promises.lstat = targetPath =>
      path.resolve(String(targetPath)) === path.resolve(assetPath)
        ? new Promise(() => {})
        : originalLstat(targetPath);

    const installation = installMinecraftAssetsWithRetry({
      version: { assets: 'test', assetIndex: { sha1: 'cccccccccccccccccccccccccccccccccccccccc' } },
      clientPath,
      hardTimeoutMs: 20,
      idleTimeoutMs: 1_000,
      createDispatcher: () => ({ async close() {} }),
      createAssetIndexTask: () => createTask()
    }).then(
      () => ({ success: true }),
      error => ({ success: false, error })
    );
    const outcome = await Promise.race([
      installation,
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 200))
    ]);

    assert.equal(outcome.timeout, undefined);
    assert.equal(outcome.success, false);
    assert.equal(outcome.error?.code, 'MINECRAFT_ASSET_HARD_TIMEOUT');
  } finally {
    fs.promises.lstat = originalLstat;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset cleanup returns a quarantining error when a file removal cannot be confirmed', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-unlink-timeout-'));
  const clientPath = path.join(root, 'client');
  const expectedBytes = Buffer.from('complete asset');
  const hash = sha1(expectedBytes);
  const assetPath = await writeAsset(clientPath, hash, Buffer.from('partial'));
  const originalUnlink = fs.promises.unlink;
  let downloadTaskCreated = false;

  try {
    await fsp.mkdir(path.join(clientPath, 'assets', 'indexes'), { recursive: true });
    await fsp.writeFile(
      path.join(clientPath, 'assets', 'indexes', 'test.json'),
      JSON.stringify({ objects: { 'minecraft/stalled.bin': { hash, size: expectedBytes.length } } })
    );
    fs.promises.unlink = targetPath =>
      path.resolve(String(targetPath)) === path.resolve(assetPath)
        ? new Promise(() => {})
        : originalUnlink(targetPath);

    const installation = installMinecraftAssetsWithRetry({
      version: { assets: 'test', assetIndex: { sha1: 'dddddddddddddddddddddddddddddddddddddddd' } },
      clientPath,
      hardTimeoutMs: 30,
      idleTimeoutMs: 1_000,
      createDispatcher: () => ({ async close() {} }),
      createAssetIndexTask: () => createTask(),
      createAssetDownloadTask: () => {
        downloadTaskCreated = true;
        return createTask();
      }
    }).then(
      () => ({ success: true }),
      error => ({ success: false, error })
    );
    const outcome = await Promise.race([
      installation,
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 200))
    ]);

    assert.equal(outcome.timeout, undefined);
    assert.equal(outcome.success, false);
    assert.equal(outcome.error?.code, 'MINECRAFT_ASSET_CANCEL_TIMEOUT');
    assert.equal(downloadTaskCreated, false);
  } finally {
    fs.promises.unlink = originalUnlink;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset installer stops at its finite attempt budget with a path-free verified-file error', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-assets-budget-'));
  const clientPath = path.join(root, 'client');
  const finalBytes = Buffer.from('complete asset');
  const hash = sha1(finalBytes);
  const index = { objects: { 'minecraft/asset.bin': { hash, size: finalBytes.length } } };
  let attempts = 0;
  let dispatcherClosed = false;

  try {
    await fsp.mkdir(path.join(clientPath, 'assets', 'indexes'), { recursive: true });
    await fsp.writeFile(path.join(clientPath, 'assets', 'indexes', 'test.json'), JSON.stringify(index));
    const assetPath = path.join(clientPath, 'assets', 'objects', hash.slice(0, 2), hash);

    await assert.rejects(
      installMinecraftAssetsWithRetry({
        version: { assets: 'test', assetIndex: { sha1: '3333333333333333333333333333333333333333' } },
        clientPath,
        maxAttempts: 2,
        idleTimeoutMs: 1_000,
        hardTimeoutMs: 5_000,
        cancelTimeoutMs: 100,
        createDispatcher: () => ({ async close() { dispatcherClosed = true; } }),
        createAssetIndexTask: () => createTask(),
        createAssetDownloadTask: () => createTask(async () => {
          attempts += 1;
          await writeAsset(clientPath, hash, Buffer.from('partial'));
          throw new Error(`raw downloader failure at ${root}`);
        })
      }),
      error => error?.code === 'MINECRAFT_ASSET_DOWNLOAD_FAILED' &&
        error.message === 'Minecraft asset download could not verify 1 required file after 2 attempts.' &&
        !error.message.includes(root)
    );

    assert.equal(attempts, 2);
    assert.equal(dispatcherClosed, true);
    await assert.rejects(fsp.access(assetPath), { code: 'ENOENT' });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset cleanup refuses a non-regular target without recursively deleting it', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-assets-safe-'));
  const clientPath = path.join(root, 'client');
  const bytes = Buffer.from('complete asset');
  const hash = sha1(bytes);
  const index = { objects: { 'minecraft/asset.bin': { hash, size: bytes.length } } };
  let downloadTaskCreated = false;

  try {
    await fsp.mkdir(path.join(clientPath, 'assets', 'indexes'), { recursive: true });
    await fsp.writeFile(path.join(clientPath, 'assets', 'indexes', 'test.json'), JSON.stringify(index));
    const unsafeTarget = path.join(clientPath, 'assets', 'objects', hash.slice(0, 2), hash);
    await fsp.mkdir(unsafeTarget, { recursive: true });
    await fsp.writeFile(path.join(unsafeTarget, 'sentinel.txt'), 'keep');

    await assert.rejects(
      installMinecraftAssetsWithRetry({
        version: { assets: 'test', assetIndex: { sha1: '4444444444444444444444444444444444444444' } },
        clientPath,
        createDispatcher: () => ({ async close() {} }),
        createAssetIndexTask: () => createTask(),
        createAssetDownloadTask: () => {
          downloadTaskCreated = true;
          return createTask();
        }
      }),
      error => error?.code === 'MINECRAFT_ASSET_STORAGE_UNSAFE' &&
        error.message === 'Minecraft asset storage contains an unsafe entry.'
    );

    assert.equal(downloadTaskCreated, false);
    assert.equal(await fsp.readFile(path.join(unsafeTarget, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset installer refuses redirected metadata storage before starting a download', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-assets-parent-'));
  const clientPath = path.join(root, 'client');
  const outsidePath = path.join(root, 'outside');
  let indexTaskCreated = false;

  try {
    await fsp.mkdir(path.join(clientPath, 'assets'), { recursive: true });
    await fsp.mkdir(outsidePath, { recursive: true });
    await fsp.writeFile(path.join(outsidePath, 'sentinel.txt'), 'keep');
    await fsp.symlink(
      outsidePath,
      path.join(clientPath, 'assets', 'indexes'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    await assert.rejects(
      installMinecraftAssetsWithRetry({
        version: { assets: 'test', assetIndex: { sha1: '8888888888888888888888888888888888888888' } },
        clientPath,
        createDispatcher: () => ({ async close() {} }),
        createAssetIndexTask: () => {
          indexTaskCreated = true;
          return createTask();
        }
      }),
      error => error?.code === 'MINECRAFT_ASSET_STORAGE_UNSAFE' &&
        error.message === 'Minecraft asset storage contains an unsafe entry.'
    );

    assert.equal(indexTaskCreated, false);
    assert.equal(await fsp.readFile(path.join(outsidePath, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset installer keeps the client logging configuration in the same bounded preparation stage', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-assets-log-'));
  const clientPath = path.join(root, 'client');
  const order = [];

  try {
    await fsp.mkdir(path.join(clientPath, 'assets', 'indexes'), { recursive: true });
    await fsp.writeFile(path.join(clientPath, 'assets', 'indexes', 'test.json'), '{"objects":{}}');

    const result = await installMinecraftAssetsWithRetry({
      version: {
        assets: 'test',
        assetIndex: { sha1: '5555555555555555555555555555555555555555' },
        logging: {
          client: {
            file: {
              id: 'client-log.xml',
              url: 'https://example.invalid/client-log.xml',
              sha1: '6666666666666666666666666666666666666666'
            }
          }
        }
      },
      clientPath,
      createDispatcher: () => ({ async close() {} }),
      createLogConfigTask: () => createTask(async () => { order.push('log'); }),
      createAssetIndexTask: () => createTask(async () => { order.push('index'); }),
      createAssetDownloadTask: () => {
        throw new Error('no asset objects should be downloaded');
      }
    });

    assert.deepEqual(order, ['log', 'index']);
    assert.deepEqual(result, { total: 0, verified: 0, attempts: 0 });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('asset installer rejects a logging destination that is not a safe file identifier', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-proper-assets-log-id-'));
  const clientPath = path.join(root, 'client');
  let logTaskCreated = false;

  try {
    await fsp.mkdir(clientPath, { recursive: true });
    await assert.rejects(
      installMinecraftAssetsWithRetry({
        version: {
          assets: 'test',
          assetIndex: { sha1: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          logging: {
            client: {
              file: {
                id: '..',
                url: 'https://example.invalid/client-log.xml',
                sha1: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
              }
            }
          }
        },
        clientPath,
        createDispatcher: () => ({ async close() {} }),
        createLogConfigTask: () => {
          logTaskCreated = true;
          return createTask();
        }
      }),
      error => error?.code === 'MINECRAFT_ASSET_LOG_CONFIG_INVALID' &&
        error.message === 'Minecraft client logging metadata is invalid.'
    );
    assert.equal(logTaskCreated, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
