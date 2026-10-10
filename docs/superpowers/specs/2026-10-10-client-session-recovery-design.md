# Matching-client session recovery

## Intent and evidence

The normal disposable TFG 0.13.4 client must remain usable after idle time, a long pack download, or a management-server restart. Authentication recovery must not alter the client directory being reviewed or installed, change the selected server, or bypass pack/file verification.

Native testing on 10 October found that Review matching pack and Refresh requirement failed after idle time while management still showed Connected. Returning to the same client through the sidebar re-registered it and restored the requirement. The exact historical HTTP rejection was not captured. Source establishes a 120-second server idle timeout, 300-second client polling, and no recovery in the main matching-pack reader. An external probe using encrypted on-disk token bytes was invalid and is discarded.

The user has explicitly requested self-review and implementation without further design questions. Independent design review is recorded in `.superpowers/sdd/2026-10-08-matching-client-packs/task-6-client-session-design-review.md`; its five corrections are incorporated here. Product/test files remain frozen until the current native preview settles and the QA app is closed normally.

## Decision

Use one main-owned, process-memory management session broker. Both existing registered-client renderer requests and main matching-pack requests acquire the same current session. Recover safe reads once after a 401. Registration changes memory only, never `client-config.json` or app-store authentication fields.

Rejected alternatives: extending server TTL/adding only a heartbeat does not survive restart or suspension; writing recovered tokens into the client directory invalidates retained review and publication snapshots. No durable token store, heartbeat, generic HTTP proxy, cross-process lease, or config caching across publication is needed.

## Authority and lifetime

- Resolve an existing registered client by app instance ID in main. A mutually exclusive path fallback is allowed only through the existing registered-path resolver. Renderer URLs, ports, pins, invites, remote identities, and tokens are never authority inputs to the new IPC.
- At each acquire/read boundary, re-resolve the instance and read normalized saved config. Canonical registered path, origin, TLS pin, remote client ID, registration name and invite authority identify a binding. Missing or undecryptable required authority fails closed.
- Seed its saved token once. Subsequent reads of an old disk token never replace a newer memory token. Allocate a fresh opaque binding generation on each authority change/invalidation; token revisions advance independently within one generation.
- Recheck authority after asynchronous acquisition/registration and before retry/commit. Saved-origin changes, removal or invalidation reject stale completions. Hooks on explicit client save, rename and removal invalidate promptly; read-time comparison also detects external edits and closes write-hook races.
- Distinct local bindings claiming the same canonical origin and remote client ID must fail closed rather than repeatedly rotate each other's token. No claim of coordination across different user-data roots or machines.
- Broker exists only behind successful production composition ownership. Reuse the existing ArtifactWorkspaceRegistry process-bound root lease. On shutdown abort shared registration and settle owned promises; do not release the existing ownership before broker disposal.

## Contracts

Create `electron/services/management-session-broker.cjs`:

```js
new ManagementSessionBroker({ resolveClient, readClientConfig, getPinnedHttpsAgent,
  requestJson, clock, randomUUID, timeoutMs })
broker.acquire(clientInstanceId, { signal, deadline, expectedBinding, reason,
  observedBindingGeneration, observedRevision })
// -> immutable { token, baseOrigin, binding, bindingGeneration, revision }
broker.readServerInfo(clientInstanceId, { signal, deadline, expectedBinding })
// -> { response, binding }
broker.invalidate(clientInstanceId)
broker.dispose()
```

`reason` is `reuse`, `authorization-rejected`, or `explicit-reconnect`. The latter two require the failed/acquired generation and revision together. Old-generation observations fail without rotating a replacement binding. If a peer already advanced the same binding's revision, adopt it. Otherwise join a single registration promise. First acquisition without a token can register once; explicit reconnect first acquires a snapshot, then requests its conditional rotation.

`binding` is an immutable main-only stamp containing no token. Expected binding is mandatory on subsequent reads in one retained preview/install or managed launch sequence. Public pack DTOs remain unchanged.

Add private `ManagementPackClient.readRequirement(clientId, options) -> { descriptor, binding }`; retain descriptor-only `getRequirement` for independent callers. Descriptor normalization, server-change errors, launch fingerprint/artifact and port checks remain in ManagementPackClient. `getLaunchConnection` accepts the retained binding via a separate options argument, not public authority data.

## Bounded transport and cancellation

- Main transport allows only fixed GET `/api/server/info` and POST `/api/client/register` at validated saved origin. HTTPS uses the current pinned agent. No redirects.
- One logical safe read: at most initial GET, one registration/join, one retry GET. Only protected-read 401 permits recovery. Registration refusal, 403, 429, 5xx, network/TLS failure, malformed data and pack drift do not authorize retry/rotation.
- Default per-attempt timeout 10 seconds; logical-read deadline 30 seconds including agent preparation and shared-registration wait. Caller may supply a shorter deadline. Bound registration request/response to 16 KiB and info response to 256 KiB. Registration requires `success: true` and the existing server's 64-character lowercase hex token.
- Propagate the preview/install AbortSignal through every requirement read. Cancellation of one waiter must detach promptly without aborting a peer's shared registration. Shared work has its own deadline and is aborted by binding invalidation/disposal. Recheck waiter cancellation and binding after each await. Never auto-replay a mutation/download.
- Errors expose an allowlisted failure category/status where useful, never headers, body, token, invite, certificate/key, raw config or arbitrary remote error text. No new persistent diagnostic stream is required.

