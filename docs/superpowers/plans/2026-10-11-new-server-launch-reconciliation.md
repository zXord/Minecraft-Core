# New-Server Launch Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover an uncertain new-server Start by its reviewed plan identity and permit destination reuse only after backend-owned, durably confirmed release.

**Architecture:** Extend the existing operation record with a private v2 binding, while keeping every public job DTO v1. Reuse the reservation path gate, process-bound workspace lease, lifecycle active owners and authenticated recovery closure; add bounded startup classification and read-only reconciliation/discovery. Never replay Start or filesystem recovery to discover/repair bookkeeping.

**Tech Stack:** Electron/CommonJS services, existing guarded durable-fs transport, Node `node:test`, Svelte renderer and existing Playwright component fixtures.

**Spec:** `.superpowers/sdd/2026-10-08-matching-client-packs/task-6-launch-reconciliation-design.md` (complete amended design); its `task-6-launch-reconciliation-design-review.md`; `task-6-launch-reconciliation-current-audit.md`; renderer handoff uses `task-6-renderer-ordering-amended-design.md` in the same directory. Executors read these before their slice. Source audit baseline: HEAD `e4bfedc`; use named methods, not stale line offsets.

## Global Constraints

- Four dependent review gates below. Task 1 is independently testable storage-only work; **production v2 creation/holds stay disabled until all four slices are reviewed and root explicitly enables them**.
- No separate durable launch-receipt store, a new prepare-launch round trip, resumable persisted plans, or another job scheduler. No second owner framework or broadened native filesystem/recovery authority.
- Preserve the **public v1 job DTO**. Existing v1 files remain v1, readable and not bulk rewritten. An older binary rejects v2 files during full initialization; document this one-way product rollback boundary before enabling v2 writes.
- `instanceId` is the never-recycled reservation incarnation. Do not add a reservation token, executable plan contents, owner epoch or a second durable root to the binding.
- No runtime work is scheduled until the durable job/binding is known to exist and match. Remove a live hold only after durable confirmation. Never infer release permission from terminal phase, cancellation, TTL, absent active owner, generic IPC failure or cached absence.
- Keep the existing same-canonical-workspace/profile scope; different profiles/shared destinations remain subject to native mutation/recovery leases, identity and reparse guards.
- Limits: 16 pending new-server admissions; stalled reason after 30 seconds without eviction; list limit 1–100, default 50; four snapshots; 2,000 identities per snapshot; two-minute snapshot expiry. Do not prune held bindings/jobs.
- Deterministic tests only: injected failures/deferred promises/fake clocks/disposable roots. No real dialogs, application/server/process actions, profile/cache/instance reads, broad tests, builds, dependency changes or Git mutations without root authorization.
- Preserve concurrent writers. Task 1 owns only operation store/event-store and their tests. Later lifecycle `createPlan`/workspace changes wait for the stale-review writer; retirement helper/restore-point-service/tests remain Task 3 retirement's ownership, not this plan's.
- Root has delegated self-review authority; send the plan/results to root, not a new user approval question. A review checkpoint is not authority to commit, ship or enable the feature.

## Review Focus

- A valid v2 file may exist although create threw before index insertion: Task 1 must find it; Task 2 schedules that exact admission at most once.
- A complete-looking cached catalogue may miss a concurrent publication: Task 1 detects generation/publication changes; Task 2 also excludes claim-before-create admissions.
- An old release or historical settlement callback may run against a new same-path reservation: Tasks 2–3 preserve immutable job/incarnation binding and never recycle IDs.
- Workspace ownership may empty before terminal publication finishes: Task 2 drains admitted work, including Verify and recovery-finalization callbacks, before lease disposal.
- A v1 JSON record cannot prove its writer/runtime origin: Task 3 defaults unknown origin to deferral and requires a root migration ruling; it never synthesizes a legacy marker.

---

## File ownership and exact shared contracts

Paths below are repository-relative for implementers. Only the plan is written in this planning turn.

| Slice | Production files | Owned test files |
| --- | --- | --- |
| 1: storage | `electron/services/modpack-lifecycle/operation-store.cjs`, `operation-event-store.cjs` | `tests/modpacks/operation-store.test.cjs`, `operation-event-store.test.cjs` |
| 2: owner/live handoff | `electron/bootstrap/create-production-modpack-composition.cjs`; lifecycle `modpack-lifecycle-service.cjs`, `plan-registry.cjs`; `electron/services/modpacks/planning/server-destination-reservation-service.cjs`; guarded release routing in `electron/ipc/modpack-handlers.cjs` | `tests/modpacks/production-modpack-composition.test.cjs`, `plan-registry.test.cjs`, `server-destination-reservation.test.cjs`, `modpack-lifecycle-mutations.test.cjs`, `modpack-ipc.test.cjs`; create `tests/modpacks/new-server-launch-reconciliation.test.cjs` |
| 3: closure/startup | same composition/lifecycle; `production-mutation-runtime.cjs`, `operation-recovery-reconciler.cjs`; create one pure `electron/services/modpack-lifecycle/new-server-launch-closure.cjs` for shared closure predicates/classification | new focused launch suite above; `tests/modpacks/operation-recovery-reconciliation.test.cjs`, `production-mutation-runtime.test.cjs`, `production-modpack-composition.test.cjs`, `modpack-recovery-facade.test.cjs` |
| 4: IPC/renderer | `electron/services/modpacks/ipc-schemas.cjs`, `errors.cjs`, `electron/ipc/modpack-handlers.cjs`, `electron/preload.cjs`, `src/utils/modpacks/modpackApi.js`; `src/components/setup/ServerSetupWizard.svelte`, `ArchiveGuidedReview.svelte`; `src/components/modpacks/ModpackPlanReview.svelte`; `src/routes/ModpackPage.svelte` for parent review ownership; `ModpackJobProgress.svelte` only for intentional-selection context if required, preserving existing merge/poll/terminal behavior | `tests/modpacks/ipc-schemas.test.cjs`, `error-codes.test.cjs`, `modpack-ipc.test.cjs`, `modpack-preload-contract.test.cjs`, `modpack-setup-renderer-contract.test.cjs`; create `tests/modpacks/modpack-api-launch-reconciliation.test.cjs`, `tests/e2e/modpack-launch-reconciliation.spec.js` using disposable rendered fixtures; update directly affected existing ownership/ordering assertions only |

