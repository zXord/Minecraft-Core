# Native modpack verification — 2026-10-08

Status: in progress. This is an evidence ledger, not a completion claim.

## Isolation and method

Normal `npm run dev`, with only `MINECRAFT_CORE_USER_DATA_DIR` pointing to the disposable `minecraft-core-native-qa-20261008-a1/user-data` profile in Windows Temp. No test-mode IPC, seeded instance records, native dialog overrides, or synthetic client authentication. The desktop window is driven through visible Windows controls and native folder pickers.

Only the disposable `Minecraft/Codex QA 2026-10-08-a1/TFG 0.13.4` server under SynologyDrive is used. The user's existing Server and Client folders are out of scope. Test server: localhost, port 25575, 6 GiB. Times below are Asia/Riyadh.

## Observed native results

| Scenario | Result | Evidence |
| --- | --- | --- |
| Fresh GitHub ServerPack installation | Passed | TerraFirmaGreg-Team/Modpack-Modern 0.13.4, uploaded asset 477754820; 519,260,266 archive bytes, 4,794 entries; normal creation UI and native destination picker. |
| Exact Java and Forge setup | Passed | Java 17.0.20.1+1; Minecraft 1.20.1, Forge 47.4.13. No archive launch script used. |
| First server start and installation health | Passed | Clicked Install 12:26:37; server `Done (5.434s)!` 12:36:58.218; durable operation completed 12:37:16.701. |
| Normal stop/start/stop | Passed | Stopped 12:38:08; Start 12:38:35; second `Done` 12:40:37.013; Stop 12:41:42, no remaining test Java process. |
| Mods inventory | Passed | Actual 208 root mod JARs; UI displayed 208 Installed Mods. This does not constitute a client pack. |
| Release notification | Passed | Check for updates reported the same repository's 0.13.10; notification opened its uploaded assets and cleared unread count. Nothing from that release installed. |
| Actual Windows taskbar icon | Passed in this isolated run | Temp screenshot `codex-shot-2026-10-08_12-49-24.png` shows the running Minecraft cube icon, not Electron's atom. This is separate from the window-title icon. |
| Close/reopen and persistence | Passed | Normal restart 13:02; Vite ready in 1,127 ms; correct 0.13.4 server persisted. This single timing does not establish every cold-start time. |
| Upgrade 0.13.4 → 0.13.5 | Native retry unresolved; no publication | Preflight and backup issues were fixed and the retry passed those stages. It then encountered a loader failure and an IPC close-wait bug. Shutdown/recovery safeguards and bounded failure diagnostics are now reviewed, but the initiating loader error and a successful native retry remain unverified. |
| Downgrade/rollback, verify/repair | Pending | Must be tested through the UI. |
| Matching client import and actual join | Implemented; native acceptance pending | MRPACK pairing/import and guarded exact-runtime launch are implemented and reviewed. Normal Microsoft authentication, if needed, requires user handoff. No offline fixture is counted as a native join. |

Fresh-install operation: `op2-b79191713e5bf6826984f733fa1c28d7`.

Registered test instance: `server-fa366c69-37fd-4639-8541-43af510541fd`.

0.13.4 ServerPack SHA256: `2e36fb62f8bb30f95ed244a03a0e01050c7e9f443211b14d35203a6126a6fdbf`.

The upgrade review found 22 conflicts: 18 ordinary configuration/quest files rewritten by the running server, plus protected run scripts, server.properties and JVM arguments. This is an actual user-facing decision point, not a completed upgrade. The native run exposed the need for explicit bulk conflict choices; individual choices and protected-content restrictions remain enforced.

Native bulk conflict controls passed: Use pack files for configs selected the 18 ordinary entries; Keep existing files filled the four protected entries without overwriting those decisions. Re-review produced 50 additions, 121 changes, 496 removals and 8,562 preserved entries. Started reviewed operation `op2-b444a47250efc23d407b68bae2ed7818` with start-after validation. It failed at 13:40:06 before any pack publication. Recovery validated the original 0.13.4 server and stopped it; the Versions page still displayed Installed: 0.13.4 afterward. This is recovery/failure evidence, not an upgrade pass.

## Automated evidence (not native acceptance)

