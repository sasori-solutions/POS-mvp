import { useEffect, useRef, useState } from 'react'
import { Check, Minus, Plus, MoreHorizontal, ShoppingBag, Star, Trash2 } from 'lucide-react'
import { AccountClientError } from '../lib/account'
import type { PaymentMethod } from '../lib/contracts'
import type { CartLine, ItemSelection, Product, Sale } from '../lib/pos-contracts'
import { cartTotal, filterProducts, maxQuantity, maxSaleLines, money, posRequest, type PosAccess } from '../lib/pos'
import { clearPendingSale, pendingSaleKey, readPendingSale, writePendingSale, type PendingSale } from '../lib/pending-sale'
import { productDetails, isSoldOut, lineKey, selectedPrice, selectionLabel, includedTax } from '../lib/product-details'
import { number } from '../lib/format'
import ProductSelection from './ProductSelection'
import { BackToCatalog, CatalogFilters, EmptyCatalog, paymentLabels, SaleDetail, PosDialog } from './PosShared'
import { accessErrorCodes, type CatalogState } from './useCatalog'

function saleCommand(cart: CartLine[], paymentMethod: PaymentMethod, totalCents: number, operationId: string): PendingSale {
  return { command: 'complete_sale', operationId, paymentMethod, totalCents,
    items: cart.map(line => ({ productId: line.product.id, quantity: line.quantity, unitPriceCents: selectedPrice(line.product, line.selection), version: line.product.version, ...(line.selection ? {selection: line.selection} : {}) })) }
}

