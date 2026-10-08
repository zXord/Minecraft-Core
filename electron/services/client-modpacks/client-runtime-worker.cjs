'use strict';
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { TOKEN_ENV, CODES, createFrame, verifyFrame } = require('./client-runtime-worker-protocol.cjs');
const { safePath, normalizeClientRuntime, verifyClientRuntime, profileMetadata, failure, assertEffectiveLoader } = require('./client-runtime-installer.cjs');
const { waitForRuntimeWorkerQuiescence } = require('../runtime-worker-quiescence.cjs');

// This interception is restricted to the disposable worker process and must be
// installed before loading XMCL. XMCL settles processors on exit/error, neither
// of which is sufficient evidence that the exact child has closed its streams.
function trackRuntimeChildren(api = childProcess) {
  const original = {}; const pending = new Set(); const tracked = new WeakSet();
  const track = child => {
    if (!tracked.has(child)) {
      tracked.add(child);
      let done; const closed = new Promise(resolve => { done = resolve; }); pending.add(closed);
      child.on('error', () => {});
      child.once('close', () => { pending.delete(closed); done(); });
    }
    return child;
  };
  // exec/execFile use internal spawn bindings, not the exported spawn function.
  // Their custom promisifier also invokes the original binding directly.
  for (const name of ['spawn', 'fork', 'exec', 'execFile']) {
    if (typeof api[name] !== 'function') continue;
    original[name] = api[name];
    api[name] = function(...args) { return track(original[name].apply(this, args)); };
    const custom = original[name][promisify.custom];
    if (typeof custom === 'function') api[name][promisify.custom] = function(...args) {
      const result = custom.apply(this, args); track(result.child); return result;
    };
  }
  return {
    async settle() { while (pending.size) await Promise.all([...pending]); },
    restore() { for (const name of Object.keys(original)) api[name] = original[name]; }
  };
}
async function prepareClientRuntime(request) {
  const { clientPath, signal, onProgress } = request;
  const runtime = normalizeClientRuntime(request.runtime);
  safePath(clientPath, '', true);
  const active = () => { if (signal?.aborted) throw failure('CANCELLED'); };
  const { JavaManager } = require('../minecraft-launcher/java-manager.cjs');
  const { ProperMinecraftLauncher } = require('../minecraft-launcher/proper-launcher.cjs');
  const { installClientLoader } = require('../loader-install-service.cjs');
  const { Version } = require('@xmcl/core');
  const { installLibraries } = require('@xmcl/installer');
  active(); onProgress({ phase: 'java' });
  const java = await new JavaManager(clientPath).ensureJava(runtime.javaMajor, () => {}, { signal });
  if (!java?.success || !java.javaPath) throw failure();
  // Never allow JavaManager output to authorize an executable outside candidate.
  const relativeJava = require('node:path').relative(clientPath, java.javaPath).replaceAll('\\', '/');
  if (!relativeJava.startsWith(`java/java-${runtime.javaMajor}/`)) throw failure();
  safePath(clientPath, relativeJava);
  active(); onProgress({ phase: 'minecraft' });
  const launcher = new ProperMinecraftLauncher();
  launcher.on('launch-progress', event => {
    if (event?.phase !== 'assets' || !Number.isSafeInteger(event.current) || !Number.isSafeInteger(event.total) || event.current < 0 || event.total < event.current) return;
    if (event.type === 'Complete') onProgress({ phase: 'minecraft', files: event.current, totalFiles: event.total });
    else if (['Downloading', 'Retrying'].includes(event.type)) onProgress({ phase: 'minecraft', bytes: event.current, totalBytes: event.total });
  });
  await launcher.ensureMinecraftClient(clientPath, runtime.minecraftVersion, { signal });
  active(); onProgress({ phase: 'loader' });
  const installed = await installClientLoader({ clientPath, minecraftVersion: runtime.minecraftVersion, loader: runtime.loaderFamily, loaderVersion: runtime.loaderVersion, javaPath: java.javaPath, signal });
  active();
  const metadata = profileMetadata(clientPath, runtime);
  if (installed?.success !== true || installed.profileId !== metadata.profileId) throw failure();
  onProgress({ phase: 'libraries' });
  const resolved = await Version.parse(clientPath, metadata.profileId, { name: 'windows', arch: 'x64', version: '' });
  assertEffectiveLoader(resolved.libraries, runtime);
  resolved.minecraftDirectory = clientPath;
  // No bounded cancellation wrapper: this awaited stage owns Node downloads
  // until completion; the worker boundary can stop Node-only residual writers.
  await installLibraries(resolved, { minecraftDirectory: clientPath });
  active(); onProgress({ phase: 'verify' });
  await verifyClientRuntime({ clientPath, runtime });
}
function startClientRuntimeWorker(options = {}) {
  const processRef = options.processRef || process;
  const token = processRef.env[TOKEN_ENV]; delete processRef.env[TOKEN_ENV];
  const tracker = trackRuntimeChildren(options.childProcessApi || childProcess);
  const controller = new AbortController();
  let accepted = false; let finished = false; let disconnected = false;
  const exit = code => { if (!finished) { finished = true; clearTimeout(timer); tracker.restore(); processRef.exit(code); } };
  const timer = setTimeout(() => { if (!accepted) exit(64); }, 60000); timer.unref?.();
  processRef.once('disconnect', () => { disconnected = true; controller.abort(); if (!accepted) exit(64); });
  processRef.on('message', async message => {
    if (finished) return;
    // An extra message must never force-exit an accepted descendant owner.
    if (accepted) { disconnected = true; controller.abort(); return; }
    let frame;
    try { frame = verifyFrame(message, token); if (frame.kind !== 'request') throw failure(); } catch { exit(64); return; }
    accepted = true; clearTimeout(timer);
    let error; let ownership; let ownershipUncertain = false;
    const progress = payload => {
      if (!disconnected && processRef.connected) try { processRef.send(createFrame(token, frame.id, 'progress', payload), () => {}); } catch { /* parent loss is handled by disconnect */ }
    };
    try {
      if (frame.payload.ownership) {
        try {
          if (!processRef.argv?.includes(`--minecraft-core-client-runtime-id=${frame.payload.ownership.markerId}`)) throw failure();
          const factory = options.ownershipFactory || require('./client-runtime-ownership.cjs').createWorkerRuntimeOwnership;
          ownership = await factory(frame.payload.ownership);
        } catch (caught) { ownershipUncertain = true; throw caught; }
      } else if (!options.prepareImpl) throw failure();
      await (options.prepareImpl || prepareClientRuntime)({ ...frame.payload, signal: controller.signal, onProgress: progress });
    }
    catch (caught) { error = caught; }
    await tracker.settle();
    try {
      if (ownershipUncertain) throw failure();
      if (error) await waitForRuntimeWorkerQuiescence(error);
      if (ownership) await ownership.settle();
      // Persisting proof may own a native durable-filesystem helper. Retain its
      // exact close, and keep the process-bound lease until OS process exit.
      // A settled record alone must not authorize cleanup while IPC sending or
      // Node-only residual callbacks can still write inside this worker.
      await tracker.settle();
    } catch {
      await tracker.settle();
      exit(66); return;
    }
    if (disconnected) { exit(65); return; }
    const code = error ? (CODES.has(error.code) ? error.code : 'RUNTIME_INCOMPLETE') : null;
    try {
      processRef.send(createFrame(token, frame.id, 'result', { ok: !error, code }), sendError => {
        // All child writers are settled before either success or send failure.
        exit(sendError ? 65 : error ? 1 : 0);
      });
    } catch { exit(65); }
  });
  return { started: true };
}
if (require.main === module) startClientRuntimeWorker();
module.exports = { startClientRuntimeWorker, trackRuntimeChildren, prepareClientRuntime };
