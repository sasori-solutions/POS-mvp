const currency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })

/** Preserve every cent when aggregate totals approach the safe-integer boundary. */
export function integerCurrency(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError('Importe inválido')
  const amount = BigInt(cents), absolute = amount < 0n ? -amount : amount
  const whole = absolute / 100n, fraction = (absolute % 100n).toString().padStart(2, '0')
  const signedWhole = amount < 0n ? whole === 0n ? -0 : -whole : whole
  return currency.formatToParts(signedWhole).map(part => part.type === 'fraction' ? fraction : part.value).join('')
}
