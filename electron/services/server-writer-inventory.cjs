const crypto = require('node:crypto');
const path = require('node:path');

const SERVER_WRITER_HANDLER_FILES = Object.freeze([
  'electron/ipc/backup-handlers.cjs',
  'electron/ipc/config-handlers.cjs',
  'electron/ipc/file-handlers.cjs',
  'electron/ipc/install-handlers.cjs',
  'electron/ipc/management-server-handlers.cjs',
  'electron/ipc/minecraft-launcher-handlers.cjs',
  'electron/ipc/mod-availability-handlers.cjs',
  'electron/ipc/modpack-handlers.cjs',
  'electron/ipc/mod-handlers.cjs',
  'electron/ipc/mod-handlers/client-mod-handlers.cjs',
  'electron/ipc/mod-handlers/manual-mod-handlers.cjs',
  'electron/ipc/mod-handlers/server-mod-handlers.cjs',
  'electron/ipc/player-handlers.cjs',
  'electron/ipc/server-java-handlers.cjs',
  'electron/ipc/server-properties-handlers.cjs',
  'electron/ipc/settings-handlers.cjs'
]);

const SERVER_WRITER_ANCILLARY_CHANNELS = Object.freeze(new Set([
  'backups:create',
  'backups:create-full',
  'backups:create-incremental',
  'backups:calculate-sizes',
  'backups:clear-cache',
  'backups:watch-size-changes',
  'cancel-download',
  'clear-corruption-alert',
  'download-mod-from-fallback',
  'download-mod-from-server',
  'get-download-preferences',
  'handle-dropped-files',
  'mod-watch:interval:set',
  'modpacks:ack-notification',
  'modpacks:cancel-job',
  'modpacks:select-local-archive',
  'modpacks:update-tracking',
  'minecraft-list-reusable-auth',
  'minecraft-load-auth',
  'prioritize-download',
  'retry-download',
  'save-mod-categories',
  'save-temp-file',
  'select-mod-files',
  'set-instance-visibility',
  'set-server-path',
  'update-management-server-path',
  'update-server-path'
]));

