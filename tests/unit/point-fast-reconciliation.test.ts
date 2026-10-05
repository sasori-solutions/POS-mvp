import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { randomSecret, TokenVault } from '../../supabase/functions/point/crypto'
import { MercadoPagoPoint } from '../../supabase/functions/point/provider'
import type { ExpectedOrder, TokenSet } from '../../supabase/functions/point/provider'
import { processPointResult, runWorker } from '../../supabase/functions/point/service'
import type { Configuration, RpcClient, WorkerScope } from '../../supabase/functions/point/service'

const scope: WorkerScope = { businessId: randomUUID(), attemptId: randomUUID() }
const expected: ExpectedOrder = { amountCents: 500, currency: 'MXN', receiverId: '900001', environment: 'sandbox',
  externalReference: 'synthetic-fast-path', terminalId: 'NEWLAND_N950__SBX0000001' }
const token: TokenSet = { accessToken: 'synthetic-fast-test-token', refreshToken: '', expiresAt: '2099-01-01T00:00:00Z',
  receiverId: expected.receiverId, environment: 'sandbox', scope: 'read write', source: 'server_test' }
async function fixture(status = 'processed') {
  const vault = new TokenVault({ test: randomSecret() }, 'test')
  const calls: { action: string; payload: Record<string, unknown> }[] = [], requests: string[] = []
  const connection = { tokenVersion: 1, businessId: scope.businessId, environment: 'sandbox', receiverId: token.receiverId,
    tokensCiphertext: await vault.seal(token, `mercadopago:${scope.businessId}:sandbox`) }
  let claimed = false, leaseAvailable = true
  const admin: RpcClient = { rpc(_name, args) {
    const action = String(args.p_action), payload = args.p_payload as Record<string, unknown>
    calls.push({ action, payload })
    let data: unknown = {}
    if (action === 'connection_get') data = connection
    else if (action === 'official_sandbox_authorize') data = { backendDirective: { connectionId: 'connection', remoteOrderId: 'ORDTSTFIXTURE' } }
    else if (action === 'claim_jobs') {
      data = { jobs: claimed || !leaseAvailable ? [] : [{ id: 'job', kind: 'reconcile', attemptId: scope.attemptId, connectionId: 'connection',
        leaseToken: 'lease', payload: { ...expected, remoteOrderId: 'ORDTSTFIXTURE' } }] }
      claimed = true
    }
    return Promise.resolve({ data, error: null })
  } }
  const adapter = new MercadoPagoPoint({ clientId: 'fixture', clientSecret: 'fixture-secret', redirectUri: 'https://example.test/point/callback',
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname; requests.push(`${init?.method}:${path}`)
      if (path === '/users/me') return Response.json({ id: token.receiverId, site_id: 'MLM', tags: ['test_user'] })
      if (path.endsWith('/events')) return new Response(null, { status: 204 })
      return Response.json({ id: 'ORDTSTFIXTURE', type: 'point', country_code: 'MEX', currency: 'MXN', user_id: token.receiverId,
        external_reference: expected.externalReference, status, status_detail: status === 'processed' ? 'accredited' : 'created',
        last_updated_date: '2026-10-05T12:00:00Z', config: { point: { terminal_id: expected.terminalId } },
        transactions: { payments: [{ id: 'PAYFIXTURE', amount: '5.00', status, status_detail: status === 'processed' ? 'accredited' : 'created' }] } })
    }) as typeof fetch })
  const config: Configuration = { adapter, vault, clientId: 'fixture', redirectUri: 'https://example.test/point/callback',
    environment: 'sandbox', chargesEnabled: false, testAccessToken: token.accessToken }
  return { admin, config, calls, requests, disableLease: () => { leaseAvailable = false } }
}

