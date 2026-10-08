# Modpack Lifecycle and GitHub Release Import Design

**Date:** 2026-08-01
**Status:** Approved for implementation planning
**Product:** Minecraft Core
**Initial providers:** Modrinth, GitHub Releases, and local archives

## Summary

Minecraft Core will gain a complete modpack lifecycle rather than treating a pack as a loose collection of individually installed mods. Users will be able to browse Modrinth modpacks, select exact versions, create a server from a pack, install or switch a pack on an existing server, update or downgrade it, verify or repair it, detach management, and safely uninstall pack-owned files.

GitHub Releases is a day-one source because some projects publish server packs there before or instead of publishing them to Modrinth. A user can explicitly add a public GitHub repository, select a release and asset, and import `.mrpack`, ZIP, RAR4, RAR5, or complete multipart RAR packages. GitHub is an explicit artifact source and release tracker, not a universal modpack catalog.

All mutating operations are owned by one durable main-process lifecycle service. Downloads, archive inspection, extraction, runtime preparation, ownership reconciliation, commit, health validation, rollback, and recovery form one operation. The renderer never coordinates partial filesystem changes.

CurseForge remains unavailable and does not carry a roadmap promise. Its UI label becomes **CurseForge (Unavailable)** with the visible explanation **CurseForge browsing is unavailable in this build.**

## Context and Current Limitations

The current application has several useful foundations, but no pack-level model:

- The setup wizard creates a manually configured Vanilla, Fabric, or Forge server and writes into the selected destination as it advances. See [`src/components/setup/SetupWizard.svelte`](../../../src/components/setup/SetupWizard.svelte).
- The Mods UI searches and installs individual files. The Modrinth service already accepts a `projectType` filter, but the renderer and IPC expose mod-oriented operations. See [`electron/services/mod-api-service.cjs`](../../../electron/services/mod-api-service.cjs).
- CurseForge is a stub with "Coming Soon" copy. See [`src/components/mods/components/ModSearch.svelte`](../../../src/components/mods/components/ModSearch.svelte).
- Runtime detection recognizes Fabric, Forge, NeoForge, and Quilt markers, but installation and launch are complete only for Fabric and Forge. See [`electron/utils/server-loader.cjs`](../../../electron/utils/server-loader.cjs), [`electron/services/loader-install-service.cjs`](../../../electron/services/loader-install-service.cjs), and [`electron/services/server-launcher.cjs`](../../../electron/services/server-launcher.cjs).
- Existing full backups are valuable user restore points, but restore overlays files and cannot by itself prove exact rollback of newly created files. See [`electron/services/backup-service.cjs`](../../../electron/services/backup-service.cjs).
- Existing path and remote URL boundaries are reusable, but archive extraction needs entry-level and post-extraction protections beyond lexical path checks. See [`electron/utils/security-boundaries.cjs`](../../../electron/utils/security-boundaries.cjs).
- Electron Builder currently packages application files but no external archive extractor. See [`package.json`](../../../package.json).

The feature therefore requires a pack identity, exact version and artifact identity, managed-file ownership, conflict-aware upgrades, a transaction journal, secure archive handling, complete loader support, and health-gated commit semantics.

## Goals

1. Browse, inspect, and install Modrinth modpacks without adding their mods one by one.
2. Import server-pack releases from explicitly trusted public GitHub repositories on day one.
3. Import local `.mrpack`, ZIP, and supported RAR packages through the same inspection and transaction engine.
4. Support exact version selection, upgrade, downgrade, switching, verification, repair, detach, and uninstall.
5. Preserve worlds, user settings, access lists, secrets, user-added mods, and modified files unless the user explicitly chooses otherwise.
6. Never leave a server in an untracked partially updated state after an ordinary failure, cancellation, or application restart.
7. Notify users of available releases without silently installing them.
8. Support the complete Modrinth server loader set required by selected packs: Vanilla where applicable, Fabric, Forge, NeoForge, and Quilt.
9. Keep provider-specific API details out of the lifecycle engine so CurseForge or another catalog can be added later.
10. Ship the archive extractor, notices, recovery behavior, and packaged smoke coverage as part of the feature.

## Non-goals for Day One

- CurseForge browsing or installation.
- FTB catalog integration.
- Private GitHub repositories or GitHub authentication.
- Webhook delivery for arbitrary GitHub repositories.
- Automatic installation of modpack updates.
- Executing scripts, executables, or arbitrary installer JARs supplied by a pack.
- Installing password-protected archives. They may be downloaded, but inspection and installation stop with a clear explanation.
- Automatically identifying and adopting an arbitrary manually installed pack. A user may explicitly select a known source/version and reconcile it against the existing server.
- Guaranteeing that a provider-verified JAR is safe code. Hashes establish artifact identity and transport integrity, not harmlessness.

## Product Decisions

| Area | Decision |
| --- | --- |
| Primary catalog | Modrinth |
| Supplementary day-one source | Public GitHub Releases added explicitly by repository URL or a trusted upstream mapping |
| Local import | `.mrpack`, ZIP, RAR4, RAR5, and complete multipart RAR |
| CurseForge wording | `CurseForge (Unavailable)` plus visible explanatory text; no "Coming Soon" |
| Update policy | Notify and review; never silently install |
| Version identity | Exact provider version/release/asset IDs and digests; never an implicit "latest" fallback |
| Archive engine | Reproducibly pinned full official 7-Zip CLI through a least-privilege Windows `ArchiveWorker` broker |
| Encrypted archives | Rejected for installation on day one |
| Unknown packages | Guided root/runtime selection when safely classifiable; otherwise reject |
| Pack scripts | Never run automatically |
| Existing-server mutation | Server stopped, verified restore point, complete sibling candidate, isolated health test, journaled directory swap, exact rollback |
| World downgrade | Restore the matching pre-upgrade world snapshot; binary rollback alone is insufficient |

## User Experience

### Server Creation

The setup flow gains an initial method choice after Server Manager:

1. **Empty/Custom Server**
2. **Install Modpack**

The modpack path then offers:

1. **Browse Modrinth**
2. **Import GitHub Release**
3. **Import Local Archive**

The existing manual server flow remains available and retains its current meaning.

### Modrinth Flow

The Modrinth browser presents server-relevant modpacks with search, category, Minecraft version, loader, release channel, updated date, download count, and server compatibility filters. Selecting a project opens its description, supported runtimes, gallery where available, and exact version history.

The user selects an exact version. The application does not substitute a newer compatible version during execution. If the chosen version disappears or changes before download, planning stops and the user returns to version selection.

Loading, empty, offline, rate-limited, and retryable failure states preserve the user's filters and search. They offer appropriate combinations of **Retry**, **Import local archive**, and **Empty/Custom Server** rather than clearing the flow.

### GitHub Release Flow

The user pastes a public repository or release URL, or accepts a GitHub repository linked from a Modrinth project. The application resolves and stores the repository's permanent numeric ID in addition to owner/name.

Release selection defaults to stable releases. Prereleases are hidden until the user enables them; drafts are never offered. Every uploaded release asset is shown with:

