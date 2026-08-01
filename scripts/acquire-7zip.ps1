[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$PinnedMsiUri = [Uri]'https://github.com/ip7z/7zip/releases/download/26.02/7z2602-x64.msi'
$PinnedMsiSize = [Int64]1999872
$PinnedMsiSha256 = 'db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e'
$PinnedSourceUri = 'https://github.com/ip7z/7zip/releases/download/26.02/7z2602-src.7z'
$PinnedSourceSha256 = 'c7502dd4557481f52ccf1b3e680329f1fdd207e79a25544afeb3106325474944'
$PinnedVersion = '26.02'
$ExpectedNames = @('7z.exe', '7z.dll', 'License.txt')
$AllowedRedirectHosts = @(
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
)

function Assert-ContainedPath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][string]$Label
  )
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $resolvedCandidate = [IO.Path]::GetFullPath($Candidate)
  $prefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedCandidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escaped its validated root."
  }
  return $resolvedCandidate
}

function Assert-NoReparsePath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][string]$Label
  )
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $resolvedCandidate = Assert-ContainedPath -Root $resolvedRoot -Candidate $Candidate -Label $Label
  $cursor = $resolvedCandidate
  while (-not [string]::Equals($cursor, $resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $item = Get-Item -LiteralPath $cursor -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a reparse point."
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrWhiteSpace($cursor)) { throw "$Label escaped its validated root." }
  }
  return $resolvedCandidate
}

function Assert-AllowedDownloadUri {
  param(
    [Parameter(Mandatory)][Uri]$Uri,
    [Parameter(Mandatory)][bool]$Initial
  )
  if (-not $Uri.IsAbsoluteUri -or $Uri.Scheme -cne 'https') { throw '7-Zip download must use HTTPS.' }
  if (-not [string]::IsNullOrEmpty($Uri.UserInfo)) { throw '7-Zip download credentials are forbidden.' }
  if (-not $Uri.IsDefaultPort -and $Uri.Port -ne 443) { throw '7-Zip download ports are forbidden.' }
  $hostName = $Uri.IdnHost.ToLowerInvariant()
  if ($hostName -notin $AllowedRedirectHosts) { throw '7-Zip download redirect host is not allowed.' }
  if ($Initial -and $Uri.AbsoluteUri -cne $PinnedMsiUri.AbsoluteUri) { throw '7-Zip initial download identity changed.' }
  if ($hostName -eq 'github.com' -and $Uri.AbsolutePath -cne $PinnedMsiUri.AbsolutePath) {
    throw '7-Zip GitHub release path changed.'
  }
}

function Save-PinnedMsi {
  param(
    [Parameter(Mandatory)][string]$Destination
  )
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $handler.CheckCertificateRevocationList = $true
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromMinutes(5)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('Minecraft-Core-Archive-Runtime-Acquisition/1')
  $current = $PinnedMsiUri
  try {
    for ($hop = 0; $hop -le 5; $hop++) {
      Assert-AllowedDownloadUri -Uri $current -Initial:($hop -eq 0)
      $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $current)
      try {
        $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      } finally {
        $request.Dispose()
      }
      try {
        $status = [int]$response.StatusCode
        if ($status -in @(301, 302, 303, 307, 308)) {
          if ($hop -eq 5) { throw '7-Zip download exceeded the redirect limit.' }
          $locations = @($response.Headers.GetValues('Location'))
          if ($locations.Count -ne 1 -or [string]::IsNullOrWhiteSpace($locations[0])) {
            throw '7-Zip download returned a missing or ambiguous redirect.'
          }
          $next = [Uri]::new($current, $locations[0])
          Assert-AllowedDownloadUri -Uri $next -Initial:$false
          $current = $next
          continue
        }
        if ($status -ne 200) { throw '7-Zip download did not return the pinned artifact.' }
        if ($null -ne $response.Content.Headers.ContentLength -and [Int64]$response.Content.Headers.ContentLength -ne $PinnedMsiSize) {
          throw '7-Zip download declared an unexpected size.'
        }

        $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $file = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = [byte[]]::new(65536)
        [Int64]$total = 0
        try {
          while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($total + $count -gt $PinnedMsiSize) { throw '7-Zip download exceeded the pinned byte size.' }
            $file.Write($buffer, 0, $count)
            $hash.AppendData($buffer, 0, $count)
            $total += $count
          }
          $file.Flush($true)
        } finally {
          $file.Dispose()
          $stream.Dispose()
        }
        if ($total -ne $PinnedMsiSize) { throw '7-Zip download byte size did not match.' }
        $digest = [BitConverter]::ToString($hash.GetHashAndReset()).Replace('-', '').ToLowerInvariant()
        $hash.Dispose()
        if ($digest -cne $PinnedMsiSha256) { throw '7-Zip download SHA-256 did not match.' }
        return [ordered]@{ finalUri = $current.AbsoluteUri; size = $total; sha256 = $digest }
      } finally {
        $response.Dispose()
      }
    }
    throw '7-Zip download did not complete.'
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Get-AuthenticodeEvidence {
  param([Parameter(Mandatory)][string]$MsiPath)
  $signature = Get-AuthenticodeSignature -LiteralPath $MsiPath
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned -or
      $null -ne $signature.SignerCertificate -or $null -ne $signature.TimeStamperCertificate -or
      $signature.SignatureType.ToString() -cne 'None') {
    throw '7-Zip artifact Authenticode state did not match the pinned unsigned state.'
  }
  return [ordered]@{ status = 'NotSigned' }
}

