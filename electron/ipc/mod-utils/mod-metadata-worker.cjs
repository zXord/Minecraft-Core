const { parentPort, workerData } = require('worker_threads');
const { parseJarMetadataSync } = require('./mod-analysis-utils.cjs');

try {
  const metadata = parseJarMetadataSync(workerData?.jarPath);
  parentPort.postMessage({ metadata });
} catch {
  parentPort.postMessage({ metadata: null });
}