- filename;
- size;
- upload and update timestamps;
- file type inferred from magic bytes after download;
- provider digest availability;
- labels such as **Likely server pack**, **Modrinth pack**, **Client pack**, **Source**, or **Unknown**.

Before download, file type and role are explicitly provisional and use only provider metadata, filename, extension, and an opted-in saved matching rule. After the selected asset or multipart group downloads, magic-byte, integrity, and archive classification results replace those provisional labels. Preselection never means inspection has passed.

Multipart RAR assets appear as one package choice with part count, combined size, naming scheme, and missing-volume state. An incomplete group is disabled with an adjacent explanation.

The application never installs the first ZIP automatically. It may preselect one asset only when a single candidate has strong provisional evidence, but the user still reviews it and post-download inspection must pass. If no installable uploaded asset exists, the UI explains that generated GitHub source archives are not server packs and offers local import or empty-server creation. Loading and retryable failure states preserve the pasted repository/release URL.

An opt-in **Use this asset pattern for future releases** choice records a normalized name pattern, prior asset role, archive-root fingerprint, runtime evidence, and user overrides. A later release is preselected only when exactly one asset matches with high confidence. Zero or multiple matches produce an **Asset selection required** notification.

### Archive Inspection and Guided Import

After download, the review flow shows:

- archive type and integrity result;
- an archive tree preview;
- proposed server root and alternate candidate roots;
- classification and supporting evidence;
- Minecraft version;
- loader family and exact loader version;
- Java major requirement;
- file count and expanded size;
- protected, pack-managed, user-owned, and conflicting paths;
- planned downloads, runtime construction, writes, removals, and preserved files;
- EULA acknowledgement where required.

Ambiguous roots or runtime candidates block continuation. The user can choose another root, choose another asset, supply a supported runtime choice, import files only into a new unmanaged server when safe, or cancel with no server changes.

### Existing Server Modpack Tab

`App.svelte` gains a top-level **Modpack** tab beside **Mods**. The tab is available for all servers:

- unmanaged servers offer browse/import/install;
- managed servers show pack, provider, installed release, runtime, integrity status, last update check, and available releases;
- pack-managed files and mods are visibly distinguished from user additions;
- pack version changes in Settings route through this lifecycle instead of independently changing Minecraft or loader versions.

Managed-server actions are:

- **Review update**;
- **Change version** for upgrade or downgrade;
- **Switch modpack**;
- **Verify/repair**;
- **Rollback to restore point**;
- **Detach management and keep files**;
- **Uninstall managed files**.

### Progress, Cancellation, and Failure

User-visible stages are:

1. Resolving
2. Downloading
3. Verifying
4. Inspecting
5. Planning
6. Creating restore point
7. Extracting
8. Reconciling files
9. Configuring runtime and Java
10. Validating candidate on loopback
11. Committing directory swap
12. Starting from the final server path
13. Validating final health
14. Cleaning rollback staging
15. Completed, or Rolling back

Progress is operation-scoped and includes a stable job ID. Cancellation is available before commit. Once commit begins, the UI explains that Minecraft Core is completing the transaction or rollback and does not offer cancellation.

The progress screen explains that health validation may temporarily start the server and that the prior running/stopped preference will be restored. A pre-commit cancellation leaves the server unchanged but may retain a content-addressed cache download or an already verified restore point. The result screen lists retained artifacts and offers their safe cleanup actions.

Failures distinguish these outcomes and actions precisely:

- **Nothing changed** — **Retry**, **Change selection**, or **Open details**;
- **Downloaded file retained for manual use** — **Open folder**, **Remove download**, or **Choose another asset**;
- **Update failed; server restored successfully** — **Return to server** or **Review restore point**;
- **Automatic recovery required on next launch** — normal server launch is blocked; offer **Restart and recover** or **Open details**;
- **Manual recovery required** — normal server launch is blocked; offer **Review recovery**, **Restore from restore point**, or **Open diagnostic details**.

Journal paths and low-level recovery data remain in diagnostic details rather than becoming the primary user instruction.

Detach and uninstall confirmations include a side-by-side behavioral summary:

- **Detach and keep all files** stops pack management and release notifications and removes nothing.
- **Remove managed pack files** states the number of unchanged managed files to remove, preserves worlds/user files/modified files, may leave a non-runnable files-only instance, and does not delete the instance or its world.

Both confirmations default focus to **Cancel**.

## Architecture

### Separation of Responsibilities

Provider catalog behavior, artifact acquisition, archive interpretation, runtime construction, and server mutation are separate layers:

- `CatalogProvider` supports search, project details, and version lists. Modrinth implements it on day one.
- `ArtifactSource` resolves an exact downloadable artifact. Modrinth, GitHub Releases, and local files implement it.
- `ReleaseTracker` checks for newer or different releases. Modrinth and GitHub implement it.
- `ArtifactDownloader` streams to a partial file, enforces URL and size policy, follows validated redirects, calculates digests, and atomically finalizes the cache entry.
- `ArchiveInspector` lists entries without installing, applies archive policy, unwraps a single unambiguous wrapper directory, and classifies candidates.
- `ArchiveWorker` is a least-privilege Windows broker that runs the pinned extractor without network access or ambient filesystem authority and enforces process/resource limits.
- `MrpackParser` validates the Modrinth manifest and creates the server-side file plan.
- `RuntimeManager` installs or validates an exact Vanilla, Fabric, Forge, NeoForge, or Quilt runtime using application-owned logic.
- `OwnershipPlanner` produces the three-way file reconciliation and explicit conflict list.
- `ModpackLifecycleService` owns jobs, durable phases, staging, snapshot, journal, commit, health validation, rollback, and recovery while acquiring shared locks through `ServerMutationCoordinator`.
- `ServerMutationCoordinator` is the shared per-server gate for every application writer and every server start, including existing mod, settings, backup-restore, repair, world, setup, and lifecycle handlers.
- `RecoveryRegistry` records active operations under Electron `userData` before staging or mutation so interrupted work can be found even when a server is new, moved, offline, or not yet registered.
- `ReleaseMonitor` schedules checks and creates persistent notifications.

GitHub is intentionally not forced into `CatalogProvider`; it has no safe equivalent of curated modpack browsing. Future CurseForge support adds adapters without changing archive, ownership, or transaction behavior.

### Main-process Ownership

All network access, archive subprocesses, filesystem inspection, hashing, runtime installation, backup creation, mutation, launch, and recovery execute in the Electron main process. The renderer receives serializable view models and requests plans or operations through allowlisted IPC.

The renderer may not pass an arbitrary command, extractor argument, download destination, server path, archive path, or unvalidated URL to the service. Existing instances are referenced by stable main-process instance IDs. A native file picker immediately copies and hashes the selected file or multipart set into controlled cache/staging, or retains it behind a short-lived opaque selection ID. Planning and execution accept that ID; they never trust a renderer-replayed path. Multipart local import uses picker multi-selection and validates the complete reviewed set before inspection.

### Provider-neutral Identity

An installed source record contains:

