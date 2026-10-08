const Ajv = require('ajv');
const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { ModpackError, FAILURE_CODES, PUBLIC_ERROR_DETAILS_BY_CODE, deepFreeze, isValidPublicErrorResult } = require('./errors.cjs');
const { normalizeRuntimeTuple } = require('./contracts.cjs');

const ajv = new Ajv({ allErrors: true, strict: true });

const runtimeTupleSchema = {
  type: 'object', additionalProperties: false,
  required: ['minecraftVersion', 'loaderFamily', 'loaderVersion', 'javaMajor', 'os', 'architecture'],
  properties: {
    minecraftVersion: { type: 'string', pattern: '^\\d+\\.\\d+(?:\\.\\d+)?(?:-[A-Za-z0-9._-]+)?$', maxLength: 64 },
    loaderFamily: { enum: ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'] },
    loaderVersion: { type: 'string', minLength: 1, maxLength: 128 },
    javaMajor: { type: 'integer', minimum: 8, maximum: 99 },
    os: { const: 'win32' },
    architecture: { const: 'x64' }
  }
};

function detailSchema(kind) {
  if (Array.isArray(kind)) return { enum: kind };
  const common = { type: 'string' };
  if (kind === 'decimal') return { type: 'string', pattern: '^(0|[1-9][0-9]*)$' };
  if (kind === 'algorithm') return { enum: ['sha1', 'sha256', 'sha512'] };
  if (kind === 'provider') return { enum: ['modrinth', 'github', 'local'] };
  if (kind === 'archiveFamily') return { enum: ['mrpack', 'zip', 'rar4', 'rar5', 'multipart-rar'] };
  if (kind === 'loaderFamily') return { enum: ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'] };
  if (kind === 'limit') return { enum: ['maxArtifactSetBytes', 'maxArchiveEntries', 'maxExpandedBytes', 'maxFileExpandedBytes', 'maxPathDepth', 'maxNormalizedPathLength', 'maxTechnicalStdoutBytes', 'maxTechnicalStderrBytes', 'maxListTestMs', 'maxExtractionMs', 'maxChildJobMemoryBytes'] };
  if (kind === 'digest') return { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64}|[a-f0-9]{128})$' };
  if (kind === 'id') return { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };
  if (kind === 'field') return { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.]{0,127}$' };
  return { ...common, minLength: 1, maxLength: 256, pattern: '^[^\\\\/?\\u0000-\\u001f]+$' };
}

const publicErrorResultSchema = {
  type: 'object', additionalProperties: false, required: ['ok', 'error'], properties: {
    ok: { const: false },
    error: {
      oneOf: FAILURE_CODES.map((code) => ({
        type: 'object', additionalProperties: false, required: ['code', 'message', 'details', 'retryable'], properties: {
          code: { const: code },
          message: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\\\/?\\u0000-\\u001f]+$' },
          retryable: { type: 'boolean' },
          details: {
            type: 'object', additionalProperties: false,
            properties: Object.fromEntries(Object.entries(PUBLIC_ERROR_DETAILS_BY_CODE[code]).map(([name, kind]) => [name, detailSchema(kind)]))
          }
        }
      }))
    }
  }
};

const validators = Object.freeze({
  RuntimeTuple: ajv.compile(runtimeTupleSchema),
  PublicModpackErrorResult: ajv.compile(publicErrorResultSchema)
});

const MODPACK_INVOKE_CHANNELS = Object.freeze([
  'modpacks:search-catalog', 'modpacks:get-project', 'modpacks:list-versions', 'modpacks:list-github-releases',
  'modpacks:list-github-assets', 'modpacks:select-local-archive', 'modpacks:reserve-server-destination',
  'modpacks:release-server-destination', 'modpacks:inspect', 'modpacks:cancel-inspection', 'modpacks:preflight',
  'modpacks:preflight-management', 'modpacks:start-operation', 'modpacks:cancel-job', 'modpacks:get-job', 'modpacks:get-state',
  'modpacks:list-history', 'modpacks:list-rollback-options', 'modpacks:list-recovery', 'modpacks:recover', 'modpacks:list-notifications',
  'modpacks:ack-notification', 'modpacks:check-updates', 'modpacks:update-tracking', 'modpacks:verify',
  'modpacks:perform-safe-action'
]);
const MODPACK_EVENT_CHANNELS = Object.freeze([
  'modpacks:job-progress', 'modpacks:job-log', 'modpacks:state-changed', 'modpacks:notification',
  'modpacks:inspection-progress', 'modpacks:preflight-progress'
]);

