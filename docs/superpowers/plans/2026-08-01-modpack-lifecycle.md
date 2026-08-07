# Modpack Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a packaged, end-to-end modpack lifecycle to Minecraft Core: exact Modrinth installs, public GitHub Release imports and tracking, local MRPACK/ZIP/RAR imports, safe version changes and removal, crash-safe existing-server transactions, complete supported loader launch paths, persistent notifications, and recovery.

**Architecture:** Main-process provider adapters resolve immutable artifact plans into verified artifact sets. A content-addressed cache, pinned ArchiveWorker, archive inspector, MRPACK parser, runtime manager, ownership planner, and one lifecycle service prepare deterministic plans. Every write and launch shares a `ServerMutationCoordinator`; existing-server changes occur only in a complete sibling candidate and commit through a durable two-rename directory swap guarded by an application-level recovery registry. The renderer is a schema-validated client of this service and never receives trusted filesystem paths or coordinates mutations.

**Tech Stack:** Electron 42, Node.js/CommonJS main process, Svelte 5 renderer, Node `node:test`, Ajv 8.20.0, ipaddr.js 2.4.0, .NET 8 self-contained Windows x64 ArchiveWorker, official 7-Zip 26.02 x64, Playwright 1.62.1, Electron Builder 26.

## Global Constraints

- The approved design at `docs/superpowers/specs/2026-08-01-modpack-lifecycle-design.md` is authoritative. This plan narrows implementation constants and interfaces; it does not weaken the design.
- All production work is test-driven. Each task must run its named focused test before implementation and record the expected RED failure, then implement, run the focused GREEN test, run the relevant aggregate tests, and commit. Tests must not use the public network unless the command is explicitly an integration or acquisition smoke command.
- Main-process modules use CommonJS `.cjs`; renderer code uses existing Svelte 5/JavaScript conventions. Public DTOs are JSON-serializable and validated at IPC boundaries with Ajv 8.20.0 in strict mode.
- Every failure crossing a service or IPC boundary is a `ModpackError` with one stable code from the approved design. User messages contain no secret, query string, arbitrary provider body, archive output, password, or uncontrolled local path.
- Exact IDs are mandatory. Modrinth execution accepts a selected version ID. GitHub execution accepts numeric repository/release/asset IDs and the reviewed asset-set fingerprint. No provider, loader, or lifecycle method has an implicit `latest` fallback.
- The renderer never supplies a server path, archive path, download destination, executable, command-line argument, or reusable remote download URL. Existing servers are selected by stable instance ID. Native file selection yields a one-use opaque selection ID with a 30-minute TTL.
- Artifact plans and verified artifact sets are distinct types. Every verified part has measured size plus calculated SHA-256 and SHA-512. Persisted state never contains a source URL or cache path. Multipart sets preserve reviewed basenames, ordering, primary part, release identity, and one canonical set digest.
- Remote transport allows public HTTPS only. Validate credentials, hostname, DNS answers, connected peer address, redirect destination, and redirect DNS independently on every hop. Reject every private, loopback, link-local, multicast, reserved, documentation, carrier-grade NAT, or otherwise non-public address. Preserve the vetted hostname for TLS SNI and `Host`.
- Archive policy version `1` uses these exact initial limits: 16 GiB compressed/downloaded bytes per artifact set; 250,000 entries; 64 GiB total declared or measured expansion; 16 GiB per file; depth 64; normalized path length 1,024 UTF-16 code units; 64 MiB technical stdout; 8 MiB stderr; 5-minute list/test deadline; 60-minute extraction deadline; 2 GiB child job memory. Reject non-empty entries with compressed size zero. Apply the 1000:1 per-entry ratio limit when expanded size is at least 64 MiB and the 1000:1 aggregate ratio limit when expansion is at least 256 MiB. Preflight reserve is `max(2 GiB, ceil(plannedFootprint * 0.10))` in addition to the planned footprint.
- Supported archives are MRPACK, single-file ZIP/ZIP64, RAR4, RAR5, `.partN.rar`, `.rar` plus `.rNN`, and numeric-volume RAR sets. Split/spanned ZIP, recovery volumes, incomplete/extra/duplicate multipart sets, links/reparse entries, non-regular entries, encrypted headers/files, and password prompts are unsupported. Magic determines family. No pack-provided script, executable, bootstrap JAR, or installer runs.
- Pin official 7-Zip x64 MSI `https://github.com/ip7z/7zip/releases/download/26.02/7z2602-x64.msi`, byte size `1999872`, SHA-256 `db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e`. Pin source asset `7z2602-src.7z` SHA-256 `c7502dd4557481f52ccf1b3e680329f1fdd207e79a25544afeb3106325474944`. Packaged runtime resolution uses only `process.resourcesPath/archive`; development/tests may use an injected repository `vendor` root only when `app.isPackaged === false` and must verify the same manifest. No mode uses `PATH`, `7za`, `7zr`, or a system installation, and a packaged build never falls back to the development tree.
- ArchiveWorker is a packaged self-contained .NET 8 `win-x64` broker. It creates/derives a zero-capability AppContainer, grants the child read-only access to the isolated input and read/write access only to the empty output, uses an explicit inherited-handle list, starts suspended/no-console, assigns a kill-on-close Job Object with active-process limit 1, then resumes. On the supported Windows host, adding `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY` to this AppContainer launch makes ordinary children fail during process initialization (`0xc0000142`), so that incompatible attribute is deliberately omitted. Descendant denial is instead enforced by the one-process Job and measured by a live sandbox probe that must fail to create a second process. Failure of profile, ACL, process, Job Object, or packaged self-test returns `EXTRACTOR_UNAVAILABLE`; there is no unrestricted fallback. Unsupported build architectures fail before packaging.
- Modrinth MRPACK v1 requires SHA-512 and SHA-1 for every remote file, verifies both, and accepts initial download URLs only on the published exact HTTPS hosts `cdn.modrinth.com`, `github.com`, `raw.githubusercontent.com`, and `gitlab.com`. Every redirect still passes provider-specific host policy and public-address checks. Absent `env` is required; server-optional defaults selected; server-unsupported is excluded; `overrides/` applies before `server-overrides/`; client-only packs are rejected.
- GitHub day one supports explicit public repositories without authentication and sends `X-GitHub-Api-Version: 2026-03-10`, `Accept: application/vnd.github+json`, and an application User-Agent. API calls use exact `api.github.com`; asset bytes are requested by numeric asset ID with `Accept: application/octet-stream`, and redirects are limited to vetted public GitHub asset hosts `release-assets.githubusercontent.com`, `objects.githubusercontent.com`, and `github-releases.githubusercontent.com`. Exclude drafts and generated source archives; hide prereleases by default. Poll due tracked sources at startup and then every 12 hours with deterministic ±10% jitter, ETag/304, pagination, rate-limit headers, `Retry-After`, and capped exponential backoff. A changed asset ID/digest/size/update timestamp under an existing tag is `ASSET_CHANGED`, never an ordinary update. Updates are persistent notifications and never auto-install.
- Managed runtime identity is exactly Minecraft version, loader family, loader version, Java major, OS, and architecture. Vanilla, Fabric, Forge, NeoForge, and Quilt must resolve, install/validate, generate a launch plan, emit a ready marker, listen, and answer a matching Minecraft status ping. NeoForge/Quilt must never fall through to Vanilla.
- `.minecraft-core.json` remains backward-compatible and gains normalized `contentRevision` (non-negative integer, default 0) plus summary fields. Full state is protected under `.minecraft-core-state/`. Ordinary renderer/config writes cannot lower or arbitrarily replace `contentRevision`.
- Planning may download/cache/inspect but is read-only with respect to the server. Execution revalidates exact artifacts, plan fingerprint, `contentRevision`, and every touched-path stat/hash precondition after acquiring the mutation gate.
- An existing-server mutation must stop the server, suspend auto-restart, create and verify a pinned visible restore point, build a complete direct sibling candidate with real copies, validate it only on loopback, restore exact candidate `server.properties`, durably journal both renames, validate after canonical publication, durably record `committed-healthy`, and only then remove rollback staging. Cleanup failure is `cleanup-pending`, not rollback.
- Startup recovery initializes the coordinator fail-closed and scans the application-level registry before transient cleanup, IPC setup, auto-restart, setup continuation, or any launch. Ambiguous/offline records remain visible and block the affected server. Recovery is idempotent and never overlays a restore point onto a live directory.
- World downgrade is blocked without a verified compatible pre-upgrade world restore point. Detach removes no server file. Uninstall removes only unchanged managed paths, preserves protected/user/modified files, and may leave an unmanaged files-only instance.
- CurseForge copy is exactly `CurseForge (Unavailable)` and `CurseForge browsing is unavailable in this build.` There is no date or `Coming Soon` language.
- Destructive dialogs default focus to Cancel, trap/restore focus, and close on Escape. Wizard steps have headings and `aria-current="step"`; progress uses a progressbar plus throttled polite stage announcements; failures use alerts; selectable cards/rows are keyboard controls; color is never the only state cue.
- Release completion requires `npm test`, `npm run build`, `npm run pack`, the packaged ArchiveWorker containment/import smoke, Playwright product flows, and `npm run dist`. Mandatory Windows archive/package tests must fail rather than silently skip on supported x64 CI/build hosts.

---

### Task 1: Establish contracts, schemas, failure codes, limits, and storage paths

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `electron/services/modpacks/contracts.cjs`
- Create: `electron/services/modpacks/errors.cjs`
- Create: `electron/services/modpacks/limits.cjs`
- Create: `electron/services/modpacks/paths.cjs`
- Create: `electron/services/modpacks/ipc-schemas.cjs`
- Create: `src/types/modpack.d.ts`
- Test: `tests/modpacks/contracts.test.cjs`
- Test: `tests/modpacks/error-codes.test.cjs`
- Test: `tests/modpacks/ipc-schemas.test.cjs`

**Interfaces:**

```js
class ModpackError extends Error {
  constructor(code, safeMessage, { cause, details, retryable = false } = {})
  toPublicResult() // validated PublicModpackErrorResult
}

createArtifactSetPlan(input) // -> ArtifactSetPlan
finalizeVerifiedArtifactSet(plan, verifiedParts) // -> VerifiedArtifactSet
computeArtifactSetDigest(parts) // -> lowercase sha256
assertArtifactSetUnchanged(expected, actual) // -> actual or throws PLAN_STALE
normalizeRuntimeTuple(input) // -> exact RuntimeTuple
validateSchema(schemaName, value) // -> frozen clone or throws INVALID_REQUEST
createModpackPaths(userDataPath) // -> ModpackPathRoots
```

**Consumes:** no prior task.

**Produces:** shared provider/artifact/runtime/error DTO constructors, schema primitives, and controlled roots for `cache`, `selections`, `notifications`, `recoveryActive`, `recoveryHistory`, `operations`, `plans`, and `workspaces`. Task 26 owns the final complete IPC request/result/event schemas after those DTOs exist.

`PUBLIC_ERROR_DETAILS_BY_CODE` is a closed map from each failure code to permitted scalar/enumerated public detail fields. `toPublicResult()` validates against it and drops every undeclared key; raw URLs, query strings, provider bodies, local paths, archive output, commands, and causes can never enter `details`.

`FAILURE_CODES` contains exactly the approved codes `INVALID_RELEASE_URL`, `REPOSITORY_NOT_FOUND`, `RELEASE_NOT_FOUND`, `ASSET_AMBIGUOUS`, `ASSET_SELECTION_REQUIRED`, `ASSET_CHANGED`, `UNSUPPORTED_ARCHIVE`, `MAGIC_EXTENSION_MISMATCH`, `ENCRYPTED_ARCHIVE`, `MULTIPART_VOLUME_MISSING`, `ARCHIVE_LIMIT_EXCEEDED`, `UNSAFE_ARCHIVE_ENTRY`, `ARCHIVE_ENTRY_COLLISION`, `EXTRACTOR_UNAVAILABLE`, `EXTRACTOR_FAILED`, `MANIFEST_INVALID`, `CLIENT_ONLY_PACK`, `MISSING_PROVIDER_DIGEST`, `HASH_MISMATCH`, `PACK_ROOT_AMBIGUOUS`, `LOADER_CONFLICT`, `UNSUPPORTED_LOADER`, `UNSUPPORTED_RUNTIME_LAYOUT`, `RUNTIME_INCOMPLETE`, `PLAN_STALE`, `SERVER_RUNNING`, `OPERATION_IN_PROGRESS`, `CANCELLED`, `TARGET_EXISTS`, `INSUFFICIENT_DISK`, `BACKUP_FAILED`, `COMMIT_FAILED`, `HEALTH_CHECK_FAILED`, `ROLLBACK_FAILED`, `RECOVERY_REQUIRED`, and `CLEANUP_FAILED`, plus implementation-boundary codes `INVALID_REQUEST` and `NO_INSTALLABLE_ASSET`. Adding another code later requires updating the closed public schema and tests.

**Required RED assertion:**

```js
test('public error details cannot leak paths or signed URLs', () => {
  const error = new ModpackError('HASH_MISMATCH', 'Integrity check failed', {
    details: { algorithm: 'sha256', path: 'C:\\secret', url: 'https://x/?token=y' }
  });
  assert.deepEqual(error.toPublicResult().error.details, { algorithm: 'sha256' });
});
```

