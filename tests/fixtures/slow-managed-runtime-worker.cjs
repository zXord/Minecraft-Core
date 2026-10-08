const fs = require('node:fs');
const path = require('node:path');
const {
  startManagedRuntimeWorker
} = require('../../electron/services/managed-runtime-worker.cjs');

startManagedRuntimeWorker({
  prepareRuntimeImpl(options) {
    fs.writeFileSync(path.join(options.targetPath, '.managed-runtime-started'), 'started');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
    return {
      valid: true,
      runtime: options.runtime,
      loader: { family: 'fabric', launcherJar: 'fabric-server-launch.jar' },
      artifacts: [{
        relativePath: 'fabric-server-launch.jar',
        size: 7,
        sha256: 'a'.repeat(64),
        sha512: 'b'.repeat(128)
      }]
    };
  }
});
