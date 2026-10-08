// Proper Minecraft launcher using @xmcl packages to fix LogUtils and other issues
const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Agent, interceptors } = require('undici');

const { LibraryInfo, MinecraftFolder, Version } = require('@xmcl/core');
const {
  DownloadTask,
  InstallAssetIndexTask,
  installResolvedAssetsTask,
  installVersion,
  installLibraries,
  installLibrariesTask
} = require('@xmcl/installer');
const { installClientLoader, normalizeLoader, getLoaderVersions } = require('../loader-install-service.cjs');

const DEFAULT_ASSET_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_ASSET_HARD_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_ASSET_CANCEL_TIMEOUT_MS = 5_000;
const DEFAULT_ASSET_MAX_ATTEMPTS = 3;
const MAX_ASSET_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_OBJECTS = 100_000;
const MAX_ASSET_TOTAL_BYTES = 32 * 1024 * 1024 * 1024;
const ASSET_HASH = /^[a-f0-9]{40}$/u;
const ASSET_INDEX_ID = /^[A-Za-z0-9._-]{1,128}$/u;

function isSafeAssetFileId(value) {
  return typeof value === 'string' && ASSET_INDEX_ID.test(value) && value !== '.' && value !== '..';
}

function createAssetInstallError(code, message) {
  const error = new Error(message);
  error.name = 'MinecraftAssetInstallError';
  error.code = code;
  return error;
}

function assertAssetStageActive(signal, deadlineMs) {
  if (signal?.aborted) {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_CANCELLED',
      'Minecraft asset preparation was cancelled.'
    );
  }
  if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_HARD_TIMEOUT',
      'Minecraft asset download exceeded its maximum allowed time.'
    );
  }
}

function createAssetIoAbortScope(signal, deadlineMs) {
  assertAssetStageActive(signal, deadlineMs);
  const controller = new AbortController();
  let hardTimedOut = false;
  const onAbort = () => controller.abort();
  const timer = Number.isFinite(deadlineMs)
    ? setTimeout(() => {
      hardTimedOut = true;
      controller.abort();
    }, Math.max(1, deadlineMs - Date.now()))
    : null;
  signal?.addEventListener?.('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    assertActive() {
      if (signal?.aborted) {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_CANCELLED',
          'Minecraft asset preparation was cancelled.'
        );
      }
      if (hardTimedOut) {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_HARD_TIMEOUT',
          'Minecraft asset download exceeded its maximum allowed time.'
        );
      }
      assertAssetStageActive(signal, deadlineMs);
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  };
}

async function raceAssetStageOperation(operationPromise, stage = {}) {
  assertAssetStageActive(stage.signal, stage.deadlineMs);
  if (!stage.signal && !Number.isFinite(stage.deadlineMs)) {
    return operationPromise;
  }
  let timer = null;
  let onAbort = null;
  const interruption = new Promise((resolve, reject) => {
    onAbort = () => reject(createAssetInstallError(
      'MINECRAFT_ASSET_CANCELLED',
      'Minecraft asset preparation was cancelled.'
    ));
    stage.signal?.addEventListener?.('abort', onAbort, { once: true });
    if (Number.isFinite(stage.deadlineMs)) {
      timer = setTimeout(() => reject(createAssetInstallError(
        'MINECRAFT_ASSET_HARD_TIMEOUT',
        'Minecraft asset download exceeded its maximum allowed time.'
      )), Math.max(1, stage.deadlineMs - Date.now()));
    }
  });
  try {
    const result = await Promise.race([operationPromise, interruption]);
    assertAssetStageActive(stage.signal, stage.deadlineMs);
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort) stage.signal?.removeEventListener?.('abort', onAbort);
  }
}

async function raceAssetStageMutation(operationPromise, stage = {}) {
  try {
    return await raceAssetStageOperation(operationPromise, stage);
  } catch (error) {
    if (
      error?.code === 'MINECRAFT_ASSET_CANCELLED' ||
      error?.code === 'MINECRAFT_ASSET_HARD_TIMEOUT'
    ) {
      operationPromise.catch(() => {});
      throw createAssetInstallError(
        'MINECRAFT_ASSET_CANCEL_TIMEOUT',
        'Minecraft asset storage operation could not be confirmed safely.'
      );
    }
    throw error;
  }
}

async function waitForSettlementWithin(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function createLaunchAttempt() {
  let resolvePreSpawn;
  let preSpawnIsSettled = false;
  const preSpawnSettled = new Promise(resolve => {
    resolvePreSpawn = resolve;
  });
  return {
    token: Symbol('minecraft-launch-attempt'),
    controller: new AbortController(),
    client: null,
    preSpawnSettled,
    settlePreSpawn(outcome) {
      if (preSpawnIsSettled) return;
      preSpawnIsSettled = true;
      resolvePreSpawn(outcome);
    }
  };
}

async function runBoundedXmclTask(task, options = {}) {
  if (!task || typeof task.startAndWait !== 'function' || typeof task.cancel !== 'function') {
    throw new TypeError('A cancellable XMCL task is required');
  }
  if (options.signal?.aborted) {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_CANCELLED',
      'Minecraft asset preparation was cancelled.'
    );
  }
  const idleTimeoutMs = Math.max(1, Number(options.idleTimeoutMs) || DEFAULT_ASSET_IDLE_TIMEOUT_MS);
  const hardTimeoutMs = Math.max(1, Number(options.hardTimeoutMs) || DEFAULT_ASSET_HARD_TIMEOUT_MS);
  const cancelTimeoutMs = Math.max(1, Number(options.cancelTimeoutMs) || DEFAULT_ASSET_CANCEL_TIMEOUT_MS);
  const signal = options.signal;
  let idleTimer = null;
  let hardTimer = null;
  let cancelTimer = null;
  let resolveTimeout;
  const timeout = new Promise(resolve => {
    resolveTimeout = resolve;
  });
  const clearTimers = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (hardTimer !== null) clearTimeout(hardTimer);
    if (cancelTimer !== null) clearTimeout(cancelTimer);
    signal?.removeEventListener?.('abort', onAbort);
  };
  const onAbort = () => resolveTimeout('cancelled');
  const resetIdleTimer = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => resolveTimeout('idle'), idleTimeoutMs);
  };

  resetIdleTimer();
  hardTimer = setTimeout(() => resolveTimeout('hard'), hardTimeoutMs);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });
  const taskOutcome = Promise.resolve()
    .then(() => task.startAndWait({
      onUpdate(updatedTask, chunkSize) {
        if (Number(chunkSize) > 0) resetIdleTimer();
        if (typeof options.onProgress === 'function') {
          try {
            const current = Number(updatedTask?.progress);
            const total = Number(updatedTask?.total);
            if (Number.isFinite(current) && current >= 0 && Number.isFinite(total) && total >= 0) {
              options.onProgress(Object.freeze({ current, total }));
            }
          } catch {
            // Progress reporting must never change task correctness.
          }
        }
      }
    }))
    .then(value => ({ type: 'result', value }), error => ({ type: 'error', error }));

  const outcome = await Promise.race([taskOutcome, timeout]);
  if (outcome && typeof outcome === 'object') {
    clearTimers();
    if (outcome.type === 'error') throw outcome.error;
    return outcome.value;
  }

  const cancellation = Promise.resolve().then(() => task.cancel());
  const cancellationFinished = await Promise.race([
    cancellation.then(() => true, () => false),
    new Promise(resolve => {
      cancelTimer = setTimeout(() => resolve(false), cancelTimeoutMs);
    })
  ]);
  clearTimers();
  if (!cancellationFinished) {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_CANCEL_TIMEOUT',
      'Minecraft asset download could not be cancelled safely.'
    );
  }
  if (outcome === 'hard') {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_HARD_TIMEOUT',
      'Minecraft asset download exceeded its maximum allowed time.'
    );
  }
  if (outcome === 'cancelled') {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_CANCELLED',
      'Minecraft asset preparation was cancelled.'
    );
  }
  throw createAssetInstallError(
    'MINECRAFT_ASSET_IDLE_TIMEOUT',
    'Minecraft asset download stopped because no progress was received.'
  );
}

