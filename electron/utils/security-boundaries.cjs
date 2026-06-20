const path = require('path');
const net = require('net');

function normalizePathForCompare(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(childPath, parentPath) {
  const child = normalizePathForCompare(childPath);
  const parent = normalizePathForCompare(parentPath);
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPathInside(childPath, parentPath, message = 'Path is outside the allowed directory') {
  if (!isPathInside(childPath, parentPath)) {
    throw new Error(message);
  }
  return childPath;
}

function normalizeAllowedExtensions(allowedExtensions) {
  if (!allowedExtensions) return null;
  const values = Array.isArray(allowedExtensions) ? allowedExtensions : [allowedExtensions];
  return values
    .map((extension) => String(extension || '').trim().toLowerCase())
    .filter(Boolean)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);
}

function safeBaseName(value, label = 'file name', options = {}) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${label}`);
  }

  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed !== value ||
    trimmed.includes('\0') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed === '.' ||
    trimmed === '..' ||
    path.basename(trimmed) !== trimmed ||
    path.win32.basename(trimmed) !== trimmed ||
    path.posix.basename(trimmed) !== trimmed ||
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed)
  ) {
    throw new Error(`Invalid ${label}`);
  }

  const allowedExtensions = normalizeAllowedExtensions(options.allowedExtensions);
  if (allowedExtensions && !allowedExtensions.some((extension) => trimmed.toLowerCase().endsWith(extension))) {
    throw new Error(`Invalid ${label}`);
  }

  return trimmed;
}

function safeJoin(baseDir, ...segments) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(resolvedBase, ...segments);
  return assertPathInside(resolvedPath, resolvedBase);
}

function safeFilePath(baseDir, fileName, label = 'file name', options = {}) {
  const safeName = safeBaseName(fileName, label, options);
  return safeJoin(baseDir, safeName);
}

function normalizeHost(value) {
  return String(value || '').replace(/^\[|\]$/g, '').trim().toLowerCase();
}

function isPrivateIpAddress(hostname) {
  const host = normalizeHost(hostname);
  const family = net.isIP(host);

  if (family === 4) {
    const parts = host.split('.').map((part) => Number.parseInt(part, 10));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19) ||
      a >= 224
    );
  }

  if (family === 6) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
    if (host.startsWith('::ffff:')) return isPrivateIpAddress(host.slice('::ffff:'.length));
  }

  return false;
}

function isLocalHostname(hostname) {
  const host = normalizeHost(hostname);
  return host === 'localhost' || host.endsWith('.localhost') || isPrivateIpAddress(host);
}

function hostMatchesAllowedList(hostname, allowedHosts = []) {
  const host = normalizeHost(hostname);
  return allowedHosts.some((entry) => {
    const allowed = normalizeHost(entry);
    if (!allowed) return false;
    if (allowed.startsWith('.')) return host.endsWith(allowed);
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

function assertSafeRemoteUrl(value, options = {}) {
  const allowedProtocols = options.allowedProtocols || ['https:'];
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('Invalid download URL');
  }

  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error('Download URL protocol is not allowed');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Download URL credentials are not allowed');
  }

  if (options.allowedHosts && !hostMatchesAllowedList(parsed.hostname, options.allowedHosts)) {
    throw new Error('Download URL host is not allowed');
  }

  if (options.blockPrivateHosts !== false && isLocalHostname(parsed.hostname)) {
    throw new Error('Download URL host is not allowed');
  }

  return parsed.toString();
}

function resolveSafeRedirectUrl(location, previousUrl, options = {}) {
  if (!location || typeof location !== 'string') {
    throw new Error('Redirect location is missing');
  }
  const next = new URL(location, previousUrl);
  return assertSafeRemoteUrl(next.toString(), options);
}

function getSocketRemoteAddress(req) {
  return (
    (req && req.socket && req.socket.remoteAddress) ||
    (req && req.connection && req.connection.remoteAddress) ||
    (req && req.ip) ||
    'unknown'
  );
}

function requestOriginMatchesHost(req) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  const host = normalizeHost(req?.headers?.host || (req?.get && req.get('host')) || '');
  if (!host) return false;

  const candidates = [
    req?.headers?.origin,
    req?.headers?.referer
  ].filter((value) => typeof value === 'string' && value.trim());

  if (candidates.length === 0) {
    return false;
  }

  return candidates.some((value) => {
    try {
      const parsed = new URL(value);
      const parsedHost = normalizeHost(parsed.host || parsed.hostname);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsedHost === host;
    } catch {
      return false;
    }
  });
}

function escapeWmicLikeLiteral(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/\[/g, '[[]')
    .replace(/%/g, '[%]')
    .replace(/_/g, '[_]');
}

module.exports = {
  assertPathInside,
  assertSafeRemoteUrl,
  escapeWmicLikeLiteral,
  getSocketRemoteAddress,
  hostMatchesAllowedList,
  isLocalHostname,
  isPathInside,
  isPrivateIpAddress,
  normalizeHost,
  requestOriginMatchesHost,
  resolveSafeRedirectUrl,
  safeBaseName,
  safeFilePath,
  safeJoin
};
