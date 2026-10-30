const fs = require('node:fs');
const { createStartupPageUrl } = require('./startup-window.cjs');
const { describeStartupFailure } = require('../bootstrap/startup-health.cjs');

const RELEASES_DOWNLOAD_URL = 'https://github.com/zXord/Minecraft-Core/releases/latest';
const DATA_SAFETY_LINE = 'Your servers, clients, worlds and settings were not changed.';
const FATAL_DIALOG_TITLE = 'Minecraft Core could not start';
const FATAL_DIALOG_BUTTONS = Object.freeze(['Check for updates', 'Open download page', 'Open log folder', 'Quit']);
const CHECK_FOR_UPDATES = FATAL_DIALOG_BUTTONS.indexOf('Check for updates');
const OPEN_DOWNLOAD_PAGE = FATAL_DIALOG_BUTTONS.indexOf('Open download page');
const OPEN_LOG_FOLDER = FATAL_DIALOG_BUTTONS.indexOf('Open log folder');
const QUIT = FATAL_DIALOG_BUTTONS.indexOf('Quit');
const PROGRESS_STEP_PERCENT = 5;
const PROGRESS_INTERVAL_MS = 1000;
const MAX_MESSAGE_LENGTH = 500;

const NOT_INSTALLED_MESSAGE = 'This copy of Minecraft Core is not the installed app, so it cannot install updates. Use Open download page to download the installer instead.';
const UPDATE_UNAVAILABLE_MESSAGE = 'Minecraft Core could not check for updates. Use Open download page to download the latest installer.';
const CHECK_FAILED_MESSAGE = 'Minecraft Core could not check for updates. Check your internet connection, or use Open download page.';
const CHECK_BUSY_MESSAGE = 'An update check is already running. Try again in a moment.';
const NO_UPDATE_MESSAGE = 'No newer version is available yet. Open the log folder for details, or use Open download page to see the releases.';
const DOWNLOAD_FAILED_MESSAGE = 'The update could not be downloaded. Try again, or use Open download page.';
const INSTALL_REFUSED_MESSAGE = 'The update was downloaded but could not be installed yet. Try again, or use Open download page.';
const INSTALLING_MESSAGE = 'The update is installing. Minecraft Core restarts when the installer finishes.';

function firstText(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text) return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
  }
  return null;
}

function readProperty(value, key) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function updateResult(status, message, version = null) {
  return Object.freeze(version ? { status, message, version } : { status, message });
}

function isUpdateService(value) {
  return ['checkForUpdates', 'downloadUpdate', 'on', 'removeListener']
    .every(method => typeof readProperty(value, method) === 'function');
}

async function readInstallCapability(updateService) {
  if (typeof readProperty(updateService, 'getInstallCapability') !== 'function') return { installed: false, message: null };
  let capability;
  try {
    capability = await updateService.getInstallCapability();
  } catch {
    return { installed: false, message: null };
  }
  if (capability === true) return { installed: true, message: null };
  if (!capability || typeof capability !== 'object') return { installed: false, message: null };
  const allowed = readProperty(capability, 'allowed');
  const installed = typeof allowed === 'boolean' ? allowed : readProperty(capability, 'installed') === true;
  return {
    installed: installed === true,
    message: firstText(readProperty(capability, 'message'), readProperty(capability, 'error'))
  };
}

function progressPercent(progress) {
  const value = Number(readProperty(progress, 'percent'));
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.floor(value)));
}

function downloadAndInstall(updateService, version, notify) {
  return new Promise(resolve => {
    let settled = false;
    let downloaded = false;
    const listeners = {
      'download-progress': progress => {
        if (!settled && !downloaded) notify({ phase: 'downloading', version, percent: progressPercent(progress) });
      },
      'update-downloaded': () => {
        if (settled) return;
        downloaded = true;
        // The update service starts the installer from its own update-downloaded
        // handler and reports a refused install as update-error in the same turn.
        setImmediate(() => {
          if (settled) return;
          notify({ phase: 'installing', version });
          finish(updateResult('installing', INSTALLING_MESSAGE, version));
        });
      },
      'update-error': details => {
        const message = firstText(readProperty(details, 'message'));
        finish(downloaded
          ? updateResult('install-refused', message || INSTALL_REFUSED_MESSAGE, version)
          : updateResult('download-failed', message || DOWNLOAD_FAILED_MESSAGE, version));
      }
    };
    function finish(result) {
      if (settled) return;
      settled = true;
      for (const [event, listener] of Object.entries(listeners)) updateService.removeListener(event, listener);
      resolve(result);
    }

    for (const [event, listener] of Object.entries(listeners)) updateService.on(event, listener);
    notify({ phase: 'downloading', version, percent: 0 });
    Promise.resolve()
      .then(() => updateService.downloadUpdate({ installAfterDownload: true }))
      .then(started => {
        if (!downloaded && readProperty(started, 'success') === false) {
          finish(updateResult('download-failed', firstText(readProperty(started, 'error')) || DOWNLOAD_FAILED_MESSAGE, version));
        }
      }, error => {
        if (!downloaded) {
          finish(updateResult('download-failed', firstText(readProperty(error, 'message')) || DOWNLOAD_FAILED_MESSAGE, version));
        }
      });
  });
}

