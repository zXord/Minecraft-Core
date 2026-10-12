import { expect, test } from '@playwright/test';
import harness from './fixtures/modpack-harness.cjs';

// Catch status placement below long history and App/recovery intrinsic widths;
// all geometry comes from the actual rendered App, not a detached component.
const env = { MINECRAFT_CORE_USE_DEV_SERVER: '1', MINECRAFT_CORE_DEV_SERVER_URL: 'http://127.0.0.1:5173' };
const sizes = [{ width: 800, height: 600 }, { width: 390, height: 844 }, { width: 1440, height: 1000 }];
const recoveryRecord = {
  recoveryId: `recovery-${'b'.repeat(32)}`, serverId: 'server-e2e', instanceId: 'server-e2e',
  visibilityScope: 'registered-server', operationKind: 'repair', title: 'Recover repair operation',
  phase: 'committing', automaticPossible: true,
  summary: 'The interrupted server change can be verified again or restored to the prior server.',
  actions: [{ actionId: 'retry-recovery', label: 'Retry verified recovery', recommended: true },
    { actionId: 'rollback-server', label: 'Restore prior server', recommended: false }]
};
const status = page => page.locator('.inspection-progress');
const recovery = page => page.getByRole('region', { name: 'Modpack recovery', exact: true });
const calls = (fixture, method) => fixture.readState().lifecycleCalls.filter(call => call.method === method);
function release(fixture, phaseStep = 3) {
  fixture.updateScenario({ inspectionFixture: { holdProgress: phaseStep < 3, phaseStep } });
}
async function launch(profile, viewport, options = {}) {
  const fixture = await harness.launchModpackApp({ profile, env, ...options });
  await fixture.page.setViewportSize(viewport);
  fixture.errors = [];
  fixture.consoleIssues = [];
  fixture.page.on('pageerror', error => fixture.errors.push(error.message));
  fixture.page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) fixture.consoleIssues.push(message.text());
  });
  return fixture;
}
async function source(fixture, origin) {
  const { page } = fixture;
  if (origin === 'new') {
    await page.getByRole('button', { name: /Create Your First Instance/u }).click();
    await page.getByRole('button', { name: /Server Manager/u }).click();
    await page.getByRole('button', { name: /Install Modpack/u }).click();
  } else {
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Install modpack', exact: true }).click();
  }
}
async function browser(fixture, origin) {
  await source(fixture, origin);
  await fixture.page.getByRole('button', { name: /Browse Modrinth/u }).click();
  await fixture.page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
  await expect(fixture.page.locator('ul.mp-list button.mp-row')).toHaveCount(8);
}
async function evidence(page, locator, testInfo, name) {
  const geometry = await locator.evaluate(element => {
    const rectangle = node => {
      const r = node.getBoundingClientRect();
      const s = getComputedStyle(node);
      return { tag: node.tagName, className: node.className, x: r.x, y: r.y, right: r.right, bottom: r.bottom,
        width: r.width, height: r.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
        scrollTop: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
        css: { width: s.width, minWidth: s.minWidth, boxSizing: s.boxSizing, overflowX: s.overflowX, overflowY: s.overflowY } };
    };
    const ancestors = [];
    for (let n = element.parentElement; n; n = n.parentElement) ancestors.push(rectangle(n));
    const scrollOwner = ancestors.find(n => n.scrollHeight > n.clientHeight && /auto|scroll/u.test(n.css.overflowY)) || rectangle(document.scrollingElement);
    return { viewport: { width: document.documentElement.clientWidth, height: innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth }, scrollOwner,
      target: rectangle(element), ancestors, focus: { tag: document.activeElement?.tagName,
        className: document.activeElement?.className, label: document.activeElement?.getAttribute('aria-label') } };
  });
  await testInfo.attach(`${name}-geometry`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
  console.log(`${name}: ${JSON.stringify(geometry)}`);
  return geometry;
}
function inViewport(g, message, ring = 0) {
  expect.soft(g.target.x - ring, `${message}: left`).toBeGreaterThanOrEqual(-1);
  expect.soft(g.target.right + ring, `${message}: right`).toBeLessThanOrEqual(g.viewport.width + 1);
  expect.soft(g.target.y - ring, `${message}: top`).toBeGreaterThanOrEqual(-1);
  expect.soft(g.target.bottom + ring, `${message}: bottom`).toBeLessThanOrEqual(g.viewport.height + 1);
}
async function progress(fixture, testInfo, name, percent = '50') {
  await expect(status(fixture.page)).toHaveCount(1);
  await expect(status(fixture.page).getByRole('progressbar')).toHaveAttribute('value', percent);
  await expect(status(fixture.page)).toContainText(percent === '50' ? '512 B of 1.0 KB' : '768 B of 1.0 KB');
  inViewport(await evidence(fixture.page, status(fixture.page), testInfo, name), name);
  const headingHits = await status(fixture.page).locator('.progress-heading strong').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    return [...range.getClientRects()].flatMap(r => [r.left + 2, r.right - 2].map(x => {
      const hit = document.elementFromPoint(x, r.top + r.height / 2);
      return { x, y: r.top + r.height / 2, clear: element.contains(hit),
        hit: { tag: hit?.tagName, className: hit?.className } };
    }));
  });
  console.log(`${name}-heading-hit-test: ${JSON.stringify(headingHits)}`);
  expect.soft(headingHits.every(hit => hit.clear), 'progress heading is not covered by fixed controls').toBe(true);
}
function noPlans(fixture) {
  expect(calls(fixture, 'createPlan')).toEqual([]);
  expect(calls(fixture, 'createManagementPlan')).toEqual([]);
  expect(calls(fixture, 'startOperation')).toEqual([]);
}
async function health(fixture, testInfo) {
  await expect(fixture.page).toHaveTitle('Minecraft Core');
  await expect(fixture.page.locator('vite-error-overlay')).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
  console.log(`console-health: ${JSON.stringify({ pageErrors: fixture.errors, issues: fixture.consoleIssues })}`);
  await testInfo.attach('console-issues', { body: JSON.stringify(fixture.consoleIssues), contentType: 'application/json' });
}
for (const [index, origin, row] of [[1, 'new', 'first'], [2, 'new', 'last'], [3, 'existing', 'first'], [4, 'existing', 'last']]) {
  test(`P${index} ${origin} 800x600 ${row} mouse activation keeps measured progress on screen`, async ({}, info) => {
    const fixture = await launch(origin === 'new' ? 'empty' : 'unmanaged', sizes[0], { inspectionFixture: { holdProgress: true } });
    try {
      await browser(fixture, origin);
      const rows = fixture.page.locator('ul.mp-list button.mp-row');
      const selected = row === 'first' ? rows.first() : rows.last();
      const label = await selected.innerText();
      await selected.click();
      await progress(fixture, info, `P${index}-held`);
      await expect(rows).toHaveCount(8);
      expect(await rows.evaluateAll(buttons => buttons.every(button => button.disabled))).toBe(true);
      expect(calls(fixture, 'inspectSource')).toHaveLength(1);
      expect(calls(fixture, 'inspectSource')[0]).toMatchObject({ provider: 'modrinth', projectId: 'fixture-pack',
        versionId: row === 'first' ? 'version-upgrade' : 'version-forward-neoforge' });
      await info.attach('selected-version', { body: label, contentType: 'text/plain' });
      noPlans(fixture);
      await health(fixture, info);
    } finally { release(fixture); await fixture.close(); }
  });
}
for (const [index, origin] of [[5, 'new'], [6, 'existing']]) {
  test(`P${index} ${origin} desktop keyboard progress updates preserve focus and scroll`, async ({}, info) => {
    const fixture = await launch(origin === 'new' ? 'empty' : 'unmanaged', sizes[2], { inspectionFixture: { holdProgress: true } });
    try {
      await browser(fixture, origin);
      const selected = fixture.page.getByRole('button', { name: /^1\.20\.1 Forge beta/u });
      await selected.focus();
      await fixture.page.keyboard.press('Enter');
      await progress(fixture, info, `P${index}-50`);
      await fixture.page.evaluate(() => {
        window.__layoutFocus = document.activeElement;
        window.__layoutScrollElements = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight && e.clientHeight > 0);
      });
      const snapshot = () => fixture.page.evaluate(() => ({ sameFocus: document.activeElement === window.__layoutFocus,
        scroll: window.__layoutScrollElements.map(e => ({ tag: e.tagName, className: e.className, top: e.scrollTop })) }));
      const before = await snapshot();
      release(fixture, 1);
      await progress(fixture, info, `P${index}-75`, '75');
      expect(await snapshot()).toEqual(before);
      release(fixture, 2);
      await expect(status(fixture.page)).toContainText('Preparing the archive workspace');
      await expect(status(fixture.page).getByRole('progressbar')).toHaveCount(0);
      await expect(status(fixture.page)).not.toContainText(/\d+%/u);
      inViewport(await evidence(fixture.page, status(fixture.page), info, `P${index}-archive`), 'materialize');
      expect(await snapshot()).toEqual(before);
      expect(calls(fixture, 'inspectSource')).toHaveLength(1);
      expect(calls(fixture, 'inspectSource')[0].versionId).toBe('version-forge-beta');
      noPlans(fixture);
      release(fixture);
      await expect(fixture.page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible();
      await health(fixture, info);
    } finally { release(fixture); await fixture.close(); }
  });
}
test('P7 leaving held inspection for overview cannot revive stale status or review', async ({}, info) => {
  const fixture = await launch('unmanaged', sizes[0], { inspectionFixture: { holdProgress: true } });
  try {
    await browser(fixture, 'existing');
    await fixture.page.locator('ul.mp-list button.mp-row').first().click();
    await expect(status(fixture.page)).toContainText('512 B');
    await fixture.page.getByRole('button', { name: 'Back to Modpack overview' }).click();
    release(fixture);
    await expect.poll(() => calls(fixture, 'inspectSourceCancelled').length + calls(fixture, 'inspectSourceCompleted').length).toBe(1);
    await expect(fixture.page.getByRole('region', { name: 'Modpack overview' })).toBeVisible();
    await expect(status(fixture.page)).toHaveCount(0);
    await expect(fixture.page.getByRole('heading', { name: 'Inspect evidence before installation' })).toHaveCount(0);
    noPlans(fixture);
    await health(fixture, info);
  } finally { release(fixture); await fixture.close(); }
});
async function recoveryGeometry(fixture, info, name) {
  const { page } = fixture;
  await expect(recovery(page)).toContainText('Recover');
  const buttons = recovery(page).getByRole('button');
  await expect(buttons).toHaveCount(3);
  const textFits = await recovery(page).locator('.recovery-copy').evaluateAll(items => items.every(el => {
    const outer = el.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(el);
    return [...range.getClientRects()].every(r => r.left >= outer.left - 1 && r.right <= outer.right + 1);
  }));
  expect.soft(textFits, 'complete recovery title and summary fit horizontally').toBe(true);
  for (let i = 0; i < 3; i++) {
    const button = buttons.nth(i);
    await button.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    const g = await evidence(page, button, info, `${name}-control-${i}`);
    inViewport(g, `${name} control ${i}`, 4);
    const text = await button.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const outer = el.getBoundingClientRect();
      return [...range.getClientRects()].every(r => r.left >= outer.left && r.right <= outer.right + 1 && r.top >= outer.top && r.bottom <= outer.bottom + 1);
    });
    expect.soft(text, 'full label inside control').toBe(true);
    expect.soft(g.viewport.documentScrollWidth, 'document horizontal overflow').toBeLessThanOrEqual(g.viewport.width + 1);
  }
  expect(fixture.readState().recoveryCalls).toEqual([]);
  noPlans(fixture);
}
for (const [index, viewport] of sizes.entries()) {
  test(`L${index + 1} recovery overview and section contain reachable labels at ${viewport.width}x${viewport.height}`, async ({}, info) => {
    const fixture = await launch('managed', viewport, { recoveryRecords: [recoveryRecord], refreshFixture: { stateFailureIds: ['server-e2e'] } });
    try {
      await fixture.openModpack();
      await recoveryGeometry(fixture, info, `L${index + 1}-overview`);
      await fixture.page.getByRole('button', { name: 'Recovery', exact: true }).click();
      await recoveryGeometry(fixture, info, `L${index + 1}-section`);
      await health(fixture, info);
    } finally { await fixture.close(); }
  });
}
test('L4 long recovery words and bounded identifier fit; Refresh is read-only and preserves status gates', async ({}, info) => {
  const record = { ...recoveryRecord, title: `Recover an interrupted operation with a long ordinary word title ${'identifier'.repeat(12)}`,
    actions: [{ actionId: 'retry-recovery', label: 'Retry the verified recovery operation after carefully checking the interrupted server transaction', recommended: true },
      recoveryRecord.actions[1]] };
  const fixture = await launch('managed', sizes[0], { recoveryRecords: [record], refreshFixture: { stateFailureIds: ['server-e2e'] } });
  try {
    await fixture.openModpack();
    await recoveryGeometry(fixture, info, 'L4-long');
    const { page } = fixture;
    await page.getByRole('button', { name: 'Recovery', exact: true }).click();
    const before = fixture.readState().recoveryListCalls;
    fixture.updateScenario({ recoveryListFixture: { delayMsByCall: { [before + 1]: 800 }, failureCalls: [before + 1] } });
    await recovery(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(recovery(page).getByRole('button', { name: 'Checking…' })).toBeDisabled();
    expect(await recovery(page).locator('.action-column button').evaluateAll(items => items.every(item => item.disabled))).toBe(true);
    await expect(recovery(page)).toContainText('Recovery status unavailable');
    expect(await recovery(page).locator('.action-column button').evaluateAll(items => items.every(item => item.disabled))).toBe(true);
    await expect(page.getByText('No recovery action is pending', { exact: true })).toHaveCount(0);
    fixture.updateScenario({ recovery: [], recoveryListFixture: {} });
    await recovery(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('No recovery action is pending', { exact: true })).toBeVisible();
    expect(fixture.readState().recoveryCalls).toEqual([]);
    expect(calls(fixture, 'verify')).toEqual([]);
    noPlans(fixture);
    await health(fixture, info);
  } finally { await fixture.close(); }
});
for (const viewport of [{ width: 800, height: 600 }, { width: 788, height: 595 }, sizes[2]]) {
  test(`C2 Dashboard settings and server tabs remain reachable at ${viewport.width}x${viewport.height}`, async ({}, info) => {
    const fixture = await launch('unmanaged', viewport);
    try {
      const { page } = fixture;
      await expect(page.locator('.dashboard-panel')).toBeVisible();
      const settings = page.getByRole('button', { name: 'Open app settings', exact: true });
      const tabs = page.locator('.server-tabs').getByRole('button');
      await expect(tabs).toHaveCount(6);
      inViewport(await evidence(page, page.locator('.server-header'), info, `C2-${viewport.width}-header`), 'server header');
      inViewport(await evidence(page, settings, info, `C2-${viewport.width}-settings`), 'app settings');
      expect(await settings.evaluate(element => {
        const r = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), 'settings center receives pointer input without horizontal scrolling').toBe(true);
      const panel = await page.locator('.content-panel').boundingBox();
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width);
      if (viewport.width === 1440) expect(panel.width).toBeCloseTo(1240, 2);

      await settings.click();
      const dialog = page.getByRole('dialog', { name: 'App Settings' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await tabs.first().focus();
      await page.keyboard.press('Shift+Tab');
      await expect(settings).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await settings.focus();
      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press('Tab');
        await expect(tabs.nth(index)).toBeFocused();
        inViewport(await evidence(page, tabs.nth(index), info, `C2-${viewport.width}-tab-${index}`), 'server tab');
      }
      await page.locator('.server-tabs').getByRole('button', { name: 'Modpack', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Modpack', exact: true })).toBeVisible();
      noPlans(fixture);
      await health(fixture, info);
    } finally { await fixture.close(); }
  });
}

test('C1 GitHub keeps one local held status and fitted Dashboard and Method ancestry', async ({}, info) => {
  for (const viewport of [sizes[0], sizes[2]]) {
    for (const origin of ['existing', 'new']) {
      const fixture = await launch(origin === 'new' ? 'empty' : 'unmanaged', viewport, { inspectionFixture: { holdProgress: true } });
      try {
        const { page } = fixture;
        if (origin === 'existing') {
          await expect(page.locator('.dashboard-panel')).toBeVisible();
          const width = await page.locator('.content-panel').evaluate(el => el.getBoundingClientRect().width);
          if (viewport.width === 800) expect(width).toBeLessThanOrEqual(736);
          else expect(width).toBe(1240);
          await evidence(page, page.locator('.server-tabs'), info, `C1-${viewport.width}-dashboard-header`);
        }
        if (origin === 'new') {
          await page.getByRole('button', { name: /Create Your First Instance/u }).click();
          await page.getByRole('button', { name: /Server Manager/u }).click();
          await expect(page.getByRole('heading', { name: 'How do you want to set it up?' })).toBeVisible();
          const method = await evidence(page, page.locator('.method-panel'), info, `C1-${viewport.width}-method`);
          inViewport(method, 'unaffected Method panel');
          await page.getByRole('button', { name: /Install Modpack/u }).click();
        } else await source(fixture, origin);
        await page.getByRole('button', { name: /GitHub Releases/u }).click();
        await page.getByLabel('Public repository or release URL').fill('https://github.com/FixtureOrg/FixturePack');
        await page.getByRole('button', { name: 'Load releases' }).click();
        await page.getByRole('button', { name: /Fixture Release v2/u }).click();
        await page.getByRole('radio', { name: /fixture-server\.zip/u }).click();
        await page.getByRole('button', { name: 'Download and inspect selected asset' }).click();
        await expect(status(page)).toHaveCount(1);
        await expect(page.getByRole('radiogroup', { name: 'GitHub uploaded asset selection' }).locator('..').locator('.inspection-progress')).toHaveCount(1);
        await expect(status(page).getByRole('progressbar')).toHaveAttribute('value', '50');
        await status(page).scrollIntoViewIfNeeded();
        await evidence(page, status(page), info, `C1-${viewport.width}-${origin}-github`);
        expect(calls(fixture, 'inspectSource')).toHaveLength(1);
        noPlans(fixture);
        await health(fixture, info);
      } finally { release(fixture); await fixture.close(); }
    }
  }
});
