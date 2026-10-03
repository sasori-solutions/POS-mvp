import { expect, test } from 'vitest'
import { averageTicket, businessDate, changePercent, paymentPercent } from '../../src/lib/reporting'

test('report dates belong to the business calendar, including midnight and daylight saving', () => {
  expect(businessDate('America/Mexico_City', new Date('2026-10-03T04:30:00Z'))).toBe('2026-10-02')
  expect(businessDate('America/Chicago', new Date('2026-03-08T08:30:00Z'))).toBe('2026-03-08')
})

test('average ticket rounds cents exactly and has no invented value without receipts', () => {
  expect(averageTicket(1001, 2)).toBe(501)
  expect(averageTicket(3003, 3)).toBe(1001)
  expect(averageTicket(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER)
  expect(averageTicket(0, 0)).toBeNull()
})

test('comparisons require a positive base and handle negative net sales and large exact differences', () => {
  expect(changePercent(0, 0)).toBeNull()
  expect(changePercent(100, -100)).toBeNull()
  expect(changePercent(12000, 10000)).toBe('+20%')
  expect(changePercent(-5000, 10000)).toBe('-150%')
  expect(changePercent(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe('-200%')
  expect(paymentPercent(333, 1000)).toBe('33.3%')
  expect(paymentPercent(0, 0)).toBe('—')
})