/**
 * Checks for, downloads and installs an app update without the main window.
 * Only the installed copy may install: a service without the install-identity
 * API counts as not installed. Resolves {status: 'installing'} once the update
 * service has the downloaded installer and is starting it.
 */
async function runStandaloneUpdate({ updateService, onStatus = null } = {}) {
  const notify = status => {
    try {
      onStatus?.(Object.freeze(status));
    } catch {
      // Progress display is best effort and never changes the update outcome.
    }
  };
  if (!isUpdateService(updateService)) return updateResult('update-unavailable', UPDATE_UNAVAILABLE_MESSAGE);
  const capability = await readInstallCapability(updateService);
  if (!capability.installed) return updateResult('not-installed-copy', capability.message || NOT_INSTALLED_MESSAGE);

  notify({ phase: 'checking' });
  let check;
  try {
    check = await updateService.checkForUpdates();
  } catch (error) {
    return updateResult('check-failed', firstText(readProperty(error, 'message')) || CHECK_FAILED_MESSAGE);
  }
  if (readProperty(check, 'checking') === true) return updateResult('check-failed', CHECK_BUSY_MESSAGE);
  if (readProperty(check, 'success') !== true) {
    return updateResult('check-failed', firstText(readProperty(check, 'error')) || CHECK_FAILED_MESSAGE);
  }
  if (readProperty(check, 'updateAvailable') !== true) return updateResult('no-update', NO_UPDATE_MESSAGE);
  return downloadAndInstall(updateService, firstText(readProperty(check, 'latestVersion')), notify);
}

function usableWindow(window) {
  try {
    return window && !window.isDestroyed?.() ? window : null;
  } catch {
    return null;
  }
}

function hideWindow(window) {
  try {
    usableWindow(window)?.hide?.();
  } catch {
    // A window that cannot be hidden must not stop the failure report.
  }
}

function createSplashProgress(getSplash, description, now) {
  let lastPercent = null;
  let lastRenderedAt = 0;
  const withSplash = action => {
    const splash = getSplash();
    if (!splash) return;
    try {
      action(splash);
    } catch {
      // The splash only mirrors progress; the dialogs carry every outcome.
    }
  };
  const render = (heading, detail) => withSplash(splash => {
    const loading = splash.loadURL?.(createStartupPageUrl({ heading, detail }));
    if (loading && typeof loading.catch === 'function') void loading.catch(() => {});
  });
  const setProgress = value => withSplash(splash => { splash.setProgressBar?.(value); });

  return Object.freeze({
    showFailure() {
      lastPercent = null;
      setProgress(-1);
      render(FATAL_DIALOG_TITLE, description.summary);
    },
    show(status) {
      if (status.phase === 'checking') {
        render('Checking for updates…', 'Minecraft Core is looking for a newer version.');
      } else if (status.phase === 'installing') {
        setProgress(2);
        render('Installing the update…', 'Minecraft Core restarts when the installer finishes.');
      } else if (status.phase === 'downloading') {
        const time = now();
        const due = lastPercent === null || status.percent >= 100 ||
          status.percent - lastPercent >= PROGRESS_STEP_PERCENT || time - lastRenderedAt >= PROGRESS_INTERVAL_MS;
        if (!due) return;
        lastPercent = status.percent;
        lastRenderedAt = time;
        setProgress(status.percent / 100);
        render(`Downloading Minecraft Core ${status.version || 'update'}…`, `${status.percent}%`);
      }
    }
  });
}

/**
 * Creates the reporter for a startup failure that leaves no usable app. In
 * interactive mode it loops on a dialog offering Check for updates, Open
 * download page, Open log folder and Quit, modal to the splash when one is
 * open; before Electron is ready it can only show a plain error box. In
 * non-interactive mode (test, smoke and E2E harness runs) it logs, sets a
 * failing exit code and returns at once. report() resolves 'quit', or
 * 'installing' when an update installer has taken over.
 */
