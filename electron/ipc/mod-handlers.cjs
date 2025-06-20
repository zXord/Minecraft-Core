const { dialog, app } = require('electron');
const modFileManager = require('./mod-utils/mod-file-manager.cjs');
const { createServerModHandlers } = require('./mod-handlers/server-mod-handlers.cjs');
const { createClientModHandlers } = require('./mod-handlers/client-mod-handlers.cjs');
const { createModInfoHandlers } = require('./mod-handlers/mod-info-handlers.cjs');
const { createManualModHandlers } = require('./mod-handlers/manual-mod-handlers.cjs');

function createModHandlers(win) {
  const generalHandlers = {
    'select-mod-files': async () => {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Mod Files', extensions: ['jar'] }],
        title: 'Select Mod Files',
        defaultPath: app.getPath('downloads')
      });
      if (result.canceled) return [];
      return result.filePaths;
    },

    'get-dropped-file-paths': async (_e, fileIdentifiers) => {
      if (!fileIdentifiers || !Array.isArray(fileIdentifiers) || !fileIdentifiers.length) {
        return [];
      }
      return fileIdentifiers.filter(f => f && f.path).map(f => f.path);
    },

    'handle-dropped-files': async (_e, files) => {
      if (!files || !files.length) return [];
      let filePaths = [];
      if (Array.isArray(files)) {
        if (files[0] && typeof files[0] === 'object') {
          filePaths = files.map(file => file.path || '').filter(Boolean);
        } else if (typeof files[0] === 'string') {
          filePaths = files;
        }
      } else if (typeof files === 'object' && files.path) {
        filePaths = [files.path];
      }
      return filePaths;
    },

    'save-temp-file': async (_e, { name, buffer }) => {
      return await modFileManager.saveTemporaryFile({ name, buffer });
    },

    'direct-add-mod': async (_e, { serverPath, fileName, buffer }) => {
      return await modFileManager.directAddMod({ serverPath, fileName, buffer });
    }
  };

  return {
    ...generalHandlers,
    ...createModInfoHandlers(),
    ...createServerModHandlers(win),
    ...createClientModHandlers(win),
    ...createManualModHandlers(),
  };
}

module.exports = { createModHandlers };
