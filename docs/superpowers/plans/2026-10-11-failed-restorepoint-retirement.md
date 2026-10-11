# Failed Restorepoint Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclaim an eligible failed precommit attempt's exact archive/sidecar pair promptly, while retaining physical pins until deletion, durable retry evidence, and Repair availability.

**Architecture:** Add a file-only handle-bound native primitive, then registry-owned exact receipts, then exact-pair orchestration, then production callers and separate warnings. Only the live precommit settlement plus final outer-policy boundary mints authorization in version one; startup and recovery-completion callers retry existing authorizations and never infer missing proof. Four sequential reviewable tasks; no collector, daemon, age policy, legacy migration, or optional pre-planning hook.

**Tech Stack:** Existing CommonJS/Electron services, Node test runner, Svelte notification store, Windows x64 .NET 8 ArchiveWorker and its existing durability transport; no new dependency.

**Spec:** [Accepted failed-restorepoint retirement specification](../specs/2026-10-11-failed-restorepoint-retirement.md). Read it and its linked audit/feasibility evidence before execution.

## Global Constraints

- **no intentional retention delay once eligibility is proven**
- **no retention-only admission gate**
- **Unreceipted crash gaps are conservatively deferred in version one.**
- Preserve the existing physical operation pin until its sidecar is deleted.
- Another independent owner/reference prevents authorization and deletion.
- No archive-count, byte, or cleanup-latency bound is claimed.
- Eligible: existing target, authenticated failed terminal history, recovery action `pre-swap-restored`, `swapStep: none`, never started commit/canonical publication; no remaining creation/candidate/writer/recovery obligation.
- Exclude completed and rolled-back operations, new targets, prepared/commit-started attempts, between-renames restoration, divergent-policy variants, and uncertainty. Failed rollback attempts may retire only their newly created safety point, never the selected older point.
- No physical unpin, sidecar rewrite/guard-pin transfer, generic `deleteBackup`, recursive deletion, profile/name scan, ordinary retention coupling, process/policy actions for cleanup, or effective-policy-query subsystem.
- Only generated isolated roots for tests; actual historical pairs, real instances, original profiles, a1 evidence, and all other pre-existing archives are never targets.
- Root reviews this plan and assigns file/test ownership before dispatch. Preserve unrelated work, especially `src/stores/modStore.js`, `tests/ignored-mod-updates-renderer.test.cjs`, and `migration-review-2026-10-07.md`. No staging/commit is requested. Do not run broad native containment/profile tests or use `scripts/build-archive-worker.ps1` as a shortcut (it has broader packaging/self-test effects).
- Coordinate Task 4 bootstrap and notification files with the current startup/renderer owners before editing; planning itself changes documentation only.

## Review Focus

- A native response lost after disposition must not let a replacement leaf be deleted or release serialization before confirmed worker close (Task 1).
- A plausible failed history plus defaulted/cached policy state must not mint restart authorization; even a crash after actual policy success but before receipt remains deferred (Tasks 2 and 4).
- A point owned by a history entry beyond the first page, a claimed plan, or a newly added pin must survive (Tasks 2 and 3).
- A gone archive plus pinned surviving sidecar must remain a visible partial obligation across progress-write/flush crashes; ordinary retention cannot take over (Task 3).
- Retention errors must not hide warnings, change the primary failed/cancelled outcome, or block another safe Repair; maintenance changes must invalidate stale planning evidence (Task 4).

---

## Shared contracts and finite limits

All types below are internal, not renderer IPC. Strict objects reject unknown/missing keys, accessors, symbols, non-plain prototypes, unsafe paths, duplicate JSON keys, invalid hashes/numbers, and over-limit input. New schema optional state is represented by explicit `null`, not omitted properties; the reused ObjectIdentity directory `sha256` omission below is an explicit compatibility exception. Existing validated recovery IDs, Windows basenames, canonical target paths, runtime tuples and timestamp validators remain authoritative.

- `Selector = { instanceId: string, serverPath: string }`; `Target = { kind: 'existing', stableServerId: string, path: string }`.
- `Binding = { expectedTarget: Target, expectedOperationKind: RecoveryOperationKind }`, using the registry's existing operation enum and production operation mapping.
- `ObjectIdentity` is the existing durability DTO: `{ fileType, dev, ino, size, birthtime, mtime, ctime, sha256? }`. Decimal strings remain strings. Directory equality compares only `fileType/dev/ino/birthtime`, preserving existing directory identity semantics: directory size/mtime/ctime changes do not invalidate the same directory, and directory SHA-256 remains omitted (not null). File equality additionally requires authorized size, mtime and SHA-256; retain existing ctime-drift policy. Preserve supported non-name-surrogate reparse policy and revalidate it on the same handle. Regular-file type and single-link checks are mandatory additional deletion checks.
- `CandidateV1 = { schemaVersion: 1, id, name, metadataName, sha256, size, totalBytes, scopeSha256, sourceRevision, sourceRuntime, operationId, createdAt }`. This is exactly the existing restorepoint reference's immutable fields, without absolute paths or pinId, plus `metadataName = name.replace(/\.zip$/, '.json')`. Reuse existing restore-name grammar, point/reference validation, positive safe integer `size`, nonnegative safe integer `sourceRevision`, decimal `totalBytes`, normalized runtime/null, ISO timestamp, and lowercase 64-hex hashes. Bind target from the registry record, not candidate input. Creator `operationId` must equal failed job.
- `PublishedEvidence = { record, recordSha256, envelope, envelopeSha256 }`: hashes of actual bounded on-disk bytes; both files must be fully in history, no active duplicate/split; verify envelope binding and exact record identity. Not the permissive `loadHistory` result.
- `RetirementResult = { status: 'reclaimed' | 'deferred' | 'not-eligible', jobId, reason: Reason | null, progress: Progress | null, archiveBytesReclaimed: string }`. `archiveBytesReclaimed` is the confirmed cumulative authorized archive size only once archive deletion is durably reconciled, otherwise `'0'`; it is not a global storage estimate.
- `Reason = 'missing-final-policy-proof' | 'independent-owner' | 'reference-proof-incomplete' | 'target-busy' | 'target-running' | 'recovery-pending' | 'identity-mismatch' | 'unsupported-native' | 'io-failure' | 'publication-incomplete' | 'writer-unproven' | 'receipt-conflict' | 'invalid-evidence'`.
- `Progress = 'authorized' | 'deleting' | 'archive-deleted' | 'deleted'`. Monotonic; diagnostics never reset it.