- [ ] Install exact direct dependencies with `npm install --save-exact ajv@8.20.0 ipaddr.js@2.4.0`; do not import transitive copies.
- [ ] RED: write the tests, then run `node --test tests/modpacks/contracts.test.cjs tests/modpacks/error-codes.test.cjs tests/modpacks/ipc-schemas.test.cjs`; require `MODULE_NOT_FOUND` for the new contracts or the first intended assertion failure, never a syntax/setup failure.
- [ ] Implement frozen DTO constructors, canonical JSON hashing with explicit field order, `ModpackError` redaction-safe public conversion, constants, paths, and strict schemas. Use `BigInt` internally for byte arithmetic but emit validated safe decimal strings in DTOs when values may exceed `Number.MAX_SAFE_INTEGER`.
- [ ] GREEN: run `node --test tests/modpacks/contracts.test.cjs tests/modpacks/error-codes.test.cjs tests/modpacks/ipc-schemas.test.cjs`; require every named subtest to pass with no warning. Then run `npm test` and require the 147-test baseline plus the new tests to pass.
- [ ] Commit: `feat(modpacks): establish lifecycle contracts`

### Task 2: Implement artifact-set grouping, fingerprints, and content-addressed cache

**Files:**

- Create: `electron/services/modpacks/artifacts/multipart-names.cjs`
- Create: `electron/services/modpacks/artifacts/artifact-set.cjs`
- Create: `electron/services/modpacks/artifacts/artifact-fingerprint.cjs`
- Create: `electron/services/modpacks/artifacts/artifact-cache.cjs`
- Create: `electron/services/modpacks/artifacts/artifact-workspace-registry.cjs`
- Test: `tests/modpacks/multipart-names.test.cjs`
- Test: `tests/modpacks/artifact-set.test.cjs`
- Test: `tests/modpacks/artifact-cache.test.cjs`
- Test: `tests/modpacks/artifact-workspace-registry.test.cjs`

**Interfaces:**

```js
groupMultipartCandidates(assets) // choices plus disabled incomplete groups
validateCompleteArtifactSet(plan)
canonicalPartIdentity(part)
computePlanFingerprint(plan)

class ArtifactCache {
  constructor({ root, fsApi, clock })
  pathForSha256(digest)
  async commitPart({ partialPath, sha256, measuredSize })
  async materializeSet(verifiedSet, destination)
  async verifyEntry({ sha256, size })
  async removeIfUnreferenced(sha256)
}

class ArtifactWorkspaceRegistry {
  createPlanningSession()
  registerVerifiedSet({ ownerId, verifiedSet })
  materializeInput({ ownerId, artifactSetId })
  createStagingOutput({ ownerId })
  createInspection({ ownerId, artifactSetId, result })
  resolveOwnedId({ ownerId, id, kind })
  transferOwnership({ fromOwnerId, toOwnerId })
  releaseOwner(ownerId)
  sweepExpired(now)
}
```

**Consumes:** Task 1 artifact/runtime/error contracts, limits, and controlled path roots.

**Produces:** multipart grouping/fingerprints, verified cache entries, and the only internal registry allowed to resolve `artifactSetId`, `inputDirectoryId`, `outputDirectoryId`, or `inspectionId` into a path-bearing record. IDs are random, owner-bound, kind-bound, expire after 30 minutes of inactivity before claim, and cannot be replayed. `inspectSource()` creates an internal `planningSessionId`; its public opaque `inspectionId` resolves back to that owner. Task 23 atomically transfers all records from planning session to `planId`, then Task 24 transfers them from `planId` to `jobId` when the plan is claimed.

**Required RED assertion:**

```js
test('workspace IDs are owner-bound and never substitute paths', () => {
  const id = registry.createStagingOutput({ ownerId: 'plan-a' });
  assert.throws(
    () => registry.resolveOwnedId({ ownerId: 'plan-b', id, kind: 'output' }),
    error => error.code === 'PLAN_STALE'
  );
});
```

- [ ] Add RED cases for a single asset, `.part1.rar`, `.part01.rar`, `.rar/.r00`, `.001`, missing middle and tail volumes, duplicate volume numbers, case/Unicode aliases, unrelated siblings, `.rev`, same-release enforcement, stable order, set mutation, cache races, truncated cache content, safe basename materialization, opaque-ID expiry/replay, cross-operation/kind substitution, and path-field rejection.
- [ ] Implement deterministic `provisional-group` results from names/provider metadata. Disable known gaps before download, but never claim tail completeness from filenames alone. Only Task 9 can promote a group to `verified-complete-set` after isolated materialization and forced-family list/test confirms the exact volume set. Reject mixing release IDs or local selection IDs.
- [ ] Cache paths are built as `path.join(cacheRoot, 'sha256', digest.slice(0, 2), digest)` for a validated lowercase SHA-256 and use unique `wx` partial files, file flush, atomic rename, and race verification. Materialization creates a fresh empty directory and copies exact verified parts under validated original basenames; only the primary path is returned to the engine.
- [ ] RED: run `node --test tests/modpacks/multipart-names.test.cjs tests/modpacks/artifact-set.test.cjs tests/modpacks/artifact-cache.test.cjs tests/modpacks/artifact-workspace-registry.test.cjs`; require the new-module or intended assertion failure.
- [ ] GREEN: run the same four-file command and require all subtests to pass, then run `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)` and `npm test`; all commands must exit 0.
- [ ] Commit: `feat(modpacks): add verified artifact sets and cache`

### Task 3: Implement rebinding-safe HTTPS transport and bounded artifact downloads

**Files:**

- Create: `electron/services/modpacks/network/remote-url-policy.cjs`
- Create: `electron/services/modpacks/network/pinned-https-client.cjs`
- Create: `electron/services/modpacks/artifacts/artifact-downloader.cjs`
- Test: `tests/modpacks/remote-url-policy.test.cjs`
- Test: `tests/modpacks/pinned-https-client.test.cjs`
- Test: `tests/modpacks/artifact-downloader.test.cjs`

**Interfaces:**

```js
validateRemoteUrl(url, { allowedHosts, allowSubdomains })
resolvePublicAddresses(hostname, { lookup })

class PinnedHttpsClient {
  async request(url, { headers, signal, allowedHosts, maxRedirects = 5 })
}

class ArtifactDownloader {
  async downloadPart(partPlan, { signal, onProgress })
  async downloadSet(artifactSetPlan, { signal, onProgress })
}
```

**Consumes:** Tasks 1-2 errors/limits, artifact plans/cache, and controlled partial paths.

**Produces:** public-address-vetted HTTPS streams and verified cached artifact sets with measured size plus SHA-256/SHA-512. Redirect responses remain internal and every hop is revalidated.

**Required RED assertion:**

```js
test('a redirect to a private address is rejected before a body is read', async () => {
  await assert.rejects(client.request(publicUrl, options), error => error.code === 'INVALID_RELEASE_URL');
  assert.equal(privateServer.bodyReads, 0);
});
```

- [ ] RED: first write injected-DNS and local-TLS cases for credentials, HTTP, IPv4/IPv6 private/reserved, mixed answers, redirect private, rebinding, wrong peer, TLS hostname, redirect cap, declared/chunked oversize, short body, digest mismatch, abort cleanup, cache race, and query redaction; run `node --test tests/modpacks/remote-url-policy.test.cjs tests/modpacks/pinned-https-client.test.cjs tests/modpacks/artifact-downloader.test.cjs` and require an intended assertion/module failure.
- [ ] Implement `https.request` with `dns.promises.lookup(host,{ all:true, verbatim:true })`, reject the entire resolution if any answer is non-public, pin the socket lookup to one vetted address, and verify `socket.remoteAddress` against the vetted set. Follow redirects manually and repeat every check. Only expose the final response stream after connection validation.
- [ ] Stream each part to a unique controlled partial with `wx`; enforce declared and measured 16 GiB set budget, calculate SHA-256/SHA-512 concurrently, verify provider digest when present, call `FileHandle.sync()`, close, and pass it to `ArtifactCache.commitPart()`. Always remove the partial on failure/cancellation. GitHub missing digest remains a warning; Modrinth missing required digest is an error.
- [ ] GREEN: run `node --test tests/modpacks/remote-url-policy.test.cjs tests/modpacks/pinned-https-client.test.cjs tests/modpacks/artifact-downloader.test.cjs`, then `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)`, then `npm test`; all commands must exit 0.
- [ ] Commit: `feat(modpacks): secure artifact downloads`

### Task 4: Add exact Modrinth catalog/version resolution and MRPACK planning

**Files:**

- Create: `electron/services/modpacks/providers/modrinth-modpack-provider.cjs`
- Create: `electron/services/modpacks/mrpack/mrpack-schema.cjs`
- Create: `electron/services/modpacks/mrpack/mrpack-parser.cjs`
- Create: `electron/services/modpacks/mrpack/mrpack-file-plan.cjs`
- Test: `tests/modpacks/modrinth-modpack-provider.test.cjs`
- Test: `tests/modpacks/mrpack-parser.test.cjs`
- Test: `tests/modpacks/mrpack-file-plan.test.cjs`

**Interfaces:**

```js
class ModrinthModpackProvider {
  searchProjects({ query, categories, gameVersion, loader, channel,
    serverCompatibility, sort, offset, limit })
  getProject(projectId)
  listVersions({ projectId, gameVersions, loaders, channels })
  getVersion(versionId)
  resolveArtifactSetPlan(versionId)
}

parseMrpackManifest(buffer)
validateMrpackManifest(value)
buildMrpackServerPlan({ manifest, selectedOptionalFiles, archiveEntries })
```

**Consumes:** Tasks 1-3 contracts, errors, exact URL policy, downloader, verified cache, and artifact sets.

**Produces:** catalog cards containing exact project ID, title, summary, icon, categories, supported Minecraft/loaders, server compatibility, updated time, downloads, and pagination; project detail containing description/body, gallery, normalized runtimes, and untrusted upstream-link candidates; exact version/artifact plans; strict MRPACK server file plans.

**Required RED assertion:**

```js
test('execution resolves the selected Modrinth version and never latest', async () => {
  await provider.resolveArtifactSetPlan('version-exact');
  assert.deepEqual(http.requestedPaths, ['/version/version-exact']);
});
```

- [ ] RED-test `project_type:modpack`, exact project/version endpoints, updated/download sort, server-compatibility filter/derivation, preserved IDs/channel/timestamps, paging/filter serialization, description/body/gallery/upstream links, offline/429 normalization, no implicit first/latest fallback, exactly one selected primary `.mrpack`, changed version/file identity, and normalized compatibility.
- [ ] RED-test format v1/game `minecraft`, required SHA-512 plus SHA-1, absent/server-required/server-optional/server-unsupported semantics, optional default, Modrinth published host allowlist, override precedence, client-only rejection, reserved state paths, duplicate targets, and unsafe URLs. The parser accepts a bounded `modrinth.index.json` buffer supplied by the archive layer; it never extracts with AdmZip.
- [ ] Implement the provider with injected HTTP transport and a distinct modpack API surface; do not call individual-mod helpers that infer latest files. Implement the strict manifest and deterministic server file plan with both hashes carried to placement verification.
- [ ] RED: run `node --test tests/modpacks/modrinth-modpack-provider.test.cjs tests/modpacks/mrpack-parser.test.cjs tests/modpacks/mrpack-file-plan.test.cjs`; require the new-module or intended assertion failure. GREEN: rerun the same command and require all subtests to pass, then run `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)` and `npm test`.
- [ ] Commit: `feat(modpacks): add exact Modrinth pack planning`

### Task 5: Add public GitHub Release sources, asset review, and release comparison

**Files:**

- Create: `electron/services/modpacks/providers/github-url.cjs`
- Create: `electron/services/modpacks/providers/github-releases-source.cjs`
- Create: `electron/services/modpacks/providers/github-release-tracker.cjs`
- Create: `electron/services/modpacks/providers/github-asset-pattern.cjs`
- Create: `electron/services/modpacks/providers/provider-source-mapping.cjs`
- Test: `tests/modpacks/github-url.test.cjs`
- Test: `tests/modpacks/github-releases-source.test.cjs`
- Test: `tests/modpacks/github-release-tracker.test.cjs`
- Test: `tests/modpacks/github-asset-pattern.test.cjs`
- Test: `tests/modpacks/provider-source-mapping.test.cjs`

**Interfaces:**

```js
parsePublicGitHubUrl(input)

class GitHubReleasesSource {
  getRepositoryIdentity(input)
  listReleases({ repositoryId, owner, repo, includePrereleases, cursor })
  getRelease({ repositoryId, releaseId })
  listUploadedAssets({ repositoryId, releaseId })
  buildArtifactSetPlan({ repositoryId, releaseId, selectedAssetIds })
}

compareReleaseSnapshot(previous, current)
compileAssetPattern(reviewedSelection)
matchAssetPattern(pattern, releaseAssets)
acceptTrustedUpstreamMapping({ modrinthProjectId, githubRepositoryId, url })
artifactsAreEquivalent(left, right, acceptedMappings)
```

**Consumes:** Tasks 1-3 contracts, safe transport, artifact grouping/downloader/cache; Task 4 normalized Modrinth upstream-link candidates.

**Produces:** exact public GitHub repository/release/asset DTOs, provisional installable choices, versioned asset-pattern records, explicit accepted Modrinth-to-GitHub mappings keyed by permanent IDs, and release comparison outcomes including `NO_INSTALLABLE_ASSET` and `ASSET_CHANGED`.

`compileAssetPattern()` persists normalized filename matcher, reviewed role, archive-root fingerprint, exact runtime evidence, and user overrides. `matchAssetPattern()` is high confidence only when all recorded evidence fields match and exactly one complete asset set remains; zero or multiple matches are `ASSET_SELECTION_REQUIRED`. `artifactsAreEquivalent()` returns true only for a trusted byte digest match or an explicit accepted permanent-ID mapping; names/tags never suffice.

**Required RED assertion:**

```js
test('a republished asset is never classified as a normal update', () => {
  assert.equal(compareReleaseSnapshot(previous, { ...previous, size: previous.size + 1 }).type, 'ASSET_CHANGED');
});
```

