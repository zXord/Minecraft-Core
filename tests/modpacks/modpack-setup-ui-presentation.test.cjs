const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function cssCustomProperty(css, name) {
  const match = css.match(new RegExp(`${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:\\s*(#[a-f0-9]{6})`, 'iu'));
  assert.ok(match, `Expected ${name} to be a six-digit hex color`);
  return match[1];
}

function whiteContrastRatio(hex) {
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map(channel => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  return 1.05 / (luminance + 0.05);
}

function moduleUrl(specifier) {
  return pathToFileURL(require.resolve(specifier)).href;
}

async function loadServerComponent(relativePath) {
  const { compile } = await import('svelte/compiler');
  const absolutePath = path.join(ROOT, relativePath);
  let code = compile(source(relativePath), { filename: absolutePath, generate: 'server', dev: false }).js.code;
  code = code
    .replace("from 'svelte/internal/server'", `from '${moduleUrl('svelte/internal/server')}'`)
    .replace("from 'svelte'", `from '${moduleUrl('svelte')}'`)
    .replace(
      "from '../../utils/modpacks/modpackApi.js'",
      `from '${pathToFileURL(path.join(ROOT, 'src/utils/modpacks/modpackApi.js')).href}'`
    )
    .replace(
      "from '../../utils/modpacks/serverRequestScope.js'",
      `from '${pathToFileURL(path.join(ROOT, 'src/utils/modpacks/serverRequestScope.js')).href}'`
    )
    .replace(
      "from '../../utils/modpacks/publicJobMerge.js'",
      `from '${pathToFileURL(path.join(ROOT, 'src/utils/modpacks/publicJobMerge.js')).href}'`
    );
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
}

test('source cards remain neutral action cards because each choice advances immediately', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/setup/ModpackSourceChoice.svelte');
  const initial = render(Component, { props: { selected: '' } }).body;
  const legacySelectedProp = render(Component, { props: { selected: 'github' } }).body;

  assert.equal(initial.includes('role="radiogroup"'), false);
  assert.equal(initial.includes('aria-checked'), false);
  assert.equal(initial.includes('Selected'), false);
  assert.equal(legacySelectedProp.includes('Selected'), false);
  for (const title of ['Browse Modrinth', 'GitHub Releases', 'Local archive']) {
    assert.match(initial, new RegExp(title, 'u'));
  }
});

test('persistent setup selections use a neutral surface instead of the blue-violet action accent', () => {
  const shared = source('src/components/modpacks/modpack-ui.css');
  const immediateChoices = [
    source('src/components/setup/ServerSetupWizard.svelte'),
    source('src/components/setup/ModpackSourceChoice.svelte'),
    source('src/components/setup/ModrinthPackBrowser.svelte')
  ].join('\n');

  assert.match(shared, /\.mp-card\s*\{\s*padding:\s*1rem;\s*\}/u);
  assert.doesNotMatch(immediateChoices, /(?:method-card|source-card|result-card)[^}]*background:\s*var\(--mp-accent(?:-strong)?\)/u);
  assert.match(shared, /\.mp-row\.selected\s*\{[^}]*border-color:\s*rgba\(255, 255, 255, 0\.46\)[^}]*background:\s*rgba\(255, 255, 255, 0\.09\)[^}]*box-shadow:\s*inset 3px 0 rgba\(255, 255, 255, 0\.48\)/su);
  assert.doesNotMatch(shared, /\.mp-row\.selected\s*\{[^}]*var\(--mp-accent\)/su);
});