```json
{
  "provider": "modrinth | github | local",
  "project": {
    "id": "provider-stable-id",
    "slug": "display-slug",
    "title": "display title"
  },
  "release": {
    "id": "provider-stable-release-id",
    "version": "display version",
    "channel": "release | beta | alpha | prerelease",
    "publishedAt": "ISO-8601"
  },
  "artifactSet": {
    "kind": "single | multipart",
    "primaryPartId": "part-1",
    "groupingScheme": "single | part-number | rar-rxx | numbered-volume",
    "parts": [
      {
        "partId": "part-1",
        "providerAssetId": "nullable provider-stable-asset-id",
        "fileName": "serverpack.part1.rar",
        "size": 123,
        "updatedAt": "ISO-8601",
        "providerDigest": {
          "algorithm": "sha256",
          "value": "nullable publisher value"
        },
        "calculatedDigests": {
          "sha256": "...",
          "sha512": "..."
        }
      }
    ],
    "setDigest": "sha256 of the canonical ordered part identities",
    "providerImmutable": false,
    "attestationStatus": "unavailable | unverified | verified"
  }
}
```

Fields that do not apply to a source are omitted, not guessed. A publisher/provider digest is nullable, while Minecraft Core always calculates SHA-256 and SHA-512 for every downloaded or selected part. Provider immutability and attestation status are recorded separately from byte identity. For GitHub, permanent repository ID, release ID, asset ID, owner/name, tag, asset timestamps, ETag, and available provider digest are stored. Tag or filename alone is never identity.

An `artifactSet` is either one part or an ordered multipart set. `primaryPartId` references an application-stable `parts[].partId`; `providerAssetId` is nullable and exists only for provider-backed assets. Local part identity uses the validated basename and application-calculated digest within the reviewed selection. Multipart identity also records the release ID when applicable, grouping scheme, primary volume, and every volume's validated original basename, size, update timestamp, provider/calculated digests, plus a digest of the canonical ordered set. Every remote volume must come from the same reviewed release; local volumes must come from one explicit reviewed selection. Each volume is independently verified. A missing, changed, duplicate, or additional volume invalidates the plan, cache materialization, update comparison, and plan fingerprint.

GitHub and Modrinth releases are considered the same artifact only when their bytes match by a trusted digest or an author-approved persistent mapping exists. Similar display names are insufficient.

## Source Behavior

### Modrinth

Modrinth requests use `project_type:modpack` and exact project/version endpoints. The provider returns normalized compatibility and artifact data while preserving original provider IDs and channel metadata.

A selected `.mrpack` must have a supported format version and a valid `modrinth.index.json`. Each file entry is interpreted for the server environment:

- `server: required` is included;
- `server: optional` is offered and defaults to included unless the pack specifies otherwise;
- `server: unsupported` is excluded;
- absent `env` metadata follows the format default and is treated as required on both client and server;
- a pack with no usable server content and explicit server incompatibility is rejected as client-only.

Modrinth format v1 entries must contain both SHA-512 and SHA-1. Minecraft Core verifies both before placement and treats SHA-512 as authoritative if any diagnostic distinction is needed. A missing required hash or disagreement blocks installation. General `overrides/` are applied first and `server-overrides/` second. Client-only overrides are not applied.

Downloads must use public HTTPS and the download-domain allowlist published for the Modrinth pack format. Credentials, plain HTTP, private/reserved addresses, non-allowlisted domains, DNS rebinding, and unsafe redirects are rejected. A nonconforming locally supplied manifest is reported separately as unsupported; ordinary Modrinth installation does not broaden its trust policy through a confirmation prompt.

### GitHub Releases

Only repositories explicitly added by the user or linked through a trusted project relationship are monitored. Day one covers public repositories without tokens.

The release monitor:

- checks on startup when the interval has elapsed and every 12 hours while the application is running;
- applies jitter so multiple repositories are not queried at once;
- sends `If-None-Match` with stored ETags;
- honors `304`, rate-limit headers, `Retry-After`, and exponential backoff;
- excludes drafts;
- treats prereleases according to the repository preference;
- persists the last successful check and failure state.

There is no promise of checks while Minecraft Core is fully closed. Notifications are persisted in the app and may also use a native Windows notification while the application is running or minimized.

GitHub releases and assets are mutable unless protected by GitHub's immutable-release behavior. A change to asset ID, digest, size, or update timestamp under an already seen tag produces **Source changed or republished** and requires review. It is never presented as an ordinary safe update.

When GitHub supplies an asset SHA-256 digest, it must match. Minecraft Core still calculates local SHA-256 and SHA-512 in every case. A missing provider digest means publisher-authenticated integrity is unavailable, not that the downloaded bytes lack a stable local identity; it permits only a user-reviewed manual installation with a prominent warning. Digest mismatch blocks installation.

### Local Archives

Local imports use a native file picker and are copied or streamed into application staging before inspection. The original archive remains untouched. Local artifacts receive an application-calculated SHA-256 and SHA-512 identity.

Local import uses the same archive limits, classification, planning, ownership, transaction, and runtime behavior as remote sources.

### CurseForge

No CurseForge API calls, credentials, catalog results, placeholder dates, or "Coming Soon" promises are included. The provider control is disabled or non-actionable with adjacent visible text:

> CurseForge browsing is unavailable in this build.

The provider abstraction remains capable of accepting a future CurseForge adapter.

## Archive Engine and Safety Policy

### Bundled Extractor

Builds pin 7-Zip 26.02, or a later explicitly security-reviewed version, by exact official asset and Windows architecture via Electron Builder `extraResources`. Repository-controlled SHA-256 values verify every vendored `7z.exe` and required DLL. Builds never resolve an unversioned "latest" download, and runtime lookup never falls back to `PATH` or a system installation. Reduced `7za` or `7zr` builds are not used because they do not provide the required RAR coverage. A packaged check runs `7z i` and confirms the expected pinned version plus ZIP and RAR handlers.

The package ships the unmodified official 7-Zip `license.txt`, applicable LGPL 2.1-or-later and BSD texts/notices, the unRAR restriction, copyright notices, an identification that Minecraft Core uses 7-Zip, and a link to the exact corresponding source version.

The application invokes the pinned engine with an argument array, `shell: false`, `windowsHide: true`, absolute application-controlled paths, and `--` before an untrusted archive path. It never uses switches that preserve absolute paths, restore alternate streams/security descriptors, or weaken link protections.

Out-of-process execution alone is not considered sandboxing. `ArchiveWorker` launches 7-Zip through a restricted-token/AppContainer broker, or an equivalently reviewed Windows least-privilege boundary. Archive-data read access is limited to the isolated input directory, and archive-output write access is limited to the empty staging directory. Beyond read/execute access required for the pinned engine and Windows runtime, the worker has no network capability, inherited handles, shell, ambient user-directory access, or permission to spawn descendants. A Windows Job Object applies kill-on-close, one-process, cancellation, memory, output, and time limits. If the required broker cannot establish those restrictions, archive inspection fails closed rather than falling back to an unrestricted process.

