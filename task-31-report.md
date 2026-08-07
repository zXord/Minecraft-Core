# Task 31 - Electron modpack E2E report

Date: 2026-08-02

## Delivered

- Pinned `@playwright/test` exactly to `1.62.1` and added the required one-worker `test:e2e:modpacks` script.
- Added a one-worker Playwright configuration with bounded timeouts, retained failure traces, and failure-only screenshots.
- Added a real Electron harness that runs the built renderer, production preload, registered IPC schemas/handlers, and isolated per-scenario user data while injecting deterministic offline services only into unpackaged test composition.
- Added setup, lifecycle, recovery, and accessibility specifications covering 16 product-level tests.
- Added a production-only packaged observer and a separately labelled `non-packaged-test-composition` lifecycle evidence helper for Task 33. The packaged observer never enables the fixture factory.
- Made the test composition seam fail closed whenever `app.isPackaged` is true. Packaged runtime flags, recovery factories, service factories, and IPC overrides cannot be activated by caller-provided test environment flags.

## Product coverage

- Setup: unchanged manual setup; effective `install-new` for an empty pre-reserved target; Modrinth exact versions; GitHub MRPACK, ZIP, RAR, multipart, no uploaded asset, missing digest, ambiguity, client-only, encrypted, changed asset set, files-only, remembered asset pattern, accepted Modrinth-linked GitHub repository; local registered selection; cancellation; exact CurseForge unavailable copy.
- Lifecycle: existing-server install, update, blocked and safe downgrade, source switch, verify then targeted repair, exact restore-point rollback, detach, uninstall, files-only outcome, durable history, opaque outcome actions, persistent notifications, prior running/stopped restoration, and preservation of user mods/config/world data.
- Recovery: process kill at `before-live-rename`, `between-renames`, and `after-candidate-rename`; blocked planning after relaunch; reviewed recovery; exactly one canonical server; user-file preservation; second-launch idempotence.
- Accessibility: keyboard-only source/project/version path; stage, assertive-error, and terminal-result focus; destructive-dialog default Cancel, focus trap, Escape, and focus restoration; polite progress announcements; visible disabled explanations; textual/non-color states.

## E2E-discovered fixes

- A completed opaque outcome action returned to the Modpack dashboard without refreshing durable state. The route now clears transient job state and refreshes the durable state.
- Management plan blockers were hidden and Start remained enabled. Blockers are now visible, Start is disabled, and the handler also guards execution.
- Keyboard flow changes did not move focus to the new stage, and assertive page errors were not focused. `ModpackPage` now centralizes stage and error focus; terminal focus remains owned by `ModpackJobProgress`.
- Schema authority scanning rejected the schema-defined `selections.conflictChoices.paths` structure. The exact nested map is accepted while top-level, sibling, absolute-path, and other renderer path authority remain rejected.

## Verification

- `npm run build` - pass; Vite transformed 3,789 modules.
- `npm run test:e2e:modpacks` - pass; 16 passed, 0 failed, one worker, 53.7 seconds.
- `node --test tests/test-modpack-composition-loader.test.cjs tests/main-bootstrap.test.cjs tests/modpacks/ipc-schemas.test.cjs tests/modpacks/modpack-management-renderer-contract.test.cjs tests/modpacks/modpack-accessibility-contract.test.cjs tests/modpacks/modpack-setup-renderer-contract.test.cjs` - pass; 39 passed, 0 failed.
- `node -e "require('./tests/e2e/fixtures/modpack-harness.cjs').runDeterministicModpackLifecycleEvidence()..."` - pass; create/update/verify/repair/detach, durable history, three recovery boundaries, RAR RXX, numbered volumes, and encrypted-header evidence completed in 32.7 seconds.
- `npm ls @playwright/test --depth=0` - `@playwright/test@1.62.1`.
- `git diff --check` - pass; line-ending conversion warnings only.
- `npm test` - repository-wide run completed with 1,231 tests: 1,226 passed, 2 failed, 3 skipped. Both remaining failures are archive/package gates outside Task 31: packaged manifest verification returned `EXTRACTOR_UNAVAILABLE`, and the sevenzip SLT missing-volume case returned invalid technical-listing classification instead of `MULTIPART_VOLUME_MISSING`.

No files were staged or committed by Task 31.
