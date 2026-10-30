const ALLOW_DEV_NATIVE_TOASTS_ENV = 'MINECRAFT_CORE_ALLOW_DEV_NATIVE_TOASTS';

// Electron's toast activator re-points the Start Menu '<ProductName>.lnk' and
// the HKCU toast CLSID at whichever exe shows a toast first. Only the installed
// copy may therefore create OS notifications; an unpackaged development run can
// opt in explicitly. Until configured, native toasts are denied.
let allowed = false;

function policyInputs(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  // configureNativeToastPolicy(getInstallIdentity()) passes the identity itself.
  const direct = !Object.hasOwn(options, 'identity') && typeof options.installed === 'boolean';
  const identity = direct ? options : options.identity;
  if (!identity || typeof identity !== 'object' || typeof identity.installed !== 'boolean') return null;
  const isPackaged = direct || options.isPackaged === undefined ? identity.isPackaged : options.isPackaged;
  const env = direct || options.env === undefined ? process.env : options.env;
  if (typeof isPackaged !== 'boolean' || !env || typeof env !== 'object') return null;
  return { identity, isPackaged, env };
}

/**
 * @param {{identity: {installed: boolean, isPackaged?: boolean}, isPackaged?: boolean, env?: object}} options
 *   isPackaged defaults to identity.isPackaged and env to process.env. An install
 *   identity (as returned by getInstallIdentity()) may also be passed directly.
 * @returns {boolean} whether native toasts are now allowed
 */
function configureNativeToastPolicy(options) {
  allowed = false;
  const inputs = policyInputs(options);
  if (!inputs) throw new TypeError('Native toast policy needs an install identity, isPackaged and env');
  allowed = inputs.identity.installed === true ||
    (inputs.isPackaged === false && inputs.env[ALLOW_DEV_NATIVE_TOASTS_ENV] === '1');
  return allowed;
}

function nativeToastsAllowed() {
  return allowed;
}

module.exports = { ALLOW_DEV_NATIVE_TOASTS_ENV, configureNativeToastPolicy, nativeToastsAllowed };
