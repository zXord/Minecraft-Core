const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  ArchiveWorkerClient,
  verifyArchiveWorkerExecutable
} = require('../../electron/services/modpacks/archive/archive-worker-client.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const {
  MAX_FLUSH_DIRECTORIES,
  WindowsDurableFsClient
} = require('../../electron/utils/windows-durable-fs-client.cjs');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workerPath = path.join(repositoryRoot, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe');
const workerManifestPath = path.join(repositoryRoot, 'build-resources', 'archive-runtime', 'archive-worker-x64.json');
const manifestFormatterPath = path.join(repositoryRoot, 'scripts', 'archive-worker-manifest.ps1');
const sourceDigestPath = path.join(repositoryRoot, 'native', 'archive-worker-source-digest.json');
const COMMITTED_WORKER = Object.freeze({
  size: 67764851,
  sha256: '279e3beb4c2b7e9425b7768be27764661eb53ff6e8d7b6da8823c3bfaff58083'
});

function installedPowerShells() {
  const shells = [{
    name: 'Windows PowerShell',
    path: path.join(process.env.SystemRoot || process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  }];
  const located = childProcess.spawnSync('where.exe', ['pwsh'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const pwsh = located.status === 0 ? located.stdout.split(/\r?\n/u).map(line => line.trim()).find(Boolean) : null;
  if (pwsh) shells.push({ name: 'PowerShell 7', path: pwsh });
  return shells;
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(shell, statements) {
  const result = childProcess.spawnSync(shell.path, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', ["$ErrorActionPreference = 'Stop'", 'Set-StrictMode -Version Latest', `. ${powerShellLiteral(manifestFormatterPath)}`, ...statements].join('\n')
  ], { encoding: 'utf8', windowsHide: true, timeout: 120000, shell: false });
  assert.equal(result.status, 0, `${shell.name}: ${result.error || result.stderr || result.stdout}`);
  return result.stdout;
}

function copyLineEndingVariant(root, lineEnding) {
  const target = path.join(root, `ArchiveWorker-${lineEnding === '\n' ? 'lf' : 'crlf'}`);
  fs.cpSync(path.join(repositoryRoot, 'native', 'ArchiveWorker'), target, {
    recursive: true,
    filter: source => !(['bin', 'obj'].includes(path.basename(source)) && fs.lstatSync(source).isDirectory())
  });
  const rewrite = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        rewrite(entryPath);
        continue;
      }
      const text = fs.readFileSync(entryPath, 'latin1').replaceAll('\r\n', '\n');
      fs.writeFileSync(entryPath, lineEnding === '\n' ? text : text.replaceAll('\n', '\r\n'), 'latin1');
    }
  };
  rewrite(target);
  return target;
}

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

function createRetryObservedSpawn(onRetry) {
  return (executable, args, options) => {
    assert.deepEqual(args, ['--durable-fs']);
    const child = childProcess.spawn(executable, ['--durable-fs-test-observe-retries'], options);
    const nativeStderr = child.stderr;
    const publicStderr = new PassThrough();
    child.stderr = publicStderr;
    let pending = '';

    const consumeLine = line => {
      const match = /^DURABILITY_RETRY attempt=([1-4]) delayMs=(50|150|400|800)$/.exec(line);
      if (match) {
        onRetry(Object.freeze({ attempt: Number(match[1]), delayMs: Number(match[2]) }));
        return;
      }
      publicStderr.write(Buffer.from(`${line}\n`, 'utf8'));
    };
    nativeStderr.on('data', chunk => {
      pending += chunk.toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/u, '');
        pending = pending.slice(newline + 1);
        consumeLine(line);
      }
    });
    nativeStderr.once('error', error => publicStderr.destroy(error));
    nativeStderr.once('end', () => {
      if (pending.length > 0) publicStderr.write(Buffer.from(pending, 'utf8'));
      publicStderr.end();
    });
    return child;
  };
}

test('worker manifest is closed and matches the exact AMD64 executable', async () => {
  const verified = await verifyArchiveWorkerExecutable({ workerPath, workerManifestPath });
  const bytes = fs.readFileSync(workerPath);
  assert.equal(verified.architecture, 'x64');
  assert.equal(verified.runtimeIdentifier, 'win-x64');
  assert.equal(verified.targetFramework, 'net8.0-windows');
  assert.equal(verified.runtimeMode, 'in-memory-single-file');
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
  assert.match(source, /Environment\['DOTNET_BUNDLE_EXTRACT_BASE_DIR'\]\s*=\s*\$published\.FullName/);
  assert.match(source, /Assert-Within/);
  assert.match(source, /\.ArchiveWorker\.stage-/);
  assert.match(source, /\.archive-worker-x64\.stage-/);
  assert.doesNotMatch(source, /Remove-Item[^\r\n]*(?:-Recurse|-r\b)/i);
  assert.doesNotMatch(source, /& \$published\.FullName '--build-self-test'/);
});

