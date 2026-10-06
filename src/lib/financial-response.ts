import { AccountClientError } from './account'
import type { PosCommand } from './pos-contracts'
import type { Sale } from './pos-contracts'
import type { CheckoutAttempt, OperationalOrder, OrderLine } from './operations-contracts'
import { assertMonetaryLineSnapshot, FinancialIntegrityError, isBoundedInteger, maxOperationalLines, maxOperationalMoneyCents, maxOperationalQuantity, maxOperationalUnitPriceCents, monetaryLineSlice } from './operational-money'
import { checkoutAmountTotals } from './checkout-amounts'

type ObjectValue = Record<string, unknown>
const orderCommands = new Set(['order', 'save_order', 'set_order_discount', 'cancel_order', 'send_order', 'begin_order_checkout', 'resume_order_service', 'move_order', 'close_order'])
const attemptCommands = new Set(['attempt', 'prepare_checkout', 'update_checkout', 'start_checkout', 'mark_checkout_uncertain', 'resolve_checkout', 'prepare_reversal'])
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const sameId = (first: string, second: string) => first.toLowerCase() === second.toLowerCase()
type LineIdentity = { kind?: string; productId: string | null; name?: string }
const requestedAmountName = (name: string) => name.trim().replace(/\s+/g, ' ') || 'Importe libre'
function financialLineIdentity(line: ObjectValue): boolean {
  if (line.kind === 'amount') return line.productId === null && typeof line.name === 'string' && line.name.trim() === line.name && line.name.length >= 1 && [...line.name].length <= 100
  return (line.kind === undefined || line.kind === 'product') && identifier(line.productId)
}
function sameLineIdentity(first: LineIdentity, second: LineIdentity): boolean {
  if (first.kind === 'amount' || second.kind === 'amount') return first.kind === 'amount' && second.kind === 'amount' && first.productId === null && second.productId === null && first.name === second.name
  return typeof first.productId === 'string' && typeof second.productId === 'string' && sameId(first.productId, second.productId)
}
function requireValue(valid: boolean): asserts valid { if (!valid) throw new FinancialIntegrityError() }
function object(value: unknown): ObjectValue {
  requireValue(Boolean(value) && typeof value === 'object' && !Array.isArray(value))
  return value as ObjectValue
}
function cents(value: unknown, maximum = maxOperationalMoneyCents): number {
  requireValue(typeof value === 'number' && isBoundedInteger(value, 0, maximum))
  return value
}
function amountParts(value: unknown): number[] {
  requireValue(Array.isArray(value) && value.length >= 1 && value.length <= 20)
  const parts = value.map(amount => { const part = cents(amount); requireValue(part > 0); return part })
  cents(parts.reduce((sum, part) => sum + part, 0))
  return parts
}
function header(value: ObjectValue) {
  requireValue(identifier(value.id) && typeof value.revision === 'number' && isBoundedInteger(value.revision, 1, 2_147_483_647))
}
function items(value: unknown, minimum: number): ObjectValue[] {
  requireValue(Array.isArray(value) && value.length >= minimum && value.length <= maxOperationalLines)
  const identities = new Set<string>()
  return value.map(raw => {
    const item = object(raw)
    requireValue(identifier(item.lineId) && financialLineIdentity(item))
    const id = item.lineId.toLowerCase()
    requireValue(!identities.has(id)); identities.add(id)
    return item
  })
}

