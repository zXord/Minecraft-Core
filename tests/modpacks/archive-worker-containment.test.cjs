const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ArchiveWorkerClient,
  verifyArchiveWorkerExecutable
} = require('../../electron/services/modpacks/archive/archive-worker-client.cjs');
const { WindowsDurableFsClient } = require('../../electron/utils/windows-durable-fs-client.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workerPath = path.join(repositoryRoot, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe');
const workerManifestPath = path.join(repositoryRoot, 'build-resources', 'archive-runtime', 'archive-worker-x64.json');

function copyPackagedArchiveResources(targetRoot) {
  const archiveRoot = path.join(targetRoot, 'archive');
  for (const [source, destination] of [
    ['vendor/7zip/x64', '7zip'],
    ['vendor/archive-worker/x64', 'worker'],
    ['third-party/7zip', 'licenses'],
    ['build-resources/archive-runtime', 'manifests']
  ]) {
    fs.cpSync(path.join(repositoryRoot, source), path.join(archiveRoot, destination), { recursive: true });
  }
  return archiveRoot;
}

test('worker manifest is closed and matches the exact AMD64 executable', async () => {
  const verified = await verifyArchiveWorkerExecutable({ workerPath, workerManifestPath });
  const bytes = fs.readFileSync(workerPath);
  assert.equal(verified.architecture, 'x64');
  assert.equal(verified.runtimeIdentifier, 'win-x64');
  assert.equal(verified.targetFramework, 'net8.0-windows');
  assert.equal(verified.file.size, bytes.length);
  assert.equal(verified.file.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(bytes.readUInt16LE(0), 0x5a4d);
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt32LE(pe), 0x00004550);
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664);
});

test('worker build script pins the SDK, publishes one self-contained AMD64 executable, self-tests, and safely stages exact outputs', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'build-archive-worker.ps1'), 'utf8');
  assert.match(source, /10\.0\.204/);
  assert.match(source, /dotnet @publishArguments/);
  assert.match(source, /--self-contained', 'true'/);
  assert.match(source, /publishedEntries\.Count -ne 1/);
  assert.match(source, /Assert-Amd64Pe/);
  assert.match(source, /--build-self-test/);
  assert.match(source, /ProcessStartInfo/);
  assert.match(source, /RedirectStandardOutput\s*=\s*\$true/);
  assert.match(source, /RedirectStandardError\s*=\s*\$true/);
  assert.match(source, /CreateNoWindow\s*=\s*\$true/);
  assert.match(source, /Assert-Within/);
  assert.match(source, /\.ArchiveWorker\.stage-/);
  assert.match(source, /\.archive-worker-x64\.stage-/);
  assert.doesNotMatch(source, /Remove-Item[^\r\n]*(?:-Recurse|-r\b)/i);
  assert.doesNotMatch(source, /& \$published\.FullName '--build-self-test'/);
});

test('worker verification fails closed for tampered executable or manifest and has no PATH fallback', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copiedWorker = path.join(root, 'ArchiveWorker.exe');
  const copiedManifest = path.join(root, 'archive-worker-x64.json');
  fs.copyFileSync(workerPath, copiedWorker);
  fs.copyFileSync(workerManifestPath, copiedManifest);
  fs.appendFileSync(copiedWorker, Buffer.from([0]));
  await assert.rejects(
    verifyArchiveWorkerExecutable({ workerPath: copiedWorker, workerManifestPath: copiedManifest }),
    error => error.code === 'EXTRACTOR_UNAVAILABLE'
  );
  fs.copyFileSync(workerPath, copiedWorker);
  const manifest = JSON.parse(fs.readFileSync(copiedManifest, 'utf8'));
  manifest.extra = true;
  fs.writeFileSync(copiedManifest, JSON.stringify(manifest));
  await assert.rejects(
    verifyArchiveWorkerExecutable({ workerPath: copiedWorker, workerManifestPath: copiedManifest }),
    error => error.code === 'EXTRACTOR_UNAVAILABLE'
  );
});

