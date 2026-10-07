import { expect, test } from 'vitest'
import { appendVariations, previewVariations } from '../../src/lib/product-variation-builder'
import type { Variation } from '../../src/lib/pos-contracts'

const existing: Variation = { id: 'existing', name: 'Chico · Caliente', priceCents: 4200, sku: 'LATTE-S', barcode: '750123', soldOut: true }

test('a Cartesian preview deduplicates values and identifies only new combinations', () => {
  expect(previewVariations([{ id: 'size', name: 'Tamaño', values: 'Chico, chico, Grande' }, { id: 'temperature', name: 'Temperatura', values: 'Caliente\nFrío' }], [existing])).toEqual({ names: ['Chico · Caliente', 'Chico · Frío', 'Grande · Caliente', 'Grande · Frío'], additions: ['Chico · Frío', 'Grande · Caliente', 'Grande · Frío'], error: '' })
})

test('appending combinations preserves all existing identities, prices, codes and availability', () => {
  let number = 0
  const next = appendVariations([existing], ['CHICO · Caliente', 'Grande · Frío'], 5500, () => `new-${++number}`)
  expect(next).toEqual([existing, { id: 'new-1', name: 'Grande · Frío', priceCents: 5500, sku: '', barcode: '', soldOut: false }])
  expect(next[0]).toBe(existing)
})

test('a preview rejects excessive combinations before materializing them', () => {
  const result = previewVariations([{ id: 'size', name: 'Tamaño', values: '1,2,3,4,5' }, { id: 'flavor', name: 'Sabor', values: 'a,b,c,d,e' }], [])
  expect(result.error).toContain('más de 20')
  expect(result.names).toEqual([])
})

test('the combined limit counts preserved variants as well as new combinations', () => {
  const result = previewVariations([{ id: 'size', name: 'Tamaño', values: 'Chico,Grande' }], Array.from({ length: 19 }, (_, index) => ({ ...existing, id: `old-${index}`, name: `Otra ${index}` })))
  expect(result.error).toContain('variantes actuales')
})

test('overlong combination labels are rejected instead of silently truncated or duplicated', () => {
  expect(previewVariations([{ id: 'size', name: 'Tamaño', values: 'a'.repeat(31) }, { id: 'flavor', name: 'Sabor', values: 'b'.repeat(31) }], []).error).toContain('supera 60')
})

test('ambiguous joined option values fail visibly instead of merging different combinations', () => {
  const result = previewVariations([{ id: 'first', name: 'Primera', values: 'A, A · B' }, { id: 'second', name: 'Segunda', values: 'B · C, C' }], [])
  expect(result.error).toContain('mismo nombre')
  expect(result.names).toEqual([])
  expect(result.additions).toEqual([])
})

test('append requires valid integer cents and respects the variant bound', () => {
  expect(() => appendVariations([], ['Chico'], 12.5)).toThrow()
  expect(() => appendVariations(Array.from({ length: 20 }, (_, index) => ({ ...existing, name: `Otra ${index}` })), ['Chico'], 100)).toThrow()
  expect(appendVariations([], ['Gratis'], 0, () => 'zero')[0].priceCents).toBe(0)
})