**Reference identity rule (all owner checks):** a restorepoint is target-scoped and identified by its point ID; SHA-256 constrains its bytes, not its object identity. A well-formed reference on the same authenticated target with the same ID and digest is an independent owner. Same ID with missing/conflicting digest or conflicting locator is ambiguous evidence and defers, never an excuse to delete. A well-formed different-ID reference does not own the candidate merely because its digest is equal. Missing/partial ID/digest pairs, malformed references, uncertain target binding and duplicate-ID conflicting records fail closed; history entries with neither restore field have no point reference. Where evidence contains a full locator/identity, also compare its canonical archive/sidecar names or held file identity: the same physical file/path is protective even if the claimed IDs disagree (that conflict is invalid evidence). Reuse exact candidate/sidecar/native single-link/lineage verification; no discovery scan or digest-based deduplication. Independently pinned metadata on the candidate still protects it, regardless of the owner query.

Source basis: RestorePointService generates a timestamp/random-token filename and `restore-<token>` ID, but stores `verified.sha256` from ZIP bytes; createVerifiedZip receives source items/partPath, not the point ID. resolveRestorePoint matches serverPath + id + sha256, not sha256 alone; completed listings additionally bind creator/revision/runtime. Thus two distinct valid single-linked archive files with different IDs/names may contain identical bytes without either owning the other. This does not certify any observed historical pair.

Receipt schema (at most **64 KiB**, exact keys at every level):

```text
ReceiptV1 = {
  schemaVersion: 1, policyVersion: 1, sequence: nonnegative-safe-integer,
  jobId, operationKind, target: Target, candidate: CandidateV1,
  terminal: { recordSha256, envelopeSha256, targetPathHash, envelopeChecksum },
  lineage: { parent: DirectoryIdentity, target: DirectoryIdentity, backups: DirectoryIdentity },
  files: { archive: FileIdentity, sidecar: FileIdentity },
  pinOwner: jobId,
  settlement: { caller: 'live-precommit-final-policy', action: 'pre-swap-restored',
                swapStep: 'none', commitStarted: false, policyRestored: true },
  progress: Progress,
  durability: { archive: 'not-started'|'intent'|'durable',
                sidecar: 'not-started'|'intent'|'durable' },
  diagnostic: null | { reason: Reason, at: ISO-timestamp },
  lastAttemptAt: null | ISO-timestamp,
  createdAt: ISO-timestamp, updatedAt: ISO-timestamp
}
```

`DirectoryIdentity/FileIdentity` mean `ObjectIdentity` with the respective fileType. Sidecar identity includes its unchanged byte digest. Exact parent is `dirname(target.path)`; backups is exactly `target.path/backups`; both leaves are derived from candidate basenames. No receipt-supplied alternate root/path/options. Use a dedicated retirement durable-fs instance configured only for the authorized target's parent (not the runtime's unrelated roots). The native allowed-root identity is that parent; carry the target as an expected ancestor and backups as expected file parent, so target substitution is checked on held native handles, not just in JS. Sequence CAS and immutable-field comparison reject retargeting, decreasing progress, digest/identity replacement, and contradictory durability states. `authorized` has both not-started; `deleting` has archive intent and sidecar not-started; `archive-deleted` has archive durable and sidecar not-started/intent; `deleted` has both durable. Persist sidecar intent before its effect. Absent files reconcile only when that file's intent was durable beforehand.

Finite pass policy: partition registry-derived items before selecting work. Post-ready startup has a protected budget of **16 authorized-retry receipts + 4 notice-only items = 20 total**; recovery completion has **4 authorized-retry receipts + 2 notice-only items = 6 total** for its exact selector. One attempt/upsert per selected item, sequentially; no budget borrowing, automatic continuation, timer, daemon or general queue. Deferred-proof and reclaimed items only use the notice budget and can never consume an authorized retry slot. An authorized receipt's result/warning update belongs to its retry slot, not a second notice slot. Live hook handles only its own point.

Authorized retry order is deterministic: never-attempted receipts (`lastAttemptAt: null`) first, ordered by `createdAt, jobId`; then previously attempted receipts ordered oldest `lastAttemptAt, createdAt, jobId` first. Before each selected attempt, CAS-persist a new `lastAttemptAt` and sequence/update timestamp in that exact receipt; no source lease is required for this registry-only write. Choose `attemptAt = max(clock milliseconds, this receipt's createdAt milliseconds, 1 + maximum persisted lastAttemptAt milliseconds in the authenticated inventory)`, taking the maximum over an empty attempt set as -1, with valid ISO range checking, so equal ticks/clock rollback do not reset ordering. Persist this timestamp for live attempts too. Receipt transition validation permits null-to-timestamp then nondecreasing lastAttemptAt only; it rejects clearing/backdating that field and requires updatedAt >= lastAttemptAt. Refresh the inventory after each successful CAS. After any deferred attempt (including busy/running admission refusal), CAS-persist its diagnostic with the same attempt timestamp where possible; never reset authorization/progress. A CAS conflict reloads once and defers that selected slot, not an immediate retry. If fairness/diagnostic persistence fails, retain the obligation and use the current invocation's in-memory timestamp without promising restart fairness; persistent I/O failure remains an explicit indeterminate-retention caveat. Restart reloads receipt timestamps, not a job-ID cursor, so successfully stamped busy items rotate behind unattempted/older pending receipts.

