import { useState } from 'react'
import type { OperationalOrder } from '../../lib/operations-contracts'
import type { Promotion } from '../../lib/promotion-contracts'
import { money, type PosAccess } from '../../lib/pos'
import type { AccountClientError } from '../../lib/account'
import { discountEligibleGross } from '../../lib/promotion-math'
import { orderDiscountPreview } from './order-discount-model'
import { usePromotions } from '../../components/usePromotions'

export default function SavedPromotionPicker({ access, order, disabled, onApply, onSessionError }: {
  access: PosAccess; order: OperationalOrder; disabled: boolean; onApply: (promotion: Promotion) => void
  onSessionError?: (error: AccountClientError) => void
}) {
  const library = usePromotions(access, onSessionError), [selected, setSelected] = useState('')
  const promotions = library.promotions.filter(promotion => promotion.active)
  const promotion = promotions.find(value => value.id === selected)
  const eligible = promotion ? discountEligibleGross(order, promotion.scope) : 0
  const preview = promotion && eligible > 0 ? orderDiscountPreview(eligible, promotion.kind, promotion.value) : null
  return <section className="ops-form" aria-label="Promociones guardadas">
    <h4>Usar una promoción</h4>
    {library.loading ? <p role="status">Consultando promociones…</p> : library.error ? <div role="alert"><p>{library.error}</p><button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => { void library.refresh() }}>Reintentar promociones</button></div> : !promotions.length ? <p className="operations-caption">Puedes crear promociones por producto o categoría desde Productos.</p> : <>
      <label>Promoción<select value={selected} disabled={disabled} onChange={event => setSelected(event.target.value)}><option value="">Elige una promoción</option>{promotions.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
      {promotion && <><p className="operations-caption">Se aplica a {money(eligible)} de consumos elegibles. Sustituye el descuento actual de la cuenta.</p>{preview ? <p>Descuento: −{money(preview.discountCents)} · Total: {money(order.grossCents - preview.discountCents)}</p> : <p role="status">Esta cuenta no cumple las condiciones o el importe elegible es insuficiente.</p>}
        <button type="button" className="pos-button pos-secondary" disabled={disabled || !preview || preview.discountCents === 0} onClick={() => onApply(promotion)}>Aplicar {promotion.name}</button></>}
    </>}
    {!library.loading && !library.error && <button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => { void library.refresh() }}>Actualizar promociones</button>}
  </section>
}
