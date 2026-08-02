# Task 10 report: exact NeoForge and Quilt runtimes

## Outcome

Implemented NeoForge and Quilt as explicit, fail-closed server runtime families while preserving the options-object installer API, the validated positional compatibility overload, and Vanilla/Fabric/Forge launch behavior. Runtime installation now uses exact tuple metadata, app-owned isolated staging, transactional publication with rollback, bounded official network/process seams, and metadata-backed launch validation.

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

Modpack regression command:

```powershell
$task10Tests = Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName
node --test $task10Tests
```

Result: 273 tests, 270 passed, 0 failed, 3 skipped because Windows file-symlink creation was unavailable without elevated privilege.

Direct ESLint command:

```powershell
npx eslint electron/ipc/install-handlers.cjs electron/services/loader-install-service.cjs electron/services/server-launcher.cjs electron/services/server-manager.cjs electron/utils/server-loader.cjs tests/loader-install-service.test.cjs tests/server-launcher.test.cjs tests/neoforge-runtime.test.cjs tests/quilt-runtime.test.cjs
```

Result: clean exit with no warnings or errors.

`npm test` was also run. Every Task 10 test passed; the run had one unrelated failure in `tests/modpacks/archive-runtime-manifest.test.cjs` caused by the parent's concurrent Task 7 RED work in `scripts/acquire-7zip.ps1`. The parent confirmed that concurrent RED does not block this isolated commit.

## Authoritative resolution

- NeoForge metadata: `https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml`.
- NeoForge installer: `https://maven.neoforged.net/releases/net/neoforged/neoforge/{version}/neoforge-{version}-installer.jar`, verified with the exact sibling SHA-512 sidecar, with SHA-256 fallback only for an actual SHA-512 404.
- Legacy Minecraft mapping removes the leading `1` and supplies an omitted patch (`1.20.2 -> 20.2.*`, `1.21 -> 21.0.*`). Calver retains the complete game identity and supplies an omitted patch (`26.1 -> 26.1.0.*`, `26.1.2 -> 26.1.2.*`). Qualifiers remain exact.
- Quilt list: `https://meta.quiltmc.org/v3/versions/loader/{game_version}`.
- Quilt exact pair/profile: `https://meta.quiltmc.org/v3/versions/loader/{game_version}/{loader_version}` and its `/server/json` child.
- Quilt libraries are accepted only from the reviewed Quilt and Fabric HTTPS Maven roots and are mapped from strict three-part Maven coordinates.

A live read-only lookup against the authoritative services returned 241 NeoForge versions for Minecraft 1.21.1 (first sorted result `21.1.248`) and 299 Quilt versions for Minecraft 1.20.1 (first sorted result `0.30.1-beta.2`). No `/latest`, compatible-range, first-entry, or cross-game fallback is used.

## Runtime and launch layouts

NeoForge runs only the digest-verified downloaded installer with the selected absolute Java executable, argument array `-jar <installer> --installServer`, `shell:false`, a hidden window, sanitized environment, bounded output/deadline/cancellation, and confirmed child exit after termination. It installs in a fresh `.minecraft-core-state/runtime-staging/<operation>/server` tree. The exact Windows `win_args.txt`, its contained classpath references, matching universal library, base server input, and `user_jvm_args.txt` are validated before transactional publication. Launch uses app-owned memory arguments plus only the exact Windows argument file; pack scripts and `user_jvm_args.txt` are never executed or expanded.

Quilt validates the exact pair and server profile, downloads the complete deterministic library set, and generates `quilt-server-launch.jar` with the official launcher main class and closed relative classpath plus `quilt-server-launcher.properties` binding `server.jar`. No installer process is executed. Launch uses only the app-generated launcher JAR.

Both families atomically publish exact tuple metadata and streamed SHA-256/SHA-512 artifact records only after candidate validation. Publication backs up replaced files and conflicting Fabric/Forge/NeoForge/Quilt launch assets, verifies the published runtime, rolls back on failure, and retains the recovery workspace if restoration itself cannot be proven complete. Filename-only loader detection was removed for NeoForge and Quilt.

## Integration and residual risk

`server-manager.cjs` now consumes launch `cwd`, loader/runtime identity, ready markers, and fatal markers while retaining Java selection, server identifier JVM property, memory arguments, stdin/stdout/stderr, and process tracking. Known fatal startup output cannot transition the server to healthy; the standard dedicated-server ready line does.

Install and repair health paths validate the exact NeoForge/Quilt tuple using the Java major resolved by the existing server Java manager. Existing third-party Forge/Fabric installers retain their prior implementation and do not yet receive the new persisted runtime metadata unless reworked by a later lifecycle task. A production end-to-end NeoForge installer execution and full Quilt base-server download remain network- and upstream-size-dependent; exact resolver endpoints were live-checked, while deterministic tests cover all application-owned install, validation, publication, rollback, and launch logic.

## Commit

This report is contained in the Task 10 commit whose full hash is reported in the handoff; a Git commit cannot embed its own final hash without changing that hash.
