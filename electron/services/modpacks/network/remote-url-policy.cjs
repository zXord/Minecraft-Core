const { domainToASCII } = require('node:url');
const dns = require('node:dns');
const ipaddr = require('ipaddr.js');
const { ModpackError } = require('../errors.cjs');

const IPV6_GENERAL_GLOBAL_UNICAST = Object.freeze([ipaddr.parse('2000::'), 3]);
const ADDITIONAL_NON_PUBLIC_RANGES = Object.freeze([
  Object.freeze([ipaddr.parse('198.18.0.0'), 15])
]);

function rejectUrl(reasonCode = 'host-not-allowed') {
  throw new ModpackError('INVALID_RELEASE_URL', 'Remote release address is not allowed', { details: { reasonCode } });
}

function normalizedHostname(value) {
  if (typeof value !== 'string' || !value) return '';
  const withoutDot = value.endsWith('.') ? value.slice(0, -1) : value;
  return domainToASCII(withoutDot).toLowerCase();
}

function normalizedHttpsOrigin(value) {
  let url;
  try { url = value instanceof URL ? new URL(value.href) : new URL(value); }
  catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    url.pathname !== '/' || url.search || url.hash) return '';
  const hostname = normalizedHostname(url.hostname);
  return hostname ? `https://${hostname}` : '';
}

function validateRemoteUrl(value, { allowedHosts, allowedOrigins, allowSubdomains = false } = {}) {
  let url;
  try { url = value instanceof URL ? new URL(value.href) : new URL(value); }
  catch { rejectUrl('malformed-url'); }
  if (url.protocol !== 'https:') rejectUrl('non-https');
  if (url.username || url.password) rejectUrl('credentials-not-allowed');
  if (url.port) rejectUrl('port-not-allowed');
  const addressHost = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  if (ipaddr.isValid(addressHost)) rejectUrl();
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || typeof allowSubdomains !== 'boolean') rejectUrl();
  const hostname = normalizedHostname(url.hostname);
  const allowed = allowedHosts.map(normalizedHostname).filter(Boolean);
  if (!hostname || !allowed.some(host => hostname === host || (allowSubdomains && hostname.endsWith(`.${host}`)))) rejectUrl();
  if (allowedOrigins !== undefined) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) rejectUrl('origin-not-allowed');
    const normalizedOrigins = allowedOrigins.map(normalizedHttpsOrigin);
    if (normalizedOrigins.some(origin => !origin) || !normalizedOrigins.includes(`https://${hostname}`)) {
      rejectUrl('origin-not-allowed');
    }
  }
  return url;
}

function parsedPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%') || !ipaddr.isValid(address)) return null;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
  const explicitlyNonPublic = ADDITIONAL_NON_PUBLIC_RANGES.some(([network, prefix]) =>
    parsed.kind() === network.kind() && parsed.match(network, prefix));
  const generallyAllocated = parsed.kind() !== 'ipv6' || parsed.match(IPV6_GENERAL_GLOBAL_UNICAST);
  return parsed.range() === 'unicast' && generallyAllocated && !explicitlyNonPublic ? parsed : null;
}

function addressFamilyMatches(address, family) {
  if (typeof address !== 'string' || address.includes('%') || !ipaddr.isValid(address)) return false;
  const kind = ipaddr.parse(address).kind();
  return kind === 'ipv4' ? family === 4 : family === 6;
}

function normalizeAddress(address) {
  const parsed = parsedPublicAddress(address);
  return parsed ? parsed.toNormalizedString() : null;
}

async function resolvePublicAddresses(hostname, { lookup = dns.promises.lookup } = {}) {
  let answers;
  try { answers = await lookup(hostname, { all: true, verbatim: true }); }
  catch { rejectUrl(); }
  if (!Array.isArray(answers) || answers.length === 0) rejectUrl();
  const result = answers.map(answer => {
    if (!answer || typeof answer !== 'object' || (answer.family !== 4 && answer.family !== 6) || !addressFamilyMatches(answer.address, answer.family) || !parsedPublicAddress(answer.address)) rejectUrl();
    return Object.freeze({ address: answer.address, family: answer.family });
  });
  return Object.freeze(result);
}

module.exports = { validateRemoteUrl, resolvePublicAddresses, normalizeAddress };
