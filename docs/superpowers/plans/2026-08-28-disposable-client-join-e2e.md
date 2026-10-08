# Disposable client join E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly opt-in Playwright test proving a new Minecraft client joins a disposable offline-mode Server Optimized 1.20.1 server through the production app.

**Architecture:** A new helper imports the existing production real-lifecycle harness for the fresh root, production Electron environment, and exact Modrinth install. It owns confined server-property writes, synthetic Electron-safeStorage auth, disposable-client registration, real launch, and log evidence.

**Tech Stack:** Node.js, Playwright Electron, Electron `safeStorage`, production IPC, filesystem promises.

**Spec:** `docs/superpowers/specs/2026-08-28-disposable-client-join-e2e-design.md`

## Global Constraints

- Use `MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E=1`; keep the normal E2E command unchanged.
- Create a fresh temporary root with separate user-data, server, client, and evidence children.
- Install exact Modrinth Server Optimized `oQ6gSIoF` through production modpack IPC.
- Change only the disposable `server.properties`: `online-mode=false` and `enforce-secure-profile=false` before the client-facing server start.
- Write `xmcl-auth.json` only under the disposable client using Electron `safeStorage`; never read, enumerate, import, copy, or refresh external auth.
- Launch through `minecraft-launch` with the proper launcher, prove the literal username from `logs/latest.log`, then stop client and server.
- Delete only the validated scratch root after all assertions and stops succeed; preserve it and attach evidence on failure.

---

### Task 1: Confined disposable helper

**Files:**
- Create: `tests/e2e/fixtures/disposable-client-join-harness.cjs`
- Create: `tests/disposable-client-join-harness.test.cjs`

**Interfaces:**
- Consumes: the root and production Electron helpers exported by `tests/e2e/fixtures/real-modpack-harness.cjs`.
- Produces: `isDisposableClientJoinEnabled(environment)`, `assertDisposablePath(lifecycle, candidatePath)`, `configureOfflineServerProperties(lifecycle)`, and `createSyntheticAuthData({ username, now })`.

- [ ] **Step 1: Write failing unit tests**

```js
test('disposable client join is opt-in and confines writable paths', async () => {
  assert.equal(isDisposableClientJoinEnabled({}), false);
  assert.equal(isDisposableClientJoinEnabled({ MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E: '1' }), true);
  const lifecycle = await realHarness.createIsolatedRealLifecycle();
  try {
    assert.equal(assertDisposablePath(lifecycle, lifecycle.clientPath), lifecycle.clientPath);
    assert.throws(() => assertDisposablePath(lifecycle, path.join(lifecycle.root, '..', 'outside')), /outside/i);
  } finally { await lifecycle.dispose({ preserveRoot: false }); }
});
```

- [ ] **Step 2: Verify red**

Run: `node --test tests/disposable-client-join-harness.test.cjs`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the minimal helper**

```js
function isDisposableClientJoinEnabled(environment = process.env) {
  const value = String(environment.MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}
```

Write property replacement line-by-line so unrelated settings remain intact and the path is first constrained by `assertDisposablePath`.

- [ ] **Step 4: Verify green**

Run: `node --test tests/disposable-client-join-harness.test.cjs`

Expected: PASS.

### Task 2: Synthetic safeStorage auth and client registration

**Files:**
- Modify: `tests/e2e/fixtures/disposable-client-join-harness.cjs`
- Modify: `tests/disposable-client-join-harness.test.cjs`

**Interfaces:**
- Consumes: Task 1 confinement and a Playwright Electron `Application`.
- Produces: `writeSyntheticEncryptedAuth(electronApp, lifecycle, { username, now })` and `registerDisposableClient(page, lifecycle, { username })`.

- [ ] **Step 1: Write failing auth-shape test**

```js
test('synthetic auth is a fresh cache-only shape with no real-account input', () => {
  const auth = createSyntheticAuthData({ username: 'E2EJoiner', now: new Date('2026-08-28T00:00:00.000Z') });
  assert.equal(auth.name, 'E2EJoiner');
  assert.match(auth.access_token, /^disposable-/u);
  assert.equal(auth.xmcl_tokens.microsoft.refresh_token, 'disposable-refresh-token');
  assert.equal(Object.hasOwn(auth, 'microsoft_refresh_token'), false);
});
```

- [ ] **Step 2: Verify red**

Run: `node --test tests/disposable-client-join-harness.test.cjs`

Expected: FAIL because synthetic auth is missing.

- [ ] **Step 3: Implement safeStorage and registration**

In `electronApp.evaluate(({ safeStorage }, payload) => ...)`, require encrypted storage availability, encrypt sensitive auth values with the product `enc:` convention, and write exactly `<client>/xmcl-auth.json`. Register via `save-client-config` on renderer IPC with loopback and no management/invite credentials. Do not call account-list, account-import, authenticate, or refresh channels.

- [ ] **Step 4: Verify green**

Run: `node --test tests/disposable-client-join-harness.test.cjs`

Expected: PASS.

### Task 3: Gated production client-join spec

**Files:**
- Create: `tests/e2e/disposable-client-join.spec.js`
- Modify: `tests/e2e/fixtures/disposable-client-join-harness.cjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 1–2 plus `REAL_MODRINTH_LIFECYCLE.versions[0]` and production lifecycle helpers.
- Produces: `launchDisposableClient(page, lifecycle, runtime, { username })`, `waitForJoinLog(lifecycle, username)`, `stopDisposableClient(page)`, and `collectDisposableJoinEvidence(lifecycle)`.

- [ ] **Step 1: Write gated spec before launch helpers**

```js
test('joins isolated offline Server Optimized 1.20.1 with a synthetic encrypted profile', async ({}, testInfo) => {
  test.setTimeout(60 * 60_000);
  // exact production install; isolated flags; synthetic auth; registration;
  // real proper launch; log line containing "E2EJoiner joined the game".
});
```

- [ ] **Step 2: Verify opt-in gate**

Run: `npx playwright test tests/e2e/disposable-client-join.spec.js --workers=1`

Expected: SKIPPED with the opt-in message and no download.

- [ ] **Step 3: Implement launch and server-log proof**

Pass the reviewed plan runtime's Minecraft version, loader family, and loader version to `minecraft-launch` with `useProperLauncher: true`. Poll the disposable server log for the literal username and `joined the game`; do not accept process status as proof. In `finally`, call `minecraft-stop`, `stop-server`, and close Electron before cleanup/evidence handling. Add a dedicated package script for only this spec.

- [ ] **Step 4: Verify unit and static gate**

Run: `node --test tests/disposable-client-join-harness.test.cjs && npx playwright test tests/e2e/disposable-client-join.spec.js --workers=1`

Expected: unit PASS; Playwright SKIPPED without the explicit environment switch.

- [ ] **Step 5: Verify real opt-in run when intentionally provisioned**

Run: `$env:MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E='1'; npm run build; npm run test:e2e:disposable-client-join`

Expected: PASS only after the server log proves the synthetic join, then clean client and server stops and scratch-root deletion.

## Self-Review

- Spec coverage: Tasks 1–3 cover isolation, production IPC install, offline-only properties, encrypted fake auth, registration, proper launch, log proof, cleanup, and opt-in execution.
- Placeholder scan: no unspecified tests or implementation actions remain.
- Type consistency: Task 1 confinement is required by Task 2 writes and Task 3 evidence; Task 3 owns process stops and success-only cleanup.
