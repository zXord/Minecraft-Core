# Client Cleanup Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make owned matching-client retained-tree cleanup practical for large packs while preserving crash-resumable exact ownership and compatibility with interrupted cleanup.

**Architecture:** Persist a bounded pending range before deletion, retain all per-entry checks, then flush the complete surviving boundary and CAS-advance once per batch. Keep existing awaited mutation ownership and startup/recovery lifecycle. The independently frozen verifier transport and recovery-indicator changes are prerequisites, not native acceptance.

**Tech Stack:** Node.js CommonJS, existing durable-fs/Windows native helper, node:test, Svelte/Playwright supplemental UI tests, ordinary isolated Electron native acceptance.

**Spec:** `docs/superpowers/specs/2026-10-10-client-cleanup-batches.md`

## Global Constraints

- Cleanup intent schema 2 keeps the same exact top-level fields as schema 1.
- In schema 2, `pending` is either null or an exact plain object `{ endExclusive: number }`. `endExclusive` must pass `Number.isSafeInteger`. Its start is `cursor`; the range must be nonempty, within `entryCount`, and at most **256** entries. `complete` requires cursor equal to entryCount and pending null.
- Schema 1 continues accepting only its existing numeric singleton pending value equal to cursor. It represents the range `[cursor, cursor + 1)`.
- Inventory/proof and transaction schemas stay unchanged. Never remove ownership, hash, ancestry, quiescence, lease, expected-target CAS, or confirmed-native-close checks.
- No recursive deletion, background mutator, verification-result cache, native protocol change, or manual edits to any native QA/profile/candidate/journal.
- `maxDeletes` remains a hard bound on actual unlink/rmdir operations; already absent authorized entries consume none.
- Existing real instances and a1 evidence remain excluded. Only the normal isolated b1 app can supply native acceptance; inert tests are supplemental.
- Root owns index/commits, full-package/build gate, and native UI. Implementer has no subagents and no profile or app access.

## Review Focus

1. All-absent pending replay must still flush the full deterministic boundary, including outer parent after root disappearance (Task 1 replay tests).
2. Schema-1 cursor 85 must not silently authorize a wider batch; null and numeric-pending paths both migrate safely (Task 1 legacy tests).
3. A tiny resumed deletion budget must make eventual progress through a previously larger pending range without exceeding its limit (Task 1 budget tests).
4. Cross-depth batches need every surviving parent, not just a topmost/common ancestor, and must stop on swapped boundaries (Task 1 boundary tests).
5. Write-then-reject CAS and partial native flush must not advance local authority or lose safe restart evidence (Task 1 uncertainty tests).

---

### Task 1: Implement and prove bounded cleanup ranges

**Files:**
- Modify: `electron/services/client-modpacks/client-pack-transaction.cjs` (cleanup intent validation, remainder proof, missing-aware ancestry, bounded deletion and flush loop only).
- Modify: `tests/client-modpacks/client-pack-transaction.test.cjs` (reuse its actual temporary filesystem fixture and durable-fs boundary; add focused regressions and narrowly update old barrier/schema expectations).
- Optional only if an existing integration test's durability double lacks the already-public batch method: update that exact test utility and report its path/reason before editing. Do not change production service/composition/router contracts.

**Interfaces:**
- Keep public `cleanup(target, { isQuiescent, maxDeletes = 20000, maxOperations = 8 })` result shape `{ completed, retained, pending, incomplete }` unchanged.
- Consume existing `durableFs.readFileBoundedAsync`, `writeJsonAtomicAsync(...,{expectedTargetSha256})`, `flushDirectoryAsync`, and `flushDirectoriesAsync(paths)`. The last method already validates/pins individual boundary identities through the production wrapper/native helper.
- `_cleanupIntent` accepts exactly v1 singleton or v2 bounded range, preserving all other strict fields. Add private range/boundary helpers within this class as needed; no new public API or module.
- `_deleteCleanupEntry` must distinguish actual deletion from authorized absence and budget exhaustion without weakening ancestry/content checks; only successful unlink/rmdir decrements budget. Any unexpected read/stat/probe error retains rather than pretending absence.
- New progress writes use schema 2. Existing v1 complete markers need no conversion. Existing v1 pending singleton must settle as a singleton before any new larger range is persisted.