- [ ] RED-test repository/release URL parsing, owner/name canonicalization through numeric repo ID, public-only 404 behavior, pinned API headers, pagination, drafts excluded, prerelease preference, uploaded-state assets only, generated zipball/tarball excluded, `NO_INSTALLABLE_ASSET`, numeric IDs/ETag/size/digest/timestamps retained, multipart assets restricted to one release, and missing provider digest warning.
- [ ] RED-test `304`, rate-limit reset, `Retry-After`, exponential backoff metadata, newer stable/prerelease classification, same-tag changes to ID/digest/size/`updated_at` yielding `ASSET_CHANGED`, and persistent high-confidence pattern matching only when exactly one complete asset set matches role, root fingerprint, runtime evidence, and overrides.
- [ ] Implement against `X-GitHub-Api-Version: 2026-03-10`, injected clock/transport, maximum page size 100, and safe provider error normalization. Pre-download roles are explicitly `provisional`; no function silently selects the first ZIP. Artifact plans retain numeric asset IDs; the downloader constructs the exact GitHub asset API request and never accepts a renderer or persisted browser-download URL. When no uploaded asset is installable, return `NO_INSTALLABLE_ASSET` with safe action identifiers `import-local` and `create-empty`, not generated source URLs.
- [ ] RED: run `node --test tests/modpacks/github-url.test.cjs tests/modpacks/github-releases-source.test.cjs tests/modpacks/github-release-tracker.test.cjs tests/modpacks/github-asset-pattern.test.cjs tests/modpacks/provider-source-mapping.test.cjs`; require the new-module or intended assertion failure. GREEN: rerun the same command and require all subtests to pass, then run `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)` and `npm test`.
- [ ] Commit: `feat(modpacks): support GitHub Release artifacts`

### Task 6: Add opaque native local-archive selection and controlled ingestion

**Files:**

- Create: `electron/services/modpacks/local/selection-registry.cjs`
- Create: `electron/services/modpacks/local/local-artifact-source.cjs`
- Test: `tests/modpacks/local-selection.test.cjs`

**Interfaces:**

```js
class SelectionRegistry {
  create({ selectedPaths, displayNames, expiresAt })
  claim(selectionId)
  invalidate(selectionId)
  sweepExpired()
}

class LocalArtifactSource {
  async selectWithNativeDialog({ allowMultipart })
  async ingestSelection(selectionId, { signal, onProgress })
}
```

**Consumes:** Tasks 1-3 errors, grouping, cache, downloader stream hashing, and an injected Electron dialog boundary.

**Produces:** one-use 30-minute picker selections and verified local artifact sets whose originals remain untouched; public DTOs contain display metadata only.

**Required RED assertion:**

```js
test('a claimed local selection cannot be replayed', async () => {
  await source.ingestSelection(selectionId, options);
  await assert.rejects(source.ingestSelection(selectionId, options), error => error.code === 'PLAN_STALE');
});
```

- [ ] RED: test picker cancellation, one/multi selection, multipart gaps, same selection, expiry/replay, source mutation, dual hashes, untouched original, and renderer path rejection; run `node --test tests/modpacks/local-selection.test.cjs` and require intended failure.
- [ ] Inject Electron `dialog`, clock, random ID, filesystem, cache, and artifact-set grouping. Return only selection ID, expiry, filenames, sizes, and provisional grouping. `ingestSelection()` claims once, re-stats each source, streams it into controlled partial/cache, verifies the initial identity, and invalidates on success or error.
- [ ] GREEN: run `node --test tests/modpacks/local-selection.test.cjs`, `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)`, and `npm test`; all pass.
- [ ] Commit: `feat(modpacks): ingest opaque local archives`

### Task 7: Vendor and verify the exact 7-Zip 26.02 x64 runtime

**Files:**

- Modify: `package.json`
- Create: `scripts/acquire-7zip.ps1`
- Create: `scripts/verify-archive-runtime.cjs`
- Create: `build-resources/archive-runtime/7zip-26.02.json`
- Create: `vendor/7zip/x64/7z.exe`
- Create: `vendor/7zip/x64/7z.dll`
- Create: `vendor/7zip/x64/License.txt`
- Create: `third-party/7zip/LGPL-2.1-or-later.txt`
- Create: `third-party/7zip/BSD-notice.txt`
- Create: `third-party/7zip/unRAR-restriction.txt`
- Create: `third-party/7zip/NOTICE.md`
- Test: `tests/modpacks/archive-runtime-manifest.test.cjs`

**Manifest requirements:** schema version `1`, version `26.02`, architecture `x64`, the exact upstream and source identities from Global Constraints, the valid observed Authenticode signer identity, and exactly three extracted file records keyed `7z.exe`, `7z.dll`, and `License.txt`. Each file record contains the measured positive integer byte size and a lowercase 64-hex SHA-256 calculated by the acquisition script; the verifier rejects zero, absent, additional, or syntactically invalid values.

**Consumes:** Task 1 failure/limit conventions and the pinned upstream identities in Global Constraints.

**Produces:** reviewed unmodified x64 engine files, exact repository manifest, license/notices, deterministic acquisition script, and fail-closed build verifier.

**Required RED assertion:**

```js
test('a one-byte change invalidates the archive runtime', async () => {
  await assert.rejects(verifyArchiveRuntime(tamperedRoot), error => error.code === 'EXTRACTOR_UNAVAILABLE');
});
```

- [ ] RED: write the manifest test first and run `node --test tests/modpacks/archive-runtime-manifest.test.cjs`; it must fail while runtime is absent or any size/hash/version/license/handler is wrong. Non-Windows/non-x64 asserts a deliberate unsupported-build error rather than skipping.
- [ ] Implement `scripts/acquire-7zip.ps1` to download only the exact MSI to a fresh task temp directory; restrict redirects to the official GitHub release asset chain; verify exact size/SHA-256 and `Get-AuthenticodeSignature` status; set `$msiPath` and `$extractDir` to validated absolute paths and call `Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/a', $msiPath, '/qn', "TARGETDIR=$extractDir") -Wait -PassThru -WindowStyle Hidden`; require exit 0 and exactly one colocated `7z.exe`, `7z.dll`, and `License.txt`; verify x64 PE machine and File/Product version 26.02; run that exact executable with `i` and require ZIP and RAR handlers; copy those three files into `vendor/7zip/x64`; record exact extracted hashes, sizes, observed signer identity, acquisition time, and source link in the JSON manifest.
- [ ] Copy the unmodified official license plus the corresponding LGPL, BSD, unRAR restriction, identification/copyright notice, and exact source URL. `NOTICE.md` must explain that hashes prove the vendored runtime identity and that 7-Zip remains separately licensed.
- [ ] Implement `scripts/verify-archive-runtime.cjs` as a fail-closed verifier of architecture, files, exact hashes/sizes/version/handlers, and notices. Add `verify:archive-runtime` and make `pack`, `dist`, and `release` call it before Electron Builder. Do not put the only check in `afterPack.cjs` because that hook currently tolerates failures.
- [ ] GREEN: run `powershell -ExecutionPolicy Bypass -File scripts/acquire-7zip.ps1`, inspect the fixed manifest, then run `node --test tests/modpacks/archive-runtime-manifest.test.cjs`, `npm run verify:archive-runtime`, and `npm test`; all pass.
- [ ] Commit: `build: vendor pinned 7-Zip archive runtime`

### Task 8: Build the fail-closed Windows ArchiveWorker broker

**Files:**

- Create: `native/ArchiveWorker/global.json`
- Create: `native/ArchiveWorker/ArchiveWorker.csproj`
- Create: `native/ArchiveWorker/Program.cs`
- Create: `native/ArchiveWorker/Protocol/FrameReader.cs`
- Create: `native/ArchiveWorker/Protocol/FrameWriter.cs`
- Create: `native/ArchiveWorker/Protocol/WorkerDtos.cs`
- Create: `native/ArchiveWorker/Protocol/WorkerJsonContext.cs`
- Create: `native/ArchiveWorker/Sandbox/AppContainerProfile.cs`
- Create: `native/ArchiveWorker/Sandbox/DirectoryAcl.cs`
- Create: `native/ArchiveWorker/Sandbox/JobObject.cs`
- Create: `native/ArchiveWorker/Sandbox/SandboxedProcess.cs`
- Create: `native/ArchiveWorker/Sandbox/NativeMethods.cs`
- Create: `native/ArchiveWorker/SevenZip/SevenZipCommandFactory.cs`
- Create: `native/ArchiveWorker/SevenZip/SevenZipRuntimeVerifier.cs`
- Create: `native/ArchiveWorker/Security/CanonicalPaths.cs`
- Create: `native/ArchiveWorker/Security/Redaction.cs`
- Create: `native/ArchiveWorker/Durability/DurableFilesystem.cs`
- Create: `scripts/build-archive-worker.ps1`
- Create: `electron/services/modpacks/archive/archive-worker-client.cjs`
- Create: `electron/utils/windows-durable-fs-client.cjs`
- Create: `build-resources/archive-runtime/archive-worker-x64.json`
- Create: `vendor/archive-worker/x64/ArchiveWorker.exe`
- Test: `tests/modpacks/archive-worker-protocol.test.cjs`
- Test: `tests/modpacks/archive-worker-containment.test.cjs`

**Protocol:**

```text
stdin:  uint32 little-endian byte length + one UTF-8 JSON WorkerRequest
stdout: repeated uint32 little-endian byte length + typed UTF-8 JSON frames
frame types: stdout | stderr | data | status
operations: self-test | list | test | extract | read-entry
terminal status: { type:"status", ok, exitCode, errorCode?, metrics }
```

The Node client accepts only `{ operation, operationId, artifactSetId, inputDirectoryId, outputDirectoryId?, archiveFamily, entryName?, limits }`; it resolves all IDs to application-owned paths before framing. It has no generic executable, arguments, environment, or renderer-facing path parameter.

```js
class ArchiveWorkerClient {
  run(request, { signal, onFrame }) // -> Promise<WorkerTerminalStatus>
  selfTest({ resourcesRoot, userDataSentinel }) // -> Promise<ContainmentEvidence>
}

class WindowsDurableFsClient {
  moveWriteThrough(sourcePath, destinationPath) // trusted internal worker op
  flushDirectory(directoryPath) // CreateFileW directory handle + FlushFileBuffers
}
```

**Consumes:** Task 1 limits/errors/paths, Task 2 workspace IDs, and Task 7 exact engine manifest/runtime.

**Produces:** hashed self-contained x64 broker, manifest, framed Node archive client, packaged containment evidence, and a separate trusted internal durability client used by Task 11/transaction code. Renderer IPC never exposes trusted durability operations.

**Required RED assertion:**

```js
test('containment failure has no plain-process fallback', async () => {
  await assert.rejects(client.run(validListRequest, { signal }), error => error.code === 'EXTRACTOR_UNAVAILABLE');
  assert.equal(fakePlainProcessSpawn.calls.length, 0);
});
```

- [ ] Target `net8.0-windows`, `win-x64`, self-contained single-file (`PublishSingleFile=true`, `SelfContained=true`, `PublishTrimmed=false`, `IncludeNativeLibrariesForSelfExtract=true`). Pin SDK `10.0.204` with `rollForward: disable` in the nested `global.json`, and have the build script run `dotnet publish` from that directory. Do not use NativeAOT because this checkout lacks the required C++ linker. The packaged worker requires no machine-installed .NET runtime.
- [ ] Write protocol RED tests for fragmented/oversize/truncated frames, more than one request, unknown operation, invalid IDs/family/limits, output caps, cancellation, timeout, nonzero exit mapping, redaction, and malformed worker output.
- [ ] Implement classic AppContainer process launch with source-generated `[LibraryImport]`: create/derive stable zero-capability profile `MinecraftCore.ArchiveWorker`; grant the AppContainer SID RX on the engine directory, R on the fresh isolated input, and RW on the fresh empty staging directory; configure `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` and an explicit stdout/stderr handle list; close stdin; use absolute `7z.exe`, fixed argument arrays, `EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW`; assign a Job Object with kill-on-close, active-process limit 1, 2 GiB process/job memory, CPU-time/UI restrictions, and no breakaway; then resume. Do not add the host-incompatible child-process-policy attribute: live launch testing proved it causes `0xc0000142` before both the bundled engine and a basic executable can initialize. The Job's active-process limit is the enforced descendant boundary, and the live probe must prove a descendant cannot be created. Never use `Process.Start` as a fallback.
- [ ] Command factory forces `-tzip` or `-trar`, UTF-8 technical output, noninteractive mode, memory limits including RAR memory limit, `--`, and only controlled paths. It never emits a password, link-enabling switch, absolute-path preservation, alternate streams, ACL restoration, or shell command.
- [ ] `self-test` launches `ArchiveWorker.exe --sandbox-probe-child` through the same AppContainer/Job path and grants that probe executable RX. Publish with `IncludeAllContentForSelfExtract=true`, set `DOTNET_BUNDLE_EXTRACT_BASE_DIR` to a fresh job-owned, AppContainer-writable subdirectory, and prove actual bundle files appear only there. Accept Windows' documented AppContainer rewrites of profile/temp variables only when every resulting path is the controlled scratch root or its descendant; require ambient `PATH` and broker secrets to be absent. Prove input read/output write allowed, userData sentinel denied, broker-owned loopback connection denied, and descendant creation denied. Any failed assertion is `EXTRACTOR_UNAVAILABLE`.
- [ ] Implement trusted internal same-volume publication with identity-pinned, handle-bound `SetFileInformationByHandle(FileRenameInfoEx)`: no-replace for absent destinations and `FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS` for an existing file. The supported Win32 API/host rejects a non-null `FILE_RENAME_INFO.RootDirectory` in this call, so pass the canonical extended-length absolute destination while keeping the verified source handle, destination parent, source parent, every intervening directory, and allowed roots pinned. Windows replacement semantics require the expected old target to allow share-delete; it remains pinned against writers, is checked immediately before and after the one namespace mutation, and the final destination must be the current source-handle identity and hash. This provides crash-atomic publication and a verified postcondition, while the documented residual target-slot race is limited to an exact app-authorized destination within the pinned directory chain. Use write-through handles and re-snapshot the still-open source after rename because NTFS name tunneling can apply the replaced name's cached creation time; compare that complete current identity to the published path without weakening the birthtime check. Flush every changed parent directory before success. Route native path calls through validated local-drive `\\?\` paths up to the policy's 1,024-code-unit limit. A path-based `MoveFileExW` call is prohibited. Implement `flush-directory` with `CreateFileW(..., FILE_FLAG_BACKUP_SEMANTICS)` plus `FlushFileBuffers`; return stable errors and never accept these operations from renderer IPC. Task 11 tests the JS wrapper and Task 21 injects failures around the real primitive.
- [ ] RED: before implementation run `node --test tests/modpacks/archive-worker-protocol.test.cjs tests/modpacks/archive-worker-containment.test.cjs` and require the missing worker/new protocol assertion. GREEN: build with `powershell -ExecutionPolicy Bypass -File scripts/build-archive-worker.ps1`, record exact size/SHA-256 in `build-resources/archive-runtime/archive-worker-x64.json`, then run the same tests and `npm test`; all exit 0.
- [ ] Commit: `feat(modpacks): add sandboxed archive worker`

