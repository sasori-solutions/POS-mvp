import { describe, expect, it, vi } from 'vitest'
import { MercadoPagoPoint, verifyOrder } from '../../supabase/functions/point/provider'
import type { ExpectedOrder, TokenSet } from '../../supabase/functions/point/provider'
import { configuration, processPointResult, runWorker } from '../../supabase/functions/point/service'
import type { Configuration, RpcClient } from '../../supabase/functions/point/service'
import { randomSecret, TokenVault } from '../../supabase/functions/point/crypto'
const token: TokenSet = { accessToken: 'synthetic-test-only', refreshToken: '', expiresAt: '2099-01-01T00:00:00Z', receiverId: '900001', environment: 'sandbox', scope: 'read write', source: 'server_test' }
const virtual = 'NEWLAND_N950__SBX0000001'
function adapter(handler: (path: string, init?: RequestInit) => Response) {
  return new MercadoPagoPoint({ clientId: '', clientSecret: '', redirectUri: 'https://example.test/point/callback', fetch: vi.fn(async (url, init) => handler(new URL(String(url)).pathname, init)) as typeof fetch })
}
const identity = { userId: 'user', authSessionId: 'session' }
async function fixture() {
  const writes: string[] = [], requests: string[] = []
  const vault = new TokenVault({ test: randomSecret() }, 'test')
  const connection = { tokenVersion: 1, businessId: 'business', environment: 'sandbox', receiverId: token.receiverId, tokensCiphertext: await vault.seal(token, 'mercadopago:business:sandbox') }
  const provider = adapter(path => {
    requests.push(path)
    if (path === '/users/me') return Response.json({ id: token.receiverId, site_id: 'MLM', tags: ['test_user'] })
    if (path.endsWith('/events')) return new Response(null, { status: 204 })
    return Response.json({ id: 'ORD1', user_id: token.receiverId, live_mode: false, status: 'created', config: { point: { terminal_id: virtual } } })
  })
  const config: Configuration = { adapter: provider, vault, clientId: '', redirectUri: 'https://example.test/point/callback', environment: 'live', chargesEnabled: false, testAccessToken: token.accessToken, localSimulator: false, oauthAvailable: false }
  const admin: RpcClient = { rpc(_name, args) {
    writes.push(String(args.p_action))
    return Promise.resolve({ data: args.p_action === 'connection_get' ? connection : args.p_action === 'official_sandbox_authorize' ? { data: { backendDirective: { connectionId: 'connection', remoteOrderId: 'ORD1' } } } : {}, error: null })
  } }
  return { config, admin, writes, requests }
}
describe('official Point sandbox boundary', () => {
  it('accepts 204 exclusively for order simulation, not an empty charge success', async () => {
    const provider = adapter(() => new Response(null, { status: 204 }))
    expect(await provider.request(token, '/v1/orders/ORD1/events', 'POST', { status: 'processed' })).toEqual({})
    await expect(provider.create(token, {}, 'unique-attempt')).rejects.toThrow('UNCERTAIN')
  })
  it('reports capabilities from configured secrets and preserves local simulator separation', async () => {
    const { config, admin } = await fixture()
    expect(await processPointResult(admin, { command: 'settings' }, { sandbox: { testBusiness: false } }, identity, config)).toMatchObject({ availableEnvironment: null, sandbox: { available: true, official: true, testBusiness: false } })
    expect(await processPointResult(admin, { command: 'settings' }, {}, identity, { ...config, testAccessToken: undefined })).toMatchObject({ sandbox: { available: false } })
    expect(await processPointResult(admin, { command: 'settings' }, {}, identity, { ...config, localSimulator: true })).toMatchObject({ sandbox: { available: false, official: false } })
  })
  it('requires a valid vault and provider configuration even with a test token', () => {
    const values: Record<string, string> = { MP_TEST_ACCESS_TOKEN: token.accessToken, MP_REDIRECT_URI: 'https://example.test/point/callback', MP_ENVIRONMENT: 'live', MP_TOKEN_KEYS: JSON.stringify({ test: randomSecret() }), MP_TOKEN_ACTIVE_KEY: 'test' }
    expect(configuration(name => values[name]).oauthAvailable).toBe(false)
    expect(() => configuration(name => name === 'MP_TOKEN_ACTIVE_KEY' ? 'missing' : values[name])).toThrow()
    expect(() => configuration(name => name === 'MP_API_BASE_URL' ? 'https://unknown.example' : values[name])).toThrow('POINT_CONFIGURATION_REQUIRED')
  })
  it('sends simulation only after current authorization and never materializes a payment', async () => {
    const f = await fixture()
    const request = { command: 'simulate', businessId: 'business', checkoutId: 'checkout', operatorToken: 'synthetic-operator', status: 'processed' }
    const result = { backendDirective: { kind: 'simulate', businessId: 'business', connectionId: 'connection', remoteOrderId: 'ORD1' } }
    expect(await processPointResult(f.admin, request, result, identity, f.config)).toEqual({ accepted: true })
    expect(f.writes).toEqual(['connection_get', 'official_sandbox_authorize'])
    expect(f.requests).toEqual(['/users/me', '/v1/orders/ORD1', '/v1/orders/ORD1/events'])
    await expect(processPointResult(f.admin, { ...request, status: 'refunded' }, result, identity, f.config)).rejects.toThrow('POINT_STATE_INVALID')
    await expect(processPointResult(f.admin, request, result, identity, { ...f.config, localSimulator: true })).rejects.toThrow('POINT_CONFIGURATION_REQUIRED')
  })
  it('does not send an event after session revocation or missing test credential', async () => {
    const f = await fixture()
    const request = { command: 'simulate', businessId: 'business', checkoutId: 'checkout', status: 'processed' }
    const result = { backendDirective: { kind: 'simulate', businessId: 'business', connectionId: 'connection', remoteOrderId: 'ORD1' } }
    const revoked: RpcClient = { rpc(name, args) { return args.p_action === 'official_sandbox_authorize' ? Promise.resolve({ data: null, error: { message: 'SESSION_INVALID' } }) : f.admin.rpc(name, args) } }
    await expect(processPointResult(revoked, request, result, identity, f.config)).rejects.toThrow('SESSION_INVALID')
    expect(f.requests).not.toContain('/v1/orders/ORD1/events')
    await expect(processPointResult(f.admin, request, result, identity, { ...f.config, testAccessToken: undefined })).rejects.toThrow('POINT_CONFIGURATION_REQUIRED')
  })
  it('rejects a live-account token accidentally configured as a test secret', async () => {
    const f = await fixture()
    f.config.adapter = adapter(() => Response.json({ id: token.receiverId, site_id: 'MLM', tags: [] }))
    await expect(processPointResult(f.admin, { command: 'connect_sandbox', operationId: 'op' }, { backendDirective: { kind: 'connect_sandbox', businessId: 'business' } }, identity, f.config)).rejects.toThrow('INVALID_RESPONSE')
    expect(f.writes).toHaveLength(0)
  })
})