- [x] **Step 1: Add regression tests and observe genuine RED before product edits.** Use hand-derived fixtures, actual files and reopened transaction objects. Failure cases must assert unchanged live client files and retained authority, not merely thrown mock calls. Cover these assertions:

  - A 520-file abandoned candidate cleans in ranges of at most 256, with one persisted pending write, one complete boundary flush and one cursor-advance write per range. No durable publication per deleted entry. Same protocol cleans a committed previous tree while preserving the current live saves/configuration.
  - Build valid v1 histories at literal cursor 85 with pending null or numeric 85. Numeric pending allows only index 85's absence until its flush/cursor commit. Verify subsequent v2 batch progress and unchanged record/proof bindings; v1 complete/compacted and no-candidate markers stay compatible.
  - Invalid v2 endpoints `{endExclusive:0}`, negative/reversed, fractional, unsafe integer, larger than count, width 257, extra keys, wrong pending type/schema refuse without unlink/checkpoint rewrite. Cover nonfinite values through the validator seam if representable; malformed persisted JSON remains refused.
  - Inject failure before/after pending CAS, after selected deletions, during a partial boundary flush, before/after cursor CAS, and before terminal marker/compaction. Reopen and prove the correct state; unconfirmed operations are never counted complete.
  - All-absent and mixed/nonprefix-absent pending batches must flush the same expected boundary set as uninterrupted processing. Missing entries outside the range, resurrected entries before cursor, unexpected members and substituted/modified/link entries retain.
  - Cross-depth pending range includes descendants and their removed parent. Missing in-range ancestor is tolerated without traversing it; missing/out-of-range/substituted ancestor is refused. Final root-only and whole-final-suffix absence flush exact outer parent.
  - A batch with a surviving child directory and its surviving ancestor flushes both when each directly contains a removal. Boundary substitution before or after flush cannot advance cursor.
  - Resume a larger pending range repeatedly with `maxDeletes:1`; each invocation deletes at most one entry, absent entries use no budget, and trailing absent entries permit final flush/advance after budget reaches zero.
  - Preserve no-intent/already-absent-root completion after full settled ownership/quiescence/outer-parent proof, no deletion; preserve no-quiescence retention and operation budget/historical cleanup behavior.

- [x] **Step 2: Run focused new tests and retain RED output.** Command: `node --test --test-name-pattern="cleanup batch|cleanup v1|cleanup range" tests/client-modpacks/client-pack-transaction.test.cjs`. New test names must use these prefixes. Expected failures must identify missing batching/range behavior, not syntax/fixture errors. Existing passing safety controls are not RED.

- [x] **Step 3: Implement the spec algorithm in the class.** Use indexed proof membership to calculate authorized missing range and deterministic boundary set. Persist pending before any delete. Traverse existing ancestors root-to-leaf; only ENOENT at a same-range ancestor permits a skipped absence. Derive boundaries from the entire persisted range, deduplicate exact paths but never collapse nested surviving parents; validate before and after one batch flush. CAS-advance only after the whole range is absent and flushed. Retain any failed/uncertain operation for fresh restart proof. Preserve final absence, outer-parent flush, terminal marker and compaction sequence.

- [x] **Step 4: Run GREEN and full affected tests.** First the focused command, then `node --test tests/client-modpacks/client-pack-transaction.test.cjs`. Report exact counts, skips and all diagnostics. Do not run the root full package/build command or unrelated slow suites. Keep original RED evidence if an existing test needs an intentional schema/barrier assertion update. The final terminal-schema amendment received focused RED/GREEN and the root's complete final-source npm gate, rather than a third overlapping heavy transaction run.

- [x] **Step 5: Self-review and freeze.** Save full report, raw logs and scoped diff in this plan's `.superpowers/sdd` workspace. Record SHA256 of both changed files, list exact assumptions and limitations. Send root DONE/DONE_WITH_CONCERNS with report path. No commit/index operations. Root dispatches independent spec/quality review and resolves every important finding before the next step.

### Task 2: Bound async native flush frames by actual bytes

**Files:** Modify `electron/utils/windows-durable-fs-client.cjs`; test in `tests/windows-durable-fs-async.test.cjs`. Preserve the independently frozen verifier-reuse changes in that same product file.

**Interfaces:** Keep `flushDirectoriesAsync(directoryPaths, expectations)` and existing native request schema unchanged. Consume exported `MAX_FRAME_BYTES` (1,048,576) and `encodeFrame` from the existing archive-worker module, with all current validated path/identity/root/count constraints. No transaction, public API, native worker, or synchronous flush changes.

