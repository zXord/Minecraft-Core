[CmdletBinding()]
param([switch]$PolicySelfTest)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class MinecraftCoreArchiveAcquisitionNative
{
    private const uint OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName, uint desiredAccess, FileShare shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle fileHandle, StringBuilder filePath, uint filePathLength, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle fileHandle, int fileInformationClass,
        out FileAttributeTagInfo fileInformation, uint bufferSize);

    public static string GetFinalPath(string filePath)
    {
        using (SafeFileHandle handle = CreateFileW(
            filePath, 0, FileShare.Read | FileShare.Write | FileShare.Delete, IntPtr.Zero,
            OpenExisting, BackupSemantics, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new IOException("Could not open the controlled path.");
            StringBuilder buffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity) throw new IOException("Could not resolve the controlled path.");
            string result = buffer.ToString();
            if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + result.Substring(8);
            if (result.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return result.Substring(4);
            return result;
        }
    }

    public static bool IsRedirectingReparsePoint(string filePath)
    {
        using (SafeFileHandle handle = CreateFileW(
            filePath, 0, FileShare.Read | FileShare.Write | FileShare.Delete, IntPtr.Zero,
            OpenExisting, BackupSemantics | 0x00200000, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new IOException("Could not inspect the controlled path.");
            FileAttributeTagInfo info;
            if (!GetFileInformationByHandleEx(handle, 9, out info, (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo))))
                throw new IOException("Could not inspect the controlled path tag.");
            const uint ReparsePoint = 0x00000400;
            const uint NameSurrogate = 0x20000000;
            return (info.FileAttributes & ReparsePoint) != 0 && (info.ReparseTag & NameSurrogate) != 0;
        }
    }

    public static async Task<byte[]> ReadBoundedAsync(Stream stream, int maximumBytes, CancellationToken cancellationToken)
    {
        if (stream == null || maximumBytes <= 0) throw new ArgumentException("Invalid bounded stream request.");
        byte[] buffer = new byte[8192];
        using (MemoryStream output = new MemoryStream())
        {
            while (true)
            {
                int count = await stream.ReadAsync(buffer, 0, buffer.Length, cancellationToken).ConfigureAwait(false);
                if (count == 0) return output.ToArray();
                if (output.Length + count > maximumBytes) throw new IOException("Bounded process output exceeded its limit.");
                output.Write(buffer, 0, count);
            }
        }
    }
}
'@

$PinnedMsiUri = [Uri]'https://github.com/ip7z/7zip/releases/download/26.02/7z2602-x64.msi'
$PinnedMsiSize = [Int64]1999872
$PinnedMsiSha256 = 'db407a4f6d4999e5c7bc00ce8a882be94717b56e7fa68140fe3f12605d91643e'
$PinnedSourceUri = 'https://github.com/ip7z/7zip/releases/download/26.02/7z2602-src.7z'
$PinnedSourceSha256 = 'c7502dd4557481f52ccf1b3e680329f1fdd207e79a25544afeb3106325474944'
$PinnedVersion = '26.02'
$ExpectedNames = @('7z.exe', '7z.dll', 'License.txt')
$PinnedPolicySize = [Int64]310
$PinnedPolicySha256 = '4051244573651ad3194ad069cb2dd97cc58a1f777b6e78967d99dce7d94ce5b9'

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