The packaged Windows gate is measured rather than inferred. A zero-capability AppContainer receives only an explicit stdio handle list and exact journaled ACL leases. The supported host cannot combine this AppContainer launch with `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY`: both 7-Zip and a basic executable terminate during initialization with `0xc0000142`. The broker therefore enforces descendant denial with the Job Object active-process limit of one and requires a live probe's second-process attempt to fail. `ArchiveWorker` is published as an extraction-free self-contained single file, and the schema-v2 worker manifest pins `runtimeMode: in-memory-single-file`. `DOTNET_BUNDLE_EXTRACT_BASE_DIR` is set to the verified worker executable itself, so the current build creates no writable runtime copy and any future extraction-enabled build fails in the .NET host before managed code starts. AppContainer-rewritten profile/temp variables must remain inside controlled scratch, while ambient `PATH`, user data, network access, unrelated handles, and broker secrets remain unavailable.

Trusted durability operations use one `SetFileInformationByHandle(FileRenameInfoEx)` namespace mutation on the verified source handle. On the supported Win32 API/host, `RootDirectory` must be null for this call, so the target is a validated extended-length absolute local-drive path while its parent and the complete reparse-free ancestor chain remain pinned. Existing-file POSIX replacement requires the old target to allow share-delete; it still denies writers and is identity-checked immediately before and after mutation. NTFS name tunneling may apply the replaced name's cached creation time to the source object, so success compares the published path with a complete snapshot of the same still-open source handle after rename; birthtime remains part of that comparison. This leaves a narrow external target-slot concurrency risk at the exact authorized leaf, but prevents ancestor redirection and fails closed unless the required postcondition is proven. Every changed parent is flushed before success.

Inspection invokes the pinned engine with deterministic UTF-8 technical-list output and treats stdout and stderr as untrusted bounded text protocols. The streaming parser rejects malformed record order, duplicate or missing safety-relevant fields, undecodable or control-containing names, numeric overflow, unsupported entry types, and unknown fields that affect safety. Size arithmetic is overflow-safe and parser fixtures are pinned to the bundled engine version. The detected archive family is forced consistently during listing, integrity testing, and extraction rather than allowing extension-based format drift.

Every invocation is non-interactive: stdin is closed, no console is inherited, prompts are disabled where supported, output is bounded, and a hard timeout applies. No password argument is supplied. Only exit code `0` is success. Warning, fatal, command-line, out-of-memory, and cancellation exit codes all stop the operation. Any password-related diagnostic or failure maps to `ENCRYPTED_ARCHIVE`.

### Supported Archive Forms

- Modrinth `.mrpack`;
- single-file ZIP/ZIP64; split or spanned ZIP is unsupported on day one;
- RAR4;
- RAR5;
- multipart RAR when every required part is available.

Multipart GitHub assets are grouped using recognized naming schemes such as `.part1.rar`, `.part2.rar`, `.rar` plus `.r00`, or numbered volumes. The UI lists every required or missing part. A secondary volume cannot be installed alone. Recovery volumes such as `.rev` are not reconstructed on day one; every ordinary volume must be present.

For inspection and extraction, the verified exact volume set is materialized under validated original basenames in a fresh isolated input directory containing no unrelated siblings. Only the primary volume is passed to 7-Zip. Content-addressed cache keys remain internal and are never used as the sibling filenames expected by the archive engine.

Magic bytes determine the primary archive family before extension. Secondary RAR volumes are accepted only as members of the exact engine-confirmed set; extension patterns alone never establish membership. A family mismatch is reported and must not silently choose a parser based only on the filename.

### Encrypted Archives

Header-encrypted or file-encrypted archives are detected during listing or testing and rejected with `ENCRYPTED_ARCHIVE`. Entry encryption flags, encrypted-header/password-required diagnostics, or a password-related listing/test failure all map to that code, and integrity testing does not continue after encryption is detected. The UI explains that password-protected installation is not supported in this release and may retain the downloaded artifact for manual use. No password prompt, persistence, command-line exposure, or log field exists on day one.

### Entry Validation

Before extraction, reject entries containing or resolving to:

- absolute paths, drive-qualified paths, UNC paths, or root-relative paths;
- `..` traversal or an empty/ambiguous normalized destination;
- NUL characters or alternate data stream colons;
- Windows reserved device names;
- names with trailing dots or spaces;
- C0 or DEL control characters;
- file-versus-directory ancestor conflicts such as `a` and `a/b`;
- duplicate canonical destinations after Windows case, separator, trailing-dot/space, reserved-name, and Unicode-normalization rules;
- excessive depth or path length;
- symbolic links, hard links, junctions, reparse points, devices, other non-regular entry types, or any link/redirection target metadata.

No invocation enables absolute-path preservation, alternate-stream/security-descriptor restoration, or a switch such as `-snld20` that bypasses link checks. After extraction, walk the staging tree without following links. Reject reparse points and non-regular objects, re-check canonical collisions and normalized names, and prove every resolved path remains within staging. Extraction is never performed directly into a server folder.

### Resource Limits

Archive policy has centralized, versioned limits for:

- remote download/compressed bytes;
- entry count;
- total declared and actual expanded bytes;
- per-file expanded bytes;
- aggregate and per-entry compression ratio;
- directory depth and normalized path length;
- extractor wall-clock time and memory;
- required free-space reserve.

The implementation plan will choose conservative initial constants using representative real server packs and malicious fixtures. The operation preflight includes download, expanded staging, journal, restore point, and a safety reserve; it fails before mutation when capacity is insufficient.

Listing and extraction output are streamed and byte-bounded; they are never accumulated without limit. During extraction, the application watchdog continuously enforces elapsed time, actual staging bytes, file count, per-file size, and remaining free-space reserve. Crossing a limit terminates the entire Job Object immediately and removes staging. Pinned 7-Zip memory switches, including the RAR-specific memory limit where applicable, are always supplied, but engine switches do not replace the application's measured-output watchdog. Unknown or overflowing declared sizes fail closed unless a separately documented stricter policy safely handles them. Post-extraction measured usage must also remain within policy.

## Package Classification

The inspector unwraps at most one wrapper directory, and only when every meaningful entry is beneath that one directory. It assigns one of these classifications with evidence:

1. **`mrpack-server`** — valid Modrinth manifest, supported schema, usable server environment, verified file hashes, and valid overrides.
2. **`mrpack-client-only`** — server explicitly unsupported or no usable server payload; installation blocked.
3. **`prepared-server-pack`** — runnable recognized root such as `server.jar`, `fabric-server-launch.jar`, or complete Forge/NeoForge argument and library assets.
4. **`loader-installer-bundle`** — installer JAR or scripts without a complete runtime. Files may provide version evidence, but supplied installers/scripts are not executed; Minecraft Core rebuilds the runtime.
5. **`backup-archive`** — identified as a Minecraft Core backup and routed to the existing restore experience rather than modpack import.
6. **`ambiguous-or-unknown`** — multiple roots, conflicting loaders, or insufficient evidence; requires guided selection or rejection.
7. **`unsupported-runtime-layout`** — depends on a custom bootstrap script, executable, wrapper, or unrecognized launch protocol that Minecraft Core cannot safely reconstruct; installation is rejected.

Filename terms such as `serverpack`, `client`, or `multimc` rank candidates but never prove runtime or safety. Manifest, configuration, library, argument-file, and known launcher evidence determine classification.

