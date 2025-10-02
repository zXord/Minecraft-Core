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
    const iconPath = path.resolve(__dirname, '../build/icon.ico');

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
        
        console.log('Using rcedit to set icon...');
        await rcedit(exePath, {
            icon: iconPath
        });
        
        console.log('Successfully embedded icon in exe');
    } catch (error) {
        console.error('Failed to update exe icon:', error.message);
        // Don't fail the build, just log the error
    }
};
