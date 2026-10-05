import { startSimulator } from './simulator.mjs'
import { createPayload, mapState, MercadoPagoPoint, ProviderError, record, verifyOrder } from '../../supabase/functions/point/provider.ts'
import type { ExpectedOrder, PointAdapter, TokenSet } from '../../supabase/functions/point/provider.ts'
import { randomSecret, TokenVault } from '../../supabase/functions/point/crypto.ts'
import { configuration, connectionToken, processPointResult, runWorker } from '../../supabase/functions/point/service.ts'
import type { Configuration, RpcClient } from '../../supabase/functions/point/service.ts'
import { verifySignature } from '../../supabase/functions/point/webhook.ts'
import { boundedBody, workerAuthorized } from '../../supabase/functions/point/http.ts'
function assert(value: unknown, message = 'Assertion failed'): asserts value { if (!value) throw new Error(message) }
function equal(actual: unknown, expected: unknown): void { assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) }
async function rejects(task: () => unknown, code?: string): Promise<void> {
  let caught = false
  try { await task() } catch (error) { caught = true; if (code) equal((error as Error).message, code) }
  assert(caught, 'Expected rejection')
}
const expected: ExpectedOrder = { amountCents: 1000, currency: 'MXN', receiverId: '900001', environment: 'sandbox', externalReference: 'sasori_attempt_1', terminalId: 'NEWLAND_N950__SERIAL-1' }
const syntheticToken: TokenSet = { accessToken: 'sim-access-1', refreshToken: 'sim-refresh-1', expiresAt: '2099-01-01T00:00:00Z', receiverId: '900001', environment: 'sandbox', scope: 'read write offline_access' }
async function setup(scenario = 'approved') {
  const sim = await startSimulator()
  sim.state.scenario = scenario
  const adapter = new MercadoPagoPoint({ clientId: 'sim-client', clientSecret: 'sim-secret', redirectUri: 'http://127.0.0.1:5173/point/callback', baseUrl: sim.url, allowLocalSimulator: true, timeoutMs: 1000 })
  const token = await adapter.exchange('sim-code', randomSecret(), 'sandbox')
  return { sim, adapter, token }
}
async function evidence(adapter: PointAdapter, token: TokenSet, order: Record<string, unknown>) {
  const payment = record((record(order.transactions).payments as unknown[])[0])
  const proof = payment.reference_id ? await adapter.request(token, `/v1/payments/${payment.reference_id}`) : undefined
  return verifyOrder(order, expected, token, proof)
}
Deno.test('real HTTP adapter serializes exact cents, idempotency and official Orders/payment evidence', async () => {
  const { sim, adapter, token } = await setup()
  try {
    const order = await adapter.create(token, createPayload(expected), 'key-1')
    equal(order.currency, undefined) // official Orders sample omits currency; the payment source supplies it.
    equal((await evidence(adapter, token, order)).state, 'approved')
    await adapter.create(token, createPayload(expected), 'key-1')
    equal(sim.state.creates, 1)
    await rejects(() => adapter.create(token, createPayload({ ...expected, amountCents: 1001 }), 'key-1'), 'DEFINITIVE_FAILURE')
    equal(sim.state.calls.filter(c => c.path === '/v1/orders').map(c => c.key), ['key-1', 'key-1', 'key-1'])
  } finally { await sim.close() }
})
Deno.test('timeout before and after charge recover with the same identity without another charge', async () => {
  for (const scenario of ['timeout-before', 'timeout-after', 'transient-after', 'invalid-json']) {
    const { sim, adapter, token } = await setup(scenario)
    try {
      await rejects(() => adapter.create(token, createPayload(expected), 'lost-response'), 'UNCERTAIN')
      sim.state.scenario = 'approved'
      const recovered = await adapter.create(token, createPayload(expected), 'lost-response')
      equal((await evidence(adapter, token, recovered)).state, 'approved')
      equal(sim.state.creates, 1)
    } finally { await sim.close() }
  }
})
Deno.test('authoritative wrong amount currency account environment can never approve', async () => {
  for (const scenario of ['wrong-amount', 'wrong-currency', 'wrong-account']) {
    const { sim, adapter, token } = await setup(scenario)
    try {
      const order = await adapter.create(token, createPayload(expected), 'wrong-fact')
      await rejects(() => evidence(adapter, token, order), 'INVALID_RESPONSE')
    } finally { await sim.close() }
  }
  const { sim, adapter, token } = await setup()
  try { sim.state.scenario = 'wrong-environment'; await rejects(() => adapter.verifyAccount(token), 'INVALID_RESPONSE') } finally { await sim.close() }
})
Deno.test('complete status mapping keeps action_required and unknown details in review', () => {
  equal(mapState('created', 'created', 'created', 'created'), 'pending')
  equal(mapState('at_terminal', 'at_terminal', 'at_terminal', 'at_terminal'), 'sent')
  equal(mapState('action_required', 'action_required', 'action_required', 'check_on_terminal'), 'review')
  equal(mapState('processed', 'processed', 'processed', 'accredited'), 'approved')
  equal(mapState('processed', 'partially_refunded', 'processed', 'accredited'), 'partially_refunded')
  equal(mapState('refunded', 'refunded', 'refunded', 'refunded'), 'refunded')
  equal(mapState('failed', 'failed', 'failed', 'rejected_by_issuer'), 'rejected')
  equal(mapState('failed', 'failed', 'failed', 'in_review'), 'review')
  equal(mapState('canceled', 'canceled', 'canceled', 'canceled_by_api'), 'canceled')
  equal(mapState('expired', 'expired', 'expired', 'expired'), 'expired')
  equal(mapState('processed', 'processed', 'processed', 'future_status'), 'review')
})
Deno.test('partial and full HTTP refunds confirm cumulative evidence and deduplicate refund identities', async () => {
  const { sim, adapter, token } = await setup()
  try {
    const order = await adapter.create(token, createPayload(expected), 'order-refund')
    const paymentId = String(record((record(order.transactions).payments as unknown[])[0]).id)
    await adapter.refund(token, String(order.id), paymentId, 300, 'refund-1')
    await adapter.refund(token, String(order.id), paymentId, 300, 'refund-1')
    const partial = await evidence(adapter, token, await adapter.order(token, String(order.id)))
    equal(partial.state, 'partially_refunded'); equal(partial.refunds[0].amountCents, 300); equal(sim.state.refunds, 1)
    await adapter.refund(token, String(order.id), paymentId, 700, 'refund-2')
    equal((await evidence(adapter, token, await adapter.order(token, String(order.id)))).state, 'refunded')
    equal(sim.state.refunds, 2)
    const second = await adapter.create(token, createPayload({ ...expected, externalReference: 'total_refund' }), 'second')
    await adapter.refund(token, String(second.id), String(record((record(second.transactions).payments as unknown[])[0]).id), 1000, 'total', true)
    equal(sim.state.refunds, 3)
  } finally { await sim.close() }
})
Deno.test('at-terminal cancellation is a physical action and never sends the cancel API', async () => {
  const { sim, adapter, token } = await setup('at_terminal')
  try {
    const order = await adapter.create(token, createPayload(expected), 'terminal-cancel')
    await rejects(() => adapter.cancel(token, String(order.id), 'cancel'), 'CANCEL_ON_TERMINAL')
    equal(sim.state.calls.filter(c => c.path.endsWith('/cancel')).length, 0)
  } finally { await sim.close() }
})
Deno.test('OAuth rotation uses documented expiry and environment rather than token prefixes', async () => {
  const { sim, adapter, token } = await setup()
  try {
    assert(Date.parse(token.expiresAt) > Date.now() + 3590000)
    const next = await adapter.refresh(token)
    equal(next.refreshToken, 'sim-refresh-2'); equal(sim.state.refreshes, 1)
    await rejects(() => adapter.refresh(token), 'REVOKED')
  } finally { await sim.close() }
})
Deno.test('isolated fixture OAuth account verifies its own terminal and authoritative payment without touching development', async () => {
  const { sim, adapter } = await setup()
  try {
    const before = JSON.stringify(sim.state)
    const token = await adapter.exchange('sim-code-910123456', randomSecret(), 'sandbox')
    await adapter.verifyAccount(token)
    const owned = { ...expected, receiverId: '910123456', terminalId: 'NEWLAND_N950__TST910123456' }
    const order = await adapter.create(token, createPayload(owned), 'owned-order')
    const payment = record((record(order.transactions).payments as unknown[])[0])
    const proof = await adapter.request(token, `/v1/payments/${payment.reference_id}`)
    equal(verifyOrder(order, owned, token, proof).state, 'approved')
    await rejects(() => adapter.order(syntheticToken, String(order.id)), 'DEFINITIVE_FAILURE')
    const rotated = await adapter.refresh(token)
    equal(rotated.receiverId, token.receiverId)
    equal(rotated.refreshToken, 'sim-refresh-910123456-2')
    // The intentional cross-account GET is the only development-account request.
    equal(sim.state.creates, 0); equal(sim.state.refreshes, 0); equal(sim.state.version, 1)
    equal(JSON.stringify({ ...sim.state, calls: sim.state.calls.slice(0, -1) }), before)
  } finally { await sim.close() }
})
Deno.test('independent signature fixture validates canonical query, lowercasing, headers and old retry timestamp', async () => {
  // Fixture generated using Node createHmac independently of this verifier, with an intentionally old timestamp.
  const url = 'https://example.test/point-webhook?data.id=ORD01JQ4S4KY8HWQ6NA5PXB65B3D3&type=order'
  const headers = { 'x-request-id': '2066ca19-c6f1-498a-be75-1923005edd06', 'x-signature': 'ts=1742505638683,v1=4736b46f7c4dabd9fcb0b89f7534bffb461bf573de7e0c36dc94d79a020152b1' }
  const verified = await verifySignature(new Request(url, { headers }), ['independent-fixture-key'])
  equal(verified.remoteOrderId, 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3')
  equal((await verifySignature(new Request(url, { headers }), ['old-key', 'independent-fixture-key'])).eventKey, verified.eventKey)
  await rejects(() => verifySignature(new Request(url.replace('3D3', '3D4'), { headers }), ['independent-fixture-key']))
  await rejects(() => verifySignature(new Request(url, { headers: { ...headers, 'x-request-id': 'tampered' } }), ['independent-fixture-key']))
  await rejects(() => verifySignature(new Request(url + '&data.id=evil', { headers }), ['independent-fixture-key']))
  await rejects(() => verifySignature(new Request(url, { headers: { ...headers, 'x-signature': headers['x-signature'] + ',ts=1' } }), ['independent-fixture-key']))
})
Deno.test('tokens are authenticated encrypted, tenant-bound and readable during key rotation', async () => {
  const firstKey = randomSecret(), secondKey = randomSecret()
  const first = new TokenVault({ a: firstKey }, 'a')
  const encrypted = await first.seal(syntheticToken, 'mercadopago:business-a:sandbox')
  assert(!encrypted.includes(syntheticToken.accessToken)); assert(!encrypted.includes(syntheticToken.refreshToken))
  const rotated = new TokenVault({ a: firstKey, b: secondKey }, 'b')
  equal(await rotated.open(encrypted, 'mercadopago:business-a:sandbox'), syntheticToken)
  await rejects(() => rotated.open(encrypted, 'mercadopago:business-b:sandbox'))
  await rejects(() => rotated.open(encrypted.slice(0, -1) + (encrypted.at(-1) === 'A' ? 'B' : 'A'), 'mercadopago:business-a:sandbox'))
})
Deno.test('worker credential and streamed body limits reject browser requests', async () => {
  const secret = 'synthetic-worker-secret-at-least-32-bytes'
  assert(await workerAuthorized(new Request('https://example.test', { headers: { Authorization: `Bearer ${secret}` } }), secret))
  assert(!await workerAuthorized(new Request('https://example.test', { headers: { Authorization: 'Bearer public-browser-key' } }), secret))
  await rejects(() => boundedBody(new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(8200) }) })))
})
/** Independent non-Mercado-Pago implementation demonstrates the provider contract is swappable. */
class IndependentAdapter implements PointAdapter {
  refreshCount = 0
  exchange(): Promise<TokenSet> { return Promise.resolve(syntheticToken) }
  async refresh(): Promise<TokenSet> { this.refreshCount++; await new Promise(resolve => setTimeout(resolve, 25)); return { ...syntheticToken, refreshToken: 'independent-rotated' } }
  verifyAccount(): Promise<void> { return Promise.resolve() }
  request(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  order(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  create(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  refund(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  cancel(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
}
Deno.test('OAuth service supports a second adapter and strips every backend secret from results', async () => {
  const adapter = new IndependentAdapter(), vault = new TokenVault({ test: randomSecret() }, 'test')
  const config: Configuration = { adapter, vault, clientId: 'independent-client', redirectUri: 'http://127.0.0.1/point/callback', environment: 'sandbox', chargesEnabled: false }
  const states = new Map<string, Record<string, unknown>>()
  const admin: RpcClient = { rpc(_name, args) {
    const payload = args.p_payload as Record<string, unknown>
    if (args.p_action === 'oauth_state_create') { states.set(String(payload.stateHash), payload); return Promise.resolve({ data: { data: {} }, error: null }) }
    if (args.p_action === 'oauth_state_consume') {
      const stored = states.get(String(payload.stateHash))
      if (!stored || stored.businessId !== payload.businessId || stored.userId !== payload.userId) return Promise.resolve({ data: { error: { code: 'POINT_OAUTH_INVALID' } }, error: null })
      states.delete(String(payload.stateHash)); return Promise.resolve({ data: { data: stored }, error: null })
    }
    return Promise.resolve({ data: { data: {} }, error: null })
  } }
  const identity = { userId: 'owner-a', authSessionId: 'session-a' }
  const start = await processPointResult(admin, { command: 'oauth_start' }, { backendDirective: { businessId: 'business-a', kind: 'oauth_start' } }, identity, config) as { authorizationUrl: string }
  const state = new URL(start.authorizationUrl).searchParams.get('state')!
  assert(!start.authorizationUrl.includes('sim-access')); assert(new URL(start.authorizationUrl).searchParams.has('code_challenge'))
  await rejects(() => processPointResult(admin, { command: 'oauth_callback', code: 'code', state }, { backendDirective: { businessId: 'business-b', kind: 'oauth_callback' } }, identity, config), 'POINT_OAUTH_INVALID')
  const result = await processPointResult(admin, { command: 'oauth_callback', code: 'code', state }, { backendDirective: { businessId: 'business-a', kind: 'oauth_callback' } }, identity, config)
  assert(!JSON.stringify(result).includes('accessToken'))
  await rejects(() => processPointResult(admin, { command: 'oauth_callback', code: 'code', state }, { backendDirective: { businessId: 'business-a', kind: 'oauth_callback' } }, identity, config), 'POINT_OAUTH_INVALID')
  equal(await processPointResult(admin, {}, { safe: true, tokensCiphertext: 'secret', backendDirective: undefined }), { safe: true })
})
Deno.test('worker persists remote locator then recovers a failed financial write through GET only', async () => {
  const { sim, adapter, token } = await setup()
  const vault = new TokenVault({ test: randomSecret() }, 'test')
  const config: Configuration = { adapter, vault, clientId: 'sim-client', redirectUri: 'http://127.0.0.1/point/callback', environment: 'sandbox', chargesEnabled: true }
  const connection = { tokenVersion: 1, businessId: 'business', receiverId: token.receiverId, environment: token.environment, tokensCiphertext: await vault.seal(token, 'mercadopago:business:sandbox') }
  const job = { id: 'job', kind: 'create', attemptId: 'attempt', connectionId: 'connection', leaseToken: 'lease', payload: { ...expected, createPayload: createPayload(expected), idempotencyKey: 'durable', remoteOrderId: '' } }
  let fail = true, materialized = 0, completed = false
  const admin: RpcClient = { rpc(_name, args) {
    const p = args.p_payload as Record<string, unknown>
    if (args.p_action === 'connection_get') return Promise.resolve({ data: { data: connection }, error: null })
    if (args.p_action === 'claim_jobs') return Promise.resolve({ data: { data: { jobs: completed ? [] : [job] } }, error: null })
    if (args.p_action === 'record_remote_order') job.payload.remoteOrderId = String(p.remoteOrderId)
    if (args.p_action === 'apply_order') {
      if (fail) { fail = false; return Promise.resolve({ data: null, error: { message: 'simulated persistence failure' } }) }
      assert(p.verified); materialized++
    }
    if (args.p_action === 'complete_job') completed = true
    return Promise.resolve({ data: { data: {} }, error: null })
  } }
  try {
    equal(await runWorker(admin, config), { processed: 0, failed: 1 })
    equal(await runWorker(admin, config), { processed: 1, failed: 0 })
    equal(sim.state.creates, 1); equal(materialized, 1)
    equal(sim.state.calls.filter(c => c.method === 'POST' && c.path === '/v1/orders').length, 1)
  } finally { await sim.close() }
})
Deno.test('refresh contender cannot rotate the same credentials while exclusive SQL lease is held', async () => {
  const adapter = new IndependentAdapter(), vault = new TokenVault({ test: randomSecret() }, 'test')
  const config: Configuration = { adapter, vault, clientId: 'test', redirectUri: 'http://127.0.0.1/point/callback', environment: 'sandbox', chargesEnabled: false }
  const expired = { ...syntheticToken, expiresAt: '2020-01-01T00:00:00Z' }
  const connection = { tokenVersion: 1, businessId: 'business', receiverId: expired.receiverId, environment: expired.environment, tokensCiphertext: await vault.seal(expired, 'mercadopago:business:sandbox') }
  let leased = false
  const admin: RpcClient = { rpc(_name, args) {
    const payload = args.p_payload as Record<string, unknown>
    if (args.p_action === 'connection_get') return Promise.resolve({ data: { data: connection }, error: null })
    if (args.p_action === 'refresh_claim') { const claimed = !leased; leased = true; return Promise.resolve({ data: { data: { claimed, connection } }, error: null }) }
    if (args.p_action === 'refresh_save') { connection.tokensCiphertext = String(payload.tokensCiphertext); connection.tokenVersion++; return Promise.resolve({ data: { data: connection }, error: null }) }
    return Promise.resolve({ data: { data: {} }, error: null })
  } }
  const outcomes = await Promise.allSettled([connectionToken(admin, config, 'connection'), connectionToken(admin, config, 'connection')])
  equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
  equal(outcomes.filter(r => r.status === 'rejected').length, 1)
  equal(adapter.refreshCount, 1)
})
Deno.test('lost refresh response rotates once then requires reconnection rather than replaying old refresh', async () => {
  const { sim, adapter, token } = await setup()
  const vault = new TokenVault({ test: randomSecret() }, 'test')
  const config: Configuration = { adapter, vault, clientId: 'sim-client', redirectUri: 'http://127.0.0.1/point/callback', environment: 'sandbox', chargesEnabled: false }
  const connection = { tokenVersion: 1, businessId: 'business', receiverId: token.receiverId, environment: token.environment, tokensCiphertext: await vault.seal({ ...token, expiresAt: '2020-01-01T00:00:00Z' }, 'mercadopago:business:sandbox') }
  let uncertain = false
  const admin: RpcClient = { rpc(_name, args) {
    const payload = args.p_payload as Record<string, unknown>
    if (args.p_action === 'connection_get') return Promise.resolve({ data: { data: connection }, error: null })
    if (args.p_action === 'refresh_claim') return Promise.resolve({ data: { data: { claimed: true, connection } }, error: null })
    if (args.p_action === 'refresh_release') uncertain = payload.uncertain === true
    return Promise.resolve({ data: { data: {} }, error: null })
  } }
  try {
    sim.state.scenario = 'refresh-timeout'
    await rejects(() => connectionToken(admin, config, 'connection'), 'UNCERTAIN')
    assert(uncertain); equal(sim.state.refreshes, 1); equal(sim.state.version, 2)
  } finally { await sim.close() }
})

Deno.test('provider monetary evidence rejects unallocated tips, short collection and missing refund detail', async () => {
  const { sim, adapter, token } = await setup()
  try {
    const order = await adapter.create(token, createPayload(expected), 'monetary-evidence')
    const proof = await adapter.request(token, `/v1/payments/${record((record(order.transactions).payments as unknown[])[0]).reference_id}`)
    const altered = (field: string, value: string) => {
      const copy = structuredClone(order)
      record((record(copy.transactions).payments as unknown[])[0])[field] = value
      return copy
    }
    await rejects(() => verifyOrder(altered('tip_amount', '2.00'), expected, token, proof), 'INVALID_RESPONSE')
    await rejects(() => verifyOrder(altered('paid_amount', '9.99'), expected, token, proof), 'INVALID_RESPONSE')
    await rejects(() => verifyOrder(altered('refunded_amount', '1.00'), expected, token, proof), 'INVALID_RESPONSE')
    await rejects(() => verifyOrder(order, expected, token, { ...proof, transaction_amount_refunded: 1 }), 'INVALID_RESPONSE')
    // Financing paid by the buyer can exceed merchandise; it is never added to our sale.
    equal(verifyOrder(altered('paid_amount', '11.00'), expected, token, proof).amountCents, 1000)
  } finally { await sim.close() }
})

Deno.test('failed orders with a payment reference release only with consistent nonpayment evidence', async () => {
  const { sim, adapter, token } = await setup()
  try {
    const order = await adapter.create(token, createPayload(expected), 'referenced-rejection')
    const payment = record((record(order.transactions).payments as unknown[])[0])
    const proof = await adapter.request(token, `/v1/payments/${payment.reference_id}`)
    order.status = 'failed'; order.status_detail = 'failed'
    payment.status = 'failed'; payment.status_detail = 'rejected_by_issuer'
    equal(verifyOrder(order, expected, token, { ...proof, status: 'rejected' }).state, 'rejected')
    await rejects(() => verifyOrder(order, expected, token, proof), 'INVALID_RESPONSE')
    order.status = 'at_terminal'; order.status_detail = 'at_terminal'
    payment.status = 'at_terminal'; payment.status_detail = 'at_terminal'
    equal(verifyOrder(order, expected, token, { ...proof, status: 'in_process' }).state, 'sent')
  } finally { await sim.close() }
})

async function refundWorkerFixture() {
  const { sim, adapter, token } = await setup()
  const order = await adapter.create(token, createPayload(expected), 'refund-worker-order')
  const payment = record((record(order.transactions).payments as unknown[])[0])
  const vault = new TokenVault({ test: randomSecret() }, 'test')
  const config: Configuration = { adapter, vault, clientId: 'sim-client', redirectUri: 'http://127.0.0.1/point/callback', environment: 'sandbox', chargesEnabled: true }
  const connection = { tokenVersion: 1, businessId: 'business', receiverId: token.receiverId, environment: token.environment, tokensCiphertext: await vault.seal(token, 'mercadopago:business:sandbox') }
  const refundRequest = { id: 'refund-request', status: 'pending', amountCents: 300, firstSentAt: new Date().toISOString(), remoteRefundId: null as string | null }
  const job = { id: 'refund-job', kind: 'refund', attemptId: 'attempt', connectionId: 'connection', leaseToken: 'refund-lease',
    payload: { ...expected, remoteOrderId: String(order.id), paymentId: String(payment.id), refundAmountCents: 300, idempotencyKey: 'refund-worker-key', refundRequest } }
  const events: string[] = []
  let complete = false, failApply = false
  const admin: RpcClient = { rpc(_name, args) {
    const p = args.p_payload as Record<string, unknown>
    events.push(String(args.p_action))
    if (args.p_action === 'connection_get') return Promise.resolve({ data: { data: connection }, error: null })
    if (args.p_action === 'claim_jobs') return Promise.resolve({ data: { data: { jobs: complete ? [] : [job] } }, error: null })
    if (args.p_action === 'record_remote_refund') {
      equal(p.refundId, refundRequest.id); equal(p.jobId, job.id); equal(p.leaseToken, job.leaseToken)
      refundRequest.remoteRefundId = String(p.remoteRefundId)
    }
    if (args.p_action === 'apply_order' && failApply) { failApply = false; return Promise.resolve({ data: null, error: { message: 'simulated persistence failure' } }) }
    if (args.p_action === 'complete_job') complete = true
    return Promise.resolve({ data: { data: {} }, error: null })
  } }
  return { sim, config, admin, refundRequest, events, failNextApply() { failApply = true } }
}

Deno.test('refund recovery preserves remote identity and never POSTs again after locator persistence', async () => {
  const fixture = await refundWorkerFixture()
  try {
    fixture.failNextApply()
    equal(await runWorker(fixture.admin, fixture.config), { processed: 0, failed: 1 })
    assert(fixture.refundRequest.remoteRefundId)
    assert(fixture.events.indexOf('record_remote_refund') < fixture.events.indexOf('apply_order'))
    equal(await runWorker(fixture.admin, fixture.config), { processed: 1, failed: 0 })
    equal(fixture.sim.state.refunds, 1)
    equal(fixture.sim.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/refund')).length, 1)
  } finally { await fixture.sim.close() }
})

Deno.test('lost refund response recovers the original refund within its own replay window', async () => {
  const fixture = await refundWorkerFixture()
  try {
    fixture.sim.state.scenario = 'refund-timeout'
    equal(await runWorker(fixture.admin, fixture.config), { processed: 0, failed: 1 })
    equal(fixture.refundRequest.remoteRefundId, null)
    fixture.sim.state.scenario = 'approved'
    equal(await runWorker(fixture.admin, fixture.config), { processed: 1, failed: 0 })
    assert(fixture.refundRequest.remoteRefundId)
    equal(fixture.sim.state.refunds, 1)
  } finally { await fixture.sim.close() }
})

Deno.test('expired refund replay window queries evidence and never sends another refund POST', async () => {
  const fixture = await refundWorkerFixture()
  try {
    fixture.sim.state.scenario = 'refund-timeout'
    equal(await runWorker(fixture.admin, fixture.config), { processed: 0, failed: 1 })
    fixture.refundRequest.firstSentAt = new Date(Date.now() - 24 * 3600000).toISOString()
    fixture.sim.state.refundKeys.clear() // Provider guarantee has expired across a worker outage.
    fixture.sim.state.scenario = 'approved'
    equal(await runWorker(fixture.admin, fixture.config), { processed: 0, failed: 1 })
    equal(fixture.sim.state.refunds, 1)
    equal(fixture.sim.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/refund')).length, 1)
    assert(fixture.sim.state.calls.filter(c => c.method === 'GET' && c.path.startsWith('/v1/orders/')).length >= 2)
  } finally { await fixture.sim.close() }
})

Deno.test('a local provider override cannot receive production OAuth credentials', async () => {
  const settings: Record<string, string> = { MP_CLIENT_ID: 'sim-client', MP_CLIENT_SECRET: 'sim-secret', MP_REDIRECT_URI: 'http://127.0.0.1/point/callback',
    MP_ENVIRONMENT: 'sandbox', MP_TOKEN_KEYS: JSON.stringify({ test: randomSecret() }), MP_TOKEN_ACTIVE_KEY: 'test',
    SUPABASE_URL: 'http://127.0.0.1:54321', MP_ALLOW_LOCAL_SIMULATOR: 'true', MP_API_BASE_URL: 'http://127.0.0.1:8187' }
  equal(configuration(name => settings[name]).environment, 'sandbox')
  settings.MP_ENVIRONMENT = 'live'
  await rejects(() => configuration(name => settings[name]), 'POINT_CONFIGURATION_REQUIRED')
})

Deno.test('cancel worker reconciles a terminal race and a cancellation whose response was lost', async () => {
  for (const scenario of ['at_terminal', 'pending']) {
    const { sim, adapter, token } = await setup(scenario)
    try {
      const order = await adapter.create(token, createPayload(expected), `cancel-${scenario}`)
      if (scenario === 'pending') await adapter.cancel(token, String(order.id), 'cancel-lost-response')
      const vault = new TokenVault({ test: randomSecret() }, 'test')
      const config: Configuration = { adapter, vault, clientId: 'test', redirectUri: 'http://127.0.0.1/point/callback', environment: 'sandbox', chargesEnabled: true }
      const connection = { tokenVersion: 1, businessId: 'business', receiverId: token.receiverId, environment: token.environment, tokensCiphertext: await vault.seal(token, 'mercadopago:business:sandbox') }
      const job = { id: 'cancel-job', kind: 'cancel', attemptId: 'attempt', connectionId: 'connection', leaseToken: 'cancel-lease',
        payload: { ...expected, remoteOrderId: order.id, idempotencyKey: 'cancel-lost-response' } }
      let complete = false, applied: Record<string, unknown> = {}
      const admin: RpcClient = { rpc(_name, args) {
        if (args.p_action === 'connection_get') return Promise.resolve({ data: { data: connection }, error: null })
        if (args.p_action === 'claim_jobs') return Promise.resolve({ data: { data: { jobs: complete ? [] : [job] } }, error: null })
        if (args.p_action === 'apply_order') applied = args.p_payload as Record<string, unknown>
        if (args.p_action === 'complete_job') complete = true
        return Promise.resolve({ data: { data: {} }, error: null })
      } }
      equal(await runWorker(admin, config), { processed: 1, failed: 0 })
      equal(applied.state, scenario === 'at_terminal' ? 'sent_to_terminal' : 'cancelled')
      equal(applied.cancelCapability, scenario === 'at_terminal' ? 'terminal' : 'unavailable')
      equal(sim.state.calls.filter(c => c.method === 'POST' && c.path.endsWith('/cancel')).length, scenario === 'at_terminal' ? 0 : 1)
    } finally { await sim.close() }
  }
})

Deno.test('a delayed old-token 401 cannot revoke a newly reconnected credential generation', async () => {
  for (const entrypoint of ['owner', 'worker']) {
    const vault = new TokenVault({ test: randomSecret() }, 'test')
    const connection = { tokenVersion: 1, status: 'connected', businessId: 'business', receiverId: syntheticToken.receiverId,
      environment: syntheticToken.environment, tokensCiphertext: await vault.seal(syntheticToken, 'mercadopago:business:sandbox') }
    class ReconnectedAdapter extends IndependentAdapter {
      override verifyAccount(): Promise<void> {
        connection.tokenVersion = 2 // The owner reconnects while this HTTP request is in flight.
        return Promise.reject(new ProviderError('REVOKED', 401))
      }
    }
    const config: Configuration = { adapter: new ReconnectedAdapter(), vault, clientId: 'test', redirectUri: 'http://127.0.0.1/point/callback', environment: 'sandbox', chargesEnabled: true }
    let observedVersion: unknown
    const admin: RpcClient = { rpc(_name, args) {
      const p = args.p_payload as Record<string, unknown>
      if (args.p_action === 'connection_get') return Promise.resolve({ data: { data: connection }, error: null })
      if (args.p_action === 'connection_revoke') {
        observedVersion = p.expectedTokenVersion
        if (observedVersion === connection.tokenVersion) connection.status = 'revoked'
      }
      if (args.p_action === 'claim_jobs') return Promise.resolve({ data: { data: { jobs: [{ id: 'job', kind: 'reconcile', attemptId: 'attempt', connectionId: 'connection', leaseToken: 'lease', payload: expected }] } }, error: null })
      return Promise.resolve({ data: { data: {} }, error: null })
    } }
    if (entrypoint === 'owner') await rejects(() => processPointResult(admin, { command: 'verify_connection' },
      { backendDirective: { kind: 'verify_connection', businessId: 'business', connectionId: 'connection' } }, undefined, config), 'REVOKED')
    else equal(await runWorker(admin, config), { processed: 0, failed: 1 })
    equal(observedVersion, 1)
    equal(connection.status, 'connected')
  }
})

Deno.test('OAuth invalid_grant HTTP 400 requires reconnection without retrying a revoked refresh token', async () => {
  const vault = new TokenVault({ test: randomSecret() }, 'test')
  const expired = { ...syntheticToken, expiresAt: '2020-01-01T00:00:00Z' }
  const connection = { tokenVersion: 1, status: 'connected', businessId: 'business', receiverId: expired.receiverId,
    environment: expired.environment, tokensCiphertext: await vault.seal(expired, 'mercadopago:business:sandbox') }
  let calls = 0
  const adapter = new MercadoPagoPoint({ clientId: 'sim-client', clientSecret: 'sim-secret', redirectUri: 'http://127.0.0.1/point/callback',
    fetch: () => { calls++; return Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant', message: 'not exposed' }), { status: 400 })) } })
  const config: Configuration = { adapter, vault, clientId: 'test', redirectUri: 'http://127.0.0.1/point/callback', environment: 'sandbox', chargesEnabled: false }
  const admin: RpcClient = { rpc(_name, args) {
    if (args.p_action === 'connection_get') return Promise.resolve({ data: { data: connection }, error: null })
    if (args.p_action === 'refresh_claim') return Promise.resolve({ data: { data: { claimed: connection.status === 'connected', connection } }, error: null })
    if (args.p_action === 'refresh_release' && (args.p_payload as Record<string, unknown>).uncertain) connection.status = 'reconnect_required'
    return Promise.resolve({ data: { data: {} }, error: null })
  } }
  await rejects(() => connectionToken(admin, config, 'connection'), 'REVOKED')
  equal(connection.status, 'reconnect_required')
  await rejects(() => connectionToken(admin, config, 'connection'), 'POINT_REFRESH_BUSY')
  equal(calls, 1)
  // A payment validation error remains a payment error, even if its body has this text.
  await rejects(() => adapter.create(syntheticToken, createPayload(expected), 'unrelated-create'), 'DEFINITIVE_FAILURE')
})
