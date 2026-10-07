import { useEffect, useRef, useState } from 'react'
import { Layers, Plus, Users } from 'lucide-react'
import type { BusinessContext } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { DiningTable, OperationalOrder } from '../../lib/operations-contracts'
import type { ServiceCourse, ServiceMutation, ServiceOrderState } from '../../lib/service-contracts'
import { assertServiceOrderView } from '../../lib/service-response'
import { money, posRequest, type PosAccess } from '../../lib/pos'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'
import { PosDialog } from '../../components/PosShared'
import './service-panels.css'

export default function ServiceOrderPanel({ business, access, order, tables, mutation, onSaved, onContinue, onOpenOrder, onSessionError, onHeldChange }: {
  business: BusinessContext; access: PosAccess; order: OperationalOrder; tables: DiningTable[]; mutation: ServiceMutation
  onSaved: (order: OperationalOrder) => void; onContinue: (order: OperationalOrder) => void
  onOpenOrder?: (order: OperationalOrder) => void; onSessionError?: (error: AccountClientError) => void
  onHeldChange?: (orderId: string, revision: number, count: number | null) => void
}) {
  const [state, setState] = useState<ServiceOrderState | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0)
  const [dialog, setDialog] = useState<'course' | 'tables' | 'continue' | null>(null)
  const [courseName, setCourseName] = useState('Entradas'), [quantities, setQuantities] = useState<Record<string, number>>({})
  const [tableIds, setTableIds] = useState<string[]>([]), [continuationName, setContinuationName] = useState('Sobremesa')
  const generation = useRef(0), submitted = useRef(false)
  const heldCallback = useRef(onHeldChange); heldCallback.current = onHeldChange
  const sessionErrorHandler = useRef(onSessionError); sessionErrorHandler.current = onSessionError
  const canManage = hasPermission(business, 'orders.manage'), canTables = canManage && hasPermission(business, 'tables.manage')
  const disabled = mutation.busy || Boolean(mutation.pending) || loading
  useEffect(() => {
    const captured = ++generation.current
    setState(null); setLoading(true); setError(''); setDialog(null)
    heldCallback.current?.(order.id, order.revision, null)
    void posRequest(access, { command: 'service_order', orderId: order.id }).then(value => { if (generation.current === captured) { assertServiceOrderView(value); setState(value); setLoading(false); heldCallback.current?.(order.id, order.revision, value.courses.filter(course => course.status === 'held').length) } }).catch(cause => {
      if (generation.current !== captured) return
      setLoading(false)
      if (cause instanceof AccountClientError && accessErrorCodes.includes(cause.code)) sessionErrorHandler.current?.(cause)
      else setError('No pudimos cargar los tiempos y la visita. Vuelve a intentar.')
    })
    return () => { generation.current++ }
  }, [access.businessId, access.operatorToken, access.deviceToken, order.id, order.revision, reload])
  const held = state?.courses.filter(course => course.status === 'held') ?? []
  const available = order.items.filter(line => line.kind !== 'amount').map(line => ({ ...line, available: line.quantity - line.sentQuantity - held.reduce((sum, course) => sum + (course.items.find(item => item.lineId === line.lineId)?.quantity ?? 0), 0) })).filter(line => line.available > 0)
  const editable = canManage && order.status === 'open' && !order.frozen && order.phase === 'service'
  const visit = state?.visit
  const latest = !visit || visit.orders.at(-1)?.id === order.id
  const canContinue = canManage && business.profile.accountsEnabled && order.frozen && order.paidCents > 0 && ['open', 'paid', 'closed'].includes(order.status) && latest && (!visit || visit.status === 'active')
  async function act(action: (current: () => boolean) => Promise<void>) {
    if (disabled || submitted.current) return
    const captured = generation.current; submitted.current = true; setError('')
    try { await action(() => captured === generation.current) } catch { if (captured === generation.current) setError('La operación no se completó. Revisa el aviso y la recuperación de la cuenta.') }
    finally { submitted.current = false }
  }
  async function courseAction(course: ServiceCourse, command: 'send_service_course' | 'cancel_service_course') {
    await act(async current => {
      const result = await mutation.execute({ command, operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: course.id })
      if (!current()) return
      assertServiceOrderView({ visit: state?.visit ?? null, courses: result.courses })
      setState(previous => ({ visit: previous?.visit ?? null, courses: result.courses })); onSaved(result.order)
    })
  }
  async function saveCourse() {
    const items = available.flatMap(line => quantities[line.lineId] > 0 ? [{ lineId: line.lineId, quantity: quantities[line.lineId] }] : [])
    if (!items.length || !courseName.trim() || items.some(item => !Number.isInteger(item.quantity) || item.quantity > available.find(line => line.lineId === item.lineId)!.available)) return
    await act(async current => {
      const result = await mutation.execute({ command: 'save_service_course', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, courseId: crypto.randomUUID(), name: courseName.trim(), items })
      if (!current()) return
      assertServiceOrderView({ visit: state?.visit ?? null, courses: result.courses })
      setDialog(null); setQuantities({}); setState(previous => ({ visit: previous?.visit ?? null, courses: result.courses })); onSaved(result.order)
    })
  }
  const courses = state?.courses.filter(course => course.status !== 'released') ?? []
  return <section className="service-order-panel" aria-label="Visita y tiempos de cocina">
    {loading && <p className="operations-caption" role="status">Cargando servicio…</p>}
    {error && <div role="alert" className="operations-error"><p>{mutation.error || error}</p>{!mutation.pending && <button type="button" className="pos-button pos-secondary" disabled={mutation.busy} onClick={() => setReload(value => value + 1)}>Volver a cargar</button>}</div>}
    {state && <>
      {(editable || courses.length > 0) && <div className="service-panel-heading"><div><h3><Layers size={18} aria-hidden="true" />Tiempos de cocina</h3><p className="operations-caption">Retén consumos y envía cada grupo cuando corresponda.</p></div>{editable && available.length > 0 && <button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => { setQuantities({}); setDialog('course') }}><Plus size={18} aria-hidden="true" />Añadir tiempo</button>}</div>}
      {courses.length > 0 && <ul className="service-course-list">{courses.map(course => <li key={course.id}><div><strong>{course.name}</strong><span className="service-status">{course.status === 'held' ? 'Retenido' : course.batch?.fullyCancelled ? 'Envío cancelado' : 'Enviado a cocina'}</span></div><ul>{course.items.map(item => <li key={item.lineId}>{item.quantity} × {course.batch?.items.find(line => line.lineId === item.lineId)?.name ?? order.items.find(line => line.lineId === item.lineId)?.name ?? 'Consumo del envío'}{(course.batch?.items.find(line => line.lineId === item.lineId)?.cancelledQuantity ?? 0) > 0 && <small> · {course.batch!.items.find(line => line.lineId === item.lineId)!.cancelledQuantity} cancelado(s)</small>}</li>)}</ul>{course.status === 'held' && editable && <div className="service-panel-actions"><button type="button" className="pos-button pos-primary" disabled={disabled} onClick={() => void courseAction(course, 'send_service_course')}>Enviar {course.name.toLocaleLowerCase('es-MX')}</button><button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => void courseAction(course, 'cancel_service_course')}>Quitar del tiempo</button></div>}{course.status === 'held' ? <p className="operations-caption">Quitar del tiempo libera el envío; los consumos permanecen en la cuenta.</p> : <p className="operations-caption">El envío conserva productos, notas y extras. Para cancelar consumos, usa la cancelación de la cuenta; cocina conserva el aviso.</p>}</li>)}</ul>}
      {held.length > 0 && <p className="operations-caption">Antes de cobrar o enviar toda la cuenta, envía o quita los tiempos retenidos.</p>}
      {visit && <div className="service-visit-summary"><div className="service-panel-heading"><h3><Users size={18} aria-hidden="true" />{visit.name}</h3><strong>{money(visit.balanceCents)} pendiente</strong></div><p className="operations-caption">{visit.status === 'closed' ? 'Visita finalizada' : `${visit.tableIds.length} mesa${visit.tableIds.length === 1 ? '' : 's'} asociada${visit.tableIds.length === 1 ? '' : 's'}`} · {visit.orders.length} cuenta{visit.orders.length === 1 ? '' : 's'}</p><ul className="service-visit-accounts">{visit.orders.map(account => <li key={account.id}><button type="button" className="operations-record-button" disabled={!onOpenOrder || disabled || account.id === order.id} onClick={() => onOpenOrder?.(account)}><span><strong>{account.name}</strong><small>{account.id === order.id ? 'Cuenta actual' : account.balanceCents > 0 ? 'Saldo pendiente' : 'Resuelta'}</small></span><strong>{money(account.balanceCents)}</strong></button></li>)}</ul>
        {canTables && visit.status === 'active' && <button type="button" className="pos-button pos-secondary" disabled={disabled || visit.balanceCents !== 0 || held.length > 0} onClick={() => void act(async current => { const saved = await mutation.execute({ command: 'release_service_visit', operationId: crypto.randomUUID(), visitId: visit.id, expectedRevision: visit.revision }); if (!current()) return; setState(previous => previous ? { ...previous, visit: saved } : null); onSaved(saved.orders.find(account => account.id === order.id)!); setReload(value => value + 1) })}>Finalizar visita y liberar mesas</button>}
      </div>}
      <div className="service-panel-actions">{canTables && (!visit || visit.status === 'active') && <button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => { setTableIds(visit?.tableIds ?? (order.tableId ? [order.tableId] : [])); setDialog('tables') }}>Asociar mesas</button>}{canContinue && <button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => setDialog('continue')}>Añadir consumo después del pago</button>}</div>
      {canContinue && <p className="operations-caption">El nuevo consumo irá a otra cuenta de esta visita. La venta pagada conserva su historial.</p>}
    </>}
    {dialog === 'course' && <PosDialog title="Añadir tiempo" onClose={() => { if (!mutation.busy) setDialog(null) }}><form className="ops-form" onSubmit={event => { event.preventDefault(); void saveCourse() }}><label>Nombre<input autoFocus maxLength={60} value={courseName} disabled={disabled} placeholder="Entradas, principales, postres…" onChange={event => setCourseName(event.target.value)} /></label><p className="operations-caption">Elige las cantidades que cocina debe esperar para preparar.</p>{available.map(line => <label key={line.lineId} className="service-quantity"><span>{line.name}<small>{line.selectionLabel} · {line.available} sin enviar</small></span><input aria-label={`Cantidad de ${line.name}`} type="number" inputMode="numeric" min={0} max={line.available} step={1} value={quantities[line.lineId] ?? 0} disabled={disabled} onChange={event => setQuantities({ ...quantities, [line.lineId]: Number(event.target.value) })} /></label>)}<button type="submit" className="pos-button pos-primary" disabled={disabled || !courseName.trim() || !available.some(line => quantities[line.lineId] > 0)}>Retener estos consumos</button></form></PosDialog>}
    {dialog === 'tables' && <PosDialog title="Mesas de la visita" onClose={() => { if (!mutation.busy) setDialog(null) }}><form className="ops-form" onSubmit={event => { event.preventDefault(); void act(async current => { const result = await mutation.execute({ command: 'associate_service_tables', operationId: crypto.randomUUID(), orderId: order.id, expectedRevision: order.revision, expectedVisitRevision: visit?.revision ?? null, tableIds }); if (!current()) return; setState(previous => ({ courses: previous?.courses ?? [], visit: result.visit })); setDialog(null); onSaved(result.order) }) }}><p className="operations-caption">Las mesas seleccionadas atienden la misma visita. Se liberan al finalizar todas sus cuentas.</p>{tables.filter(table => table.active).map(table => <label className="ops-check" key={table.id}><input type="checkbox" checked={tableIds.includes(table.id)} disabled={disabled || Boolean(table.orderId && table.orderId !== order.id && !visit?.tableIds.includes(table.id)) || table.id === order.tableId && ['open','paid'].includes(order.status)} onChange={event => setTableIds(event.target.checked ? [...tableIds, table.id] : tableIds.filter(id => id !== table.id))} /><span>{table.name}{table.orderId && !tableIds.includes(table.id) ? ' · Ocupada' : ''}</span></label>)}<button type="submit" className="pos-button pos-primary" disabled={disabled}>Guardar mesas asociadas</button></form></PosDialog>}
    {dialog === 'continue' && <PosDialog title="Continuar la visita" onClose={() => { if (!mutation.busy) setDialog(null) }}><form className="ops-form" onSubmit={event => { event.preventDefault(); void act(async current => { const result = await mutation.execute({ command: 'continue_service_order', operationId: crypto.randomUUID(), sourceOrderId: order.id, expectedRevision: order.revision, orderId: crypto.randomUUID(), name: continuationName.trim() }); if (!current()) return; setDialog(null); onContinue(result.order) }) }}><p className="operations-caption">Se abrirá una cuenta nueva para añadir consumos. La cuenta pagada permanecerá disponible dentro de esta visita.</p><label>Nombre de la nueva cuenta<input autoFocus maxLength={100} value={continuationName} disabled={disabled} onChange={event => setContinuationName(event.target.value)} /></label><button type="submit" className="pos-button pos-primary" disabled={disabled || !continuationName.trim()}>Abrir cuenta y añadir consumos</button></form></PosDialog>}
  </section>
}