test('worker build script writes the manifest and the source digest from the shared LF formatters', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'build-archive-worker.ps1'), 'utf8');
  assert.match(source, /^\. \(Join-Path \$PSScriptRoot 'archive-worker-manifest\.ps1'\)\r?$/mu);
  assert.match(source, /\$manifestText = Format-ArchiveWorkerManifest -Size \$publishedSize -Sha256 \$publishedHash/u);
  assert.doesNotMatch(source, /\$manifest\s*\|\s*ConvertTo-Json/u, 'ConvertTo-Json output differs between PowerShell editions');
  assert.doesNotMatch(source, /\$manifestText\s*=[^\r\n]*\[Environment\]::NewLine/u);
  const sourceBefore = source.indexOf('Get-ArchiveWorkerSourceDigest -SourceRoot $projectRoot');
  const publish = source.indexOf('& dotnet @publishArguments');
  const sourceAfter = source.indexOf('Get-ArchiveWorkerSourceDigest -SourceRoot $projectRoot', publish);
  assert.ok(sourceBefore >= 0 && sourceBefore < publish && sourceAfter > publish,
    'the source digest is taken before the build and re-checked after it');
  assert.match(source, /Format-ArchiveWorkerSourceDigest -Digest \$sourceDigest -WorkerSize \$publishedSize -WorkerSha256 \$publishedHash/u);
  assert.match(source, /'native\\archive-worker-source-digest\.json'/u);
  assert.match(source, /\.archive-worker-source-digest\.stage-/u);
});

test('the manifest formatter writes the pinned LF bytes under every installed PowerShell edition', (t) => {
  const { MANIFEST_IDENTITIES } = require('../../scripts/verify-packaged-archive.cjs');
  const pin = MANIFEST_IDENTITIES['archive-worker-x64.json'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-manifest-format-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [index, shell] of installedPowerShells().entries()) {
    const output = path.join(root, `manifest-${index}.json`);
    const stdout = runPowerShell(shell, [
      `$text = Format-ArchiveWorkerManifest -Size ${COMMITTED_WORKER.size} -Sha256 '${COMMITTED_WORKER.sha256}'`,
      `[IO.File]::WriteAllText(${powerShellLiteral(output)}, $text, [Text.UTF8Encoding]::new($false))`,
      '$rejected = 0',
      `try { [void](Format-ArchiveWorkerManifest -Size 0 -Sha256 '${COMMITTED_WORKER.sha256}') } catch { $rejected++ }`,
      `try { [void](Format-ArchiveWorkerManifest -Size 1 -Sha256 '${COMMITTED_WORKER.sha256.toUpperCase()}') } catch { $rejected++ }`,
      "[Console]::Out.Write(\"rejected=$rejected\")"
    ]);
    assert.equal(stdout, 'rejected=2', shell.name);
    const bytes = fs.readFileSync(output);
    assert.equal(bytes.includes(0x0d), false, `${shell.name} must write LF line endings`);
    assert.equal(bytes.length, pin.size, shell.name);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pin.sha256, shell.name);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')).files['ArchiveWorker.exe'], COMMITTED_WORKER, shell.name);
  }
});