function Assert-Amd64Pe {
  param([Parameter(Mandatory)][string]$FilePath)
  $stream = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 256 -or $reader.ReadUInt16() -ne 0x5a4d) { throw '7-Zip runtime file is not a PE image.' }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadUInt32()
    if ($peOffset -gt $stream.Length - 6) { throw '7-Zip runtime PE header is invalid.' }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw '7-Zip runtime PE signature is invalid.' }
    if ($reader.ReadUInt16() -ne 0x8664) { throw '7-Zip runtime PE machine is not AMD64.' }
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Get-ExactVersionEvidence {
  param([Parameter(Mandatory)][string]$FilePath)
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($FilePath)
  if ($version.FileVersion -cne $PinnedVersion -or $version.ProductVersion -cne $PinnedVersion) {
    throw '7-Zip runtime version is not the pinned version.'
  }
  return [ordered]@{ fileVersion = $version.FileVersion; productVersion = $version.ProductVersion }
}

function Invoke-7ZipInfo {
  param([Parameter(Mandatory)][string]$Executable)
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Executable
  $start.Arguments = 'i'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw 'Pinned 7-Zip runtime could not start.' }
    $process.StandardInput.Close()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) {
      try { $process.Kill($true) } catch {}
      throw 'Pinned 7-Zip runtime inspection timed out.'
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0 -or $stdout.Length -gt 1048576 -or $stderr.Length -gt 1048576) {
      throw 'Pinned 7-Zip runtime inspection failed.'
    }
    if ($stdout -notmatch '(?m)^7-Zip 26\.02 \(x64\)' -or $stdout -notmatch '(?im)^\s*[^\r\n]*\bZip\b' -or $stdout -notmatch '(?im)^\s*[^\r\n]*\bRar\b') {
      throw 'Pinned 7-Zip runtime lacks required version or archive handlers.'
    }
    return [ordered]@{ version = $PinnedVersion; zip = $true; rar = $true }
  } finally {
    $process.Dispose()
  }
}

function Get-FileRecord {
  param([Parameter(Mandatory)][string]$FilePath)
  $item = Get-Item -LiteralPath $FilePath -Force
  if (-not $item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and $item.Length -gt 0) {
    return [ordered]@{
      size = [Int64]$item.Length
      sha256 = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  throw '7-Zip runtime member is not a positive regular file.'
}

if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) {
  throw '7-Zip acquisition supports only Windows x64.'
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path $temporaryBase ("minecraft-core-7zip-{0}" -f [Guid]::NewGuid().ToString('N'))))
if ([IO.Path]::GetDirectoryName($temporaryRoot) -cne $temporaryBase -or -not $temporaryRoot.StartsWith($temporaryBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw '7-Zip acquisition temporary root is invalid.'
}
[void](New-Item -ItemType Directory -Path $temporaryRoot)

$vendorParent = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'vendor\7zip'))
$vendorTarget = Assert-ContainedPath -Root $repositoryRoot -Candidate (Join-Path $vendorParent 'x64') -Label 'vendor target'
$manifestParent = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'build-resources\archive-runtime'))
$manifestTarget = Assert-ContainedPath -Root $repositoryRoot -Candidate (Join-Path $manifestParent '7zip-26.02.json') -Label 'manifest target'
$stageId = [Guid]::NewGuid().ToString('N')
$vendorStage = Join-Path $vendorParent ".x64.stage-$stageId"
$vendorBackup = Join-Path $vendorParent ".x64.backup-$stageId"
$manifestStage = Join-Path $manifestParent ".7zip-26.02.stage-$stageId.json"
$manifestBackup = Join-Path $manifestParent ".7zip-26.02.backup-$stageId.json"
$publishedVendor = $false
$publishedManifest = $false
$hadVendor = $false
$hadManifest = $false