- [x] **Step 1: Add genuine RED tests** exercising this production method: valid long/multibyte paths whose combined native request exceeds 1MiB split into individually valid nonempty requests; every requested directory appears exactly once and only its captured identity accompanies it. Preserve one request for small inputs. An unfit singleton/root envelope must fail before any native spawn; all partitions must be known feasible before first dispatch. First/later native failure stops later chunks and never retries smaller; await confirmed-close policy when configured. A changed directory/root detected by final revalidation must refuse. Use actual inert filesystem fixtures and simulate only the native process boundary where necessary; do not assert source text or introduce public test-only helpers.
- [x] **Step 2: Run `node --test --test-name-pattern="flush frame" tests/windows-durable-fs-async.test.cjs` and retain expected behavioral RED.** New test names use this prefix; distinguish preexisting passing controls and setup errors.
- [x] **Step 3: Prepartition the already validated full directory request set in the async client.** Use the actual serialized JSON UTF-8 byte count, including full allowed-root/identity envelope, not guessed headroom or character count. Reject unfit input before any invocation. Execute partitions sequentially under unchanged per-request fresh verification and native close policy. Keep existing final all-directory/root validation. No fallback/retry after a native error and no mutation-authority caching.
- [x] **Step 4: Run focused GREEN then both affected files:** `node --test tests/windows-durable-fs-async.test.cjs tests/windows-durable-fs-verifier-reuse.test.cjs`. Preserve raw output/counts. Full package/build remains root-owned.
- [x] **Step 5: Self-review, freeze and hand off independent review** with report/diff/hash in this plan workspace; no commit/index actions. Do not count this as native cleanup or power-loss acceptance.

### Task 3: Root integration and normal-app acceptance

**Files:** Update `docs/testing/modpack-release-checklist.md`; plan workspace only for temporary benchmark/evidence. No new product feature.

**Interfaces:** Consume Tasks 1 and 2's frozen changes plus reviewed verifier transport/recovery indicator. No fallback to direct APIs for user-flow acceptance.

- [x] **Step 1: Run a small actual-Windows inert cleanup benchmark.** Use the real checked-in worker, real reparse inspector and production durable-fs stack with one uniquely created temp tree (for example 520 tiny files with nested directories). Record preparation separately from cleanup, completed outcome, exact batch request counts and elapsed time. Confirm teardown targets stay within the generated temp root. Do not point this at b1 or any existing profile. Report structural/synthetic results separately from native app acceptance.
- [x] **Step 2: Freeze source, run `npm test`, `npm run build`, and the complete matching-client panel test file once.** Read full logs, identify skips and unexpected failures, preserve unrelated user edits. Independent source review can overlap the frozen run; findings that change source invalidate affected gates. Do not count interrupted commands as passes. Final gate: 4,965 pass / 8 documented platform skips / 0 failures; build and 68/68 matching-client panels passed on unchanged source.
- [ ] **Step 3: Commit only reviewed scoped task paths and documentation locally.** No push/release or unrelated user changes. Keep native-unpassed caveats explicit.
- [ ] **Step 4: Reopen ordinary `npm run dev` using only the existing isolated b1 user-data override.** Expect approved same-operation cleanup to resume automatically before the main window; observe actual progress/checkpoint and normal UI when ready. Preserve the original failed candidate/journal until app-owned cleanup completes. Do not launch another cleanup or manually alter its data.
- [ ] **Step 5: Continue normal matching-client Review/Install/Verify/reopen, then authentication and real join as authorized and possible.** Windows action-time installation confirmation and user-only authentication/security handoffs still apply. No actual install/join pass until observed. Keep the larger release checklist open for all other remaining tests.

## Plan self-review and execution

Task 1 owns the coupled persisted protocol/fault tests; Task 2 owns exact native-frame sizing behind an unchanged interface, and Task 3 owns root integration/acceptance. No overlapping writers. All five review-focus conditions map to concrete Task 1 tests; long/multibyte framing and partial failure are pinned by Task 2. No changed public service/IPC/native interface. Root preserves the existing `codex/verify-modpacks-client-packs` checkout to avoid earlier wrong-checkout confusion, with exact scoped staging and three protected unrelated files unchanged. The user delegated plan review/implementation; root reviewed this plan against the specification and selects subagent-driven execution without another approval prompt.