### Private storage v2 and unchanged public projection

V1 storage retains its exact existing keys/checksum algorithm. V2 storage is the same closed key set plus exactly `launchBinding`, with `schemaVersion: 2`; type remains `minecraft-core-modpack-job`. Include binding and actual storage version in the v2 checksum. Only `install-new` and `import-files-only-new` may be v2. No optional unvalidated JSON or mixed v1-with-binding file is accepted.

```js
launchBinding = {
  planId,                  // plan-launch-v1-<UUID v4>, backend allocated, never reissued
  planFingerprint,         // lowercase SHA-256, equals the record's planFingerprint
  instanceId,              // existing identifier grammar, equals record.serverId
  targetPath,              // normalizeRecoveryTargetPath() canonical Windows target string
  capturedReservation,     // exactly one of the existing capture forms below
  displayName,             // captured backend display name; NFC, trimmed, 1–128, safe basename/no controls
  destinationDisposition   // 'held' | 'released' | 'consumed'; creation requires 'held'
};
capturedReservation = { kind: 'absent' };
// OR:
capturedReservation = {
  kind: 'empty-directory',
  identity: { dev, ino, birthtimeNs } // existing capture's decimal strings, not volumeSerial/fileId
};
```

Use `strictObject`/existing bounded cloning, pure `normalizeRecoveryTargetPath` from `recovery-target-envelope.cjs` and `isSafeWindowsBasename`. Canonicalize backend input before initial publication; require canonical storage on read, not silent identity/path rewriting. Identity is exactly `reserved-target-authority.cjs`'s capture shape: canonical decimal strings; `dev/ino` nonnegative, `birthtimeNs` may be signed; reject numbers, extra/missing keys, accessors, symbols and malformed encodings. **Reject `existing-unmanaged-directory`**. The current authority exports capture/consume but no pure captured-reservation validator: add only local pure storage validation of that shape; do not call capture/consume, lstat, realpath or inspect the actual target to parse a job. All binding identity fields are immutable; disposition is the only mutable binding field. Existing operation-directory pinning still runs normally.

Every existing public read/mutation/initialize return is explicitly projected to exactly:

```text
type, schemaVersion:1, sequence, jobId, operationKind, serverId, planFingerprint,
phase, swapStep, progress, cancellationRequested, createdAt, updatedAt,
terminalAt, outcome, events
```

Never return checksum, storage schemaVersion 2, binding, target/capture evidence, internal revision, owner epoch or publication generation through public DTOs/events/notifications/errors/actions. `validatePublicJob` continues to require this closed v1 shape, including its existing nested public validation; it must not begin accepting raw private/v2 records. Each later transition preserves the loaded storage version and immutable binding.

### Private store interfaces and concurrency semantics

Extend the constructor with `allowNewServerLaunchBindings = false` and `launchOwner = null`. Existing callers remain unchanged. Tests explicitly opt in; production composition does not opt in before Task 4's final gate. The option gates **new v2 creation**, not v1 reads/writes or v2 parsing. New trusted launch methods require the owner contract; they are never exposed directly to IPC.

`launchOwner = { epoch, assertCurrent(expectedEpoch, { allowClosing = false, startupOnly = false }) }` is a local composition-owned object. Epoch is freshly allocated per composition, never persisted or supplied by renderer. Its synchronous assertion checks exact epoch, existing non-null held workspace lease, root binding, non-disposed owner; default rejects closing, `startupOnly` additionally requires startup classification before readiness. `allowClosing:true` is used only for previously admitted settlement/publication while shutdown drains. It does not authorize fresh admission. Storage tests use an explicit fake lease/epoch with that contract; a registry with null lease is not owner evidence.

