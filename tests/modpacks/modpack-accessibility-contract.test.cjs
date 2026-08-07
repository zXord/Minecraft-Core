const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const source = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

test('destructive modpack confirmation defaults focus to Cancel and traps focus', () => {
  const confirmation = source('src/components/common/ConfirmationDialog.svelte');
  assert.match(confirmation, /export let initialFocus\s*=\s*['"]cancel['"]/);
  assert.match(confirmation, /cancelButton/);
  assert.match(confirmation, /Tab/);
  assert.match(confirmation, /Escape/);
  assert.match(confirmation, /previousFocus/);
});

test('wizard and cards expose keyboard step focus and non-color states', () => {
  const wizard = source('src/components/setup/ServerSetupWizard.svelte');
  const choice = source('src/components/setup/ModpackSourceChoice.svelte');
  const browser = source('src/components/setup/ModrinthPackBrowser.svelte');
  assert.match(wizard, /aria-current=\{activeStep\s*===\s*stepName\s*\?\s*['"]step['"]/);
  assert.match(wizard, /tabindex=["']-1["']/);
  assert.match(choice + browser, /on:keydown/);
  assert.match(choice + browser, /role=["'](?:button|radio)["']/);
  assert.match(choice + browser, /Available|Unavailable|Selected|Not selected/i);
});

test('progress separates polite stages from non-live raw logs and labels diffs', () => {
  const progress = source('src/components/modpacks/ModpackJobProgress.svelte');
  const review = source('src/components/modpacks/ModpackPlanReview.svelte');
  assert.match(progress, /role=["']progressbar["']/);
  assert.match(progress, /aria-valuenow/);
  assert.match(progress, /aria-live=["']polite["']/);
  assert.match(progress, /aria-live=["']off["']/);
  assert.match(progress, /tabindex=["']-1["']/);
  assert.match(review, /aria-label/);
});

test('notification center is persistent action-only and cleans every listener', () => {
  const store = source('src/stores/modpackNotificationStore.js');
  const center = source('src/components/modpacks/ModpackNotificationCenter.svelte');
  assert.match(store, /listNotifications/);
  assert.match(store, /ackNotification/);
  assert.match(store, /performSafeAction/);
  assert.match(store, /unsubscribe|destroy/);
  assert.match(center, /Notification/);
  assert.doesNotMatch(center, /install(?:Pack|Version|Modpack)\s*\(/);
});
