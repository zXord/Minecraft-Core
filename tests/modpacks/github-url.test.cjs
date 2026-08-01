const assert = require('node:assert/strict');
const test = require('node:test');

const { parsePublicGitHubUrl } = require('../../electron/services/modpacks/providers/github-url.cjs');

test('parses only exact public repository and tag release URLs into immutable lookup hints', () => {
  const repository = parsePublicGitHubUrl('https://github.com/Example-Org/Server_Pack');
  assert.deepEqual(repository, { kind: 'repository', owner: 'Example-Org', repo: 'Server_Pack' });
  assert.equal(Object.isFrozen(repository), true);

  const release = parsePublicGitHubUrl('https://github.com/Example-Org/Server_Pack/releases/tag/v2.0.1-beta');
  assert.deepEqual(release, {
    kind: 'release-tag', owner: 'Example-Org', repo: 'Server_Pack', tag: 'v2.0.1-beta'
  });
  assert.equal(Object.isFrozen(release), true);
});

test('accepts the releases index as a repository hint but rejects dynamic latest and asset URLs', () => {
  assert.deepEqual(parsePublicGitHubUrl('https://github.com/owner/repo/releases/'), {
    kind: 'repository', owner: 'owner', repo: 'repo'
  });
  for (const value of [
    'https://github.com/owner/repo/releases/latest',
    'https://github.com/owner/repo/releases/download/v1/server.zip',
    'https://github.com/owner/repo/archive/refs/tags/v1.zip',
    'https://github.com/owner/repo/issues'
  ]) {
    assert.throws(() => parsePublicGitHubUrl(value), error => error.code === 'INVALID_RELEASE_URL');
  }
});

test('rejects credentials ports queries fragments subdomains lookalikes and non-HTTPS schemes', () => {
  for (const value of [
    'http://github.com/owner/repo',
    'https://user:secret@github.com/owner/repo',
    'https://github.com:443/owner/repo',
    'https://github.com:8443/owner/repo',
    'https://github.com/owner/repo?token=secret',
    'https://github.com/owner/repo#fragment',
    'https://api.github.com/owner/repo',
    'https://github.com.evil.example/owner/repo',
    'https://evilgithub.com/owner/repo'
  ]) {
    assert.throws(() => parsePublicGitHubUrl(value), error =>
      error.code === 'INVALID_RELEASE_URL' && !String(error.message).includes('secret'));
  }
});

test('rejects encoded separators traversal backslashes dot-git ambiguity and unsafe names', () => {
  for (const value of [
    'https://github.com/owner%2Frepo/pack',
    'https://github.com/owner/repo%2Fother',
    'https://github.com/owner/repo/releases/tag/v1%2Fserver',
    'https://github.com/owner/../repo',
    'https://github.com/owner//repo',
    'https://github.com/owner/repo/releases//tag/v1',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo\\releases\\tag\\v1',
    'https://github.com/-owner/repo',
    'https://github.com/owner-/repo',
    'https://github.com/owner/.git',
    ' https://github.com/owner/repo'
  ]) {
    assert.throws(() => parsePublicGitHubUrl(value), error => error.code === 'INVALID_RELEASE_URL');
  }
});

test('rejects non-string and overlong public URL input without reflecting it', () => {
  for (const value of [null, {}, `https://github.com/owner/${'a'.repeat(101)}`]) {
    assert.throws(() => parsePublicGitHubUrl(value), error =>
      error.code === 'INVALID_RELEASE_URL' && String(error.message).length < 257);
  }
});