test('persistent setup choices distinguish selected, focus-visible, and disabled states', () => {
  const shared = source('src/components/modpacks/modpack-ui.css');
  const archive = source('src/components/setup/ArchiveGuidedReview.svelte');

  assert.match(shared, /button\.mp-row:focus-visible\s*\{[^}]*outline:\s*2px solid/su);
  assert.match(shared, /button\.mp-row:disabled\s*\{[^}]*cursor:\s*not-allowed;[^}]*opacity:/su);
  assert.match(shared, /button\.mp-card:disabled,\s*\.mp-card\[aria-disabled='true'\]\s*\{[^}]*cursor:\s*not-allowed;[^}]*opacity:/su);
  assert.match(archive, /\.choice-list label:has\(> input:is\(\[type='radio'\], \[type='checkbox'\]\):checked\)\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.09\)/su);
  assert.doesNotMatch(archive, /\.choice-list label:has\(> input:is\(\[type='radio'\], \[type='checkbox'\]\):checked\)\s*\{[^}]*var\(--mp-accent\)/su);
  assert.match(archive, /\.choice-list label:has\(> input:focus-visible\)\s*\{[^}]*outline:\s*2px solid/su);
  assert.match(archive, /\.choice-list label:has\(> input:disabled\)\s*\{[^}]*cursor:\s*not-allowed;[^}]*opacity:/su);
});

