# Archive security fixtures

These are intentionally tiny, deterministic fixtures for the untrusted archive boundary. Tests verify every binary's byte length and lowercase SHA-256. The ordinary ZIP fixtures contain only text or generated structural bytes created for this repository; they contain no third-party modpack or Minecraft payload. The RAR fixtures are copied only from the two reviewed, redistributable upstream corpora below. CI never creates or modifies a RAR archive with 7-Zip.

## Locally generated ZIP fixtures

Generator: `node tests/fixtures/archives/generate-fixtures.cjs` using Node's standard `zlib` plus the repository-owned ZIP writer in that file. All timestamps are fixed to 2020-01-01 00:00:00 DOS time, entry ordering is explicit, and traditional ZIP encryption uses a fixed test header. License/provenance: project-owned generated test artifacts with no third-party contents, distributed under the same terms as this repository. The nested `server.jar` and installer JAR are generated ZIP structures containing only fixture JSON/text; they are not Mojang or loader binaries.

| File | Bytes | SHA-256 | Purpose |
| --- | ---: | --- | --- |
| `ambiguous-roots.zip` | 1020 | `57777dee2b7afa772b41e4e83b0be2b54121ed46ca6f45cab65961cc547c6f39` | Two independently plausible wrapper roots; must remain ambiguous. |
| `client-only.mrpack` | 659 | `49c26b533cc367623ef943567ebda72324692ea01aab589e19eadddb5b500bc4` | Valid Modrinth v1 manifest whose only file is explicitly server-unsupported. |
| `conflicting-loader.zip` | 570 | `4508441bebc745f81c3bca02ebe1a5ea5a4dd091c54e974db2d9f454bff4176c` | Fabric and NeoForge evidence in one root. |
| `custom-bootstrap.zip` | 297 | `a676cd8d78350a575ec5b7c97916f60726fee4393dd6a9ee34afdb47cb784370` | Unknown wrapper JAR plus a custom launch script; neither may execute. |
| `encrypted.zip` | 136 | `41d5385a18d61e93d14d19b4d82b2a1a13db9c382b41f1e6700be416856bc5e3` | Deterministic traditional ZipCrypto entry; password is the non-secret string `fixture`. |
| `file-directory-collision.zip` | 203 | `7b2aee4b0291b0686e406ecde869418894db39a767d773390e2e0e1f605b66bb` | File `a` conflicts with descendant `a/b.txt`. |
| `high-ratio.zip` | 65346 | `9f6e6b9c2d0f514df8927063f1ad519afe279d76b26f7724097245ff78e0d05d` | 64 MiB of zero bytes compressed past the exact per-entry ratio boundary. |
| `installer-only.zip` | 461 | `f441af84292a25383bcee67e6f1920b8e9c812846f53ad933a61bf7494b77152` | Generated Forge-named installer JAR and inert script without a prepared runtime. |
| `minecraft-core-backup.zip` | 481 | `76102411cc5a1d3c602e2d7b3f9f7e58d4cd1835c2829de4d23c089ff6a1f6c1` | Positive Minecraft Core state plus server and world evidence. |
| `prepared-vanilla.zip` | 636 | `5304c611fa8329dec173d90cd83d10cc4f49440023e6216c1eea93764b891814` | Generated server JAR with manifest/version metadata and `server.properties`. |
| `symlink-metadata.zip` | 130 | `97a95d81b857822912db32e1c0c075976608a27af2a2bc9491d350df06a9535f` | Unix symlink mode and link target metadata. |
| `tiny-zip64.zip` | 247 | `f4735f3d12914a8b3ddacbab8aaefc84912b91a0df4194be5ba5db0e46af3279` | Minimal genuine ZIP64 extra fields, EOCD64 record, and locator. |
| `tiny.zip` | 123 | `2263efc47699dff59d9aff2d3e7def4b2eaa580938bfa3f9c5847c6dc15d56af` | Minimal normal ZIP list/test/read/extract baseline. |
| `traversal.zip` | 132 | `b610f140c37669a753051fc166f8bf71e3f7049267a30df61484e6878e69ca7f` | Parent traversal entry. |
| `unicode-alias.zip` | 242 | `ebd23b7ea8fce77240780ffd78b75fb7050387df6810e50e89dbe6e81da39b17` | NFC and decomposed Unicode aliases for one Windows destination. |

## CC0 single-volume RAR fixtures

Source repository: <https://github.com/ssokolow/rar-test-files> at exact commit `16b785c2b1b504e99fc307676e5369a26d3ce060`. Upstream documentation states the files were legally generated with a purchased WinRAR license and dedicates the author's rights under [CC0 1.0 Universal](https://raw.githubusercontent.com/ssokolow/rar-test-files/16b785c2b1b504e99fc307676e5369a26d3ce060/LICENSE.cc0). Importer: `node tests/fixtures/archives/import-rar-fixtures.cjs <rar-test-files checkout> <libarchive checkout>`; it refuses any checkout not at the exact reviewed commits.

