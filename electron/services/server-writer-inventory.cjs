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
  // Reviewed: one mkdir of <userData>/client-packs/processes for the degraded
  // client guard; it writes no instance folder and refuses durable launch records.
  'electron/bootstrap/create-degraded-modpack-fallbacks.cjs': 'ba28e50fd52e1adffa83cecab3efa06bae8bed13dd202d74a707278b11ac70c3',
  'electron/bootstrap/create-modpack-service-graph.cjs': 'c8f69919d06d69de5d73d84caa4e1c21bc5d95a8d5c9bd6dd0cd031d6c7b3f1d',
  'electron/ipc/backup-handlers.cjs': '995f832f9d8b8985d08d7ffcc7f8f0b78be3d3ff94ece6c2f3cdcedcb54fac0d',
  'electron/ipc/config-handlers.cjs': '151afb76a3edb57ddeeb9fb24a150b23269c31b38279014a9691bc704f5e0ec6',
  'electron/ipc/file-handlers.cjs': 'be918d651aed580a58ed756f1cb2f39dc69ab9a20cb46974da62fb6240028707',
  'electron/ipc/install-handlers.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/ipc/management-server-handlers.cjs': 'cf28bfc4ae27930e34673299f97b144b204e8b131f9d9cf552cf8f5a9ab187cd',
  // Reviewed: the same ensureServersDat write site now captures its result so a
  // failed registered info read stops marker creation/launch. All 56 sites remain.
  'electron/ipc/minecraft-launcher-handlers.cjs': '853ca8611ee4f127c0a95ce32b5027b86a96f2126fb7517ebc330abbd6d5f870',
  'electron/ipc/mod-availability-handlers.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/ipc/mod-handlers.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/ipc/mod-handlers/client-mod-handlers.cjs': 'a024e7d4979e6c98946f9ac1f57d0c582aa9ba9d586df81fcc4ed0597a9cf97d',
  'electron/ipc/mod-handlers/manual-mod-handlers.cjs': 'e57e40e9867529da92ab29e36d3f57e703b433e6aff0a58155e62e28983fcc89',
  'electron/ipc/mod-handlers/server-mod-handlers.cjs': '5281ad8cb8c744d42305de058ea9f6563f857bb8825790440afbeb510a8d3186',
  'electron/ipc/mod-utils/file-integrity-service.cjs': 'e9f8638988e171c673b11a4fe39718e044821fe3b1222da141fcc7c950bdd528',
  // Reviewed: ignored-updates saves stage a 'wx' temp file, set unreadable bytes
  // aside and publish by rename; only minecraft-core-configs is ever created.
  'electron/ipc/mod-utils/mod-file-manager.cjs': 'c17efbd05dfac4675ad660582134eaf6729535593fb595fe4142021b1cd4cbf9',
  'electron/ipc/mod-utils/mod-installation-service.cjs': 'e93eb84cccef6f6b05fc31b5616aadd65e9814f7b96a990ca51492f8fa7da42e',
  'electron/ipc/player-handlers.cjs': '8484397932aa267e27a85f184d8e196681b24c191702737054d917a0fdbe5b44',
  'electron/ipc/server-java-handlers.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/ipc/server-properties-handlers.cjs': '5daaeb2fea7a025d5fe6dd0bf0ff16d1475c463eb99722440349442b4b970c39',
  'electron/ipc/settings-handlers.cjs': '45d919eded7ecffe3d2970d61e395656bbf165d3848a54cad232f046356e6c94',
  'electron/main.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  'electron/services/auto-restart.cjs': 'f6c459eac819046a5060f59e5d153b57994d16133a93fd04d0f1ebb3cac79f7a',
  // Reviewed: restore extraction (v26.6.1) now counts as a site, and after it
  // restoreContentRevision puts the pre-restore counter back (N4); both run after
  // the entry check and the dirty mark, inside the stopped-only restore lease.
  'electron/services/backup-service.cjs': '2ea87a45d050726ebf7dc3dd690d9328119038f80dee6687ad1b0b93d2b34e04',
  'electron/services/browser-panel-server.cjs': '22b27effe9025f5a671a189ccbc889ca03afffe0ca53b2b9a9abf768f00ddd89',
  // Reviewed: downloadWithProgress adds AbortSignal to its existing declaration;
  // destination writes/lease marking are unchanged, and pipeline now awaits close.
  'electron/services/download-manager.cjs': '506facc5de8adc181da754dca0a556318e1fd371698e1d2153f867bcfa698460',
  'electron/services/forge-runtime-finalizer-worker.cjs': 'c780be1547c8d6f53252d7d475fbba760f861e0b418197dad147ccae3dbe102d',
  'electron/services/java-archive-worker-client.cjs': '8da09e8e7729edc67f4cdf68a0be4a9b8de242e460f68c87584da6dbcce63b95',
  // Reviewed: unchanged code; newly visible are the O_RDONLY|O_NOFOLLOW open of
  // the pinned archive and the extraction into the request-unique staging folder.
  'electron/services/java-archive-worker.cjs': 'f53001e80f3468c111f4f57749cd5024d42d68e57903c3133e8b5a73368a3a05',
  // Reviewed: the NeoForge vanilla root copy is gone; a regular root jar in the
  // private runtime staging folder is removed before the guard. Still 27 sites.
  'electron/services/loader-install-service.cjs': '09022a8e755141ccf95344adf9e7217c6ab47e2972e1f287453b7bfd7caa2c66',
  'electron/services/managed-runtime-worker.cjs': '6e94d638b000e8baba70b5b00223d42637a9d4cf4063a143a5c2c7694f3947e3',
  // Reviewed: unchanged code; the newly visible writeZip builds the client's
  // Fabric profile jar inside the coordinated client runtime download.
  'electron/services/minecraft-launcher/client-downloader.cjs': 'b6c4c2eee95641901eb354c0225449a25f5524ccf57f3eb1fda689268a2ecca1',
  'electron/services/minecraft-launcher/index.cjs': '2a459f5ca8f7860dc20f996e8da5165aaf60f7b77471b67c667d8851fdc71f16',
  'electron/services/minecraft-launcher/java-manager.cjs': '1ab694f9ee3206f66bae53c58e136cf4301abb79d32412db6e5cfca939312d1f',
  'electron/services/minecraft-launcher/proper-launcher.cjs': '75e20ad94830666207f5378cea20879a678e5a67da582df852e83c9e42544c29',
  'electron/services/minecraft-launcher/xmcl-auth-handler.cjs': 'd04919177a1a150a98fe703b370ea1eda309d850290e2c0d71611dc10c396ff8',
  'electron/services/minecraft-launcher/xmcl-client-downloader.cjs': '306d60d0be1892af5d4def7f0542b6b0a6561b8cca9a2b397af9b9a2306f5a2f',
  'electron/services/mod-availability-watcher.cjs': '32672f2a7aec253c923436e52a49d75a299fcf302fb3183bda35a58599b6548d',
  // Reviewed: the read-only session.lock probe; it opens server.properties and
  // the lock with 'r' and has no write site.
  'electron/services/modpack-lifecycle/live-server-folder-probe.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  // Reviewed: the ownership predicate only stats and lstats; it has no write site.
  'electron/services/modpacks/instance-ownership.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  // Reviewed: the client counter compare-and-sets client-config.json through the
  // capability the coordinator passes (the legacy writer for unmanaged folders).
  'electron/services/server-content-revision.cjs': '0595e5631d3be13d4052ec5b7e3a4a85f5b0e4bf2dc521661c5768758d64e6a1',
  'electron/services/server-java-manager.cjs': '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  // Reviewed: start-lease writers; the server.properties overlay (skipped when
  // unchanged) and the Forge root shim copy each mark the start lease dirty first.
  'electron/services/server-launcher.cjs': 'ebaccf1fb5bd408ae492b8eff852eee8b23c853e9ab23842efcafe1b9ab86400',
  // Reviewed: config publication is writeJsonAtomic with an expected sha256; only
  // the legacy writer preserves unreadable bytes first; restoreContentRevision
  // writes back exactly the pre-restore counter, keeping every restored field.
  'electron/utils/config-manager.cjs': '85a3df5233ae06e9aac3324a500a5f65ac54b24df3e67993e52d095caf966598',
  // Reviewed: the legacy writer for folders without evidence; 'wx' temp, fsync,
  // rename, and on EPERM/EACCES/EBUSY the in-place compare-and-set write
  // ('wx'/'w'/'r+', truncate, fsync); create-only *.unreadable-* copies.
  'electron/utils/instance-config-fs.cjs': '467ba134dd12553038492853fd58013aa3b8b52014f6d39d6a8ab3f2c1bbb9f3',
  'electron/utils/tls-utils.cjs': '995f832f9d8b8985d08d7ffcc7f8f0b78be3d3ff94ece6c2f3cdcedcb54fac0d'
});

