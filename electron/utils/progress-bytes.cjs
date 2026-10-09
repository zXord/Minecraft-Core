const UINT64_MAX = 18446744073709551615n;
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

function byteInteger(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === 'bigint') {
    return value >= 0n && value.toString().length <= 128 ? value : null;
  }
  if (typeof value === 'string' && value.length <= 128 && /^(?:0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
}

// Presentation only: at most 128 decimal digits, binary formatting through uint64.
function formatProgressBytes(processed, total) {
  const numerator = byteInteger(processed);
  const denominator = byteInteger(total);
  if (numerator === null || denominator === null || numerator > denominator) return null;
  if (denominator > UINT64_MAX) return `${numerator} of ${denominator} bytes`;
  let unit = 0;
  let scale = 1n;
  while (unit < UNITS.length - 1 && denominator >= scale * 1024n) { scale *= 1024n; unit++; }
  if (unit === 0) return `${numerator} of ${denominator} B`;
  const rounded = value => (value * 100n + scale / 2n) / scale;
  const decimal = value => {
    const fraction = (value % 100n).toString().padStart(2, '0').replace(/0+$/, '');
    return `${value / 100n}${fraction ? `.${fraction}` : ''}`;
  };
  const done = rounded(numerator);
  const size = rounded(denominator);
  if (numerator < denominator && done === size) {
    return `${decimal(size)} ${UNITS[unit]} total; less than 0.01 ${UNITS[unit]} remaining (approx. total)`;
  }
  return `${decimal(done)} of ${decimal(size)} ${UNITS[unit]} (approx.)`;
}

module.exports = { formatProgressBytes };
