const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getAuthErrorMessage,
  shouldFallbackToEmbeddedMicrosoftAuth
} = require('../electron/services/minecraft-launcher/auth-launch-utils.cjs');

test('auth launch utils normalize string and Error instances consistently', () => {
  assert.equal(getAuthErrorMessage('error.gui.raw.noBrowser'), 'error.gui.raw.noBrowser');
  assert.equal(getAuthErrorMessage(new Error('spawn msedge.exe ENOENT')), 'spawn msedge.exe ENOENT');
});

test('embedded auth fallback only triggers for browser launch/environment failures', () => {
  assert.equal(shouldFallbackToEmbeddedMicrosoftAuth('error.gui.raw.noBrowser'), true);
  assert.equal(shouldFallbackToEmbeddedMicrosoftAuth(new Error('spawn msedge.exe ENOENT')), true);
  assert.equal(shouldFallbackToEmbeddedMicrosoftAuth(new Error('spawn msedge.exe EACCES')), true);

  assert.equal(shouldFallbackToEmbeddedMicrosoftAuth('error.gui.closed'), false);
  assert.equal(shouldFallbackToEmbeddedMicrosoftAuth(new Error('Failed to login to Microsoft account')), false);
});