// Durable publication (writeJsonAtomic, preserveUnreadable, ...) and zip writes
// count on any receiver; restoreContentRevision writes a server config.
const WRITE_METHOD_PATTERN = /\b(?:fs|fsp|fsApi|fsPromises|fsSync)\s*(?:\.\s*promises)?\s*\.\s*(?:appendFile|appendFileSync|copyFile|copyFileSync|createWriteStream|ftruncate|ftruncateSync|mkdir|mkdirSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync|unlink|unlinkSync|write|writeFile|writeFileSync|writeSync)\s*\(|\b[A-Za-z_$][\w$]*Handle\s*(?:\?\.|\.)\s*(?:appendFile|createWriteStream|truncate|write|writeFile)\s*\(|\bcreateWriteStream\s*\(|(?:\?\.|\.)\s*(?:extractAllTo(?:Async)?|extractEntryTo|preserveUnreadable|renameDurable(?:Async)?|writeFileAtomic(?:Async)?|writeJsonAtomic(?:Async)?|writeZip)\s*\(|\b(?:downloadWithProgress|ensureConfigFile(?:Strict)?|ensureServersDat|persistInviteMetadata|restoreContentRevision|setInstanceConfig|updateServerConfig|updateServerInstance)\s*\(|\b__testUtils\s*(?:\?\.|\.)\s*(?:finalizeForgeRuntimeMetadata|prepareManagedServerRuntimeInProcess)\b/;
const WRITE_OPEN_PATTERN = /\b(?:fs|fsp|fsApi|fsPromises|fsSync)\s*(?:\.\s*promises)?\s*\.\s*(?:open|openSync)\s*\([^\r\n]*?,\s*['"](?:(?:a|as|ax|w|wx)\+?|(?:r|rs)\+)['"]\s*(?:,|\))/;
// An open whose flag is computed may write (the legacy config writer chooses
// 'wx', 'w' or 'r+'); only a literal or an explicit O_RDONLY flag is read-only.
const WRITE_COMPUTED_OPEN_PATTERN = /\b(?:fs|fsp|fsApi|fsPromises|fsSync)\s*(?:\.\s*promises)?\s*\.\s*(?:open|openSync)\s*\((?:[^,()\r\n]|\([^()\r\n]*\))*,\s*(?!['"]|(?:fs|fsp|fsApi|fsPromises|fsSync)\s*\.\s*constants\s*\.\s*O_RDONLY\b)[^\s,)]/;
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
    .filter(line => WRITE_METHOD_PATTERN.test(line) || WRITE_OPEN_PATTERN.test(line) ||
      WRITE_COMPUTED_OPEN_PATTERN.test(line))
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
