# Matching client modpacks

## Intent and authorization

The user approved matching client-pack support on 2026-10-08 after native testing proved that a GitHub ServerPack creates a working server but cannot prepare its client. Success means a person can choose the matching client pack in Minecraft Core, connect a client instance, install all required client content and exact runtime, and launch/join without manually copying files. Existing instances must remain safe. The user explicitly delegates design/plan review and implementation; no further plan-approval pause is required.

Native acceptance uses only disposable profiles and server/client folders. The original `minecraft-core-native-qa-20261008-a1` interrupted operation is preserved; active acceptance now uses the separate `minecraft-core-native-qa-20261008-control-b1` profile and explicitly named b1 QA folders recorded in the native evidence ledger. Never use the user's existing Server or Client folders. The exact acceptance pack is TerraFirmaGreg-Team/Modpack-Modern 0.13.4, ServerPack plus the official same-release MRPACK client asset.

## Approach

Use the existing verified provider/download/archive pipeline and a separate client projection/installer. Do not pretend the server's mods directory is a complete client pack. Do not run arbitrary launch scripts from archives. Do not use server lifecycle publication/health checks for client installations.

Alternatives considered: copying server mods misses client-only content/configs; treating arbitrary ZIPs as clients requires guessing runtime and ownership. The selected first implementation supports MRPACK v1 companions (from Modrinth or an explicitly selected uploaded GitHub release asset). Server ZIP/RAR support remains unchanged. MultiMC/CurseForge client formats are explicitly unsupported, not silently approximated.

## Companion identity

Server Modpack overview offers a Matching client pack panel. For GitHub it lists MRPACK assets from the installed immutable repository/release IDs. A person selects and inspects one; the runtime must equal the installed server's Minecraft/loader tuple. For Modrinth the exact installed version's MRPACK is the companion, still inspected before confirmation. Local imports cannot advertise a remotely downloadable companion in this increment.

Pairings live in app-data, not the strict server state/config schema. Key each by registered server ID plus a canonical SHA256 fingerprint of installed provider identity, artifact set digest, runtime and selected optional files. Exclude title, timestamps, contentRevision, manifest ID and paths so restoring the same pack reuses its pairing; upgrading to another release requires its own pairing. Preserve historical records. Corrupt/missing pairing data must not stop a healthy server from booting; it makes matching client installation unavailable with an actionable message. Publishing a pairing takes the server mutation reservation, checks fingerprint again, and does not increment content revision.

The authenticated management info response adds `clientModpack`: null for unmanaged servers; otherwise a strict descriptor with status `unpaired` or `ready`, server fingerprint, server version label, exact companion source IDs/digest and exact runtime. It contains no local paths, tokens, URLs chosen by the renderer, or executable instructions. Clients fetch this themselves in main using their saved management origin, session token and TLS pin. No redirect may receive credentials. Provider downloads are resolved again from immutable official IDs and must match the advertised digest. Managed servers without a pairing never fall back to an empty loose-mod synchronization and claim the client is ready.

## Client projection and preview

Honor `env.client`: required selected, unsupported excluded, optional shown as explicit default-selected choices. Apply downloaded files, then `overrides`, then `client-overrides`; never apply `server-overrides`. Reuse MRPACK path/collision/hash/size/host rules. Add client-specific protected paths: app state/config/auth/credentials, saves, screenshots, logs, crash reports, runtime roots and executable scripts/binaries cannot be supplied by the pack. `options.txt`, `optionsof.txt` and `servers.dat` may seed a fresh client but are preserved after that. Mods, configs, defaultconfigs, kubejs, scripts/resources and other ordinary pack data retain their relative paths; do not hard-code TFG filenames.

Preview shows exact release, asset, Minecraft/loader, download bytes, optional files, destination, additions/removals and conflicts. Inspect/download progress shows measured bytes/counts or an honest indeterminate phase, not simulated progress. Users can cancel before publication. Missing/malformed runtime or unsupported format explains the reason without touching client files.

## Ownership, publication and recovery

A client pack manifest is separate from connection/auth config and records source fingerprint, companion digest, exact runtime, chosen optional IDs, and each owned file's installed SHA256/size. A new installation never replaces an unrelated client directory wholesale. Existing unowned paths and user additions are preserved. Unchanged previously owned files can be replaced/removed on update; modified owned files that would be replaced/removed are conflicts with explicit preserve/replace decisions. Preserving a modified config is allowed and recorded; a preserved divergent managed JAR is not called a verified matching client. Saves/auth/options are never conflict-replacement candidates.

Build the candidate in an owned workspace before writing the live client. Under an exclusive client mutation reservation and stopped-client proof, prepare an adjacent same-volume candidate that includes preserved user files, verify the reviewed baseline still matches, then durably journal directory publication. Record intent before either rename; live -> previous, candidate -> live, then commit the manifest and completion marker. Recovery identifies exact directories by native identities and journal phase, never pathname alone; ambiguous state blocks mutation/launch and exposes Retry recovery. Keep the previous directory until publication is proven committed. Cleanup cannot race a still-running extractor/downloader/runtime worker. Cancellation is not reported complete until writers are quiescent. Normal app close cancels preparation and waits within existing orderly-quit constraints; incomplete publication remains recoverable.

