import { _electron as electron, expect, test } from '@playwright/test';
import { createServer } from 'vite';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

function isolatedElectronEnvironment(userDataPath, devServerUrl) {
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    MINECRAFT_CORE_TEST_MODE: '1',
    MINECRAFT_CORE_USER_DATA_DIR: userDataPath,
    MINECRAFT_CORE_USE_DEV_SERVER: '1',
    MINECRAFT_CORE_DEV_SERVER_URL: devServerUrl,
    npm_lifecycle_event: 'dev:electron',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  };
  delete environment.MINECRAFT_CORE_TEST_MODPACK_FACTORY;
  delete environment.MINECRAFT_CORE_E2E_SCENARIO_FILE;
  delete environment.MINECRAFT_CORE_TEST_RECOVERY_FACTORY;
  return environment;
}

test('development startup renders the source app instead of a white or failed page', async () => {
  test.setTimeout(75_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-dev-startup-'));
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(userDataPath);
  let vite = null;
  let electronApp = null;
  let viteMiddleware = null;
  const developmentServer = http.createServer((request, response) => {
    if (!viteMiddleware) {
      request.socket.destroy();
      return;
    }
    viteMiddleware(request, response);
  });

  try {
    await new Promise((resolve, reject) => {
      developmentServer.once('error', reject);
      developmentServer.listen(0, '127.0.0.1', resolve);
    });
    const address = developmentServer.address();
    if (!address || typeof address === 'string') throw new Error('Development server did not bind an IPv4 port');
    const devServerUrl = `http://127.0.0.1:${address.port}`;

    electronApp = await electron.launch({
      args: ['.'],
      cwd: PROJECT_ROOT,
      env: isolatedElectronEnvironment(userDataPath, devServerUrl)
    });
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByRole('heading', { name: 'Starting Minecraft Core…' })).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(255, 255, 255)');

    vite = await createServer({
      logLevel: 'silent',
      appType: 'spa',
      server: { middlewareMode: true }
    });
    viteMiddleware = vite.middlewares;

    await expect(page.locator('#app')).not.toBeEmpty({ timeout: 45_000 });
    await expect(page.locator('#startup-splash')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Development server unavailable' })).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(255, 255, 255)');
  } finally {
    await electronApp?.close().catch(() => {});
    await vite?.close().catch(() => {});
    await new Promise(resolve => developmentServer.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