function Test-ContainedOrEqualPath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Candidate
  )
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $resolvedCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  return [string]::Equals($resolvedRoot, $resolvedCandidate, [StringComparison]::OrdinalIgnoreCase) -or
    $resolvedCandidate.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeMutationPath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][string]$Label,
    [switch]$MustExist,
    [ValidateSet('Any', 'File', 'Directory')][string]$Kind = 'Any'
  )
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $resolvedCandidate = Assert-ContainedPath -Root $resolvedRoot -Candidate $Candidate -Label $Label
  if (-not (Test-Path -LiteralPath $resolvedRoot)) { throw "$Label root does not exist." }
  $rootItem = Get-Item -LiteralPath $resolvedRoot -Force
  if (-not $rootItem.PSIsContainer -or [MinecraftCoreArchiveAcquisitionNative]::IsRedirectingReparsePoint($resolvedRoot)) {
    throw "$Label root is not a controlled directory."
  }
  $realRoot = [IO.Path]::GetFullPath([MinecraftCoreArchiveAcquisitionNative]::GetFinalPath($resolvedRoot)).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $cursor = $resolvedCandidate
  $candidateExists = Test-Path -LiteralPath $resolvedCandidate
  if ($MustExist -and -not $candidateExists) { throw "$Label does not exist." }
  while (-not [string]::Equals($cursor, $resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if ([MinecraftCoreArchiveAcquisitionNative]::IsRedirectingReparsePoint($cursor)) { throw "$Label contains a redirecting reparse point." }
      $realCursor = [IO.Path]::GetFullPath([MinecraftCoreArchiveAcquisitionNative]::GetFinalPath($cursor))
      if (-not (Test-ContainedOrEqualPath -Root $realRoot -Candidate $realCursor)) { throw "$Label resolved outside its controlled root." }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrWhiteSpace($cursor)) { throw "$Label escaped its controlled root." }
  }
  if ($candidateExists -and $Kind -ne 'Any') {
    $candidateItem = Get-Item -LiteralPath $resolvedCandidate -Force
    if (($Kind -eq 'Directory' -and -not $candidateItem.PSIsContainer) -or ($Kind -eq 'File' -and $candidateItem.PSIsContainer)) {
      throw "$Label has the wrong object kind."
    }
  }
  return $resolvedCandidate
}

function Assert-SafeTree {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][string]$Label
  )
  $resolved = Assert-SafeMutationPath -Root $Root -Candidate $Candidate -Label $Label -MustExist
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($resolved)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    [void](Assert-SafeMutationPath -Root $Root -Candidate $current -Label $Label -MustExist)
    $item = Get-Item -LiteralPath $current -Force
    if ($item.PSIsContainer) {
      foreach ($child in @(Get-ChildItem -LiteralPath $current -Force)) {
        if ([MinecraftCoreArchiveAcquisitionNative]::IsRedirectingReparsePoint($child.FullName)) { throw "$Label tree contains a redirecting reparse point." }
        $pending.Push($child.FullName)
      }
    }
  }
  return $resolved
}

function New-SafeDirectory {
  param([string]$Root, [string]$Candidate, [string]$Label)
  $resolved = Assert-SafeMutationPath -Root $Root -Candidate $Candidate -Label $Label
  if (Test-Path -LiteralPath $resolved) { throw "$Label already exists." }
  [void](New-Item -ItemType Directory -Path $resolved)
  return Assert-SafeMutationPath -Root $Root -Candidate $resolved -Label $Label -MustExist -Kind Directory
}

function Move-SafeItem {
  param([string]$Root, [string]$Source, [string]$Destination, [string]$Label)
  $resolvedSource = Assert-SafeMutationPath -Root $Root -Candidate $Source -Label "$Label source" -MustExist
  $sourceItem = Get-Item -LiteralPath $resolvedSource -Force
  if ($sourceItem.PSIsContainer) { [void](Assert-SafeTree -Root $Root -Candidate $resolvedSource -Label "$Label source tree") }
  $resolvedDestination = Assert-SafeMutationPath -Root $Root -Candidate $Destination -Label "$Label destination"
  if (Test-Path -LiteralPath $resolvedDestination) { throw "$Label destination already exists." }
  Move-Item -LiteralPath $resolvedSource -Destination $resolvedDestination
  $published = Assert-SafeMutationPath -Root $Root -Candidate $resolvedDestination -Label "$Label published destination" -MustExist
  if ($sourceItem.PSIsContainer) { [void](Assert-SafeTree -Root $Root -Candidate $published -Label "$Label published tree") }
  return $published
}

function Remove-SafeItem {
  param([string]$Root, [string]$Candidate, [string]$Label, [switch]$Recurse)
  if (-not (Test-Path -LiteralPath $Candidate)) { return }
  if ($Recurse) { $resolved = Assert-SafeTree -Root $Root -Candidate $Candidate -Label $Label }
  else { $resolved = Assert-SafeMutationPath -Root $Root -Candidate $Candidate -Label $Label -MustExist }
  Remove-Item -LiteralPath $resolved -Recurse:$Recurse -Force
  [void](Assert-SafeMutationPath -Root $Root -Candidate $resolved -Label "$Label removed path")
}

