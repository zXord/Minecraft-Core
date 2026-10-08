# Matching Client Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install and maintain the exact client companion for a managed server through Minecraft Core's normal UI without damaging personal client content.

**Architecture:** Reuse official provider acquisition and isolated archive services, add an explicit MRPACK client projection, a server companion registry and a client-owned transaction service. Keep identity, process exclusion, launch checks and legacy-writer guards in main; UI receives scoped previews/progress only.

**Tech Stack:** Electron 42, Node 24, CommonJS services, Svelte 5, existing durable-fs/ArchiveWorker/XMCL, node:test and Playwright rendered tests. No new package required.

**Spec:** `docs/superpowers/specs/2026-10-08-matching-client-packs-design.md`

## Global Constraints

- Only disposable native test profile/folders; never the user's existing Server or Client instances.
- MRPACK v1 client projection; existing GitHub ZIP/RAR server handling unchanged; no arbitrary script execution.
- Exact immutable source IDs/digest and Minecraft/loader versions; no latest/vanilla fallback for managed clients.
- Preserve saves, screenshots, auth, connection config, options and user additions; conflicts require explicit review.
- A live or uncertain client process blocks pack mutation across app restarts; no broad process killing.
- Main authenticates management requests from saved client connection data; no credential-bearing redirects or renderer filesystem/URL authority.
- Local commits only after verification; preserve unrelated `migration-review-2026-10-07.md` and prior work. No push/release.
- Root owns native UI and final full-suite/build runs; implementers use scoped tests and report RED/GREEN. No concurrent agents writing shared files.

## Review Focus

- A game changes a config after preview: transaction rejects the stale baseline or shows a new conflict (Task 4).
- App dies after JVM spawn but before PID persistence: marker/owner proof still blocks a second import (Task 3).
- Server returns to a prior release with a new manifest/revision: canonical pairing identity still matches (Task 2).
- Pack embeds credentials or case-aliases a protected client file: reject before publication (Task 1).
- Delayed metadata for client A arrives after switching to B: no installation or launch with A's identity (Task 5).

---

### Task 1: Client MRPACK projection and isolated candidate

**Files:** Modify `electron/services/modpacks/mrpack/mrpack-file-plan.cjs` only to share side-independent projection internals; create `electron/services/client-modpacks/client-content-policy.cjs`, `client-candidate-preparer.cjs`; test `tests/modpacks/mrpack-client-file-plan.test.cjs`, `tests/client-modpacks/client-candidate-preparer.test.cjs`.

**Interfaces:** Export `buildMrpackClientPlan({manifest,selectedOptionalFiles,archiveEntries=[]})`, `listOptionalClientFileChoices(manifest)`, `resolveOptionalClientFileChoiceIds(manifest,ids)` alongside unchanged server exports. Client plan mirrors server result but type `mrpack-client-plan`, layers downloads/overrides/client-overrides. Export `clientPathPolicy(relativePath)` -> `managed|preserve-after-seed` or throw. `ClientCandidatePreparer({workspaceRegistry,archiveExtractor,artifactDownloader,artifactCache,candidateHashService,reparseInspector,randomUUID})`: `inspect({inspectionId,signal,onProgress})` -> main-only `{inspectionId,outputId,runtime,name,version,optionalFiles,downloadBytes,manifest,archiveEntries}`; `prepare({inspectionId,optionalFileIds,signal,onProgress})` -> `{ownerId,outputId,path,runtime,manifest:{entries:[{path,pathKey,sha256,size,policy}]},optionalFileIds,totalBytes}`. `release(ownerId)` releases only controlled workspaces. No registered client/live-path writes.

