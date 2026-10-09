const assert = require('node:assert/strict');
const test = require('node:test');
const { formatProgressBytes } = require('../../electron/utils/progress-bytes.cjs');

test('progress byte detail uses exact integer rounding and truthful incomplete tails', () => {
  for (const [processed, total, want] of [
    [4474778661, 4491226001, '4.17 of 4.18 GiB (approx.)'],
    [0, 0, '0 of 0 B'], [1023, 1023, '1023 of 1023 B'],
    [1023, 1024, '1 KiB total; less than 0.01 KiB remaining (approx. total)'],
    [1, 1024, '0 of 1 KiB (approx.)'], [1024, 1024, '1 of 1 KiB (approx.)'],
    [9007199254740991, 9007199254740991, '8 of 8 PiB (approx.)'],
    [0n, 18446744073709551615n, '0 of 16 EiB (approx.)'],
    ['18446744073709551616', '18446744073709551616', '18446744073709551616 of 18446744073709551616 bytes'],
    ['9'.repeat(128), '9'.repeat(128), `${'9'.repeat(128)} of ${'9'.repeat(128)} bytes`]
  ]) assert.equal(formatProgressBytes(processed, total), want);
});

test('progress byte detail rejects invalid and oversized representations without coercion', () => {
  let getterCalls = 0;
  const boxed = { get valueOf() { getterCalls++; throw new Error('must not coerce'); } };
  for (const value of [null, undefined, -1, 1.5, Infinity, NaN, 9007199254740992, -1n,
    '', '00', '01', '+1', '-1', ' 1', '1 ', '1.0', '1e3', '9'.repeat(129), new Number(1), boxed]) {
    assert.equal(formatProgressBytes(value, 10), null);
    assert.equal(formatProgressBytes(0, value), null);
  }
  assert.equal(formatProgressBytes(11, 10), null);
  assert.equal(getterCalls, 0);
});
