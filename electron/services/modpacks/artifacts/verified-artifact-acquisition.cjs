const { isAppIssuedVerifiedArtifactSet } = require('../contracts.cjs');
const { ModpackError } = require('../errors.cjs');

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The artifact acquisition request is invalid', { cause });
}

class VerifiedArtifactAcquisition {
  constructor({ artifactDownloader } = {}) {
    if (!artifactDownloader || typeof artifactDownloader.downloadSet !== 'function') throw invalid();
    this.artifactDownloader = artifactDownloader;
  }

  async downloadSet(value, options) {
    if (value?.type === 'verified-artifact-set') {
      if (!isAppIssuedVerifiedArtifactSet(value)) throw invalid();
      return value;
    }
    return this.artifactDownloader.downloadSet(value, options);
  }
}

module.exports = { VerifiedArtifactAcquisition };
