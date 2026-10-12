'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { acquireProcessBoundLocalEndpointLease } = require('../../utils/process-bound-local-endpoint-lease.cjs');
const { createClientProcessInspector, validateProcessSnapshot, validIdentity } = require('./client-process-inspector.cjs');
const { isSafeWindowsBasename } = require('../modpacks/windows-basename.cjs');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MARKER = '-Dminecraft.core.clientLaunchId=';

function failure(code = 'RECOVERY_REQUIRED', cause) {
  return Object.assign(new Error(code === 'CLIENT_RUNNING' ? 'The client is running, launching, or busy installing a pack. Wait for it to finish, then retry.' : 'Client process state could not be proven stopped. Close the game or launcher, then retry. If an app-owned server cannot be verified, stop and start that server normally.'), { code, cause });
}

function durableIdentity(snapshotIdentity) {
  if (!validIdentity(snapshotIdentity)) throw failure();
  return { pid: snapshotIdentity.pid, parentPid: snapshotIdentity.parentPid, creationTime: snapshotIdentity.creationTime,
    executablePath: snapshotIdentity.executablePath,
    commandLineSha256: crypto.createHash('sha256').update(snapshotIdentity.commandLine).digest('hex') };
}

function validDurableIdentity(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'commandLine') &&
    Object.keys(value).length === 5 && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    Number.isSafeInteger(value.parentPid) && value.parentPid >= 0 &&
    ['creationTime', 'executablePath'].every(key => typeof value[key] === 'string' && value[key].trim() && value[key].length <= 32768 && !value[key].includes('\0')) &&
    typeof value.commandLineSha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.commandLineSha256);
}

function sameIdentity(snapshotIdentity, recordedIdentity) {
  if (!validIdentity(snapshotIdentity) || !validDurableIdentity(recordedIdentity)) return false;
  const liveIdentity = durableIdentity(snapshotIdentity);
  return Object.keys(liveIdentity).every(key => liveIdentity[key] === recordedIdentity[key]);
}

function hasMarker(commandLine, launchId) {
  return typeof commandLine === 'string' && commandLine.split(/\s+/u).some(token => token.replace(/^"|"$/gu, '') === `${MARKER}${launchId}`);
}

// Windows argv quoting, bounded by the snapshot's 32 KiB command-line limit.
// Do not split quoted game directories on whitespace or guess relative roots.
function commandArguments(commandLine) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) throw failure();
  const args = []; let token = ''; let quoted = false; let started = false;
  for (let index = 0; index < commandLine.length; index++) {
    const char = commandLine[index];
    if (char === '\\') {
      let end = index; while (commandLine[end] === '\\') end++;
      const count = end - index;
      if (commandLine[end] === '"') {
        token += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) token += '"'; else quoted = !quoted;
        index = end;
      } else { token += '\\'.repeat(count); index = end - 1; }
      started = true;
    } else if (char === '"') { quoted = !quoted; started = true; }
    else if (/\s/u.test(char) && !quoted) {
      if (started) args.push(token);
      token = ''; started = false;
    } else { token += char; started = true; }
  }
  if (quoted) throw failure();
  if (started) args.push(token);
  return args;
}

async function unownedGameStatus(item, target, isCurrentUnrelatedServer) {
  if (!/^javaw?(?:\.exe)?$/iu.test(item.name)) return 'stopped';
  const args = commandArguments(item.commandLine);
  const directories = [];
  const indirect = args.some(argument => argument.startsWith('@') || /^org\.(?:prismlauncher|multimc)\.EntryPoint$/iu.test(argument));
  if (indirect && !validIdentity(item)) return 'uncertain';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--gameDir') directories.push(args[++index]);
    else if (args[index].startsWith('--gameDir=')) directories.push(args[index].slice(10));
  }
  if (!directories.length) {
    if (indirect) return await isCurrentUnrelatedServer({ process: item, clientPath: target.clientPath }) === true ? 'stopped' : 'uncertain';
    // A recognisable game without an absolute root cannot establish non-use.
    return /net\.minecraft\.(?:client|launchwrapper)|net\.fabricmc|org\.quiltmc|cpw\.mods\.(?:bootstraplauncher|modlauncher)/iu.test(item.commandLine) ? 'uncertain' : 'stopped';
  }
  if (directories.length !== 1 || typeof directories[0] !== 'string' || !path.isAbsolute(directories[0])) return 'uncertain';
  const canonical = fs.realpathSync.native(directories[0]);
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  if (normalized === target.clientPath) return validIdentity(item) ? 'running' : 'uncertain';
  if (indirect) return await isCurrentUnrelatedServer({ process: item, clientPath: target.clientPath }) === true ? 'stopped' : 'uncertain';
  return 'stopped';
}