function createMinecraftAssetDispatcher() {
  const agent = new Agent({
    connections: 16,
    connect: { timeout: 30_000 },
    headersTimeout: 60_000,
    bodyTimeout: DEFAULT_ASSET_IDLE_TIMEOUT_MS,
    keepAliveTimeout: 10_000
  });
  return agent.compose(interceptors.redirect({ maxRedirections: 5 }));
}

function emitAssetProgress(onProgress, event) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(Object.freeze({
      type: event.type,
      task: event.task,
      total: event.total,
      current: event.current,
      phase: 'assets',
      attempt: event.attempt
    }));
  } catch {
    // Renderer progress reporting must never change launch correctness.
  }
}

async function lstatIfPresent(targetPath, stage = {}) {
  try {
    return await raceAssetStageOperation(fs.promises.lstat(targetPath), stage);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSafeAssetDirectory(directoryPath, { allowMissing = false, ...stage } = {}) {
  const info = await lstatIfPresent(directoryPath, stage);
  if (!info && allowMissing) return false;
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_STORAGE_UNSAFE',
      'Minecraft asset storage contains an unsafe entry.'
    );
  }
  return true;
}

async function assertAssetDirectoryContained(clientPath, directoryPath, stage = {}) {
  const [clientRealPath, directoryRealPath] = await raceAssetStageOperation(Promise.all([
    fs.promises.realpath(clientPath),
    fs.promises.realpath(directoryPath)
  ]), stage);
  const relative = path.relative(clientRealPath, directoryRealPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_STORAGE_UNSAFE',
      'Minecraft asset storage contains an unsafe entry.'
    );
  }
}

async function ensureSafeAssetDirectory(directoryPath, stage = {}) {
  assertAssetStageActive(stage.signal, stage.deadlineMs);
  if (!await lstatIfPresent(directoryPath, stage)) {
    try {
      assertAssetStageActive(stage.signal, stage.deadlineMs);
      await raceAssetStageMutation(fs.promises.mkdir(directoryPath), stage);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  await assertSafeAssetDirectory(directoryPath, stage);
  if (stage.clientPath) {
    await assertAssetDirectoryContained(stage.clientPath, directoryPath, stage);
  }
  assertAssetStageActive(stage.signal, stage.deadlineMs);
}

async function prepareSafeAssetStorage(clientPath, { needsLogConfig = false, signal, deadlineMs } = {}) {
  assertAssetStageActive(signal, deadlineMs);
  await assertSafeAssetDirectory(clientPath, { signal, deadlineMs });
  const assetsPath = path.join(clientPath, 'assets');
  const stage = { signal, deadlineMs, clientPath };
  await ensureSafeAssetDirectory(assetsPath, stage);
  await ensureSafeAssetDirectory(path.join(assetsPath, 'indexes'), stage);
  await ensureSafeAssetDirectory(path.join(assetsPath, 'objects'), stage);
  if (needsLogConfig) {
    await ensureSafeAssetDirectory(path.join(assetsPath, 'log_configs'), stage);
  }
}

async function prepareSafeAssetObjectPrefixes(clientPath, assets, stage = {}) {
  const objectsPath = path.join(clientPath, 'assets', 'objects');
  for (const prefix of new Set(assets.map(asset => asset.hash.slice(0, 2)))) {
    await ensureSafeAssetDirectory(path.join(objectsPath, prefix), stage);
  }
}

async function assertSafeAssetParents(clientPath, hash, { allowMissing = false, ...stage } = {}) {
  const assetsPath = path.join(clientPath, 'assets');
  const objectsPath = path.join(assetsPath, 'objects');
  const prefixPath = path.join(objectsPath, hash.slice(0, 2));
  await assertSafeAssetDirectory(clientPath, stage);
  if (!await assertSafeAssetDirectory(assetsPath, { ...stage, allowMissing })) return false;
  if (!await assertSafeAssetDirectory(objectsPath, { ...stage, allowMissing })) return false;
  if (!await assertSafeAssetDirectory(prefixPath, { ...stage, allowMissing })) return false;
  return true;
}

async function sha1RegularFile(filePath, stage = {}) {
  const ioScope = createAssetIoAbortScope(stage.signal, stage.deadlineMs);
  const digest = crypto.createHash('sha1');
  let handle = null;
  const openPromise = fs.promises.open(filePath, 'r');
  try {
    try {
      handle = await raceAssetStageOperation(openPromise, stage);
    } catch (error) {
      openPromise.then(lateHandle => lateHandle.close().catch(() => {}), () => {});
      throw error;
    }
    ioScope.assertActive();
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      signal: ioScope.signal
    })) {
      ioScope.assertActive();
      digest.update(chunk);
    }
    ioScope.assertActive();
  } catch (error) {
    if (ioScope.signal.aborted) ioScope.assertActive();
    throw error;
  } finally {
    ioScope.dispose();
    if (handle) {
      const closePromise = handle.close();
      try {
        await raceAssetStageOperation(closePromise, stage);
      } catch (error) {
        closePromise.catch(() => {});
        throw error;
      }
    }
  }
  return digest.digest('hex');
}

async function inspectAssetObjects(clientPath, assets, stage = {}) {
  const invalid = [];
  for (const asset of assets) {
    assertAssetStageActive(stage.signal, stage.deadlineMs);
    const parentsExist = await assertSafeAssetParents(clientPath, asset.hash, {
      ...stage,
      allowMissing: true
    });
    if (!parentsExist) {
      invalid.push(asset);
      continue;
    }
    const filePath = path.join(clientPath, 'assets', 'objects', asset.hash.slice(0, 2), asset.hash);
    const info = await lstatIfPresent(filePath, stage);
    if (!info) {
      invalid.push(asset);
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      invalid.push(asset);
      continue;
    }
    if (info.size !== asset.size || await sha1RegularFile(filePath, stage) !== asset.hash) invalid.push(asset);
  }
  assertAssetStageActive(stage.signal, stage.deadlineMs);
  return invalid;
}

async function removeInvalidAssetObjects(clientPath, assets, stage = {}) {
  for (const asset of assets) {
    assertAssetStageActive(stage.signal, stage.deadlineMs);
    const parentsExist = await assertSafeAssetParents(clientPath, asset.hash, {
      ...stage,
      allowMissing: true
    });
    if (!parentsExist) continue;
    const filePath = path.join(clientPath, 'assets', 'objects', asset.hash.slice(0, 2), asset.hash);
    const info = await lstatIfPresent(filePath, stage);
    if (!info) continue;
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw createAssetInstallError(
        'MINECRAFT_ASSET_STORAGE_UNSAFE',
        'Minecraft asset storage contains an unsafe entry.'
      );
    }
    assertAssetStageActive(stage.signal, stage.deadlineMs);
    await raceAssetStageMutation(fs.promises.unlink(filePath), stage);
  }
}

async function readAssetIndex(clientPath, version, stage = {}) {
  assertAssetStageActive(stage.signal, stage.deadlineMs);
  const indexIds = [version?.assets, version?.assetIndex?.sha1]
    .filter(isSafeAssetFileId);
  let indexPath = null;
  for (const id of [...new Set(indexIds)]) {
    assertAssetStageActive(stage.signal, stage.deadlineMs);
    const candidate = path.join(clientPath, 'assets', 'indexes', `${id}.json`);
    if (await lstatIfPresent(candidate, stage)) {
      indexPath = candidate;
      break;
    }
  }
  if (!indexPath) {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_INDEX_INVALID',
      'Minecraft asset metadata is unavailable.'
    );
  }
  const info = await lstatIfPresent(indexPath, stage);
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_ASSET_INDEX_BYTES) {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_INDEX_INVALID',
      'Minecraft asset metadata is invalid.'
    );
  }
  let parsed;
  const ioScope = createAssetIoAbortScope(stage.signal, stage.deadlineMs);
  try {
    parsed = JSON.parse(await fs.promises.readFile(indexPath, {
      encoding: 'utf8',
      signal: ioScope.signal
    }));
    ioScope.assertActive();
  } catch (error) {
    if (ioScope.signal.aborted) ioScope.assertActive();
    throw createAssetInstallError(
      'MINECRAFT_ASSET_INDEX_INVALID',
      'Minecraft asset metadata is invalid.'
    );
  } finally {
    ioScope.dispose();
  }
  if (!parsed?.objects || typeof parsed.objects !== 'object' || Array.isArray(parsed.objects)) {
    throw createAssetInstallError(
      'MINECRAFT_ASSET_INDEX_INVALID',
      'Minecraft asset metadata is invalid.'
    );
  }
  const unique = new Map();
  let totalBytes = 0;
  for (const [name, entry] of Object.entries(parsed.objects)) {
    assertAssetStageActive(stage.signal, stage.deadlineMs);
    const hash = typeof entry?.hash === 'string' ? entry.hash.toLowerCase() : '';
    const size = Number(entry?.size);
    if (!ASSET_HASH.test(hash) || !Number.isSafeInteger(size) || size < 0) {
      throw createAssetInstallError(
        'MINECRAFT_ASSET_INDEX_INVALID',
        'Minecraft asset metadata is invalid.'
      );
    }
    const existing = unique.get(hash);
    if (existing && existing.size !== size) {
      throw createAssetInstallError(
        'MINECRAFT_ASSET_INDEX_INVALID',
        'Minecraft asset metadata is invalid.'
      );
    }
    if (!existing) {
      unique.set(hash, { name, hash, size });
      totalBytes += size;
      if (unique.size > MAX_ASSET_OBJECTS || totalBytes > MAX_ASSET_TOTAL_BYTES) {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_INDEX_INVALID',
          'Minecraft asset metadata exceeds its safety limits.'
        );
      }
    }
  }
  assertAssetStageActive(stage.signal, stage.deadlineMs);
  return [...unique.values()].sort((left, right) => left.hash.localeCompare(right.hash, 'en-US'));
}

