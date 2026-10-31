# Server writer inventory

This inventory is the reviewed boundary for filesystem and durable configuration writes owned by a Minecraft server. A registered server is keyed by its stable instance ID and canonical server path. IPC entry points listed as coordinated are wrapped by `server-mutation-policy.cjs` before the handler runs. Nested services mark the active lease immediately before their first filesystem mutation so partial failures still advance the content revision once.

Instances without modpack lifecycle evidence (every server and client a v26.6.1 user has) behave exactly as in v26.6.1. Modpack lifecycle and recovery work keeps its strict, exclusive machinery. The ownership predicate that tells them apart, `inspectFolderEvidence` in `electron/services/modpacks/instance-ownership.cjs`, answers `unmanaged` only when the folder is an existing directory and every evidence entry is absent (`.minecraft-core-state\modpack.json`, `manifests`, `operations` and `history` for servers; `.minecraft-core-client-pack.json` for clients). Any present entry gives `lifecycle`, and any other error gives `unknown`; both select the strict path. The predicate never caches and never writes.

## Writer classes

The coordinator (`server-mutation-coordinator.cjs`) admits three classes of holder per folder record.

| Class | Who | Admission |
| --- | --- | --- |
| Ordinary shared | every policy-wrapped writer except the stopped-only set and registry groups | joins other shared writers and a starting or running server at once (v26.6.1 concurrency); waits in FIFO order behind an exclusive ordinary holder or an earlier exclusive waiter; fails fast with `OPERATION_IN_PROGRESS` against lifecycle or recovery work |
| Ordinary exclusive | a stopped-only writer (including a management writer on a modpack-managed server), or an ordinary group (`runManyMutations`: a `save-instances` that adds or removes registrations, every client delete as a one-folder group, and a client delete with files that also reserves the servers inside it) | waits for shared holders and earlier exclusive ordinary holders; fails fast against lifecycle or recovery work; a stopped-only writer gets `SERVER_RUNNING` while the server runs and `OPERATION_IN_PROGRESS` while it is starting |
| Lifecycle | modpack lifecycle, recovery, companion pairing and failed-restorepoint retirement (every caller that does not pass `ordinary`) | exclusive and fail-fast against any holder, shared or exclusive, and against a starting server; quiesces a running server; pins the content revision |

Every wait is bounded: `ordinaryWaitTimeoutMs` (default 120 s) gives `OPERATION_IN_PROGRESS`, and the abort signal is honoured. After a wait, admission is re-run from scratch over all selectors, so no writer holds one folder while waiting for another. A plain server start may overlap shared holders but not an exclusive one, and an ordinary lease can never parent a start. `listActiveOperations()` reports lifecycle, exclusive, shared and start-pending holders for the app update guard.

## Writers that need the server stopped

The policy marks only the writers the v26.6.1 UI already disabled while a server ran. `tests/server-mutation-policy.running.test.cjs` pins both sets.

- **Stopped-only:** `backups:restore`, `delete-world`, `delete-instance`, `download-minecraft-server`, `download-and-install-loader`, `download-and-install-fabric`, `repair-health`.
- **Stopped-only when managed:** `start-management-server`, `set-management-server-external-host`, `set-management-invite-host`, `regenerate-management-invite-secret`. The server is classified through the state observer before admission and again inside the lease. An unmanaged server keeps them shared (allowed while running, as in v26.6.1). A modpack-managed server, a state that cannot be read or a missing repository needs the server stopped (fail closed).

Every other writer is shared and allowed while a server runs.

## Read-modify-write lanes

Shared writers no longer serialise each other, so read-modify-write families take a per-folder FIFO lane inside their lease (`runInWriteLane`, bounded at 60 s, then `OPERATION_IN_PROGRESS`). Lanes belong to the coordinator, so desktop IPC, the browser panel and the mod availability watcher queue in the same lanes.

| Lane | Channels |
| --- | --- |
| `config` | `write-config`, `update-config`, `update-settings`, `set-auto-restart`, `save-version-selection`, `write-eula`, the four management metadata writers |
| `players` | `add-player`, `add-player-with-details`, `remove-player` |
| `server-properties` | `write-server-properties`, `generate-server-properties`, `restore-backup-properties` |
| `backups-meta` | `backups:configure-automation`, `backups:apply-retention-policy`, `backups:save-retention-settings`, `backups:rename`, `backups:delete` |
| `mod-watch` | `mod-watch:*` writers and the watcher's own publications |
| `disabled-mods` | `save-disabled-mods` |

