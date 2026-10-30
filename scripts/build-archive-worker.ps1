[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$OperationRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'archive-worker-manifest.ps1')

function Resolve-ExactDirectory {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer) { throw "$Label is not a directory" }
  return [IO.Path]::GetFullPath($item.FullName)
}

function Assert-Within {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  if (-not $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "$Label escaped the repository" }
  return $candidateFull
}

function Assert-RegularExactFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedParent,
    [Parameter(Mandatory = $true)][string]$ExpectedName,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $full = [IO.Path]::GetFullPath($Path)
  if (-not [string]::Equals([IO.Path]::GetDirectoryName($full), [IO.Path]::GetFullPath($ExpectedParent), [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([IO.Path]::GetFileName($full), $ExpectedName, [StringComparison]::Ordinal)) { throw "$Label path is not exact" }
  $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Length -lt 1 -or $null -ne $item.LinkType) { throw "$Label is not a regular file" }
  $resolved = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $full -ErrorAction Stop).Path)
  if (-not [string]::Equals($resolved, $full, [StringComparison]::OrdinalIgnoreCase)) { throw "$Label redirects" }
  return $item
}

function Assert-Amd64Pe {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $reader = [IO.BinaryReader]::new($stream)
    try {
      if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'ArchiveWorker PE header is missing' }
      $stream.Position = 0x3c
      $offset = $reader.ReadInt32()
      if ($offset -lt 0x40 -or $offset -gt ($stream.Length - 6)) { throw 'ArchiveWorker PE offset is invalid' }
      $stream.Position = $offset
      if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'ArchiveWorker is not AMD64 PE' }
    } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
}

function ConvertTo-WindowsProcessArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value.IndexOf([char]0) -ge 0) { throw 'Process argument contains NUL' }
  $builder = [Text.StringBuilder]::new($Value.Length + 2)
  [void]$builder.Append([char]34)
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) { $backslashes++; continue }
    if ($character -eq [char]34) {
      [void]$builder.Append([char]92, ($backslashes * 2) + 1)
      [void]$builder.Append([char]34)
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) { [void]$builder.Append([char]92, $backslashes); $backslashes = 0 }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) { [void]$builder.Append([char]92, $backslashes * 2) }
  [void]$builder.Append([char]34)
  return $builder.ToString()
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw 'ArchiveWorker can only be built on Windows x64'
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryRoot = Resolve-ExactDirectory -Path $repositoryRoot -Label 'repository root'
if ([string]::IsNullOrWhiteSpace($OperationRoot)) {
  $temporaryParent = Join-Path $repositoryRoot '.tmp'
  if (-not (Test-Path -LiteralPath $temporaryParent)) { New-Item -ItemType Directory -Path $temporaryParent -ErrorAction Stop | Out-Null }
  $temporaryParent = Resolve-ExactDirectory -Path $temporaryParent -Label 'temporary parent'
  $OperationRoot = Join-Path $temporaryParent ("awb-{0}" -f [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $OperationRoot -ErrorAction Stop | Out-Null
}
$operationRootFull = Assert-Within -Root $repositoryRoot -Candidate $OperationRoot -Label 'operation root'
$operationRootFull = Resolve-ExactDirectory -Path $operationRootFull -Label 'operation root'
if ((Get-ChildItem -LiteralPath $operationRootFull -Force -ErrorAction Stop | Measure-Object).Count -ne 0) { throw 'Operation root must be empty' }

$projectRoot = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $repositoryRoot 'native\ArchiveWorker') -Label 'project root'
$projectRoot = Resolve-ExactDirectory -Path $projectRoot -Label 'project root'
$projectFile = Join-Path $projectRoot 'ArchiveWorker.csproj'
$sdkFile = Join-Path $projectRoot 'global.json'
foreach ($required in @($projectFile, $sdkFile)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'ArchiveWorker build input is missing' }
}

$publishRoot = Join-Path $operationRootFull 'publish'
$selfTestRoot = Join-Path $operationRootFull 'self-test'
$logsRoot = Join-Path $operationRootFull 'logs'
New-Item -ItemType Directory -Path $publishRoot, $selfTestRoot, $logsRoot -ErrorAction Stop | Out-Null

$sdkLog = Join-Path $logsRoot 'dotnet-sdk.txt'
$publishLog = Join-Path $logsRoot 'dotnet-publish.log'
$selfTestOut = Join-Path $logsRoot 'worker-self-test.stdout.log'
$selfTestErr = Join-Path $logsRoot 'worker-self-test.stderr.log'
$sourceDigest = Get-ArchiveWorkerSourceDigest -SourceRoot $projectRoot