## Runtime Resolution

Every managed installation stores an exact runtime tuple:

```text
Minecraft version + loader family + loader version + Java major + OS + architecture
```

The lifecycle service never upgrades a loader independently or asks the loader installer for an unspecified latest version. If the pack does not identify an exact required loader, the plan must obtain an explicit compatible choice from the user before execution.

Loader work required by this feature includes:

- preserving current Fabric and Forge behavior while moving it behind the lifecycle service;
- adding official NeoForge version resolution, server installation, validation, and launch argument handling;
- adding official Quilt version resolution, server installation, validation, and launch handling;
- extending shared health and filesystem validation for all supported runtimes;
- deriving Java major from Minecraft and loader requirements and using the managed Java subsystem.

A prepared pack may reuse a complete recognized runtime. An incomplete installer bundle is reconstructed using Minecraft Core's trusted runtime installer. If a pack can run only through its custom bootstrap script, executable, wrapper JAR, or unrecognized launch protocol, it is rejected with `UNSUPPORTED_RUNTIME_LAYOUT`; the application does not overpromise compatibility or weaken the no-script rule.

## Persistent State

### Server Summary

The existing `.minecraft-core.json` keeps a compact, backward-compatible summary used by normal server loading:

- `modpackManaged`;
- `modpackProvider`;
- project/release display identity;
- runtime tuple;
- `contentRevision`;
- current operation/recovery indicator when applicable.

The configuration file is written atomically and remains readable by older versions that ignore unknown keys.

### Detailed State Directory

Full lifecycle state lives beneath the protected server directory `.minecraft-core-state/`:

```text
.minecraft-core-state/
  modpack.json
  manifests/
    <installation-id>.json
  operations/
    <job-id>/
      journal.json
  history/
    <operation-id>.json
```

`modpack.json` contains current source identity, runtime, selected optional files, asset-selection preference, installed timestamp, content revision, and manifest ID.

The ownership manifest contains every managed path, normalized path key, origin, management policy, role, installed hash, size, and prior baseline required for reconciliation. Server-local operation journals are durable and phase-versioned, but they are not the only discovery mechanism.

Before any staging or mutation, `RecoveryRegistry` atomically writes an application-level record under Electron `userData`, for example:

```text
<userData>/modpack-lifecycle/active/<job-id>.json
```

The record contains job ID, stable server ID when one exists, target path, candidate and rollback sibling paths, restore-point ID/digest, server-local journal path, prior running/auto-restart state, and durable phase. It covers new unregistered servers as well as existing ones. It is removed only after completed cleanup or a recorded terminal recovery result.

Startup recovery runs before transient runtime-flag cleanup, IPC exposure, automatic restart, setup continuation, or any server launch. Every launch path and every writer consults the shared recovery gate. A missing/offline target remains a visible pending recovery record rather than being silently forgotten.

Artifact downloads are content-addressed in an application cache outside the server. Candidate and rollback sibling directories are on the target volume so final directory renames do not cross filesystems.

## File Ownership and Conflict Resolution

### Origin and Management Policy

Origin and management policy are separate fields so a pack-provided file can become user-owned after seeding:

| Origin | Meaning |
| --- | --- |
| `pack` | Declared by `.mrpack` or copied from the reviewed server-pack root |
| `runtime` | Generated by Minecraft Core for the exact loader/runtime tuple |
| `user` | Created, imported, or explicitly claimed by the user |
| `application` | Minecraft Core state or management material |

| Management policy | Meaning |
| --- | --- |
| `replaceable-managed` | Reconciled against the pack/runtime baseline |
| `preserve-after-seed` | A new install may seed it, then it becomes user-controlled |
| `protected` | Never replaced or removed without a path-specific explicit action |
| `ignored-rejected` | The pack entry is ignored or the package is rejected because the path is reserved |

User add-ons are user-origin files not present in the pack manifest. A **modified managed** file is a `replaceable-managed` path whose live hash differs from its installed baseline.

Protected user-owned defaults include:

- `world`, `world_nether`, `world_the_end`, and configured world directories;
- `server.properties`;
- `eula.txt`;
- operator, whitelist, ban, and user-cache files;
- `.minecraft-core.json` and `.minecraft-core-state/`;
- management configuration, certificates, and secrets;
- `backups/`;
- logs and crash reports;
- `server-icon.png`;
- explicitly registered JVM arguments and custom launch scripts.

On a new server, a reviewed pack may seed a world template, `server.properties`, icon, or other allowed protected configuration; after seeding, those paths use `preserve-after-seed` or `protected`. On an existing server they are never replaced without path-specific approval. Pack-provided `eula.txt` is always ignored: Minecraft Core writes acceptance only from the user's explicit EULA acknowledgement.

Any pack/archive entry targeting `.minecraft-core.json` or `.minecraft-core-state/` is rejected as a reserved-path violation rather than shown as an ordinary conflict. The user may deliberately approve another protected configuration path during review, but the default is preservation and the previous version remains in the verified restore point and untouched rollback directory.

### Three-way Reconciliation

For each path, compare the old installed baseline, live file, and incoming file:

| Condition | Default action |
| --- | --- |
| Live equals old baseline; incoming changed | Replace with incoming |
| Incoming equals old baseline; live changed | Keep live modification |
| Live and incoming both changed differently | Conflict; preserve live pending explicit choice |
| Incoming removed; live equals old baseline | Remove managed file |
| Incoming removed; live changed | Preserve as orphan and flag it |
| New incoming path collides with user-owned path | Conflict; preserve user file pending explicit choice |
| User add-on remains compatible | Keep it |
| User add-on conflicts by mod ID/runtime | Block or require explicit removal/disable choice |

Conflict choices are **Keep mine**, **Use pack version**, or **Keep both** only when distinct filenames are valid. Bulk choices may apply by category, but worlds and secrets never inherit a bulk replace decision implicitly.

## Transaction Lifecycle

### Operation State Machine

Durable states are:

```text
queued
resolving
downloading
verifying
inspecting
planning
awaiting-user
preflight
snapshotting
staging
validating-candidate
committing
publishing
published
registering
starting
validating-live
committed-healthy
cleanup
cleanup-pending
completed
cancelling
cancelled
rolling-back
rolled-back
failed
recovery-required
```

`cancelling` is entered only before commit; it cleans staging according to artifact-retention policy and terminates as `cancelled`. Commit, live validation, and rollback cannot be cancelled.

`ServerMutationCoordinator` provides one exclusive per-server mutation/start gate shared by the lifecycle service and all existing handlers that can change server files or start a process. Mod install/update/remove, settings writes, backup restore, repair, world operations, setup, detach/uninstall, and server launch must use it. Application-owned mutations increment `contentRevision` atomically. A running server holds a run lease that must be stopped and released before lifecycle mutation can acquire the exclusive gate.

Browse, details, and read-only update checks may run concurrently. Because manual/external filesystem edits cannot increment `contentRevision`, execution also re-stats and re-hashes every touched path and every plan precondition against the planning snapshot. Either a revision mismatch or filesystem mismatch invalidates the plan.

### Planning