- [ ] Write RED tests: required client+unsupported server selected, server-only excluded; optional IDs independent of server side; common/client precedence; no server overrides; collision/protected paths including case/backslashes, `.minecraft-core`, `minecraft-core-*`, `client-config.json`, auth, saves, runtime roots and executables rejected; options/servers.dat preserve-after-seed. Existing server assertions must remain unchanged.
- [ ] Run `node --test tests/modpacks/mrpack-client-file-plan.test.cjs`; confirm missing client exports/behavior fail.
- [ ] Implement side-aware shared projection and client-only policy (do not duplicate the complete server planner).
- [ ] Write/run RED candidate tests using actual temporary trees/manifest/hash files with only external download/worker boundary doubles: exact file contents, both hashes passed to downloader, optional selection, cancellation, changed source, output ownership, errors release owned workspaces only.
- [ ] Implement candidate using existing ArchiveInspector materializer load and ArchiveExtractor output ownership; parse extracted bounded root index; copy validated files through existing copyRegularFile/hash service. Reject ambiguous/nested index for first format rather than guessing. Preserve same byte/count progress shape as server candidate.
- [ ] Run both new test files and existing MRPACK/candidate tests; expect all pass. Produce scoped diff/report; root commits after integration verification.

### Task 2: Canonical companion identity and server pairing

**Files:** Create `electron/services/client-modpacks/companion-contracts.cjs`, `companion-store.cjs`, `companion-service.cjs`; test corresponding `tests/client-modpacks/*.test.cjs`. Integration is Task 5, not this task.

**Interfaces:** `serverPackFingerprint(state)` -> SHA256 canonical identity; `normalizeCompanionDescriptor(value)` -> strict public descriptor. `CompanionStore({filePath,durableFs,fsApi})` exposes `initialize()`, `get(serverId,fingerprint)`, `put(record,{expectedSequence})`, `sequence`. `CompanionService({store,readServerState,resolveServer,coordinator,providers,sourceResolver,artifactAcquisition,archiveInspector,clientCandidatePreparer})` exposes `getStatus({serverId})`, `listAssets({serverId})`, `inspect({serverId,expectedServerFingerprint,assetId},options)`, `accept({serverId,expectedServerFingerprint,inspectionId})`. `getStatus` yields null unmanaged or descriptor `{schemaVersion:1,status:'unpaired'|'ready',serverFingerprint,serverVersion,source:null|source,runtime:null|runtime,artifactSha256:null|string}`; source uses exact Github `{provider,repositoryId,githubOwner,githubRepo,releaseId,assetId}` or Modrinth `{provider,projectId,versionId}`. No path/URL fields.

- [ ] RED tests: stable fingerprint through content revision/manifest/installedAt changes; different release/runtime/optional choices changes it; reject untrusted sources; historical pairing survives rollback. Corrupt store cannot return ready or overwrite existing data silently.
- [ ] Implement bounded atomic checksummed registry (4MiB/1000 records) with CAS sequence and strict records; use existing durable-fs methods, no silent catch-and-reset.
- [ ] RED service tests: same-release asset selection only, official re-resolution, measured digest binding, runtime mismatch rejection, stale server fingerprint between inspect/accept, mutation reservation with revisionMode none, absent/corrupt pair yields explicit unavailable without altering healthy server state.
- [ ] Implement service using Task 1 inspection; Modrinth resolves installed exact version. Pairing inspection does not download every referenced mod, only archive/index. Cache inspected selection in main; renderer cannot manufacture a binding.
- [ ] Run `node --test tests/client-modpacks/companion*.test.cjs`; expect pass. Produce report/diff; no UI or server journal changes.

### Task 3: Durable running-client exclusion

**Files:** Create `electron/services/client-modpacks/client-process-guard.cjs`, `client-process-inspector.cjs`; modify `electron/services/minecraft-launcher/proper-launcher.cjs` and `index.cjs` for optional managed hooks; tests `tests/client-modpacks/client-process-guard.test.cjs`, `tests/client-modpacks/managed-client-launch.test.cjs`.

