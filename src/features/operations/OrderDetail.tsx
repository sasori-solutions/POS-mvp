import { useEffect, useRef, useState } from 'react'
import type { BusinessContext, PaymentMethod } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { BalanceWaiver, CheckoutAttempt, OperationalOrder, OrderDiscount } from '../../lib/operations-contracts'
import { money, parsePrice, posRequest, type PosAccess } from '../../lib/pos'
import MoneyInput from '../../components/MoneyInput'
import { PosDialog } from '../../components/PosShared'
import { paymentLabels } from '../../components/PosShared'
import PaymentMethodPicker from '../../components/PaymentMethodPicker'
import AttemptPanel from './AttemptPanel'
import type { OperationalMutation } from './useOperations'
import type { AccountClientError } from '../../lib/account'
import { maxOperationalMoneyCents, parseOperationalMoney } from '../../lib/operational-money'
import { checkoutTotals, checkoutSelectionKey } from '../../lib/checkout-selection'
import { useCurrentAttempt } from './useCurrentAttempt'
import PointPayment from '../../components/PointPayment'
import type { PointSettings } from '../../lib/point-contracts'

export default function OrderDetail({ order, business, methods: configuredMethods, attempts, mutation, onSaved, onPaymentRecorded, onEdit, refresh, collectionAllowed, access, onSessionError, checkoutView = false, pointSettings, onPointBlocked }: { checkoutView?: boolean; order: OperationalOrder; business: BusinessContext; methods: PaymentMethod[]; attempts: CheckoutAttempt[]; mutation: OperationalMutation; onSaved: (order: OperationalOrder) => void; onPaymentRecorded?: (order: OperationalOrder) => void; onEdit: () => void; refresh: () => Promise<void>; collectionAllowed: boolean; access?: PosAccess; onSessionError?: (error: AccountClientError) => void; pointSettings?: PointSettings | null; onPointBlocked?: (blocked: boolean) => void }) {
  const methods = configuredMethods.filter(method => method !== 'card_integrated' || pointSettings?.enabled && pointSettings.permissions.charge)
  const [pointBusy, setPointBusy] = useState(false)
  const recovered = useRef(attempts.find(a => a.orderId === order.id && a.kind === 'payment'))
  const selectionAttemptId = useRef(recovered.current?.id ?? null)
  const [split, setSplit] = useState(() => Boolean(recovered.current && order.items.some(l => (recovered.current!.items.find(i => i.lineId === l.lineId)?.quantity ?? 0) !== l.quantity - l.paidQuantity)))
  const [quantities, setQuantities] = useState<Record<string, number>>(() => Object.fromEntries(order.items.map(l => [l.lineId, recovered.current ? recovered.current.items.find(i => i.lineId === l.lineId)?.quantity ?? 0 : l.quantity - l.paidQuantity])))
  const [method, setMethod] = useState<PaymentMethod>(recovered.current?.paymentMethod ?? methods[0] ?? 'cash')
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null)
  const [reason, setReason] = useState('')
  const [discountKind, setDiscountKind] = useState<'fixed' | 'percent'>('fixed')
  const [discountValue, setDiscountValue] = useState('')
  const [discountAction, setDiscountAction] = useState<{ discount: OrderDiscount | null } | null>(null)
  const [waiver, setWaiver] = useState<BalanceWaiver | null>(null)
  const [waiverConfirmed, setWaiverConfirmed] = useState(false)
  const allowed = (key: Parameters<typeof hasPermission>[1]) => hasPermission(business, key)
  const disabled = mutation.busy || Boolean(mutation.pending) || pointBusy
  const settled = ['paid', 'cancelled', 'waived', 'closed'].includes(order.status)
  const requested = useRef('')
  const [reservationError, setReservationError] = useState(false)
  const [reservationRetry, setReservationRetry] = useState(0)
  const remaining = order.items.map(l => `${l.lineId}:${l.quantity - l.paidQuantity}`).join('|')
  const remainingKey = useRef(remaining)
  useEffect(() => {
    if (remainingKey.current !== remaining) {
      remainingKey.current = remaining
      setQuantities(Object.fromEntries(order.items.map(l => [l.lineId, l.quantity - l.paidQuantity])))
    }
  }, [order.id, remaining])
  const persistedAttempt = attempts.find(a => a.orderId === order.id)
  useEffect(() => { if (persistedAttempt && (!attempt || persistedAttempt.id !== attempt.id || persistedAttempt.revision > attempt.revision)) setAttempt(persistedAttempt) }, [persistedAttempt, attempt])
  useEffect(() => {
    if (mutation.lastResult && ['prepare_checkout', 'update_checkout'].includes(mutation.lastResult.command)) {
      const accepted = mutation.lastResult.result as CheckoutAttempt
      if (accepted.orderId === order.id) setAttempt(previous => !previous || accepted.id !== previous.id || accepted.revision > previous.revision ? accepted : previous)
    }
  }, [mutation.lastResult, order.id])
  const selectedAttempt = persistedAttempt && persistedAttempt.id !== attempt?.id ? persistedAttempt : attempt ?? persistedAttempt
  const current = useCurrentAttempt(access, selectedAttempt, attempts, onSessionError)
  const currentAttempt = current.attempt
  const adoptingReservation = Boolean(currentAttempt && currentAttempt.id !== selectionAttemptId.current)
  useEffect(() => {
    if (!currentAttempt || !adoptingReservation) return
    selectionAttemptId.current = currentAttempt.id
    setMethod(currentAttempt.paymentMethod)
    setQuantities(Object.fromEntries(order.items.map(l => [l.lineId, currentAttempt.items.find(i => i.lineId === l.lineId)?.quantity ?? 0])))
    setSplit(order.items.some(l => (currentAttempt.items.find(i => i.lineId === l.lineId)?.quantity ?? 0) !== l.quantity - l.paidQuantity))
  }, [currentAttempt?.id, adoptingReservation])
  const items = order.items.map(l => ({ lineId: l.lineId, quantity: split ? Math.min(quantities[l.lineId] ?? 0, l.quantity - l.paidQuantity) : l.quantity - l.paidQuantity })).filter(l => l.quantity > 0)
  const selectionKey = checkoutSelectionKey(items)
  const totals = checkoutTotals(order, items)
  const reservationMatches = Boolean(currentAttempt?.status === 'prepared' && currentAttempt.paymentMethod === method && checkoutSelectionKey(currentAttempt.items) === selectionKey)
  const editableReservation = !pointBusy && (!currentAttempt || currentAttempt.status === 'prepared')
  useEffect(() => {
    if (adoptingReservation || settled || !allowed('sales.create') || !collectionAllowed || !methods.includes(method) || !items.length || disabled || !editableReservation || current.blocked) return
    if (reservationMatches) return
    const requestKey = `${order.id}:${currentAttempt?.id ?? order.revision}:${currentAttempt?.revision ?? 0}:${method}:${selectionKey}:${reservationRetry}`
    if (requested.current === requestKey) return
    requested.current = requestKey
    setReservationError(false)
    const request = currentAttempt
      ? { command: 'update_checkout' as const, operationId: crypto.randomUUID(), attemptId: currentAttempt.id, expectedRevision: currentAttempt.revision, items, paymentMethod: method }
      : { command: 'prepare_checkout' as const, operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, items, paymentMethod: method }
    void mutation.execute(request).then(saved => { selectionAttemptId.current = saved.id; setAttempt(saved); void refresh() }).catch(() => setReservationError(true))
  }, [order.id, order.revision, selectionKey, method, disabled, collectionAllowed, currentAttempt?.id, currentAttempt?.revision, current.blocked, editableReservation, reservationMatches, settled, reservationRetry, adoptingReservation])
  const parsedDiscount = discountKind === 'fixed' ? parseOperationalMoney(discountValue) : parsePrice(discountValue)
  async function transition(command: 'resume_order_service' | 'cancel_order' | 'close_order') {
    try {
      const common = { operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision }
      let saved: OperationalOrder
      switch (command) {
        case 'cancel_order': saved = await mutation.execute({ command, ...common, reason: reason.trim() }); break
        case 'resume_order_service': saved = await mutation.execute({ command, ...common }); break
        case 'close_order': saved = await mutation.execute({ command, ...common }); break
      }
      onSaved(saved); await refresh()
    } catch { /* Shell recovery. */ }
  }
  async function applyDiscount(discount: OrderDiscount | null) {
    try {
      let editableOrder = order
      if (currentAttempt?.status === 'prepared') {
        if (!access || current.blocked) return
        await mutation.execute({ command: 'resolve_checkout', operationId: crypto.randomUUID(), attemptId: currentAttempt.id, expectedRevision: currentAttempt.revision, resolution: 'abort', confirmed: true, reason: 'Operador confirma que no recibió pago antes de cambiar descuento' })
        editableOrder = await posRequest(access, { command: 'order', orderId: order.id })
      }
      onSaved(await mutation.execute({ command: 'set_order_discount', operationId: crypto.randomUUID(), orderId: editableOrder.id, expectedRevision: editableOrder.revision, discount }))
      await refresh(); setAttempt(null); setDiscountAction(null)
    } catch { /* Keep recovery and the accepted reservation visible. */ }
  }
  function discount(discount: OrderDiscount | null) {
    if (currentAttempt?.status === 'prepared') setDiscountAction({discount})
    else void applyDiscount(discount)
  }
  async function recordPayment() {
    if (method === 'card_integrated') return
    if (!items.length || !currentAttempt || !reservationMatches || current.blocked) return
    try {
      const result = await mutation.execute({ command: 'record_checkout', operationId: crypto.randomUUID(), attemptId: currentAttempt.id, expectedRevision: currentAttempt.revision, confirmed: true })
      if (onPaymentRecorded) onPaymentRecorded(result.order)
      else onSaved(result.order)
      void refresh()
    } catch { /* Retry the same persisted payment; never request payment again. */ }
  }
  async function prepareWaiver() { try { setWaiver(await mutation.execute({ command: 'prepare_waiver', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, reason: reason.trim() })); setWaiverConfirmed(false) } catch { /* Shell recovery. */ } }
  return <div className={checkoutView ? 'checkout-layout' : 'ops-form'}>
    <div className={checkoutView ? 'checkout-summary' : 'ops-form'}>
    {checkoutView && <div className="checkout-amount"><p>Saldo a cobrar · MXN</p><strong>{money(totals.totalCents)}</strong></div>}
    {checkoutView && <h3 className="checkout-section-title">{order.name}</h3>}
    <p>{order.phase === 'checkout' ? 'Cuenta final' : 'En servicio'}{order.frozen ? ' · Artículos y descuento fijos' : ''}</p>
    <ul className="ops-list">{order.items.map(line => <li key={line.lineId}><span><strong>{line.quantity} × {line.name}</strong><small>{line.selectionLabel}{line.note ? ` · ${line.note}` : ''}</small><small>{line.sentQuantity} enviados · {line.paidQuantity} pagados</small></span><span>{money(line.totalCents)}{split && line.quantity > line.paidQuantity && <label>En este cobro<input aria-label={`Cantidad a cobrar de ${line.name}`} type="number" inputMode="numeric" min={0} max={line.quantity - line.paidQuantity} step={1} value={quantities[line.lineId] ?? 0} disabled={disabled || !editableReservation} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= line.quantity - line.paidQuantity) setQuantities(previous => ({ ...previous, [line.lineId]: n })) }} /></label>}</span></li>)}</ul>
    <dl className="ops-totals"><div><dt>Subtotal</dt><dd>{money(checkoutView ? totals.grossCents : order.grossCents)}</dd></div>{order.discount && <div><dt>Descuento · {order.discount.reason}</dt><dd>−{money(checkoutView ? totals.discountCents : order.discountCents)}</dd></div>}<div><dt>IVA incluido conocido</dt><dd>{money(checkoutView ? totals.taxCents : order.taxCents)}</dd></div>{(!checkoutView || order.paidCents > 0) && <div><dt>Pagado</dt><dd>{money(order.paidCents)}</dd></div>}{order.waivedCents > 0 && <div><dt>Condonado</dt><dd>{money(order.waivedCents)}</dd></div>}{order.cancelledCents > 0 && <div><dt>Cancelado</dt><dd>{money(order.cancelledCents)}</dd></div>}{!checkoutView && <div><dt>Saldo</dt><dd>{money(order.balanceCents)}</dd></div>}</dl>
    </div><div className={checkoutView ? 'checkout-controls ops-form' : 'ops-form'}>
    {!checkoutView && order.status !== 'closed' && !settled && order.phase === 'service' && !order.frozen && <>
      {(allowed('orders.manage') || allowed('sales.create')) && <button className="pos-button pos-secondary" disabled={disabled} onClick={onEdit}>Editar artículos</button>}
    </>}
    {!settled && allowed('sales.create') && editableReservation && <section className="ops-card">
      <h3>Cobrar cuenta</h3><label className="ops-check"><input type="checkbox" checked={split} disabled={disabled} onChange={e => setSplit(e.target.checked)} /><span>Dividir por artículos</span></label>
      {checkoutView ? <PaymentMethodPicker name="order-payment" methods={methods} value={method} onChange={setMethod} disabled={disabled} /> : <label>Método de pago<select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} disabled={disabled}>{methods.map(m => <option key={m} value={m}>{paymentLabels[m]}</option>)}</select></label>}
      {method !== 'card_integrated' && (reservationMatches && !current.blocked ? <p>Recibe {money(currentAttempt!.totalCents)} y registra el pago para crear la comanda.</p> : <p role="status">{reservationError ? 'No pudimos reservar este cobro.' : items.length ? 'Reservando el cobro…' : 'Selecciona artículos para cobrar.'}</p>)}
      {reservationError && !mutation.pending && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => setReservationRetry(n => n + 1)}>Reintentar reserva</button>}
      {!collectionAllowed && <p role="status">Abre o reanuda el turno en Caja antes de cobrar.</p>}
      {method !== 'card_integrated' && <button className="pos-button pos-primary" disabled={disabled || current.blocked || !reservationMatches || !collectionAllowed || !methods.length || !order.items.length || (split && !Object.values(quantities).some(n => n > 0))} onClick={() => void recordPayment()}>Registrar pago</button>}
      {!checkoutView && order.phase === 'checkout' && !order.frozen && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => void transition('resume_order_service')}>Volver al servicio</button>}
    </section>}
    {current.loading && <p role="status">Consultando el estado del intento…</p>}
    {current.error && <p role="alert">{current.error}<button className="pos-button pos-secondary" onClick={current.retry}>Reintentar consulta</button></p>}
    {currentAttempt?.paymentMethod === 'card_integrated' && access && <PointPayment key={currentAttempt.id} access={access} attempt={currentAttempt} initialCheckout={pointSettings?.pending.find(checkout => checkout.checkout.id === currentAttempt.id)} settings={pointSettings ?? null} onSessionError={onSessionError} onBlocked={blocked => { setPointBusy(blocked); onPointBlocked?.(blocked) }} onResolved={() => { void refresh() }} onDone={() => { void posRequest(access, { command: 'order', orderId: order.id }).then(saved => { setPointBusy(false); onPointBlocked?.(false); if (onPaymentRecorded) onPaymentRecorded(saved); else onSaved(saved); void refresh() }) }} />}
    {currentAttempt && currentAttempt.paymentMethod !== 'card_integrated' && currentAttempt.status !== 'prepared' && <><AttemptPanel attempt={currentAttempt} mutation={{ ...mutation, busy: mutation.busy || current.blocked }} collectionAllowed={collectionAllowed} onSaved={a => { setAttempt(a); void refresh() }} />{['completed', 'aborted'].includes(currentAttempt.status) && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => { void refresh().then(() => setAttempt(null)) }}>Continuar con la cuenta</button>}</>}
    {!settled && !order.frozen && editableReservation && allowed('sales.discount') && <details><summary>Descuento de toda la cuenta</summary><div className="ops-form"><label>Tipo<select value={discountKind} onChange={e => setDiscountKind(e.target.value as 'fixed' | 'percent')} disabled={disabled}><option value="fixed">Importe fijo</option><option value="percent">Porcentaje</option></select></label><label>{discountKind === 'fixed' ? 'Importe' : 'Porcentaje (0–100)'}{discountKind === 'fixed' ? <MoneyInput maxCents={maxOperationalMoneyCents} value={discountValue} onValueChange={setDiscountValue} disabled={disabled} /> : <input value={discountValue} inputMode="decimal" onChange={e => setDiscountValue(e.target.value)} disabled={disabled} />}</label><label>Motivo<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={disabled} /></label><button className="pos-button pos-primary" disabled={disabled || !reason.trim() || parsedDiscount === null || (discountKind === 'percent' && (parsedDiscount ?? 10001) > 10000)} onClick={() => { const value = parsedDiscount; if (value !== null) void discount({ kind: discountKind, value, reason: reason.trim() }) }}>Aplicar descuento</button>{order.discount && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => void discount(null)}>Quitar descuento</button>}</div></details>}
    {!settled && !currentAttempt && (allowed('orders.cancel') || business.role === 'owner') && <details><summary>Cancelar o condonar saldo pendiente</summary><div className="ops-form"><p>Las preparaciones enviadas quedan en el historial. Los pagos registrados se conservan.</p><label>Motivo<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={disabled} /></label>{allowed('orders.cancel') && <button className="pos-button pos-secondary" disabled={disabled || !reason.trim()} onClick={() => void transition('cancel_order')}>Cancelar saldo de artículos sin preparar</button>}{business.role === 'owner' && <button className="pos-button pos-secondary" disabled={disabled || !reason.trim()} onClick={() => void prepareWaiver()}>Preparar condonación del saldo</button>}{waiver && waiver.status === 'prepared' && <section className="ops-card"><p>Condonar {money(waiver.amountCents)} · {waiver.reason}</p><label className="ops-check"><input type="checkbox" checked={waiverConfirmed} onChange={e => setWaiverConfirmed(e.target.checked)} /><span>Apruebo que este saldo preparado o entregado quede sin cobrar.</span></label><button className="pos-button pos-primary" disabled={disabled || !waiverConfirmed} onClick={() => { void (async () => { try { setWaiver(await mutation.execute({ command: 'confirm_waiver', operationId: crypto.randomUUID(), waiverId: waiver.id, expectedRevision: waiver.revision, confirmed: true })); await refresh() } catch { /* Shell recovery. */ } })() }}>Confirmar condonación</button></section>}</div></details>}
    {order.status !== 'closed' && settled && (allowed('orders.manage') || allowed('sales.create')) && <><p>El saldo está resuelto.</p><button className="pos-button pos-primary" disabled={disabled} onClick={() => void transition('close_order')}>Cerrar cuenta</button></>}
    </div>
    {discountAction && <PosDialog title="¿Cambiar el descuento?" busy={disabled} onClose={() => setDiscountAction(null)}>
      <p>Confirma que aún no recibiste dinero. Reservaremos el importe actualizado antes de cobrar.</p>
      <div className="dialog-actions"><button className="pos-button pos-primary" disabled={disabled || current.blocked} onClick={() => void applyDiscount(discountAction.discount)}>No recibí pago · Cambiar descuento</button><button className="pos-button pos-secondary" disabled={disabled} onClick={() => setDiscountAction(null)}>Cancelar</button></div>
    </PosDialog>}
  </div>
}