test('native choices and every active progress indicator use one restrained non-success accent', async () => {
  const { render } = await import('svelte/server');
  const inspectionComponent = await loadServerComponent('src/components/modpacks/ModpackInspectionProgress.svelte');
  const reviewComponent = await loadServerComponent('src/components/setup/ArchiveGuidedReview.svelte');
  const jobComponent = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const shared = source('src/components/modpacks/modpack-ui.css');

  const inspection = render(inspectionComponent, {
    props: { progress: { phase: 'downloading', transferredBytes: 25, totalBytes: 100 } }
  }).body;
  const preflight = render(reviewComponent, {
    props: {
      inspection: null,
      busy: true,
      preflightProgress: { phase: 'preparing-candidate', processedBytes: 25, totalBytes: 100 }
    }
  }).body;
  const lifecycle = render(jobComponent, {
    props: { job: { jobId: 'active-progress-job', phase: 'downloading', progress: { message: 'Downloading' } } }
  }).body;

  assert.match(shared, /input\[type=['"]checkbox['"]\][^}]*input\[type=['"]radio['"]\][^}]*accent-color:\s*var\(--mp-control-accent\)/su);
  assert.match(shared, /--mp-progress-active:\s*var\(--mp-control-accent\)/u);
  assert.match(shared, /\.mp-progress-meter\s*\{[^}]*accent-color:\s*var\(--mp-progress-active\)/su);
  assert.match(shared, /\.mp-progress-activity\s*\{[^}]*background:\s*var\(--mp-progress-active\)/su);
  assert.doesNotMatch(shared, /\.mp-progress-(?:meter|activity)[^}]*var\(--mp-good\)/su);
  assert.match(inspection, /<progress class="mp-progress-meter"/u);
  assert.match(preflight, /<progress class="mp-progress-meter"/u);
  assert.match(lifecycle, /class="mp-progress-track"[^>]*role="progressbar"/u);
  assert.match(lifecycle, /class="mp-progress-activity"/u);
});

test('ordinary white primary-action text meets WCAG AA contrast', () => {
  const shared = source('src/components/modpacks/modpack-ui.css');
  const primary = cssCustomProperty(shared, '--mp-accent-strong');

  assert.ok(
    whiteContrastRatio(primary) >= 4.5,
    `${primary} provides only ${whiteContrastRatio(primary).toFixed(2)}:1 contrast against white text`
  );
});

test('terminal operation outcomes expose semantic border classes', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const renderPhase = phase => render(Component, {
    props: { job: { jobId: `outcome-${phase}`, phase, outcome: {} } }
  }).body;

  assert.match(renderPhase('failed'), /class="[^"]*outcome[^"]*danger[^"]*"/u);
  assert.match(renderPhase('recovery-required'), /class="[^"]*outcome[^"]*danger[^"]*"/u);
  assert.match(renderPhase('cancelled'), /class="[^"]*outcome[^"]*warn[^"]*"/u);
  assert.match(renderPhase('rolled-back'), /class="[^"]*outcome[^"]*warn[^"]*"/u);
  assert.match(renderPhase('completed'), /class="[^"]*outcome[^"]*good[^"]*"/u);
});

async function renderVerification(result) {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  return render(Component, {
    props: { job: { jobId: 'verify-result', operationKind: 'verify', phase: 'completed', outcome: { kind: 'completed', result } } }
  }).body;
}

const healthyVerification = {
  type: 'modpack-verification-result', contentRevision: 1,
  checkedFiles: '2', mismatchCount: '0', healthy: true, repairAvailable: false,
  repair: null, mismatches: [], verifiedAt: '2026-10-09T00:00:00.000Z'
};

test('healthy Verify reports checked content without claiming a server commit', async () => {
  // Catches Verify falling through to ordinary install success copy.
  const html = await renderVerification(healthyVerification);
  assert.match(html, /Verified healthy/u);
  assert.match(html, /Checked files: 2/u);
  assert.match(html, /Mismatches: 0/u);
  assert.match(html, /No server files were changed/u);
  assert.match(html, /Repair is not needed/u);
  assert.match(html, /mp-badge good/u);
  assert.match(html, /Return to server/u);
  assert.doesNotMatch(html, /committed, validated from its final location, and recorded in history/u);
});

test('unhealthy Verify shows warning counts and relative mismatch names separately from Repair', async () => {
  // Catches a completed-but-unhealthy Verify being painted green or hiding differences.
  const html = await renderVerification({
    ...healthyVerification, checkedFiles: '3', mismatchCount: '2', healthy: false, repairAvailable: true,
    repair: { operationKind: 'repair', mismatchCount: '2' },
    mismatches: [
      { entryName: 'mods/managed.jar', origin: 'pack', role: 'mod', status: 'modified' },
      { entryName: 'libraries/runtime.jar', origin: 'runtime', role: 'runtime', status: 'missing' }
    ]
  });
  assert.match(html, /Differences found/u);
  assert.match(html, /Checked files: 3/u);
  assert.match(html, /Mismatches: 2/u);
  assert.match(html, /mods\/managed.jar/u);
  assert.match(html, /modified/u);
  assert.match(html, /libraries\/runtime.jar/u);
  assert.match(html, /missing/u);
  assert.match(html, /No server files were changed/u);
  assert.match(html, /Repair is available separately/u);
  assert.match(html, /mp-badge warn/u);
  assert.match(html, /class="[^"]*outcome[^"]*warn/u);
  assert.doesNotMatch(html, /mp-badge good|committed, validated from its final location/u);
});

test('truncated Verify results explain shown versus full totals even when no labels fit', async () => {
  // Catches sampled lists being presented as the complete mismatch inventory.
  for (const mismatches of [[{ entryName: 'config/sample.json', status: 'modified' }], []]) {
    const html = await renderVerification({
      ...healthyVerification, healthy: false, mismatchCount: '148', repairAvailable: true,
      mismatches, shownMismatchCount: String(mismatches.length),
      omittedMismatchCount: String(148 - mismatches.length), mismatchesTruncated: true
    });
    assert.match(html, new RegExp(`Showing ${mismatches.length} of 148 differences`, 'u'));
    assert.match(html, new RegExp(`${148 - mismatches.length} additional differences are not listed`, 'u'));
    assert.match(html, /Differences found/u);
    assert.match(html, /No server files were changed/u);
    assert.match(html, /Repair is available separately/u);
    assert.doesNotMatch(html, /Verified healthy|mp-badge good/u);
  }
  const complete = await renderVerification({
    ...healthyVerification, healthy: false, mismatchCount: '1', repairAvailable: true,
    mismatches: [{ entryName: 'mods/managed.jar', status: 'modified' }]
  });
  assert.doesNotMatch(complete, /additional differences are not listed/u);
});

test('legacy or incomplete Verify results never fabricate a healthy pass or counts', async () => {
  // Catches absent health/counts being treated as successful verification.
  for (const result of [undefined, { repairAvailable: true }, { healthy: true },
    { ...healthyVerification, mismatchCount: undefined }, { ...healthyVerification, checkedFiles: 'unknown' }]) {
    const html = await renderVerification(result);
    assert.match(html, /Verification result unavailable/u);
    assert.match(html, /Return to the Modpack page and run Verify again/u);
    assert.match(html, /No server files were changed/u);
    assert.match(html, /mp-badge warn/u);
    assert.doesNotMatch(html, /Verified healthy|mp-badge good|Checked files:|Mismatches:|committed, validated/u);
  }
});

test('Verify mismatch content is escaped rather than interpreted as markup', async () => {
  // Catches unsafe HTML rendering of publisher or local filenames/statuses.
  const html = await renderVerification({
    ...healthyVerification, healthy: false, mismatchCount: '1', repairAvailable: true,
    mismatches: [{ entryName: 'mods/<img src=x onerror=alert(1)>&.jar', status: '<script>bad()</script>' }]
  });
  assert.match(html, /mods\/&lt;img src=x onerror=alert\(1\)>&amp;.jar/u);
  assert.match(html, /&lt;script>bad\(\)&lt;\/script>/u);
  assert.doesNotMatch(html, /<img|<script>/u);
});

test('ordinary install success keeps committed-state copy and existing actions', async () => {
  // Catches a Verify-only result branch accidentally replacing ordinary completion.
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const html = render(Component, { props: { job: {
    jobId: 'install-result', operationKind: 'install-existing', phase: 'completed',
    outcome: { kind: 'completed', actions: [{ actionId: 'open-details', opaqueRef: 'details-ref' }] }
  } } }).body;
  assert.match(html, /committed, validated from its final location, and recorded in history/u);
  assert.match(html, /mp-badge good/u);
  assert.match(html, /Return to server/u);
  assert.match(html, /Open details/u);
  assert.doesNotMatch(html, /Verification result unavailable|No server files were changed/u);
});

test('neutral button hover does not erase primary or destructive hierarchy', () => {
  const shared = source('src/components/modpacks/modpack-ui.css');

  assert.match(shared, /\.mp-button\.primary:hover:not\(:disabled\)\s*\{[^}]*var\(--mp-accent-strong\)/su);
  assert.match(shared, /\.mp-button\.danger:hover:not\(:disabled\)\s*\{[^}]*var\(--mp-danger\)/su);
});

test('selected asset badges remain neutral beside provisional status', () => {
  const assetReview = source('src/components/setup/GitHubAssetReview.svelte');

  assert.match(assetReview, /\.selected-badge\s*\{[^}]*color:\s*rgba\(255, 255, 255, 0\.88\)[^}]*background:\s*rgba\(255, 255, 255, 0\.09\)/su);
  assert.doesNotMatch(assetReview, /\.selected-badge\s*\{[^}]*var\(--mp-accent\)/su);
});

test('archive review truthfully explains that compressed data will be verified during protected setup', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/setup/ArchiveGuidedReview.svelte');
  const html = render(Component, {
    props: {
      inspection: {
        integrity: 'deferred-to-extraction',
        archiveFamily: 'zip',
        rootCandidates: [],
        entries: [],
        classification: { kind: 'prepared-server-pack', confidence: 'exact', blocked: false }
      }
    }
  }).body;

  assert.match(html, /Will be checked during protected setup/u);
  assert.doesNotMatch(html, /deferred-to-extraction|Not tested/u);
  assert.match(source('src/components/setup/GitHubAssetReview.svelte'), /Compressed file data will be verified once during protected setup/u);
  assert.doesNotMatch(source('src/components/modpacks/ModpackInspectionProgress.svelte'), /Testing archive integrity|Checking compressed archive data/u);
});

