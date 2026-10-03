import { useState } from 'react'
import type { DiningTable, OperationalOrder, OrderInputLine } from '../../lib/operations-contracts'
import type { ItemSelection, Product } from '../../lib/pos-contracts'
import { filterProducts, money } from '../../lib/pos'
import { isSoldOut, productDetails, selectedPrice, selectionLabel } from '../../lib/product-details'
import ProductSelection from '../../components/ProductSelection'
import type { OperationalMutation } from './useOperations'

export default function OrderEditor({ order, initialTableId, products, tables, mutation, onSaved, onCancel }: { order?: OperationalOrder; initialTableId?: string; products: Product[]; tables: DiningTable[]; mutation: OperationalMutation; onSaved: (order: OperationalOrder) => void; onCancel: () => void }) {
  const [name, setName] = useState(order?.name ?? '')
  const [tableId, setTableId] = useState(order?.tableId ?? initialTableId ?? '')
  const [query, setQuery] = useState('')
  const [choosing, setChoosing] = useState<Product | null>(null)
  const [lines, setLines] = useState<OrderInputLine[]>(order?.items.map(line => ({ lineId: line.lineId, productId: line.productId, quantity: line.quantity, unitPriceCents: line.unitPriceCents, version: line.version, ...(line.selection ? { selection: line.selection } : {}), note: line.note })) ?? [])
  const [orderId] = useState(order?.id ?? crypto.randomUUID())
  const disabled = mutation.busy || Boolean(mutation.pending)
  const selectable = filterProducts(products.filter(p => p.active && !isSoldOut(p)), query, '')
  function add(product: Product, selection?: ItemSelection) { if (lines.length >= 40) return; setLines(previous => [...previous, { lineId: crypto.randomUUID(), productId: product.id, quantity: 1, unitPriceCents: selectedPrice(product, selection), version: product.version, note: '', ...(selection ? { selection } : {}) }]) }
  async function save() {
    try { onSaved(await mutation.execute({ command: 'save_order', operationId: crypto.randomUUID(), orderId, expectedRevision: order?.revision ?? null, name: name.trim() || (tableId ? tables.find(t => t.id === tableId)?.name ?? 'Cuenta' : 'Mostrador'), tableId: tableId || null, items: lines })) } catch { /* Shell recovery. */ }
  }
  return <div className="ops-form">
    <label>Nombre de la cuenta<input value={name} maxLength={80} onChange={e => setName(e.target.value)} disabled={disabled} /></label>
    {!order && tables.length > 0 && <label>Mesa<select value={tableId} onChange={e => setTableId(e.target.value)} disabled={disabled}><option value="">Sin mesa</option>{tables.filter(t => t.active && !t.orderId).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
    <ul className="ops-list">{lines.map(line => {
      const snapshot = order?.items.find(l => l.lineId === line.lineId)
      const product = products.find(p => p.id === line.productId)
      const minimum = snapshot?.sentQuantity ?? 0
      return <li className="ops-line" key={line.lineId}><div><strong>{snapshot?.name ?? product?.name ?? 'Producto'}</strong><small>{snapshot?.selectionLabel ?? (product ? selectionLabel(product, line.selection) : '')} · {money(line.unitPriceCents)}</small><label>Nota de cocina<input value={line.note} maxLength={120} disabled={disabled || minimum > 0} onChange={e => setLines(previous => previous.map(l => l.lineId === line.lineId ? { ...l, note: e.target.value } : l))} /></label></div><div className="ops-quantity"><button type="button" aria-label={`Reducir ${snapshot?.name ?? product?.name ?? 'producto'}`} disabled={disabled || line.quantity <= Math.max(1, minimum)} onClick={() => setLines(previous => previous.map(l => l.lineId === line.lineId ? { ...l, quantity: l.quantity - 1 } : l))}>−</button><span>{line.quantity}</span><button type="button" aria-label={`Añadir ${snapshot?.name ?? product?.name ?? 'producto'}`} disabled={disabled || line.quantity >= 999} onClick={() => setLines(previous => previous.map(l => l.lineId === line.lineId ? { ...l, quantity: l.quantity + 1 } : l))}>+</button><button type="button" disabled={disabled || minimum > 0} onClick={() => setLines(previous => previous.filter(l => l.lineId !== line.lineId))}>Quitar</button></div></li>
    })}</ul>
    <label>Buscar producto<input type="search" value={query} onChange={e => setQuery(e.target.value)} disabled={disabled} /></label>
    <div className="ops-product-grid">{selectable.map(p => <button type="button" key={p.id} disabled={disabled || lines.length >= 40} onClick={() => {
      const d = productDetails(p)
      if (d.variations.length || d.modifierSets.length || d.variablePrice) setChoosing(p); else add(p)
    }}>{p.name}<small>{money(p.priceCents)}</small></button>)}</div>
    {!selectable.length && <p>No hay productos disponibles para agregar.</p>}
    <button className="pos-button pos-primary" disabled={disabled || lines.length === 0} onClick={() => void save()}>Guardar cuenta</button><button className="pos-button pos-secondary" disabled={mutation.busy} onClick={onCancel}>Cancelar edición</button>
    {choosing && <ProductSelection product={choosing} onClose={() => setChoosing(null)} onAdd={selection => add(choosing, selection)} />}
  </div>
}
