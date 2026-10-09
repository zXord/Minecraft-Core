# Modpack release checklist

Updated 9 October 2026 after the recovery-routing/diagnostic verification gate, Asia/Riyadh. **Not release ready.** This is the restart checklist for normal, visible app testing. Automated tests support these checks; they do not replace installing the real pack, running Minecraft, and joining the server.

## Pause and resume

The routing and diagnostic fixes have passed independent review and a fresh full run: **3,873 passed, zero failed, five Windows skips**, followed by **176/176 rendered checks** and a successful production build. One earlier affected-run 200 ms fixture timeout is retained in the evidence; it passed both its isolated rerun and this full run, without a proven cause or timeout change. The app is still closed at this checkpoint. Next: normal b1 Recovery, then same-version Repair with the new primary/fallback diagnostics. No interrupted folders were manually moved or removed.

At 21:18, the corrected working tree passed a fresh full Node run: 3,842 passed, 0 failed, 5 documented Windows skips. The 176 controlled rendered checks and production build also passed. Exact same-version 0.13.4 Repair `op2-7642286d23c4dd0c680d85574cc225bb` ran through the normal isolated b1 app from 21:30:41 to 21:50:00 and ended **recovery-required**. It passed the prior properties-metadata failure, booted/stopped the candidate, then failed during the directory swap with `COMMIT_FAILED`. The active registry remains `committing / live-moved`; preserve both candidate and rollback folders. This is not a Repair pass. The Windows Security OpenJDK network prompt was untouched. After terminal settlement and no remaining test Java/worker, the owned dev launcher was interrupted; the app is now closed and recovery evidence preserved. A scoped fallback-routing fix and diagnostic follow-up precede the next normal recovery/retry. Warm Vite readiness was 1,191 ms after a build, not cold-start proof.

The user resumed testing while away at 19:32. After the reviewed fixes, the normal isolated b1 app launched at19:51. Repair `op2-8467466c9823f345c79ffa13c1459a92` ran20:06:16–20:26:27 and failed before publication, with **cleanupPending: false**. The candidate booted, stopped, and was safely removed. Its diagnostic identifies a **ctime-only difference between the initial path stat and opened handle stat** for the exact properties snapshot; the metadata writer is not identified. The QA app closed normally at20:27. Code investigation continues before another native retry. The earlier cancellation at12:36:09 remains a separate result.

- [x] Confirm this operation's terminal result and cleanup after the user's Cancel action: cancelled, no server change, no pending cleanup.
- [x] Record the actual result without treating cancellation as successful Repair.
- [x] On resumption, inspect fresh app/profile/Recovery state before starting another operation. At 19:52 the normal isolated b1 app confirmed the intended server, stopped services and no pending Recovery action. Do not manually delete candidate or recovery folders.
- [x] Resume only after the user asks. User explicitly resumed; no overnight task or automatic resumption was scheduled.

Previous cancelled operation: `op2-c664440fb572faa7eae1b98185bab65a`. It started at 11:52:35 through the normal Repair UI with EULA and start-after-install selected. Revalidation and recovery-snapshot verification passed; it was cancelled during candidate preparation. The downloaded archive remains retained and eligible for automatic cleanup after seven days, as displayed by the app.

## Test isolation

Never select, install into, edit, or delete the user's real Server, Client, or TrollCraft instances. All normal UI tests use the disposable setup below. Keep source edits and development hot reload out of an active acceptance run.

| Item | Exact target |
| --- | --- |
| Repository | `TerraFirmaGreg-Team/Modpack-Modern` on GitHub |
| Required baseline | Release **0.13.4**, `TerraFirmaGreg-Modern-0.13.4-serverpack.zip`, asset `477754820` |
| Matching client | Same release, `TerraFirmaGreg-Modern-0.13.4-modrinth.mrpack`, asset `477754823`; not the MultiMC ZIP |
| Runtime | Minecraft 1.20.1, Forge 47.4.13, Java 17 |
| QA profile | `C:\Users\s3eed\AppData\Local\Temp\minecraft-core-native-qa-20261008-control-b1\user-data` |
| QA server | `C:\Users\s3eed\SynologyDrive\Desktop\ET\Minecraft\Codex QA TFG 0.13.4 2026-10-08-b1` |
| Server ID | `server-e3e8d70a-7b87-4dbc-8e84-ee85baa7c4a4` |
| QA client | `C:\Users\s3eed\SynologyDrive\Desktop\ET\Minecraft\Codex QA Client TFG 0.13.4 2026-10-09-b1` — created, but still unregistered and uninstalled at this checkpoint |
| Network | Localhost; Minecraft port 25575, client-management port 8080; automatic startup disabled |

Preserve the older **a1** interrupted operation `op2-bbb18ef48d2efa541c9569569b47a9ba` and its candidate. A missing process or a reboot is not permission to delete recovery evidence. Inspect fresh window/profile state before any input. Windows security prompts and Microsoft sign-in require the user; do not bypass them or reuse credentials from real profiles.