Notice-only work is independently selected by `createdAt, jobId`, using a bounded in-memory rotation cursor; losing that cursor on restart cannot starve authorized work. Reuse the existing registry metadata inventory; no repeated initialize per point or server/profile traversal. Return `PassResult = { considered, retryConsidered, noticeConsidered, results, remaining }`; considered is their sum, results has one RetirementResult per considered item, and remaining counts known unprocessed items, not a cleanup guarantee. Stop before selecting a new item when closing.

Local reference proof reads **200** history items/page, at most **50** pages/point/check; only EOF proves absence. Repeated cursor, malformed result, errors, or 10,000-item cap with a non-null cursor defer with reference-proof-incomplete; never treat the cap as no references.

## Task 1: Exact native file deletion boundary

**Files:**

- Modify: `electron/utils/durable-fs.cjs`, `electron/utils/windows-durable-fs-client.cjs`.
- Modify: `native/ArchiveWorker/Durability/DurableFilesystem.cs`, `native/ArchiveWorker/Durability/DurabilityRetryPolicy.cs`, `native/ArchiveWorker/Protocol/WorkerDtos.cs`, `native/ArchiveWorker/Program.cs`, `native/ArchiveWorker/Sandbox/NativeMethods.cs`.
- Test: `tests/durable-fs.test.cjs`, `tests/windows-durable-fs-async.test.cjs`.
- Create focused native fixture: `native/ArchiveWorker.RecoveryTests/ExactDeleteTests.cs`; modify that project's `Program.cs` to dispatch `--exact-delete-only` before any existing tests. Existing project links production durability files, so do not create another native application.

**Interfaces:**

- Produces `durableFs.deleteFileExactAsync(filePath, { expectedFileIdentity, expectedParentIdentity, expectedAllowedRootIdentities, expectedAncestorIdentities, mode }) -> Promise<{ deleted: true, durable: true }>`, both factory and configured facade exports.
- Client method has the same name/signature. Required mode is `'delete' | 'reconcile-absent'`. The latter must refuse any present leaf and only flush/confirm the authenticated absent name; it can never delete. Required ancestor identities: ordered array of exact `{ path, identity }`, maximum **32**, all configured root-to-file-parent intermediate directories, no omissions/extras/duplicates. Required root identities: array of exact `{ path, identity }` for configured roots, maximum existing **16**. No defaults that adopt a current occupant; every supplied expectation must match before request.
- Request operation `'delete-file-exact'`: exactly `operation, sourcePath, sourceIdentity, sourceParentIdentity, allowedRoots, allowedRootIdentities, ancestorIdentities, mode`; reject all move/directory-batch/destination fields, even mixed legitimate fields. Strict existing DTO deserialization plus operation-specific validation.
- Capability `deleteFileExactFlushesParent: true` is an own enumerable frozen capability; production requires it. No synchronous or pathname fallback on any platform.
- For this operation only, success frame `{ ok: true, deletion: 'durable' }`; failure frame `{ ok: false, failureKind, failureStage, effectState: 'none' | 'uncertain' }`. Old operations keep their old strict shapes. JS error adds `durableEffectState` alongside existing kind/stage. Unknown/missing/mixed fields fail closed.
- Add failure stages `'handle-disposition'`, `'delete-close'`, `'delete-parent-flush'`. All are post-effect/uncertain and nonretryable. Existing opening/revalidation stages may retry sharing failures using current **50/150/400/800 ms** schedule only; request identity is unchanged.

- [ ] **Step 1: Write failing JS transport/facade tests and focused native fixtures.**

  Tests named `exact delete requires original identities and strict capability`, `delete response waits for confirmed worker close`, and `post-effect delete failures never retry` assert: no spawn with missing hash/root/parent, no `unlink/rm` fallback, strict success/failure frames, timeout/lost response cannot resolve while worker is alive, and at most one disposition after any effect. Native fixture methods `ExactDeleteRegularFile`, `SubstitutionBeforeOpen`, `SubstitutionAfterOpenDenied`, `RejectDirectoryHardlinkAndRedirect`, `SharingConflictBeforeEffect`, `CrashAtDispositionCloseFlush` assert only the authorized fixture leaf disappears, expected digest/size/birthtime/mtime/type/link mismatch leaves it untouched, same bytes/new identity is rejected, supported nonredirecting reparse policy remains unchanged, and parent flush precedes durable success. Use internal injected test seams for stages, not a production IPC path/flag that bypasses validation.

- [ ] **Step 2: Run focused JS red tests; compile/run the exact-only native mode after adding its fixture dispatcher.**

  `node --test tests/durable-fs.test.cjs tests/windows-durable-fs-async.test.cjs`

  `dotnet run --project native/ArchiveWorker.RecoveryTests/ArchiveWorker.RecoveryTests.csproj --configuration Release -- --exact-delete-only`

  Expected red: missing exact-delete method/protocol, not missing SDK/fixture contamination. Windows x64 with .NET 8 SDK is required. Native fixture creates a GUID-named temporary root itself, verifies it is newly created, asserts every write target stays inside it, and only removes validated generated files/root. No user-supplied server path. Missing prerequisite is a reported verification gap, not permission to weaken deletion.

- [ ] **Step 3: Implement the strict transport and held-handle deletion.**

  Reuse `DurableRootPins`, `DurableAncestorPins`, `DurablePinnedObject`; open leaf with DELETE/read rights while denying write/delete sharing. Verify regular file attributes and `NumberOfLinks == 1` on that held handle, authorized identity/hash/path/reparse policy, then apply handle disposition via `SetFileInformationByHandle`. Compare all receipt-derived expected ancestor identities while held; keep ancestors pinned through leaf close and parent flush. In reconcile-absent mode prove absence under those same pins, refuse a present replacement, flush the exact parent and return durable completion without opening a leaf for deletion. Mark effect uncertainty before calling disposition. Close the held leaf, verify the original name is absent without touching any replacement, and flush the pinned parent before success. If absence cannot be confirmed, report uncertainty. Existing worker-close confirmation remains mandatory even after response/error/timeout; an unproven live worker never yields a settled retention result.