## Renderer boundary

Create exact-schema `management-session:acquire` IPC, allowlisted in preload and registered for the current app webContents **and its main frame only**. Owner destruction cancels its waiters, not peer work. Request contains exactly one registered `clientInstanceId` or `clientPath`, reason, and conditional observed generation/revision. Response is privileged `{ sessionToken, baseOrigin, bindingGeneration, revision, registrationAttempted }`; it is never a public client-pack DTO or durable store field. The required boolean is main-authored acquisition provenance: true only when this acquisition started or joined shared registration. A narrow main-only `acquireWithProvenance` wraps the same acquisition algorithm; ordinary `acquire` snapshots stay unchanged. Missing provenance fails closed. A fresh initial registration consumes the logical read's one registration allowance, so neither explicit reconnect nor a first401 rotates it again. Mounted tokens and revision arithmetic cannot supply this evidence.

Update managementAuth helpers to acquire the broker snapshot; remove renderer registration and its save-client-config side effect for already registered clients. Authenticated request callbacks receive immutable headers and the matching trusted origin snapshot. Construct URLs only from that snapshot, after acquisition, with `redirect: 'error'`. An async selection/mounted-authority change must discard stale completion rather than updating another client. Initial ClientSetupWizard registration/save remains unchanged.

Registered reads keep attempt and logical deadlines/cancellation active through streamed body consumption, JSON parsing and final assertions, not merely headers. A parsed-result helper may share the recovery operation and return `{ok,status,data}`; all production protected JSON consumers use it. Count actual response bytes for the256KiB information limit before retaining an oversized chunk. Other protected lists retain their existing size policy. The registered server-list fallback reuses bounded main transport with one absolute deadline through acquisition/agent/assertion/body; setup's default fetch branch is unchanged. Capture Manager liveness at user-operation start and carry it into installed/synchronization/list continuations after IPC and timers, suppressing retired results without replaying or retargeting the content operation.

Inventory every token attachment site, categorizing it:

1. Public `/api/test`: no authentication header.
2. Protected status/version/mod/asset-list reads: acquire at dispatch and use bounded safe-read recovery, including immediate status polling.
3. One-shot legacy content mutation/download: keep managed-client gates, obtain current registered context in main immediately before dispatch, and never replay automatically. Do not rewrite content-download behavior.
4. Initial setup: existing registration/save contract unchanged.

Mounted compatibility fields may be refreshed without persistence only when still bound to the acquired snapshot. No auth-refresh call may invoke save-client-config, app-store persistence, or candidate writes. Existing explicit user settings changes remain genuine content changes.

## Pack lifecycle invariants

Preview retains its first requirement's binding. Both install reads require that same binding even when another server would return an identical descriptor. Managed launch retains one binding across classification, file/runtime verification and connection resolution. Token renewal does not change a binding. Connection changes fail PLAN_STALE.

Full client-tree baselines, client-config bytes, preserved files, manifest equality and publication checks stay unchanged. Do not silently refresh a baseline, omit config from equality, patch copied tokens or add network calls after seal. Temporary absence of config may fail a concurrent read closed; publication itself needs no config cache.

## Verification and scope

Test-first implementation with synthetic auth and controlled clocks/transports; tests exercise the real broker, adapter and relevant renderer helpers, not source-string assertions. Cover concurrent main/renderer recovery, stale generation, same-revision adoption, alias refusal, authority change during await, pin/redirect/status/body/deadline refusals, waiter cancellation/disposal, exact IPC/trusted frame, unchanged setup, and all token-site categories.

Lifecycle regressions must prove memory recovery before install and after long runtime preparation leaves exact client-config bytes unchanged, preserves retained binding, and still rejects real config/file edits. Test managed launch's complete binding sequence.

After review/build/regression gates, reopen only isolated b1 normally and retest idle >150 seconds, preview/review, idle-before-install, long runtime preparation, restart, client verification and launch through native controls. Installation/security/authentication actions retain applicable action-time/user-only restrictions. Existing real instances remain untouched. Scripted regressions are not native acceptance evidence.

Out of scope: global auth redesign, token persistence migration, server TTL changes, OS security prompts, unrelated user edits, push or release. Slow-preview retention expiry is a separately scoped correction with its own test and does not justify weakening any integrity check.

## Self-review

The design keeps origin and token paired, requires a retained connection binding, covers token consumers beyond registration sites, revalidates saved authority despite missed hooks, and propagates cancellation/budgets. No field or endpoint is delegated to untrusted renderer authority. The existing composition owns lifetime; no new lease or publication-time network work. Native source freeze is an execution prerequisite, not a completion claim.
