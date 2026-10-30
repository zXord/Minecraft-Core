# Shared by scripts/build-archive-worker.ps1 and its tests. These files are pinned and verified byte for
# byte (scripts/verify-packaged-archive.cjs), so they come from fixed LF templates instead of ConvertTo-Json,
# whose layout differs between Windows PowerShell 5.1 and PowerShell 7, and never use [Environment]::NewLine.

function Format-ArchiveWorkerManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][long]$Size,
    [Parameter(Mandatory = $true)][string]$Sha256
  )
  if ($Size -lt 1) { throw 'ArchiveWorker size is invalid' }
  if ($Sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'ArchiveWorker sha256 is invalid' }
  $invariant = [Globalization.CultureInfo]::InvariantCulture
  $lines = @(
    '{',
    '  "schemaVersion": 2,',
    '  "architecture": "x64",',
    '  "runtimeIdentifier": "win-x64",',
    '  "targetFramework": "net8.0-windows",',
    '  "sdkVersion": "10.0.204",',
    '  "runtimeMode": "in-memory-single-file",',
    '  "files": {',
    '    "ArchiveWorker.exe": {',
    ('      "size": ' + $Size.ToString($invariant) + ','),
    ('      "sha256": "' + $Sha256 + '"'),
    '    }',
    '  }',
    '}'
  )
  return (($lines -join "`n") + "`n")
}

function Get-ArchiveWorkerSha256Hex {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Bytes)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-', '')).ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Test-ArchiveWorkerSourceLink {
  param([Parameter(Mandatory = $true)][IO.FileSystemInfo]$Entry)
  # Symbolic links and junctions redirect; cloud-sync placeholders also carry the reparse attribute but do not.
  return ($null -ne $Entry.LinkType -and $Entry.LinkType -ne 'HardLink')
}

# Every regular file under native/ArchiveWorker except bin and obj build output, hashed with CRLF folded to
# LF so a CRLF checkout gives the same digest as the LF blobs git stores. Must stay identical to
# computeArchiveWorkerSourceDigest in scripts/verify-packaged-archive.cjs.
function Get-ArchiveWorkerSourceDigest {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$SourceRoot)
  $root = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($SourceRoot))
  if (-not $root.Exists -or (Test-ArchiveWorkerSourceLink -Entry $root)) { throw 'ArchiveWorker source root is not an exact directory' }
  $latin1 = [Text.Encoding]::GetEncoding(28591)
  $hashes = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
  $pending = [Collections.Generic.Stack[object]]::new()
  $pending.Push(@($root, ''))
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($entry in $current[0].GetFileSystemInfos()) {
      if ($entry.Name -cnotmatch '^[A-Za-z0-9._-]+$') {
        throw "ArchiveWorker source name is not supported: $($current[1])$($entry.Name)"
      }
      $relative = $current[1] + $entry.Name
      if (Test-ArchiveWorkerSourceLink -Entry $entry) { throw "ArchiveWorker source is a link: $relative" }
      if ($entry -is [IO.DirectoryInfo]) {
        if ($entry.Name -ceq 'bin' -or $entry.Name -ceq 'obj') { continue }
        $pending.Push(@($entry, ($relative + '/')))
        continue
      }
      $normalized = $latin1.GetBytes($latin1.GetString([IO.File]::ReadAllBytes($entry.FullName)).Replace("`r`n", "`n"))
      $hashes[$relative] = Get-ArchiveWorkerSha256Hex -Bytes $normalized
    }
  }
  if ($hashes.Count -lt 1) { throw 'ArchiveWorker source root is empty' }
  [string[]]$paths = @($hashes.Keys)
  [Array]::Sort($paths, [StringComparer]::Ordinal)
  $listing = [Text.StringBuilder]::new()
  $files = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal)
  foreach ($relative in $paths) {
    [void]$listing.Append($hashes[$relative]).Append('  ').Append($relative).Append("`n")
    $files[$relative] = $hashes[$relative]
  }
  return [pscustomobject]@{
    Sha256 = Get-ArchiveWorkerSha256Hex -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($listing.ToString()))
    Files = $files
  }
}

function Format-ArchiveWorkerSourceDigest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Digest,
    [Parameter(Mandatory = $true)][long]$WorkerSize,
    [Parameter(Mandatory = $true)][string]$WorkerSha256
  )
  if ($Digest.Sha256 -cnotmatch '^[a-f0-9]{64}$' -or $Digest.Files.Count -lt 1) { throw 'ArchiveWorker source digest is invalid' }
  if ($WorkerSize -lt 1) { throw 'ArchiveWorker size is invalid' }
  if ($WorkerSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'ArchiveWorker sha256 is invalid' }
  $invariant = [Globalization.CultureInfo]::InvariantCulture
  $fileLines = [Collections.Generic.List[string]]::new()
  foreach ($relative in $Digest.Files.Keys) {
    if ($relative -cnotmatch '^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$' -or $Digest.Files[$relative] -cnotmatch '^[a-f0-9]{64}$') {
      throw 'ArchiveWorker source digest is invalid'
    }
    $fileLines.Add('    "' + $relative + '": "' + $Digest.Files[$relative] + '"')
  }
  $lines = @(
    '{',
    '  "schemaVersion": 1,',
    '  "source": "native/ArchiveWorker",',
    ('  "sha256": "' + $Digest.Sha256 + '",'),
    '  "files": {',
    ($fileLines -join ",`n"),
    '  },',
    '  "worker": {',
    ('    "size": ' + $WorkerSize.ToString($invariant) + ','),
    ('    "sha256": "' + $WorkerSha256 + '"'),
    '  }',
    '}'
  )
  return (($lines -join "`n") + "`n")
}
