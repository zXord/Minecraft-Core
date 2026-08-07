const assert = require('node:assert/strict');
const test = require('node:test');

let notificationModule;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observeStore(store) {
  let value;
  const unsubscribe = store.subscribe(state => {
    value = state;
  });
  return {
    get value() { return value; },
    unsubscribe
  };
}

function installBridge(invoke) {
  const listeners = new Map();
  global.window = {
    electron: {
      invoke,
      on(channel, handler) { listeners.set(channel, handler); },
      removeListener(channel) { listeners.delete(channel); }
    }
  };
  return listeners;
}

test.before(async () => {
  notificationModule = await import('../../src/stores/modpackNotificationStore.js');
});

test.afterEach(() => {
  notificationModule.modpackNotificationStore.destroy();
  delete global.window;
});

test('global notification affordance appears only for unread actionable notifications', () => {
  assert.equal(typeof notificationModule.deriveModpackNotificationPresentation, 'function');

  const derive = notificationModule.deriveModpackNotificationPresentation;
  const quiet = derive({
    items: [
      { notificationId: 'read-action', serverId: 'server-a', read: true, action: { actionId: 'open-details' } },
      { notificationId: 'unread-history', serverId: 'server-a', read: false, action: null }
    ],
    serverId: 'server-a',
    managed: false,
    recoveryCount: 0
  });
  const attention = derive({
    items: [
      { notificationId: 'unread-action', serverId: 'server-b', read: false, action: { actionId: 'review-recovery' } },
      { notificationId: 'unread-history', serverId: 'server-a', read: false, action: null }
    ],
    serverId: 'server-a',
    managed: false,
    recoveryCount: 0
  });

  assert.equal(quiet.showGlobalBell, false);
  assert.equal(quiet.globalUnreadActionableCount, 0);
  assert.equal(attention.showGlobalBell, true);
  assert.equal(attention.globalUnreadActionableCount, 1);
});

test('contextual notification control appears for managed state retained server history or recovery', () => {
  const derive = notificationModule.deriveModpackNotificationPresentation;
  const base = { items: [], serverId: 'server-a', managed: false, recoveryCount: 0 };

  assert.equal(derive(base).showContextualControl, false);
  assert.equal(derive({ ...base, managed: true }).showContextualControl, true);
  assert.equal(derive({ ...base, recoveryCount: 1 }).showContextualControl, true);
  assert.equal(derive({
    ...base,
    items: [{ notificationId: 'retained', serverId: 'server-a', read: true, action: null }]
  }).showContextualControl, true);
  assert.equal(derive({
    ...base,
    items: [{ notificationId: 'other-server', serverId: 'server-b', read: false, action: { actionId: 'open-details' } }]
  }).showContextualControl, false);
});

test('current server badge and history exclude notifications owned by other servers', () => {
  const result = notificationModule.deriveModpackNotificationPresentation({
    serverId: 'server-a',
    items: [
      { notificationId: 'a-unread', serverId: 'server-a', read: false, action: null },
      { notificationId: 'a-read', serverId: 'server-a', read: true, action: { actionId: 'open-details' } },
      { notificationId: 'b-unread', serverId: 'server-b', read: false, action: { actionId: 'open-details' } }
    ]
  });

  assert.deepEqual(result.currentServerItems.map(item => item.notificationId), ['a-unread', 'a-read']);
  assert.equal(result.currentServerUnreadCount, 1);
});

test('global notification attention excludes only the active Modpack server', () => {
  const result = notificationModule.deriveModpackNotificationPresentation({
    serverId: 'server-a',
    excludeServerId: 'server-a',
    items: [
      { notificationId: 'a-action', serverId: 'server-a', read: false, action: { actionId: 'open-details' } },
      { notificationId: 'b-action', serverId: 'server-b', read: false, action: { actionId: 'review-recovery' } },
      { notificationId: 'b-history', serverId: 'server-b', read: false, action: null }
    ]
  });

  assert.deepEqual(result.globalItems.map(item => item.notificationId), ['b-action', 'b-history']);
  assert.equal(result.globalUnreadActionableCount, 1);
  assert.equal(result.showGlobalBell, true);
});

test('recovery records are scoped to the active server across supported identity fields', () => {
  assert.equal(typeof notificationModule.filterRecoveryRecordsForServer, 'function');
  const records = [
    { recoveryId: 'direct', serverId: 'server-a' },
    { recoveryId: 'instance', instanceId: 'server-a' },
    { recoveryId: 'stable', stableServerId: 'server-a' },
    { recoveryId: 'other', serverId: 'server-b' },
    null
  ];

  assert.deepEqual(
    notificationModule.filterRecoveryRecordsForServer(records, 'server-a').map(item => item.recoveryId),
    ['direct', 'instance', 'stable']
  );
  assert.deepEqual(notificationModule.filterRecoveryRecordsForServer({ items: records }, 'server-b'), [records[3]]);
  assert.deepEqual(notificationModule.filterRecoveryRecordsForServer(records, ''), []);
});

