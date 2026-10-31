'use strict';

// fs.promises as a lifecycle review sees a modpack server that is running:
// Minecraft holds its world lock, appends to its log and saves the world while
// the review reads the server folder.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// The server's reply to the "list" command Minecraft Core sends every two minutes.
const LIST_LINE = '[12:02:00] [Server thread/INFO]: There are 0 of a max of 20 players online: \n';

function busyError() {
  return Object.assign(new Error('EBUSY: resource busy or locked, read'), { code: 'EBUSY', syscall: 'read', errno: -4082 });
}

// Each `locked` file opens but every read fails with EBUSY, as with the lock
// the JVM holds on <world>/session.lock. Each `after` hook, keyed
// '<lstat|readdir|open> <path>', makes one server write right after that call
// first returned for that path.
function runningServerFs({ locked = [], after = {} } = {}) {
  const lockedPaths = new Set(locked.map(target => path.resolve(target)));
  const pending = new Map(Object.entries(after).map(([key, hook]) => {
    const separator = key.indexOf(' ');
    return [`${key.slice(0, separator)} ${path.resolve(key.slice(separator + 1))}`, hook];
  }));
  const settle = async (call, target) => {
    const key = `${call} ${path.resolve(target)}`;
    const hook = pending.get(key);
    if (!hook) return;
    pending.delete(key);
    await hook();
  };
  return {
    access: (...args) => fsp.access(...args),
    async lstat(target, ...args) {
      const stat = await fsp.lstat(target, ...args);
      await settle('lstat', target);
      return stat;
    },
    async readdir(target, ...args) {
      const children = await fsp.readdir(target, ...args);
      await settle('readdir', target);
      return children;
    },
    async open(target, ...args) {
      const handle = await fsp.open(target, ...args);
      await settle('open', target);
      if (!lockedPaths.has(path.resolve(target))) return handle;
      return {
        stat: (...statArgs) => handle.stat(...statArgs),
        async read() { throw busyError(); },
        close: () => handle.close()
      };
    }
  };
}

// Minecraft saves level.dat through a temporary file and keeps the previous
// one as level.dat_old. `begin` writes the temporary file, `finish` swaps it in.
function levelAutosave(worldPath, bytes = 'level autosave') {
  const temporary = path.join(worldPath, 'level7731852640159113235.dat');
  return {
    temporary,
    begin: () => fs.writeFileSync(temporary, bytes),
    finish: () => {
      fs.rmSync(path.join(worldPath, 'level.dat_old'), { force: true });
      fs.renameSync(path.join(worldPath, 'level.dat'), path.join(worldPath, 'level.dat_old'));
      fs.renameSync(temporary, path.join(worldPath, 'level.dat'));
    }
  };
}

module.exports = { LIST_LINE, levelAutosave, runningServerFs };