Mod jar installs and downloads and client channels take no lane, as in v26.6.1.

## Core coordinated IPC writers

| Area | Channels | Revision policy | Selector |
| --- | --- | --- | --- |
| Server config | `write-config`, `update-config` | automatic when bytes are written | `serverPath` |
| Folder/version | `select-folder`, `save-version-selection` | automatic | selected path / payload path |
| EULA/world | `write-eula`, `delete-world` | automatic; `delete-world` is stopped-only | payload path / server path |
| Settings/instances | `update-settings`, `save-instances` | automatic per root actually written | stable ID plus registered path |
| Instance registry | `rename-instance`, `delete-instance` | none; a rename is shared; a server delete is stopped-only; a client delete is an exclusive one-folder group that may overlap a running server when it keeps the files (v26.6.1), and is stopped-only when it deletes files (it also reserves the registered servers inside that folder) or when a folder whose registration it removes is shared by a registered server and bound to the client's own ID by the coordinator (the refusal names that server); a successful delete retires the removed registrations | stable ID resolved before work, server or client; a client ID shared by copied folders resolves by its registered folder |
| Server properties | `write-server-properties`, `generate-server-properties`, `restore-backup-properties` | automatic | registered server path |
| Server runtime | `download-minecraft-server`, `download-and-install-loader`, `download-and-install-fabric`, `repair-health` | automatic when runtime bytes change; stopped-only | target path |
| Server Java | `server-java-ensure` | automatic at the Java filesystem boundary | server path |
| Restore | `backups:restore` | automatic; stopped-only; a full restore that would replace the modpack state of a managed server is refused (world-only restores stay allowed) | server path |
| Backup metadata | `backups:delete`, `backups:rename`, `backups:apply-retention-policy`, `backups:save-retention-settings` | shared, `backups-meta` lane; backup-only writes do not revise launch content | server path |
| Backup automation config | `backups:configure-automation` | automatic when folder config changes | server path |
| Auto restart config | `set-auto-restart` | automatic when a target server is supplied | target path |
| Managed modpack lifecycle | `modpacks:start-operation`, `modpacks:recover`, `modpacks:verify`, `modpacks:perform-safe-action` | lifecycle-owned exact revision; handlers acquire internally through the shared coordinator | opaque plan, job, recovery, or action IDs resolved only in main |

## Content and management coordinated IPC writers

| Area | Channels | Revision policy | Selector |
| --- | --- | --- | --- |
| Player lists | `add-player`, `add-player-with-details`, `remove-player` | automatic only when a list or player/IP mapping changes | registered server path in argument 2 |
| Management metadata | `start-management-server`, `set-management-server-external-host`, `set-management-invite-host`, `regenerate-management-invite-secret` | automatic when invite/TLS/config bytes change; stopped-only when managed | stable server ID and path |
| Server mods | `direct-add-mod`, `save-disabled-mods`, `save-ignored-mod-updates`, `install-mod`, `install-mod-with-fallback`, `download-mod-with-fallback`, `add-mod`, `delete-mod`, `update-mod`, `move-mod-file`, `enable-and-update-mod`, `auto-redownload-corrupted-file`, `store-file-checksum` | automatic; loose jar edits on a modpack-managed server are refused with `MANAGED_MOD_EDIT_BLOCKED` | registered server root; nested checksum paths resolve to that root |
| Shaders/resource packs | `delete-shader`, `delete-resourcepack`, `install-shader-with-fallback`, `install-resourcepack-with-fallback` | automatic | registered server root, including its managed `client` subtree |
| Client/manual mods | `install-client-mod`, `update-client-mod`, `disable-client-mod`, `update-client-mods`, `disable-client-mods`, `download-client-mod-version-updates`, `remove-manual-mods`, `toggle-manual-mod`, `update-manual-mod`, `clear-client-mod-cache` | automatic | stable client instance root, or the containing registered server root |
| Launcher content | auth save/import/refresh/clear, mod and asset download/remove/toggle/delete, client runtime download/clear, launch preparation, expected-state reconciliation, dependency acknowledgement, download preferences | automatic when bytes change | `clientPath`, `targetClientPath`, or stable client ID resolved to its owning registered root |
| Explicit metadata migration | `migrate-server-mod-metadata`, `migrate-client-mod-metadata` | automatic | registered owning root |
| Availability state | `mod-watch:add`, `mod-watch:remove`, `mod-watch:clear`, `mod-watch:history:clear` plus periodic state/history publication | automatic | registered server root |

