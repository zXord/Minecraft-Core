# Task 33 - Packaged modpack release gates

Date: 2026-08-07

## Outcome

The modpack feature is implemented across setup, management, persistence, recovery, archive handling, notifications, and Windows packaging. Task 33 turns that implementation into mandatory Windows x64 release gates: the release workflow builds the pinned native archive worker, runs the complete regression/modpack/failure/Electron suites, creates a clean unpacked application, verifies and smokes it, creates the installer, repeats the packaged verification and smoke against the final payload, and binds `latest.yml` to one exact installer.

This report records the completed clean release-gate sequence for the final source and Windows x64 payload.

## Product scope delivered

- Server setup can keep the existing Empty/Custom flow or install a modpack from an exact Modrinth version, an explicit public GitHub release and reviewed asset set, or a one-use local archive selection.
- GitHub Releases supports MRPACK, ZIP, RAR, and multipart RAR assets, explicit asset selection, remembered asset-pattern review, republish/change detection, release tracking, and persistent actionable notifications. No action silently selects `latest` or installs directly from a notification.
- Modpack management supports install on a new or existing server, update, guarded downgrade, source switch, verify, targeted repair, restore-point rollback, detach, and managed-file uninstall. Targeted repair reacquires only missing or mismatched managed files.
- Active state, ownership, operation history, release tracking, notifications, restore points, job transitions, and recovery records are durable. Detach keeps server content and disables active ownership/tracking; uninstall preserves user-owned and modified content and can leave a files-only instance.
- Modrinth/GitHub/local review presents integrity, runtime, ownership, conflicts, changes, and preservation decisions before execution. CurseForge is labelled **Unavailable** and makes no delivery-date promise.
- Fabric, Forge, NeoForge, Quilt, and loaderless/vanilla runtime paths are represented by exact planned runtime identities and validated health gates.

## Safety and data-preservation model

- Renderer requests cross schema-validated IPC using stable instance IDs, exact provider/release/asset IDs, opaque plan/selection references, and plan fingerprints. Renderer-provided server paths, archive paths, executable paths, and reusable download URLs are rejected.
- Remote acquisition accepts only public HTTPS destinations and revalidates credentials, hostname, DNS results, connected peer, redirects, byte limits, and calculated SHA-256/SHA-512 identities. Persisted lifecycle state contains no source URL or cache path.
- Untrusted archives are magic-bound, completely preflighted, bounded by entry/size/depth/ratio/output/time/disk limits, extracted to an empty application-owned directory, post-walked, and never allowed to execute pack-provided scripts, executables, bootstrap JARs, or installers. Encrypted/password-protected content fails without prompting.
- Archive execution is brokered by the self-contained Windows x64 `ArchiveWorker` through a zero-capability AppContainer and constrained Job Object. Its self-test proves input/output ACL boundaries, ambient/user-data/temp/network denial, descendant containment, closed standard input, bundle-extraction isolation, survivor cleanup, ACL cleanup, and clean profile teardown. Failure to establish every property fails closed.
- Every existing server writer and launch path shares the mutation coordinator and content-revision boundary. Plans become stale when the server revision or touched content changes; concurrent launches/mutations are blocked.
- Existing-server mutations build and health-check a complete sibling candidate before a durable two-rename swap. A verified pinned restore point and untouched rollback sibling protect the prior state. Worlds, user-added mods/configuration, and modified managed files follow explicit ownership/preservation rules.
- Recovery records directory identities, fingerprints, phases, and swap steps durably. Startup recovery runs before IPC, cleanup, auto-restart, or any launch. Ambiguous state remains blocked as `RECOVERY_REQUIRED`; healthy committed state is not rolled back merely because cleanup must be retried.

## Closed packaged archive runtime

The release payload contains only the architecture-filtered archive closure under `resources/archive`: pinned 7-Zip binaries, licenses/notices, manifests, and one self-contained worker. Packaged resolution cannot use repository `vendor` files, `PATH`, a system 7-Zip installation, the fixture composition, or development-server state. `app.asar` is checked for required production modules and rejected if it contains nested builder output such as `dist/win-unpacked`.

Pinned resource identities:

| Resource | Size | SHA-256 |
| --- | ---: | --- |
| 7-Zip 26.02 x64 MSI input | 1,999,872 bytes | `db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e` |
| `7z.exe` | 576,000 bytes | `83967f1b02b43c4efeda302795722c809e0e81b8307de73558d10484d5676a7d` |
| `7z.dll` | 1,906,688 bytes | `69fd4df057985c40e510e2fac182881c7f85e90aa13ec703f763a8fdb2ce61f8` |
| `License.txt` | 6,031 bytes | `519ac0a4bded9c18ea02e0afb71f663d8c47373bd9facd3ac96a79f51d77765d` |
| `ArchiveWorker.exe` | 67,744,371 bytes | `8a7653cfbfece23e2ad6dcd62584021309ce5df0c91e0a76212c3ae1e7d32489` |
| `archive-worker-x64.json` | 481 bytes | `bded48a2a3870835cfd77e4f8837f26db8929530e1f5e3b32d13b7ec34c19891` |

