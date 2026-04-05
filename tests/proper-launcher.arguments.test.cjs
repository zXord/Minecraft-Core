const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  buildLaunchReplacements,
  expandVersionArguments
} = require('../electron/services/minecraft-launcher/proper-launcher.cjs');

test('proper launcher replacements include the Forge library directory token', () => {
  const clientPath = path.join('C:', 'Minecraft', 'Client');
  const replacements = buildLaunchReplacements({
    authData: {
      name: 'player',
      uuid: 'uuid',
      access_token: 'token'
    },
    clientPath,
    launchJson: {
      assetIndex: { id: '1.20.1' },
      type: 'release'
    },
    launchVersion: '1.20.1-forge-47.4.18',
    minecraftVersion: '1.20.1',
    nativesDir: path.join(clientPath, 'versions', '1.20.1-forge-47.4.18', 'natives'),
    classpathSeparator: ';',
    classpathValue: 'A;B'
  });

  assert.equal(replacements.library_directory, path.join(clientPath, 'libraries'));
});

test('proper launcher expands Forge module-path placeholders before launch', () => {
  const clientPath = path.join('C:', 'Minecraft', 'Client');
  const replacements = buildLaunchReplacements({
    authData: {
      name: 'player',
      uuid: 'uuid',
      access_token: 'token'
    },
    clientPath,
    launchJson: {
      assetIndex: { id: '1.20.1' },
      type: 'release'
    },
    launchVersion: '1.20.1-forge-47.4.18',
    minecraftVersion: '1.20.1',
    nativesDir: path.join(clientPath, 'versions', '1.20.1-forge-47.4.18', 'natives'),
    classpathSeparator: ';',
    classpathValue: 'A;B'
  });

  const args = expandVersionArguments([
    '-DlibraryDirectory=${library_directory}',
    '-p',
    '${library_directory}/cpw/mods/bootstraplauncher.jar${classpath_separator}${library_directory}/cpw/mods/securejarhandler.jar'
  ], replacements);

  assert.deepEqual(args, [
    `-DlibraryDirectory=${path.join(clientPath, 'libraries')}`,
    '-p',
    `${path.join(clientPath, 'libraries')}/cpw/mods/bootstraplauncher.jar;${path.join(clientPath, 'libraries')}/cpw/mods/securejarhandler.jar`
  ]);
});