## Confirmed results

- [x] Exact GitHub 0.13.4 ServerPack installed and reached its first server-ready state on b1. A later restart failed; this is not a complete installation acceptance pass.
- [x] Current native archive inspection recognizes 4,794 entries and the expected Minecraft/Forge runtime.
- [x] Native Verify reports 4,596 checked files and 147 differences, honestly displaying 64 with 83 omitted. Repeated at 19:53–19:55, job `op2-3167ab658c23e4aa7b9f85e813184c83`.
- [x] Same-release client MRPACK discovery, inspection, pairing and persistence across an app restart worked. Client installation remains untested.
- [x] Managed individual-JAR edit controls are visibly disabled. Invalid/empty client-invite validation worked.
- [x] Development taskbar capture at 06:20 showed the grass-block icon. Warm Vite starts were approximately one second; latest at 21:19 was 1,191 ms after a build. Cold-start variation and packaged taskbar acceptance are unresolved.
- [x] Checkpoint `1fcf231` passed 3,822 Node tests with zero failures and five documented Windows skips, 165 controlled rendered checks, production build and syntax checks. New changes require fresh verification.

## Fix and verify the blockers first

- [ ] **Stale terminal status text — cancellation native retest pending:** presentation fix and independent review passed; 41 rendered tests include nine new regressions. Settled outcomes now use bounded terminal wording, with genuine cleanup-pending precedence, instead of stale live progress. Completed Verify passed normal UI testing at19:55; terminal Failed and “Operation failed. Review the result below.” passed at20:27. Cancellation wording still needs native coverage.
- [x] **Copy progress overhead:** controlled real-helper probe confirmed five tiny updates reread 338,783,295 executable bytes and took 5.366 seconds. Reviewed ten-second counter checkpoint fix passed 309 focused tests and 18 identity tests. Normal Repair at20:13:34–20:14:35 advanced842→4520files in60.345seconds; all8,010files were copied and directory flushing/copy verification reached by20:15:52. This sampled copy improvement does not certify all Repair latency or publication. Initial/completion/substages and all safety/cancellation boundaries remain immediate; no executable verification was removed.
- [ ] **Restore-point progress clarity:** source audit found further full archive hashes/source rechecks/publication verification behind unchanged near-complete counters. Distinguish actual verification passes/substages instead of leaving old counts visible during different work. Keep the checks and avoid simulated overall progress.
- [ ] **Companion freshness warning:** the first Overview after a normal restart again showed the generic stale-evidence warning. Pairing loss and release change are not established. Add bounded channel/guard diagnostics and reproduce; a successful paired-status read must not be hidden merely because the separate asset-list read failed. Existing health/freshness fences must remain intact.
- [ ] **Progress ordering:** follow up the pre-existing late poll/event race; lower durable sequences must not overwrite newer results, while equal-sequence full hydration and newer recovery reconciliation still work. Design saved separately; not changed by the checkpoint fix.
- [ ] **Repair completion — swap failure now blocks acceptance:** the reviewed ctime-only correction passed the fresh full suite and the 21:30–21:50 native retry crossed that boundary. It later failed during the swap with canonical absent and both candidate/rollback retained. Fix the concrete committing/live-moved fallback routing mismatch, preserve primary versus fallback diagnostics, then recover/retry through the normal UI. The initiating Windows failure remains unknown. Earlier job `op2-bd7d420d3c75e0796daff25f5bf01fb1` lacked the ctime diagnostic; do not retroactively assign it that cause. Candidate boot alone does not pass Repair.
- [ ] **Cleanup latency — fix reviewed, native retest pending:** three discarded full-payload hashes in the retained-stopped-original wrapper now use the existing complete structural inspection, preserving descendant link/reparse/membership and parent/target checks. Initial source-content authority and the terminal retry's inner full scan remain unchanged. Real fixture accounting confirms one full source scan instead of four; 146 focused checks and independent spec/quality review passed. Final retain-only proofs no longer promise payload readability. Native timing/cleanup acceptance remains pending; do not infer safe cleanup from PID absence.
- [ ] **Canonical restart:** Repair must publish successfully, then the actual server must start, stop normally and start again. Track the SophisticatedCore config at ready, before Stop, after process closure and before restart. The existing malformed config's writer is unknown; do not manually replace it to manufacture a pass.
- [ ] **Backup growth:** source audit found a production retention gap: restore points acquire operation pins, but production never calls the existing unpin primitive. Failed/cancelled retries that reach staging can therefore accumulate permanently protected backups. Define and test retirement only after authenticated never-committed settlement and reference checks; uncertain recovery and completed historical rollback material stay protected. Two observed pairs total 1,712,745,266 bytes; neither is certified safe to delete. Snapshots exclude backups, so this is not recursive archiving. This is separate from download-cache cleanup.
- [ ] **Planning stage labels — partial native pass:** both displays now use fixed “Preparing review” with the actual activity and measured counts, avoiding misleading backward ordinals. Independent spec/quality review passed, with 29/29 Node and 43/43 controlled rendered tests. Normal existing-server Repair showed the corrected heading across scan, extraction, archive verification and measured assembly at 21:25–21:30. The separate new-server display still needs native coverage.

