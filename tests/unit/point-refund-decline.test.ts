import { describe, expect, it } from 'vitest'
import { randomSecret, TokenVault } from '../../supabase/functions/point/crypto'
import { MercadoPagoPoint } from '../../supabase/functions/point/provider'
import type { ExpectedOrder, TokenSet } from '../../supabase/functions/point/provider'
import { runWorker } from '../../supabase/functions/point/service'
import type { Configuration, RpcClient } from '../../supabase/functions/point/service'

const token: TokenSet = { accessToken: 'synthetic-test-only', refreshToken: '', expiresAt: '2099-01-01T00:00:00Z', receiverId: '900001', environment: 'sandbox', scope: 'read write', source: 'server_test' }
const expected: ExpectedOrder = { amountCents: 10000, currency: 'MXN', receiverId: token.receiverId, environment: 'sandbox', externalReference: 'synthetic-reference', terminalId: 'NEWLAND_N950__SBX0000001' }
const unsupported = { errors: [{ code: 'unsupported_partially_refunds', message: 'Untrusted provider explanation' }] }
function provider(fetch: typeof globalThis.fetch) { return new MercadoPagoPoint({ clientId: '', clientSecret: '', redirectUri: 'https://example.test/point/callback', fetch }) }
function order(refunds: unknown[] = []) {
  return { id: 'ORDTSTSYNTHETIC', type: 'point', country_code: 'MEX', currency: 'MXN', user_id: token.receiverId,
    external_reference: expected.externalReference, status: 'processed', status_detail: 'accredited', last_updated_date: '2026-10-04T20:40:00Z',
    config: { point: { terminal_id: expected.terminalId } }, transactions: { payments: [{ id: 'PAYSYNTHETIC', amount: '100.00', paid_amount: '100.00',
      reference_id: '1234567890', status: 'processed', status_detail: 'accredited' }], refunds } }
}

describe('definitive Point partial-refund rejection', () => {
  it.each([unsupported, { code: 'unsupported_partially_refunds' }, { error: 'unsupported_partially_refunds' }])('retains only the documented 400 partial-refund code', async body => {
    const adapter = provider(async () => Response.json(body, { status: 400 }))
    await expect(adapter.refund(token, 'ORDTSTSYNTHETIC', 'PAYSYNTHETIC', 200, 'same-request')).rejects.toMatchObject({ code: 'REFUND_UNSUPPORTED', status: 400, message: 'REFUND_UNSUPPORTED' })
    await expect(adapter.refund(token, 'ORDTSTSYNTHETIC', 'PAYSYNTHETIC', 10000, 'same-request', true)).rejects.toMatchObject({ code: 'DEFINITIVE_FAILURE' })
    await expect(adapter.request(token, '/v1/orders', 'POST', {}, 'same-request')).rejects.toMatchObject({ code: 'DEFINITIVE_FAILURE' })
  })
  it.each([409, 412, 422, 425, 428, 429, 500])('never treats HTTP %s as a terminal refusal', async status => {
    await expect(provider(async () => Response.json(unsupported, { status })).refund(token, 'ORDTSTSYNTHETIC', 'PAYSYNTHETIC', 200, 'same-request')).rejects.not.toMatchObject({ code: 'REFUND_UNSUPPORTED' })
  })
  it.each([{ errors: [{ code: 'refund_amount_exceeds' }] }, { errors: [{ code: 'unsupported_partially_refunds' }, { code: 'unknown' }] }, { message: 'unsupported_partially_refunds' }])('keeps generic or ambiguous 400 failures unresolved', async body => {
    await expect(provider(async () => Response.json(body, { status: 400 })).refund(token, 'ORDTSTSYNTHETIC', 'PAYSYNTHETIC', 200, 'same-request')).rejects.toMatchObject({ code: 'DEFINITIVE_FAILURE' })
  })
  it('keeps a lost transport response uncertain', async () => {
    await expect(provider(async () => { throw new TypeError('synthetic connection loss') }).refund(token, 'ORDTSTSYNTHETIC', 'PAYSYNTHETIC', 200, 'same-request')).rejects.toMatchObject({ code: 'UNCERTAIN' })
  })
  it('verifies both GETs, rejects the request and completes its job in one SQL action without refunding money', async () => {
    const f = await workerFixture()
    expect(await runWorker(f.admin, f.config)).toEqual({ processed: 1, failed: 0 })
    expect(f.paths).toEqual(['/users/me', '/v1/orders/ORDTSTSYNTHETIC', '/v1/orders/ORDTSTSYNTHETIC/refund', '/v1/orders/ORDTSTSYNTHETIC'])
    expect(f.writes).toMatchObject([{ action: 'refund_declined', payload: { jobId: 'job', leaseToken: 'lease', refundId: 'request', refundAmountCents: 200, idempotencyKey: 'same-request',
      code: 'unsupported_partially_refunds', amountCents: 10000, paymentId: 'PAYSYNTHETIC', remoteOrderId: 'ORDTSTSYNTHETIC', verified: true, refunds: [] } }])
    expect(f.writes).toHaveLength(1)
  })
  it.each(['prior-refund', 'new-refund', 'processing-refund', 'wrong-amount', 'bad-after-get', 'total', 'lost-lease', 'unrecognized-412'] as const)('retains the reservation for %s', async scenario => {
    const f = await workerFixture(scenario)
    expect(await runWorker(f.admin, f.config)).toEqual({ processed: 0, failed: 1 })
    const accepted = f.writes.filter(write => write.action === 'refund_declined' && scenario !== 'lost-lease')
    expect(accepted).toHaveLength(0)
    expect(f.writes.at(-1)?.action).toBe('fail_job')
    expect(f.writes.some(write => write.action === 'apply_order' || write.action === 'record_remote_refund')).toBe(false)
  })
  it('reconciles a known refund locator without repeating POST or declining it', async () => {
    const f = await workerFixture('known-locator')
    expect(await runWorker(f.admin, f.config)).toEqual({ processed: 1, failed: 0 })
    expect(f.paths.filter(path => path.endsWith('/refund'))).toHaveLength(0)
    expect(f.writes.map(write => write.action)).toEqual(['apply_order', 'complete_job'])
  })
})