```text
RecordRevision = { sequence: nonnegative safe integer, sha256: lowercase SHA-256 }
LaunchRecord = { job: PublicJobV1, binding: LaunchBinding, recordRevision: RecordRevision }

create({ jobId?, operationKind, serverId, planFingerprint?, launchBinding? }, ownerEpoch = null,
  { onPublicationAttempt = null } = {})
  -> PublicJobV1
getNewServerLaunch(jobId, ownerEpoch) -> LaunchRecord | null
findNewServerLaunch({ planId, planFingerprint }, ownerEpoch) -> LaunchRecord | null
listNewServerLaunchBindings(ownerEpoch) -> LaunchRecord[]
getLaunchPublicationState(ownerEpoch) -> { generation, pending: boolean }
settleNewServerDestination(jobId, {
  expectedInstanceId, expectedRecordRevision, nextDisposition, terminalUpdate?
}, ownerEpoch) -> PublicJobV1
closeInterruptedQueued(jobId, { expectedInstanceId, expectedRecordRevision }, ownerEpoch)
  -> PublicJobV1
```

- `recordRevision.sequence` is the logical monotonic job revision; `recordRevision.sha256` is SHA-256 of **exact current durable file bytes** returned by existing `#read`, not the embedded checksum or a reconstructed DTO digest. Both must match the authoritative reread before a new CAS write; pass that exact byte digest to `expectedTargetSha256`. CAS mismatch is `PLAN_STALE`; corruption/contradiction is `RECOVERY_REQUIRED`; invalid trusted input is `INVALID_REQUEST`.
- `create` without binding stays v1. With binding require opt-in, owner epoch, supported kind, exact equal identities and initial held disposition; reject a pre-existing plan association/instance incarnation rather than replacing it. Expected-absent publication remains `expectedTargetSha256:null`. This primitive creates no runtime owner or schedule. The optional trusted callback is invoked once, after all existence/collision checks and directory revalidation, immediately before the publication await, with frozen `{job:PublicJobV1,binding:LaunchBinding,expectedTargetSha256:null}` for a v2 attempt. This is a local attempt witness, not a durable receipt/credential; no callback on precondition/TARGET_EXISTS rejection. The lifecycle retains it only through that admission, and an ambiguous-create reread must match its complete initial public job plus immutable binding/held disposition. Never adopt a precondition rejection or an unrelated matching-looking record. EventStore forwards the callback privately; no witness enters return/error/event/log/IPC payloads.
- `getNewServerLaunch` waits for this job's active publication like `get`, validates durable v2 and returns the private envelope; absent file returns null, an existing v1/wrong-kind file is not an adoptable launch and rejects. It does not claim global absence.
- `find/list` scan and validate the complete operations directory into a temporary local catalogue. Do **not** call `initialize` or replace/delete/update `records` to obtain this scan. Validate every file, including v1; duplicate plan ID (even another fingerprint), contradictory association, unreadable/invalid file or malformed binding is recovery-required, never null. Find rejects fingerprint mismatch as invalid credential, never absence. List returns all validated v2 bindings, not only held records.
- Increment store `publicationGeneration` at begin and end of **every** publication, including create and all `#write` paths; register before its first awaited publication and clear in `finally`, including post-publication revalidation failure. Track all operations because catalogue absence is global. `getLaunchPublicationState` returns internal scalar state, not paths/promises.
- Full-catalogue reads assert owner before/after, reject with safe `PLAN_STALE` retry semantics if publications are pending or generation changes during the scan; never return null/partial results in that case. The lifecycle translates this read-only retry condition to pending, not failure/absence. Store absence certifies only this stable durable catalogue; Task 2 must additionally fence admissions and prove plan unusability before public `not-started`.
- `settle...`: next disposition is released/consumed only; check exact job/incarnation. Held→requested performs one hash+sequence guarded atomic write and increments sequence once. Already exactly requested is idempotent success without a write/increment; opposite disposition is recovery-required. Optional `terminalUpdate` uses the existing `{ expectedPhase, nextPhase, patch }` transition shape, restricted to a legal failed/cancelled terminal update and existing normalized public patch/outcome; publish terminal+released in one write for live unrecorded closure. For idempotent replay with terminalUpdate require the exact normalized terminal pair already exists, not disposition alone.
- `closeInterruptedQueued` is a trusted **startup-only** primitive, not a proof classifier. Require supported new-server kind, exact server/incarnation, reread still queued, revision CAS and startup owner assertion. In one write set failed with outcome `{status:'failed',message:'The operation was interrupted before execution',errorCode:'COMMIT_FAILED',operationKind,actions:[]}` and progress `{percent:100,message:'Interrupted before execution',currentItem:null}`; for v2 set released, for v1 retain v1 with no binding. Keep job started/discoverable, not not-started. Exact already-published result is idempotent success; other terminal/later records reject. Caller must supply Task 3's complete proof, including trusted legacy-origin policy for v1.
- After any ambiguous CAS exception, the trusted caller rereads the exact job: requested immutable binding/disposition (+ terminal pair where required) is success; unchanged held/queued may get **one** retry after complete authority recheck and fresh revision; changed/opposite/uncertain remains held and explicitly repair/recovery/support-required. No target action replay.
- `OperationEventStore` forwards private reads unchanged, and wraps trusted mutation returns in its existing safe publication projection. New forwarding methods must not make legacy stub dependencies mandatory unless used; do not break existing v1-only test/composition fixtures.

### Later owners and method names

