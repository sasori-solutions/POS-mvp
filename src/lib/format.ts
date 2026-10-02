const currency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
const numbers = new Intl.NumberFormat('es-MX')
export function money(cents: number): string { return currency.format(cents / 100) }
export function number(value: number): string { return numbers.format(value) }
export function saleDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value))
}
