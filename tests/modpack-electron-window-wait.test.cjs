const assert = require('node:assert/strict');
const test = require('node:test');

const harness = require('./e2e/fixtures/modpack-harness.cjs');

test('source Electron launch allows a slow checkout up to the bounded startup timeout', async () => {
  assert.equal(typeof harness.waitForFirstElectronWindow, 'function');
  const expectedPage = { id: 'main-window' };
  let receivedOptions = null;
  const electronApp = {
    async firstWindow(options) {
      receivedOptions = options;
      return expectedPage;
    }
  };

  const page = await harness.waitForFirstElectronWindow(electronApp);

  assert.equal(page, expectedPage);
  assert.deepEqual(receivedOptions, { timeout: 120_000 });
});

test('failed source Electron window discovery closes the launched process before reporting the error', async () => {
  const expectedError = new Error('main window did not open');
  let closed = false;
  const electronApp = {
    async firstWindow() {
      throw expectedError;
    },
    async close() {
      closed = true;
    }
  };

  await assert.rejects(
    harness.waitForFirstElectronWindow(electronApp),
    error => error === expectedError
  );
  assert.equal(closed, true);
});