- PlanRegistry: `bindNewServerReservation(planId, instanceId)`, `invalidateReservation(instanceId)`; private association is separate from fingerprinted plan. Invalidation/expiry synchronously make plans unclaimable **before** awaited workspace cleanup; claim rechecks after its asynchronous credential step. New-server plan allocation uses the v2 binding's protocol namespace.
- Reservation service: `withDestinationGate(targetPath, work)`, `holdJobDestination({jobId,binding})`, `restoreJobHold({jobId,binding})`, `removeConfirmedJobHold({jobId,instanceId,disposition})`. Gate uses the existing normalized path queue; holders deny expiry/release/re-reserve, never grant filesystem authority. `resolve` rejects genuinely expired unlaunched metadata without deleting it outside the gated finalizer. Runtime-held resolution does not expire at the old TTL.
- Lifecycle: `releaseServerDestination(instanceId) -> boolean`, `settleJobDestination({jobId,disposition,evidence})`, `reconcileNewServerLaunch({planId,planFingerprint})`, `listNewServerLaunches({cursor?,limit?})`; private evidence never reaches IPC. Existing reserve/start/release request/response shapes stay unchanged. Internal settlement validates evidence and calls store CAS before removing the hold.
- Composition owner state is local: `starting → ready → closing → disposed`; one fresh epoch, one monotonically changing lifecycle `admissionGeneration`, pending admission map and tracked admitted tasks. Increment admission generation on admission begin/job handoff/no-job closure/fencing changes. Negative reads compare admission generation, store publication generation and epoch before/after awaited evidence reads; changed/pending returns pending, never closed absence. The per-plan pending entry exists before first await and records generated jobId after claim. Bound settlement callbacks are tracked until their final publication/cleanup completes.

---

## Task 1 / Slice 1: Private storage contract only

**Files:** first row of ownership table only. No lifecycle, reservation, composition, runtime, IPC or renderer edits. Tests may create logical Windows target strings; no target directory is accessed. No production caller supplies the new opt-in.

**Consumes:** existing atomic byte-digest guards, current exact v1 parser/public sanitizer, captured reservation shape and pure recovery target grammar.

**Produces:** all private store interfaces/types above; explicit public-v1 projection; tracked create and independent catalogue scan. No admission/execution/recovery policy.

- [ ] **Step 1: Add failing compatibility/privacy tests.** Extend the existing disposable `fixture(t)` with optional explicit test owner and opt-in. Add `v2 launch storage preserves public v1 shape` with assertions:

  ```js
  assert.equal(publicJob.schemaVersion, 1);
  assert.equal(rawStored.schemaVersion, 2);
  assert.deepEqual(privateRead.binding, suppliedBinding);
  assert.deepEqual(Object.keys(publicJob).sort(), PUBLIC_V1_KEYS.slice().sort());
  assert.throws(() => validatePublicJob(rawStored));
  assert.equal(JSON.stringify(publicJob).includes('launchBinding'), false);
  ```

  Assert default opt-in rejects binding creation and old create remains byte-compatible v1. Test absent/empty-directory capture, existing-unmanaged rejection, extra/accessor/symbol keys, malformed fingerprint/UUID/path/disposition/identity, top-level mismatch, invalid checksum and stored noncanonical path. `normalizeRecoveryTargetPath('C:\\private\\new-server')` is a logical fixture path, not an I/O root. Reread existing v1 files without rewriting.
- [ ] **Step 2: Run RED.** `node --test --test-name-pattern='v2 launch|public v1|launch binding' tests/modpacks/operation-store.test.cjs`. Expect the new feature assertions/method calls to fail; diagnose unrelated fixture failures before proceeding.
- [ ] **Step 3: Implement strict v1/v2 parsing/projection in operation-store.** Keep existing public validators strict. Preserve storage version/binding through every current mutation path. Implement creation gate and pure binding normalization exactly above; no filesystem calls for target validation.
- [ ] **Step 4: Add failing publication/catalogue/CAS tests.** Names and decisive assertions:
  - `launch create is tracked through post-publication failure`: defer transport, assert pending true and exactly one frozen attempt witness; publish bytes then throw, assert map clears in finally and exact allocated-job private reread finds one sequence-0 held record matching the witness despite missing index insertion. Before-publication/TARGET_EXISTS/precondition failures never authorize adoption; rejected preconditions emit no witness.
  - `launch lookup validates complete durable catalogue without resetting index`: capture `store.records` reference/content, alter disposable durable fixture, assert exact lookup/list sees disk; corrupted unrelated file rejects; same `records` reference/content remains unchanged.
  - `launch duplicate associations and changed generation never certify absence`: two valid checksummed files with same plan ID/different fingerprint or reused incarnation reject; pending/new publication or owner loss rejects, never null.
  - `launch disposition uses sequence and exact byte hash CAS`: wrong sequence with right digest and right sequence with wrong digest both reject without mutation; held→released increments once; same replay does not increment/write; consumed→released rejects; ordinary progress/cancellation preserves binding and storage v2.
  - `queued closure atomically fails and releases only under startup owner`: v1 stays v1, v2 fails+releases in one publication; cancelling/preflight/live-ready owner/wrong incarnation/stale hash reject. Fault before/after publication then exact reread; assert no target capture/consume function runs.
  - `launch reads and events never leak private metadata`: assert serialized public returns/events/notifications have no binding, targetPath, capturedReservation, recordRevision, epoch or checksum; private EventStore forwarding is exact and does not publish reads.
