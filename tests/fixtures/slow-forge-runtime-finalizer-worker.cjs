const fs = require('node:fs');
const path = require('node:path');
const {
  startForgeRuntimeFinalizerWorker
} = require('../../electron/services/forge-runtime-finalizer-worker.cjs');

startForgeRuntimeFinalizerWorker({
  finalizeForgeRuntimeImpl(targetPath, runtime) {
    fs.writeFileSync(path.join(targetPath, '.finalizer-started'), 'started');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
    return {
      valid: true,
      runtime,
      loader: {
        family: 'forge',
        argsFile: `libraries/net/minecraftforge/forge/${runtime.minecraftVersion}-${runtime.loaderVersion}/win_args.txt`
      },
      artifacts: [
        {
          relativePath: '.finalizer-started',
          size: 7,
          sha256: 'a'.repeat(64),
          sha512: 'b'.repeat(128)
        },
        {
          relativePath: `libraries/net/minecraftforge/forge/${runtime.minecraftVersion}-${runtime.loaderVersion}/win_args.txt`,
          size: 5,
          sha256: 'c'.repeat(64),
          sha512: 'd'.repeat(128)
        }
      ]
    };
  }
});
