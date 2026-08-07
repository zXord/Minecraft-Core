# Task 22 - Startup transaction recovery

## Outcome

Implemented production startup recovery before any ordinary server launch, IPC exposure, cleanup, auto-restart listener, window, updater, tray, watchdog, notification listener, or public management listener. Recovery remains fail-closed globally until the registry is scanned and every discoverable record is either resolved or retained as an exact per-server/global block.

The implementation covers:

- pre-swap candidate cleanup without touching the original server;
- new-server publication reconciliation across `publishing`, `published`, and `registering`;
- existing-server repair across both durable renames and every rollback topology;
- full stop before filesystem rollback, identity-bound failed-live moves, source-runtime health validation, and prior running/auto-restart restoration;
- `committed-healthy` and `cleanup-pending` retry without rolling back a healthy canonical server;
- missing rollback reconstruction from one pinned, verified ZIP restore point into a fresh sibling;
- idempotent operation-journal and registry advancement after interrupted rollback steps;
- exact validated process handoff into the normal server-manager process state;
- activation/concurrent-ready startup paths that await the same recovery promise.

## Production composition

`create-modpack-service-graph.cjs` now lazily composes the real recovery registry, recovery service, health validator, runtime policy, state/runtime resolver, restore infrastructure, durable filesystem worker, registration/unregistration adapter, revision publisher, and runtime quiescence verifier. It caches one recovery composition and exposes no legacy empty `completeRecovery` escape hatch.

Legacy or pre-managed servers can derive a strict recovery runtime tuple from their validated server config. Source recovery searches the rollback/original topology before failed target content; target recovery searches the canonical/candidate topology first. Missing mod-loader versions or unsupported identities remain `RECOVERY_REQUIRED` rather than being guessed.

Task 26 still owns full `ModpackLifecycleService` composition. Its instance resolver must read the current `appStore` instances on every call and return the exact `{ instanceId, serverPath }`; it must reject duplicate IDs, duplicate path aliases, non-server entries, relative/root paths, and ID/path mismatch. This was deliberately not mixed into Task 22.

## Verified restore extractor

The recovery-only extractor is ZIP-only and binds extraction to pinned metadata:

- exact archive size and SHA-256;
- exact canonical expected scope and scope digest;
- no traversal, Windows aliases/reserved names/ADS/control characters, encrypted entries, symlink or reparse/link attributes;
- bounded entry count, per-file bytes, total bytes, and depth;
- complete preflight before destination creation;
- identity-owned staging directory, exclusive/no-follow file creation where supported, file close/fsync and directory flush;
- identity-bound cleanup on interruption;
- post-extraction exact scope comparison and full tree fingerprint.

## Test-driven evidence

Representative RED failures captured before implementation included missing recovery modules/extractor, IPC exposure using the legacy empty-recovery path, eager IPC module loading, activation bypass, no rollback journal transitions, interrupted rollback topology rejection, missing Task 21 handoff path derivation, and missing legacy runtime derivation.

Fresh scoped command:

```text
node --test tests/main-bootstrap.test.cjs tests/modpacks/modpack-recovery.test.cjs tests/modpacks/modpack-prior-runtime-state.test.cjs tests/modpacks/service-graph.test.cjs tests/modpacks/startup-recovery-order.test.cjs tests/modpacks/verified-restore-extractor.test.cjs tests/server-mutation-coordinator.test.cjs tests/server-start-gate.test.cjs tests/server-writer-inventory.test.cjs tests/auto-restart-start-request.test.cjs
```

Result: **80 tests, 80 passed, 0 failed**.

Fresh full repository test result:

```text
tests 1167
pass 1157
fail 7
skipped 3
```

All seven remaining failures are the not-yet-implemented Task 30 deterministic lifecycle harness/fault-matrix contracts: five full-provider harness tests report the harness factory as undefined, and two fault-matrix tests report the missing boundary injections/harness. No Task 22 test failed.

`git diff --check` reported no Task 22 whitespace errors (only existing LF-to-CRLF warnings on tracked Windows files), and the explicit scan of new Task 22 files found no trailing whitespace.

## Build status

Fresh `npm run build`: **passed** (`vite`: 3,789 modules, 15.48 seconds; post-build logger asset injection succeeded).

## Files owned by Task 22

- `electron/services/modpack-lifecycle/modpack-recovery-service.cjs`
- `electron/services/modpack-lifecycle/startup-recovery-bootstrap.cjs`
- `electron/services/modpack-lifecycle/verified-restore-extractor.cjs`
- `electron/bootstrap/create-main-bootstrap.cjs`
- `electron/bootstrap/create-modpack-service-graph.cjs`
- `electron/main.cjs`
- `electron/services/auto-restart.cjs`
- `electron/services/server-manager.cjs`
- `electron/services/server-mutation-coordinator.cjs`
- `electron/services/server-mutation-context.cjs`
- `electron/services/server-writer-inventory.cjs` (updated normalized write-site digest)
- the corresponding recovery, startup, coordinator, process-adoption, extractor, service-graph, and inventory tests listed above.

No files were staged or committed.
