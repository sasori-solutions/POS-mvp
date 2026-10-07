import { expect, test } from 'vitest';
import { amountKey, parseAmountCents } from '../../src/lib/importe';

test.each([['0.01', 1], ['.10', 10], ['1.1', 110], ['10,25', 1025], ['760.68', 76068], ['999999.99', 99999999], ['12.', 1200]])('parses %s as exact integer cents', (input, cents) => {
  expect(parseAmountCents(input)).toBe(cents);
});
test.each(['', '0', '0.00', '-1', '1.001', '1000000', '1e2', '2+3', 'NaN'])('rejects zero, invalid or out of range amount %s', input => {
  expect(parseAmountCents(input)).toBeNull();
});
test('the keypad preserves decimal precision and supports clear/backspace/zero', () => {
  expect(amountKey('', '.')).toBe('0.');
  expect(amountKey('0', '5')).toBe('5');
  expect(amountKey('12.34', '5')).toBe('12.34');
  expect(amountKey('12.34', '.')).toBe('12.34');
  expect(amountKey('999999', '9')).toBe('999999');
  expect(amountKey('0.01', 'backspace')).toBe('0.0');
  expect(amountKey('12.34', 'clear')).toBe('');
});
