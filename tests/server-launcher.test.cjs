const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveLaunchPlan } = require('../electron/services/server-launcher.cjs');

function makeTempForgeServer() {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-forge-'));
  const forgeDir = path.join(
    serverPath,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    '1.20.1-47.4.18'
  );

  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'user_jvm_args.txt'), '# test\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'win_args.txt'), '-p libraries/a.jar;libraries/b.jar\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'unix_args.txt'), '-p libraries/a.jar:libraries/b.jar\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'run.bat'), '@echo off\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'run.sh'), '#!/bin/sh\n', 'utf8');

  return serverPath;
}

test('resolveLaunchPlan prefers platform-specific Forge args files', () => {
  const serverPath = makeTempForgeServer();

  try {
    const plan = resolveLaunchPlan(serverPath, {
      loader: 'forge',
      maxRam: 4,
      minecraftVersion: '1.20.1',
      loaderVersion: '47.4.18'
    });

    const expectedArgsFile = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';

    assert.equal(plan.type, 'forge');
    assert.equal(path.basename(plan.assets.forgeArgs), expectedArgsFile);
    assert.match(
      plan.args.find((arg) => typeof arg === 'string' && arg.startsWith('@libraries')),
      new RegExp(`${expectedArgsFile.replace('.', '\\.')}$`)
    );
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});