function createFatalStartupReporter({
  dialog = null,
  shell = null,
  app = null,
  getUpdateService = null,
  logDirectory = null,
  interactive,
  userDataPath = null,
  workerPath = null,
  existsSync = fs.existsSync,
  logger = console,
  processLike = process,
  now = Date.now
} = {}) {
  if (typeof interactive !== 'boolean') throw new TypeError('Fatal startup reporter interactive mode must be a boolean');
  if (logDirectory !== null && (typeof logDirectory !== 'string' || !logDirectory.trim())) {
    throw new TypeError('Fatal startup reporter log directory is invalid');
  }
  if (interactive) {
    if (typeof dialog?.showMessageBox !== 'function' || typeof dialog?.showErrorBox !== 'function') {
      throw new TypeError('Fatal startup reporter requires the Electron dialog API');
    }
    if (typeof shell?.openExternal !== 'function' || typeof shell?.openPath !== 'function') {
      throw new TypeError('Fatal startup reporter requires the Electron shell API');
    }
    if (typeof app?.isReady !== 'function') throw new TypeError('Fatal startup reporter requires the Electron app');
    if (typeof getUpdateService !== 'function') throw new TypeError('Fatal startup reporter requires an update service getter');
  } else if (!processLike || typeof processLike !== 'object') {
    throw new TypeError('Fatal startup reporter requires a process to mark the failed exit');
  }
  if (typeof now !== 'function') throw new TypeError('Fatal startup reporter clock is invalid');

  const logFolderLine = logDirectory ? `\n\nLog folder: ${logDirectory}` : '';

  function logFailure(description) {
    try {
      logger?.error?.('Minecraft Core could not start', {
        stage: description.stage,
        reason: description.reason,
        summary: description.summary,
        technical: description.technical,
        logDirectory
      });
    } catch {
      // Logging is the last resort in non-interactive runs and must not throw.
    }
  }

  async function showMessage(parent, options) {
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }

  async function showInfo(parent, message) {
    try {
      await showMessage(parent, {
        type: 'info',
        title: FATAL_DIALOG_TITLE,
        message,
        buttons: ['OK'],
        defaultId: 0,
        noLink: true
      });
    } catch {
      // The fatal dialog is shown again next, so a lost notice is not silent.
    }
  }

  async function askNextStep(parent, description) {
    try {
      const result = await showMessage(parent, {
        type: 'error',
        title: FATAL_DIALOG_TITLE,
        message: description.summary,
        detail: `${description.hint}\n\n${DATA_SAFETY_LINE}\n\nTechnical details: ${description.technical}${logFolderLine}`,
        buttons: [...FATAL_DIALOG_BUTTONS],
        defaultId: CHECK_FOR_UPDATES,
        cancelId: QUIT,
        noLink: true
      });
      return Number.isInteger(result?.response) ? result.response : QUIT;
    } catch {
      return QUIT;
    }
  }

  async function checkForUpdates(progress) {
    try {
      return await runStandaloneUpdate({ updateService: getUpdateService(), onStatus: status => progress.show(status) });
    } catch {
      return updateResult('update-unavailable', UPDATE_UNAVAILABLE_MESSAGE);
    }
  }

  async function openDownloadPage(parent) {
    try {
      await shell.openExternal(RELEASES_DOWNLOAD_URL);
    } catch {
      await showInfo(parent, `Open ${RELEASES_DOWNLOAD_URL} in your browser to download the latest installer.`);
    }
  }

  async function openLogFolder(parent) {
    if (!logDirectory) {
      await showInfo(parent, 'The log folder is not available.');
      return;
    }
    let failure;
    try {
      failure = await shell.openPath(logDirectory);
    } catch {
      failure = 'unavailable';
    }
    if (failure) await showInfo(parent, `The log folder could not be opened: ${logDirectory}`);
  }

  async function report(error, { splash = null, mainWindow = null } = {}) {
    hideWindow(mainWindow);
    const description = describeStartupFailure(error, { userDataPath, workerPath, existsSync });
    if (!interactive) {
      logFailure(description);
      processLike.exitCode = 1;
      return 'quit';
    }
    if (!app.isReady()) {
      try {
        dialog.showErrorBox(FATAL_DIALOG_TITLE, `${description.summary}\n\n${description.hint}\n\n${DATA_SAFETY_LINE}\n\n` +
          `Download the latest version from ${RELEASES_DOWNLOAD_URL}\n\nTechnical details: ${description.technical}${logFolderLine}`);
      } catch {
        logFailure(description);
      }
      return 'quit';
    }

    const currentSplash = () => usableWindow(splash);
    const progress = createSplashProgress(currentSplash, description, now);
    progress.showFailure();
    for (;;) {
      const response = await askNextStep(currentSplash(), description);
      if (response === CHECK_FOR_UPDATES) {
        const outcome = await checkForUpdates(progress);
        if (outcome.status === 'installing') return 'installing';
        progress.showFailure();
        await showInfo(currentSplash(), outcome.message);
      } else if (response === OPEN_DOWNLOAD_PAGE) {
        await openDownloadPage(currentSplash());
      } else if (response === OPEN_LOG_FOLDER) {
        await openLogFolder(currentSplash());
      } else {
        return 'quit';
      }
    }
  }

  return Object.freeze({ report });
}

module.exports = {
  DATA_SAFETY_LINE,
  FATAL_DIALOG_BUTTONS,
  RELEASES_DOWNLOAD_URL,
  createFatalStartupReporter,
  describeStartupFailure,
  runStandaloneUpdate
};