const SERVER_WRITER_WRITE_SITE_DIGESTS = Object.freeze({
  'electron/bootstrap/create-modpack-service-graph.cjs': 'c8f69919d06d69de5d73d84caa4e1c21bc5d95a8d5c9bd6dd0cd031d6c7b3f1d',
  'electron/ipc/backup-handlers.cjs': '995f832f9d8b8985d08d7ffcc7f8f0b78be3d3ff94ece6c2f3cdcedcb54fac0d',
  'electron/ipc/config-handlers.cjs': '151afb76a3edb57ddeeb9fb24a150b23269c31b38279014a9691bc704f5e0ec6',
  'electron/ipc/file-handlers.cjs': 'be918d651aed580a58ed756f1cb2f39dc69ab9a20cb46974da62fb6240028707',
  'electron/ipc/install-handlers.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/ipc/management-server-handlers.cjs': 'cf28bfc4ae27930e34673299f97b144b204e8b131f9d9cf552cf8f5a9ab187cd',
  'electron/ipc/minecraft-launcher-handlers.cjs': 'ba99f7b69ae92a82f4e2cdf201a8bcebf584b4a1c342cd3b8a4b1784bebb7e58',
  'electron/ipc/mod-availability-handlers.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/ipc/mod-handlers.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/ipc/mod-handlers/client-mod-handlers.cjs': 'a024e7d4979e6c98946f9ac1f57d0c582aa9ba9d586df81fcc4ed0597a9cf97d',
  'electron/ipc/mod-handlers/manual-mod-handlers.cjs': 'e57e40e9867529da92ab29e36d3f57e703b433e6aff0a58155e62e28983fcc89',
  'electron/ipc/mod-handlers/server-mod-handlers.cjs': '5281ad8cb8c744d42305de058ea9f6563f857bb8825790440afbeb510a8d3186',
  'electron/ipc/mod-utils/file-integrity-service.cjs': 'e9f8638988e171c673b11a4fe39718e044821fe3b1222da141fcc7c950bdd528',
  'electron/ipc/mod-utils/mod-file-manager.cjs': '06fde5feced0bf3502069f8aaf1f28458dbae3dbe254d2605f57088a5e684333',
  'electron/ipc/mod-utils/mod-installation-service.cjs': 'e93eb84cccef6f6b05fc31b5616aadd65e9814f7b96a990ca51492f8fa7da42e',
  'electron/ipc/player-handlers.cjs': '8484397932aa267e27a85f184d8e196681b24c191702737054d917a0fdbe5b44',
  'electron/ipc/server-java-handlers.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/ipc/server-properties-handlers.cjs': '5daaeb2fea7a025d5fe6dd0bf0ff16d1475c463eb99722440349442b4b970c39',
  'electron/ipc/settings-handlers.cjs': '45d919eded7ecffe3d2970d61e395656bbf165d3848a54cad232f046356e6c94',
  'electron/main.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/services/auto-restart.cjs': 'f6c459eac819046a5060f59e5d153b57994d16133a93fd04d0f1ebb3cac79f7a',
  'electron/services/backup-service.cjs': '43c7bfd849a1c2e85ae22ea0d1266f6ba43bf6dcdc53b427a13e653fadcd8f4f',
  'electron/services/browser-panel-server.cjs': '22b27effe9025f5a671a189ccbc889ca03afffe0ca53b2b9a9abf768f00ddd89',
  // Reviewed: downloadWithProgress adds AbortSignal to its existing declaration;
  // destination writes/lease marking are unchanged, and pipeline now awaits close.
  'electron/services/download-manager.cjs': '506facc5de8adc181da754dca0a556318e1fd371698e1d2153f867bcfa698460',
  'electron/services/forge-runtime-finalizer-worker.cjs': 'c780be1547c8d6f53252d7d475fbba760f861e0b418197dad147ccae3dbe102d',
  'electron/services/java-archive-worker-client.cjs': '8da09e8e7729edc67f4cdf68a0be4a9b8de242e460f68c87584da6dbcce63b95',
  'electron/services/java-archive-worker.cjs': 'a08522a594d35e4561ea65c48e4f5ee21b8cb9127cfc17fd2dadcd063ea6333e',
  'electron/services/loader-install-service.cjs': '285a58782d5a5d20e888f37662db7cd1187b014035be16e2bfd5d5335d897a0f',
  'electron/services/managed-runtime-worker.cjs': '6e94d638b000e8baba70b5b00223d42637a9d4cf4063a143a5c2c7694f3947e3',
  'electron/services/minecraft-launcher/client-downloader.cjs': '9a98f34282bcd63b9f07025a13c77000c4e133da8adf4f11c1c8057490bc9e85',
  'electron/services/minecraft-launcher/index.cjs': '2a459f5ca8f7860dc20f996e8da5165aaf60f7b77471b67c667d8851fdc71f16',
  'electron/services/minecraft-launcher/java-manager.cjs': '1ab694f9ee3206f66bae53c58e136cf4301abb79d32412db6e5cfca939312d1f',
  'electron/services/minecraft-launcher/proper-launcher.cjs': '75e20ad94830666207f5378cea20879a678e5a67da582df852e83c9e42544c29',
  'electron/services/minecraft-launcher/xmcl-auth-handler.cjs': 'd04919177a1a150a98fe703b370ea1eda309d850290e2c0d71611dc10c396ff8',
  'electron/services/minecraft-launcher/xmcl-client-downloader.cjs': '306d60d0be1892af5d4def7f0542b6b0a6561b8cca9a2b397af9b9a2306f5a2f',
  'electron/services/mod-availability-watcher.cjs': '32672f2a7aec253c923436e52a49d75a299fcf302fb3183bda35a58599b6548d',
  'electron/services/server-content-revision.cjs': '83977927cdfea0dd8de6c5b6d3b3364ef9a21f8cd59314e2b95777053b18b8b8',
  'electron/services/server-java-manager.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/utils/config-manager.cjs': 'f69dc17eca786a11ec8db986f21c485f794540f6d51c18e1c8fe907c524b9f25',
  'electron/utils/tls-utils.cjs': '995f832f9d8b8985d08d7ffcc7f8f0b78be3d3ff94ece6c2f3cdcedcb54fac0d'
});

