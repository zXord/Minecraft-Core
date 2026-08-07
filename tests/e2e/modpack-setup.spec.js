import { expect, test } from '@playwright/test';
import harness from './fixtures/modpack-harness.cjs';

async function returnToOverview(page) {
  const back = page.getByRole('button', { name: 'Back to Modpack overview' });
  if (await back.isVisible().catch(() => false)) await back.click();
  await expect(page.getByRole('heading', { name: 'Modpack', exact: true })).toBeVisible();
}

async function openSource(page) {
  await returnToOverview(page);
  await page.getByRole('button', { name: 'Install modpack' }).click();
  await expect(page.getByRole('heading', { name: 'Choose where the pack is published' })).toBeVisible();
}

async function openGithubRelease(page, releaseName = 'Fixture Release v2') {
  await openSource(page);
  await page.getByRole('radio', { name: /GitHub Releases/u }).click();
  await page.getByLabel('Public repository or release URL').fill('https://github.com/FixtureOrg/FixturePack');
  await page.getByRole('button', { name: 'Load releases' }).click();
  await page.getByRole('button', { name: new RegExp(releaseName, 'u') }).click();
}

async function chooseGithubAsset(page, assetName, { rememberPattern = false } = {}) {
  await openGithubRelease(page);
  await page.getByRole('radio', { name: new RegExp(assetName.replaceAll('.', '\\.'), 'u') }).click();
  if (rememberPattern) await page.getByLabel('Use this asset pattern for future releases').check();
  await page.getByRole('button', { name: 'Download and inspect selected asset' }).click();
}

test.describe.serial('new server setup', () => {
  let fixture;

  test.beforeAll(async () => {
    fixture = await harness.launchModpackApp({ profile: 'empty' });
  });

  test.afterAll(async () => fixture?.close());

  test('manual setup remains unchanged and source choice uses exact availability copy', async () => {
    const { page } = fixture;
    await page.getByRole('button', { name: /Create Your First Instance/u }).click();
    await page.getByRole('button', { name: /Server Manager/u }).click();
    await expect(page.getByRole('heading', { name: 'How do you want to set it up?' })).toBeVisible();
    await page.getByRole('button', { name: /Empty\/Custom Server/u }).click();
    await expect(page.getByRole('heading', { name: 'Select a folder to set up Minecraft Core' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to setup method' }).click();
    await page.getByRole('button', { name: /Install Modpack/u }).click();
    await expect(page.getByText('CurseForge (Unavailable)', { exact: true })).toBeVisible();
    await expect(page.getByText('CurseForge browsing is unavailable in this build.', { exact: true })).toBeVisible();
    await expect(page.getByText(/Coming Soon|coming soon/u)).toHaveCount(0);
    await expect(page.locator('[aria-current="step"]')).toContainText('Source');
  });

  test('Modrinth setup traverses exact version, preflight, progress, and managed completion', async () => {
    const { page } = fixture;
    await page.getByRole('radio', { name: /Modrinth/u }).click();
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await page.getByRole('button', { name: /^2\.0\.0/u }).click();
    await expect(page.getByText('mrpack archive', { exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Server utilities/u })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Example configuration/u })).not.toBeChecked();
    await page.getByRole('button', { name: 'Run preflight review' }).click();
    await page.getByLabel('I accept the Minecraft EULA').check();
    await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
    await expect(page.getByRole('progressbar', { name: 'Downloading' })).toHaveAttribute('aria-valuenow', '35');
    await expect(page.getByText('Verifying exact offline fixture bytes', { exact: true })).toHaveAttribute('aria-live', 'polite');
    // Completing initial setup publishes the instance and intentionally returns to
    // the server dashboard; result-focus coverage lives in the management flow.
    await expect(page.locator('.server-tabs').getByRole('button', { name: /^Modpack(?:,|$)/u })).toBeVisible();
    const evidence = fixture.readState();
    expect(evidence.state).toMatchObject({ modpackManaged: true, lifecycleMode: 'managed' });
    expect(evidence.lifecycleCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'createPlan', operationKind: 'install-new' }),
      expect.objectContaining({ method: 'startOperation', operationKind: 'install-new' })
    ]));
    expect(evidence.ambientNetworkRequests).toBe(0);
  });
});

