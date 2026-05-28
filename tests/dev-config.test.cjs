const test = require('node:test');
const assert = require('node:assert/strict');

const devConfig = require('../config/dev-config.cjs');

test('production build config does not auto-open DevTools', () => {
  assert.equal(devConfig.enableDevConsole, false);
});
