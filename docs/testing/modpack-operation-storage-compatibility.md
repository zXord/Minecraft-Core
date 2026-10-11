# Modpack operation storage compatibility

Status: production composition explicitly opts in to new-server v2 creation after joint Task 4 implementation review, the root's pre-rollout deterministic gate, and explicit root rollout authorization at source checkpoint `36c23ec`. Primitive constructor defaults remain disabled. The root's combined enabled-wiring gate and native acceptance remain separate requirements under `../superpowers/plans/2026-10-11-new-server-launch-reconciliation.md`; this source opt-in does not certify release readiness.

## What changes

New `install-new` and `import-files-only-new` operations may use a private v2 operation record. It binds the reviewed plan to one destination reservation and records whether that destination is held, released, or consumed. Public job responses remain v1; private paths, reservation evidence, and binding data are not added to UI responses.

Existing v1 records stay v1. There is no bulk rewrite or migration of old history. Unknown-origin interrupted v1 jobs are not automatically declared safe to release; they retain the applicable support/recovery state.

## Application rollback is not modpack rollback

Once a profile contains v2 records, a binary that only understands v1 cannot safely initialize that operation store. Successful modpack downgrade or restore-point rollback does not convert these records back to v1. Turning off new v2 creation also does not convert records already written.

- Keep using a compatible application build for a profile containing v2 records.
- Never edit schema versions/checksums, remove operation records, delete recovery evidence, or point an older build at the profile to force it to open.
- Preserve the complete profile and affected instance data before any application migration. If returning to an older binary is essential, use a separately preserved, internally consistent pre-upgrade profile **and** instance backup, with all related app/server/client processes stopped and no unresolved operation. Restoring only the profile can contradict newer server files and is not a supported shortcut.
- A clean isolated profile may be used to evaluate an older build, but it must not be attached to instances still owned by the newer profile. It is not recovery of an existing operation.

Normal version changes and recovery should use the compatible app's reviewed modpack controls. An uncertain Start response is reconciled against the recorded operation; it must not be resolved by deleting journals or repeatedly starting the same setup.
