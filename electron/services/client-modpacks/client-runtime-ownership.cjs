'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { acquireProcessBoundLocalEndpointLease } = require('../../utils/process-bound-local-endpoint-lease.cjs');
const { resolveSystemPowerShellRuntime, encodePowerShellCommand } = require('../../watchdog/app-watchdog.cjs');
const { isSafeWindowsBasename } = require('../modpacks/windows-basename.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const recoveryRequired = () => Object.assign(new Error('Client runtime ownership could not be proven settled.'), { code: 'RECOVERY_REQUIRED' });
// 26H2 (26300) shares the 24H2/25H2 servicing branch; retain all runtime
// layout cross-checks rather than treating unknown future builds as supported.
// https://blogs.windows.com/windows-insider/2026/08/27/releasing-windows-11-version-26h2-to-the-release-preview-channel/
const BUILDS = new Set([19041, 19042, 19043, 19044, 19045, 22000, 22621, 22631, 26100, 26200, 26300]);

// Windows SDK ntddk.h KUSER_SHARED_DATA: NtBuildNumber 0x260,
// NativeProcessorArchitecture 0x26a, NtMajorVersion 0x26c, BootId 0x2c4.
// BootId is the OS loader's boot-attempt sequence, not a wall-clock timestamp
// or the persistent BCD entry GUID. User mapping is read-only at 0x7FFE0000.
// https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-kuser_shared_data
// https://www.microsoft.com/msrc/blog/2022/04/randomizing-the-kuser_shared_data-structure-on-windows
const BOOT_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
try {
  if (-not [Environment]::Is64BitProcess -or -not [Environment]::Is64BitOperatingSystem) { exit 41 }
  $v = [Environment]::OSVersion.Version
  $base = [IntPtr]::new(0x7FFE0000)
  $a = [uint32]([Runtime.InteropServices.Marshal]::ReadInt32($base, 0x2C4) -band 0xFFFFFFFFL)
  $major = [Runtime.InteropServices.Marshal]::ReadInt32($base, 0x26C)
  $build = [Runtime.InteropServices.Marshal]::ReadInt32($base, 0x260) -band 0xFFFF
  $arch = [Runtime.InteropServices.Marshal]::ReadInt16($base, 0x26A)
  $b = [uint32]([Runtime.InteropServices.Marshal]::ReadInt32($base, 0x2C4) -band 0xFFFFFFFFL)
  if ($v.Major -ne $major -or $v.Build -ne $build) { exit 42 }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{version=1;major=$major;build=$build;architecture=$arch;sequenceA=$a;sequenceB=$b}))
} catch { exit 43 }
`;
function sequence(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) throw recoveryRequired();
  return value;
}
function createWindowsBootSequenceProvider({ platform = process.platform, architecture = process.arch, env = process.env,
  resolveRuntime = resolveSystemPowerShellRuntime, execFileFn = execFile } = {}) {
  return async () => {
    if (platform !== 'win32' || architecture !== 'x64') throw recoveryRequired();
    const runtime = resolveRuntime({ env });
    if (!runtime?.executable || !runtime.systemRoot) throw recoveryRequired();
    let value;
    try {
      const output = await new Promise((resolve, reject) => execFileFn(runtime.executable,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(BOOT_PROBE)],
        { windowsHide: true, timeout: 10000, maxBuffer: 4096, encoding: 'utf8', env: { SystemRoot: runtime.systemRoot, WINDIR: runtime.systemRoot, PSModulePath: runtime.modulePath } },
        (error, stdout) => error ? reject(error) : resolve(stdout)));
      value = JSON.parse(output.replace(/^\uFEFF/, ''));
    } catch { throw recoveryRequired(); }
    exact(value, ['version', 'major', 'build', 'architecture', 'sequenceA', 'sequenceB']);
    if (value.version !== 1 || value.major !== 10 || !BUILDS.has(value.build) || value.architecture !== 9 || value.sequenceA !== value.sequenceB) throw recoveryRequired();
    return sequence(value.sequenceA);
  };
}
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw recoveryRequired();
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value !== path.resolve(value) || value.length > 32767 || /[\u0000-\u001f\u007f]/.test(value)) throw recoveryRequired();
  return value;
}
function workerConfig(value) {
  exact(value, ['workerPath', 'workerManifestPath', 'appOwnedRoot']);
  return Object.freeze({ workerPath: absolute(value.workerPath), workerManifestPath: absolute(value.workerManifestPath), appOwnedRoot: absolute(value.appOwnedRoot) });
}
function contextFor(value) {
  exact(value, ['root', 'operationId', 'markerId', 'clientPath', 'workerDurableConfig']);
  if (!UUID.test(value.operationId) || !UUID.test(value.markerId)) throw recoveryRequired();
  return { root: absolute(value.root), operationId: value.operationId, markerId: value.markerId, clientPath: absolute(value.clientPath), workerDurableConfig: workerConfig(value.workerDurableConfig) };
}
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
class ClientRuntimeOwnership {
  constructor({ root, durableFs, workerDurableConfig, getBootSequence = createWindowsBootSequenceProvider(), acquireLease = acquireProcessBoundLocalEndpointLease } = {}) {
    this.root = absolute(root);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(root), root) ||
      typeof durableFs?.readFileBoundedAsync !== 'function' || typeof durableFs?.writeJsonAtomicAsync !== 'function' || typeof getBootSequence !== 'function' || typeof acquireLease !== 'function') throw recoveryRequired();
    this.durableFs = durableFs; this.workerDurableConfig = workerConfig(workerDurableConfig);
    this.getBootSequence = getBootSequence; this.acquireLease = acquireLease; this.mainLeases = new Map();
    this.workerConfigHash = sha256(JSON.stringify(this.workerDurableConfig));
  }
  _file(operationId) { if (!UUID.test(operationId)) throw recoveryRequired(); return path.join(this.root, `${operationId}.json`); }
  async _lease(operationId, actor) {
    this._file(operationId);
    const rootIdentity = process.platform === 'win32' ? this.root.toLowerCase() : this.root;
    return this.acquireLease({ namespace: `minecraft-core-runtime-${actor}`, leaseId: sha256(`${rootIdentity}\0${operationId}`) });
  }
  async _read(operationId) {
    const bytes = await this.durableFs.readFileBoundedAsync(this._file(operationId), { maxBytes: 65536, allowMissing: true });
    if (bytes === null) return null;
    const record = JSON.parse(bytes.toString('utf8'));
    exact(record, ['schemaVersion', 'operationId', 'markerId', 'clientPath', 'bootSequence', 'phase', 'workerConfigHash']);
    if (record.schemaVersion !== 1 || record.operationId !== operationId || !UUID.test(record.markerId) ||
      !['reserved', 'preparing', 'settled'].includes(record.phase) || record.workerConfigHash !== this.workerConfigHash) throw recoveryRequired();
    absolute(record.clientPath); sequence(record.bootSequence);
    return { record, sha256: sha256(bytes) };
  }
  async _write(record, expectedTargetSha256) {
    await this.durableFs.writeJsonAtomicAsync(this._file(record.operationId), record, { expectedTargetSha256 });
  }
  async reserve({ operationId, clientPath }) {
    this._file(operationId); absolute(clientPath);
    const parent = path.dirname(clientPath); const stat = fs.lstatSync(parent);
    if (!isSafeWindowsBasename(path.basename(clientPath)) || !stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(parent), parent) || this.mainLeases.has(operationId)) throw recoveryRequired();
    const lease = await this._lease(operationId, 'main');
    try {
      if (await this._read(operationId)) throw recoveryRequired();
      const record = { schemaVersion: 1, operationId, markerId: crypto.randomUUID(), clientPath,
        bootSequence: sequence(await this.getBootSequence()), phase: 'reserved', workerConfigHash: this.workerConfigHash };
      lease.assertHeld(); await this._write(record, null); lease.assertHeld();
      this.mainLeases.set(operationId, lease);
    } catch (error) { await lease.close(); throw error; }
  }
  async activate(operationId) {
    const lease = this.mainLeases.get(operationId); if (!lease) throw recoveryRequired();
    const current = await this._read(operationId);
    if (current?.record.phase !== 'reserved' || sequence(await this.getBootSequence()) !== current.record.bootSequence) throw recoveryRequired();
    lease.assertHeld(); await this._write({ ...current.record, phase: 'preparing' }, current.sha256); lease.assertHeld();
    return Object.freeze({ root: this.root, operationId, markerId: current.record.markerId, clientPath: current.record.clientPath, workerDurableConfig: this.workerDurableConfig });
  }
  async releaseMain(operationId) {
    const lease = this.mainLeases.get(operationId); if (!lease) return false;
    await lease.close(); this.mainLeases.delete(operationId); return true;
  }
  async releaseReserved(operationId) {
    // Main-only authority: caller has positively settled ALL stage writers,
    // including native durable-fs helpers. A bounded promise rejection without
    // exact helper close is not sufficient to call this settlement API.
    const lease = this.mainLeases.get(operationId); if (!lease) return false;
    const current = await this._read(operationId);
    if (current?.record.phase !== 'reserved') return false;
    lease.assertHeld(); await this._write({ ...current.record, phase: 'settled' }, current.sha256);
    await this.releaseMain(operationId); return true;
  }
  async completeFromExactClose(operationId) {
    const owned = this.mainLeases.get(operationId); const lease = owned || await this._lease(operationId, 'main');
    try {
      const current = await this._read(operationId); if (!current) throw recoveryRequired();
      lease.assertHeld();
      if (current.record.phase !== 'settled') await this._write({ ...current.record, phase: 'settled' }, current.sha256);
      return true;
    } finally { if (owned) await this.releaseMain(operationId); else await lease.close(); }
  }
  async claimWorker(input) {
    const context = contextFor(input);
    if (!samePath(context.root, this.root) || sha256(JSON.stringify(context.workerDurableConfig)) !== this.workerConfigHash) throw recoveryRequired();
    const lease = await this._lease(context.operationId, 'worker');
    try {
      const current = await this._read(context.operationId);
      if (current?.record.phase !== 'preparing' || current.record.markerId !== context.markerId || current.record.clientPath !== context.clientPath || current.record.bootSequence !== sequence(await this.getBootSequence())) throw recoveryRequired();
      lease.assertHeld();
    } catch (error) { await lease.close(); throw error; }
    return Object.freeze({
      settle: async () => {
        const current = await this._read(context.operationId);
        if (!current || current.record.markerId !== context.markerId || current.record.clientPath !== context.clientPath || !['preparing', 'settled'].includes(current.record.phase)) throw recoveryRequired();
        lease.assertHeld();
        if (current.record.phase !== 'settled') await this._write({ ...current.record, phase: 'settled' }, current.sha256);
        lease.assertHeld(); return true;
      },
      release: () => lease.close()
    });
  }
  async getRecoveryState(operationId) {
    const state = (quiescent, status) => ({ quiescent, status });
    if (this.mainLeases.has(operationId)) return state(false, 'running');
    let main; let worker;
    try {
      if (!await this._read(operationId)) return state(false, 'unknown');
      try { main = await this._lease(operationId, 'main'); worker = await this._lease(operationId, 'worker'); }
      catch { return state(false, 'running'); }
      const current = await this._read(operationId); if (!current) return state(false, 'unknown');
      main.assertHeld(); worker.assertHeld();
      // Reserved also covers main-owned staging. Its native durable-filesystem
      // helpers can survive main death even before runtime authorization.
      if (current.record.phase !== 'settled') {
        const boot = sequence(await this.getBootSequence());
        if (boot <= current.record.bootSequence) return state(false, boot === current.record.bootSequence ? 'restart-required' : 'uncertain');
      }
      if (current.record.phase !== 'settled') await this._write({ ...current.record, phase: 'settled' }, current.sha256);
      return state(true, 'quiescent');
    } catch { return state(false, 'uncertain'); }
    finally { await worker?.close(); await main?.close(); }
  }
}
function createWorkerRuntimeOwnership(input, dependencies = {}) {
  const context = contextFor(input);
  let durableFs = dependencies.durableFs;
  if (!durableFs) {
    const { createDurableFs } = require('../../utils/durable-fs.cjs');
    const { WindowsDurableFsClient } = require('../../utils/windows-durable-fs-client.cjs');
    durableFs = createDurableFs({ durableClient: new WindowsDurableFsClient({ ...context.workerDurableConfig, allowedRoots: [context.root], requireConfirmedClose: true }), allowedRoots: [context.root] });
  }
  return new ClientRuntimeOwnership({ root: context.root, workerDurableConfig: context.workerDurableConfig, ...dependencies, durableFs }).claimWorker(context);
}
module.exports = { ClientRuntimeOwnership, createWindowsBootSequenceProvider, createWorkerRuntimeOwnership, contextFor };
