const { domainToASCII } = require('node:url');
const dns = require('node:dns');
const ipaddr = require('ipaddr.js');
const { ModpackError } = require('../errors.cjs');

function rejectUrl(reasonCode = 'host-not-allowed') {
  throw new ModpackError('INVALID_RELEASE_URL', 'Remote release address is not allowed', { details: { reasonCode } });
}

function normalizedHostname(value) {
  if (typeof value !== 'string' || !value) return '';
  const withoutDot = value.endsWith('.') ? value.slice(0, -1) : value;
  return domainToASCII(withoutDot).toLowerCase();
}

function validateRemoteUrl(value, { allowedHosts, allowSubdomains = false } = {}) {
  let url;
  try { url = value instanceof URL ? new URL(value.href) : new URL(value); }
  catch { rejectUrl('malformed-url'); }
  if (url.protocol !== 'https:') rejectUrl('non-https');
  if (url.username || url.password) rejectUrl('credentials-not-allowed');
  const addressHost = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  if (ipaddr.isValid(addressHost)) rejectUrl();
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || typeof allowSubdomains !== 'boolean') rejectUrl();
  const hostname = normalizedHostname(url.hostname);
  const allowed = allowedHosts.map(normalizedHostname).filter(Boolean);
  if (!hostname || !allowed.some(host => hostname === host || (allowSubdomains && hostname.endsWith(`.${host}`)))) rejectUrl();
  return url;
}

function parsedPublicAddress(address) {
  if (typeof address !== 'string' || !ipaddr.isValid(address)) return null;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
  return parsed.range() === 'unicast' ? parsed : null;
}

function addressFamilyMatches(address, family) {
  if (typeof address !== 'string' || !ipaddr.isValid(address)) return false;
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
