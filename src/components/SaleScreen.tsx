import { useEffect, useRef, useState } from 'react'
import { Check, Minus, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { AccountClientError } from '../lib/account'
import type { PaymentMethod } from '../lib/contracts'
import type { CartLine, Product, Sale } from '../lib/pos-contracts'
import { cartTotal, filterProducts, maxQuantity, maxSaleLines, money, posRequest, type PosAccess } from '../lib/pos'
import { clearPendingSale, pendingSaleKey, readPendingSale, writePendingSale, type PendingSale } from '../lib/pending-sale'
import { BackToCatalog, CatalogFilters, EmptyCatalog, paymentLabels, SaleDetail } from './PosShared'
import { accessErrorCodes, type CatalogState } from './useCatalog'

export default function SaleScreen({ access, employeeId, catalog, onProducts, onHistory, onSessionError }: {
  access: PosAccess; employeeId: string; catalog: CatalogState; onProducts: () => void; onHistory: () => void; onSessionError?: (error: AccountClientError) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [showCart, setShowCart] = useState(false)
  const [checkout, setCheckout] = useState(false)
  const [payment, setPayment] = useState<PaymentMethod>('cash')
  const [pending, setPending] = useState<PendingSale | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [receipt, setReceipt] = useState<Sale | null>(null)
  const [storageError, setStorageError] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const mounted = useRef(true)
  const submitting = useRef(false)
  const pendingRef = useRef<PendingSale | null>(null)
  const completedOperation = useRef<string | null>(null)
  const storageKey = pendingSaleKey(access.businessId, employeeId)
  const activeProducts = catalog.products.filter(product => product.active)
  const filtered = filterProducts(activeProducts, query, category)
  const frozen = busy || Boolean(pending) || storageError

  async function clearStoredOperation(operationId: string) {
    if (navigator.locks) await navigator.locks.request(storageKey, () => clearPendingSale(storageKey, operationId))
    else clearPendingSale(storageKey, operationId)
  }

  function restorePending() {
    try {
      const command = readPendingSale(storageKey)
      pendingRef.current = command
      setPending(command)
      setStorageError(false)
      setError('')
      if (command) { setCheckout(true); setShowCart(true); setPayment(command.paymentMethod); setNotice('Hay una venta por confirmar. Reintenta el registro sin volver a cobrar.') }
    } catch (caught) { setStorageError(true); setError(caught instanceof Error ? caught.message : 'No pudimos leer el registro pendiente de este dispositivo.') }
  }

  useEffect(() => {
    mounted.current = true
    restorePending()
    const connected = () => setOnline(navigator.onLine)
    const stored = (event: StorageEvent) => { if (event.key === storageKey && event.newValue && !submitting.current) restorePending() }
    window.addEventListener('online', connected); window.addEventListener('offline', connected)
    window.addEventListener('storage', stored)
    return () => { mounted.current = false; window.removeEventListener('online', connected); window.removeEventListener('offline', connected); window.removeEventListener('storage', stored) }
  }, [storageKey])

  useEffect(() => {
    if (!pending && !checkout && catalog.paymentMethods.length && !catalog.paymentMethods.includes(payment)) setPayment(catalog.paymentMethods[0])
  }, [catalog.paymentMethods, payment, pending, checkout])

  const displayCart = pending ? pending.items.map(item => ({ product: {
    id: item.productId, name: catalog.products.find(product => product.id === item.productId)?.name ?? 'Producto de la venta pendiente',
    category: '', active: true, priceCents: item.unitPriceCents, version: item.version,
  }, quantity: item.quantity })) : cart
  let total = pending?.totalCents ?? 0
  let totalError = ''
  if (!pending) { try { total = cartTotal(cart) } catch (caught) { totalError = caught instanceof Error ? caught.message : 'Revisa la venta.' } }
  const outdated = !pending && catalog.loaded && cart.some(line => {
    const current = catalog.products.find(product => product.id === line.product.id)
    return !current?.active || current.version !== line.product.version
  })
  const canCheckout = cart.length > 0 && !outdated && !totalError && catalog.loaded && !catalog.error && online && !frozen

  function add(product: Product) {
    if (frozen || checkout) return
    const existing = cart.find(line => line.product.id === product.id)
    if (existing && existing.quantity >= maxQuantity) { setError(`Máximo ${maxQuantity} unidades por producto.`); return }
    if (!existing && cart.length >= maxSaleLines) { setError(`Máximo ${maxSaleLines} productos distintos por venta.`); return }
    const next = existing ? cart.map(line => line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line) : [...cart, { product, quantity: 1 }]
    try { cartTotal(next) } catch (caught) { setError((caught as Error).message); return }
    setCart(next); setError(''); setNotice(`${product.name} agregado a la venta.`)
  }
  function quantity(productId: string, change: number) {
    if (frozen) return
    const next = cart.map(line => line.product.id === productId ? { ...line, quantity: line.quantity + change } : line).filter(line => line.quantity > 0)
    try { cartTotal(next) } catch (caught) { setError((caught as Error).message); return }
    setCart(next); setError('')
  }
  function updateCart() {
    setCart(previous => previous.flatMap(line => {
      const product = catalog.products.find(product => product.id === line.product.id && product.active)
      return product ? [{ ...line, product }] : []
    }))
    setCheckout(false); setError(''); setNotice('Venta actualizada. Revisa los productos y el total antes de cobrar.')
  }

  async function register() {
    if (submitting.current || storageError || !online) return
    let command = pendingRef.current
    if (!command && (!canCheckout || !catalog.paymentMethods.includes(payment))) return
    submitting.current = true; setBusy(true); setError(''); setNotice('')
    try {
      if (!command) {
        if (!navigator.locks) { setError('Este navegador no puede proteger el registro entre pestañas. Abre el POS en un navegador actualizado.'); return }
        let alreadyPending = false
        try {
          command = await navigator.locks.request(storageKey, () => {
            const stored = readPendingSale(storageKey)
            if (stored) { alreadyPending = true; return stored }
            const next: PendingSale = { command: 'complete_sale', operationId: crypto.randomUUID(), paymentMethod: payment, totalCents: total,
              items: cart.map(line => ({ productId: line.product.id, quantity: line.quantity, unitPriceCents: line.product.priceCents, version: line.product.version })) }
            writePendingSale(storageKey, next)
            return next
          })
        } catch (caught) {
          setError(caught instanceof Error && caught.message.includes('pendiente') ? caught.message : 'No pudimos conservar el registro en este dispositivo. Revisa el almacenamiento y reintenta el registro sin volver a cobrar.')
          return
        }
        if (!mounted.current) return
        pendingRef.current = command; setPending(command); setPayment(command.paymentMethod)
        if (alreadyPending) { setNotice('Hay una venta por confirmar en otra pestaña. Reintenta ese registro sin volver a cobrar.'); setCheckout(true); setShowCart(true); return }
      }
      const sale = await posRequest(access, command)
      if (!mounted.current) return
      completedOperation.current = command.operationId
      setReceipt(sale); setCart([]); setCheckout(false); setShowCart(false)
      try { await clearStoredOperation(command.operationId); pendingRef.current = null; setPending(null) }
      catch { setStorageError(true); setError('La venta está registrada. No pudimos limpiar el reintento local. Reintenta la limpieza antes de iniciar otra venta.') }
    } catch (caught) {
      if (!mounted.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos confirmar el registro.')
      if (caught instanceof AccountClientError && ['PRODUCT_CHANGED', 'PRODUCT_UNAVAILABLE', 'PAYMENT_METHOD_DISABLED', 'VALIDATION_ERROR'].includes(caught.code)) {
        // The server definitively refused the transaction; review the draft with current catalog.
        try { if (command) await clearStoredOperation(command.operationId); pendingRef.current = null; setPending(null) }
        catch { setStorageError(true) }
        if (command) setCart(command.items.map(item => ({ product: {
          id: item.productId, name: catalog.products.find(product => product.id === item.productId)?.name ?? 'Producto de la venta pendiente',
          category: '', active: true, priceCents: item.unitPriceCents, version: item.version,
        }, quantity: item.quantity })))
        setCheckout(false)
        setNotice('La venta no se registró. Revisa los productos, el cobro recibido y el total antes de continuar.')
        void catalog.refresh()
      } else {
        setNotice('El resultado aún no está confirmado. Reintenta este registro sin volver a cobrar.')
        if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
      }
    } finally { submitting.current = false; if (mounted.current) setBusy(false) }
  }

  if (receipt) return <div className="sale-result"><div className="sale-success-mark"><Check size={28} aria-hidden="true" /></div><h2>Venta registrada</h2><SaleDetail sale={receipt} />{error && <p className="pos-error" role="alert">{error}</p>}
    {storageError ? <button className="pos-button pos-primary" onClick={() => { void (async () => { try { if (completedOperation.current) await clearStoredOperation(completedOperation.current); pendingRef.current = null; setPending(null); setStorageError(false); setError('') } catch { setError('No pudimos limpiar el reintento. Conserva este dispositivo y pide ayuda.') } })() }}>Reintentar limpieza</button> : <button className="pos-button pos-primary" onClick={() => { setReceipt(null); setError(''); setNotice(''); setQuery(''); setCategory(''); restorePending() }}>Nueva venta</button>}
    <button className="pos-button pos-secondary" onClick={onHistory}>Ver ventas</button>
  </div>

  return <div className={`sale-workspace ${showCart || checkout || pending ? 'show-cart' : ''}`}>
    <div className="sale-catalog">
      <CatalogFilters products={activeProducts} query={query} category={category} onQuery={setQuery} onCategory={setCategory} />
      {!online && <p className="pos-warning" role="status">Sin conexión. Conéctate para registrar la venta.</p>}
      {catalog.error && <div className="pos-error" role="alert"><p>{catalog.error}</p><button className="pos-button pos-secondary compact" onClick={() => void catalog.refresh()} disabled={catalog.loading}>Reintentar</button></div>}
      {catalog.loading && !catalog.loaded && <p className="pos-status" role="status">Cargando productos…</p>}
      {catalog.loaded && !activeProducts.length ? <EmptyCatalog description="Agrega productos activos para empezar a vender."><button className="pos-button pos-secondary compact" onClick={onProducts}>Ver productos</button></EmptyCatalog>
        : catalog.loaded && !filtered.length ? <EmptyCatalog title="No encontramos productos" description="Prueba otro nombre o categoría." />
        : <div className="touch-catalog">{filtered.map(product => {
          const amount = cart.find(line => line.product.id === product.id)?.quantity ?? 0
          return <button key={product.id} className="touch-product" onClick={() => add(product)} disabled={frozen || checkout} aria-label={`Agregar ${product.name}, ${money(product.priceCents)}`}><strong>{product.name}</strong>{product.category && <span>{product.category}</span>}<b>{money(product.priceCents)}</b>{amount > 0 && <span className="touch-product-quantity" aria-hidden="true">{amount}</span>}</button>
        })}</div>}
      <div className="mobile-cart-action"><button className="pos-button pos-primary" onClick={() => setShowCart(true)} disabled={!displayCart.length && !storageError}>{displayCart.length ? `Ver cuenta (${displayCart.reduce((sum, line) => sum + line.quantity, 0)}) ${money(total)}` : 'Venta actual'}</button></div>
    </div>
    <aside className="current-sale" aria-label="Venta actual">
      {!pending && <div className="mobile-back"><BackToCatalog onClick={() => { setShowCart(false); setCheckout(false) }} /></div>}
      <div className="current-sale-heading"><h2>{checkout ? 'Registrar pago' : 'Venta actual'}</h2><span>{displayCart.reduce((sum, line) => sum + line.quantity, 0)} artículos</span></div>
      <div className="current-sale-body">
      {notice && <p className="pos-status" role="status">{notice}</p>}
      {error && <p className="pos-error" role="alert">{error}</p>}
      {storageError && <button className="pos-button pos-secondary" onClick={restorePending}>Revisar registro pendiente</button>}
      {!displayCart.length && !storageError && <p className="empty-cart">Selecciona productos para iniciar la venta.</p>}
      <ul className="cart-lines">{displayCart.map(({ product, quantity: amount }) => <li key={product.id}><div className="cart-line-heading"><strong>{product.name}</strong><span>{money(product.priceCents * amount)}</span></div><p>{money(product.priceCents)} por unidad</p>{!checkout && !pending ? <div className="quantity-controls"><button className="pos-icon-button" aria-label={`Disminuir ${product.name}`} disabled={frozen} onClick={() => quantity(product.id, -1)}><Minus size={18} aria-hidden="true" /></button><span aria-label={`Cantidad de ${product.name}`}>{amount}</span><button className="pos-icon-button" aria-label={`Aumentar ${product.name}`} disabled={frozen || amount >= maxQuantity} onClick={() => quantity(product.id, 1)}><Plus size={18} aria-hidden="true" /></button><button className="pos-icon-button cart-remove" aria-label={`Quitar ${product.name}`} disabled={frozen} onClick={() => { setCart(previous => previous.filter(line => line.product.id !== product.id)); setError('') }}><Trash2 size={18} aria-hidden="true" /></button></div> : <p>Cantidad: {amount}</p>}</li>)}</ul>
      {outdated && <div className="pos-warning" role="alert"><p>El catálogo cambió. Revisa los precios y retira los productos no disponibles.</p><button className="pos-button pos-secondary" onClick={updateCart}>Actualizar venta</button></div>}
      {totalError && <p className="pos-error" role="alert">{totalError}</p>}
      </div>
      <div className="cart-checkout"><dl className="sale-totals"><div className="sale-total"><dt>Total MXN</dt><dd>{money(total)}</dd></div></dl>
        {checkout || pending ? <>
          <fieldset className="sale-payment-methods" disabled={frozen}><legend>Método de pago</legend>{(pending ? [pending.paymentMethod] : catalog.paymentMethods).map(method => <label key={method}><input type="radio" name="sale-payment" value={method} checked={payment === method} onChange={() => setPayment(method)} /><span>{paymentLabels[method]}</span></label>)}</fieldset>
          {payment === 'card_external' ? <p className="payment-instructions">Cobra en tu terminal y registra el pago.</p> : payment === 'transfer' ? <p className="payment-instructions">Verifica que recibiste la transferencia antes de registrar el pago.</p> : <p className="payment-instructions">Recibe el efectivo antes de confirmar la venta.</p>}
          <button className="pos-button pos-primary" disabled={busy || storageError || !online || (!pending && (!canCheckout || !catalog.paymentMethods.includes(payment)))} aria-busy={busy} onClick={() => void register()}>{busy ? 'Registrando…' : pending ? 'Reintentar registro' : payment === 'cash' ? 'Confirmar venta' : 'Registrar pago'}</button>
          {!pending && <button className="pos-button pos-secondary" disabled={busy} onClick={() => setCheckout(false)}>Editar venta</button>}
        </> : <button className="pos-button pos-primary" disabled={!canCheckout} onClick={() => { setCheckout(true); setShowCart(true); setNotice(''); setError('') }}>Cobrar {money(total)}</button>}
        <button className="pos-button pos-secondary" disabled={catalog.loading || busy} onClick={() => void catalog.refresh()}><RefreshCw size={18} aria-hidden="true" />Actualizar catálogo</button>
      </div>
    </aside>
    <div className="catalog-announcement" role="status" aria-live="polite">{!showCart && !checkout ? notice : ''}{!showCart && !checkout && error ? ` ${error}` : ''}</div>
  </div>
}