/** Validate only financial DTOs consumed by checkout. Never repair a malformed server result. */
export function assertFinancialOrder(value: unknown): asserts value is OperationalOrder {
  const order = object(value); header(order)
  requireValue(order.orderKind === undefined || order.orderKind === null || order.orderKind === 'counter' || order.orderKind === 'service')
  if (order.orderKind === 'counter') requireValue(order.tableId === null)
  requireValue(['open', 'paid', 'cancelled', 'waived', 'closed'].includes(String(order.status)) && ['service', 'checkout'].includes(String(order.phase)) && typeof order.frozen === 'boolean')
  const lines = items(order.items, 0)
  let gross = 0, discount = 0, total = 0, tax = 0, paid = 0
  for (const line of lines) {
    assertMonetaryLineSnapshot(line as unknown as OrderLine)
    requireValue(typeof line.sentQuantity === 'number' && isBoundedInteger(line.sentQuantity, 0, line.quantity as number))
    if (line.kind === 'amount') requireValue(line.sentQuantity === 0 && line.version === 1 && line.selection === null && line.note === '' && line.kitchenName === '' && line.selectionLabel === '' && line.category === '' && (line.unitPriceCents as number) > 0)
    requireValue(typeof line.taxBps === 'number' && isBoundedInteger(line.taxBps, 0, 10_000))
    requireValue(['vat_16', 'vat_0', 'exempt', 'border_8', 'unconfigured', 'legacy'].includes(String(line.taxTreatment)))
    gross += line.grossCents as number; discount += line.discountCents as number; total += line.totalCents as number; tax += line.taxCents as number
    const legacyPaid = monetaryLineSlice({ ...line, paidQuantity: 0 } as unknown as OrderLine, line.paidQuantity as number)
    if (line.paidTotalCents !== undefined) {
      const linePaid = cents(line.paidTotalCents, line.totalCents as number)
      const paidDiscount = cents(line.paidDiscountCents, line.discountCents as number), paidTax = cents(line.paidTaxCents, line.taxCents as number)
      requireValue(linePaid >= legacyPaid.totalCents && paidTax <= linePaid)
      if (!order.amountSplit) requireValue(linePaid === legacyPaid.totalCents && paidDiscount === legacyPaid.discountCents && paidTax === legacyPaid.taxCents)
      if (linePaid === line.totalCents) requireValue(line.paidQuantity === line.quantity || line.totalCents === 0)
      if (line.paidQuantity === line.quantity) requireValue(linePaid === line.totalCents && paidDiscount === line.discountCents && paidTax === line.taxCents)
      paid += linePaid
    } else { requireValue(!order.amountSplit); paid += legacyPaid.totalCents }
  }
  requireValue(cents(order.grossCents) === gross && cents(order.discountCents, gross) === discount && cents(order.totalCents, gross) === total && cents(order.taxCents, total) === tax)
  requireValue(cents(order.paidCents, total) === paid)
  const waived = cents(order.waivedCents, total), cancelled = cents(order.cancelledCents, total), balance = cents(order.balanceCents, total)
  requireValue(total === paid + waived + cancelled + balance)
  if (order.amountSplit !== undefined) requireValue(typeof order.amountSplit === 'boolean')
  if (order.amountPaidParts !== undefined) {
    const paidParts = cents(order.amountPaidParts)
    requireValue(order.amountSplit ? paidParts > 0 : paidParts === 0)
  }
  if (order.amountSplit) requireValue(order.amountPaidParts !== undefined && Array.isArray(order.amountParts))
  if (order.amountParts !== undefined) {
    requireValue(Array.isArray(order.amountParts))
    if (order.amountSplit && order.status === 'open') requireValue(amountParts(order.amountParts).reduce((sum, part) => sum + part, 0) === balance)
  }
  requireValue(order.status === 'open' || balance === 0)
  if (order.discount === null) requireValue(discount === 0)
  else {
    const entry = object(order.discount)
    requireValue(entry.kind === 'fixed' || entry.kind === 'percent')
    const value = cents(entry.value, entry.kind === 'fixed' ? gross : 10_000)
    const amount = entry.kind === 'fixed' ? value : Number((BigInt(gross) * BigInt(value) + 5_000n) / 10_000n)
    requireValue(amount === discount)
  }
}

