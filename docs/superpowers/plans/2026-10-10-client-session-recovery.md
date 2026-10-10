# Client session recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep matching-client reads, retained reviews and installation usable across normal session expiration without changing reviewed files or switching server authority.

**Architecture:** One main-owned memory-only ManagementSessionBroker coordinates registered-client authentication. Narrow privileged IPC gives existing renderer readers the same origin-bound session; matching-pack lifecycle keeps a private binding stamp throughout each operation.

**Tech Stack:** Electron/CommonJS main, Svelte renderer, Node test runner, existing pinned HTTPS and client-pack transactions.

**Spec:** `docs/superpowers/specs/2026-10-10-client-session-recovery-design.md`

## Global Constraints

- Product/test source remains frozen until the current native preview settles and the isolated QA app closes normally.
- Never touch real profiles, existing real server/client instances, a1 recovery evidence, or live b1 files through test scripts. Native acceptance uses mouse/keyboard on the disposable b1 profile only.
- Preserve unrelated `src/stores/modStore.js`, `tests/ignored-mod-updates-renderer.test.cjs`, and `migration-review-2026-10-07.md` exactly.
- No session-refresh writes to client-config, app-store auth or candidates. No baseline refresh/equality exemption; explicit user settings edits still stale plans.
- Exact saved origin/pin/identity, one retained binding, one conditional registration and at most one safe-read retry; no 403/5xx/TLS retry, mutation replay, generic proxy or new lease.
- Per attempt 10 seconds, logical read 30 seconds including agent/shared wait; info maximum 256 KiB, registration request/response maximum 16 KiB; registration token lowercase hex64.
- New IPC accepts only an existing registered client identity/path and conditional recovery generation/revision; expected app webContents and main frame only.
- Initial ClientSetupWizard registration/save remains unchanged. No dependency installation, push or release.
- Test-first RED/GREEN, independent code review, build and regression gates precede normal native retesting. Scripted tests are not native acceptance.

## Review Focus

- Old-generation 401 arrives after saved server change: reject without rotating/sending credentials to replacement authority (Task1).
- Two app instances share a remote client ID: refuse conflicting local bindings rather than token ping-pong (Task1).
- One cancelled renderer waiter and a live main waiter share registration: cancellation remains local and peers settle (Task1).
- Auth rotates between review and runtime completion: exact client-config bytes and original binding stay unchanged through publish (Task2).
- Mounted URL changes during await or an HTTP redirect: acquired token never reaches the wrong origin; legacy writes are not replayed (Task3).

### Task 1: Main-owned session and bounded transport

**Files:** Create `electron/services/management-session-broker.cjs`, `electron/services/management-session-transport.cjs`, `tests/management-session-broker.test.cjs`, `tests/management-session-transport.test.cjs`.

**Interfaces:** Produce `ManagementSessionBroker` and its acquire/readServerInfo/invalidate/dispose contracts exactly as the spec. Transport export `requestManagementJson(url, { method, body, headers, agent, signal, timeoutMs, maxBytes }) -> { statusCode, body }`. Constructor-injected transport/clock/UUID permit synthetic tests; defaults use Node http/https and Date.now/crypto.randomUUID. Only broker supplies fixed paths. Binding stamp is token-free immutable object with an opaque `generation`; privileged session has `bindingGeneration` matching it and `revision`.

- [ ] Write failing broker tests for seed reuse, missing-token registration, first401→one registration→retry, concurrent main/renderer single-flight, late same-binding revision adoption, old-generation rejection, repeated401 stop, duplicate remote identity refusal, changed saved tuple/registered target, missing/decryption failure, and stale registration completion.
- [ ] Write failing transport/refusal tests using real local HTTP fixtures and injected pin-agent boundary: exact GET/POST/body/headers, redirect refusal, 403/429/500 no rotation, malformed/oversized/token-invalid responses, deadline including slow agent/shared wait, one waiter abort with peer survival, invalidation/dispose. Assert no secret in surfaced errors and no config write API is called.
- [ ] Run `node --test tests/management-session-broker.test.cjs tests/management-session-transport.test.cjs`; record expected RED before implementation.
- [ ] Implement minimum broker/transport contracts. Compare normalized saved authority on boundaries; memory overlay never takes a later saved seed over current token. Pending registrations are bound to generation and single-flight. Same origin+remote ID across distinct bindings refuses. Enforce budgets and cancellation throughout.
- [ ] Re-run focused command GREEN, inspect diff and append evidence report. Root performs independent task review before downstream integration; no native app startup by worker.

### Task 2: Pack lifecycle, privileged IPC and composition

**Files:** Modify `electron/services/client-modpacks/management-pack-client.cjs`, `client-pack-service.cjs`, `client-pack-integration.cjs`, `electron/bootstrap/create-client-pack-composition.cjs`, `create-production-modpack-composition.cjs`, `electron/ipc-handlers.cjs`, `electron/preload.cjs`, `electron/ipc/settings-handlers.cjs`. Create `electron/ipc/management-session-handlers.cjs`. Tests: existing matching client management/service/integration/composition suites, plus `tests/management-session-handlers.test.cjs` and focused integration regressions.

