import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { AccountClientError, deviceRequest } from '../lib/account'
import { closeIdentity, supabase } from '../lib/supabase'
import type { DeviceStatus, EmployeeSummary, OperatorSession } from '../lib/contracts'
import HomeScreen from './HomeScreen'
import EmployeePinSetup from './EmployeePinSetup'
import './account-management.css'

interface DeviceLoginProps { onExit?: () => void }
const deviceStorageKey = 'pos-mexico-device'
const deviceLockStorageKey = 'pos-mexico-device-lock'
const channelName = 'pos-mexico-device-session'
const roles = { owner: 'Dueño', manager: 'Encargado', cashier: 'Cajero', kitchen: 'Cocina' }

function initialPairingCode() {
  const url = new URL(window.location.href)
  const hash = new URLSearchParams(url.hash.slice(1))
  return hash.get('pair') ?? ''
}

/** The saved credential identifies a restricted register, never a Google user or operator. */
export default function DeviceLogin({ onExit }: DeviceLoginProps) {
  const [pairingCode, setPairingCode] = useState(initialPairingCode)
  const [deviceName, setDeviceName] = useState('')
  const [deviceToken, setDeviceToken] = useState('')
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [selected, setSelected] = useState<EmployeeSummary | null>(null)
  const [pin, setPin] = useState('')
  const [operator, setOperator] = useState<OperatorSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retryAt, setRetryAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [confirmForget, setConfirmForget] = useState(false)
  const [settingPin, setSettingPin] = useState(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const tokenRef = useRef('')
  const operatorRef = useRef<OperatorSession | null>(null)
  const busyRef = useRef(false)
  const pendingMutations = useRef(0)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const pairOperation = useRef<{ fingerprint: string; id: string } | null>(null)
  const identityClosed = useRef(false)
  const employeeRetryAt = useRef(new Map<string, number>())
  const initializationCycle = useRef(0)

  function beginMutation() {
    pendingMutations.current += 1
    busyRef.current = true
    setBusy(true)
  }

  function endMutation() {
    pendingMutations.current = Math.max(0, pendingMutations.current - 1)
    busyRef.current = pendingMutations.current > 0
    if (mounted.current) setBusy(busyRef.current)
  }

  function clearPrivate() {
    generation.current += 1
    operatorRef.current = null
    setOperator(null)
    setSelected(null)
    setPin('')
    setSettingPin(false)
    setRetryAt(0)
  }

  function forgetLocal() {
    clearPrivate()
    tokenRef.current = ''
    setDeviceToken('')
    setStatus(null)
    setConfirmForget(false)
    try { localStorage.removeItem(deviceStorageKey) } catch { /* Local state is already closed. */ }
  }

  function broadcast(type: 'lock' | 'forget') {
    channelRef.current?.postMessage(type)
    try { localStorage.setItem(deviceLockStorageKey, JSON.stringify({ type, eventId: crypto.randomUUID() })) } catch { /* BroadcastChannel covers supported browsers. */ }
  }

  function report(caught: unknown) {
    if (!mounted.current) return
    setError(caught instanceof Error ? caught.message : 'No pudimos completar la solicitud. Intenta de nuevo.')
    if (caught instanceof AccountClientError) {
      if (caught.code === 'DEVICE_REVOKED' || caught.code === 'BUSINESS_ACCESS_DENIED') {
        forgetLocal()
        broadcast('forget')
        setLoading(false)
      } else if (['SESSION_INVALID', 'SESSION_EXPIRED', 'EMPLOYEE_INACTIVE', 'PERMISSION_DENIED'].includes(caught.code)) {
        clearPrivate()
        setLoading(false)
      } else if (caught.code === 'PIN_LOCKED') {
        const blockedUntil = Date.now() + (caught.retryAfterSeconds ?? 900) * 1000
        if (selected) employeeRetryAt.current.set(selected.id, blockedUntil)
        setRetryAt(blockedUntil)
        setNow(Date.now())
      }
    }
  }

  async function refreshStatus(token = tokenRef.current) {
    if (!token) { setLoading(false); return }
    const current = generation.current
    setLoading(true)
    try {
      const result = await deviceRequest({ action: 'device_status', deviceToken: token })
      if (mounted.current && current === generation.current && tokenRef.current === token) setStatus(result)
    } catch (caught) { if (current === generation.current) report(caught) }
    finally { if (mounted.current && current === generation.current) setLoading(false) }
  }

  useEffect(() => {
    mounted.current = true
    const initializationGeneration = ++initializationCycle.current
    // Consume the URL in an effect, so repeated render initializers keep the code.
    const url = new URL(window.location.href)
    const hash = new URLSearchParams(url.hash.slice(1))
    if (hash.has('pair')) {
      hash.delete('pair')
      url.hash = hash.toString()
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null
    channelRef.current = channel
    const receive = (type: unknown) => {
      if (type === 'forget') { forgetLocal(); setLoading(false); setError('El dispositivo fue desvinculado.') }
      else if (type === 'lock') { clearPrivate(); setError(''); void refreshStatus() }
    }
    if (channel) channel.onmessage = (event) => receive(event.data)
    const storageChanged = (event: StorageEvent) => {
      if (event.key === deviceLockStorageKey && event.newValue) {
        try { receive((JSON.parse(event.newValue) as { type?: unknown }).type) } catch { /* Ignore unrelated malformed events. */ }
      }
      if (event.key === deviceStorageKey && event.newValue !== tokenRef.current) {
        clearPrivate()
        tokenRef.current = event.newValue ?? ''
        setDeviceToken(tokenRef.current)
        setStatus(null)
        void refreshStatus()
      }
    }
    window.addEventListener('storage', storageChanged)
    void (async () => {
      try {
        // Closing identity also prevents the SDK from writing a later Google session here.
        const identity = await supabase?.auth.getSession()
        if (!mounted.current || initializationGeneration !== initializationCycle.current) return
        const closed = await closeIdentity(identity?.data.session?.access_token)
        if (!mounted.current || initializationGeneration !== initializationCycle.current) return
        identityClosed.current = true
        if (!closed) setError('Se cerró Google en esta caja. No pudimos confirmar el cierre remoto; puedes reintentar desde el acceso del dueño.')
        const stored = localStorage.getItem(deviceStorageKey) ?? ''
        if (stored && !/^[a-f0-9]{64}$/.test(stored)) {
          localStorage.removeItem(deviceStorageKey)
          setError('Vuelve a vincular este dispositivo.')
          setLoading(false)
          return
        }
        tokenRef.current = stored
        setDeviceToken(stored)
        await refreshStatus(stored)
      } catch (caught) { if (mounted.current && initializationGeneration === initializationCycle.current) { report(caught); setLoading(false) } }
    })()
    return () => {
      mounted.current = false
      initializationCycle.current += 1
      generation.current += 1
      channel?.close()
      channelRef.current = null
      window.removeEventListener('storage', storageChanged)
    }
  }, [])

  useEffect(() => {
    if (!retryAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [retryAt])

  async function pair(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busyRef.current || !identityClosed.current) return
    if (!pairingCode.trim() || deviceName.trim().length < 2) { setError('Escribe el código y un nombre para esta caja.'); return }
    // Detect disabled storage before consuming a one-use pairing code on the server.
    try { localStorage.setItem('pos-mexico-device-storage-probe', 'available'); localStorage.removeItem('pos-mexico-device-storage-probe') }
    catch { setError('Este navegador no permite guardar la vinculación. Habilita el almacenamiento y vuelve a intentarlo.'); return }
    const fingerprint = JSON.stringify({ pairingCode: pairingCode.trim(), deviceName: deviceName.trim() })
    if (pairOperation.current?.fingerprint !== fingerprint) pairOperation.current = { fingerprint, id: crypto.randomUUID() }
    const current = generation.current
    beginMutation()
    setError('')
    try {
      const result = await deviceRequest({ action: 'device_pair', pairingCode: pairingCode.trim(), deviceName: deviceName.trim(), operationId: pairOperation.current.id })
      if (!mounted.current || current !== generation.current) {
        await deviceRequest({ action: 'device_forget', deviceToken: result.deviceToken }).catch(() => undefined)
        return
      }
      try { localStorage.setItem(deviceStorageKey, result.deviceToken) }
      catch {
        await deviceRequest({ action: 'device_forget', deviceToken: result.deviceToken }).catch(() => undefined)
        pairOperation.current = null
        setPairingCode('')
        throw new Error('No pudimos guardar la vinculación. Habilita el almacenamiento y pide un nuevo código al dueño.')
      }
      tokenRef.current = result.deviceToken
      setDeviceToken(result.deviceToken)
      setPairingCode('')
      pairOperation.current = null
      await refreshStatus(result.deviceToken)
    } catch (caught) { if (current === generation.current) report(caught) }
    finally { endMutation() }
  }

  async function unlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busyRef.current || !selected || !tokenRef.current || retryAt > Date.now()) return
    if (!/^[0-9]{6}$/.test(pin)) { setError('Escribe tu PIN de seis dígitos.'); return }
    const current = generation.current
    const token = tokenRef.current
    beginMutation()
    setError('')
    // Other tabs hide their old operator before the server changes operators.
    broadcast('lock')
    try {
      const result = await deviceRequest({ action: 'device_unlock', deviceToken: token, employeeId: selected.id, pin })
      if (!mounted.current || current !== generation.current) {
        await deviceRequest({ action: 'device_lock', deviceToken: token, operatorToken: result.operatorToken }).catch(() => undefined)
        return
      }
      operatorRef.current = result
      setOperator(result)
      setRetryAt(0)
      employeeRetryAt.current.delete(selected.id)
    } catch (caught) {
      if (current === generation.current) {
        report(caught)
        if (caught instanceof AccountClientError && caught.code === 'EMPLOYEE_INACTIVE' && tokenRef.current) await refreshStatus()
      }
    }
    finally { if (mounted.current && current === generation.current) setPin(''); endMutation() }
  }

  async function lock(message = '') {
    if (busyRef.current) return
    const previous = operatorRef.current
    const token = tokenRef.current
    clearPrivate()
    setError(message)
    broadcast('lock')
    beginMutation()
    try {
      if (previous && token) await deviceRequest({ action: 'device_lock', deviceToken: token, operatorToken: previous.operatorToken })
      await refreshStatus(token)
    } catch (caught) {
      if (caught instanceof AccountClientError && caught.code === 'DEVICE_REVOKED') report(caught)
      else setError('La caja quedó bloqueada. No pudimos confirmar el cierre en el servidor; revisa tu conexión.')
    } finally { endMutation() }
  }

  async function forget() {
    if (busyRef.current) return
    const token = tokenRef.current
    forgetLocal()
    broadcast('forget')
    beginMutation()
    setError('')
    try { if (token) await deviceRequest({ action: 'device_forget', deviceToken: token }) }
    catch (caught) {
      if (!(caught instanceof AccountClientError && caught.code === 'DEVICE_REVOKED')) setError('Se eliminó la vinculación local. No pudimos confirmar la revocación; pide al dueño que revoque esta caja en Personal y dispositivos.')
    } finally { endMutation(); if (mounted.current) setLoading(false) }
  }

  useEffect(() => {
    if (!operator) return
    const expires = new Date(operator.expiresAt).getTime()
    const timeout = window.setTimeout(() => void lock('Tu sesión venció. Vuelve a entrar con tu PIN.'), Math.max(0, expires - Date.now()))
    let inactivity = window.setTimeout(() => void lock('La caja se bloqueó por inactividad.'), 15 * 60_000)
    const active = () => { window.clearTimeout(inactivity); inactivity = window.setTimeout(() => void lock('La caja se bloqueó por inactividad.'), 15 * 60_000) }
    const activityEvents = ['pointerdown', 'keydown', 'touchstart'] as const
    for (const event of activityEvents) window.addEventListener(event, active, { passive: true })
    let refreshing = false
    const verify = async () => {
      if (refreshing || !operatorRef.current || busyRef.current) return
      refreshing = true
      const current = generation.current
      const session = operatorRef.current
      try {
        const result = await deviceRequest({ action: 'device_context', deviceToken: tokenRef.current, operatorToken: session.operatorToken })
        if (mounted.current && current === generation.current) {
          const updated = { ...session, business: result.business, expiresAt: result.expiresAt }
          operatorRef.current = updated
          // Preserve the interval and inactivity timer when only context changes.
          setOperator((previous) => previous && JSON.stringify(previous.business) !== JSON.stringify(updated.business) ? updated : previous)
        }
      } catch (caught) {
        if (current === generation.current && mounted.current) {
          if (caught instanceof AccountClientError && ['DEVICE_REVOKED', 'SESSION_INVALID', 'SESSION_EXPIRED', 'EMPLOYEE_INACTIVE', 'PERMISSION_DENIED'].includes(caught.code)) {
            report(caught)
            setLoading(false)
            if (tokenRef.current) await refreshStatus()
          } else await lock('No pudimos verificar tu acceso. Vuelve a entrar cuando tengas conexión.')
        }
      } finally { refreshing = false }
    }
    const focus = () => { void verify() }
    const interval = window.setInterval(focus, 30_000)
    window.addEventListener('focus', focus)
    return () => {
      window.clearTimeout(timeout)
      window.clearTimeout(inactivity)
      window.clearInterval(interval)
      window.removeEventListener('focus', focus)
      for (const event of activityEvents) window.removeEventListener(event, active)
    }
  }, [operator?.operatorToken])

  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000))
  if (operator) return <HomeScreen business={operator.business} onLock={() => void lock()} onLogout={() => void lock()} onSwitchEmployee={() => void lock()} logoutLabel="Salir de mi turno" busy={busy} error={error} timezoneLabel={operator.business.timezone} />
  if (settingPin && deviceToken) return <div className="employee-shell"><EmployeePinSetup deviceToken={deviceToken} onBack={() => { generation.current += 1; setSettingPin(false) }} onBeforeConsume={() => broadcast('lock')} onDone={(result) => { operatorRef.current = result; setOperator(result); setSettingPin(false); setError(''); setRetryAt(0); if (result.business.employee) employeeRetryAt.current.delete(result.business.employee.id); broadcast('lock') }} /></div>

  return <div className="employee-shell">
    {onExit && <button type="button" className="back-button" onClick={onExit} disabled={busy}><ArrowLeft size={18} aria-hidden="true" />Acceso del dueño</button>}
    {loading ? <div className="employee-loading" role="status"><span className="loader" aria-hidden="true" /><p>Cargando caja…</p></div>
      : !deviceToken ? <section className="employee-screen">
        <h1>Entrar como empleado</h1><p>Pide al dueño un código para vincular esta caja.</p>
        <form onSubmit={pair}>
          <div className="field"><label htmlFor="device-pairing">Código de emparejamiento</label><input id="device-pairing" value={pairingCode} onChange={(event) => setPairingCode(event.target.value.trim())} maxLength={128} required disabled={busy} autoComplete="off" autoCapitalize="none" spellCheck={false} /></div>
          <div className="field"><label htmlFor="device-name">Nombre del dispositivo</label><input id="device-name" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} placeholder="Tablet de mostrador" minLength={2} maxLength={100} required disabled={busy} /></div>
          {error && <p className="error-message" role="alert">{error}</p>}
          <div className="screen-actions"><button className="button primary" disabled={busy || !identityClosed.current} aria-busy={busy}>{busy ? 'Vinculando…' : 'Vincular dispositivo'}</button></div>
        </form>
      </section> : selected ? <section className="employee-screen">
        <button type="button" className="back-button" disabled={busy} onClick={() => { setSelected(null); setPin(''); setError(''); setRetryAt(0) }}><ArrowLeft size={18} aria-hidden="true" />Cambiar empleado</button>
        <p className="employee-selected">{selected.name}</p><h1>Ingresa tu PIN</h1><p>{status?.business.name}</p>
        <form onSubmit={unlock}>
          <div className="field"><label htmlFor="device-pin">PIN del empleado</label><input id="device-pin" data-testid="employee-pin-input" className="employee-pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} value={pin} onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))} disabled={busy || remaining > 0} required autoFocus /></div>
          {error && <p className="error-message" role="alert">{error}</p>}
          {remaining > 0 && <p className="employee-countdown" role="status">Vuelve a intentar en {Math.ceil(remaining / 60)} min.</p>}
          <div className="screen-actions"><button className="button primary" disabled={busy || remaining > 0} aria-busy={busy}>{busy ? 'Entrando…' : 'Entrar'}</button></div>
          {selected.role === 'owner' ? <p className="field-help">Para recuperar el PIN del dueño, abre Acceso del dueño y usa Google con tu código de recuperación.</p> : <button type="button" className="button secondary" disabled={busy} onClick={() => { if (busyRef.current) return; generation.current += 1; setPin(''); setSettingPin(true) }}>Crear o restablecer mi PIN</button>}
        </form>
      </section> : <section className="employee-screen employee-roster">
        {status && <p className="employee-summary">{status.business.name} / {status.registerName}</p>}
        <h1>Elige tu nombre</h1><p>Cada empleado entra con su propio PIN.</p>
        <button type="button" className="button secondary" disabled={busy} onClick={() => { if (busyRef.current) return; generation.current += 1; setSettingPin(true) }}>Crear o restablecer mi PIN</button>
        {error && <p className="error-message" role="alert">{error}</p>}
        {status ? <><div className="business-list">{status.employees.filter((employee) => employee.active).map((employee) => <button type="button" key={employee.id} className="business-choice" aria-label={employee.name} disabled={busy} onClick={() => { setSelected(employee); setError(''); setPin(''); setRetryAt(employeeRetryAt.current.get(employee.id) ?? 0); setNow(Date.now()) }}><span><span>{employee.name}</span><small>{roles[employee.role]}</small></span><ChevronRight size={20} aria-hidden="true" /></button>)}</div>{!status.employees.some((employee) => employee.active) && <p className="management-empty">No hay empleados activos. Pide al dueño que agregue tu acceso.</p>}</> : <button type="button" className="button secondary" disabled={busy} onClick={() => { setError(''); void refreshStatus() }}>Reintentar</button>}
        {confirmForget ? <div className="employee-forget-confirm"><p>Para volver a usar esta caja necesitarás un nuevo código del dueño.</p><div className="management-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void forget()}>Sí, desvincular</button><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmForget(false)}>Cancelar</button></div></div> : <div className="management-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmForget(true)}>Desvincular dispositivo</button></div>}
      </section>}
  </div>
}
