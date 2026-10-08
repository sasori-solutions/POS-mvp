import type { ItemSelection, ModifierSet, ProductDetails, VatTreatment } from '../../../src/lib/pos-contracts.ts'
import { isUuid, RequestValidationError } from './validation.ts'

function fail(): never { throw new RequestValidationError() }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some(k => !Object.hasOwn(record, k))) fail()
  return record
}
function string(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string' || Array.from(value).length > max || value.length < min || /[\u0000-\u001f\u007f]/.test(value)) fail()
  return value.trim()
}
function integer(value: unknown, max: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail()
  return value
}
function uuid(value: unknown): string { if (!isUuid(value)) fail(); return value }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail(); return value }
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) fail(); return value }

export function parseSelection(value: unknown): ItemSelection {
  const s = object(value, ['variationId', 'modifierIds', 'variablePriceCents'])
  const ids = array(s.modifierIds, 24).map(uuid).sort()
  return { variationId: s.variationId === null ? null : uuid(s.variationId), modifierIds: ids,
    variablePriceCents: s.variablePriceCents === null ? null : integer(s.variablePriceCents, 99_999_999) }
}
export function parseModifierSet(value: unknown): ModifierSet {
  const shared = Boolean(value && typeof value === 'object' && Object.hasOwn(value, 'libraryId'))
  const nested = Boolean(value && typeof value === 'object' && Object.hasOwn(value, 'parentOptionId'))
  const s = object(value, ['id', 'name', 'min', 'max', 'options', ...(shared ? ['libraryId'] : []), ...(nested ? ['parentOptionId'] : [])])
  const options = array(s.options, 12).map(value => {
    const optional = ['soldOut', 'maxQuantity'].filter(key => Boolean(value && typeof value === 'object' && Object.hasOwn(value, key)))
    const o = object(value, ['id', 'name', 'priceCents', ...optional])
    const name = string(o.name, 60, 1)
    if (!name) fail()
    return { id: uuid(o.id), name, priceCents: integer(o.priceCents, 99_999_999, -99_999_999),
      ...(Object.hasOwn(o, 'soldOut') ? { soldOut: bool(o.soldOut) } : {}),
      ...(Object.hasOwn(o, 'maxQuantity') ? { maxQuantity: integer(o.maxQuantity, 24, 1) } : {}) }
  })
  if (!options.length) fail()
  const capacity = Math.min(24, options.reduce((sum, option) => sum + (option.maxQuantity ?? 1), 0))
  const min = integer(s.min, capacity), max = integer(s.max, capacity, 1), id = uuid(s.id), name = string(s.name, 60, 1)
  if (!name || min > max || new Set([id, ...options.map(option => option.id)]).size !== options.length + 1) fail()
  const libraryId = shared ? uuid(s.libraryId) : undefined
  if (libraryId && libraryId !== id) fail()
  return { id, name, min, max, options, ...(shared ? { libraryId } : {}), ...(nested ? { parentOptionId: uuid(s.parentOptionId) } : {}) }
}
export function parseProductDetails(value: unknown): ProductDetails {
  const explicitTax = Boolean(value && typeof value === 'object' && Object.hasOwn(value, 'taxTreatment'))
  const optionalKeys = ['skipCustomization', 'customAttributes', 'comboComponents'].filter(key => Boolean(value && typeof value === 'object' && Object.hasOwn(value, key)))
  const d = object(value, ['description', 'imageId', 'tileColor', 'tileLabel', 'itemType', 'customerName', 'kitchenName', 'sku', 'barcode',
    'soldOut', 'favorite', 'variablePrice', 'trackStock', 'stock', 'lowStockAlert', 'costCents', 'taxBps', 'calories', 'dietary', 'allergens', 'variations', 'modifierSets', ...(explicitTax ? ['taxTreatment'] : []), ...optionalKeys])
  if (!['prepared', 'physical', 'service', 'digital', 'event', 'other'].includes(d.itemType as string) || typeof d.tileColor !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(d.tileColor)) fail()
  if (explicitTax) {
    const rates: Record<string, number> = { vat_16: 1600, vat_0: 0, exempt: 0, border_8: 800, unconfigured: 0 }
    if (typeof d.taxTreatment !== 'string' || !Object.hasOwn(rates, d.taxTreatment) || d.taxBps !== rates[d.taxTreatment]) fail()
  }
  const variations = array(d.variations, 20).map(value => {
    const v = object(value, ['id', 'name', 'priceCents', 'sku', 'barcode', 'soldOut'])
    return { id: uuid(v.id), name: string(v.name, 60, 1), priceCents: integer(v.priceCents, 99_999_999), sku: string(v.sku, 60), barcode: string(v.barcode, 32), soldOut: bool(v.soldOut) }
  })
  const modifierSets = array(d.modifierSets, 6).map(parseModifierSet)
  const comboComponents = Object.hasOwn(d, 'comboComponents') ? array(d.comboComponents, 8).map(value => {
    const explicit = Boolean(value && typeof value === 'object' && Object.hasOwn(value, 'selection'))
    const c = object(value, ['productId', 'version', 'quantity', ...(explicit ? ['selection'] : [])])
    return { productId: uuid(c.productId), version: integer(c.version, 2_147_483_647, 1), quantity: integer(c.quantity, 24, 1), ...(explicit ? { selection: parseSelection(c.selection) } : {}) }
  }) : []
  if (comboComponents.length && (d.variablePrice || variations.length)) fail()
  if (new Set(comboComponents.map(component => JSON.stringify([component.productId, component.selection ?? null]))).size !== comboComponents.length) fail()
  for (const group of modifierSets) {
    let current = group, depth = 1
    const seen = new Set([group.id])
    while (current.parentOptionId) {
      const parent = modifierSets.find(set => set.options.some(option => option.id === current.parentOptionId))
      if (!parent || seen.has(parent.id) || ++depth > 3) fail()
      seen.add(parent.id); current = parent
    }
  }
  const customAttributes = Object.hasOwn(d, 'customAttributes') ? array(d.customAttributes, 8).map(value => {
    const attribute = object(value, ['name', 'value'])
    const name = string(attribute.name, 40, 1), content = string(attribute.value, 120, 1)
    if (!name || !content) fail()
    return { name, value: content }
  }) : []
  const attributeNames = customAttributes.map(attribute => attribute.name.normalize('NFC').toLowerCase())
  if (new Set(attributeNames).size !== attributeNames.length) fail()
  const ids = [...variations.map(v => v.id), ...modifierSets.flatMap(s => [s.id, ...s.options.map(o => o.id)])]
  if (new Set(ids).size !== ids.length || (d.variablePrice && variations.length)
    || modifierSets.reduce((sum, set) => sum + set.min, 0) > 24) fail()
  return { description: string(d.description, 1000), imageId: d.imageId === null ? null : uuid(d.imageId), tileColor: d.tileColor, tileLabel: string(d.tileLabel, 8),
    itemType: d.itemType as ProductDetails['itemType'], customerName: string(d.customerName, 100), kitchenName: string(d.kitchenName, 100), sku: string(d.sku, 60), barcode: string(d.barcode, 32),
    soldOut: bool(d.soldOut), favorite: bool(d.favorite), variablePrice: bool(d.variablePrice), trackStock: bool(d.trackStock), stock: integer(d.stock, 999999), lowStockAlert: integer(d.lowStockAlert, 999999),
    costCents: d.costCents === null ? null : integer(d.costCents, 99_999_999), taxBps: integer(d.taxBps, 10000), calories: d.calories === null ? null : integer(d.calories, 100000),
    dietary: string(d.dietary, 200), allergens: string(d.allergens, 200), variations, modifierSets, ...(explicitTax ? {taxTreatment: d.taxTreatment as VatTreatment} : {}),
    ...(Object.hasOwn(d, 'skipCustomization') ? { skipCustomization: bool(d.skipCustomization) } : {}),
    ...(Object.hasOwn(d, 'customAttributes') ? { customAttributes } : {}),
    ...(Object.hasOwn(d, 'comboComponents') ? { comboComponents } : {}) }
}
