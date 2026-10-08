# Generic GitHub Import Reliability, Progress, and Windows Identity Implementation Plan

> **Execution note:** The user explicitly approved autonomous plan review and implementation. Execute continuously; do not pause for plan approval.

**Goal:** Make GitHub modpack imports work generically across unusual server-pack layouts, eliminate false filesystem-integrity failures caused by metadata-only activity, report truthful preflight work, and establish the correct Windows taskbar identity during development startup.

**Architecture:** Keep archive safety and transactional publication universal. A managed install may only be offered when the inspected archive supplies an exact supported runtime; every other safe, non-client-only layout must remain installable through an unmanaged files-only path that extracts reviewed bytes without executing publisher scripts or guessing a launch command. Durable file identity will continue to require the same object, size, last-write time, and SHA-256 content, while treating Windows ChangeTime as advisory because sync, backup, indexing, and antivirus software may update metadata without changing the file. Preflight progress will use closed public stage/activity values, determinate metrics only where real totals exist, and an indeterminate activity indicator otherwise. Electron app name and AppUserModelID will be applied before `app.whenReady()` and before the first window is created.

**Tech stack:** Electron/CommonJS main process, Svelte renderer, Node test runner, C#/.NET native ArchiveWorker, Playwright Electron tests.

## Global constraints

- Do not read from, write to, start, stop, repair, or install into the user's existing server or client instance.
- Use only uniquely named disposable directories for integration and end-to-end tests. Resolve and validate exact paths before deleting any test artifact.
- Do not add TerraFirmaGreg-, Synology-, or repository-specific behavior. The behavior must apply to any safe archive and any background filesystem metadata writer.
- Do not relax archive entry safety, reparse-point checks, canonical-path checks, file-ID checks, SHA-256 checks, download authority checks, or transactional publication and rollback.
- Ignore a file's `ctime`/Windows ChangeTime only where stronger evidence is present: same file type, volume/device, file ID, size, last-write time, SHA-256, and applicable birthtime/reparse/final-path checks.
- Never convert real content, object, path, reparse, or size changes into success. Existing substitution and tampering regression tests must remain green and new tests must demonstrate rejection.
- A files-only import never runs archive-provided scripts and never claims that Minecraft Core can launch or manage an unknown runtime.
- Progress may show a percentage only when it derives from measured byte or item totals. Coarse lifecycle stages may be shown as “stage N of M,” but must not be rendered as a fabricated percent.
- Renderer events must expose closed, schema-validated activity values and aggregate counts/bytes only; do not expose absolute paths or individual filenames.
- Preserve all unrelated working-tree changes and do not commit, reset, clean, or overwrite them.

## Task 1: Tolerate metadata-only file ChangeTime drift while retaining strong identity

**Files:**

- Modify: `native/ArchiveWorker/Durability/DurableFilesystem.cs`
- Modify: `electron/utils/windows-durable-fs-client.cjs`
- Modify: `electron/utils/durable-fs.cjs`
- Modify: `native/ArchiveWorker.RecoveryTests/Program.cs`
- Modify: `tests/windows-durable-fs-async.test.cjs`
- Modify: `tests/durable-fs.test.cjs`
- Modify as needed: `tests/config-manager.production-durability.test.cjs`

**Step 1: Add failing tests for ctime-only drift.**

- Add JS boundary tests where before/after identities keep type, device, inode, birthtime, size, mtime, and SHA-256 identical while `ctime` changes. Assert the durable operation succeeds.
- Add native recovery/identity tests exercising the same expected identity and a captured file whose ChangeTime differs. Assert `Matches` and revalidation accept the file.
- Add atomic-write tests showing a target whose metadata ChangeTime changes during replacement is accepted only when its captured SHA-256 still matches.

**Step 2: Add failing tampering controls.**

- In the same suites, vary each load-bearing signal—file ID, size, mtime, SHA-256, and path/reparse evidence as supported—and assert failure remains fail-closed.
- Add a same-size content-change case so ignoring `ctime` cannot mask a rewrite.

**Step 3: Strengthen destination expectations.**