test('live AppContainer self-test proves every required containment property', { timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sentinel = path.join(root, 'user-data-sentinel.txt');
  fs.writeFileSync(sentinel, 'must remain private');
  const client = new ArchiveWorkerClient({
    workerPath,
    workerManifestPath,
    resourcesRoot: repositoryRoot
  });
  const evidence = await client.selfTest({ resourcesRoot: repositoryRoot, userDataSentinel: sentinel });
  assert.deepEqual(evidence, {
    appContainer: true,
    zeroCapabilities: true,
    exactInputRead: true,
    exactOutputWrite: true,
    ambientTempReadDenied: true,
    ambientTempWriteDenied: true,
    userDataReadDenied: true,
    userDataWriteDenied: true,
    loopbackDenied: true,
    descendantsDenied: true,
    unrelatedEnvironmentAbsent: true,
    unrelatedHandlesAbsent: true,
    bundleExtractionIsolated: true,
    standardInputClosed: true,
    cleanupKilledSurvivors: true,
    temporaryAclRemoved: true,
    profileStoreClean: true,
    publishedOutputAclClean: true
  });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must remain private');
});

test('live AppContainer self-test consumes the exact packaged runtime layout', { timeout: 120000 }, async (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-packaged-live-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const archiveRoot = copyPackagedArchiveResources(resourcesPath);
  const sentinel = path.join(resourcesPath, 'user-data-sentinel.txt');
  fs.writeFileSync(sentinel, 'must remain private');
  const client = new ArchiveWorkerClient({
    workerPath: path.join(archiveRoot, 'worker', 'ArchiveWorker.exe'),
    workerManifestPath: path.join(archiveRoot, 'manifests', 'archive-worker-x64.json'),
    resourcesRoot: archiveRoot,
    runtimeLayout: 'packaged',
    appOwnedRoot: path.join(resourcesPath, 'app-owned')
  });

  const evidence = await client.selfTest({ resourcesRoot: archiveRoot, userDataSentinel: sentinel });
  assert.equal(Object.values(evidence).every(Boolean), true);
});

test('native restart recovery reclaims an exited-owner workspace without touching siblings', { timeout: 30000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-recovery-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  fs.mkdirSync(appOwnedRoot);
  const sentinel = path.join(root, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'outside');
  const leaseId = 'stale-workspace-1';

  const preserve = childProcess.spawnSync(workerPath, ['--preserve-workspace-fixture', appOwnedRoot, leaseId], {
    shell: false, windowsHide: true, encoding: null, timeout: 15000
  });
  assert.equal(preserve.status, 0, preserve.stderr?.toString('utf8'));
  assert.equal(fs.existsSync(path.join(appOwnedRoot, 'operations', leaseId)), true);

  const recover = childProcess.spawnSync(workerPath, ['--cancelled-staging-self-test', appOwnedRoot], {
    shell: false, windowsHide: true, encoding: null, timeout: 15000
  });
  assert.equal(recover.status, 0, recover.stderr?.toString('utf8'));
  assert.equal(fs.existsSync(path.join(appOwnedRoot, 'operations', leaseId)), false);
  assert.deepEqual(fs.readdirSync(path.join(appOwnedRoot, 'operation-leases')), []);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside');
});

test('native restart recovery preserves a stale journal and fails closed on a dangling workspace junction', { timeout: 30000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-recovery-junction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  fs.mkdirSync(appOwnedRoot);
  const leaseId = 'stale-workspace-junction';
  const workspaceRoot = path.join(appOwnedRoot, 'operations', leaseId);
  const journalPath = path.join(appOwnedRoot, 'operation-leases', `${leaseId}.workspace`);

  const preserve = childProcess.spawnSync(workerPath, ['--preserve-workspace-fixture', appOwnedRoot, leaseId], {
    shell: false, windowsHide: true, encoding: null, timeout: 15000
  });
  assert.equal(preserve.status, 0, preserve.stderr?.toString('utf8'));
  fs.rmSync(workspaceRoot, { recursive: true, force: false });
  fs.symlinkSync(path.join(root, 'missing-target'), workspaceRoot, 'junction');
  assert.equal(fs.existsSync(workspaceRoot), false, 'the junction must be dangling for this regression');
  assert.equal(fs.lstatSync(workspaceRoot).isSymbolicLink(), true);

  const recover = childProcess.spawnSync(workerPath, ['--cancelled-staging-self-test', appOwnedRoot], {
    shell: false, windowsHide: true, encoding: null, timeout: 15000
  });
  assert.notEqual(recover.status, 0, 'recovery must fail closed instead of accepting the dangling entry as absent');
  assert.equal(fs.lstatSync(workspaceRoot).isSymbolicLink(), true);
  assert.equal(fs.existsSync(journalPath), true, 'ownership proof must be retained when the tree is not safely reclaimable');
});

