import { expect, test } from 'vitest'
import { copyModifierSets } from '../../src/lib/product-modifier-copy'
import type { ModifierSet } from '../../src/lib/pos-contracts'

const group: ModifierSet = { id: 'source', name: 'Leche', min: 0, max: 1, options: [{ id: 'source-option', name: 'Avena', priceCents: 1200 }] }

test('copying modifier templates generates fresh group and option identities without mutating the source', () => {
  let number = 0
  const existing = { ...group, id: 'existing', name: 'Jarabe' }
  const copied = copyModifierSets([existing], [group], () => `copy-${++number}`)
  expect(copied).toEqual([existing, { ...group, id: 'copy-1', options: [{ ...group.options[0], id: 'copy-2' }] }])
  expect(copied[0]).toBe(existing)
  expect(copied[1]).not.toBe(group)
  expect(group.id).toBe('source')
})

test('copying rejects both group-count and total required-selection limits atomically', () => {
  expect(() => copyModifierSets(Array.from({ length: 6 }, () => group), [group])).toThrow('6 grupos')
  const required = { ...group, min: 12, max: 12 }
  expect(() => copyModifierSets([required, required], [{ ...group, min: 1 }])).toThrow('24 selecciones')
})
