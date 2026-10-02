import { useEffect, useRef } from 'react'
import { ArrowLeft, Package, Search, X } from 'lucide-react'
import type { Product, Sale } from '../lib/pos-contracts'
import { money, saleDate } from '../lib/pos'

export const paymentLabels = { cash: 'Efectivo', card_external: 'Tarjeta', transfer: 'Transferencia' }

export function CatalogFilters({ products, query, category, onQuery, onCategory }: {
  products: Product[]; query: string; category: string; onQuery: (value: string) => void; onCategory: (value: string) => void
}) {
  const categories = [...new Set(products.map(product => product.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'))
  return <div className="catalog-filters">
    <div className="catalog-search"><Search size={20} aria-hidden="true" /><input aria-label="Buscar producto" type="search" placeholder="Buscar producto" value={query} onChange={event => onQuery(event.target.value)} />{query && <button className="pos-icon-button" aria-label="Limpiar búsqueda" onClick={() => onQuery('')}><X size={18} aria-hidden="true" /></button>}</div>
    <div className="catalog-categories" role="group" aria-label="Categorías">
      {['', ...categories].map(value => <button key={value} className="catalog-category" aria-pressed={category === value} onClick={() => onCategory(value)}>{value || 'Todo'}</button>)}
    </div>
  </div>
}

export function EmptyCatalog({ title = 'Aún no hay productos', description = 'Agrega tu primer producto para empezar a vender.', children }: {
  title?: string; description?: string; children?: React.ReactNode
}) {
  return <div className="pos-empty"><Package className="pos-empty-icon" size={32} strokeWidth={1.4} aria-hidden="true" /><h2>{title}</h2><p>{description}</p>{children}</div>
}

export function PosDialog({ title, onClose, busy = false, children, className = '' }: { className?: string; title: string; onClose: () => void; busy?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement as HTMLElement | null
    dialog.showModal()
    return () => { dialog.close(); previous?.focus() }
  }, [])
  return <dialog ref={ref} className={`pos-dialog ${className}`} aria-labelledby="pos-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="pos-dialog-heading"><h2 id="pos-dialog-title">{title}</h2><button className="pos-icon-button" aria-label="Cerrar" onClick={onClose} disabled={busy}><X size={22} aria-hidden="true" /></button></div>
    {children}
  </dialog>
}

export function SaleDetail({ sale }: { sale: Sale }) {
  return <div className="sale-detail">
    <p className="sale-reference">Venta #{sale.id.slice(0, 8).toUpperCase()}</p>
    <p>{saleDate(sale.createdAt, sale.timezone)}</p>
    <ul className="sale-detail-items">{sale.items.map((item, index) => <li key={`${item.productId}:${index}`}><div><strong>{item.name}</strong><p>{item.selectionLabel}</p><p>{item.quantity} × {money(item.unitPriceCents)}</p></div><span>{money(item.totalCents)}</span></li>)}</ul>
    <dl className="sale-totals"><div><dt>Subtotal</dt><dd>{money(sale.totalCents)}</dd></div>{sale.items.some(i => i.taxCents) && <div><dt>Impuestos incluidos</dt><dd>{money(sale.items.reduce((sum,i) => sum + (i.taxCents ?? 0),0))}</dd></div>}<div className="sale-total"><dt>Total MXN</dt><dd>{money(sale.totalCents)}</dd></div><div><dt>Método de pago</dt><dd>{paymentLabels[sale.paymentMethod]}</dd></div><div><dt>Registró</dt><dd>{sale.operatorName}</dd></div></dl>
  </div>
}

export function BackToCatalog({ onClick }: { onClick: () => void }) {
  return <button className="back-button" onClick={onClick}><ArrowLeft size={20} aria-hidden="true" />Volver al catálogo</button>
}
