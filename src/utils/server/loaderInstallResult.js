// The 'download-and-install-loader' IPC handler (electron/ipc/install-handlers.cjs) reports a failed install
// by resolving { success: false, error, code }, not by rejecting. Every successful install, Vanilla included,
// resolves success: true, so only an explicit false is a failure. Any other result keeps the earlier
// behaviour, which never looked at it.
const LOADER_NAMES = new Map([
  ['vanilla', 'Vanilla'],
  ['fabric', 'Fabric'],
  ['forge', 'Forge'],
  ['neoforge', 'NeoForge'],
  ['quilt', 'Quilt']
]);

/**
 * The failure a loader install result reports, as an Error to throw, or null when it reports none.
 *
 * @param {any} result - What 'download-and-install-loader' resolved
 * @param {string} loader - The loader that was being installed
 * @returns {Error | null}
 */
export function loaderInstallFailure(result, loader) {
  if (!result || typeof result !== 'object' || result.success !== false) return null;
  const name = LOADER_NAMES.get(typeof loader === 'string' ? loader.trim().toLowerCase() : '') || 'Loader';
  const reason = typeof result.error === 'string' ? result.error.trim() : '';
  const message = reason ? `${name} installation failed: ${reason}` : `${name} installation failed.`;
  return typeof result.code === 'string' && result.code
    ? Object.assign(new Error(message), { code: result.code })
    : new Error(message);
}
