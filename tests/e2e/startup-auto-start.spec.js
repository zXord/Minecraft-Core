import { expect, test } from '@playwright/test';
import { createServer } from 'vite';

const HYDRATING_SERVER_PATH = 'C:\\servers\\startup-race';
const CLIENT_INSTANCE = Object.freeze({
  id: 'client-first',
  name: 'Client First',
  type: 'client',
  path: 'C:\\clients\\first',
  serverIp: '127.0.0.1'
});
const IDLE_SERVER_INSTANCE = Object.freeze({
  id: 'server-idle',
  name: 'Idle Server',
  type: 'server',
  path: 'C:\\servers\\idle'
});
const HYDRATING_SERVER_INSTANCE = Object.freeze({
  id: 'server-startup-race',
  name: 'Hydrating Server',
  type: 'server',
  path: HYDRATING_SERVER_PATH
});

let vite;
let appUrl;

test.beforeAll(async () => {
  vite = await createServer({
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false }
  });
  await vite.listen();
  appUrl = vite.resolvedUrls?.local?.[0];
  if (!appUrl) throw new Error('Vite did not publish a local test URL');
});

test.afterAll(async () => {
  await vite?.close();
});

test('client-first multi-server auto-start waits only for each server persistence boundary', async ({ page }) => {
  test.setTimeout(75_000);
  await page.addInitScript(({ clientInstance, idleServerInstance, hydratingServerInstance }) => {
    const listeners = new Map();
    const events = [];
    let ignoredSaveActive = false;
    let signalIgnoredSaveStarted;
    const ignoredSaveStarted = new Promise(resolve => {
      signalIgnoredSaveStarted = resolve;
    });
    let releaseIgnoredSave;
    const ignoredSaveReleased = new Promise(resolve => {
      releaseIgnoredSave = resolve;
    });
    const pathKey = hydratingServerInstance.path.toLowerCase();
    const fallbackKey = `minecraft-core:ignored-updates:${encodeURIComponent(pathKey)}`;
    window.__startupRace = { events, releaseIgnoredSave };
    window.serverPath = Object.freeze({
      get: async () => Object.freeze({
        path: hydratingServerInstance.path,
        serverSettings: Object.freeze({
          port: 25565,
          maxRam: 4,
          autoStartMinecraft: false,
          autoStartManagement: true
        })
      }),
      set: async () => ({ success: true })
    });
    window.electron = {
      async invoke(channel, ...args) {
        switch (channel) {
          case 'get-instances':
            await ignoredSaveStarted;
            return [clientInstance, idleServerInstance, hydratingServerInstance];
          case 'get-settings': {
            const selector = args[0] || {};
            return {
              success: true,
              settings: {
                port: selector.instanceId === idleServerInstance.id ? 25565 : 25566,
                maxRam: 4,
                managementPort: selector.instanceId === idleServerInstance.id ? 18085 : 18086,
                autoStartMinecraft: false,
                autoStartManagement: true
              }
            };
          }
          case 'get-ignored-mod-updates':
            return { success: true, found: false, data: {} };
          case 'save-ignored-mod-updates':
            events.push('ignored-save:start');
            ignoredSaveActive = true;
            signalIgnoredSaveStarted();
            await ignoredSaveReleased;
            ignoredSaveActive = false;
            events.push('ignored-save:end');
            return { success: true, changed: true };
          case 'start-management-server':
            if (args[0]?.serverPath === hydratingServerInstance.path && ignoredSaveActive) {
              events.push('management-start:hydrating:busy');
              const error = new Error('Another operation is already changing this server');
              error.code = 'OPERATION_IN_PROGRESS';
              throw error;
            }
            events.push(args[0]?.serverPath === idleServerInstance.path
              ? 'management-start:idle:success'
              : 'management-start:hydrating:success');
            return { success: true };
          case 'get-management-server-status':
            return { success: true, status: { isRunning: false, clientCount: 0 } };
          case 'get-management-invite-info':
            return { success: false, error: 'not needed by this startup test' };
          case 'read-config':
            return { version: '1.21.1', loader: 'fabric', loaderVersion: '0.16.0' };
          case 'get-disabled-mods':
          case 'get-server-mods':
          case 'get-installed-mod-info':
            return [];
          default:
            return { success: true };
        }
      },
      on(channel, callback) {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel).add(callback);
      },
      removeListener(channel, callback) {
        listeners.get(channel)?.delete(callback);
      },
      removeAllListeners(channel) {
        listeners.delete(channel);
      },
      send() {}
    };

    try {
      localStorage.setItem('currentInstance', JSON.stringify(clientInstance));
      localStorage.setItem('instances', JSON.stringify([
        clientInstance,
        idleServerInstance,
        hydratingServerInstance
      ]));
      localStorage.setItem(fallbackKey, JSON.stringify({
        'Deferred.jar': { ids: ['deferred-version'], vers: [] }
      }));
    } catch {
      // The init script also runs for the initial opaque about:blank document.
    }
  }, {
    clientInstance: CLIENT_INSTANCE,
    idleServerInstance: IDLE_SERVER_INSTANCE,
    hydratingServerInstance: HYDRATING_SERVER_INSTANCE
  });

  // A cold Vite transform can take longer than the global navigation timeout on
  // slower disks. Commit proves that the HTML renderer is reachable; the
  // assertions below still require the application module to mount and finish.
  await page.goto(appUrl, { waitUntil: 'commit' });
  await expect.poll(
    () => page.evaluate(() => window.__startupRace.events),
    { timeout: 45_000 }
  ).toContain('management-start:idle:success');
  expect(await page.evaluate(() => window.__startupRace.events)).toEqual([
    'ignored-save:start',
    'management-start:idle:success'
  ]);
  await page.evaluate(() => window.__startupRace.releaseIgnoredSave());
  await expect.poll(
    () => page.evaluate(() => window.__startupRace.events),
    { timeout: 10_000 }
  ).toContain('management-start:hydrating:success');
  expect(await page.evaluate(() => window.__startupRace.events)).toEqual([
    'ignored-save:start',
    'management-start:idle:success',
    'ignored-save:end',
    'management-start:hydrating:success'
  ]);
  await page.waitForLoadState('load', { timeout: 30_000 });
  await expect(page.locator('#app')).not.toBeEmpty();
  await expect(page.locator('#startup-splash')).toHaveCount(0);
});
