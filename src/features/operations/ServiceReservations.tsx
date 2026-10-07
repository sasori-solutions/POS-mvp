import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Plus } from 'lucide-react'
import type { BusinessContext } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import { businessTimezoneLabel } from '../../lib/business-profile'
import type { DiningTable, OperationalOrder } from '../../lib/operations-contracts'
import type { ReservationStatus, ServiceDay, ServiceMutation, ServiceReservation } from '../../lib/service-contracts'
import { posRequest, type PosAccess } from '../../lib/pos'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'
import { serviceLocalInput, serviceLocalTimestamp } from '../../lib/service-time'
import { assertServiceDayView } from '../../lib/service-response'
import { PosDialog } from '../../components/PosShared'
import './service-panels.css'

const labels: Record<ReservationStatus, string> = { confirmed: 'Confirmada', seated: 'En mesa', cancelled: 'Cancelada', no_show: 'No se presentó', completed: 'Visita finalizada' }
type Draft = { id: string; reservation?: ServiceReservation; name: string; contact: string; partySize: number; startsAt: string; endsAt: string; tableIds: string[]; note: string }
export default function ServiceReservations({ business, access, orders, tables, mutation, onOpenOrder, onNewAccount, onSaved, onSessionError }: {
  business: BusinessContext; access: PosAccess; orders: OperationalOrder[]; tables: DiningTable[]; mutation: ServiceMutation
  onOpenOrder?: (order: OperationalOrder) => void; onNewAccount?: () => void; onSaved?: () => void
  onSessionError?: (error: AccountClientError) => void
}) {
  const timezone = business.timezone
  const [date, setDate] = useState(() => serviceLocalInput(new Date().toISOString(), timezone).slice(0, 10))
  const [day, setDay] = useState<ServiceDay | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null), [seating, setSeating] = useState<ServiceReservation | null>(null), [orderId, setOrderId] = useState('')
  const generation = useRef(0), submitted = useRef(false)
  const sessionErrorHandler = useRef(onSessionError); sessionErrorHandler.current = onSessionError
  const canManage = hasPermission(business, 'orders.manage') && hasPermission(business, 'tables.manage')
  const disabled = mutation.busy || Boolean(mutation.pending) || loading
  useEffect(() => {
    const captured = ++generation.current; setDay(null); setLoading(true); setError('')
    void posRequest(access, { command: 'service_day', date }).then(value => { if (generation.current === captured) { assertServiceDayView(value); setDay(value); setLoading(false) } }).catch(cause => {
      if (generation.current !== captured) return
      setLoading(false)
      if (cause instanceof AccountClientError && accessErrorCodes.includes(cause.code)) sessionErrorHandler.current?.(cause)
      else setError('No pudimos cargar las reservaciones. Vuelve a intentar.')
    })
    return () => { generation.current++ }
  }, [access.businessId, access.operatorToken, access.deviceToken, date, reload])
  useEffect(() => { setDraft(null); setSeating(null) }, [access.businessId, access.operatorToken, access.deviceToken])
  const serviceOrders = orders.filter(order => order.orderKind !== 'counter' && order.status === 'open' && order.phase === 'service' && !order.frozen)
  function edit(reservation?: ServiceReservation) {
    setError('')
    setDraft({ id: reservation?.id ?? crypto.randomUUID(), reservation, name: reservation?.name ?? '', contact: reservation?.contact ?? '', partySize: reservation?.partySize ?? 2, startsAt: reservation ? serviceLocalInput(reservation.startsAt, timezone) : `${date}T13:00`, endsAt: reservation ? serviceLocalInput(reservation.endsAt, timezone) : `${date}T14:30`, tableIds: reservation?.tableIds ?? [], note: reservation?.note ?? '' })
  }
  async function save() {
    if (!draft || disabled || submitted.current || !canManage) return
    const startsAt = serviceLocalTimestamp(draft.startsAt, timezone), endsAt = serviceLocalTimestamp(draft.endsAt, timezone)
    if (!startsAt || !endsAt) { setError('Ese horario no existe o se repite por el cambio de hora. Elige otro horario.'); return }
    const duration = Date.parse(endsAt) - Date.parse(startsAt)
    if (duration < 900_000 || duration > 43_200_000) { setError('La reservación debe durar entre 15 minutos y 12 horas.'); return }
    const captured = generation.current; submitted.current = true; setError('')
    try {
      await mutation.execute({ command: 'save_service_reservation', operationId: crypto.randomUUID(), reservationId: draft.id, expectedRevision: draft.reservation?.revision ?? null, name: draft.name.trim(), contact: draft.contact.trim(), partySize: draft.partySize, startsAt, endsAt, tableIds: draft.tableIds, note: draft.note.trim() })
      if (generation.current !== captured) return
      setDraft(null); setReload(value => value + 1); onSaved?.()
    } catch { if (generation.current === captured) setError('La reservación no se guardó. Revisa el aviso; no vuelvas a capturarla si está pendiente de recuperar.') }
    finally { submitted.current = false }
  }
  async function status(reservation: ServiceReservation, value: ReservationStatus, accountId: string | null = null) {
    if (disabled || submitted.current || !canManage) return
    const captured = generation.current; submitted.current = true; setError('')
    try {
      const result = await mutation.execute({ command: 'set_service_reservation_status', operationId: crypto.randomUUID(), reservationId: reservation.id, expectedRevision: reservation.revision, status: value, orderId: accountId })
      if (generation.current !== captured) return
      setSeating(null); setReload(number => number + 1); onSaved?.()
      if (value === 'seated') { const account = result.visit?.orders.find(order => order.id === accountId); if (account) onOpenOrder?.(account) }
    } catch { if (generation.current === captured) setError('No se pudo actualizar la reservación. Revisa el aviso de la operación.') }
    finally { submitted.current = false }
  }
  const time = (value: string) => new Intl.DateTimeFormat('es-MX', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  const formError = error || mutation.error
  return <section className="service-reservations" aria-label="Reservaciones">
    <div className="service-panel-heading"><div><h3><CalendarDays size={20} aria-hidden="true" />Reservaciones</h3><p className="operations-caption">Hora del local · {businessTimezoneLabel(timezone)}</p></div>{canManage && <button type="button" className="pos-button pos-primary" disabled={disabled} onClick={() => edit()}><Plus size={18} aria-hidden="true" />Añadir reservación</button>}</div>
    <div className="service-reservation-toolbar"><label>Fecha<input type="date" min="2000-01-01" max="2100-12-31" value={date} disabled={mutation.busy} onChange={event => { if (event.target.value) setDate(event.target.value) }} /></label><button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => setReload(value => value + 1)}>Actualizar agenda</button></div>
    {loading && <p role="status" className="operations-caption">Cargando agenda…</p>}
    {formError && !draft && !seating && <div className="operations-error" role="alert"><p>{formError}</p>{!mutation.pending && <button type="button" className="pos-button pos-secondary" disabled={mutation.busy} onClick={() => setReload(value => value + 1)}>Volver a cargar</button>}</div>}
    {day && (day.reservations.length ? <ul className="service-reservation-list">{day.reservations.map(reservation => <li key={reservation.id}><div className="service-panel-heading"><strong>{time(reservation.startsAt)}–{time(reservation.endsAt)} · {reservation.name}</strong><span className="service-status">{labels[reservation.status]}</span></div><small>{reservation.partySize} personas · {reservation.tableIds.map(id => tables.find(table => table.id === id)?.name ?? 'Mesa').join(', ') || 'Sin mesa asignada'}</small>{reservation.contact && <p>{reservation.contact}</p>}{reservation.note && <p>{reservation.note}</p>}{canManage && reservation.status === 'confirmed' && <div className="service-panel-actions"><button type="button" className="pos-button pos-primary" disabled={disabled} onClick={() => { setOrderId(''); setSeating(reservation) }}>Registrar llegada</button><button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => edit(reservation)}>Editar</button><button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => void status(reservation, 'no_show')}>No se presentó</button><button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => void status(reservation, 'cancelled')}>Cancelar reserva</button></div>}{reservation.status === 'seated' && <p className="operations-caption">Finaliza la visita desde su cuenta para liberar las mesas y cerrar esta reservación.</p>}</li>)}</ul> : <div className="operations-empty"><CalendarDays size={28} aria-hidden="true" /><h3>No hay reservaciones para esta fecha</h3><p>Añade el horario y las mesas; la agenda te avisará si se cruzan con otra reserva.</p></div>)}
    {draft && <PosDialog title={draft.reservation ? 'Editar reservación' : 'Añadir reservación'} onClose={() => { if (!mutation.busy) setDraft(null) }}><form className="ops-form" onSubmit={event => { event.preventDefault(); void save() }}><label>Nombre<input autoFocus required maxLength={100} disabled={disabled} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><div className="service-form-columns"><label>Personas<input type="number" inputMode="numeric" required min={1} max={100} step={1} disabled={disabled} value={draft.partySize} onChange={event => setDraft({ ...draft, partySize: Number(event.target.value) })} /></label><label>Contacto opcional<input type="text" maxLength={80} disabled={disabled} value={draft.contact} onChange={event => setDraft({ ...draft, contact: event.target.value })} /></label></div><label>Inicio · horario del negocio<input type="datetime-local" required min="2000-01-01T00:00" max="2100-12-31T23:59" disabled={disabled} value={draft.startsAt} onChange={event => setDraft({ ...draft, startsAt: event.target.value })} /></label><label>Fin · horario del negocio<input type="datetime-local" required disabled={disabled} value={draft.endsAt} onChange={event => setDraft({ ...draft, endsAt: event.target.value })} /></label><fieldset className="ops-form"><legend>Mesas</legend>{tables.filter(table => table.active).map(table => <label className="ops-check" key={table.id}><input type="checkbox" disabled={disabled} checked={draft.tableIds.includes(table.id)} onChange={event => setDraft({ ...draft, tableIds: event.target.checked ? [...draft.tableIds, table.id] : draft.tableIds.filter(id => id !== table.id) })} /><span>{table.name}</span></label>)}</fieldset><label>Nota opcional<textarea maxLength={200} disabled={disabled} value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} /></label>{formError && <p role="alert">{formError}</p>}<button type="submit" className="pos-button pos-primary" disabled={disabled || !draft.name.trim() || !Number.isInteger(draft.partySize) || draft.partySize < 1 || draft.partySize > 100}>Guardar reservación</button></form></PosDialog>}
    {seating && <PosDialog title={`Llegada de ${seating.name}`} onClose={() => { if (!mutation.busy) setSeating(null) }}><form className="ops-form" onSubmit={event => { event.preventDefault(); if (orderId) void status(seating, 'seated', orderId) }}><p className="operations-caption">Asocia la reservación con una cuenta de servicio. Sus mesas quedarán ocupadas por la misma visita.</p>{serviceOrders.length > 0 ? <label>Cuenta<select required value={orderId} disabled={disabled} onChange={event => setOrderId(event.target.value)}><option value="">Selecciona una cuenta</option>{serviceOrders.map(order => <option key={order.id} value={order.id}>{order.name}</option>)}</select></label> : <p>Abre una cuenta para esta visita desde Mesas.</p>}{onNewAccount && <button type="button" className="pos-button pos-secondary" disabled={disabled} onClick={() => { setSeating(null); onNewAccount() }}>Abrir una cuenta</button>}{formError && <p role="alert">{formError}</p>}<button type="submit" className="pos-button pos-primary" disabled={disabled || !orderId}>Asociar cuenta y registrar llegada</button></form></PosDialog>}
  </section>
}
