import type { CheckoutSelection, OperationalOrder } from './operations-contracts'

/** Same prefix allocation as ops_slice: each cent is charged exactly once. */
export function checkoutTotals(order: OperationalOrder, items: CheckoutSelection[]) {
  let grossCents = 0, discountCents = 0, taxCents = 0
  for (const selection of items) {
    const line = order.items.find(item => item.lineId === selection.lineId)
    if (!line || !Number.isInteger(selection.quantity) || selection.quantity < 0 || selection.quantity > line.quantity - line.paidQuantity) throw new Error('Selección de cobro inválida.')
    const quantity = BigInt(line.quantity), paid = BigInt(line.paidQuantity), end = paid + BigInt(selection.quantity)
    const discount = BigInt(line.discountCents), unit = BigInt(line.unitPriceCents)
    const prefixDiscount = (n: bigint) => discount * n / quantity
    const prefixTax = (n: bigint) => line.totalCents === 0 ? 0n : BigInt(line.taxCents) * (unit * n - prefixDiscount(n)) / BigInt(line.totalCents)
    grossCents += line.unitPriceCents * selection.quantity
    discountCents += Number(prefixDiscount(end) - prefixDiscount(paid))
    taxCents += Number(prefixTax(end) - prefixTax(paid))
  }
  return { grossCents, discountCents, taxCents, totalCents: grossCents - discountCents }
}
export function checkoutSelectionKey(items: CheckoutSelection[]) {
  return JSON.stringify(items.map(({lineId,quantity}) => ({lineId,quantity})).sort((a,b) => a.lineId.localeCompare(b.lineId)))
}
