const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');

test('global generic center shows unread unmanaged retention copy without an action and hides after resolution', async () => {
  const listeners = new Map();
  global.window = { electron: { async invoke() { return { ok: true, value: [] }; },
    on(channel, handler) { listeners.set(channel, handler); }, removeListener(channel) { listeners.delete(channel); } } };
  const { modpackNotificationStore } = await import('../../src/stores/modpackNotificationStore.js');
  modpackNotificationStore.connect();
  const notice = { notificationId: 'retention-component', serverId: 'unmanaged', type: 'retention-warning', read: false,
    title: 'Backup cleanup pending', message: 'This warning alone does not block Repair.', timestamp: '2026-10-11T00:00:00.000Z',
    source: { provider: 'local', sourceId: 'failed-backup-retirement' }, release: null, action: null, dedupeKey: 'retirement:job' };
  try {
    const { render } = await import('svelte/server'); const Component = await loadServerComponent('src/components/modpacks/ModpackNotificationCenter.svelte');
    listeners.get('modpacks:notification')(notice);
    const html = render(Component, { props: { variant: 'global', connectStore: false, open: true } }).body;
    assert.equal(html.includes('aria-label="Modpack notifications'), true);
    assert.equal(html.includes('Backup cleanup pending'), true);
    assert.equal(html.includes('review-restore-point'), false);
    listeners.get('modpacks:notification')({ ...notice, title: 'Backup cleanup complete', read: true });
    const resolved = render(Component, { props: { variant: 'global', connectStore: false } }).body;
    assert.equal(resolved.includes('aria-label="Modpack notifications'), false);
  } finally { modpackNotificationStore.destroy(); delete global.window; }
});

function moduleUrl(specifier) {
  return pathToFileURL(require.resolve(specifier)).href;
}

async function loadServerComponent(relativePath) {
  const { compile } = await import('svelte/compiler');
  const absolutePath = path.join(ROOT, relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  let code = compile(source, { filename: absolutePath, generate: 'server', dev: false }).js.code;
  code = code
    .replace("from 'svelte/internal/server'", `from '${moduleUrl('svelte/internal/server')}'`)
    .replace("from 'svelte'", `from '${moduleUrl('svelte')}'`)
    .replace(
      "from '../../stores/modpackNotificationStore.js'",
      `from '${pathToFileURL(path.join(ROOT, 'src/stores/modpackNotificationStore.js')).href}'`
    );
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
}

test('global bell does not render when there are no unread actionable notifications', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackNotificationCenter.svelte');
  const html = render(Component, { props: { variant: 'global' } }).body;

  assert.equal(html.includes('aria-label="Modpack notifications'), false);
});

test('contextual notification control renders for a managed server but not a pristine unmanaged server', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackNotificationCenter.svelte');
  const unmanagedHtml = render(Component, {
    props: { variant: 'contextual', serverId: 'server-a', managed: false, recoveryCount: 0, connectStore: false }
  }).body;
  const managedHtml = render(Component, {
    props: { variant: 'contextual', serverId: 'server-a', managed: true, recoveryCount: 0, connectStore: false }
  }).body;

  assert.equal(unmanagedHtml.includes('aria-label="Modpack notifications'), false);
  assert.equal(managedHtml.includes('aria-label="Modpack notifications'), true);
  assert.equal(managedHtml.includes('>Notifications<'), true);
});

test('contextual notification history renders only the active server records', async () => {
  const listeners = new Map();
  global.window = {
    electron: {
      async invoke() { return { ok: true, value: [] }; },
      on(channel, handler) { listeners.set(channel, handler); },
      removeListener(channel) { listeners.delete(channel); }
    }
  };
  const { modpackNotificationStore } = await import('../../src/stores/modpackNotificationStore.js');
  modpackNotificationStore.connect();
  const notify = listeners.get('modpacks:notification');
  assert.equal(typeof notify, 'function');
  notify({
    notificationId: 'server-a-item', serverId: 'server-a', type: 'integrity-warning', read: false,
    title: 'Current server notice', message: 'Belongs here', timestamp: '2026-08-07T00:00:00.000Z',
    source: { provider: 'github' }, release: null, action: null
  });
  notify({
    notificationId: 'server-b-item', serverId: 'server-b', type: 'update-available', read: false,
    title: 'Other server notice', message: 'Must stay out', timestamp: '2026-08-07T00:00:01.000Z',
    source: { provider: 'modrinth' }, release: null, action: { actionId: 'open-details', opaqueRef: 'opaque' }
  });

  try {
    const { render } = await import('svelte/server');
    const Component = await loadServerComponent('src/components/modpacks/ModpackNotificationCenter.svelte');
    const html = render(Component, {
      props: { variant: 'contextual', serverId: 'server-a', managed: true, connectStore: false, open: true }
    }).body;

    assert.equal(html.includes('Current server notice'), true);
    assert.equal(html.includes('Other server notice'), false);
  } finally {
    modpackNotificationStore.destroy();
    delete global.window;
  }
});

