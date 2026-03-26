const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRequiredJavaVersion
} = require('../electron/services/minecraft-launcher/utils.cjs');

test('legacy Minecraft versions keep their historical Java requirements', () => {
  assert.equal(getRequiredJavaVersion('1.16.5'), 8);
  assert.equal(getRequiredJavaVersion('1.20.4'), 17);
  assert.equal(getRequiredJavaVersion('1.20.5'), 21);
});

test('new Minecraft version numbering maps to the newer Java runtime fallback', () => {
  assert.equal(getRequiredJavaVersion('26.1'), 25);
  assert.equal(getRequiredJavaVersion('26w13a'), 25);
});