test('native cancellation interrupts staging before any artifact copy', { timeout: 30000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-cancelled-staging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  fs.mkdirSync(appOwnedRoot);

  const result = childProcess.spawnSync(workerPath, ['--cancelled-staging-self-test', appOwnedRoot], {
    shell: false, windowsHide: true, encoding: null, timeout: 15000
  });

  assert.equal(result.status, 0, result.stderr?.toString('utf8'));
  assert.deepEqual(fs.readdirSync(path.join(appOwnedRoot, 'operations')), []);
  assert.deepEqual(fs.readdirSync(path.join(appOwnedRoot, 'operation-leases')), []);
});

test('native cancellation interrupts runtime verification and staging before any engine copy', { timeout: 30000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-cancelled-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  fs.mkdirSync(appOwnedRoot);

  const result = childProcess.spawnSync(workerPath, ['--cancelled-runtime-self-test', repositoryRoot, appOwnedRoot], {
    shell: false, windowsHide: true, encoding: null, timeout: 15000
  });

  assert.equal(result.status, 0, result.stderr?.toString('utf8'));
  assert.deepEqual(fs.readdirSync(appOwnedRoot), []);
});

test('native source uses AppContainer, STARTUPINFOEX, explicit handles, suspended Job assignment, and no process fallback', () => {
  const nativeRoot = path.join(repositoryRoot, 'native', 'ArchiveWorker');
  const all = fs.readdirSync(path.join(nativeRoot, 'Sandbox')).filter(name => name.endsWith('.cs'))
    .map(name => fs.readFileSync(path.join(nativeRoot, 'Sandbox', name), 'utf8')).join('\n');
  assert.match(all, /CreateAppContainerProfile/);
  assert.match(all, /DeriveAppContainerSidFromAppContainerName/);
  assert.match(all, /ProcThreadAttributeSecurityCapabilities/);
  assert.match(all, /ProcThreadAttributeHandleList/);
  assert.match(all, /ProcThreadAttributeChildProcessPolicy/);
  const launch = fs.readFileSync(path.join(nativeRoot, 'Sandbox', 'SandboxedProcess.cs'), 'utf8');
  assert.doesNotMatch(launch, /UpdateProcThreadAttribute\([^;]*ProcThreadAttributeChildProcessPolicy/s);
  assert.doesNotMatch(launch, /childPolicyPointer/);
  assert.match(fs.readFileSync(path.join(nativeRoot, 'Program.cs'), 'utf8'), /DescendantsDenied\s*=\s*descendantsDenied/);
  assert.match(all, /ExtendedStartupInfoPresent/);
  assert.match(all, /CreateSuspended/);
  assert.match(all, /CreateNoWindow/);
  assert.match(all, /CreateUnicodeEnvironment/);
  assert.match(all, /AssignProcessToJobObject/);
  assert.match(all, /ResumeThread/);
  assert.match(all, /JobObjectLimitKillOnJobClose/);
  assert.match(all, /JobObjectLimitActiveProcess/);
  assert.doesNotMatch(all, /Process\.Start|cmd\.exe|powershell(?:\.exe)?/i);
});

test('native ACL authority is an exact journaled lease with stale-owner recovery and fail-stop quiescence', () => {
  const nativeRoot = path.join(repositoryRoot, 'native', 'ArchiveWorker');
  const sandbox = fs.readdirSync(path.join(nativeRoot, 'Sandbox')).filter(name => name.endsWith('.cs'))
    .map(name => fs.readFileSync(path.join(nativeRoot, 'Sandbox', name), 'utf8')).join('\n');
  const program = fs.readFileSync(path.join(nativeRoot, 'Program.cs'), 'utf8');
  assert.match(sandbox, /AclLeaseJournal/);
  assert.match(sandbox, /ProcessStartTimeUtcTicks/);
  assert.match(sandbox, /RecoverStale/);
  assert.match(sandbox, /GetAclInformation/);
  assert.match(sandbox, /GetAce/);
  assert.match(sandbox, /AddAccessAllowedAceEx/);
  assert.match(sandbox, /DeleteAppContainerProfile/);
  assert.match(sandbox, /ProcessIdentity\.State\(parsed\.Owner\)/);
  assert.match(sandbox, /live or ambiguous/);
  assert.match(sandbox, /0 or 1 or 2 or 3 or 16 or 17 or 18 or 19/);
  assert.match(sandbox, /ScrubFreshTree/);
  assert.match(sandbox, /ScrubDescendants/);
  assert.match(sandbox, /AclCompletionPolicy\.Complete/);
  assert.match(sandbox, /profile-security\.lock/);
  assert.match(sandbox, /FileShareNone/);
  assert.match(sandbox, /CrossSessionProfileLock/);
  assert.doesNotMatch(sandbox, /originalDacl|GrantTraverseAncestors/);
  assert.match(program, /Environment\.FailFast/);
  assert.match(program, /PreserveForRecovery/);
});

test('ACL journal directory flush opens a write-capable handle required by FlushFileBuffers', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Sandbox', 'AclLease.cs'), 'utf8');
  const start = source.indexOf('private static void FlushDirectory(');
  const end = source.indexOf('private static void TryDeleteFile(', start);
  const flush = source.slice(start, end);
  assert.match(flush, /CreateFile\(NativeFilePath\.ForApi\(directory\),\s*NativeMethods\.GenericWrite/);
  assert.match(flush, /FlushFileBuffers\(handle\)/);
});

test('profile reset treats a derived SID with no profile store as an absent profile before recreate', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Sandbox', 'AppContainerProfile.cs'), 'utf8');
  assert.match(source, /TryGetProfileFolder/);
  assert.match(source, /result is FileNotFoundHResult or NotFoundHResult/);
  assert.match(source, /DeleteAppContainerProfile\(ProfileName\)/);
  assert.match(source, /if \(folder is not null && Directory\.Exists\(folder\)\)/);
});

