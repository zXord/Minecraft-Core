const fs = require('node:fs');
const path = require('node:path');

const locks = new Map();

function lockKey(serverPath) {
  if (typeof serverPath !== 'string' || !path.isAbsolute(serverPath) || serverPath.includes('\0')) {
    throw new TypeError('A canonical server path is required');
  }
  const resolved = path.resolve(serverPath);
  const stat = fs.lstatSync(resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('A canonical server directory is required');
  const canonical = path.resolve(fs.realpathSync.native(resolved));
  const comparableResolved = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  const comparableCanonical = process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
  if (comparableResolved !== comparableCanonical) throw new TypeError('Server path aliases are not allowed');
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
