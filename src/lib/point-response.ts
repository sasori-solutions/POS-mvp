import { AccountClientError } from './account'
import { assertFinancialAttempt, assertFinancialSale } from './financial-response'
import type { PointCheckout, PointCommand, PointSettings } from './point-contracts'
import { exactCents } from './point-domain'

const states = ['prepared', 'pending', 'sent_to_terminal', 'processing', 'approved_verified', 'rejected', 'cancelled', 'expired', 'unknown_review', 'partially_refunded', 'refunded']
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const same = (first: string, second: string) => first.toLowerCase() === second.toLowerCase()
function requireValue(value: unknown): asserts value { if (!value) throw new Error('INVALID_POINT_RESPONSE') }
function object(value: unknown): Record<string, unknown> { requireValue(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown> }
function terminal(value: unknown) {
  const data = object(value)
  for (const name of ['id', 'serial', 'branchId', 'registerId', 'branchName', 'registerName', 'mode']) requireValue(typeof data[name] === 'string')
  for (const name of ['verified', 'active', 'physicalStepsPending']) requireValue(typeof data[name] === 'boolean')
}
function checkout(value: unknown): asserts value is PointCheckout {
  const data = object(value)
  requireValue(uuid(data.id) && (data.attemptId === null || uuid(data.attemptId)) && states.includes(String(data.state)))
  requireValue(['pending', 'materialized'].includes(String(data.saleState)))
  assertFinancialAttempt(data.checkout)
  const reservation = data.checkout
  requireValue(reservation.kind === 'payment' && reservation.paymentMethod === 'card_integrated')
  requireValue(exactCents(data.totalCents) === reservation.totalCents && exactCents(data.refundedCents) <= reservation.totalCents)
  requireValue(Array.isArray(data.items) && data.items.length === reservation.items.length)
  const snapshot = new Map(reservation.items.map(item => [item.lineId.toLowerCase(), item]))
  const identities = new Set<string>()
  for (const raw of data.items) {
    const item = object(raw); requireValue(uuid(item.lineId))
    const original = snapshot.get(item.lineId.toLowerCase())
    requireValue(original && !identities.has(item.lineId.toLowerCase())); identities.add(item.lineId.toLowerCase())
    for (const key of ['productId', 'quantity', 'unitPriceCents', 'discountCents', 'totalCents', 'taxCents'] as const) requireValue(original[key] === item[key])
  }
  terminal(data.terminal)
  requireValue(['backend', 'terminal', 'unavailable'].includes(String(data.cancelCapability)) && typeof data.updatedAt === 'string' && Number.isFinite(Date.parse(data.updatedAt)))
  if (data.saleState === 'materialized') {
    requireValue(['approved_verified', 'partially_refunded', 'refunded'].includes(String(data.state)))
    assertFinancialSale(data.sale)
    requireValue(data.sale.paymentMethod === 'card_integrated' && reservation.status === 'completed' && reservation.saleId && same(data.sale.id, reservation.saleId) && data.sale.totalCents === reservation.totalCents)
    const signature = (item: { productId: string; quantity: number; unitPriceCents: number; totalCents: number; discountCents?: number; taxCents?: number | null }) => JSON.stringify([item.productId.toLowerCase(), item.quantity, item.unitPriceCents, item.totalCents, item.discountCents ?? 0, item.taxCents ?? 0])
    const expected = reservation.items.map(signature).sort(), actual = data.sale.items.map(signature).sort()
    requireValue(expected.length === actual.length && expected.every((item, index) => item === actual[index]))
  } else requireValue(data.sale === null)
  requireValue(Array.isArray(data.refundRequests))
  const requests = new Set<string>()
  let pendingRefundCents = 0
  for (const raw of data.refundRequests) {
    const request = object(raw)
    requireValue(uuid(request.id) && uuid(request.operationId) && !requests.has(request.operationId.toLowerCase()))
    requests.add(request.operationId.toLowerCase())
    requireValue(['pending', 'unknown_review', 'confirmed', 'rejected'].includes(String(request.status)))
    const amount = exactCents(request.amountCents)
    requireValue(amount > 0 && amount <= reservation.totalCents && exactCents(request.merchandiseCents) + exactCents(request.tipCents) === amount)
    if (request.status === 'pending' || request.status === 'unknown_review') pendingRefundCents += amount
    requireValue(typeof request.reason === 'string' && (request.remoteRefundId === null || typeof request.remoteRefundId === 'string'))
  }
  // Verified refunds and pending requests can describe the same provider movement before its locator is recovered.
  // Bound them separately; only an exact provider refund ID can resolve that ambiguity.
  requireValue(pendingRefundCents <= reservation.totalCents)
}
function settings(value: unknown): asserts value is PointSettings {
  const data = object(value), permissions = object(data.permissions)
  requireValue(data.chargesEnabled === undefined || typeof data.chargesEnabled === 'boolean')
  requireValue(uuid(data.actorId) && typeof data.enabled === 'boolean' && Array.isArray(data.terminals) && Array.isArray(data.pending))
  for (const name of ['manage', 'charge', 'refund', 'reports', 'admin']) requireValue(typeof permissions[name] === 'boolean')
  data.terminals.forEach(terminal); data.pending.forEach(checkout)
}

function statement(value: unknown) {
  const data = object(value)
  requireValue(uuid(data.id) && ['closed', 'invoiced'].includes(String(data.status)))
  requireValue(typeof data.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(data.period))
  requireValue(typeof data.exactNumerator === 'string' && /^-?\d+$/.test(data.exactNumerator))
  const amount = (key: string) => { const value = data[key]; requireValue(typeof value === 'number' && Number.isSafeInteger(value)); return value }
  const net = amount('netCents'), vat = amount('vatCents'), total = amount('totalCents'), collected = amount('collectedCents'), remaining = amount('remainingCents')
  requireValue(Number.isSafeInteger(net + vat) && net + vat === total && collected >= 0 && Number.isSafeInteger(total - collected) && total - collected === remaining)
  requireValue(total >= 0 ? collected <= total : collected === 0)
  return data
}

/** A malformed success may have committed. Keep its operation pending for exact recovery. */
export function assertPointResponse(command: PointCommand, value: unknown): void {
  try {
    if (command.command === 'simulate') { requireValue(object(value).accepted === true)
    } else if (['prepare', 'start', 'status', 'cancel', 'incident', 'refund', 'refund_context'].includes(command.command)) {
      checkout(value)
      if ('checkoutId' in command) requireValue(same(value.id, command.checkoutId))
      if (command.command === 'prepare') requireValue(same(value.checkout.id, command.checkoutAttemptId) && value.terminal.id === command.terminalId)
      if (command.command === 'refund_context') requireValue(value.sale && same(value.sale.id, command.saleId))
      if (command.command === 'refund') {
        const request = value.refundRequests.find(item => same(item.operationId, command.operationId))
        requireValue(request && request.amountCents === command.amountCents && request.merchandiseCents === command.merchandiseCents && request.tipCents === command.tipCents)
      }
    } else if (command.command === 'statements') {
      const data = object(value); requireValue(Array.isArray(data.statements))
      const identifiers = new Set()
      for (const entry of data.statements) { const data = statement(entry); requireValue(!identifiers.has(data.id)); identifiers.add(data.id) }
    } else if (command.command === 'close_statement' || command.command === 'mark_statement_invoiced' || command.command === 'record_commission_payment') {
      const data = statement(value)
      if (command.command === 'close_statement') requireValue(data.period === command.period)
      else requireValue(typeof data.id === 'string' && same(data.id, command.statementId))
      if (command.command === 'mark_statement_invoiced') requireValue(data.status === 'invoiced')
      if (command.command === 'record_commission_payment') requireValue(data.status === 'invoiced' && (data.collectedCents as number) >= command.amountCents)
    } else if (command.command === 'recover') {
      const data = object(value); requireValue(Array.isArray(data.checkouts)); data.checkouts.forEach(checkout)
    } else if (['settings', 'connect_sandbox', 'oauth_callback', 'verify_connection', 'link_terminal', 'test_terminal', 'activate', 'disconnect'].includes(command.command)) settings(value)
  } catch {
    throw new AccountClientError('SERVER_ERROR', 'No pudimos verificar el resultado de Point. Conserva el mismo intento para consultarlo.')
  }
}