Push-Location -LiteralPath $projectRoot
try {
  $sdkVersion = (& dotnet --version 2>&1 | Out-String).Trim()
  [IO.File]::WriteAllText($sdkLog, $sdkVersion + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  if ($LASTEXITCODE -ne 0 -or $sdkVersion -ne '10.0.204') { throw 'Pinned .NET SDK 10.0.204 is unavailable' }
  $publishArguments = @(
    'publish', $projectFile,
    '--configuration', 'Release',
    '--runtime', 'win-x64',
    '--self-contained', 'true',
    '--output', $publishRoot,
    '--nologo'
  )
  & dotnet @publishArguments *> $publishLog
  if ($LASTEXITCODE -ne 0) { throw 'ArchiveWorker publish failed' }
} finally {
  Pop-Location
}

$publishedEntries = @(Get-ChildItem -LiteralPath $publishRoot -Force -ErrorAction Stop)
if ($publishedEntries.Count -ne 1) { throw 'ArchiveWorker publish output was not exactly one file' }
$published = Assert-RegularExactFile -Path $publishedEntries[0].FullName -ExpectedParent $publishRoot -ExpectedName 'ArchiveWorker.exe' -Label 'published worker'
Assert-Amd64Pe -Path $published.FullName
$publishedHash = (Get-FileHash -LiteralPath $published.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
$publishedSize = [long]$published.Length
if ($publishedSize -lt 1 -or $publishedHash -notmatch '^[a-f0-9]{64}$') { throw 'ArchiveWorker identity is invalid' }

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $published.FullName
$startInfo.Arguments = (@('--build-self-test', $repositoryRoot, $selfTestRoot) | ForEach-Object { ConvertTo-WindowsProcessArgument -Value $_ }) -join ' '
$startInfo.WorkingDirectory = $publishRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
$startInfo.Environment['DOTNET_BUNDLE_EXTRACT_BASE_DIR'] = $published.FullName
$selfTestProcess = [Diagnostics.Process]::new()
$selfTestProcess.StartInfo = $startInfo
$selfTestTimedOut = $false
try {
  if (-not $selfTestProcess.Start()) { throw 'ArchiveWorker self-test did not start' }
  $stdoutTask = $selfTestProcess.StandardOutput.ReadToEndAsync()
  $stderrTask = $selfTestProcess.StandardError.ReadToEndAsync()
  if (-not $selfTestProcess.WaitForExit(360000)) {
    $selfTestTimedOut = $true
    try { $selfTestProcess.Kill() } catch { }
    [void]$selfTestProcess.WaitForExit(30000)
  }
  $selfTestStdout = $stdoutTask.GetAwaiter().GetResult()
  $selfTestStderr = $stderrTask.GetAwaiter().GetResult()
  [IO.File]::WriteAllText($selfTestOut, $selfTestStdout, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($selfTestErr, $selfTestStderr, [Text.UTF8Encoding]::new($false))
  if ($selfTestTimedOut) { throw 'ArchiveWorker self-test timed out' }
  $selfTestExit = $selfTestProcess.ExitCode
} finally {
  $selfTestProcess.Dispose()
}
if ($selfTestExit -ne 0) { throw "ArchiveWorker self-test failed with exit $selfTestExit" }
if ($selfTestStdout.Length -ne 0 -or $selfTestStderr.Length -ne 0) { throw 'ArchiveWorker self-test emitted unexpected output' }
if ((Get-ArchiveWorkerSourceDigest -SourceRoot $projectRoot).Sha256 -cne $sourceDigest.Sha256) { throw 'ArchiveWorker sources changed during the build' }

$vendorRoot = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $repositoryRoot 'vendor') -Label 'vendor root'
$workerParent = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $vendorRoot 'archive-worker') -Label 'worker parent'
$workerDirectory = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $workerParent 'x64') -Label 'worker directory'
foreach ($directory in @($vendorRoot, $workerParent, $workerDirectory)) {
  if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null }
  [void](Resolve-ExactDirectory -Path $directory -Label 'worker publication directory')
}
$workerTarget = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $workerDirectory 'ArchiveWorker.exe') -Label 'worker target'
$workerStage = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $workerDirectory (".ArchiveWorker.stage-{0}.exe" -f [Guid]::NewGuid().ToString('N'))) -Label 'worker stage'
[IO.File]::Copy($published.FullName, $workerStage, $false)
$stagedWorker = Assert-RegularExactFile -Path $workerStage -ExpectedParent $workerDirectory -ExpectedName ([IO.Path]::GetFileName($workerStage)) -Label 'staged worker'
Assert-Amd64Pe -Path $stagedWorker.FullName
if ($stagedWorker.Length -ne $publishedSize -or (Get-FileHash -LiteralPath $stagedWorker.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $publishedHash) {
  throw 'Staged ArchiveWorker identity changed'
}
if (Test-Path -LiteralPath $workerTarget) {
  [void](Assert-RegularExactFile -Path $workerTarget -ExpectedParent $workerDirectory -ExpectedName 'ArchiveWorker.exe' -Label 'existing worker')
}
Move-Item -LiteralPath $workerStage -Destination $workerTarget -Force -ErrorAction Stop
$finalWorker = Assert-RegularExactFile -Path $workerTarget -ExpectedParent $workerDirectory -ExpectedName 'ArchiveWorker.exe' -Label 'final worker'
Assert-Amd64Pe -Path $finalWorker.FullName
if ($finalWorker.Length -ne $publishedSize -or (Get-FileHash -LiteralPath $finalWorker.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $publishedHash) {
  throw 'Published ArchiveWorker identity changed'
}

$manifestDirectory = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $repositoryRoot 'build-resources\archive-runtime') -Label 'manifest directory'
$manifestDirectory = Resolve-ExactDirectory -Path $manifestDirectory -Label 'manifest directory'
$manifestTarget = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $manifestDirectory 'archive-worker-x64.json') -Label 'manifest target'
$manifestStage = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $manifestDirectory (".archive-worker-x64.stage-{0}.json" -f [Guid]::NewGuid().ToString('N'))) -Label 'manifest stage'
$manifestText = Format-ArchiveWorkerManifest -Size $publishedSize -Sha256 $publishedHash
[IO.File]::WriteAllText($manifestStage, $manifestText, [Text.UTF8Encoding]::new($false))
$stagedManifest = Assert-RegularExactFile -Path $manifestStage -ExpectedParent $manifestDirectory -ExpectedName ([IO.Path]::GetFileName($manifestStage)) -Label 'staged manifest'
if ($stagedManifest.Length -gt 65536) { throw 'ArchiveWorker manifest is too large' }
if (Test-Path -LiteralPath $manifestTarget) {
  [void](Assert-RegularExactFile -Path $manifestTarget -ExpectedParent $manifestDirectory -ExpectedName 'archive-worker-x64.json' -Label 'existing manifest')
}
Move-Item -LiteralPath $manifestStage -Destination $manifestTarget -Force -ErrorAction Stop