test('PowerShell and Node compute the same LF-normalised source digest, which the committed record holds', { timeout: 120000 }, (t) => {
  const { computeArchiveWorkerSourceDigest } = require('../../scripts/verify-packaged-archive.cjs');
  assert.equal(typeof computeArchiveWorkerSourceDigest, 'function', 'computeArchiveWorkerSourceDigest is required');
  const record = JSON.parse(fs.readFileSync(sourceDigestPath, 'utf8'));
  assert.deepEqual(record.worker, COMMITTED_WORKER);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-source-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const variants = [
    path.join(repositoryRoot, 'native', 'ArchiveWorker'),
    copyLineEndingVariant(root, '\n'),
    copyLineEndingVariant(root, '\r\n')
  ];
  for (const sourceRoot of variants) {
    const digest = computeArchiveWorkerSourceDigest(sourceRoot);
    assert.equal(digest.sha256, record.sha256, sourceRoot);
    assert.deepEqual(digest.files, record.files, sourceRoot);
  }
  const linkedRoot = path.join(root, 'ArchiveWorker-linked');
  fs.cpSync(variants[1], linkedRoot, { recursive: true });
  fs.symlinkSync(path.join(variants[1], 'Security'), path.join(linkedRoot, 'Linked'), 'junction');
  assert.throws(() => computeArchiveWorkerSourceDigest(linkedRoot), error => error?.code === 'EXTRACTOR_UNAVAILABLE');
  const emptyFileRoot = path.join(root, 'ArchiveWorker-empty-file');
  fs.cpSync(variants[1], emptyFileRoot, { recursive: true });
  fs.writeFileSync(path.join(emptyFileRoot, 'Security', 'Empty.cs'), '');
  const emptyFileDigest = computeArchiveWorkerSourceDigest(emptyFileRoot).sha256;
  assert.notEqual(emptyFileDigest, record.sha256, 'an added empty file changes the digest');
  for (const [index, shell] of installedPowerShells().entries()) {
    assert.equal(runPowerShell(shell, [
      `try { [void](Get-ArchiveWorkerSourceDigest -SourceRoot ${powerShellLiteral(linkedRoot)}); [Console]::Out.Write('accepted') }`,
      "catch { [Console]::Out.Write('rejected') }"
    ]), 'rejected', `${shell.name} must refuse a linked source tree`);
    assert.equal(runPowerShell(shell, [
      `[Console]::Out.Write((Get-ArchiveWorkerSourceDigest -SourceRoot ${powerShellLiteral(emptyFileRoot)}).Sha256)`
    ]), emptyFileDigest, `${shell.name} must hash an empty source file like Node`);
    for (const [variantIndex, sourceRoot] of variants.entries()) {
      const output = path.join(root, `digest-${index}-${variantIndex}.json`);
      runPowerShell(shell, [
        `$sourceDigest = Get-ArchiveWorkerSourceDigest -SourceRoot ${powerShellLiteral(sourceRoot)}`,
        `$text = Format-ArchiveWorkerSourceDigest -Digest $sourceDigest -WorkerSize ${COMMITTED_WORKER.size} -WorkerSha256 '${COMMITTED_WORKER.sha256}'`,
        `[IO.File]::WriteAllText(${powerShellLiteral(output)}, $text, [Text.UTF8Encoding]::new($false))`
      ]);
      const written = fs.readFileSync(output, 'utf8');
      assert.equal(written, `${JSON.stringify(record, null, 2)}\n`, `${shell.name}: ${sourceRoot}`);
    }
  }
});

test('the verified single-file worker loads in memory without writing a private runtime copy', (t) => {
  const project = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'ArchiveWorker.csproj'), 'utf8');
  assert.match(project, /<IncludeNativeLibrariesForSelfExtract>false<\/IncludeNativeLibrariesForSelfExtract>/);
  assert.match(project, /<IncludeAllContentForSelfExtract>false<\/IncludeAllContentForSelfExtract>/);

  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-worker-no-extraction-'));
  t.after(() => fs.rmSync(executionRoot, { recursive: true, force: true }));
  const copiedWorker = path.join(executionRoot, 'ArchiveWorker.exe');
  fs.copyFileSync(workerPath, copiedWorker);
  const expectedHash = crypto.createHash('sha256').update(fs.readFileSync(copiedWorker)).digest('hex');
  const result = childProcess.spawnSync(copiedWorker, ['--probe-descendant'], {
    shell: false,
    windowsHide: true,
    encoding: null,
    timeout: 30_000,
    env: {
      DOTNET_BUNDLE_EXTRACT_BASE_DIR: copiedWorker,
      SystemRoot: process.env.SystemRoot || process.env.WINDIR,
      windir: process.env.WINDIR || process.env.SystemRoot
    }
  });

  assert.equal(result.status, 0, result.stderr?.toString('utf8'));
  assert.deepEqual(fs.readdirSync(executionRoot), ['ArchiveWorker.exe'], 'the exact worker must not materialize a runtime tree');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(copiedWorker)).digest('hex'), expectedHash);
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
    bundleRuntimeInMemory: true,
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