- When an existing atomic-write destination is captured, compute its SHA-256 within the configured atomic size limit and include the digest in the destination expectation sent to the Windows worker.
- Revalidate the live target against that digest immediately before publication. Preserve the existing caller-provided `expectedTargetSha256` behavior.

**Step 4: Change identity comparison semantics.**

- Keep parsing and carrying `ctime` for diagnostics/protocol compatibility.
- For files, compare type, device/volume, file ID/index, birthtime where applicable, size, mtime, and SHA-256; do not make `ctime` a pass/fail field.
- For directories, retain the existing stable directory identity rules.
- Keep `allowMetadataChange` scoped to post-flush cases that intentionally permit mtime/birthtime changes; it must not waive hashes, IDs, path, or reparse evidence.

**Step 5: Run targeted tests.**

Run the native recovery test executable and:

```powershell
node --test tests/windows-durable-fs-async.test.cjs tests/durable-fs.test.cjs tests/config-manager.production-durability.test.cjs
```

**Step 6: Reproduce under a synced parent.**

- Run a bounded replace/write loop in a unique disposable directory under the configured synced parent.
- Record that ctime-only interference no longer fails and that an injected same-size content substitution still fails.
- Delete only the exact disposable directory after resolving and validating it.

## Task 2: Make the generic files-only fallback consistent end to end

**Files:**

- Modify: `electron/services/modpacks/planning/production-candidate-preparer.cjs`
- Modify: `src/components/setup/ArchiveGuidedReview.svelte`
- Modify: `tests/modpacks/production-candidate-preparer.test.cjs`
- Modify: `tests/modpacks/guided-archive-planning.test.cjs`
- Modify: `tests/modpacks/modpack-setup-ui-presentation.test.cjs`

**Step 1: Add failing planner tests.**

- Cover a safe `unsupported-runtime-layout` archive and a safe `ambiguous-or-unknown` archive selected with `operationKind: 'files-only'`.
- Assert extraction and plan preparation continue with classification normalized to exact `files-only`, runtime `null`, and no publisher scripts executed.
- Assert client-only packs and application backup archives remain blocked even when files-only is requested.

**Step 2: Fix the classification order.**

- Split classifications into always-blocked categories (client-only and application backup) and managed-runtime-only blocks.
- Apply always-blocked checks before extraction.
- After optional root reclassification, allow files-only to normalize safe unusual layouts before managed-runtime-only validation.
- For managed installs, continue rejecting unsupported custom runtime layouts and incomplete runtime evidence.

**Step 3: Clarify the UI contract.**

- Explain that “safe files-only” copies reviewed server files without guessing or running an unknown launcher/runtime and therefore is not automatically managed/startable.
- Keep the managed-install choice visually and semantically distinct from the generic fallback.
- Ensure the UI does not advertise files-only for client-only or backup classifications.

**Step 4: Run targeted tests.**

```powershell
node --test tests/modpacks/production-candidate-preparer.test.cjs tests/modpacks/guided-archive-planning.test.cjs tests/modpacks/modpack-setup-ui-presentation.test.cjs
```

## Task 3: Replace synthetic preflight percentages with truthful activity progress

**Files:**

- Modify: `electron/services/modpacks/ipc-schemas.cjs`
- Modify: `electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs`
- Modify: `electron/services/modpacks/planning/production-planning-adapter.cjs`
- Modify: `electron/services/modpacks/planning/production-candidate-preparer.cjs`
- Modify as needed: `electron/services/modpacks/archive/archive-extractor.cjs`
- Modify as needed: `electron/services/modpacks/artifacts/artifact-downloader.cjs`
- Modify as needed: `electron/services/modpacks/planning/candidate-hash-service.cjs`
- Modify: `src/components/setup/ArchiveGuidedReview.svelte`
- Modify: `src/types/modpack.d.ts`
- Modify: `tests/modpacks/ipc-schemas.test.cjs`
- Modify: `tests/modpacks/modpack-preflight-progress.test.cjs`
- Modify: `tests/modpacks/production-planning-adapter.test.cjs`
- Modify: `tests/modpacks/production-candidate-preparer.test.cjs`
- Modify: `tests/modpacks/modpack-setup-ui-presentation.test.cjs`

