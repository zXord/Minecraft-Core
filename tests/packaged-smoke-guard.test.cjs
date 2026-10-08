const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPackagedSmokeGuard } = require('../electron/bootstrap/packaged-smoke-guard.cjs');

test('smoke guard attaches before windows and blocks/counts renderer public traffic', () => {
  const app = new EventEmitter();
  const guard = createPackagedSmokeGuard({ app });
  let beforeRequest;
  guard.installSessionBlock({ defaultSession: { webRequest: { onBeforeRequest(_filter, handler) { beforeRequest = handler; } } } });
  let result;
  beforeRequest({ url: 'https://modrinth.com/project' }, value => { result = value; });
  assert.deepEqual(result, { cancel: true });
  assert.equal(guard.evidence().rendererPublicNetworkRequests, 1);
});

test('smoke guard captures renderer failures from webContents created after early registration', () => {
  const app = new EventEmitter();
  const guard = createPackagedSmokeGuard({ app });
  const contents = new EventEmitter();
  app.emit('web-contents-created', {}, contents);
  contents.emit('did-fail-load', {}, -2, 'failed', 'file:///app.asar/dist/index.html', true);
  contents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.deepEqual(guard.evidence().webContentsErrors, [
    'did-fail-load: -2 failed file:///app.asar/dist/index.html',
    'render-process-gone: crashed'
  ]);
});
