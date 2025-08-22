const {
  addModAvailabilityWatch,
  removeModAvailabilityWatch,
  clearModAvailabilityWatches,
  listModAvailabilityWatches,
  getModAvailabilityHistory,
  clearModAvailabilityHistory,
  setModAvailabilityInterval,
  getModAvailabilityConfig,
  startModAvailabilityWatcher
} = require('../services/mod-availability-watcher.cjs');

let logger = null;
try {
  const { getLoggerHandlers } = require('./logger-handlers.cjs');
  logger = getLoggerHandlers();
} catch {
  // Logger unavailable
}

function log(level, message, data) {
  if (logger && logger[level]) {
    logger[level](message, { category: 'mods', data: { handler: 'mod-availability', ...data } });
  }
}

function createModAvailabilityHandlers() {
  // Ensure background watcher started
  startModAvailabilityWatcher();
  return {
    'mod-watch:add': async (_e, { serverPath, projectId, modName, fileName, targetMc, targetFabric }) => {
      log('info', 'Adding mod availability watch', { serverPath, projectId, targetMc, targetFabric });
      return await addModAvailabilityWatch({ serverPath, projectId, modName, fileName, targetMc, targetFabric });
    },
    'mod-watch:remove': async (_e, { serverPath, projectId, targetMc, targetFabric }) => {
      log('info', 'Removing mod availability watch', { serverPath, projectId, targetMc, targetFabric });
      return await removeModAvailabilityWatch({ serverPath, projectId, targetMc, targetFabric });
    },
    'mod-watch:list': async (_e, serverPath) => {
      return await listModAvailabilityWatches(serverPath);
    },
    'mod-watch:clear': async (_e, serverPath) => {
      log('info', 'Clearing all mod availability watches', { serverPath });
      return await clearModAvailabilityWatches(serverPath);
    },
    'mod-watch:history': async (_e, serverPath) => {
      return await getModAvailabilityHistory(serverPath);
    },
    'mod-watch:history:clear': async (_e, serverPath) => {
      log('info', 'Clearing mod availability history', { serverPath });
      return await clearModAvailabilityHistory(serverPath);
    },
    'mod-watch:interval:set': async (_e, hours) => {
      return await setModAvailabilityInterval(hours);
    },
    'mod-watch:config': async (_e, serverPath) => {
      return await getModAvailabilityConfig(serverPath);
  }
  };
}

module.exports = { createModAvailabilityHandlers };
