# Archive policy v1 limit calibration

Measurement date: 2026-08-02. This document fixes the evidence used to choose and review the initial archive-policy limits. It is not a promise that an archive beneath every numeric ceiling is safe: magic binding, forced handlers, encryption rejection, canonical Windows-name policy, collision checks, multipart verification, contained extraction, and the no-follow postwalk remain mandatory.

## Method

Measurements used the repository-pinned official 7-Zip 26.02 x64 runtime with `-mmt1`, a forced ZIP handler, technical `l -slt`, and integrity `t`. Technical output was parsed by `parseSevenZipTechnicalList`; sizes are the unsigned decimal values reported by the engine. "Archive bytes" is the downloaded file length. "Expanded bytes" is the sum of all entry sizes. Ratios are expanded bytes divided by archive bytes, except "max entry ratio", which is the largest entry size divided by its reported packed size. Depth and name length use NFC-normalized `/`-separated names and JavaScript UTF-16 code-unit length, matching policy v1.

The three real packs were the first listed stable release returned by the Modrinth version API for the named project on the measurement date. Their exact version IDs, API-advertised SHA-512 values, measured SHA-256 values, and version pages are recorded below. Downloaded calibration copies are not committed. All three manifests declare every listed download server-eligible; "declared downloads" is the sum of their manifest `fileSize` values and is separate from the bytes physically embedded in the MRPACK.

Timing and Windows working-set figures are single-run observations on the development machine. They are useful headroom checks, not performance guarantees. No untrusted archive was extracted outside the contained worker for calibration.

## Representative server-compatible packs

