import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, Clock3, CreditCard, X } from 'lucide-react'
import { AccountClientError } from '../lib/account'
import type { CheckoutAttempt } from '../lib/operations-contracts'
import type { PointCheckout, PointSettings } from '../lib/point-contracts'
import { pointFailed, pointRequest, pointResolved, pointStateLabels } from '../lib/point-client'
import { money, type PosAccess } from '../lib/pos'
import { SaleDetail } from './PosShared'
import { accessErrorCodes } from './useCatalog'
import { PendingIndicator } from './LoadingPlaceholder'
import './point-payment.css'

function matchesQuote(expected: CheckoutAttempt | null | undefined, returned: CheckoutAttempt) {
  if (!expected) return true
  const signature = (value: CheckoutAttempt) => JSON.stringify([value.id, value.revision, value.orderId, value.paymentMethod, value.totalCents, value.discountCents, value.taxCents,
    value.items.map(item => [item.lineId, item.productId, item.quantity, item.unitPriceCents, item.discountCents, item.totalCents, item.taxCents]).sort((first, second) => String(first[0]).localeCompare(String(second[0])))])
  return expected.status === 'prepared' && signature(expected) === signature(returned)
}

export default function PointPayment(props: Parameters<typeof PointPaymentSession>[0]) {
  const { access, attempt, initialCheckout } = props
  return <PointPaymentSession key={`${access.businessId}:${access.operatorToken}:${access.deviceToken ?? ''}:${attempt?.id ?? initialCheckout?.id ?? ''}`} {...props} />
}

