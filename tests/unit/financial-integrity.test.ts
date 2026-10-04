import { describe, expect, it } from 'vitest'
import { checkoutTotals } from '../../src/lib/checkout-selection'
import { includedTax } from '../../src/lib/product-details'
import { orderDiscountPreview } from '../../src/features/operations/order-discount-model'
import type { OperationalOrder, OrderLine } from '../../src/lib/operations-contracts'

function line(overrides: Partial<OrderLine> = {}): OrderLine {
  return { lineId: 'line-a', productId: 'product-a', version: 1, name: 'Producto', kitchenName: 'Producto', category: '', selectionLabel: '', note: '',
    quantity: 3, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 101, grossCents: 303, discountCents: 101, totalCents: 202,
    taxCents: 28, taxBps: 1600, taxTreatment: 'vat_16', ...overrides }
}
function order(items: OrderLine[]): OperationalOrder {
  const grossCents = items.reduce((sum, item) => sum + item.grossCents, 0)
  const discountCents = items.reduce((sum, item) => sum + item.discountCents, 0)
  const totalCents = items.reduce((sum, item) => sum + item.totalCents, 0)
  return { id: 'order-a', revision: 1, name: 'Cuenta', tableId: null, status: 'open', phase: 'checkout', frozen: false,
    createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z', operatorName: 'Operador', items, discount: null,
    grossCents, discountCents, totalCents, taxCents: items.reduce((sum, item) => sum + item.taxCents, 0), paidCents: 0,
    waivedCents: 0, cancelledCents: 0, balanceCents: totalCents }
}

describe('checkout allocation financial integrity', () => {
  it('rejects duplicate selections before the same units can be counted twice', () => {
    const account = order([line()])
    expect(() => checkoutTotals(account, [{ lineId: 'line-a', quantity: 2 }, { lineId: 'line-a', quantity: 2 }])).toThrow()
  })

  it.each([
    { quantity: 0, grossCents: 0, discountCents: 0, totalCents: 0, taxCents: 0 },
    { paidQuantity: -1 },
    { unitPriceCents: -1, grossCents: -3, discountCents: 0, totalCents: -3, taxCents: 0 },
    { grossCents: 304 },
    { discountCents: 304, totalCents: -1, taxCents: 0 },
    { totalCents: 203 },
    { taxCents: 203 },
    { unitPriceCents: 100_000_000, grossCents: 300_000_000, totalCents: 299_999_899 },
    { grossCents: Number.MAX_SAFE_INTEGER + 1 },
    { taxCents: Number.NaN },
    { paidQuantity: 1.5 },
    { unitPriceCents: Number.POSITIVE_INFINITY },
  ])('refuses an invalid monetary snapshot instead of displaying a plausible amount: %j', change => {
    const account = order([line(change)])
    expect(() => checkoutTotals(account, [{ lineId: 'line-a', quantity: 0 }])).toThrow()
  })

  it('rejects ambiguous line identities and snapshots even when nothing is selected', () => {
    expect(() => checkoutTotals(order([line(), line()]), [])).toThrow()
    expect(() => checkoutTotals(order([line({ lineId: '' })]), [])).toThrow()
    expect(() => checkoutTotals(order([line({ totalCents: 203 })]), [])).toThrow()
  })

  it('rejects more than 40 lines and an order beyond the total money bound', () => {
    const small = (lineId: string) => line({ lineId, quantity: 1, unitPriceCents: 1, grossCents: 1, discountCents: 0, totalCents: 1, taxCents: 0 })
    const forty = Array.from({ length: 40 }, (_, index) => small(String(index)))
    expect(checkoutTotals(order(forty), forty.map(item => ({ lineId: item.lineId, quantity: 1 }))).totalCents).toBe(40)
    expect(() => checkoutTotals(order([...forty, small('extra')]), [])).toThrow()
    expect(() => checkoutTotals(order(forty), [...forty.map(item => ({ lineId: item.lineId, quantity: 1 })), { lineId: 'extra', quantity: 0 }])).toThrow()
    const large = line({ quantity: 61, unitPriceCents: 99_999_999, grossCents: 6_099_999_939, discountCents: 0, totalCents: 6_099_999_939, taxCents: 0 })
    expect(() => checkoutTotals(order([large, { ...large, lineId: 'line-b' }]), [])).toThrow()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -1, 1.5, 4])('rejects invalid selected quantity %s', quantity => {
    expect(() => checkoutTotals(order([line()]), [{ lineId: 'line-a', quantity }])).toThrow()
  })

  it('conserves every discount and tax cent for every single-unit split', () => {
    for (const quantity of [1, 2, 3, 7, 17, 999]) {
      for (const unitPriceCents of [0, 1, 3, 101, 99_999]) {
        const grossCents = quantity * unitPriceCents
        for (const discountCents of [...new Set([0, 1, Math.floor(grossCents / 3), grossCents])].filter(value => value <= grossCents)) {
          const totalCents = grossCents - discountCents
          const taxCents = includedTax(totalCents, 1600)
          const item = line({ quantity, unitPriceCents, grossCents, discountCents, totalCents, taxCents })
          let collected = 0, allocatedDiscount = 0, allocatedTax = 0
          for (let paidQuantity = 0; paidQuantity < quantity; paidQuantity++) {
            const slice = checkoutTotals(order([{ ...item, paidQuantity }]), [{ lineId: item.lineId, quantity: 1 }])
            expect(slice.totalCents).toBeGreaterThanOrEqual(0)
            expect(slice.taxCents).toBeGreaterThanOrEqual(0)
            expect(slice.taxCents).toBeLessThanOrEqual(slice.totalCents)
            collected += slice.totalCents
            allocatedDiscount += slice.discountCents
            allocatedTax += slice.taxCents
          }
          expect({ collected, allocatedDiscount, allocatedTax }).toEqual({ collected: totalCents, allocatedDiscount: discountCents, allocatedTax: taxCents })
        }
      }
    }
  })

  it('matches exact half-up percentage rounding across half-cent boundaries', () => {
    for (const grossCents of [0, 1, 3, 99, 101, 9_999_999_999]) {
      for (const basisPoints of [0, 1, 3333, 5000, 9999, 10000]) {
        const expected = (BigInt(grossCents) * BigInt(basisPoints) + 5000n) / 10000n
        expect(orderDiscountPreview(grossCents, 'percent', basisPoints)).toEqual({ discountCents: Number(expected), totalCents: grossCents - Number(expected) })
      }
    }
  })
})