- [ ] **Step 4: Run the same JS/native commands green and add serialization regression.**

  Expected: all relevant tests pass; native prints `exact-delete-only: passed`, exit 0, no skips on Windows x64. Test that another cooperating mutation cannot begin during unconfirmed close, and that reconciliation sees a substituted leaf and preserves it. Run `node --test tests/windows-durable-fs-verifier-reuse.test.cjs` for transport reuse. Review exact-delete diff independently before Task 3 can consume it. Do not build/update vendored executables/manifests in this task.

## Task 2: Durable candidate, terminal proof, receipt and reference authority

**Files:**

- Create: `electron/services/modpack-lifecycle/failed-restorepoint-retirement-evidence.cjs` (strict DTO validation only).
- Modify: `electron/services/modpack-lifecycle/recovery-registry.cjs`, `electron/services/modpack-lifecycle/production-mutation-runtime.cjs`, `electron/services/modpack-lifecycle/plan-registry.cjs`.
- Test: `tests/modpacks/recovery-registry.test.cjs`, `tests/modpacks/plan-registry.test.cjs`, `tests/modpacks/production-mutation-runtime.test.cjs`.

**Interfaces:**

- Evidence module exports `normalizeRetirementCandidate(value) -> CandidateV1`, `normalizeRetirementReceipt(value) -> ReceiptV1`, `assertRetirementReceiptTransition(previous, next) -> void`.
- Registry adds `loadPublishedTerminalEvidence(jobId, binding) -> Promise<PublishedEvidence>`; read-only, fails on incomplete publication, never completes a rename as a side effect.
- Registry adds `loadRestorePointRetirement(jobId) -> Promise<null | { value: ReceiptV1, sha256: string }>` and `writeRestorePointRetirement(jobId, { expectedSha256: string | null, value: ReceiptV1 }) -> Promise<{ value: ReceiptV1, sha256: string }>`; null expectation means create-only. Revalidate terminal binding/digests for receipt writes, not merely schema validity. Protected in-process CAS serialization and existing durable JSON expected-hash semantics.
- Registry adds `listRestorePointRetirementItems({ selector: Selector | null }) -> ReadonlyArray<{ jobId, selector, state: 'authorized-retry' | 'deferred-proof' | 'reclaimed', createdAt: string, lastAttemptAt: string | null }>` from its latest initialized authenticated metadata inventory, plus live receipt/candidate updates. Extend `initialize()` result with `pendingRestorePointRetirements` (only the first two states); collect before already-published skip. The list method also includes deleted receipts for warning reconciliation; reclaimed/deferred-proof items consume only the separate notice budget and never invoke server/native mutation. Each item carries exact createdAt and lastAttemptAt (null for unreceipted items), loaded from authenticated evidence for deterministic partition/order.
- Registry adds `hasOtherActiveRestorePointReference({ target: Target, candidate: CandidateV1, excludingJobId }) -> Promise<boolean>`; applies the shared reference identity rule to its active/pending inventory and bound records (including any exact candidate locator), fails closed on uncertain/corrupt evidence for the target. Unknown global binding means incomplete proof, not clear.
- PlanRegistry adds `hasRestorePointReference({ instanceId, candidate: CandidateV1, excludingJobId }) -> boolean`. Retain claimed private plans in a map until successful `releaseClaim`, in addition to reviewed plans; unknown/malformed matching-target plans throw. Check every `plan.restorePoints` entry using the shared reference identity rule, including claimed downgrade/rollback plans. Different valid IDs sharing a digest are not a match; matching IDs or any known same-physical-file locator conflict remain protective/ambiguous as specified. Do not expire/delete a plan as a side effect of this query. Excluding failed job applies only to its own newly created locator, never its selected older point.

- [ ] **Step 1: Add red schema, publication, ownership, and candidate-preservation tests.**

  Assert unknown receipt fields, unsafe basename, wrong creator/job/target, mismatching terminal digests, nonmonotonic sequence/progress, forged replacement identity, oversize/duplicate JSON, wrong schema and CAS conflict all reject with no file changes. Table-test active-only, record/envelope split, duplicate active/history, and fully published cases. `initialize marks unreceipted failed candidate deferred-proof` must not call source/native services; completed markers and legacy no-locator records never authorize. `claimed rollback plan protects selected point after claim removes reviewed plan` proves the new claimed map. Add `different point IDs with equal digest are not ownership` across valid history/active-record/reviewed-and-claimed-plan references, plus same-ID/wrong-digest, partial reference and known same-path/different-ID cases that defer. Preserve all terminal bytes through receipt creation/retry.

- [ ] **Step 2: Run focused red tests.**

  `node --test tests/modpacks/recovery-registry.test.cjs tests/modpacks/plan-registry.test.cjs tests/modpacks/production-mutation-runtime.test.cjs`

  Expected red: missing candidate/receipt/query contracts.

- [ ] **Step 3: Implement evidence persistence and read-only reference queries.**

  Create and pin `modpack-lifecycle/retirements` beside active/history; exact filename `<jobId>.json`, only existing job-ID grammar, bounded reads and durable create/CAS. Do not place retirement filenames in active/history. Validate the optional outcome candidate with strict CandidateV1 schema and bind it to the record; write it in the same snapshotting transition as `restorePoint` while the exact creation reference exists. Preserve the candidate across all subsequent outcome merges/transitions; reject removal/replacement once set, including finish. Legacy absence stays valid and nonretirable. Do not change immutable terminal records to erase references. Corrupt retirement metadata defers retention and warns, not a new source-recovery block; retain existing safety behavior for corruption of active recovery evidence.

