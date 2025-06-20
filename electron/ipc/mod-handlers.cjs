const fs = require('fs');
const path = require('path');
const { dialog, app } = require('electron');
const modFileManager = require('./mod-utils/mod-file-manager.cjs');
const { createServerModHandlers } = require('./mod-handlers/server-mod-handlers.cjs');
const { createClientModHandlers } = require('./mod-handlers/client-mod-handlers.cjs');
const { createManualModHandlers } = require('./mod-handlers/manual-mod-handlers.cjs');
const { createModInfoHandlers } = require('./mod-handlers/mod-info-handlers.cjs');

function createModHandlers(win) {
  const baseHandlers = {
    'select-mod-files': async () => {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Mod Files', extensions: ['jar'] }],
        title: 'Select Mod Files',
        defaultPath: app.getPath('downloads')
      });
      return result.canceled ? [] : result.filePaths;
    },
    'get-dropped-file-paths': async (_event, fileIdentifiers) => {
      if (!fileIdentifiers || !Array.isArray(fileIdentifiers) || !fileIdentifiers.length) {
        return [];
      }
      return fileIdentifiers.filter(f => f && f.path).map(f => f.path);
    },
    'handle-dropped-files': async (_event, files) => {
      if (!files || !files.length) return [];
      if (Array.isArray(files)) {
        if (files[0] && typeof files[0] === 'object') {
          return files.map(f => f.path || '').filter(Boolean);
        }
        if (typeof files[0] === 'string') return files;
      } else if (typeof files === 'object' && files.path) {
        return [files.path];
      }
      return [];
    },
    'save-temp-file': async (_event, { name, buffer }) => {
      return await modFileManager.saveTemporaryFile({ name, buffer });
    },
    'direct-add-mod': async (_event, { serverPath, fileName, buffer }) => {
      return await modFileManager.directAddMod({ serverPath, fileName, buffer });
    }
  };
  return {
    ...baseHandlers,
    ...createModInfoHandlers(),
    ...createServerModHandlers(win),
    ...createClientModHandlers(win),
    ...createManualModHandlers()
  };
}

module.exports = { createModHandlers };
