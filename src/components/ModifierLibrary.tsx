import { useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { ModifierSet, PosCommand, Product, SharedModifierGroup } from '../lib/pos-contracts'
import { modifierPriceInput, parseModifierPrice } from '../lib/modifier-price'
import { modifierGroupCapacity } from '../lib/product-details'
import { posRequest, type PosAccess } from '../lib/pos'
import ModifierGroupFields from './ModifierGroupFields'
import { PosDialog } from './PosShared'
import { accessErrorCodes } from './useCatalog'
import { useModifierLibrary } from './useModifierLibrary'

export default function ModifierLibrary({ access, onProductsChanged, onSessionError }: {
  access: PosAccess; onProductsChanged: (products: Product[]) => void; onSessionError?: (error: AccountClientError) => void
}) {
  const library = useModifierLibrary(access, true, onSessionError)
  const [editing, setEditing] = useState<SharedModifierGroup | 'new' | null>(null), [message, setMessage] = useState('')
  return <section aria-label="Biblioteca de extras" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-lg font-medium">Biblioteca de extras</h2><p className="mt-2 max-w-160 text-sm text-muted">Crea grupos para varios productos. Al editar un grupo, todos sus productos enlazados se actualizan. Las cuentas ya creadas conservan sus elecciones y precios.</p></div>
      <button className="pos-button pos-primary" onClick={() => setEditing('new')}>Crear grupo compartido</button>
    </div>
    {message && <p role="status" className="text-sm text-muted">{message}</p>}
    {library.loading && <p role="status">Cargando biblioteca…</p>}
    {library.error && <div role="alert" className="pos-error"><p>{library.error}</p><button className="pos-button pos-secondary" onClick={() => void library.refresh()}>Reintentar biblioteca</button></div>}
    {!library.loading && !library.error && !library.groups.length && <p className="rounded-lg bg-surface p-6 text-sm">Todavía no hay grupos. Por ejemplo, crea “Leche” y enlázalo a tus cafés desde el editor de cada producto.</p>}
    <ul className="m-0 list-none border-t border-line p-0">{library.groups.map(group => <li key={group.id} className="flex flex-wrap items-center justify-between gap-4 border-b border-line py-4">
      <div className="min-w-0 flex-1"><strong className="font-medium">{group.name}</strong><p className="mt-1 text-sm text-muted">{group.options.length} opciones · {group.linkedProducts.length} productos enlazados</p><p className="mt-1 text-sm [overflow-wrap:anywhere]">{group.linkedProducts.map(product => product.name).join(', ') || 'Disponible para enlazar'}</p></div>
      <button className="pos-button pos-secondary" aria-label={`Editar grupo ${group.name}`} onClick={() => setEditing(group)}>Editar grupo</button>
    </li>)}</ul>
    {editing && <SharedGroupEditor group={editing === 'new' ? null : editing} access={access} onClose={() => setEditing(null)} onSessionError={onSessionError} onRefresh={() => { setEditing(null); void library.refresh(); }} onSaved={(group, products) => {
      setEditing(null); setMessage(`Grupo guardado. ${group.linkedProducts.length} productos enlazados.`); onProductsChanged(products); void library.refresh()
    }} />}
  </section>
}

function SharedGroupEditor({ group, access, onClose, onSaved, onRefresh, onSessionError }: {
  group: SharedModifierGroup | null; access: PosAccess; onClose: () => void; onSaved: (group: SharedModifierGroup, products: Product[]) => void;
  onRefresh: () => void; onSessionError?: (error: AccountClientError) => void
}) {
  const [details, setDetails] = useState<ModifierSet>(() => group ? { id: group.id, name: group.name, min: group.min, max: group.max, options: group.options.map(option => ({ ...option })) } : { id: crypto.randomUUID(), name: '', min: 0, max: 1, options: [{ id: crypto.randomUUID(), name: '', priceCents: 0 }] })
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [uncertain, setUncertain] = useState(false)
  const pending = useRef<Extract<PosCommand, { command: 'save_modifier_group' }> | null>(null), submitting = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const moneyValue = (id: string, cents: number) => drafts[id] ?? modifierPriceInput(cents)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (submitting.current || conflict) return
    if (!pending.current) {
      const options = details.options.map(option => ({ ...option, name: option.name.trim(), priceCents: parseModifierPrice(moneyValue(option.id, option.priceCents)) }))
      if (!details.name.trim() || options.some(option => !option.name || option.priceCents === null || !Number.isInteger(option.maxQuantity ?? 1) || (option.maxQuantity ?? 1) < 1 || (option.maxQuantity ?? 1) > 24) || !Number.isInteger(details.min) || !Number.isInteger(details.max) || details.min < 0 || details.min > details.max || details.max < 1 || details.max > modifierGroupCapacity(details)) {
        setError('Revisa los nombres, precios y cantidades del grupo.'); return
      }
      pending.current = { command: 'save_modifier_group', operationId: crypto.randomUUID(), groupId: details.id, expectedVersion: group?.version ?? null, name: details.name.trim(), min: details.min, max: details.max, options: options.map(option => ({ ...option, priceCents: option.priceCents! })) }
      if (new TextEncoder().encode(JSON.stringify(pending.current)).length > 6800) { pending.current = null; setError('El grupo tiene demasiado texto. Reduce el contenido antes de guardar.'); return }
    }
    submitting.current = true; setBusy(true); setError('')
    try {
      const result = await posRequest(access, pending.current)
      if (alive.current) onSaved(result.group, result.products)
    } catch (caught) {
      if (!alive.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar el grupo.')
      const unknown = !(caught instanceof AccountClientError) || ['NETWORK_ERROR', 'SERVER_ERROR'].includes(caught.code)
      setUncertain(unknown)
      if (!unknown) pending.current = null
      if (caught instanceof AccountClientError) { setConflict(caught.code === 'PRODUCT_CHANGED'); if (accessErrorCodes.includes(caught.code)) onSessionError?.(caught) }
    } finally { submitting.current = false; if (alive.current) setBusy(false) }
  }
  return <PosDialog title={group ? 'Editar grupo compartido' : 'Crear grupo compartido'} onClose={onClose} busy={busy || uncertain} className="product-selection-dialog">
    <p className="mb-4 rounded-lg bg-surface p-4 text-sm">{group?.linkedProducts.length ? `Se actualizarán ${group.linkedProducts.length} productos: ${group.linkedProducts.map(product => product.name).join(', ')}.` : 'Después podrás enlazar este grupo desde el editor de cada producto.'} Las cuentas ya creadas conservan sus extras y precios.</p>
    <form onSubmit={event => void save(event)}><fieldset disabled={busy || uncertain || conflict} className="flex min-w-0 flex-col gap-4 border-0 p-0"><ModifierGroupFields group={details} onChange={setDetails} moneyValue={moneyValue} onMoneyChange={(id, value) => setDrafts(current => ({ ...current, [id]: value }))} /></fieldset>
      {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
      {uncertain && <p className="mt-3 text-sm text-muted">No sabemos si el cambio se guardó. Reintenta el mismo cambio para confirmar.</p>}
      <div className="mt-6 flex flex-col gap-3">{conflict ? <button type="button" className="pos-button pos-primary" onClick={onRefresh}>Cargar biblioteca actual</button> : <button className="pos-button pos-primary" disabled={busy}>{busy ? 'Guardando…' : uncertain ? 'Reintentar cambio' : group?.linkedProducts.length ? 'Guardar para todos los productos' : 'Guardar grupo'}</button>}
        {!uncertain && <button type="button" className="pos-button pos-secondary" disabled={busy} onClick={onClose}>Cancelar</button>}
      </div>
    </form>
  </PosDialog>
}