const idSchema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$' };
const shortIdSchema = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };
const fingerprintSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const nullableIdSchema = { anyOf: [idSchema, { type: 'null' }] };
const nullableStringSchema = { anyOf: [{ type: 'string', minLength: 1, maxLength: 512 }, { type: 'null' }] };
const safeJsonSchema = {
  $id: 'minecraft-core-safe-json',
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string', maxLength: 16_384 },
    { type: 'array', maxItems: 10_000, items: { $ref: 'minecraft-core-safe-json' } },
    {
      type: 'object', maxProperties: 512,
      propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$' },
      additionalProperties: { $ref: 'minecraft-core-safe-json' }
    }
  ]
};
ajv.addSchema(safeJsonSchema);

function closed(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, required, properties };
}

const emptyRequest = closed({});
const executionChoicesSchema = closed({
  acceptEula: { type: 'boolean' },
  startAfterInstall: { type: 'boolean' },
  restorePointId: nullableIdSchema
}, []);
const conflictChoicesSchema = closed({
  paths: {
    type: 'object', maxProperties: 10_000,
    propertyNames: idSchema,
    additionalProperties: closed({
      choice: { enum: ['keep-mine', 'use-pack', 'keep-both', 'disable-addon', 'remove-addon'] },
      alternateId: idSchema
    }, ['choice'])
  },
  categories: {
    type: 'object', additionalProperties: false,
    properties: Object.fromEntries([
      'mod', 'configuration', 'world', 'runtime', 'library', 'server', 'resource', 'shader', 'application', 'secret', 'other'
    ].map(role => [role, { enum: ['keep-mine', 'use-pack'] }]))
  }
}, []);
const selectedArchiveRootSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'string', minLength: 1, maxLength: 255,
      pattern: '^(?!\\.{1,2}$)(?!.*[. ]$)[^\\\\/:*?"<>\\u0000-\\u001f\\u007f]+$'
    }
  ]
};
const runtimeChoiceSchema = {
  anyOf: [
    { type: 'null' },
    closed({
      minecraftVersion: {
        type: 'string', minLength: 3, maxLength: 64,
        pattern: '^\\d+\\.\\d+(?:\\.\\d+)?(?:-[A-Za-z0-9._-]+)?$'
      },
      loaderFamily: { enum: ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'] },
      loaderVersion: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$' }
    })
  ]
};
const planningSelectionsSchema = closed({
  optionalFileIds: { type: 'array', maxItems: 10_000, uniqueItems: true, items: idSchema },
  conflictChoices: conflictChoicesSchema,
  acknowledgeMissingProviderDigest: { type: 'boolean' },
  acknowledgeDowngradeWorldRisk: { type: 'boolean' },
  selectedRoot: selectedArchiveRootSchema,
  runtimeChoice: runtimeChoiceSchema,
  maxRam: { anyOf: [{ type: 'integer', minimum: 1, maximum: 64 }, { type: 'null' }] },
  serverPort: { anyOf: [{ type: 'integer', minimum: 1025, maximum: 65535 }, { type: 'null' }] },
  networkAccess: { anyOf: [{ enum: ['pack-default', 'loopback'] }, { type: 'null' }] }
}, ['optionalFileIds', 'conflictChoices', 'acknowledgeMissingProviderDigest']);

const trackingRecordSchema = closed({
  trackingId: idSchema,
  serverId: shortIdSchema,
  provider: { enum: ['github', 'modrinth'] },
  projectId: nullableIdSchema,
  repositoryId: nullableIdSchema,
  githubOwner: nullableStringSchema,
  githubRepo: nullableStringSchema,
  includePrereleases: { type: 'boolean' },
  acceptedMapping: { anyOf: [{ $ref: 'minecraft-core-safe-json' }, { type: 'null' }] },
  assetPattern: { anyOf: [{ $ref: 'minecraft-core-safe-json' }, { type: 'null' }] },
  etag: nullableStringSchema,
  lastSuccessfulCheck: nullableStringSchema,
  lastFailure: { anyOf: [{ $ref: 'minecraft-core-safe-json' }, { type: 'null' }] },
  nextDueAt: { type: 'string', minLength: 1, maxLength: 64 },
  lastSnapshot: { anyOf: [{ $ref: 'minecraft-core-safe-json' }, { type: 'null' }] }
});

const requestSchemas = Object.freeze({
  'modpacks:search-catalog': closed({
    query: { type: 'string', maxLength: 256 },
    categories: { type: 'array', maxItems: 64, uniqueItems: true, items: idSchema },
    gameVersion: { type: 'string', maxLength: 64 },
    loader: { enum: ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'] },
    serverCompatibility: { enum: ['compatible', 'required', 'optional', 'unsupported', 'unknown'] },
    sort: { enum: ['updated', 'downloads'] },
    offset: { type: 'integer', minimum: 0, maximum: 10000 },
    limit: { type: 'integer', minimum: 1, maximum: 100 }
  }, []),
  'modpacks:get-project': closed({ projectId: shortIdSchema }),
  'modpacks:list-versions': closed({
    projectId: shortIdSchema,
    gameVersions: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', maxLength: 64 } },
    loaders: { type: 'array', maxItems: 16, uniqueItems: true, items: { enum: ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'] } },
    channels: { type: 'array', maxItems: 3, uniqueItems: true, items: { enum: ['release', 'beta', 'alpha'] } }
  }, ['projectId']),
  'modpacks:list-github-releases': closed({
    repositoryUrl: { type: 'string', pattern: '^https://github\\.com/[A-Za-z0-9-]{1,39}/(?!\\.)[A-Za-z0-9_.-]{1,100}(?:/releases/tag/[^/?#]{1,128})?/?$', maxLength: 512 },
    includePrereleases: { type: 'boolean' },
    cursor: { anyOf: [{ type: 'string', pattern: '^github-page-[1-9][0-9]*$' }, { type: 'null' }] }
  }, ['repositoryUrl', 'includePrereleases']),
  'modpacks:list-github-assets': closed({
    repositoryId: idSchema,
    releaseId: idSchema,
    serverId: shortIdSchema
  }, ['repositoryId', 'releaseId']),
  'modpacks:select-local-archive': closed({ allowMultipart: { type: 'boolean' } }),
  'modpacks:reserve-server-destination': emptyRequest,
  'modpacks:release-server-destination': closed({ instanceId: shortIdSchema }),
  'modpacks:inspect': {
    type: 'object', additionalProperties: false, required: ['provider'],
    properties: {
      provider: { enum: ['modrinth', 'github', 'local'] },
      projectId: shortIdSchema,
      versionId: shortIdSchema,
      repositoryId: idSchema,
      releaseId: idSchema,
      assetIds: { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: idSchema },
      selectionId: idSchema,
      rememberAssetPattern: { type: 'boolean' },
      linkedModrinthProjectId: shortIdSchema,
      requestId: shortIdSchema
    },
    allOf: [{
      if: { type: 'object', required: ['provider'], properties: { provider: { const: 'github' } } },
      then: true,
      else: {
        type: 'object',
        not: { anyOf: [
          { type: 'object', properties: { rememberAssetPattern: {} }, required: ['rememberAssetPattern'] },
          { type: 'object', properties: { linkedModrinthProjectId: {} }, required: ['linkedModrinthProjectId'] }
        ] }
      }
    }]
  },
  'modpacks:cancel-inspection': {
    oneOf: [
      closed({ requestId: shortIdSchema }),
      closed({ inspectionId: shortIdSchema })
    ]
  },
  'modpacks:preflight': closed({
    inspectionId: shortIdSchema,
    instanceId: shortIdSchema,
    operationKind: { enum: [
      'install-new', 'install-existing', 'update', 'downgrade', 'switch', 'repair', 'rollback-restore-point',
      'files-only', 'import-files-only-new', 'detach', 'uninstall'
    ] },
    selections: planningSelectionsSchema,
    requestId: shortIdSchema
  }, ['inspectionId', 'instanceId', 'operationKind', 'selections']),
  'modpacks:preflight-management': closed({
    serverId: shortIdSchema,
    operationKind: { enum: ['detach', 'uninstall', 'repair', 'rollback-restore-point'] },
    selectionRef: nullableIdSchema,
    requestId: shortIdSchema
  }, ['serverId', 'operationKind']),
  'modpacks:start-operation': closed({ planId: shortIdSchema, planFingerprint: fingerprintSchema, choices: executionChoicesSchema }),
  'modpacks:cancel-job': closed({ jobId: shortIdSchema }),
  'modpacks:get-job': closed({ jobId: shortIdSchema }),
  'modpacks:get-state': closed({ serverId: shortIdSchema }),
  'modpacks:list-history': closed({
    serverId: shortIdSchema,
    cursor: { anyOf: [{ type: 'string', minLength: 1, maxLength: 512 }, { type: 'null' }] },
    limit: { type: 'integer', minimum: 1, maximum: 200 }
  }, ['serverId']),
  'modpacks:list-rollback-options': closed({ serverId: shortIdSchema }),
  'modpacks:list-recovery': emptyRequest,
  'modpacks:recover': closed({ recoveryId: shortIdSchema, actionId: shortIdSchema }),
  'modpacks:list-notifications': closed({
    unreadOnly: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 1000 }
  }, []),
  'modpacks:ack-notification': closed({ notificationId: idSchema }),
  'modpacks:check-updates': closed({ trackingId: nullableIdSchema, force: { type: 'boolean' } }, []),
  'modpacks:update-tracking': trackingRecordSchema,
  'modpacks:verify': closed({ serverId: shortIdSchema }),
  'modpacks:perform-safe-action': closed({ actionId: shortIdSchema, opaqueRef: idSchema }, ['actionId'])
});

const successResultSchema = closed({ ok: { const: true }, value: { $ref: 'minecraft-core-safe-json' } });
const resultSchema = { oneOf: [successResultSchema, publicErrorResultSchema] };
const requestValidators = Object.freeze(Object.fromEntries(MODPACK_INVOKE_CHANNELS.map(channel => [
  channel, ajv.compile(requestSchemas[channel])
])));
const resultValidator = ajv.compile(resultSchema);
const eventValidator = ajv.compile({ $ref: 'minecraft-core-safe-json' });
const inspectionProgressEventValidator = ajv.compile(closed({
  requestId: shortIdSchema,
  phase: { enum: ['resolving', 'downloading', 'verifying', 'materialize', 'list', 'validate', 'classify', 'complete'] },
  transferredBytes: { type: 'integer', minimum: 0, maximum: 16 * 1024 * 1024 * 1024 },
  totalBytes: { type: 'integer', minimum: 0, maximum: 16 * 1024 * 1024 * 1024 },
  percent: { type: 'integer', minimum: 0, maximum: 100 }
}, ['requestId', 'phase']));
const preflightProgressEventValidator = ajv.compile(closed({
  requestId: shortIdSchema,
  phase: { enum: [
    'validating-destination', 'preparing-candidate', 'scanning-server', 'verifying-restore-point', 'calculating-changes',
    'checking-capacity', 'sealing-plan', 'complete'
  ] },
  activity: { enum: [
    'extracting', 'verifying-archive', 'downloading-pack-files', 'assembling-files', 'hashing-candidate-files'
  ] },
  completedItems: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  totalItems: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  processedBytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  totalBytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
}, ['requestId', 'phase']));

function validPreflightProgressMetrics(value) {
  const itemPair = Object.hasOwn(value, 'completedItems') === Object.hasOwn(value, 'totalItems');
  const bytePair = Object.hasOwn(value, 'processedBytes') === Object.hasOwn(value, 'totalBytes');
  if (!itemPair || !bytePair) return false;
  if (Object.hasOwn(value, 'completedItems') && value.completedItems > value.totalItems) return false;
  if (Object.hasOwn(value, 'processedBytes') && value.processedBytes > value.totalBytes) return false;
  const hasCandidateDetail = Object.hasOwn(value, 'activity') || Object.hasOwn(value, 'completedItems') ||
    Object.hasOwn(value, 'processedBytes');
  if (!hasCandidateDetail) return true;
  if (value.phase === 'preparing-candidate') return true;
  return value.phase === 'verifying-restore-point' &&
    (!Object.hasOwn(value, 'activity') || value.activity === 'verifying-archive');
}

const REQUEST_FORBIDDEN_KEY = /(?:path|directory|destination|command|arguments?|executable|token|secret|password|headers?|authorization|cookie|cache|workspace|provider.?internal|artifactSetId|inputDirectoryId|outputDirectoryId|planningSessionId)/i;
const PUBLIC_FORBIDDEN_KEY = /(?:path|url|uri|directory|destination|command|arguments?|executable|token|secret|password|headers?|authorization|cookie|cache|workspace|provider.?internal|artifactSetId|inputDirectoryId|outputDirectoryId|planningSessionId|native.?error|stack|cause|errno|syscall)/i;
const INTERNAL_ID = /^(?:artifact-set|input|output|planning|workspace|cache)-/i;

function assertNoAuthority(value, { channel, output = false, allowRemoteDisplay = false }, field = 'request', depth = 0) {
  if (depth > 16) throw new ModpackError('INVALID_REQUEST', 'Request contains unsupported authority', { details: { field: 'request' } });
  if (typeof value === 'string') {
    const repositoryUrl = !output && channel === 'modpacks:list-github-releases' && field === 'request.repositoryUrl';
    const absoluteLocal = /(?:^|\s)[A-Za-z]:[\\/]/u.test(value) || /(?:^|\s)\\\\/u.test(value) ||
      /^\/(?!\/)/u.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value) || /\bfile:\/\//iu.test(value);
    const remoteUrl = /\bhttps?:\/\//iu.test(value);
    if (absoluteLocal || (!repositoryUrl && ((!output && remoteUrl) || (output && remoteUrl && !allowRemoteDisplay))) || INTERNAL_ID.test(value)) {
      throw new ModpackError('INVALID_REQUEST', 'Request contains unsupported authority', { details: { field: 'request' } });
    }
    if (repositoryUrl && !/^https:\/\/github\.com\//u.test(value)) throw new ModpackError('INVALID_REQUEST', 'Request contains unsupported authority');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAuthority(item, { channel, output, allowRemoteDisplay }, `${field}.${index}`, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const repositoryUrlKey = !output && channel === 'modpacks:list-github-releases' && field === 'request' && key === 'repositoryUrl';
    const validatedConflictPathsKey = !output && channel === 'modpacks:preflight' &&
      field === 'request.selections.conflictChoices' && key === 'paths';
    const validatedConflictPathEntry = !output && channel === 'modpacks:preflight' &&
      field === 'request.selections.conflictChoices.paths';
    const displayUrlKey = output && ['modpacks:search-catalog', 'modpacks:get-project'].includes(channel) &&
      /^(?:iconUrlCandidate|galleryUrlCandidates|urlCandidate|upstreamLinkCandidates)$/u.test(key);
    const outcomeDestinationKey = output && channel === 'modpacks:perform-safe-action' && field === 'result' && key === 'destination';
    const archiveLimitMeasurementKey = output && channel === 'modpacks:inspect' && field === 'result.limitEvidence.totals' &&
      ['directoryCount', 'maximumPathLength'].includes(key);
    if (!repositoryUrlKey && !validatedConflictPathsKey && !validatedConflictPathEntry && !displayUrlKey && !outcomeDestinationKey && !archiveLimitMeasurementKey &&
        (output ? PUBLIC_FORBIDDEN_KEY : REQUEST_FORBIDDEN_KEY).test(key)) {
      throw new ModpackError('INVALID_REQUEST', 'Request contains unsupported authority', { details: { field: 'request' } });
    }
    assertNoAuthority(child, {
      channel,
      output,
      allowRemoteDisplay: allowRemoteDisplay || displayUrlKey
    }, `${field}.${key}`, depth + 1);
  }
}

function cloneJson(value) {
  try {
    return strictJsonClone(value, { maxDepth: 16, maxCollection: 20_000, maxStringBytes: 256 * 1024 });
  } catch {
    throw new ModpackError('INVALID_REQUEST', 'Request must contain JSON data', { details: { field: 'request' } });
  }
}

function validateModpackIpcRequest(channel, value) {
  if (!Object.hasOwn(requestValidators, channel)) throw new ModpackError('INVALID_REQUEST', 'Modpack IPC channel is invalid');
  const candidate = cloneJson(value);
  if (!requestValidators[channel](candidate)) {
    throw new ModpackError('INVALID_REQUEST', 'Modpack IPC request is invalid', { details: { field: 'request' } });
  }
  assertNoAuthority(candidate, { channel, output: false });
  return deepFreeze(candidate);
}

function validateModpackIpcResult(channel, value) {
  if (!MODPACK_INVOKE_CHANNELS.includes(channel)) throw new ModpackError('INVALID_REQUEST', 'Modpack IPC channel is invalid');
  const candidate = cloneJson(value);
  if (!resultValidator(candidate) || (candidate.ok === false && !isValidPublicErrorResult(candidate))) {
    throw new ModpackError('INVALID_REQUEST', 'Modpack IPC result is invalid');
  }
  if (candidate.ok) assertNoAuthority(candidate.value, { channel, output: true }, 'result');
  return deepFreeze(candidate);
}

function validateModpackIpcEvent(channel, value) {
  if (!MODPACK_EVENT_CHANNELS.includes(channel)) throw new ModpackError('INVALID_REQUEST', 'Modpack IPC event channel is invalid');
  const candidate = cloneJson(value);
  const valid = channel === 'modpacks:inspection-progress'
    ? inspectionProgressEventValidator(candidate)
    : channel === 'modpacks:preflight-progress'
      ? preflightProgressEventValidator(candidate)
      : eventValidator(candidate);
  if (!valid || (channel === 'modpacks:preflight-progress' && !validPreflightProgressMetrics(candidate))) {
    throw new ModpackError('INVALID_REQUEST', 'Modpack IPC event is invalid');
  }
  assertNoAuthority(candidate, { channel, output: true }, 'event');
  return deepFreeze(candidate);
}

function validateSchema(schemaName, value) {
  if (!Object.hasOwn(validators, schemaName)) throw new ModpackError('INVALID_REQUEST', 'Request schema is not supported', { details: { field: 'schemaName' } });
  const candidate = cloneJson(value);
  const valid = validators[schemaName](candidate);
  if (!valid || (schemaName === 'PublicModpackErrorResult' && !isValidPublicErrorResult(candidate))) {
    throw new ModpackError('INVALID_REQUEST', 'Request did not match the expected schema', { details: { field: schemaName } });
  }
  const normalized = schemaName === 'RuntimeTuple' ? normalizeRuntimeTuple(candidate) : candidate;
  return deepFreeze(normalized);
}

module.exports = {
  MODPACK_EVENT_CHANNELS,
  MODPACK_INVOKE_CHANNELS,
  validateModpackIpcEvent,
  validateModpackIpcRequest,
  validateModpackIpcResult,
  validateSchema
};