**Step 1: Define the public progress contract with failing tests.**

- Keep lifecycle stages as a closed enum: destination validation, candidate preparation, server scan, change calculation, capacity check, plan sealing, complete.
- Add a closed optional activity enum for candidate work such as extracting, verifying archive, downloading pack files, assembling files, and hashing candidate files.
- Permit optional non-negative `completedItems`/`totalItems` and `processedBytes`/`totalBytes` pairs. Require a valid total before a determinate metric is rendered.
- Reject unknown activities, negative values, values above totals, paths, and filenames at the IPC schema boundary.

**Step 2: Propagate real signals.**

- Change the planning reporter to accept structured events rather than mapping every stage to a hard-coded percentage.
- Thread an `onProgress` callback through candidate preparation.
- Forward exact downloader byte progress where total bytes are known.
- Emit ordered activity boundaries for extraction, archive verification, file assembly, and hashing. Add item/byte counters only where the underlying operation can report real measurements without a second expensive scan.
- Preserve cancellation and ensure progress callback failures never change plan correctness.

**Step 3: Render truthful status.**

- Show “Stage N of M” plus the current activity label.
- Render a determinate progress element only for a real byte/item ratio; otherwise use the existing accessible indeterminate treatment and reduced-motion behavior.
- Keep the destination-picker explanation visible while the native picker is open.
- Remove the misleading hard-coded 20%, 60%, 75%, 86%, and 94% presentation.

**Step 4: Run targeted tests.**

```powershell
node --test tests/modpacks/ipc-schemas.test.cjs tests/modpacks/modpack-preflight-progress.test.cjs tests/modpacks/production-planning-adapter.test.cjs tests/modpacks/production-candidate-preparer.test.cjs tests/modpacks/modpack-setup-ui-presentation.test.cjs
```

## Task 4: Establish Windows app identity before the first development window

**Files:**

- Modify: `electron/startup-entry.cjs`
- Modify as needed: `electron/bootstrap/create-main-bootstrap.cjs`
- Modify: `tests/startup-entry.test.cjs`
- Modify as needed: `tests/main-bootstrap.test.cjs`
- Modify as needed: `tests/modpacks/after-pack-icon.test.cjs`

**Step 1: Add a failing ordering test.**

- Use a fake Electron app that records `setName`, `setAppUserModelId`, `whenReady`, and first-window creation.
- Assert `Minecraft Core` and `com.minecraft-core.app` are set before `whenReady()` and before the startup window is constructed on Windows.
- Assert non-Windows startup does not call the Windows-only AppUserModelID API.

**Step 2: Apply shared early identity.**

- Introduce a small idempotent startup identity helper or equivalent logic in `startup-entry.cjs`.
- Apply name and AppUserModelID after any explicit test user-data override but before awaiting readiness.
- Keep bootstrap initialization idempotent so the main bootstrap can safely confirm the same identity later.
- Continue resolving and passing the valid `.ico` to the early and main windows.

**Step 3: Run targeted tests.**

```powershell
node --test tests/startup-entry.test.cjs tests/main-bootstrap.test.cjs tests/modpacks/after-pack-icon.test.cjs
```

## Task 5: Rebuild pinned native artifacts and verify the full feature

**Files:**

- Regenerate: `vendor/archive-worker/x64/ArchiveWorker.exe`
- Modify generated pin: `build-resources/archive-runtime/archive-worker-x64.json`
- Modify: `scripts/verify-packaged-archive.cjs`
- Modify: `tests/modpacks/archive-worker-packaged.test.cjs`
- Modify as needed: end-to-end fixtures under `tests/e2e/fixtures/`

**Step 1: Rebuild and repin ArchiveWorker.**

- Build the Windows x64 worker from the modified native source.
- Copy the exact rebuilt executable to the vendored runtime location using the repository's established build process.
- Update all SHA-256/size pins and packaged verification expectations together.