- [ ] **Step 4: Run green tests plus registry publication regression.**

  Same command, then `node --test tests/modpacks/operation-recovery-reconciliation.test.cjs`. Expected: existing metadata-only retry never calls deletion or mints receipts; current full publication proof rejects what permissive `loadHistory` accepts. Review the exact DTO and state machine before Task 3. No server-file deletion in this task.

## Task 3: Exact pair orchestration with pins retained

**Files:**

- Create: `electron/services/modpack-lifecycle/failed-restorepoint-retirement.cjs`.
- Modify: `electron/services/modpack-lifecycle/restore-point-service.cjs`.
- Create: `tests/modpacks/failed-restorepoint-retirement.test.cjs`.
- Test: `tests/modpacks/verified-restore-point.test.cjs`.

**Interfaces:**

- `new FailedRestorePointRetirement({ registry, coordinator, planRegistry, stateRepository, restorePointServiceFor, verifyLiveProof, assertTargetAvailable, clock, randomUUID })`. `restorePointServiceFor(selector)` returns the existing target-bound service. `verifyLiveProof(proof, { jobId, selector, lease }) -> boolean` is the runtime-owned in-memory validator from Task 4; no plain object/renderer boolean is sufficient. `assertTargetAvailable(selector, lease) -> Promise<void>` reuses existing cooperating-runtime/writer safety checks without policy/process mutation; throws classified defer or writer-unproven.
- `retireLive({ jobId, binding, selector, lease, finalPolicyProof }) -> Promise<RetirementResult>`.
- `retryPass({ trigger: 'startup' | 'recovery-completed', selector: Selector | null }) -> Promise<PassResult>`; startup requires null selector, recovery-completed requires exact selector. PassResult counts are nonnegative safe integers, results is RetirementResult[], and limits above are constants, not caller-controlled. Add `close() -> Promise<void>`: synchronously reject new live/pass work with INVALID_REQUEST, stop before the next unstarted item, and drain active work through confirmed worker close/required effect bookkeeping before resolving. No generic cancellation signal may abandon a sent native mutation.
- `RestorePointService.withExactRetirementPoint(candidate, { authority, receipt, recheckReferences }, work) -> Promise<RetirementResult>` owns the one backup lock and offers `work(session)` only after validation. `authority = { lease, operationId, selector, coordinator }` remains internal/trusted composition data; session methods reassert the real ambient lease.
- Session methods: `captureAuthorization() -> Promise<{ lineage, files, pinOwner }>`, `deleteArchive(receipt) -> Promise<void>`, `deleteSidecar(receipt) -> Promise<void>`, `reconcileAbsent(file: 'archive'|'sidecar', receipt) -> Promise<boolean>`. Session is closure-branded, invalid after callback, never returned/exposed to renderer. Receipt creation/progress writes belong to helper and run inside this lock. `recheckReferences() -> Promise<void>` is invoked immediately before each native effect and absence reconciliation; return only on complete negative proof.

- [ ] **Step 1: Write red exact-pair and bounded-proof tests using generated temp fixtures.**

  Assert event order `lease -> backup-lock -> full evidence/reference proof -> authorized receipt -> deleting intent -> native archive delete/flush -> archive-deleted receipt -> sidecar intent -> native sidecar delete/flush -> deleted receipt`. Pin bytes must remain byte-identical until sidecar disappears. Fail if pending-point discovery, unpin, generic deletion, process control, or policy APIs are called. Table-test all spec exclusions; missing point returns not-eligible without filesystem discovery.

  Add `more than 16 old reclaimed notices cannot starve a new eligible receipt`: seed 40 older reclaimed items, 8 deferred-proof candidates and one newly authorized eligible receipt; startup must attempt/reclaim that receipt, process at most 4 notice-only items, and report retryConsidered=1, noticeConsidered<=4, considered<=20. Add `busy receipts rotate across restart`: seed 20 authorized receipts, first 16 busy and last 4 eligible, plus older unreceipted candidates; pass one stamps/defer the 16 busy receipts, recreate the helper/registry with identical or earlier injected clock, and pass two attempts the 4 unattempted eligible receipts before reattempting busy ones. Assert preserved timestamps/diagnostics, no source writes for busy admission refusal, and fixed recovery bounds 4+2=6. CAS/timestamp-write failures must retain material, remain bounded, and make no false fairness guarantee.

  Add `separate same-byte archive does not retain failed duplicate`: create two distinct single-linked files with identical valid ZIP bytes and distinct valid point IDs/names/sidecars/creators in a generated root. Put the older point in completed local history and a reviewed/claimed rollback plan, retire only the eligible failed point, and assert older archive/sidecar bytes, identities and pins are unchanged and its exact reference remains resolvable. Change that owner reference to the failed point's ID/digest and assert no deletion. Add same-ID/conflicting digest, partial-ID/hash, full same-path/different-ID and hardlink variants; all defer, and no pathname fallback/discovery occurs.

  Add `history page two owns point`, `history proof cap is not absence`, `repeated cursor defers`, `concurrent independent pin before sidecar deletion preserves sidecar`, `wrong nonambient expired maintenance lease`, `replacement with identical bytes survives`, `archive absent without durable intent is not success`, and `receipt CAS conflict prevents next effect`. Crash-inject before/after every intent/effect/close/flush/progress-write boundary. Check complete-pair versus partial result, actual archive byte count, and immutable history.

- [ ] **Step 2: Run focused red tests.**

  `node --test tests/modpacks/failed-restorepoint-retirement.test.cjs tests/modpacks/verified-restore-point.test.cjs`

  Expected red: missing helper/exact-only methods.

