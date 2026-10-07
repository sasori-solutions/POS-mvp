import { useState } from 'react'
import { ChevronDown, Minus, MoreHorizontal, Plus, ReceiptText, Search, Trash2 } from 'lucide-react'
import type { OperationalOrder, OrderInputLine } from '../../lib/operations-contracts'
import type { ItemSelection, Product } from '../../lib/pos-contracts'
import { filterProducts, money, parsePrice, priceInput } from '../../lib/pos'
import { isSoldOut, productDetails, quickProductSelection, selectedPrice, selectionLabel } from '../../lib/product-details'
import { isBoundedInteger, maxOperationalLines, maxOperationalMoneyCents, maxOperationalQuantity, maxOperationalUnitPriceCents } from '../../lib/operational-money'
import ProductSelection from '../../components/ProductSelection'
import AmountEntry from '../../components/AmountEntry'
import MoneyInput from '../../components/MoneyInput'
import type { OperationalMutation } from './useOperations'
import LoadingPlaceholder from '../../components/LoadingPlaceholder'
import './operations-polish.css'

const amountLine = (line: OrderInputLine): line is Extract<OrderInputLine, { kind: 'amount' }> => 'kind' in line && line.kind === 'amount'

export default function OrderEditor({ order, products, mutation, onSaved, onCancel, serviceAccount = true, catalogLoading = false, catalogError = '', onRetryCatalog }: { order?: OperationalOrder; products: Product[]; mutation: OperationalMutation; onSaved: (order: OperationalOrder) => void; onCancel: () => void; serviceAccount?: boolean; catalogLoading?: boolean; catalogError?: string; onRetryCatalog?: () => void | Promise<void> }) {
  const [name, setName] = useState(order?.name ?? '')
  const [query, setQuery] = useState('')
  const [choosing, setChoosing] = useState<Product | null>(null)
  const [addingAmount, setAddingAmount] = useState(false)
  const [lines, setLines] = useState<OrderInputLine[]>(order?.items.map(line => line.kind === 'amount'
    ? { lineId: line.lineId, kind: 'amount', name: line.name, quantity: line.quantity, unitPriceCents: line.unitPriceCents, note: '' }
    : { lineId: line.lineId, productId: line.productId!, quantity: line.quantity, unitPriceCents: line.unitPriceCents, version: line.version, ...(line.selection ? { selection: line.selection } : {}), note: line.note }) ?? [])
  const [amountInputs, setAmountInputs] = useState<Record<string, string>>(() => Object.fromEntries((order?.items ?? []).filter(line => line.kind === 'amount').map(line => [line.lineId, priceInput(line.unitPriceCents)])))
  const [orderId] = useState(order?.id ?? crypto.randomUUID())
  const disabled = mutation.busy || Boolean(mutation.pending) || Boolean(order && (order.frozen || order.status !== 'open' || order.phase !== 'service'))
  const selectable = filterProducts(products.filter(p => p.active && !isSoldOut(p)), query, '')
  const itemCount = lines.reduce((total, line) => total + line.quantity, 0)
  const invalidAmounts = lines.some(line => amountLine(line) && (parsePrice(amountInputs[line.lineId] ?? '') ?? 0) <= 0)
  const validAmounts = lines.every(line => isBoundedInteger(line.quantity, 1, maxOperationalQuantity) && isBoundedInteger(line.unitPriceCents, 0, maxOperationalUnitPriceCents))
  const subtotal = validAmounts ? Number(lines.reduce((total, line) => total + BigInt(line.quantity) * BigInt(line.unitPriceCents), 0n)) : 0
  const totalError = !validAmounts || lines.length > maxOperationalLines
    ? 'Revisa las cantidades y los precios de la cuenta.'
    : subtotal > maxOperationalMoneyCents
      ? `El subtotal supera el límite de ${money(maxOperationalMoneyCents)}. Reduce cantidades antes de guardar.`
      : ''
  function add(product: Product, selection?: ItemSelection) {
    if (disabled || lines.length >= maxOperationalLines || isSoldOut(product)) return
    setLines(previous => [...previous, { lineId: crypto.randomUUID(), productId: product.id, quantity: 1, unitPriceCents: selectedPrice(product, selection), version: product.version, note: '', ...(selection ? { selection } : {}) }])
  }
  function addAmount(unitPriceCents: number, name: string) {
    if (disabled || lines.length >= maxOperationalLines) return false
    const lineId = crypto.randomUUID()
    setLines(previous => [...previous, { lineId, kind: 'amount', name, quantity: 1, unitPriceCents, note: '' }])
    setAmountInputs(previous => ({ ...previous, [lineId]: priceInput(unitPriceCents) }))
    setAddingAmount(false)
    return true
  }
  async function save() {
    if (disabled || invalidAmounts || totalError) return
    const orderKind = order ? order.orderKind ?? undefined : serviceAccount ? 'service' : 'counter'
    try { onSaved(await mutation.execute({ command: 'save_order', operationId: crypto.randomUUID(), orderId, expectedRevision: order?.revision ?? null, name: name.trim() || (serviceAccount ? 'Cuenta' : 'Mostrador'), tableId: order?.tableId ?? null, items: lines, ...(orderKind ? { orderKind } : {}) }, orderKind === 'counter' || !orderKind && !serviceAccount ? 'counter' : 'service')) } catch { /* Shell recovery. */ }
  }
  return <div className="ops-form operations-polish order-editor">
    <label className="order-editor-name">Nombre de la cuenta<input value={name} placeholder={serviceAccount ? 'Cuenta' : 'Mostrador'} maxLength={80} onChange={e => setName(e.target.value)} disabled={disabled} /></label>
    <div className="order-editor-layout">
      <section className="order-editor-catalog" aria-label="Añadir productos">
        {addingAmount ? <AmountEntry disabled={disabled} onAdd={addAmount} onCancel={() => setAddingAmount(false)} /> : <button type="button" className="pos-button pos-secondary" disabled={disabled || lines.length >= 40} onClick={() => setAddingAmount(true)}>Añadir importe libre</button>}
        {catalogLoading ? <LoadingPlaceholder variant="catalog" rows={4} label="Cargando productos" /> : catalogError ? <div className="operations-error" role="alert"><p>{catalogError}</p>{onRetryCatalog && <button className="pos-button pos-secondary" onClick={() => void onRetryCatalog()}>Reintentar catálogo</button>}</div> : <>
        <label className="order-editor-search"><span className="sr-only">Buscar producto</span><Search size={20} aria-hidden="true" /><input type="search" placeholder="Buscar producto" value={query} onChange={e => setQuery(e.target.value)} disabled={disabled} /></label>
        <div className="ops-product-grid order-editor-products">
          {selectable.map(product => {
            const details = productDetails(product)
            const prices = details.variations.filter(variation => !variation.soldOut).map(variation => variation.priceCents)
            const priceLabel = details.variablePrice ? 'Precio abierto' : prices.length ? `Desde ${money(Math.min(...prices))}` : money(product.priceCents)
            return (
              <div className="order-editor-product" key={product.id}>
                <button type="button" className="order-editor-product-add" aria-label={`Agregar ${product.name}, ${priceLabel}`} disabled={disabled || lines.length >= maxOperationalLines} onClick={() => {
                  const selection = quickProductSelection(product)
                  if (selection) add(product, selection)
                  else setChoosing(product)
                }}>
                  <span><strong>{product.name}</strong><small>{priceLabel}</small></span>
                  <Plus size={18} aria-hidden="true" />
                </button>
                <button type="button" className="order-editor-product-details" aria-label={`Detalles de ${product.name}`} onClick={() => setChoosing(product)}>
                  <MoreHorizontal size={20} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
        {!selectable.length && <p className="operations-empty-inline">Sin productos disponibles.</p>}
        </>}
      </section>
      <section className="order-editor-account" aria-label="Artículos de la cuenta">
        <div className="operations-heading"><h3>Cuenta</h3><span className="operations-count">{itemCount}</span></div>
        {!lines.length && <div className="operations-empty"><ReceiptText size={28} strokeWidth={1.5} aria-hidden="true" /><p>Añade productos</p></div>}
        <ul className="ops-list order-editor-lines">{lines.map(line => {
      const snapshot = order?.items.find(l => l.lineId === line.lineId)
      const freeAmount = amountLine(line)
      const product = freeAmount ? undefined : products.find(p => p.id === line.productId)
      const minimum = snapshot?.sentQuantity ?? 0
      const label = freeAmount ? line.name.trim() || 'Importe libre' : snapshot?.name ?? product?.name ?? 'Producto'
      const selection = freeAmount ? '' : snapshot?.selectionLabel ?? (product ? selectionLabel(product, line.selection) : '')
      return <li className="ops-line" key={line.lineId}><div className="order-editor-line-heading"><div><strong>{label}</strong>{selection && <small>{selection}</small>}<small>{money(line.unitPriceCents)} c/u{freeAmount ? ' · Importe libre' : ''}</small></div><strong>{money(line.quantity * line.unitPriceCents)}</strong></div><div className="ops-quantity order-editor-quantity"><button type="button" aria-label={`Reducir ${label}`} disabled={disabled || line.quantity <= Math.max(1, minimum)} onClick={() => setLines(previous => previous.map(l => l.lineId === line.lineId ? { ...l, quantity: l.quantity - 1 } : l))}><Minus size={16} aria-hidden="true" /></button><span>{line.quantity}</span><button type="button" aria-label={`Añadir ${label}`} disabled={disabled || line.quantity >= 999} onClick={() => setLines(previous => previous.map(l => l.lineId === line.lineId ? { ...l, quantity: l.quantity + 1 } : l))}><Plus size={16} aria-hidden="true" /></button><button className="order-editor-remove" type="button" aria-label={`Quitar ${label}`} disabled={disabled || minimum > 0} onClick={() => setLines(previous => previous.filter(l => l.lineId !== line.lineId))}><Trash2 size={16} aria-hidden="true" /></button></div>{freeAmount ? <details className="order-editor-note"><summary><span>Editar importe</span><ChevronDown size={16} aria-hidden="true" /></summary>
        <div className="flex flex-col gap-3">
          <label>Concepto (opcional)<input value={line.name} placeholder="Importe libre" maxLength={100} disabled={disabled} onChange={event => setLines(previous => previous.map(item => item.lineId === line.lineId && amountLine(item) ? { ...item, name: event.target.value } : item))} /></label>
          <label>Importe unitario<MoneyInput value={amountInputs[line.lineId] ?? ''} disabled={disabled} aria-invalid={(parsePrice(amountInputs[line.lineId] ?? '') ?? 0) <= 0} onValueChange={value => {
            setAmountInputs(previous => ({ ...previous, [line.lineId]: value }))
            const cents = parsePrice(value)
            if (cents !== null && cents > 0) setLines(previous => previous.map(item => item.lineId === line.lineId && amountLine(item) ? { ...item, unitPriceCents: cents } : item))
          }} /></label>
          {(parsePrice(amountInputs[line.lineId] ?? '') ?? 0) <= 0 && <p role="alert">Escribe un importe mayor a $0.00.</p>}
        </div>
      </details> : <details className="order-editor-note"><summary><span>{line.note || 'Nota de cocina'}</span><ChevronDown size={16} aria-hidden="true" /></summary><label><span className="sr-only">Nota de cocina para {label}</span><input value={line.note} placeholder="Indicaciones para cocina" maxLength={120} disabled={disabled || minimum > 0} onChange={e => setLines(previous => previous.map(l => l.lineId === line.lineId ? { ...l, note: e.target.value } : l))} /></label></details>}</li>
    })}</ul>
      {lines.length > 0 && <dl className="order-editor-subtotal"><dt>Subtotal</dt><dd>{validAmounts ? money(subtotal) : 'Revisa los importes'}</dd></dl>}
      {totalError && <p className="operations-error" role="alert">{totalError}</p>}
      </section>
    </div>
    <div className="order-editor-actions"><button className="pos-button pos-secondary" disabled={mutation.busy} onClick={onCancel}>Cancelar</button><button className="pos-button pos-primary" disabled={disabled || invalidAmounts || Boolean(totalError) || (!order && lines.length === 0)} onClick={() => void save()}>Guardar cuenta</button></div>
    {choosing && <ProductSelection product={choosing} addingDisabled={disabled || lines.length >= maxOperationalLines} onClose={() => setChoosing(null)} onAdd={selection => add(choosing, selection)} />}
  </div>
}