### Task 9: Implement archive listing, policy, extraction, and classification

**Files:**

- Create: `electron/services/modpacks/archive/archive-engine-paths.cjs`
- Create: `electron/services/modpacks/archive/archive-magic.cjs`
- Create: `electron/services/modpacks/archive/sevenzip-slt-parser.cjs`
- Create: `electron/services/modpacks/archive/archive-entry-policy.cjs`
- Create: `electron/services/modpacks/archive/archive-input-materializer.cjs`
- Create: `electron/services/modpacks/archive/archive-inspector.cjs`
- Create: `electron/services/modpacks/archive/archive-extractor.cjs`
- Create: `electron/services/modpacks/archive/archive-classifier.cjs`
- Create: `docs/security/archive-limit-calibration.md`
- Create: `tests/fixtures/archives/README.md`
- Test: `tests/modpacks/archive-magic.test.cjs`
- Test: `tests/modpacks/sevenzip-slt-parser.test.cjs`
- Test: `tests/modpacks/archive-entry-policy.test.cjs`
- Test: `tests/modpacks/archive-inspector.integration.test.cjs`
- Test: `tests/modpacks/archive-extractor.integration.test.cjs`
- Fixtures: `tests/fixtures/archives/*`

**Interfaces:**

```js
getBundledArchiveRuntime({ resourcesPath, arch, isPackaged })
detectArchiveFamily(prefixBytes, reviewedNames)
parseSevenZipTechnicalList(readable, { maxBytes })
validateArchiveEntries(entries, limits)
inspectArchive({ verifiedArtifactSet, signal, onProgress })
extractArchive({ inspectionId, destinationId, signal, onProgress })
classifyArchive({ entries, readEntry, selectedRoot })
```

**Consumes:** Tasks 1-8 limits/errors, verified artifact/workspace IDs, MRPACK parser, pinned runtime, and ArchiveWorker client.

**Produces:** `InspectionResult` with exact archive family/integrity/entries/root candidates/classification/runtime evidence/limit evidence, and a `verified-complete-set` artifact identity required by planning. Development tests receive an injected fixed `runtimeRoot` pointing at `vendor`; packaged mode resolves only `process.resourcesPath/archive`.

**Required RED assertion:**

```js
test('known multipart names remain provisional until engine verification', async () => {
  const result = await inspectArchive({ verifiedArtifactSet: namedParts, signal });
  assert.equal(result.artifactSet.completeness, 'verified-complete-set');
  assert.equal(result.engineEvidence.family, 'rar');
});
```

- [ ] Add generated/provenance-documented tiny ZIP/ZIP64 plus legally reviewable RAR4/RAR5/multipart fixtures, along with encrypted, traversal, alias, collision, link/reparse metadata, prepared server, installer-only, backup, client-only, conflicting loader, custom bootstrap, and ambiguous-root cases. `README.md` records generator/source/license and SHA-256 for every binary fixture; CI never synthesizes RAR with 7-Zip. `docs/security/archive-limit-calibration.md` records compressed/expanded size, entry count, depth, path length, and ratio for named representative real-world server packs plus malicious fixtures, and explains why every Global Constraints limit admits representative packs while stopping malicious cases.
- [ ] RED-test magic/extension mismatch, forced family, every technical-list field/order error, UTF-8/control rejection, decimal overflow, unsafe absolute/drive/UNC/traversal/ADS/device/trailing-dot-space names, Unicode/case aliases, ancestor conflicts, links, non-regular types, depth/path/count/size/ratio/output/time/disk limits, encrypted flags/diagnostics, and no packaged runtime fallback.
- [ ] Implement streaming `-slt` parsing, pre-extraction validation, integrity test, one-wrapper-root detection, bounded `read-entry`, and classifications `mrpack-server`, `mrpack-client-only`, `prepared-server-pack`, `loader-installer-bundle`, `backup-archive`, `ambiguous-or-unknown`, and `unsupported-runtime-layout` with evidence. Integrate MRPACK parsing from Task 4.
- [ ] Extraction goes only to a fresh application-owned staging directory, starts a measured watchdog for actual bytes/file count/per-file/free-space/deadline, terminates the Job when any bound crosses, then performs a no-follow postwalk that rejects reparse/nonregular objects, revalidates canonical names/collisions, and proves containment. On any error remove staging and retain only policy-approved cache entries.
- [ ] RED: run `node --test tests/modpacks/archive-magic.test.cjs tests/modpacks/sevenzip-slt-parser.test.cjs tests/modpacks/archive-entry-policy.test.cjs tests/modpacks/archive-inspector.integration.test.cjs tests/modpacks/archive-extractor.integration.test.cjs`; require the new-module or intended assertion failure. GREEN: rerun it and require all subtests to pass, then run `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)`, `npm test`, and `npm run verify:archive-runtime`.
- [ ] Commit: `feat(modpacks): inspect and extract untrusted packs`

### Task 10: Complete exact NeoForge and Quilt runtime installation and launch

**Files:**

- Modify: `electron/services/loader-install-service.cjs`
- Modify: `electron/services/server-launcher.cjs`
- Modify: `electron/services/server-java-manager.cjs`
- Modify: `electron/services/server-manager.cjs`
- Modify: `electron/ipc/install-handlers.cjs`
- Modify: `electron/utils/server-loader.cjs`
- Test: `tests/neoforge-runtime.test.cjs`
- Test: `tests/quilt-runtime.test.cjs`
- Modify test: `tests/loader-install-service.test.cjs`
- Modify test: `tests/server-launcher.test.cjs`

**Interfaces:**

```js
getLoaderVersions(loader, minecraftVersion, { transport })
installServerLoader(serverPath, loader, minecraftVersion, loaderVersion, options)
validatePreparedRuntime(serverPath, runtimeTuple)
resolveLaunchPlan(serverPath, config, { runtimeTuple })
```

**Consumes:** Task 1 exact runtime tuple/errors and existing Fabric/Forge/server Java contracts.

**Produces:** backward-compatible `LaunchPlan = { type, loader, jar, args, cwd, readyMarkers, fatalMarkers, runtime }`. `args` remains the loader/application argument array expected by `server-manager.cjs`; `ServerJavaManager` continues to own the Java executable. Task 18 may refactor process ownership but must preserve this shape.

**Required RED assertion:**

```js
test('NeoForge can never fall through to vanilla', () => {
  assert.throws(() => resolveLaunchPlan(incompleteNeoForgePath, config, { runtimeTuple }),
    error => error.code === 'RUNTIME_INCOMPLETE');
});
```

- [ ] RED-test exact NeoForge Maven metadata/version/artifact URL, exact Quilt Meta loader/server artifact, unavailable exact version, no latest fallback, official installer/runtime reconstruction only, incomplete runtime detection, Java-major selection, argument-file parsing, Windows classpath handling, ready/fatal markers, and explicit rejection rather than Vanilla fallback.
- [ ] Preserve current Fabric/Forge public behavior and add explicit `neoforge` and `quilt` branches to resolution, install, validation, and launch. Application-generated official loader installation is allowed; pack-supplied installers/scripts are never executed. Validate resolved runtime paths remain inside the server and exact tuple metadata matches.
- [ ] `resolveLaunchPlan()` returns the declared backward-compatible `LaunchPlan` for all five families. Update `server-manager.cjs` to consume `cwd`, ready/fatal markers, loader/runtime fields while retaining Java selection, JVM-property insertion, and process tracking. Unknown/incomplete loaders return `UNSUPPORTED_LOADER` or `RUNTIME_INCOMPLETE`; they never produce Vanilla arguments.
- [ ] RED: run `node --test tests/loader-install-service.test.cjs tests/server-launcher.test.cjs tests/neoforge-runtime.test.cjs tests/quilt-runtime.test.cjs` before implementation and require the intended missing NeoForge/Quilt assertion. GREEN: rerun it and `npm test`; all pass.
- [ ] Commit: `feat(runtime): support NeoForge and Quilt servers`

### Task 11: Make server config writes durable and revision-aware

**Files:**

- Create: `electron/utils/durable-fs.cjs`
- Create: `electron/services/server-content-revision.cjs`
- Modify: `electron/utils/config-manager.cjs`
- Test: `tests/durable-fs.test.cjs`
- Test: `tests/config-manager.content-revision.test.cjs`

**Interfaces:**

```js
writeFileAtomic(filePath, data, { mode, fsyncParent = true } = {})
writeJsonAtomic(filePath, value, options)
renameDurable(sourcePath, destinationPath)
sha256File(filePath)
readContentRevision(serverPath)
bumpContentRevision(serverPath, { expectedRevision, operationId })

writeServerConfig(serverPath, config, defaults = {}, options = {})
updateServerConfig(serverPath, updates, defaults = {}, options = {})
```

**Consumes:** Task 8 `WindowsDurableFsClient`; existing config normalization.

**Produces:** atomic file replacement with flushed file data and flushed parent metadata, write-through file/directory rename, normalized revision compare-and-set, and backward-compatible config APIs.

**Required RED assertion:**

```js
test('atomic JSON publication flushes data before write-through rename', async () => {
  await writeJsonAtomic(target, { contentRevision: 1 });
  assert.deepEqual(calls.map(call => call.kind), ['write', 'flush-file', 'move-write-through', 'flush-directory']);
});
```

`options` supports `{ expectedContentRevision, nextContentRevision, allowRevisionOverride:false }` and defaults to rejecting a renderer/config attempt to set revision directly.

- [ ] RED-test file and parent flush ordering through injected filesystem calls, atomic replacement, cleanup after failure, compare-and-set mismatch, default revision 0, normalized non-negative integers, ordinary-field preservation, renderer revision overwrite rejection, lifecycle candidate explicit `old+1`, and no partial JSON on injected failures.
- [ ] Replace direct config writes with unique temp, file flush/close, Task 8 write-through replace/rename, and required parent-directory flush. A failure of the supported Windows durability primitive fails the write and remains recoverable; there is no best-effort success path. Maintain backward-compatible config normalization and unknown-key preservation.
- [ ] RED: run `node --test tests/durable-fs.test.cjs tests/config-manager.content-revision.test.cjs`; require the new-module or intended ordering assertion failure. GREEN: rerun it and require all subtests to pass, then run `npm test`.
- [ ] Commit: `feat(core): add durable content revisions`

### Task 12: Implement the shared mutation coordinator and start gate

**Files:**

- Create: `electron/services/server-mutation-coordinator.cjs`
- Create: `electron/services/server-mutation-context.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/services/server-manager.cjs`
- Modify: `electron/services/server-launcher.cjs`
- Test: `tests/server-mutation-coordinator.test.cjs`
- Test: `tests/server-start-gate.test.cjs`
- Modify test: `tests/auto-restart-start-request.test.cjs`

**Interfaces:**

```js
class ServerMutationCoordinator {
  beginStartupRecovery()
  installRecoveryBlocks(records)
  completeStartupRecovery(outcomes)
  runMutation(selector, options, work)
  runManyMutations(selectors, options, work)
  acquireStart(selector, { operation, operationId, parentMutationLease = null })
}

selector = { instanceId, serverPath }
options = { operation, operationId, revisionMode: 'auto'|'lifecycle'|'none', quiesce }
```

**Consumes:** Task 11 durable revision compare-and-set and existing process manager hooks.

**Produces:** case-insensitive instance/path alias locks; pending-mutation reservations; mutation leases exposing `baseRevision`, `markDirty()`, `assertOwnedPath()`, nested candidate/final starts, and idempotent release; start leases exposing `markRunning({ pid })`, `markDirty()`, and release. The shared coordinator begins fail-closed for recovery; legacy composition explicitly completes an empty recovery pass until Task 22 installs real recovery.

**Required RED assertion:**

```js
test('a pending mutation blocks a new start before quiesce awaits', async () => {
  const mutation = coordinator.runMutation(selector, options, async () => gate.promise);
  await assert.rejects(coordinator.acquireStart(selector, startOptions), error => error.code === 'OPERATION_IN_PROGRESS');
  gate.resolve();
  await mutation;
});
```