- [ ] **Step 3: Implement eligibility, locked orchestration, and bounded retry.**

  Authenticate live proof and published evidence independently; require spec's narrow predicate, original/rollback identity equality, no failed sibling, no unresolved writer/candidate/creation/commit/publication state, and exactly the creating failed job's pin (no additional owners). Read all local history pages through `stateRepository.listHistory(serverPath, { cursor, limit: 200 })`; apply the shared target/point-ID plus integrity-digest identity rule regardless of history outcome, not a digest-only match. Recheck registry, reviewed/claimed plans and physical pins before every effect. Unknown/malformed evidence is deferral.

  Capture exact unchanged pair and lineage without `resolveRestorePoint`, `#recoverPendingRestorePointsLocked`, or directory sidecar enumeration. Require existing creation-derived exact naming and valid metadata; ambiguous/corrupt exact sidecar or alternate pending counterpart causes deferral, not cleanup. Under the original live lease, read-only exact capture may durably authorize a proved pair even when final policy restored a running original; running status defers all pair mutation, not receipt persistence. Invoke `assertTargetAvailable` before every effect/reconciliation. Receipt must exist durably before deletion. Archive first, then sidecar, with intent and parent flush confirmation as specified. Missing authorized leaf requires matching prior per-file intent, current lineage and native `mode: 'reconcile-absent'` with the original expectations; never use ordinary flushDirectoryAsync's recaptured parent as sufficient proof, and never adopt a replacement. Retain full pair/partial sidecar on all ordinary failures.

  For retry, use `coordinator.runMutation(selector, { operation: 'failed-restorepoint-retirement', operationId: 'retire-' + randomUUID(), revisionMode: 'auto' }, async lease => ...)` with no quiesce/signal inherited from cancelled job. Assert current maintenance operation ID, separately bind retired job in receipt. Mark lease dirty before first potential server-file effect (also absence reconciliation when prior effect may have occurred). Catch ordinary deletion/receipt errors inside callback into deferred result, so successful coordinator finalization advances content revision once when dirty. Busy/running/recovery admission errors map to defer; an unproven live deleter must not settle/release.

- [ ] **Step 4: Run green tests and native-boundary integration fixture.**

  Same command plus `node --test tests/server-mutation-coordinator.test.cjs` and Task 1 exact-only native command. Tests assert no nested backup lock or nested coordinator mutation, generic ordinary cleaner refuses the pinned full/partial pair, a new independent owner prevents the next effect, and pass calls stop at 16+4=20 / 4+2=6 with protected retry budgets and remaining obligations intact. No claim that those limits bound storage or elapsed time. Review before production wiring.

## Task 4: Live caller authority, retry composition, warning persistence, availability

**Files:**

- Modify: `electron/services/modpack-lifecycle/production-mutation-runtime.cjs`, `electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs`.
- Modify after owner handoff: `electron/main.cjs` (minimal readiness adapter only), `electron/bootstrap/create-modpack-service-graph.cjs`, `electron/bootstrap/create-production-modpack-composition.cjs`.
- Modify: `electron/services/modpacks/notifications/notification-store.cjs`, `src/stores/modpackNotificationStore.js`; create `electron/services/modpack-lifecycle/failed-restorepoint-retirement-warning.cjs`.
- Modify: `docs/superpowers/specs/2026-08-01-modpack-lifecycle-design.md` only for the accepted failed-registry-history exception and pin-preserving best-effort policy.
- Create: `tests/modpacks/failed-restorepoint-retirement-production.test.cjs`.
- Extend: `tests/main-bootstrap.test.cjs`, `tests/startup-window.test.cjs`, `tests/orderly-quit-barrier.test.cjs`, `tests/modpacks/service-graph.test.cjs`, `tests/modpacks/startup-recovery-order.test.cjs`, `tests/modpacks/operation-recovery-reconciliation.test.cjs`, `tests/modpacks/notification-store.test.cjs`, `tests/modpacks/modpack-notification-presentation.test.cjs`, `tests/modpacks/modpack-notification-component.test.cjs`.

**Interfaces:**

- Runtime adds `retireFailedRestorePoint({ jobId, plan, resolved, lease }) -> Promise<RetirementResult>`. Existing `abandonCandidate` and `restorePriorState` remain compatible; latter additionally accepts/validates passed `lease` for retirement provenance.
- Runtime keeps private `WeakMap<lease, Map<jobId, settlementProof>>` independent of `contexts` (abandon currently deletes context). Only successful narrow abandonment followed by successful final required policy return under that same ambient lease creates proof; `restored: true` and bound token/job/target are mandatory. No token/new-server shortcut is authorization. Cached successful policy return may satisfy the live boundary only for same bound operation and setting. Exclude `plan.operation.kind === 'uninstall' && plan.ownership.confirmation.possibleNonRunnable === true` before proof creation. Retire consumes proof once and clears it; new receipt retries use durable receipt, not replayed proof.
- Helper's `verifyLiveProof` is a closure wired by this runtime, checking object identity against that private map, job/selector/lease binding, and current coordinator authority. Only this runtime invokes `retireLive`; composition owns all `retryPass` invocations and their shutdown drain.
- Main supplies `startup.waitForWindowNavigationReady(window) -> Promise<boolean>`: combine its existing pre-registered ready-to-show tracker with the existing loadRendererContent promise; true only for `status: 'loaded'` and a nondestroyed window, false on diagnostic/failure/close. Preserve the captured window reference rather than mutable global win. Missing adapter skips startup retirement, never substitutes true; tests explicitly inject readiness. No polling, added timeout, or changes to renderer loading/auto-start policy.
- Composition adds `armStartupRetirement(ready: Promise<boolean>) -> boolean`, one-shot, called by service-graph afterWindowCreated without awaiting ready or the pass. It owns a readiness continuation and one cancellable `setImmediate` dispatch after true readiness (one event-loop yield, not a recurring scheduler); initial/recreated windows cannot arm duplicate startup passes. False readiness/closing skips the pass.
- Composition owns `retirementClosing`, at most one active pass promise, and the optional one-shot dispatch handle. Concurrent triggers while a pass is active do not queue another pass; preserve their receipts for a later existing opportunity. Existing onResolved uses this same owned entry, after claim/lease/block release, without changing its source-reconciliation result. Dispose sets closing synchronously, cancels an unstarted dispatch, makes pending readiness continuation a no-op, calls helper.close(), and drains the active pass before disposing plan/reference/workspace/native dependencies. No new pass on close or deadline race; unresolved native close keeps disposal pending, not rejected or falsely settled. An unresolved readiness promise itself need not drain because it cannot mutate after closing.
- Warning publisher `publishRetirementWarning({ jobId, serverId, result }) -> Promise<void>` maps strict results (reclaimed -> reclaimed; deferred plus archive-deleted -> partial; deferred with missing-final-policy-proof -> deferred-proof; other deferred -> retained; not-eligible -> no notice) to notification-store method `upsertRetirementNotice({ jobId, serverId, state: 'retained'|'partial'|'deferred-proof'|'reclaimed', reason: Reason | null }) -> Promise<NotificationDTO>`.
- Notification type `'retention-warning'`, dedupe key `'retirement:' + jobId`, source `{ provider: 'local', sourceId: 'failed-backup-retirement' }`, release/action null. Reuse existing strict durable store/CAS and bounded capacity. One notification per job, update same ID; unchanged state/reason preserves read/timestamp, material unresolved change sets unread, reclaimed replaces message and marks read. Not a new job outcome or recovery record.

