export const maxOperationalMoneyCents = 9_999_999_999
export const maxOperationalUnitPriceCents = 99_999_999
export const maxOperationalQuantity = 999
export const maxOperationalLines = 40

/** A stored allocation basis. Tax is historical included tax, never recalculated. */
export interface MonetaryLineSnapshot {
  quantity: number
  paidQuantity: number
  unitPriceCents: number
  grossCents: number
  discountCents: number
  totalCents: number
  taxCents: number
}

export class FinancialIntegrityError extends Error {
  constructor() { super('No pudimos verificar los importes de la cuenta.'); this.name = 'FinancialIntegrityError' }
}

export function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

/** Reject invalid snapshots before any preview, including an empty or zero selection. */
export function assertMonetaryLineSnapshot(line: MonetaryLineSnapshot): void {
  if (!isBoundedInteger(line.quantity, 1, maxOperationalQuantity)
    || !isBoundedInteger(line.paidQuantity, 0, line.quantity)
    || !isBoundedInteger(line.unitPriceCents, 0, maxOperationalUnitPriceCents)
    || !isBoundedInteger(line.grossCents, 0, maxOperationalMoneyCents)
    || !isBoundedInteger(line.discountCents, 0, line.grossCents)
    || !isBoundedInteger(line.totalCents, 0, line.grossCents)
    || !isBoundedInteger(line.taxCents, 0, line.totalCents)
    || BigInt(line.grossCents) !== BigInt(line.quantity) * BigInt(line.unitPriceCents)
    || line.totalCents !== line.grossCents - line.discountCents) throw new FinancialIntegrityError()
}

/** Mirrors ops_slice's cumulative allocation. Every historical discount/IVA cent is conserved. */
export function monetaryLineSlice(line: MonetaryLineSnapshot, selectedQuantity: number) {
  assertMonetaryLineSnapshot(line)
  if (!isBoundedInteger(selectedQuantity, 0, line.quantity - line.paidQuantity)) throw new FinancialIntegrityError()
  const quantity = BigInt(line.quantity), paid = BigInt(line.paidQuantity), end = paid + BigInt(selectedQuantity)
  const discount = BigInt(line.discountCents), unit = BigInt(line.unitPriceCents)
  const prefixDiscount = (count: bigint) => discount * count / quantity
  const prefixTax = (count: bigint) => line.totalCents === 0 ? 0n : BigInt(line.taxCents) * (unit * count - prefixDiscount(count)) / BigInt(line.totalCents)
  const grossCents = Number(unit * BigInt(selectedQuantity))
  const discountCents = Number(prefixDiscount(end) - prefixDiscount(paid))
  const taxCents = Number(prefixTax(end) - prefixTax(paid))
  return { grossCents, discountCents, taxCents, totalCents: grossCents - discountCents }
}

/** Parse decimal digits into integer cents, without a binary floating point price. */
export function parseOperationalMoney(value: string): number | null {
  const match = value.trim().replace(',', '.').match(/^(\d{1,8})(?:\.(\d{1,2}))?$/)
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return cents <= maxOperationalMoneyCents ? cents : null
}