- [ ] **Step 5: Run RED.** `node --test --test-name-pattern='launch |queued closure' tests/modpacks/operation-store.test.cjs tests/modpacks/operation-event-store.test.cjs`. Expect absent tracking/read/CAS interfaces and privacy assertions to expose the intended gaps.
- [ ] **Step 6: Implement tracking, scans, CAS and forwarding.** Use existing `#read` byte digest and `#write`; factor only small local parser/publication helpers. Scan without index mutation; register create before publication await; owner checks bracket scan/write and failures. Forward methods lazily so existing v1 fixture dependencies remain valid.
- [ ] **Step 7: Run GREEN/regression.** `node --test tests/modpacks/operation-store.test.cjs tests/modpacks/operation-event-store.test.cjs`. Expect all tests pass, zero failures/cancellations, no new skips. Inspect task-only diff for exact public projection and no external writers/production opt-in. Run the focused new tests again with owner loss and both publication fault locations.
- [ ] **Step 8: Root review gate.** Report exact RED/GREEN commands/results and owned files; demonstrate production constructors still omit opt-in and normal `.create` remains v1. No commit/staging unless separately authorized. Stop here when dispatched only for storage slice; root chooses the fresh next implementer/reviewer.

## Task 2 / Slice 2: Single-owner live handoff and drain

**Files:** second row; wait for lifecycle stale-review writer before overlapping edits. Consume Task 1 interfaces unchanged. Production durable holds/new v2 starts remain disabled; exercise enabled wiring via explicit fixtures only.

**Produces:** local owner/epoch/drain contract, synchronous plan fencing, shared destination gate, fresh incarnation IDs, guarded release/expiry, exact ambiguous-create handling.

- [ ] **Step 1: Add failing root/owner/drain tests** in composition/launch suites. Reject mismatched workspace/operations paths relative to `createModpackPaths(userDataPath)` and null/lost lease. Defer create, then terminal publication **after claim release**, Verify, and recovery `onResolved`; `dispose()` synchronously rejects fresh starts, remains pending, and does not close lease until all admitted work settles. On drain failure retain lease while live writers remain; do not voluntarily close it or kill workers. Test startup direct-call rejection before readiness and owner epoch change after awaited evidence reads.
- [ ] **Step 2: Run RED.** `node --test --test-name-pattern='launch owner|launch drain|launch startup' tests/modpacks/production-modpack-composition.test.cjs tests/modpacks/new-server-launch-reconciliation.test.cjs`. Expect missing root/lifetime barriers to fail.
- [ ] **Step 3: Implement owner binding and drain** in composition/lifecycle. Match canonical default roots with existing validators/pins; reuse non-null process-bound lease. Close admission synchronously, drain admitted create/execution/terminal settlement and bound recovery-finalization callbacks, then dispose inspections/plans/hash/workspaces in existing safe order. Continue admitted settlement with allowClosing owner assertions. Do not treat `activeOperations.size===0` or empty workspaces alone as the drain proof.
- [ ] **Step 4: Add failing gate/fence tests** in plan/reservation/lifecycle/launch suites. Pause start after lookup/claim/during create/after publication; release-first invalidates before cleanup and creates no job, start-first refuses generic release; duplicate starts/sibling plans schedule one owner; expiry/late dialog cannot bypass gate. Same-path re-reservation gets a different ID; old release/settlement cannot affect it. Admission 17 rejects before claim; after fake 30 seconds unresolved admission retains fence/slot with reason `admission-unresolved`; settled/no-job admissions leave discovery.
- [ ] **Step 5: Run RED.** `node --test --test-name-pattern='launch |reservation incarnation|synchronous.*fence' tests/modpacks/plan-registry.test.cjs tests/modpacks/server-destination-reservation.test.cjs tests/modpacks/modpack-lifecycle-mutations.test.cjs tests/modpacks/new-server-launch-reconciliation.test.cjs`.
- [ ] **Step 6: Implement live interfaces and start branch** in ownership table. Bind successful new-server preflight privately under gate before returning unchanged DTO; allocate `plan-launch-v1-<UUID>` IDs; validate choices/reservation again after entering gate; claim once. Publish held binding then transfer hold/invalidate siblings and schedule once in existing active map. On create error, wait for create tracking to finish, reread allocated ID outside its own publication wait, and adopt only the matching own initial sequence-0 queued record with expected-absent creation established. Collision/mismatch/unreadable publication retains claim/fence/hold without scheduling. Proven absence plus completed claim cleanup closes the attempt; cleanup uncertainty remains unresolved. Preserve all EULA/fingerprint/restore choice checks.
- [ ] **Step 7: Route release and expiry** through the lifecycle owner/shared gate. Preserve boolean result, refuse pending/job-held including terminal jobs; unlaunched release synchronously fences associated plans before async cleanup. Normal expiry finalization and deferred dialog completion use the same gate. Held reservations remain resolvable past original TTL; no gate held while waiting for execution, getJob terminal settlement or nested recovery.
- [ ] **Step 8: Run GREEN/regression.** `node --test tests/modpacks/plan-registry.test.cjs tests/modpacks/server-destination-reservation.test.cjs tests/modpacks/modpack-lifecycle-mutations.test.cjs tests/modpacks/production-modpack-composition.test.cjs tests/modpacks/modpack-ipc.test.cjs tests/modpacks/new-server-launch-reconciliation.test.cjs`. Root reviews generation/epoch checks, ambiguous-create claim retention and lease lifetime. Keep production opt-in false; no new feature acceptance claim.