Planning is read-only with respect to the server. It resolves the exact source, downloads or locates the complete artifact set in cache, verifies it, inspects it, calculates the runtime, and produces a deterministic plan containing:

- source and complete artifact-set identity;
- calculated set/part digests, provider-digest availability, and immutability/attestation status;
- runtime tuple;
- selected archive root;
- optional-file decisions;
- download and disk estimates;
- added, changed, removed, preserved, and conflicting paths;
- user add-on compatibility findings;
- restore-point requirement;
- downgrade/world warning;
- expected service interruption;
- a plan fingerprint.

Execution accepts the fingerprint. Any provider, artifact-set part, live-file precondition, server-state, or content-revision change invalidates it and requires a new plan.

### Preflight

Before mutation:

- resolve the stable instance ID through the main-process registry and validate its current path;
- acquire the shared exclusive mutation gate, stop the server gracefully when necessary, and verify that no server process retains the directory;
- suspend automatic restart for the operation;
- verify the exact artifact set and plan fingerprint;
- re-stat and re-hash every touched/precondition path;
- verify disk capacity for the artifact set, complete sibling candidate, restore point, rollback sibling, journal, and safety reserve, plus write access on the target volume;
- verify managed Java and loader prerequisites;
- resolve every conflict and optional file;
- require explicit acknowledgement for downgrade world risk and missing GitHub provider digest;
- create a mandatory user-visible full restore point for an existing server through a strengthened backup path;
- fail the operation if the restore point cannot be created and verified.

A verified restore point is streamed first to a `.part` archive while producing an expected-scope path manifest and cryptographic digest. The writer flushes and closes it, tests archive integrity, confirms the archived path set against the scope manifest, calculates/finalizes its digest, and only then atomically renames it to the visible backup name. Lifecycle history pins restore-point ID, digest, source `contentRevision`, source runtime, and operation ID. Retention cannot delete a restore point while lifecycle history or a pending downgrade references it.

### Staging and Commit

For a new server, build and seal the complete server in a unique sibling candidate directory on the target volume without executing it there. Before rename, flush a `publishing` registry phase that proves the target did not exist and identifies the operation-owned candidate. Rename it to the final path, durably record `published`, register the instance, and record `registering`/registered completion. Every managed new server then receives exactly one launch and health check from its canonical path; this avoids pathname-dependent differences in pack wrappers, caches, scripts, and configuration. If **Start server after installation** is selected, that validated process is adopted; otherwise it is stopped cleanly after validation. A crash after rename is recoverable even though the server was not previously registered: recovery validates the exact operation-owned target and either completes registration/final validation or moves the failed target aside. It never adopts, overwrites, or deletes a path not proven to belong to that operation.

For an existing server, the live directory is never updated file by file:

1. Register the operation in the application-level recovery registry before creating staging.
2. Construct a complete sibling candidate directory from the live server and the ownership plan. User-owned and preserved content is copied into the candidate; incoming pack/runtime changes are applied only there.
3. Never ordinary-hardlink a path that the candidate runtime might modify. A platform copy-on-write clone may be used only when its isolation semantics are verified; otherwise use a real copy. Immutable retained artifacts may use a verified safe optimization.
4. Write the new ownership state and `.minecraft-core.json` inside the candidate and flush the candidate journal.
5. Validate the candidate while the original live directory remains untouched.
6. Stop the candidate and verify all handles are closed.
7. Flush a directory-swap journal and recovery-registry phase containing the live, candidate, and rollback sibling paths.
8. Rename the live directory to the rollback sibling, then rename the candidate to the canonical live path. Both renames occur on the same volume. The durable phase record makes the temporary between-renames state recoverable.
9. The candidate already contains the next `contentRevision`; perform the final launch/health check from the canonical path while the mutation gate remains held.
10. After final health succeeds, flush the durable `committed-healthy` phase, publish the state-change event, then enter `cleanup` and remove the rollback sibling.
11. Cleanup failure transitions to `cleanup-pending`: the healthy committed server remains authoritative, the rollback sibling is retained, and startup retries cleanup without rolling the server back.

The untouched rollback sibling, not the current overlay-style backup restore, is the primary exact rollback state. The verified user-visible restore point remains as a durable fallback and downgrade asset.

### Health Validation

Successful process spawn is insufficient. For an existing-server mutation, the operation starts the sibling candidate before the directory swap with operation-scoped logs, a temporary loopback-only address/port, and public/management exposure disabled. For a new server, the sibling candidate is integrity-sealed without execution and the same checks run once after publication from the canonical path. Validation waits for all of:

- a recognized Minecraft ready marker for the selected runtime;
- the phase-appropriate listener: the temporary loopback endpoint during candidate validation and the configured endpoint during final live validation;
- a successful Minecraft status ping matching the launched instance.

Fatal log markers, premature exit, timeout, or status mismatch fail validation. A pre-swap failure discards the candidate and leaves the original live directory byte-for-byte untouched. The candidate is stopped completely before the swap.

Candidate endpoint isolation uses an application-generated temporary `server.properties` overlay inside the candidate only. The canonical planned file bytes or planned absence are retained separately. After candidate shutdown, the overlay is removed, the canonical planned state is restored, and its hash/absence is verified before the directory swap. Candidate-only query, RCON, and management exposure remains disabled. Pack scripts are not used to create these overrides.

After an existing-server swap, the application launches from the canonical path and validates the real configured endpoint. A final-launch failure stops that process and swaps the untouched rollback sibling back. A new server always performs its sole validation launch from the canonical path. A failure unregisters and quarantines only that operation-owned new directory; there is no prior server to endanger. The default auto-restart policy remains suspended until finalization completes.

The operation records whether the server was running before it began. After a successful update, a previously running server remains running and a previously stopped server is stopped again after validation. New-server review includes an explicit **Start server after installation** choice. With that choice off, the one canonical validation process is stopped cleanly; with it on, the same validated process remains running after adoption.

### Rollback and Recovery

Rollback is phase-aware and idempotent:

- before swap, stop and delete the candidate; the original live directory was never changed;
- during the two-rename swap, use the durable registry and journal to restore exactly one canonical live directory and retain the other as diagnostic state until verified;
- after swap or final-launch failure, stop the candidate runtime, rename the failed canonical directory aside, and rename the untouched rollback sibling back to the canonical path;
- verify the restored directory identity/state before restoring prior auto-restart behavior;
- launch and health-validate the previous runtime only when it was running before the operation;
- retain the user-visible verified restore point and record the exact rollback outcome;
- use restore-point reconstruction only as a fallback if the rollback sibling is missing or damaged, never as an unverified overlay.

On application startup, `RecoveryRegistry` is scanned before transient runtime cleanup, IPC registration, auto-restart, or any launch path. Pre-swap jobs clean candidates according to retention policy and become failed/cancelled. A new-server `published`/`registering` job validates the exact operation-owned target, completes registration, and performs the one canonical health launch if it was not already committed. `committed-healthy` and terminal inactive new-server records never health-boot again; recovery verifies their mutable publication lineage, enforces the stopped policy, and reconciles remaining side effects. A committed server meant to remain running may be relaunched after an application crash. Legacy candidate-health records remain recoverable without trusting malformed attestations. Existing-server swap-or-later jobs use recorded directory identities and phases to complete rollback unless `committed-healthy` was durably recorded. A `committed-healthy` or `cleanup-pending` job keeps the healthy server authoritative and retries deferred cleanup; it is never rolled back merely because rollback-sibling deletion failed. If automatic recovery cannot prove consistency, the server is marked **Recovery required** and every start/mutation path remains blocked until recovery succeeds or the user completes the reviewed manual restore flow.