# Ties the committed exe to these sources: CI ships the exe without rebuilding it, and verify:archive-worker
# fails when native/ArchiveWorker no longer matches this record.
$nativeRoot = Resolve-ExactDirectory -Path (Assert-Within -Root $repositoryRoot -Candidate (Join-Path $repositoryRoot 'native') -Label 'native root') -Label 'native root'
$sourceDigestTarget = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $repositoryRoot 'native\archive-worker-source-digest.json') -Label 'source digest target'
$sourceDigestStage = Assert-Within -Root $repositoryRoot -Candidate (Join-Path $nativeRoot (".archive-worker-source-digest.stage-{0}.json" -f [Guid]::NewGuid().ToString('N'))) -Label 'source digest stage'
$sourceDigestText = Format-ArchiveWorkerSourceDigest -Digest $sourceDigest -WorkerSize $publishedSize -WorkerSha256 $publishedHash
[IO.File]::WriteAllText($sourceDigestStage, $sourceDigestText, [Text.UTF8Encoding]::new($false))
[void](Assert-RegularExactFile -Path $sourceDigestStage -ExpectedParent $nativeRoot -ExpectedName ([IO.Path]::GetFileName($sourceDigestStage)) -Label 'staged source digest')
if (Test-Path -LiteralPath $sourceDigestTarget) {
  [void](Assert-RegularExactFile -Path $sourceDigestTarget -ExpectedParent $nativeRoot -ExpectedName 'archive-worker-source-digest.json' -Label 'existing source digest')
}
Move-Item -LiteralPath $sourceDigestStage -Destination $sourceDigestTarget -Force -ErrorAction Stop

$identityRecord = [ordered]@{
  schemaVersion = 1
  worker = [ordered]@{ size = $publishedSize; sha256 = $publishedHash }
  manifest = 'build-resources/archive-runtime/archive-worker-x64.json'
  executable = 'vendor/archive-worker/x64/ArchiveWorker.exe'
  sourceDigest = $sourceDigest.Sha256
}
[IO.File]::WriteAllText((Join-Path $operationRootFull 'build-result.json'), ($identityRecord | ConvertTo-Json -Depth 3) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Output ("ArchiveWorker built: size={0} sha256={1}" -f $publishedSize, $publishedHash)
Write-Output ("Evidence root: {0}" -f $operationRootFull)
