import type { OrderDiscount } from '../../lib/operations-contracts'
import { maxOperationalMoneyCents, parseOperationalMoney } from '../../lib/operational-money'

export function discountInputValue(value: number): string {
  const integer = BigInt(value)
  return `${integer / 100n}.${String(integer % 100n).padStart(2, '0')}`
}

/** Fixed values are cents; percentage values are basis points, matching the RPC. */
export function parseOrderDiscount(kind: OrderDiscount['kind'], input: string, grossCents: number): number | null {
  // Preserve a valid preview while the person types the decimal separator.
  const decimal = input.trim().replace(',', '.')
  const numeric = /^\d+\.$/.test(decimal) ? decimal.slice(0, -1) : /^\.\d{1,2}$/.test(decimal) ? `0${decimal}` : decimal
  const value = parseOperationalMoney(numeric)
  if (value === null || !Number.isSafeInteger(grossCents) || grossCents < 0 || grossCents > maxOperationalMoneyCents) return null
  if (kind === 'percent' ? value > 10_000 : value > grossCents) return null
  return value
}

/** Mirrors PostgreSQL round() for nonnegative money without binary decimal arithmetic. */
export function orderDiscountPreview(grossCents: number, kind: OrderDiscount['kind'], value: number | null): { discountCents: number; totalCents: number } | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(grossCents) || grossCents < 0 || grossCents > maxOperationalMoneyCents) return null
  if (kind === 'percent' ? value > 10_000 : value > grossCents) return null
  const gross = BigInt(grossCents)
  const discount = kind === 'fixed' ? BigInt(value) : (gross * BigInt(value) + 5_000n) / 10_000n
  return { discountCents: Number(discount), totalCents: Number(gross - discount) }
}

export function discountReason(reason: string): string | null {
  if (/\p{Cc}/u.test(reason)) return null
  const normalized = reason.trim().replace(/\s+/g, ' ')
  return normalized.length > 0 && Array.from(normalized).length <= 200 ? normalized : null
}