async function installMinecraftAssetsWithRetry(options = {}) {
  const {
    version,
    clientPath,
    signal,
    onProgress,
    maxAttempts = DEFAULT_ASSET_MAX_ATTEMPTS,
    idleTimeoutMs = DEFAULT_ASSET_IDLE_TIMEOUT_MS,
    hardTimeoutMs = DEFAULT_ASSET_HARD_TIMEOUT_MS,
    cancelTimeoutMs = DEFAULT_ASSET_CANCEL_TIMEOUT_MS,
    createDispatcher = createMinecraftAssetDispatcher,
    createLogConfigTask = ({ file, folder, downloadOptions }) =>
      new DownloadTask({
        url: file.url,
        validator: { algorithm: 'sha1', hash: file.sha1 },
        destination: folder.getLogConfig(file.id),
        ...downloadOptions
      }),
    createAssetIndexTask = ({ version: targetVersion, downloadOptions }) =>
      new InstallAssetIndexTask(targetVersion, downloadOptions),
    createAssetDownloadTask = ({ assets, folder, downloadOptions }) =>
      installResolvedAssetsTask(assets, folder, downloadOptions)
  } = options;
  if (!version || typeof version !== 'object' || typeof clientPath !== 'string' || !path.isAbsolute(clientPath)) {
    throw new TypeError('A resolved Minecraft version and absolute client path are required');
  }
  const attemptsLimit = Math.max(1, Math.min(5, Number(maxAttempts) || DEFAULT_ASSET_MAX_ATTEMPTS));
  const startedAt = Date.now();
  const stageHardTimeoutMs = Math.max(1, Number(hardTimeoutMs) || DEFAULT_ASSET_HARD_TIMEOUT_MS);
  const deadlineMs = startedAt + stageHardTimeoutMs;
  const stage = { signal, deadlineMs, clientPath };
  const dispatcher = createDispatcher();
  if (!dispatcher || typeof dispatcher.destroy !== 'function' && typeof dispatcher.close !== 'function') {
    throw new TypeError('A disposable Minecraft asset dispatcher is required');
  }
  const taskOptions = () => {
    assertAssetStageActive(signal, deadlineMs);
    const remainingHardTimeoutMs = Math.max(1, deadlineMs - Date.now());
    return {
      idleTimeoutMs,
      hardTimeoutMs: remainingHardTimeoutMs,
      cancelTimeoutMs,
      signal
    };
  };
  const downloadOptions = { dispatcher };
  const folder = MinecraftFolder.from(clientPath);
  try {
    await prepareSafeAssetStorage(clientPath, {
      needsLogConfig: Boolean(version.logging?.client?.file),
      ...stage
    });
    emitAssetProgress(onProgress, {
      type: 'Preparing',
      task: 'Checking Minecraft asset metadata',
      total: 0,
      current: 0,
      attempt: 0
    });
    if (
      !isSafeAssetFileId(version.assets) ||
      typeof version.assetIndex?.sha1 !== 'string' ||
      !ASSET_HASH.test(version.assetIndex.sha1.toLowerCase())
    ) {
      throw createAssetInstallError(
        'MINECRAFT_ASSET_INDEX_INVALID',
        'Minecraft asset metadata is invalid.'
      );
    }
    const logConfig = version.logging?.client?.file;
    if (logConfig) {
      if (
        typeof logConfig.url !== 'string' || !logConfig.url ||
        !isSafeAssetFileId(logConfig.id) ||
        typeof logConfig.sha1 !== 'string' || !ASSET_HASH.test(logConfig.sha1.toLowerCase())
      ) {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_LOG_CONFIG_INVALID',
          'Minecraft client logging metadata is invalid.'
        );
      }
      try {
        await runBoundedXmclTask(
          createLogConfigTask({
            file: { ...logConfig, sha1: logConfig.sha1.toLowerCase() },
            folder,
            clientPath,
            downloadOptions
          }),
          taskOptions()
        );
      } catch (error) {
        if (
          error?.code === 'MINECRAFT_ASSET_CANCELLED' ||
          error?.code === 'MINECRAFT_ASSET_CANCEL_TIMEOUT'
        ) {
          throw error;
        }
        throw createAssetInstallError(
          'MINECRAFT_ASSET_LOG_CONFIG_FAILED',
          'Minecraft client logging metadata could not be downloaded.'
        );
      }
    }
    try {
      await runBoundedXmclTask(
        createAssetIndexTask({ version, clientPath, downloadOptions }),
        taskOptions()
      );
    } catch (error) {
      if (
        error?.code === 'MINECRAFT_ASSET_CANCELLED' ||
        error?.code === 'MINECRAFT_ASSET_CANCEL_TIMEOUT'
      ) {
        throw error;
      }
      throw createAssetInstallError(
        'MINECRAFT_ASSET_INDEX_DOWNLOAD_FAILED',
        'Minecraft asset metadata could not be downloaded.'
      );
    }

    const assets = await readAssetIndex(clientPath, version, stage);
    await prepareSafeAssetObjectPrefixes(clientPath, assets, stage);
    const totalAssetBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
    let remaining = await inspectAssetObjects(clientPath, assets, stage);
    if (remaining.length === 0) {
      emitAssetProgress(onProgress, {
        type: 'Complete', task: 'Minecraft assets are ready', total: assets.length,
        current: assets.length, attempt: 0
      });
      return { total: assets.length, verified: assets.length, attempts: 0 };
    }

    let attempts = 0;
    while (remaining.length > 0 && attempts < attemptsLimit) {
      attempts += 1;
      if (signal?.aborted) {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_CANCELLED',
          'Minecraft asset preparation was cancelled.'
        );
      }
      await removeInvalidAssetObjects(clientPath, remaining, stage);
      const remainingBytes = remaining.reduce((sum, asset) => sum + asset.size, 0);
      const verifiedBytes = totalAssetBytes - remainingBytes;
      const progressTotal = totalAssetBytes || assets.length;
      const progressCurrent = totalAssetBytes ? verifiedBytes : assets.length - remaining.length;
      const taskLabel = `Downloading ${remaining.length} required Minecraft asset${remaining.length === 1 ? '' : 's'}`;
      emitAssetProgress(onProgress, {
        type: attempts === 1 ? 'Downloading' : 'Retrying',
        task: taskLabel,
        total: progressTotal,
        current: progressCurrent,
        attempt: attempts
      });

      let attemptError = null;
      let lastProgressAt = 0;
      try {
        await runBoundedXmclTask(
          createAssetDownloadTask({
            assets: remaining,
            folder: MinecraftFolder.from(clientPath),
            downloadOptions,
            attempt: attempts
          }),
          {
            ...taskOptions(),
            onProgress: ({ current }) => {
              const now = Date.now();
              if (now - lastProgressAt < 250 && current < remainingBytes) return;
              lastProgressAt = now;
              emitAssetProgress(onProgress, {
                type: attempts === 1 ? 'Downloading' : 'Retrying',
                task: taskLabel,
                total: progressTotal,
                current: totalAssetBytes
                  ? verifiedBytes + Math.min(remainingBytes, current)
                  : progressCurrent,
                attempt: attempts
              });
            }
          }
        );
      } catch (error) {
        attemptError = error;
      }

      if (attemptError?.code === 'MINECRAFT_ASSET_CANCEL_TIMEOUT') {
        throw attemptError;
      }
      remaining = await inspectAssetObjects(clientPath, remaining, stage);
      if (remaining.length === 0) {
        emitAssetProgress(onProgress, {
          type: 'Complete', task: 'Minecraft assets are ready', total: assets.length,
          current: assets.length, attempt: attempts
        });
        return { total: assets.length, verified: assets.length, attempts };
      }
      await removeInvalidAssetObjects(clientPath, remaining, stage);
      if (attemptError?.code === 'MINECRAFT_ASSET_CANCELLED') throw attemptError;
      if (attemptError?.code === 'MINECRAFT_ASSET_HARD_TIMEOUT') {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_HARD_TIMEOUT',
          'Minecraft asset download exceeded its maximum allowed time.'
        );
      }
    }

    throw createAssetInstallError(
      'MINECRAFT_ASSET_DOWNLOAD_FAILED',
      `Minecraft asset download could not verify ${remaining.length} required file${remaining.length === 1 ? '' : 's'} after ${attemptsLimit} attempts.`
    );
  } catch (error) {
    if (error?.name === 'MinecraftAssetInstallError') throw error;
    throw createAssetInstallError(
      'MINECRAFT_ASSET_PREPARATION_FAILED',
      'Minecraft asset preparation could not be completed.'
    );
  } finally {
    await Promise.resolve()
      .then(() => typeof dispatcher.destroy === 'function' ? dispatcher.destroy() : dispatcher.close())
      .catch(() => {});
  }
}