## Update, Downgrade, Switch, Repair, and Removal

### Update and Downgrade

Version selection always uses exact provider release IDs. The review shows release channel, source changes, runtime changes, file diff, conflicts, optional-file changes, and user add-on compatibility.

The same transaction applies to upgrades and downgrades. A downgrade after the server has run an upgraded world requires selecting the corresponding pre-upgrade restore point for world data. The UI must not imply that replacing JARs reverses world migrations.

If no verified restore point matching the pre-upgrade world exists, an in-place downgrade is blocked. The available choices are restoring a compatible snapshot supplied by the user, creating a separate server/world with the selected older version, or cancelling. A binary-only downgrade is never presented as safe for the existing world.

### Switch Modpack

Switching removes unchanged files owned only by the old pack, preserves modified old-pack files as flagged orphans, preserves user-owned content, installs the selected new pack, and identifies duplicate or incompatible user add-ons. It always creates a restore point and uses the full transaction.

### Verify and Repair

Verification hashes pack-managed and runtime-managed files against the current manifest. Repair downloads or rebuilds only missing/corrupt managed content, applies the same ownership rules, creates a restore point when changes are required, and validates runtime health.

### Detach

Detach keeps all server files and records a final detached history entry. Active pack ownership and release monitoring are disabled, `modpackManaged` becomes false, and no pack files are removed. Detailed history may be retained for audit and a later explicit reattachment.

### Uninstall Managed Files

Uninstall creates a restore point, removes unchanged pack/runtime-owned files, preserves worlds and other user-owned files, preserves modified managed files as flagged orphans, and removes active modpack management state only after commit. If no runnable server remains, the instance becomes an unmanaged files-only instance rather than being silently deleted.

## Notifications and Release Review

Notifications are persistent records, not toast-only messages. Types include:

- Modpack update available;
- Prerelease available;
- GitHub asset selection required;
- Source changed or republished;
- Integrity information missing;
- Integrity verification failed;
- Update check delayed by rate limiting;
- Action required for an operation;
- Operation completed;
- Operation failed and server restored;
- Recovery required.

Clicking an actionable notification opens the exact server and review state. Toasts and optional native notifications summarize new records, while the notification center retains history, read state, source, timestamp, and next action.

No notification action installs immediately. **Review update** is the primary action.

## IPC and Events

A dedicated handler module is registered through [`electron/ipc-handlers.cjs`](../../../electron/ipc-handlers.cjs) and allowlisted through [`electron/preload.cjs`](../../../electron/preload.cjs). Exact names may be refined during implementation planning, but the contract groups are:

- catalog search/project/version queries;
- GitHub repository/release/asset queries and tracking preferences;
- local archive selection;
- artifact inspection and plan creation;
- job execution, status, cancellation, and recovery;
- managed installation state and history;
- update checks and persistent notifications;
- detach and uninstall planning/execution.

Events are operation-scoped:

- `modpacks:job-progress` with job ID, phase, bounded progress, current item, and safe message;
- `modpacks:job-log` with redacted structured detail;
- `modpacks:state-changed` with server identity and new `contentRevision`;
- `modpacks:notification` with a persistent notification ID.

Every IPC payload is schema-validated in the main process. Results use stable machine-readable error codes plus user-safe messages. Raw provider errors, URLs with credentials, archive passwords, tokens, and arbitrary process output are never exposed unredacted.

## Stable Failure Codes

The design reserves at least these error codes:

- `INVALID_RELEASE_URL`
- `REPOSITORY_NOT_FOUND`
- `RELEASE_NOT_FOUND`
- `ASSET_AMBIGUOUS`
- `ASSET_SELECTION_REQUIRED`
- `ASSET_CHANGED`
- `UNSUPPORTED_ARCHIVE`
- `MAGIC_EXTENSION_MISMATCH`
- `ENCRYPTED_ARCHIVE`
- `MULTIPART_VOLUME_MISSING`
- `ARCHIVE_LIMIT_EXCEEDED`
- `UNSAFE_ARCHIVE_ENTRY`
- `ARCHIVE_ENTRY_COLLISION`
- `EXTRACTOR_UNAVAILABLE`
- `EXTRACTOR_FAILED`
- `MANIFEST_INVALID`
- `CLIENT_ONLY_PACK`
- `MISSING_PROVIDER_DIGEST`
- `HASH_MISMATCH`
- `PACK_ROOT_AMBIGUOUS`
- `LOADER_CONFLICT`
- `UNSUPPORTED_LOADER`
- `UNSUPPORTED_RUNTIME_LAYOUT`
- `RUNTIME_INCOMPLETE`
- `PLAN_STALE`
- `SERVER_RUNNING`
- `OPERATION_IN_PROGRESS`
- `CANCELLED`
- `TARGET_EXISTS`
- `INSUFFICIENT_DISK`
- `BACKUP_FAILED`
- `COMMIT_FAILED`
- `HEALTH_CHECK_FAILED`
- `ROLLBACK_FAILED`
- `RECOVERY_REQUIRED`
- `CLEANUP_FAILED`

Failures retain provider/technical detail in redacted logs while presenting specific recovery actions to the user.

## Security and Trust Boundaries

- Treat every downloaded archive, configuration, and JAR as untrusted input.
- Provider digests prove identity only; they are not malware scanning.
- Reuse and extend remote URL validation for every redirect, blocking credentials, unsafe protocols, private/reserved destinations, and DNS rebinding to non-public addresses.
- Stream remote content into bounded partial files; never buffer large artifacts in renderer or main-process memory.
- Verify declared content length where available and enforce measured bytes regardless of headers.
- Use content-addressed cache names rather than remote filenames for disk identity.
- Never invoke a shell for archive or loader subprocesses.
- Never execute pack-provided scripts, executables, or arbitrary installer JARs.
- Keep server launch arguments application-generated and loader-specific.
- Protect `.minecraft-core-state/` from pack ownership, archive overrides, and uninstall rules.
- Redact query strings, tokens, environment secrets, and user paths where logs leave the local diagnostic boundary.
- Keep the bundled archive engine updated and cover its presence/version in release checks.

## Accessibility and Interaction Requirements

- Progress uses `role="progressbar"` with appropriate values and a separate `aria-live` stage message.
- Asset, version, root, runtime, conflict, and rollback choices are keyboard accessible and retain visible focus.
- Disabled provider controls have adjacent visible explanations, not title-only hints.
- Destructive confirmations default focus to Cancel.
- Color is never the only signal for release channel, conflict, integrity, or failure.
- Long file diffs use virtualized or paged rendering without losing screen-reader labels.
- Every wizard step has a programmatic heading and step indicator using `aria-current="step"`; focus moves to the new heading after navigation and to an error summary after validation fails.
- Dialogs trap focus while open and restore it to their trigger when closed.
- Progress announces stage changes and throttled meaningful updates; raw job logs are not live regions.
- Completion, rollback, and recovery move focus to the result heading and expose the primary recovery action immediately after it.

