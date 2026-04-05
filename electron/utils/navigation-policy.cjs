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

function isAllowedLocalNavigation(targetUrl) {
  const parsed = parseNavigationUrl(targetUrl);
  if (!parsed) return false;

  if (parsed.protocol === 'file:' || parsed.protocol === 'about:') {
    return true;
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

function shouldAllowNavigation(targetUrl, { isMainWindow = false } = {}) {
  if (isAllowedLocalNavigation(targetUrl)) {
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
  isTrustedMicrosoftAuthUrl,
  shouldAllowNavigation
};