**Interfaces:** `ClientProcessGuard({root,durableFs,inspectProcesses,acquireEndpointLease,randomUUID})`: `withMutation({clientId,clientPath},callback)`, `beginLaunch({clientId,clientPath})` -> `{launchId,jvmArgument,attach(child),abortBeforeSpawn(),close()}`; `status({clientId,clientPath})` -> stopped/running/uncertain. JVM marker `-Dminecraft.core.clientLaunchId=<uuid>` issued only in main. `inspectProcesses()` returns bounded authoritative process snapshot with PID,parentPID,creation/executable/commandline identity or rejects; missing visibility is uncertain, not absence. Managed hooks passed as non-renderer production options to launcher.

- [ ] RED tests with event-emitting exact child: launch reservation blocks mutation before spawn, while child alive, after error-before-close, and until close; failed pre-spawn settles safely; no arbitrary PID kills.
- [ ] RED restart tests with real temp durable intent: crash before PID publication + marked child alive blocks; PID reused but different identity does not adopt/kill; query denied/malformed/partial means uncertain; owner still preparing blocks; both owner+marker proven absent permits recovery.
- [ ] Implement process-bound endpoint exclusion plus bounded durable intent and exact child identity. Follow existing app-watchdog static PowerShell process identity pattern on Windows, never interpolate untrusted paths into shell code. Keep process queries read-only.
- [ ] Wire optional main-owned hooks immediately before actual spawn and exact close; do not release at successful IPC return. Main crash must leave enough evidence for startup status. Unmanaged launch unchanged.
- [ ] Run new tests plus proper-launcher/auth-launch cancellation tests; expect pass. Review before Task 4 publication uses guard.

### Task 4: Client ownership transaction and main service

**Files:** Create `electron/services/client-modpacks/client-pack-state.cjs`, `client-pack-transaction.cjs`, `client-pack-service.cjs`, `management-pack-client.cjs`; tests under `tests/client-modpacks/` with matching names.

**Interfaces:** `ManagementPackClient({resolveClient,readClientConfig,fetchJson,getPinnedHttpsAgent})` exposes `getRequirement(clientId,{signal})` -> validated descriptor fetched from saved exact origin. `ClientPackService({resolveClient,managementClient,candidatePreparer,sourceResolver,artifactAcquisition,archiveInspector,processGuard,transaction,stateStore,runtimeInstaller})`: `getState({clientId})`, `preview({clientId,optionalFileIds},options)`, `install({clientId,planId,conflictChoices},options)`, `cancel({clientId,operationId})`, `verify({clientId})`, `recover({clientId})`, `getLaunchAuthority({clientId})`. State/result/progress are path-free public DTOs; internal plan holds identities, snapshots and staged paths. Exact optional IDs come from preview, unknown choices rejected.

- [ ] RED transport tests: authenticate exact saved origin, TLS pin required for HTTPS, reject redirect/token forwarding, bounded JSON/timeout, server fingerprint/digest/runtime validated; renderer descriptor cannot authorize a fetch.
- [ ] RED ownership tests: fresh install files, preserve auth/saves/options/user additions, remove only unchanged old-owned, changed owned file conflict, explicit preserve config vs replace, modified JAR cannot be declared verified, stale preview rejects without writes.
- [ ] Implement main-only state store and plan authority; fetch requirement again before publication; official provider re-resolution must match reviewed SHA256. Runtime install uses exact XMCL/Java tuple, never checkMinecraftClient's version cleanup path.
- [ ] RED durable publication tests inject failure before/after each rename/manifest publication; recover old-or-new exact directory, never mixed or empty live; unknown identity blocks; active child blocks; cancellation waits for writers, preserves evidence on uncertainty. Use real temp filesystem and injected durable flush failure only at boundaries.
- [ ] Implement same-volume candidate/previous directory transaction using durable-fs, exact native directory identities, journal and recovery. No reuse of server-only health/registration code. Retain prior directory until commit proven; constrained cleanup only owned paths.
- [ ] Run `node --test tests/client-modpacks/*.test.cjs` plus related durable-fs tests; expect pass. Produce reviewed service before wiring exposed IPC.

### Task 5: Production wiring, guarded legacy paths and visible flows

