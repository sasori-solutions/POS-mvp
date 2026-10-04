import { expect, test } from 'vitest'
import { discountInputValue, discountReason, orderDiscountPreview, parseOrderDiscount } from '../../src/features/operations/order-discount-model'

test('percentage preview matches SQL half-up rounding in integer cents', () => {
  expect(orderDiscountPreview(101, 'percent', 5_000)).toEqual({ discountCents: 51, totalCents: 50 })
  expect(orderDiscountPreview(1, 'percent', 5_000)).toEqual({ discountCents: 1, totalCents: 0 })
  expect(orderDiscountPreview(19_500, 'percent', 1_000)).toEqual({ discountCents: 1_950, totalCents: 17_550 })
  expect(orderDiscountPreview(9_999_999_999, 'percent', 9_999)).toEqual({ discountCents: 9_998_999_999, totalCents: 1_000_000 })
})

test('fixed preview replaces the whole-account discount without discounting the net again', () => {
  expect(orderDiscountPreview(19_500, 'fixed', 5_000)).toEqual({ discountCents: 5_000, totalCents: 14_500 })
  expect(orderDiscountPreview(19_500, 'fixed', 19_500)).toEqual({ discountCents: 19_500, totalCents: 0 })
  expect(orderDiscountPreview(19_500, 'percent', 10_000)).toEqual({ discountCents: 19_500, totalCents: 0 })
})

test('the editor matches server limits and decimal precision', () => {
  expect(parseOrderDiscount('percent', '100.00', 19_500)).toBe(10_000)
  expect(parseOrderDiscount('percent', '15.', 19_500)).toBe(1_500)
  expect(parseOrderDiscount('percent', '.5', 19_500)).toBe(50)
  expect(parseOrderDiscount('percent', '100.01', 19_500)).toBeNull()
  expect(parseOrderDiscount('fixed', '195,00', 19_500)).toBe(19_500)
  expect(parseOrderDiscount('fixed', '195.01', 19_500)).toBeNull()
  expect(parseOrderDiscount('fixed', '195.001', 19_500)).toBeNull()
  expect(parseOrderDiscount('fixed', '', 19_500)).toBeNull()
  expect(orderDiscountPreview(19_500, 'fixed', -1)).toBeNull()
  expect(orderDiscountPreview(19_500, 'percent', 10_001)).toBeNull()
  expect(orderDiscountPreview(19_500, 'fixed', 19_501)).toBeNull()
  expect(orderDiscountPreview(9_999_999_999 + 1, 'percent', 1_000)).toBeNull()
  expect(orderDiscountPreview(195.5, 'percent', 1_000)).toBeNull()
})

test('stored discount values round trip without floating point formatting', () => {
  expect(discountInputValue(9_999_999_999)).toBe('99999999.99')
  expect(discountInputValue(1_525)).toBe('15.25')
  expect(discountInputValue(1)).toBe('0.01')
})

test('reasons are required and match server text normalization', () => {
  expect(discountReason('  Cortesía   del día  ')).toBe('Cortesía del día')
  expect(discountReason('  ')).toBeNull()
  expect(discountReason('a'.repeat(201))).toBeNull()
  expect(discountReason('Motivo\nno válido')).toBeNull()
})
