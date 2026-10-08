import { expect, test } from 'vitest'
import { emptyDetails, lineKey, productAvailabilityReason, selectedPrice, selectionIssue, selectionLabel } from '../../src/lib/product-details'
import { modifierPriceInput, parseModifierPrice } from '../../src/lib/modifier-price'
import { parseModifierSet, parseSelection } from '../../supabase/functions/account/product-validation'
import { copyModifierSets } from '../../src/lib/product-modifier-copy'
import { readPendingSale, writePendingSale, type PendingSale } from '../../src/lib/pending-sale'
import type { ItemSelection, ModifierSet, Product } from '../../src/lib/pos-contracts'

const id = '00000000-0000-4000-a000-000000000001', shot = '00000000-0000-4000-a000-000000000002', milk = '00000000-0000-4000-a000-000000000003'
const group: ModifierSet = { id, libraryId: id, name: 'Extras', min: 1, max: 3, options: [{ id: shot, name: 'Shot', priceCents: 101, maxQuantity: 2 }, { id: milk, name: 'Sin leche', priceCents: -300 }] }
const product: Product = { id, version: 1, active: true, name: 'Café', category: '', priceCents: 1001, details: { ...emptyDetails(), modifierSets: [group] } }
const selection: ItemSelection = { variationId: null, modifierIds: [shot, milk, shot], variablePriceCents: null }

test('signed adjustments parse exact decimal cents without changing ordinary price parsing', () => {
  for (const [text, cents] of [['-1.01', -101], ['-0,01', -1], ['0', 0], ['999999.99', 99999999], ['-999999.99', -99999999]] as const) expect(parseModifierPrice(text)).toBe(cents)
  for (const text of ['-', '--1', '-1.001', '+1', '1e2', '-1000000']) expect(parseModifierPrice(text)).toBeNull()
  expect(modifierPriceInput(-101)).toBe('-1.01')
})

test('repeated selections have canonical identity, bounded counts and exact readable snapshots', () => {
  expect(parseSelection(selection)).toEqual({ ...selection, modifierIds: [...selection.modifierIds].sort() })
  expect(selectedPrice(product, selection)).toBe(903)
  expect(selectionIssue(product, selection)).toBeNull()
  expect(selectionLabel(product, selection)).toBe('2 × Shot, Sin leche')
  expect(lineKey({ product, selection })).toBe(lineKey({ product, selection: { ...selection, modifierIds: [milk, shot, shot] } }))
  expect(lineKey({ product, selection })).not.toBe(lineKey({ product, selection: { ...selection, modifierIds: [milk, shot] } }))
  expect(selectionIssue(product, { ...selection, modifierIds: [shot, shot, shot] })).toContain('hasta 2')
  expect(selectionIssue({ ...product, priceCents: 100 }, { ...selection, modifierIds: [milk] })).toContain('entre $0.00')
  expect(parseModifierSet(group)).toEqual(group)
})

test('unavailable choices preserve optional products and block impossible mandatory groups with a reason', () => {
  const unavailable = { ...group, options: group.options.map(option => ({ ...option, soldOut: option.id === shot })) }
  const item = { ...product, details: { ...product.details!, modifierSets: [unavailable] } }
  expect(productAvailabilityReason(item)).toBeNull()
  expect(selectionIssue(item, selection)).toContain('Shot no está disponible')
  expect(productAvailabilityReason({ ...item, details: { ...item.details, modifierSets: [{ ...unavailable, min: 2 }] } })).toContain('Extras')
  expect(productAvailabilityReason({ ...item, details: { ...item.details, modifierSets: [{ ...unavailable, min: 0 }] } })).toBeNull()
})

test('independent copies drop the library identity while preserving repeat limits, availability and signed adjustments', () => {
  let number = 0
  const copy = copyModifierSets([], [{ ...group, options: group.options.map(option => ({ ...option, soldOut: true })) }], () => `fresh-${++number}`)[0]
  expect(copy).not.toHaveProperty('libraryId')
  expect(copy.options[0]).toMatchObject({ maxQuantity: 2, soldOut: true, priceCents: 101 })
  expect(copy.options[1].priceCents).toBe(-300)
})

test('durable sale recovery retains two extra units without persisting access credentials', () => {
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } as Storage
  const command: PendingSale = { command: 'complete_sale', operationId: id, paymentMethod: 'cash', totalCents: 903, items: [{ productId: id, version: 1, quantity: 1, unitPriceCents: 903, selection }] }
  writePendingSale('synthetic', command, storage)
  expect(readPendingSale('synthetic', storage)).toEqual({ ...command, items: [{ ...command.items[0], selection: parseSelection(selection) }] })
})
