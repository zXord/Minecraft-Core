const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const CACHE_DIRECTORY_NAME = 'dev-electron-runtime';
const MARKER_FILENAME = '.minecraft-core-runtime.json';
const RUNTIME_PREFIX = 'runtime-';
const STAGING_PREFIX = '.staging-';
const LOCK_PREFIX = '.lock-';
const LOCK_OWNER_FILENAME = 'owner.json';
const LOCK_CANDIDATE_PREFIX = '.lock-candidate-';
const LOCK_QUARANTINE_PREFIX = '.quarantined-lock-';
const LEASE_PREFIX = '.lease-';
const STALE_RUNTIME_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_LEASE_AGE_MS = 5 * 60 * 1000;
const ORPHAN_LOCK_GRACE_MS = 5 * 1000;
const LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const LOCK_RETRY_MS = 50;

async function digestFile(filePath) {
  const digest = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on('data', chunk => digest.update(chunk));
    input.once('end', resolve);
    input.once('error', reject);
  });
  return digest.digest('hex');
}

function safeSegment(value, fallback) {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/gu, '-');
  return normalized || fallback;
}

async function assertRegularFile(filePath, label) {
  const stats = await fsPromises.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
    throw new TypeError(`${label} must be one non-empty regular file`);
  }
  return stats;
}

function expectedMarker({ electronVersion, architecture, sourceDigest, iconDigest }) {
  return Object.freeze({
    schemaVersion: 1,
    electronVersion,
    architecture,
    sourceDigest,
    iconDigest
  });
}

async function isReusableRuntime(cacheDirectory, marker) {
  try {
    const markerPath = path.join(cacheDirectory, MARKER_FILENAME);
    const parsed = JSON.parse(await fsPromises.readFile(markerPath, 'utf8'));
    const expectedKeys = [...Object.keys(marker), 'patchedExecutableDigest'].sort();
    if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys)) return false;
    for (const [key, value] of Object.entries(marker)) {
      if (parsed[key] !== value) return false;
    }
    if (!/^[a-f0-9]{64}$/u.test(parsed.patchedExecutableDigest)) return false;
    const executablePath = path.join(cacheDirectory, 'electron.exe');
    await assertRegularFile(executablePath, 'Cached Electron executable');
    if (await digestFile(executablePath) !== parsed.patchedExecutableDigest) return false;
    return true;
  } catch {
    return false;
  }
}

