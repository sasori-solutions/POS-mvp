import { useEffect, useState } from 'react'
import type { BusinessContext, PaymentMethod } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { BalanceWaiver, CheckoutAttempt, DiningTable, OperationalOrder, OrderDiscount } from '../../lib/operations-contracts'
import { money, parsePrice, type PosAccess } from '../../lib/pos'
import MoneyInput from '../../components/MoneyInput'
import { paymentLabels } from '../../components/PosShared'
import AttemptPanel from './AttemptPanel'
import type { OperationalMutation } from './useOperations'
import type { AccountClientError } from '../../lib/account'
import { maxOperationalMoneyCents, parseOperationalMoney } from '../../lib/operational-money'
import { useCurrentAttempt } from './useCurrentAttempt'

export default function OrderDetail({ order, business, tables, methods, attempts, mutation, onSaved, onEdit, refresh, collectionAllowed, access, onSessionError }: { order: OperationalOrder; business: BusinessContext; tables: DiningTable[]; methods: PaymentMethod[]; attempts: CheckoutAttempt[]; mutation: OperationalMutation; onSaved: (order: OperationalOrder) => void; onEdit: () => void; refresh: () => Promise<void>; collectionAllowed: boolean; access?: PosAccess; onSessionError?: (error: AccountClientError) => void }) {
  const [split, setSplit] = useState(false)
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [method, setMethod] = useState<PaymentMethod>(methods[0] ?? 'cash')
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null)
  const [reason, setReason] = useState('')
  const [discountKind, setDiscountKind] = useState<'fixed' | 'percent'>('fixed')
  const [discountValue, setDiscountValue] = useState('')
  const [tableId, setTableId] = useState(order.tableId ?? '')
  const [waiver, setWaiver] = useState<BalanceWaiver | null>(null)
  const [waiverConfirmed, setWaiverConfirmed] = useState(false)
  const allowed = (key: Parameters<typeof hasPermission>[1]) => hasPermission(business, key)
  const disabled = mutation.busy || Boolean(mutation.pending)
  const settled = ['paid', 'cancelled', 'waived', 'closed'].includes(order.status)
  useEffect(() => { setQuantities(Object.fromEntries(order.items.map(l => [l.lineId, l.quantity - l.paidQuantity]))); setTableId(order.tableId ?? '') }, [order.id, order.revision])
  const persistedAttempt = attempts.find(a => a.orderId === order.id)
  useEffect(() => { if (persistedAttempt && (!attempt || persistedAttempt.id !== attempt.id || persistedAttempt.revision > attempt.revision)) setAttempt(persistedAttempt) }, [persistedAttempt, attempt])
  const selectedAttempt = persistedAttempt && persistedAttempt.id !== attempt?.id ? persistedAttempt : attempt ?? persistedAttempt
  const current = useCurrentAttempt(access, selectedAttempt, attempts, onSessionError)
  const currentAttempt = current.attempt
  const parsedDiscount = discountKind === 'fixed' ? parseOperationalMoney(discountValue) : parsePrice(discountValue)
  async function transition(command: 'send_order' | 'begin_order_checkout' | 'resume_order_service' | 'cancel_order' | 'close_order') {
    try {
      const common = { operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision }
      let saved: OperationalOrder
      switch (command) {
        case 'cancel_order': saved = await mutation.execute({ command, ...common, reason: reason.trim() }); break
        case 'send_order': saved = await mutation.execute({ command, ...common }); break
        case 'begin_order_checkout': saved = await mutation.execute({ command, ...common }); break
        case 'resume_order_service': saved = await mutation.execute({ command, ...common }); break
        case 'close_order': saved = await mutation.execute({ command, ...common }); break
      }
      onSaved(saved); await refresh()
    } catch { /* Shell recovery. */ }
  }
  async function discount(discount: OrderDiscount | null) { try { onSaved(await mutation.execute({ command: 'set_order_discount', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, discount })); await refresh() } catch { /* Shell recovery. */ } }
  async function prepare() {
    const items = order.items.map(l => ({ lineId: l.lineId, quantity: split ? quantities[l.lineId] ?? 0 : l.quantity - l.paidQuantity })).filter(l => l.quantity > 0)
    if (!items.length) return
    try { setAttempt(await mutation.execute({ command: 'prepare_checkout', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, items, paymentMethod: method })); await refresh() } catch { /* Shell recovery. */ }
  }
  async function prepareWaiver() { try { setWaiver(await mutation.execute({ command: 'prepare_waiver', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, reason: reason.trim() })); setWaiverConfirmed(false) } catch { /* Shell recovery. */ } }
  return <div className="ops-form">
    <p>{order.phase === 'checkout' ? 'Cuenta final' : 'En servicio'}{order.frozen ? ' · Artículos y descuento fijos' : ''}</p>
    <ul className="ops-list">{order.items.map(line => <li key={line.lineId}><span><strong>{line.quantity} × {line.name}</strong><small>{line.selectionLabel}{line.note ? ` · ${line.note}` : ''}</small><small>{line.sentQuantity} enviados · {line.paidQuantity} pagados</small></span><span>{money(line.totalCents)}{split && order.phase === 'checkout' && line.quantity > line.paidQuantity && <label>En este cobro<input aria-label={`Cantidad a cobrar de ${line.name}`} type="number" inputMode="numeric" min={0} max={line.quantity - line.paidQuantity} step={1} value={quantities[line.lineId] ?? 0} disabled={disabled || Boolean(currentAttempt && !['completed', 'aborted'].includes(currentAttempt.status))} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n <= line.quantity - line.paidQuantity) setQuantities(previous => ({ ...previous, [line.lineId]: n })) }} /></label>}</span></li>)}</ul>
    <dl className="ops-totals"><div><dt>Subtotal</dt><dd>{money(order.grossCents)}</dd></div>{order.discount && <div><dt>Descuento · {order.discount.reason}</dt><dd>−{money(order.discountCents)}</dd></div>}<div><dt>IVA incluido conocido</dt><dd>{money(order.taxCents)}</dd></div><div><dt>Pagado</dt><dd>{money(order.paidCents)}</dd></div>{order.waivedCents > 0 && <div><dt>Condonado</dt><dd>{money(order.waivedCents)}</dd></div>}{order.cancelledCents > 0 && <div><dt>Cancelado</dt><dd>{money(order.cancelledCents)}</dd></div>}<div><dt>Saldo</dt><dd>{money(order.balanceCents)}</dd></div></dl>
    {order.status !== 'closed' && !settled && order.phase === 'service' && !order.frozen && <>
      {(allowed('orders.manage') || allowed('sales.create')) && <button className="pos-button pos-secondary" disabled={disabled} onClick={onEdit}>Editar artículos</button>}
      {allowed('orders.manage') && order.items.some(l => l.quantity > l.sentQuantity) && <button className="pos-button pos-primary" disabled={disabled} onClick={() => void transition('send_order')}>Enviar nuevos artículos a cocina</button>}
      {allowed('sales.create') && <button className="pos-button pos-primary" disabled={disabled} onClick={() => void transition('begin_order_checkout')}>Finalizar cuenta para cobrar</button>}
    </>}
    {order.phase === 'checkout' && !settled && allowed('sales.create') && !currentAttempt && <section className="ops-card">
      <h3>Cobrar cuenta final</h3><label className="ops-check"><input type="checkbox" checked={split} disabled={disabled} onChange={e => setSplit(e.target.checked)} /><span>Dividir por artículos al final del servicio</span></label>
      <label>Método de pago<select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)} disabled={disabled}>{methods.map(m => <option key={m} value={m}>{paymentLabels[m]}</option>)}</select></label>
      <p>Se guardará el importe exacto antes de cobrar. El primer pago fija los artículos y el descuento.</p>
      {!collectionAllowed && <p role="status">Abre o reanuda el turno en Caja antes de cobrar.</p>}
      <button className="pos-button pos-primary" disabled={disabled || !collectionAllowed || !methods.length || (split && !Object.values(quantities).some(n => n > 0))} onClick={() => void prepare()}>Preparar {split ? 'cobro de artículos' : 'cobro completo'}</button>
      {!order.frozen && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => void transition('resume_order_service')}>Volver al servicio</button>}
    </section>}
    {current.loading && <p role="status">Consultando el estado del intento…</p>}
    {current.error && <p role="alert">{current.error}<button className="pos-button pos-secondary" onClick={current.retry}>Reintentar consulta</button></p>}
    {currentAttempt && <><AttemptPanel attempt={currentAttempt} mutation={{ ...mutation, busy: mutation.busy || current.blocked }} collectionAllowed={collectionAllowed} onSaved={a => { setAttempt(a); void refresh() }} />{['completed', 'aborted'].includes(currentAttempt.status) && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => { void refresh().then(() => setAttempt(null)) }}>Continuar con la cuenta</button>}</>}
    {!settled && order.phase === 'service' && !order.frozen && !currentAttempt && allowed('sales.discount') && <details><summary>Descuento de toda la cuenta</summary><div className="ops-form"><label>Tipo<select value={discountKind} onChange={e => setDiscountKind(e.target.value as 'fixed' | 'percent')} disabled={disabled}><option value="fixed">Importe fijo</option><option value="percent">Porcentaje</option></select></label><label>{discountKind === 'fixed' ? 'Importe' : 'Porcentaje (0–100)'}{discountKind === 'fixed' ? <MoneyInput maxCents={maxOperationalMoneyCents} value={discountValue} onValueChange={setDiscountValue} disabled={disabled} /> : <input value={discountValue} inputMode="decimal" onChange={e => setDiscountValue(e.target.value)} disabled={disabled} />}</label><label>Motivo<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={disabled} /></label><button className="pos-button pos-primary" disabled={disabled || !reason.trim() || parsedDiscount === null || (discountKind === 'percent' && (parsedDiscount ?? 10001) > 10000)} onClick={() => { const value = parsedDiscount; if (value !== null) void discount({ kind: discountKind, value, reason: reason.trim() }) }}>Aplicar descuento</button>{order.discount && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => void discount(null)}>Quitar descuento</button>}</div></details>}
    {!settled && !currentAttempt && (allowed('orders.cancel') || business.role === 'owner') && <details><summary>Cancelar o condonar saldo pendiente</summary><div className="ops-form"><p>Las preparaciones enviadas quedan en el historial. Los pagos registrados se conservan.</p><label>Motivo<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={disabled} /></label>{allowed('orders.cancel') && <button className="pos-button pos-secondary" disabled={disabled || !reason.trim()} onClick={() => void transition('cancel_order')}>Cancelar saldo de artículos sin preparar</button>}{business.role === 'owner' && <button className="pos-button pos-secondary" disabled={disabled || !reason.trim()} onClick={() => void prepareWaiver()}>Preparar condonación del saldo</button>}{waiver && waiver.status === 'prepared' && <section className="ops-card"><p>Condonar {money(waiver.amountCents)} · {waiver.reason}</p><label className="ops-check"><input type="checkbox" checked={waiverConfirmed} onChange={e => setWaiverConfirmed(e.target.checked)} /><span>Apruebo que este saldo preparado o entregado quede sin cobrar.</span></label><button className="pos-button pos-primary" disabled={disabled || !waiverConfirmed} onClick={() => { void (async () => { try { setWaiver(await mutation.execute({ command: 'confirm_waiver', operationId: crypto.randomUUID(), waiverId: waiver.id, expectedRevision: waiver.revision, confirmed: true })); await refresh() } catch { /* Shell recovery. */ } })() }}>Confirmar condonación</button></section>}</div></details>}
    {order.status !== 'closed' && allowed('tables.manage') && <details><summary>Mover cuenta</summary><div className="ops-form"><label>Mesa de destino<select value={tableId} disabled={disabled} onChange={e => setTableId(e.target.value)}><option value="">Sin mesa</option>{tables.filter(t => t.active && (!t.orderId || t.orderId === order.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><button className="pos-button pos-secondary" disabled={disabled || tableId === (order.tableId ?? '')} onClick={() => { void (async () => { try { onSaved(await mutation.execute({ command: 'move_order', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, tableId: tableId || null })); await refresh() } catch { /* Shell recovery. */ } })() }}>Mover a mesa libre</button></div></details>}
    {order.status !== 'closed' && settled && (allowed('tables.manage') || allowed('orders.manage') || allowed('sales.create')) && <><p>{order.tableId ? 'La mesa sigue ocupada hasta que cierres esta cuenta.' : 'El saldo está resuelto.'}</p><button className="pos-button pos-primary" disabled={disabled} onClick={() => void transition('close_order')}>Cerrar cuenta{order.tableId ? ' y liberar mesa' : ''}</button></>}
  </div>
}
