import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { AccountClientError } from '../lib/account'
import type { Promotion } from '../lib/promotion-contracts'
import type { Product } from '../lib/pos-contracts'
import { money, type PosAccess } from '../lib/pos'
import { promotionCategory } from '../lib/promotion-math'
import { discountInputValue, parseOrderDiscount } from '../features/operations/order-discount-model'
import type { OperationalMutation } from '../features/operations/useOperations'
import { usePromotions } from './usePromotions'
import MoneyInput from './MoneyInput'
import { PendingIndicator } from './LoadingPlaceholder'

type Draft = { id: string; revision: number | null; name: string; active: boolean; kind: Promotion['kind']; input: string; productIds: string[]; categories: string[] }
const fromPromotion = (value: Promotion): Draft => ({ id: value.id, revision: value.revision, name: value.name, active: value.active, kind: value.kind, input: discountInputValue(value.value), ...value.scope })
export default function PromotionManager({ access, products, mutation, onSessionError }: {
  access: PosAccess; products: Product[]; mutation: OperationalMutation; onSessionError?: (error: AccountClientError) => void
}) {
  const library = usePromotions(access, onSessionError), [draft, setDraft] = useState<Draft | null>(null), [error, setError] = useState('')
  const generation = useRef(0), handled = useRef(mutation.lastResult)
  useEffect(() => { generation.current++; return () => { generation.current++ } }, [access.businessId, access.operatorToken, access.deviceToken])
  useEffect(() => {
    const pending = mutation.pending
    if (pending?.command === 'save_promotion') setDraft({ id: pending.promotionId, revision: pending.expectedRevision, name: pending.name, active: pending.active, kind: pending.kind, input: discountInputValue(pending.value), ...pending.scope })
  }, [mutation.pending])
  useEffect(() => {
    if (mutation.lastResult === handled.current) return
    handled.current = mutation.lastResult
    if (mutation.lastResult?.command !== 'save_promotion') return
    const saved = mutation.lastResult.result as Promotion
    setDraft(current => current?.id === saved.id ? null : current)
    void library.refresh()
  }, [mutation.lastResult, library.refresh])
  const busy = mutation.busy || Boolean(mutation.pending)
  const categories = [...new Set([...products.map(product => promotionCategory(product.category)).filter(Boolean), ...(draft?.categories ?? [])])].sort()
  const parsed = draft ? parseOrderDiscount(draft.kind, draft.input, 9_999_999_999) : null
  const valid = Boolean(draft?.name.trim() && parsed !== null && parsed > 0 && (draft.productIds.length || draft.categories.length))
  function update(patch: Partial<Draft>) { if (draft && !busy) { setDraft({ ...draft, ...patch }); setError('') } }
  async function save() {
    if (!draft || !valid || parsed === null || busy) return
    const scope = generation.current
    setError('')
    try {
      await mutation.execute({ command: 'save_promotion', operationId: crypto.randomUUID(), promotionId: draft.id, expectedRevision: draft.revision,
        name: draft.name.trim().replace(/\s+/g, ' ').normalize('NFC'), active: draft.active, kind: draft.kind, value: parsed,
        scope: { productIds: [...draft.productIds].sort(), categories: [...draft.categories].sort() } })
      if (scope === generation.current) { setDraft(null); void library.refresh() }
    } catch { if (scope === generation.current) setError('La promoción no se guardó. Revisa el aviso y la solicitud pendiente antes de repetirla.') }
  }
  return <section className="ops-form" aria-label="Promociones del catálogo">
    <div className="operations-heading"><div><h2>Promociones</h2><p className="operations-caption">Elige productos o categorías. Al cobrar, aplica una promoción y revisa el total.</p></div><button type="button" className="pos-button pos-primary" disabled={busy || Boolean(draft)} onClick={() => setDraft({ id: crypto.randomUUID(), revision: null, name: '', active: true, kind: 'percent', input: '10', productIds: [], categories: [] })}><Plus size={18} aria-hidden="true" />Crear promoción</button></div>
    {error && <p role="alert">{error}</p>}
    {draft && <form className="ops-card ops-form" onSubmit={event => { event.preventDefault(); void save() }}>
      <h3>{draft.revision === null ? 'Nueva promoción' : 'Editar promoción'}</h3>
      <fieldset className="ops-form" disabled={busy}>
        <label>Nombre<input autoFocus maxLength={60} value={draft.name} onChange={event => update({ name: event.target.value })} placeholder="Ej. 10 % en bebidas" required /></label>
        <label>Tipo de descuento<select value={draft.kind} onChange={event => update({ kind: event.target.value as Promotion['kind'], input: '' })}><option value="percent">Porcentaje</option><option value="fixed">Importe</option></select></label>
        {draft.kind === 'fixed' ? <label>Importe del descuento<MoneyInput value={draft.input} onValueChange={input => update({ input })} maxCents={9_999_999_999} /></label> : <label>Porcentaje<input type="text" inputMode="decimal" value={draft.input} onChange={event => update({ input: event.target.value })} placeholder="10" /></label>}
        {draft.input && parsed === null && <p role="alert">Usa un importe válido o un porcentaje entre 0 y 100, con hasta dos decimales.</p>}
        <fieldset className="order-discount-scope"><legend>Productos o categorías elegibles</legend>
          {categories.map(category => <label className="ops-check" key={category}><input type="checkbox" checked={draft.categories.includes(category)} disabled={!draft.categories.includes(category) && draft.categories.length >= 24} onChange={event => update({ categories: event.target.checked ? [...draft.categories, category] : draft.categories.filter(value => value !== category) })} /><span>Categoría: {category}</span></label>)}
          {products.map(product => <label className="ops-check" key={product.id}><input type="checkbox" checked={draft.productIds.includes(product.id)} disabled={!draft.productIds.includes(product.id) && draft.productIds.length >= 100} onChange={event => update({ productIds: event.target.checked ? [...draft.productIds, product.id] : draft.productIds.filter(value => value !== product.id) })} /><span>Producto: {product.name}</span></label>)}
          {draft.productIds.filter(id => !products.some(product => product.id === id)).map(id => <label className="ops-check" key={id}><input type="checkbox" checked onChange={() => update({ productIds: draft.productIds.filter(value => value !== id) })} /><span>Producto ya no disponible · quítalo para actualizar</span></label>)}
        </fieldset>
        <label className="ops-check"><input type="checkbox" checked={draft.active} onChange={event => update({ active: event.target.checked })} /><span>Promoción activa</span></label>
      </fieldset>
      <p className="operations-caption">Coincidir con cualquiera de las condiciones hace elegible el consumo. El importe fijo se reparte entre esos consumos, sin exceder su subtotal. La promoción sustituye el descuento actual de la cuenta.</p>
      <div className="service-panel-actions"><button type="submit" className="pos-button pos-primary" disabled={busy || !valid}>{mutation.busy && <PendingIndicator label="Guardando promoción" />}Guardar promoción</button><button type="button" className="pos-button pos-secondary" disabled={busy} onClick={() => setDraft(null)}>Cancelar edición</button></div>
    </form>}
    {library.loading && <p role="status">Consultando promociones…</p>}
    {library.error && <div role="alert"><p>{library.error}</p><button type="button" className="pos-button pos-secondary" disabled={busy} onClick={() => { void library.refresh() }}>Reintentar promociones</button></div>}
    <ul className="ops-form">{library.promotions.map(promotion => <li key={promotion.id} className="ops-card"><h3>{promotion.name}</h3><p>{promotion.kind === 'fixed' ? money(promotion.value) : `${discountInputValue(promotion.value).replace('.', ',')} %`} · {promotion.active ? 'Activa' : 'Pausada'}</p><p className="operations-caption">{promotion.scope.categories.join(', ')}{promotion.scope.categories.length && promotion.scope.productIds.length ? ' · ' : ''}{promotion.scope.productIds.length > 0 ? `${promotion.scope.productIds.length} productos` : ''}</p><button type="button" className="pos-button pos-secondary mt-3" disabled={busy || Boolean(draft)} onClick={() => { setDraft(fromPromotion(promotion)); setError('') }}>Editar {promotion.name}</button></li>)}</ul>
    {!library.loading && !library.error && !library.promotions.length && <p>Aún no hay promociones. También puedes aplicar un descuento puntual al cobrar.</p>}
  </section>
}
