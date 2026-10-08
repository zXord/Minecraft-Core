# Server writer inventory

This inventory is the reviewed boundary for filesystem and durable configuration writes owned by a Minecraft server. A registered server is keyed by its stable instance ID and canonical server path. IPC entry points listed as coordinated are wrapped by `server-mutation-policy.cjs` before the handler runs. Nested services mark the active lease immediately before their first filesystem mutation so partial failures still advance the content revision once.

## Core coordinated IPC writers

| Area | Channels | Revision policy | Selector |
| --- | --- | --- | --- |
| Server config | `write-config`, `update-config` | automatic when bytes are written | `serverPath` |
| Folder/version | `select-folder`, `save-version-selection` | automatic | selected path / payload path |
| EULA/world | `write-eula`, `delete-world` | automatic | payload path / server path |
| Settings/instances | `update-settings`, `save-instances` | automatic per root actually written | stable ID plus registered path |
| Instance lifecycle | `rename-instance`, `delete-instance` | exclusive, no post-delete revision write | stable ID resolved before work |
| Server properties | `write-server-properties`, `generate-server-properties`, `restore-backup-properties` | automatic | registered server path |
| Server runtime | `download-minecraft-server`, `download-and-install-loader`, `download-and-install-fabric`, `repair-health` | automatic when runtime bytes change | target path |
| Server Java | `server-java-ensure` | automatic at the Java filesystem boundary | server path |
| Restore | `backups:restore` | automatic | server path; running server is rejected |
| Protected backup metadata | `backups:delete`, `backups:rename`, `backups:apply-retention-policy`, `backups:save-retention-settings` | exclusive; backup-only writes do not revise launch content | server path |
| Backup automation config | `backups:configure-automation` | automatic when folder config changes | server path |
| Auto restart config | `set-auto-restart` | automatic when a target server is supplied | target path |
| Managed modpack lifecycle | `modpacks:start-operation`, `modpacks:recover`, `modpacks:verify`, `modpacks:perform-safe-action` | lifecycle-owned exact revision; handlers acquire internally through the shared coordinator | opaque plan, job, recovery, or action IDs resolved only in main |

## Content and management coordinated IPC writers

| Area | Channels | Revision policy | Selector |
| --- | --- | --- | --- |
| Player lists | `add-player`, `add-player-with-details`, `remove-player` | automatic only when a list or player/IP mapping changes | registered server path in argument 2 |
| Management metadata | `start-management-server`, `set-management-server-external-host`, `set-management-invite-host`, `regenerate-management-invite-secret` | automatic when invite/TLS/config bytes change | stable server ID and path |
| Server mods | `direct-add-mod`, `save-disabled-mods`, `save-ignored-mod-updates`, `install-mod`, `install-mod-with-fallback`, `download-mod-with-fallback`, `add-mod`, `delete-mod`, `update-mod`, `move-mod-file`, `enable-and-update-mod`, `auto-redownload-corrupted-file`, `store-file-checksum` | automatic | registered server root; nested checksum paths resolve to that root |
| Shaders/resource packs | `delete-shader`, `delete-resourcepack`, `install-shader-with-fallback`, `install-resourcepack-with-fallback` | automatic | registered server root, including its managed `client` subtree |
| Client/manual mods | `install-client-mod`, `update-client-mod`, `disable-client-mod`, `update-client-mods`, `disable-client-mods`, `download-client-mod-version-updates`, `remove-manual-mods`, `toggle-manual-mod`, `update-manual-mod`, `clear-client-mod-cache` | automatic | stable client instance root, or the containing registered server root |
| Launcher content | auth save/import/refresh/clear, mod and asset download/remove/toggle/delete, client runtime download/clear, launch preparation, expected-state reconciliation, dependency acknowledgement, download preferences | automatic when bytes change | `clientPath`, `targetClientPath`, or stable client ID resolved to its owning registered root |
| Explicit metadata migration | `migrate-server-mod-metadata`, `migrate-client-mod-metadata` | automatic | registered owning root |
| Availability state | `mod-watch:add`, `mod-watch:remove`, `mod-watch:clear`, `mod-watch:history:clear` plus periodic state/history publication | automatic | registered server root |

