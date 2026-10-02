import type { CartLine, ItemSelection, Product, ProductDetails } from './pos-contracts'

export function emptyDetails(): ProductDetails {
  return { description: '', imageId: null, tileColor: '#E8EEF8', tileLabel: '', itemType: 'prepared',
    customerName: '', kitchenName: '', sku: '', barcode: '', soldOut: false, favorite: false, variablePrice: false,
    trackStock: false, stock: 0, lowStockAlert: 5, costCents: null, taxBps: 0, calories: null,
    dietary: '', allergens: '', variations: [], modifierSets: [] }
}
export function productDetails(product: Product): ProductDetails { return { ...emptyDetails(), ...product.details } }
export function lineKey(line: Pick<CartLine, 'product' | 'selection'>): string {
  const s = line.selection
  return `${line.product.id}:${s?.variationId ?? ''}:${[...(s?.modifierIds ?? [])].sort().join(',')}:${s?.variablePriceCents ?? ''}`
}
export function selectedPrice(product: Product, selection?: ItemSelection): number {
  const d = productDetails(product)
  const variation = d.variations.find(v => v.id === selection?.variationId)
  let price = d.variablePrice ? selection?.variablePriceCents ?? product.priceCents : variation?.priceCents ?? product.priceCents
  for (const set of d.modifierSets) for (const option of set.options) if (selection?.modifierIds.includes(option.id)) price += option.priceCents
  return price
}
export function selectionLabel(product: Product, selection?: ItemSelection): string {
  const d = productDetails(product)
  return [d.variations.find(v => v.id === selection?.variationId)?.name,
    ...d.modifierSets.flatMap(s => s.options.filter(o => selection?.modifierIds.includes(o.id)).map(o => o.name))].filter(Boolean).join(', ')
}
export function isSoldOut(product: Product): boolean {
  const d = productDetails(product)
  return d.soldOut || (d.trackStock && d.stock === 0) || (d.variations.length > 0 && d.variations.every(v => v.soldOut))
}
export function includedTax(cents: number, bps: number): number {
  return Number((BigInt(cents) * BigInt(bps) + BigInt(Math.floor((10000 + bps) / 2))) / BigInt(10000 + bps))
}