test('retained-download outcome explains automatic cleanup and confirms explicit removal', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const html = render(Component, {
    props: {
      job: {
        jobId: 'retained-job', phase: 'failed', outcome: {
          kind: 'retained-download', retainedDownload: { sha256: 'a'.repeat(64) },
          actions: [{ actionId: 'remove-retained-download', opaqueRef: 'remove-ref' }]
        }
      }
    }
  }).body;

  assert.match(html, /eligible for automatic cleanup after seven days/u);
  assert.match(source('src/components/modpacks/ModpackJobProgress.svelte'), /Downloaded file removed/u);
});

test('a retained download blocked by destination recovery explains the real next step and hydrates its durable log', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const html = render(Component, {
    props: {
      job: {
        jobId: 'recovery-blocked-job',
        phase: 'failed',
        outcome: {
          errorCode: 'RECOVERY_REQUIRED',
          failureReason: 'destination-recovery',
          retainedDownload: true,
          actions: [{ actionId: 'choose-another-asset', opaqueRef: 'choose-ref' }]
        },
        events: [{
          sequence: 4,
          jobId: 'recovery-blocked-job',
          channel: 'log',
          phase: 'preflight',
          timestamp: '2026-09-03T00:00:00.000Z',
          message: 'Server recovery must be completed before this operation can continue',
          progress: null,
          currentItem: null,
          details: { errorCode: 'RECOVERY_REQUIRED', step: 'acquire-mutation' }
        }]
      }
    }
  }).body;

  assert.match(html, /Destination has unfinished recovery/u);
  assert.match(html, /Choose a different empty folder/u);
  assert.match(html, /existing server files were not touched/u);
  assert.match(html, /Start setup again/u);
  assert.match(html, /preflight/u);
  assert.match(html, /RECOVERY_REQUIRED/u);
  assert.match(html, /Server recovery must be completed before this operation can continue/u);
  assert.doesNotMatch(html, /No detailed log records have been published/u);
});