The selector resolver accepts a client path only when it is either an exact registered client instance or lies inside a registered server root. It chooses the most specific registered owner and never derives ownership from a display name, remote host, or renderer-provided alias. Standalone client revisions are compare-and-set in `client-config.json`; they never create a server `.minecraft-core.json`. Path-shaped legacy `instanceId` values are resolved only when they exactly identify a registered root.

A registered server root owns its writes even when a plain client folder is nested in it, around it or in the same folder (layouts v26.6.1 allowed). Only a client with matching-pack evidence (a manifest or an unsettled pack journal) refuses such a layout. Client channels for a folder registered twice act as the lowest client ID in code-point order, the client its launch resolves. Client settings channels run through `runPersonalMutation`, client-local content channels through `runLocalMutation` (allowed while the host gives no HTTP response at all), other client channels through `runLegacyMutation`, and client rename and delete through `runRegistryMutation`, which never reads the host, tolerates a client whose folder is gone, and selects a client by its registration (ID and folder), so copied folders that share one client ID can be renamed and deleted as in v26.6.1. Every registration a delete removes passes the client-pack registry guard; launch, sync, toggles and sessions still resolve by ID alone and refuse a shared ID.

## Registry saves (changed-only `save-instances`)

`save-instances` compares normalized (ID, folder) pairs with the current registry. A server listed again with the same ID and folder is not touched, not reserved and not written back, so a reorder while servers run leaves every `.minecraft-core.json` byte-identical (v26.6.1 saved the list while servers ran).

- No added or removed server: the plan is re-checked synchronously right before the handler, which reads the registry before its first await.
- Otherwise only the added and removed folders are reserved, as one ordinary group, stopped-only when anything is removed.
- Inside the group the plan is made again. The handler runs only when every added or removed folder is held, and added folders passed the client-overlap and server-destination checks; otherwise `OPERATION_IN_PROGRESS` without running it.
- Only a new registration whose folder config can be read receives a write-back (secret migration, invite host), and a write-back failure is logged without failing the save.

## Coordinator identity and retirement

There is one coordinator record per normalized folder. `canonicalCoordinatorSelector` (`electron/services/coordinator-identity.cjs`) picks its identity by a stable rule, never by sidebar order: the coordinator's bound ID when it is registered at that folder; otherwise a server before a client, then the lowest ID in code-point order. An ID registered nowhere gives a path-only selector. Duplicate registrations of one folder are tolerated (v26.6.1 parity) and share the record, so writes, reorders and starts work in any order.

Removed registrations are forgotten, so a deleted folder can be used again in the same session (R2):

- `retireRegistrationOnRelease(lease)`: a successful `delete-instance` (or a `save-instances` that removed the registration) arms retirement; the record is forgotten when that exclusive lease is released, only if it is then idle and unblocked.
- `retireIdleRegistration({instanceId, serverPath})`: forgets an exact, idle, unblocked record; used for clients that disappeared from the registry.
- A record with a start, a recovery block, a revision failure or a new-server install reservation is never retired, and a lifecycle fence is carried over by path to the next record for that folder.
- A bound ID that is registered nowhere, on an idle record, is retired before the folder is used again.
- Both helpers are best-effort and never fail the writer that already succeeded.

`normalizeServerPath` accepts drive roots and UNC share roots, keeps the caller's spelling and keys records by NFC plus lower case, so an NFD folder name resolves on disk.

## Change counters and lifecycle fences

Every lease keeps its own revision base. When the coordinator publishes N to N+1 for one lease, every other live ordinary or start lease on that folder based on N moves to N+1, so a write while the server runs never makes the next start fail its compare-and-set. A lease based on anything else saw a genuine external change.

