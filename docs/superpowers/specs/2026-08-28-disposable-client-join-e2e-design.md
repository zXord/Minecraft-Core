# Disposable client join E2E design

## Scope

Add an opt-in Playwright integration test that proves a fresh, disposable
Minecraft client can join a fresh offline-mode modpack server through the
production application stack. It must not read, enumerate, import, copy, or
refresh authentication from any existing client instance.

## Design

The test uses an independent helper under `tests/e2e/fixtures/`. The helper
creates one scratch root and separate `userData`, server, and client children.
It starts the desktop application with only that user-data directory and with
the production service graph; it never sets the test modpack factory variable.

The helper installs the exact Modrinth Server Optimized 1.20.1 release through
the production IPC surface, changes only that server's `server.properties` to
set `online-mode=false` and `enforce-secure-profile=false`, and then starts the
resulting server. It creates a synthetic, safeStorage-encrypted
`xmcl-auth.json` inside only the disposable client directory. The helper never
calls the reusable-account or import-account IPC channels, and never inspects
the normal application user-data location.

The spec launches with the real proper launcher, waits for a successful game
connection, and asserts the synthetic username in the disposable server log.
It removes the scratch root only after all assertions pass. On failure it
retains the root and reports its location for diagnosis.

## Verification

Unit tests cover scratch-root isolation, fake-auth packing, cleanup policy,
and prohibited environment/API inputs. The opt-in Playwright spec is excluded
from the normal E2E command and must be launched explicitly with its required
real-runtime environment.
