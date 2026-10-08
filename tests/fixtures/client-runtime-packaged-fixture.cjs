'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { startClientRuntimeWorker } = require('../../electron/services/client-modpacks/client-runtime-worker.cjs');
startClientRuntimeWorker({ prepareImpl: async ({ clientPath, onProgress }) => {
  const { JavaManager } = require('../../electron/services/minecraft-launcher/java-manager.cjs');
  const { ProperMinecraftLauncher } = require('../../electron/services/minecraft-launcher/proper-launcher.cjs');
  const { installClientLoader } = require('../../electron/services/loader-install-service.cjs');
  const { installLibraries } = require('@xmcl/installer');
  if ([JavaManager, ProperMinecraftLauncher, installClientLoader, installLibraries].some(value => typeof value !== 'function')) throw Error('Runtime dependencies unavailable');
  onProgress({ phase: 'libraries', files: 4, totalFiles: 4 });
  fs.writeFileSync(path.join(clientPath, '.runtime-require-fixture'), 'loaded');
} });
