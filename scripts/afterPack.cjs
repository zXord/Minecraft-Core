/**
 * electron-builder afterPack hook
 * This runs after the app is built but before packaging
 * Use this to ensure the icon is properly embedded in the exe
 */

const path = require('path');
const fs = require('fs');

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
        
        console.log('Using rcedit to set icon and metadata...');
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
        
        console.log('Successfully embedded icon and metadata in exe');
    } catch (error) {
        console.error('Failed to update exe:', error.message);
        // Don't fail the build, just log the error
    }
};