test('native atomic JSON publication supports a reviewed local path beyond legacy MAX_PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-long-path-'));
  try {
    let targetParent = root;
    let index = 0;
    while (path.join(targetParent, 'directory-marker.json').length <= 300) {
      targetParent = path.join(targetParent, `reviewed-${String(index).padStart(2, '0')}-abcdefghij`);
      fs.mkdirSync(targetParent);
      index += 1;
    }
    const target = path.join(targetParent, 'directory-marker.json');
    assert.ok(target.length > 260, `fixture must cross legacy MAX_PATH, received ${target.length}`);

    const client = new WindowsDurableFsClient({
      workerPath,
      workerManifestPath,
      allowedRoots: [root],
      appOwnedRoot: path.join(root, 'broker')
    });
    const durableFs = createDurableFs({
      fsApi: fs,
      durableClient: client,
      allowedRoots: [root],
      tempNameFactory: () => 'long-path-regression'
    });

    durableFs.writeJsonAtomic(target, { fixture: 'long-path' }, { expectedTargetSha256: null });
    const initialSha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    durableFs.writeJsonAtomic(target, { fixture: 'long-path-replaced' }, { expectedTargetSha256: initialSha256 });

    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { fixture: 'long-path-replaced' });
    assert.deepEqual(fs.readdirSync(targetParent).sort(), ['directory-marker.json']);
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