## Task 3 / Slice 3: Settlement matrix and bounded startup closure

**Files:** third row, no retirement/restore service edits. Consume immutable Task 1 binding/revision and Task 2 owner/gate interfaces. Extract runtime's existing closure predicates into the one pure `new-server-launch-closure.cjs`, shared by runtime/composition/startup; it is not a recovery executor.

**Produces:** `classifyRecoveryTerminalClosure(record, {releaseTrackingIntent = null} = {}) -> 'completed'|'abandoned'|'rolled-back'|null` (runtime wrapper translates null to its existing pending-recovery error), and `classifyLaunchDestination({job,binding,recoveryEvidence,registrationState,queuedProof}) -> {disposition:'released'|'consumed'|null, settlementStatus, reason, recoveryAvailable}`. Inputs come only from the owning backend after authenticated registry reads; pure classification cannot authenticate arbitrary caller JSON or authorize target work. `settlementStatus` is active/settled/repair-pending/recovery-required/support-required. Reuse exact registration check: one ID and one canonical-path match must be the same server object; none of either is absent; otherwise conflict.

| Authenticated evidence | Result and owned boundary |
| --- | --- |
| Completed new history, published candidate, completed exact registration, required release tracking applied; current registration exactly matches ID/path | consumed; ordinary cleanup, already-historical return, onResolved or startup repairs metadata only |
| Failed pre-publication-cleanup/new-health-failed satisfying existing swap/identity/publication predicates, exact operation ID, current registration absent | released; rollback/abandon ordinary/historical paths repair only after recovery closes |
| Failed revalidation-aborted; swap none, no restore creation/point, no candidate/rollback/failed identities, new-target identity null, no publication/registration/live authorization, operation ID absent or exact, registration absent | released; reuse restrictive runtime predicate, never action-string-only acceptance |
| Supported prior-owner still-queued with complete proof below | atomic failed+released for v2; failed-only v1; never target operations/reexecution |
| Live unrecorded revalidation failure, full clean scan and original lease-authorized reserved-target handling already complete | atomically terminal failure/cancellation+released through terminalUpdate; after restart missing evidence alone cannot rebuild this proof |
| Exact settled destination-recovery outcome proves failed mutation acquisition, current registration absent, older conflicting recovery retained | release only this setup hold via checked outcome route/startup metadata repair; preserve older path/global restriction |
| Active matching recovery, pending terminal publication, ambiguous/unpublished closure | held; finish existing bound recovery/bookkeeping first, then reclassify |
| Conflicting registration/identity/opposite disposition, corrupt or unbindable mutation evidence | held plus scoped recovery/support restriction; no guessed release/consumption |

**Queued proof:** startup-only owner/epoch/lease and completed orphan initialization; initial catalogue member with no current admission/execution/settlement; intact supported kind still queued on reread; complete recovery scan (active/corrupt/blocks/global/pending) plus history and stable-server-ID registration (path too when trustworthy) contain no contradiction; recheck all authority and exact record revision immediately before CAS. Existing recovery/history evidence goes to matrix, not absence classifier. At most one retry after complete reproof; later phase rejects. No current owner, cancelling/preflight or raw null load shortcuts.

**Legacy migration gate requiring root ruling:** source ordering is proved only for stock repository lineage `cc97271` through audited `e4bfedc`; no tagged lifecycle-enabled origin or per-v1 writer marker is available. Default production policy is **unknown origin: do not call v1 queued closure**. Root must either approve an explicitly evidenced stock-installation origin scope before enabling automatic v1 closure, or keep unknown v1 jobs deferred with named support/recovery disposition and justified scope. Never infer origin from v1 JSON, lack of recovery, current injected runtime, package version, random job ID or a new marker written onto an old job. Fixtures may explicitly select audited-stock policy to test the primitive/classifier, but that is not deployment evidence. This blocks v1 auto-migration, not Task 1 storage or exact v2 behavior; do not impose global denial solely because a queued v1 path is missing.

