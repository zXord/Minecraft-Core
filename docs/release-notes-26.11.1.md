# Minecraft Core 26.11.1 release notes (draft)

Draft of 30 October 2026, not published. If the release slips into December it ships as 26.12.1. The native test plan in the [release checklist](testing/modpack-release-checklist.md#native-test-plan) must pass on the final build before these notes are used.

Servers and clients without modpack data, which is everything a 26.6.1 user has, keep working exactly as in 26.6.1. The notes below cover what changes or needs explaining when you upgrade.

## Hosts update first

- A friend on 26.11.1 cannot play on a host that still runs 26.6.1. Play shows **Host Update Required** with a **Refresh** button; ask the host to update Minecraft Core, then press Refresh.
- On a PC with no modpack data, the friend can instead switch to the host's older version (**Use version 26.6.1 on this PC**), with a warning.
- On a PC that has modpack data, that switch is refused and the reason is shown: the older version cannot read that data safely.
- A friend on 26.6.1 joining a 26.11.1 host is offered the update, as before.
- Playing still needs exactly the same app version on both sides, as in 26.6.1.

## Server actions while a server runs

- Restore backup, Delete world, Delete instance, Version update or loader install and Repair still need the server stopped, as in 26.6.1.
- Every other server action works while the server runs again: players, bans, settings and auto-start, the management server and invites, server.properties, backup rename, delete, automation and retention, mods and mod watches, renaming, and adding or reordering instances.
- On a modpack-managed server, a full backup restore that would replace its modpack state is refused, with a pointer to **Modpack > Rollback** or **Detach**. World-only restores still work. Other servers restore exactly as before.
- On a modpack-managed server, the management server and its invite settings change only while the server is stopped.

## Modpack features need a normal folder

Modpack features need the server or client in its own normal folder. These are refused up front with a message to move the server or client into a subfolder:

- a drive root, or a folder directly under a drive root;
- a junction, SUBST, mapped-drive or network-share path;
- a folder name copied from a Mac (NFD), or one with leading or trailing spaces;
- a folder registered twice in the sidebar.

Everything else about such servers and clients works as in 26.6.1.

When AppData is redirected to a network share, Minecraft Core opens with a banner and modpack features turned off. Servers, clients, backups and mods work as before.

## Other behaviour notes

- A damaged or unreadable `.minecraft-core.json` or `ignored-mod-updates.json` is repaired automatically. The original bytes are kept next to it as a `*.unreadable-*` file. A read-only `.minecraft-core.json` still cannot be saved, as in 26.6.1, and does not block the server from starting.
- When Windows PowerShell is blocked or too slow, ordinary servers still run, with a console warning; as with 26.6.1 they are not stopped automatically if Minecraft Core itself crashes. Modpack servers refuse to start, with an explanation.
- A modpack operation is refused while a Minecraft server that Minecraft Core did not start still holds the world.
- A friend can toggle and delete their own shaders, resource packs and client mods while the host gives no answer at all, unless the client uses a matching modpack. A host that is connected but slow gets up to 10 seconds to answer.
- Deleting a client with its files, when a registered server sits inside that client folder, needs that server stopped first; it is then deleted as in 26.6.1.
- A new server can again be created inside, or in the same folder as, a plain client folder. Matching client-pack installs refuse such nested layouts with an explanation.
- Port conflicts between servers are checked as in 26.6.1.
- A friend's **Required Mods** list shows its mods again. 26.6.1 showed only the count ("2 mods") for lists of 80 mods or fewer.
- If the loader install (Fabric, Forge, NeoForge or Quilt) fails during server setup or a version update, Minecraft Core now stops and shows the reason next to the button, instead of finishing as if it had worked.

## Going back to 26.6.1 after using modpacks

- Hidden sibling folders (`.<job>.c`, `.f`, `.r`) left next to a server by an interrupted modpack operation are not recognised by 26.6.1.
- NeoForge servers made by 26.11.1 deliberately refuse to start under 26.6.1 with an `UpdateRequired…` message. Quilt servers keep working.
- Legacy Forge (1.12 to 1.16) modpack servers show 'Forge launch assets are missing' in 26.6.1.
- 26.6.1's Version Updater or Repair on those servers replaces the guard jar with vanilla. Update to 26.11.1 again, then use **Modpack Verify** and **Repair**.

## Known limitations of the new modpack setup wizard

These are not 26.6.1 regressions.

- If a modpack Start failed for a reason other than an expired review, the wizard can stay paused until it is reopened.
- A destination folder that is deleted and recreated before an app restart stays reserved until the restart.
- A Modrinth pack with more than 5,000 versions, or a version history over 16 MiB, cannot be browsed; the app says so and points to **Local archive** with the pack's `.mrpack` file.
- Per-machine installs may get a stray per-user Start Menu shortcut the first time a Windows notification is shown. This is cosmetic; uninstaller cleanup is planned.

## Owner decisions behind this release (30 October 2026)

| # | Decision | State in this release |
| --- | --- | --- |
| Q1 | Version 26.11.1 now; 26.12.1 if the release slips into December. | `package.json` is 26.11.1. |
| Q2 | Within the setup wizard, a "not observed" Start counts as not admitted, and a settled reservation is released through the guarded backend release, including automatically when that review is no longer on screen. | Implemented in the setup wizard. |
| Q3 | Keep a guarded "Use the host's older version" option for PCs without modpack data; refuse it with an explanation where modpack data exists. | Implemented in the updater and Play tab. |
| Q4 | The modpack-only limitations above are acceptable as release notes; everything 26.6.1 supports keeps working for those instances. | This document. |
| Q5 | `enableDevUpdates:false`; unpackaged runs default to the "Minecraft Core Development" profile and identity; dev and QA copies never poll GitHub or install over the real installation. | Implemented. |
| Q6 | Cache the ArchiveWorker.exe verification per process, keyed by the file's identity, re-hashing whenever it changes. | **Not implemented in this fix wave.** Strict writes on modpack-managed servers still re-hash the worker each time; servers without modpack data no longer use it. |
| Q7 | Deleting a client with "delete files" when the folder contains a registered server reserves that server and requires it stopped, then deletes as 26.6.1 did. | Implemented. |
| Q8 | A new server nested in, or sharing a folder with, a plain client folder is allowed again; matching client-pack installs refuse nested layouts. | Implemented. |
| Q9 | Refuse a modpack operation while a server Minecraft Core did not start holds the world (session.lock probe). | Implemented. |
| Q10 | Allow local shader, resource-pack and client-mod toggles and deletes when the host gives no HTTP response and the client has no matching pack. | Implemented. |
| Q11 | On modpack-managed servers, refuse a full backup restore that would overwrite modpack state; allow world-only restores; unmanaged servers unchanged. | Implemented. |
| Q12 | Throwaway repository for the publish rehearsal. | Deferred: ask the owner at the end. Nothing has been pushed, published or released. |

Port conflicts are not a regression: 26.6.1 has the same cross-instance port check, and it is unchanged.