A revision bump that was refused before anything was written (every legacy-writer failure is advisory and tagged `pre-publication`) keeps the writer's result and sets a lifecycle fence (`revision-not-recorded`) instead of quarantining the folder or stopping Java. A lease base below the highest revision the folder has shown (a restored or replaced config) sets the fence `revision-rolled-back`. Ordinary writers and plain starts ignore fences. The next modpack lifecycle admission on a fenced folder performs one repair bump through the folder's own writer and then throws `PLAN_STALE` ('review the modpack change again'); an ordinary bump never clears a fence. Any other revision failure keeps the full quarantine, which in practice happens only on folders with evidence.

A full backup restore puts the pre-restore counter back after extraction (`restoreContentRevision`), so the restore's own bump continues from it and counters stay monotonic even for v26.6.1 backups, which have no counter (N4).

## Instance configuration writers

`.minecraft-core.json` and `client-config.json` are written through a per-folder capability chosen on every call by `createInstanceConfigFsFactory` (`electron/utils/instance-config-fs.cjs`), wired into config-manager and the coordinator by the service graph.

- **Legacy writer, for folders without evidence (`unmanaged`):** a `wx` temp file in the instance folder, fsync and rename; when the rename is refused (EPERM, EACCES, EBUSY: a sync client, antivirus or read-only file) the v26.6.1 in-place write, still compare-and-set. It needs no ArchiveWorker and makes no realpath, reparse, UNC, NFC, basename or root checks, so junctions, SUBST and mapped drives, UNC paths, drive roots and NFD names work as in v26.6.1. An unreadable config (BOM, damaged JSON) is replaced after its exact bytes are kept as a create-only `<file>.unreadable-<sha12>` (none for an empty file). Every failure is advisory, so it can fence modpack work but never quarantine a server.
- **Strict writer, for `lifecycle` or `unknown` folders:** the native durable writer (ArchiveWorker) with fail-closed parsing, unchanged.

Invariant, pinned by `tests/legacy-writer-invariant.test.cjs`: no lifecycle or recovery code writes `.minecraft-core.json` in place in a live folder without evidence. Publication writes candidate folders that already carry the evidence layout and swaps them in.

## Live-folder probe

`probeLiveServerFolder` (`electron/services/modpack-lifecycle/live-server-folder-probe.cjs`) reads `level-name` from `server.properties` and then one byte of `<level-name>\session.lock`. A running Minecraft server holds that lock exclusively, so EBUSY or EPERM means a server that Minecraft Core did not start still owns the world. Modpack lifecycle and recovery operations call it after proving the app's own server stopped and refuse with `SERVER_RUNNING` ('A Minecraft server that Minecraft Core did not start is still using this folder') unless the probe proves the folder free. The probe opens files read-only and never creates, writes or deletes anything; ordinary writers and starts never use it.

## Reviewed downstream write sites

