import { describe, expect, it } from 'vitest'
import { processPointResult } from '../../supabase/functions/point/service'
import type { Configuration, RpcClient } from '../../supabase/functions/point/service'
import { MercadoPagoPoint } from '../../supabase/functions/point/provider'
import type { TokenSet } from '../../supabase/functions/point/provider'
import { randomSecret, TokenVault } from '../../supabase/functions/point/crypto'

const token: TokenSet = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', receiverId: '900001',
  expiresAt: '2099-01-01T00:00:00Z', environment: 'live', scope: 'read write offline_access' }
const operationId = '10000000-0000-4000-8000-000000000001'
async function fixture(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { path: string; method: string; key: string | null; body: Record<string, unknown> | null }[] = []
  const vault = new TokenVault({ fixture: randomSecret() }, 'fixture')
  const connection = { businessId: 'business', receiverId: token.receiverId, environment: token.environment, tokenVersion: 1,
    tokensCiphertext: await vault.seal(token, 'mercadopago:business:live') }
  const admin: RpcClient = { rpc() { return Promise.resolve({ data: connection, error: null }) } }
  const provider = new MercadoPagoPoint({ clientId: 'fixture-app', clientSecret: 'fixture-secret', redirectUri: 'https://example.test/point/callback',
    fetch: (async (input, init) => {
      const url = new URL(String(input)), options = init!
      calls.push({ path: url.pathname + url.search, method: options.method!, key: new Headers(options.headers).get('X-Idempotency-Key'),
        body: options.body ? JSON.parse(String(options.body)) : null })
      if (url.pathname === '/users/me') return Response.json({ id: token.receiverId, site_id: 'MLM', tags: [] })
      return handler(url, options)
    }) as typeof fetch })
  const config: Configuration = { adapter: provider, vault, clientId: 'fixture-app', redirectUri: 'https://example.test/point/callback',
    environment: 'live', chargesEnabled: true, oauthAvailable: true }
  const run = (command: string, request = {}) => processPointResult(admin, { command, businessId: 'business', ...request },
    { backendDirective: { kind: command, businessId: 'business', connectionId: 'connection' } }, undefined, config)
  return { calls, config, admin, run }
}

describe('Point terminal setup uses the current provider contract', () => {
  it('discovers v2 POS data and maps only the connected recipient', async () => {
    const f = await fixture(url => {
      if (url.pathname.endsWith('/stores/search')) return Response.json({ results: [{ id: 'store-1', name: 'Sucursal', user_id: token.receiverId }] })
      if (url.pathname === '/v2/pos') return Response.json({ data: [{ id: 'pos-1', name: 'Caja', store_id: 'store-1', user_id: token.receiverId }] })
      if (url.pathname === '/terminals/v1/list') return Response.json({ data: { terminals: [{ id: 'NEWLAND_N950__SERIAL', store_id: 'store-1', pos_id: 'pos-1', operating_mode: 'PDV' }] } })
      return new Response(null, { status: 404 })
    })
    expect(await f.run('resources')).toMatchObject({ registers: [{ id: 'pos-1', branchId: 'store-1', name: 'Caja' }],
      terminals: [{ registerName: 'Caja', branchName: 'Sucursal' }] })
    expect(f.calls.some(c => c.path === '/pos?limit=50&offset=0')).toBe(false)
  })
  it('creates a v2 POS with stable idempotency and a valid external identifier', async () => {
    const f = await fixture((url, init) => {
      if (url.pathname.endsWith('/stores/search')) return Response.json({ results: [{ id: 'store-1' }] })
      if (url.pathname === '/v2/pos' && init.method === 'POST') return Response.json({ id: 'pos-1', name: 'Caja', user_id: token.receiverId, external_id: JSON.parse(String(init.body)).external_id })
      return new Response(null, { status: 404 })
    })
    const request = { operationId, branchId: 'store-1', name: 'Caja' }
    expect(await f.run('create_register', request)).toEqual({ id: 'pos-1', branchId: 'store-1', name: 'Caja' })
    await f.run('create_register', request)
    const creates = f.calls.filter(c => c.method === 'POST')
    expect(creates.map(c => [c.path, c.key])).toEqual([['/v2/pos', operationId], ['/v2/pos', operationId]])
    expect(String(creates[0].body?.external_id)).toMatch(/^[A-Za-z0-9]{38}$/)
    expect(creates[0].body).toEqual({ name: 'Caja', store_id: 'store-1', external_id: `sasori${operationId.replaceAll('-', '')}` })
  })
  it('does not return a POS associated with another branch', async () => {
    const f = await fixture(url => url.pathname.endsWith('/stores/search')
      ? Response.json({ results: [{ id: 'store-1' }] }) : Response.json({ id: 'pos-1', store_id: 'another-store', name: 'Caja' }))
    await expect(f.run('create_register', { operationId, branchId: 'store-1', name: 'Caja' })).rejects.toThrow('POINT_FACT_MISMATCH')
  })
  it('exposes the server charge gate without preventing read or recovery', async () => {
    const f = await fixture(() => Response.json({}))
    expect(await processPointResult(f.admin, { command: 'settings' }, { enabled: true }, undefined, { ...f.config, chargesEnabled: false }))
      .toMatchObject({ enabled: true, chargesEnabled: false, availableEnvironment: 'live' })
  })
  it('recovers a created branch after a lost response using its original external reference', async () => {
    let created = false
    const location = { street_number: '1', street_name: 'Calle ficticia', city_name: 'Ciudad', state_name: 'Estado', latitude: 20, longitude: -103, reference: '' }
    const branch = { id: 'store-1', name: 'Sucursal', external_id: `sasori${operationId.replaceAll('-', '')}`, user_id: token.receiverId, location }
    const f = await fixture((url, init) => {
      if (url.pathname.endsWith('/stores/search')) return Response.json({ results: created ? [branch] : [] })
      if (init.method === 'POST' && url.pathname.endsWith('/stores')) { created = true; return new Response(null, { status: 503 }) }
      return new Response(null, { status: 404 })
    })
    const request = { operationId, name: branch.name, location }
    await expect(f.run('create_branch', request)).rejects.toThrow('UNCERTAIN')
    expect(await f.run('create_branch', request)).toEqual({ id: 'store-1', name: 'Sucursal' })
    expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(1)
    expect(f.calls.filter(c => c.path.includes('external_id=')).map(c => c.path)).toEqual([
      `/users/${token.receiverId}/stores/search?external_id=${branch.external_id}`,
      `/users/${token.receiverId}/stores/search?external_id=${branch.external_id}`,
    ])
    await expect(f.run('create_branch', { ...request, name: 'Otro nombre' })).rejects.toThrow('POINT_FACT_MISMATCH')
  })
})
