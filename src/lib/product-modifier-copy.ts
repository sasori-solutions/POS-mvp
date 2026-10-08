import type { ModifierSet } from './pos-contracts'

/** Copy a tenant catalog template; generated identities make all edits independent. */
export function copyModifierSets(existing: ModifierSet[], source: ModifierSet[], uuid: () => string = () => crypto.randomUUID()): ModifierSet[] {
  if (existing.length + source.length > 6) throw new Error('Puedes guardar hasta 6 grupos de extras. Quita grupos antes de copiar estos.')
  if ([...existing, ...source].reduce((total, set) => total + set.min, 0) > 24) throw new Error('Los grupos pueden exigir como máximo 24 selecciones en total. Reduce los mínimos antes de copiar.')
  const optionIds = new Map<string, string>()
  const copies = source.map(set => ({ id: uuid(), name: set.name, min: set.min, max: set.max, options: set.options.map(option => {
    const id = uuid(); optionIds.set(option.id, id); return { ...option, id }
  }) }))
  return [
    ...existing,
    ...copies.map((set, index) => ({ ...set,
      ...(source[index].parentOptionId ? { parentOptionId: optionIds.get(source[index].parentOptionId!) ?? source[index].parentOptionId } : {}) })),
  ]
}
