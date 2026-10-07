import type { AmountCartLine, ProductCartLine, ItemSelection, Product, ProductDetails } from './pos-contracts'

export function emptyDetails(): ProductDetails {
  return { description: '', imageId: null, tileColor: '#E8EEF8', tileLabel: '', itemType: 'prepared',
    customerName: '', kitchenName: '', sku: '', barcode: '', soldOut: false, favorite: false, variablePrice: false,
    trackStock: false, stock: 0, lowStockAlert: 5, costCents: null, taxBps: 0, calories: null,
    dietary: '', allergens: '', variations: [], modifierSets: [] }
}
export function productDetails(product: Product): ProductDetails {
  return { ...emptyDetails(), ...product.details, trackStock: false }
}
/** Choose readable text for a saved six-digit sRGB tile color. */
export function tileForegroundColor(color: string): '#111111' | '#FFFFFF' {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return '#111111'
  const channels = [1, 3, 5].map(start => {
    const channel = parseInt(color.slice(start, start + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  // The ink token has luminance 0.0056; use white below the contrast crossover.
  return luminance < 0.191 ? '#FFFFFF' : '#111111'
}
export function lineKey(line: Pick<ProductCartLine, 'product' | 'selection'> | AmountCartLine): string {
  if ('kind' in line && line.kind === 'amount') return `amount:${line.id}`
  if (!('product' in line)) throw new Error('Revisa el artículo de la cuenta.')
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
/** Quick add never supplies an open price or skips a required choice. */
export function quickProductSelection(product: Product): ItemSelection | null {
  const details = productDetails(product)
  if (isSoldOut(product) || details.variablePrice || details.modifierSets.some(set => set.min > 0)) return null
  const available = details.variations.filter(variation => !variation.soldOut)
  if (details.variations.length && available.length !== 1) return null
  if ((details.variations.length || details.modifierSets.length) && !details.skipCustomization) return null
  return { variationId: available[0]?.id ?? null, modifierIds: [], variablePriceCents: null }
}
export function selectionLabel(product: Product, selection?: ItemSelection): string {
  const d = productDetails(product)
  return [d.variations.find(v => v.id === selection?.variationId)?.name,
    ...d.modifierSets.flatMap(s => s.options.filter(o => selection?.modifierIds.includes(o.id)).map(o => o.name))].filter(Boolean).join(', ')
}
export function isSoldOut(product: Product): boolean {
  const d = productDetails(product)
  return d.soldOut || (d.variations.length > 0 && d.variations.every(v => v.soldOut))
}
export function includedTax(cents: number, bps: number): number {
  return Number((BigInt(cents) * BigInt(bps) + BigInt(Math.floor((10000 + bps) / 2))) / BigInt(10000 + bps))
}