The selector resolver accepts a client path only when it is either an exact registered client instance or lies inside a registered server root. It chooses the most specific registered owner and never derives ownership from a display name, remote host, or renderer-provided alias. Standalone client revisions are compare-and-set in `client-config.json`; they never create a server `.minecraft-core.json`. Path-shaped legacy `instanceId` values are resolved only when they exactly identify a registered root.

`save-instances` reserves every current and incoming server root in deterministic order. The grouped lease attributes each config write to the owning path; untouched roots do not receive a revision bump.

## Reviewed downstream write sites

| File/service | Owned writes | Boundary |
| --- | --- | --- |
| `electron/utils/config-manager.cjs` | `.minecraft-core.json` publication | marks the ambient owned path after validation and immediately before durable publication |
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
| `electron/services/backup-service.cjs` | restore deletion/extraction | archive entries are validated, then the lease is marked before server-content deletion/extraction |
| `electron/utils/tls-utils.cjs` | management TLS stored in server config | flows through `updateServerConfig`, which marks the ambient lease |
| `electron/services/auto-restart.cjs` | per-server auto-restart config | renderer channel is coordinated; server config write uses the config boundary |
| `electron/ipc/player-handlers.cjs` | whitelist, ops, bans, IP/name mapping | marks immediately before an actual list/mapping write; duplicate add/remove operations remain clean |
| `electron/ipc/settings-handlers.cjs` | atomic same-directory publication of `client-config.json`; optional first-time `servers.dat` and `.servers-initialized` setup | explicit setup keeps multiplayer initialization enabled; auth-only session-token persistence passes `initializeMultiplayer: false`, so it neither initializes nor modifies multiplayer files; a failed publication removes its request-unique temporary file and cannot leave a partial final config |
| `electron/ipc/mod-utils/mod-file-manager.cjs` | mod files, disabled/ignored state, manifests, category moves | read APIs never create directories or persist metadata; explicit migrations and mutations mark the owning root |
| `electron/ipc/mod-utils/mod-installation-service.cjs` | downloaded mod, shader/resource-pack files and manifests | marks immediately before content directory creation/publication |
| `electron/ipc/mod-utils/file-integrity-service.cjs` | checksum sidecars beside managed files | installed-file calls are coordinated; temporary download sidecars remain staging-only |
| client/manual/launcher handlers and launcher downloaders | standalone client files, manifests, expected-state, auth, version markers, runtime, and assets | all registered content paths resolve through the content policy; nested helpers mark before writes, including partial downloads and version-change cleanup |
| `electron/services/mod-availability-watcher.cjs` | watches and fulfilled-history JSON | hydration is read-only; IPC uses its ambient lease and background publications acquire their own lease |
| `electron/services/browser-panel-server.cjs` | HTTP management, settings, backup restore/delete, player, property, Java and mod routes | routes call pre-coordinated handler groups or `runCoordinatedWriter`; they do not construct raw content handlers per request |

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

## Narrow ancillary exceptions

The following writes do not alter server launch bytes or managed ownership state and do not increment `contentRevision`:

- creation, rename, retention, metadata, size cache, and progress logging for ordinary user backups; restore itself is never ancillary;
- application logs, metrics, crash counters, notification state, and renderer progress events;
- application-store-only UI preferences, cached certificate pins, last-selected path, window state, backup size-cache invalidation, and in-memory management-server path selection;
- controlled download staging outside a registered server root before final publication.
- temporary mod-download staging, queue controls, global mod-category UI preferences, corruption-alert memory, and availability interval memory.
- local archive selection/staging, lifecycle job cancellation, notification acknowledgement, and release-tracking publication outside server roots.

## Closed inventory enforcement

`server-writer-inventory.cjs` scans every reviewed handler factory for mutation-shaped channel names. Each such channel must exist in the closed `SERVER_WRITER_POLICIES` table or the narrow ancillary set above. It also computes a stable digest from the reviewed filesystem-write call sites across the core, content, browser, downstream launcher/service inventory, and authenticated child writer entrypoints. A new or changed `writeFile`, stream publication, descriptor or file-handle open/write, directory creation, rename, copy, deletion, or reviewed loader-service preparation/finalization seam changes that digest and fails `tests/server-writer-inventory.test.cjs` until the site and policy are reviewed together.

Task 26 must keep the policy table and scanned write-site inventory closed when lifecycle IPC is added.
