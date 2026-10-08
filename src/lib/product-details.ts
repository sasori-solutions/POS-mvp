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
  for (const set of d.modifierSets) for (const option of set.options) price += option.priceCents * modifierQuantity(selection, option.id)
  return price
}
/** The existing bounded selection array records one identity for each whole extra. */
export function modifierQuantity(selection: ItemSelection | undefined, id: string): number {
  return selection?.modifierIds.filter(value => value === id).length ?? 0
}
export function modifierOptionLimit(option: ProductDetails['modifierSets'][number]['options'][number]): number { return option.maxQuantity ?? 1 }
export function modifierHierarchyIssue(groups: ProductDetails['modifierSets']): string | null {
  for (const group of groups) {
    let current = group, depth = 1
    const seen = new Set([group.id])
    while (current.parentOptionId) {
      const parent = groups.find(candidate => candidate.options.some(option => option.id === current.parentOptionId))
      if (!parent) return `${group.name || 'El grupo'} necesita una opción principal que exista en este producto.`
      if (seen.has(parent.id)) return 'Los grupos dependientes no pueden formar un ciclo.'
      if (++depth > 3) return 'Puedes anidar hasta tres niveles de extras.'
      seen.add(parent.id); current = parent
    }
  }
  return null
}
export function modifierGroupCapacity(set: ProductDetails['modifierSets'][number], availableOnly = false, groups?: ProductDetails['modifierSets']): number {
  return Math.min(24, set.options.reduce((sum, option) => sum + (availableOnly && (option.soldOut || (groups && !modifierOptionAvailable(groups, option.id))) ? 0 : modifierOptionLimit(option)), 0))
}
/** A parent choice is unavailable when its mandatory preparation branch cannot be completed. */
export function modifierOptionAvailable(groups: ProductDetails['modifierSets'], id: string, depth = 1): boolean {
  const option = groups.flatMap(group => group.options).find(option => option.id === id)
  if (!option || option.soldOut || depth > 3) return false
  return groups.filter(group => group.parentOptionId === id).every(group => group.min <= Math.min(24, group.options.reduce((sum, child) => sum + (modifierOptionAvailable(groups, child.id, depth + 1) ? modifierOptionLimit(child) : 0), 0)))
}
export function activeModifierSets(product: Product, selection: ItemSelection): ProductDetails['modifierSets'] {
  const groups = productDetails(product).modifierSets
  const active = new Set(groups.filter(group => !group.parentOptionId).map(group => group.id))
  for (let depth = 0; depth < 3; depth++) for (const group of groups) {
    if (group.parentOptionId && selection.modifierIds.includes(group.parentOptionId) && groups.some(parent => active.has(parent.id) && parent.options.some(option => option.id === group.parentOptionId))) active.add(group.id)
  }
  return groups.filter(group => active.has(group.id))
}
/** Changing a parent drops only descendants that are no longer active. */
export function normalizeModifierIds(product: Product, modifierIds: string[]): string[] {
  const active = activeModifierSets(product, { variationId: null, variablePriceCents: null, modifierIds })
  const ids = new Set(active.flatMap(group => group.options.map(option => option.id)))
  return modifierIds.filter(id => ids.has(id))
}
export function productAvailabilityReason(product: Product): string | null {
  const details = productDetails(product)
  if (details.soldOut) return 'Producto no disponible.'
  if (product.comboUnavailableReason) return product.comboUnavailableReason
  if (details.variations.length && details.variations.every(variation => variation.soldOut)) return 'No hay tamaños disponibles.'
  const required = details.modifierSets.find(set => !set.parentOptionId && set.min > modifierGroupCapacity(set, true, details.modifierSets))
  return required ? `${required.name}: no hay suficientes opciones disponibles para completar este producto.` : null
}
export function selectionIssue(product: Product, selection: ItemSelection): string | null {
  const unavailable = productAvailabilityReason(product)
  if (unavailable) return unavailable
  const details = productDetails(product)
  if (selection.modifierIds.length > 24) return 'Puedes elegir hasta 24 extras por producto.'
  const options = details.modifierSets.flatMap(set => set.options)
  if (selection.modifierIds.some(id => !options.some(option => option.id === id))) return 'Revisa los extras de este producto.'
  const active = activeModifierSets(product, selection)
  if (normalizeModifierIds(product, selection.modifierIds).length !== selection.modifierIds.length) return 'Elige primero la opción principal de estos extras.'
  for (const set of active) {
    let quantity = 0
    for (const option of set.options) {
      const chosen = modifierQuantity(selection, option.id)
      if (chosen && !modifierOptionAvailable(details.modifierSets, option.id)) return `${option.name} no está disponible. Elige otra opción.`
      if (chosen > modifierOptionLimit(option)) return `Puedes elegir hasta ${modifierOptionLimit(option)} de ${option.name}.`
      quantity += chosen
    }
    if (quantity < set.min) return `Elige al menos ${set.min} en ${set.name}.`
    if (quantity > set.max) return `Elige hasta ${set.max} en ${set.name}.`
  }
  const price = selectedPrice(product, selection)
  if (!Number.isSafeInteger(price) || price < 0 || price > 99_999_999) return 'Los ajustes deben dejar un precio entre $0.00 y $999,999.99.'
  return null
}
/** Quick add never supplies an open price or skips a required choice. */
export function quickProductSelection(product: Product): ItemSelection | null {
  const details = productDetails(product)
  if (isSoldOut(product) || details.variablePrice || details.modifierSets.some(set => !set.parentOptionId && set.min > 0)) return null
  const available = details.variations.filter(variation => !variation.soldOut)
  if (details.variations.length && available.length !== 1) return null
  if ((details.variations.length || details.modifierSets.length) && !details.skipCustomization) return null
  return { variationId: available[0]?.id ?? null, modifierIds: [], variablePriceCents: null }
}
export function selectionLabel(product: Product, selection?: ItemSelection): string {
  const d = productDetails(product)
  return [d.variations.find(v => v.id === selection?.variationId)?.name,
    ...d.modifierSets.flatMap(s => s.options.filter(o => modifierQuantity(selection, o.id)).map(o => modifierQuantity(selection, o.id) > 1 ? `${modifierQuantity(selection, o.id)} × ${o.name}` : o.name))].filter(Boolean).join(', ')
}
export function isSoldOut(product: Product): boolean {
  return productAvailabilityReason(product) !== null
}
export function includedTax(cents: number, bps: number): number {
  return Number((BigInt(cents) * BigInt(bps) + BigInt(Math.floor((10000 + bps) / 2))) / BigInt(10000 + bps))
}
