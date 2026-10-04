/** Orders API adapter. Never accepts a provider URL from a request or notification. */
export type Environment = 'live' | 'sandbox'
export type PaymentState = 'pending' | 'sent' | 'processing' | 'approved' | 'rejected' | 'canceled' | 'expired' | 'review' | 'partially_refunded' | 'refunded'
export class ProviderError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'REVOKED' | 'INVALID_RESPONSE' | 'DEFINITIVE_FAILURE' | 'UNCERTAIN' | 'CANCEL_ON_TERMINAL', readonly status = 0) {
    super(code)
  }
}
type Json = Record<string, unknown>
export function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('INVALID_RESPONSE')
  return value as Json
}
export function identifier(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[A-Za-z0-9_-]{1,128}$/.test(String(value))) throw new ProviderError('INVALID_RESPONSE')
  return String(value)
}
export function decimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 999999999) throw new ProviderError('INVALID_RESPONSE')
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}
export function cents(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) throw new ProviderError('INVALID_RESPONSE')
  const [whole, fraction = ''] = value.split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(amount) || amount > 999999999) throw new ProviderError('INVALID_RESPONSE')
  return amount
}
export interface TokenSet { accessToken: string; refreshToken: string; expiresAt: string; receiverId: string; environment: Environment; scope: string }
export interface ExpectedOrder { amountCents: number; currency: string; receiverId: string; environment: Environment; externalReference: string; terminalId: string }
export interface OrderEvidence {
  remoteOrderId: string; paymentId: string; state: PaymentState; status: string; statusDetail: string;
  amountCents: number; currency: string; receiverId: string; environment: Environment; externalReference: string;
  refunds: { id: string; amountCents: number; confirmedAt: string }[]; observedAt: string; verified: boolean
}
export function createPayload(expected: ExpectedOrder): Json {
  if (expected.currency !== 'MXN' || !/^[A-Za-z0-9_-]{1,64}$/.test(expected.externalReference)) throw new ProviderError('INVALID_RESPONSE')
  return { type: 'point', external_reference: expected.externalReference, expiration_time: 'PT15M',
    transactions: { payments: [{ amount: decimal(expected.amountCents) }] },
    config: { point: { terminal_id: identifier(expected.terminalId), print_on_terminal: 'no_ticket' } } }
}
export function mapState(status: string, detail: string, txStatus: string, txDetail: string): PaymentState {
  if (status === 'action_required' || txStatus === 'action_required' || txDetail === 'in_review') return 'review'
  if (status === 'refunded' && detail === 'refunded' && ['processed', 'refunded'].includes(txStatus)) return 'refunded'
  if (status === 'processed' && detail === 'partially_refunded' && txStatus === 'processed') return 'partially_refunded'
  if (status === 'processed' && ['processed', 'accredited'].includes(detail) && txStatus === 'processed' && ['processed', 'accredited'].includes(txDetail)) return 'approved'
  if (status === 'created' && detail === 'created' && txStatus === 'created') return 'pending'
  if (status === 'at_terminal' && detail === 'at_terminal' && ['created', 'at_terminal'].includes(txStatus)) return 'sent'
  if (status === 'canceled' && ['canceled', 'canceled_by_api', 'canceled_on_terminal'].includes(detail) && txStatus === 'canceled' && ['canceled', 'canceled_by_api', 'canceled_on_terminal'].includes(txDetail)) return 'canceled'
  if (status === 'expired' && detail === 'expired' && ['created', 'expired'].includes(txStatus)) return 'expired'
  const definitive = ['failed', 'bad_filled_card_data', 'insufficient_amount', 'high_risk', 'rejected_by_issuer', 'required_call_for_authorize', 'max_attempts_exceeded', 'card_disabled', 'amount_limit_exceeded', 'invalid_installments', 'processing_error']
  if (status === 'failed' && ['failed', 'rejected'].includes(detail) && txStatus === 'failed' && definitive.includes(txDetail)) return 'rejected'
  return 'review'
}
export function verifyOrder(raw: unknown, expected: ExpectedOrder, token: TokenSet, monetaryProof?: unknown): OrderEvidence {
  const order = record(raw), transactions = record(order.transactions)
  if (!Array.isArray(transactions.payments) || transactions.payments.length !== 1) throw new ProviderError('INVALID_RESPONSE')
  const payment = record(transactions.payments[0])
  const amount = cents(payment.amount)
  const proof = monetaryProof === undefined ? null : record(monetaryProof)
  const currency = order.currency ?? order.currency_id ?? proof?.currency_id
  const receiver = identifier(order.user_id)
  const terminal = record(record(order.config).point).terminal_id
  if (order.type !== 'point' || amount !== expected.amountCents || currency !== expected.currency || receiver !== expected.receiverId
    || receiver !== token.receiverId || token.environment !== expected.environment || order.external_reference !== expected.externalReference
    || terminal !== expected.terminalId || (order.live_mode !== undefined && order.live_mode !== (expected.environment === 'live'))) throw new ProviderError('INVALID_RESPONSE')
  if (proof) {
    const reference = payment.reference_id ?? (payment.reference && record(payment.reference).id)
    if (identifier(proof.id) !== identifier(reference) || identifier(proof.collector_id) !== receiver || proof.live_mode !== (expected.environment === 'live')
      || proof.currency_id !== expected.currency || (proof.external_reference !== undefined && proof.external_reference !== expected.externalReference)
      || !['approved', 'refunded'].includes(String(proof.status)) || typeof proof.transaction_amount !== 'number'
      || !Number.isFinite(proof.transaction_amount) || cents(String(proof.transaction_amount)) !== amount) throw new ProviderError('INVALID_RESPONSE')
  }
  const observedAt = typeof order.last_updated_date === 'string' && Number.isFinite(Date.parse(order.last_updated_date)) ? order.last_updated_date : ''
  if (!observedAt) throw new ProviderError('INVALID_RESPONSE')
  const status = String(order.status ?? ''), detail = String(order.status_detail ?? '')
  const state = mapState(status, detail, String(payment.status ?? ''), String(payment.status_detail ?? ''))
  if (['approved', 'partially_refunded', 'refunded'].includes(state) && !proof && order.live_mode === undefined) throw new ProviderError('INVALID_RESPONSE')
  const refunds: OrderEvidence['refunds'] = []
  if (transactions.refunds !== undefined && !Array.isArray(transactions.refunds)) throw new ProviderError('INVALID_RESPONSE')
  for (const item of transactions.refunds as unknown[] ?? []) {
    const refund = record(item)
    if (refund.status !== 'processed') continue
    if (refund.transaction_id !== payment.id) throw new ProviderError('INVALID_RESPONSE')
    refunds.push({ id: identifier(refund.id), amountCents: cents(refund.amount), confirmedAt: observedAt })
  }
  if (new Set(refunds.map(r => r.id)).size !== refunds.length || refunds.reduce((sum, r) => sum + r.amountCents, 0) > amount) throw new ProviderError('INVALID_RESPONSE')
  const refunded = refunds.reduce((sum, r) => sum + r.amountCents, 0)
  if ((state === 'refunded' && refunded !== amount) || (state === 'partially_refunded' && !(refunded > 0 && refunded < amount))) throw new ProviderError('INVALID_RESPONSE')
  return { remoteOrderId: identifier(order.id), paymentId: identifier(payment.id), state, status, statusDetail: detail,
    amountCents: amount, currency: String(currency), receiverId: receiver, environment: expected.environment,
    externalReference: expected.externalReference, refunds, observedAt, verified: ['approved', 'partially_refunded', 'refunded'].includes(state) }
}
export interface PointAdapter {
  exchange(code: string, verifier: string, environment: Environment): Promise<TokenSet>;
  refresh(token: TokenSet): Promise<TokenSet>;
  verifyAccount(token: TokenSet): Promise<void>;
  request(token: TokenSet, path: string, method?: string, body?: unknown, key?: string): Promise<Json>;
  order(token: TokenSet, id: string): Promise<Json>;
  create(token: TokenSet, payload: Json, key: string): Promise<Json>;
  refund(token: TokenSet, orderId: string, paymentId: string, amountCents: number, key: string, total?: boolean): Promise<Json>;
  cancel(token: TokenSet, orderId: string, key: string): Promise<Json>;
}
export class MercadoPagoPoint implements PointAdapter {
  private readonly base: string
  constructor(private readonly options: { clientId: string; clientSecret: string; redirectUri: string; baseUrl?: string; allowLocalSimulator?: boolean; timeoutMs?: number; fetch?: typeof fetch }) {
    this.base = options.baseUrl ?? 'https://api.mercadopago.com'
    const url = new URL(this.base)
    if (this.base !== 'https://api.mercadopago.com' && !(options.allowLocalSimulator && ['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal'].includes(url.hostname) && url.protocol === 'http:')) throw new Error('Invalid provider configuration')
  }
  private async http(path: string, method: string, body?: unknown, token?: string, key?: string): Promise<Json> {
    if (!/^\/[A-Za-z0-9_/?=&.-]+$/.test(path) || path.includes('..') || path.includes('//')) throw new ProviderError('INVALID_RESPONSE')
    const mutation = method !== 'GET'
    try {
      const response = await (this.options.fetch ?? fetch)(this.base + path, { method, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'X-Idempotency-Key': identifier(key) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 8000) })
      if (response.status === 401) throw new ProviderError('REVOKED', response.status)
      if (!response.ok) throw new ProviderError(response.status >= 500 || response.status === 429 ? (mutation ? 'UNCERTAIN' : 'UNAVAILABLE') : 'DEFINITIVE_FAILURE', response.status)
      if (!response.body) throw new ProviderError(mutation ? 'UNCERTAIN' : 'INVALID_RESPONSE')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          length += part.value.length
          if (length > 131072) { await reader.cancel(); throw new ProviderError(mutation ? 'UNCERTAIN' : 'INVALID_RESPONSE') }
          chunks.push(part.value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const part of chunks) { bytes.set(part, offset); offset += part.length }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      try { return record(JSON.parse(text)) } catch { throw new ProviderError(mutation ? 'UNCERTAIN' : 'INVALID_RESPONSE') }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError(mutation ? 'UNCERTAIN' : 'UNAVAILABLE')
    }
  }
  private tokens(raw: Json, environment: Environment): TokenSet {
    if (typeof raw.access_token !== 'string' || typeof raw.refresh_token !== 'string' || typeof raw.expires_in !== 'number'
      || !Number.isSafeInteger(raw.expires_in) || raw.expires_in <= 0 || raw.live_mode !== (environment === 'live')
      || typeof raw.scope !== 'string' || !raw.scope.split(' ').includes('offline_access')) throw new ProviderError('INVALID_RESPONSE')
    return { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt: new Date(Date.now() + raw.expires_in * 1000).toISOString(), receiverId: identifier(raw.user_id), environment, scope: raw.scope }
  }
  async exchange(code: string, verifier: string, environment: Environment): Promise<TokenSet> {
    const raw = await this.http('/oauth/token', 'POST', { client_id: this.options.clientId, client_secret: this.options.clientSecret,
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.options.redirectUri, test_token: environment === 'sandbox' })
    const token = this.tokens(raw, environment)
    await this.verifyAccount(token)
    return token
  }
  async refresh(token: TokenSet): Promise<TokenSet> {
    const next = this.tokens(await this.http('/oauth/token', 'POST', { client_id: this.options.clientId, client_secret: this.options.clientSecret,
      grant_type: 'refresh_token', refresh_token: token.refreshToken, test_token: token.environment === 'sandbox' }), token.environment)
    if (next.receiverId !== token.receiverId) throw new ProviderError('INVALID_RESPONSE')
    await this.verifyAccount(next)
    return next
  }
  async verifyAccount(token: TokenSet): Promise<void> {
    const account = await this.request(token, '/users/me')
    if (identifier(account.id) !== token.receiverId || account.site_id !== 'MLM' || !Array.isArray(account.tags)
      || account.tags.includes('test_user') !== (token.environment === 'sandbox')) throw new ProviderError('INVALID_RESPONSE')
  }
  request(token: TokenSet, path: string, method = 'GET', body?: unknown, key?: string): Promise<Json> { return this.http(path, method, body, token.accessToken, key) }
  order(token: TokenSet, id: string): Promise<Json> { return this.request(token, `/v1/orders/${identifier(id)}`) }
  create(token: TokenSet, payload: Json, key: string): Promise<Json> { return this.request(token, '/v1/orders', 'POST', payload, key) }
  refund(token: TokenSet, orderId: string, paymentId: string, amountCents: number, key: string, total = false): Promise<Json> {
    return this.request(token, `/v1/orders/${identifier(orderId)}/refund`, 'POST', total ? undefined : { transactions: [{ id: identifier(paymentId), amount: decimal(amountCents) }] }, key)
  }
  async cancel(token: TokenSet, orderId: string, key: string): Promise<Json> {
    const current = await this.order(token, orderId)
    if (current.status !== 'created') throw new ProviderError('CANCEL_ON_TERMINAL')
    return this.request(token, `/v1/orders/${identifier(orderId)}/cancel`, 'POST', undefined, key)
  }
}