test('global bell excludes the active Modpack server but retains other-server attention', async () => {
  const listeners = new Map();
  global.window = {
    electron: {
      async invoke() { return { ok: true, value: [] }; },
      on(channel, handler) { listeners.set(channel, handler); },
      removeListener(channel) { listeners.delete(channel); }
    }
  };
  const { modpackNotificationStore } = await import('../../src/stores/modpackNotificationStore.js');
  modpackNotificationStore.connect();
  listeners.get('modpacks:notification')({
    notificationId: 'current-actionable', serverId: 'server-a', type: 'update-available', read: false,
    title: 'Current server update', message: 'Review it here', timestamp: '2026-08-07T00:00:00.000Z',
    source: { provider: 'modrinth' }, release: null, action: { actionId: 'open-details', opaqueRef: 'opaque' }
  });
  listeners.get('modpacks:notification')({
    notificationId: 'other-actionable', serverId: 'server-b', type: 'update-available', read: false,
    title: 'Other server update', message: 'Keep global attention', timestamp: '2026-08-07T00:00:01.000Z',
    source: { provider: 'github' }, release: null, action: { actionId: 'open-details', opaqueRef: 'opaque-b' }
  });

  try {
    const { render } = await import('svelte/server');
    const Component = await loadServerComponent('src/components/modpacks/ModpackNotificationCenter.svelte');
    const html = render(Component, {
      props: { variant: 'global', connectStore: false, excludeServerId: 'server-a', open: true }
    }).body;

    assert.match(html, /aria-label="Modpack notifications, 1 unread"/u);
    assert.equal(html.includes('Current server update'), false);
    assert.equal(html.includes('Other server update'), true);
  } finally {
    modpackNotificationStore.destroy();
    delete global.window;
  }
});

test('global bell hides when exclusion removes its only actionable notice', async () => {
  const listeners = new Map();
  global.window = {
    electron: {
      async invoke() { return { ok: true, value: [] }; },
      on(channel, handler) { listeners.set(channel, handler); },
      removeListener(channel) { listeners.delete(channel); }
    }
  };
  const { modpackNotificationStore } = await import('../../src/stores/modpackNotificationStore.js');
  modpackNotificationStore.connect();
  listeners.get('modpacks:notification')({
    notificationId: 'current-only', serverId: 'server-a', type: 'update-available', read: false,
    title: 'Current only', message: 'Context owns this', timestamp: '2026-08-07T00:00:00.000Z',
    source: { provider: 'modrinth' }, release: null, action: { actionId: 'open-details', opaqueRef: 'opaque' }
  });

  try {
    const { render } = await import('svelte/server');
    const Component = await loadServerComponent('src/components/modpacks/ModpackNotificationCenter.svelte');
    const html = render(Component, {
      props: { variant: 'global', connectStore: false, excludeServerId: 'server-a' }
    }).body;

    assert.equal(html.includes('aria-label="Modpack notifications'), false);
  } finally {
    modpackNotificationStore.destroy();
    delete global.window;
  }
});

test('notification trigger identifies its controlled panel', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackNotificationCenter.svelte');
  const html = render(Component, {
    props: { variant: 'contextual', serverId: 'server-a', managed: true, connectStore: false, open: true }
  }).body;

  assert.match(html, /aria-controls="modpack-notifications-contextual-server-a-panel"/u);
  assert.match(html, /id="modpack-notifications-contextual-server-a-panel"/u);
});

test('failed safe action remains visible with a retryable error in the notification panel', async () => {
  const listeners = new Map();
  global.window = {
    electron: {
      async invoke(channel) {
        if (channel === 'modpacks:perform-safe-action') {
          return {
            ok: false,
            error: {
              code: 'COMMIT_FAILED',
              message: 'The notification action is temporarily unavailable.',
              retryable: true
            }
          };
        }
        if (channel === 'modpacks:ack-notification') {
          throw new Error('failed actions must not be acknowledged');
        }
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on(channel, handler) { listeners.set(channel, handler); },
      removeListener(channel) { listeners.delete(channel); }
    }
  };
  const { modpackNotificationStore } = await import('../../src/stores/modpackNotificationStore.js');
  const item = {
    notificationId: 'retry-visible',
    serverId: 'server-a',
    type: 'update-available',
    read: false,
    title: 'Update needs review',
    message: 'Review the exact release.',
    timestamp: '2026-08-07T00:00:00.000Z',
    source: { provider: 'modrinth' },
    release: { version: '2.0.0' },
    action: { actionId: 'open-details', opaqueRef: 'retry-ref' }
  };
  modpackNotificationStore.connect();
  listeners.get('modpacks:notification')(item);
  await modpackNotificationStore.performNotificationAction(item);

  try {
    const { render } = await import('svelte/server');
    const Component = await loadServerComponent('src/components/modpacks/ModpackNotificationCenter.svelte');
    const html = render(Component, {
      props: { variant: 'contextual', serverId: 'server-a', managed: true, connectStore: false, open: true }
    }).body;

    assert.match(html, /role="alert"/u);
    assert.match(html, /The notification action is temporarily unavailable\./u);
    assert.match(html, /Try again/u);
    assert.match(html, /Update needs review/u);
    assert.match(html, /aria-label="Modpack notifications, 1 unread"/u);
  } finally {
    modpackNotificationStore.destroy();
    delete global.window;
  }
});