**Step 2: Run repository verification.**

```powershell
npm run verify:archive-runtime
node --test tests/modpacks/archive-worker-packaged.test.cjs
npm run test:modpacks
npm test
npm run build
npm run pack
npm run verify:packaged-archive
```

**Step 3: Restart and inspect the real Electron UI.**

- Gracefully close the currently open development app before restarting main-process code.
- Launch a fresh development instance and verify startup time remains in the improved range.
- Inspect the Windows taskbar identity/icon from the first visible window.
- Exercise the rendered GitHub release flow through selection, download/inspection, destination selection, truthful preflight progress, and review.

**Step 4: Run disposable end-to-end cases.**

- Use a unique disposable server target, never an existing user instance.
- Validate one exact managed server-pack path and one safe unusual-layout files-only path.
- Validate install/start/health where the selected pack has a supported exact runtime.
- Validate that update/downgrade/switch/repair and release-notification paths still pass their existing real-flow tests.
- Confirm failed/abandoned disposable downloads are cleaned according to the existing retention policy and orderly app shutdown cleanup.
- Preserve logs and test reports needed to explain a failure; delete only exact disposable server/client artifacts after successful validation.

## Task 14: Remove the remaining main-thread filesystem loops

**Files:**

- Modify: `electron/services/modpack-lifecycle/server-directory-identity.cjs`
- Modify: `electron/services/modpack-lifecycle/server-directory-transaction.cjs`
- Modify: `electron/services/modpacks/planning/production-server-snapshot.cjs`
- Modify as needed: `electron/services/modpacks/planning/production-planning-adapter.cjs`
- Modify: focused identity, transaction, planning, and responsiveness tests

**Implementation:**

- Replace synchronous content reads, writes, and per-file flushes with bounded `FileHandle` operations while preserving before/open/after identity checks, no-follow/reparse checks, exact hashes, and cancellation.
- Replace synchronous directory traversal/mutation with awaited operations and cooperative checkpoints. Keep deletion identity-gated and fail closed.
- Move large existing-server preflight hashes to the already-pinned candidate hash worker and emit truthful processed-file/byte activity.
- Add watchdog tests that prove timers and IPC polls advance during large copy, hash, flush, and cleanup operations; make synchronous content methods throw in injected test dependencies.

## Task 15: Make restore points asynchronous and cancellable

**Files:**

- Modify: `electron/utils/backup-util.cjs`
- Modify: `electron/services/modpack-lifecycle/restore-point-service.cjs`
- Modify: `electron/services/modpack-lifecycle/production-mutation-runtime.cjs`
- Modify: focused ZIP runtime and verified restore-point tests

**Implementation:**

- Hash and verify ZIPs through async `FileHandle` reads, retaining the exact pinned descriptor used by the ZIP parser.
- Publish ZIPs and metadata through the async durable filesystem API.
- Thread cancellation and bounded progress through restore-point creation and verification; safely remove only owned partial files.
- Preserve both pre- and post-publication archive validation until the durable identity proof can make a duplicate pass provably unnecessary.

## Task 16: Correct failure settlement and bind new-server resources

**Files:**

- Modify: `electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs`
- Modify as needed: `electron/services/server-mutation-coordinator.cjs`
- Modify: destination reservation, planning, IPC schema, runtime, renderer, and lifecycle tests
- Modify: the real TerraFirmaGreg E2E fixture/spec

**Implementation:**

- Begin settlement in every outer failure path and publish exactly one terminal result after coordinator ownership is released; never swallow a failed terminal CAS or strand `cancelling`.
- Distinguish candidate-only/pre-publication dirtiness from a published live revision so a failed candidate health test cannot be rewritten as `PLAN_STALE` merely because its isolated sibling changed.
- Drive cleanup from the durable transaction/recovery record even when candidate construction throws before returning.
- Add a validated, plan-bound memory choice for new modpack servers. Default it from application server settings, persist it into the new server configuration, and use it for candidate/live health. Do not infer or execute arbitrary publisher scripts. The pinned TerraFirmaGreg test selects 6 GiB explicitly.
- Preserve a bounded, local technical diagnostic for failed candidate boot so the UI can report the actual failing stage without leaking paths or secrets through public IPC.

