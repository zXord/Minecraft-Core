const assert = require('node:assert/strict');
const test = require('node:test');

const { NativeModpackNotificationBridge } = require('../../electron/services/modpacks/notifications/native-notification-bridge.cjs');

function notification() {
  return {
    notificationId: 'notice-one',
    type: 'update-available',
    serverId: 'server-one',
    source: { provider: 'github', sourceId: '1234' },
    release: { releaseId: '5678', version: 'v1.2.0', prerelease: false },
    timestamp: '2026-08-02T00:00:00.000Z',
    read: false,
    title: 'Modpack update available',
    message: 'Release v1.2.0 is ready to review.',
    action: { actionId: 'open-details', opaqueRef: 'release-one' },
    dedupeKey: 'tracking-one:5678:update'
  };
}

test('a durable notification is forwarded to the renderer and shown natively without executing its action', () => {
  const sent = [];
  const shown = [];
  const listeners = new Map();
  let windowShows = 0;
  class FakeNotification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; shown.push(this); }
    on(name, listener) { listeners.set(name, listener); }
    show() { this.shown = true; }
    close() { this.closed = true; }
  }
  const window = {
    isDestroyed: () => false,
    show() { windowShows += 1; },
    focus() { windowShows += 1; },
    webContents: { send(channel, value) { sent.push([channel, value]); } }
  };
  const bridge = new NativeModpackNotificationBridge({
    Notification: FakeNotification,
    getWindow: () => window
  });
  const emitted = bridge.publish(notification());
  assert.equal(emitted.notificationId, 'notice-one');
  assert.deepEqual(sent.map(([channel]) => channel), ['modpacks:notification']);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].options, {
    title: 'Modpack update available',
    body: 'Release v1.2.0 is ready to review.',
    silent: false
  });
  assert.equal(shown[0].shown, true);
  assert.equal(sent.length, 1);
  listeners.get('click')();
  assert.equal(windowShows, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0], 'modpacks:notification');
});

test('unsupported native notifications still reach the renderer and malformed payloads fail closed', () => {
  const sent = [];
  class UnsupportedNotification { static isSupported() { return false; } }
  const bridge = new NativeModpackNotificationBridge({
    Notification: UnsupportedNotification,
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { send(channel, value) { sent.push([channel, value]); } }
    })
  });
  bridge.publish(notification());
  assert.equal(sent.length, 1);
  assert.throws(
    () => bridge.publish({ ...notification(), serverPath: 'C:\\private' }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('job progress logs and durable state changes use only their exact renderer event channels', () => {
  const sent = [];
  const bridge = new NativeModpackNotificationBridge({
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { send(channel, value) { sent.push([channel, value]); } }
    })
  });
  bridge.publishJobEvent({ jobId: 'job-one', channel: 'progress', phase: 'staging', progress: 50 });
  bridge.publishJobEvent({ jobId: 'job-one', channel: 'log', phase: 'staging', message: 'Candidate validated' });
  bridge.publishStateChanged({ serverId: 'server-one', contentRevision: 5, managed: true });
  assert.deepEqual(sent.map(([channel]) => channel), [
    'modpacks:job-progress', 'modpacks:job-log', 'modpacks:state-changed'
  ]);
  assert.throws(() => bridge.publishJobEvent({ jobId: 'job-one', channel: 'native' }), error => error.code === 'INVALID_REQUEST');
});
