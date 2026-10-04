import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, ClipboardList, Plus, ReceiptText } from 'lucide-react'
import type { BusinessContext } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { KitchenBatch, OperationalOrder, OperationsSnapshot } from '../../lib/operations-contracts'
import { money, posRequest, type PosAccess } from '../../lib/pos'
import type { OperationalMutation } from './useOperations'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'
import LoadingPlaceholder from '../../components/LoadingPlaceholder'
import './operations-polish.css'

export default function OrdersScreen({ business, access, snapshot, mutation, onOrder, onNew, refresh, onSessionError }: { business: BusinessContext; access: PosAccess; snapshot: OperationsSnapshot; mutation: OperationalMutation; onOrder: (order: OperationalOrder) => void; onNew: () => void; refresh: () => Promise<void>; onSessionError?: (error: AccountClientError) => void }) {
  const allowed = (key: Parameters<typeof hasPermission>[1]) => hasPermission(business, key)
  const sections = [allowed('kitchen.read') ? 'Comandas' : '', allowed('orders.read') ? 'Cuentas' : ''].filter(Boolean)
  const [tab, setTab] = useState(sections[0] ?? 'Comandas')
  const [batches, setBatches] = useState<KitchenBatch[]>([])
  const [kitchenLoaded, setKitchenLoaded] = useState(false)
  const [kitchenError, setKitchenError] = useState('')
  const [completed, setCompleted] = useState(false)
  const sequence = useRef(0)
  const disabled = mutation.busy || Boolean(mutation.pending)
  const activeTab = sections.includes(tab) ? tab : sections[0]
  const visibleBatches = batches.filter(batch => completed === (batch.status === 'delivered' || Boolean(batch.fullyCancelled)))
  async function kitchen() {
    if (!snapshot.enabled || !allowed('kitchen.read')) return
    const request = ++sequence.current
    try { const r = await posRequest(access, { command: 'kitchen' }); if (sequence.current === request) { setBatches(r.batches); setKitchenLoaded(true); setKitchenError('') } } catch (e) { if (sequence.current === request) { setKitchenError(e instanceof Error ? e.message : 'No pudimos cargar las comandas.'); if (e instanceof AccountClientError && accessErrorCodes.includes(e.code)) { setBatches([]); setKitchenLoaded(false); onSessionError?.(e) } } }
  }
  useEffect(() => { void kitchen(); return () => { sequence.current++ } }, [snapshot, access.operatorToken])
  async function status(batch: KitchenBatch) { try { await mutation.execute({ command: 'set_kitchen_status', operationId: crypto.randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status: 'delivered' }); await kitchen(); await refresh() } catch { /* Shell recovery. */ } }
  return <div className="ops-section operations-polish orders-workspace">
    {!snapshot.enabled && <p className="operations-caption">Activa los turnos en Caja para comenzar.</p>}
    {sections.length > 1 && <div className="operations-segments orders-sections" role="group" aria-label="Comandas y cuentas">{sections.map(section => <button key={section} type="button" aria-pressed={activeTab === section} onClick={() => setTab(section)}>{section}</button>)}</div>}
    {activeTab === 'Cuentas' && <>
      <div className="operations-heading"><span className="operations-caption">{snapshot.orders.length} {snapshot.orders.length === 1 ? 'cuenta abierta' : 'cuentas abiertas'}</span>{allowed('orders.manage') && <button className="pos-button pos-primary operations-compact-action" disabled={disabled || !snapshot.enabled} onClick={() => onNew()}><Plus size={18} aria-hidden="true" />Abrir cuenta</button>}</div>
      {snapshot.orders.length ? <ul className="orders-account-list">{snapshot.orders.map(order => <li key={order.id}><button className="operations-record-button" onClick={() => onOrder(order)}><span className="operations-record-icon"><ReceiptText size={20} aria-hidden="true" /></span><div><strong>{order.name}</strong><small>{order.operatorName} · {order.balanceCents === 0 ? 'Sin saldo' : order.phase === 'checkout' ? 'Cobro parcial' : 'Por cobrar'}</small></div><strong>{money(order.balanceCents)}</strong><ChevronRight size={18} aria-hidden="true" /></button></li>)}</ul> : <div className="operations-empty"><ReceiptText size={28} strokeWidth={1.5} aria-hidden="true" /><h2>No hay cuentas abiertas</h2></div>}
    </>}
    {activeTab === 'Comandas' && <>
      <div className="operations-heading"><div className="operations-segments" role="group" aria-label="Estado de comandas"><button aria-pressed={!completed} onClick={() => setCompleted(false)}>Pendientes</button><button aria-pressed={completed} onClick={() => setCompleted(true)}>Completadas</button></div>{kitchenLoaded && <span className="operations-count" aria-label={`${visibleBatches.length} comandas`}>{visibleBatches.length}</span>}</div>
      {kitchenError && <div className="operations-error" role="alert"><p>{kitchenError}</p><button className="pos-button pos-secondary" onClick={() => void kitchen()}>Reintentar</button></div>}
      {!kitchenLoaded && !kitchenError && snapshot.enabled && <LoadingPlaceholder variant="cards" rows={4} label="Cargando comandas" />}
      <div className="ops-kitchen-grid operations-kitchen-grid">{visibleBatches.map(batch => <section className="ops-card comanda-card" key={batch.id} aria-label={`Comanda ${batch.orderName}`}>
        <div className="operations-heading comanda-heading"><div><h2>{batch.orderName}</h2>{batch.tableName && <span className="operations-caption">{batch.tableName}</span>}</div><time className="operations-caption" dateTime={batch.createdAt}>{new Intl.DateTimeFormat('es-MX', { timeStyle: 'short', timeZone: business.timezone }).format(new Date(batch.createdAt))}</time></div>
        <span className={`operations-status ${batch.status === 'delivered' && !batch.fullyCancelled ? 'operations-status-active' : ''}`}>{batch.fullyCancelled ? 'Cancelada' : batch.status === 'delivered' ? 'Completada' : batch.kind === 'cancellation' ? 'Cancelación · Pendiente' : 'Pendiente'}</span>
        {batch.reason && <p className="operations-caption">{batch.reason}</p>}
        <ul className="ops-list comanda-items">{batch.items.map(line => <li key={line.lineId}><span>
          <strong>{Math.max(0, line.quantity - (line.cancelledQuantity ?? 0))} × {line.name}</strong>
          {(line.cancelledQuantity ?? 0) > 0 && <small>Cantidad original: {line.quantity} · Canceladas: {line.cancelledQuantity}</small>}
          {line.selectionLabel && <small>{line.selectionLabel}</small>}{line.note && <small className="comanda-note">Nota: {line.note}</small>}
        </span></li>)}</ul>
        {allowed('kitchen.operate') && batch.status !== 'delivered' && !batch.fullyCancelled && <button className="pos-button pos-primary" disabled={disabled} onClick={() => void status(batch)}><Check size={18} aria-hidden="true" />Marcar como completada</button>}
      </section>)}</div>
      {kitchenLoaded && !visibleBatches.length && <div className="operations-empty"><ClipboardList size={28} strokeWidth={1.5} aria-hidden="true" /><h2>{completed ? 'No hay comandas completadas.' : 'No hay comandas pendientes.'}</h2></div>}
    </>}
  </div>
}