| File/service | Owned writes | Boundary |
| --- | --- | --- |
| `electron/utils/config-manager.cjs` | `.minecraft-core.json` publication, unreadable-config preservation, restore counter write-back | marks the ambient owned path after validation and immediately before publication through the folder's instance-config capability; only the legacy writer replaces an unreadable config |
| `electron/utils/instance-config-fs.cjs` | legacy temp/rename publication, in-place compare-and-set fallback, `*.unreadable-*` copies | chosen per call for folders without evidence; never used by lifecycle or recovery publication |
| `electron/services/server-content-revision.cjs` | server counter through config-manager; client counter in `client-config.json` | compare-and-set through the capability the coordinator passes |
| `electron/services/server-launcher.cjs` | `server.properties` network overlay and the Forge root shim at start | marks the start lease dirty first; an unchanged `server.properties` is not rewritten |
| `electron/ipc/file-handlers.cjs` | initial `mods`/`logs`/`config`, EULA, world backup and deletion | selected folders acquire explicitly; registered channels use the closed policy |
| `electron/ipc/config-handlers.cjs` | config update and exact old-runtime cleanup | config publication marks dirty before cleanup; reads never normalize on disk |
| `electron/ipc/server-properties-handlers.cjs` | properties, `.bak`, explicit default snapshot/restore | marks before the first copy/write; property reads do not create a backup |
| `electron/services/download-manager.cjs` | streamed server/runtime destination | marks the destination under the ambient server lease before directory/file creation |
| `electron/services/loader-install-service.cjs` | app-controlled loader runtime | called only by coordinated runtime handlers in this pass; validation remains before publication |
| `electron/services/forge-runtime-finalizer-worker.cjs` | loader-service-mediated Forge finalization may materialize `forge-<minecraft>-<loader>.jar` and `minecraft_server.<minecraft>.jar`, then atomically publish `.minecraft-core-state/runtime.json`; it hashes but does not rewrite the selected `libraries/**`, `versions/**`, and runtime-root artifacts | authenticated child entrypoint accepts one exact canonical server root and Forge runtime tuple; the finalizer revalidates contained regular-file identity before and after metadata publication |
| `electron/services/java-archive-worker-client.cjs` and `java-archive-worker.cjs` | extracts a parent-verified Java ZIP into a request-unique staging directory, publishes the exact `java-N` destination, and removes the exact request staging directory after a cancelled/failed child closes | authenticated one-shot child accepts only a canonical Java root, its `temp/*.zip`, a direct `java-N` child, and the parent-pinned archive size/SHA-256; path, link, entry, expansion, extracted-tree, cancellation, and clean-exit checks fail closed |
| `electron/services/managed-runtime-worker.cjs` | prepare mode delegates all loader-family writes beneath the exact server root: `.minecraft-core-state/runtime-staging/**`, final `libraries/**`, `versions/**`, loader-specific root artifacts, and `.minecraft-core-state/runtime.json`; verify mode is read-only | authenticated child entrypoint preflights the canonical target directory and regular Java executable, then calls the loader-service in-process seam with mutation marking disabled because the parent already owns the lifecycle lease |
| `electron/utils/windows-durable-fs-client.cjs` | trusted write-through rename/replace and directory durability acknowledgements through the pinned native helper | lifecycle cleanup uses the asynchronous, identity-bound directory-flush path; stdout/stderr and runtime are bounded, timeout tree-kills the helper, success is accepted only after a clean close, and the exact directory plus allowed roots are revalidated before and after the await |
| `electron/services/server-java-manager.cjs` and Java manager | server-local Java directory and runtime | lazy reads; `beforeFilesystemMutation` marks the owning server lease |
| `electron/services/backup-service.cjs` | restore deletion/extraction and the pre-restore counter write-back | archive entries are validated, then the lease is marked before server-content deletion/extraction; ordinary backup create/list/rename/delete take the per-folder backup lock |
| `electron/utils/tls-utils.cjs` | management TLS stored in server config | flows through `updateServerConfig`, which marks the ambient lease |
| `electron/services/auto-restart.cjs` | per-server auto-restart config | renderer channel is coordinated; server config write uses the config boundary |
| `electron/ipc/player-handlers.cjs` | whitelist, ops, bans, IP/name mapping | marks immediately before an actual list/mapping write; duplicate add/remove operations remain clean |
| `electron/ipc/settings-handlers.cjs` | atomic same-directory publication of `client-config.json`; optional first-time `servers.dat` and `.servers-initialized` setup | explicit setup keeps multiplayer initialization enabled; auth-only session-token persistence passes `initializeMultiplayer: false`, so it neither initializes nor modifies multiplayer files; a failed publication removes its request-unique temporary file and cannot leave a partial final config |
| `electron/ipc/mod-utils/mod-file-manager.cjs` | mod files, disabled/ignored state, manifests, category moves | read APIs never create directories or persist metadata; explicit migrations and mutations mark the owning root; ignored-updates saves stage a `wx` temp file, keep unreadable bytes aside and publish by rename |
| `electron/ipc/mod-utils/mod-installation-service.cjs` | downloaded mod, shader/resource-pack files and manifests | marks immediately before content directory creation/publication |
| `electron/ipc/mod-utils/file-integrity-service.cjs` | checksum sidecars beside managed files | installed-file calls are coordinated; temporary download sidecars remain staging-only |
| client/manual/launcher handlers and launcher downloaders | standalone client files, manifests, expected-state, auth, version markers, runtime, and assets | all registered content paths resolve through the content policy; nested helpers mark before writes, including partial downloads and version-change cleanup |
| `electron/services/mod-availability-watcher.cjs` | watches and fulfilled-history JSON | hydration is read-only; Modrinth lookups run outside any lease; IPC uses its ambient lease and background publications take one short ordinary lease per server in the `mod-watch` lane |
| `electron/services/browser-panel-server.cjs` | HTTP management, settings, backup restore/delete, player, property, Java and mod routes | routes call pre-coordinated handler groups or `runCoordinatedWriter` with the app's shared policy (`configureBrowserPanelMutationPolicy`), so browser writes get the same modpack-state and matching-client checks as desktop IPC |
| `electron/bootstrap/create-degraded-modpack-fallbacks.cjs` | `<userData>\client-packs\processes` for the degraded client guard | app data only; instances without evidence keep working, durable launch records are refused |