- [ ] RED-test Windows path aliases, stable instance/path aliasing, two writers, writer-versus-start, reservation before quiesce, nested lifecycle validation start, startup/recovery block, spawn failure/exit release, dirty-once bump, thrown partial dirty work, deterministic multi-server ordering, cancellation, and reentrancy rejection.
- [ ] Make `startMinecraftServer()` acquire before config read/property sync and release on spawn failure or child exit. A pending mutation blocks starts before it stops the active child. Lifecycle can keep one parent lease through both validations and commit. Until the real registry exists, current `main.cjs` explicitly completes an empty startup-recovery pass before ordinary startup; Task 15 moves that call into the composition root and Task 22 replaces it with real registry recovery before feature IPC is exposed.
- [ ] RED: run `node --test tests/server-mutation-coordinator.test.cjs tests/server-start-gate.test.cjs tests/auto-restart-start-request.test.cjs`; require new-module or intended assertion failure. GREEN: rerun it with every subtest passing, then `npm test`.
- [ ] Commit: `feat(core): coordinate server mutations and starts`

### Task 13: Route core configuration, runtime, backup, and world writers through the gate

**Files:**

- Create: `electron/services/server-mutation-policy.cjs`
- Create: `docs/security/server-writer-inventory.md`
- Modify: `electron/ipc-handlers.cjs`
- Modify: `electron/ipc/config-handlers.cjs`
- Modify: `electron/ipc/file-handlers.cjs`
- Modify: `electron/ipc/settings-handlers.cjs`
- Modify: `electron/ipc/server-properties-handlers.cjs`
- Modify: `electron/ipc/install-handlers.cjs`
- Modify: `electron/ipc/server-java-handlers.cjs`
- Modify: `electron/ipc/backup-handlers.cjs`
- Modify: `electron/services/download-manager.cjs`
- Modify: `electron/services/loader-install-service.cjs`
- Modify: `electron/services/server-java-manager.cjs`
- Modify: `electron/services/backup-service.cjs`
- Modify: `electron/services/auto-restart.cjs`
- Modify: `electron/utils/tls-utils.cjs`
- Test: `tests/server-core-writer-coordination.test.cjs`

**Consumes:** Task 12 coordinator/context and Task 11 content revisions.

**Produces:** coordinated policies for config write/update/cleanup, folder/version/EULA/world operations, settings/instance deletion, server properties, server/loader/Java install, backup restore/pinned deletion, management secrets/TLS, and auto-restart config. Backup creation/logging remain ancillary; restore is exclusive.

**Required RED assertion:**

```js
test('a restore cannot write while the server run lease exists', async () => {
  await assert.rejects(handlers['backups:restore'](event, request), error => error.code === 'SERVER_RUNNING');
});
```

- [ ] Move constructor/read-path directory creation and config migration into explicit `ensure*` mutations. `get-instances`, config reads, mod reads, and hydration perform no filesystem writes.
- [ ] Build `server-mutation-policy.cjs` with exact channel, operation, and stable instance/path resolver. Add every touched service/handler and its write sites to the reviewed inventory, including justified ancillary exceptions.
- [ ] RED: run `node --test tests/server-core-writer-coordination.test.cjs`; require intended ungated-write failure. GREEN: rerun it and `npm test`; require all pass.
- [ ] Commit: `feat(core): gate core server writers`

### Task 14: Route mods, client assets, player lists, and browser writers through the gate

**Files:**

- Modify: `electron/ipc/management-server-handlers.cjs`
- Modify: `electron/ipc/player-handlers.cjs`
- Modify: `electron/ipc/minecraft-launcher-handlers.cjs`
- Modify: `electron/ipc/mod-handlers.cjs`
- Modify: `electron/ipc/mod-handlers/server-mod-handlers.cjs`
- Modify: `electron/ipc/mod-handlers/client-mod-handlers.cjs`
- Modify: `electron/ipc/mod-handlers/manual-mod-handlers.cjs`
- Modify: `electron/ipc/mod-utils/mod-installation-service.cjs`
- Modify: `electron/ipc/mod-utils/mod-file-manager.cjs`
- Modify: `electron/services/browser-panel-server.cjs`
- Modify: `electron/services/mod-availability-watcher.cjs`
- Modify: `electron/services/server-mutation-policy.cjs`
- Modify: `docs/security/server-writer-inventory.md`
- Test: `tests/server-content-writer-coordination.test.cjs`
- Test: `tests/server-writer-inventory.test.cjs`

**Consumes:** Tasks 12-13 coordinator, context, policy table, and inventory format.

**Produces:** coordinated player/operator/whitelist/ban writes; management-panel writes; server/client/manual mod install/update/delete/move/disable/manifest operations; shader/resource-pack operations; launcher-managed client assets tied back to their owning server; browser API delegation; and availability-state writes.

**Required RED assertion:**

```js
test('registered filesystem writers are inventoried or explicitly ancillary', () => {
  assert.deepEqual(scanUnaccountedWriteSites(), []);
});
```

- [ ] Split read-only mod listing/metadata from state migration and directory creation; explicit migration helpers acquire a mutation lease. Browser routes delegate to already-gated services and cannot bypass policy.
- [ ] The inventory test scans registered handlers and reviewed `fs` write calls, failing for a new mutating channel/site without a policy or a documented ancillary exception. Task 26 must rerun and extend it for lifecycle IPC.
- [ ] RED: run `node --test tests/server-content-writer-coordination.test.cjs tests/server-writer-inventory.test.cjs`; require intended uncovered-write failures. GREEN: rerun it and `npm test`; require all pass.
- [ ] Commit: `feat(core): gate content and browser writers`

### Task 15: Introduce an injectable main-process composition root

**Files:**

- Create: `electron/bootstrap/create-main-bootstrap.cjs`
- Create: `electron/bootstrap/create-modpack-service-graph.cjs`
- Create: `electron/bootstrap/runtime-flags.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/ipc-handlers.cjs`
- Test: `tests/main-bootstrap.test.cjs`
- Test: `tests/modpacks/service-graph.test.cjs`

**Interfaces:**

```js
createModpackServiceGraph(deps) // -> frozen service graph
createMainBootstrap({ electronApi, serviceGraph, runtimeFlags })
// -> { initializeBeforeReady, onReady, dispose }
```

**Consumes:** Tasks 1-14 providers/archive/runtime/coordinator and existing app services.

**Produces:** one composition root that injects app/store/window, paths, clock, DNS/HTTPS, filesystem, random IDs, worker/process factories, provider adapters, coordinator, updater/tray/watchdog toggles, and runtime roots. `MINECRAFT_CORE_TEST_MODE=1` is honored only when `NODE_ENV=test`; it disables updater, tray, watchdog, native notifications, and public management listeners while retaining production IPC/security and isolated `userData`.

**Required RED assertion:**

```js
test('test mode cannot accidentally start updater or public services', async () => {
  await bootstrap.onReady();
  assert.equal(fakeUpdater.start.calls.length, 0);
  assert.equal(fakeManagementServer.listen.calls.length, 0);
});
```

- [ ] Refactor eager startup side effects behind explicit dependency factories without changing production behavior. `setupIpcHandlers()` consumes the graph rather than constructing globals. Until Task 22 installs real recovery, bootstrap explicitly completes an empty recovery pass before any launch; no modpack lifecycle IPC is exposed yet.
- [ ] RED: run `node --test tests/main-bootstrap.test.cjs tests/modpacks/service-graph.test.cjs`; require intended ordering/injection failure. GREEN: rerun it, `npm run build`, and `npm test`.
- [ ] Commit: `refactor(core): add injectable main bootstrap`

### Task 16: Add the application-level recovery registry

**Files:**

- Create: `electron/services/modpack-lifecycle/recovery-registry.cjs`
- Create: `electron/services/modpack-lifecycle/recovery-target-envelope.cjs`
- Test: `tests/modpacks/recovery-registry.test.cjs`

**Interfaces:**

```js
class RecoveryRegistry {
  constructor({ userDataPath, fsApi, clock, randomUUID })
  async initialize()
  async create(record)
  async load(jobId)
  async listActive()
  async transition(jobId, { expectedPhase, nextPhase, patch })
  async finish(jobId, { terminalPhase, outcome })
}
```

Each record contains `schemaVersion`, monotonic `sequence`, `jobId`, `operationKind`, target kind and stable server ID, canonical target/candidate/rollback/failed paths, restore-point identity/digest, journal path, prior running/auto-restart state, phase/swap step, directory identities, and timestamps.

**Consumes:** Task 11 durable writes/renames and Task 1 errors/controlled paths.

**Produces:** an app-level registry under `path.join(userDataPath, 'modpack-lifecycle', 'active')` plus a separately checksummed minimal target envelope containing job ID, stable server ID when known, normalized target-path hash, and display-safe target label. `initialize()` returns valid records, corrupt records whose envelope still permits a per-server block, and `globalBlock:true` if neither full record nor target envelope can be trusted.

**Required RED assertion:**

```js
test('an unidentifiable corrupt record blocks every start', async () => {
  await fs.writeFile(activeRecordPath, '{bad');
  const scan = await registry.initialize();
  assert.equal(scan.globalBlock, true);
});
```

- [ ] RED-test unique create, envelope-before-record ordering, schema rejection, compare-and-transition, monotonic sequence, durable temp/flush/write-through rename, corrupt-record quarantine without deletion, per-server/global blocks, active/history separation, offline targets retained, terminal finish, and injected failure at every durable step.
- [ ] Never rely solely on server-local state and never delete/rename an ambiguous target. Finishing a record durably moves both record and envelope to history only after terminal outcome persistence.
- [ ] RED: run `node --test tests/modpacks/recovery-registry.test.cjs`; require new-module/intended corrupt-record assertion failure. GREEN: rerun it and `npm test`; require all pass.
- [ ] Commit: `feat(modpacks): add durable recovery registry`

### Task 17: Strengthen backups into verified pinned lifecycle restore points

**Files:**

- Modify: `electron/utils/backup-util.cjs`
- Modify: `electron/services/backup-service.cjs`
- Modify: `electron/ipc/backup-handlers.cjs`
- Create: `electron/services/modpack-lifecycle/restore-point-service.cjs`
- Test: `tests/modpacks/verified-restore-point.test.cjs`
- Modify test: `tests/backup-service-boundary.test.cjs`

**Interfaces:**

```js
enumerateArchiveScope(items)
createVerifiedZip({ items, partPath, expectedScope, onProgress })

class RestorePointService {
  createVerifiedRestorePoint({ serverPath, operationId, sourceRevision, sourceRuntime })
  pinRestorePoint(reference)
  unpinRestorePoint(reference)
  isRestorePointPinned(reference)
  restoreToFreshCandidate(reference, destination)
  verifyRestorePoint(reference)
}
```

**Consumes:** Tasks 8/11/12 durable filesystem and mutation context plus existing backup APIs.

**Produces:** user-visible exact-scope ZIP restore points with archive digest, scope manifest, source revision/runtime, durable operation pin, retention protection, and fresh-candidate reconstruction.

**Required RED assertion:**

```js
test('a scope mismatch never publishes a visible restore point', async () => {
  await assert.rejects(service.createVerifiedRestorePoint(request), error => error.code === 'BACKUP_FAILED');
  assert.deepEqual(await visibleZipFiles(backupDir), []);
});
```

- [ ] RED: test exact scope, links, `.part`, digest/flush/close, integrity, entry equality, final rename/pin, retention, fresh reconstruction, and corruption; run `node --test tests/modpacks/verified-restore-point.test.cjs tests/backup-service-boundary.test.cjs` and require intended failure.
- [ ] Inject failure before archive close, during integrity test, during manifest comparison, before/after final rename, and during pin persistence. Before final rename no visible `.zip` may exist; after rename without a durable pin, recovery must discover and either finish pinning the operation-owned artifact or retain it diagnostically.
- [ ] Keep ordinary backup APIs backward compatible. Lifecycle rollback must call `restoreToFreshCandidate()` only as fallback; never use the existing overlay restore for exact transaction recovery.
- [ ] GREEN: run `node --test tests/modpacks/verified-restore-point.test.cjs tests/backup-service-boundary.test.cjs`, then `npm test`; all pass.
- [ ] Commit: `feat(backups): add verified lifecycle restore points`

### Task 18: Add operation-scoped process launch and Minecraft health validation

**Files:**

- Create: `electron/services/server-process-runner.cjs`
- Create: `electron/services/minecraft-status-ping.cjs`
- Create: `electron/services/server-health-validator.cjs`
- Modify: `electron/services/server-manager.cjs`
- Test: `tests/minecraft-status-ping.test.cjs`
- Test: `tests/server-health-validator.test.cjs`
- Modify test: `tests/server-launcher.test.cjs`

**Interfaces:**

```js
launchServerProcess({ serverPath, instanceId, runtime, javaPath, maxRam,
  operationId, publishEvents, onLine })
pingMinecraftStatus({ host, port, timeoutMs, protocolVersion = -1, signal })

class ServerHealthValidator {
  validateCandidate({ jobId, candidatePath, runtime, maxRam, mutationLease, timeoutMs, signal })
  validateLive({ jobId, instanceId, serverPath, runtime, port, maxRam,
    mutationLease, keepRunning, timeoutMs, signal })
}
```

**Consumes:** Task 10 launch plans, Task 12 nested start lease, and existing Java/process event contracts.

**Produces:** shared process handles, protocol-correct Minecraft status ping, candidate/live validation, and `HealthEvidence` tied to the launched PID, endpoint, ready marker, pong nonce, liveness, and restored properties hash/absence.

**Required RED assertion:**

