# Task 10 report: exact NeoForge and Quilt runtimes

## Outcome

Implemented NeoForge and Quilt as explicit, fail-closed server runtime families while preserving the options-object installer API, the validated positional compatibility overload, and Vanilla/Fabric/Forge launch behavior. Runtime installation now uses exact tuple metadata, app-owned isolated staging, transactional publication with rollback, bounded official network/process seams, and metadata-backed launch validation.

The hardening follow-up closes every independent-review blocker: process success now waits for child `close`; non-quiescent forced termination preserves staging; Quilt accepts only exact semantic versions before Java/network work; every path segment uses the shared Windows basename policy; runtime HTTPS requests are exact-origin and default-port only; NeoForge writes are cleanup-bounded with redacted coded failures; Quilt obtains `server.jar` through the bounded pinned Mojang metadata/data chain; corrupt app-owned markers fail closed and valid markers override legacy config; and every supplied official digest is verified.

## TDD evidence

Initial RED command:

```powershell
node --test tests/loader-install-service.test.cjs tests/server-launcher.test.cjs tests/neoforge-runtime.test.cjs tests/quilt-runtime.test.cjs
```

Initial result: 25 tests, 6 passed and 19 failed for the intentionally missing NeoForge/Quilt interfaces and launch branches.

Additional safety RED command:

```powershell
node --test --test-name-pattern "bounded installer termination|failed publish rollback|reparse ancestor|reconstructs a deterministic" tests/loader-install-service.test.cjs tests/neoforge-runtime.test.cjs tests/quilt-runtime.test.cjs
```

Result before the safety implementation: 4 tests, 0 passed and 4 failed. The failures proved early process settlement, backup-loss risk, reparse-ancestor acceptance, and stale-loader coexistence.

Final focused GREEN command:

```powershell
node --test tests/loader-install-service.test.cjs tests/server-launcher.test.cjs tests/neoforge-runtime.test.cjs tests/quilt-runtime.test.cjs
```

Final result: 30 passed, 0 failed, 0 skipped.

Hardening RED command:

```powershell
node --test tests/loader-install-service.test.cjs tests/neoforge-runtime.test.cjs tests/quilt-runtime.test.cjs tests/server-launcher.test.cjs tests/modpacks/remote-url-policy.test.cjs tests/modpacks/pinned-https-client.test.cjs
```

Result before the hardening implementation: 65 tests, 51 passed and 14 failed. Those failures covered close/quiescence, nonclosing kill settlement, exact origins and ports, staging cleanup/error redaction, Quilt semantic aliases, Win32 devices, all supplied hashes, pinned Mojang acquisition, and corrupt-marker fallback. An additional valid-marker/config conflict regression was captured RED before making the app-owned marker authoritative.

Final hardening-focused result: 67 passed, 0 failed, 0 skipped.

Modpack regression command:

```powershell
$task10Tests = Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName
node --test $task10Tests
```

Original result: 273 tests, 270 passed, 0 failed, 3 skipped because Windows file-symlink creation was unavailable without elevated privilege.

Hardening regression result over every tracked `tests/modpacks/*.test.cjs`: 303 tests, 300 passed, 0 failed, 3 skipped for the same Windows file-symlink privilege limitation.

Direct ESLint command:

```powershell
npx eslint electron/ipc/install-handlers.cjs electron/services/loader-install-service.cjs electron/services/server-launcher.cjs electron/services/server-manager.cjs electron/utils/server-loader.cjs tests/loader-install-service.test.cjs tests/server-launcher.test.cjs tests/neoforge-runtime.test.cjs tests/quilt-runtime.test.cjs
```

Result: clean exit with no warnings or errors.

The hardening ESLint run covered the runtime service, pinned URL policy/client, loader detection, and all six focused test files. It exited cleanly with no warnings or errors. `git diff --check` also exited cleanly.

The hardening `npm test` run executed 509 tests: 500 passed, 3 skipped, and 6 failed. Every Task 10 and tracked suite passed. All six failures came only from the concurrent, untracked Task 8 `archive-worker-containment.test.cjs`, whose worker manifest, executable, native source tree, and durable broker were still being created in the shared worktree. No Task 8 path is included in this commit.

## Authoritative resolution