## Matching client and real join

- [ ] Dashboard → set up invite → start client-management server → copy the refreshed local invite. Do not put its secret in reports.
- [ ] Add Instance → Client Interface → select only the disposable client folder → Test Connection → Save & Continue. Confirm registration actually succeeded; finishing the wizard alone is insufficient.
- [ ] Review and install the exact paired 0.13.4 MRPACK through the matching-client panel, including mods, configs, scripts and required runtime. Check real progress, errors and conflict handling.
- [ ] Verify the installed matching pack, close/reopen the app normally, and verify persisted state.
- [ ] Complete normal Microsoft authentication with the user. Launch Minecraft from the app, join the disposable server, reach the actual game world, disconnect and rejoin. Preserve visible and server-log evidence; no offline simulation counts as a join.
- [ ] Confirm server-only content is not incorrectly installed on the client and client-only content is not sent to the server.

## Version changes and ownership

- [ ] Upgrade the disposable server from 0.13.4 to exact 0.13.5 through the UI; verify runtime, retained settings/data, launch and join.
- [ ] Pair/install the matching client release and verify the client follows the server version, not an unrelated latest version.
- [ ] Test a reviewed downgrade to 0.13.4 and restore-point rollback separately. Preserve a recoverable test world; do not assume arbitrary world downgrades are safe. Recheck client transition and actual join.
- [ ] Stop the disposable server, reversibly remove/rename one managed test JAR, and confirm drift is detected and the client cannot silently install/launch against an invalid managed state. Restore or Repair normally, then verify recovery and join.
- [ ] Test user-added files and configuration conflicts: review choices must preserve the intended files and not silently discard them.
- [ ] Test Detach last or on another isolated disposable instance: files remain, modpack management/notifications stop, and ordinary mod controls unlock. Check matching-client behavior after Detach.

## Other native feature coverage

- [ ] Modrinth search/details/version selection show all pack-supported Minecraft versions and loaders, independent of the existing server's runtime; install a suitable real pack on a separate disposable instance.
- [ ] Local archive import works through the native picker. Test supported ZIP/MRPACK/RAR paths, multipart selection where supported, and clear rejection of unsupported or incomplete archives.
- [ ] GitHub release/channel/asset selection, optional saved asset pattern, update detection, notification opening/read/dismiss behavior and exact-version installation work. Do not install an update merely because a notification appears.
- [ ] Cancellation during download/preparation and before commit leaves an honest terminal outcome. Test retry, interrupted-operation recovery and reuse of a previously failed destination name after safe cleanup.
- [ ] Retained downloads can be located/removed as designed. Verify seven-day eligibility and startup/shutdown cleanup without removing active, referenced or recovery-dependent files. Check repeated failures do not accumulate unexplained data indefinitely.
- [ ] Invalid destinations, filesystem interference and capacity failures produce actionable general messages without blaming a specific sync product or modifying another instance.
- [ ] Verify consistent neutral selection styles, legible progress and failure details, clear destination selection, and CurseForge **Unavailable** wording across the flow. Check controls at a smaller window size.
- [ ] Capture a naturally slow cold `npm run dev` startup with phase timings, then a warm restart without clearing caches. Determine the slow interval; do not call the cold-start problem fixed based on warm timings.
- [ ] Launch the locally packaged app normally in an isolated profile: check startup, renderer, taskbar icon, bundled archive/runtime tools, installation and client workflow. Do not publish the build.

## Final acceptance

- [ ] For each native check above, record date, exact pack/asset, isolated instance, observed result and any screenshot/log reference in the evidence ledger. Keep failed, blocked and automated-only results distinct from native passes.
- [ ] Fix discovered defects with regressions and independent review; rerun affected native scenarios on the final code.
- [ ] Run the full automated suite and production build after the last source change, then complete final review. Preserve the user's unrelated edits.
- [ ] Stop only owned test servers/clients normally, confirm no test processes or unresolved operations are left behind, and document retained test data. Commit only reviewed task changes locally if appropriate.
- [ ] Give an honest final release-readiness summary. No push, release or publication without separate authorization.

## Supporting records

Detailed history: [Native verification evidence](2026-10-08-native-modpack-verification.md). Implementation scope: [Matching client pack plan](../superpowers/plans/2026-10-08-matching-client-packs.md). Current local checkpoint: `1fcf231`, branch `codex/verify-modpacks-client-packs`.

Additional working evidence is retained under `.superpowers/sdd/2026-10-08-matching-client-packs/`, particularly `progress.md`, `task-6-native-resume-1143.md`, and `task-6-post-candidate-recovery-audit.md`. Those scratch files must not be the only record of unfinished work; update this repository checklist when status changes.
