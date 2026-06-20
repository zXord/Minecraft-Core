const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const {
  isAllowedLocalNavigation,
  isAllowedMainWindowFile,
  isTrustedMicrosoftAuthUrl,
  shouldAllowNavigation
} = require('../electron/utils/navigation-policy.cjs');

test('local navigation stays restricted to app and loopback urls', () => {
  assert.equal(isAllowedLocalNavigation('file:///index.html'), true);
  assert.equal(isAllowedLocalNavigation('file:///index.html', { isMainWindow: true }), false);
  assert.equal(isAllowedLocalNavigation('about:blank'), true);
  assert.equal(isAllowedLocalNavigation('http://localhost:5173'), true);
  assert.equal(isAllowedLocalNavigation('https://127.0.0.1:8080'), true);
  assert.equal(isAllowedLocalNavigation('https://login.live.com'), false);
});

test('main window may load only explicit app-owned file entries', () => {
  const entryPath = path.join(__dirname, '..', 'dist', 'index.html');
  const entryUrl = pathToFileURL(entryPath).toString();

  assert.equal(isAllowedMainWindowFile(entryUrl, [entryPath]), true);
  assert.equal(isAllowedLocalNavigation(entryUrl, { isMainWindow: true, allowedFilePaths: [entryPath] }), true);
  assert.equal(shouldAllowNavigation(entryUrl, { isMainWindow: true, allowedFilePaths: [entryPath] }), true);
  assert.equal(
    shouldAllowNavigation('file:///C:/Windows/System32/calc.exe', { isMainWindow: true, allowedFilePaths: [entryPath] }),
    false
  );
});

test('trusted Microsoft auth urls are recognized explicitly', () => {
  assert.equal(isTrustedMicrosoftAuthUrl('https://login.live.com/oauth20_authorize.srf'), true);
  assert.equal(isTrustedMicrosoftAuthUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize'), true);
  assert.equal(isTrustedMicrosoftAuthUrl('https://example.com/oauth'), false);
});

test('secondary auth windows may keep Microsoft login pages in-app without weakening the main window policy', () => {
  assert.equal(
    shouldAllowNavigation('file:///C:/Windows/System32/calc.exe', { isMainWindow: true }),
    false
  );
  assert.equal(
    shouldAllowNavigation('https://login.live.com/oauth20_authorize.srf', { isMainWindow: false }),
    true
  );
  assert.equal(
    shouldAllowNavigation('https://login.live.com/oauth20_authorize.srf', { isMainWindow: true }),
    false
  );
  assert.equal(
    shouldAllowNavigation('https://example.com', { isMainWindow: false }),
    false
  );
});