export function assertFinancialAttempt(value: unknown): asserts value is CheckoutAttempt {
  const attempt = object(value); header(attempt)
  requireValue(attempt.kind === 'payment' || attempt.kind === 'reversal')
  requireValue(['prepared', 'collection_started', 'completed', 'aborted', 'uncertain'].includes(String(attempt.status)))
  requireValue(identifier(attempt.shiftId) && ['cash', 'card_external', 'card_integrated', 'transfer'].includes(String(attempt.paymentMethod)))
  if (attempt.kind === 'payment') {
    requireValue(identifier(attempt.orderId) && attempt.originalSaleId === null)
    requireValue(attempt.status === 'completed' ? identifier(attempt.saleId) : attempt.saleId === null)
  } else requireValue(identifier(attempt.originalSaleId) && attempt.orderId === null && attempt.saleId === null)
  let total = 0, discount = 0, tax = 0
  if (attempt.amountsCents !== undefined) requireValue(attempt.kind === 'payment' && amountParts(attempt.amountsCents)[0] === attempt.totalCents)
  for (const line of items(attempt.items, 1)) {
    const allocated = line.allocatedGrossCents !== undefined
    requireValue(!allocated || attempt.kind === 'reversal' || attempt.amountsCents !== undefined)
    requireValue(attempt.amountsCents === undefined || allocated)
    requireValue(typeof line.quantity === 'number' && isBoundedInteger(line.quantity, allocated ? 0 : 1, maxOperationalQuantity))
    const unit = cents(line.unitPriceCents, maxOperationalUnitPriceCents), gross = allocated ? cents(line.allocatedGrossCents) : cents(unit * line.quantity)
    if (line.kind === 'amount') requireValue(unit > 0)
    const lineDiscount = cents(line.discountCents, gross), lineTotal = cents(line.totalCents, gross), lineTax = cents(line.taxCents, lineTotal)
    requireValue(lineTotal === gross - lineDiscount)
    // Historical reversals can have no recorded classification/rate. Their recorded tax cents stay authoritative.
    if (line.taxBps !== undefined) requireValue(line.taxBps === null ? attempt.kind === 'reversal' && (line.taxTreatment === 'legacy' || line.taxTreatment === null) : typeof line.taxBps === 'number' && isBoundedInteger(line.taxBps, 0, 10_000))
    total += lineTotal; discount += lineDiscount; tax += lineTax
  }
  cents(total + discount)
  requireValue(cents(attempt.totalCents) === total && cents(attempt.discountCents) === discount && cents(attempt.taxCents, total) === tax)
}

/** Receipts may repeat a product across variants or separate order lines and omit historic IVA metadata. */
export function assertFinancialSale(value: unknown): asserts value is Sale {
  const sale = object(value)
  requireValue(identifier(sale.id) && ['cash', 'card_external', 'card_integrated', 'transfer'].includes(String(sale.paymentMethod)))
  requireValue(Array.isArray(sale.items) && sale.items.length >= 1 && sale.items.length <= maxOperationalLines)
  let grossTotal = 0, total = 0, count = 0
  for (const raw of sale.items) {
    const line = object(raw)
    const allocated = line.allocatedGrossCents !== undefined
    requireValue(financialLineIdentity(line) && typeof line.quantity === 'number' && isBoundedInteger(line.quantity, allocated ? 0 : 1, maxOperationalQuantity))
    const unit = cents(line.unitPriceCents, maxOperationalUnitPriceCents), gross = allocated ? cents(line.allocatedGrossCents) : cents(unit * line.quantity)
    if (line.kind === 'amount') requireValue(unit > 0)
    const discount = line.discountCents === undefined ? 0 : cents(line.discountCents, gross)
    const net = cents(line.totalCents, gross)
    requireValue(net === gross - discount)
    if (line.taxCents !== undefined && line.taxCents !== null) cents(line.taxCents, net)
    if (line.taxBps !== undefined && line.taxBps !== null) requireValue(typeof line.taxBps === 'number' && isBoundedInteger(line.taxBps, 0, 10_000))
    grossTotal += gross; total += net; count += line.quantity
  }
  cents(grossTotal)
  requireValue(cents(sale.totalCents) === total && sale.itemCount === count)
}

