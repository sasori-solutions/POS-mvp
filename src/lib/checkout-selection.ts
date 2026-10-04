import type { CheckoutSelection, OperationalOrder } from './operations-contracts'
import type { PaymentMethod } from './contracts'
import { assertMonetaryLineSnapshot, FinancialIntegrityError, maxOperationalLines, maxOperationalMoneyCents, monetaryLineSlice } from './operational-money'

/** UI selection only, kept in memory for the current operator. Never a payment authorization. */
export interface CheckoutDraft {
  orderId: string
  split: boolean
  quantities: Record<string, number>
  method: PaymentMethod
}

/** Same prefix allocation as ops_slice: each cent is charged exactly once. */
export function checkoutTotals(order: OperationalOrder, items: CheckoutSelection[]) {
  if (order.items.length > maxOperationalLines || items.length > maxOperationalLines) throw new FinancialIntegrityError()
  const lines = new Map<string, OperationalOrder['items'][number]>()
  let orderGross = 0
  for (const line of order.items) {
    if (!line.lineId || lines.has(line.lineId)) throw new FinancialIntegrityError()
    assertMonetaryLineSnapshot(line)
    lines.set(line.lineId, line)
    orderGross += line.grossCents
  }
  if (!Number.isSafeInteger(orderGross) || orderGross > maxOperationalMoneyCents) throw new FinancialIntegrityError()
  const selected = new Set<string>()
  let grossCents = 0, discountCents = 0, taxCents = 0
  for (const selection of items) {
    const line = lines.get(selection.lineId)
    if (!line || selected.has(selection.lineId)) throw new FinancialIntegrityError()
    selected.add(selection.lineId)
    const slice = monetaryLineSlice(line, selection.quantity)
    grossCents += slice.grossCents
    discountCents += slice.discountCents
    taxCents += slice.taxCents
  }
  return { grossCents, discountCents, taxCents, totalCents: grossCents - discountCents }
}
export function checkoutSelectionKey(items: CheckoutSelection[]) {
  return JSON.stringify(items.map(({lineId,quantity}) => ({lineId,quantity})).sort((a,b) => a.lineId.localeCompare(b.lineId)))
}
