import { describe, expect, it } from 'vitest'
import { createPayload, validateCreatePayload } from '../../supabase/functions/point/provider'
import type { ExpectedOrder, TokenSet } from '../../supabase/functions/point/provider'

const expected: ExpectedOrder = { amountCents: 76068, currency: 'MXN', receiverId: '900001', environment: 'sandbox', externalReference: 'synthetic-attempt', terminalId: 'NEWLAND_N950__SBX0000001' }
const token: TokenSet = { accessToken: 'synthetic-only', refreshToken: '', receiverId: expected.receiverId, environment: 'sandbox', scope: '', expiresAt: '2099-01-01T00:00:00Z' }

describe('immutable outgoing Point payload', () => {
  it('accepts the saved payload without changing its contents or identity', () => {
    const payload = createPayload(expected)
    expect(validateCreatePayload(payload, expected, token)).toBe(payload)
  })
  it('accepts JSON object keys in any order', () => {
    const payload = createPayload(expected)
    expect(validateCreatePayload(Object.fromEntries(Object.entries(payload).reverse()), expected, token)).toEqual(payload)
  })
  it.each([
    { transactions: { payments: [{ amount: '760.69' }] } },
    { transactions: { payments: [{ amount: 760.68 }] } },
    { transactions: { payments: [{ amount: '760.68' }, { amount: '1.00' }] } },
    { external_reference: 'another-attempt' },
    { config: { point: { terminal_id: 'another-terminal', print_on_terminal: 'no_ticket' } } },
    { config: { point: { terminal_id: expected.terminalId, print_on_terminal: 'seller_ticket', installments: 3 } } },
    { expiration_time: 'PT30M' }, { type: 'qr' }, { total_amount: '760.68' },
  ])('rejects payload drift before any provider mutation: %j', change => {
    expect(() => validateCreatePayload({ ...createPayload(expected), ...change }, expected, token)).toThrow('INVALID_RESPONSE')
  })
  it.each([{ receiverId: '900002' }, { environment: 'live' as const }])('rejects another account or environment: %j', change => {
    expect(() => validateCreatePayload(createPayload(expected), expected, { ...token, ...change })).toThrow('INVALID_RESPONSE')
  })
})