```js
test('an unrelated listener cannot satisfy candidate health', async () => {
  await assert.rejects(validator.validateCandidate(request), error => error.code === 'HEALTH_CHECK_FAILED');
});
```

`HealthEvidence` records PID, matching ready marker, expected loopback/configured listener endpoint, matching status response/MOTD nonce, child liveness, clean shutdown evidence, elapsed time, and exact restored `server.properties` hash or absence.

- [ ] RED: test VarInt/handshake/status, fragmentation, oversize/invalid response, wrong identity, timeout/abort/close, and unrelated listener; run `node --test tests/minecraft-status-ping.test.cjs tests/server-health-validator.test.cjs tests/server-launcher.test.cjs` and require intended failure.
- [ ] RED-test fake children for each loader ready/fatal marker, premature exit, loopback-only temporary port/address, query/RCON/management disabled, job-specific MOTD, `publishEvents:false`, canonical `server.properties` bytes/absence saved and restored, child fully stopped, live validation, keep-running handoff, and prior stopped state.
- [ ] Refactor normal launch to share the process runner without changing event behavior. Candidate validation writes only a temporary candidate overlay, waits for ready marker + listener + matching status pong from the same live child, stops it, restores exact bytes/absence, and verifies the hash before returning. Final validation runs from the canonical path under the parent mutation lease.
- [ ] GREEN: run `node --test tests/minecraft-status-ping.test.cjs tests/server-health-validator.test.cjs tests/server-launcher.test.cjs`, then `npm test`; all pass.
- [ ] Commit: `feat(runtime): health-gate server publication`

### Task 19: Persist managed state and produce ownership/preflight plans

**Files:**

- Create: `electron/services/modpacks/state/modpack-state-repository.cjs`
- Create: `electron/services/modpacks/planning/ownership-planner.cjs`
- Create: `electron/services/modpacks/planning/preflight-planner.cjs`
- Create: `electron/services/modpacks/planning/plan-fingerprint.cjs`
- Test: `tests/modpacks/modpack-state-repository.test.cjs`
- Test: `tests/modpacks/ownership-planner.test.cjs`
- Test: `tests/modpacks/preflight-planner.test.cjs`

**Interfaces:**

```js
class ModpackStateRepository {
  read(serverPath)
  writeCandidate(serverPath, state)
  appendHistory(serverPath, entry)
  listHistory(serverPath, { cursor, limit })
  detachCandidate(serverPath, operation)
}

planOwnership({ oldManifest, liveSnapshot, incomingManifest, conflictChoices })
buildPreflightPlan({ operation, source, artifactSet, runtime, inspection,
  serverSnapshot, ownershipPlan, restorePoints, selections })
assertPlanStillValid(plan, currentSnapshot)
```

**Consumes:** Tasks 1-10 provider/artifact/runtime/inspection contracts and Task 11 durable state writes.

**Produces:** protected managed state/manifest/history, three-way ownership decisions, deterministic preflight/fingerprint, asset-pattern and accepted cross-provider mapping persistence, and confirmation DTOs including exact unchanged-managed removal count, preserved categories, possible non-runnable outcome, and explicit instance/world retention.

**Required RED assertion:**

```js
test('similar provider names never merge source identity', () => {
  assert.equal(planCrossProviderIdentity(modrinth, github, []), 'distinct');
});
```

- [ ] RED-test the four origin values, four management policies, reserved state rejection, EULA ignored, protected seeding/new versus preservation/existing, configured world directories, user add-ons, modified-managed/orphan detection, every three-way reconciliation row, conflict choice rules, `Keep both` validity, bulk-choice exclusions for worlds/secrets, and mod-ID/runtime incompatibility.
- [ ] RED-test deterministic added/changed/removed/preserved/conflict lists, exact runtime/artifact identity, optional decisions, restore-point/downgrade requirements, files-only safety, missing GitHub digest acknowledgement, disk arithmetic/reserve, writeability, touched-path stat/hash snapshot, `contentRevision`, asset-pattern evidence drift, accepted permanent-ID mapping, history pagination, detach/uninstall confirmation counts, and fingerprint invalidation for every input mutation.
- [ ] Persist compact backward-compatible summary in candidate `.minecraft-core.json` and schema-versioned state under candidate `.minecraft-core-state/{modpack.json,manifests,operations,history}`. `modpack.json` includes versioned asset pattern and accepted upstream mapping when present. State files are `application/protected`, never archive-owned, and use durable writes. Persist no cache path or remote URL.
- [ ] RED: run `node --test tests/modpacks/modpack-state-repository.test.cjs tests/modpacks/ownership-planner.test.cjs tests/modpacks/preflight-planner.test.cjs`; require intended failure. GREEN: rerun it, `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)`, and `npm test`.
- [ ] Commit: `feat(modpacks): plan ownership and preflight`

### Task 20: Build candidates and publish new servers transactionally

**Files:**

- Create: `electron/services/modpack-lifecycle/operation-journal.cjs`
- Create: `electron/services/modpack-lifecycle/server-directory-identity.cjs`
- Create: `electron/services/modpack-lifecycle/server-directory-transaction.cjs`
- Create: `electron/services/modpack-lifecycle/instance-registry.cjs`
- Test: `tests/modpacks/new-server-publication.test.cjs`

**Interfaces:**

```js
createSiblingPaths(targetPath, jobId)
identifyServerDirectory(path)
buildNewCandidate(context)
publishNewCandidate(context)
registerPublishedInstance(context)
```

**Consumes:** Tasks 11-12 durability/lease, Task 16 recovery registry, Task 18 health validator, and Task 19 state/preflight plan.

**Produces:** exclusive same-volume sibling paths, operation-owned directory markers/identities, complete new-server candidate construction, loopback validation, durable `publishing -> published -> registering` publication, and main-process instance registration returning a stable instance ID.

**Required RED assertion:**

```js
test('new publication never adopts a pre-existing target', async () => {
  await fs.mkdir(targetPath);
  await assert.rejects(publishNewCandidate(context), error => error.code === 'TARGET_EXISTS');
});
```

- [ ] Reject target/candidate/failed symlinks, junctions, reparse points, recursive paths, changed identities, and unowned pre-existing paths. Candidate uses real copies/no-follow walks and no ordinary hardlinks.
- [ ] Before rename, durably write recovery phase `publishing`, `swapStep:'new-prepared'`, target-absence evidence, candidate identity, and operation marker. Use Task 8 write-through rename, durably transition `published`, register exact operation-owned target, then transition `registering`/registration complete.
- [ ] RED: run `node --test tests/modpacks/new-server-publication.test.cjs`; require intended target/publication failure. GREEN: rerun it and `npm test`.
- [ ] Commit: `feat(modpacks): publish new servers transactionally`

### Task 21: Commit existing-server candidates with a durable directory swap

**Files:**

- Modify: `electron/services/modpack-lifecycle/operation-journal.cjs`
- Modify: `electron/services/modpack-lifecycle/server-directory-identity.cjs`
- Modify: `electron/services/modpack-lifecycle/server-directory-transaction.cjs`
- Test: `tests/modpacks/server-directory-transaction.test.cjs`

**Interfaces:**

```js
buildExistingCandidate(context)
swapExistingCandidate(context)
markCommittedHealthy(context)
cleanupCommittedTransaction(context)
```

**Consumes:** Task 20 identity/journal/transaction primitives plus Tasks 17-19 restore point, health, state/ownership plan.

**Produces:** complete existing-server candidates, exact two-rename commit, canonical final validation, durable healthy mark, and cleanup-pending outcome. Top-level operation phases remain the approved enum. `swapStep` is separately versioned as `none | prepared | live-moved | candidate-published | failed-canonical-moved | rollback-restored | cleanup-complete`; these values never appear as top-level phases.

**Required RED assertion:**

```js
test('failure between renames retains enough identity to restore one canonical server', async () => {
  faultInjector.failAfter('live-moved');
  await assert.rejects(transaction.swapExistingCandidate(context));
  assert.equal((await registry.load(jobId)).swapStep, 'live-moved');
});
```

- [ ] Copy preserved/user content with real copies; apply incoming changes only in the candidate; write state/revision `old+1`; loopback-validate; stop; verify exact canonical `server.properties`; and retain the untouched original as rollback sibling.
- [ ] Under one MutationLease: durable `committing/prepared`; write-through rename live to rollback; durable `live-moved`; rename candidate to live; durable `candidate-published`; final canonical validation; durable `committed-healthy`; publish one revision event; cleanup. Cleanup failure is `cleanup-pending` and keeps healthy canonical authoritative.
- [ ] Inject failure after every journal/registry/file/directory flush and rename. RED: run `node --test tests/modpacks/server-directory-transaction.test.cjs`; require intended phase failure. GREEN: rerun it and `npm test`.
- [ ] Commit: `feat(modpacks): commit directory-swap updates`

### Task 22: Recover transactions before any launch or IPC exposure

**Files:**

- Create: `electron/services/modpack-lifecycle/modpack-recovery-service.cjs`
- Create: `electron/services/modpack-lifecycle/startup-recovery-bootstrap.cjs`
- Modify: `electron/bootstrap/create-main-bootstrap.cjs`
- Modify: `electron/bootstrap/create-modpack-service-graph.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/services/auto-restart.cjs`
- Test: `tests/modpacks/modpack-recovery.test.cjs`
- Test: `tests/modpacks/modpack-prior-runtime-state.test.cjs`
- Test: `tests/modpacks/startup-recovery-order.test.cjs`

**Interfaces:**

```js
class ModpackRecoveryService {
  recoverAll(scanResult)
  recover(record)
  rollback(record, reason)
  recoverNewPublication(record)
  recoverExistingSwap(record)
  retryCommittedCleanup(record)
}

initializeStartupRecovery({ coordinator, registry, recoveryService, runtimeVerifier })
```

**Consumes:** Tasks 15-21 composition root, recovery registry/envelopes, restore points, health, new publication, and existing swap.

**Produces:** idempotent recovery outcomes and startup ordering: coordinator fail-closed/runtime verification; registry scan; automatic recovery; unresolved per-server/global blocks; then transient cleanup, IPC/window, config migration, auto-restart, browser start, and all other launches.

**Required RED assertion:**

```js
test('IPC setup cannot run before recovery finishes', async () => {
  await bootstrap.onReady();
  assert.ok(order.indexOf('recover-all') < order.indexOf('setup-ipc'));
});
```

- [ ] Cover pre-swap cleanup; new `publishing/published/registering`; between-renames identity repair; post-swap health rollback; verified restore reconstruction to a fresh sibling; `committed-healthy/cleanup-pending` cleanup retry; offline/ambiguous block; corrupt-envelope global block; prior auto-restart; relaunch only when previously running.
- [ ] Stop failed runtime, move failed canonical aside, restore untouched rollback with write-through rename, verify identity, and only then restore prior policy. Never overlay. Keep unresolved diagnostics and visible records.
- [ ] RED: run `node --test tests/modpacks/modpack-recovery.test.cjs tests/modpacks/modpack-prior-runtime-state.test.cjs tests/modpacks/startup-recovery-order.test.cjs`; require intended ordering/recovery failure. GREEN: rerun it and `npm test`.
- [ ] Commit: `feat(modpacks): recover lifecycle operations at startup`

### Task 23: Add durable jobs, ephemeral reviewed plans, and read-only planning

**Files:**

- Create: `electron/services/modpack-lifecycle/operation-store.cjs`
- Create: `electron/services/modpack-lifecycle/plan-registry.cjs`
- Create: `electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs`
- Test: `tests/modpacks/operation-store.test.cjs`
- Test: `tests/modpacks/plan-registry.test.cjs`
- Test: `tests/modpacks/modpack-lifecycle-planning.test.cjs`

**Interfaces:**

```js
class PlanRegistry {
  create({ plan, sanitizedView, fingerprint, planningSessionId })
  // -> { planId, fingerprint, planView, expiresAt }
  get({ planId, fingerprint })
  claim({ planId, fingerprint })
  invalidate(planId)
}

class ModpackLifecycleService {
  inspectSource(request)
  createPlan(request) // -> sanitized plan view + opaque planId
  getJob(jobId)
  cancelJob(jobId)
}
```

**Consumes:** Tasks 1-22 providers/artifacts/archive/runtime/planning/coordinator/recovery/transaction services.

**Produces:** two-hour in-memory, one-use, random plan IDs bound to fingerprint/server/artifact/workspace state; durable jobs; operation-scoped safe events. `create()` atomically transfers Task 2 workspace ownership from the internal planning session to `planId`; `claim()` transfers it from `planId` to the new `jobId` in the same critical section as the one-use claim. Source URLs remain only in the internal in-memory plan. Verified artifacts persist by digest. Application restart invalidates unclaimed plans and requires preflight again.

The only top-level phases are `queued`, `resolving`, `downloading`, `verifying`, `inspecting`, `planning`, `awaiting-user`, `preflight`, `snapshotting`, `staging`, `validating-candidate`, `committing`, `publishing`, `published`, `registering`, `starting`, `validating-live`, `committed-healthy`, `cleanup`, `cleanup-pending`, `completed`, `cancelling`, `cancelled`, `rolling-back`, `rolled-back`, `failed`, and `recovery-required`. Swap steps from Task 21 are a separate field.

**Required RED assertion:**

```js
test('a fingerprint cannot execute without its one-use plan ID', () => {
  assert.throws(() => registry.claim({ planId: 'wrong', fingerprint }), error => error.code === 'PLAN_STALE');
});
```

