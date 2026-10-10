# Bounded, crash-resumable matching-client cleanup

## Intent and evidence

The user wants the official TFG 0.13.4 matching client installed and tested through the normal app, without touching real instances. An approved native recovery settled its disposable transaction but cleaned only 85 of 14,610 entries in about six minutes. Recovery and app initialization await this cleanup. The existing protocol makes two durable cursor writes plus one native parent flush per entry. Reusing only the verifier's read-only probe transport improves measured warm native flushes from about 1.6 seconds to 0.37 seconds, but roughly 43,830 requests remain unacceptable. This is an architectural batching correction, not removal of validation or a native acceptance claim.

## Decision

Retain the existing transaction ownership, full immutable inventory proof, per-entry identity/content/ancestry checks, quiescence requirement, mutation lease, write-through checkpoint CAS, and fail-closed retention. Amortize only durable barriers over an explicitly recorded, bounded pending range. Do not introduce a background mutator, native persistent writer, verification-result cache, or new authority outside the already owned retained candidate/previous tree.

Alternatives considered: inspector reuse alone remains hours-long; a persistent native writer still changes process lifetime/protocol and retains executable hashing on every request; untracked background cleanup would obscure mutation ownership and move the delay elsewhere. Batching gives a bounded, persisted explanation for every possibly absent entry and uses the already existing directory-flush batch interface.

## Persisted contract and compatibility

- Inventory/proof and transaction schemas stay unchanged. Cleanup intent schema 2 keeps the same exact top-level fields as schema 1.
- In schema 2, `pending` is either null or an exact plain object `{ endExclusive: number }`. `endExclusive` must pass `Number.isSafeInteger`. Its start is `cursor`; the range must be nonempty, within `entryCount`, and at most **256** entries. `complete` requires cursor equal to entryCount and pending null.
- Schema 1 continues accepting only its existing numeric singleton pending value equal to cursor. It represents the range `[cursor, cursor + 1)`. A schema-1 complete marker is accepted without rewriting its compacted proof. A valid in-flight singleton is completed without widening its authority; subsequent newly written progress can use schema 2.
- All existing exact ownership fields, hashes, path constraints, parent/root identities, entry limits and source record binding remain mandatory. Invalid or unknown versions/ranges retain data; never reset or reinterpret them permissively.
- Before initial deletion or restart, prove the full remaining tree. Missing entries are allowed only inside the persisted pending range; all other remaining entries must exist unchanged. Unexpected entries, changed content/identity, hard links, symlinks/reparse points and substituted parents retain the tree.
- A missing retained root is permitted only when the complete remaining suffix is covered by a pending range ending at entryCount, or when a completed cursor already proves it. This does not authorize deleting a replacement root.
- Preserve the existing no-intent/already-absent-root completion path: with a validated settled record/proof, proven quiescence and exact outer parent, it performs no deletion, flushes the outer parent and writes completion. Do not generalize this exception to an existing contradictory intent.

## Batch algorithm

1. Read and validate record, proof, optional cleanup intent, quiescence and full remaining tree as today. Maintain indexed inventory lookup; do not repeatedly search or serialize the entire proof per entry.
2. If no pending range exists, choose the next at most 256 entries, also limited by the remaining deletion budget. Persist that pending range durably with expected-target hash CAS **before any deletion**.
3. Process entries in the existing descendant-before-parent order. Each present entry still receives the existing native identity, file hash, hard-link/reparse and ancestry checks immediately around the single unlink/rmdir. Do not use recursive deletion. An absent entry may be skipped only within the recorded pending range. A missing ancestor can be tolerated only if that ancestor is itself in the same pending range; check every existing ancestor before reaching it, and do not traverse past it. The immutable inventory order must prove no still-required descendant is skipped.
4. Compute the surviving boundary directories from **every inventory member of the persisted pending range**, including members already absent on restart (never only this invocation's successful deletions). For each member, walk its parent upward past directories included in this same range, stopping at the first directory outside the range. The retained root's parent is the recorded client parent. Deduplicate; at most 256 directories result. Do not collapse distinct nested surviving boundaries to their common ancestor: flushing a parent is not recursive. All these directories must still match the proof's native identities (or the recorded outer-parent identity), with safe ancestry, before and after flushing. They are never themselves deleted in this batch. An all-absent replay still flushes this complete boundary before cursor advancement.
5. After every entry in the pending range is absent through exact deletion or approved interrupted absence, await **one `flushDirectoriesAsync`** for the surviving boundary directories. Only after successful flush and fresh boundary validation durably advance cursor to endExclusive and clear pending using CAS. Preserve publication uncertainty by retaining intent and stopping on any failed/unknown write or flush outcome.
6. Continue until budget exhaustion or completion. `maxDeletes` remains a hard bound on actual unlink/rmdir operations during the invocation. Skipping already absent pending entries does not consume that budget. If the budget ends midway through an existing range, return pending with the original range intact and no cursor advancement; a later invocation re-proves the remainder and finishes it. Allow read-only examination of trailing absent members and the final flush/checkpoint even when the last permitted unlink exactly exhausts the budget. Never repeatedly spend the budget on already absent entries without making progress.
7. Final root absence, outer-parent durability, terminal marker and proof compaction remain mandatory. Do not mark completion or forget runtime ownership before this succeeds.

For N entries, durability requests become approximately three per 256-entry batch rather than three per entry. Real filesystem scan, file hashing and checks remain. No fixed speed guarantee is inferred from this count.

## Scope and UI

This correction is within `ClientPackTransaction` plus focused tests; the existing production router already exposes `flushDirectoriesAsync`. Update test utilities only where they need to exercise that real boundary. Do not alter recovery/service IPC cancellation, detach cleanup, suppress cleanup on startup, or change authentication/installation authority. The separately developed renderer-only recovery working indicator and verifier transport reuse remain independent changes. Normal startup still awaits cleanup; measure actual time on a real inert fixture before attempting the retained b1 operation again.

## Validation and acceptance

Use test-first actual inert filesystem fixtures with durable I/O boundaries instrumented, not text assertions. Cover new batches, both retained roles, exact v1 pending migration, no-candidate/complete/compacted markers, same-parent and cross-depth batches, root-only final batch, partial and nonprefix missing pending entries, deletion budget smaller than an existing range, restart at each durable boundary, invalid range/schema, unexpected disappearance outside the range, substitutions/content changes/reparse/hard-link cases, boundary-directory replacement, failed flush, failed/ambiguous CAS, quiescence and preservation of live saves/configuration. Assert request-count amortization and batch size independently of timing. Existing tests remain relevant and may require narrow expectation updates for intentional schema/barrier changes.

After independent source/design review and frozen full-suite/build gates, use the normal isolated b1 app and observe the same approved recovery checkpoint resuming automatically at startup. Never manually edit or delete its journal/candidate/proof. Record real duration and final UI/status separately from synthetic tests. Matching-client Install, Verify, authentication and join are still separate unpassed acceptance gates.

## Delegated review

The user explicitly instructed the agent to review plans itself and implement without another design-approval request. Root owns specification/plan review and an independent design check before implementation. Any uncertainty that removes ownership or durability guarantees requires redesign, not weakened checks. Existing real instances and a1 evidence remain excluded.
