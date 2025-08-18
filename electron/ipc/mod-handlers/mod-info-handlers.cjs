const modApiService = require('../../services/mod-api-service.cjs');
const modAnalysisUtils = require('../mod-utils/mod-analysis-utils.cjs');

function createModInfoHandlers() {
  return {
    'search-mods': async (_e, { keyword, loader, version, source, page = 1, limit = 20, sortBy = 'popular', environmentType = 'all' }) => {
      if (source === 'modrinth') {
        if (!keyword || keyword.trim() === '') {
          return await modApiService.getModrinthPopular({ loader, version, page, limit, sortBy, environmentType });
        }
        return await modApiService.searchModrinthMods({ query: keyword, loader, version, page, limit, sortBy, environmentType });
      } else if (source === 'curseforge') {
        if (!keyword || keyword.trim() === '') {
          return await modApiService.getCurseForgePopular({ loader, version, page, limit, environmentType });
        }
        return await modApiService.searchCurseForgeMods({ query: keyword, loader, version, page, limit, environmentType });
      }
      throw new Error(`Invalid source: ${source}`);
    },

    'get-mod-versions': async (_e, { modId, loader, mcVersion, source, loadLatestOnly }) => {
      if (source === 'modrinth') {
        return await modApiService.getModrinthVersions(modId, loader, mcVersion, loadLatestOnly);
      }
      throw new Error('Only Modrinth version fetching is currently fully supported via modApiService.');
    },

    'get-version-info': async (_e, { modId, versionId, source, gameVersion, loader }) => {
      if (source === 'modrinth') {
        return await modApiService.getModrinthVersionInfo(modId, versionId, gameVersion, loader);
      }
      throw new Error('Only Modrinth version info is currently fully supported via modApiService.');
    },

    'get-mod-info': async (_e, { modId, source }) => {
      if (source === 'modrinth') {
        return await modApiService.getModInfo(modId, source);
      }
      throw new Error('Only Modrinth mod info is currently fully supported via modApiService.');
    },

    'get-project-info': async (_e, { projectId, source }) => {
      if (source === 'modrinth') {
        return await modApiService.getModrinthProjectInfo(projectId);
      }
      throw new Error('Only Modrinth project info is currently fully supported via modApiService.');
    },

    'extract-jar-dependencies': async (_e, modPath) => {
      return await modAnalysisUtils.extractDependenciesFromJar(modPath);
    },

    'analyze-mod-from-url': async (_e, { url, modId }) => {
      return await modAnalysisUtils.analyzeModFromUrl(url, modId);
    },

    'search-shaders': async (_e, { keyword, loader, version, source, page = 1, limit = 20, sortBy = 'popular', environmentType = 'all' }) => {
      if (source === 'modrinth') {
        if (!keyword || keyword.trim() === '') {
          return await modApiService.getModrinthPopular({ 
            loader, 
            version, 
            page, 
            limit, 
            sortBy, 
            environmentType,
            projectType: 'shader'
          });
        }
        return await modApiService.searchModrinthMods({ 
          query: keyword, 
          loader, 
          version, 
          page, 
          limit, 
          sortBy, 
          environmentType,
          projectType: 'shader'
        });
      } else if (source === 'curseforge') {
        if (!keyword || keyword.trim() === '') {
          return await modApiService.getCurseForgePopular({ 
            loader, 
            version, 
            page, 
            limit, 
            environmentType
          });
        }
        return await modApiService.searchCurseForgeMods({ 
          query: keyword, 
          loader, 
          version, 
          page, 
          limit, 
          environmentType
        });
      }
      throw new Error(`Invalid source: ${source}`);
    },

    'search-resourcepacks': async (_e, { keyword, loader, version, source, page = 1, limit = 20, sortBy = 'popular', environmentType = 'all' }) => {
      if (source === 'modrinth') {
        if (!keyword || keyword.trim() === '') {
          return await modApiService.getModrinthPopular({ 
            loader, 
            version, 
            page, 
            limit, 
            sortBy, 
            environmentType,
            projectType: 'resourcepack'
          });
        }
        return await modApiService.searchModrinthMods({ 
          query: keyword, 
          loader, 
          version, 
          page, 
          limit, 
          sortBy, 
          environmentType,
          projectType: 'resourcepack'
        });
      } else if (source === 'curseforge') {
        if (!keyword || keyword.trim() === '') {
          return await modApiService.getCurseForgePopular({ 
            loader, 
            version, 
            page, 
            limit, 
            environmentType
          });
        }
        return await modApiService.searchCurseForgeMods({ 
          query: keyword, 
          loader, 
          version, 
          page, 
          limit, 
          environmentType
        });
      }
      throw new Error(`Invalid source: ${source}`);
    }
  };
}

module.exports = { createModInfoHandlers };
