'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHashInput, hexToInt64 } = require('../shared/hash-format');

// A real value from the Stash dev library: hex 88febf45e2572015 is stored
// as int64 -8575206333595836395.
const HEX = '88febf45e2572015';
const INT64 = '-8575206333595836395';

test('accepts hex, 0x-prefixed hex, upper case, and surrounding whitespace', () => {
  assert.equal(parseHashInput(HEX), HEX);
  assert.equal(parseHashInput('0x' + HEX), HEX);
  assert.equal(parseHashInput(HEX.toUpperCase()), HEX);
  assert.equal(parseHashInput(`  ${HEX}\n`), HEX);
});

test('accepts negative and positive int64 decimals (the Stash column value)', () => {
  assert.equal(parseHashInput(INT64), HEX);
  assert.equal(parseHashInput('-6160970836780373462'), 'aa7fd5aa8a2a2a2a');
  assert.equal(parseHashInput('12345'), '0000000000003039');
  assert.equal(parseHashInput('0'), '0000000000000000');
});

test('accepts the unsigned decimal form too', () => {
  assert.equal(parseHashInput(BigInt('0x' + HEX).toString()), HEX);
  assert.equal(parseHashInput('18446744073709551615'), 'ffffffffffffffff');
});

test('pads short hex on the left', () => {
  assert.equal(parseHashInput('ff'), '00000000000000ff');
});

test('rejects garbage, out-of-range decimals, and over-long hex', () => {
  assert.equal(parseHashInput(''), null);
  assert.equal(parseHashInput('not a hash'), null);
  assert.equal(parseHashInput('0x'), null);
  assert.equal(parseHashInput('a'.repeat(17)), null);
  assert.equal(parseHashInput('18446744073709551616'), null);
  assert.equal(parseHashInput('-9223372036854775809'), null);
  assert.equal(parseHashInput(null), null);
});

test('hexToInt64 round-trips with parseHashInput', () => {
  assert.equal(hexToInt64(HEX), INT64);
  assert.equal(parseHashInput(hexToInt64('aa7fd5aa8a2a2a2a')), 'aa7fd5aa8a2a2a2a');
  assert.equal(hexToInt64('7fffffffffffffff'), '9223372036854775807');
  assert.equal(hexToInt64('8000000000000000'), '-9223372036854775808');
});
