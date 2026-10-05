import type { OperationalOrder } from './operations-contracts'
import { FinancialIntegrityError, maxOperationalMoneyCents, monetaryLineSlice, parseOperationalMoney } from './operational-money'

export function amountPlan(balanceCents: number, inputs: string[]) {
  if (!Number.isSafeInteger(balanceCents) || balanceCents <= 0 || balanceCents > maxOperationalMoneyCents || inputs.length > 19) return null
  const amounts: number[] = []
  let sum = 0
  for (const input of inputs) {
    const amount = parseOperationalMoney(input)
    if (amount === null || amount <= 0) return null
    sum += amount
    if (sum >= balanceCents) return null
    amounts.push(amount)
  }
  return [...amounts, balanceCents - sum]
}

export function amountInput(cents: number) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** Mirrors the private monetary quote. Product choice never comes from the client. */
export function checkoutAmountTotals(order: OperationalOrder, amountCents: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > order.balanceCents) throw new FinancialIntegrityError()
  let available = amountCents, discountCents = 0, taxCents = 0
  const items: { lineId: string; quantity: number; totalCents: number; discountCents: number; taxCents: number; allocatedGrossCents: number }[] = []
  for (const line of [...order.items].sort((a, b) => a.lineId.toLowerCase().localeCompare(b.lineId.toLowerCase()))) {
    if (line.quantity === line.paidQuantity) continue
    const unpaid = monetaryLineSlice(line, line.quantity - line.paidQuantity)
    const remaining = line.paidTotalCents === undefined ? unpaid.totalCents : line.totalCents - line.paidTotalCents
    const discount = line.paidDiscountCents === undefined ? unpaid.discountCents : line.discountCents - line.paidDiscountCents
    const tax = line.paidTaxCents === undefined ? unpaid.taxCents : line.taxCents - line.paidTaxCents
    if (remaining < 0 || discount < 0 || tax < 0 || tax > remaining) throw new FinancialIntegrityError()
    const take = Math.min(available, remaining)
    if (take > 0 || remaining === 0) {
      const allocatedDiscount = remaining === 0 ? discount : Number(BigInt(discount) * BigInt(take) / BigInt(remaining))
      const allocatedTax = remaining === 0 ? tax : Number(BigInt(tax) * BigInt(take) / BigInt(remaining))
      discountCents += allocatedDiscount
      taxCents += allocatedTax
      items.push({ lineId: line.lineId, quantity: take === remaining ? line.quantity - line.paidQuantity : 0, totalCents: take, discountCents: allocatedDiscount, taxCents: allocatedTax, allocatedGrossCents: take + allocatedDiscount })
    }
    available -= take
  }
  if (available !== 0) throw new FinancialIntegrityError()
  return { grossCents: amountCents + discountCents, discountCents, taxCents, totalCents: amountCents, items }
}
