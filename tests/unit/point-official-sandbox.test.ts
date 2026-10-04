import { describe, expect, it, vi } from 'vitest'
import { MercadoPagoPoint } from '../../supabase/functions/point/provider'
import type { TokenSet } from '../../supabase/functions/point/provider'
import { configuration, processPointResult } from '../../supabase/functions/point/service'
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
