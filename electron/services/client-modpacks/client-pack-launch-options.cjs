const path = require('node:path');
const { ModpackError } = require('../modpacks/errors.cjs');

// Only the internal reservation argument carries this authority, never launch options.
function managedLaunchOptions(options, reservation) {
  const authority = reservation?.authority;
  if (!authority) return options;
  if (authority.clientPath !== options.clientPath || !authority.runtime ||
      typeof authority.javaPath !== 'string' || !path.isAbsolute(authority.javaPath) ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/.test(authority.profileId)) {
    throw new ModpackError('RUNTIME_INCOMPLETE', 'The exact installed client runtime must be verified before launching');
  }
  return { ...options, clientPath: authority.clientPath,
    maxMemory: Number.isSafeInteger(options.maxMemory) && options.maxMemory >= 512 && options.maxMemory <= 65536 ? options.maxMemory : 4096,
    minecraftVersion: authority.runtime.minecraftVersion, loaderType: authority.runtime.loaderFamily,
    loaderVersion: authority.runtime.loaderVersion, javaPath: authority.javaPath,
    serverIp: authority.serverIp, serverPort: authority.serverPort };
}
module.exports = { managedLaunchOptions };
