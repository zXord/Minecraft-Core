const path = require('node:path');
const { verifyArchiveRuntime } = require('./archive-runtime-verifier.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { verifyArchiveWorkerExecutable } = require('./archive-worker-client.cjs');

function unavailable(cause) {
  return new ModpackError('EXTRACTOR_UNAVAILABLE', 'Verified archive processing is unavailable', { cause });
}

async function getBundledArchiveRuntime({
  resourcesPath,
  runtimeRoot,
  arch,
  isPackaged,
  verifyRuntime = verifyArchiveRuntime,
  verifyWorker = verifyArchiveWorkerExecutable
} = {}) {
  try {
    if (arch !== 'x64' || typeof isPackaged !== 'boolean') throw unavailable();
    let resourcesRoot;
    let enginePath;
    let workerPath;
    let workerManifestPath;
    if (isPackaged) {
      if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) throw unavailable();
      resourcesRoot = path.join(path.resolve(resourcesPath), 'archive');
      enginePath = path.join(resourcesRoot, '7zip', '7z.exe');
      workerPath = path.join(resourcesRoot, 'worker', 'ArchiveWorker.exe');
      workerManifestPath = path.join(resourcesRoot, 'manifests', 'archive-worker-x64.json');
    } else {
      if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) throw unavailable();
      resourcesRoot = path.resolve(runtimeRoot);
      enginePath = path.join(resourcesRoot, 'vendor', '7zip', 'x64', '7z.exe');
      workerPath = path.join(resourcesRoot, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe');
      workerManifestPath = path.join(resourcesRoot, 'build-resources', 'archive-runtime', 'archive-worker-x64.json');
    }

    const runtimeLayout = isPackaged ? 'packaged' : 'repository';
    const runtime = await verifyRuntime(resourcesRoot, { layout: runtimeLayout });
    if (runtime?.version !== '26.02' || runtime?.architecture !== 'x64' ||
        runtime?.handlers?.zip !== true || runtime?.handlers?.rar !== true) throw unavailable();

    const worker = await verifyWorker({ workerPath, workerManifestPath });
    if (worker?.architecture !== 'x64' || worker?.runtimeIdentifier !== 'win-x64') throw unavailable();

    return deepFreeze({
      resourcesRoot,
      runtimeLayout,
      enginePath,
      workerPath,
      workerManifestPath,
      engineVersion: runtime.version,
      architecture: 'x64'
    });
  } catch (error) {
    if (error instanceof ModpackError && error.code === 'EXTRACTOR_UNAVAILABLE') throw error;
    throw unavailable(error);
  }
}

module.exports = { getBundledArchiveRuntime };