- Earlier baseline: 2,743 Node tests, 2,739 passed, 4 skipped.
- After runtime-worker cancellation fixes: 2,766 Node tests, 2,757 passed, 5 failed, 4 skipped. The failures were two outdated packaged-worker fixtures and three writer-inventory checks. Focused corrections reported 69/69 passing; a new complete suite remains required after integration.
- Empty watcher/snapshot regressions: 17/17 focused tests passed.
- Managed dashboard runtime refresh: 9/9 rendered tests plus 21/21 related Node tests; independent rendered review 9 passed.
- Real byte/count progress and Svelte reactivity: 11/11 rendered tests passed.
- Runtime cancellation and exact-child quiescence: 290/290 focused tests. Unadopted server health-handoff cleanup: 242/242 expanded tests.

Logs remain in the disposable QA root's `evidence` directory. A fresh production build, full suite, integrated client review, and final native acceptance are outstanding.

Backup metadata follow-up: independent review and fix verification passed134/134 tests plus8targeted regressions. Ctime-only drift now triggers bounded content revalidation; archive mode/link-count mutation and changed raw ZIP bytes still reject. The read-only production scanner succeeded against the actual failed QA tree (8006 files,1067688971 bytes,17.87seconds). This is not a completed upgrade.

Normal isolated dev restart13:58:56: Vite readiness1403ms; original0.13.4 state persisted and server stopped. Native upgrade retry through GitHub0.13.5 ServerPack selection began after independent approval. Result pending.

Upgrade retry started through normal UI14:18:26, job `op2-bbb18ef48d2efa541c9569569b47a9ba`; same reviewed diff and protected choices, start-after validation enabled. At14:21:59 the real restore-point operation was writing1458 of9203 entries. This is progress beyond the earlier scope-scan failure, not a completed upgrade.

At14:25:22 the restore point completed and the real operation entered candidate staging. It copied the old server and reached exact-loader preparation. At14:33:15 the technical log changed to “Waiting for runtime workers to stop before safely cleaning the candidate,” but the headline continued to show installation. The job remains unresolved; no0.13.5 publication or successful upgrade is claimed. The old app has not been restarted or the candidate deleted.

Read-only diagnostics, separate from UI acceptance, reproduced an IPC shutdown race using the same branded Electron executable: the production parent disconnected on an authenticated worker error, observed exit, and never received the close event. A passive parent received close normally. Controlled Node/Electron protocol-only fixtures reproduce the race without launching Java or downloading a pack. The two-client fix passed81 focused tests and is under independent review. A separate durable recovery safeguard is required before restarting the currently stuck app, because old in-memory shutdown evidence cannot be reconstructed from process absence.

The worker-close fix and its first-termination-cause regression correction subsequently passed86 scoped tests and an independent37-test rereview. These are controlled worker-boundary tests, not evidence that the old native job recovered. Production integration of durable unresolved-worker handling is still underway before reopening that profile.

The original0.13.4 runtime's154 recorded artifacts matched their hashes; later read-only runtime verification succeeded. The interrupted candidate differed in the regenerated Forge server.json and retained its earlier runtime manifest. These observations do not establish the initiating loader failure. No manual candidate repair, publication, or synthetic success was performed.

Matching client backend integration passed238 scoped tests and an independent226-test network-free review. The rendered integration, final full suite/build, matching client install, and Microsoft-authenticated launch/join remain pending. Measured existing-server copy counts passed164 initial tests; a review-driven mutable-file total correction passed21 focused tests. The currently running app predates that progress change, so visible verification remains pending.

At15:15, the combined client-pack Node suite completed422/422 with no failures/skips (462.42s). Its20,000-file capacity fixture took400.45s; this used disposable temporary data, not a user client. The subsequent measured-client-copy wiring passed2 new regression tests and68 scoped tests. Renderer integration author verification passed35 actual-view/panel tests and5API tests; independent review is pending. None of these results substitutes for the still-pending native client installation and authenticated join.

At15:28, the durable server-runtime recovery safeguard passed independent review (154 controlled tests). It records unresolved runtime writers before work and refuses candidate cleanup until exact shutdown or an authoritative later Windows boot is proven. Legacy uncertain operations, including the old native QA job, are not made safe merely by restarting the app. This approval permits preparing a coherent application restart; it does not authorize deleting the old candidate or count as a successful upgrade.