test('an unrelated recovery-required failure is not misreported as a destination collision', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const html = render(Component, {
    props: {
      job: {
        jobId: 'unrelated-recovery-job',
        phase: 'failed',
        outcome: {
          errorCode: 'RECOVERY_REQUIRED',
          retainedDownload: true,
          actions: [{ actionId: 'choose-another-asset', opaqueRef: 'choose-ref' }]
        },
        events: []
      }
    }
  }).body;

  assert.doesNotMatch(html, /Destination has unfinished recovery/u);
  assert.doesNotMatch(html, /Choose a different empty folder/u);
  assert.match(html, /Choose another asset/u);
});

test('immediate setup choices use Lucide icons and native button activation', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');
  const sourceChoice = source('src/components/setup/ModpackSourceChoice.svelte');
  const browser = source('src/components/setup/ModrinthPackBrowser.svelte');

  assert.match(setup, /lucide-svelte\/icons\/wrench/u);
  assert.match(setup, /lucide-svelte\/icons\/package-open/u);
  assert.doesNotMatch(setup, /🛠️|📦|on:keydown/u);
  assert.doesNotMatch(sourceChoice + browser, /on:keydown/u);
});

test('failed and cancelled jobs use truthful terminal badges and stopped-before-change framing', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const failed = render(Component, { props: { job: { jobId: 'failed-job', phase: 'failed', outcome: { kind: 'nothing-changed' } } } }).body;
  const cancelled = render(Component, { props: { job: { jobId: 'cancelled-job', phase: 'cancelled', outcome: { kind: 'nothing-changed' } } } }).body;

  assert.match(failed, /mp-badge danger/u);
  assert.match(cancelled, /mp-badge warn/u);
  assert.match(failed, /Stopped before server changes/u);
  assert.match(failed, /No server files were changed/u);
});

