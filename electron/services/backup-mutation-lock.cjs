const fs = require('node:fs');
const path = require('node:path');

const locks = new Map();

// Native realpath asks Windows for the final path of an open handle
// (GetFinalPathNameByHandleW). Some drivers, such as some RAM disks and virtual
// drives, cannot answer, and libuv then reports EISDIR for a directory that
// exists. Ordinary backups worked there in v26.6.1, so an existing directory
// falls back to the JS realpath, which still follows junctions and symlinks but
// not SUBST or mapped drives, and then to its resolved spelling. A missing path
// or a file is still refused.
function canonicalDirectoryPath(resolved) {
  try {
    return path.resolve(fs.realpathSync.native(resolved));
  } catch {
    if (!fs.statSync(resolved).isDirectory()) throw new TypeError('A server directory is required');
    try {
      return path.resolve(fs.realpathSync(resolved));
    } catch {
      return resolved;
    }
  }
}

// Every spelling of a folder (junction, symlink, SUBST or mapped drive, letter
// case) resolves to the real directory, so all of them share one lock. Alias
// refusal for modpack lifecycle work stays in restore-point-service.
function lockKey(serverPath) {
  if (typeof serverPath !== 'string' || !path.isAbsolute(serverPath) || serverPath.includes('\0')) {
    throw new TypeError('An absolute server path is required');
  }
  const canonical = canonicalDirectoryPath(path.resolve(serverPath));
  const stat = fs.statSync(canonical, { bigint: true });
  if (!stat.isDirectory()) throw new TypeError('A server directory is required');
  const comparableCanonical = process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
  return `${comparableCanonical}|${stat.dev}|${stat.ino}|${stat.birthtimeNs}`;
}

async function withBackupMutationLock(serverPath, operation) {
  if (typeof operation !== 'function') throw new TypeError('A backup operation is required');
  const key = lockKey(serverPath);
  let state = locks.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), waiters: 0 };
    locks.set(key, state);
  }
  const predecessor = state.tail;
  let release;
  state.tail = new Promise(resolve => { release = resolve; });
  state.waiters += 1;
  await predecessor;
  try {
    return await operation();
  } finally {
    state.waiters -= 1;
    release();
    if (state.waiters === 0 && locks.get(key) === state) locks.delete(key);
  }
}

module.exports = { withBackupMutationLock };