function matchesSelection(attempt: CheckoutAttempt, selected: { lineId: string; quantity: number }[]) {
  requireValue(attempt.items.length === selected.length)
  const quantities = new Map(selected.map(line => [line.lineId.toLowerCase(), line.quantity]))
  requireValue(quantities.size === selected.length && attempt.items.every(line => quantities.get(line.lineId.toLowerCase()) === line.quantity))
}
function completedPayment(value: unknown, command: Extract<PosCommand, { command: 'record_checkout' | 'record_payment' }>) {
  const result = object(value); assertFinancialOrder(result.order); assertFinancialAttempt(result.attempt)
  const { order, attempt } = result
  requireValue(attempt.kind === 'payment' && attempt.status === 'completed' && sameId(order.id, attempt.orderId!))
  if (command.command === 'record_checkout') requireValue(sameId(attempt.id, command.attemptId))
  else { requireValue(sameId(order.id, command.orderId) && attempt.paymentMethod === command.paymentMethod); matchesSelection(attempt, command.items) }
  requireValue(order.paidCents >= attempt.totalCents && order.frozen)
  if (attempt.amountsCents) {
    requireValue(Boolean(order.amountSplit))
    const slices = new Map(attempt.items.map(line => [line.lineId.toLowerCase(), line]))
    const before: OperationalOrder = { ...order, balanceCents: order.balanceCents + attempt.totalCents, items: order.items.map(line => {
      const slice = slices.get(line.lineId.toLowerCase())
      requireValue(line.paidTotalCents !== undefined && line.paidDiscountCents !== undefined && line.paidTaxCents !== undefined)
      return { ...line, paidQuantity: line.paidQuantity - (slice?.quantity ?? 0), paidTotalCents: line.paidTotalCents - (slice?.totalCents ?? 0), paidDiscountCents: line.paidDiscountCents - (slice?.discountCents ?? 0), paidTaxCents: line.paidTaxCents - (slice?.taxCents ?? 0) }
    }) }
    const expected = checkoutAmountTotals(before, attempt.totalCents).items
    requireValue(expected.length === attempt.items.length && expected.every(line => {
      const slice = slices.get(line.lineId.toLowerCase()), source = order.items.find(item => sameId(item.lineId, line.lineId))
      return Boolean(slice && source && sameLineIdentity(slice, source) && slice.unitPriceCents === source.unitPriceCents && slice.quantity === line.quantity && slice.totalCents === line.totalCents && slice.discountCents === line.discountCents && slice.taxCents === line.taxCents && slice.allocatedGrossCents === line.allocatedGrossCents)
    }))
    return
  }
  const lines = new Map(order.items.map(line => [line.lineId.toLowerCase(), line]))
  for (const slice of attempt.items) {
    const line = lines.get(slice.lineId.toLowerCase())
    requireValue(Boolean(line) && sameLineIdentity(line!, slice) && line!.unitPriceCents === slice.unitPriceCents && line!.paidQuantity >= slice.quantity)
    const expected = monetaryLineSlice({ ...line!, paidQuantity: line!.paidQuantity - slice.quantity }, slice.quantity)
    requireValue(expected.totalCents === slice.totalCents && expected.discountCents === slice.discountCents && expected.taxCents === slice.taxCents)
  }
}

