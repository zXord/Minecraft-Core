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
  await page.getByRole('button', { name: /GitHub Releases/u }).click();
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

async function openModrinthBrowser(page) {
  await page.getByRole('button', { name: /Create Your First Instance/u }).click();
  await page.getByRole('button', { name: /Server Manager/u }).click();
  await page.getByRole('button', { name: /Install Modpack/u }).click();
  await page.getByRole('button', { name: /Browse Modrinth/u }).click();
}

test('Modrinth detail failure preserves usable exact version history', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'empty',
    modrinthFixture: { projectDetailFailures: ['fixture-pack'] }
  });
  try {
    const { page } = fixture;
    await openModrinthBrowser(page);
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await expect(page.getByRole('alert').getByText('Project details unavailable')).toBeVisible();
    await expect(page.getByRole('button', { name: /^2\.0\.0/u })).toBeVisible();
    await expect(page.getByText('This project has no published versions.')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('Modrinth history failure preserves usable project detail', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'empty',
    modrinthFixture: { versionHistoryFailures: ['fixture-pack'] }
  });
  try {
    const { page } = fixture;
    await openModrinthBrowser(page);
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await expect(page.getByText('Minecraft 1.21.1 · fabric')).toBeVisible();
    await expect(page.getByRole('alert').getByText('Version history unavailable')).toBeVisible();
    await expect(page.getByText('This project has no published versions.')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('Modrinth ignores stale project responses after Back and another project selection', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'empty',
    modrinthFixture: { includeAlternateProject: true, delayedProjectIds: ['fixture-pack'] }
  });
  try {
    const { page } = fixture;
    await openModrinthBrowser(page);
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await page.getByRole('button', { name: 'Back to results' }).click();
    await page.getByRole('button', { name: /Alternate Forge Pack/u }).click();
    await page.waitForTimeout(500);
    await expect(page.getByRole('heading', { name: 'Alternate Forge Pack' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^4\.0\.0/u })).toBeVisible();
    await expect(page.getByText('Fixture Factory Pack')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('server setup blocks a double version activation while inspection progress is visible', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'empty',
    modrinthFixture: {
      inspectionDelayMsByVersionId: {
        'version-forge-beta': 2000
      }
    }
  });
  try {
    const { page } = fixture;
    await openModrinthBrowser(page);
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    const version = page.getByRole('button', { name: /1\.20\.1 Forge beta/u });
    await version.evaluate(button => { button.click(); button.click(); });

    await expect(version).toBeDisabled();
    await expect(page.getByRole('progressbar', { name: 'Downloading selected asset' })).toHaveAttribute('value', '50');
    await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'inspectSource' && call.versionId === 'version-forge-beta').length).toBe(1);
  } finally {
    await fixture.close();
  }
});

test('GitHub asset selection stays neutral and reports correlated inspection progress', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'unmanaged',
    inspectionFixture: { delayMsByAssetId: { 'asset-zip': 700 } }
  });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await openGithubRelease(page);

    const asset = page.getByRole('radio', { name: /fixture-server\.zip/u });
    await asset.click();
    await expect(asset).toHaveAttribute('aria-checked', 'true');
    await expect(asset.getByText('Selected', { exact: true })).toBeVisible();
    expect(await asset.evaluate(element => getComputedStyle(element).outlineWidth)).not.toBe('4px');
    await expect.poll(() => asset.evaluate(element => {
      const style = getComputedStyle(element);
      return { backgroundColor: style.backgroundColor, borderLeftColor: style.borderLeftColor };
    })).toEqual({
      backgroundColor: 'rgba(255, 255, 255, 0.09)',
      borderLeftColor: 'rgba(255, 255, 255, 0.46)'
    });

    const inspect = page.getByRole('button', { name: 'Download and inspect selected asset' });
    await inspect.click();
    await expect(page.getByRole('button', { name: 'Inspection in progress…' })).toBeDisabled();
    await expect(page.getByRole('progressbar', { name: 'Downloading selected asset' })).toHaveAttribute('value', '50');
    await expect(page.getByText('512 B of 1.0 KB', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('cancelled destination selection stays explicit after showing live picker status', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'empty' });
  try {
    const { page, electronApp } = fixture;
    await openModrinthBrowser(page);
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await page.getByRole('button', { name: /^2\.0\.0/u }).click();
    await electronApp.evaluate(async ({ dialog }) => {
      dialog.showOpenDialog = async () => {
        await new Promise(resolve => setTimeout(resolve, 700));
        return { canceled: true, filePaths: [] };
      };
    });

    const chooseDestination = page.getByRole('button', { name: 'Choose destination and review plan' });
    await chooseDestination.click();
    await expect(page.getByText('The native folder picker is open.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Waiting for destination…' })).toBeDisabled();
    await expect(page.getByText('No destination was selected. Choose a folder to continue.', { exact: true })).toBeVisible();
    await expect(chooseDestination).toBeEnabled();
  } finally {
    await fixture.close();
  }
});