class ClientProcessGuard {
  constructor({ root, durableFs, inspectProcesses = createClientProcessInspector(),
    acquireEndpointLease = acquireProcessBoundLocalEndpointLease, randomUUID = crypto.randomUUID,
    isCurrentUnrelatedServer = () => false } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !durableFs ||
        typeof durableFs.readFileBoundedAsync !== 'function' || typeof durableFs.writeJsonAtomicAsync !== 'function' ||
        typeof inspectProcesses !== 'function' || typeof acquireEndpointLease !== 'function' || typeof randomUUID !== 'function' ||
        typeof isCurrentUnrelatedServer !== 'function') throw failure();
    this.root = fs.realpathSync.native(root);
    this.durableFs = durableFs;
    this.inspectProcesses = inspectProcesses;
    this.acquireEndpointLease = acquireEndpointLease;
    this.randomUUID = randomUUID;
    this.isCurrentUnrelatedServer = isCurrentUnrelatedServer;
    this.active = new Map();
  }

  _target({ clientId, clientPath } = {}, { requireExisting = false } = {}) {
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(clientId) ||
        typeof clientPath !== 'string' || !path.isAbsolute(clientPath) || clientPath.includes('\0')) throw failure();
    // Publication recovery may temporarily have no live leaf. Its proven parent
    // and validated leaf must still resolve to the identical path authority.
    const resolved = path.resolve(clientPath);
    const leaf = path.basename(resolved);
    if (!isSafeWindowsBasename(leaf) || clientPath.split(/[\\/]/u).some(part => part === '.' || part === '..')) throw failure();
    const parent = path.dirname(resolved);
    const parentStat = fs.lstatSync(parent);
    const canonicalParent = fs.realpathSync.native(parent);
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || normalize(canonicalParent) !== normalize(parent)) throw failure();
    let leafStat;
    try { leafStat = fs.lstatSync(resolved); }
    catch (error) { if (error.code !== 'ENOENT' || requireExisting) throw error; }
    if (leafStat && (!leafStat.isDirectory() || leafStat.isSymbolicLink() ||
        normalize(fs.realpathSync.native(resolved)) !== normalize(resolved))) throw failure();
    const canonical = path.join(canonicalParent, leaf);
    const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    const key = crypto.createHash('sha256').update(normalized).digest('hex');
    return { clientId, clientPath: normalized, key, recordPath: path.join(this.root, `${key}.json`) };
  }

  async _acquire(target) {
    if (this.active.has(target.key)) throw failure('CLIENT_RUNNING');
    const lease = await this.acquireEndpointLease({ namespace: 'minecraft-core-client', leaseId: target.key });
    this.active.set(target.key, lease);
    return lease;
  }

  async _release(target, lease) {
    await lease.close();
    if (this.active.get(target.key) === lease) this.active.delete(target.key);
  }

  async _snapshot() {
    return validateProcessSnapshot(await this.inspectProcesses());
  }

  async _read(target) {
    const bytes = await this.durableFs.readFileBoundedAsync(target.recordPath, { maxBytes: 64 * 1024, allowMissing: true });
    if (bytes === null) return null;
    const record = JSON.parse(bytes.toString('utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 8 ||
        record.version !== 1 || record.key !== target.key || record.clientPath !== target.clientPath ||
        typeof record.clientId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.clientId) || !UUID.test(record.launchId) ||
        !['preparing', 'running', 'settled'].includes(record.phase) || !validDurableIdentity(record.owner) ||
        (record.child !== null && !validDurableIdentity(record.child)) ||
        (record.phase === 'running' && record.child === null) || (record.phase === 'preparing' && record.child !== null)) throw failure();
    return record;
  }

  async _status(target) {
    try {
      const record = await this._read(target);
      const { processes } = await this._snapshot();
      if (record && record.phase !== 'settled') {
        if (processes.some(item => hasMarker(item.commandLine, record.launchId))) return 'running';
        if (record.child && processes.some(item => sameIdentity(item, record.child))) return 'running';
        if (processes.some(item => (item.pid === record.owner.pid || item.pid === record.child?.pid) && !validIdentity(item))) return 'uncertain';
        // A still-preparing owner can spawn immediately after this snapshot.
        if (processes.some(item => sameIdentity(item, record.owner))) return 'uncertain';
      }
      let uncertain = false;
      for (const item of processes) {
        let status;
        try { status = await unownedGameStatus(item, target, this.isCurrentUnrelatedServer); } catch { status = 'uncertain'; }
        if (status === 'running') return 'running';
        if (status === 'uncertain') uncertain = true;
      }
      return uncertain ? 'uncertain' : 'stopped';
    } catch { return 'uncertain'; }
  }

  async status(request) {
    let target; let lease;
    try {
      target = this._target(request);
      if (this.active.has(target.key)) return 'running';
      lease = await this._acquire(target);
      return await this._status(target);
    } catch { return 'uncertain'; }
    finally { if (lease) await this._release(target, lease); }
  }

  async withMutation(request, callback) {
    const target = this._target(request);
    const lease = await this._acquire(target);
    try {
      const status = await this._status(target);
      if (status !== 'stopped') throw failure(status === 'running' ? 'CLIENT_RUNNING' : 'RECOVERY_REQUIRED');
      lease.assertHeld();
      return await callback();
    } finally { await this._release(target, lease); }
  }

  async beginLaunch(request) {
    const target = this._target(request, { requireExisting: true });
    const lease = await this._acquire(target);
    let record;
    try {
      const status = await this._status(target);
      if (status !== 'stopped') throw failure(status === 'running' ? 'CLIENT_RUNNING' : 'RECOVERY_REQUIRED');
      const owner = (await this._snapshot()).processes.find(item => item.pid === process.pid);
      const launchId = this.randomUUID();
      if (!validIdentity(owner) || !UUID.test(launchId)) throw failure();
      record = { version: 1, key: target.key, clientId: target.clientId, clientPath: target.clientPath,
        launchId, owner: durableIdentity(owner), child: null, phase: 'preparing' };
      lease.assertHeld();
      await this.durableFs.writeJsonAtomicAsync(target.recordPath, record);
      lease.assertHeld();
    } catch (error) {
      await this._release(target, lease);
      throw error;
    }

    let attached = false;
    let childClosed = false;
    let settled = false;
    let writes = Promise.resolve();
    let settlement = null;
    const write = value => {
      // A failed child-identity publication must not suppress a later, stronger
      // exact-close settlement. Each caller still observes its own write error.
      writes = writes.catch(() => {}).then(async () => { lease.assertHeld(); await this.durableFs.writeJsonAtomicAsync(target.recordPath, value); });
      return writes;
    };
    const settle = () => {
      if (settlement) return settlement;
      settlement = write({ ...record, phase: 'settled' }).then(async () => {
        settled = true;
        await this._release(target, lease);
      });
      // Listener-triggered persistence errors keep the endpoint/intent blocked.
      settlement.catch(() => {});
      return settlement;
    };
    return Object.freeze({
      launchId: record.launchId,
      jvmArgument: `${MARKER}${record.launchId}`,
      attach: async child => {
        if (attached || settlement || settled || !child || typeof child.once !== 'function') throw failure();
        attached = true;
        child.once('close', () => { childClosed = true; settle(); });
        child.on('error', () => {}); // An error event is not exact process close.
        const identity = (await this._snapshot()).processes.find(item => item.pid === child.pid && hasMarker(item.commandLine, record.launchId));
        if (childClosed) return settlement;
        if (!identity) throw failure();
        record = { ...record, child: durableIdentity(identity), phase: 'running' };
        await write(record);
      },
      abortBeforeSpawn: async () => {
        if (attached) throw failure();
        await settle();
      },
      close: async () => {
        // Public cleanup cannot substitute for the exact retained child's close.
        if (settlement) await settlement;
      }
    });
  }
}

module.exports = { ClientProcessGuard };