**Current caller proof (rechecked 11 October):**

- Lifecycle `#settleFailure`'s `!state.commitStarted` branch awaits `abandonCandidate`, separately awaits `restorePriorState`, then releases claim (currently around lines 1849–1873). Both exceptions become cleanupError. Hook is only between policy success and release, when actual abandonment succeeded, required policy succeeded, runtime writers are proved, and no cleanupError. Never infer these from `cleanupPending: false`.
- Production `abandonCandidate` calls `recoverWithLease`, proves closure, and deletes `contexts`; `restorePriorState` returns cached token restoration or policy result. Hence private lease-bound proof, not context lookup or a caller-supplied boolean.
- Registry already-published skip currently bypasses failed histories; Task 2 inventory is the startup source of obligations.
- Service graph establishes startup recovery boundary before production composition initialization; composition initializes stores then reconciles operation presentation. Initialization only prepares metadata/helper; never await or start archive proof/deletion there. Current afterWindowCreated follows window construction, but main starts loadRendererContent fire-and-forget, so that hook alone does not prove navigation-ready. Arm the owned pass there using the main readiness adapter; run only after recovery/reconciliation AND successful main-window ready/navigation boundaries. Main bootstrap onReady/startApplicationAfterReady never await retirement. Preserve existing ready-to-show/start-minimized behavior; the app can be used during housekeeping.
- Composition's existing cachePrunePromise and beginCleanup/disposePromise illustrate owned asynchronous cleanup, but its prune timeout/fresh-on-close pass is explicitly unsuitable here. Drain retirement before planRegistry.dispose or shared resource disposal; existing orderly-quit barrier must stay pending while a native deleter remains unproven. No retirement timeout may settle/reject disposal early (the current quit barrier quits even after a disposal rejection).
- Recovery facade awaits raw recovery method before `onResolved`; composition reconciles presentation and releases claim there. Invoke exact-target retry after claim release and underlying recovery lease/block release; do not return its ordinary deferred result as failed source reconciliation.
- **No actual source-recovery minting caller in v1.** `ModpackRecoveryService.#finish`, stopped-original recovery, general source recovery, and metadata-only retry remain unchanged. Their unreceipted eligible candidates are deferred-proof. `onResolved` may only retry an already-authorized receipt; a metadata-only recovery result cannot mint one.

- [ ] **Step 1: Write red production-caller, warning and availability regressions.**

  Use real lifecycle/runtime/composition classes with injected synthetic recovery/archive/runtime authorities and generated roots, not only direct helper mocks. Repeat **three** eligible failed/cancelled staging attempts with ordinary retention disabled; assert each actual live hook deletes its own archive bytes and sidecar, leaves history readable, and never offers review-restore-point. Spy on exact caller ordering and same ambient lease.

  Table-test abandonment throws, policy throws/returns restored false, missing token, prepared/commitStarted, divergent uninstall, new/completed/rollback disposition, worker unproven and independent owner: no authorization/deletion. Crash after outer policy return before receipt => after restart deferred-proof, regardless of cached/defaulted config. Actual startup and facade onResolved tests count bounded helper calls and verify no automatic source recovery/no fabricated recovery block/no process or policy calls for cleanup.

  Add `held retirement cannot delay window-ready`: hold a synthetic archive/native promise, resolve main ready plus navigation-loaded, and assert initialize, afterWindowCreated, bootstrap onReady and startup-window closure settle while retirement remains pending; no pass before both ready/load or for diagnostic page, and repeated afterWindowCreated arms once. Add `closing drains held native retirement`: dispose before readiness/dispatch starts no mutation, rejects new passes and does not wait on readiness; dispose during an effect stays pending with lease held and dependencies intact until confirmed worker close, then drains once, releases authority and permits orderly quit. Assert no next item/queued pass starts after closing, no timeout bypass, and background ordinary failure is caught/reported rather than unhandled. Run with injected deferred promises/immediate dispatch, no wall-clock timings.

  `retention failure permits next safe Repair` asserts failed/cancelled primary outcome and cleanupPending retain source semantics, while warning is durable; subsequent safe attempt is admitted subject only to normal safety/capacity checks. `maintenance retires before reviewed plan execution` asserts dirty auto lease increments revision and reviewed plan is PLAN_STALE; no old source fingerprint proceeds. Live-hook deletion remains inside the failed original lifecycle lease and its existing revision-finalization semantics; tests prove the next attempt captures a fresh source, not an invented mid-failure revision bump.