test('new-server retained download can be removed and can return to source selection', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'empty', retainedDownloadOnFirstJob: true });
  try {
    const { page } = fixture;
    await openModrinthBrowser(page);
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await page.getByRole('button', { name: /^2\.0\.0/u }).click();
    await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
    await page.getByLabel('I accept the Minecraft EULA').check();
    await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();

    await expect(page.getByRole('heading', { name: 'Downloaded file retained for manual use' })).toBeVisible();
    await expect(page.getByText(/eligible for automatic cleanup after seven days/u)).toBeVisible();
    await page.getByRole('button', { name: 'Remove download' }).click();
    await expect(page.getByRole('heading', { name: 'Downloaded file removed' })).toBeVisible();
    await page.getByRole('button', { name: 'Choose another asset' }).click();
    await expect(page.getByRole('heading', { name: 'Choose where the pack is published' })).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test('destination-recovery restart asks for a fresh destination before the next preflight', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'empty',
    destinationRecoveryOnFirstJob: true
  });
  try {
    const { page } = fixture;
    await openModrinthBrowser(page);
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await page.getByRole('button', { name: /^2\.0\.0/u }).click();
    await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
    await page.getByLabel('I accept the Minecraft EULA').check();
    await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();

    await expect(page.getByText('Destination has unfinished recovery', { exact: true })).toBeVisible();
    await expect.poll(() => fixture.readState().lifecycleCalls.filter(call =>
      call.method === 'reserveServerDestination').length).toBe(1);

    await page.getByRole('button', { name: 'Start setup again' }).click();
    await expect(page.getByRole('heading', { name: 'Choose where the pack is published' })).toBeVisible();
    await page.getByRole('button', { name: /Browse Modrinth/u }).click();
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await page.getByRole('button', { name: /^2\.0\.0/u }).click();
    await page.getByRole('button', { name: 'Choose destination and review plan' }).click();

    await expect(page.locator('p.destination-note').filter({ hasText: 'Chosen destination:' })).toContainText('fixture-server');
    await expect.poll(() => fixture.readState().lifecycleCalls.filter(call =>
      call.method === 'reserveServerDestination').length).toBe(2);
  } finally {
    await fixture.close();
  }
});