function hasProcessExited(child) {
  return !!child && (child.exitCode !== null && child.exitCode !== undefined ||
    child.signalCode !== null && child.signalCode !== undefined);
}

function isProcessAlive(pid, processKill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    processKill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only definitive "not found" result. Permission and other
    // probe failures must remain conservative so status never reports a live
    // process as stopped.
    return error?.code !== 'ESRCH';
  }
}

function waitForConfirmedProcessExit(child, options = {}) {
  const {
    isProcessAlive: processAlive = isProcessAlive,
    timeoutMs = 5000,
    pollIntervalMs = 100,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = options;
  const pid = child?.pid;

  if (hasProcessExited(child) || !processAlive(pid)) {
    return Promise.resolve(true);
  }

  const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  if (boundedTimeoutMs === 0) {
    return Promise.resolve(false);
  }

  const boundedPollIntervalMs = Math.max(1, Number(pollIntervalMs) || 100);
  const deadline = Date.now() + boundedTimeoutMs;

  return new Promise(resolve => {
    let timer = null;
    let settled = false;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeoutFn(timer);
      }
      child?.removeListener?.('exit', onExit);
      child?.removeListener?.('close', onExit);
    };
    const finish = exited => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exited);
    };
    const onExit = () => finish(true);
    const check = () => {
      if (hasProcessExited(child) || !processAlive(pid)) {
        finish(true);
        return;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        finish(false);
        return;
      }
      timer = setTimeoutFn(check, Math.min(boundedPollIntervalMs, remainingMs));
    };

    child?.once?.('exit', onExit);
    child?.once?.('close', onExit);
    timer = setTimeoutFn(check, Math.min(boundedPollIntervalMs, boundedTimeoutMs));
  });
}

async function stopTrackedProcess(child, options = {}) {
  const {
    isProcessAlive: processAlive = isProcessAlive,
    gracefulTimeoutMs = 5000,
    forceTimeoutMs = 5000,
    pollIntervalMs = 100,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = options;

  if (!child) {
    return { success: true, alreadyExited: true };
  }

  const pid = child.pid;
  if (hasProcessExited(child) || !processAlive(pid)) {
    return { success: true, alreadyExited: true, pid };
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // A failed signal is not an exit confirmation. Continue to the bounded
    // wait and exact-PID force-kill path below.
  }

  const waitOptions = {
    isProcessAlive: processAlive,
    pollIntervalMs,
    setTimeoutFn,
    clearTimeoutFn
  };
  if (await waitForConfirmedProcessExit(child, {
    ...waitOptions,
    timeoutMs: gracefulTimeoutMs
  })) {
    return { success: true, pid };
  }

  try {
    // ChildProcess.kill() targets the retained OS process handle. A delayed
    // PID-only taskkill can race with natural exit and terminate an unrelated
    // process after Windows reuses the numeric PID.
    child.kill('SIGKILL');
  } catch {
    // A signal can race with a natural exit. The follow-up probe decides
    // whether shutdown actually succeeded.
  }

  if (await waitForConfirmedProcessExit(child, {
    ...waitOptions,
    timeoutMs: forceTimeoutMs
  })) {
    return { success: true, pid };
  }

  return {
    success: false,
    error: 'Minecraft process did not exit after termination attempts',
    pid
  };
}

async function fetchMinecraftVersionMetadata(versionId) {
  const response = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  if (!response.ok) {
    throw new Error(`Failed to fetch Minecraft version manifest: ${response.status}`);
  }

  const manifest = await response.json();
  const versionInfo = Array.isArray(manifest?.versions)
    ? manifest.versions.find((entry) => entry.id === versionId)
    : null;

  if (!versionInfo?.url) {
    throw new Error(`Minecraft version metadata not found for ${versionId}`);
  }

  return versionInfo;
}

function mergeVersionArguments(parentArgs, childArgs) {
  const merged = [];
  const append = (value) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      merged.push(entry);
    }
  };
  append(parentArgs);
  append(childArgs);
  return merged;
}

function mergeVersionJson(parentJson, childJson) {
  const parentLibraries = Array.isArray(parentJson?.libraries) ? parentJson.libraries : [];
  const childLibraries = Array.isArray(childJson?.libraries) ? childJson.libraries : [];
  const childLibraryNames = new Set(childLibraries.map((library) => library?.name).filter(Boolean));
  const mergedLibraries = [
    ...parentLibraries.filter((library) => !library?.name || !childLibraryNames.has(library.name)),
    ...childLibraries
  ];

  return {
    ...parentJson,
    ...childJson,
    arguments: {
      jvm: mergeVersionArguments(parentJson?.arguments?.jvm, childJson?.arguments?.jvm),
      game: mergeVersionArguments(parentJson?.arguments?.game, childJson?.arguments?.game)
    },
    downloads: {
      ...(parentJson?.downloads || {}),
      ...(childJson?.downloads || {})
    },
    libraries: mergedLibraries,
    mainClass: childJson?.mainClass || parentJson?.mainClass,
    assetIndex: childJson?.assetIndex || parentJson?.assetIndex,
    javaVersion: childJson?.javaVersion || parentJson?.javaVersion,
    type: childJson?.type || parentJson?.type,
    inheritsFrom: childJson?.inheritsFrom || parentJson?.inheritsFrom,
    jar: childJson?.jar || parentJson?.jar
  };
}

function loadResolvedVersionJson(clientPath, versionId, visited = new Set()) {
  if (!versionId || visited.has(versionId)) {
    return null;
  }

  visited.add(versionId);
  const versionJsonPath = path.join(clientPath, 'versions', versionId, `${versionId}.json`);
  if (!fs.existsSync(versionJsonPath)) {
    return null;
  }

  const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
  if (!versionJson?.inheritsFrom) {
    return versionJson;
  }

  const parentJson = loadResolvedVersionJson(clientPath, versionJson.inheritsFrom, visited);
  if (!parentJson) {
    return versionJson;
  }

  return mergeVersionJson(parentJson, versionJson);
}