test('failed jobs render a provider-neutral redacted filesystem recovery summary', async () => {
  // This fails if the UI hides actionable safe diagnostics or renders raw provider/path/exception payloads.
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const html = render(Component, {
    props: {
      job: {
        jobId: 'filesystem-failure', phase: 'failed', outcome: {
          kind: 'nothing-changed',
          failure: {
            stage: 'durable-move', category: 'integrity-failure', boundary: 'destination-parent-open'
          }
        }
      }
    }
  }).body;

  assert.match(html, /File integrity check could not be completed/u);
  assert.match(html, /Check that the selected destination folder is available, then retry/u);
  assert.doesNotMatch(html, /private|provider-name|native exception/i);

  let reads = 0;
  const malformed = { stage: 'durable-move', boundary: 'destination-parent-open' };
  Object.defineProperty(malformed, 'category', {
    enumerable: true,
    get() { reads += 1; return 'integrity-failure'; }
  });
  const rejected = render(Component, {
    props: {
      job: {
        jobId: 'malformed-filesystem-failure', phase: 'failed', outcome: {
          kind: 'nothing-changed', failure: malformed
        }
      }
    }
  }).body;
  assert.equal(reads, 0);
  assert.doesNotMatch(rejected, /Filesystem check/u);
});

test('failed candidate boots render a closed actionable stage without reading malformed diagnostics', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const valid = render(Component, {
    props: {
      job: {
        jobId: 'candidate-boot-failure', phase: 'failed', outcome: {
          kind: 'nothing-changed',
          failure: {
            stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
          }
        }
      }
    }
  }).body;

  assert.match(valid, /Candidate boot check/u);
  assert.match(valid, /waiting for the isolated server to report that it was ready/u);
  assert.match(valid, /One or more mods failed during the isolated startup test/u);
  assert.match(valid, /Try another pack version or review the publisher release notes before retrying/u);

  let reads = 0;
  const malformed = { stage: 'candidate-boot', boundary: 'readiness' };
  Object.defineProperty(malformed, 'category', {
    enumerable: true,
    get() { reads += 1; return 'mod-loading-failure'; }
  });
  const rejected = render(Component, {
    props: {
      job: {
        jobId: 'malformed-candidate-boot-failure', phase: 'failed', outcome: {
          kind: 'nothing-changed', failure: malformed
        }
      }
    }
  }).body;

  assert.equal(reads, 0);
  assert.doesNotMatch(rejected, /Candidate boot check|isolated startup test/u);
});

test('stopped jobs make retry the single primary next action', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackJobProgress.svelte');
  const html = render(Component, {
    props: {
      job: {
        jobId: 'retry-job',
        phase: 'failed',
        outcome: {
          kind: 'nothing-changed',
          actions: [
            { actionId: 'retry', opaqueRef: 'retry-ref' },
            { actionId: 'change-selection', opaqueRef: 'selection-ref' }
          ]
        }
      }
    }
  }).body;

  assert.match(html, /class="mp-button primary[^>]*>Retry</u);
  assert.match(html, /class="mp-button"[^>]*>Change selection</u);
});

test('setup progress distinguishes completed, current, and upcoming steps and explains the protected destination', () => {
  const setup = source('src/components/setup/ServerSetupWizard.svelte');

  assert.match(setup, /class:completed=/u);
  assert.match(setup, /class:current=/u);
  assert.match(setup, /class:upcoming=/u);
  assert.match(setup, /native folder picker/u);
  assert.match(setup, /preflight checks/u);
  assert.match(setup, /Chosen destination/u);
});

test('busy plan review renders a truthful header and activity with determinate progress only for measured bytes', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/setup/ArchiveGuidedReview.svelte');
  const html = render(Component, {
    props: {
      inspection: null,
      busy: true,
      preflightProgress: {
        phase: 'preparing-candidate', activity: 'downloading-pack-files',
        processedBytes: 25, totalBytes: 100
      }
    }
  }).body;

  assert.match(html, /Preparing review/u);
  assert.match(html, /Downloading pack files/u);
  assert.match(html, /value="25"/u);
  assert.match(html, />25%/u);
});

