const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const downloadManagerPath = require.resolve('../electron/services/download-manager.cjs');
const originalLoad = Module._load;
Module._load = function loadDownloadManagerFixture(request, parent, isMain) {
  if (request.endsWith('ipc/logger-handlers.cjs')) {
    return { getLoggerHandlers: () => ({ info: () => {}, debug: () => {}, error: () => {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
delete require.cache[downloadManagerPath];
const { __testUtils: { appendBoundedInstallerOutput, installerDiagnosticText } } = require(downloadManagerPath);
Module._load = originalLoad;

test('Fabric installer diagnostics retain only the bounded tail for an internal failure log', () => {
  let capture = { bytes: Buffer.alloc(0), truncated: false };
  capture = appendBoundedInstallerOutput(capture, Buffer.from('first\n', 'utf8'), 12);
  capture = appendBoundedInstallerOutput(capture, Buffer.from('second\nthird\n', 'utf8'), 12);

  assert.equal(capture.bytes.length, 12);
  assert.equal(capture.truncated, true);
  assert.equal(installerDiagnosticText(capture, 12), '[truncated; retained last 12 bytes]\necond\nthird\n');
});
