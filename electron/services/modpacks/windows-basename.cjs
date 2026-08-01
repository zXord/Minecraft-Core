const RESERVED_DEVICE_STEMS = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', 'CONIN$', 'CONOUT$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

const SUPERSCRIPT_DIGITS = Object.freeze({ '¹': '1', '²': '2', '³': '3' });

function basenamePolicy(value, { maxLength = 255 } = {}) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value !== value.trim() ||
    value === '.' || value === '..' || /[<>:"/\\|?*]/.test(value) || /[. ]$/.test(value) ||
    [...value].some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })) return null;

  const normalized = value.normalize('NFC');
  const rawStem = normalized.split('.', 1)[0].replace(/[ .]+$/g, '').toLocaleUpperCase('en-US');
  const deviceStem = [...rawStem].map(character => SUPERSCRIPT_DIGITS[character] ?? character).join('');
  if (RESERVED_DEVICE_STEMS.has(deviceStem)) return null;
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

module.exports = { isSafeWindowsBasename, windowsBasenameCollisionKey };