function resolveExistingLoaderProfile(clientPath, minecraftVersion, loaderType, loaderVersion) {
  const versionsDir = path.join(clientPath, 'versions');
  if (!fs.existsSync(versionsDir)) {
    return null;
  }

  const versionDirs = fs.readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const normalizedLoader = normalizeLoader(loaderType);
  if (normalizedLoader === 'vanilla') {
    return versionDirs.includes(minecraftVersion) ? minecraftVersion : null;
  }

  if (normalizedLoader === 'forge') {
    const exactCandidates = [
      loaderVersion ? `${minecraftVersion}-forge-${loaderVersion}` : null,
      loaderVersion ? `forge-${minecraftVersion}-${loaderVersion}` : null
    ].filter(Boolean);
    for (const candidate of exactCandidates) {
      if (versionDirs.includes(candidate)) {
        return candidate;
      }
    }

    const prefix = `${minecraftVersion}-forge-`;
    const matches = versionDirs.filter((name) => name.startsWith(prefix));
    if (matches.length === 0) {
      return null;
    }

    if (loaderVersion) {
      const exactMatch = matches.find((name) => name === `${minecraftVersion}-forge-${loaderVersion}`);
      if (exactMatch) {
        return exactMatch;
      }
      const suffixMatch = matches.find((name) => name.includes(`-${loaderVersion}`));
      if (suffixMatch) {
        return suffixMatch;
      }
    }

    return matches.sort().reverse()[0] || null;
  }

  if (normalizedLoader === 'fabric') {
    const exactCandidates = [
      loaderVersion ? `fabric-loader-${loaderVersion}-${minecraftVersion}` : null,
      loaderVersion ? `${minecraftVersion}-fabric-${loaderVersion}` : null,
      loaderVersion ? `${minecraftVersion}-fabric${loaderVersion}` : null
    ].filter(Boolean);
    for (const candidate of exactCandidates) {
      if (versionDirs.includes(candidate)) {
        return candidate;
      }
    }

    const matches = versionDirs.filter((name) =>
      (name.startsWith('fabric-loader-') && name.endsWith(`-${minecraftVersion}`)) ||
      name.startsWith(`${minecraftVersion}-fabric`)
    );
    if (matches.length === 0) {
      return null;
    }

    if (loaderVersion) {
      const exactMatch = matches.find((name) => name === `fabric-loader-${loaderVersion}-${minecraftVersion}`);
      if (exactMatch) {
        return exactMatch;
      }
      const canonicalXmclMatch = matches.find((name) => name === `${minecraftVersion}-fabric${loaderVersion}`);
      if (canonicalXmclMatch) {
        return canonicalXmclMatch;
      }
      const middleMatch = matches.find((name) => name.includes(`-${loaderVersion}-`));
      if (middleMatch) {
        return middleMatch;
      }
    }

    return matches.sort().reverse()[0] || null;
  }

  return null;
}

function resolveLibraryArtifactPath(library) {
  if (!library || typeof library !== 'object') {
    return null;
  }

  if (typeof library.downloads?.artifact?.path === 'string' && library.downloads.artifact.path.trim()) {
    return library.downloads.artifact.path;
  }

  if (typeof library.name === 'string' && library.name.trim()) {
    try {
      return LibraryInfo.resolve(library.name).path;
    } catch {
      return null;
    }
  }

  return null;
}