test('pending new-server recovery is resolved from setup with only its server-issued opaque action', async () => {
  const pendingRecovery = {
    recoveryId: 'recovery-11111111111111111111111111111111',
    serverId: 'pending-11111111111111111111111111111111',
    instanceId: 'pending-11111111111111111111111111111111',
    visibilityScope: 'pending-new-server',
    operationKind: 'install-new',
    phase: 'validating-candidate',
    automaticPossible: true,
    title: 'Recover interrupted server setup',
    summary: 'The interrupted setup can be resolved from its durable evidence.',
    actions: [{
      actionId: 'retry-recovery',
      label: 'Resolve interrupted setup',
      recommended: true
    }]
  };
  const registeredServerRecovery = {
    recoveryId: 'recovery-22222222222222222222222222222222',
    serverId: 'server-existing-fixture',
    instanceId: 'server-existing-fixture',
    visibilityScope: 'registered-server',
    operationKind: 'update',
    phase: 'cleanup-pending',
    automaticPossible: true,
    title: 'Registered server recovery must stay contextual',
    summary: 'Private registered recovery details must not appear in setup.',
    actions: [{
      actionId: 'retry-cleanup',
      label: 'Retry safe cleanup',
      recommended: true
    }]
  };
  const fixture = await harness.launchModpackApp({
    profile: 'empty',
    recoveryRecords: [pendingRecovery, registeredServerRecovery]
  });
  try {
    const { page } = fixture;
    await page.getByRole('button', { name: /Create Your First Instance/u }).click();
    await page.getByRole('button', { name: /Server Manager/u }).click();

    const recoveryHeading = page.getByRole('heading', { name: 'Unfinished server setup' });
    await expect(recoveryHeading).toBeVisible();
    await expect(page.getByText('Registered server recovery must stay contextual', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Private registered recovery details must not appear in setup.', { exact: true })).toHaveCount(0);
    expect(fixture.readState().recoveryRuns).toBe(0);
    expect(fixture.readState().recoveryCalls || []).toEqual([]);

    const recover = page.getByRole('button', { name: 'Resolve interrupted setup' });
    await expect(recover).toBeVisible();
    await recover.click();

    await expect(recoveryHeading).toHaveCount(0);
    const recovered = fixture.readState();
    expect(recovered.recoveryRuns).toBe(1);
    expect(recovered.recoveryCalls).toEqual([{
      recoveryId: pendingRecovery.recoveryId,
      actionId: 'retry-recovery'
    }]);
    expect(recovered.recovery).toEqual([registeredServerRecovery]);
  } finally {
    await fixture.close();
  }
});

test('resolved pending recovery disappears before a failing confirmation refresh completes', async () => {
  const pendingRecovery = {
    recoveryId: 'recovery-44444444444444444444444444444444',
    serverId: 'pending-44444444444444444444444444444444',
    instanceId: 'pending-44444444444444444444444444444444',
    visibilityScope: 'pending-new-server',
    operationKind: 'install-new',
    phase: 'validating-candidate',
    automaticPossible: true,
    title: 'Recovery that must disappear immediately',
    summary: 'The interrupted setup can be resolved from its durable evidence.',
    actions: [{
      actionId: 'retry-recovery',
      label: 'Resolve interrupted setup',
      recommended: true
    }]
  };
  const fixture = await harness.launchModpackApp({
    profile: 'empty',
    recoveryRecords: [pendingRecovery],
    recoveryListFixture: {
      delayMsByCall: { 2: 700 },
      failureCalls: [2]
    }
  });
  try {
    const { page } = fixture;
    await page.getByRole('button', { name: /Create Your First Instance/u }).click();
    await page.getByRole('button', { name: /Server Manager/u }).click();

    const recoveryTitle = page.getByText(pendingRecovery.title, { exact: true });
    const recover = page.getByRole('button', { name: 'Resolve interrupted setup' });
    await expect(recoveryTitle).toBeVisible();
    await recover.click();

    await expect.poll(() => fixture.readState().recoveryRuns).toBe(1);
    await expect(recoveryTitle).toHaveCount(0);
    await expect(page.locator('.mp-state.error > strong').filter({
      hasText: 'Setup recovery could not be completed'
    })).toBeVisible();
    await expect(recover).toHaveCount(0);
    expect(fixture.readState().recoveryCalls).toEqual([{
      recoveryId: pendingRecovery.recoveryId,
      actionId: 'retry-recovery'
    }]);
  } finally {
    await fixture.close();
  }
});

test('a late recovery refresh cannot overwrite the newer recovery list', async () => {
  const resolvedRecovery = {
    recoveryId: 'recovery-55555555555555555555555555555555',
    serverId: 'pending-55555555555555555555555555555555',
    instanceId: 'pending-55555555555555555555555555555555',
    visibilityScope: 'pending-new-server',
    operationKind: 'install-new',
    phase: 'validating-candidate',
    automaticPossible: true,
    title: 'Older recovery record',
    summary: 'This record is present in the delayed stale response.',
    actions: [{
      actionId: 'retry-recovery',
      label: 'Resolve older setup',
      recommended: true
    }]
  };
  const newerRecovery = {
    recoveryId: 'recovery-66666666666666666666666666666666',
    serverId: 'pending-66666666666666666666666666666666',
    instanceId: 'pending-66666666666666666666666666666666',
    visibilityScope: 'pending-new-server',
    operationKind: 'install-new',
    phase: 'cleanup-pending',
    automaticPossible: true,
    title: 'Newer recovery record',
    summary: 'This record exists only in the newer response.',
    actions: [{
      actionId: 'retry-recovery',
      label: 'Resolve newer setup',
      recommended: true
    }]
  };
  const fixture = await harness.launchModpackApp({
    profile: 'empty',
    recoveryRecords: [resolvedRecovery],
    recoveryListFixture: {
      delayMsByCall: { 2: 700 },
      recordsAfterResolution: [newerRecovery]
    }
  });
  try {
    const { page } = fixture;
    await page.getByRole('button', { name: /Create Your First Instance/u }).click();
    await page.getByRole('button', { name: /Server Manager/u }).click();

    await expect(page.getByText(resolvedRecovery.title, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Resolve older setup' }).click();
    await expect(page.getByText(newerRecovery.title, { exact: true })).toBeVisible();
    await expect.poll(() => fixture.readState().recoveryListCompletedCalls.includes(2)).toBe(true);

    await expect(page.getByText(newerRecovery.title, { exact: true })).toBeVisible();
    await expect(page.getByText(resolvedRecovery.title, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resolve newer setup' })).toBeEnabled();
  } finally {
    await fixture.close();
  }
});

test('failed pending new-server recovery remains available for an explicit retry', async () => {
  const pendingRecovery = {
    recoveryId: 'recovery-33333333333333333333333333333333',
    serverId: 'pending-33333333333333333333333333333333',
    instanceId: 'pending-33333333333333333333333333333333',
    visibilityScope: 'pending-new-server',
    operationKind: 'install-new',
    phase: 'validating-candidate',
    automaticPossible: true,
    title: 'Recover interrupted server setup',
    summary: 'The interrupted setup can be resolved from its durable evidence.',
    actions: [{
      actionId: 'retry-recovery',
      label: 'Resolve interrupted setup',
      recommended: true
    }]
  };
  const fixture = await harness.launchModpackApp({
    profile: 'empty',
    recoveryRecords: [pendingRecovery],
    recoveryFailureIds: [pendingRecovery.recoveryId]
  });
  try {
    const { page } = fixture;
    await page.getByRole('button', { name: /Create Your First Instance/u }).click();
    await page.getByRole('button', { name: /Server Manager/u }).click();

    const recoveryHeading = page.getByRole('heading', { name: 'Unfinished server setup' });
    const recover = page.getByRole('button', { name: 'Resolve interrupted setup' });
    await expect(recoveryHeading).toBeVisible();
    await recover.click();

    await expect(page.locator('.mp-state.error > strong').filter({
      hasText: 'Setup recovery could not be completed'
    })).toBeVisible();
    await expect(recoveryHeading).toBeVisible();
    await expect(recover).toBeEnabled();
    let state = fixture.readState();
    expect(state.recoveryRuns).toBe(0);
    expect(state.recovery).toEqual([pendingRecovery]);
    expect(state.recoveryCalls).toEqual([{
      recoveryId: pendingRecovery.recoveryId,
      actionId: 'retry-recovery'
    }]);

    await recover.click();

    await expect(recoveryHeading).toHaveCount(0);
    state = fixture.readState();
    expect(state.recoveryRuns).toBe(1);
    expect(state.recoveryCalls).toEqual([
      { recoveryId: pendingRecovery.recoveryId, actionId: 'retry-recovery' },
      { recoveryId: pendingRecovery.recoveryId, actionId: 'retry-recovery' }
    ]);
    expect(state.recovery).toEqual([]);
  } finally {
    await fixture.close();
  }
});

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

  test('Modrinth project history shows every exact release without catalog filters', async () => {
    const { page } = fixture;
    const firstInstance = page.getByRole('button', { name: /Create Your First Instance/u });
    if (await firstInstance.isVisible().catch(() => false)) {
      await firstInstance.click();
      await page.getByRole('button', { name: /Server Manager/u }).click();
    }
    const installModpack = page.getByRole('button', { name: /Install Modpack/u });
    if (await installModpack.isVisible().catch(() => false)) await installModpack.click();
    const modrinth = page.getByRole('button', { name: /Browse Modrinth/u });
    if (await modrinth.isVisible().catch(() => false)) await modrinth.click();
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();

    for (const version of ['2.0.0', '1.0.0', '1.20.1 Forge beta', '1.19.4 Quilt alpha']) {
      await expect(page.getByRole('button', { name: new RegExp(version.replaceAll('.', '\\.'), 'u') })).toBeVisible();
    }
    await expect(page.getByText('This pack selects its runtime. Archive inspection confirms the exact runtime.')).toHaveCount(8);

    const call = fixture.readState().providerCalls.filter(entry => entry.method === 'listVersions').at(-1);
    expect(call).toMatchObject({ provider: 'modrinth', method: 'listVersions', request: { projectId: 'fixture-pack' } });
    expect(Object.keys(call.request)).toEqual(['projectId']);
    await page.getByRole('button', { name: 'Change source' }).click();
  });

  test('abandoning new-server review releases its destination reservation for immediate reuse', async () => {
    const { page } = fixture;
    const firstInstance = page.getByRole('button', { name: /Create Your First Instance/u });
    if (await firstInstance.isVisible().catch(() => false)) await openModrinthBrowser(page);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const modrinthSource = page.getByRole('button', { name: /Browse Modrinth/u });
      if (await modrinthSource.isVisible().catch(() => false)) await modrinthSource.click();
      await expect(page.getByRole('heading', { name: 'Browse server modpacks' })).toBeVisible();
      await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
      await page.getByRole('button', { name: /^2\.0\.0/u }).click();
      await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
      await expect(page.locator('p.destination-note').filter({ hasText: 'Chosen destination:' })).toContainText('fixture-server');
      await page.getByRole('button', { name: 'Choose another asset' }).click();
      await expect(page.getByRole('heading', { name: 'Choose where the pack is published' })).toBeVisible();
      await expect.poll(() => fixture.readState().lifecycleCalls.filter(call =>
        call.method === 'releaseServerDestination' && call.released === true).length).toBe(attempt);
    }
  });

  test('Modrinth setup traverses exact version, preflight, progress, and managed completion', async () => {
    const { page } = fixture;
    fixture.updateScenario({ holdFirstJobBeforeCommit: true });
    await page.getByRole('button', { name: /Browse Modrinth/u }).click();
    await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
    await page.getByRole('button', { name: /^2\.0\.0/u }).click();
    await expect(page.getByText('mrpack archive', { exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Server utilities/u })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /Example configuration/u })).not.toBeChecked();
    await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
    await page.getByLabel('I accept the Minecraft EULA').check();
    await page.getByRole('button', { name: 'Install this exact reviewed plan' }).click();
    await expect(page.getByRole('progressbar', { name: 'Downloading' })).not.toHaveAttribute('aria-valuenow');
    await expect(page.getByText('Verifying exact offline fixture bytes', { exact: true })).toHaveAttribute('aria-live', 'polite');
    expect(fixture.readState().state.modpackManaged).toBe(false);
    fixture.updateScenario({ releaseFirstJobBeforeCommit: true });
    // Completing initial setup publishes the instance and intentionally returns to
    // the server dashboard; result-focus coverage lives in the management flow.
    await expect(page.locator('.server-tabs').getByRole('button', { name: /^Modpack(?:,|$)/u })).toBeVisible();
    const evidence = fixture.readState();
    expect(evidence.lifecycleCalls.filter(call => call.method === 'releaseHeldFirstJob')).toEqual([
      expect.objectContaining({ jobId: 'job-1' })
    ]);
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
    await page.getByRole('button', { name: /Local archive/u }).click();
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
    const preflight = page.getByRole('button', { name: 'Review planned changes' });
    await expect(preflight).toBeDisabled();
    await page.getByLabel('Missing digest acknowledgement').check();
    await expect(preflight).toBeEnabled();

    await chooseGithubAsset(page, 'fixture-ambiguous.zip');
    await expect(page.getByText('Unresolved ambiguity blocks installation', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: /server-a/u }).check();
    await expect(page.getByRole('button', { name: 'Review planned changes' })).toBeEnabled();

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
    await expect(page.getByRole('button', { name: 'Import reviewed data as files-only' })).toBeEnabled();
  });

  test('accepted Modrinth-linked repository remains explicit through GitHub asset review', async () => {
    const { page } = fixture;
    await openSource(page);
    await page.getByRole('button', { name: /Browse Modrinth/u }).click();
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
