'use strict';
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { TOKEN_ENV, createFrame, verifyFrame } = require('./client-runtime-worker-protocol.cjs');
const { failure } = require('./client-runtime-installer.cjs');
const { retainRuntimeWorkerQuiescence } = require('../runtime-worker-quiescence.cjs');
function createClientRuntimeWorkerClient(dependencies = {}) {
  const fork = dependencies.forkImpl || childProcess.fork;
  const workerPath = dependencies.workerPath || path.join(__dirname, 'client-runtime-worker.cjs');
  const executable = dependencies.execPath || process.execPath;
  return async function run(options) {
    let request; let token; let id;
    try {
      if (options.signal?.aborted) throw failure('CANCELLED');
      token = (dependencies.tokenFactory || (() => crypto.randomBytes(32).toString('hex')))();
      id = (dependencies.idFactory || (() => crypto.randomBytes(16).toString('hex')))();
      request = createFrame(token, id, 'request', { clientPath: options.clientPath, runtime: options.runtime, ...(options.ownership ? { ownership: options.ownership } : {}) });
    } catch (error) { throw retainRuntimeWorkerQuiescence(error, Promise.resolve(true)); }
    return new Promise((resolve, reject) => {
      let child; let accepted = false; let settled = false; let result; let termination; let deadline; let grace;
      let recordClosure; const closed = new Promise(resolve => { recordClosure = resolve; });
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(deadline); clearTimeout(grace);
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(retainRuntimeWorkerQuiescence(error, closed)); else resolve(value);
      };
      const terminate = error => {
        if (termination || settled) return; termination = error;
        clearTimeout(deadline);
        // Accepted workers may own Java. Disconnect asks them to stop between
        // stages and retain every child until exact close. Never kill here.
        try { child?.disconnect(); } catch { /* exact close remains required */ }
        grace = setTimeout(() => finish(error), options.terminationGraceMs || 5000); grace.unref?.();
      };
      const abort = () => terminate(failure('CANCELLED'));
      const env = { PATH: path.dirname(executable), ELECTRON_RUN_AS_NODE: '1', [TOKEN_ENV]: token };
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
      try {
        const args = options.ownership ? [`--minecraft-core-client-runtime-id=${options.ownership.markerId}`] : [];
        child = fork(workerPath, args, { execPath: executable, execArgv: [], cwd: path.dirname(executable), env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
        child.on('message', message => {
          if (termination || settled) return;
          try {
            const frame = verifyFrame(message, token, id);
            if (result || frame.kind === 'request') throw failure();
            if (frame.kind === 'progress') { try { options.onProgress?.(frame.payload); } catch { /* observers do not own runtime */ } }
            else result = frame.payload;
          } catch { terminate(failure()); }
        });
        child.once('error', () => terminate(failure()));
        child.once('close', (code, signal) => {
          const clean = signal === null && ((!accepted && code === 64) || code === 65 || (result && ((code === 0 && result.ok) || (code === 1 && !result.ok))));
          recordClosure(Boolean(clean));
          if (termination) finish(termination);
          else if (clean && result?.ok) finish(null, { quiescent: true });
          else finish(failure(result?.code));
        });
        options.signal?.addEventListener('abort', abort, { once: true });
        deadline = setTimeout(() => terminate(failure()), options.timeoutMs || 60 * 60 * 1000); deadline.unref?.();
        accepted = true;
        child.send(request, error => { if (error) terminate(failure()); });
        if (options.signal?.aborted) abort();
      } catch {
        if (!child) { recordClosure(true); finish(failure()); }
        else terminate(failure());
      }
    });
  };
}
const runClientRuntimeWorker = createClientRuntimeWorkerClient();
module.exports = { createClientRuntimeWorkerClient, runClientRuntimeWorker };
