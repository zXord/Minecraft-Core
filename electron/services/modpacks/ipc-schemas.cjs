const Ajv = require('ajv');
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

function cloneJson(value) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
    return JSON.parse(serialized);
  } catch {
    throw new ModpackError('INVALID_REQUEST', 'Request must contain JSON data', { details: { field: 'request' } });
  }
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

module.exports = { validateSchema };