**Interfaces:** Consume Task1 broker. `ManagementPackClient.readRequirement(clientId, {signal, deadline, expectedBinding}) -> {descriptor,binding}`; `getRequirement` remains descriptor-only; `getLaunchConnection(clientId, authority, {expectedBinding,signal,deadline})` enforces retained binding. ClientPackService private `_requirement` supports the binding result; public request/response DTOs unchanged. `getLaunchAuthority` takes internal options separately, never renderer-supplied binding. Session IPC takes exactly one of `clientInstanceId`/`clientPath`, reason, and recovery observation; returns `{ok:true,value:{sessionToken,baseOrigin,bindingGeneration,revision}}` or sanitized failure. Handler factory receives current win + broker + registered-path resolver; dispose detaches owner waiters. Composition exposes broker plus path resolver only to internal IPC wiring.

- [ ] Write failing lifecycle tests: expired before install, after long runtime prep, server restart; same descriptor from changed origin/pin/identity still PLAN_STALE; full launch sequence retains one stamp; caller cancellation reaches requirement. Use real service/transaction seams with synthetic network and exact client-config bytes; real edits still fail baseline.
- [ ] Write failing IPC tests for trusted webContents/main frame, exact request shape/recovery pair, unregistered path, cross-client response scope, owner cancellation, sanitized failure. Test settings-save/rename/remove invalidation and read-time comparison after asynchronous writes.
- [ ] Run the affected test files and record expected RED.
- [ ] Wire one broker behind the existing owning production composition and dispose it before ownership release. Main adapter retains all descriptor/server-change/fingerprint/launch-port checks. Preview stores binding; install reads and managed launch require it. No network added after seal. Thread AbortSignal/deadline rather than silently discarding them.
- [ ] Add privileged handler/preload registration with strict trusted frame and lifecycle handling; add save/rename/delete invalidation hooks without changing settings serialization or snapshot semantics.
- [ ] Run focused tests GREEN; independent task review before renderer integration.

### Task 3: Renderer readers and legacy one-shot consumers

**Files:** Modify `src/utils/managementAuth.js`, `src/components/client/ClientInterface.svelte`, `src/components/client/ClientModManager.svelte`, `src/utils/clientMods.ts`, and the narrow registered-authority acquisition boundary in `electron/ipc/minecraft-launcher-handlers.cjs`/composition if legacy content consumers need it. Tests: existing management-auth/client renderer suites and focused legacy main boundary tests; add behavioral renderer regressions where needed.

**Interfaces:** `requestWithSessionRecovery(instance, request, options)` calls `request(headers, sessionSnapshot)`; callers construct URLs from `sessionSnapshot.baseOrigin` after acquire and set `redirect:'error'`. Existing ensure helper delegates to broker for registered clients and never registers/saves itself. Runtime mutation/download dispatch obtains current main registered context once without replay. Setup wizard is unchanged.

- [ ] Inventory all token attachments in a report as public/no-auth, protected safe read, one-shot content dispatch, or initial setup. Include immediate status, optional lists, and renderer serverInfo IPC payloads—not only ensure callers.
- [ ] Write failing behavioral tests for current overlay replacing stale mounted tokens, origin mismatch/selection change while awaiting, generation+revision recovery request, one401retry but no403/5xx retry, redirects blocked, no save-client-config side effect, protected status after idle, and managed-client legacy gates unchanged. Assert a one-shot mutation is dispatched at most once.
- [ ] Run relevant tests RED; implement helpers/callers with snapshot-origin and token paired. Public probes omit tokens. No auth-refresh persistence; no new UI security/auth bypass.
- [ ] Re-run focused tests GREEN, then root independently reviews the integrated diff. Run `npm test`, the relevant rendered test suite and `npm run build` on frozen final source. Record all failures/skips; fix via tested focused changes, not timeout inflation.
- [ ] Root commits only scoped reviewed files, updates native checklist, opens normal b1 app with its existing isolated profile, and retests idle>150s, preview/review, idle-before-install, long preparation, management restart and client launch. Respect action-time install confirmation and user-only authentication/security prompts. Do not mark release complete from regression tests.

## Self-review and execution

All tasks consume the same field names and binding semantics. Task1 independently tests memory/transport; Task2 owns authority propagation/IPC/lifetime; Task3 owns callers and complete end-to-end integration. Shared files between2/3 require sequential execution. No plan step edits native test data. Long-preview retention expiry is a separately reviewed small fix and must not be disguised as authentication behavior.

The user explicitly delegated plan review and implementation decisions. Root self-reviewed this plan against the committed spec and chooses sequential subagent implementation with independent per-task review, while root alone operates the native UI. No additional design approval request is required. Execution begins only after the active native preview ends and the QA app is closed normally.
