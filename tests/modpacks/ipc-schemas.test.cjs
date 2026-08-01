const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSchema } = require('../../electron/services/modpacks/ipc-schemas.cjs');

test('schema validation clones and freezes a valid runtime tuple', () => {
  const input = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64'
  };

  const result = validateSchema('RuntimeTuple', input);
  input.loaderVersion = 'mutated';

  assert.equal(result.loaderVersion, '0.16.14');
  assert.equal(Object.isFrozen(result), true);
});

test('schema validation rejects unknown fields and never accepts renderer path fields', () => {
  assert.throws(
    () => validateSchema('RuntimeTuple', {
      minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64', serverPath: 'C:\\server'
    }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('public modpack error results accept only code-specific declared details', () => {
  const result = validateSchema('PublicModpackErrorResult', {
    ok: false,
    error: {
      code: 'HASH_MISMATCH',
      message: 'Integrity check failed',
      details: { algorithm: 'sha512' },
      retryable: false
    }
  });

  assert.deepEqual(result.error.details, { algorithm: 'sha512' });
  assert.throws(
    () => validateSchema('PublicModpackErrorResult', {
      ok: false,
      error: { code: 'HASH_MISMATCH', message: 'Integrity check failed', details: { url: 'https://x/?token=y' }, retryable: false }
    }),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('schema validation converts cyclic and BigInt serialization failures into INVALID_REQUEST', () => {
  const cyclic = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  cyclic.self = cyclic;
  const bigint = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21n, os: 'win32', architecture: 'x64'
  };

  assert.throws(() => validateSchema('RuntimeTuple', cyclic), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => validateSchema('RuntimeTuple', bigint), error => error.code === 'INVALID_REQUEST');
});