test('ACL journal records the file-specific mask Windows persists instead of generic access bits', () => {
  const sandboxRoot = path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Sandbox');
  const lease = fs.readFileSync(path.join(sandboxRoot, 'AclLease.cs'), 'utf8');
  const policy = fs.readFileSync(path.join(sandboxRoot, 'AclAccessMaskPolicy.cs'), 'utf8');
  assert.match(lease, /mask\s*=\s*AclAccessMaskPolicy\.MapFile\(mask\)/);
  assert.match(policy, /FileGenericRead\s*=\s*0x00120089/);
  assert.match(policy, /FileGenericWrite\s*=\s*0x00120116/);
  assert.match(policy, /FileGenericExecute\s*=\s*0x001200a0/);
  assert.match(policy, /GenericRead\s*=\s*0x80000000/);
  assert.match(policy, /GenericWrite\s*=\s*0x40000000/);
  assert.match(policy, /GenericExecute\s*=\s*0x20000000/);
});

test('self-test evidence is measured from token, EOF, job termination, profile deletion, and post-publish ACLs', () => {
  const nativeRoot = path.join(repositoryRoot, 'native', 'ArchiveWorker');
  const program = fs.readFileSync(path.join(nativeRoot, 'Program.cs'), 'utf8');
  const sandboxed = fs.readFileSync(path.join(nativeRoot, 'Sandbox', 'SandboxedProcess.cs'), 'utf8');
  const methods = fs.readFileSync(path.join(nativeRoot, 'Sandbox', 'NativeMethods.cs'), 'utf8');
  assert.match(program, /TokenCapabilities/);
  assert.match(program, /Console\.OpenStandardInput\(\)\.ReadByte\(\) == -1/);
  assert.match(program, /ProcessIdentity\.State\(killedIdentity/);
  assert.match(program, /HasNoAllowForSid/);
  assert.doesNotMatch(program, /MINECRAFT_CORE_CAPABILITY_COUNT/);
  assert.doesNotMatch(program, /CleanupKilledSurvivors\s*=\s*true|TemporaryAclRemoved\s*=\s*true/);
  assert.match(sandboxed, /if \(jobAssigned\)/);
  assert.match(sandboxed, /TerminateProcess/);
  assert.match(methods, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JobObjectLimitKillOnJobClose/);
  assert.doesNotMatch(methods, /BREAKAWAY_OK|BreakawayOk/);
});

test('control channel has an authenticated heartbeat deadline and always joins its monitor', () => {
  const program = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Program.cs'), 'utf8');
  assert.match(program, /ControlHeartbeatTimeout/);
  assert.match(program, /CancelAfter\(ControlHeartbeatTimeout\)/);
  assert.match(program, /finally[\s\S]*controlStop\.Cancel\(\)[\s\S]*await controlTask/);
});

test('command factory names only the exact colocated runtime and emits no dangerous switches', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'SevenZip', 'SevenZipCommandFactory.cs'), 'utf8');
  assert.match(source, /7z\.exe/);
  assert.match(source, /-tzip/);
  assert.match(source, /"rar4"\s*=>\s*"-trar"/);
  assert.match(source, /"rar5"\s*=>\s*"-trar5"/);
  assert.match(source, /-bso0/);
  assert.match(source, /-bse2/);
  assert.match(source, /-smemx2g/);
  assert.match(source, /-sccUTF-8/);
  assert.match(source, /-slt/);
  assert.match(source, /"--"/);
  assert.doesNotMatch(source, /-sni/i, '7-Zip 26.02 exposes -sni without a supported negative form');
  assert.doesNotMatch(source, /7za(?:\.exe)?|7zr(?:\.exe)?|\s-p\{|-spf|-snl|-snh|-sns(?!-)/i);
});