## Running-client and legacy-writer interlock

Pack changes and launch preparation share a client-path authority. A managed client launch writes a durable intent before spawn, adds a unique main-issued JVM launch marker, and records the exact child PID/creation identity. Hold the in-process lease through the exact child's `close`, not only through the launch IPC return. On restart, use a bounded process inspection to prove the previous owner/marked client absent; a surviving process or incomplete inspection blocks mutations. Never kill guessed PIDs or unrelated Java processes. A crash between intent and PID persistence must remain safe via the unique marker and prior owner identity.

Main process guards all legacy client content writers/reconcilers for managed pack paths. The UI branch alone is insufficient: forged renderer mod lists cannot remove pack JARs. Connection/auth/preferences remain usable; user additions should be handled deliberately rather than silently replacing owned files. Managed client runtime verification is read-only and never invokes the legacy version-change cleanup. Launch uses main-read persisted runtime and current authenticated server fingerprint, not renderer choices, and does not resolve latest or fall back to vanilla. A mismatch routes to the matching-pack update action.

## User flow

1. Server: Modpack overview -> Matching client pack -> choose exact same-release MRPACK -> inspect -> confirm pairing.
2. Client: normal folder/invite setup -> successful management connection -> Matching modpack card -> preview/install -> ready.
3. Play: authenticate normally with Microsoft, then launch exact managed runtime. Credentials are never copied from the user's real profile during testing.
4. Server changes: client reports update/downgrade required and offers reviewed synchronization. Returning to a historically paired server release reuses its exact descriptor.
5. Existing unmanaged clients keep the current workflow. Unsupported/missing companion and recovery states have explicit actionable copy; no coming-soon promises.

## Verification and limits

Unit/integration tests cover client-vs-server environments, override precedence, protection/collisions, stale release/digest, ownership conflicts, crash boundaries, cancellation quiescence, process/PID reuse uncertainty, forged legacy requests, strict runtime launch and scoped UI async responses. Rendered tests use actual components. Native acceptance must use visible UI and real provider files, with separate evidence from fixtures.

Acceptance includes TFG 0.13.4 install, stop/restart, 0.13.5 upgrade and 0.13.4 downgrade/rollback; client MRPACK installation and preserved settings; real game launch/join if the user completes Microsoft authentication. Do not synthesize offline credentials and call that a normal-user join. Clearly report any remaining external authentication/OS permission gate.

Reference: [official MRPACK format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack), inspected 2026-10-08. Its client environment and override layering inform the projection; application ownership/recovery rules are Minecraft Core's policy.

## Self-review

### Native-test addendum: managed server mod edits

The normal UI test exposed two independent defects: the production companion adapter consumed a repository envelope as a flat state, and ordinary JAR edits left the original companion advertised. Correct the adapter without changing persisted contracts. Active managed servers must reject loose JAR writers in main, under the existing mutation reservation, and mirror that restriction in Mods. Settings, worlds, auth, metadata and ignored-update preferences remain usable. Detach is an explicit reviewed choice that keeps files and enables individual mod management. This intentionally also restricts editing user-added JARs while managed; it does not take ownership of or delete those files.

Companion availability must separately establish that expected replaceable pack-owned mod JARs are intact. Config rewrites and preserved user files are not part of that JAR check. Canonical pairing fingerprints remain unchanged so repair/rollback can reuse the exact source pairing. Missing, disabled, unsafe or changed expected JARs produce an actionable unavailable error, never an unmanaged null fallback or a ready claim. Status checks may reuse hashes only after revalidating root, manifest and each file's identity including change time; new or changed files are hashed asynchronously with stable pre/open/post evidence. Cache entries are bounded, process-local and discarded on failure/state change; watchers alone are not proof. Pair acceptance requires a fresh hash check under its existing reservation. This is not a claim of adversarial continuous integrity, automatic custom client-pack creation or compatibility of extra user JARs.

Do not add another full-tree check or a new server-start prerequisite. Existing runtime and lifecycle health checks retain their authority; this addendum changes companion readiness and loose mod edits, not ordinary server startup. A server with external JAR drift cannot advertise a matching client; the owner can use Verify/Repair or explicit Detach. Native tests must exercise real UI refusal/restoration and companion behavior separately from controlled tests.

Large Verify results retain exact total counts and health/Repair availability, but expose a byte/count-bounded display list with clear shown-versus-total guidance. Generic job size/redaction limits and internal verification results stay unchanged. Normal config rewrites are reported as differences, not hidden or treated as proof of failed installation.

The companion registry does not alter server journal schemas. Main-owned identity is authoritative across UI, management API and launch. Client candidate publication and live-process proof are inseparable release requirements, not optional hardening. Format scope is explicitly MRPACK v1; no promise of arbitrary client ZIP compatibility. All original server feature verification remains outstanding until recorded with fresh evidence.
