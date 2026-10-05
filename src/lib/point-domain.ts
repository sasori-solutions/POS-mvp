import type { PointPaymentState } from './point-contracts.ts'

const MAX_CENTS = 9_999_999_999
export function exactCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) throw new Error('INVALID_MONEY')
  return value
}
export function providerAmount(cents: number): string {
  const value = BigInt(exactCents(cents))
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`
}
export function parseProviderAmount(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new Error('INVALID_MONEY')
  const [whole, decimal = ''] = value.split('.')
  return exactCents(Number(BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'))))
}
/** Signed half away from zero. Exact integer numerator until the period closes. */
export function roundNumerator(numerator: bigint, denominator = 10_000n): bigint {
  if (denominator <= 0n) throw new Error('INVALID_DENOMINATOR')
  const sign = numerator < 0n ? -1n : 1n
  const absolute = numerator * sign
  return sign * ((absolute + denominator / 2n) / denominator)
}
export function monthlyCommission(entries: { baseCents: number; rateBps: number; direction: 1 | -1 }[], vatBps: number) {
  if (!Number.isInteger(vatBps) || vatBps < 0 || vatBps > 10_000) throw new Error('INVALID_RATE')
  const numerator = entries.reduce((sum, entry) => {
    if (!Number.isInteger(entry.rateBps) || entry.rateBps < 0 || entry.rateBps > 10_000) throw new Error('INVALID_RATE')
    return sum + BigInt(exactCents(entry.baseCents)) * BigInt(entry.rateBps) * BigInt(entry.direction)
  }, 0n)
  const net = roundNumerator(numerator)
  const vat = roundNumerator(net * BigInt(vatBps))
  return { exactNumerator: numerator.toString(), netCents: Number(net), vatCents: Number(vat), totalCents: Number(net + vat) }
}
export function mapPointState(status: string, detail: string, transactionStatus: string, transactionDetail: string): PointPaymentState {
  if (status === 'action_required' || transactionStatus === 'action_required' || detail === 'action_required' || transactionDetail === 'in_review') return 'unknown_review'
  if (status === 'refunded' && detail === 'refunded' && ['processed','refunded'].includes(transactionStatus)) return 'refunded'
  if (status === 'processed' && detail === 'partially_refunded' && transactionStatus === 'processed') return 'partially_refunded'
  if (status === 'processed' && ['processed', 'accredited'].includes(detail) && transactionStatus === 'processed' && ['processed', 'accredited'].includes(transactionDetail)) return 'approved_verified'
  const definitive = ['failed','bad_filled_card_data','insufficient_amount','high_risk','rejected_by_issuer','required_call_for_authorize','max_attempts_exceeded','card_disabled','amount_limit_exceeded','invalid_installments','processing_error']
  if (status === 'failed' && detail === 'failed' && transactionStatus === 'failed' && definitive.includes(transactionDetail)) return 'rejected'
  if (status === 'canceled' && ['canceled','canceled_by_api','canceled_on_terminal'].includes(detail) && transactionStatus === 'canceled' && ['canceled','canceled_by_api','canceled_on_terminal','cancel_by_terminal'].includes(transactionDetail)) return 'cancelled'
  if (status === 'expired' && detail === 'expired' && ['created','expired'].includes(transactionStatus)) return 'expired'
  if (status === 'at_terminal' && detail === 'at_terminal' && ['created','at_terminal'].includes(transactionStatus)) return 'sent_to_terminal'
  if (status === 'created' && detail === 'created' && transactionStatus === 'created') return 'pending'
  return 'unknown_review'
}
export function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}