function replaceLaunchPlaceholders(value, replacements) {
  let result = value;
  for (const [token, replacement] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\$\\{${token}\\}`, 'g'), () => String(replacement));
  }
  return result;
}

function normalizeOsName() {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'osx';
    case 'linux':
      return 'linux';
    default:
      return process.platform;
  }
}

function isRuleMatch(rule = {}, featureState = {}) {
  if (!rule || typeof rule !== 'object') {
    return true;
  }

  if (rule.os && typeof rule.os === 'object') {
    if (rule.os.name && String(rule.os.name).toLowerCase() !== normalizeOsName()) {
      return false;
    }

    if (rule.os.arch) {
      const expectedArch = String(rule.os.arch).toLowerCase();
      const currentArch = process.arch === 'x64' ? 'x86_64' : process.arch.toLowerCase();
      if (expectedArch !== currentArch && expectedArch !== process.arch.toLowerCase()) {
        return false;
      }
    }
  }

  if (rule.features && typeof rule.features === 'object') {
    for (const [featureName, expectedValue] of Object.entries(rule.features)) {
      if (Boolean(featureState[featureName]) !== Boolean(expectedValue)) {
        return false;
      }
    }
  }

  return true;
}

function shouldIncludeArgument(entry, featureState = {}) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.rules) || entry.rules.length === 0) {
    return true;
  }

  let allowed = false;
  for (const rule of entry.rules) {
    const action = rule && typeof rule.action === 'string' ? rule.action.toLowerCase() : 'allow';
    if (isRuleMatch(rule, featureState)) {
      allowed = action === 'allow';
    }
  }

  return allowed;
}

function expandVersionArguments(entries, replacements, featureState = {}) {
  const expanded = [];
  if (!Array.isArray(entries)) {
    return expanded;
  }

  const appendValue = (value) => {
    if (typeof value === 'string' && value.length > 0) {
      expanded.push(replaceLaunchPlaceholders(value, replacements));
    }
  };

  for (const entry of entries) {
    if (typeof entry === 'string') {
      appendValue(entry);
      continue;
    }

    if (!entry || typeof entry !== 'object' || !shouldIncludeArgument(entry, featureState)) {
      continue;
    }

    if (Array.isArray(entry.value)) {
      for (const value of entry.value) {
        appendValue(value);
      }
      continue;
    }

    appendValue(entry.value);
  }

  return expanded;
}

function createServerLaunchTarget(serverIp, serverPort) {
  const rawHost = typeof serverIp === 'string' ? serverIp.trim() : '';
  const rawPort = typeof serverPort === 'string' || typeof serverPort === 'number'
    ? String(serverPort).trim()
    : '';
  if (!rawHost || !/^[0-9]{1,5}$/u.test(rawPort)) {
    return null;
  }

  const portNumber = Number(rawPort);
  if (portNumber < 1 || portNumber > 65535) {
    return null;
  }

  const hasOpeningBracket = rawHost.startsWith('[');
  const hasClosingBracket = rawHost.endsWith(']');
  if (hasOpeningBracket !== hasClosingBracket) {
    return null;
  }
  const host = hasOpeningBracket
    ? rawHost.slice(1, -1)
    : rawHost;
  if (!host) {
    return null;
  }

  const port = String(portNumber);
  const quickPlayHost = host.includes(':') ? `[${host}]` : host;
  return {
    host,
    port,
    quickPlayMultiplayer: `${quickPlayHost}:${port}`
  };
}

function appendServerLaunchFallback(gameArgs, serverTarget) {
  if (!serverTarget || gameArgs.includes('--quickPlayMultiplayer')) {
    return gameArgs;
  }

  gameArgs.push('--server', serverTarget.host, '--port', serverTarget.port);
  return gameArgs;
}

function buildLaunchReplacements({
  authData,
  clientPath,
  launchJson,
  launchVersion,
  minecraftVersion,
  nativesDir,
  classpathSeparator,
  classpathValue,
  quickPlayMultiplayer = ''
}) {
  return {
    auth_playerName: authData?.name || '',
    auth_player_name: authData?.name || '',
    auth_uuid: authData?.uuid || '',
    auth_xuid: authData?.xuid || '',
    auth_accessToken: authData?.access_token || '',
    auth_access_token: authData?.access_token || '',
    auth_session: authData?.access_token || '',
    auth_userType: 'msa',
    auth_user_type: 'msa',
    user_type: 'msa',
    clientid: authData?.client_token || authData?.clientToken || '',
    user_properties: '{}',
    version_name: launchVersion,
    game_directory: clientPath,
    assets_root: path.join(clientPath, 'assets'),
    assets_index_name: launchJson?.assetIndex?.id || minecraftVersion,
    version_type: launchJson?.type || 'release',
    launcher_name: 'minecraft-core',
    launcher_version: '1.0.0',
    natives_directory: nativesDir,
    library_directory: path.join(clientPath, 'libraries'),
    classpath_separator: classpathSeparator,
    classpath: classpathValue,
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer,
    quickPlayRealms: '',
    resolution_width: '',
    resolution_height: ''
  };
}

function ensureIgnoredJarInJvmArgs(versionJvmArgs, jarPath) {
  if (!jarPath || !fs.existsSync(jarPath)) {
    return versionJvmArgs;
  }

  const jarName = path.basename(jarPath);
  return versionJvmArgs.map((arg) => {
    if (typeof arg !== 'string' || !arg.startsWith('-DignoreList=')) {
      return arg;
    }

    const prefix = '-DignoreList=';
    const existingEntries = arg.slice(prefix.length)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (!existingEntries.includes(jarName)) {
      existingEntries.push(jarName);
    }

    return `${prefix}${existingEntries.join(',')}`;
  });
}

function appendProcessOutput(buffer, chunk, limit = 16000) {
  const next = `${buffer}${chunk}`;
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function readTextFileIfExists(filePath) {
  if (!filePath) {
    return '';
  }

  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }

    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function findNewestMatchingFile(directoryPath, matcher) {
  try {
    if (!directoryPath || !fs.existsSync(directoryPath)) {
      return null;
    }

    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && matcher(entry.name))
      .map((entry) => {
        const filePath = path.join(directoryPath, entry.name);
        const stats = fs.statSync(filePath);
        return {
          filePath,
          mtimeMs: stats.mtimeMs || 0
        };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    return entries[0]?.filePath || null;
  } catch {
    return null;
  }
}

function extractTailLines(text, lineCount = 12) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lineCount);
}

function parseForgeDependencyDiagnostics(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const matches = Array.from(text.matchAll(
    /Mod ID:\s*'([^']+)'.*?Requested by:\s*'([^']+)'.*?Expected range:\s*'([^']+)'.*?Actual version:\s*'([^']+)'/gsi
  ));

  if (matches.length === 0) {
    return null;
  }

  const details = matches.map((match) => ({
    dependencyId: match[1],
    requestedBy: match[2],
    expectedRange: match[3],
    actualVersion: match[4],
    message: `${match[2]} requires ${match[1]} ${match[3]}, found ${match[4]}`
  }));

  const first = details[0];
  return {
    kind: 'forge_dependency_error',
    summary: `${first.requestedBy} requires ${first.dependencyId} ${first.expectedRange}, but ${first.actualVersion} is installed`,
    details,
    source: 'latest.log'
  };
}

function parseForgeLaunchDiagnostics(sources) {
  const orderedSources = [
    { name: 'latest.log', text: sources.latestLog || '' },
    { name: 'debug.log', text: sources.debugLog || '' },
    { name: 'crash-report', text: sources.crashReport || '' },
    { name: 'fml-report', text: sources.fmlReport || '' },
    { name: 'hs_err', text: sources.hsErr || '' }
  ];

  for (const source of orderedSources) {
    const dependencyDiagnostics = parseForgeDependencyDiagnostics(source.text);
    if (dependencyDiagnostics) {
      return {
        ...dependencyDiagnostics,
        source: source.name
      };
    }
  }

  for (const source of orderedSources) {
    const tailLines = extractTailLines(source.text);
    if (tailLines.length > 0) {
      return {
        kind: 'log_excerpt',
        summary: tailLines[tailLines.length - 1],
        details: tailLines.map((line) => ({ message: line })),
        source: source.name
      };
    }
  }

  return null;
}

function collectLaunchDiagnostics(clientPath) {
  const logsDir = path.join(clientPath, 'logs');
  const crashReportsDir = path.join(clientPath, 'crash-reports');
  const latestLogPath = path.join(logsDir, 'latest.log');
  const debugLogPath = path.join(logsDir, 'debug.log');
  const crashReportPath = findNewestMatchingFile(crashReportsDir, (name) => /\.txt$/i.test(name));
  const fmlReportPath = findNewestMatchingFile(clientPath, (name) => /^fml.*\.txt$/i.test(name));
  const hsErrPath = findNewestMatchingFile(clientPath, (name) => /^hs_err.*\.(?:log|txt)$/i.test(name));

  const parsed = parseForgeLaunchDiagnostics({
    latestLog: readTextFileIfExists(latestLogPath),
    debugLog: readTextFileIfExists(debugLogPath),
    crashReport: readTextFileIfExists(crashReportPath),
    fmlReport: readTextFileIfExists(fmlReportPath),
    hsErr: readTextFileIfExists(hsErrPath)
  });

  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    latestLogPath: fs.existsSync(latestLogPath) ? latestLogPath : null,
    debugLogPath: fs.existsSync(debugLogPath) ? debugLogPath : null,
    crashReportPath,
    fmlReportPath,
    hsErrPath
  };
}

class ProperMinecraftLauncher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.isLaunching = false;
    this.client = null;
    this.authData = null;
    this.clientPath = null;
    this._isProcessAlive = options.isProcessAlive || isProcessAlive;
    this._stopTrackedProcess = options.stopTrackedProcess || stopTrackedProcess;
    this._stopOptions = options.stopOptions || {};
    this._installMinecraftAssets = options.installMinecraftAssets || installMinecraftAssetsWithRetry;
    this._assetInstallOptions = options.assetInstallOptions || {};
    this._getLoaderVersions = options.getLoaderVersions || getLoaderVersions;
    this._installClientLoader = options.installClientLoader || installClientLoader;
    this._installLibrariesTask = options.installLibrariesTask || installLibrariesTask;
    this._spawn = options.spawn || spawn;
    // Main-owned constructor authority only; never read hooks from launch IPC options.
    this._beginManagedLaunch = options.beginManagedLaunch || null;
    this._activeLaunchAttempt = null;
    this._launchPreparationStopTimeoutMs = Math.max(1, Number(options.launchPreparationStopTimeoutMs) || 15_000);
  }

  _finalizeTrackedClient(trackedClient) {
    if (!trackedClient || this.client !== trackedClient) {
      return false;
    }
    this.isLaunching = false;
    this.client = null;
    this.emit('minecraft-stopped');
    return true;
  }

  _handleTrackedProcessError(trackedClient) {
    if (!trackedClient?.child || trackedClient !== this.client) {
      return false;
    }
    try {
      if (!hasProcessExited(trackedClient.child) && this._isProcessAlive(trackedClient.child.pid)) {
        return false;
      }
    } catch {
      return false;
    }
    return this._finalizeTrackedClient(trackedClient);
  }

  setAuthData(authData) {
    this.authData = authData;
  }

  async ensureMinecraftClient(clientPath, version, options = {}) {
    this.clientPath = clientPath;

    const versionsDir = path.join(clientPath, 'versions');
    const librariesDir = path.join(clientPath, 'libraries');
    const assetsDir = path.join(clientPath, 'assets');

    for (const dir of [versionsDir, librariesDir, assetsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const versionManifestEntry = await fetchMinecraftVersionMetadata(version);
    await installVersion(versionManifestEntry, clientPath, {
      side: 'client'
    });

    const versionJsonPath = path.join(versionsDir, version, `${version}.json`);
    if (!fs.existsSync(versionJsonPath)) {
      throw new Error(`Version JSON not found after installation: ${versionJsonPath}`);
    }

    const installableVersion = await Version.parse(MinecraftFolder.from(clientPath), version);
    installableVersion.minecraftDirectory = clientPath;
    const installOptions = {
      minecraftDirectory: clientPath
    };

    await installLibraries(installableVersion, installOptions);
    await this._installMinecraftAssets({
      ...this._assetInstallOptions,
      version: installableVersion,
      clientPath,
      signal: options.signal,
      onProgress: event => this.emit('launch-progress', event)
    });

    return { success: true };
  }

  async launchMinecraft(options, managedReservation = undefined) {
    let launchAttempt = null;
    let launchReservation = managedReservation;
    let childSpawned = false;
    try {
      let {
        clientPath,
        minecraftVersion,
        serverIp,
        serverPort,
        maxMemory = 4096,
        loaderType = 'vanilla',
        loaderVersion = null,
        javaPath = null,
        showDebugTerminal = false
      } = options;

      if (this.isLaunching) {
        throw new Error('Minecraft is already launching');
      }

      if (!this.authData) {
        throw new Error('No authentication data available');
      }

      this.isLaunching = true;
      launchAttempt = createLaunchAttempt();
      this._activeLaunchAttempt = launchAttempt;
      if (managedReservation === undefined && this._beginManagedLaunch) {
        launchReservation = await this._beginManagedLaunch({ clientPath });
      }
      options = require('../client-modpacks/client-pack-launch-options.cjs').managedLaunchOptions(options, launchReservation);
      ({ clientPath, minecraftVersion, serverIp, serverPort, maxMemory = 4096, loaderType = 'vanilla',
        loaderVersion = null, javaPath = null, showDebugTerminal = false } = options);
      assertAssetStageActive(launchAttempt.controller.signal);
      if (!launchReservation?.authority) await this.ensureMinecraftClient(clientPath, minecraftVersion, {
        signal: launchAttempt.controller.signal
      });
      if (launchAttempt.controller.signal.aborted) {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_CANCELLED',
          'Minecraft asset preparation was cancelled.'
        );
      }

      const normalizedLoader = normalizeLoader(loaderType);
      let effectiveLoaderVersion = loaderVersion;
      if (
        !launchReservation?.authority && normalizedLoader !== 'vanilla' &&
        (!effectiveLoaderVersion || String(effectiveLoaderVersion).trim().toLowerCase() === 'latest')
      ) {
        const availableVersions = await this._getLoaderVersions(normalizedLoader, minecraftVersion);
        if (launchAttempt.controller.signal.aborted) {
          throw createAssetInstallError(
            'MINECRAFT_ASSET_CANCELLED',
            'Minecraft asset preparation was cancelled.'
          );
        }
        effectiveLoaderVersion = availableVersions[0] || effectiveLoaderVersion;
      }

      let launchVersion = launchReservation?.authority?.profileId || minecraftVersion;
      if (!launchReservation?.authority && normalizedLoader !== 'vanilla') {
        const existingProfileId = resolveExistingLoaderProfile(
          clientPath,
          minecraftVersion,
          normalizedLoader,
          effectiveLoaderVersion
        );

        if (existingProfileId) {
          launchVersion = existingProfileId;
        } else {
          const loaderResult = await this._installClientLoader({
            clientPath,
            minecraftVersion,
            loader: normalizedLoader,
            loaderVersion: effectiveLoaderVersion,
            javaPath
          });

          launchVersion = loaderResult.profileId ||
            resolveExistingLoaderProfile(clientPath, minecraftVersion, normalizedLoader, effectiveLoaderVersion) ||
            minecraftVersion;
        }
      }
      if (launchAttempt.controller.signal.aborted) {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_CANCELLED',
          'Minecraft asset preparation was cancelled.'
        );
      }

      if (!launchReservation?.authority && normalizedLoader !== 'vanilla') {
        const resolvedLoaderVersion = await Version.parse(
          MinecraftFolder.from(clientPath),
          launchVersion
        );
        resolvedLoaderVersion.minecraftDirectory = clientPath;
        const loaderLibrariesTask = this._installLibrariesTask(resolvedLoaderVersion);
        await runBoundedXmclTask(loaderLibrariesTask, {
          ...this._assetInstallOptions,
          signal: launchAttempt.controller.signal
        });
      }
      if (launchAttempt.controller.signal.aborted) {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_CANCELLED',
          'Minecraft asset preparation was cancelled.'
        );
      }

      const launchJson = loadResolvedVersionJson(clientPath, launchVersion);
      if (!launchJson) {
        throw new Error(`Launch profile not found: ${launchVersion}`);
      }

      const classpathEntries = [];
      const classpathSet = new Set();
      const addClasspathEntry = (entryPath) => {
        if (!entryPath || !fs.existsSync(entryPath) || classpathSet.has(entryPath)) {
          return;
        }
        classpathSet.add(entryPath);
        classpathEntries.push(entryPath);
      };

      const primaryVersionId = launchJson.jar || launchJson.inheritsFrom || minecraftVersion;
      const launchVersionJar = path.join(clientPath, 'versions', launchVersion, `${launchVersion}.jar`);
      const primaryVersionJar = path.join(clientPath, 'versions', primaryVersionId, `${primaryVersionId}.jar`);
      addClasspathEntry(launchVersionJar);
      addClasspathEntry(primaryVersionJar);

      const launchLibraries = Array.isArray(launchJson.libraries) ? launchJson.libraries : [];
      for (const library of launchLibraries) {
        const artifactPath = resolveLibraryArtifactPath(library);
        if (!artifactPath) {
          continue;
        }
        addClasspathEntry(path.join(clientPath, 'libraries', artifactPath));
      }

      if (classpathEntries.length === 0) {
        throw new Error(`No launch classpath entries were resolved for ${launchVersion}`);
      }

      const nativesDir = path.join(clientPath, 'versions', launchVersion, 'natives');
      if (!fs.existsSync(nativesDir)) {
        fs.mkdirSync(nativesDir, { recursive: true });
      }

      const classpathSeparator = process.platform === 'win32' ? ';' : ':';
      const classpathValue = classpathEntries.join(classpathSeparator);
      const serverTarget = createServerLaunchTarget(serverIp, serverPort);
      const featureState = {
        is_demo_user: false,
        has_custom_resolution: false,
        has_quick_plays_support: false,
        is_quick_play_singleplayer: false,
        is_quick_play_multiplayer: Boolean(serverTarget),
        is_quick_play_realms: false
      };
      const replacements = buildLaunchReplacements({
        authData: this.authData,
        clientPath,
        launchJson,
        launchVersion,
        minecraftVersion,
        nativesDir,
        classpathSeparator,
        classpathValue,
        quickPlayMultiplayer: serverTarget?.quickPlayMultiplayer || ''
      });

      let versionJvmArgs = expandVersionArguments(launchJson.arguments?.jvm, replacements, featureState);
      if (launchVersion !== primaryVersionId) {
        versionJvmArgs = ensureIgnoredJarInJvmArgs(versionJvmArgs, primaryVersionJar);
      }
      const versionProvidesClasspath = versionJvmArgs.some((arg, index) =>
        (arg === '-cp' || arg === '-classpath') && typeof versionJvmArgs[index + 1] === 'string'
      );

      const jvmArgs = [
        `-Xmx${maxMemory}M`,
        '-Xms1024M',
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+DisableExplicitGC',
        '-XX:+AlwaysPreTouch',
        '-XX:G1NewSizePercent=30',
        '-XX:G1MaxNewSizePercent=40',
        '-XX:G1HeapRegionSize=8M',
        '-XX:G1ReservePercent=20',
        '-XX:G1HeapWastePercent=5',
        '-XX:G1MixedGCCountTarget=4',
        '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1RSetUpdatingPauseTimePercent=5',
        '-XX:SurvivorRatio=32',
        '-XX:+PerfDisableSharedMem',
        '-XX:MaxTenuringThreshold=1',
        `-Djava.library.path=${nativesDir}`
      ];

      if (!versionProvidesClasspath) {
        jvmArgs.push('-cp', classpathValue);
      }

      jvmArgs.push(...versionJvmArgs);

      const gameArgs = expandVersionArguments(launchJson.arguments?.game, replacements, featureState);

      if (gameArgs.length === 0 && typeof launchJson.minecraftArguments === 'string') {
        for (const arg of launchJson.minecraftArguments.split(/\s+/).filter(Boolean)) {
          gameArgs.push(replaceLaunchPlaceholders(arg, replacements));
        }
      }

      if (!gameArgs.includes('--username')) {
        gameArgs.push(
          '--username', this.authData.name || '',
          '--version', launchVersion,
          '--gameDir', clientPath,
          '--assetsDir', path.join(clientPath, 'assets'),
          '--assetIndex', launchJson.assetIndex?.id || minecraftVersion,
          '--uuid', this.authData.uuid || '',
          '--accessToken', this.authData.access_token || '',
          '--userType', 'msa',
          '--versionType', launchJson.type || 'release',
          '--userProperties', '{}'
        );
      }

      appendServerLaunchFallback(gameArgs, serverTarget);

      const javaCommand = javaPath || (process.platform === 'win32' ? 'javaw' : 'java');
      let debugJavaPath = javaCommand;
      const allArgs = [
        ...jvmArgs,
        launchJson.mainClass || 'net.minecraft.client.main.Main',
        ...gameArgs
      ];

      const spawnOptions = {
        cwd: clientPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      };

      let debugWindow = null;
      if (showDebugTerminal) {
        if (process.platform === 'win32') {
          debugJavaPath = launchReservation?.authority ? javaCommand : javaCommand.replace(/javaw\.exe$/i, 'java.exe');
          spawnOptions.windowsHide = true;
        }

        try {
          const { BrowserWindow } = require('electron');
          debugWindow = new BrowserWindow({
            width: 800,
            height: 500,
            title: `Minecraft Debug Console - ${launchVersion}`,
            backgroundColor: '#1a1a1a',
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              preload: path.join(__dirname, '../../preload.cjs'),
              sandbox: true
            },
            icon: path.join(__dirname, '../../icon.png'),
            show: false,
            resizable: true,
            minimizable: true,
            maximizable: true
          });

          debugWindow.loadFile(path.join(__dirname, '../../debug-console.html'));
          debugWindow.once('ready-to-show', () => {
            debugWindow.show();
            if (debugWindow && !debugWindow.isDestroyed()) {
              debugWindow.webContents.send('debug-log', {
                type: 'header',
                message: `========================================
MINECRAFT DEBUG CONSOLE
========================================

Java Executable: ${debugJavaPath}
Working Directory: ${clientPath}
Launch Version: ${launchVersion}

========================================
Starting Minecraft with console output...
========================================
`
              });
            }
          });
        } catch {
          debugWindow = null;
        }
      }

      if (launchAttempt.controller.signal.aborted) {
        throw createAssetInstallError(
          'MINECRAFT_ASSET_CANCELLED',
          'Minecraft asset preparation was cancelled.'
        );
      }
      if (launchReservation) {
        // The main-issued marker must be a JVM argument, not a game argument.
        allArgs.splice(jvmArgs.length, 0, launchReservation.jvmArgument);
      }
      const child = this._spawn(showDebugTerminal ? debugJavaPath : javaCommand, allArgs, spawnOptions);
      childSpawned = true;
      const trackedClient = { child, launchToken: launchAttempt.token };
      launchAttempt.client = trackedClient;
      this.client = trackedClient;
      if (this._activeLaunchAttempt === launchAttempt) {
        this._activeLaunchAttempt = null;
      }
      launchAttempt.settlePreSpawn({ success: true, client: trackedClient });
      if (!showDebugTerminal) {
        child.unref();
      } else if (debugWindow) {
        this.debugWindow = debugWindow;
        debugWindow.on('closed', () => {
          this.debugWindow = null;
        });
      }

      let launchStdout = '';
      let launchStderr = '';
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        launchStdout = appendProcessOutput(launchStdout, text);
        if (debugWindow && !debugWindow.isDestroyed()) {
          debugWindow.webContents.send('debug-log', {
            type: 'info',
            message: text
          });
        }
      });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        launchStderr = appendProcessOutput(launchStderr, text);
        if (debugWindow && !debugWindow.isDestroyed()) {
          debugWindow.webContents.send('debug-log', {
            type: 'error',
            message: text
          });
        }
      });

      child.on('close', () => {
        if (debugWindow && !debugWindow.isDestroyed()) {
          debugWindow.webContents.send('debug-log', {
            type: child.exitCode === 0 ? 'success' : 'error',
            message: `\n========================================\nMinecraft process ended with code: ${child.exitCode}\n========================================\n`
          });
        }
        this._finalizeTrackedClient(trackedClient);
      });

      child.on('error', () => {
        this._handleTrackedProcessError(trackedClient);
      });

      if (launchReservation) await launchReservation.attach(child);

      await new Promise((resolve) => setTimeout(resolve, 3000));

      if (child.killed || child.exitCode !== null) {
        const combinedOutput = `${launchStdout}\n${launchStderr}`.trim();
        const outputSuffix = combinedOutput
          ? `\n${combinedOutput.slice(-4000)}`
          : '';
        const diagnostics = collectLaunchDiagnostics(clientPath);

        return {
          success: false,
          error: `Minecraft failed to start. Exit code: ${child.exitCode}${outputSuffix}`,
          message: `Failed to launch Minecraft: process exited early with code ${child.exitCode}`,
          diagnostics
        };
      }

      return {
        success: true,
        message: `Minecraft ${launchVersion} launched successfully with XMCL`,
        pid: child.pid,
        version: launchVersion,
        vanillaVersion: minecraftVersion,
        loaderType: normalizedLoader,
        loaderVersion: effectiveLoaderVersion
      };
    } catch (error) {
      if (launchReservation && !childSpawned && error?.code !== 'MINECRAFT_ASSET_CANCEL_TIMEOUT') {
        try { await launchReservation.abortBeforeSpawn(); }
        catch (settlementError) { error = settlementError; }
      }
      if (launchAttempt) {
        const ownsAttempt = this._activeLaunchAttempt === launchAttempt;
        const ownsClient = Boolean(launchAttempt.client) && this.client === launchAttempt.client;
        const cancellationUnconfirmed = error?.code === 'MINECRAFT_ASSET_CANCEL_TIMEOUT';
        if (ownsAttempt && !cancellationUnconfirmed) this._activeLaunchAttempt = null;
        if (launchReservation && childSpawned && ownsClient) {
          // Publication/query failure after spawn is not process exit. Keep the
          // exact retained child available for normal stop, while its guard holds.
          this.isLaunching = true;
        } else if (ownsAttempt && cancellationUnconfirmed) {
          this.isLaunching = true;
          this.client = null;
        } else if (ownsAttempt || ownsClient) {
          this.isLaunching = false;
          if (!launchAttempt.client || ownsClient) this.client = null;
        }
        launchAttempt.settlePreSpawn({ success: false, error });
      }
      const diagnostics = this.clientPath ? collectLaunchDiagnostics(this.clientPath) : null;

      return {
        success: false,
        error: error.message,
        message: `Failed to launch Minecraft: ${error.message}`,
        diagnostics
      };
    }
  }

  async stopMinecraft() {
    const trackedClient = this.client;
    if (!trackedClient?.child) {
      const launchAttempt = this._activeLaunchAttempt;
      if (launchAttempt) {
        let preparationOutcome = null;
        const observedPreparation = launchAttempt.preSpawnSettled.then(outcome => {
          preparationOutcome = outcome;
        });
        launchAttempt.controller.abort();
        const settled = await waitForSettlementWithin(
          observedPreparation,
          this._launchPreparationStopTimeoutMs
        );
        if (!settled || preparationOutcome?.error?.code === 'MINECRAFT_ASSET_CANCEL_TIMEOUT') {
          return {
            success: false,
            error: 'Minecraft launch preparation could not be cancelled safely'
          };
        }
      }
      if (!this._activeLaunchAttempt && !this.client) this.isLaunching = false;
      return {
        success: true,
        message: 'Minecraft process cleanup completed (no active process found)'
      };
    }

    let result;
    try {
      result = await this._stopTrackedProcess(trackedClient.child, {
        ...this._stopOptions,
        isProcessAlive: this._isProcessAlive
      });
    } catch (error) {
      result = { success: false, error: error.message };
    }

    if (!result?.success) {
      return {
        success: false,
        error: result?.error || 'Minecraft process exit could not be confirmed'
      };
    }

    this._finalizeTrackedClient(trackedClient);
    return { success: true, message: 'Minecraft stopped' };
  }

  getStatus() {
    let isRunning = false;
    if (this.client?.child) {
      try {
        const trackedClient = this.client;
        if (hasProcessExited(trackedClient.child) || !this._isProcessAlive(trackedClient.child.pid)) {
          this._finalizeTrackedClient(trackedClient);
        } else {
          isRunning = true;
        }
      } catch {
        // An inconclusive process probe must not report a live tracked client
        // as stopped. Only an exit event or a definitive ESRCH clears state.
        isRunning = true;
      }
    }

    return {
      isAuthenticated: !!this.authData,
      isLaunching: this.isLaunching,
      isRunning,
      username: this.authData?.name || null,
      clientPath: this.clientPath
    };
  }
}

module.exports = {
  ProperMinecraftLauncher,
  appendServerLaunchFallback,
  buildLaunchReplacements,
  collectLaunchDiagnostics,
  createServerLaunchTarget,
  expandVersionArguments,
  installMinecraftAssetsWithRetry,
  isProcessAlive,
  parseForgeLaunchDiagnostics,
  replaceLaunchPlaceholders,
  runBoundedXmclTask,
  stopTrackedProcess,
  waitForSettlementWithin,
  waitForConfirmedProcessExit
};
