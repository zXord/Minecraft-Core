const { ModpackError } = require('../modpacks/errors.cjs');
const { normalizeRuntimeTuple } = require('../modpacks/contracts.cjs');

const EXACT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const ALIAS = /^(?:latest|release|snapshot)$/i;
const incomplete = () => new ModpackError('RUNTIME_INCOMPLETE', 'The exact client runtime is incomplete');

function normalizeRuntimeConstraints(value) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 1) throw incomplete();
    const descriptor = Object.getOwnPropertyDescriptor(value, 'lwjglVersion');
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw incomplete();
    const version = descriptor.value;
    if (version !== null && (typeof version !== 'string' || !EXACT_VERSION.test(version) || ALIAS.test(version))) throw incomplete();
    return Object.freeze({ lwjglVersion: version });
  } catch { throw incomplete(); }
}

function assertRuntimeConstraints(libraries, runtime, value) {
  // Only omission means legacy MRPACK. An explicit null constraint still marks MultiMC Fabric.
  if (value === undefined) return;
  const constraints = normalizeRuntimeConstraints(value);
  let normalized;
  try { normalized = normalizeRuntimeTuple(runtime); } catch { throw incomplete(); }
  if (!Array.isArray(libraries) || libraries.length > 10000) throw incomplete();
  let core = false;
  let intermediary = false;
  for (const library of libraries) {
    const match = typeof library?.name === 'string' && /^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.+-]+)(?::([A-Za-z0-9_.+-]+))?(?:@([A-Za-z0-9]+))?$/.exec(library.name);
    if (!match) throw incomplete();
    const [, group, artifact, version, classifier, extension] = match;
    const ordinaryJar = !classifier && (!extension || extension === 'jar') && library.isNative !== true;
    if (constraints.lwjglVersion !== null && group === 'org.lwjgl' && (artifact === 'lwjgl' || artifact.startsWith('lwjgl-'))) {
      if (version !== constraints.lwjglVersion) throw incomplete();
      if (artifact === 'lwjgl' && ordinaryJar) core = true;
    }
    if (normalized.loaderFamily === 'fabric' && group === 'net.fabricmc' && artifact === 'intermediary') {
      if (version !== normalized.minecraftVersion) throw incomplete();
      if (ordinaryJar) intermediary = true;
    }
  }
  if (constraints.lwjglVersion !== null && !core || normalized.loaderFamily === 'fabric' && !intermediary) throw incomplete();
}

module.exports = { normalizeRuntimeConstraints, assertRuntimeConstraints };
