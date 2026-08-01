# 7-Zip 26.02 notice

Minecraft Core redistributes the unmodified Windows x64 command-line runtime
from **7-Zip 26.02**, copyright (C) 1999-2026 Igor Pavlov. 7-Zip is separate
third-party software and remains governed by its own LGPL 2.1-or-later, BSD,
and unRAR-related terms. Minecraft Core does not relicense it.

- Official release information: https://www.7-zip.org/download.html
- Official license information: https://www.7-zip.org/license.txt
- Official version history: https://www.7-zip.org/history.txt
- Exact x64 MSI: https://github.com/ip7z/7zip/releases/download/26.02/7z2602-x64.msi
- MSI byte size: `1999872`
- MSI SHA-256: `db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e`
- Exact corresponding source: https://github.com/ip7z/7zip/releases/download/26.02/7z2602-src.7z
- Source SHA-256: `c7502dd4557481f52ccf1b3e680329f1fdd207e79a25544afeb3106325474944`

The pinned upstream MSI and its extracted `7z.exe` and `7z.dll` report the
exact Windows Authenticode state `NotSigned`; no publisher or timestamp
identity is claimed. Their repository-controlled sizes and hashes prove only
that the vendored bytes match the reviewed upstream identities. Hash matching
does not transfer licensing, establish authorship, scan for malware, or prove
that the software is harmless.

The unchanged upstream `License.txt`, the complete LGPL 2.1 text, both
applicable BSD notices, and the unRAR restriction accompany the runtime in
this repository.
