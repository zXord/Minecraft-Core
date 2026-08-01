const { ModpackError, deepFreeze } = require('../errors.cjs');

const OWNER = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,254}$/;

function invalid(reasonCode = 'malformed-url') {
  throw new ModpackError('INVALID_RELEASE_URL', 'GitHub repository address is invalid', {
    details: { reasonCode }
  });
}

function hasControl(value) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function parsePublicGitHubUrl(input) {
  if (typeof input !== 'string' || input.length < 1 || input.length > 2048 || input !== input.trim() || input.includes('\\') || input.includes('%') || hasControl(input)) invalid();
  if (!/^https:\/\//i.test(input)) invalid(/^http:/i.test(input) ? 'non-https' : 'malformed-url');

  const authority = /^https:\/\/([^/]+)(?:\/|$)/i.exec(input)?.[1];
  if (!authority) invalid();
  if (authority.includes('@')) invalid('credentials-not-allowed');
  if (authority.toLocaleLowerCase('en-US') !== 'github.com') invalid('host-not-allowed');

  let parsed;
  try { parsed = new URL(input); } catch { invalid(); }
  if (parsed.protocol !== 'https:') invalid('non-https');
  if (parsed.username || parsed.password) invalid('credentials-not-allowed');
  if (parsed.hostname.toLocaleLowerCase('en-US') !== 'github.com' || parsed.port) invalid('host-not-allowed');
  if (parsed.search || parsed.hash) invalid();
  if (parsed.pathname.includes('//')) invalid();

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || !OWNER.test(segments[0]) || !REPOSITORY.test(segments[1]) || segments[1].toLocaleLowerCase('en-US').endsWith('.git')) invalid();
  const [owner, repo] = segments;

  if (segments.length === 2 || (segments.length === 3 && segments[2] === 'releases')) {
    return deepFreeze({ kind: 'repository', owner, repo });
  }
  if (segments.length === 5 && segments[2] === 'releases' && segments[3] === 'tag' && TAG.test(segments[4])) {
    return deepFreeze({ kind: 'release-tag', owner, repo, tag: segments[4] });
  }
  invalid();
}

module.exports = { parsePublicGitHubUrl };
