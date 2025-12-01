/**
 * electron-builder afterPack hook
 * This runs after the app is built but before packaging
 * Use this to ensure the icon is properly embedded in the exe
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

exports.default = async function(context) {
    // Only process Windows builds
    if (context.electronPlatformName !== 'win32') {
        return;
    }

    const appOutDir = context.appOutDir;
    const exePath = path.join(appOutDir, 'Minecraft Core.exe');
    const iconPath = path.resolve(__dirname, '../build-resources/icon.ico');

    console.log('Running afterPack hook...');
    console.log('Exe path:', exePath);
    console.log('Icon path:', iconPath);

    // Verify files exist
    if (!fs.existsSync(exePath)) {
        console.error('ERROR: Exe not found at', exePath);
        return;
    }

    if (!fs.existsSync(iconPath)) {
        console.error('ERROR: Icon not found at', iconPath);
        return;
    }

    // Use rcedit from node_modules
    try {
        const rcedit = require('rcedit');
        const rceditBin = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', `rcedit-${process.arch === 'ia32' ? 'ia32' : 'x64'}.exe`);

        const applyIcon = async (attempt) => {
            console.log(`Using rcedit to set icon and metadata (attempt ${attempt})...`);
            try {
                await rcedit(exePath, {
                    icon: iconPath,
                    'version-string': {
                        'CompanyName': 'zXord',
                        'FileDescription': 'Minecraft Core',
                        'ProductName': 'Minecraft Core',
                        'InternalName': 'Minecraft Core',
                        'OriginalFilename': 'Minecraft Core.exe'
                    },
                    'file-version': context.packager.appInfo.version,
                    'product-version': context.packager.appInfo.version
                });
                return true;
            } catch (err) {
                console.error(`rcedit attempt ${attempt} failed: ${err.message}`);
                return false;
            }
        };

        const applyIconDirect = async (attempt) => {
            console.log(`Trying direct rcedit binary (attempt ${attempt})...`);
            const args = [
                exePath,
                '--set-icon', iconPath,
                '--set-version-string', 'CompanyName', 'zXord',
                '--set-version-string', 'FileDescription', 'Minecraft Core',
                '--set-version-string', 'ProductName', 'Minecraft Core',
                '--set-version-string', 'InternalName', 'Minecraft Core',
                '--set-version-string', 'OriginalFilename', 'Minecraft Core.exe',
                '--set-file-version', context.packager.appInfo.version,
                '--set-product-version', context.packager.appInfo.version
            ];

            try {
                await execFileAsync(rceditBin, args);
                return true;
            } catch (err) {
                console.error(`Direct rcedit attempt ${attempt} failed: ${err.message}`);
                if (err.stderr) console.error(`stderr: ${err.stderr}`);
                return false;
            }
        };

        // Retry a few times in case AV/IO locks the executable briefly
        let success = false;
        for (let i = 1; i <= 3 && !success; i++) {
            success = await applyIcon(i);
            if (!success) {
                // Small delay before fallback/next attempt
                await new Promise(res => setTimeout(res, 300));
            }
        }

        if (!success) {
            for (let i = 1; i <= 2 && !success; i++) {
                success = await applyIconDirect(i);
                if (!success) {
                    await new Promise(res => setTimeout(res, 300));
                }
            }
        }

        if (success) {
            console.log('Successfully embedded icon and metadata in exe');
        } else {
            console.error('Failed to update exe after multiple attempts');
        }
    } catch (error) {
        console.error('Failed to update exe:', error.message);
        // Don't fail the build, just log the error
    }
};