export default function SaleScreen({ access, employeeId, catalog, onProducts, onHistory, onSessionError }: {
  access: PosAccess; employeeId: string; catalog: CatalogState; onProducts: () => void; onHistory: () => void; onSessionError?: (error: AccountClientError) => void
}) {
  const [choosing, setChoosing] = useState<Product | null>(null)
  const [availability, setAvailability] = useState<Product | null>(null)
  const [favorites, setFavorites] = useState(false)
  const availabilityRequest = useRef<{ product: Product; soldOut: boolean; operationId: string } | null>(null)
  const [availabilityBusy, setAvailabilityBusy] = useState(false)
  const [availabilityError, setAvailabilityError] = useState('')
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
  const filtered = filterProducts(activeProducts.filter(p => !favorites || p.details?.favorite), query, category)
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

  const displayCart: CartLine[] = pending ? pending.items.map(item => ({ product: {
    id: item.productId, name: catalog.products.find(product => product.id === item.productId)?.name ?? 'Producto de la venta pendiente',
    category: '', active: true, priceCents: item.unitPriceCents, version: item.version,
  }, quantity: item.quantity, selection: item.selection })) : cart
  let total = pending?.totalCents ?? 0
  let totalError = ''
  if (!pending) { try { total = cartTotal(cart) } catch (caught) { totalError = caught instanceof Error ? caught.message : 'Revisa la venta.' } }
  if (!pending && !totalError && new TextEncoder().encode(JSON.stringify(saleCommand(cart, 'card_external', total, '00000000-0000-4000-8000-000000000000'))).length > 6800) totalError = 'La cuenta tiene demasiadas opciones. Divídela en dos ventas antes de cobrar.'
  const outdated = !pending && catalog.loaded && cart.some(line => {
    const current = catalog.products.find(product => product.id === line.product.id)
    return !current?.active || isSoldOut(current) || current.version !== line.product.version
  })
  const stockExceeded = cart.some(line => { const d = productDetails(line.product); return d.trackStock && cart.filter(l => l.product.id === line.product.id).reduce((sum,l) => sum+l.quantity,0) > d.stock })
  const canCheckout = cart.length > 0 && !outdated && !stockExceeded && !totalError && catalog.loaded && !catalog.error && online && !frozen

  function add(product: Product, selection?: ItemSelection) {
    if (frozen || checkout || isSoldOut(product)) return
    const key = lineKey({ product, selection })
    const existing = cart.find(line => lineKey(line) === key)
    if (existing && existing.quantity >= maxQuantity) { setError(`Máximo ${maxQuantity} unidades por producto.`); return }
    if (!existing && cart.length >= maxSaleLines) { setError(`Máximo ${maxSaleLines} productos distintos por venta.`); return }
    const next = existing ? cart.map(line => lineKey(line) === key ? { ...line, quantity: line.quantity + 1 } : line) : [...cart, { product, quantity: 1, selection }]
    try { cartTotal(next) } catch (caught) { setError((caught as Error).message); return }
    setCart(next); setError(''); setNotice(`${product.name} agregado a la venta.`)
  }
  function quantity(key: string, change: number) {
    if (frozen) return
    const next = cart.map(line => lineKey(line) === key ? { ...line, quantity: line.quantity + change } : line).filter(line => line.quantity > 0)
    try { cartTotal(next) } catch (caught) { setError((caught as Error).message); return }
    setCart(next); setError('')
  }
  useEffect(() => {
    if (pending || busy || !catalog.loaded || catalog.error) return
    const changed = cart.some(line => { const current = catalog.products.find(p => p.id === line.product.id); return !current || current.version !== line.product.version || isSoldOut(current) })
    if (!changed) return
    setCart(previous => previous.flatMap(line => {
      const product = catalog.products.find(p => p.id === line.product.id && p.active && !isSoldOut(p))
      if (!product) return []
      const d = productDetails(product), selection = line.selection
      if (d.variations.length && !d.variations.some(v => v.id === selection?.variationId && !v.soldOut)) return []
      if (selection?.variationId && !d.variations.some(v => v.id === selection.variationId)) return []
      if (d.variablePrice && selection?.variablePriceCents == null) return []
      if (!d.variablePrice && selection?.variablePriceCents != null) return []
      if (selection?.modifierIds.some(id => !d.modifierSets.some(s => s.options.some(o => o.id === id)))) return []
      if (d.modifierSets.some(s => { const n = s.options.filter(o => selection?.modifierIds.includes(o.id)).length; return n < s.min || n > s.max })) return []
      return [{ ...line, product }]
    }))
    setCheckout(false); setNotice(previous => previous.includes('La venta no se registró') ? previous : 'El catálogo cambió. Revisamos precios y disponibilidad. Comprueba la cuenta antes de cobrar.')
  }, [catalog.products, catalog.loaded, catalog.error, cart, pending, busy])

  async function toggleAvailability(product: Product) {
    if (availabilityBusy) return
    const command = availabilityRequest.current ?? { product, soldOut: !productDetails(product).soldOut, operationId: crypto.randomUUID() }
    availabilityRequest.current = command
    setAvailabilityBusy(true); setAvailabilityError('')
    try {
      const saved = await posRequest(access, { command: 'set_product_sold_out', operationId: command.operationId, productId: command.product.id, expectedVersion: command.product.version, soldOut: command.soldOut })
      if (!mounted.current) return
      catalog.upsert(saved); setAvailability(null); availabilityRequest.current = null; setNotice(command.soldOut ? `${saved.name} marcado como agotado.` : isSoldOut(saved) ? `${saved.name} sigue agotado. Revisa sus existencias y variantes en Productos.` : `${saved.name} disponible de nuevo.`)
    } catch (caught) {
      if (!mounted.current) return
      setAvailabilityError(caught instanceof Error ? caught.message : 'No pudimos cambiar la disponibilidad.')
      if (caught instanceof AccountClientError) {
        if (!['NETWORK_ERROR','SERVER_ERROR'].includes(caught.code)) availabilityRequest.current = null
        if (caught.code === 'PRODUCT_CHANGED') { setAvailability(null); void catalog.refresh(); setError('El producto cambió. Revisa su disponibilidad e intenta de nuevo.') }
        if (accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
      }
    } finally { if (mounted.current) setAvailabilityBusy(false) }
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
            const next = saleCommand(cart, payment, total, crypto.randomUUID())
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
      setReceipt(sale); setCart([]); void catalog.refresh(); setCheckout(false); setShowCart(false)
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
        }, quantity: item.quantity, selection: item.selection })))
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
      <div className="sale-library-tabs" role="group" aria-label="Vista del catálogo"><button aria-pressed={!favorites} onClick={() => setFavorites(false)}>Todos los productos</button><button aria-pressed={favorites} onClick={() => setFavorites(true)}><Star size={17} aria-hidden="true" />Favoritos</button></div>
      <CatalogFilters products={activeProducts} query={query} category={category} onQuery={setQuery} onCategory={setCategory} />
      {!online && <p className="pos-warning" role="status">Sin conexión. Conéctate para registrar la venta.</p>}
      {catalog.error && <div className="pos-error" role="alert"><p>{catalog.error}</p><button className="pos-button pos-secondary compact" onClick={() => void catalog.refresh()} disabled={catalog.loading}>Reintentar</button></div>}
      {catalog.loading && !catalog.loaded && <p className="pos-status" role="status">Cargando productos…</p>}
      {catalog.loaded && !activeProducts.length ? <EmptyCatalog description="Agrega productos activos para empezar a vender."><button className="pos-button pos-secondary compact" onClick={onProducts}>Ver productos</button></EmptyCatalog>
        : catalog.loaded && !filtered.length ? <EmptyCatalog title="No encontramos productos" description="Prueba otro nombre o categoría." />
        : <div className="touch-catalog">{filtered.map(product => {
          const amount = cart.filter(line => line.product.id === product.id).reduce((sum,line) => sum + line.quantity,0)
          const d = productDetails(product), soldOut = isSoldOut(product)
          const prices = d.variations.filter(v => !v.soldOut).map(v => v.priceCents)
          const shownPrice = prices.length ? Math.min(...prices) : product.priceCents
          return <div className={`touch-product-wrap ${soldOut ? 'sold-out-tile' : ''}`} key={product.id}>
            <button className="touch-product" onClick={() => d.variations.length || d.modifierSets.length || d.variablePrice ? setChoosing(product) : add(product)} disabled={frozen || checkout || soldOut} aria-label={`Agregar ${product.name}, ${money(shownPrice)}`}>
              <span className="tile-visual" style={{backgroundColor:d.tileColor}}>{product.image ? <img src={product.image} alt="" loading="lazy" /> : <span className="tile-monogram">{d.tileLabel || product.name.slice(0,2).toLocaleUpperCase('es-MX')}</span>}</span>
              <span className="tile-copy"><strong>{product.name}</strong><b>{d.variablePrice ? 'Precio variable' : `${prices.length ? 'Desde ' : ''}${money(shownPrice)}`}</b>{soldOut ? <small className="tile-stock">Agotado</small> : d.trackStock && <small className="tile-stock">{d.stock <= d.lowStockAlert ? 'Pocas existencias · ' : ''}{number(d.stock)} disponibles</small>}</span>
              {amount > 0 && <span className="touch-product-quantity" aria-hidden="true">{amount}</span>}
            </button>
            <button className="tile-menu pos-icon-button" aria-label={`Disponibilidad de ${product.name}`} disabled={frozen || checkout || availabilityBusy} onClick={() => { setAvailability(product); setAvailabilityError('') }}><MoreHorizontal size={20} aria-hidden="true" /></button>
          </div>
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
      {!displayCart.length && !storageError && <div className="empty-cart"><ShoppingBag size={40} strokeWidth={1.2} aria-hidden="true" /><h3>Tu cuenta está vacía</h3><p>Toca un producto para comenzar.</p></div>}
      <ul className="cart-lines">{displayCart.map(line => {
        const {product, quantity:amount, selection} = line, key = lineKey(line), price = selectedPrice(product,selection)
        return <li key={key}><div className="cart-line-heading"><strong>{product.name}</strong><span>{money(price * amount)}</span></div>{selectionLabel(product,selection) && <p>{selectionLabel(product,selection)}</p>}<p>{money(price)} por unidad</p>{!checkout && !pending ? <div className="quantity-controls"><button className="pos-icon-button" aria-label={`Disminuir ${product.name}`} disabled={frozen} onClick={() => quantity(key,-1)}><Minus size={18} aria-hidden="true" /></button><span aria-label={`Cantidad de ${product.name}`}>{amount}</span><button className="pos-icon-button" aria-label={`Aumentar ${product.name}`} disabled={frozen || amount >= maxQuantity} onClick={() => quantity(key,1)}><Plus size={18} aria-hidden="true" /></button><button className="pos-icon-button cart-remove" aria-label={`Quitar ${product.name}`} disabled={frozen} onClick={() => { setCart(previous => previous.filter(l => lineKey(l) !== key)); setError('') }}><Trash2 size={18} aria-hidden="true" /></button></div> : <p>Cantidad: {amount}</p>}</li>
      })}</ul>
      {outdated && <p className="pos-warning" role="status">Revisando disponibilidad y precios…</p>}
      {stockExceeded && <p className="pos-warning" role="alert">La cantidad supera las existencias. Reduce las unidades de la cuenta.</p>}
      {totalError && <p className="pos-error" role="alert">{totalError}</p>}
      </div>
      <div className="cart-checkout"><dl className="sale-totals">{!pending && cart.some(l => l.product.details?.taxBps) && <div><dt>Impuestos incluidos</dt><dd>{money(cart.reduce((sum,l) => sum+includedTax(selectedPrice(l.product,l.selection)*l.quantity,l.product.details?.taxBps ?? 0),0))}</dd></div>}<div className="sale-total"><dt>Total MXN</dt><dd>{money(total)}</dd></div></dl>
        {checkout || pending ? <>
          <fieldset className="sale-payment-methods" disabled={frozen}><legend>Método de pago</legend>{(pending ? [pending.paymentMethod] : catalog.paymentMethods).map(method => <label key={method}><input type="radio" name="sale-payment" value={method} checked={payment === method} onChange={() => setPayment(method)} /><span>{paymentLabels[method]}</span></label>)}</fieldset>
          {payment === 'card_external' ? <p className="payment-instructions">Cobra en tu terminal y registra el pago.</p> : payment === 'transfer' ? <p className="payment-instructions">Verifica que recibiste la transferencia antes de registrar el pago.</p> : <p className="payment-instructions">Recibe el efectivo antes de confirmar la venta.</p>}
          <button className="pos-button pos-primary" disabled={busy || storageError || !online || (!pending && (!canCheckout || !catalog.paymentMethods.includes(payment)))} aria-busy={busy} onClick={() => void register()}>{busy ? 'Registrando…' : pending ? 'Reintentar registro' : payment === 'cash' ? 'Confirmar venta' : 'Registrar pago'}</button>
          {!pending && <button className="pos-button pos-secondary" disabled={busy} onClick={() => setCheckout(false)}>Editar venta</button>}
        </> : <button className="pos-button pos-primary" disabled={!canCheckout} onClick={() => { setCheckout(true); setShowCart(true); setNotice(''); setError('') }}>Cobrar {money(total)}</button>}
      </div>
    </aside>
    {choosing && <ProductSelection product={choosing} onClose={() => setChoosing(null)} onAdd={selection => add(choosing,selection)} />}
    {availability && <PosDialog title={availability.name} onClose={() => { setAvailability(null); availabilityRequest.current = null }} busy={availabilityBusy}>
      <p>{productDetails(availability).soldOut ? 'Este producto está marcado como agotado.' : 'Cambia su disponibilidad para todas las cajas.'}</p>
      {productDetails(availability).trackStock && productDetails(availability).stock === 0 && <p className="pos-warning">Sin existencias. Repón el inventario en Productos para poder venderlo.</p>}
      {productDetails(availability).variations.length > 0 && productDetails(availability).variations.every(v => v.soldOut) && <p className="pos-warning">Sus variantes están agotadas. Revisa su disponibilidad en Productos.</p>}
      {availabilityError && <p className="pos-error" role="alert">{availabilityError}</p>}
      <div className="dialog-actions"><button className="pos-button pos-primary" disabled={availabilityBusy} onClick={() => void toggleAvailability(availability)}>{availabilityBusy ? 'Guardando…' : productDetails(availability).soldOut ? 'Marcar disponible' : 'Marcar agotado'}</button></div>
    </PosDialog>}
    <div className="catalog-announcement" role="status" aria-live="polite">{!showCart && !checkout ? notice : ''}{!showCart && !checkout && error ? ` ${error}` : ''}</div>
  </div>
}