## Task 17: Finish the audited modpack UX

**Files:**

- Modify: `src/components/modpacks/modpack-ui.css`
- Modify: `src/components/setup/ArchiveGuidedReview.svelte`
- Modify: `src/components/setup/GitHubAssetReview.svelte`
- Modify: `src/components/setup/ServerSetupWizard.svelte`
- Modify: `src/components/modpacks/ModpackJobProgress.svelte`
- Modify: focused presentation and Playwright tests

**Implementation:**

- Replace blue/violet persistent selection fills with neutral surface/border tokens; reserve the accent for primary actions, focus, and transient activity.
- Handle retained-download actions in the new-server wizard exactly as the management page does, including navigation and stale-outcome clearing.
- State that retained downloads are eligible for automatic cleanup after seven days.
- Cover the visible waiting-for-destination, cancelled-picker, and preflight transitions with a delayed native-dialog test and verify computed selected-card colors.

## Task 18: Repeat real gates and final verification from fresh roots

- Rerun the pinned TerraFirmaGreg GitHub server-pack inspection/install/boot test in a new wrapper after Tasks 14-17.
- Run the disposable Modrinth server/client install and loopback join test in a separate new wrapper.
- Run the complete unit, build, packaging, packaged-archive, renderer E2E, startup, and packaged smoke gates from the final source.
- Audit exact wrapper-scoped processes before cleanup. Preserve failed evidence until diagnosed; remove successful wrappers and superseded diagnosed failure wrappers only after exact path/identity validation.

## Self-review rulings

| Area | Ruling | Reason | Cost if wrong |
| --- | --- | --- | --- |
| Existing dirty workspace vs isolated worktree | Continue in the current workspace without creating another worktree. | This is a resumed, uncommitted feature implementation whose dependencies exist only in the current tree; the user explicitly told us to resume it and previously asked to remove the stale client-lag worktree. | A hidden dependency on an unrelated local edit could complicate later integration; full tests and final diff review mitigate this. |
| Commit-oriented subagent workflow vs user-owned changes | Do not create commits during this task. | The working tree contains a large body of ongoing user-visible feature work, and no commit was requested. Reviews will use scoped file lists and reports rather than commit ranges. | Review packaging is less convenient; reviewers must inspect explicit files and test evidence. |
| Universal importer vs arbitrary executable runtime | Support arbitrary safe file layouts through files-only import, but do not auto-execute unknown scripts. | Guessing and executing publisher-specific scripts would turn generic compatibility into unsafe behavior. Exact supported runtimes remain managed/startable. | Some unusual packs require the user to finish runtime setup manually until a generic declarative runtime adapter is added. |
| Windows ChangeTime | Treat ctime as diagnostic metadata, not identity, only when strong object/content evidence matches. | Reproduction proved ctime alone changes under background metadata activity while file ID, size, mtime, birthtime, and SHA-256 remain stable. | A metadata-only event will no longer abort a transaction; actual data/object/path changes remain blocked. |
| Preflight percentage | Remove synthetic overall percentages rather than making them move more often. | More fabricated checkpoints would still misrepresent long extraction/hash work. | Users see an indeterminate indicator during work without measurable totals, but the activity label remains accurate. |
| Publisher launch scripts vs memory hints | Never execute or parse arbitrary publisher scripts as authority; require a validated app-owned memory choice for managed health checks. | Script semantics are not a safe generic configuration contract, while RAM is an app-owned server setting. | A pack may still need a different user-selected value; the failure remains explicit and retryable instead of repository-specific. |
| Candidate dirtiness vs live revision | Candidate sibling writes do not by themselves prove that the live server revision changed. | The real TerraFirmaGreg failure showed a candidate health error being overwritten by coordinator `PLAN_STALE` after only isolated candidate writes. | Incorrect phase tagging could hide an uncertain publication; post-publication identity/journal evidence remains authoritative and recovery-required. |