**Files:** Modify production modpack composition/service graph, main registration, management-server, preload/types, server-mutation-policy, minecraft-launcher handlers; create `electron/ipc/client-modpack-handlers.cjs`, `src/components/modpacks/ClientCompanionPanel.svelte`, `src/components/client/ClientModpackPanel.svelte`; modify ModpackPage, ClientInterface, PlayTab and ClientSetupWizard at owned boundaries. Add focused IPC/integration and rendered tests.

**Interfaces:** Invoke channels `client-packs:get-companion`, `client-packs:list-companion-assets`, `client-packs:inspect-companion`, `client-packs:accept-companion`, `client-packs:get-state`, `client-packs:preview`, `client-packs:install`, `client-packs:cancel`, `client-packs:verify`, `client-packs:recover`; event `client-packs:progress` includes requestId/clientId or serverId, phase and measured counts. Server selectors are registered IDs; clients registered IDs. Strict request/result schemas and sender-scoped progress, not generic unbounded invoke.

- [ ] RED IPC tests for forged path/source/descriptor rejection and unknown fields, current-instance scope, main-owned registered resolution, disposal cancellation. Create production services through graph; expose sanitized clientModpack in authenticated `/api/server/info` only.
- [ ] RED tests call legacy client content handlers with forged empty mod lists on a managed path: no pack file deleted/modified; main rejects with actionable managed-pack error. Keep connection/auth/preference edits usable. Branch read-only managed check to pack verification, not legacy cleanup.
- [ ] Implement main launch authority: fresh requirement and installed fingerprint must match; runtime from state, strict proper launch, exact loader profile required; generic latest/vanilla fallback forbidden. Connect Task 3 hooks.
- [ ] RED rendered tests: explicit companion asset choice/runtime review; client preview/options/progress/install/recovery; unpaired blocked with explanation; unmanaged unchanged; delayed client A response after switching B ignored; preserved/conflicting file decisions visible; no success label after failure.
- [ ] Implement consistent neutral cards/accent primary action; show real byte+file progress. Auth remains normal user action; never auto-import existing profile. Native user settings remain preserved.
- [ ] Run focused Node IPC/guard/integration tests and `npx playwright test tests/e2e/client-modpack*.spec.js --workers=1` with a unique output directory; expect pass. No production build while root's native session is active.

### Task 6: Native acceptance, whole-suite review and commits

**Files:** Create `docs/testing/2026-10-08-native-modpack-verification.md`; update existing documentation to distinguish supported client/server formats. Root owns any final fix integration and scoped commits.

- [ ] Through normal app UI and disposable profile complete TFG 0.13.4 server, upgrade0.13.5, downgrade/rollback0.13.4, verify/repair/history/notifications; record exact IDs and observed outcomes.
- [ ] Pair official0.13.4 MRPACK asset477754823, SHA256117091d40d83ea53baab195e895302be385fd4260bc9a2c4c44167e456aee821; create disposable client via normal invite/folder setup; install and verify configs/scripts/mods, exact runtime and honest progress.
- [ ] Launch client with normal Microsoft authentication (user hands off login if needed), join exact disposable server, record game/server proof. No synthetic offline fixture counted as normal join. Test update/downgrade and preserved options. Stop only test processes normally.
- [ ] Close native app, run fresh `node --test --test-concurrency=2`, deterministic modpack/client rendered/Electron tests, `npm run build`, syntax/diff checks. Report all skips and external blockers accurately.
- [ ] Independent whole-change review for ownership/async/recovery integration. Fix important findings with regression tests and rerun affected/full checks.
- [ ] Stage only task-relevant files, preserving unrelated migration review. Commit coherent verified groups locally; never push/publish. Final report distinguishes visible real-pack results from automated fixtures and lists any still-unverified authentication-dependent step.

## Self-review and execution notes

Tasks1/2 produce exact projection/identity consumed by4/5; Task3 is required before any live client mutation or managed launch; Task4 exposes no IPC before Task5 guards exist. Task5 owns shared bootstrap/IPC files so earlier tasks cannot race edits there. Normal server testing continues independently using already-built server code. No client feature is represented as complete until Task6 evidence exists.