try {
  $msiPath = Assert-ContainedPath -Root $temporaryRoot -Candidate (Join-Path $temporaryRoot '7z2602-x64.msi') -Label 'MSI path'
  $extractDir = Assert-ContainedPath -Root $temporaryRoot -Candidate (Join-Path $temporaryRoot 'extract') -Label 'extraction directory'
  [void](New-Item -ItemType Directory -Path $extractDir)

  $download = Save-PinnedMsi -Destination $msiPath
  $signature = Get-AuthenticodeEvidence -MsiPath $msiPath
  $install = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/a', $msiPath, '/qn', "TARGETDIR=$extractDir") -Wait -PassThru -WindowStyle Hidden
  if ($install.ExitCode -ne 0) { throw '7-Zip MSI administrative extraction failed.' }

  $matchesByName = [ordered]@{}
  foreach ($name in $ExpectedNames) {
    $matches = @(Get-ChildItem -LiteralPath $extractDir -Recurse -Force -File | Where-Object { $_.Name -ceq $name })
    if ($matches.Count -ne 1) { throw "7-Zip MSI did not contain exactly one $name candidate." }
    $matchesByName[$name] = $matches[0]
  }
  $candidateParent = $matchesByName['7z.exe'].Directory.FullName
  foreach ($name in $ExpectedNames) {
    if (-not [string]::Equals($matchesByName[$name].Directory.FullName, $candidateParent, [StringComparison]::OrdinalIgnoreCase)) {
      throw '7-Zip MSI runtime members are not colocated.'
    }
    $candidatePath = Assert-NoReparsePath -Root $extractDir -Candidate $matchesByName[$name].FullName -Label $name
    if (-not [IO.File]::Exists($candidatePath)) { throw '7-Zip MSI runtime member is not a regular file.' }
  }

  $exePath = $matchesByName['7z.exe'].FullName
  $dllPath = $matchesByName['7z.dll'].FullName
  Assert-Amd64Pe -FilePath $exePath
  Assert-Amd64Pe -FilePath $dllPath
  $exeVersion = Get-ExactVersionEvidence -FilePath $exePath
  $dllVersion = Get-ExactVersionEvidence -FilePath $dllPath
  $exeAuthenticode = Get-AuthenticodeEvidence -MsiPath $exePath
  $dllAuthenticode = Get-AuthenticodeEvidence -MsiPath $dllPath
  $handlers = Invoke-7ZipInfo -Executable $exePath

  [void](New-Item -ItemType Directory -Path $vendorParent -Force)
  [void](New-Item -ItemType Directory -Path $manifestParent -Force)
  if (Test-Path -LiteralPath $vendorStage) { throw '7-Zip vendor staging path already exists.' }
  [void](New-Item -ItemType Directory -Path $vendorStage)
  foreach ($name in $ExpectedNames) {
    Copy-Item -LiteralPath $matchesByName[$name].FullName -Destination (Join-Path $vendorStage $name)
  }

  $fileRecords = [ordered]@{}
  foreach ($name in $ExpectedNames) {
    $sourceRecord = Get-FileRecord -FilePath $matchesByName[$name].FullName
    $publishedRecord = Get-FileRecord -FilePath (Join-Path $vendorStage $name)
    if ($sourceRecord.size -ne $publishedRecord.size -or $sourceRecord.sha256 -cne $publishedRecord.sha256) {
      throw '7-Zip vendor staging changed a runtime member.'
    }
    $fileRecords[$name] = $publishedRecord
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    version = $PinnedVersion
    architecture = 'x64'
    msi = [ordered]@{ url = $PinnedMsiUri.AbsoluteUri; size = $PinnedMsiSize; sha256 = $PinnedMsiSha256 }
    source = [ordered]@{ url = $PinnedSourceUri; sha256 = $PinnedSourceSha256 }
    acquiredAt = [DateTimeOffset]::UtcNow.ToString('o')
    download = [ordered]@{ finalHost = ([Uri]$download.finalUri).IdnHost.ToLowerInvariant(); size = $download.size; sha256 = $download.sha256 }
    authenticode = $signature
    pe = [ordered]@{
      machine = 'AMD64'
      executable = [ordered]@{ fileVersion = $exeVersion.fileVersion; productVersion = $exeVersion.productVersion; authenticodeStatus = $exeAuthenticode.status }
      library = [ordered]@{ fileVersion = $dllVersion.fileVersion; productVersion = $dllVersion.productVersion; authenticodeStatus = $dllAuthenticode.status }
    }
    handlers = $handlers
    files = $fileRecords
  }
  $json = $manifest | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($manifestStage, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

  if (Test-Path -LiteralPath $vendorTarget) {
    $hadVendor = $true
    $existing = @(Get-ChildItem -LiteralPath $vendorTarget -Force)
    if ($existing.Count -ne 3 -or @($existing | Where-Object { $_.Name -cnotin $ExpectedNames }).Count -ne 0) {
      throw 'Existing 7-Zip vendor directory contains unexpected members.'
    }
    Move-Item -LiteralPath $vendorTarget -Destination $vendorBackup
  }
  Move-Item -LiteralPath $vendorStage -Destination $vendorTarget
  $publishedVendor = $true

  if (Test-Path -LiteralPath $manifestTarget) {
    $hadManifest = $true
    Move-Item -LiteralPath $manifestTarget -Destination $manifestBackup
  }
  Move-Item -LiteralPath $manifestStage -Destination $manifestTarget
  $publishedManifest = $true

  if ($hadVendor) { Remove-Item -LiteralPath $vendorBackup -Recurse -Force }
  if ($hadManifest) { Remove-Item -LiteralPath $manifestBackup -Force }

  Write-Output ("Authenticode status: {0}" -f $signature.status)
  Write-Output ("7z.exe Authenticode status: {0}" -f $exeAuthenticode.status)
  Write-Output ("7z.dll Authenticode status: {0}" -f $dllAuthenticode.status)
  foreach ($name in $ExpectedNames) {
    Write-Output ("{0}: {1} bytes sha256 {2}" -f $name, $fileRecords[$name].size, $fileRecords[$name].sha256)
  }
  Write-Output ("7-Zip {0} AMD64 handlers: ZIP={1} RAR={2}" -f $PinnedVersion, $handlers.zip, $handlers.rar)
} catch {
  if ($publishedManifest -and (Test-Path -LiteralPath $manifestTarget)) { Remove-Item -LiteralPath $manifestTarget -Force }
  if ($hadManifest -and (Test-Path -LiteralPath $manifestBackup)) { Move-Item -LiteralPath $manifestBackup -Destination $manifestTarget }
  if ($publishedVendor -and (Test-Path -LiteralPath $vendorTarget)) { Remove-Item -LiteralPath $vendorTarget -Recurse -Force }
  if ($hadVendor -and (Test-Path -LiteralPath $vendorBackup)) { Move-Item -LiteralPath $vendorBackup -Destination $vendorTarget }
  throw
} finally {
  if (Test-Path -LiteralPath $vendorStage) { Remove-Item -LiteralPath $vendorStage -Recurse -Force }
  if (Test-Path -LiteralPath $manifestStage) { Remove-Item -LiteralPath $manifestStage -Force }
  if (Test-Path -LiteralPath $temporaryRoot) {
    $resolvedCleanup = [IO.Path]::GetFullPath($temporaryRoot)
    if ([IO.Path]::GetDirectoryName($resolvedCleanup) -cne $temporaryBase -or -not $resolvedCleanup.StartsWith($temporaryBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Refusing unsafe 7-Zip acquisition cleanup.'
    }
    Remove-Item -LiteralPath $resolvedCleanup -Recurse -Force
  }
}
