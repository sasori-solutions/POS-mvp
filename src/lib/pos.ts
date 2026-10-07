import { accountRequest, deviceRequest } from './account'
import { selectedPrice } from './product-details'
import { assertFinancialResponse } from './financial-response'
export { money, saleDate } from './format'
import type { PosCommand, PosResponses, CartLine, Product } from './pos-contracts'

export const maxProductPrice = 99_999_999
export const maxSaleTotal = 9_999_999_999
export const maxQuantity = 999
export const maxSaleLines = 40

/** Parse decimal text without multiplying a floating point price. */
export function parsePrice(value: string): number | null {
  const text = value.trim().replace(',', '.')
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return cents <= maxProductPrice ? cents : null
}

export function priceInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

export function cartTotal(lines: CartLine[]): number {
  if (lines.length > maxSaleLines) throw new Error(`La venta admite hasta ${maxSaleLines} productos distintos.`)
  let total = 0
  for (const { product, quantity, selection } of lines) {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity
      || !Number.isInteger(product.priceCents) || product.priceCents < 0 || product.priceCents > maxProductPrice) {
      throw new Error('Revisa las cantidades y los precios de la venta.')
    }
    const price = selectedPrice(product, selection)
    if (!Number.isSafeInteger(price) || price < 0 || price > maxProductPrice) throw new Error('Revisa el precio del producto.')
    total += quantity * price
  }
  if (!Number.isSafeInteger(total) || total > maxSaleTotal) throw new Error('El total supera el límite de esta venta.')
  return total
}

export function searchText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-MX').trim()
}

export function filterProducts(products: Product[], query: string, category: string): Product[] {
  const search = searchText(query)
  return products.filter(product => (!category || product.category === category)
    && (!search || searchText([product.name, product.details?.customerName, product.details?.kitchenName, product.details?.sku, product.details?.barcode,
      ...product.details?.customAttributes?.map(attribute => `${attribute.name} ${attribute.value}`) ?? [],
      ...product.details?.variations?.map(v => `${v.name} ${v.sku} ${v.barcode}`) ?? []].join(' ')).includes(search)))
}

export interface PosAccess { businessId: string; operatorToken: string; deviceToken?: string }

export async function posRequest<C extends PosCommand['command']>(
  access: PosAccess, command: Extract<PosCommand, { command: C }>,
): Promise<PosResponses[C]> {
  const result = access.deviceToken
    ? await deviceRequest({ action: 'device_pos', deviceToken: access.deviceToken, operatorToken: access.operatorToken, ...command })
    : await accountRequest({ action: 'pos', businessId: access.businessId, operatorToken: access.operatorToken, ...command })
  assertFinancialResponse(command, result)
  return result as PosResponses[C]
}
