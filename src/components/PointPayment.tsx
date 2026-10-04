import { useCallback, useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { CheckoutAttempt } from '../lib/operations-contracts'
import type { PointCheckout, PointSettings } from '../lib/point-contracts'
import { pointFailed, pointRequest, pointResolved, pointStateLabels } from '../lib/point-client'
import { money, type PosAccess } from '../lib/pos'
import { SaleDetail } from './PosShared'
import { accessErrorCodes } from './useCatalog'

export default function PointPayment({ access, attempt, initialCheckout, settings, onSessionError, onBlocked, onResolved, onDone }: {
  access: PosAccess; attempt?: CheckoutAttempt | null; initialCheckout?: PointCheckout; settings: PointSettings | null
  onSessionError?: (error: AccountClientError) => void; onBlocked?: (blocked: boolean) => void
  onResolved?: (checkout: PointCheckout) => void; onDone?: () => void
}) {
  const [checkout, setCheckout] = useState<PointCheckout | null>(initialCheckout ?? null)
  const [terminalId, setTerminalId] = useState(initialCheckout?.terminal.id ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reason, setReason] = useState('')
  const [uncertain, setUncertain] = useState(false), [online, setOnline] = useState(navigator.onLine)
  const alive = useRef(true), running = useRef(false), prepareId = useRef(crypto.randomUUID()), startId = useRef(crypto.randomUUID())
  const resolved = useRef('')
  const heading = useRef<HTMLHeadingElement>(null)
  const available = settings?.terminals.filter(t => t.active && t.verified && t.mode === 'PDV' && !t.physicalStepsPending) ?? []
  const blocked = busy || uncertain || Boolean(checkout && (!pointResolved(checkout.state) || checkout.saleState !== 'materialized' && !pointFailed(checkout.state)))
  const change = useCallback((value: PointCheckout) => { if (alive.current) { setCheckout(value); setUncertain(false); setError('') } }, [])
  useEffect(() => { if (initialCheckout) setCheckout(previous => !previous || initialCheckout.id === previous.id && initialCheckout.updatedAt > previous.updatedAt ? initialCheckout : previous) }, [initialCheckout])
  useEffect(() => { alive.current = true; const connected = () => setOnline(navigator.onLine); window.addEventListener('online', connected); window.addEventListener('offline', connected); heading.current?.focus(); return () => { alive.current = false; window.removeEventListener('online', connected); window.removeEventListener('offline', connected); onBlocked?.(false) } }, [])
  useEffect(() => { onBlocked?.(blocked) }, [blocked, onBlocked])
  useEffect(() => { if (!terminalId && available[0]) setTerminalId(available[0].id) }, [available, terminalId])
  useEffect(() => {
    if (!checkout || !pointResolved(checkout.state) || checkout.saleState !== 'materialized' && !pointFailed(checkout.state)) return
    const key = `${checkout.id}:${checkout.state}:${checkout.saleState}`
    if (resolved.current !== key) { resolved.current = key; onResolved?.(checkout) }
  }, [checkout, onResolved])
  function failure(caught: unknown) {
    if (!alive.current) return
    setError(caught instanceof Error ? caught.message : 'No pudimos confirmar el resultado. Conserva este intento.')
    if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
  }
  const read = useCallback(async () => {
    if (!checkout || running.current || !navigator.onLine) return
    running.current = true
    try { change(await pointRequest(access, { command: 'status', checkoutId: checkout.id })) } catch (caught) { failure(caught) }
    finally { running.current = false }
  }, [access.businessId, access.operatorToken, access.deviceToken, checkout?.id])
  useEffect(() => {
    if (!checkout || pointResolved(checkout.state) && (checkout.saleState === 'materialized' || pointFailed(checkout.state))) return
    // This is bounded backend polling. Durable server reconciliation does not depend on this view.
    let count = 0
    const interval = window.setInterval(() => { if (++count <= 40 && !document.hidden) void read(); else if (count > 40) window.clearInterval(interval) }, 3_000)
    return () => window.clearInterval(interval)
  }, [checkout?.id, checkout?.state, checkout?.saleState, read])
  async function initiate() {
    if (running.current || !online || !settings?.enabled || !settings.permissions.charge) return
    running.current = true; setBusy(true); setError('')
    try {
      let value = checkout
      if (!value) {
        if (!attempt || !terminalId) return
        value = await pointRequest(access, { command: 'prepare', operationId: prepareId.current, checkoutAttemptId: attempt.id, terminalId })
        change(value)
      }
      if (value.state === 'prepared') change(await pointRequest(access, { command: 'start', operationId: startId.current, checkoutId: value.id }))
    } catch (caught) {
      failure(caught)
      if (!checkout && caught instanceof AccountClientError && ['POINT_DISABLED', 'POINT_CONNECTION_REQUIRED', 'POINT_TERMINAL_NOT_READY', 'POINT_TERMINAL_BUSY', 'PERMISSION_DENIED', 'VALIDATION_ERROR', 'POINT_STATE_INVALID'].includes(caught.code)) { setUncertain(false); return }
      setUncertain(true)
      // Lost prepare responses are recovered from the persisted reservation, never by creating another charge.
      try {
        const recovery = await pointRequest(access, { command: 'recover' })
        const value = recovery.checkouts.find(item => item.checkout.id === attempt?.id || item.id === checkout?.id)
        if (value) change(value)
      } catch { /* Keep the conservative lock and explicit recovery action. */ }
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function cancel() {
    if (!checkout || running.current || !online) return
    running.current = true; setBusy(true); setError('')
    try { change(await pointRequest(access, { command: 'cancel', checkoutId: checkout.id })) } catch (caught) { failure(caught); setUncertain(true) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function incident() {
    if (!checkout || running.current || !online || !reason.trim()) return
    running.current = true; setBusy(true)
    try { change(await pointRequest(access, { command: 'incident', operationId: crypto.randomUUID(), checkoutId: checkout.id, reason: reason.trim() })); setReason('') } catch (caught) { failure(caught) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function recover() {
    if (running.current || !online) return
    if (checkout) { void read(); return }
    running.current = true; setBusy(true)
    try {
      const result = await pointRequest(access, { command: 'recover' })
      const found = result.checkouts.find(item => item.checkout.id === attempt?.id)
      if (found) change(found)
      else setError('Aún no hay un resultado confirmado para esta reserva. Solicita revisión antes de iniciar otro cobro.')
    } catch (caught) { failure(caught) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="point-payment ops-form" aria-label="Cobro con tarjeta integrada">
    <h3 ref={heading} tabIndex={-1}>{checkout ? pointStateLabels[checkout.state] : 'Cobrar con Mercado Pago Point'}</h3>
    <div role="status" aria-live="polite" aria-atomic="true">{checkout && <><p>{money(checkout.totalCents)} MXN</p><p>Venta: {checkout.saleState === 'materialized' ? 'registrada' : 'pendiente de registrar'}</p></>}</div>
    {!online && <p role="alert">Sin conexión. El intento sigue guardado. Conéctate para consultar su resultado.</p>}
    {error && <p role="alert">{error}</p>}
    {checkout ? <>
      <p className="text-sm">Terminal {checkout.terminal.serial} / {checkout.terminal.registerName}</p>
      <p className="text-sm">Referencia {checkout.id}</p>
      {checkout.statusDetail && <p className="text-sm">Detalle del proveedor: {checkout.statusDetail}</p>}
    </> : <label>Terminal autorizada<select value={terminalId} onChange={event => setTerminalId(event.target.value)} disabled={busy || uncertain}>
      <option value="">Selecciona una terminal</option>{available.map(terminal => <option key={terminal.id} value={terminal.id}>{terminal.serial} / {terminal.registerName}</option>)}
    </select></label>}
    {!checkout && !available.length && <p>No hay una terminal vinculada y verificada. Pide al dueño completar la configuración de Point.</p>}
    {(!checkout || checkout.state === 'prepared') && !uncertain && <button className="pos-button pos-primary" disabled={busy || !online || !settings?.enabled || !settings.permissions.charge || !checkout && (!attempt || !terminalId)} onClick={() => void initiate()}>{busy ? 'Iniciando…' : 'Iniciar cobro en terminal'}</button>}
    {(uncertain || checkout && !pointResolved(checkout.state)) && <p className="text-sm">No vuelvas a cobrar ni cambies de medio mientras el resultado siga pendiente. Cerrar esta pantalla no cancela el cargo.</p>}
    {checkout?.state === 'unknown_review' && <p>Revisa la terminal y conserva la evidencia. Una declaración del operador no verifica un pago.</p>}
    {(checkout || uncertain) && <button className="pos-button pos-secondary" disabled={busy || !online} onClick={() => void recover()}>Consultar el mismo intento</button>}
    {checkout && !pointResolved(checkout.state) && (checkout.state === 'prepared' || checkout.cancelCapability === 'backend') && <button className="pos-button pos-secondary" disabled={busy || !online} onClick={() => void cancel()}>Solicitar cancelación</button>}
    {checkout && !pointResolved(checkout.state) && checkout.cancelCapability === 'terminal' && <p>La cancelación requiere actuar en la terminal. Después consulta este mismo intento.</p>}
    {checkout?.state === 'unknown_review' && <details><summary>Registrar una incidencia</summary><div className="ops-form"><label>Evidencia y motivo<textarea value={reason} maxLength={200} onChange={event => setReason(event.target.value)} disabled={busy} /></label><button className="pos-button pos-secondary" disabled={busy || !online || !reason.trim()} onClick={() => void incident()}>Guardar incidencia para revisión</button></div></details>}
    {checkout?.sale && <SaleDetail sale={checkout.sale} />}
    {checkout && pointResolved(checkout.state) && (pointFailed(checkout.state) || checkout.saleState === 'materialized') && onDone && <button className="pos-button pos-primary" onClick={onDone}>{pointFailed(checkout.state) ? 'Volver a la cuenta' : 'Ver cuenta registrada'}</button>}
  </section>
}
