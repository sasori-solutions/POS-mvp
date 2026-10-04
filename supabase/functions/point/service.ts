import { challenge, digest, randomSecret, TokenVault } from './crypto.ts'
import { identifier, MercadoPagoPoint, ProviderError, record, verifyOrder } from './provider.ts'
import type { Environment, ExpectedOrder, PointAdapter, TokenSet } from './provider.ts'
export interface RpcClient { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
export interface Configuration { adapter: PointAdapter; vault: TokenVault; clientId: string; redirectUri: string; environment: Environment; chargesEnabled: boolean }
export class PointServiceError extends Error { constructor(readonly code: string) { super(code) } }
export async function serviceRpc(admin: RpcClient, action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await admin.rpc('point_service', { p_action: action, p_payload: payload })
  if (response.error) {
    const message = typeof response.error === 'object' ? (response.error as { message?: unknown }).message : undefined
    const safe = ['POINT_OAUTH_INVALID', 'POINT_FACT_MISMATCH', 'POINT_LEASE_LOST', 'POINT_CONNECTION_REQUIRED', 'POINT_STATE_INVALID', 'POINT_CHECKOUT_NOT_FOUND', 'POINT_REFUND_LIMIT', 'VALIDATION_ERROR', 'AUTH_REQUIRED', 'PERMISSION_DENIED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'BUSINESS_ACCESS_DENIED']
    throw new PointServiceError(typeof message === 'string' && safe.includes(message) ? message : 'POINT_SERVICE_UNAVAILABLE')
  }
  const envelope = record(response.data)
  if (envelope.error) throw new PointServiceError(String(record(envelope.error).code ?? 'POINT_SERVICE_UNAVAILABLE'))
  return record(envelope.data ?? envelope)
}
export function configuration(env = (name: string) => Deno.env.get(name)): Configuration {
  const clientId = env('MP_CLIENT_ID'), clientSecret = env('MP_CLIENT_SECRET'), redirectUri = env('MP_REDIRECT_URI')
  const environment = env('MP_ENVIRONMENT')
  if (!clientId || !clientSecret || !redirectUri || !['sandbox', 'live'].includes(environment ?? '')) throw new PointServiceError('POINT_CONFIGURATION_REQUIRED')
  const url = new URL(redirectUri)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new PointServiceError('POINT_CONFIGURATION_REQUIRED')
  const keys = JSON.parse(env('MP_TOKEN_KEYS') ?? '{}')
  const baseUrl = env('MP_API_BASE_URL')
  // A simulator override needs both flags and a loopback Supabase. This can never redirect a production credential.
  const supabaseHost = new URL(env('SUPABASE_URL') ?? 'https://invalid').hostname
  const simulator = env('MP_ALLOW_LOCAL_SIMULATOR') === 'true' && ['127.0.0.1', 'localhost', '[::1]', 'kong', 'host.docker.internal'].includes(supabaseHost)
  return { adapter: new MercadoPagoPoint({ clientId, clientSecret, redirectUri, baseUrl, allowLocalSimulator: simulator }),
    vault: new TokenVault(keys, env('MP_TOKEN_ACTIVE_KEY') ?? ''), clientId, redirectUri, environment: environment as Environment,
    chargesEnabled: env('POINT_CHARGES_ENABLED') === 'true' }
}
function binding(connection: Record<string, unknown>): string { return `mercadopago:${connection.businessId}:${connection.environment}` }
export async function connectionToken(admin: RpcClient, config: Configuration, connectionId: string): Promise<TokenSet> {
  let connection = await serviceRpc(admin, 'connection_get', { connectionId })
  let token = await config.vault.open<TokenSet>(String(connection.tokensCiphertext), binding(connection))
  if (token.receiverId !== connection.receiverId || token.environment !== connection.environment) throw new PointServiceError('POINT_FACT_MISMATCH')
  if (Date.parse(token.expiresAt) > Date.now() + 60000) return token
  const leaseToken = crypto.randomUUID()
  const claim = await serviceRpc(admin, 'refresh_claim', { connectionId, leaseToken })
  if (!claim.claimed) throw new PointServiceError('POINT_REFRESH_BUSY')
  connection = record(claim.connection ?? connection)
  token = await config.vault.open<TokenSet>(String(connection.tokensCiphertext), binding(connection))
  if (Date.parse(token.expiresAt) > Date.now() + 60000) {
    await serviceRpc(admin, 'refresh_release', { connectionId, leaseToken, uncertain: false })
    return token
  }
  try {
    const renewed = await config.adapter.refresh(token)
    const tokensCiphertext = await config.vault.seal(renewed, binding(connection))
    await serviceRpc(admin, 'refresh_save', { connectionId, leaseToken, tokensCiphertext, expiresAt: renewed.expiresAt })
    return renewed
  } catch (error) {
    // A lost refresh response may have rotated the refresh credential. Never race/replay the old one.
    await serviceRpc(admin, 'refresh_release', { connectionId, leaseToken, uncertain: !(error instanceof ProviderError && error.code === 'DEFINITIVE_FAILURE') })
    throw error
  }
}
function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|ciphertext|verifier|backendDirective|lease/i.test(key)).map(([key, item]) => [key, redacted(item)]))
}
async function terminals(config: Configuration, token: TokenSet, storeId?: string, posId?: string): Promise<Record<string, unknown>[]> {
  const path = `/terminals/v1/list?limit=50&offset=0${storeId ? `&store_id=${identifier(storeId)}` : ''}${posId ? `&pos_id=${identifier(posId)}` : ''}`
  const result = await config.adapter.request(token, path)
  const list = record(result.data).terminals
  if (!Array.isArray(list)) throw new ProviderError('INVALID_RESPONSE')
  return list.map(item => { const t = record(item); return { id: identifier(t.id), serial: identifier(t.id).split('__').at(-1), branchId: identifier(t.store_id), registerId: identifier(t.pos_id), mode: String(t.operating_mode), verified: false, active: false, physicalStepsPending: true } })
}
/** Called only AFTER SQL authorized the exact account/device command. Directives never cross the browser boundary. */
export async function processPointResult(admin: RpcClient, request: Record<string, unknown>, result: unknown,
  identity?: { userId: string; authSessionId: string }, supplied?: Configuration): Promise<unknown> {
  const data = record(result)
  if (!data.backendDirective) return redacted(data)
  const directive = record(data.backendDirective), config = supplied ?? configuration()
  const command = String(directive.kind ?? request.command)
  const businessId = identifier(directive.businessId ?? request.businessId)
  if (command === 'oauth_start' || command === 'oauth_callback') {
    if (!identity?.userId || !identity.authSessionId) throw new PointServiceError('PERMISSION_DENIED')
    if (request.environment !== undefined && request.environment !== config.environment) throw new PointServiceError('POINT_OAUTH_INVALID')
    if (command === 'oauth_start') {
      const state = randomSecret(), verifier = randomSecret(), stateHash = await digest(state)
      const expiresAt = new Date(Date.now() + 600000).toISOString()
      const verifierCiphertext = await config.vault.seal({ verifier }, `oauth:${businessId}:${identity.userId}:${stateHash}`)
      await serviceRpc(admin, 'oauth_state_create', { businessId, ...identity, stateHash, verifierCiphertext, environment: config.environment, redirectUri: config.redirectUri, expiresAt })
      const url = new URL('https://auth.mercadopago.com/authorization')
      for (const [key, value] of Object.entries({ client_id: config.clientId, response_type: 'code', platform_id: 'mp', redirect_uri: config.redirectUri, state,
        code_challenge: await challenge(verifier), code_challenge_method: 'S256' })) url.searchParams.set(key, value)
      return { authorizationUrl: url.toString(), expiresAt }
    }
    if (typeof request.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(request.state)) throw new PointServiceError('POINT_OAUTH_INVALID')
    const stateHash = await digest(request.state)
    const saved = await serviceRpc(admin, 'oauth_state_consume', { businessId, ...identity, stateHash, redirectUri: config.redirectUri })
    if (saved.environment !== config.environment) throw new PointServiceError('POINT_OAUTH_INVALID')
    // Rejection consumes the state too. The owner may begin another fresh authorization.
    if (request.error) return { connected: false, rejected: true }
    if (typeof request.code !== 'string' || !request.code || request.code.length > 2048) throw new PointServiceError('POINT_OAUTH_INVALID')
    const { verifier } = await config.vault.open<{ verifier: string }>(String(saved.verifierCiphertext), `oauth:${businessId}:${identity.userId}:${stateHash}`)
    const token = await config.adapter.exchange(request.code, verifier, config.environment)
    const tokensCiphertext = await config.vault.seal(token, `mercadopago:${businessId}:${config.environment}`)
    await serviceRpc(admin, 'connection_save', { businessId, environment: token.environment, receiverId: token.receiverId, tokensCiphertext, expiresAt: token.expiresAt })
    return { connected: true, environment: token.environment, receiverId: token.receiverId, terminalReady: false }
  }
  const connectionId = identifier(directive.connectionId)
  try {
    const token = await connectionToken(admin, config, connectionId)
    await config.adapter.verifyAccount(token)
    if (command === 'verify_connection') {
      await serviceRpc(admin, 'connection_verified', { connectionId })
      return redacted({ ...data, verified: true, terminalReady: false })
    }
    if (command === 'resources') {
      const stores = await config.adapter.request(token, `/users/${identifier(token.receiverId)}/stores/search?limit=50&offset=0`)
      const points = await config.adapter.request(token, '/pos?limit=50&offset=0')
      const branches = Array.isArray(stores.results) ? stores.results.map(item => { const s = record(item); return { id: identifier(s.id), name: String(s.name ?? '') } }) : []
      const registers = Array.isArray(points.results) ? points.results.map(item => { const p = record(item); if (p.user_id !== undefined && identifier(p.user_id) !== token.receiverId) throw new ProviderError('INVALID_RESPONSE'); return { id: identifier(p.id), branchId: identifier(p.store_id), name: String(p.name ?? '') } }) : []
      return { branches, registers, terminals: await terminals(config, token) }
    }
    if (command === 'create_branch') {
      const raw = await config.adapter.request(token, `/users/${identifier(token.receiverId)}/stores`, 'POST',
        { name: request.name, external_id: `sasori_${identifier(request.operationId)}`, location: request.location })
      return { id: identifier(raw.id), name: String(raw.name ?? '') }
    }
    if (command === 'create_register') {
      const branches = await config.adapter.request(token, `/users/${identifier(token.receiverId)}/stores/search?limit=50&offset=0`)
      if (!Array.isArray(branches.results) || !branches.results.some(item => identifier(record(item).id) === request.branchId)) throw new PointServiceError('POINT_FACT_MISMATCH')
      const raw = await config.adapter.request(token, '/pos', 'POST', { name: request.name, store_id: identifier(request.branchId), external_id: `sasori_${identifier(request.operationId)}`, fixed_amount: false })
      return { id: identifier(raw.id), branchId: identifier(raw.store_id), name: String(raw.name ?? '') }
    }
    if (command === 'link_terminal' || command === 'test_terminal') {
      const serial = String(request.serial ?? directive.serial ?? '')
      const branchId = String(request.branchId ?? directive.branchId ?? ''), registerId = String(request.registerId ?? directive.registerId ?? '')
      const list = await terminals(config, token, branchId || undefined, registerId || undefined)
      const selected = list.find(t => command === 'link_terminal' ? t.serial === serial : t.id === (request.terminalId ?? directive.terminalId))
      if (!selected || selected.branchId !== branchId || selected.registerId !== registerId) throw new PointServiceError('POINT_TERMINAL_NOT_READY')
      if (command === 'link_terminal' && selected.mode !== 'PDV') {
        await config.adapter.request(token, '/terminals/v1/setup', 'PATCH', { terminals: [{ id: selected.id, operating_mode: 'PDV' }] })
        await serviceRpc(admin, 'terminal_save', { connectionId, terminalId: selected.id, serial: selected.serial, storeId: selected.branchId, posId: selected.registerId,
          mode: 'PDV', verified: false, physicallyConfirmed: false })
        // Reader restart and physical association still required; never claim online presence.
        return { terminal: selected, physicalStepsPending: true, instruction: 'Reinicia la terminal y confirma Punto de venta en Más opciones > Configuración > Modo de vinculación.' }
      }
      if (selected.mode !== 'PDV') throw new PointServiceError('POINT_TERMINAL_NOT_READY')
      await serviceRpc(admin, 'terminal_save', { connectionId, terminalId: selected.id, serial: selected.serial, storeId: selected.branchId, posId: selected.registerId, mode: selected.mode,
        verified: true, physicallyConfirmed: command === 'test_terminal' })
      return redacted({ ...data, terminal: { ...selected, verified: true, physicalStepsPending: command !== 'test_terminal' }, configurationVerified: true, onlinePresence: null })
    }
    throw new PointServiceError('VALIDATION_ERROR')
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'REVOKED') await serviceRpc(admin, 'connection_revoke', { connectionId })
    throw error
  }
}
interface Job { id: string; kind: string; attemptId: string; connectionId: string; leaseToken: string; payload: Record<string, unknown> }
export async function runWorker(admin: RpcClient, supplied?: Configuration): Promise<{ processed: number; failed: number }> {
  const config = supplied ?? configuration()
  await serviceRpc(admin, 'pending_sweep', { limit: 100 })
  let processed = 0, failed = 0
  // Acquire each lease immediately before work, so preceding slow HTTP calls cannot age waiting leases.
  for (let iteration = 0; iteration < 4; iteration++) {
    const claimed = await serviceRpc(admin, 'claim_jobs', { limit: 1, leaseToken: crypto.randomUUID(), chargesEnabled: config.chargesEnabled })
    const jobs = Array.isArray(claimed.jobs) ? claimed.jobs as unknown as Job[] : []
    if (jobs.length === 0) break
    const job = jobs[0]
    try {
      const token = await connectionToken(admin, config, job.connectionId)
      const expected = job.payload as unknown as ExpectedOrder
      await config.adapter.verifyAccount(token)
      let remoteOrderId = typeof job.payload.remoteOrderId === 'string' ? job.payload.remoteOrderId : ''
      if (job.kind === 'create' && !remoteOrderId) {
        // An uncertain response NEVER permits another identity or an out-of-window create replay.
        if (!config.chargesEnabled && !job.payload.firstSentAt) throw new PointServiceError('POINT_DISABLED')
        const firstSent = job.payload.firstSentAt
        if (firstSent && Date.now() - Date.parse(String(firstSent)) >= 23 * 3600000) throw new PointServiceError('POINT_IDEMPOTENCY_WINDOW_EXPIRED')
        const created = await config.adapter.create(token, record(job.payload.createPayload), identifier(job.payload.idempotencyKey))
        remoteOrderId = identifier(created.id)
        await serviceRpc(admin, 'record_remote_order', { attemptId: job.attemptId, remoteOrderId, leaseToken: job.leaseToken, jobId: job.id })
      } else if (job.kind === 'refund') {
        if (!remoteOrderId) throw new PointServiceError('POINT_RESULT_UNCERTAIN')
        await config.adapter.refund(token, remoteOrderId, identifier(job.payload.paymentId), Number(job.payload.refundAmountCents), identifier(job.payload.idempotencyKey), Number(job.payload.refundAmountCents) === expected.amountCents)
      } else if (job.kind === 'cancel') {
        if (!remoteOrderId) throw new PointServiceError('POINT_RESULT_UNCERTAIN')
        await config.adapter.cancel(token, remoteOrderId, identifier(job.payload.idempotencyKey))
      }
      if (!remoteOrderId) throw new PointServiceError('POINT_RESULT_UNCERTAIN')
      const order = await config.adapter.order(token, remoteOrderId)
      const payments = record(order.transactions).payments
      const payment = Array.isArray(payments) && payments.length === 1 ? record(payments[0]) : null
      const reference = payment?.reference_id ?? (payment?.reference ? record(payment.reference).id : undefined)
      // Some documented Orders responses omit currency/live_mode. Obtain payment evidence from its documented numeric reference.
      // Pending orders have no payment reference yet: they remain unverified; country/token context is enough to persist their locator.
      if (!['processed', 'refunded'].includes(String(order.status)) && !order.currency && !order.currency_id) order.currency = order.country_code === 'MEX' ? 'MXN' : undefined
      const proof = reference !== undefined ? await config.adapter.request(token, `/v1/payments/${identifier(reference)}`) : undefined
      const evidence = verifyOrder(order, expected, token, proof)
      const states: Record<string, string> = { approved: 'approved_verified', sent: 'sent_to_terminal', canceled: 'cancelled', review: 'unknown_review' }
      await serviceRpc(admin, 'apply_order', { attemptId: job.attemptId, ...evidence, state: states[evidence.state] ?? evidence.state,
        cancelCapability: evidence.state === 'pending' ? 'backend' : ['sent', 'processing', 'review'].includes(evidence.state) ? 'terminal' : 'unavailable', jobId: job.id, leaseToken: job.leaseToken })
      await serviceRpc(admin, 'complete_job', { id: job.id, leaseToken: job.leaseToken })
      processed++
    } catch (error) {
      const code = error instanceof ProviderError || error instanceof PointServiceError ? error.code : 'POINT_SERVICE_UNAVAILABLE'
      if (code === 'REVOKED') await serviceRpc(admin, 'connection_revoke', { connectionId: job.connectionId })
      await serviceRpc(admin, 'fail_job', { id: job.id, leaseToken: job.leaseToken, code,
        uncertain: ['UNCERTAIN', 'INVALID_RESPONSE', 'POINT_RESULT_UNCERTAIN', 'POINT_IDEMPOTENCY_WINDOW_EXPIRED'].includes(code), delaySeconds: 15 + crypto.getRandomValues(new Uint8Array(1))[0] % 16 })
      failed++
      // A failing queue head waits for SQL backoff. End here rather than hammering one attempt or connection.
      break
    }
  }
  return { processed, failed }
}