const WRITE_METHOD_PATTERN = /\b(?:fs|fsp|fsApi|fsPromises|fsSync)\s*(?:\.\s*promises)?\s*\.\s*(?:appendFile|appendFileSync|copyFile|copyFileSync|createWriteStream|mkdir|mkdirSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync|unlink|unlinkSync|write|writeFile|writeFileSync|writeSync)\s*\(|\b[A-Za-z_$][\w$]*Handle\s*(?:\?\.|\.)\s*(?:appendFile|createWriteStream|truncate|write|writeFile)\s*\(|\bcreateWriteStream\s*\(|\b(?:downloadWithProgress|ensureConfigFile(?:Strict)?|ensureServersDat|persistInviteMetadata|setInstanceConfig|updateServerConfig|updateServerInstance)\s*\(|\b__testUtils\s*(?:\?\.|\.)\s*(?:finalizeForgeRuntimeMetadata|prepareManagedServerRuntimeInProcess)\b/;
const WRITE_OPEN_PATTERN = /\b(?:fs|fsp|fsApi|fsPromises|fsSync)\s*(?:\.\s*promises)?\s*\.\s*(?:open|openSync)\s*\([^\r\n]*?,\s*['"](?:(?:a|as|ax|w|wx)\+?|(?:r|rs)\+)['"]\s*(?:,|\))/;
const MUTATING_CHANNEL_PATTERN = /(?:^|[-:])(add|acknowledge|auth|clear|delete|direct|disable|download|ensure|install|launch|migrate|move|regenerate|remove|rename|repair|restore|save|select|set|start|toggle|update|write|writer)(?:$|[-:])/;
const CHANNEL_PATTERN = /(?:^|[{,])\s*['"]([^'"]+)['"]\s*:\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm;

function normalizeWriteSite(line) {
  return line
    .replace(/\/\/.*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function computeWriteSiteDigest(source) {
  const sites = String(source)
    .split(/\r?\n/u)
    .filter(line => WRITE_METHOD_PATTERN.test(line) || WRITE_OPEN_PATTERN.test(line))
    .map(normalizeWriteSite)
    .sort();
  return crypto.createHash('sha256').update(JSON.stringify(sites)).digest('hex');
}

function scanUnaccountedWriteSites({ repositoryRoot, readFile, expectedDigests } = {}) {
  if (typeof repositoryRoot !== 'string' || typeof readFile !== 'function' ||
      !expectedDigests || typeof expectedDigests !== 'object') {
    throw new TypeError('Invalid writer inventory scan options');
  }
  return Object.entries(expectedDigests)
    .filter(([relativePath, expectedDigest]) => {
      const source = readFile(path.join(repositoryRoot, relativePath));
      return computeWriteSiteDigest(source) !== expectedDigest;
    })
    .map(([relativePath]) => relativePath)
    .sort();
}

function discoverMutatingChannels(source) {
  const channels = new Set();
  for (const match of String(source).matchAll(CHANNEL_PATTERN)) {
    if (MUTATING_CHANNEL_PATTERN.test(match[1])) channels.add(match[1]);
  }
  return channels;
}

function scanUnaccountedWriterChannels({
  repositoryRoot,
  readFile,
  handlerFiles,
  policies,
  ancillaryChannels = SERVER_WRITER_ANCILLARY_CHANNELS
} = {}) {
  if (typeof repositoryRoot !== 'string' || typeof readFile !== 'function' ||
      !Array.isArray(handlerFiles) || !policies || typeof policies !== 'object') {
    throw new TypeError('Invalid writer channel scan options');
  }
  const accounted = new Set([...Object.keys(policies), ...ancillaryChannels]);
  const discovered = new Set();
  for (const relativePath of handlerFiles) {
    for (const channel of discoverMutatingChannels(readFile(path.join(repositoryRoot, relativePath)))) {
      discovered.add(channel);
    }
  }
  return [...discovered].filter(channel => !accounted.has(channel)).sort();
}

module.exports = {
  SERVER_WRITER_ANCILLARY_CHANNELS,
  SERVER_WRITER_HANDLER_FILES,
  SERVER_WRITER_WRITE_SITE_DIGESTS,
  computeWriteSiteDigest,
  scanUnaccountedWriteSites,
  scanUnaccountedWriterChannels
};
