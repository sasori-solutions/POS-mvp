import type { ModifierSet } from './pos-contracts'

/** Copy a tenant catalog template; generated identities make all edits independent. */
export function copyModifierSets(existing: ModifierSet[], source: ModifierSet[], uuid: () => string = () => crypto.randomUUID()): ModifierSet[] {
  if (existing.length + source.length > 6) throw new Error('Puedes guardar hasta 6 grupos de extras. Quita grupos antes de copiar estos.')
  if ([...existing, ...source].reduce((total, set) => total + set.min, 0) > 24) throw new Error('Los grupos pueden exigir como máximo 24 selecciones en total. Reduce los mínimos antes de copiar.')
  return [
    ...existing,
    ...source.map(set => ({ ...set, id: uuid(), options: set.options.map(option => ({ ...option, id: uuid() })) })),
  ]
}