/** Run before posRequest resolves, so uncertain mutations retain their original durable UUID/payload. */
export function assertFinancialResponse(command: PosCommand, value: unknown): void {
  try {
    if (orderCommands.has(command.command)) {
      assertFinancialOrder(value)
      if ('orderId' in command) requireValue(sameId(value.id, command.orderId))
      if (command.command === 'set_order_discount') requireValue(command.discount === null ? value.discount === null : value.discount?.kind === command.discount.kind && value.discount.value === command.discount.value)
      if (command.command === 'save_order') {
        if (command.orderKind !== undefined) requireValue(value.orderKind === command.orderKind)
        requireValue(value.items.length === command.items.length)
        const lines = new Map(command.items.map(line => [line.lineId.toLowerCase(), line]))
        requireValue(lines.size === command.items.length && value.items.every(line => {
          const requested = lines.get(line.lineId.toLowerCase())
          if (!requested || line.quantity !== requested.quantity || line.unitPriceCents !== requested.unitPriceCents) return false
          if (requested.kind === 'amount') return line.kind === 'amount' && line.productId === null && line.name === requestedAmountName(requested.name)
          return line.kind !== 'amount' && sameId(line.productId!, requested.productId) && line.version === requested.version
        }))
      }
    } else if (attemptCommands.has(command.command)) {
      assertFinancialAttempt(value)
      if ('attemptId' in command) requireValue(sameId(value.id, command.attemptId))
      if (command.command === 'prepare_checkout' || command.command === 'update_checkout') {
        requireValue(value.kind === 'payment' && value.status === 'prepared' && value.paymentMethod === command.paymentMethod)
        if (command.command === 'prepare_checkout') requireValue(sameId(value.orderId!, command.orderId))
        if (command.amountsCents) requireValue(command.items.length === 0 && JSON.stringify(value.amountsCents) === JSON.stringify(command.amountsCents))
        else { requireValue(value.amountsCents === undefined); matchesSelection(value, command.items) }
      }
      if (command.command === 'prepare_reversal') requireValue(value.kind === 'reversal' && sameId(value.originalSaleId!, command.saleId))
      if (command.command === 'start_checkout') requireValue(value.status === 'collection_started')
      if (command.command === 'mark_checkout_uncertain') requireValue(value.status === 'uncertain')
      if (command.command === 'resolve_checkout') requireValue(value.status === (command.resolution === 'complete' ? 'completed' : 'aborted'))
      if (command.command === 'update_checkout' || command.command === 'start_checkout' || command.command === 'mark_checkout_uncertain' || command.command === 'resolve_checkout') requireValue(value.revision > command.expectedRevision)
    } else if (command.command === 'record_checkout' || command.command === 'record_payment') completedPayment(value, command)
    else if (command.command === 'sale' || command.command === 'complete_sale') {
      assertFinancialSale(value)
      if (command.command === 'sale') requireValue(sameId(value.id, command.saleId))
      else {
        requireValue(value.totalCents === command.totalCents && value.paymentMethod === command.paymentMethod && value.items.length === command.items.length)
        const requested = command.items.map(line => JSON.stringify([line.kind === 'amount' ? ['amount', requestedAmountName(line.name)] : ['product', line.productId.toLowerCase()], line.quantity, line.unitPriceCents])).sort()
        const returned = value.items.map(line => JSON.stringify([line.kind === 'amount' ? ['amount', line.name] : ['product', line.productId!.toLowerCase()], line.quantity, line.unitPriceCents])).sort()
        requireValue(requested.every((line, index) => line === returned[index]) && value.items.every(line => (line.discountCents ?? 0) === 0))
      }
    }
    else if (command.command === 'orders' || command.command === 'operations') {
      const result = object(value)
      requireValue(Array.isArray(result.orders))
      const orderIds = new Set<string>()
      for (const order of result.orders) {
        assertFinancialOrder(order)
        requireValue(!orderIds.has(order.id.toLowerCase())); orderIds.add(order.id.toLowerCase())
      }
      if (command.command === 'operations') {
        requireValue(Array.isArray(result.attempts))
        const attemptIds = new Set<string>()
        for (const attempt of result.attempts) {
          assertFinancialAttempt(attempt)
          requireValue(!attemptIds.has(attempt.id.toLowerCase())); attemptIds.add(attempt.id.toLowerCase())
        }
      }
    }
  } catch {
    // A malformed success may have committed. SERVER_ERROR is deliberately uncertain for durable recovery.
    throw new AccountClientError('SERVER_ERROR', 'No pudimos verificar los importes. Conservamos la solicitud para revisarla.')
  }
}
