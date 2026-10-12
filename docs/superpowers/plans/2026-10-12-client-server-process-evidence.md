# Client/server process evidence implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this single task. Root owns review, staging, commits and broad gates; no worker subagents.

**Goal:** Close the final indirect-Java client-admission gap while permitting an exact unrelated app-owned Forge/NeoForge server.

**Architecture:** Extend the current runner with private ephemeral launch evidence and inject its read-only provider into the current client guard. Keep existing process supervision, client journals, snapshot bounds and renderer APIs unchanged.

**Tech Stack:** CommonJS, Node node:test, injected inert child processes, existing bounded Windows inspector.

**Spec:** `docs/superpowers/specs/2026-10-12-client-server-process-evidence-design.md`.

## Global Constraints

- No real profiles/instances, native app/process inspection, network/authentication, dependencies, builds, broad suites, Git mutation, or subagents in worker execution.
- No durable state, renderer authority, restart adoption, or argument-file expansion.
- Preserve the original nine-file transaction/policy fix and frozen rollout files; exactly seven source/test paths below are owned after root's explicit argv-test addition.
- Pending/failed/incomplete evidence grants no exemption; it must not kill a healthy server or alter supervision success.
- Root accepts the existing trusted dedicated-server launch boundary, not hostile server-code containment.

## Review Focus

1. Initial capture races exact child exit; tests must deny pending/late identity.
2. PID/operation-ID reuse; tests require fresh nonce and immutable creation/command identity, and stale callbacks cannot remove current entries.
3. Root aliases/ancestor overlap/prefix-lookalike siblings; tests distinguish positive disjointness from string resemblance.
4. Hidden arguments plus visible unrelated root; test that visible unrelated text cannot override hidden-client uncertainty.
5. Real composition integration and fixture imports; prove provider wiring and prevent accidental system probes from factory-created inert tests.

## Task 1: Exact runner evidence and guarded consumption

**Files:**
- Modify `electron/services/server-process-runner.cjs`.
- Modify `electron/services/client-modpacks/client-process-guard.cjs`.
- Modify `electron/bootstrap/create-client-pack-composition.cjs`.
- Create `tests/server-process-evidence.test.cjs`.
- Modify `tests/client-modpacks/client-process-guard.test.cjs`.
- Modify `tests/client-modpacks/production-client-pack-composition.test.cjs`.
- Modify only deterministic UUID injection and exact affected inert runner argv assertions in `tests/server-launcher.test.cjs`; no production behavior change solely to appease pre-marker fixtures. Run the exact inert test names RED then GREEN.

**Interfaces:**
- Runner factory adds optional `inspectProcesses`, `captureLaunchRoot`, `randomUUID` dependency seams. No inspector call merely from import or a legacy inert factory.
- `captureLaunchRoot(absolutePath)` is synchronous bounded canonical directory/object evidence, permitting capture before the existing synchronous spawn. It returns a frozen canonical path and stable directory identity or throws. Recheck the same root synchronously during proof; no full-tree hashing.
- Runner exposes `isCurrentUnrelatedServer({ process, clientPath })`, returning boolean or Promise<boolean> with false on insufficient evidence. Its baseline is never minted from this later supplied row. The production shared runner enables real capture and is the sole production provider.
- `ClientProcessGuard` accepts optional `isCurrentUnrelatedServer` (default no exemption), consuming the existing validated current snapshot. Composition supplies the shared provider; test injection may supply an inert provider without broadening renderer authority.
- Preserve synchronous `launchServerProcess`, existing ownership events/operation ID marker; add private `-Dminecraft.core.server.launch=<uuid>` before launch arguments. UUID random per spawn, not lifecycle ID.

- [ ] Step 1: Read spec, residual review and the seven files. Record current file hashes and inspect the selected test fixtures for accidental real inspection. Do not broaden scope.
- [ ] Step 2: Add missing/settled-record tests for all-argument `@file`, quoted `@path with spaces`, Prism `org.prismlauncher.EntryPoint`, MultiMC `org.multimc.EntryPoint`, and indirect plus visible unrelated root. Assert uncertain/no mutation callback/no launch admission. Retain direct unrelated/same-root and ordinary Java controls. Run those exact positive-name selections RED and retain full output.
- [ ] Step 3: Add inert runner evidence tests. Use fake children/streams and supervision, injected bounded snapshots/root evidence. Assert exact valid Forge/NeoForge admission through real runner provider + guard; pending/malformed/failed capture stays uncertain without killing server; copied marker grants no authority. Exercise PID/creation/executable/command/parent drift, repeated operation ID, exit/close/error/fatal/stop, late old callback, new runner, root equality/ancestor/descendant/change/alias/missing and prefix siblings. Run new tests RED.
- [ ] Step 4: Implement private runner evidence, conservative indirect classification and composition wiring only in owned files. Capture failure is caught and recorded as unavailable, never an unhandled rejection. Preserve existing startup/supervision/close settlement.
- [ ] Step 5: Add actual composition behavior tests using inert seams. Prove current unrelated Forge server permits the matching-client guarded path and missing/failed provider does not turn indirect activity into stopped. Ensure no hidden real system inspector use. Run selected tests GREEN, then the inert cases in the exact three files. Preserve the pre-existing real Node-child integration test unchanged; exclude it only from the worker's explicit positive-name allowlist and name it in the report. Root runs that case/full file after freeze. Expected exit0 and zero unexplained failures/skips.
- [ ] Step 6: Self-review against spec and all five Review Focus items. Freeze the seven-file incremental diff against the original nine-file wave, record before/after hashes, exact commands and complete RED/GREEN output in `final-client-process-evidence-report.md`; return concise status. No commit.
- [ ] Step 7 (root): Read full report/output, verify frozen hashes and incremental diff. Single independent scoped residual review, not broad branch review. Record ruling/result, then run affected/full root gates, stage only reviewed paths and commit. Preserve unrelated changes.

## Root preflight/self-review

One coherent task: runner produces current-main proof, guard consumes it, composition supplies it. They share one admission contract and cannot be independently deployed. New tests are inert and cover both refusal and intended compatibility; initial capture is synchronous root evidence plus asynchronous bounded OS snapshot, so launch signature stays unchanged. This resolves the exploratory design's illustrative async root seam ambiguity. No schema/UI change or extra dependency. The seven-file allowance includes the directly affected existing argv assertions; any further file requires root ruling before edit. Root records scope extensions, not worker guesswork.

The user explicitly delegated plan self-review and implementation; no routine approval pause. This is a finite residual correction under that instruction, not another general review cycle.

Root clarification02:31: stop invalidation is runner-owned `stopFully`; normal server-manager stdin stop is outside that request interface, not process-exit evidence. Add one inert direct-stdin-stop then exit control: current exact unrelated-server proof can remain while shutdown is live, and must cease on exit. Do not add manager imports/status coupling. Existing identity/root/supervision checks remain mandatory throughout.

Root scope addition02:32: the nonce intentionally changes runner argv. Existing exact spawn expectations at tests/server-launcher.test.cjs:463–465 and530–531 need deterministic UUID injection and an explicit expected token, preserving full ordering/content checks. This is the sole added seventh path; include it in the frozen incremental diff and report. No wider launcher edits or native execution are authorized.
