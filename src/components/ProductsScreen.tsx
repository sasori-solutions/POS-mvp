import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Plus, Power } from 'lucide-react'
import { AccountClientError } from '../lib/account'
import type { PosCommand, Product } from '../lib/pos-contracts'
import { filterProducts, money, parsePrice, posRequest, priceInput, type PosAccess } from '../lib/pos'
import { CatalogFilters, EmptyCatalog, PosDialog } from './PosShared'
import { accessErrorCodes, type CatalogState } from './useCatalog'

export default function ProductsScreen({ access, catalog, canManage, onSessionError }: {
  access: PosAccess; catalog: CatalogState; canManage: boolean; onSessionError?: (error: AccountClientError) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('active')
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [toggling, setToggling] = useState<Product | null>(null)
  const [message, setMessage] = useState('')
  const products = catalog.products.filter(product => status === 'all' || product.active === (status === 'active'))
  const filtered = filterProducts(products, query, category)

  function saved(product: Product) {
    catalog.upsert(product)
    setMessage(product.active ? 'Producto guardado.' : 'Producto desactivado. Sus ventas se conservan.')
    setEditing(null)
    setToggling(null)
  }
  return <div className="products-screen">
    <div className="catalog-toolbar"><p>{canManage ? 'Administra nombres, precios y disponibilidad.' : 'Consulta los productos disponibles.'}</p>{canManage && <button className="pos-button pos-primary compact" onClick={() => { setMessage(''); setEditing('new') }}><Plus size={20} aria-hidden="true" />Agregar producto</button>}</div>
    {message && <p className="pos-status" role="status">{message}</p>}
    <CatalogFilters products={catalog.products} query={query} category={category} onQuery={setQuery} onCategory={setCategory} />
    {canManage && <div className="catalog-status-filter"><label htmlFor="product-status">Mostrar</label><select id="product-status" value={status} onChange={event => setStatus(event.target.value)}><option value="active">Activos</option><option value="inactive">Inactivos</option><option value="all">Todos</option></select></div>}
    {catalog.error && <div className="pos-error" role="alert"><p>{catalog.error}</p><button className="pos-button pos-secondary compact" onClick={() => void catalog.refresh()} disabled={catalog.loading}>Reintentar</button></div>}
    {catalog.loading && !catalog.loaded && <p className="pos-status" role="status">Cargando productos…</p>}
    {catalog.loaded && !filtered.length ? <EmptyCatalog title={catalog.products.length ? 'Sin productos para esta búsqueda' : 'Aún no hay productos'} description={catalog.products.length ? 'Prueba otro nombre, categoría o estado.' : canManage ? 'Agrega tu primer producto para empezar a vender.' : 'Pide al dueño que agregue productos.'} /> :
      <ul className="product-list" aria-label="Catálogo de productos">{filtered.map(product => {
        const details = <><div className="product-list-info"><strong>{product.name}</strong><p>{product.category || 'Sin categoría'}{!product.active && <span className="product-state">Inactivo</span>}</p></div><span className="product-price">{money(product.priceCents)}</span></>
        return <li key={product.id} className={product.active ? '' : 'inactive-product'}>{canManage ? <button className="product-edit" aria-label={`Editar ${product.name}`} onClick={() => { setMessage(''); setEditing(product) }}>{details}<ChevronRight size={18} aria-hidden="true" /></button> : <div className="product-edit">{details}</div>}{canManage && <button className="pos-icon-button product-availability" title={product.active ? 'Desactivar producto' : 'Activar producto'} aria-label={`${product.active ? 'Desactivar' : 'Activar'} ${product.name}`} onClick={() => { setMessage(''); setToggling(product) }}><Power size={19} aria-hidden="true" /></button>}</li>
      })}</ul>}
    {editing && <ProductEditor product={editing === 'new' ? null : editing} products={catalog.products} access={access} onClose={() => setEditing(null)} onSaved={saved} onRefresh={() => { setEditing(null); void catalog.refresh() }} onSessionError={onSessionError} />}
    {toggling && <ProductActivation product={toggling} access={access} onClose={() => setToggling(null)} onSaved={saved} onRefresh={() => { setToggling(null); void catalog.refresh() }} onSessionError={onSessionError} />}
  </div>
}

function ProductEditor({ product, products, access, onClose, onSaved, onRefresh, onSessionError }: {
  product: Product | null; products: Product[]; access: PosAccess; onClose: () => void; onSaved: (product: Product) => void; onRefresh: () => void; onSessionError?: (error: AccountClientError) => void
}) {
  const [name, setName] = useState(product?.name ?? '')
  const [category, setCategory] = useState(product?.category ?? '')
  const [price, setPrice] = useState(product ? priceInput(product.priceCents) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [conflict, setConflict] = useState(false)
  const productId = useRef(product?.id ?? crypto.randomUUID())
  const request = useRef<Extract<PosCommand, { command: 'save_product' }> | null>(null)
  const submitting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting.current || conflict) return
    if (!request.current) {
      const normalized = name.trim().replace(/\s+/g, ' ')
      const normalizedCategory = category.trim().replace(/\s+/g, ' ')
      const priceCents = parsePrice(price)
      if (!normalized || Array.from(normalized).length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) { setError('Escribe un nombre de 1 a 100 caracteres.'); return }
      if (Array.from(normalizedCategory).length > 60 || /[\u0000-\u001f\u007f]/.test(normalizedCategory)) { setError('La categoría admite hasta 60 caracteres.'); return }
      if (priceCents === null) { setError('Escribe un precio entre $0.00 y $999,999.99, con hasta 2 decimales.'); return }
      request.current = { command: 'save_product', productId: productId.current, expectedVersion: product?.version ?? null, name: normalized, category: normalizedCategory, priceCents, operationId: crypto.randomUUID() }
    }
    submitting.current = true; setBusy(true); setError('')
    try {
      const saved = await posRequest(access, request.current)
      if (mounted.current) onSaved(saved)
    } catch (caught) {
      if (!mounted.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar el producto.')
      const unknown = !(caught instanceof AccountClientError) || ['NETWORK_ERROR', 'SERVER_ERROR'].includes(caught.code)
      setUncertain(unknown)
      if (!unknown) request.current = null
      if (caught instanceof AccountClientError) {
        setConflict(caught.code === 'PRODUCT_CHANGED')
        if (accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
      }
    } finally { submitting.current = false; if (mounted.current) setBusy(false) }
  }

  return <PosDialog title={product ? 'Editar producto' : 'Agregar producto'} onClose={onClose} busy={busy}>
    <form className="product-form" onSubmit={event => void save(event)}>
      <div className="field"><label htmlFor="product-name">Nombre</label><input id="product-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={busy || uncertain || conflict} autoFocus /></div>
      <div className="field"><label htmlFor="product-price">Precio MXN</label><input id="product-price" value={price} onChange={event => setPrice(event.target.value)} inputMode="decimal" placeholder="0.00" required disabled={busy || uncertain || conflict} aria-describedby="price-help" /><p id="price-help" className="product-help">Precio final por producto, con hasta 2 decimales.</p></div>
      <div className="field"><label htmlFor="product-category">Categoría (opcional)</label><input id="product-category" value={category} onChange={event => setCategory(event.target.value)} maxLength={60} list="product-categories" disabled={busy || uncertain || conflict} /><datalist id="product-categories">{[...new Set(products.map(item => item.category).filter(Boolean))].map(value => <option key={value} value={value} />)}</datalist></div>
      {error && <p className="pos-error" role="alert">{error}</p>}
      {uncertain && <p>Reintenta para confirmar si el producto quedó guardado.</p>}
      <div className="dialog-actions">{conflict ? <button type="button" className="pos-button pos-primary" onClick={onRefresh}>Cargar catálogo actual</button> : <button className="pos-button pos-primary" disabled={busy} aria-busy={busy}>{busy ? 'Guardando…' : uncertain ? 'Reintentar guardado' : 'Guardar producto'}</button>}<button type="button" className="pos-button pos-secondary" disabled={busy} onClick={onClose}>Cancelar</button></div>
    </form>
  </PosDialog>
}

function ProductActivation({ product, access, onClose, onSaved, onRefresh, onSessionError }: {
  product: Product; access: PosAccess; onClose: () => void; onSaved: (product: Product) => void; onRefresh: () => void; onSessionError?: (error: AccountClientError) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const submitting = useRef(false)
  const operationId = useRef(crypto.randomUUID())
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function save() {
    if (submitting.current) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const saved = await posRequest(access, { command: 'set_product_active', productId: product.id, expectedVersion: product.version, active: !product.active, operationId: operationId.current })
      if (mounted.current) onSaved(saved)
    } catch (caught) {
      if (!mounted.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos cambiar el producto.')
      if (caught instanceof AccountClientError) {
        setConflict(caught.code === 'PRODUCT_CHANGED')
        if (accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
      }
    } finally { submitting.current = false; if (mounted.current) setBusy(false) }
  }
  return <PosDialog title={product.active ? 'Desactivar producto' : 'Activar producto'} onClose={onClose} busy={busy}>
    <p><strong>{product.name}</strong>{product.active ? ' dejará de aparecer en nuevas ventas. Las ventas anteriores se conservan.' : ' volverá a estar disponible para vender.'}</p>
    {error && <p className="pos-error" role="alert">{error}</p>}
    <div className="dialog-actions">{conflict ? <button className="pos-button pos-primary" onClick={onRefresh}>Cargar catálogo actual</button> : <button className="pos-button pos-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Guardando…' : product.active ? 'Desactivar' : 'Activar'}</button>}<button className="pos-button pos-secondary" disabled={busy} onClick={onClose}>Cancelar</button></div>
  </PosDialog>
}