The initiating loader failure remains unknown. Read-only comparison found all154 candidate artifacts stable and only normal regenerated `time`/`releaseTime` fields differing in Forge's server.json. Bounded authenticated stage/reason diagnostics were added and passed149 author tests; independent review is pending. No content-integrity predicate was relaxed. The full integrated Node suite was started after these backend changes; its result is still pending.

Client renderer review found two remaining issues: retained-cleanup information was not visible, and uncorrelated old launch events could affect a newly selected client during authentication. Both are being corrected before native client acceptance. Measured client-copy progress independently passed its two new regressions.

By15:39, both renderer findings were fixed and independently approved (44 rendered tests and5API tests). The diagnostic transport was independently checked with85 tests; a minor getter-before-error-proof issue was fixed and rereviewed with6 tests. Root's combined final diagnostic/close/loader/recovery check passed90 tests. Syntax checks passed for407 changed/untracked JavaScript modules, and repository whitespace checks passed.

The first integrated full Node run finished with3327 tests:3320 passed,3 failed,4 skipped,682.96seconds. All three failures were miniature packaged-worker fixtures missing the new diagnostics module; production packaging includes `electron/**/*`. Fixture corrections and a final rerun are required. Three skips concern unavailable Windows file-symlink privileges; one pathname-cleanup scenario is not applicable to Windows retention-only bundles. Skips are not native passes.

Final integration review additionally found missing runtime progress-counter aliases and a running unmanaged-client-to-managed-client transition gap. The progress regression reproduced and passed after a bounded normalization fix; durable launch ownership across that transition is being corrected. Overall acceptance remains incomplete.

Normal closing/reopening of the native QA app is currently blocked by computer-control activation failures. Fresh window capture works, but activation, title-bar close and the exposed Raise action return `failed to activate captured window`. No Blank screensaver or owned modal was found. The user was asked to close the isolated test app normally; it was not force-killed or cleaned up.

At15:41, the three corrected miniature-ASAR tests passed the author's run and root's independent3/3 rerun; related author regressions passed153/153. Root's runtime progress correction passed46 service tests and a separate20 IPC tests; independent review approved the three directly affected progress cases. These scoped results do not replace the required final whole-suite rerun after the launch-ownership change.

The production bundle built successfully in11.72seconds while the old QA window remained read-only. This was a deliberate safe adjustment to the original close-before-build sequencing: build output is confined to repository generated assets/logger HTML, the dev renderer watches neither, and no QA profile or runtime candidate was changed. A new Svelte warning about keyboard focus on the large file list was reported and assigned for a bounded accessibility correction before the next build. The native app was not restarted by the build.

By15:52, the ordinary-launch ownership transition fix passed91 author tests and91 independent tests; both final integration findings were approved. This covers current application-started registered sessions, not retroactive ownership of older/external games. README tells users to close those before importing. The file-list accessibility correction retains semantic lists in a labelled native scroll region, with no added observer/action logic. Root reran74 rendered tests successfully in53.3seconds and rebuilt successfully in10.24seconds without the warning. All407 changed/untracked JavaScript modules passed a fresh syntax check. The final whole Node rerun is in progress.

## Latest verification checkpoint — 16:00

- Final whole Node run: **3340 tests,3336 passed,0 failed,4 skipped**, exit0,685.45seconds. The four skips remain the three unavailable file-symlink privilege cases and the Windows retention-only pathname-cleanup case described above.
- Rendered integration: **74 passed**, exit0,53.3seconds; real components with controlled external boundaries, not native game acceptance.
- Production build: exit0,10.24seconds, no accessibility warning. JavaScript syntax:407 files,0 failures. Whitespace checks: passed.
- Independent integration review: both findings resolved; runtime/recovery and renderer follow-up reviews approved within their stated scopes.
- Test results describe the current working tree. Pre-existing ignored-update persistence edits and their regression file are preserved separately rather than silently included in the modpack checkpoint; `migration-review-2026-10-07.md` is also excluded and untouched.
- The native QA app is still open and its old main process has not loaded the new code. The failed upgrade's candidate remains retained. No manual cleanup, synthetic success, real-profile import, authenticated client join, successful upgrade/downgrade, or completed overall acceptance is claimed.

Next: close the old isolated app normally and reopen a coherent current build, verify retained recovery status, then continue only in disposable server/client instances. Do not reuse the user's existing Server or Client folders. Microsoft authentication and any Windows security prompt require user handoff.