test('failed notification action stays unread and returns a retryable UI error without acknowledging', async () => {
  const calls = [];
  const listeners = installBridge(async (channel, request) => {
    calls.push({ channel, request });
    if (channel === 'modpacks:perform-safe-action') {
      return {
        ok: false,
        error: {
          code: 'COMMIT_FAILED',
          message: 'The safe action could not be completed.',
          retryable: true
        }
      };
    }
    if (channel === 'modpacks:ack-notification') {
      throw new Error('acknowledgement must not run after a failed action');
    }
    throw new Error(`Unexpected channel: ${channel}`);
  });
  const item = {
    notificationId: 'retry-action',
    serverId: 'server-a',
    read: false,
    action: { actionId: 'open-details', opaqueRef: 'opaque-action' }
  };
  notificationModule.modpackNotificationStore.connect();
  listeners.get('modpacks:notification')(item);
  const observed = observeStore(notificationModule.modpackNotificationStore);

  try {
    const outcome = await notificationModule.modpackNotificationStore.performNotificationAction(item);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.message, 'The safe action could not be completed.');
    assert.equal(outcome.error.retryable, true);
    assert.equal(observed.value.items[0].read, false);
    assert.equal(observed.value.actionError.notificationId, 'retry-action');
    assert.equal(observed.value.actionError.error.retryable, true);
    assert.deepEqual(calls.map(call => call.channel), ['modpacks:perform-safe-action']);
  } finally {
    observed.unsubscribe();
  }
});

test('successful notification action is durably acknowledged only after the action completes', async () => {
  const calls = [];
  const listeners = installBridge(async (channel) => {
    calls.push(channel);
    if (channel === 'modpacks:perform-safe-action') {
      return {
        ok: true,
        value: {
          type: 'outcome-action-result',
          actionId: 'open-details',
          status: 'ready',
          destination: { kind: 'details', targetId: 'server-a' }
        }
      };
    }
    if (channel === 'modpacks:ack-notification') {
      return { ok: true, value: { notificationId: 'ordered-action', read: true } };
    }
    throw new Error(`Unexpected channel: ${channel}`);
  });
  const item = {
    notificationId: 'ordered-action',
    serverId: 'server-a',
    read: false,
    action: { actionId: 'open-details', opaqueRef: 'opaque-action' }
  };
  notificationModule.modpackNotificationStore.connect();
  listeners.get('modpacks:notification')(item);
  const observed = observeStore(notificationModule.modpackNotificationStore);

  try {
    const outcome = await notificationModule.modpackNotificationStore.performNotificationAction(item);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.destination.kind, 'details');
    assert.deepEqual(calls, ['modpacks:perform-safe-action', 'modpacks:ack-notification']);
    assert.equal(observed.value.items[0].read, true);
    assert.equal(observed.value.actionError, null);
  } finally {
    observed.unsubscribe();
  }
});

test('live notification emitted during an in-flight list survives a stale list completion', async () => {
  const pendingList = deferred();
  const listeners = installBridge(async channel => {
    if (channel === 'modpacks:list-notifications') return pendingList.promise;
    throw new Error(`Unexpected channel: ${channel}`);
  });
  notificationModule.modpackNotificationStore.connect();
  const observed = observeStore(notificationModule.modpackNotificationStore);
  const listPromise = notificationModule.modpackNotificationStore.listNotifications();
  listeners.get('modpacks:notification')({
    notificationId: 'race-item',
    serverId: 'server-a',
    read: false,
    title: 'Live update',
    action: { actionId: 'open-details', opaqueRef: 'live-ref' }
  });
  pendingList.resolve({
    ok: true,
    value: {
      items: [{
        notificationId: 'race-item',
        serverId: 'server-a',
        read: true,
        title: 'Stale list copy',
        action: { actionId: 'open-details', opaqueRef: 'stale-ref' }
      }]
    }
  });

  try {
    await listPromise;
    assert.equal(observed.value.items.length, 1);
    assert.equal(observed.value.items[0].title, 'Live update');
    assert.equal(observed.value.items[0].read, false);
    assert.equal(observed.value.items[0].action.opaqueRef, 'live-ref');
  } finally {
    observed.unsubscribe();
  }
});

test('initial renderer load includes the full durable retention window and its oldest unread alert', async () => {
  const retained = Array.from({ length: 1000 }, (_, index) => ({
    notificationId: `retained-${index}`,
    serverId: 'server-a',
    read: index !== 999,
    title: `Retained ${index}`,
    action: index === 999 ? { actionId: 'review-recovery', opaqueRef: 'oldest-alert' } : null
  }));
  let requestedLimit = null;
  installBridge(async (channel, request) => {
    if (channel !== 'modpacks:list-notifications') throw new Error(`Unexpected channel: ${channel}`);
    requestedLimit = request.limit;
    return { ok: true, value: { items: retained.slice(0, request.limit) } };
  });
  const observed = observeStore(notificationModule.modpackNotificationStore);

  try {
    await notificationModule.modpackNotificationStore.listNotifications();
    const presentation = notificationModule.deriveModpackNotificationPresentation(observed.value);

    assert.equal(requestedLimit, 1000);
    assert.equal(observed.value.items.length, 1000);
    assert.equal(observed.value.items.at(-1).notificationId, 'retained-999');
    assert.equal(presentation.globalUnreadActionableCount, 1);
    assert.equal(presentation.showGlobalBell, true);
  } finally {
    observed.unsubscribe();
  }
});
