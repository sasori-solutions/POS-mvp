import { describe, expect, it } from 'vitest'
import { digest, randomSecret, TokenVault } from '../../supabase/functions/point/crypto'
import { MercadoPagoPoint } from '../../supabase/functions/point/provider'
import { processPointResult } from '../../supabase/functions/point/service'
import type { Configuration, RpcClient } from '../../supabase/functions/point/service'

describe('OAuth completion after provider I/O', () => {
  it.each([null, 'AUTH_REQUIRED', 'SESSION_INVALID', 'BUSINESS_ACCESS_DENIED'])('revalidates identity and the consumed state before saving: %s', denied => {
    return completion(denied)
  })
})

async function completion(denied: string | null) {
  const state = randomSecret(), identity = { userId: 'synthetic-owner', authSessionId: 'synthetic-session' }
  const request = { command: 'oauth_callback', businessId: 'synthetic-business', operatorToken: 'synthetic-operator', code: 'synthetic-code', state }
  const vault = new TokenVault({ test: randomSecret() }, 'test')
  const stateHash = await digest(state)
  const verifierCiphertext = await vault.seal({ verifier: 'synthetic-verifier' }, `oauth:${request.businessId}:${identity.userId}:${stateHash}`)
  const writes: { action: unknown; payload: Record<string, unknown> }[] = []
  let exchanged = false
  const adapter = new MercadoPagoPoint({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/point/callback', fetch: async input => {
    if (new URL(String(input)).pathname === '/oauth/token') { exchanged = true; return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', user_id: '900001', expires_in: 3600, live_mode: true, scope: 'read write offline_access' }) }
    return Response.json({ id: '900001', site_id: 'MLM', tags: [] })
  } })
  const config: Configuration = { adapter, vault, clientId: 'synthetic-client', redirectUri: 'https://example.test/point/callback', environment: 'live', chargesEnabled: false }
  const admin: RpcClient = { rpc(_name, args) {
    if (args.p_action === 'oauth_state_consume') return Promise.resolve({ data: { environment: 'live', verifierCiphertext }, error: null })
    expect(exchanged).toBe(true)
    writes.push({ action: args.p_action, payload: args.p_payload as Record<string, unknown> })
    return Promise.resolve({ data: denied ? null : {}, error: denied ? { message: denied } : null })
  } }
  const result = processPointResult(admin, request, { backendDirective: { kind: 'oauth_callback', businessId: request.businessId } }, identity, config)
  if (denied) await expect(result).rejects.toThrow(denied)
  else expect(await result).toMatchObject({ connected: true, environment: 'live', receiverId: '900001' })
  expect(writes).toMatchObject([{ action: 'oauth_connection_save', payload: { ...identity, businessId: request.businessId, stateHash, redirectUri: config.redirectUri, operatorToken: request.operatorToken, environment: 'live', receiverId: '900001' } }])
  expect(writes).toHaveLength(1)
  expect(writes[0].payload.tokensCiphertext).not.toContain('synthetic-access')
}