- [ ] **Step 1: Add failing matrix/queued tests** in new launch/reconciler suites using real disposable operation/recovery stores where durable proof matters. Table-drive every row; assert disposition/status/reason and zero target calls for metadata repair. Include changed revision/epoch, active/history/corrupt/global/pending evidence, registration conflicts, no v1 path, unknown injected origin, cancelling/preflight and incompatible provenance.
- [ ] **Step 2: Run RED.** `node --test --test-name-pattern='launch matrix|launch queued|launch legacy' tests/modpacks/new-server-launch-reconciliation.test.cjs tests/modpacks/operation-recovery-reconciliation.test.cjs`. Expect missing complete classifier/atomic closure behavior.
- [ ] **Step 3: Implement shared predicates and startup classifier.** Use existing bound `retryTerminalPublication`, not bare history alone. Under held startup owner, validate full initial catalogue/recovery/registration, reconstruct denial-only holds, apply queue closure/matrix metadata repair, then normal job reconciliation and readiness. Keep classifications consistent in one pass. Unknown later-phase no-evidence gets `support-required:missing-recovery-evidence`; preserve trustworthy path restriction, escalate global only for genuinely unbindable mutation risk under existing recovery authority.
- [ ] **Step 4: Add failing historical/uncertainty tests** in runtime/composition/facade suites: ordinary and already-historical cleanup/rollback/abandon/revalidation; archived-success then failed onResolved and restart; disposition CAS before/after publication; exact idempotent replay and opposite disposition; live unrecorded atomic terminal pair; destination-recovery checked release without clearing older restriction. Assert no source cleanup/quarantine/registration replay and no getJob/gate deadlock.
- [ ] **Step 5: Run RED.** `node --test --test-name-pattern='launch settlement|launch historical|launch disposition|launch destination recovery' tests/modpacks/new-server-launch-reconciliation.test.cjs tests/modpacks/production-mutation-runtime.test.cjs tests/modpacks/production-modpack-composition.test.cjs tests/modpacks/modpack-recovery-facade.test.cjs`.
- [ ] **Step 6: Implement settlement adapters.** Filesystem/recovery authority closes first; authenticate exact closure/current registration; store CAS; ambiguous reread/one reproved retry; remove live hold only on confirmed requested disposition. Adapt every early return and composition callback. Public reads never trigger repair. Preserve existing active-job recovery exclusion and native lease/reparse/identity/runtime-writer checks.
- [ ] **Step 7: Run GREEN/regression.** `node --test tests/modpacks/new-server-launch-reconciliation.test.cjs tests/modpacks/operation-recovery-reconciliation.test.cjs tests/modpacks/production-mutation-runtime.test.cjs tests/modpacks/production-modpack-composition.test.cjs tests/modpacks/modpack-recovery-facade.test.cjs`. Root reviews full matrix, unknown legacy deferral and real-store fault evidence; still no production enablement.

## Task 4 / Slice 4: Read-only handoff, bounded discovery and renderer adoption

**Files:** fourth row; consume earlier interfaces unchanged and current renderer merge/context owners. Do not reopen unrelated page Verify/navigation or terminal-summary implementations.

**Produces:** additive channels `modpacks:reconcile-new-server-launch({planId,planFingerprint})` and `modpacks:list-new-server-launches({cursor?,limit?})`; API wrappers with matching names. Closed schemas allow only safe public correlation/settlement data. Existing start/reserve/release shapes remain unchanged.

**Root implementation-seam refinement, 11 October:** current output-authority filtering rejects every `destination` key substring. Admit `destinationDisposition` only at the exact reconciliation/list settlement result paths for these two new output channels, with the closed held/released/consumed enum; retain the general filter and reject any private path/binding/extra fields. Add the bounded public error codes `LAUNCH_CURSOR_EXPIRED`, `LAUNCH_DISCOVERY_CAPACITY`, `LAUNCH_LIST_LIMIT_EXCEEDED` with empty details and distinct safe messages; include only the matching `ModpackFailureCode` additions in `src/types/modpack.d.ts` and its existing type-contract regression. Cursor expiry/capacity are retryable; an oversized catalogue must not create an automatic retry loop. The shared review children currently also serve ModpackPage: supply its parent-owned review callback/context rather than leave a bare late started event. Carry intentional-selection context through the existing progress owner only where needed; do not rewrite already equivalent accepted merge/poll/terminal/Verify guards merely to match old design names. The ownership-table additions are limited to these required seams and directly affected assertions.

Exact reconciliation result shapes:

```text
{ status:'pending', planId, planFingerprint, reason?:'admission-unresolved' }
{ status:'not-observed'|'not-started', planId, planFingerprint }
{ status:'started', planId, planFingerprint, job:PublicJobV1,
  settlement:{ status, destinationDisposition, reason?, recoveryAvailable:boolean } }
{ status:'recovery-required', planId, planFingerprint, reason }
{ status:'unavailable', planId, planFingerprint, reason:'legacy-correlation-unavailable' }
```

`not-observed` requires stable absence but a usable plan; `not-started` additionally proves plan irreversibly unusable and no pending admission/publication under unchanged epoch/generations. Wrong fingerprint is an invalid credential, never not-started. Exact readable job stays started even failed/cancelled/held terminal; settlement carries repair/recovery/support state, not competing top-level recovery-required. Pin safe reasons to this closed allowlist: admission-unresolved, missing-recovery-evidence, conflicting-evidence, invalid-durable-evidence, pending-terminal-publication, settlement-repair-required, destination-recovery, legacy-origin-unproven. Raw errors/private details are never returned. An unavailable legacy plan is not a retrospectively correlated launch; unknown legacy job-origin deferral uses legacy-origin-unproven rather than pretending correlation or clean absence.