test('durable directory batch flushes nested identity-bound directories in one verified worker process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-live-batch-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(first, 'second');
    const third = path.join(root, 'third');
    fs.mkdirSync(second, { recursive: true });
    fs.mkdirSync(third);
    let workerInvocations = 0;
    const client = new WindowsDurableFsClient({
      workerPath,
      workerManifestPath,
      allowedRoots: [root],
      spawnSync(executable, args, options) {
        workerInvocations += 1;
        return childProcess.spawnSync(executable, args, options);
      }
    });

    client.flushDirectories([second, first, third, root]);

    assert.equal(workerInvocations, 1);
    assert.equal(Object.isFrozen(client.capabilities), true);
    assert.equal(client.capabilities.moveWriteThroughFlushesParents, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('durable native worker accepts the exact token-safe maximum directory batch', { timeout: 60_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-live-max-batch-'));
  try {
    const directories = Array.from({ length: MAX_FLUSH_DIRECTORIES }, (_, index) => {
      const directory = path.join(root, `directory-${String(index).padStart(4, '0')}`);
      fs.mkdirSync(directory);
      return directory;
    });
    let workerInvocations = 0;
    const client = new WindowsDurableFsClient({
      workerPath,
      workerManifestPath,
      allowedRoots: [root],
      appOwnedRoot: path.join(root, 'app-owned'),
      spawnSync(executable, args, options) {
        workerInvocations += 1;
        return childProcess.spawnSync(executable, args, options);
      }
    });

    client.flushDirectories(directories);

    assert.equal(MAX_FLUSH_DIRECTORIES, 512);
    assert.equal(workerInvocations, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('durable directory promotion uses the native parent-flush capability in one worker process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-live-promotion-'));
  try {
    const sourceParent = path.join(root, 'selected-restore');
    const destinationParent = path.join(root, 'candidate');
    const source = path.join(sourceParent, '.fabric');
    const destination = path.join(destinationParent, '.fabric');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(destinationParent);
    fs.writeFileSync(path.join(source, 'server-launch.jar'), 'fixture');
    let workerInvocations = 0;
    const client = new WindowsDurableFsClient({
      workerPath,
      workerManifestPath,
      allowedRoots: [root],
      spawnSync(executable, args, options) {
        workerInvocations += 1;
        return childProcess.spawnSync(executable, args, options);
      }
    });
    const durableFs = createDurableFs({ fsApi: fs, durableClient: client, allowedRoots: [root] });

    durableFs.renameDurable(source, destination);

    assert.equal(workerInvocations, 1);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(path.join(destination, 'server-launch.jar'), 'utf8'), 'fixture');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native uncertain move reconciliation pins the published file and both original parents through durable completion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-live-reconcile-'));
  try {
    const sourceParent = path.join(root, 'source-parent');
    const destinationParent = path.join(root, 'destination-parent');
    const source = path.join(sourceParent, 'candidate.bin');
    const destination = path.join(destinationParent, 'published.bin');
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(destinationParent);
    fs.writeFileSync(source, 'exact candidate bytes');
    const stat = fs.lstatSync(source, { bigint: true });
    const identity = value => ({
      dev: String(value.dev), ino: String(value.ino), size: Number(value.size),
      birthtime: String(value.birthtimeNs ?? value.birthtimeMs),
      mtime: String(value.mtimeNs ?? value.mtimeMs), ctime: String(value.ctimeNs ?? value.ctimeMs)
    });
    const sourceIdentity = {
      ...identity(stat),
      sha256: crypto.createHash('sha256').update('exact candidate bytes').digest('hex')
    };
    const sourceParentIdentity = identity(fs.lstatSync(sourceParent, { bigint: true }));
    const destinationParentIdentity = identity(fs.lstatSync(destinationParent, { bigint: true }));
    fs.renameSync(source, destination);
    let workerInvocations = 0;
    const client = new WindowsDurableFsClient({
      workerPath,
      workerManifestPath,
      allowedRoots: [root],
      spawnSync(executable, args, options) {
        workerInvocations += 1;
        return childProcess.spawnSync(executable, args, options);
      }
    });

    client.reconcileMoveWriteThrough(source, destination, {
      sourceIdentity,
      sourceParentIdentity,
      destinationParentIdentity
    });

    assert.equal(workerInvocations, 1);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'exact candidate bytes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native atomic replacement reconciliation accepts exact committed bytes after a reported completion failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-live-atomic-reconcile-'));
  try {
    const target = path.join(root, 'notifications.json');
    fs.writeFileSync(target, '{"sequence":1}\n');
    const nativeClient = new WindowsDurableFsClient({
      workerPath,
      workerManifestPath,
      allowedRoots: [root]
    });
    let reconciliations = 0;
    const durableClient = {
      capabilities: nativeClient.capabilities,
      moveWriteThrough: (...args) => nativeClient.moveWriteThrough(...args),
      replaceFileWriteThrough(...args) {
        nativeClient.replaceFileWriteThrough(...args);
        throw new Error('injected failure after the exact native replacement committed');
      },
      reconcileMoveWriteThrough(...args) {
        reconciliations += 1;
        return nativeClient.reconcileMoveWriteThrough(...args);
      },
      flushDirectory: (...args) => nativeClient.flushDirectory(...args)
    };
    const durableFs = createDurableFs({
      fsApi: fs,
      durableClient,
      allowedRoots: [root],
      tempNameFactory: () => 'live-atomic-reconcile'
    });

    durableFs.writeJsonAtomic(target, { sequence: 2 });

    assert.equal(reconciliations, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { sequence: 2 });
    assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('minecraft-core-tmp')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('durable directory batch fails closed when one captured directory identity is substituted', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-live-batch-race-'));
  const root = path.join(parent, 'owned');
  const original = path.join(parent, 'original');
  const stable = path.join(root, 'stable');
  const substituted = path.join(root, 'substituted');
  fs.mkdirSync(stable, { recursive: true });
  fs.mkdirSync(substituted);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let injected = false;
  const client = new WindowsDurableFsClient({
    workerPath,
    workerManifestPath,
    allowedRoots: [root],
    spawnSync(executable, args, options) {
      if (!injected) {
        injected = true;
        fs.renameSync(substituted, original);
        fs.mkdirSync(substituted);
      }
      return childProcess.spawnSync(executable, args, options);
    }
  });

  assert.throws(
    () => client.flushDirectories([stable, substituted]),
    error => error.code === 'COMMIT_FAILED'
  );
  assert.equal(injected, true);
  assert.equal(fs.statSync(stable).isDirectory(), true);
  assert.equal(fs.statSync(substituted).isDirectory(), true);
  assert.equal(fs.statSync(original).isDirectory(), true);
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
    assert.throws(
      () => client.moveWriteThrough(moveSource, moveDestination),
      error => error.code === 'COMMIT_FAILED' && error.durableFailureKind === 'sharing-violation' &&
        error.durableFailureStage === 'source-open'
    );
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

test('native durable replacement waits for a brief destination writer and publishes with one worker', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-transient-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const replacement = path.join(root, 'replacement.txt');
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(replacement, 'replacement');
  fs.writeFileSync(target, 'old-target');
  let workerSpawns = 0;
  const retries = [];
  let writer = fs.openSync(target, 'r+');
  let released = false;
  const releaseWriter = () => {
    if (released) return;
    released = true;
    fs.closeSync(writer);
    writer = null;
  };
  const observedSpawn = createRetryObservedSpawn(retry => {
    retries.push(retry);
    releaseWriter();
  });
  const client = new WindowsDurableFsClient({
    workerPath,
    workerManifestPath,
    allowedRoots: [root],
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn(executable, args, options) {
      workerSpawns += 1;
      return observedSpawn(executable, args, options);
    }
  });

  try {
    await client.replaceFileWriteThroughAsync(replacement, target);
  } finally {
    releaseWriter();
  }

  assert.deepEqual(retries, [{ attempt: 1, delayMs: 50 }]);
  assert.equal(released, true, 'the first native retry decision released the transient writer');
  assert.equal(workerSpawns, 1, 'retry remains inside one identity-bound native request');
  assert.equal(fs.existsSync(replacement), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'replacement');
});

test('native sharing retry rejects a source substituted while the destination is busy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-transient-substitution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const replacement = path.join(root, 'replacement.txt');
  const target = path.join(root, 'target.txt');
  fs.writeFileSync(replacement, 'reviewed-replacement');
  fs.writeFileSync(target, 'old-target');
  const retries = [];
  let writer = fs.openSync(target, 'r+');
  let released = false;
  const substituteAndRelease = () => {
    if (released) return;
    fs.writeFileSync(replacement, 'substituted-replacement');
    fs.closeSync(writer);
    writer = null;
    released = true;
  };
  const client = new WindowsDurableFsClient({
    workerPath,
    workerManifestPath,
    allowedRoots: [root],
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn: createRetryObservedSpawn(retry => {
      retries.push(retry);
      substituteAndRelease();
    })
  });

  try {
    await assert.rejects(
      client.replaceFileWriteThroughAsync(replacement, target),
      error => error.code === 'COMMIT_FAILED' && error.durableFailureKind === 'integrity-failure' &&
        error.durableFailureStage === 'source-open'
    );
  } finally {
    substituteAndRelease();
  }

  assert.deepEqual(retries, [{ attempt: 1, delayMs: 50 }]);
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'substituted-replacement');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old-target');
});

test('durable client keeps bounded sync mutations and terminates only its retained async worker handle', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'electron', 'utils', 'windows-durable-fs-client.cjs'), 'utf8');
  assert.match(source, /spawnSync/);
  assert.match(source, /flushDirectoryAsync/);
  assert.match(source, /target\?\.kill\?\.\('SIGKILL'\)/);
  assert.match(source, /shell:\s*false/);
  assert.match(source, /windowsHide:\s*true/);
  assert.match(source, /timeout:/);
  assert.doesNotMatch(source, /renameSync|copyFileSync|COPY_ALLOWED|cmd\.exe|powershell|taskkill|wmic|process\.kill/i);
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
  assert.match(durability, /Encoding\.Unicode\.GetBytes\(NativeFilePath\.ForApi\(destinationPath\)\)/);
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

test('native batch durability validates every bounded directory before flushing and then revalidates all pins', () => {
  const nativeRoot = path.join(repositoryRoot, 'native', 'ArchiveWorker');
  const durability = fs.readFileSync(path.join(nativeRoot, 'Durability', 'DurableFilesystem.cs'), 'utf8');
  const dtos = fs.readFileSync(path.join(nativeRoot, 'Protocol', 'WorkerDtos.cs'), 'utf8');
  assert.match(dtos, /DurableDirectoryRequest\[\]\?\s+Directories/);
  assert.match(durability, /case\s+"flush-directories"/);
  assert.match(durability, /MaxFlushDirectories/);
  assert.match(durability, /DurableAncestorPins\.Open\(roots/);
  assert.match(durability, /foreach\s*\([^)]*directory[^)]*\)\s*directory\.Revalidate\(requirePath:\s*true\)/);
  assert.match(durability, /foreach\s*\([^)]*directory[^)]*\)\s*directory\.Flush\(\)/);
  assert.match(durability, /foreach\s*\([^)]*directory[^)]*\)\s*directory\.Revalidate\(requirePath:\s*true,\s*allowMetadataChange:\s*true\)/);
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
  // The separate exact-file deletion primitive also uses this Windows API.
  // Publication still has exactly one rename, not a rename/delete fallback.
  assert.equal((durability.match(/NativeMethods\.SetFileInformationByHandle\(/g) || []).length, 2);
  assert.equal((durability.match(/NativeMethods\.SetFileInformationByHandle\(source, NativeMethods\.FileRenameInfoEx/g) || []).length, 1);
  assert.equal((durability.match(/NativeMethods\.SetFileInformationByHandle\(leaf\.Handle, NativeMethods\.FileDispositionInfo/g) || []).length, 1);
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
