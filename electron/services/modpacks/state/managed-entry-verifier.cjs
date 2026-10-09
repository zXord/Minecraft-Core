const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ModpackError } = require('../errors.cjs');

const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const samePath = (left, right) => pathKey(left) === pathKey(right);
const yieldControl = () => new Promise(resolve => setImmediate(resolve));
function cancelled(signal) {
  if (signal?.aborted) throw new ModpackError('CANCELLED', 'Managed file verification was cancelled');
}
function changed(cause) {
  return cause instanceof ModpackError ? cause : new ModpackError('PLAN_STALE', 'A managed file changed during verification', { cause });
}
function fileIdentity(stat) {
  return Object.fromEntries(['dev', 'ino', 'size', 'nlink'].map(key => [key, String(stat[key])]).concat([
    ['birth', String(stat.birthtimeNs ?? stat.birthtimeMs)],
    ['mtime', String(stat.mtimeNs ?? stat.mtimeMs)], ['ctime', String(stat.ctimeNs ?? stat.ctimeMs)]
  ]));
}
function sameFileIdentity(left, right) {
  return !!left && !!right && Object.keys(left).every(key => left[key] === right[key]);
}

// Walk every ancestor each pass. Native reparse evidence supplements Node's
// symlink/realpath checks on Windows; callers own the inspector's lifecycle.
async function inspectManagedPath(serverPath, entry, { fsApi = fs, reparseInspector, signal, ancestorProof } = {}) {
  cancelled(signal);
  const candidate = path.resolve(serverPath, ...entry.path.split('/'));
  const relative = path.relative(serverPath, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ModpackError('INVALID_REQUEST', 'Managed modpack state is invalid');
  }
  const root = path.parse(candidate).root;
  const parts = candidate.slice(root.length).split(path.sep).filter(Boolean);
  let current = root; let stat;
  for (let index = -1; index < parts.length; index++) {
    cancelled(signal);
    if (index >= 0) current = path.join(current, parts[index]);
    try { stat = fsApi.lstatSync(current, { bigint: true }); }
    catch (cause) { if (cause?.code === 'ENOENT') return { status: 'missing' }; throw changed(cause); }
    const last = index === parts.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() || BigInt(stat.nlink) !== 1n : !stat.isDirectory())) return { status: 'unsafe' };
    const identity = fileIdentity(stat);
    if (last || !sameFileIdentity(ancestorProof?.get(current), identity)) {
      if (!samePath(fsApi.realpathSync.native(current), current)) return { status: 'unsafe' };
      if (reparseInspector && await reparseInspector.isReparsePoint(current, { signal })) return { status: 'unsafe' };
      if (!last) ancestorProof?.set(current, identity);
    }
    cancelled(signal);
  }
  return { status: String(stat.size) === entry.size ? 'matched' : 'modified', identity: fileIdentity(stat), candidate };
}

// Shared stable pre/open/post/path verifier used by full Verify and companion health.
async function verifyManagedEntry(serverPath, entry, {
  fsApi = fs, fsPromises = fsApi.promises, reparseInspector, signal, yieldToLoop = yieldControl,
  identitiesMatch = sameFileIdentity, beforeAncestors, afterAncestors
} = {}) {
  const before = await inspectManagedPath(serverPath, entry, { fsApi, reparseInspector, signal, ancestorProof: beforeAncestors });
  if (before.status !== 'matched') return before;
  const { identity: beforeIdentity, candidate } = before;
  const expectedBytes = BigInt(entry.size);
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let handle;
  try {
    handle = await fsPromises.open(candidate, 'r');
  } catch (error) {
    cancelled(signal);
    throw changed(error);
  }

  let failure = null;
  let handleAfterIdentity = null;
  try {
    cancelled(signal);
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile() || BigInt(openedStat.nlink) !== 1n ||
        !identitiesMatch(beforeIdentity, fileIdentity(openedStat))) {
      throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
    }
    let measuredBytes = 0n;
    for (;;) {
      cancelled(signal);
      const remaining = expectedBytes - measuredBytes;
      const readLength = remaining >= BigInt(buffer.length)
        ? buffer.length
        : Number(remaining) + 1;
      let result;
      try { result = await handle.read(buffer, 0, readLength, null); }
      catch (error) {
        cancelled(signal);
        throw changed(error);
      }
      cancelled(signal);
      const bytesRead = result?.bytesRead;
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > readLength) {
        throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
      }
      if (bytesRead === 0) break;
      measuredBytes += BigInt(bytesRead);
      if (measuredBytes > expectedBytes) {
        throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
      }
      digest.update(buffer.subarray(0, bytesRead));
      await yieldToLoop();
      cancelled(signal);
    }
    if (measuredBytes !== expectedBytes) {
      throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
    }
    handleAfterIdentity = fileIdentity(await handle.stat({ bigint: true }));
    cancelled(signal);
  } catch (error) {
    failure = error;
    throw changed(error);
  } finally {
    try { await handle.close(); }
    catch (error) {
      if (failure === null) throw changed(error);
    }
  }

  const after = await inspectManagedPath(serverPath, entry, { fsApi, reparseInspector, signal, ancestorProof: afterAncestors });
  if (after.status !== 'matched' || !identitiesMatch(beforeIdentity, handleAfterIdentity) ||
      !identitiesMatch(beforeIdentity, after.identity)) {
    throw new ModpackError('PLAN_STALE', 'A managed file changed during verification');
  }
  return { status: digest.digest('hex') === entry.installedHash ? 'matched' : 'modified', identity: after.identity };
}

module.exports = { verifyManagedEntry, inspectManagedPath, fileIdentity, sameFileIdentity, samePath, cancelled };