- [ ] RED-test every legal/illegal transition, monotonic sequence, one terminal state, cancellation only before commit, event isolation/redaction, reload lookup, plan expiry/replay/restart invalidation, fingerprint-only rejection, cross-server claim, workspace ownership transfer/rollback, and sanitized view with no path/URL/cache/workspace/provider-internal field.
- [ ] Planning may download/cache/inspect but writes nothing under the server. It returns `{ planId, planFingerprint, planView, expiresAt }`; `planView` is exactly `sanitizedView`, never the internal plan. Execution in Task 24 accepts `{ planId, planFingerprint, choices }`.
- [ ] RED: run `node --test tests/modpacks/operation-store.test.cjs tests/modpacks/plan-registry.test.cjs tests/modpacks/modpack-lifecycle-planning.test.cjs`; require intended failures. GREEN: rerun it and `npm test`.
- [ ] Commit: `feat(modpacks): add reviewed lifecycle plans and jobs`

### Task 24: Execute install, version-change, switch, repair, and rollback jobs

**Files:**

- Modify: `electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs`
- Test: `tests/modpacks/modpack-lifecycle-mutations.test.cjs`

**Interfaces:**

```js
startOperation({ planId, planFingerprint, choices }) // -> JobDto immediately
```

**Consumes:** Task 23 claimed plan/job plus all transaction services.

**Produces:** `install-new`, `install-existing`, `update`, `downgrade`, `switch`, `repair`, and `rollback-restore-point` jobs fully owned by the main process.

**Required RED assertion:**

```js
test('downgrade cannot replace binaries without a compatible world restore point', async () => {
  await assert.rejects(service.startOperation(downgradeWithoutWorldSnapshot), error => error.code === 'PLAN_STALE');
});
```

- [ ] Re-resolve instance, claim plan, acquire once, quiesce, suspend restart, revalidate exact artifacts/touched hashes/revision/disk/Java/runtime/conflicts/acknowledgements, snapshot existing server, construct/validate candidate, commit/validate live, persist state/history, restore prior run state, and emit one revision change.
- [ ] Cover exact new install/registration, existing unmanaged adoption, upgrade, world-safe downgrade, switch old ownership/orphans/user add-ons, targeted repair only for detected mismatches, and restore-point rollback through a fresh candidate. Pre-commit failure leaves original byte-identical; post-commit failure rolls back or remains recovery-required.
- [ ] RED: run `node --test tests/modpacks/modpack-lifecycle-mutations.test.cjs`; require intended lifecycle failure. GREEN: rerun it, `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)`, and `npm test`.
- [ ] Commit: `feat(modpacks): execute managed lifecycle mutations`

### Task 25: Add verify, files-only import, detach, uninstall, history, and outcome actions

**Files:**

- Modify: `electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs`
- Modify: `electron/services/modpacks/state/modpack-state-repository.cjs`
- Create: `electron/services/modpack-lifecycle/outcome-action-service.cjs`
- Test: `tests/modpacks/modpack-lifecycle-management.test.cjs`
- Test: `tests/modpacks/modpack-outcome-actions.test.cjs`

**Interfaces:**

```js
verify(instanceId) // read-only job/result; no restore point
listHistory(instanceId, { cursor, limit })
performSafeAction({ actionId, opaqueRef })
```

**Consumes:** Tasks 2, 17, 19, 23-24 cache/state/restore/lifecycle contracts.

**Produces:** `verify`, `import-files-only-new`, `detach`, and `uninstall-managed`; paged redacted history; and safe outcome action DTOs. Allowed action IDs are `retry`, `change-selection`, `open-details`, `open-retained-download-folder`, `remove-retained-download`, `choose-another-asset`, `return-to-server`, `review-restore-point`, `restart-and-recover`, `review-recovery`, and `restore-from-restore-point`.

**Required RED assertion:**

```js
test('detach removes no server file', async () => {
  const before = await snapshotTree(serverPath);
  await runAndWait(service, detachRequest);
  assert.deepEqual(await snapshotTree(serverPath), before);
});
```

- [ ] Verify hashes managed/runtime files against manifest while checking revision/stat preconditions and offers repair only for mismatch. Files-only import is permitted only for safely classified content, creates a new unmanaged instance, runs no supplied bootstrap/runtime, and records provenance without active ownership.
- [ ] Detach disables management/tracking and removes zero files. Uninstall plans exact unchanged managed-file count, preserves worlds/user/modified/protected paths, removes active state only after commit, never deletes instance/world, and marks a non-runnable outcome as unmanaged files-only.
- [ ] Outcome actions resolve opaque cache/restore/recovery references internally. Cache removal checks reference counts; folder opening targets only the controlled cache parent via Task 26 IPC; no renderer path is accepted.
- [ ] RED: run `node --test tests/modpacks/modpack-lifecycle-management.test.cjs tests/modpacks/modpack-outcome-actions.test.cjs`; require intended behavior failure. GREEN: rerun it and `npm test`.
- [ ] Commit: `feat(modpacks): complete management and outcome actions`

### Task 26: Expose schema-validated IPC, release monitoring, and persistent notifications

**Files:**

- Create: `electron/ipc/modpack-handlers.cjs`
- Create: `electron/services/modpacks/notifications/notification-store.cjs`
- Create: `electron/services/modpacks/notifications/release-tracking-store.cjs`
- Create: `electron/services/modpacks/notifications/release-monitor.cjs`
- Modify: `electron/ipc-handlers.cjs`
- Modify: `electron/preload.cjs`
- Modify: `electron/main.cjs`
- Modify: `src/electron.d.ts`
- Modify: `electron/services/server-mutation-policy.cjs`
- Modify: `docs/security/server-writer-inventory.md`
- Test: `tests/modpacks/modpack-ipc.test.cjs`
- Test: `tests/modpacks/modpack-preload-contract.test.cjs`
- Test: `tests/modpacks/notification-store.test.cjs`
- Test: `tests/modpacks/release-monitor.test.cjs`
- Modify test: `tests/server-writer-inventory.test.cjs`

**Invoke channels:**

```text
modpacks:search-catalog
modpacks:get-project
modpacks:list-versions
modpacks:list-github-releases
modpacks:list-github-assets
modpacks:select-local-archive
modpacks:inspect
modpacks:preflight
modpacks:start-operation
modpacks:cancel-job
modpacks:get-job
modpacks:get-state
modpacks:list-history
modpacks:list-recovery
modpacks:recover
modpacks:list-notifications
modpacks:ack-notification
modpacks:check-updates
modpacks:update-tracking
modpacks:verify
modpacks:perform-safe-action
```

**Event channels:**

```text
modpacks:job-progress
modpacks:job-log
modpacks:state-changed
modpacks:notification
```

**Consumes:** Tasks 1 and 23-25 final service DTOs/safe actions plus Task 15 composition root.

**Produces:** complete strict Ajv schemas and typed renderer declarations for every listed invoke/result/event; handler factories injected from the service graph; persisted tracked-source state; symmetric preload allowlists. `modpacks:preflight` returns `{ planId, planFingerprint, planView, expiresAt }`, and its schema forbids paths, URLs, cache/workspace IDs, and provider-internal fields inside `planView`; `modpacks:start-operation` requires both opaque ID and fingerprint.

**Required RED assertion:**

```js
test('renderer paths are rejected before any safe action runs', async () => {
  const result = await handlers['modpacks:perform-safe-action'](event, { actionId: 'remove-retained-download', path: 'C:\\x' });
  assert.equal(result.error.code, 'INVALID_REQUEST');
});
```

- [ ] RED-test each invoke through the handler factory with valid/invalid final schema, stable public error results, unknown instance/selection/plan/job, renderer path/URL/command rejection, archive-runtime unavailable state, handler registration, and all four duplicated preload allowlists (`invoke`, `on`, `removeListener`, `removeAllListeners`).
- [ ] Notification records persist ID/type/server/source/release/timestamp/read/action payload and never install directly. RED-test acknowledge idempotence, history across restart, update/prerelease/asset-selection/source-changed/integrity/rate-limit/operation/recovery types, safe action routing, and native/toast summaries not replacing persistence.
- [ ] `release-tracking-store.cjs` persists provider/permanent repository or project ID, stable/prerelease policy, exact accepted upstream mapping/asset pattern, ETag, last successful check, last failure/backoff, next due, and last release/asset snapshot. Release monitor checks at startup only when due, then every 12 hours with stable per-source ±10% jitter, ETag/304/pagination, rate limits, retry-after, capped exponential backoff, source mutation, restart, and clock rollback. Use Modrinth/GitHub trackers; do not reuse the individual-mod watcher.
- [ ] Register handlers only after startup recovery/runtime verification creates the injected service graph. Main owns native file dialogs, controlled `shell.showItemInFolder`, and Windows notifications. Preload exposes only generic allowlisted invoke/listener methods, with symmetric removal. Extend the writer policy/inventory: lifecycle mutations are marked `service-acquires-lease`; read/check/notification channels are formally non-mutating.
- [ ] RED: run `node --test tests/modpacks/modpack-ipc.test.cjs tests/modpacks/modpack-preload-contract.test.cjs tests/modpacks/notification-store.test.cjs tests/modpacks/release-monitor.test.cjs tests/server-writer-inventory.test.cjs`; require intended schema/persistence/policy failures. GREEN: rerun it, `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)`, and `npm test`.
- [ ] Commit: `feat(modpacks): expose lifecycle IPC and notifications`

### Task 27: Build renderer clients, stores, and the modpack setup flow

**Files:**

- Create: `src/utils/modpacks/modpackApi.js`
- Create: `src/stores/modpackCatalogStore.js`
- Create: `src/stores/modpackLifecycleStore.js`
- Create: `src/components/setup/ServerSetupWizard.svelte`
- Create: `src/components/setup/ModpackSourceChoice.svelte`
- Create: `src/components/setup/ModrinthPackBrowser.svelte`
- Create: `src/components/setup/GitHubReleasePicker.svelte`
- Create: `src/components/setup/GitHubAssetReview.svelte`
- Create: `src/components/setup/ArchiveGuidedReview.svelte`
- Modify: `src/components/setup/SetupWizard.svelte`
- Modify: `src/App.svelte`
- Test: `tests/modpacks/modpack-setup-renderer-contract.test.cjs`

**Consumes:** Task 26 typed IPC; existing manual setup wizard remains the Empty/Custom child.

**Produces:** request clients with symmetric listener cleanup, catalog/lifecycle stores preserving view state, and setup choice `Empty/Custom Server` versus `Install Modpack` followed by Modrinth/GitHub/local source flows.

**Required RED assertion:**

```js
test('setup submits plan ID and fingerprint, never a server/archive path', () => {
  assert.match(setupSource, /planId/);
  assert.doesNotMatch(setupSource, /archivePath\s*:/);
});
```

- [ ] Modrinth preserves query/category/Minecraft/loader/channel/server compatibility/sort/paging across loading, empty, offline, and 429; project detail shows description, runtimes, gallery, exact history. Failure actions are the applicable exact combination of Retry, Import local archive, and Empty/Custom Server.
- [ ] GitHub preserves explicit URL, defaults stable, toggles prerelease, accepts a normalized Modrinth-linked repository only after explicit user approval, displays all uploaded asset/groups with provisional role/size/timestamps/digest, supports the exact opt-in **Use this asset pattern for future releases**, disables known gaps/ambiguity, and explains `NO_INSTALLABLE_ASSET` with local/empty actions. Local source invokes native opaque selection only.
- [ ] Guided review shows integrity/tree/root alternatives/classification evidence/runtime/Java/counts/sizes/ownership/conflicts/writes/removals/preservation/EULA/missing digest/world downgrade/start-after-install. It allows safe unmanaged files-only import, blocks all unresolved ambiguity, and starts only with `{ planId, planFingerprint, choices }`.
- [ ] RED: run `node --test tests/modpacks/modpack-setup-renderer-contract.test.cjs`; require intended missing-flow failure. GREEN: rerun it, `npm run build`, and `npm test`.
- [ ] Commit: `feat(ui): add modpack setup flow`

### Task 28: Build the top-level Modpack management page and job outcomes

**Files:**

- Create: `src/components/modpacks/ModpackJobProgress.svelte`
- Create: `src/components/modpacks/ModpackRecoveryPanel.svelte`
- Create: `src/components/modpacks/ModpackOverview.svelte`
- Create: `src/components/modpacks/ModpackVersionPanel.svelte`
- Create: `src/components/modpacks/ModpackActionPanel.svelte`
- Create: `src/components/modpacks/ModpackPlanReview.svelte`
- Create: `src/routes/ModpackPage.svelte`
- Modify: `src/App.svelte`
- Modify: `src/routes/SettingsPage.svelte`
- Modify: `src/components/settings/VersionUpdater.svelte`
- Test: `tests/modpacks/modpack-management-renderer-contract.test.cjs`

**Consumes:** Tasks 25-27 management/history/outcome IPC and renderer stores.

**Produces:** top-level Modpack tab beside Mods for every server; unmanaged install/import/files-only; managed update/exact version/switch/verify then repair/restore-point rollback/detach/uninstall; paged history; and durable job/recovery result routing. Managed Settings routes version work to Modpack.

**Required RED assertion:**

```js
test('verify is available without immediately scheduling repair', () => {
  assert.match(actionPanelSource, /Verify/);
  assert.doesNotMatch(actionPanelSource, /on:click=.*repair.*Verify/);
});
```

