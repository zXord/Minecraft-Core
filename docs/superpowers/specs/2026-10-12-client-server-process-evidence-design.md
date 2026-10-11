# Exact server-process evidence for client admission

## Intent

The user wants normal GitHub modpack installation, matching clients, and release testing without touching existing personal instances. The final review found that an indirect already-running Java client could be misclassified as stopped. Fix that gap without preventing a matching client from launching alongside this app's Forge/NeoForge server.

This changes an internal ownership interface and is treated as architectural despite its limited file scope. Root self-reviews and authorizes implementation under the user's explicit instruction to review plans and implement without asking again. This does not authorize authentication, security settings, real-profile access, release publication, or process termination.

## Selected approach and alternatives

Use a private, current-main-process registry in the existing server process runner. Each entry binds the exact child, a fresh spawn nonce, its initial OS process identity, and canonical server directory identity. The client process guard consumes a boolean proof that the currently observed process is that unrelated server. No durable state, renderer authority, restart adoption, or argument-file expansion.

Rejected alternatives: refusing all Java argument-file launches breaks normal Forge server plus client use; reading mutable argument files does not prove the arguments of an already-running JVM; PID-only or `nogui`/filename heuristics do not prove ownership. A server-manager-only registry misses lifecycle health children.

## Contracts

- Unresolved Java argument-file and Prism/MultiMC wrapper launches are uncertain, including indirect commands with an otherwise unrelated visible root. A same-root or conflicting visible `--gameDir` cannot be exempted. Existing own-client markers/owner/child checks retain priority.
- Direct, unambiguous canonical unrelated roots and ordinary unrelated direct Java commands remain nonblocking. Unknown indirect activity refuses mutation/launch with existing errors and actionable close-and-retry guidance. No exhaustive arbitrary-launcher claim.
- The runner owns the registry privately. No public registration or caller-provided PID/path exemption. Only children it spawned through the existing trusted dedicated-server launch boundary qualify.
- Copy the minimal spawn authority before spawn; preserve operation-ID marker and add a separate random per-spawn UUID marker. Capture initial complete OS identity through the existing bounded inspector, after handlers are installed, without making synchronous launch asynchronous.
- Initial evidence requires the exact live retained child, matching main parent PID, executable, single issued nonce, complete creation identity, and full command-line hash. Missing/pending/failed capture grants no exemption, does not kill a healthy server, and does not change existing supervision success.
- Every proof compares a current guard snapshot to the frozen initial identity. Require successful supervision and current liveness. Exit/close/error/fatal/stop invalidates; old callbacks cannot remove a newer incarnation at the same PID. A new main/runner starts with no evidence.
- Canonical requested server root and actual cwd must be identical and retain their directory object identity. Root and target must be disjoint, using path-segment ancestry, not string-prefix tests. Changed, aliased, unreadable, overlapping or ambiguous roots do not qualify. No full-tree walk.
- Do not read or persist argument-file contents or raw command lines. The initial full command hash remains private memory only. Exact OS identity/cwd proves this app's trusted server launch, not a sandbox against malicious server code or tampered launch inputs.
- Use optional injected inspection/root-capture/UUID seams. The production shared runner opts into actual evidence; factory-created inert runners do not silently launch system inspectors. Imports do not inspect processes or access profiles.
- Snapshot failure may require ordinary server stop/start before a matching client can be admitted. No forced-exempt control or unbounded retries.

## Ownership and tests

Three product files: `electron/services/server-process-runner.cjs`, `electron/services/client-modpacks/client-process-guard.cjs`, `electron/bootstrap/create-client-pack-composition.cjs`.

Three test files: `tests/server-process-evidence.test.cjs` (new), `tests/client-modpacks/client-process-guard.test.cjs`, `tests/client-modpacks/production-client-pack-composition.test.cjs`.

Tests use inert children/streams, injected snapshots and temporary roots only. Prove indirect refusal, real injected runner plus guard admission for unrelated Forge/NeoForge, PID reuse/identity changes, pending/failed capture, lifecycle invalidation, root overlap/drift, and real composition wiring. No live Java/CIM/auth/native workers during focused tests. Root owns full gates and normal-app acceptance later.

## Self-review and boundaries

Reviewed requirements, alternatives, ownership, stale evidence, availability and privacy. The existing trusted server-launch boundary is accepted; hostile server-code containment is not claimed. Capture failure remains fail-closed for client actions but does not interrupt the server. The original nine-file transaction/policy fix stays intact. No unresolved design placeholders; exact interfaces and finite execution are in the companion plan. Review of the resulting patch is scoped to this residual and newly introduced breakage, not another broad audit.
