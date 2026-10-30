// Renderer copy of electron/utils/app-version.cjs: strict MAJOR.MINOR.PATCH with
// an optional -prerelease, compared numerically (as strings, '26.11.1' <
// '26.6.1'). tests/app-version.test.cjs runs one vector table through both, so
// change them together. Kept free of imports so any renderer code can use it.
const MAX_APP_VERSION_LENGTH = 256;
const APP_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?$/u;
const NUMERIC_IDENTIFIER = /^\d+$/u;

function parseAppVersion(value) {
  if (typeof value !== 'string' || value.length > MAX_APP_VERSION_LENGTH) return null;
  const match = APP_VERSION_PATTERN.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return { parts, prerelease: match[4] === undefined ? [] : match[4].split('.') };
}

function compareOrdered(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareIdentifiers(left, right) {
  const leftNumeric = NUMERIC_IDENTIFIER.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER.test(right);
  // Numeric identifiers have no leading zeros, so length then digits is numeric order.
  if (leftNumeric && rightNumeric) return compareOrdered(left.length, right.length) || compareOrdered(left, right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return compareOrdered(left, right);
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) return compareOrdered(right.length, left.length);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const order = compareIdentifiers(left[index], right[index]);
    if (order !== 0) return order;
  }
  return compareOrdered(left.length, right.length);
}

function compareAppVersions(left, right) {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  if (!a || !b) return null;
  return compareOrdered(a.parts[0], b.parts[0]) || compareOrdered(a.parts[1], b.parts[1]) ||
    compareOrdered(a.parts[2], b.parts[2]) || comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * How this client's Minecraft Core version relates to the host's.
 * @param {unknown} clientVersion
 * @param {unknown} hostVersion
 * @returns {'equal'|'client-older'|'client-newer'|'unknown'} 'unknown' when either version cannot be parsed.
 */
export function relateAppVersions(clientVersion, hostVersion) {
  const order = compareAppVersions(clientVersion, hostVersion);
  if (order === null) return 'unknown';
  if (order === 0) return 'equal';
  return order < 0 ? 'client-older' : 'client-newer';
}