- [ ] Progress renders Resolving, Downloading, Verifying, Inspecting, Planning, Creating restore point, Extracting, Reconciling files, Configuring runtime and Java, Validating candidate on loopback, Committing directory swap, Starting from final path, Validating final health, Cleaning rollback staging, Completed, and Rolling back. Cancellation exists only before commit and job reload uses durable ID.
- [ ] Outcome cards render the exact states/actions: **Nothing changed** with Retry/Change selection/Open details; **Downloaded file retained for manual use** with Open folder/Remove download/Choose another asset; **Update failed; server restored successfully** with Return to server/Review restore point; **Automatic recovery required on next launch** with Restart and recover/Open details; **Manual recovery required** with Review recovery/Restore from restore point/Open diagnostic details. They never accept a path. Managed files/user additions are distinguished and history is readable.
- [ ] Detach/uninstall review renders side-by-side behavior headed **Detach and keep all files** and **Remove managed pack files**. Detach says management/notifications stop and zero files are removed. Uninstall shows the exact unchanged-managed count, preserves worlds/user/modified files, warns it may leave a non-runnable files-only instance, and states that neither the instance nor its world is deleted.
- [ ] RED: run `node --test tests/modpacks/modpack-management-renderer-contract.test.cjs`; require intended route/action failure. GREEN: rerun it, `npm run build`, and `npm test`.
- [ ] Commit: `feat(ui): add modpack management page`

### Task 29: Integrate persistent notifications and accessibility behavior

**Files:**

- Create: `src/stores/modpackNotificationStore.js`
- Create: `src/components/modpacks/ModpackNotificationCenter.svelte`
- Modify: `src/App.svelte`
- Modify: `src/components/common/ConfirmationDialog.svelte`
- Modify: `src/components/mods/components/ModSearch.svelte`
- Modify: `src/components/setup/ModpackSourceChoice.svelte`
- Modify: `src/components/setup/ServerSetupWizard.svelte`
- Modify: `src/components/setup/ModpackSourceChoice.svelte`
- Modify: `src/components/setup/ModrinthPackBrowser.svelte`
- Modify: `src/components/setup/GitHubReleasePicker.svelte`
- Modify: `src/components/setup/GitHubAssetReview.svelte`
- Modify: `src/components/setup/ArchiveGuidedReview.svelte`
- Modify: `src/components/modpacks/ModpackJobProgress.svelte`
- Modify: `src/components/modpacks/ModpackRecoveryPanel.svelte`
- Modify: `src/components/modpacks/ModpackOverview.svelte`
- Modify: `src/components/modpacks/ModpackVersionPanel.svelte`
- Modify: `src/components/modpacks/ModpackActionPanel.svelte`
- Modify: `src/components/modpacks/ModpackPlanReview.svelte`
- Modify: `src/routes/ModpackPage.svelte`
- Test: `tests/modpacks/modpack-accessibility-contract.test.cjs`
- Test: `tests/modpacks/curseforge-copy.test.cjs`

**Consumes:** Tasks 26-28 notification IPC and all renderer flows.

**Produces:** persistent notification center/actions, safe summaries, focus/keyboard/live-region behavior, and final CurseForge unavailable wording.

**Required RED assertion:**

```js
test('destructive modpack confirmation defaults focus to Cancel', () => {
  assert.match(confirmationSource, /initialFocus=['"]cancel['"]/);
});
```

- [ ] Mount notifications globally and remove all listeners on destroy. Actions open exact server/review/history and never install. Toast/native messages summarize persisted records only.
- [ ] ConfirmationDialog traps/restores focus, supports Escape/configurable initial focus, and defaults Cancel for detach/uninstall. Wizard headings receive focus, steps use `aria-current="step"`, rows/cards are keyboard controls, progressbar values and throttled polite stage announcements are separate, raw logs are not live, errors/results receive focus, diffs remain labeled when paged, and every state has non-color text.
- [ ] Replace both provider controls with exact `CurseForge (Unavailable)` and adjacent `CurseForge browsing is unavailable in this build.`; remove all roadmap/date/Coming Soon copy.
- [ ] RED: run `node --test tests/modpacks/modpack-accessibility-contract.test.cjs tests/modpacks/curseforge-copy.test.cjs`; require intended contract failure. GREEN: rerun it, `npm run build`, and `npm test`.
- [ ] Commit: `feat(ui): finish modpack notifications and accessibility`

### Task 30: Build deterministic integration fixtures and the durability failure matrix

**Files:**

- Create: `tests/modpacks/fixtures/lifecycle-harness.cjs`
- Create: `tests/modpacks/lifecycle-failure-matrix.test.cjs`
- Create: `tests/modpacks/full-provider-lifecycle.test.cjs`
- Modify: `package.json`

**Consumes:** Task 15 dependency injection and the complete Task 1-29 service/UI contracts.

**Produces:** deterministic fake Modrinth/GitHub HTTPS services, injected DNS/clock, generated safe ZIP/MRPACK, reviewed vendored RAR fixtures, fake official loaders/Java/status child, isolated userData, byte-level tree snapshots, crash/fault controls, package scripts `"test:modpacks": "node --test tests/modpacks"` and `"test:failure-matrix": "node --test tests/modpacks/lifecycle-failure-matrix.test.cjs"`. No test contacts a public service.

**Required RED assertion:**

```js
test('every durable boundary is represented in the fault matrix', () => {
  assert.deepEqual(missingRequiredFaultPoints(matrix), []);
});
```

- [ ] Table-drive every registry/download/restore/candidate/journal/health/rename/directory-flush/commit/cleanup/rollback/reconstruction/registration boundary. Assert byte identity, exactly one proven canonical server, phase/swapStep, correct block, retained cache/restore, and idempotent repeated recovery.
- [ ] Full provider integration covers exact Modrinth and GitHub/local artifact flows through inspection/planning/lifecycle using only injected services, including multipart mutation and missing digest.
- [ ] RED: run `node --test tests/modpacks/lifecycle-failure-matrix.test.cjs tests/modpacks/full-provider-lifecycle.test.cjs`; require intended missing-fault/flow failure. GREEN: rerun it, `npm run test:modpacks`, `npm run test:failure-matrix`, and `npm test`.
- [ ] Commit: `test(modpacks): add deterministic failure matrix`

### Task 31: Exercise setup, lifecycle, recovery, and accessibility in Electron

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `playwright.config.mjs`
- Create: `tests/e2e/fixtures/modpack-harness.cjs`
- Create: `tests/e2e/modpack-setup.spec.js`
- Create: `tests/e2e/modpack-lifecycle.spec.js`
- Create: `tests/e2e/modpack-recovery-accessibility.spec.js`

**Consumes:** Task 15 test-mode Electron composition, Task 30 deterministic services/fixtures, and all renderer flows.

**Produces:** exact `@playwright/test@1.62.1`, one-worker isolated Electron E2E suite, and package script `"test:e2e:modpacks": "playwright test tests/e2e/modpack-setup.spec.js tests/e2e/modpack-lifecycle.spec.js tests/e2e/modpack-recovery-accessibility.spec.js --workers=1"`.

**Required RED assertion:**

```js
test('detach confirmation keeps Cancel focused', async ({ page }) => {
  await page.getByRole('button', { name: 'Detach management' }).click();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
});
```

- [ ] Setup covers manual unchanged; Modrinth; GitHub MRPACK/ZIP/RAR/multipart; local; accepted linked repository; asset pattern; no uploaded server asset; missing digest; ambiguity; changed set; client-only; encrypted; files-only; cancellation; and registered selection.
- [ ] Lifecycle covers install existing, upgrade, safe/blocked downgrade, switch, verify then repair, config/user-mod preservation, restore rollback, detach, uninstall, files-only outcome, history/outcome actions, notifications, and prior running/stopped state.
- [ ] Recovery kills Electron pre/between/post rename, relaunches, and proves startup blocking/recovery. Accessibility uses keyboard-only paths, focus trap/restore/default Cancel, stage/error/result focus, progress announcements, visible disabled explanations, non-color labels, and exact CurseForge copy.
- [ ] RED: install dependency, run `npm run build` then `npm run test:e2e:modpacks`, and record the intended missing-flow failure before UI fixtures are complete. GREEN: rerun `npm run build`, `npm run test:e2e:modpacks`, and `npm test`; all pass with one Playwright worker.
- [ ] Commit: `test(modpacks): cover Electron lifecycle flows`

### Task 32: Package and verify the broker, extractor, manifests, and notices

**Files:**

- Modify: `package.json`
- Modify: `scripts/afterPack.cjs`
- Create: `scripts/verify-packaged-archive.cjs`
- Create: `tests/modpacks/archive-worker-packaged.test.cjs`

**Packaging map:**

```text
vendor/7zip/x64                 -> resources/archive/7zip
vendor/archive-worker/x64       -> resources/archive/worker
third-party/7zip                -> resources/archive/licenses
build-resources/archive-runtime -> resources/archive/manifests
```

**Consumes:** Tasks 7-9 exact runtime/broker/manifests/licenses and Task 26 packaged runtime readiness.

**Produces:** architecture-filtered `extraResources`, fail-closed prepack/afterPack verification, and a real `win-unpacked` resource contract.

**Required RED assertion:**

```js
test('packaged resolution cannot fall back to vendor or PATH', () => {
  assert.throws(() => getBundledArchiveRuntime({ resourcesPath: emptyRoot, arch: 'x64', isPackaged: true }),
    error => error.code === 'EXTRACTOR_UNAVAILABLE');
});
```

- [ ] Add Electron Builder `extraResources` entries with architecture filters and a prepack build/verifier that throws for unsupported architecture, missing/mismatched worker/runtime/license, wrong version/handler, or a failing containment self-test. `afterPack.cjs` must propagate archive-security verification failures instead of logging and continuing.
- [ ] RED-test temporary and real resources roots. The packaged app resolves only `process.resourcesPath/archive`; invoke the resolver with a sanitized PATH and absent resources and require failure even though repository vendor files exist.
- [ ] `verify-packaged-archive.cjs` verifies worker/runtime hash/size/architecture, 7-Zip version/ZIP/RAR handlers, every license/manifest, and ArchiveWorker containment self-test. `afterPack.cjs` propagates security failure.
- [ ] RED: run `node --test tests/modpacks/archive-worker-packaged.test.cjs` before `extraResources` and require the expected missing-resource assertion. GREEN: run `powershell -ExecutionPolicy Bypass -File scripts/build-archive-worker.ps1`, `npm run verify:archive-runtime`, `npm run build`, `npm run pack`, `node --test tests/modpacks/archive-worker-packaged.test.cjs`, and `node scripts/verify-packaged-archive.cjs`; all pass.
- [ ] Commit: `build: package verified archive runtime`

### Task 33: Prove installed modpack flows and make them release gates

**Files:**

- Create: `scripts/run-modpack-packaged-smoke.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `package.json`

**Consumes:** Task 32 verified unpacked app and Task 30-31 deterministic fixtures/E2E.

**Produces:** installed/unpacked modpack smoke, mandatory Windows x64 CI gates, and final installer build.

**Required RED assertion:**

```js
assert.equal(smokeEvidence.archiveWorker.containment, 'passed');
assert.equal(smokeEvidence.fallbacksUsed.length, 0);
```

- [ ] Launch the packaged app with isolated userData and sanitized PATH. Import MRPACK, ZIP/ZIP64, RAR4/RAR5, every multipart scheme; reject encrypted/incomplete/unsafe archives; create/update/verify/repair/detach a server; crash/relaunch between renames; verify exact state and no development/system fallback.
- [ ] Windows release CI pins .NET SDK 10.0.204, verifies/acquires committed-hash 7-Zip inputs, builds worker, runs unit/modpack/failure/E2E, packs, runs packaged verifier/smoke, then builds installer. Supported Windows x64 archive/package gates cannot skip or allow failure.
- [ ] RED: run `node scripts/run-modpack-packaged-smoke.mjs` before its harness is complete and record the intended missing-evidence failure. GREEN: run `npm test`, `npm run test:modpacks`, `npm run test:failure-matrix`, `npm run build`, `npm run pack`, `node scripts/verify-packaged-archive.cjs`, `node scripts/run-modpack-packaged-smoke.mjs`, `npm run test:e2e:modpacks`, and `npm run dist`; all pass.
- [ ] Record exact commands, pass/fail counts, resource hashes, containment evidence, each imported archive family, and recovery result in the controller-supplied `task-33-report.md`. Commit source, reviewed fixtures, vendored runtime/worker, manifests, licenses, tests, and build metadata; never commit `dist/`.
- [ ] Commit: `build: gate release on packaged modpack smoke`

## Final Verification

- [ ] Run `rg -n -i "todo|tbd|not implemented" electron src tests scripts` and `rg -n -i "coming soon" electron src`; resolve every feature-related hit. Exact negative assertions inside tests may remain only when they prove forbidden copy is absent.
- [ ] Run `node --test (Get-ChildItem -File tests/modpacks -Filter '*.test.cjs' | Select-Object -ExpandProperty FullName)` and `node --test tests/loader-install-service.test.cjs tests/server-launcher.test.cjs tests/neoforge-runtime.test.cjs tests/quilt-runtime.test.cjs tests/durable-fs.test.cjs tests/config-manager.content-revision.test.cjs tests/server-mutation-coordinator.test.cjs tests/server-start-gate.test.cjs tests/server-core-writer-coordination.test.cjs tests/server-content-writer-coordination.test.cjs tests/server-writer-inventory.test.cjs tests/main-bootstrap.test.cjs`.
- [ ] Run `npm test`; record total/pass/fail counts and require zero warnings emitted by new tests.
- [ ] Run `npm run build`, `npm run pack`, `node scripts/verify-packaged-archive.cjs`, `node scripts/run-modpack-packaged-smoke.mjs`, `npm run test:e2e:modpacks`, and `npm run dist`; every command exits 0.
- [ ] Confirm `git status --short`, inspect `git diff --check`, and verify no cache, partial, userData, recovery scratch, SDK output, secrets, query-bearing URL, or packaged `dist/` artifact is tracked.
- [ ] Run a whole-branch review against the merge base, fix all Critical/Important findings, re-run affected tests, then use `superpowers:finishing-a-development-branch`.
