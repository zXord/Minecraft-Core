const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldUseDevServer } = require('../electron/utils/runtime-mode.cjs');

test('npm start from source loads the built app instead of probing Vite ports', () => {
  assert.equal(
    shouldUseDevServer({
      isPackaged: false,
      enableDevServer: false,
      lifecycleEvent: 'start'
    }),
    false
  );
});

test('npm run dev keeps using the Vite dev server from source', () => {
  assert.equal(
    shouldUseDevServer({
      isPackaged: false,
      enableDevServer: false,
      lifecycleEvent: 'dev:electron'
    }),
    true
  );
});

test('packaged builds only use the dev server when explicitly enabled', () => {
  assert.equal(
    shouldUseDevServer({
      isPackaged: true,
      enableDevServer: false,
      lifecycleEvent: 'dev:electron'
    }),
    false
  );

  assert.equal(
    shouldUseDevServer({
      isPackaged: true,
      enableDevServer: true,
      lifecycleEvent: 'start'
    }),
    true
  );
});