function Invoke-PolicyContainmentSelfTest {
  $testParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $testRoot = Join-Path $testParent ("minecraft-core-7zip-policy-{0}" -f [Guid]::NewGuid().ToString('N'))
  $controlled = Join-Path $testRoot 'controlled'
  $outside = Join-Path $testRoot 'outside'
  $junction = Join-Path $controlled 'redirect'
  try {
    [void](New-Item -ItemType Directory -Path $testRoot)
    [void](New-Item -ItemType Directory -Path $controlled)
    [void](New-Item -ItemType Directory -Path $outside)
    [IO.File]::WriteAllText((Join-Path $outside 'marker.txt'), 'outside')
    [void](New-Item -ItemType Junction -Path $junction -Target $outside)
    $rejected = $false
    try {
      [void](Assert-SafeMutationPath -Root $controlled -Candidate (Join-Path $junction 'marker.txt') -Label 'self-test redirect' -MustExist -Kind File)
    } catch {
      $rejected = $true
    }
    if (-not $rejected -or -not [IO.File]::Exists((Join-Path $outside 'marker.txt'))) {
      throw '7-Zip acquisition containment self-test failed.'
    }
    [IO.Directory]::Delete($junction)
    Remove-SafeItem -Root $testParent -Candidate $testRoot -Label 'policy self-test cleanup' -Recurse
    Write-Output '7-Zip acquisition containment self-test passed.'
  } finally {
    if (Test-Path -LiteralPath $junction) {
      try { [IO.Directory]::Delete($junction) } catch {}
    }
    if (Test-Path -LiteralPath $testRoot) {
      try { Remove-SafeItem -Root $testParent -Candidate $testRoot -Label 'policy self-test final cleanup' -Recurse } catch {}
    }
  }
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
  $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('Minecraft-Core-Archive-Runtime-Acquisition/1')
  $current = $PinnedMsiUri
  $downloadCancellation = [Threading.CancellationTokenSource]::new($DownloadDeadlineMs)
  try {
    for ($hop = 0; $hop -le $MaxRedirects; $hop++) {
      Assert-AllowedDownloadUri -Uri $current -Initial:($hop -eq 0)
      $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $current)
      try {
        $response = $client.SendAsync(
          $request,
          [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
          $downloadCancellation.Token
        ).GetAwaiter().GetResult()
      } finally {
        $request.Dispose()
      }
      $hash = $null
      try {
        $status = [int]$response.StatusCode
        if ($status -in @(301, 302, 303, 307, 308)) {
          if ($hop -eq $MaxRedirects) { throw '7-Zip download exceeded the redirect limit.' }
          [Collections.Generic.IEnumerable[string]]$locationValues = $null
          if (-not $response.Headers.TryGetValues('Location', [ref]$locationValues)) {
            throw '7-Zip download returned a missing or ambiguous redirect.'
          }
          $locations = @($locationValues)
          if ($locations.Count -ne 1 -or [string]::IsNullOrWhiteSpace($locations[0])) {
            throw '7-Zip download returned a missing or ambiguous redirect.'
          }
          $next = [Uri]::new($current, $locations[0])
          Assert-AllowedDownloadUri -Uri $next -Initial:$false
          $current = $next
          continue
        }
        if ($status -ne 200) { throw '7-Zip download did not return the pinned artifact.' }
        $finalHost = $current.IdnHost.ToLowerInvariant()
        if ($finalHost -notin $AllowedFinalHosts) { throw '7-Zip download final host is not allowed.' }
        if ($null -ne $response.Content.Headers.ContentLength -and [Int64]$response.Content.Headers.ContentLength -ne $PinnedMsiSize) {
          throw '7-Zip download declared an unexpected size.'
        }

        $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $file = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = [byte[]]::new(65536)
        [Int64]$total = 0
        try {
          while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $downloadCancellation.Token).GetAwaiter().GetResult()) -gt 0) {
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
        if ($digest -cne $PinnedMsiSha256) { throw '7-Zip download SHA-256 did not match.' }
        return [ordered]@{ finalUri = $current.AbsoluteUri; size = $total; sha256 = $digest }
      } finally {
        if ($null -ne $hash) { $hash.Dispose() }
        $response.Dispose()
      }
    }
    throw '7-Zip download did not complete.'
  } finally {
    $downloadCancellation.Dispose()
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
  $outputCancellation = [Threading.CancellationTokenSource]::new()
  $started = $false
  try {
    if (-not $process.Start()) { throw 'Pinned 7-Zip runtime could not start.' }
    $started = $true
    $process.StandardInput.Close()
    $stdoutTask = [MinecraftCoreArchiveAcquisitionNative]::ReadBoundedAsync(
      $process.StandardOutput.BaseStream,
      1048576,
      $outputCancellation.Token
    )
    $stderrTask = [MinecraftCoreArchiveAcquisitionNative]::ReadBoundedAsync(
      $process.StandardError.BaseStream,
      1048576,
      $outputCancellation.Token
    )
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.WaitForExit(50)) {
      if ($stdoutTask.IsFaulted -or $stdoutTask.IsCanceled -or $stderrTask.IsFaulted -or $stderrTask.IsCanceled -or $watch.ElapsedMilliseconds -ge 30000) {
        $outputCancellation.Cancel()
        try { $process.Kill() } catch {}
        if (-not $process.WaitForExit(5000)) { throw 'Pinned 7-Zip runtime did not terminate.' }
        throw 'Pinned 7-Zip runtime inspection exceeded a safety bound.'
      }
    }
    $stdoutBytes = $stdoutTask.GetAwaiter().GetResult()
    $stderrBytes = $stderrTask.GetAwaiter().GetResult()
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $stdout = $strictUtf8.GetString($stdoutBytes)
    $stderr = $strictUtf8.GetString($stderrBytes)
    if ($process.ExitCode -ne 0 -or $stdoutBytes.Length -gt 1048576 -or $stderrBytes.Length -gt 1048576 -or $stderr.Length -ne 0) {
      throw 'Pinned 7-Zip runtime inspection failed.'
    }
    if ($stdout -notmatch '(?m)^7-Zip 26\.02 \(x64\)' -or $stdout -notmatch '(?im)^\s*[^\r\n]*\bZip\b' -or $stdout -notmatch '(?im)^\s*[^\r\n]*\bRar\b') {
      throw 'Pinned 7-Zip runtime lacks required version or archive handlers.'
    }
    return [ordered]@{ version = $PinnedVersion; zip = $true; rar = $true }
  } finally {
    $outputCancellation.Cancel()
    if ($started -and -not $process.HasExited) {
      try { $process.Kill() } catch {}
      try { [void]$process.WaitForExit(5000) } catch {}
    }
    $outputCancellation.Dispose()
    $process.Dispose()
  }
}