## Read-only guarantees

- `read-config` returns normalized data in memory and never rewrites the source file.
- file-handler configuration reads do not create a config or mutate the store.
- `read-server-properties` no longer creates `server.properties.default`; the snapshot is created only during an explicit write when an original exists.
- `get-settings` does not repair `lastServerPath` as a side effect.
- `get-instances` may hydrate returned DTOs from folder configuration, but it does not migrate secrets, rewrite folder configuration, persist the hydrated result, or update instance context.
- startup server-config inspection and imported-server default hydration stay in memory; missing defaults are persisted only by a later explicit mutation.
- `get-management-invite-info` and `update-management-server-path` inspect existing invite metadata without generating, migrating, or persisting it. A missing secret remains unconfigured until explicit server start or secret regeneration.
- server Java availability checks remain directory-creation free.
- `read-players` normalizes legacy banned-IP records only in memory and never rewrites the list or player map.
- `list-mods`, installed-mod metadata, disabled/ignored state, shader/resource-pack listing, client assets, availability watches, and availability history do not create directories or refresh manifests.
- legacy expected-mod state is normalized in memory; corruption is not deleted during a load.
- modpack source inspection and both install and management preflight channels only create opaque, expiring plans outside server roots; server content changes begin only after `modpacks:start-operation` validates the reviewed fingerprint.
- modpack state for display, the policy and companion reads goes through the state observer, which answers `null` for a folder whose state is proven absent without the parent-scoped strict repository; the ownership predicate and the live-folder probe never write.

## Narrow ancillary exceptions

The following writes do not alter server launch bytes or managed ownership state and do not increment `contentRevision`:

- creation, rename, retention, metadata, size cache, and progress logging for ordinary user backups; restore itself is never ancillary;
- application logs, metrics, crash counters, notification state, and renderer progress events;
- application-store-only UI preferences, cached certificate pins, last-selected path, window state, backup size-cache invalidation, and in-memory management-server path selection;
- controlled download staging outside a registered server root before final publication.
- temporary mod-download staging, queue controls, global mod-category UI preferences, corruption-alert memory, and availability interval memory.
- local archive selection/staging, lifecycle job cancellation, notification acknowledgement, and release-tracking publication outside server roots.
- the app's own data folder: the service graph's canonical `userData` and the degraded client guard's process folder.

## Closed inventory enforcement

`server-writer-inventory.cjs` scans every reviewed handler factory for mutation-shaped channel names. Each such channel must exist in the closed `SERVER_WRITER_POLICIES` table or the narrow ancillary set above. It also computes a stable digest from the reviewed filesystem-write call sites across the core, content, browser, downstream launcher/service inventory, the instance-config writers, the start-lease writers and authenticated child writer entrypoints. A new or changed `writeFile`, stream publication, descriptor or file-handle open/write (including an open whose flag is computed rather than a read-only literal or `O_RDONLY`), truncation, directory creation, rename, copy, deletion, durable publication (`writeJsonAtomic`, `writeFileAtomic`, `renameDurable`, `preserveUnreadable`), zip extraction or write, `restoreContentRevision`, or reviewed loader-service preparation/finalization seam changes that digest and fails `tests/server-writer-inventory.test.cjs` until the site and policy are reviewed together. Every digest change carries a one-line `Reviewed:` note in the table. The ownership predicate and the live-folder probe are pinned with the digest of an empty write-site list.