describe('Point fast reconciliation uses the existing durable worker', () => {
  it('claims only the authorized attempt once and verifies GET before applying money', async () => {
    const f = await fixture()
    expect(await runWorker(f.admin, f.config, scope)).toEqual({ processed: 1, failed: 0 })
    expect(f.calls.map(call => call.action)).toEqual(['reconcile_now', 'claim_jobs', 'connection_get', 'apply_order', 'complete_job'])
    expect(f.calls[0].payload).toEqual(scope)
    expect(f.calls[1].payload).toMatchObject({ ...scope, limit: 1, chargesEnabled: false })
    expect(f.calls[3].payload).toMatchObject({ attemptId: scope.attemptId, verified: true, state: 'approved_verified', amountCents: 500, jobId: 'job', leaseToken: 'lease' })
    expect(f.requests).toEqual(['GET:/users/me', 'GET:/v1/orders/ORDTSTFIXTURE'])
  })

  it('a competing live lease leaves the queue and provider alone', async () => {
    const f = await fixture(); f.disableLease()
    expect(await runWorker(f.admin, f.config, scope)).toEqual({ processed: 0, failed: 0 })
    expect(f.calls.map(call => call.action)).toEqual(['reconcile_now', 'claim_jobs'])
    expect(f.requests).toHaveLength(0)
  })

  it('a pending provider GET keeps payment unconfirmed without another collection', async () => {
    const f = await fixture('created')
    expect(await runWorker(f.admin, f.config, scope)).toEqual({ processed: 1, failed: 0 })
    expect(f.calls.find(call => call.action === 'apply_order')?.payload).toMatchObject({ state: 'pending', verified: false, amountCents: 500 })
    expect(f.requests.every(request => request.startsWith('GET:'))).toBe(true)
  })

  it('hides private wake metadata and keeps the accepted response when scheduling fails', async () => {
    const f = await fixture(), work: WorkerScope[] = []
    const request = { command: 'status', businessId: scope.businessId }
    const result = { id: 'checkout', state: 'processing', backendWork: scope }
    expect(await processPointResult(f.admin, request, result, undefined, f.config, target => { work.push(target) })).toEqual({ id: 'checkout', state: 'processing' })
    expect(work).toEqual([scope])
    expect(await processPointResult(f.admin, request, result, undefined, f.config, () => { throw new Error('runtime ended') })).toEqual({ id: 'checkout', state: 'processing' })
    expect(f.calls).toHaveLength(0)
    expect(await processPointResult(f.admin, request, { ...result, backendWork: { ...scope, businessId: randomUUID() } }, undefined, f.config, target => { work.push(target) })).not.toHaveProperty('backendWork')
    expect(work).toHaveLength(1)
  })

  it('wakes simulation only after the event is accepted and does not apply that event as payment', async () => {
    const f = await fixture('created'), work: WorkerScope[] = []
    expect(await processPointResult(f.admin, { command: 'simulate', businessId: scope.businessId, checkoutId: 'checkout', status: 'processed' },
      { backendDirective: { kind: 'simulate', businessId: scope.businessId, connectionId: 'connection', remoteOrderId: 'ORDTSTFIXTURE' }, backendWork: scope },
      { userId: 'owner', authSessionId: 'session' }, f.config, target => {
        expect(f.requests).toContain('POST:/v1/orders/ORDTSTFIXTURE/events'); work.push(target)
      })).toEqual({ accepted: true })
    expect(work).toEqual([scope])
    expect(f.calls.map(call => call.action)).toEqual(['connection_get', 'official_sandbox_authorize'])
    expect(f.calls.some(call => call.action === 'apply_order')).toBe(false)
  })

  it.each(['start', 'status'])('wakes an authorized shared-device %s using the server tenant and hides the hint', async command => {
    const f = await fixture(), work: WorkerScope[] = []
    const result = { id: 'checkout', state: 'pending', backendWork: scope }
    expect(await processPointResult(f.admin, { action: 'device_point', command }, result, undefined, f.config, target => { work.push(target) })).toEqual({ id: 'checkout', state: 'pending' })
    expect(work).toEqual([scope])
    expect(f.calls).toHaveLength(0)
  })

  it('does not let a shared device simulate or wake a provider transition without personal authorization', async () => {
    const f = await fixture('created'), work: WorkerScope[] = []
    await expect(processPointResult(f.admin, { action: 'device_point', command: 'simulate', checkoutId: 'checkout', status: 'processed' },
      { backendDirective: { kind: 'simulate', businessId: scope.businessId, connectionId: 'connection', remoteOrderId: 'ORDTSTFIXTURE' }, backendWork: scope },
      undefined, f.config, target => { work.push(target) })).rejects.toThrow('PERMISSION_DENIED')
    expect(work).toHaveLength(0)
    expect(f.requests.some(request => request.startsWith('POST:'))).toBe(false)
    expect(f.calls.some(call => call.action === 'apply_order')).toBe(false)
  })

  it('does not wake or change money when sandbox provider rejects the simulated event', async () => {
    const f = await fixture('created'), work: WorkerScope[] = []
    const request = f.config.adapter.request.bind(f.config.adapter)
    f.config.adapter.request = async (...args) => { if (args[1].endsWith('/events')) throw new Error('provider did not accept'); return request(...args) }
    await expect(processPointResult(f.admin, { command: 'simulate', businessId: scope.businessId, checkoutId: 'checkout', status: 'processed' },
      { backendDirective: { kind: 'simulate', businessId: scope.businessId, connectionId: 'connection', remoteOrderId: 'ORDTSTFIXTURE' }, backendWork: scope },
      { userId: 'owner', authSessionId: 'session' }, f.config, target => { work.push(target) })).rejects.toThrow('provider did not accept')
    expect(work).toHaveLength(0)
    expect(f.calls.some(call => call.action === 'apply_order')).toBe(false)
  })
})
