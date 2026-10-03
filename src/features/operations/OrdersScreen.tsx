import { useEffect, useRef, useState } from 'react'
import type { BusinessContext } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { DiningTable, KitchenBatch, OperationalOrder, OperationsSnapshot } from '../../lib/operations-contracts'
import { money, posRequest, type PosAccess } from '../../lib/pos'
import type { OperationalMutation } from './useOperations'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'

const kitchenLabels = { queued: 'Nueva', preparing: 'Preparando', ready: 'Lista', delivered: 'Entregada' }

export default function OrdersScreen({ business, access, snapshot, mutation, onOrder, onNew, refresh, onSessionError }: { business: BusinessContext; access: PosAccess; snapshot: OperationsSnapshot; mutation: OperationalMutation; onOrder: (order: OperationalOrder) => void; onNew: (tableId?: string) => void; refresh: () => Promise<void>; onSessionError?: (error: AccountClientError) => void }) {
  const allowed = (key: Parameters<typeof hasPermission>[1]) => hasPermission(business, key)
  const sections = [allowed('orders.read') ? 'Cuentas' : '', allowed('kitchen.read') ? 'Cocina' : '', allowed('tables.manage') ? 'Mesas' : ''].filter(Boolean)
  const [tab, setTab] = useState(sections[0] ?? 'Cuentas')
  const [batches, setBatches] = useState<KitchenBatch[]>([])
  const [kitchenError, setKitchenError] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [editingTable, setEditingTable] = useState<DiningTable | null>(null)
  const [tableName, setTableName] = useState('')
  const [tableActive, setTableActive] = useState(true)
  const sequence = useRef(0)
  const disabled = mutation.busy || Boolean(mutation.pending)
  const visibleBatches = batches.filter(batch => showHistory || (batch.status !== 'delivered' && !batch.fullyCancelled))
  async function kitchen() {
    if (!snapshot.enabled || !allowed('kitchen.read')) return
    const request = ++sequence.current
    try { const r = await posRequest(access, { command: 'kitchen' }); if (sequence.current === request) { setBatches(r.batches); setKitchenError('') } } catch (e) { if (sequence.current === request) { setKitchenError(e instanceof Error ? e.message : 'No pudimos cargar las comandas.'); if (e instanceof AccountClientError && accessErrorCodes.includes(e.code)) onSessionError?.(e) } }
  }
  useEffect(() => { void kitchen(); return () => { sequence.current++ } }, [snapshot, access.operatorToken])
  async function status(batch: KitchenBatch, status: 'preparing' | 'ready' | 'delivered') { try { await mutation.execute({ command: 'set_kitchen_status', operationId: crypto.randomUUID(), batchId: batch.id, expectedRevision: batch.revision, status }); await kitchen(); await refresh() } catch { /* Shell recovery. */ } }
  async function saveTable() {
    if (!tableName.trim()) return
    try { await mutation.execute({ command: 'save_table', operationId: crypto.randomUUID(), tableId: editingTable?.id ?? crypto.randomUUID(), expectedRevision: editingTable?.revision ?? null, name: tableName.trim(), active: tableActive }); setEditingTable(null); setTableName(''); setTableActive(true); await refresh() } catch { /* Shell recovery. */ }
  }
  return <div className="ops-section">
    {!snapshot.enabled && <p>Activa los turnos desde Más → Caja para comenzar esta operación.</p>}
    <div className="ops-tabs" role="group" aria-label="Comandas y mesas">{sections.map(section => <button key={section} type="button" aria-pressed={tab === section} onClick={() => setTab(section)}>{section}</button>)}</div>
    {tab === 'Cuentas' && <>
      {allowed('orders.manage') && <button className="pos-button pos-primary" disabled={disabled || !snapshot.enabled} onClick={() => onNew()}>Abrir cuenta</button>}
      <ul className="ops-list">{snapshot.orders.map(order => <li key={order.id}><button className="ops-row" onClick={() => onOrder(order)}><strong>{order.name}</strong><small>{order.tableId ? snapshot.tables.find(t => t.id === order.tableId)?.name ?? 'Mesa' : 'Sin mesa'} · {order.phase === 'checkout' ? 'Cuenta final' : 'En servicio'}{order.balanceCents === 0 ? ' · Saldo resuelto' : ''}</small></button><strong>{money(order.balanceCents)}</strong></li>)}</ul>
      {!snapshot.orders.length && <p>No hay cuentas abiertas.</p>}
    </>}
    {tab === 'Cocina' && <>
      <label className="ops-check"><input type="checkbox" checked={showHistory} onChange={e => setShowHistory(e.target.checked)} /><span>Mostrar entregadas y canceladas</span></label>
      {kitchenError && <p role="alert">{kitchenError}<button className="pos-button pos-secondary" onClick={() => void kitchen()}>Reintentar</button></p>}
      <div className="ops-kitchen-grid">{visibleBatches.map(batch => <section className="ops-card" key={batch.id} aria-label={`Comanda ${batch.orderName}`}>
        <div><h2>{batch.orderName}</h2><p>{batch.tableName ?? 'Sin mesa'} · {new Intl.DateTimeFormat('es-MX', { timeStyle: 'short', timeZone: business.timezone }).format(new Date(batch.createdAt))}</p></div>
        <strong>{batch.fullyCancelled ? 'Cancelada' : `${batch.kind === 'cancellation' ? 'Cancelación · ' : ''}${kitchenLabels[batch.status]}`}</strong>
        {batch.reason && <p>{batch.reason}</p>}
        <ul className="ops-list">{batch.items.map(line => <li key={line.lineId}><span>
          <strong>{Math.max(0, line.quantity - (line.cancelledQuantity ?? 0))} × {line.name}</strong>
          {(line.cancelledQuantity ?? 0) > 0 && <small>Cantidad original: {line.quantity} · Canceladas: {line.cancelledQuantity}</small>}
          <small>{line.selectionLabel}</small>{line.note && <small>Nota: {line.note}</small>}
        </span></li>)}</ul>
        {allowed('kitchen.operate') && batch.status !== 'delivered' && !batch.fullyCancelled && <button className="pos-button pos-primary" disabled={disabled} onClick={() => void status(batch, batch.kind === 'cancellation' ? 'delivered' : batch.status === 'queued' ? 'preparing' : batch.status === 'preparing' ? 'ready' : 'delivered')}>{batch.kind === 'cancellation' ? 'Confirmar aviso' : batch.status === 'queued' ? 'Comenzar preparación' : batch.status === 'preparing' ? 'Marcar lista' : 'Marcar entregada'}</button>}
      </section>)}</div>
      {!visibleBatches.length && <p>{batches.length ? 'No hay comandas pendientes.' : 'Las cuentas enviadas a cocina aparecerán aquí.'}</p>}
    </>}
    {tab === 'Mesas' && <>
      <div className="ops-table-grid">{snapshot.tables.map(table => <section className="ops-card" key={table.id}><h2>{table.name}</h2><p>{table.orderId ? 'Ocupada' : table.active ? 'Libre' : 'Inactiva'}</p>{table.orderId ? <button className="pos-button pos-primary" onClick={() => { const order = snapshot.orders.find(o => o.id === table.orderId); if (order) onOrder(order) }}>Ver cuenta</button> : table.active && allowed('orders.manage') && <button className="pos-button pos-primary" disabled={disabled || !snapshot.enabled} onClick={() => onNew(table.id)}>Abrir cuenta de mesa</button>}<button className="pos-button pos-secondary" disabled={disabled} onClick={() => { setEditingTable(table); setTableName(table.name); setTableActive(table.active) }}>Editar mesa</button></section>)}</div>
      <section className="ops-card"><h2>{editingTable ? 'Editar mesa' : 'Agregar mesa'}</h2><label>Nombre<input value={tableName} maxLength={60} disabled={disabled} onChange={e => setTableName(e.target.value)} /></label>{editingTable && <label className="ops-check"><input type="checkbox" checked={tableActive} disabled={disabled || Boolean(editingTable.orderId)} onChange={e => setTableActive(e.target.checked)} /><span>Mesa activa</span></label>}<button className="pos-button pos-primary" disabled={disabled || !snapshot.enabled || !tableName.trim()} onClick={() => void saveTable()}>Guardar mesa</button>{editingTable && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => { setEditingTable(null); setTableName(''); setTableActive(true) }}>Cancelar edición</button>}</section>
    </>}
  </div>
}