## Testing Strategy

### Unit and Contract Tests

- Provider normalization and exact-ID behavior for Modrinth and GitHub.
- ETag, `304`, pagination, rate-limit, retry, prerelease, draft, mutation, and asset-pattern behavior.
- `.mrpack` schema, absent/server environment semantics, override layering, optional files, published host allowlist, required dual hashes, and hash verification.
- ZIP, RAR4, RAR5, multipart RAR, magic/extension mismatch, encrypted archive, and wrapper-root classification.
- Every supported multipart naming scheme, missing middle/tail volumes, recovery volumes, duplicate/additional volumes, and malicious unrelated siblings.
- Every unsafe path form, newline/control name, link/reparse entry, link-then-child traversal, Windows alias, file/directory conflict, case/normalization collision, depth, size, ratio, timeout, output flood, and disk limit.
- A bomb stopped during extraction before it can exhaust the configured staging or free-space budget.
- Prepared-server, installer-only, custom-bootstrap rejection, backup, client-only, conflicting loader, and ambiguous-root fixtures.
- Artifact-set grouping/fingerprints plus nullable provider and mandatory calculated digest behavior.
- Ownership origin/policy precedence, reserved-state rejection, EULA ignoring, protected seeding, and every three-way merge row.
- Plan fingerprint invalidation from application revision changes and manually edited touched paths.
- Opaque picker selection expiry/replay and renderer-supplied path rejection.
- Durable cancellation/start/cleanup transitions and terminal `CANCELLED` behavior.
- Stable error-code mapping and log redaction.

### Transaction and Recovery Tests

- Failure injection at every durable operation phase.
- Cancellation before commit leaves the server unchanged.
- Crash/restart before swap cleans or reports the candidate through the application-level registry, including for an unregistered new server.
- New-server crash recovery immediately before/after final rename and around instance registration handles `publishing`, `published`, and `registering` without adopting a pre-existing path.
- Crash/restart before, between, and after the two directory renames performs exact idempotent recovery.
- Recovery runs before transient cleanup, IPC, auto-restart, and every launch path; offline/moved targets remain visible and blocked.
- A failed loopback candidate validation leaves the original live directory byte-for-byte untouched and exposes no public listener.
- Candidate validation uses only the temporary loopback endpoint, then restores and hash-verifies the exact canonical `server.properties` state before publication/swap.
- A failed canonical-path launch swaps the untouched rollback directory back byte-for-byte.
- `committed-healthy` is durable before cleanup; cleanup failure retains a diagnosable rollback sibling and retries later without rolling back the healthy server.
- Verified restore-point tests cover `.part` finalization, integrity test, scope manifest, digest, atomic rename, and retention pinning.
- Backup failure prevents commit.
- The shared coordinator blocks conflicting lifecycle, mod, settings, restore, repair, world, setup, and launch operations.
- Previous auto-restart and running state are restored correctly.
- A failed rollback blocks normal launch and exposes recovery actions.

### Runtime Tests

- Exact-version installation and launch for Fabric, Forge, NeoForge, and Quilt.
- Vanilla handling where selected pack content is loaderless.
- Prepared-runtime validation and incomplete-runtime reconstruction.
- Java-major selection.
- Ready-marker, listener, and Minecraft status-ping validation.
- Premature process exit and false-positive listener rejection.

### Product Flow Tests

- New server from Modrinth.
- New server from GitHub `.mrpack`, ZIP, RAR, and multipart RAR.
- New server from a local archive.
- Install on an existing unmanaged server.
- Upgrade, downgrade with world restore, switch, verify/repair, detach, and uninstall.
- User-modified config and user-added mod preservation.
- Ambiguous GitHub asset, changed multipart part/set, missing provider digest, and no-installable-asset flows.
- CurseForge unavailable copy and accessibility.
- Keyboard/focus behavior, progress announcements, cancellation, and destructive-dialog defaults.

### Packaged Release Tests

- Build and installer complete successfully.
- Bundled 7-Zip executable and DLLs are present and callable from `process.resourcesPath`.
- The pinned archive worker establishes its least-privilege token/container and Job Object; failure to establish containment blocks extraction.
- Required licenses/notices are present.
- A clean installed build imports representative ZIP/ZIP64, RAR4, RAR5, and every supported multipart RAR naming scheme and rejects header/file encryption.
- No development-path fallback is required.
- Existing server, mod, backup, update, and setup regression suites remain green.

## Definition of Done

The feature is complete only when:

1. All day-one product flows above work in a packaged Windows build.
2. Modrinth versions are resolved and installed by exact ID with verified `.mrpack` contents.
3. Public GitHub releases can be tracked, reviewed, and safely imported from explicit assets.
4. ZIP, RAR4, RAR5, and complete multipart RAR imports pass security and package tests.
5. Password-protected archives stop safely without prompting for or exposing a password.
6. Fabric, Forge, NeoForge, and Quilt packs launch and pass ready-marker, listener, and status-ping health checks.
7. Existing-server operations create verified pinned restore points, validate complete sibling candidates in isolation, and demonstrate byte-exact directory-swap recovery under injected failures.
8. Updates, downgrades, switching, repair, detach, and uninstall preserve user-owned and modified data according to the ownership rules.
9. GitHub and Modrinth notifications persist and always route through review rather than auto-install.
10. CurseForge no longer promises "Coming Soon."
11. The shared mutation/recovery gate covers every existing server writer and launch path, including startup before transient cleanup.
12. Bundled archive licenses, pinned-binary verification, least-privilege broker, and packaged extractor smoke checks pass.
13. The full existing regression suite and all new tests pass.

## Delivery Boundary

This document approves the product and architecture design. It does not itself authorize shortcuts around transactionality, loader completeness, archive security, recovery, packaging, or tests. The implementation plan must break the work into independently verifiable increments while preserving this end-to-end definition of done.

## External References

- [Modrinth API](https://docs.modrinth.com/api/)
- [Modrinth search projects](https://docs.modrinth.com/api/operations/searchprojects/)
- [Modrinth project versions](https://docs.modrinth.com/api/operations/getprojectversions/)
- [Modrinth `.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
- [GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases)
- [GitHub release assets REST API](https://docs.github.com/en/rest/releases/assets)
- [GitHub REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [GitHub release integrity and immutable releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
- [7-Zip official downloads](https://www.7-zip.org/download.html)
- [7-Zip license](https://www.7-zip.org/license.txt)
- [7-Zip version and security history](https://www.7-zip.org/history.txt)
- [Electron Builder `extraResources`](https://www.electron.build/contents.html#extraresources)

## Approval Record

The user approved the complete design in the Codex task on 2026-08-01, including Modrinth first, GitHub Releases on day one, ZIP/RAR support, neutral CurseForge wording, no automatic pack-script execution, and rejection of password-protected archives for day-one installation.
