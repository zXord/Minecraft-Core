const RESERVED_DEVICE_STEMS = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', 'CONIN$', 'CONOUT$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

const SUPERSCRIPT_DIGITS = Object.freeze({ '¹': '1', '²': '2', '³': '3' });

function normalizedDeviceStem(value) {
  const rawStem = value.split('.', 1)[0].replace(/[ .]+$/g, '').toLocaleUpperCase('en-US');
  return [...rawStem].map(character => SUPERSCRIPT_DIGITS[character] ?? character).join('');
}

function hasInvalidBasenameCharacter(value, { allowWildcard = false } = {}) {
  const invalidCharacters = allowWildcard ? /[<>:"/\\|?]/ : /[<>:"/\\|?*]/;
  return invalidCharacters.test(value) || [...value].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function basenamePolicy(value, { maxLength = 255 } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value !== value.trim() ||
    value === '.' || value === '..' || hasInvalidBasenameCharacter(value) || /[. ]$/.test(value)) return null;

  const normalized = value.normalize('NFC');
  if (RESERVED_DEVICE_STEMS.has(normalizedDeviceStem(normalized))) return null;
  return Object.freeze({
    normalized,
    collisionKey: normalized.toLocaleLowerCase('en-US')
  });
}

function basenamePatternPolicy(value, { maxLength = 255 } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value !== value.trim() ||
    value === '.' || value === '..' || hasInvalidBasenameCharacter(value, { allowWildcard: true }) || /[. ]$/.test(value)) return null;
  const stars = value.split('*').length - 1;
  if (stars > 1) return null;
  if (stars === 0) return basenamePolicy(value, { maxLength });

  const normalized = value.normalize('NFC');
  const starIndex = normalized.indexOf('*');
  const prefix = normalized.slice(0, starIndex);
  const dotIndex = prefix.indexOf('.');
  if (dotIndex >= 0) {
    if (RESERVED_DEVICE_STEMS.has(normalizedDeviceStem(prefix))) return null;
  } else {
    const devicePrefix = [...prefix.toLocaleUpperCase('en-US')]
      .map(character => SUPERSCRIPT_DIGITS[character] ?? character).join('');
    if ([...RESERVED_DEVICE_STEMS].some(stem => stem.startsWith(devicePrefix))) return null;
  }
  return Object.freeze({
    normalized,
    collisionKey: normalized.toLocaleLowerCase('en-US')
  });
}

function isSafeWindowsBasename(value, options) {
  return basenamePolicy(value, options) !== null;
}

function windowsBasenameCollisionKey(value, options) {
  return basenamePolicy(value, options)?.collisionKey ?? null;
}

function isSafeWindowsBasenamePattern(value, options) {
  return basenamePatternPolicy(value, options) !== null;
}

module.exports = { isSafeWindowsBasename, isSafeWindowsBasenamePattern, windowsBasenameCollisionKey };