function Get-FileRecord {
  param([Parameter(Mandatory)][string]$FilePath)
  $item = Get-Item -LiteralPath $FilePath -Force
  if (-not $item.PSIsContainer -and -not [MinecraftCoreArchiveAcquisitionNative]::IsRedirectingReparsePoint($FilePath) -and $item.Length -gt 0) {
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
if ($PolicySelfTest) {
  Invoke-PolicyContainmentSelfTest
  exit 0
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([IO.Path]::DirectorySeparatorChar)
$repositoryItem = Get-Item -LiteralPath $repositoryRoot -Force
if (-not $repositoryItem.PSIsContainer -or [MinecraftCoreArchiveAcquisitionNative]::IsRedirectingReparsePoint($repositoryRoot)) {
  throw '7-Zip acquisition repository root is not a controlled directory.'
}
$policyPath = Assert-SafeMutationPath -Root $repositoryRoot -Candidate (Join-Path $repositoryRoot 'build-resources\archive-runtime\7zip-download-policy.json') -Label 'download policy' -MustExist -Kind File
$policyRecord = Get-FileRecord -FilePath $policyPath
if ($policyRecord.size -ne $PinnedPolicySize -or $policyRecord.sha256 -cne $PinnedPolicySha256) {
  throw '7-Zip download policy identity changed.'
}
$policy = Get-Content -LiteralPath $policyPath -Raw -Encoding UTF8 | ConvertFrom-Json
$policyKeys = @($policy.PSObject.Properties.Name | Sort-Object)
$expectedPolicyKeys = @('deadlineMs', 'finalHosts', 'initialUrl', 'maxRedirects', 'redirectHosts', 'schemaVersion')
if (Compare-Object -ReferenceObject $expectedPolicyKeys -DifferenceObject $policyKeys -SyncWindow 0) { throw '7-Zip download policy schema changed.' }
if ($policy.schemaVersion -ne 1 -or $policy.initialUrl -cne $PinnedMsiUri.AbsoluteUri -or
    $policy.maxRedirects -ne 5 -or $policy.deadlineMs -ne 300000 -or
    @($policy.redirectHosts).Count -ne 2 -or $policy.redirectHosts[0] -cne 'github.com' -or $policy.redirectHosts[1] -cne 'release-assets.githubusercontent.com' -or
    @($policy.finalHosts).Count -ne 1 -or $policy.finalHosts[0] -cne 'release-assets.githubusercontent.com') {
  throw '7-Zip download policy values changed.'
}
$AllowedRedirectHosts = @($policy.redirectHosts)
$AllowedFinalHosts = @($policy.finalHosts)
$MaxRedirects = [int]$policy.maxRedirects
$DownloadDeadlineMs = [int]$policy.deadlineMs

$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path $temporaryBase ("minecraft-core-7zip-{0}" -f [Guid]::NewGuid().ToString('N'))))
if ([IO.Path]::GetDirectoryName($temporaryRoot) -cne $temporaryBase -or -not $temporaryRoot.StartsWith($temporaryBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw '7-Zip acquisition temporary root is invalid.'
}
$temporaryRoot = New-SafeDirectory -Root $temporaryBase -Candidate $temporaryRoot -Label 'acquisition temporary root'

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
$commitComplete = $false
$postCommitCleanupError = $null

try {
  $msiPath = Assert-ContainedPath -Root $temporaryRoot -Candidate (Join-Path $temporaryRoot '7z2602-x64.msi') -Label 'MSI path'
  $extractDir = Assert-ContainedPath -Root $temporaryRoot -Candidate (Join-Path $temporaryRoot 'extract') -Label 'extraction directory'
  $extractDir = New-SafeDirectory -Root $temporaryRoot -Candidate $extractDir -Label 'extraction directory'

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
    $candidatePath = Assert-SafeMutationPath -Root $extractDir -Candidate $matchesByName[$name].FullName -Label $name -MustExist -Kind File
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

  [void](Assert-SafeMutationPath -Root $repositoryRoot -Candidate $vendorParent -Label 'vendor parent' -MustExist -Kind Directory)
  [void](Assert-SafeMutationPath -Root $repositoryRoot -Candidate $manifestParent -Label 'manifest parent' -MustExist -Kind Directory)
  if (Test-Path -LiteralPath $vendorStage) { throw '7-Zip vendor staging path already exists.' }
  $vendorStage = New-SafeDirectory -Root $repositoryRoot -Candidate $vendorStage -Label 'vendor staging directory'
  foreach ($name in $ExpectedNames) {
    $sourcePath = Assert-SafeMutationPath -Root $extractDir -Candidate $matchesByName[$name].FullName -Label "$name extraction source" -MustExist -Kind File
    $destinationPath = Assert-SafeMutationPath -Root $repositoryRoot -Candidate (Join-Path $vendorStage $name) -Label "$name staging destination"
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
    [void](Assert-SafeMutationPath -Root $repositoryRoot -Candidate $destinationPath -Label "$name staged file" -MustExist -Kind File)
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
  [void](Assert-SafeMutationPath -Root $repositoryRoot -Candidate $manifestStage -Label 'manifest staging file')
  [IO.File]::WriteAllText($manifestStage, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  [void](Assert-SafeMutationPath -Root $repositoryRoot -Candidate $manifestStage -Label 'manifest staging file' -MustExist -Kind File)

  if (Test-Path -LiteralPath $vendorTarget) {
    $hadVendor = $true
    [void](Assert-SafeTree -Root $repositoryRoot -Candidate $vendorTarget -Label 'existing vendor runtime')
    $existing = @(Get-ChildItem -LiteralPath $vendorTarget -Force)
    if ($existing.Count -ne 3 -or @($existing | Where-Object { $_.Name -cnotin $ExpectedNames }).Count -ne 0) {
      throw 'Existing 7-Zip vendor directory contains unexpected members.'
    }
    [void](Move-SafeItem -Root $repositoryRoot -Source $vendorTarget -Destination $vendorBackup -Label 'vendor backup')
  }
  [void](Move-SafeItem -Root $repositoryRoot -Source $vendorStage -Destination $vendorTarget -Label 'vendor publication')
  $publishedVendor = $true

  if (Test-Path -LiteralPath $manifestTarget) {
    $hadManifest = $true
    [void](Assert-SafeMutationPath -Root $repositoryRoot -Candidate $manifestTarget -Label 'existing manifest' -MustExist -Kind File)
    [void](Move-SafeItem -Root $repositoryRoot -Source $manifestTarget -Destination $manifestBackup -Label 'manifest backup')
  }
  [void](Move-SafeItem -Root $repositoryRoot -Source $manifestStage -Destination $manifestTarget -Label 'manifest publication')
  $publishedManifest = $true

  [void](Assert-SafeTree -Root $repositoryRoot -Candidate $vendorTarget -Label 'published vendor runtime')
  [void](Assert-SafeMutationPath -Root $repositoryRoot -Candidate $manifestTarget -Label 'published manifest' -MustExist -Kind File)
  $commitComplete = $true

  Write-Output ("Authenticode status: {0}" -f $signature.status)
  Write-Output ("7z.exe Authenticode status: {0}" -f $exeAuthenticode.status)
  Write-Output ("7z.dll Authenticode status: {0}" -f $dllAuthenticode.status)
  foreach ($name in $ExpectedNames) {
    Write-Output ("{0}: {1} bytes sha256 {2}" -f $name, $fileRecords[$name].size, $fileRecords[$name].sha256)
  }
  Write-Output ("7-Zip {0} AMD64 handlers: ZIP={1} RAR={2}" -f $PinnedVersion, $handlers.zip, $handlers.rar)
} catch {
  $publicationError = $_
  $rollbackFailed = $false
  if (-not $commitComplete) {
    try {
      if ($publishedManifest -and (Test-Path -LiteralPath $manifestTarget)) { Remove-SafeItem -Root $repositoryRoot -Candidate $manifestTarget -Label 'failed manifest publication' }
      if ($hadManifest -and (Test-Path -LiteralPath $manifestBackup)) { [void](Move-SafeItem -Root $repositoryRoot -Source $manifestBackup -Destination $manifestTarget -Label 'manifest rollback') }
      if ($publishedVendor -and (Test-Path -LiteralPath $vendorTarget)) { Remove-SafeItem -Root $repositoryRoot -Candidate $vendorTarget -Label 'failed vendor publication' -Recurse }
      if ($hadVendor -and (Test-Path -LiteralPath $vendorBackup)) { [void](Move-SafeItem -Root $repositoryRoot -Source $vendorBackup -Destination $vendorTarget -Label 'vendor rollback') }
    } catch {
      $rollbackFailed = $true
    }
  }
  if ($rollbackFailed) { throw '7-Zip publication rollback was incomplete; controlled backups were retained.' }
  throw $publicationError
} finally {
  if (Test-Path -LiteralPath $vendorStage) { Remove-SafeItem -Root $repositoryRoot -Candidate $vendorStage -Label 'vendor staging cleanup' -Recurse }
  if (Test-Path -LiteralPath $manifestStage) { Remove-SafeItem -Root $repositoryRoot -Candidate $manifestStage -Label 'manifest staging cleanup' }
  if (Test-Path -LiteralPath $temporaryRoot) {
    $resolvedCleanup = [IO.Path]::GetFullPath($temporaryRoot)
    if ([IO.Path]::GetDirectoryName($resolvedCleanup) -cne $temporaryBase -or -not $resolvedCleanup.StartsWith($temporaryBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Refusing unsafe 7-Zip acquisition cleanup.'
    }
    Remove-SafeItem -Root $temporaryBase -Candidate $resolvedCleanup -Label 'acquisition temporary cleanup' -Recurse
  }
}

if ($commitComplete) {
  try {
    if ($hadVendor -and (Test-Path -LiteralPath $vendorBackup)) { Remove-SafeItem -Root $repositoryRoot -Candidate $vendorBackup -Label 'retired vendor backup' -Recurse }
    if ($hadManifest -and (Test-Path -LiteralPath $manifestBackup)) { Remove-SafeItem -Root $repositoryRoot -Candidate $manifestBackup -Label 'retired manifest backup' }
  } catch {
    $postCommitCleanupError = $_
  }
}
if ($null -ne $postCommitCleanupError) {
  throw '7-Zip runtime was published, but a controlled backup could not be removed and was retained for diagnosis.'
}
