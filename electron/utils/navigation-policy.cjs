const path = require('path');
const { fileURLToPath } = require('url');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const MICROSOFT_AUTH_HOSTS = new Set([
  'login.live.com',
  'account.live.com',
  'signup.live.com',
  'login.microsoftonline.com',
  'login.microsoft.com'
]);

function parseNavigationUrl(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') return null;
  try {
    return new URL(targetUrl);
  } catch {
    return null;
  }
}

function normalizeFilePath(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    return path.normalize(value);
  } catch {
    return '';
  }
}

function parseFileUrlPath(targetUrl) {
  try {
    return normalizeFilePath(fileURLToPath(targetUrl));
  } catch {
    return '';
  }
}

function isAllowedMainWindowFile(targetUrl, allowedFilePaths = []) {
  const targetPath = parseFileUrlPath(targetUrl);
  if (!targetPath) return false;

  const allowedPaths = Array.isArray(allowedFilePaths) ? allowedFilePaths : [];
  return allowedPaths.some((allowedPath) => {
    const normalizedAllowed = normalizeFilePath(allowedPath);
    return normalizedAllowed && targetPath === normalizedAllowed;
  });
}

function isAllowedLocalNavigation(targetUrl, { isMainWindow = false, allowedFilePaths = [] } = {}) {
  const parsed = parseNavigationUrl(targetUrl);
  if (!parsed) return false;

  if (parsed.protocol === 'about:') {
    return parsed.href === 'about:blank';
  }

  if (parsed.protocol === 'file:') {
    return !isMainWindow || isAllowedMainWindowFile(targetUrl, allowedFilePaths);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  return LOOPBACK_HOSTS.has(parsed.hostname);
}

function isTrustedMicrosoftAuthUrl(targetUrl) {
  const parsed = parseNavigationUrl(targetUrl);
  if (!parsed) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  return MICROSOFT_AUTH_HOSTS.has(parsed.hostname);
}

function shouldAllowNavigation(targetUrl, { isMainWindow = false, allowedFilePaths = [] } = {}) {
  if (isAllowedLocalNavigation(targetUrl, { isMainWindow, allowedFilePaths })) {
    return true;
  }

  // Keep the main app window locked to app/local routes, but allow dedicated
  // secondary auth windows to stay inside Microsoft's cookie-bound login flow.
  if (!isMainWindow && isTrustedMicrosoftAuthUrl(targetUrl)) {
    return true;
  }

  return false;
}

module.exports = {
  isAllowedLocalNavigation,
  isAllowedMainWindowFile,
  isTrustedMicrosoftAuthUrl,
  shouldAllowNavigation
};
