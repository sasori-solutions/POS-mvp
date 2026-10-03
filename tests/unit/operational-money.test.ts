import { expect, test } from 'vitest'
import { maxOperationalMoneyCents, parseOperationalMoney } from '../../src/lib/operational-money'

test('operational amounts preserve cents beyond the product-price bound and reject malformed or overflowing amounts', () => {
  expect(parseOperationalMoney('1000000.01')).toBe(100_000_001)
  expect(parseOperationalMoney('99999999,99')).toBe(maxOperationalMoneyCents)
  expect(parseOperationalMoney('0.01')).toBe(1)
  expect(parseOperationalMoney('0')).toBe(0)
  for (const value of ['100000000.00', '99999999.999', '-1.00', '1e6', '1 000.00', 'NaN', '']) expect(parseOperationalMoney(value)).toBeNull()
})
