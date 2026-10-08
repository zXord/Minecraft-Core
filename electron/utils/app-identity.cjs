const WINDOWS_PACKAGED_APP_USER_MODEL_ID = 'com.minecraft-core.app';
const WINDOWS_DEVELOPMENT_APP_USER_MODEL_ID = 'com.minecraft-core.app.dev';

function resolveWindowsAppUserModelId({ isPackaged = false } = {}) {
  if (typeof isPackaged !== 'boolean') {
    throw new TypeError('isPackaged must be a boolean');
  }
  return isPackaged
    ? WINDOWS_PACKAGED_APP_USER_MODEL_ID
    : WINDOWS_DEVELOPMENT_APP_USER_MODEL_ID;
}

module.exports = {
  WINDOWS_DEVELOPMENT_APP_USER_MODEL_ID,
  WINDOWS_PACKAGED_APP_USER_MODEL_ID,
  resolveWindowsAppUserModelId
};
