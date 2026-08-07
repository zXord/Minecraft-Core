const path = require('node:path');

const verifier = require('../electron/services/modpacks/archive/archive-runtime-verifier.cjs');

module.exports = verifier;

if (require.main === module) {
  verifier.verifyArchiveRuntime(path.resolve(__dirname, '..')).then(result => {
    process.stdout.write(`Verified 7-Zip ${result.version} ${result.architecture} archive runtime\n`);
  }).catch(error => {
    process.stderr.write(`${error?.safeMessage || 'Bundled archive engine is unavailable'}\n`);
    process.exitCode = 1;
  });
}
