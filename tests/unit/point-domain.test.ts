import { describe, expect, it } from 'vitest'
import { csvCell, exactCents, mapPointState, monthlyCommission, parseProviderAmount, providerAmount, roundNumerator } from '../../src/lib/point-domain'

describe('Point exact money, monthly fee and conservative states', () => {
  it('serializes exact decimal strings and rejects fractions, malformed and unsafe money', () => {
    expect(providerAmount(1)).toBe('0.01'); expect(providerAmount(9_999_999_999)).toBe('99999999.99')
    expect(parseProviderAmount('100000.00')).toBe(10_000_000)
    for (const value of [NaN, 0.1, -1, Number.MAX_SAFE_INTEGER]) expect(() => exactCents(value)).toThrow()
    for (const value of ['1e3', '1.001', '-1', '1,000', 1]) expect(() => parseProviderAmount(value)).toThrow()
  })
  it('rounds once monthly for a thousand tiny tickets and configured IVA stays separate', () => {
    expect(monthlyCommission(Array.from({ length: 1000 }, () => ({ baseCents: 100, rateBps: 30, direction: 1 as const })), 1600)).toEqual({ exactNumerator: '3000000', netCents: 300, vatCents: 48, totalCents: 348 })
    expect(monthlyCommission([{ baseCents: 10_000_000, rateBps: 30, direction: 1 }], 1600)).toMatchObject({ netCents: 30000, vatCents: 4800, totalCents: 34800 })
    expect(roundNumerator(-5000n)).toBe(-1n)
    expect(monthlyCommission([{ baseCents: 167, rateBps: 30, direction: 1 }, { baseCents: 167, rateBps: 30, direction: -1 }], 1600).netCents).toBe(0)
  })
  it('requires processed transaction facts and preserves unknown states for review', () => {
    expect(mapPointState('created', 'created', 'created', 'created')).toBe('pending')
    expect(mapPointState('processing', 'action_required', 'processing', 'action_required')).toBe('unknown_review')
    expect(mapPointState('processed', 'processed', 'processed', 'accredited')).toBe('approved_verified')
    expect(mapPointState('new-state', 'unknown', 'new-state', 'unknown')).toBe('unknown_review')
    expect(mapPointState('failed', 'failed', 'failed', 'in_review')).toBe('unknown_review')
    expect(mapPointState('failed', 'failed', 'failed', 'rejected_by_issuer')).toBe('rejected')
    expect(mapPointState('canceled', 'canceled', 'canceled', 'cancel_by_terminal')).toBe('cancelled')
    expect(mapPointState('created', 'unknown', 'created', 'created')).toBe('unknown_review')
    expect(mapPointState('created', 'refunded', 'created', 'created')).toBe('unknown_review')
  })
  it('escapes CSV text and blocks spreadsheet formulas, including whitespace', () => {
    expect(csvCell(' =SUM(A1)')).toBe('"\' =SUM(A1)"')
    expect(csvCell('a"b')).toBe('"a""b"')
  })
})