test('durable filesystem performs absent-target move, existing-file replacement, and directory flush', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-live-'));
  try {
    const client = new WindowsDurableFsClient({ workerPath, workerManifestPath, allowedRoots: [root] });
    const sourceFile = path.join(root, 'source.txt');
    const movedFile = path.join(root, 'moved.txt');
    fs.writeFileSync(sourceFile, 'new');
    client.moveWriteThrough(sourceFile, movedFile);
    assert.equal(fs.existsSync(sourceFile), false);
    assert.equal(fs.readFileSync(movedFile, 'utf8'), 'new');

    const replacement = path.join(root, 'replacement.txt');
    const oldTargetIdentity = fs.statSync(movedFile, { bigint: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    fs.writeFileSync(replacement, 'replacement');
    const replacementIdentity = fs.statSync(replacement, { bigint: true });
    assert.notEqual(replacementIdentity.birthtimeNs, oldTargetIdentity.birthtimeNs);
    client.replaceFileWriteThrough(replacement, movedFile);
    assert.equal(fs.existsSync(replacement), false);
    assert.equal(fs.readFileSync(movedFile, 'utf8'), 'replacement');
    const publishedIdentity = fs.statSync(movedFile, { bigint: true });
    assert.equal(publishedIdentity.dev, replacementIdentity.dev);
    assert.equal(publishedIdentity.ino, replacementIdentity.ino);
    client.flushDirectory(root);

    const sourceDirectory = path.join(root, 'source-dir');
    const movedDirectory = path.join(root, 'moved-dir');
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, 'entry'), 'x');
    client.moveWriteThrough(sourceDirectory, movedDirectory);
    assert.equal(fs.readFileSync(path.join(movedDirectory, 'entry'), 'utf8'), 'x');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('durable directory flush tolerates concurrent child metadata changes without weakening stable identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-live-directory-race-'));
  try {
    let injected = false;
    const client = new WindowsDurableFsClient({
      workerPath,
      workerManifestPath,
      allowedRoots: [root],
      spawnSync(executable, args, options) {
        if (!injected) {
          injected = true;
          fs.mkdirSync(path.join(root, 'concurrent-chromium-entry'));
        }
        return childProcess.spawnSync(executable, args, options);
      }
    });

    client.flushDirectory(root);

    assert.equal(injected, true);
    assert.equal(fs.statSync(path.join(root, 'concurrent-chromium-entry')).isDirectory(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('durable primitives reject each other\'s target contract, unsafe paths, and links', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-negative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = new WindowsDurableFsClient({ workerPath, workerManifestPath, allowedRoots: [root] });
  const source = path.join(root, 'source.txt');
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(source, 'source');
  fs.writeFileSync(target, 'target');
  assert.throws(() => client.moveWriteThrough(source, target), error => error.code === 'COMMIT_FAILED');
  fs.rmSync(target);
  assert.throws(() => client.replaceFileWriteThrough(source, target), error => error.code === 'COMMIT_FAILED');
  assert.throws(() => client.moveWriteThrough(source, source), error => error.code === 'COMMIT_FAILED');
  assert.throws(() => client.flushDirectory(path.parse(root).root), error => error.code === 'COMMIT_FAILED');
  assert.throws(() => client.moveWriteThrough('\\\\server\\share\\a', target), error => error.code === 'COMMIT_FAILED');
  assert.throws(() => client.moveWriteThrough(`${source}:stream`, target), error => error.code === 'COMMIT_FAILED');

  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(root, link, 'junction');
    assert.throws(() => client.flushDirectory(link), error => error.code === 'COMMIT_FAILED');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
});

test('durable publication refuses held source or destination writers before mutating either name', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = new WindowsDurableFsClient({ workerPath, workerManifestPath, allowedRoots: [root] });

  const moveSource = path.join(root, 'move-source.txt');
  const moveDestination = path.join(root, 'move-destination.txt');
  fs.writeFileSync(moveSource, 'move-source');
  const moveWriter = fs.openSync(moveSource, 'r+');
  try {
    assert.throws(() => client.moveWriteThrough(moveSource, moveDestination), error => error.code === 'COMMIT_FAILED');
  } finally {
    fs.closeSync(moveWriter);
  }
  assert.equal(fs.readFileSync(moveSource, 'utf8'), 'move-source');
  assert.equal(fs.existsSync(moveDestination), false);

  const replacement = path.join(root, 'replacement.txt');
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(replacement, 'replacement');
  fs.writeFileSync(target, 'old-target');
  const targetWriter = fs.openSync(target, 'r+');
  try {
    assert.throws(() => client.replaceFileWriteThrough(replacement, target), error => error.code === 'COMMIT_FAILED');
  } finally {
    fs.closeSync(targetWriter);
  }
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-target');

  const sourceWriter = fs.openSync(replacement, 'r+');
  try {
    assert.throws(() => client.replaceFileWriteThrough(replacement, target), error => error.code === 'COMMIT_FAILED');
  } finally {
    fs.closeSync(sourceWriter);
  }
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-target');
});

test('durable client is synchronous, bounded, hidden, and has no Node rename fallback', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'electron', 'utils', 'windows-durable-fs-client.cjs'), 'utf8');
  assert.match(source, /spawnSync/);
  assert.match(source, /shell:\s*false/);
  assert.match(source, /windowsHide:\s*true/);
  assert.match(source, /timeout:/);
  assert.doesNotMatch(source, /renameSync|copyFileSync|COPY_ALLOWED|cmd\.exe|powershell/i);
});