- [ ] **Step 2: Run focused red tests.**

  `node --test tests/modpacks/failed-restorepoint-retirement-production.test.cjs tests/modpacks/service-graph.test.cjs tests/modpacks/startup-recovery-order.test.cjs tests/modpacks/operation-recovery-reconciliation.test.cjs tests/modpacks/notification-store.test.cjs tests/modpacks/modpack-notification-presentation.test.cjs tests/modpacks/modpack-notification-component.test.cjs`

  Expected red: no live hook/startup retry or warning update support.

- [ ] **Step 3: Wire production authority and warnings, without broadening recovery.**

  Capture successful settlement and final policy provenance on the original lease, invoke runtime retirement once before claim release, and catch ordinary retention failure separately from source cleanupError. Do not swallow writer uncertainty into an ordinary warning or release while a native deleter may still act. Wire shared exact-point facade/helper and the owned post-ready/onResolved pass at the proven boundaries. Arm startup housekeeping without awaiting it from composition.initialize, afterWindowCreated, renderer readiness or startup-window close. Keep coordinator admission/lease before effects; background placement grants no weaker writer authority. Stop admission synchronously during dispose, drain active retirement before reference/resource teardown, and never reuse cache-prune's bounded shutdown wait or schedule a fresh close pass. Do not retry at planning in v1; no new admission gate.

  Persist diagnostic in existing receipt when possible; if receipt authorization/write fails, candidate still survives in terminal history and next inventory produces deferred-proof. Publish warning independently; notification I/O failure cannot undo settlement or remove candidate/receipt. At later startup/recovery passes regenerate/update notices from evidence, including deleted receipts for resolution; no tight retry loop or suppression of all startup work. Receipt/notice disk failure means no promise of a durable updated message, but previously durable obligation remains the source of truth.

  Exact UI copy:
  - retained: title **Backup cleanup pending**; message **The failed attempt's backup is still retained. Cleanup will be retried when it is safe. This warning alone does not block Repair.**
  - partial: title **Backup cleanup incomplete**; message **The archive was removed, but its protected metadata still needs cleanup. This warning alone does not block Repair.**
  - deferred-proof: title **Backup retained for safety**; message **Final policy completion was not recorded for this attempt. Its backup has been kept; automatic cleanup cannot be promised. This warning alone does not block Repair.**
  - reclaimed: title **Backup cleanup complete**; message **The failed attempt's archive and metadata were removed.**

  For reason `independent-owner`, replace the retained message with **Another history entry or operation still needs this backup. It has been kept. This warning alone does not block Repair.** For `reference-proof-incomplete` or `invalid-evidence`, use **Backup ownership could not be fully verified. It has been kept; automatic cleanup cannot be promised. This warning alone does not block Repair.** Other retained reasons use the base copy; “retried” promises only the defined future invocation opportunities, not successful cleanup. Never raw paths or exception text. Current global bell counts unread actionable notices only: additionally count only relevant unread unresolved `retention-warning` notices after existing server/exclusion filtering, without inventing a filesystem/recovery action. Do not make the bell permanently visible: empty, read, reclaimed, or excluded retention notices do not make it appear. Existing notification center renders generic title/message; no layout redesign or restore action. Add assertions for relevant unread unmanaged-server global visibility, managed contextual visibility, hidden bell for no/read/reclaimed/excluded notices, dismissal, same-state dedupe, changed partial state, rehydration, and reclaimed read state.

- [ ] **Step 4: Run the finite green gate and self-review the integrated diff.**

  Run Step 2, Tasks 1–3 focused commands, `node --test tests/main-bootstrap.test.cjs tests/startup-window.test.cjs tests/orderly-quit-barrier.test.cjs`, and:
  `node --test tests/modpacks/modpack-recovery.test.cjs tests/modpacks/production-mutation-runtime.test.cjs tests/modpacks/server-directory-transaction.test.cjs tests/modpacks/lifecycle-outcome-actions.test.cjs`

  All passing output plus the native exact-only success is required; mocks alone do not certify native disposition/close/flush. Confirm no edits outside assigned files and no protected dirt changes. Record test commands/results, any native prerequisite gap, and remaining accepted limits. No unbounded “run until all failures disappear” or general retention refactor. Root owns final integration review and later ordinary-app acceptance/packaged-worker artifact preparation, with generated fixtures only; never use real retained pairs to demonstrate cleanup.

## Self-review and handoff

Root-requested second self-review corrected starvation and readiness ownership: separate protected retry/notice budgets with durable oldest-attempt ordering survive restart when receipt writes succeed; startup deletion is one owned post-navigation-ready pass, not an initialization dependency; close drains confirmed native ownership before shared teardown. Added finite starvation/restart and held-readiness/disposal regressions, clarified directory identity compatibility, and explicitly rejected an always-visible bell. Final source review also replaced digest-only ownership matching with target-scoped point identity plus digest integrity, preserving conservative ambiguous/physical-alias handling and adding a same-bytes/distinct-file regression. The spec now explicitly excludes pre-planning retries in v1. No new scheduler, timing project, source recovery or process/policy action was added.

Self-review completed for this documentation pass: all accepted spec requirements map to one of the four tasks; DTO names and per-file intent states match across native/registry/service/caller boundaries; all five Review Focus cases have named tests; finite limits defer instead of inventing negative proof. The older audit's unpin-only proposal is superseded by the accepted exact-pair design. No tests, builds, native commands, runtime/profile/UI/process/network operations, product edits, staging or commits were performed in planning.

Root must read/self-review this plan and assign ownership before implementation dispatch. User already supplied the execution/self-review direction; this handoff does not introduce another authorization question. Estimated scope is four meaningful deliverables, not a promise of a fixed completion time or guaranteed cleanup latency.

