const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const [role, root, candidatePath] = process.argv.slice(2);
const marker = name => path.join(root, name);
const runtime = {
  minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0',
  javaMajor: 17, os: 'win32', architecture: 'x64'
};

if (role === 'parent') {
  process.on('message', message => { if (message === 'crash') process.exit(42); });
  const { createManagedRuntimeWorkerClient } = require('../../electron/services/managed-runtime-worker-client.cjs');
  const run = createManagedRuntimeWorkerClient({
    forkImpl(workerPath, _args, options) {
      return childProcess.fork(workerPath, ['worker', root, candidatePath], options);
    },
    workerPath: __filename
  });
  run({
    operation: 'prepare-managed-server-runtime', targetPath: candidatePath,
    javaPath: marker('java.exe'), runtime
  }).catch(error => fs.writeFileSync(marker('parent-failed'), String(error.stack)));
} else {
  const { startManagedRuntimeWorker } = require('../../electron/services/managed-runtime-worker.cjs');
  process.once('disconnect', () => fs.writeFileSync(marker('worker-disconnected'), 'disconnected'));
  process.once('exit', code => fs.writeFileSync(marker('worker-exited'), String(code)));
  fs.writeFileSync(marker('worker-process'), String(process.pid));
  startManagedRuntimeWorker({
    async prepareRuntimeImpl({ targetPath, runtime }) {
      fs.writeFileSync(marker('worker-writing-pending'), 'pending');
      // Models a base-layout/library helper already waiting for network I/O:
      // those production helpers currently receive no AbortSignal.
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(marker('resume-worker'))) {
        if (Date.now() >= deadline) throw new Error('Bounded fixture deadline');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      fs.mkdirSync(targetPath, { recursive: true });
      fs.writeFileSync(path.join(targetPath, 'late-runtime.bin'), 'late-runtime-bytes');
      return { valid: true, runtime };
    }
  });
}