| Pack and immutable release | Archive bytes | Expanded bytes | Entries | Max file bytes | Depth | Max name | Aggregate ratio | Max entry ratio | List bytes | List/test time | Peak 7-Zip working set | Server files / declared downloads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [Better MC Fabric BMC2 v40 (`M5BnAIQy`)](https://modrinth.com/modpack/better-mc-fabric-bmc2/version/M5BnAIQy), SHA-256 `82aa7ca49b118b4089dd4ac1a30b43d2a1ada25061c6375dad104f43b2b46150`, API SHA-512 `a9ebbf5132f30fa89907fcb10f7d0a92064b325afbeabf053defdd41a26b5907cd709d253046bb43ba9164c3890b100577d822b9b899fe974c56bdfde7c572d9` | 66,273,847 | 94,195,450 | 4,614 | 9,189,206 | 7 | 149 | 1.421:1 | 31.370:1 | 1,743,391 | 93 ms / 551 ms | 11,796,480 | 336 / 620,770,668 bytes |
| [Cobblemon Official Fabric 1.7.3 (`Lydu1ZNo`)](https://modrinth.com/modpack/cobblemon-fabric/version/Lydu1ZNo), SHA-256 `2cd8da213369a38c3479c0b5a27bc32cebabb40cbe082134b86f78431d0bc070`, API SHA-512 `c74ae4cab42ca3d76238e7615d8f82bc648c7afcf76184253e8bd28aca8587121dea0cc46af47b4c88e809749a42430f3016f96290cff5537d0fe5347641d4d2` | 101,013,638 | 111,240,729 | 2,427 | 15,831,040 | 11 | 145 | 1.101:1 | 52.289:1 | 926,560 | 61 ms / 713 ms | 11,239,424 | 76 / 189,443,872 bytes |
| [Prominence II 3.9.27 (`9r2hKvJH`)](https://modrinth.com/modpack/prominence-2-fabric/version/9r2hKvJH), SHA-256 `196cbfd1087acf8814b23cf23d4bd0194a31c214df42239b18758595aa7b757f`, API SHA-512 `d320854638de7f79fd42da45ae45a27977820f5c600bacb5891e1904f5e6825340c9c3850d4f0adc3e877fa343458f15ab8518612d02d07025ba00282a702248` | 110,332,256 | 120,926,894 | 1,476 | 40,525,813 | 7 | 114 | 1.096:1 | 45.741:1 | 567,791 | 57 ms / 371 ms | 11,124,736 | 548 / 950,891,640 bytes |

The largest observed values are 110,332,256 archive bytes, 120,926,894 embedded expanded bytes, 4,614 entries, a 40,525,813-byte file, depth 11, name length 149, 52.289:1 per-entry ratio, 1.421:1 aggregate ratio, 1,743,391 technical-list bytes, 713 ms list/test time, and 11,796,480 bytes peak working set. The largest server download plan is 950,891,640 bytes.

## Adversarial fixtures

All fixture hashes and provenance are fixed in `tests/fixtures/archives/README.md`.

| Fixture | Archive bytes | Expanded bytes | Entries | Depth | Max name | Aggregate ratio | Max entry ratio | Expected rejection |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `high-ratio.zip` | 65,346 | 67,108,864 | 1 | 1 | 8 | 1,026.977:1 | 1,028.772:1 | `maxPerEntryCompressionRatio`; it is exactly at the 64 MiB activation threshold and above 1000:1. |
| `traversal.zip` | 132 | 6 | 1 | 2 | 13 | 0.045:1 | 0.750:1 | `UNSAFE_ARCHIVE_ENTRY` for `../escape.txt`, independent of size. |
| `unicode-alias.zip` | 242 | 6 | 2 | 2 | 13 | 0.025:1 | 0.600:1 | `ARCHIVE_ENTRY_COLLISION` after NFC and Windows case folding. |
| `file-directory-collision.zip` | 203 | 9 | 2 | 2 | 7 | 0.044:1 | 0.714:1 | `ARCHIVE_ENTRY_COLLISION` because file `a` is an ancestor of `a/b.txt`. |
| `symlink-metadata.zip` | 130 | 10 | 1 | 1 | 11 | 0.077:1 | 1.000:1 | `UNSAFE_ARCHIVE_ENTRY` from link metadata before extraction. |

The encrypted fixture is rejected from archive or entry encryption evidence and password diagnostics. Unit tests additionally exercise exact count, total expansion, per-file expansion, aggregate ratio, depth, name-length, zero-packed-size, decimal-overflow, nonregular-object, reparse, elapsed-time, free-space, and measured-output boundaries without committing huge sparse fixtures.

## Limit rationale

| Policy v1 limit | Why representative packs pass | What it bounds or rejects |
| --- | --- | --- |
| 16 GiB artifact set | The largest sampled archive is about 0.103 GiB and the largest declared server download plan is about 0.886 GiB. | Caps downloaded/compressed authority before inspection and prevents an unbounded cache or provider plan. |
| 250,000 entries | The largest sample has 4,614 entries, over 54 times below the ceiling. | Bounds parser records, path-policy work, directory creation, postwalk work, and inode exhaustion. |
| 64 GiB expanded total | The largest sampled embedded expansion is about 0.113 GiB, over 568 times below the ceiling. | Stops declared and measured expansion bombs; extraction aborts as soon as measured bytes cross the same bound. |
| 16 GiB per file | The largest sampled entry is 40,525,813 bytes, over 423 times below the ceiling. | Prevents a single archive member from monopolizing disk and makes per-file watchdog comparison finite. |
| Depth 64 | The deepest sample is 11. | Bounds traversal, recursion, implicit-parent creation, and postwalk stack growth. |
| Normalized name length 1,024 UTF-16 code units | The longest sampled normalized name is 149. | Avoids pathological names and leaves headroom beneath common Windows extended-path behavior; unsafe basenames are still rejected separately. |
| 64 MiB technical stdout | The largest sampled list is 1,743,391 bytes, more than 38 times below the cap. | Bounds streamed `-slt` parsing and read-entry evidence. Purpose-specific reads are further capped at 2 MiB for MRPACK manifests and 64 KiB for app state. |
| 8 MiB technical stderr | Every valid sample emitted zero stderr bytes. | Allows bounded diagnostics while preventing output flooding; password diagnostics map to one stable encrypted-archive failure. |
| Five-minute list/test deadline | The slowest sampled integrity test was 713 ms. | Terminates hangs and adversarial decoder work. The deadline remains deliberately broad for slower disks and archives near the size ceiling. |
| Sixty-minute extraction deadline | All representative packs pass every pre-extraction bound, and their largest embedded expansion is 120,926,894 bytes. | A measured watchdog terminates a stalled contained extraction independently of engine switches. Packaged contained-extraction timing remains a mandatory release smoke measurement rather than an unsafe direct-extraction benchmark. |
| 2 GiB child-job memory | Sampled forced-family list/test operations peaked at 11,796,480 bytes with single-threaded `-mmt1`, over 173 times below the cap. | The Windows Job limit contains pathological codec allocation and all descendants; crossing it fails the operation. |
| 1000:1 per entry at 64 MiB | The largest representative entry ratio is 52.289:1. | The 64 MiB fixture at 1,028.772:1 is rejected, while tiny highly-compressible configuration files do not create false positives. |
| 1000:1 aggregate at 256 MiB | The largest representative aggregate ratio is 1.421:1. | Stops distributed bombs once total expansion is material; tests exercise the exact 256 MiB activation edge. |
| Non-empty packed size must be positive | Every representative non-empty entry has positive packed size. | Rejects impossible or deceptive technical-list size evidence before ratio arithmetic. |
| Preflight reserve `max(2 GiB, ceil(10%))` | The largest sampled embedded plan requires 2,268,410,542 bytes including the 2 GiB floor, a practical requirement for a server host. | Preserves rollback, metadata, temporary, and filesystem headroom; the percentage branch scales for plans above 20 GiB. Free space is remeasured throughout extraction. |

## Reproduction and review rules

1. Resolve the exact version ID from `https://api.modrinth.com/v2/project/{slug}/version`; record the API SHA-512, file size, publication timestamp, Minecraft version, and loader.
2. Download the exact primary file from the API-provided Modrinth CDN URL and verify both size and SHA-512 before measurement.
3. Run the pinned repository `vendor/7zip/x64/7z.exe` with the same forced family, UTF-8, `-mmt1`, list, and test switches used by the worker. Never use `PATH` or a system 7-Zip.
4. Feed technical stdout through the production streaming parser and compute policy totals with unsigned integer arithmetic.
5. Do not extract a newly downloaded calibration archive outside the contained worker. Packaged contained extraction, deadline, memory, cleanup, and no-follow evidence belong in the release smoke report.
6. Recalibrate before raising any limit. A larger real pack is evidence to review a bound, not permission to disable magic binding, canonical-name policy, ratio checks, containment, or the postwalk.