async function workerFixture(scenario = '') {
  const vault = new TokenVault({ test: randomSecret() }, 'test'), paths: string[] = [], writes: { action: string; payload: Record<string, unknown> }[] = []
  const connection = { tokenVersion: 1, businessId: 'business', environment: 'sandbox', receiverId: token.receiverId, tokensCiphertext: await vault.seal(token, 'mercadopago:business:sandbox') }
  let read = 0, claimed = false
  const adapter = provider(async input => {
    const path = new URL(String(input)).pathname; paths.push(path)
    if (path === '/users/me') return Response.json({ id: token.receiverId, site_id: 'MLM', tags: ['test_user'] })
    if (path.endsWith('/refund')) return Response.json(unsupported, { status: scenario === 'unrecognized-412' ? 412 : 400 })
    read++
    if (scenario === 'bad-after-get' && read === 2) return Response.json({}, { status: 500 })
    const refund = { id: 'REFSYNTHETIC', amount: '2.00', transaction_id: 'PAYSYNTHETIC', status: scenario === 'processing-refund' ? 'processing' : 'processed' }
    const current = order(scenario === 'prior-refund' || scenario === 'processing-refund' || scenario === 'new-refund' && read === 2 ? [refund] : [])
    if (current.transactions.refunds.length && scenario !== 'processing-refund') current.status_detail = 'partially_refunded'
    if (scenario === 'wrong-amount' && read === 2) current.transactions.payments[0].amount = '99.99'
    return Response.json(current)
  })
  const config: Configuration = { adapter, vault, clientId: '', redirectUri: 'https://example.test/point/callback', environment: 'sandbox', chargesEnabled: true, testAccessToken: token.accessToken }
  const amountCents = scenario === 'total' ? 10000 : 200
  const admin: RpcClient = { rpc(_name, args) {
    const action = String(args.p_action), payload = args.p_payload as Record<string, unknown>
    if (action === 'connection_get') return Promise.resolve({ data: connection, error: null })
    if (action === 'claim_jobs') {
      const jobs = claimed ? [] : [{ id: 'job', kind: 'refund', attemptId: 'attempt', connectionId: 'connection', leaseToken: 'lease', payload: { ...expected, remoteOrderId: 'ORDTSTSYNTHETIC', paymentId: 'PAYSYNTHETIC',
        idempotencyKey: 'same-request', refundAmountCents: amountCents, refundRequest: { id: 'request', status: 'pending', amountCents, firstSentAt: new Date().toISOString(), remoteRefundId: scenario === 'known-locator' ? 'REFKNOWN' : null } } }]
      claimed = true; return Promise.resolve({ data: { jobs }, error: null })
    }
    if (action !== 'pending_sweep') writes.push({ action, payload })
    return Promise.resolve({ data: {}, error: action === 'refund_declined' && scenario === 'lost-lease' ? { message: 'POINT_LEASE_LOST' } : null })
  } }
  return { admin, config, writes, paths }
}
