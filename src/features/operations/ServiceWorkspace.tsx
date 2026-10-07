import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronRight, LayoutGrid, Plus, ReceiptText, Settings2 } from 'lucide-react'
import type { BusinessContext } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { DiningTable, OperationalOrder, OperationsSnapshot } from '../../lib/operations-contracts'
import { money } from '../../lib/pos'
import type { OperationalMutation } from './useOperations'
import { PosDialog } from '../../components/PosShared'
import TableLayoutEditor from './TableLayoutEditor'
import ServiceReservations from './ServiceReservations'
import type { PosAccess } from '../../lib/pos'
import type { AccountClientError } from '../../lib/account'
import './operations-polish.css'
import './service-workspace.css'

export default function ServiceWorkspace({ business, snapshot, mutation, onOrder, onNew, onQuickAccount, refresh, access, onSessionError }: {
  business: BusinessContext
  snapshot: OperationsSnapshot
  mutation: OperationalMutation
  onOrder: (order: OperationalOrder) => void
  onNew: (table?: DiningTable) => void
  onQuickAccount: () => void
  refresh: () => Promise<void>
  access?: PosAccess
  onSessionError?: (error: AccountClientError) => void
}) {
  const [tab, setTab] = useState<'tables' | 'accounts' | 'reservations'>('tables')
  const [managing, setManaging] = useState(false)
  const [tableView, setTableView] = useState<'cards' | 'plan'>('cards')
  const [zone, setZone] = useState('')
  const [placing, setPlacing] = useState<DiningTable | null>(null)
  const [editing, setEditing] = useState<{ table?: DiningTable; id: string; name: string; active: boolean } | null>(null)
  const [formError, setFormError] = useState('')
  const observedResult = useRef(mutation.lastResult)
  const scope = `${business.id}:${business.employee?.id ?? 'owner'}`
  const currentScope = useRef(scope); currentScope.current = scope
  useEffect(() => { currentScope.current = scope; return () => { currentScope.current = '' } }, [scope])
  const allowed = (permission: Parameters<typeof hasPermission>[1]) => hasPermission(business, permission)
  const canCreate = allowed('orders.manage') && allowed('catalog.read')
  const canTables = allowed('tables.manage')
  const disabled = mutation.busy || Boolean(mutation.pending) || !snapshot.enabled
  const tables = snapshot.tables.filter(table => managing || table.active)
  const accounts = snapshot.orders.filter(order => order.orderKind !== 'counter')
  const namedAccounts = accounts.filter(order => !order.tableId)
  const occupied = snapshot.tables.filter(table => table.active && (table.orderId || table.visitId)).length
  const zones = [...new Set(tables.flatMap(table => table.layout ? [table.layout.zone] : []))].sort((a, b) => a.localeCompare(b, 'es-MX'))
  const activeZone = zones.includes(zone) ? zone : zones[0]
  const positionedTables = tables.filter(table => table.layout && table.layout.zone === activeZone)
  const columns = Math.max(1, ...positionedTables.map(table => table.layout!.column))
  const rows = Math.max(1, ...positionedTables.map(table => table.layout!.row))
  useEffect(() => {
    const result = mutation.lastResult
    // A previous accepted result must not close a form opened afterward.
    if (result === observedResult.current) return
    observedResult.current = result
    if (result?.command === 'save_table' && (result.result as DiningTable).id === editing?.id) setEditing(null)
    if (result?.command === 'set_table_layout' && (result.result as DiningTable).id === placing?.id) setPlacing(null)
  }, [mutation.lastResult, editing?.id, placing?.id])
  function editTable(table?: DiningTable) {
    setFormError('')
    setEditing({ table, id: table?.id ?? crypto.randomUUID(), name: table?.name ?? '', active: table?.active ?? true })
  }
  async function saveTable() {
    if (!editing || disabled || !canTables || !editing.name.trim()) return
    const captured = scope
    try {
      await mutation.execute({ command: 'save_table', operationId: crypto.randomUUID(), tableId: editing.id, expectedRevision: editing.table?.revision ?? null, name: editing.name.trim(), active: editing.active })
      if (currentScope.current !== captured) return
      setEditing(null)
      await refresh()
    } catch { /* The shell keeps the exact mutation available for recovery. */ }
  }
  function openTable(table: DiningTable) {
    const order = snapshot.orders.find(item => item.id === table.orderId)
    if (order) onOrder(order)
    else if (!table.orderId && !table.visitId && canCreate) onNew(table)
    else setFormError('No pudimos cargar la cuenta de esta mesa. Actualiza antes de continuar.')
  }
  const tableButton = (table: DiningTable, inPlan = false) => {
    const order = snapshot.orders.find(item => item.id === table.orderId)
    const visitOpen = Boolean(table.visitId)
    const claimed = Boolean(table.orderId || table.visitId)
    const stateLabel = !table.active ? 'Inactiva' : !claimed ? 'Libre' : visitOpen ? 'Ocupada' : order && (order.status === 'paid' || order.balanceCents === 0 && order.paidCents > 0) ? 'Pagada · cerrar' : order && ['waived', 'cancelled'].includes(order.status) ? 'Resuelta · cerrar' : 'Ocupada'
    const orderBalance = order && !visitOpen ? money(order.balanceCents) : null
    const style: CSSProperties | undefined = inPlan && table.layout ? { gridRow: table.layout.row, gridColumn: table.layout.column } : undefined
    return <button type="button" key={table.id} aria-label={`${table.name}, ${stateLabel}${orderBalance !== null ? `, saldo ${orderBalance}` : ''}${visitOpen && !managing ? ', Ver visita' : ''}`} className={`service-table ${inPlan ? 'service-plan-table' : ''}`} style={style} data-shape={table.layout?.shape} data-occupied={claimed} data-inactive={!table.active || undefined} disabled={disabled || (!managing && (!table.active || !canCreate && !claimed))} onClick={() => managing ? inPlan ? setPlacing(table) : editTable(table) : openTable(table)}>
      <strong>{table.name}</strong><span>{stateLabel}</span>{orderBalance !== null && <b>{orderBalance}</b>}{table.layout && <small>{table.layout.seats} lugares</small>}{visitOpen && !managing && <small>Ver visita</small>}{managing && <small>{inPlan ? 'Mover en plano' : 'Editar mesa'}</small>}
    </button>
  }
  const accountList = (orders: OperationalOrder[]) => <ul className="orders-account-list">{orders.map(order => <li key={order.id}><button type="button" className="operations-record-button" disabled={mutation.busy} onClick={() => onOrder(order)}>
    <span className="operations-record-icon"><ReceiptText size={20} aria-hidden="true" /></span><div><strong>{order.name}</strong><small>{order.status === 'paid' || order.balanceCents === 0 && order.paidCents > 0 ? 'Pagada · pendiente de cerrar' : ['waived', 'cancelled'].includes(order.status) ? 'Resuelta · pendiente de cerrar' : order.frozen ? 'Pago parcial · saldo pendiente' : 'En servicio'} · {order.operatorName}</small></div><strong>{money(order.balanceCents)}</strong><ChevronRight size={18} aria-hidden="true" />
  </button></li>)}</ul>
  return <div className="ops-section operations-polish service-workspace">
    <div className="service-intro"><div><h2>Mesas y cuentas</h2><p className="operations-caption">Añade consumos y envía a cocina. Cobra cuando termine la visita.</p></div>{canCreate && <button type="button" className="pos-button pos-primary operations-compact-action" disabled={disabled} onClick={() => onNew()}><Plus size={18} aria-hidden="true" />Cuenta sin mesa</button>}</div>
    {!snapshot.enabled && <p className="operations-caption">Activa la operación desde Caja para abrir cuentas.</p>}
    <div className="service-toolbar"><div className="operations-segments" role="group" aria-label="Vista de servicio"><button type="button" aria-pressed={tab === 'tables'} onClick={() => setTab('tables')}><LayoutGrid size={18} aria-hidden="true" />Mesas</button><button type="button" aria-pressed={tab === 'accounts'} onClick={() => setTab('accounts')}>Cuentas<span className="operations-count">{accounts.length}</span></button>{access && canTables && allowed('orders.read') && <button type="button" aria-pressed={tab === 'reservations'} onClick={() => setTab('reservations')}>Reservaciones</button>}</div>
      {tab === 'tables' && canTables && <button type="button" className="pos-button pos-secondary operations-compact-action" aria-pressed={managing} onClick={() => setManaging(value => !value)}><Settings2 size={18} aria-hidden="true" />{managing ? 'Terminar' : 'Organizar mesas'}</button>}
    </div>
    {formError && <div className="operations-error" role="alert"><p>{formError}</p><button type="button" className="pos-button pos-secondary" onClick={() => { setFormError(''); void refresh() }}>Actualizar cuentas</button></div>}
    {tab === 'reservations' && access ? <ServiceReservations business={business} access={access} orders={accounts} tables={snapshot.tables} mutation={mutation} onOpenOrder={onOrder} onNewAccount={canCreate ? () => onNew() : undefined} onSaved={() => { void refresh() }} onSessionError={onSessionError} /> : tab === 'tables' ? <>
      {snapshot.tables.some(table => table.active) && <p className="operations-caption">{occupied} ocupadas · {snapshot.tables.filter(table => table.active).length - occupied} libres</p>}
      {tables.length > 0 && <div className="service-toolbar"><div className="operations-segments" role="group" aria-label="Vista de mesas"><button type="button" aria-pressed={tableView === 'cards'} onClick={() => setTableView('cards')}>Tarjetas</button><button type="button" aria-pressed={tableView === 'plan'} onClick={() => setTableView('plan')}>Plano</button></div>{tableView === 'plan' && zones.length > 0 && <label>Zona<select value={activeZone} onChange={event => setZone(event.target.value)}>{zones.map(value => <option key={value}>{value}</option>)}</select></label>}</div>}
      {tableView === 'plan' && positionedTables.length > 0 && <><p className="operations-caption">{activeZone} · Desliza el plano para ver todas las mesas.</p><div className="service-plan-scroll" tabIndex={0} role="region" aria-label={`Plano de ${activeZone}`}><div className="service-floor-plan" style={{ gridTemplateColumns: `repeat(${columns}, minmax(96px, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(104px, auto))`, minWidth: columns * 108 }}>{positionedTables.map(table => tableButton(table, true))}</div></div></>}
      {tableView === 'plan' && !positionedTables.length && <p className="operations-caption">Organiza las mesas y guarda su ubicación para ver el plano.</p>}
      <div className="service-table-grid">{tables.filter(table => tableView === 'cards' || !table.layout).map(table => tableButton(table))}{canTables && (managing || !tables.length) && <button type="button" className="service-table service-table-add" disabled={disabled} onClick={() => editTable()}><Plus size={24} aria-hidden="true" /><strong>Añadir mesa</strong></button>}</div>
      {!tables.length && !canTables && <div className="operations-empty"><LayoutGrid size={28} aria-hidden="true" /><h2>Aún no hay mesas</h2><p>El dueño puede añadirlas. También puedes abrir cuentas por nombre.</p></div>}
      {namedAccounts.length > 0 && <section><h3 className="service-list-title">Cuentas por nombre</h3>{accountList(namedAccounts)}</section>}
    </> : accounts.length ? accountList(accounts) : <div className="operations-empty"><ReceiptText size={28} aria-hidden="true" /><h2>No hay cuentas abiertas</h2><p>Elige una mesa o abre una cuenta por nombre.</p></div>}
    {canCreate && tab !== 'reservations' && <button type="button" className="service-quick-link" disabled={disabled} onClick={onQuickAccount}>Abrir una cuenta desde el catálogo</button>}
    {editing && <PosDialog title={editing.table ? 'Editar mesa' : 'Añadir mesa'} onClose={() => { if (!mutation.busy) setEditing(null) }}><form className="ops-form" onSubmit={event => { event.preventDefault(); void saveTable() }}>
      <label>Nombre de la mesa<input autoFocus maxLength={60} value={editing.name} disabled={disabled} placeholder="Mesa 1, Terraza…" onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
      {editing.table && <label className="ops-check"><input type="checkbox" checked={editing.active} disabled={disabled || Boolean(editing.table.orderId || editing.table.visitId)} onChange={event => setEditing({ ...editing, active: event.target.checked })} /><span>Mesa activa</span></label>}
      {(editing.table?.orderId || editing.table?.visitId) && <p className="operations-caption">{editing.table.visitId ? 'Finaliza la visita antes de desactivar esta mesa.' : 'Cierra la cuenta antes de desactivar esta mesa.'}</p>}
      {editing.table && <button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => { setPlacing(editing.table!); setEditing(null) }}>Ubicar en el plano</button>}
      {mutation.error && <p role="alert">{mutation.error}</p>}
      <button type="submit" className="pos-button pos-primary" disabled={disabled || !editing.name.trim()}>Guardar mesa</button>
    </form></PosDialog>}
    {placing && <PosDialog title={`Ubicación de ${placing.name}`} onClose={() => { if (!mutation.busy) setPlacing(null) }}><TableLayoutEditor key={placing.id} table={placing} mutation={mutation} onSaved={() => { setPlacing(null); void refresh() }} /></PosDialog>}
  </div>
}
