import { describe, expect, it } from 'vitest'
import { assertFinancialResponse, assertFinancialShift } from '../../src/lib/financial-response'
import type { CashShift, ShiftPaymentSummary } from '../../src/lib/operations-contracts'
import { integerCurrency } from '../../src/lib/integer-currency'

const id = '00000000-0000-4000-8000-000000000001'
function summary(): ShiftPaymentSummary {
  return { collectedCents: 30_000_000_003, refundedCents: 303, netCents: 29_999_999_700, pointRefundsNotAttributed: true,
    payments: [
      { paymentMethod: 'cash', collectedCents: 30_000_000_003, refundedCents: 101, netCents: 29_999_999_902 },
      { paymentMethod: 'card_external', collectedCents: 0, refundedCents: 202, netCents: -202 },
      { paymentMethod: 'card_integrated', collectedCents: 0, refundedCents: 0, netCents: 0 },
      { paymentMethod: 'transfer', collectedCents: 0, refundedCents: 0, netCents: 0 },
    ] }
}
function shift(paymentSummary: ShiftPaymentSummary | undefined = summary()): CashShift {
  return { id, revision: 1, status: 'open', openedAt: '2026-10-06T12:00:00Z', closedAt: null, openedBy: 'Persona sintética', closedBy: null,
    openingCents: 100, countedCents: null, expectedCents: null, differenceCents: null, movements: [], ...(paymentSummary ? { paymentSummary } : {}) }
}

describe('cash-shift payment summary response boundary', () => {
  it('renders the final cent exactly for large positive, negative and sub-peso amounts', () => {
    expect(integerCurrency(Number.MAX_SAFE_INTEGER)).toBe('$90,071,992,547,409.91')
    expect(integerCurrency(-Number.MAX_SAFE_INTEGER)).toBe('-$90,071,992,547,409.91')
    expect(integerCurrency(0)).toBe('$0.00')
    expect(integerCurrency(1)).toBe('$0.01')
    expect(integerCurrency(-1)).toBe('-$0.01')
    expect(() => integerCurrency(Number.MAX_SAFE_INTEGER + 1)).toThrow('Importe inválido')
  })
  it('accepts exact aggregates larger than an order and negative refund-only method balances without rewriting data', () => {
    const value = shift(), copy = structuredClone(value)
    assertFinancialShift(value)
    assertFinancialResponse({ command: 'operations' }, { shift: value, orders: [], attempts: [] })
    assertFinancialResponse({ command: 'shifts' }, { shifts: [value, { ...value, status: 'closed' }] })
    assertFinancialResponse({ command: 'open_shift', operationId: id, openingCents: 100 }, value)
    expect(value).toEqual(copy)
  })

  it('preserves original accepted shift responses without the additive field', () => {
    const { paymentSummary: _unused, ...legacy } = shift()
    assertFinancialShift(legacy)
    assertFinancialResponse({ command: 'close_shift', operationId: id, shiftId: id, expectedRevision: 1, countedCents: 100 }, { ...legacy, status: 'closed' })
    assertFinancialResponse({ command: 'shifts' }, { shifts: [legacy] })
  })

  it('rejects unsafe, duplicated, incomplete or inconsistent totals and summaries exposed during blind count', () => {
    const invalid: CashShift[] = [
      { ...shift(), status: 'closing' },
      shift({ ...summary(), pointRefundsNotAttributed: false } as unknown as ShiftPaymentSummary),
      shift({ ...summary(), collectedCents: summary().collectedCents + 1 }),
      shift({ ...summary(), refundedCents: -1 }),
      shift({ ...summary(), netCents: summary().netCents + 1 }),
      shift({ ...summary(), collectedCents: Number.MAX_SAFE_INTEGER + 1 }),
      shift({ ...summary(), payments: summary().payments.slice(0, 3) }),
      shift({ ...summary(), payments: summary().payments.map(row => ({ ...row, paymentMethod: 'cash' })) }),
      shift({ ...summary(), payments: summary().payments.map(row => ({ ...row, netCents: row.netCents + 1 })) }),
      shift({ ...summary(), payments: summary().payments.map(row => ({ ...row, collectedCents: 1.01 })) }),
    ]
    for (const value of invalid) {
      expect(() => assertFinancialResponse({ command: 'operations' }, { shift: value, orders: [], attempts: [] })).toThrow('Conservamos la solicitud')
      expect(() => assertFinancialResponse({ command: 'shifts' }, { shifts: [value] })).toThrow('Conservamos la solicitud')
    }
    expect(() => assertFinancialResponse({ command: 'close_shift', operationId: id, shiftId: '00000000-0000-4000-8000-000000000002', expectedRevision: 1, countedCents: 100 }, { ...shift(), status: 'closed' })).toThrow('Conservamos la solicitud')
  })
})