async function touchPublishedRuntime(cacheDirectory) {
  try {
    const now = new Date();
    await fsPromises.utimes(path.join(cacheDirectory, MARKER_FILENAME), now, now);
  } catch {
    // Cache reuse remains valid when an optional last-used timestamp cannot be updated.
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function quarantineStaleLock(lockDirectory, cacheRoot, cacheKey, {
  now = Date.now(),
  randomUUID = crypto.randomUUID,
  processAlive = isProcessAlive
} = {}) {
  let stats;
  let owner = null;
  try {
    try {
      const ownerPath = path.join(lockDirectory, LOCK_OWNER_FILENAME);
      owner = JSON.parse(await fsPromises.readFile(ownerPath, 'utf8'));
      stats = await fsPromises.lstat(ownerPath);
    } catch {
      stats = await fsPromises.lstat(lockDirectory);
    }
  } catch {
    return true;
  }
  const age = now - stats.mtimeMs;
  if (!Number.isFinite(age) || age < ORPHAN_LOCK_GRACE_MS) return false;
  const ownerAlive = processAlive(owner?.pid);
  // Never steal a lock from a live process. A build can legitimately take a
  // long time on a busy or synced drive; age alone must not permit a second
  // builder to remove or replace its just-published runtime.
  if (ownerAlive) return false;

  const quarantineDirectory = path.join(
    cacheRoot,
    `${LOCK_QUARANTINE_PREFIX}${cacheKey}-${randomUUID()}`
  );
  try {
    await fsPromises.rename(lockDirectory, quarantineDirectory);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) return true;
    return false;
  }
  try {
    await fsPromises.rm(quarantineDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch {
    // The quarantined lock can no longer block this cache key.
  }
  return true;
}

async function tryPublishCacheKeyLock(cacheRoot, cacheKey, token) {
  const lockDirectory = path.join(cacheRoot, `${LOCK_PREFIX}${cacheKey}`);
  const candidateDirectory = path.join(
    cacheRoot,
    `${LOCK_CANDIDATE_PREFIX}${cacheKey}-${token}`
  );
  await fsPromises.mkdir(candidateDirectory);
  let published = false;
  try {
    await fsPromises.writeFile(path.join(candidateDirectory, LOCK_OWNER_FILENAME), JSON.stringify({
      pid: process.pid,
      token
    }), { encoding: 'utf8', flag: 'wx' });
    try {
      await fsPromises.rename(candidateDirectory, lockDirectory);
      published = true;
      return true;
    } catch (error) {
      const targetExists = await fsPromises.lstat(lockDirectory).then(
        () => true,
        targetError => {
          if (targetError?.code === 'ENOENT') return false;
          throw targetError;
        }
      );
      if (
        targetExists ||
        ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error?.code)
      ) return false;
      throw error;
    }
  } finally {
    if (!published) {
      await fsPromises.rm(candidateDirectory, {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 100
      }).catch(() => {});
    }
  }
}

async function acquireCacheKeyLock(cacheRoot, cacheKey, {
  now = Date.now,
  wait = delay,
  randomUUID = crypto.randomUUID,
  processAlive = isProcessAlive
} = {}) {
  const lockDirectory = path.join(cacheRoot, `${LOCK_PREFIX}${cacheKey}`);
  const token = randomUUID();
  const startedAt = now();
  while (true) {
    if (await tryPublishCacheKeyLock(cacheRoot, cacheKey, token)) {
      let released = false;
      return Object.freeze({
        async release() {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(await fsPromises.readFile(
              path.join(lockDirectory, LOCK_OWNER_FILENAME),
              'utf8'
            ));
            if (owner?.token !== token) return;
            await fsPromises.rm(lockDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
          } catch {
            // A missing or replaced lock no longer belongs to this caller.
          }
        }
      });
    }

    const currentTime = now();
    if (currentTime - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for development runtime cache lock ${cacheKey}`);
    }
    const cleared = await quarantineStaleLock(lockDirectory, cacheRoot, cacheKey, {
      now: currentTime,
      randomUUID,
      processAlive
    });
    if (!cleared) await wait(LOCK_RETRY_MS);
  }
}

async function hasActiveRuntimeLease(runtimeDirectory, {
  now = Date.now(),
  staleLeaseAgeMs = STALE_LEASE_AGE_MS,
  processAlive = isProcessAlive
} = {}) {
  let entries;
  try {
    entries = await fsPromises.readdir(runtimeDirectory, { withFileTypes: true });
  } catch {
    return false;
  }
  let active = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(LEASE_PREFIX)) continue;
    const leasePath = path.join(runtimeDirectory, entry.name);
    try {
      const stats = await fsPromises.lstat(leasePath);
      let leaseOwner = null;
      try {
        leaseOwner = JSON.parse(await fsPromises.readFile(leasePath, 'utf8'));
      } catch {
        // A fresh lease remains a valid prepare-to-spawn handoff even if a
        // partial metadata read races its initial publication.
      }
      if (
        processAlive(leaseOwner?.pid) ||
        (Number.isFinite(stats.mtimeMs) && now - stats.mtimeMs < staleLeaseAgeMs)
      ) {
        active = true;
      } else {
        await fsPromises.rm(leasePath, { force: true });
      }
    } catch {
      // A concurrently removed lease is inactive.
    }
  }
  return active;
}

async function createDevElectronRuntimeLease(cacheDirectory, {
  heartbeatMs = 30 * 1000,
  randomUUID = crypto.randomUUID
} = {}) {
  if (typeof cacheDirectory !== 'string' || !path.isAbsolute(cacheDirectory)) {
    throw new TypeError('Development runtime lease path must be absolute');
  }
  await assertRegularFile(path.join(cacheDirectory, 'electron.exe'), 'Leased Electron executable');
  const leasePath = path.join(cacheDirectory, `${LEASE_PREFIX}${process.pid}-${randomUUID()}`);
  await fsPromises.writeFile(leasePath, JSON.stringify({ pid: process.pid }), {
    encoding: 'utf8',
    flag: 'wx'
  });
  let disposed = false;
  const refresh = async () => {
    if (disposed) return;
    const current = new Date();
    try { await fsPromises.utimes(leasePath, current, current); } catch {
      // A missing lease is recreated only by a new launch preparation.
    }
  };
  const timer = setInterval(() => { void refresh(); }, heartbeatMs);
  timer.unref?.();
  return Object.freeze({
    leasePath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      await fsPromises.rm(leasePath, { force: true }).catch(() => {});
    }
  });
}

async function pruneStaleRuntimes(cacheRoot, currentDirectory, {
  now = Date.now(),
  staleAgeMs = STALE_RUNTIME_AGE_MS
} = {}) {
  let entries;
  try {
    entries = await fsPromises.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const currentPath = path.resolve(currentDirectory);
  await Promise.all(entries.map(async entry => {
    const isRuntime = entry.name.startsWith(RUNTIME_PREFIX);
    const isMaintenanceDirectory =
      entry.name.startsWith(STAGING_PREFIX) ||
      entry.name.startsWith(LOCK_CANDIDATE_PREFIX) ||
      entry.name.startsWith(LOCK_QUARANTINE_PREFIX);
    if (
      !entry.isDirectory() ||
      (!isRuntime && !isMaintenanceDirectory)
    ) return;
    const candidate = path.resolve(cacheRoot, entry.name);
    if (candidate === currentPath || path.dirname(candidate) !== path.resolve(cacheRoot)) return;
    try {
      let freshnessPath = candidate;
      if (isRuntime) {
        const markerPath = path.join(candidate, MARKER_FILENAME);
        try {
          await fsPromises.lstat(markerPath);
          freshnessPath = markerPath;
        } catch {
          // An incomplete runtime falls back to its directory age.
        }
      }
      const stats = await fsPromises.lstat(freshnessPath);
      if (!Number.isFinite(stats.mtimeMs) || now - stats.mtimeMs < staleAgeMs) return;
      if (isRuntime && await hasActiveRuntimeLease(candidate, { now })) return;
      await fsPromises.rm(candidate, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      // A stale runtime can still be locked by another development process.
      // It remains eligible for best-effort cleanup on the next launch.
    }
  }));
}

async function defaultEditExecutable({ executablePath, iconPath, electronVersion }) {
  const rcedit = require('rcedit');
  await rcedit(executablePath, {
    icon: iconPath,
    'version-string': {
      CompanyName: 'zXord',
      FileDescription: 'Minecraft Core Development',
      ProductName: 'Minecraft Core',
      InternalName: 'Minecraft Core Development',
      OriginalFilename: 'electron.exe'
    },
    'file-version': electronVersion,
    'product-version': electronVersion
  });
}

async function defaultVerifyExecutableIcon({ executablePath, iconPath }) {
  const { verifyWindowsExecutableIcon } = require('./afterPack.cjs');
  await verifyWindowsExecutableIcon({ exePath: executablePath, iconPath });
}

async function prepareBrandedDevElectronRuntime({
  sourceExecutablePath,
  sourceDistributionPath = path.dirname(sourceExecutablePath || ''),
  iconPath,
  cacheBasePath = process.env.LOCALAPPDATA,
  electronVersion,
  architecture = process.arch
} = {}, {
  editExecutable = defaultEditExecutable,
  verifyExecutableIcon = defaultVerifyExecutableIcon
} = {}) {
  if (process.platform !== 'win32') {
    throw new TypeError('The branded development Electron runtime is Windows-only');
  }
  if (typeof sourceDistributionPath !== 'string' || !path.isAbsolute(sourceDistributionPath)) {
    throw new TypeError('Electron distribution path must be absolute');
  }
  if (typeof cacheBasePath !== 'string' || !path.isAbsolute(cacheBasePath)) {
    throw new TypeError('Development runtime cache path must be absolute');
  }
  await assertRegularFile(sourceExecutablePath, 'Source Electron executable');
  await assertRegularFile(iconPath, 'Development application icon');

  const [sourceDigest, iconDigest] = await Promise.all([
    digestFile(sourceExecutablePath),
    digestFile(iconPath)
  ]);
  const normalizedVersion = safeSegment(electronVersion, 'unknown');
  const normalizedArchitecture = safeSegment(architecture, 'unknown');
  const cacheKey = `${normalizedVersion}-${normalizedArchitecture}-${sourceDigest.slice(0, 16)}-${iconDigest.slice(0, 16)}`;
  const cacheRoot = path.join(cacheBasePath, 'Minecraft Core', CACHE_DIRECTORY_NAME);
  const cacheDirectory = path.join(cacheRoot, `${RUNTIME_PREFIX}${cacheKey}`);
  const executablePath = path.join(cacheDirectory, 'electron.exe');
  const marker = expectedMarker({
    electronVersion: normalizedVersion,
    architecture: normalizedArchitecture,
    sourceDigest,
    iconDigest
  });
  await fsPromises.mkdir(cacheRoot, { recursive: true });
  const cacheLock = await acquireCacheKeyLock(cacheRoot, cacheKey);
  try {
    if (await isReusableRuntime(cacheDirectory, marker)) {
      await touchPublishedRuntime(cacheDirectory);
      await pruneStaleRuntimes(cacheRoot, cacheDirectory);
      return Object.freeze({ cacheDirectory, cacheKey, executablePath, reused: true });
    }

    await fsPromises.rm(cacheDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    const stagingDirectory = await fsPromises.mkdtemp(path.join(cacheRoot, `${STAGING_PREFIX}${cacheKey}-`));
    try {
      await fsPromises.cp(sourceDistributionPath, stagingDirectory, {
        recursive: true,
        force: true,
        errorOnExist: false
      });
      const stagingExecutablePath = path.join(stagingDirectory, 'electron.exe');
      await assertRegularFile(stagingExecutablePath, 'Staged Electron executable');
      await editExecutable({
        executablePath: stagingExecutablePath,
        iconPath,
        electronVersion: normalizedVersion
      });
      await verifyExecutableIcon({ executablePath: stagingExecutablePath, iconPath });
      const patchedExecutableDigest = await digestFile(stagingExecutablePath);
      await fsPromises.writeFile(
        path.join(stagingDirectory, MARKER_FILENAME),
        `${JSON.stringify({ ...marker, patchedExecutableDigest })}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
      await fsPromises.rename(stagingDirectory, cacheDirectory);
      if (!(await isReusableRuntime(cacheDirectory, marker))) {
        throw new Error('Published development Electron runtime is incomplete');
      }
      await touchPublishedRuntime(cacheDirectory);
      await pruneStaleRuntimes(cacheRoot, cacheDirectory);
      return Object.freeze({ cacheDirectory, cacheKey, executablePath, reused: false });
    } finally {
      try {
        await fsPromises.rm(stagingDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      } catch {
        // A failed staging tree is best-effort cleanup and is never executable.
      }
    }
  } finally {
    await cacheLock.release();
  }
}

module.exports = {
  createDevElectronRuntimeLease,
  prepareBrandedDevElectronRuntime,
  pruneStaleRuntimes
};