function PointPaymentSession({ access, attempt, initialCheckout, settings, onSessionError, onBlocked, onResolved, onDone, collectionAllowed = true, canStart = true }: {
  access: PosAccess; attempt?: CheckoutAttempt | null; initialCheckout?: PointCheckout; settings: PointSettings | null
  onSessionError?: (error: AccountClientError) => void; onBlocked?: (blocked: boolean) => void
  onResolved?: (checkout: PointCheckout) => void; onDone?: (checkout: PointCheckout) => void; collectionAllowed?: boolean; canStart?: boolean
}) {
  const [checkout, setCheckout] = useState<PointCheckout | null>(initialCheckout ?? null)
  const [terminalId, setTerminalId] = useState(initialCheckout?.terminal.id ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reason, setReason] = useState('')
  const [uncertain, setUncertain] = useState(false), [online, setOnline] = useState(navigator.onLine)
  const [simulation, setSimulation] = useState<'processed' | 'failed' | 'canceled' | 'expired' | 'action_required'>('processed')
  const [simulationPending, setSimulationPending] = useState(false)
  const alive = useRef(true), running = useRef(false), prepareId = useRef(crypto.randomUUID()), startId = useRef(crypto.randomUUID())
  const resolved = useRef('')
  const latestAttempt = useRef(attempt); latestAttempt.current = attempt
  const changedReservation = Boolean(checkout?.state === 'prepared' && !matchesQuote(attempt, checkout.checkout))
  const startAllowed = useRef(false); startAllowed.current = collectionAllowed && canStart && Boolean(settings?.enabled && settings.permissions.charge)
  const heading = useRef<HTMLHeadingElement>(null)
  const available = settings?.terminals.filter(t => t.active && t.verified && t.mode === 'PDV' && !t.physicalStepsPending) ?? []
  const blocked = busy || uncertain || Boolean(checkout && (!pointResolved(checkout.state) || checkout.saleState !== 'materialized' && !pointFailed(checkout.state)))
  const change = useCallback((value: PointCheckout) => { if (alive.current) { setCheckout(previous => previous?.id === value.id && previous.updatedAt > value.updatedAt ? previous : value); setUncertain(false); setError('') } }, [])
  useEffect(() => { if (initialCheckout) setCheckout(previous => !previous || initialCheckout.id === previous.id && initialCheckout.updatedAt > previous.updatedAt ? initialCheckout : previous) }, [initialCheckout])
  useEffect(() => { alive.current = true; const connected = () => setOnline(navigator.onLine); window.addEventListener('online', connected); window.addEventListener('offline', connected); heading.current?.focus(); return () => { alive.current = false; window.removeEventListener('online', connected); window.removeEventListener('offline', connected); onBlocked?.(false) } }, [])
  useEffect(() => { onBlocked?.(blocked) }, [blocked, onBlocked])
  useEffect(() => { setSimulationPending(false) }, [checkout?.state])
  useEffect(() => {
    if (checkout || uncertain || busy) return
    if (!available.some(terminal => terminal.id === terminalId)) setTerminalId(available[0]?.id ?? '')
  }, [available, terminalId, checkout, uncertain, busy])
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
    if (running.current || !navigator.onLine || !startAllowed.current) return
    running.current = true; setBusy(true); setError('')
    try {
      let value = checkout
      if (!value) {
        if (!attempt || !available.some(terminal => terminal.id === terminalId)) return
        value = await pointRequest(access, { command: 'prepare', operationId: prepareId.current, checkoutAttemptId: attempt.id, terminalId })
        if (!alive.current) return
        change(value)
      }
      if (!matchesQuote(latestAttempt.current, value.checkout)) { setError('La reserva cambió. Revisa el importe actualizado o cancela este intento.'); return }
      if (alive.current && startAllowed.current && value.state === 'prepared') change(await pointRequest(access, { command: 'start', operationId: startId.current, checkoutId: value.id }))
    } catch (caught) {
      if (!alive.current) return
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
    try { change(await pointRequest(access, { command: 'cancel', checkoutId: checkout.id })) } catch (caught) { if (alive.current) { failure(caught); setUncertain(true) } }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function incident() {
    if (!checkout || running.current || !online || !reason.trim()) return
    running.current = true; setBusy(true)
    try { change(await pointRequest(access, { command: 'incident', operationId: crypto.randomUUID(), checkoutId: checkout.id, reason: reason.trim() })); if (alive.current) setReason('') } catch (caught) { failure(caught) }
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
      else if (alive.current) setError('Aún no hay un resultado confirmado para esta reserva. Solicita revisión antes de iniciar otro cobro.')
    } catch (caught) { failure(caught) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function simulate() {
    if (!checkout?.remoteOrderId || running.current || !navigator.onLine || !settings?.sandbox?.testBusiness || !settings.permissions.manage) return
    running.current = true; setBusy(true); setError('')
    try {
      await pointRequest(access, { command: 'simulate', checkoutId: checkout.id, status: simulation })
      // The provider only accepts an event here. Polling/worker must independently
      // verify the order and materialize its original snapshot before showing success.
      if (alive.current) setSimulationPending(true)
    } catch (caught) { failure(caught) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const ready = !checkout || checkout.state === 'prepared'
  const finished = Boolean(checkout && pointResolved(checkout.state) && (pointFailed(checkout.state) || checkout.saleState === 'materialized'))
  const failed = Boolean(checkout && pointFailed(checkout.state))
  const approved = Boolean(checkout && !failed && finished)
  const reviewing = uncertain || checkout?.state === 'unknown_review'
  const selectedTerminal = checkout?.terminal ?? available.find(terminal => terminal.id === terminalId)
  const totalCents = checkout?.totalCents ?? attempt?.totalCents
  const sandbox = settings?.connection?.environment === 'sandbox'
  const StatusIcon = reviewing ? CircleAlert : approved ? Check : failed ? X : ready ? CreditCard : Clock3
  const statusTitle = reviewing ? 'Pago por confirmar' : checkout ? pointStateLabels[checkout.state] : 'Mercado Pago'
  const statusDescription = reviewing ? 'Consulta este cobro antes de intentar otro.'
    : approved ? 'El pago quedó registrado.'
    : failed ? 'Vuelve a la cuenta para elegir cómo cobrar.'
    : checkout?.state === 'approved_verified' ? 'Guardando el pago en tu cuenta.'
    : checkout?.state === 'processing' ? 'El cliente está pagando en la terminal.'
    : checkout?.state === 'pending' ? 'El cobro está en camino a la terminal.'
    : checkout && !ready ? 'El cliente puede acercar o insertar su tarjeta.'
    : sandbox ? 'Envía el importe a la terminal de prueba.' : 'El importe se enviará a la terminal seleccionada.'
  return <section className="point-payment" aria-label="Cobro con Mercado Pago">
    <div className="point-payment-heading">
      <span className="point-payment-mark">{busy && !ready ? <PendingIndicator label="Actualizando el cobro" size={22} /> : <StatusIcon size={22} strokeWidth={1.6} aria-hidden="true" />}</span>
      <div className="point-payment-title" role="status" aria-live="polite" aria-atomic="true"><h3 ref={heading} tabIndex={-1}>{statusTitle}</h3><p>{statusDescription}</p></div>
      {sandbox && <span className="point-payment-sandbox">Modo prueba</span>}
    </div>
    {!ready && totalCents !== undefined && <p className="point-payment-amount">{money(totalCents)}<span>MXN</span></p>}
    {!online && <p className="point-payment-message" role="alert">Sin conexión. El cobro sigue guardado; podrás consultarlo al reconectar.</p>}
    {error && <p className="point-payment-message is-error" role="alert">{error}</p>}
    {!checkout && available.length > 1 ? <label className="point-payment-terminal-select">Enviar a<select value={terminalId} onChange={event => setTerminalId(event.target.value)} disabled={busy || uncertain}>
      <option value="">Selecciona una terminal</option>{available.map(terminal => <option key={terminal.id} value={terminal.id}>{terminal.registerName} · {terminal.serial}</option>)}
    </select></label> : selectedTerminal && <div className="point-payment-terminal"><CreditCard size={18} aria-hidden="true" /><span><strong>{selectedTerminal.registerName}</strong><small>{selectedTerminal.serial}</small></span></div>}
    {!checkout && !available.length && <p className="point-payment-message">No hay terminales listas. El dueño puede añadir una en Vincular una terminal.</p>}
    {changedReservation && <p className="point-payment-message" role="status">La cuenta cambió. Cancela este intento para usar el importe actualizado.</p>}
    {ready && !uncertain && <button type="button" className="pos-button pos-primary point-payment-send" aria-busy={busy} disabled={busy || !online || changedReservation || !collectionAllowed || !canStart || !settings?.enabled || !settings.permissions.charge || !checkout && (!attempt || !available.some(terminal => terminal.id === terminalId))} onClick={() => void initiate()}>{busy && <PendingIndicator label="Enviando el cobro" />}<span>Enviar a terminal</span>{totalCents !== undefined && <strong>{money(totalCents)}</strong>}</button>}
    {!finished && (uncertain || checkout && !ready) && <p className="point-payment-hint">Cerrar esta pantalla no cancela el cobro.</p>}
    {sandbox && settings?.sandbox?.official && settings.sandbox.testBusiness && settings.permissions.manage && !access.deviceToken && checkout?.remoteOrderId && !pointResolved(checkout.state) && <div className="point-payment-simulator">
      <label>Simulador de Mercado Pago<select aria-label="Resultado de prueba" value={simulation} disabled={busy || simulationPending} onChange={event => setSimulation(event.target.value as typeof simulation)}><option value="processed">Aprobar pago</option><option value="failed">Rechazar pago</option><option value="canceled">Cancelar pago</option><option value="expired">Expirar cobro</option><option value="action_required">Requiere revisión</option></select></label>
      <button type="button" className="pos-button pos-secondary" disabled={busy || !online || simulationPending} onClick={() => void simulate()}>{busy && <PendingIndicator label="Solicitando simulación" />}{simulationPending ? 'Resultado solicitado' : 'Simular resultado'}</button>
      {simulationPending && <p className="point-payment-hint" role="status">Mercado Pago está procesando la prueba. El resultado se confirmará automáticamente.</p>}
    </div>}
    {(checkout || uncertain) && !finished && <div className="point-payment-actions"><button type="button" disabled={busy || !online} onClick={() => void recover()}>Consultar estado</button>
      {checkout && !pointResolved(checkout.state) && (checkout.state === 'prepared' || checkout.cancelCapability === 'backend') && <button type="button" disabled={busy || !online} onClick={() => void cancel()}>Cancelar cobro</button>}
    </div>}
    {checkout && !pointResolved(checkout.state) && checkout.cancelCapability === 'terminal' && <p className="point-payment-hint">Para cancelar, usa la terminal y consulta el estado aquí.</p>}
    {checkout?.state === 'unknown_review' && <details className="point-payment-details"><summary>Solicitar revisión</summary><div className="point-payment-incident"><label>¿Qué ocurrió?<textarea value={reason} maxLength={200} onChange={event => setReason(event.target.value)} disabled={busy} /></label><button type="button" className="pos-button pos-secondary" disabled={busy || !online || !reason.trim()} onClick={() => void incident()}>Guardar incidencia</button></div></details>}
    {checkout && finished && onDone && <button type="button" className="pos-button pos-primary" onClick={() => onDone(checkout)}>{failed ? 'Volver a la cuenta' : 'Continuar'}</button>}
    {checkout?.sale && <details className="point-payment-details"><summary>Ver recibo</summary><SaleDetail sale={checkout.sale} /></details>}
    {checkout && <details className="point-payment-details"><summary>Referencia del cobro</summary><dl><div><dt>Referencia</dt><dd>{checkout.id}</dd></div>{checkout.remoteOrderId && <div><dt>Mercado Pago</dt><dd>{checkout.remoteOrderId}</dd></div>}{checkout.statusDetail && <div><dt>Detalle</dt><dd>{checkout.statusDetail}</dd></div>}</dl></details>}
  </section>
}
