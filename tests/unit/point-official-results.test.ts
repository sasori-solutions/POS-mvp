import { describe, expect, it } from 'vitest'
import { MercadoPagoPoint, verifyOrder } from '../../supabase/functions/point/provider'
import type { ExpectedOrder, TokenSet } from '../../supabase/functions/point/provider'
import { randomSecret, TokenVault } from '../../supabase/functions/point/crypto'
import { processPointResult } from '../../supabase/functions/point/service'
import type { Configuration, RpcClient } from '../../supabase/functions/point/service'

// Sanitized shapes observed from the official virtual terminal on 4 Oct 2026.
// No credential, real business, recipient or provider reference is a fixture.
const expected: ExpectedOrder = { amountCents: 500, currency: 'MXN', receiverId: '900001', environment: 'sandbox',
  externalReference: 'fixture-reference', terminalId: 'NEWLAND_N950__SBX0000001' }
const token: TokenSet = { receiverId: expected.receiverId, environment: 'sandbox', source: 'server_test',
  accessToken: 'fixture-test-token', refreshToken: '', expiresAt: '2099-01-01T00:00:00Z', scope: 'read write' }
const scenarios = [
  ['processed', 'accredited', 'processed', 'accredited', 'approved'],
  ['failed', 'failed', 'failed', 'insufficient_amount', 'rejected'],
  ['canceled', 'canceled', 'canceled', 'cancel_by_terminal', 'canceled'],
  ['expired', 'expired', 'expired', 'expired', 'expired'],
  ['action_required', 'check_on_terminal', 'action_required', 'check_on_terminal', 'review'],
] as const
describe('official virtual results', () => {
  it.each(scenarios)('maps %s to the correct definitive result', (status, detail, paymentStatus, paymentDetail, state) => {
    expect(verifyOrder({ id: 'ORDTSTFIXTURE', type: 'point', country_code: 'MEX', currency: 'MXN', user_id: expected.receiverId,
      external_reference: expected.externalReference, status, status_detail: detail, last_updated_date: '2026-10-04T23:56:00Z',
      config: { point: { terminal_id: expected.terminalId } }, transactions: { payments: [{ id: 'PAYFIXTURE', amount: '5.00',
        status: paymentStatus, status_detail: paymentDetail }] } }, expected, token)).toMatchObject({ state, verified: state === 'approved', amountCents: 500 })
  })
})

describe('official sandbox review recovery', () => {
  async function fixture() {
    const vault = new TokenVault({ fixture: randomSecret() }, 'fixture'), calls: string[] = []
    const tokensCiphertext = await vault.seal(token, 'mercadopago:business:sandbox')
    const admin: RpcClient = { rpc(_name, payload) {
      const action = payload.p_action
      return Promise.resolve({ data: action === 'connection_get' ? { tokensCiphertext, tokenVersion: 1, businessId: 'business', receiverId: token.receiverId, environment: 'sandbox' }
        : { backendDirective: { connectionId: 'connection', remoteOrderId: 'ORDTSTFIXTURE' } }, error: null })
    } }
    const adapter = new MercadoPagoPoint({ clientId: 'fixture-app', clientSecret: 'fixture-secret', redirectUri: 'https://example.test/point/callback',
      fetch: (async (input, init) => {
        const path = new URL(String(input)).pathname; calls.push(`${init?.method}:${path}`)
        return Response.json(path === '/users/me' ? { id: token.receiverId, site_id: 'MLM', tags: ['test_user'] }
          : { id: 'ORDTSTFIXTURE', user_id: token.receiverId, status: 'action_required', status_detail: 'check_on_terminal', config: { point: { terminal_id: expected.terminalId } } })
      }) as typeof fetch })
    const config: Configuration = { adapter, vault, clientId: 'fixture-app', redirectUri: 'https://example.test/point/callback', environment: 'sandbox', chargesEnabled: true, testAccessToken: token.accessToken }
    const run = (status: string) => processPointResult(admin, { command: 'simulate', businessId: 'business', checkoutId: 'checkout', status },
      { backendDirective: { kind: 'simulate', businessId: 'business', connectionId: 'connection', remoteOrderId: 'ORDTSTFIXTURE' } },
      { userId: 'owner', authSessionId: 'session' }, config)
    return { calls, run }
  }
  it('accepts the observed approval transition without turning event acceptance into a paid sale', async () => {
    const f = await fixture()
    expect(await f.run('processed')).toEqual({ accepted: true })
    expect(f.calls).toContain('POST:/v1/orders/ORDTSTFIXTURE/events')
  })
  it.each(['failed', 'canceled', 'expired', 'action_required'])('blocks unsupported %s transitions from check_on_terminal', async status => {
    const f = await fixture()
    await expect(f.run(status)).rejects.toThrow('POINT_STATE_INVALID')
    expect(f.calls.some(call => call.startsWith('POST:'))).toBe(false)
  })
})
