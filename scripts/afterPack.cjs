/**
 * electron-builder afterPack hook
 * This runs after the app is built but before packaging
 * Use this to ensure the icon is properly embedded in the exe
 */

const path = require('path');
const fsPromises = require('node:fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { verifyPackagedArchive } = require('./verify-packaged-archive.cjs');

const execFileAsync = promisify(execFile);

const WINDOWS_ICON_VERIFICATION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-IconDigest([string]$Path, [bool]$Associated) {
    if ($Associated) {
        $icon = [Drawing.Icon]::ExtractAssociatedIcon($Path)
    } else {
        $icon = [Drawing.Icon]::new($Path)
    }
    if ($null -eq $icon) { throw 'Windows did not return an icon.' }
    try {
        $bitmap = $icon.ToBitmap()
        try {
            $stream = [IO.MemoryStream]::new()
            try {
                $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
                $sha256 = [Security.Cryptography.SHA256]::Create()
                try {
                    $digest = [BitConverter]::ToString($sha256.ComputeHash($stream.ToArray())).Replace('-', '')
                } finally {
                    $sha256.Dispose()
                }
                return "$($bitmap.Width)x$($bitmap.Height):$digest"
            } finally {
                $stream.Dispose()
            }
        } finally {
            $bitmap.Dispose()
        }
    } finally {
        $icon.Dispose()
    }
}

$expected = Get-IconDigest -Path $env:MINECRAFT_CORE_EXPECTED_ICON -Associated $false
$actual = Get-IconDigest -Path $env:MINECRAFT_CORE_PACKAGED_EXE -Associated $true
if (-not [string]::Equals($expected, $actual, [StringComparison]::Ordinal)) {
    throw 'The executable icon does not match the expected application icon.'
}
[Console]::Out.Write('matched')
`;

function packagingError(code, message, cause) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    error.code = code;
    return error;
}

async function assertExactRegularFile(filePath, code, label) {
    try {
        const stats = await fsPromises.lstat(filePath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
            throw packagingError(code, `${label} is not one exact regular file`);
        }
    } catch (error) {
        if (error?.code === code) throw error;
        throw packagingError(code, `${label} is missing`, error);
    }
}

async function verifyWindowsExecutableIcon({
    exePath,
    iconPath,
    platform = process.platform,
    systemRoot = process.env.SystemRoot || process.env.WINDIR
} = {}) {
    try {
        if (platform !== 'win32' || typeof systemRoot !== 'string' || systemRoot.length < 3) {
            throw new Error('Native Windows icon verification is unavailable');
        }
        const powerShellPath = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const { stdout } = await execFileAsync(powerShellPath, [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy', 'Bypass',
            '-Command', WINDOWS_ICON_VERIFICATION_SCRIPT
        ], {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 64 * 1024,
            env: {
                ...process.env,
                MINECRAFT_CORE_EXPECTED_ICON: iconPath,
                MINECRAFT_CORE_PACKAGED_EXE: exePath
            }
        });
        if (stdout !== 'matched') throw new Error('Native Windows icon verification returned invalid evidence');
        return Object.freeze({
            type: 'windows-native-icon-verification',
            version: 1,
            status: 'matched'
        });
    } catch (error) {
        if (error?.code === 'PACKAGED_ICON_VERIFICATION_FAILED') throw error;
        throw packagingError(
            'PACKAGED_ICON_VERIFICATION_FAILED',
            'Native Windows icon verification failed',
            error
        );
    }
}

function executableMetadata(version) {
    return {
        'version-string': {
            CompanyName: 'zXord',
            FileDescription: 'Minecraft Core',
            ProductName: 'Minecraft Core',
            InternalName: 'Minecraft Core',
            OriginalFilename: 'Minecraft Core.exe'
        },
        'file-version': version,
        'product-version': version
    };
}

async function editWithRceditModule({ exePath, iconPath, version }) {
    const rcedit = require('rcedit');
    await rcedit(exePath, { ...executableMetadata(version), icon: iconPath });
}

async function editWithRceditBinary({ exePath, iconPath, version }) {
    const binaryName = process.arch === 'ia32' ? 'rcedit.exe' : 'rcedit-x64.exe';
    const rceditBinary = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', binaryName);
    await execFileAsync(rceditBinary, [
        exePath,
        '--set-icon', iconPath,
        '--set-version-string', 'CompanyName', 'zXord',
        '--set-version-string', 'FileDescription', 'Minecraft Core',
        '--set-version-string', 'ProductName', 'Minecraft Core',
        '--set-version-string', 'InternalName', 'Minecraft Core',
        '--set-version-string', 'OriginalFilename', 'Minecraft Core.exe',
        '--set-file-version', version,
        '--set-product-version', version
    ], { windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 });
}

const DEFAULT_EDIT_STRATEGIES = Object.freeze([
    Object.freeze({ name: 'rcedit module', attempts: 3, edit: editWithRceditModule }),
    Object.freeze({ name: 'rcedit binary', attempts: 2, edit: editWithRceditBinary })
]);

async function hardenWindowsExecutable({ appOutDir, iconPath, version }, {
    editStrategies = DEFAULT_EDIT_STRATEGIES,
    verifyEmbeddedIcon = verifyWindowsExecutableIcon,
    delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    logger = console
} = {}) {
    const exePath = path.join(appOutDir, 'Minecraft Core.exe');
    await assertExactRegularFile(exePath, 'PACKAGED_EXECUTABLE_MISSING', 'Packaged executable');
    await assertExactRegularFile(iconPath, 'PACKAGED_ICON_MISSING', 'Windows application icon');

    let lastFailure;
    for (const strategy of editStrategies) {
        for (let attempt = 1; attempt <= strategy.attempts; attempt += 1) {
            try {
                await strategy.edit({ exePath, iconPath, version });
                await verifyEmbeddedIcon({ exePath, iconPath });
                return Object.freeze({
                    type: 'windows-executable-icon-verification',
                    version: 1,
                    status: 'verified'
                });
            } catch (error) {
                lastFailure = error;
                logger.error(`${strategy.name} attempt ${attempt} failed: ${error?.message || 'unknown error'}`);
                await delay(300);
            }
        }
    }
    if (lastFailure?.code === 'PACKAGED_ICON_VERIFICATION_FAILED') throw lastFailure;
    throw packagingError('PACKAGED_ICON_EMBED_FAILED', 'Windows executable icon embedding failed', lastFailure);
}

exports.hardenWindowsExecutable = hardenWindowsExecutable;
exports.verifyWindowsExecutableIcon = verifyWindowsExecutableIcon;

function createAfterPackHook({
    verifyPackagedArchive: verifyArchive = verifyPackagedArchive,
    hardenWindowsExecutable: hardenExecutable = hardenWindowsExecutable,
    iconPath = path.resolve(__dirname, '../build-resources/icon.ico')
} = {}) {
    return async function afterPackHook(context) {
        // Preserve the release-critical archive gate before mutating the executable.
        const archiveEvidence = await verifyArchive({
            appOutDir: context.appOutDir,
            architecture: context.arch,
            platform: context.electronPlatformName
        });
        if (context.electronPlatformName !== 'win32') return archiveEvidence;
        return hardenExecutable({
            appOutDir: context.appOutDir,
            iconPath,
            version: context.packager.appInfo.version
        });
    };
}

exports.createAfterPackHook = createAfterPackHook;
exports.default = createAfterPackHook();
