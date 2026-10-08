const { ModpackError } = require('../modpacks/errors.cjs');
const { normalizeMrpackPath, canonicalWindowsPath } = require('../modpacks/mrpack/mrpack-schema.cjs');

const PROTECTED_ROOTS = new Set([
  'saves', 'screenshots', 'logs', 'crash-reports', 'versions', 'libraries', 'assets',
  'runtime', 'runtimes', 'java', 'jre', 'jdk', 'natives', 'auth', 'credentials', '.minecraft'
]);
const PROTECTED_FILES = new Set([
  'client-config.json', 'xmcl-auth.json', 'auth.json', 'credentials.json', 'accounts.json',
  'launcher_accounts.json', 'launcher_profiles.json', 'usercache.json'
]);
const EXECUTABLE = /\.(?:bat|cmd|com|exe|msi|ps1|psm1|psd1|sh|bash|vbs|vbe|wsf|wsh|scr|dll|so|dylib|lnk|url|hta|cpl|reg)$/iu;
const SEEDED_SETTINGS = new Set(['options.txt', 'optionsof.txt', 'servers.dat']);

function clientPathPolicy(relativePath) {
  let normalized;
  try { normalized = canonicalWindowsPath(normalizeMrpackPath(relativePath, { rejectState: false })); }
  catch (cause) { throw new ModpackError('UNSAFE_ARCHIVE_ENTRY', 'Client pack path is unsafe', { cause }); }
  const segments = normalized.split('/');
  if (PROTECTED_ROOTS.has(segments[0]) || segments.some(segment =>
    segment.startsWith('.minecraft-core') || segment.startsWith('minecraft-core-') || PROTECTED_FILES.has(segment)) ||
      EXECUTABLE.test(normalized)) {
    throw new ModpackError('UNSAFE_ARCHIVE_ENTRY', 'Client pack cannot supply protected content');
  }
  return SEEDED_SETTINGS.has(normalized) ? 'preserve-after-seed' : 'managed';
}

module.exports = { clientPathPolicy };