List returns `{items,nextCursor}`; each item has `{planId,planFingerprint,status,createdAt}` plus known safe `serverId,operationKind,displayName,jobId,settlement` only when established; unresolved pre-plan admission omits unknown fields. No full private binding or target path. Capture one immutable safe identity set under unchanged epoch/admission/publication generations; merge pending/durable by plan identity; descending creation time then planId. Freshly reconcile each item outside gate. New admissions require refresh; captured no-job closures are transient tombstones for that snapshot only. Opaque backend-generated cursor maps to snapshot/epoch/offset; forged/expired/restarted cursor returns safe cursor-expired error, never raw offset authority. Enforce global constraints' exact limits; evict only expired oldest snapshot, otherwise capacity error; >2,000 candidates returns explicit list-limit error, not truncated success. Exact lookup/holds remain functional. Clear snapshots at shutdown.

- [ ] **Step 1: Add failing endpoint/discovery tests** in launch/IPC/API/preload suites: dropped Start response, malformed post-service IPC success, reload during pre-create admission and after publication, exact same job/one execution; closed absence vs pending/usable plan; legacy unavailable; held terminal started+settlement. Assert privacy/closed schema for every status, cursor expiry/restart/forgery, limits 1/100/default50, admission/snapshot capacity and 2,001-item explicit error, pending→durable dedup and no live index reset.
- [ ] **Step 2: Run RED.** `node --test --test-name-pattern='launch' tests/modpacks/new-server-launch-reconciliation.test.cjs tests/modpacks/ipc-schemas.test.cjs tests/modpacks/modpack-ipc.test.cjs tests/modpacks/modpack-preload-contract.test.cjs tests/modpacks/modpack-api-launch-reconciliation.test.cjs`.
- [ ] **Step 3: Implement the two read endpoints and bounded snapshots** in lifecycle/schema/handler/preload/API. Establish relevant pending fence before any awaited start lookup; exact lookup snapshots under gate then getJob after leaving it. On unstable owner/admission/publication return pending; reads never claim/start/release/repair. Validate sanitized results after projection. Public guarded release's destination-recovery exception must use exact backend binding/current hydrated outcome, not renderer authority.
- [ ] **Step 4: Add failing rendered fixture tests** in `tests/e2e/modpack-launch-reconciliation.spec.js`: parent captures plan/attempt and marks pending synchronously before invoke; structured/transport/malformed response reconciles without re-Start/release; Back/destroy detaches view without releasing; late success settles captured attempt only; explicit refreshed launch selection after reload; unrelated candidate never auto-adopted; selected started result uses getJob and current owner/server/job/fingerprint guards. Assert bounded pending retry (existing 1,200ms cadence with fake clock), honest stalled/repair/support copy and exactly-once completion. Use current existing rendered test harness, no live IPC/native/profile fixture.
- [ ] **Step 5: Run RED/GREEN rendered gate** with the existing in-memory component harness (`modpack-progress-reactivity.spec.js`) and repository `playwright.config.mjs`; no application webserver/Electron startup. Use a fresh output directory per invocation to preserve other writers' evidence:

  ```powershell
  $launchTestRun = [guid]::NewGuid().ToString('N')
  npx --no-install playwright test tests/e2e/modpack-launch-reconciliation.spec.js --workers=1 --output=("test-results/launch-reconciliation-" + $launchTestRun)
  ```

  Expected RED for missing reconciliation/selection behavior, then GREEN after local setup/review parent callback integration. Never release pending/job-owned/unknown reservation from renderer cleanup; not-started is navigation/replan permission, not directory deletion.
- [ ] **Step 6: Run affected Node GREEN** from Step 2 without name filtering, plus `node --test tests/modpacks/modpack-setup-renderer-contract.test.cjs tests/modpacks/modpack-setup-ui-presentation.test.cjs`; use existing rendered ordering/hydration tests as affected regression, not a new global state manager. Preserve terminal display/cancellation/native recovery behavior.
- [ ] **Step 7: Root rollout gate.** Document storage v2 one-way reader compatibility and safe rollback instructions (never delete/downgrade job files). Review all four slice results together, resolve/record legacy-origin migration ruling, and verify source ordering/owner assertions/drain/publication fault matrix. Only then explicitly change composition's opt-in for new v2 starts and run the same affected deterministic suites with production wiring enabled. Native normal-user lost-response/reload/reuse acceptance remains a separately authorized gate; deterministic fixtures are not native acceptance.

## Planning self-review and handoff

- [ ] Root reads this plan and complete amended design/current audit before dispatch; storage slice is the first independent deliverable, not implicit authorization for later files.
- [ ] Each slice implementer uses TDD and verification-before-completion, reports exact owned diff and limitations, and waits at its root review gate. No automatic commits or production enablement.

Planning self-review performed against every design section: storage/privacy/publication, live admission/gate/fencing, owner/drain, settlement matrix/queued proof/legacy scope, endpoints/statuses/list limits, renderer ownership and fault/regression gates are assigned above. Method names/types and sequence-versus-byte-digest CAS are consistent across slices. Only unresolved shipping decision is a trustworthy supported-origin scope for automatic legacy v1 queued closure; default deferral is explicit and does not block storage-only work. No implementation or test execution occurred while preparing this plan.
