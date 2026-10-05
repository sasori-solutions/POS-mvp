import { challenge, digest, randomSecret, TokenVault } from './crypto.ts'
import { cents, identifier, MercadoPagoPoint, officialVirtualOrder, ProviderError, record, validateCreatePayload, verifyOrder } from './provider.ts'
import type { Environment, ExpectedOrder, PointAdapter, TokenSet } from './provider.ts'
export interface RpcClient { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
export interface Configuration { adapter: PointAdapter; vault: TokenVault; clientId: string; redirectUri: string; environment: Environment; chargesEnabled: boolean; authorizationUrl?: string; testAccessToken?: string; localSimulator?: boolean; oauthAvailable?: boolean }
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
  const testAccessToken = env('MP_TEST_ACCESS_TOKEN')
  if ((!clientId || !clientSecret) && !testAccessToken || !redirectUri || !['sandbox', 'live'].includes(environment ?? '')) throw new PointServiceError('POINT_CONFIGURATION_REQUIRED')
  const url = new URL(redirectUri)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new PointServiceError('POINT_CONFIGURATION_REQUIRED')
  const keys = JSON.parse(env('MP_TOKEN_KEYS') ?? '{}')
  const baseUrl = env('MP_API_BASE_URL')
  // A simulator override needs both flags and a loopback Supabase. This can never redirect a production credential.
  const supabaseHost = new URL(env('SUPABASE_URL') ?? 'https://invalid').hostname
  const simulator = env('MP_ALLOW_LOCAL_SIMULATOR') === 'true' && ['127.0.0.1', 'localhost', '[::1]', 'kong', 'host.docker.internal'].includes(supabaseHost)
  if (baseUrl && baseUrl !== 'https://api.mercadopago.com' && (!simulator || environment !== 'sandbox')) throw new PointServiceError('POINT_CONFIGURATION_REQUIRED')
  const authorizationUrl = env('MP_OAUTH_AUTHORIZATION_URL')
  if (authorizationUrl) {
    const authorization = new URL(authorizationUrl)
    if (!simulator || environment !== 'sandbox' || authorization.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(authorization.hostname)
      || authorization.username || authorization.password || authorization.search || authorization.hash || authorization.pathname !== '/authorization') throw new PointServiceError('POINT_CONFIGURATION_REQUIRED')
  }
  return { adapter: new MercadoPagoPoint({ clientId: clientId ?? '', clientSecret: clientSecret ?? '', redirectUri, baseUrl, allowLocalSimulator: simulator }),
    vault: new TokenVault(keys, env('MP_TOKEN_ACTIVE_KEY') ?? ''), clientId: clientId ?? '', redirectUri, environment: environment as Environment,
    chargesEnabled: env('POINT_CHARGES_ENABLED') === 'true', authorizationUrl, testAccessToken, localSimulator: simulator, oauthAvailable: Boolean(clientId && clientSecret) }
}
function binding(connection: Record<string, unknown>): string { return `mercadopago:${connection.businessId}:${connection.environment}` }
type ConnectionToken = TokenSet & { connectionVersion: number }
function versionedToken(token: TokenSet, connection: Record<string, unknown>): ConnectionToken {
  if (!Number.isSafeInteger(connection.tokenVersion) || Number(connection.tokenVersion) < 1) throw new PointServiceError('POINT_SERVICE_UNAVAILABLE')
  return { ...token, connectionVersion: Number(connection.tokenVersion) }
}
export async function connectionToken(admin: RpcClient, config: Configuration, connectionId: string): Promise<ConnectionToken> {
  let connection = await serviceRpc(admin, 'connection_get', { connectionId })
  let token = await config.vault.open<TokenSet>(String(connection.tokensCiphertext), binding(connection))
  if (token.receiverId !== connection.receiverId || token.environment !== connection.environment) throw new PointServiceError('POINT_FACT_MISMATCH')
  if (token.source === 'server_test') {
    if (config.localSimulator || token.environment !== 'sandbox' || !config.testAccessToken || token.accessToken !== config.testAccessToken) throw new PointServiceError('POINT_CONFIGURATION_REQUIRED')
    return versionedToken(token, connection)
  }
  if (Date.parse(token.expiresAt) > Date.now() + 60000) return versionedToken(token, connection)
  const leaseToken = crypto.randomUUID()
  const claim = await serviceRpc(admin, 'refresh_claim', { connectionId, leaseToken })
  if (!claim.claimed) throw new PointServiceError('POINT_REFRESH_BUSY')
  connection = record(claim.connection ?? connection)
  token = await config.vault.open<TokenSet>(String(connection.tokensCiphertext), binding(connection))
  if (Date.parse(token.expiresAt) > Date.now() + 60000) {
    await serviceRpc(admin, 'refresh_release', { connectionId, leaseToken, uncertain: false })
    return versionedToken(token, connection)
  }
  try {
    const renewed = await config.adapter.refresh(token)
    const tokensCiphertext = await config.vault.seal(renewed, binding(connection))
    const saved = await serviceRpc(admin, 'refresh_save', { connectionId, leaseToken, tokensCiphertext, expiresAt: renewed.expiresAt })
    return versionedToken(renewed, saved)
  } catch (error) {
    // A lost refresh response may have rotated the refresh credential. Never race/replay the old one.
    await serviceRpc(admin, 'refresh_release', { connectionId, leaseToken, uncertain: !(error instanceof ProviderError && error.code === 'DEFINITIVE_FAILURE') })
    throw error
  }
}
function redacted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redacted)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|ciphertext|verifier|backendDirective|backendWork|lease/i.test(key)).map(([key, item]) => [key, redacted(item)]))
}
type ResourceBudget = { remaining: number; deadline?: number }
async function resourcePages(config: Configuration, token: TokenSet, path: string, select: (page: Record<string, unknown>) => unknown,
  limit: number, budget: ResourceBudget = { remaining: 40 }): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [], seen = new Set<string>()
  budget.deadline ??= Date.now() + 15000
  let offset = 0, knownTotal: number | undefined
  while (true) {
    const remainingMs = budget.deadline - Date.now()
    if (--budget.remaining < 0 || remainingMs <= 0) throw new PointServiceError('POINT_SERVICE_UNAVAILABLE')
    let timer: ReturnType<typeof setTimeout> | undefined
    let page: Record<string, unknown>
    try {
      page = await Promise.race([config.adapter.request(token, `${path}${path.includes('?') ? '&' : '?'}limit=${limit}&offset=${offset}`),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PointServiceError('POINT_SERVICE_UNAVAILABLE')), remainingMs) })])
    } finally { clearTimeout(timer) }
    if (Date.now() >= budget.deadline) throw new PointServiceError('POINT_SERVICE_UNAVAILABLE')
    const items = select(page)
    if (!Array.isArray(items) || items.length > limit) throw new ProviderError('INVALID_RESPONSE')
    const paging = page.paging === undefined ? null : record(page.paging)
    if (paging) {
      if (!Number.isSafeInteger(paging.total) || Number(paging.total) < offset + items.length
        || paging.offset !== undefined && paging.offset !== offset
        || paging.limit !== undefined && (!Number.isSafeInteger(paging.limit) || Number(paging.limit) < 1 || Number(paging.limit) > limit)) throw new ProviderError('INVALID_RESPONSE')
      if (Number(paging.total) > 500) throw new PointServiceError('POINT_SERVICE_UNAVAILABLE')
      if (knownTotal !== undefined && paging.total !== knownTotal) throw new ProviderError('INVALID_RESPONSE')
      knownTotal = Number(paging.total)
    }
    for (const item of items) {
      const row = record(item), id = identifier(row.id)
      if (seen.has(id)) throw new ProviderError('INVALID_RESPONSE')
      seen.add(id); result.push(row)
    }
    offset += items.length
    if (result.length > 500) throw new PointServiceError('POINT_SERVICE_UNAVAILABLE')
    if (knownTotal !== undefined ? offset === knownTotal : items.length < limit) return result
    if (!items.length) throw new ProviderError('INVALID_RESPONSE')
  }
}
async function terminals(config: Configuration, token: TokenSet, storeId?: string, posId?: string, budget?: ResourceBudget): Promise<Record<string, unknown>[]> {
  const filters = `${storeId ? `store_id=${identifier(storeId)}` : ''}${posId ? `${storeId ? '&' : ''}pos_id=${identifier(posId)}` : ''}`
  const path = `/terminals/v1/list${filters ? `?${filters}` : ''}`
  const list = await resourcePages(config, token, path, page => record(page.data).terminals, 50, budget)
  return list.map(t => ({ id: identifier(t.id), serial: identifier(t.id).split('__').at(-1), branchId: identifier(t.store_id), registerId: identifier(t.pos_id), mode: String(t.operating_mode), verified: false, active: false, physicalStepsPending: true }))
}
/** Called only AFTER SQL authorized the exact account/device command. Directives never cross the browser boundary. */
export async function processPointResult(admin: RpcClient, request: Record<string, unknown>, result: unknown,
  identity?: { userId: string; authSessionId: string }, supplied?: Configuration, onWork?: (scope: WorkerScope) => void): Promise<unknown> {
  const data = record(result)
  const notifyWork = () => {
    if (!onWork) return
    // Dispatch is an optimization of an already durable job. Failure to schedule
    // background work must not turn an accepted command into a failed payment.
    try {
      const work = record(data.backendWork ?? {})
      if (typeof work.businessId !== 'string' || typeof work.attemptId !== 'string'
        || request.action !== 'device_point' && work.businessId !== request.businessId) return
      onWork({ businessId: identifier(work.businessId), attemptId: identifier(work.attemptId) })
    } catch { /* Periodic recovery keeps ownership of the persisted queue. */ }
  }
  if (!data.backendDirective) {
    if (request.command === 'settings') {
      let available = false, chargesEnabled = false, availableEnvironment: Environment | null = null
      let official = supplied ? !supplied.localSimulator : Deno.env.get('MP_ALLOW_LOCAL_SIMULATOR') !== 'true'
      try { const configured = supplied ?? configuration(); official = !configured.localSimulator; chargesEnabled = configured.chargesEnabled; available = Boolean(configured.testAccessToken && official); availableEnvironment = configured.oauthAvailable ? configured.environment : null } catch { /* Feature remains visible but disabled without server credentials. */ }
      return redacted({ ...data, chargesEnabled, availableEnvironment, sandbox: { available, official, testBusiness: record(data.sandbox ?? {}).testBusiness === true } })
    }
    notifyWork()
    return redacted(data)
  }
  const directive = record(data.backendDirective), config = supplied ?? configuration()
  const command = String(directive.kind ?? request.command)
  const businessId = identifier(directive.businessId ?? request.businessId)
  if (command === 'connect_sandbox') {
    if (!identity?.userId || !identity.authSessionId || config.localSimulator || !config.testAccessToken) throw new PointServiceError('POINT_CONFIGURATION_REQUIRED')
    const provisional: TokenSet = { accessToken: config.testAccessToken, refreshToken: '', expiresAt: '2099-01-01T00:00:00Z', receiverId: '', environment: 'sandbox', scope: 'read write', source: 'server_test' }
    const account = await config.adapter.request(provisional, '/users/me')
    provisional.receiverId = identifier(account.id)
    // Fail closed if a production credential was accidentally supplied as the test secret.
    await config.adapter.verifyAccount(provisional)
    const tokensCiphertext = await config.vault.seal(provisional, `mercadopago:${businessId}:sandbox`)
    await serviceRpc(admin, 'official_sandbox_connect', { businessId, employeeId: directive.employeeId, operationId: request.operationId, ...identity, operatorToken: request.operatorToken, tokensCiphertext, receiverId: provisional.receiverId, expiresAt: provisional.expiresAt })
    return { connected: true }
  }
  if (command === 'oauth_start' || command === 'oauth_callback') {
    if (!identity?.userId || !identity.authSessionId) throw new PointServiceError('PERMISSION_DENIED')
    if (config.oauthAvailable === false) throw new PointServiceError('POINT_CONFIGURATION_REQUIRED')
    if (request.environment !== undefined && request.environment !== config.environment) throw new PointServiceError('POINT_OAUTH_INVALID')
    if (command === 'oauth_start') {
      const state = randomSecret(), verifier = randomSecret(), stateHash = await digest(state)
      const expiresAt = new Date(Date.now() + 600000).toISOString()
      const verifierCiphertext = await config.vault.seal({ verifier }, `oauth:${businessId}:${identity.userId}:${stateHash}`)
      await serviceRpc(admin, 'oauth_state_create', { businessId, ...identity, stateHash, verifierCiphertext, environment: config.environment, redirectUri: config.redirectUri, expiresAt })
      const url = new URL(config.authorizationUrl ?? 'https://auth.mercadopago.com/authorization')
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
    // OAuth I/O can outlive logout, PIN lock or ownership revocation. Complete
    // only while the original actor and consumed browser state still authorize it.
    await serviceRpc(admin, 'oauth_connection_save', { businessId, ...identity, operatorToken: request.operatorToken, stateHash,
      redirectUri: config.redirectUri, environment: token.environment, receiverId: token.receiverId, tokensCiphertext, expiresAt: token.expiresAt })
    return { connected: true, environment: token.environment, receiverId: token.receiverId, terminalReady: false }
  }
  const connectionId = identifier(directive.connectionId)
  let connectionVersion: number | undefined
  try {
    const token = await connectionToken(admin, config, connectionId)
    connectionVersion = token.connectionVersion
    await config.adapter.verifyAccount(token)
    if (command === 'simulate') {
      if (config.localSimulator || token.source !== 'server_test' || token.environment !== 'sandbox' || !['processed', 'failed', 'canceled', 'expired', 'action_required'].includes(String(request.status))) throw new PointServiceError('POINT_STATE_INVALID')
      if (!identity?.userId || !identity.authSessionId) throw new PointServiceError('PERMISSION_DENIED')
      const remoteOrderId = identifier(directive.remoteOrderId)
      const before = await config.adapter.order(token, remoteOrderId)
      if (identifier(before.id) !== remoteOrderId || identifier(before.user_id) !== token.receiverId || record(record(before.config).point).terminal_id !== 'NEWLAND_N950__SBX0000001' || before.live_mode === true || !['created', 'at_terminal', 'action_required'].includes(String(before.status))) throw new PointServiceError('POINT_STATE_INVALID')
      // The official virtual device accepts approval to resolve check_on_terminal;
      // cancellation from that state is rejected. This never overrides a live payment.
      if (before.status === 'action_required' && (before.status_detail !== 'check_on_terminal' || request.status !== 'processed')) throw new PointServiceError('POINT_STATE_INVALID')
      const authorization = await serviceRpc(admin, 'official_sandbox_authorize', { businessId, ...identity, operatorToken: request.operatorToken, checkoutId: request.checkoutId, status: request.status })
      const fresh = record(authorization.backendDirective)
      if (fresh.connectionId !== connectionId || fresh.remoteOrderId !== remoteOrderId) throw new PointServiceError('POINT_STATE_INVALID')
      const status = String(request.status)
      await config.adapter.request(token, `/v1/orders/${remoteOrderId}/events`, 'POST', { status, ...(['processed', 'failed'].includes(status) ? { payment_method_type: 'credit_card', installments: 1, payment_method_id: 'visa', status_detail: status === 'processed' ? 'accredited' : 'insufficient_amount' } : {}) })
      // Accepted is not a payment result. Existing worker/webhook GET reconciliation owns all money writes.
      notifyWork()
      return { accepted: true }
    }
    if (token.source === 'server_test' && command === 'resources') return { branches: [{ id: 'sandbox', name: 'Pruebas' }], registers: [{ id: 'sandbox', branchId: 'sandbox', name: 'Terminal virtual' }], terminals: [{ id: 'NEWLAND_N950__SBX0000001', serial: 'SBX0000001', branchId: 'sandbox', registerId: 'sandbox', mode: 'PDV', branchName: 'Pruebas', registerName: 'Terminal virtual' }] }
    if (token.source === 'server_test' && ['link_terminal', 'test_terminal', 'create_branch', 'create_register'].includes(command)) throw new PointServiceError('POINT_STATE_INVALID')
    if (command === 'verify_connection') {
      await serviceRpc(admin, 'connection_verified', { connectionId })
      return redacted({ ...data, verified: true, terminalReady: false })
    }
    if (command === 'resources') {
      const budget = { remaining: 40 }
      const stores = await resourcePages(config, token, `/users/${identifier(token.receiverId)}/stores/search`, page => page.results, 50, budget)
      const branches = stores.map(s => { if (s.user_id !== undefined && identifier(s.user_id) !== token.receiverId) throw new ProviderError('INVALID_RESPONSE'); return { id: identifier(s.id), name: String(s.name ?? '') } })
      const registers: { id: string; branchId: string; name: string }[] = [], registerIds = new Set<string>()
      for (const branch of branches) {
        // v2 POS does not promise store_id in its response. The provider's store
        // filter establishes that relationship; never guess it from a name.
        const points = await resourcePages(config, token, `/v2/pos?store_id=${branch.id}`, page => page.data, 30, budget)
        for (const p of points) {
          const id = identifier(p.id)
          if (registerIds.has(id) || p.user_id !== undefined && identifier(p.user_id) !== token.receiverId
            || p.store_id !== undefined && identifier(p.store_id) !== branch.id) throw new ProviderError('INVALID_RESPONSE')
          registerIds.add(id); registers.push({ id, branchId: branch.id, name: String(p.name ?? '') })
          if (registers.length > 500) throw new PointServiceError('POINT_SERVICE_UNAVAILABLE')
        }
      }
      const availableTerminals = (await terminals(config, token, undefined, undefined, budget)).map(terminal => ({
        ...terminal,
        branchName: branches.find(branch => branch.id === terminal.branchId)?.name ?? '',
        registerName: registers.find(register => register.id === terminal.registerId)?.name ?? '',
      }))
      return { branches, registers, terminals: availableTerminals }
    }
    if (command === 'create_branch') {
      const externalId = `sasori${identifier(request.operationId).replaceAll('-', '')}`
      const found = await config.adapter.request(token, `/users/${identifier(token.receiverId)}/stores/search?external_id=${externalId}`)
      if (!Array.isArray(found.results) || found.results.length > 1) throw new ProviderError('INVALID_RESPONSE')
      if (found.results.length === 1) {
        const existing = record(found.results[0]), location = record(existing.location), requested = record(request.location)
        if (existing.external_id !== externalId || existing.name !== request.name
          || (existing.user_id !== undefined && identifier(existing.user_id) !== token.receiverId)
          || Number(location.latitude) !== requested.latitude || Number(location.longitude) !== requested.longitude
          || String(location.reference ?? '') !== String(requested.reference ?? '')) throw new PointServiceError('POINT_FACT_MISMATCH')
        return { id: identifier(existing.id), name: String(existing.name) }
      }
      const raw = await config.adapter.request(token, `/users/${identifier(token.receiverId)}/stores`, 'POST',
        { name: request.name, external_id: externalId, location: request.location })
      return { id: identifier(raw.id), name: String(raw.name ?? '') }
    }
    if (command === 'create_register') {
      const branches = await resourcePages(config, token, `/users/${identifier(token.receiverId)}/stores/search`, page => page.results, 50)
      if (branches.some(branch => branch.user_id !== undefined && identifier(branch.user_id) !== token.receiverId)
        || !branches.some(branch => identifier(branch.id) === request.branchId)) throw new PointServiceError('POINT_FACT_MISMATCH')
      const operationId = identifier(request.operationId)
      const externalId = `sasori${operationId.replaceAll('-', '')}`
      const raw = await config.adapter.request(token, '/v2/pos', 'POST', { name: request.name, store_id: identifier(request.branchId), external_id: externalId }, operationId)
      if (raw.store_id !== undefined && identifier(raw.store_id) !== request.branchId
        || raw.user_id !== undefined && identifier(raw.user_id) !== token.receiverId
        || raw.external_id !== undefined && raw.external_id !== externalId) throw new PointServiceError('POINT_FACT_MISMATCH')
      // v2 does not guarantee store_id in the response. Its owned store was
      // checked before POST and the operation keeps the exact requested binding.
      return { id: identifier(raw.id), branchId: identifier(request.branchId), name: String(raw.name ?? '') }
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
    if (error instanceof ProviderError && error.code === 'REVOKED' && connectionVersion !== undefined) await serviceRpc(admin, 'connection_revoke', { connectionId, expectedTokenVersion: connectionVersion })
    throw error
  }
}
interface Job { id: string; kind: string; attemptId: string; connectionId: string; leaseToken: string; payload: Record<string, unknown> }
async function readOrder(config: Configuration, token: TokenSet, remoteOrderId: string, expected: ExpectedOrder) {
  const order = await config.adapter.order(token, remoteOrderId)
  if (identifier(order.id) !== remoteOrderId) throw new ProviderError('INVALID_RESPONSE')
  const payments = record(order.transactions).payments
  const payment = Array.isArray(payments) && payments.length === 1 ? record(payments[0]) : null
  const reference = payment?.reference_id ?? (payment?.reference ? record(payment.reference).id : undefined)
  // Orders can omit currency/live_mode. A completed payment supplies the monetary evidence.
  if (!['processed', 'refunded'].includes(String(order.status)) && !order.currency && !order.currency_id) order.currency = order.country_code === 'MEX' ? 'MXN' : undefined
  // Virtual-device references are synthetic and GET /payments returns 404. Only
  // the verified server test account + standard virtual terminal use Orders alone.
  const proof = reference !== undefined && !officialVirtualOrder(order, expected, token)
    ? await config.adapter.request(token, `/v1/payments/${identifier(reference)}`) : undefined
  return { order, evidence: verifyOrder(order, expected, token, proof) }
}
function withinReplayWindow(firstSentAt: unknown): boolean {
  const firstSent = typeof firstSentAt === 'string' ? Date.parse(firstSentAt) : NaN
  return Number.isFinite(firstSent) && firstSent <= Date.now() && Date.now() - firstSent < 23 * 3600000
}
export interface WorkerScope { businessId: string; attemptId: string }
export async function runWorker(admin: RpcClient, supplied?: Configuration, scope?: WorkerScope): Promise<{ processed: number; failed: number }> {
  const config = supplied ?? configuration()
  if (scope) await serviceRpc(admin, 'reconcile_now', { ...scope })
  else await serviceRpc(admin, 'pending_sweep', { limit: 100 })
  let processed = 0, failed = 0
  // Acquire each lease immediately before work, so preceding slow HTTP calls cannot age waiting leases.
  for (let iteration = 0; iteration < (scope ? 1 : 4); iteration++) {
    const claimed = await serviceRpc(admin, 'claim_jobs', { limit: 1, leaseToken: crypto.randomUUID(), chargesEnabled: config.chargesEnabled, ...scope })
    const jobs = Array.isArray(claimed.jobs) ? claimed.jobs as unknown as Job[] : []
    if (jobs.length === 0) break
    const job = jobs[0]
    let connectionVersion: number | undefined
    try {
      const token = await connectionToken(admin, config, job.connectionId)
      connectionVersion = token.connectionVersion
      const expected = job.payload as unknown as ExpectedOrder
      await config.adapter.verifyAccount(token)
      let remoteOrderId = typeof job.payload.remoteOrderId === 'string' ? job.payload.remoteOrderId : ''
      if (job.kind === 'create' && !remoteOrderId) {
        // An uncertain response NEVER permits another identity or an out-of-window create replay.
        if (!config.chargesEnabled && !job.payload.firstSentAt) throw new PointServiceError('POINT_DISABLED')
        const firstSent = job.payload.firstSentAt
        if (firstSent && Date.now() - Date.parse(String(firstSent)) >= 23 * 3600000) throw new PointServiceError('POINT_IDEMPOTENCY_WINDOW_EXPIRED')
        const payload = validateCreatePayload(job.payload.createPayload, expected, token)
        const created = await config.adapter.create(token, payload, identifier(job.payload.idempotencyKey))
        remoteOrderId = identifier(created.id)
        await serviceRpc(admin, 'record_remote_order', { attemptId: job.attemptId, remoteOrderId, leaseToken: job.leaseToken, jobId: job.id })
      } else if (job.kind === 'refund') {
        if (!remoteOrderId) throw new PointServiceError('POINT_RESULT_UNCERTAIN')
        const refund = record(job.payload.refundRequest)
        const before = await readOrder(config, token, remoteOrderId, expected)
        // A known remote refund is reconciled through GET. Never POST it again after a
        // worker restart or after a webhook already confirmed it.
        if (refund.status !== 'confirmed' && !refund.remoteRefundId) {
          if (!withinReplayWindow(refund.firstSentAt)) throw new PointServiceError('POINT_IDEMPOTENCY_WINDOW_EXPIRED')
          const refundAmount = Number(refund.amountCents)
          if (refundAmount !== Number(job.payload.refundAmountCents)) throw new PointServiceError('POINT_FACT_MISMATCH')
          let response: Record<string, unknown>
          try {
            response = await config.adapter.refund(token, remoteOrderId, identifier(job.payload.paymentId), refundAmount,
              identifier(job.payload.idempotencyKey), refundAmount === expected.amountCents)
          } catch (error) {
            if (!(error instanceof ProviderError && error.code === 'REFUND_UNSUPPORTED')) throw error
            // A second authenticated GET must rule out a successful lost response.
            // Any refund history or in-flight refund requires reconciliation instead.
            const after = await readOrder(config, token, remoteOrderId, expected)
            const noRefunds = (value: typeof before) => value.evidence.verified && value.evidence.state === 'approved'
              && (record(value.order.transactions).refunds === undefined || Array.isArray(record(value.order.transactions).refunds)
                && (record(value.order.transactions).refunds as unknown[]).length === 0)
            if (!noRefunds(before) || !noRefunds(after) || after.evidence.paymentId !== identifier(job.payload.paymentId)
              || refundAmount >= expected.amountCents) throw new PointServiceError('POINT_RESULT_UNCERTAIN')
            await serviceRpc(admin, 'refund_declined', { jobId: job.id, leaseToken: job.leaseToken, refundId: identifier(refund.id),
              code: 'unsupported_partially_refunds', refundAmountCents: refundAmount, idempotencyKey: job.payload.idempotencyKey,
              ...after.evidence })
            processed++
            continue
          }
          if (identifier(response.id) !== remoteOrderId) throw new ProviderError('INVALID_RESPONSE')
          const prior = record(before.order.transactions).refunds
          const priorIds = new Set((Array.isArray(prior) ? prior : []).map(item => identifier(record(item).id)))
          const returned = record(response.transactions).refunds
          if (!Array.isArray(returned)) throw new ProviderError('INVALID_RESPONSE')
          const matches = returned.map(record).filter(item => !priorIds.has(identifier(item.id))
            && item.transaction_id === job.payload.paymentId && cents(item.amount) === refundAmount)
          // An idempotent replay may return the already visible refund. Only the exact
          // mutation response may bind it; an unrelated GET amount is insufficient.
          const candidates = matches.length ? matches : returned.map(record).filter(item => item.transaction_id === job.payload.paymentId && cents(item.amount) === refundAmount)
          if (candidates.length !== 1) throw new PointServiceError('POINT_RESULT_UNCERTAIN')
          await serviceRpc(admin, 'record_remote_refund', { jobId: job.id, leaseToken: job.leaseToken,
            refundId: identifier(refund.id), remoteRefundId: identifier(candidates[0].id) })
        }
      } else if (job.kind === 'cancel') {
        if (!remoteOrderId) throw new PointServiceError('POINT_RESULT_UNCERTAIN')
        try {
          await config.adapter.cancel(token, remoteOrderId, identifier(job.payload.idempotencyKey))
        } catch (error) {
          // The terminal may have taken, canceled or completed the order since the UI
          // requested cancellation. Reconcile it instead of retrying a stale capability.
          if (!(error instanceof ProviderError && error.code === 'CANCEL_ON_TERMINAL')) throw error
        }
      }
      if (!remoteOrderId) throw new PointServiceError('POINT_RESULT_UNCERTAIN')
      const { evidence } = await readOrder(config, token, remoteOrderId, expected)
      const states: Record<string, string> = { approved: 'approved_verified', sent: 'sent_to_terminal', canceled: 'cancelled', review: 'unknown_review' }
      await serviceRpc(admin, 'apply_order', { attemptId: job.attemptId, ...evidence, state: states[evidence.state] ?? evidence.state,
        cancelCapability: evidence.state === 'pending' ? 'backend' : ['sent', 'processing', 'review'].includes(evidence.state) ? 'terminal' : 'unavailable', jobId: job.id, leaseToken: job.leaseToken })
      await serviceRpc(admin, 'complete_job', { id: job.id, leaseToken: job.leaseToken })
      processed++
    } catch (error) {
      const code = error instanceof ProviderError || error instanceof PointServiceError ? error.code : 'POINT_SERVICE_UNAVAILABLE'
      if (code === 'REVOKED' && connectionVersion !== undefined) await serviceRpc(admin, 'connection_revoke', { connectionId: job.connectionId, expectedTokenVersion: connectionVersion })
      await serviceRpc(admin, 'fail_job', { id: job.id, leaseToken: job.leaseToken, code,
        uncertain: ['UNCERTAIN', 'INVALID_RESPONSE', 'POINT_RESULT_UNCERTAIN', 'POINT_IDEMPOTENCY_WINDOW_EXPIRED'].includes(code), delaySeconds: 15 + crypto.getRandomValues(new Uint8Array(1))[0] % 16 })
      failed++
      // A failing queue head waits for SQL backoff. End here rather than hammering one attempt or connection.
      break
    }
  }
  return { processed, failed }
}