test('native durable operations pin no-follow identities immediately before and after publication', () => {
  const nativeRoot = path.join(repositoryRoot, 'native', 'ArchiveWorker');
  const durability = fs.readFileSync(path.join(nativeRoot, 'Durability', 'DurableFilesystem.cs'), 'utf8');
  const methods = fs.readFileSync(path.join(nativeRoot, 'Sandbox', 'NativeMethods.cs'), 'utf8');
  assert.match(durability, /DurableExpectedIdentity/);
  assert.match(durability, /AllowedRootIdentities/);
  assert.match(durability, /Revalidate\(requirePath:\s*true/);
  assert.match(durability, /SamePublishedObject/);
  assert.match(durability, /DurableAncestorPins/);
  assert.match(durability, /deleteAccess:\s*true/);
  assert.match(durability, /pinWrite:\s*true/);
  assert.match(durability, /pinRename:\s*true/);
  assert.match(durability, /FileRenameReplaceIfExists\s*\|\s*NativeMethods\.FileRenamePosixSemantics/);
  assert.match(durability, /Encoding\.Unicode\.GetBytes\(destinationPath\)/);
  assert.match(durability, /Marshal\.WriteIntPtr\(buffer,\s*8,\s*nint\.Zero\)/);
  assert.match(durability, /existingDestination[\s\S]*?pinWrite:\s*true,\s*pinRename:\s*false/);
  assert.match(durability, /committedSource\s*=\s*source\.CaptureCurrent\(\)/);
  assert.match(durability, /TryCompletion\(sourceParent\.Flush/);
  assert.match(durability, /TryCompletion\(destinationParent\.Flush/);
  assert.match(methods, /FILE_FLAG_OPEN_REPARSE_POINT|FileFlagOpenReparsePoint/);
  assert.match(methods, /GetFileInformationByHandleEx/);
  assert.match(methods, /SetFileInformationByHandle/);
  assert.match(methods, /FileRenameInfoEx/);
  assert.doesNotMatch(methods, /ReplaceFileW|MoveFileExW/);
});

test('handle-bound publication has preventive substitution pins and one crash-atomic namespace mutation', () => {
  const durability = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Durability', 'DurableFilesystem.cs'), 'utf8');
  const moveStart = durability.indexOf('private static void Move(');
  const rename = durability.indexOf('HandleBoundRename.Move(', moveStart);
  const sourceValidation = durability.indexOf('source.Revalidate(requirePath: true)', moveStart);
  const destinationValidation = durability.indexOf('existingDestination?.Revalidate(requirePath: true)', moveStart);
  const oldObjectValidation = durability.indexOf('existingDestination.Revalidate(requirePath: false)', rename);
  const parentFlush = durability.indexOf('TryCompletion(sourceParent.Flush', rename);
  assert.ok(moveStart >= 0 && sourceValidation > moveStart && destinationValidation > sourceValidation);
  assert.ok(rename > destinationValidation && oldObjectValidation > rename && parentFlush > oldObjectValidation);
  assert.equal((durability.match(/HandleBoundRename\.Move\(/g) || []).length, 1);
  assert.equal((durability.match(/NativeMethods\.SetFileInformationByHandle\(/g) || []).length, 1);
  assert.match(durability, /FileShareRead\s*\|\s*\(pinWrite \? 0u : NativeMethods\.FileShareWrite\)/);
  assert.doesNotMatch(durability, /ReplaceFile|MoveFileEx|backupFile|recoveryBackup/);
});

test('native path policy rejects raw dot traversal before normalization for move, replace, and flush inputs', () => {
  const canonical = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Security', 'CanonicalPaths.cs'), 'utf8');
  const policy = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Security', 'PathInputPolicy.cs'), 'utf8');
  const durability = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Durability', 'DurableFilesystem.cs'), 'utf8');
  assert.match(policy, /Split\(\['\\\\', '\/'\]/);
  assert.ok(canonical.indexOf('PathInputPolicy.HasTraversalAlias(value)') < canonical.indexOf('Path.GetFullPath(value)'));
  assert.match(durability, /CanonicalPaths\.ExistingFile\(request\.DestinationPath!/);
  assert.match(durability, /CanonicalPaths\.AbsentDestination\(request\.DestinationPath!/);
  assert.match(durability, /DurablePinnedObject\.Open\(request\.SourcePath!/);
  assert.match(durability, /DurablePinnedObject\.Open\(request\.DirectoryPath!/);
});

test('native reparse policy accepts stable metadata tags but rejects every name-surrogate tag', () => {
  const securityRoot = path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Security');
  const policy = fs.readFileSync(path.join(securityRoot, 'ReparsePointPolicy.cs'), 'utf8');
  const tags = fs.readFileSync(path.join(securityRoot, 'ReparseTagPolicy.cs'), 'utf8');
  const methods = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Sandbox', 'NativeMethods.cs'), 'utf8');
  assert.match(methods, /FileAttributeTagInfo\s*=\s*9/);
  assert.match(policy, /CaptureAllowed/);
  assert.match(policy, /GetFileAttributeTagInformation/);
  assert.match(policy, /GetFileInformationByHandle/);
  assert.match(policy, /before\s*!=\s*after/);
  assert.match(tags, /NameSurrogateMask\s*=\s*0x20000000/);
  assert.match(policy, /ReparseTagPolicy\.IsNameSurrogate/);
});
