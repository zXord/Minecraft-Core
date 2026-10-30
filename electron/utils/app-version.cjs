// Strict MAJOR.MINOR.PATCH with an optional -prerelease (Semantic Versioning
// 2.0.0 precedence, no build metadata, no leading zeros, no 'v' prefix).
// Versions must be compared numerically: as strings, '26.11.1' < '26.6.1'.
// src/utils/version/appVersionRelation.js mirrors this for the renderer, and
// tests/app-version.test.cjs runs one vector table through both.
const MAX_APP_VERSION_LENGTH = 256;
const APP_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?$/u;
const NUMERIC_IDENTIFIER = /^\d+$/u;

/**
 * @param {unknown} value
 * @returns {{version: string, major: number, minor: number, patch: number, prerelease: string[]}|null}
 */
function parseAppVersion(value) {
  if (typeof value !== 'string' || value.length > MAX_APP_VERSION_LENGTH) return null;
  const match = APP_VERSION_PATTERN.exec(value);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return Object.freeze({
    version: value,
    major,
    minor,
    patch,
    prerelease: Object.freeze(match[4] === undefined ? [] : match[4].split('.'))
  });
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

/**
 * @returns {-1|0|1|null} the order of left relative to right, or null when
 *   either version cannot be parsed.
 */
function compareAppVersions(left, right) {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  if (!a || !b) return null;
  return compareOrdered(a.major, b.major) || compareOrdered(a.minor, b.minor) ||
    compareOrdered(a.patch, b.patch) || comparePrerelease(a.prerelease, b.prerelease);
}

module.exports = { compareAppVersions, parseAppVersion };