The worker manifest binds `win-x64`, `net8.0-windows`, and .NET SDK `10.0.204`. The runtime verifier reports 7-Zip `26.02`, x64 architecture, and both ZIP and RAR handlers.

## Packaged smoke evidence and evidence layers

The smoke output is a closed JSON contract. It rejects extra fields, unsafe/path-bearing data, malformed hashes, incomplete coverage, any fallback, or an unexpected evidence layer.

### Packaged production evidence

The packaged observer launches `dist/win-unpacked/Minecraft Core.exe` with an isolated user-data directory and sanitized environment. It proves the renderer loaded, `app.isPackaged === true`, production composition was selected, the fixture factory was disabled, `PATH` remained sanitized, and no public-network request occurred.

The real packaged `ArchiveWorker` and packaged 7-Zip resources directly inspect/extract:

| Case | Expected packaged outcome |
| --- | --- |
| MRPACK | accepted as ZIP-family content |
| ZIP | accepted |
| ZIP64 | accepted |
| RAR4 | accepted |
| RAR5 | accepted |
| RAR4 `.partN.rar` | accepted as a complete multipart set |
| RAR5 `.partN.rar` | accepted as a complete multipart set |
| encrypted ZIP entry | rejected with `ENCRYPTED_ARCHIVE` |
| incomplete multipart RAR | rejected with `MULTIPART_VOLUME_MISSING` |
| traversal entry | rejected with `UNSAFE_ARCHIVE_ENTRY` |

The packaged verifier separately requires the complete containment self-test and reports `containment: passed`, ZIP/RAR handlers enabled, and `fallbacksUsed: []`.

### Deterministic non-packaged evidence

The following evidence is intentionally labelled `non-packaged-test-composition`; it does not claim that deterministic provider/lifecycle fixtures were injected into the production packaged application:

- `.rar` plus `.rNN` and numbered-volume RAR grouping/download/materialization are accepted by the deterministic source engine.
- encrypted RAR headers are rejected with `ENCRYPTED_ARCHIVE` by deterministic engine evidence.
- create, update, verify, targeted repair, and detach complete successfully; one canonical server remains, durable history survives relaunch, ownership transitions are recorded, and unmanaged files are preserved.
- recovery is exercised at `before-live-rename`, `between-renames`, and `after-candidate-rename`; startup remains blocked until reviewed recovery, exactly one canonical server remains, and a second launch proves recovery idempotence.

This layer boundary is deliberate: packaged evidence proves the production application/composition and native archive security boundary; deterministic Electron composition proves repeatable offline lifecycle and crash/recovery behavior without permitting fixture services in a packaged process.

## Evidence captured before the final clean sequence

- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-archive-worker.ps1` passed in 37.2 seconds. The output identity is the worker recorded above.
- `npm run verify:archive-runtime` passed in 4.7 seconds with 7-Zip 26.02 x64 and ZIP/RAR handlers.
- `node --test tests/modpacks/archive-worker-containment.test.cjs` passed: 26 tests, 26 passed, 0 failed, in 57.3 seconds.
- The focused archive-inspector and packaged-release-gate run passed: 21 tests, 21 passed, 0 failed.
- The latest complete repository baseline before the final native/parser/environment fixes passed: 1,319 tests, 1,316 passed, 3 skipped, 0 failed. A fresh final run is recorded below.
- A patched unpacked-payload diagnostic smoke passed in 269.2 seconds with containment passed, all required archive cases, zero fallbacks, sanitized packaged composition, lifecycle results, and all three recovery points. This is diagnostic evidence only; the clean post-`pack` and post-`dist` smoke results below are authoritative.

## Final release-gate results

Environment: Windows x64; local Node.js `24.14.1`; CI pins Node.js 22 and .NET SDK `10.0.204` on Windows x64.

| Gate | Final result |
| --- | --- |
| `npm run verify:archive-runtime` | Passed; 7-Zip 26.02 x64, ZIP/RAR handlers. |
| `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-archive-worker.ps1` | Passed; 67,744,371-byte worker, SHA-256 `8a7653cfbfece23e2ad6dcd62584021309ce5df0c91e0a76212c3ae1e7d32489`. |
| `npm test` | Passed; 1,325 total, 1,322 passed, 0 failed, 3 skipped; 83.8 seconds. |
| `npm run test:modpacks` | Passed; 990 total, 987 passed, 0 failed, 3 skipped; 83.1 seconds. |
| `npm run test:failure-matrix` | Passed; 2 total, 2 passed, 0 failed, 0 skipped; 1.1 seconds test time. |
| `npm run build` | Passed; 3,789 modules transformed; Vite completed in 21.3 seconds. |
| `npm run test:e2e:modpacks` | Passed; 16 of 16 with one worker; 1.2 minutes. |
| `npm run pack` | Passed in 125.3 seconds; icon/metadata embedding succeeded. |
| `npm run verify:packaged-archive` after `pack` | Passed in 20.7 seconds; 7-Zip 26.02 x64 and containment passed. |
| `npm run smoke:packaged:modpacks` after `pack` | Passed in 241.0 seconds; containment passed, zero fallbacks, sanitized production composition, complete archive/lifecycle/recovery evidence. |
| `npm run dist` | Passed in 170.0 seconds; installer and blockmap created and icon/metadata embedding succeeded. |
| `npm run verify:packaged-archive` after `dist` | Passed in 20.7 seconds; 7-Zip 26.02 x64 and containment passed. |
| `npm run smoke:packaged:modpacks` after `dist` | Passed in 249.1 seconds; containment passed, zero fallbacks, sanitized production composition, complete archive/lifecycle/recovery evidence. |
| Exact artifact-binding block from `.github/workflows/release.yml` | Passed; exactly one `Minecraft-Core-Setup-26.6.1.exe`, one matching blockmap, and `latest.yml`; calculated installer SHA-512 `B5c3HBnHuNOUJcUSV0KbZQOUKZhztgNueqMhXla5sPXqhkp1NjcFTEa6zaqCOGq2eEzaTXXqJEyKVlksqBVlBw==` matched the exact version/name/download entry. |
| Feature/release ESLint gate | Passed with zero findings for the packaged archive, smoke, harness, and late archive-inspector surfaces. |
| `git diff --check` and final source/output audit | Passed. Working and cached diff checks were clean (line-ending conversion notices only); 290 intentional files were staged; no `dist`, `test-results`, native `bin`/`obj`, `.tmp`, dependency, user-data, scratch, or recovery-runtime output was staged. Feature-scoped TODO/TBD/not-implemented/Coming-Soon scan was clean except its deliberate negative-copy assertion. Six URL/secret-pattern hits were manually allowlisted as one URL-validation regex and five redaction/network test fixtures using `example.invalid` or the public Modrinth API test URL. |

## Final artifact identities

Version: `26.6.1`

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `dist/win-unpacked/Minecraft Core.exe` | 232,649,216 bytes | `fc065ae9a4488cad58df0b7a8ede2a28d6e05aeaf6228ebe4e888a756c06ba6e` |
| `dist/win-unpacked/resources/app.asar` | 385,384,531 bytes | `96d5349a645a88643d5d27b089c775a4441f66d8abe244b0dd5725f785883a29` |
| `dist/Minecraft-Core-Setup-26.6.1.exe` | 149,845,667 bytes | `bcd82932b2b18f02b38a78642ba1b8481a0de2866469a73b34190a515932840c` |
| `dist/Minecraft-Core-Setup-26.6.1.exe.blockmap` | 155,560 bytes | `d22c30d83335e8f8868ad069ec7a201c7d1aeacf3844f9a07bddc9675c0fdf87` |
| `dist/latest.yml` | 360 bytes | `f441d12bcb06c2d837b985b2d5c2828eaac88b73b3b458210e41fd0f2f6d87b5` |
| final packaged `ArchiveWorker.exe` | 67,744,371 bytes | `8a7653cfbfece23e2ad6dcd62584021309ce5df0c91e0a76212c3ae1e7d32489` |
| final packaged `archive-worker-x64.json` | 481 bytes | `bded48a2a3870835cfd77e4f8837f26db8929530e1f5e3b32d13b7ec34c19891` |

The final `app.asar` contains 11,736 entries. It contains `electron/main.cjs`, `archive-runtime-verifier.cjs`, and `archive-worker-client.cjs`; nested builder-output entry count is zero. Task reports are not included in the application archive.

The release workflow accepts exactly one installer, its exact blockmap, and `latest.yml`. It calculates the installer SHA-512 and requires `latest.yml` to bind the exact version, installer filename, download entry, and SHA-512 before publishing any release asset. `dist/`, user data, caches, partial files, native build output, recovery scratch, and packaged artifacts remain untracked.

## Release conclusion

All executable release gates and the final staged-tree audit passed for the final Windows x64 payload. Generated `dist/` output remains ignored and is not part of the commit.