test.describe.serial('offline setup source and archive outcomes', () => {
  let fixture;

  test.beforeAll(async () => {
    fixture = await harness.launchModpackApp({ profile: 'unmanaged' });
    await fixture.openModpack();
  });

  test.afterAll(async () => fixture?.close());

  test('local registered selection is inspected without exposing a filesystem authority', async () => {
    const { page } = fixture;
    await openSource(page);
    await page.getByRole('radio', { name: /Local archive/u }).click();
    await expect(page.getByText('zip archive', { exact: true })).toBeVisible();
    const evidence = fixture.readState();
    expect(evidence.providerCalls.some(call => call.provider === 'local' && call.method === 'selectWithNativeDialog')).toBe(true);
    expect(evidence.ambientNetworkRequests).toBe(0);
  });

  test('GitHub uploaded MRPACK, ZIP, RAR, and complete multipart RAR sets reach guided inspection', async () => {
    const { page } = fixture;
    for (const [asset, archive] of [
      ['fixture-server.mrpack', 'mrpack archive'],
      ['fixture-server.zip', 'zip archive'],
      ['fixture-server.rar', 'rar5 archive'],
      ['fixture.part01.rar', 'multipart-rar archive']
    ]) {
      await chooseGithubAsset(page, asset, { rememberPattern: asset === 'fixture-server.zip' });
      await expect(page.getByText(archive, { exact: true })).toBeVisible();
    }
    expect(fixture.readState().assetPatternRemembered).toBe(true);
  });

  test('GitHub no-asset, missing-digest, ambiguity, client-only, encrypted, changed-set, and files-only outcomes stay explicit', async () => {
    const { page } = fixture;
    await openGithubRelease(page, 'Source-only Release');
    await expect(page.getByText('NO_INSTALLABLE_ASSET', { exact: true })).toBeVisible();

    await chooseGithubAsset(page, 'fixture-missing-digest.zip');
    const preflight = page.getByRole('button', { name: 'Run preflight review' });
    await expect(preflight).toBeDisabled();
    await page.getByLabel('Missing digest acknowledgement').check();
    await expect(preflight).toBeEnabled();

    await chooseGithubAsset(page, 'fixture-ambiguous.zip');
    await expect(page.getByText('Unresolved ambiguity blocks installation', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: /server-a/u }).check();
    await expect(page.getByRole('button', { name: 'Run preflight review' })).toBeEnabled();

    for (const [asset, code] of [
      ['fixture-client-only.mrpack', 'CLIENT_ONLY_PACK'],
      ['fixture-encrypted.zip', 'ENCRYPTED_ARCHIVE'],
      ['fixture-republished.zip', 'ASSET_CHANGED']
    ]) {
      await chooseGithubAsset(page, asset);
      await expect(page.getByText(code, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Dismiss' }).click();
    }

    await chooseGithubAsset(page, 'fixture-files-only.zip');
    await expect(page.getByText('files-only', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import safely as unmanaged files-only' })).toBeEnabled();
  });

  test('accepted Modrinth-linked repository remains explicit through GitHub asset review', async () => {
    const { page } = fixture;
    await openSource(page);
    await page.getByRole('radio', { name: /Modrinth/u }).click();
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await page.getByRole('button', { name: 'Review linked GitHub Releases' }).click();
    const approval = page.getByLabel('I explicitly approve using the GitHub repository linked by the selected Modrinth project.');
    await expect(page.getByRole('button', { name: 'Load releases' })).toBeDisabled();
    await approval.check();
    await page.getByRole('button', { name: 'Load releases' }).click();
    await page.getByRole('button', { name: /Fixture Release v2/u }).click();
    await page.getByRole('radio', { name: /fixture-server\.zip/u }).click();
    await page.getByRole('button', { name: 'Download and inspect selected asset' }).click();
    expect(fixture.readState().linkedRepositoryAccepted).toBe(true);
    expect(fixture.readState().ambientNetworkRequests).toBe(0);
  });
});
