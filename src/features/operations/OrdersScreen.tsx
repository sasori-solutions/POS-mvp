import { useEffect, useRef, useState } from 'react'
import type { BusinessContext } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { KitchenBatch, OperationalOrder, OperationsSnapshot } from '../../lib/operations-contracts'
import { money, posRequest, type PosAccess } from '../../lib/pos'
import type { OperationalMutation } from './useOperations'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'


export default function OrdersScreen({ business, access, snapshot, mutation, onOrder, onNew, refresh, onSessionError }: { business: BusinessContext; access: PosAccess; snapshot: OperationsSnapshot; mutation: OperationalMutation; onOrder: (order: OperationalOrder) => void; onNew: () => void; refresh: () => Promise<void>; onSessionError?: (error: AccountClientError) => void }) {
  const allowed = (key: Parameters<typeof hasPermission>[1]) => hasPermission(business, key)
  const sections = [allowed('kitchen.read') ? 'Comandas' : '', allowed('orders.read') ? 'Cuentas' : ''].filter(Boolean)
  const [tab, setTab] = useState(sections[0] ?? 'Comandas')
  const [batches, setBatches] = useState<KitchenBatch[]>([])
  const [kitchenError, setKitchenError] = useState('')
  const [completed, setCompleted] = useState(false)
  const sequence = useRef(0)
  const disabled = mutation.busy || Boolean(mutation.pending)
  const visibleBatches = batches.filter(batch => completed === (batch.status === 'delivered' || Boolean(batch.fullyCancelled)))
  async function kitchen() {
    if (!snapshot.enabled || !allowed('kitchen.read')) return
    const request = ++sequence.current
    try { const r = await posRequest(access, { command: 'kitchen' }); if (sequence.current === request) { setBatches(r.batches); setKitchenError('') } } catch (e) { if (sequence.current === request) { setKitchenError(e instanceof Error ? e.message : 'No pudimos cargar las comandas.'); if (e instanceof AccountClientError && accessErrorCodes.includes(e.code)) { setBatches([]); onSessionError?.(e) } } }
  }
  useEffect(() => { void kitchen(); return () => { sequence.current++ } }, [snapshot, access.operatorToken])
  async function status(batch: KitchenBatch) { try { await mutation.execute({ command: 'set_kitchen_status', operationId: crypto.randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: 'delivered' }); await kitchen(); await refresh() } catch { /* Shell recovery. */ } }
  return <div className="ops-section">
    {!snapshot.enabled && <p>Activa los turnos desde Más → Caja para comenzar esta operación.</p>}
    <div className="ops-tabs" role="group" aria-label="Comandas y cuentas">{sections.length > 1 && sections.map(section => <button key={section} type="button" aria-pressed={tab === section} onClick={() => setTab(section)}>{section}</button>)}</div>
    {tab === 'Cuentas' && <>
      {allowed('orders.manage') && <button className="pos-button pos-primary" disabled={disabled || !snapshot.enabled} onClick={() => onNew()}>Abrir cuenta</button>}
      <ul className="ops-list">{snapshot.orders.map(order => <li key={order.id}><button className="ops-row" onClick={() => onOrder(order)}><strong>{order.name}</strong><small>{order.phase === 'checkout' ? 'Cobro parcial' : 'Pendiente de pago'}{order.balanceCents === 0 ? ' · Saldo resuelto' : ''}</small></button><strong>{money(order.balanceCents)}</strong></li>)}</ul>
      {!snapshot.orders.length && <p>No hay cuentas abiertas.</p>}
    </>}
    {tab === 'Comandas' && <>
      <div className="comanda-segments" role="group" aria-label="Estado de comandas"><button aria-pressed={!completed} onClick={() => setCompleted(false)}>Pendientes</button><button aria-pressed={completed} onClick={() => setCompleted(true)}>Completadas</button></div>
      {kitchenError && <p role="alert">{kitchenError}<button className="pos-button pos-secondary" onClick={() => void kitchen()}>Reintentar</button></p>}
      <div className="ops-kitchen-grid">{visibleBatches.map(batch => <section className="ops-card comanda-card" key={batch.id} aria-label={`Comanda ${batch.orderName}`}>
        <div className="comanda-heading"><h2>{batch.orderName}</h2><p>{new Intl.DateTimeFormat('es-MX', { timeStyle: 'short', timeZone: business.timezone }).format(new Date(batch.createdAt))}</p></div>
        <strong className="comanda-state">{batch.fullyCancelled ? 'Cancelada' : batch.status === 'delivered' ? 'Completada' : batch.kind === 'cancellation' ? 'Cancelación · Pendiente' : 'Pendiente'}</strong>
        {batch.reason && <p>{batch.reason}</p>}
        <ul className="ops-list comanda-items">{batch.items.map(line => <li key={line.lineId}><span>
          <strong>{Math.max(0, line.quantity - (line.cancelledQuantity ?? 0))} × {line.name}</strong>
          {(line.cancelledQuantity ?? 0) > 0 && <small>Cantidad original: {line.quantity} · Canceladas: {line.cancelledQuantity}</small>}
          <small>{line.selectionLabel}</small>{line.note && <small>Nota: {line.note}</small>}
        </span></li>)}</ul>
        {allowed('kitchen.operate') && batch.status !== 'delivered' && !batch.fullyCancelled && <button className="pos-button pos-primary" disabled={disabled} onClick={() => void status(batch)}>Marcar como completada</button>}
      </section>)}</div>
      {!visibleBatches.length && <p>{completed ? 'No hay comandas completadas.' : batches.length ? 'No hay comandas pendientes.' : 'Las órdenes pagadas aparecerán aquí.'}</p>}
    </>}
  </div>
}
