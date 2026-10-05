import { describe, expect, it } from 'vitest'
import { createPayload, MercadoPagoPoint, verifyOrder } from '../../supabase/functions/point/provider'
import type { ExpectedOrder, TokenSet } from '../../supabase/functions/point/provider'

const expected: ExpectedOrder = { amountCents: 76068, currency: 'MXN', receiverId: '900001', environment: 'live', externalReference: 'synthetic-production-attempt', terminalId: 'NEWLAND_N950__SYNTHETIC' }
const token: TokenSet = { accessToken: 'synthetic-live-only', refreshToken: 'synthetic-refresh-only', receiverId: expected.receiverId, environment: 'live', scope: 'read write offline_access', expiresAt: '2099-01-01T00:00:00Z' }
function order() {
  return { id: 'ORDSYNTHETIC', type: 'point', user_id: expected.receiverId, external_reference: expected.externalReference,
    country_code: 'MEX', currency: 'MXN', live_mode: true, status: 'processed', status_detail: 'processed', last_updated_date: '2026-10-04T20:00:00Z',
    config: { point: { terminal_id: expected.terminalId } }, transactions: { payments: [{ id: 'PAYSYNTHETIC', reference_id: '900002', amount: '760.68', paid_amount: '760.68', tip_amount: '0.00', status: 'processed', status_detail: 'accredited' }] } }
}
function proof() {
  return { id: '900002', collector_id: expected.receiverId, live_mode: true, currency_id: 'MXN', external_reference: expected.externalReference, transaction_amount: 760.68, transaction_amount_refunded: 0, transaction_details: { total_paid_amount: 760.68 }, status: 'approved' }
}

describe('production Point evidence before physical pilot', () => {
  it('sends exact cents and records the authoritative live payment only when all facts match', () => {
    expect(createPayload(expected)).toMatchObject({ transactions: { payments: [{ amount: '760.68' }] }, config: { point: { terminal_id: expected.terminalId } } })
    expect(verifyOrder(order(), expected, token, proof())).toMatchObject({ state: 'approved', amountCents: 76068, verified: true, environment: 'live' })
  })
  it.each(['760.67', '760.69', '761.00'])('rejects Orders paid_amount %s that disagrees with authoritative Payments evidence', paidAmount => {
    const value = order(); value.transactions.payments[0].paid_amount = paidAmount
    expect(() => verifyOrder(value, expected, token, proof())).toThrow('INVALID_RESPONSE')
  })
  it('accepts exact decimal strings returned by Payments without losing a cent', () => {
    expect(verifyOrder(order(), expected, token, { ...proof(), transaction_amount: '760.68', transaction_amount_refunded: '0.00', transaction_details: { total_paid_amount: '760.68' } })).toMatchObject({ state: 'approved', amountCents: 76068, verified: true })
  })
  it.each([NaN, Infinity, null, false, '760.681', '760.680', '7.6068e2', {}])('rejects an invalid Payments money representation: %j', transactionAmount => {
    expect(() => verifyOrder(order(), expected, token, { ...proof(), transaction_amount: transactionAmount })).toThrow('INVALID_RESPONSE')
  })
  it('keeps buyer financing separate from merchandise when both provider resources agree', () => {
    const value = order(); value.transactions.payments[0].paid_amount = '800.00'
    expect(verifyOrder(value, expected, token, { ...proof(), transaction_details: { total_paid_amount: '800.00', net_received_amount: '740.00' } })).toMatchObject({ state: 'approved', amountCents: 76068, verified: true })
  })
  it.each([{ live_mode: false }, { collector_id: '900003' }, { currency_id: 'USD' }, { transaction_amount: 760.69 }, { external_reference: 'another-attempt' }])('rejects mismatched live monetary evidence: %j', changes => {
    expect(() => verifyOrder(order(), expected, token, { ...proof(), ...changes })).toThrow('INVALID_RESPONSE')
  })
  it('does not turn a virtual test approval into a real payment', () => {
    const value = order(); value.live_mode = false; value.config.point.terminal_id = 'NEWLAND_N950__SBX0000001'; value.id = 'ORDTSTSYNTHETIC'
    expect(() => verifyOrder(value, expected, token, proof())).toThrow('INVALID_RESPONSE')
  })
  it('requires the production OAuth account and preserves PKCE and redirect during token exchange', async () => {
    const calls: { path: string; body: unknown }[] = []
    const provider = new MercadoPagoPoint({ clientId: 'synthetic-app', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/point/callback', fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (path === '/oauth/token') return Response.json({ access_token: token.accessToken, refresh_token: token.refreshToken, expires_in: 3600, user_id: token.receiverId, live_mode: true, scope: token.scope })
      if (path === '/users/me') return Response.json({ id: token.receiverId, site_id: 'MLM', tags: [] })
      throw new Error('Unexpected request')
    } })
    expect(await provider.exchange('synthetic-code', 'synthetic-verifier', 'live')).toMatchObject({ receiverId: expected.receiverId, environment: 'live' })
    expect(calls).toEqual([{ path: '/oauth/token', body: { client_id: 'synthetic-app', client_secret: 'synthetic-secret', grant_type: 'authorization_code', code: 'synthetic-code', code_verifier: 'synthetic-verifier', redirect_uri: 'https://example.test/point/callback', test_token: false } }, { path: '/users/me', body: undefined }])
  })
  it('cannot use a test account after requesting production OAuth', async () => {
    const provider = new MercadoPagoPoint({ clientId: 'synthetic-app', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/point/callback', fetch: async input => new URL(String(input)).pathname === '/oauth/token'
      ? Response.json({ access_token: token.accessToken, refresh_token: token.refreshToken, expires_in: 3600, user_id: token.receiverId, live_mode: true, scope: token.scope })
      : Response.json({ id: token.receiverId, site_id: 'MLM', tags: ['test_user'] }) })
    await expect(provider.exchange('synthetic-code', 'synthetic-verifier', 'live')).rejects.toThrow('INVALID_RESPONSE')
  })
})
