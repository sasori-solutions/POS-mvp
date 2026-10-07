import { parsePrice, priceInput } from './pos'

/** Signed catalog adjustment; amounts remain integer cents. */
export function parseModifierPrice(value: string): number | null {
  const text = value.trim()
  const cents = parsePrice(text.startsWith('-') ? text.slice(1) : text)
  return cents === null ? null : text.startsWith('-') ? -cents : cents
}
export function modifierPriceInput(cents: number): string {
  return `${cents < 0 ? '-' : ''}${priceInput(Math.abs(cents))}`
}