| File | Exact upstream URL | Bytes | SHA-256 | Purpose |
| --- | --- | ---: | --- | --- |
| `rar4.rar` | <https://raw.githubusercontent.com/ssokolow/rar-test-files/16b785c2b1b504e99fc307676e5369a26d3ce060/build/testfile.rar3.rar> | 98 | `dce342bc0c2852fcaa36a03da5e55abb7dd69c045bbd812faebebc1a3844f5a4` | Minimal RAR4-marker (`52 61 72 21 1a 07 00`) list/test/extract fixture. Upstream calls this RAR3; 7-Zip's forced handler is `Rar`. |
| `rar5.rar` | <https://raw.githubusercontent.com/ssokolow/rar-test-files/16b785c2b1b504e99fc307676e5369a26d3ce060/build/testfile.rar5.rar> | 82 | `a546b39c1aa42669543ef81f5ec8c4ef49fc7c2e5b8d08ab10549e919996e1a4` | Minimal RAR5 marker (`52 61 72 21 1a 07 01 00`). Inspection retains the concrete RAR5 identity, requires `Type = Rar5`, and the closed worker routes it through the exact 7-Zip 26.02 `-trar5` handler. |

## BSD-licensed multipart RAR fixtures

Source repository: <https://github.com/libarchive/libarchive> at exact commit `e893064acf884e4f6a8a7314ba744a9ff997a99b`. License: libarchive's permissive two-clause license in exact [`COPYING`](https://raw.githubusercontent.com/libarchive/libarchive/e893064acf884e4f6a8a7314ba744a9ff997a99b/COPYING). The importer decodes the committed uuencoded source bytes with its small closed decoder; it does not call RAR, WinRAR, unrar, or 7-Zip. The destination names preserve a supported `.partN.rar` naming form and every volume in each selected corpus set is present.

| File | Exact upstream uuencoded source | Bytes | SHA-256 | Purpose |
| --- | --- | ---: | --- | --- |
| `multipart.part0001.rar` | [`test_rar_multivolume_single_file.part1.rar.uu`](https://raw.githubusercontent.com/libarchive/libarchive/e893064acf884e4f6a8a7314ba744a9ff997a99b/libarchive/test/test_rar_multivolume_single_file.part1.rar.uu) | 7000 | `54769cdaa6aeac494b9ba580804598369ba240f61550620434e08350e4428ec2` | RAR4 primary volume and exact three-volume completeness. |
| `multipart.part0002.rar` | [`test_rar_multivolume_single_file.part2.rar.uu`](https://raw.githubusercontent.com/libarchive/libarchive/e893064acf884e4f6a8a7314ba744a9ff997a99b/libarchive/test/test_rar_multivolume_single_file.part2.rar.uu) | 7000 | `9dd6b28d2fdf0d012390259548cc86be9535ee6eb5ec630c99fbb5dc8d037ed1` | RAR4 second volume. |
| `multipart.part0003.rar` | [`test_rar_multivolume_single_file.part3.rar.uu`](https://raw.githubusercontent.com/libarchive/libarchive/e893064acf884e4f6a8a7314ba744a9ff997a99b/libarchive/test/test_rar_multivolume_single_file.part3.rar.uu) | 6432 | `7d72ef6e876e98e6a317b7e534c0285615a2953543e68135a8a0dcc94b41cf21` | RAR4 terminal volume. |
| `rar5-multipart.part01.rar` | [`test_read_format_rar5_multiarchive_solid.part01.rar.uu`](https://raw.githubusercontent.com/libarchive/libarchive/e893064acf884e4f6a8a7314ba744a9ff997a99b/libarchive/test/test_read_format_rar5_multiarchive_solid.part01.rar.uu) | 13312 | `6607f575dad0b28aaeb02298b4c04a0e5a606e77f952127d2d9e346f60616a26` | RAR5 solid primary and exact four-volume completeness. |
| `rar5-multipart.part02.rar` | [`test_read_format_rar5_multiarchive_solid.part02.rar.uu`](https://raw.githubusercontent.com/libarchive/libarchive/e893064acf884e4f6a8a7314ba744a9ff997a99b/libarchive/test/test_read_format_rar5_multiarchive_solid.part02.rar.uu) | 13312 | `eb119ed53511905ca6f1844c164b6246d8fcdca0d1f38a8e3fb13da9c0932fbd` | RAR5 second volume. |
| `rar5-multipart.part03.rar` | [`test_read_format_rar5_multiarchive_solid.part03.rar.uu`](https://raw.githubusercontent.com/libarchive/libarchive/e893064acf884e4f6a8a7314ba744a9ff997a99b/libarchive/test/test_read_format_rar5_multiarchive_solid.part03.rar.uu) | 13312 | `e814c3dbdaf3f613fd25c840065d25543f31e6b6c95505e7e25f47867a4812bd` | RAR5 third volume. |
| `rar5-multipart.part04.rar` | [`test_read_format_rar5_multiarchive_solid.part04.rar.uu`](https://raw.githubusercontent.com/libarchive/libarchive/e893064acf884e4f6a8a7314ba744a9ff997a99b/libarchive/test/test_read_format_rar5_multiarchive_solid.part04.rar.uu) | 3280 | `9ff5a4e633b0e82a2ce6e022f3d389654dbb77a0906a34f107676d6673989c9f` | RAR5 terminal volume. |

The filename grouping unit tests separately cover `.rar` plus `.r00` and plain numbered `.001` sets. We do not relabel multipart bytes into a different naming scheme because the RAR header records its volume naming convention; such relabeling would create a misleading or nonfunctional fixture.
