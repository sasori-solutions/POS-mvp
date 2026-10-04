import { useState } from 'react'
import { ChevronDown, Minus, Plus, ReceiptText, Search, Trash2 } from 'lucide-react'
import type { OperationalOrder, OrderInputLine } from '../../lib/operations-contracts'
import type { ItemSelection, Product } from '../../lib/pos-contracts'
import { filterProducts, money } from '../../lib/pos'
import { isSoldOut, productDetails, selectedPrice, selectionLabel } from '../../lib/product-details'
import ProductSelection from '../../components/ProductSelection'
import type { OperationalMutation } from './useOperations'
import LoadingPlaceholder from '../../components/LoadingPlaceholder'
import './operations-polish.css'

export default function OrderEditor({ order, products, mutation, onSaved, onCancel, catalogLoading = false, catalogError = '', onRetryCatalog }: { order?: OperationalOrder; products: Product[]; mutation: OperationalMutation; onSaved: (order: OperationalOrder) => void; onCancel: () => void; catalogLoading?: boolean; catalogError?: string; onRetryCatalog?: () => void | Promise<void> }) {
  const [name, setName] = useState(order?.name ?? '')
  const [query, setQuery] = useState('')
  const [choosing, setChoosing] = useState<Product | null>(null)
  const [lines, setLines] = useState<OrderInputLine[]>(order?.items.map(line => ({ lineId: line.lineId, productId: line.productId, quantity: line.quantity, unitPriceCents: line.unitPriceCents, version: line.version, ...(line.selection ? { selection: line.selection } : {}), note: line.note })) ?? [])
  const [orderId] = useState(order?.id ?? crypto.randomUUID())
  const disabled = mutation.busy || Boolean(mutation.pending)
  const selectable = filterProducts(products.filter(p => p.active && !isSoldOut(p)), query, '')
  const itemCount = lines.reduce((total, line) => total + line.quantity, 0)
  const subtotal = lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0)
  function add(product: Product, selection?: ItemSelection) { if (lines.length >= 40) return; setLines(previous => [...previous, { lineId: crypto.randomUUID(), productId: product.id, quantity: 1, unitPriceCents: selectedPrice(product, selection), version: product.version, note: '', ...(selection ? { selection } : {}) }]) }
  async function save() {
    try { onSaved(await mutation.execute({ command: 'save_order', operationId: crypto.randomUUID(), orderId, expectedRevision: order?.revision ?? null, name: name.trim() || 'Mostrador', tableId: order?.tableId ?? null, items: lines })) } catch { /* Shell recovery. */ }
  }
  return <div className="ops-form operations-polish order-editor">
    <label className="order-editor-name">Nombre de la cuenta<input value={name} placeholder="Mostrador" maxLength={80} onChange={e => setName(e.target.value)} disabled={disabled} /></label>
    <div className="order-editor-layout">
      <section className="order-editor-catalog" aria-label="Añadir productos">
        {catalogLoading ? <LoadingPlaceholder variant="catalog" rows={4} label="Cargando productos" /> : catalogError ? <div className="operations-error" role="alert"><p>{catalogError}</p>{onRetryCatalog && <button className="pos-button pos-secondary" onClick={() => void onRetryCatalog()}>Reintentar catálogo</button>}</div> : <>
        <label className="order-editor-search"><span className="sr-only">Buscar producto</span><Search size={20} aria-hidden="true" /><input type="search" placeholder="Buscar producto" value={query} onChange={e => setQuery(e.target.value)} disabled={disabled} /></label>
        <div className="ops-product-grid order-editor-products">{selectable.map(p => <button type="button" key={p.id} disabled={disabled || lines.length >= 40} onClick={() => {
          const d = productDetails(p)
          if (d.variations.length || d.modifierSets.length || d.variablePrice) setChoosing(p); else add(p)
        }}><span><strong>{p.name}</strong><small>{money(p.priceCents)}</small></span><Plus size={18} aria-hidden="true" /></button>)}</div>
        {!selectable.length && <p className="operations-empty-inline">Sin productos disponibles.</p>}
        </>}
      </section>
      <section className="order-editor-account" aria-label="Artículos de la cuenta">
        <div className="operations-heading"><h3>Cuenta</h3><span className="operations-count">{itemCount}</span></div>
        {!lines.length && <div className="operations-empty"><ReceiptText size={28} strokeWidth={1.5} aria-hidden="true" /><p>Añade productos</p></div>}
        <ul className="ops-list order-editor-lines">{lines.map(line => {
      const snapshot = order?.items.find(l => l.lineId === line.lineId)
      const product = products.find(p => p.id === line.productId)
      const minimum = snapshot?.sentQuantity ?? 0
      const label = snapshot?.name ?? product?.name ?? 'Producto'
      const selection = snapshot?.selectionLabel ?? (product ? selectionLabel(product, line.selection) : '')
      return <li className="ops-line" key={line.lineId}><div className="order-editor-line-heading"><div><strong>{label}</strong>{selection && <small>{selection}</small>}<small>{money(line.unitPriceCents)} c/u</small></div><strong>{money(line.quantity * line.unitPriceCents)}</strong></div><div className="ops-quantity order-editor-quantity"><button type="button" aria-label={`Reducir ${label}`} disabled={disabled || line.quantity <= Math.max(1, minimum)} onClick={() => setLines(previous => previous.map(l => l.lineId === line.lineId ? { ...l, quantity: l.quantity - 1 } : l))}><Minus size={16} aria-hidden="true" /></button><span>{line.quantity}</span><button type="button" aria-label={`Añadir ${label}`} disabled={disabled || line.quantity >= 999} onClick={() => setLines(previous => previous.map(l => l.lineId === line.lineId ? { ...l, quantity: l.quantity + 1 } : l))}><Plus size={16} aria-hidden="true" /></button><button className="order-editor-remove" type="button" aria-label={`Quitar ${label}`} disabled={disabled || minimum > 0} onClick={() => setLines(previous => previous.filter(l => l.lineId !== line.lineId))}><Trash2 size={16} aria-hidden="true" /></button></div><details className="order-editor-note"><summary><span>{line.note || 'Nota de cocina'}</span><ChevronDown size={16} aria-hidden="true" /></summary><label><span className="sr-only">Nota de cocina para {label}</span><input value={line.note} placeholder="Indicaciones para cocina" maxLength={120} disabled={disabled || minimum > 0} onChange={e => setLines(previous => previous.map(l => l.lineId === line.lineId ? { ...l, note: e.target.value } : l))} /></label></details></li>
    })}</ul>
      {lines.length > 0 && <dl className="order-editor-subtotal"><dt>Subtotal</dt><dd>{money(subtotal)}</dd></dl>}
      </section>
    </div>
    <div className="order-editor-actions"><button className="pos-button pos-secondary" disabled={mutation.busy} onClick={onCancel}>Cancelar</button><button className="pos-button pos-primary" disabled={disabled || (!order && lines.length === 0)} onClick={() => void save()}>Guardar cuenta</button></div>
    {choosing && <ProductSelection product={choosing} onClose={() => setChoosing(null)} onAdd={selection => add(choosing, selection)} />}
  </div>
}
