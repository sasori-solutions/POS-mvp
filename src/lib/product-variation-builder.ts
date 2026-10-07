import type { Variation } from './pos-contracts'

export interface VariationDimension { id: string; name: string; values: string }
export interface VariationPreview { names: string[]; additions: string[]; error: string }

const normalized = (value: string) => value.trim().replace(/\s+/g, ' ')
const key = (value: string) => normalized(value).normalize('NFC').toLocaleLowerCase('es-MX')

/** Generate only a bounded preview; existing prices, codes and identities are never replaced. */
export function previewVariations(dimensions: VariationDimension[], existing: Variation[]): VariationPreview {
  const fail = (error: string): VariationPreview => ({ names: [], additions: [], error })
  if (!dimensions.length) return fail('Añade al menos una opción para crear combinaciones.')
  const groups: string[][] = []
  let count = 1
  for (const dimension of dimensions) {
    if (!normalized(dimension.name)) return fail('Escribe el nombre de cada opción, por ejemplo Tamaño.')
    const seen = new Set<string>()
    const values = dimension.values.split(/[,\n]/).map(normalized).filter(value => {
      if (!value || seen.has(key(value))) return false
      seen.add(key(value))
      return true
    })
    if (!values.length) return fail(`Añade los valores de ${normalized(dimension.name)}.`)
    if (values.some(value => Array.from(value).length > 60)) return fail('Cada valor admite hasta 60 caracteres.')
    count *= values.length
    if (count > 20) return fail('Las opciones generan más de 20 variantes. Reduce los valores.')
    groups.push(values)
  }
  let names = ['']
  for (const values of groups) names = names.flatMap(prefix => values.map(value => prefix ? `${prefix} · ${value}` : value))
  if (new Set(names.map(key)).size !== names.length) return fail('Hay combinaciones con el mismo nombre. Cambia los valores para distinguirlas.')
  if (names.some(name => Array.from(name).length > 60)) return fail('El nombre de una combinación supera 60 caracteres. Abrevia sus valores.')
  const existingNames = new Set(existing.map(variation => key(variation.name)))
  const additions = names.filter(name => !existingNames.has(key(name)))
  if (existing.length + additions.length > 20) return fail('Con las variantes actuales superarías el límite de 20. Quita variantes o reduce las opciones.')
  return { names, additions, error: '' }
}

export function appendVariations(existing: Variation[], names: string[], priceCents: number, uuid: () => string = () => crypto.randomUUID()): Variation[] {
  const seen = new Set(existing.map(variation => key(variation.name)))
  const additions = names.filter(name => {
    if (seen.has(key(name))) return false
    seen.add(key(name))
    return true
  })
  if (existing.length + additions.length > 20 || !Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 99_999_999) throw new Error('Revisa la cantidad de variantes y su precio.')
  if (additions.some(name => !normalized(name) || Array.from(name).length > 60)) throw new Error('Revisa los nombres de las variantes.')
  return [...existing, ...additions.map(name => ({ id: uuid(), name: normalized(name), priceCents, sku: '', barcode: '', soldOut: false }))]
}