test('busy plan review uses an accessible reduced-motion indeterminate indicator without real totals', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/setup/ArchiveGuidedReview.svelte');
  const html = render(Component, {
    props: {
      inspection: null,
      busy: true,
      preflightProgress: { phase: 'preparing-candidate', activity: 'hashing-candidate-files' }
    }
  }).body;

  assert.match(html, /Preparing review/u);
  assert.match(html, /Hashing candidate files/u);
  assert.match(html, /class="indeterminate/u);
  assert.doesNotMatch(html, /<progress/u);
  assert.match(source('src/components/modpacks/modpack-ui.css'), /prefers-reduced-motion: reduce/u);
});

test('guided review separates unavailable managed setup from the safe files-only fallback', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/setup/ArchiveGuidedReview.svelte');
  const inspect = kind => render(Component, {
    props: {
      inspection: {
        inspectionId: `inspection-${kind}`,
        rootCandidates: [],
        classification: { kind, confidence: 'exact', blocked: true }
      }
    }
  }).body;

  const customBootstrap = inspect('unsupported-runtime-layout');
  assert.match(customBootstrap, /Files-only import copies reviewed server data without running an archive launcher/u);
  assert.match(customBootstrap, /does not make the server managed or ready to start/u);
  assert.match(customBootstrap, /class="mp-button primary" disabled/u);
  assert.match(customBootstrap, /Import reviewed data as files-only/u);
  for (const kind of ['mrpack-client-only', 'multimc-client-only', 'backup-archive']) {
    assert.doesNotMatch(inspect(kind), /Import reviewed data as files-only/u);
  }
});

test('the app shell does not impose blue controls on every setup descendant', () => {
  const app = source('src/App.svelte');

  assert.doesNotMatch(app, /\.setup-container\s+:global\(button\)/u);
  assert.doesNotMatch(app, /\.setup-container\s+:global\(select\)/u);
});

test('create-server method exposes only pending setup recovery with setup-specific copy', async () => {
  const { render } = await import('svelte/server');
  const Component = await loadServerComponent('src/components/modpacks/ModpackRecoveryPanel.svelte');
  const pending = {
    recoveryId: 'recovery-' + 'a'.repeat(32),
    serverId: 'pending-' + 'a'.repeat(32),
    visibilityScope: 'pending-new-server',
    title: 'Recover install new operation',
    summary: 'Safe summary',
    phase: 'validating-candidate',
    automaticPossible: true,
    actions: [{ actionId: 'retry-recovery', label: 'Resolve interrupted setup', recommended: true }]
  };
  const registered = {
    recoveryId: 'recovery-' + 'b'.repeat(32),
    serverId: 'server-one',
    visibilityScope: 'registered-server',
    title: 'Do not show this server recovery',
    phase: 'cleanup-pending',
    actions: [{ actionId: 'retry-cleanup', label: 'Retry safe cleanup', recommended: true }]
  };

  const html = render(Component, {
    props: {
      records: { items: [registered, pending] },
      visibilityScope: 'pending-new-server',
      context: 'setup',
      hideWhenEmpty: true
    }
  }).body;

  assert.match(html, /Setup recovery/u);
  assert.match(html, /Unfinished server setup/u);
  assert.match(html, /Resolve interrupted setup/u);
  assert.doesNotMatch(html, /Do not show this server recovery|Retry safe cleanup/u);
  assert.doesNotMatch(html, /C:\\|destination path|pending-[a-f0-9]{32}/iu);

  const empty = render(Component, {
    props: {
      records: { items: [registered] },
      visibilityScope: 'pending-new-server',
      context: 'setup',
      hideWhenEmpty: true
    }
  }).body;
  assert.doesNotMatch(empty, /Setup recovery|No recovery action is pending/u);

  const wizard = source('src/components/setup/ServerSetupWizard.svelte');
  assert.match(wizard, /ModpackRecoveryPanel/u);
  assert.match(wizard, /visibilityScope="pending-new-server"/u);
});
