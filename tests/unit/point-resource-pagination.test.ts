import { describe, expect, it, vi } from 'vitest'
import { randomSecret, TokenVault } from '../../supabase/functions/point/crypto'
import { MercadoPagoPoint } from '../../supabase/functions/point/provider'
import { processPointResult } from '../../supabase/functions/point/service'
import type { Configuration, RpcClient } from '../../supabase/functions/point/service'
import type { TokenSet } from '../../supabase/functions/point/provider'

const token: TokenSet = { accessToken: 'synthetic-token', refreshToken: 'synthetic-refresh', expiresAt: '2099-01-01T00:00:00Z', receiverId: '900001', environment: 'live', scope: 'read write offline_access' }
const branch = { id: '100001', name: 'Sucursal', user_id: token.receiverId }
const register = (index: number) => ({ id: String(200001 + index), name: `Caja ${index}`, user_id: token.receiverId })
const terminal = (index: number) => ({ id: `NEWLAND_N950__SYNTHETIC${index}`, store_id: branch.id, pos_id: register(index).id, operating_mode: 'PDV' })
function paged(url: URL, rows: unknown[], field: 'results' | 'data' | 'terminals') {
  const limit = Number(url.searchParams.get('limit')), offset = Number(url.searchParams.get('offset'))
  const selected = rows.slice(offset, offset + limit), paging = { limit, offset, total: rows.length }
  return Response.json(field === 'terminals' ? { data: { terminals: selected }, paging } : { [field]: selected, paging })
}
async function fixture(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: URL[] = [], vault = new TokenVault({ fixture: randomSecret() }, 'fixture')
  const connection = { businessId: 'business', receiverId: token.receiverId, environment: token.environment, tokenVersion: 1, tokensCiphertext: await vault.seal(token, 'mercadopago:business:live') }
  const admin: RpcClient = { rpc() { return Promise.resolve({ data: connection, error: null }) } }
  const adapter = new MercadoPagoPoint({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/point/callback', fetch: async (input, init) => {
    const url = new URL(String(input)); calls.push(url)
    return url.pathname === '/users/me' ? Response.json({ id: token.receiverId, site_id: 'MLM', tags: [] }) : handler(url, init!)
  } })
  const config: Configuration = { adapter, vault, clientId: 'synthetic-client', redirectUri: 'https://example.test/point/callback', environment: 'live', chargesEnabled: false }
  const run = (command = 'resources', payload = {}) => processPointResult(admin, { command, ...payload }, { backendDirective: { kind: command, businessId: 'business', connectionId: 'connection' } }, undefined, config)
  return { calls, run }
}
describe('provider resource pagination and branch identity', () => {
  it('loads all 51 registers and terminals with the official POS page limit and store filter', async () => {
    const f = await fixture(url => {
      if (url.pathname.endsWith('/stores/search')) return paged(url, [branch], 'results')
      if (url.pathname === '/v2/pos') { expect(url.searchParams.get('store_id')).toBe(branch.id); expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(30); return paged(url, Array.from({ length: 51 }, (_, index) => register(index)), 'data') }
      return paged(url, Array.from({ length: 51 }, (_, index) => terminal(index)), 'terminals')
    })
    const result = await f.run() as { registers: { id: string; branchId: string }[]; terminals: { id: string; registerName: string }[] }
    expect(result.registers).toHaveLength(51); expect(result.terminals).toHaveLength(51)
    expect(result.registers[50]).toMatchObject({ id: register(50).id, branchId: branch.id })
    expect(result.terminals[50]).toMatchObject({ id: terminal(50).id, registerName: register(50).name })
    expect(f.calls.filter(url => url.pathname === '/v2/pos').map(url => url.searchParams.get('offset'))).toEqual(['0', '30'])
    expect(f.calls.filter(url => url.pathname === '/terminals/v1/list').map(url => url.searchParams.get('offset'))).toEqual(['0', '50'])
  })
  it('verifies a requested branch beyond the first stores page before creating its POS', async () => {
    const branches = Array.from({ length: 51 }, (_, index) => ({ ...branch, id: String(100001 + index) }))
    const f = await fixture((url, init) => url.pathname.endsWith('/stores/search') ? paged(url, branches, 'results') : Response.json({ ...JSON.parse(String(init.body)), id: '300001', user_id: token.receiverId }))
    expect(await f.run('create_register', { branchId: branches[50].id, name: 'Caja', operationId: '10000000-0000-4000-8000-000000000001' })).toMatchObject({ id: '300001', branchId: branches[50].id })
    expect(f.calls.filter(url => url.pathname.endsWith('/stores/search')).map(url => url.searchParams.get('offset'))).toEqual(['0', '50'])
  })
  it.each(['receiver', 'branch', 'duplicate', 'offset', 'total', 'missing-page'])('rejects invalid %s metadata instead of returning a partial or misassigned list', async scenario => {
    const f = await fixture(url => {
      if (url.pathname.endsWith('/stores/search')) return paged(url, [branch], 'results')
      if (url.pathname === '/v2/pos') {
        if (scenario === 'receiver') return paged(url, [{ ...register(0), user_id: '900002' }], 'data')
        if (scenario === 'branch') return paged(url, [{ ...register(0), store_id: 'another-store' }], 'data')
        if (scenario === 'duplicate') return paged(url, [register(0), register(0)], 'data')
        if (scenario === 'offset') return Response.json({ data: [register(0)], paging: { limit: 30, offset: 30, total: 1 } })
        if (scenario === 'total') return Response.json({ data: [register(0)], paging: { limit: 30, offset: 0, total: 0 } })
        return Response.json({ data: [], paging: { limit: 30, offset: 0, total: 1 } })
      }
      return paged(url, [], 'terminals')
    })
    await expect(f.run()).rejects.toThrow('INVALID_RESPONSE')
  })
  it('stops oversized or excessive resource queries with an explicit error, never a truncated success', async () => {
    const oversized = await fixture(() => Response.json({ results: [], paging: { total: 501, limit: 50, offset: 0 } }))
    await expect(oversized.run()).rejects.toThrow('POINT_SERVICE_UNAVAILABLE')
    const branches = Array.from({ length: 45 }, (_, index) => ({ ...branch, id: String(100001 + index) }))
    const exhausted = await fixture(url => url.pathname.endsWith('/stores/search') ? paged(url, branches, 'results') : paged(url, [], 'data'))
    await expect(exhausted.run()).rejects.toThrow('POINT_SERVICE_UNAVAILABLE')
    expect(exhausted.calls.length).toBeLessThanOrEqual(41)
  })
  it('shares a 15-second deadline across stores, registers and terminals', async () => {
    const f = await fixture(url => { vi.setSystemTime(Date.now() + 16000); return paged(url, [branch], 'results') })
    vi.useFakeTimers()
    try {
      await expect(f.run()).rejects.toThrow('POINT_SERVICE_UNAVAILABLE')
      expect(f.calls.some(url => url.pathname === '/v2/pos')).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('ends a hanging resource read at the shared deadline without returning a partial list', async () => {
    let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const f = await fixture(() => { began(); return new Promise<Response>(() => {}) })
    vi.useFakeTimers()
    try {
      const assertion = expect(f.run()).rejects.toThrow('POINT_SERVICE_UNAVAILABLE')
      await started
      await vi.advanceTimersByTimeAsync(15001)
      await assertion
    } finally { vi.useRealTimers() }
  })
})
