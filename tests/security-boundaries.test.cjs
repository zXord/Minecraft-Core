const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  assertSafeRemoteUrl,
  escapeWmicLikeLiteral,
  requestOriginMatchesHost,
  resolveSafeRedirectUrl,
  safeBaseName,
  safeFilePath
} = require('../electron/utils/security-boundaries.cjs');

test('safeBaseName rejects traversal, absolute paths, and invisible name changes', () => {
  assert.equal(safeBaseName('mod.jar', 'mod file', { allowedExtensions: ['.jar'] }), 'mod.jar');

  assert.throws(() => safeBaseName('../mod.jar'), /Invalid file name/);
  assert.throws(() => safeBaseName('..\\mod.jar'), /Invalid file name/);
  assert.throws(() => safeBaseName('/tmp/mod.jar'), /Invalid file name/);
  assert.throws(() => safeBaseName(' mod.jar'), /Invalid file name/);
  assert.throws(() => safeBaseName('mod.zip', 'mod file', { allowedExtensions: ['.jar'] }), /Invalid mod file/);
});

test('safeFilePath keeps generated file paths inside the intended directory', () => {
  const root = path.join(process.cwd(), 'tmp-test-root');
  const filePath = safeFilePath(root, 'shader.zip', 'asset file', { allowedExtensions: ['.zip'] });

  assert.equal(filePath, path.join(root, 'shader.zip'));
  assert.throws(
    () => safeFilePath(root, '..\\outside.zip', 'asset file', { allowedExtensions: ['.zip'] }),
    /Invalid asset file/
  );
});

test('assertSafeRemoteUrl accepts public HTTPS and blocks local, private, credentialed, and non-HTTPS URLs', () => {
  assert.equal(assertSafeRemoteUrl('https://example.com/download.jar'), 'https://example.com/download.jar');

  assert.throws(() => assertSafeRemoteUrl('http://example.com/download.jar'), /protocol/i);
  assert.throws(() => assertSafeRemoteUrl('https://localhost/download.jar'), /host/i);
  assert.throws(() => assertSafeRemoteUrl('https://127.0.0.1/download.jar'), /host/i);
  assert.throws(() => assertSafeRemoteUrl('https://192.168.1.10/download.jar'), /host/i);
  assert.throws(() => assertSafeRemoteUrl('https://user:pass@example.com/download.jar'), /credentials/i);
});

test('resolveSafeRedirectUrl validates redirect targets with the same URL policy', () => {
  assert.equal(
    resolveSafeRedirectUrl('/next.jar', 'https://example.com/download.jar'),
    'https://example.com/next.jar'
  );

  assert.throws(
    () => resolveSafeRedirectUrl('http://example.com/next.jar', 'https://example.com/download.jar'),
    /protocol/i
  );
  assert.throws(
    () => resolveSafeRedirectUrl('https://10.0.0.5/next.jar', 'https://example.com/download.jar'),
    /host/i
  );
});

test('requestOriginMatchesHost requires same-origin metadata on state-changing requests', () => {
  assert.equal(requestOriginMatchesHost({ method: 'GET', headers: { host: 'localhost:8080' } }), true);
  assert.equal(
    requestOriginMatchesHost({
      method: 'POST',
      headers: { host: 'localhost:8080', origin: 'http://localhost:8080' }
    }),
    true
  );
  assert.equal(
    requestOriginMatchesHost({
      method: 'POST',
      headers: { host: 'localhost:8080', origin: 'http://evil.example' }
    }),
    false
  );
  assert.equal(requestOriginMatchesHost({ method: 'POST', headers: { host: 'localhost:8080' } }), false);
});

test('escapeWmicLikeLiteral escapes wildcard and quote characters', () => {
  assert.equal(escapeWmicLikeLiteral("C:\\Path_100%\\Bob's [Java]"), "C:\\\\Path[_]100[%]\\\\Bob''s [[]Java]");
});
