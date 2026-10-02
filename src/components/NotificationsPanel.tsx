import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bell, Check, RefreshCw } from 'lucide-react'
import { accountRequest, AccountClientError } from '../lib/account'
import type { AccountResponses } from '../lib/contracts'
import './account-management.css'
import './notifications.css'

type Notice = AccountResponses['notifications']['notifications'][number]
interface Props {
  businessId: string
  operatorToken: string
  onBack: () => void
  onSessionError: (error: unknown) => void
  onUnreadCount: (count: number) => void
}
const statuses = { pending: 'Pendiente', approved: 'Autorizado', rejected: 'Rechazado', info: 'Dispositivo vinculado' }
function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })
}
export default function NotificationsPanel({ businessId, operatorToken, onBack, onSessionError, onUnreadCount }: Props) {
  const [notices, setNotices] = useState<Notice[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const alive = useRef(true)
  const pending = useRef(false)
  const mutationBusy = useRef(false)
  const generation = useRef(0)
  const requestSequence = useRef(0)
  const callbacks = useRef({ onSessionError, onUnreadCount })
  callbacks.current = { onSessionError, onUnreadCount }
  const fail = useCallback((problem: unknown) => {
    if (problem instanceof AccountClientError && ['AUTH_REQUIRED', 'GOOGLE_REQUIRED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'BUSINESS_ACCESS_DENIED'].includes(problem.code)) callbacks.current.onSessionError(problem)
    else setError(problem instanceof Error ? problem.message : 'No pudimos cargar las notificaciones.')
  }, [])
  const refresh = useCallback(async (force = false) => {
    if (pending.current && !force) return
    const current = generation.current
    const sequence = ++requestSequence.current
    pending.current = true
    setRefreshing(true)
    try {
      const data = await accountRequest({ action: 'notifications', businessId, operatorToken })
      if (!alive.current || current !== generation.current || sequence !== requestSequence.current || mutationBusy.current) return
      setNotices(data.notifications); callbacks.current.onUnreadCount(data.unreadCount); setError('')
    } catch (problem) {
      if (alive.current && current === generation.current && sequence === requestSequence.current && !mutationBusy.current) fail(problem)
    } finally {
      if (alive.current && current === generation.current && sequence === requestSequence.current) {
        pending.current = false; setRefreshing(false); setLoading(false)
      }
    }
  }, [businessId, operatorToken, fail])
  useEffect(() => {
    alive.current = true
    generation.current += 1
    pending.current = false
    mutationBusy.current = false
    setNotices([]); setLoading(true); setBusy(''); setConfirm(null); setMessage(''); setError('')
    void refresh()
    const update = () => { if (document.visibilityState === 'visible') void refresh() }
    const timer = window.setInterval(update, 30_000)
    document.addEventListener('visibilitychange', update)
    return () => { alive.current = false; generation.current += 1; clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [refresh])
  async function act(notice: Notice, decision?: 'approve' | 'reject') {
    if (mutationBusy.current || pending.current) return
    const current = generation.current
    mutationBusy.current = true
    setBusy(notice.id); setMessage(''); setError('')
    try {
      if (decision) await accountRequest({ action: 'review_employee_device', businessId, operatorToken, notificationId: notice.id, decision })
      else await accountRequest({ action: 'mark_notification_read', businessId, operatorToken, notificationId: notice.id })
      if (!alive.current || current !== generation.current) return
      mutationBusy.current = false
      setConfirm(null)
      setMessage(decision === 'approve' ? 'Cambio autorizado. El dispositivo anterior perdió el acceso; el empleado ya puede entrar desde el nuevo.' : decision === 'reject' ? 'Solicitud rechazada. El dispositivo anterior conserva el acceso.' : 'Notificación marcada como leída.')
      // Supersede any read begun before this decision committed.
      await refresh(true)
    } catch (problem) {
      if (alive.current && current === generation.current) {
        requestSequence.current += 1; pending.current = false; setRefreshing(false); fail(problem)
      }
    } finally {
      if (alive.current && current === generation.current) { mutationBusy.current = false; setBusy('') }
    }
  }
  const actionsDisabled = loading || refreshing || Boolean(busy)
  return <section className="screen notifications-screen">
    <button className="back-button" onClick={onBack}><ArrowLeft size={20} aria-hidden="true" />Volver a Más</button>
    <div className="notifications-title"><h1>Notificaciones</h1><button className="pos-icon-button" aria-label="Actualizar notificaciones" onClick={() => void refresh()} disabled={actionsDisabled}><RefreshCw size={20} aria-hidden="true" /></button></div>
    <p>Revisa los accesos de tu equipo. Un dispositivo nuevo permanece bloqueado hasta que autorices el cambio.</p>
    {error && <p role="alert" className="error-message">{error}</p>}
    {message && <p role="status" className="notice-success"><Check size={18} aria-hidden="true" />{message}</p>}
    {loading ? <p role="status">Cargando notificaciones…</p> : notices.length === 0 && !error ? <div className="notifications-empty"><Bell size={28} aria-hidden="true" /><h2>Estás al día</h2><p>Aquí aparecerán las solicitudes y los dispositivos vinculados de tus empleados.</p></div> : <ul className="notification-list">{notices.map((notice) => <li key={notice.id} className={`notification-card ${notice.readAt ? '' : 'unread'}`}>
      <div className="notification-meta"><span>{statuses[notice.status]}</span><time dateTime={notice.createdAt}>{dateLabel(notice.createdAt)}</time></div>
      <h2>{notice.type === 'employee_device_requested' ? 'Solicitud de otro dispositivo' : 'Dispositivo vinculado'}</h2>
      <p><strong>{notice.employeeName}</strong> · {notice.deviceName}</p>
      {notice.type === 'employee_device_requested' && notice.status === 'pending' && <p>La cuenta y el PIN se verificaron, pero el acceso está bloqueado. Confirma con el empleado que reconoce este dispositivo.</p>}
      {!notice.readAt && <span className="notification-unread">Sin leer</span>}
      {notice.status === 'pending' ? confirm === notice.id ? <div className="notification-confirm"><p>Al reemplazar el dispositivo, se cerrarán las sesiones anteriores de {notice.employeeName}.</p><button className="button primary" disabled={actionsDisabled} onClick={() => void act(notice, 'approve')}>Reemplazar dispositivo</button><button className="button secondary" disabled={actionsDisabled} onClick={() => setConfirm(null)}>Cancelar</button></div> : <div className="notification-actions"><button className="button primary" disabled={actionsDisabled} onClick={() => setConfirm(notice.id)}>Autorizar cambio</button><button className="button secondary" disabled={actionsDisabled} onClick={() => void act(notice, 'reject')}>Rechazar</button></div> : null}
      {!notice.readAt && <button className="text-button" disabled={actionsDisabled} onClick={() => void act(notice)}>Marcar como leída</button>}
    </li>)}</ul>}
  </section>
}
