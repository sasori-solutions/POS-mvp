import { Minus, Plus } from 'lucide-react'
import type { OperationalOrder } from '../../lib/operations-contracts'
import { checkoutTotals } from '../../lib/checkout-selection'
import { money } from '../../lib/pos'

export default function CheckoutItemSelection({ order, quantities, disabled, onChange }: {
  order: OperationalOrder
  quantities: Record<string, number>
  disabled: boolean
  onChange: (quantities: Record<string, number>) => void
}) {
  const lines = order.items.filter(line => line.quantity > line.paidQuantity)
  const count = lines.reduce((sum, line) => sum + Math.min(quantities[line.lineId] ?? 0, line.quantity - line.paidQuantity), 0)
  const remainingCount = lines.reduce((sum, line) => sum + line.quantity - line.paidQuantity, 0)
  function select(lineId: string, quantity: number) {
    const line = lines.find(item => item.lineId === lineId)
    if (disabled || !line || !Number.isInteger(quantity) || quantity < 0 || quantity > line.quantity - line.paidQuantity) return
    onChange({ ...quantities, [lineId]: quantity })
  }
  return <section className="checkout-item-selection" aria-label="Artículos de este cobro">
    <div className="checkout-selection-toolbar">
      <p>{count} de {remainingCount} seleccionados</p>
      <div className="checkout-selection-actions">
        <button type="button" disabled={disabled || count === remainingCount} onClick={() => onChange(Object.fromEntries(lines.map(line => [line.lineId, line.quantity - line.paidQuantity])))}>Todos</button>
        <button type="button" disabled={disabled || count === 0} onClick={() => onChange(Object.fromEntries(lines.map(line => [line.lineId, 0])))}>Limpiar</button>
      </div>
    </div>
    <ul className="ops-list checkout-selection-list">{lines.map(line => {
      const available = line.quantity - line.paidQuantity
      const selected = Math.min(quantities[line.lineId] ?? 0, available)
      const amount = checkoutTotals(order, [{ lineId: line.lineId, quantity: selected || available }]).totalCents
      return <li key={line.lineId} data-selected={selected > 0}>
        <div className="checkout-line-product"><strong>{line.name}</strong>{line.selectionLabel && <small>{line.selectionLabel}</small>}{line.note && <small>{line.note}</small>}</div>
        <span className="checkout-line-amount" aria-label={`${selected ? 'Importe seleccionado' : 'Importe disponible'}: ${money(amount)}`}>{money(amount)}</span>
        <div className="checkout-quantity-row">
          <span>{available} {available === 1 ? 'disponible' : 'disponibles'}</span>
          <div className="checkout-quantity-controls" role="group" aria-label={`Unidades de ${line.name} para este cobro`}>
            <button type="button" aria-label={`Quitar ${line.name} de este cobro`} disabled={disabled || selected === 0} onClick={() => select(line.lineId, selected - 1)}><Minus size={18} aria-hidden="true" /></button>
            <input aria-label={`Cantidad a cobrar de ${line.name}`} type="number" inputMode="numeric" min={0} max={available} step={1} value={selected} disabled={disabled} onChange={event => select(line.lineId, Number(event.target.value))} />
            <button type="button" aria-label={`Añadir ${line.name} a este cobro`} disabled={disabled || selected === available} onClick={() => select(line.lineId, selected + 1)}><Plus size={18} aria-hidden="true" /></button>
          </div>
        </div>
      </li>
    })}</ul>
  </section>
}