// Shape observed from the official Orders sandbox on 4 October 2026. Synthetic
// IDs and recipient only; no credentials or real account response is a fixture.
const virtualExpected: ExpectedOrder = { amountCents: 500, currency: 'MXN', receiverId: token.receiverId, environment: 'sandbox', externalReference: 'synthetic-reference', terminalId: virtual }
function virtualOrder(status = 'processed') {
  return { id: 'ORDTST01SYNTHETIC', type: 'point', country_code: 'MEX', currency: 'MXN', user_id: token.receiverId,
    external_reference: virtualExpected.externalReference, status, status_detail: status === 'processed' ? 'accredited' : status,
    last_updated_date: '2026-10-04T20:40:00Z', config: { point: { terminal_id: virtual } },
    transactions: { payments: [{ id: 'PAYSYNTHETIC', amount: '5.00', paid_amount: status === 'processed' ? '5.00' : undefined,
      reference_id: '1234567890', status, status_detail: status === 'processed' ? 'accredited' : status }] } }
}
describe('official virtual Orders payment evidence', () => {
  it('verifies a test approval without inventing a Payments record or live_mode field', () => {
    expect(verifyOrder(virtualOrder(), virtualExpected, token)).toMatchObject({ state: 'approved', amountCents: 500, verified: true, environment: 'sandbox' })
    expect(verifyOrder(virtualOrder('at_terminal'), virtualExpected, token)).toMatchObject({ state: 'sent', verified: false })
  })
  it('rejects mismatched money, reference, receiver, terminal, country and non-test identities', () => {
    for (const changed of [
      { ...virtualOrder(), external_reference: 'another-reference' }, { ...virtualOrder(), user_id: 'another-receiver' },
      { ...virtualOrder(), currency: 'USD' }, { ...virtualOrder(), country_code: 'ARG' },
      { ...virtualOrder(), id: 'ORDLIVE' }, { ...virtualOrder(), live_mode: true },
      { ...virtualOrder(), config: { point: { terminal_id: 'NEWLAND_N950__PHYSICAL' } } },
      { ...virtualOrder(), transactions: { payments: [{ ...virtualOrder().transactions.payments[0], amount: '4.99' }] } },
      { ...virtualOrder(), transactions: { payments: [{ ...virtualOrder().transactions.payments[0], paid_amount: '4.99' }] } },
    ]) expect(() => verifyOrder(changed, virtualExpected, token)).toThrow('INVALID_RESPONSE')
    expect(() => verifyOrder(virtualOrder(), virtualExpected, { ...token, source: undefined })).toThrow('INVALID_RESPONSE')
    expect(() => verifyOrder(virtualOrder(), { ...virtualExpected, environment: 'live' }, { ...token, environment: 'live' })).toThrow('INVALID_RESPONSE')
  })
  for (const scenario of ['approved', 'pending', 'oauth', 'real-account'] as const) {
    it(`reconciles ${scenario} through the existing worker with current account verification`, async () => {
      const requests: string[] = [], writes: Record<string, unknown>[] = []
      const currentToken = scenario === 'oauth' ? { ...token, source: undefined } : token
      const vault = new TokenVault({ test: randomSecret() }, 'test')
      const connection = { tokenVersion: 1, businessId: 'business', environment: 'sandbox', receiverId: token.receiverId,
        tokensCiphertext: await vault.seal(currentToken, 'mercadopago:business:sandbox') }
      const provider = adapter(path => {
        requests.push(path)
        if (path === '/users/me') return Response.json({ id: token.receiverId, site_id: 'MLM', tags: scenario === 'real-account' ? [] : ['test_user'] })
        if (path.startsWith('/v1/payments/')) return Response.json({ error: 'not_found' }, { status: 404 })
        return Response.json(virtualOrder(scenario === 'pending' ? 'at_terminal' : 'processed'))
      })
      const config: Configuration = { adapter: provider, vault, clientId: '', redirectUri: 'https://example.test/point/callback', environment: 'sandbox',
        chargesEnabled: true, testAccessToken: token.accessToken, localSimulator: false }
      let claimed = false
      const admin: RpcClient = { rpc(_name, args) {
        const payload = args.p_payload as Record<string, unknown>
        if (args.p_action === 'connection_get') return Promise.resolve({ data: connection, error: null })
        if (args.p_action === 'claim_jobs') {
          const jobs = claimed ? [] : [{ id: 'job', kind: 'reconcile', attemptId: 'attempt', connectionId: 'connection', leaseToken: 'lease',
            payload: { ...virtualExpected, remoteOrderId: 'ORDTST01SYNTHETIC' } }]
          claimed = true; return Promise.resolve({ data: { jobs }, error: null })
        }
        if (args.p_action === 'apply_order') writes.push(payload)
        return Promise.resolve({ data: {}, error: null })
      } }
      expect(await runWorker(admin, config)).toEqual(['approved', 'pending'].includes(scenario) ? { processed: 1, failed: 0 } : { processed: 0, failed: 1 })
      if (scenario === 'approved' || scenario === 'pending') {
        expect(requests).toEqual(['/users/me', '/v1/orders/ORDTST01SYNTHETIC'])
        expect(writes).toMatchObject([{ state: scenario === 'approved' ? 'approved_verified' : 'sent_to_terminal', verified: scenario === 'approved', amountCents: 500 }])
      } else expect(writes).toHaveLength(0)
      if (scenario === 'oauth') expect(requests).toContain('/v1/payments/1234567890')
      if (scenario === 'real-account') expect(requests).toEqual(['/users/me'])
    })
  }
})
