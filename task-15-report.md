# Task 15 - Injectable main-process composition root

## Scope delivered

- Added a frozen runtime-flag contract that honors `MINECRAFT_CORE_TEST_MODE=1` only when `NODE_ENV=test`, selects an isolated absolute `userData` directory, and disables updater, tray, watchdog, native notifications, and public management listeners in that mode.
- Added a frozen modpack service graph with injected app/store/window dependencies, paths and runtime roots, clock, DNS/HTTPS transport, filesystem APIs, random IDs, worker/process factories, provider adapters, artifact services, selection registry, server mutation coordinator, and IPC dependencies.
- Added a main bootstrap with explicit `initializeBeforeReady`, `onReady`, and `dispose` lifecycle boundaries. Startup completes recovery before cleanup, window creation, or any optional service launch, and fails closed when no recovery boundary exists.
- Refactored `electron/main.cjs` so runtime flags are evaluated before graph-dependent modules, production startup side effects are controller-owned, IPC receives the graph, and shutdown reverses started services.
- Refactored `setupIpcHandlers()` to consume the graph's store, filesystem, IPC helpers, handler factories, and mutation policy instead of reconstructing those dependencies internally.
- Kept mod-availability IPC registered in test mode while suppressing its native watcher.
- Preserved the existing production startup behavior for security handlers, certificate verification, menu removal, tray, window creation, updater checks, watchdog monitoring, browser-panel auto-start, last-server hydration, and cleanup.
- Exposed no modpack lifecycle IPC; startup recovery is the intentionally empty coordinator recovery pass until Task 22 supplies the real registry.

## TDD evidence

The first focused RED run was:

```text
node --test tests/main-bootstrap.test.cjs tests/modpacks/service-graph.test.cjs
```

It failed because both new bootstrap modules were absent. After the initial implementation, 6/6 focused tests passed.

Additional integration RED runs then demonstrated the boundaries before implementation:

- The real main entry called only `app.whenReady` and did not create/delegate to the graph and bootstrap.
- IPC used the fallback global store instead of the injected graph store.
- Native mod-availability startup ignored the disabled-watcher toggle.
- Main loaded graph-dependent modules before applying the isolated test-mode `userData` path.
- Bootstrap proceeded to window creation when no recovery boundary was injected.

Each failed for the intended assertion before the corresponding production change. The final focused run covered all of these regressions plus adjacent start-gate and writer-inventory behavior.

## Files owned by Task 15

- `electron/bootstrap/create-main-bootstrap.cjs`
- `electron/bootstrap/create-modpack-service-graph.cjs`
- `electron/bootstrap/runtime-flags.cjs`
- `electron/main.cjs`
- `electron/ipc-handlers.cjs`
- `electron/ipc/mod-availability-handlers.cjs`
- `tests/main-bootstrap.test.cjs`
- `tests/modpacks/service-graph.test.cjs`
- `tests/server-start-gate.test.cjs` (test fixture dependency surface only)

## Verification

```text
node --test tests/main-bootstrap.test.cjs tests/modpacks/service-graph.test.cjs tests/server-start-gate.test.cjs tests/mod-availability-watcher.test.cjs tests/server-content-writer-coordination.test.cjs tests/server-writer-inventory.test.cjs
```

Result: 37 tests, 37 passed, 0 failed, 0 skipped.

```text
node node_modules/eslint/bin/eslint.js electron/bootstrap/runtime-flags.cjs electron/bootstrap/create-main-bootstrap.cjs electron/bootstrap/create-modpack-service-graph.cjs electron/main.cjs electron/ipc-handlers.cjs electron/ipc/mod-availability-handlers.cjs tests/main-bootstrap.test.cjs tests/modpacks/service-graph.test.cjs tests/server-start-gate.test.cjs
```

Result: exit code 0 with no lint findings.

```text
npm run build
```

Result: exit code 0; Vite transformed 3,759 modules and the post-build logger asset injection completed.

```text
npm test
```

Result: 906 tests, 903 passed, 3 skipped, 0 failed.

## Handoff state

No files were staged or committed. Native ArchiveWorker work and Task 20 transaction files were not touched by Task 15.
