const { ModpackError } = require('../modpacks/errors.cjs');

// Discovery hints only. Inspected archive content remains the format authority.
function isClientArchiveName(fileName, provider) {
  if (typeof fileName !== 'string') return false;
  return provider === 'github' ? /\.(mrpack|zip)$/i.test(fileName) : provider === 'modrinth' && /\.mrpack$/i.test(fileName);
}

function singleClientArchive(plan, provider) {
  const set = plan?.artifactSet;
  if (set?.kind !== 'single' || !Array.isArray(set.parts) || set.parts.length !== 1 || !isClientArchiveName(set.parts[0]?.fileName, provider)) {
    throw new ModpackError('UNSUPPORTED_ARCHIVE', 'Select one supported client archive from this exact release');
  }
  return set.parts[0];
}

module.exports = { isClientArchiveName, singleClientArchive };