- NeoForge metadata: `https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml`.
- NeoForge installer: `https://maven.neoforged.net/releases/net/neoforged/neoforge/{version}/neoforge-{version}-installer.jar`, verified with the exact sibling SHA-512 sidecar, with SHA-256 fallback only for an actual SHA-512 404.
- Legacy Minecraft mapping removes the leading `1` and supplies an omitted patch (`1.20.2 -> 20.2.*`, `1.21 -> 21.0.*`). Calver retains the complete game identity and supplies an omitted patch (`26.1 -> 26.1.0.*`, `26.1.2 -> 26.1.2.*`). Qualifiers remain exact.
- Quilt list: `https://meta.quiltmc.org/v3/versions/loader/{game_version}`.
- Quilt exact pair/profile: `https://meta.quiltmc.org/v3/versions/loader/{game_version}/{loader_version}` and its `/server/json` child.
- Quilt libraries are accepted only from the reviewed Quilt and Fabric HTTPS Maven roots and are mapped from strict three-part Maven coordinates.
- Quilt base Minecraft manifest: `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`; its exact SHA-1-addressed version child and exact `https://piston-data.mojang.com/v1/objects/{sha1}/server.jar` child are fetched with fatal UTF-8 metadata parsing, byte ceilings, deadline, cancellation, pinned DNS/TLS, and exact-origin redirects. The version metadata SHA-1 plus every supplied server digest and declared size are verified before staging.

A live read-only lookup against the authoritative services returned 241 NeoForge versions for Minecraft 1.21.1 (first sorted result `21.1.248`) and 299 Quilt versions for Minecraft 1.20.1 (first sorted result `0.30.1-beta.2`). No `/latest`, compatible-range, first-entry, or cross-game fallback is used.

## Runtime and launch layouts

NeoForge runs only the digest-verified downloaded installer with the selected absolute Java executable, argument array `-jar <installer> --installServer`, `shell:false`, a hidden window, sanitized environment, bounded output/deadline/cancellation, and success only after child `close` proves stdio quiescence. Kill/error paths always settle; if `close` never arrives, the error is explicitly non-quiescent and the staging workspace is retained rather than deleted beneath a possibly live process. It installs in a fresh `.minecraft-core-state/runtime-staging/<operation>/server` tree. The exact Windows `win_args.txt`, its contained classpath references, matching universal library, base server input, and `user_jvm_args.txt` are validated before transactional publication. Launch uses app-owned memory arguments plus only the exact Windows argument file; pack scripts and `user_jvm_args.txt` are never executed or expanded.

Quilt validates the exact pair and server profile, verifies every SHA-1/SHA-256/SHA-512 value supplied for each library, obtains the exact digest-verified base server from Mojang, and generates `quilt-server-launch.jar` with the official launcher main class and closed relative classpath plus `quilt-server-launcher.properties` binding `server.jar`. No installer process is executed. Launch uses only the app-generated launcher JAR.

Both families atomically publish exact tuple metadata and streamed SHA-256/SHA-512 artifact records only after candidate validation. Publication backs up replaced files and conflicting Fabric/Forge/NeoForge/Quilt launch assets, verifies the published runtime, rolls back on failure, and retains the recovery workspace if restoration itself cannot be proven complete. `.minecraft-core-state/runtime.json` is the only authoritative app-owned NeoForge/Quilt sentinel: a present corrupt marker/layout fails `RUNTIME_INCOMPLETE`, a valid marker overrides stale legacy loader config, and filenames alone remain non-authoritative.

## Integration and residual risk

`server-manager.cjs` now consumes launch `cwd`, loader/runtime identity, ready markers, and fatal markers while retaining Java selection, server identifier JVM property, memory arguments, stdin/stdout/stderr, and process tracking. Known fatal startup output cannot transition the server to healthy; the standard dedicated-server ready line does.

Install and repair health paths validate the exact NeoForge/Quilt tuple using the Java major resolved by the existing server Java manager. Existing third-party Forge/Fabric installers retain their prior implementation and do not yet receive the new persisted runtime metadata unless reworked by a later lifecycle task. A production end-to-end NeoForge installer execution and Quilt base-server download remain network- and upstream-size-dependent; the Mojang resolver endpoints and current 1.20.1 object shape were live-read, while deterministic tests cover bounded acquisition, digest and size enforcement, cancellation, installation, validation, publication, rollback, and launch logic.

## Commit

This report is contained in the Task 10 commit whose full hash is reported in the handoff; a Git commit cannot embed its own final hash without changing that hash.
