import { useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { PointCheckout } from '../lib/point-contracts'
import { pointRequest, pointStateLabels } from '../lib/point-client'
import { money, priceInput, type PosAccess } from '../lib/pos'
import { parseOperationalMoney } from '../lib/operational-money'
import { accessErrorCodes } from './useCatalog'
import LoadingPlaceholder from './LoadingPlaceholder'

type Props = { access: PosAccess; saleId: string; onSessionError?: (error: AccountClientError) => void }
export default function PointRefund(props: Props) {
  return <PointRefundSession key={`${props.access.businessId}:${props.access.operatorToken}:${props.access.deviceToken ?? ''}:${props.saleId}`} {...props} />
}
function PointRefundSession({ access, saleId, onSessionError }: Props) {
  const [checkout, setCheckout] = useState<PointCheckout | null>(null), [amount, setAmount] = useState(''), [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [online, setOnline] = useState(navigator.onLine)
  const alive = useRef(true), running = useRef(false), loadSequence = useRef(0)
  const command = useRef<{ operationId: string; checkoutId: string; amountCents: number; merchandiseCents: number; tipCents: number; reason: string } | null>(null)
  function failure(caught: unknown) {
    if (!alive.current) return
    setError(caught instanceof Error ? caught.message : 'La devolución sigue pendiente de verificar.')
    if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught)
  }
  function change(value: PointCheckout) {
    if (!alive.current) return
    setCheckout(value)
    const ownRequest = command.current && value.refundRequests.find(request => request.operationId === command.current!.operationId)
    // Aggregate refunded money can belong to a different operator or a provider-side refund.
    if (ownRequest && ['confirmed', 'rejected'].includes(ownRequest.status)) {
      command.current = null; setUncertain(false); setReason(''); setAmount(priceInput(value.totalCents - value.refundedCents))
      setError(ownRequest.status === 'rejected' ? 'La devolución fue rechazada.' : '')
    }
  }
  useEffect(() => {
    alive.current = true
    const request = ++loadSequence.current
    const connected = () => setOnline(navigator.onLine)
    window.addEventListener('online', connected); window.addEventListener('offline', connected)
    void pointRequest(access, { command: 'refund_context', saleId }).then(value => {
      if (alive.current && request === loadSequence.current) { change(value); setAmount(priceInput(value.totalCents - value.refundedCents)) }
    }).catch(caught => { if (request === loadSequence.current) failure(caught) })
    return () => { alive.current = false; loadSequence.current += 1; window.removeEventListener('online', connected); window.removeEventListener('offline', connected) }
  }, [])
  const cents = parseOperationalMoney(amount), remaining = checkout ? checkout.totalCents - checkout.refundedCents : 0
  const pending = checkout?.refundRequests.filter(request => request.status === 'pending' || request.status === 'unknown_review') ?? []
  const awaiting = uncertain || pending.length > 0
  async function refund() {
    if (!checkout || running.current || !navigator.onLine || !command.current && (pending.length > 0 || cents === null || cents <= 0 || cents > remaining || !reason.trim())) return
    if (!command.current) command.current = { operationId: crypto.randomUUID(), checkoutId: checkout.id, amountCents: cents!, merchandiseCents: cents!, tipCents: 0, reason: reason.trim() }
    running.current = true; setBusy(true); setError('')
    try {
      const result = await pointRequest(access, { command: 'refund', ...command.current })
      if (!alive.current) return
      setUncertain(true); change(result)
      // UUID replay returns the accepted snapshot; read the current request status separately.
      if (alive.current) change(await pointRequest(access, { command: 'refund_context', saleId }))
    } catch (caught) {
      if (!alive.current) return
      failure(caught)
      if (caught instanceof AccountClientError && ['POINT_REFUND_LIMIT', 'POINT_STATE_INVALID', 'POINT_REFUND_ALLOCATION_REQUIRED', 'POINT_RESULT_UNCERTAIN', 'VALIDATION_ERROR'].includes(caught.code)) {
        command.current = null; setUncertain(false)
        try { change(await pointRequest(access, { command: 'refund_context', saleId })) } catch { /* The original error remains visible. */ }
      } else setUncertain(Boolean(command.current))
    }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function consult() {
    if (running.current || !navigator.onLine) return
    running.current = true; setBusy(true)
    try {
      const result = await pointRequest(access, { command: 'refund_context', saleId })
      if (alive.current) { change(result); if (!checkout) setAmount(priceInput(result.totalCents - result.refundedCents)) }
    } catch (caught) { failure(caught) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="ops-form mt-6" aria-label="Devolución bancaria integrada"><h3>Devolución de tarjeta integrada</h3>
    {error && <p role="alert">{error}</p>}
    {!online && <p role="status">Sin conexión. La devolución permanece guardada.</p>}
    {!checkout && !error && <LoadingPlaceholder variant="form" rows={2} label="Cargando devolución" />}
    {checkout && <><p role="status">{pointStateLabels[checkout.state]}. Devuelto: {money(checkout.refundedCents)}. Disponible: {money(remaining)}.</p>
      {pending.length > 0 && <p role="status">Devolución pendiente: {money(pending.reduce((sum, request) => sum + request.amountCents, 0))}. Consulta el resultado antes de solicitar otra.</p>}
      {(remaining > 0 || command.current) && <><label>Importe a devolver MXN<input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)} disabled={busy || awaiting} /></label><label>Motivo<input value={reason} maxLength={160} onChange={event => setReason(event.target.value)} disabled={busy || awaiting} /></label>
      {(!pending.length || command.current) && <button className="pos-button pos-primary" disabled={busy || !online || !command.current && (cents === null || cents <= 0 || cents > remaining || !reason.trim())} onClick={() => void refund()}>{command.current ? 'Reintentar la misma devolución' : cents === remaining ? 'Solicitar devolución total' : 'Solicitar devolución parcial'}</button>}</>}
      {uncertain && !pending.length && <p role="status">Resultado pendiente. El reintento conserva la misma solicitud.</p>}
    </>}
    <button className="pos-button pos-secondary" disabled={busy || !online} onClick={() => void consult()}>{checkout ? 'Consultar devolución' : 'Reintentar'}</button>
  </section>
}
