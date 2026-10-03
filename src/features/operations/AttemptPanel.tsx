import { useEffect, useState } from 'react'
import type { CheckoutAttempt } from '../../lib/operations-contracts'
import { money, priceInput } from '../../lib/pos'
import { paymentLabels } from '../../components/PosShared'
import type { OperationalMutation } from './useOperations'

export default function AttemptPanel({ attempt, mutation, onSaved, collectionAllowed = true }: { attempt: CheckoutAttempt; mutation: OperationalMutation; onSaved: (attempt: CheckoutAttempt) => void; collectionAllowed?: boolean }) {
  const [confirmed, setConfirmed] = useState(false)
  const [reason, setReason] = useState('')
  const [received, setReceived] = useState(() => priceInput(attempt.totalCents))
  const disabled = mutation.busy || Boolean(mutation.pending) || !collectionAllowed
  const refund = attempt.kind === 'reversal'
  const cashPayment = !refund && attempt.paymentMethod === 'cash'
  const matched = received.trim().replace(',', '.').match(/^(\d{1,8})(?:\.(\d{1,2}))?$/)
  const receivedCents = matched ? Number(matched[1]) * 100 + Number((matched[2] ?? '').padEnd(2, '0')) : null
  const sufficient = !cashPayment || (receivedCents !== null && receivedCents >= attempt.totalCents)
  useEffect(() => { setConfirmed(false); setReason(''); setReceived(priceInput(attempt.totalCents)) }, [attempt.id, attempt.revision])
  useEffect(() => {
    const value = mutation.lastResult?.result as CheckoutAttempt | undefined
    if (value?.id === attempt.id && ['payment', 'reversal'].includes(value.kind) && value.revision > attempt.revision) onSaved(value)
  }, [mutation.lastResult])
  async function start() {
    try { onSaved(await mutation.execute({ command: 'start_checkout', operationId: crypto.randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision })) } catch { /* Error and exact retry are shown by the shell. */ }
  }
  async function resolve(resolution: 'complete' | 'abort') {
    try { onSaved(await mutation.execute({ command: 'resolve_checkout', operationId: crypto.randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, resolution, confirmed: true, reason: reason.trim() || (resolution === 'abort' ? 'Sin movimiento de dinero confirmado' : refund ? 'Devolución externa confirmada' : 'Pago recibido y confirmado') })) } catch { /* Recovery remains visible. */ }
  }
  async function uncertain() {
    try { onSaved(await mutation.execute({ command: 'mark_checkout_uncertain', operationId: crypto.randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision })) } catch { /* Recovery remains visible. */ }
  }
  return <section className="ops-card" aria-label={refund ? 'Devolución' : 'Cobro'}>
    <h3>{refund ? 'Devolución' : 'Cobro'} · {money(attempt.totalCents)}</h3>
    <p>{paymentLabels[attempt.paymentMethod]} · {attempt.operatorName}</p>
    <p className="text-sm text-muted">Referencia {attempt.id.slice(0, 8).toUpperCase()}</p>
    {attempt.reason && <p>{attempt.reason}</p>}
    {!collectionAllowed && !['completed', 'aborted'].includes(attempt.status) && <p role="status">Abre o reanuda el turno en Caja antes de mover dinero.</p>}
    {attempt.status === 'prepared' ? <>
      <p>El importe está guardado. {refund ? 'Inicia la devolución cuando estés listo.' : 'Inicia el cobro cuando estés listo.'}</p>
      <button className="pos-button pos-primary" disabled={disabled} onClick={() => void start()}>{refund ? 'Iniciar devolución' : 'Iniciar cobro'}</button>
      <button className="pos-button pos-secondary" disabled={disabled} onClick={() => void resolve('abort')}>Cancelar sin mover dinero</button>
    </> : ['collection_started', 'uncertain'].includes(attempt.status) ? <>
      {attempt.status === 'uncertain' ? <p role="status">Resultado incierto. Comprueba el movimiento original antes de resolver. Conserva esta referencia.</p> : <p>{refund ? `Devuelve ${money(attempt.totalCents)} por ${paymentLabels[attempt.paymentMethod].toLocaleLowerCase('es')}.` : attempt.paymentMethod === 'card_external' ? `Cobra ${money(attempt.totalCents)} en tu terminal externa.` : attempt.paymentMethod === 'transfer' ? `Verifica la recepción de ${money(attempt.totalCents)} en tu cuenta.` : `Recibe ${money(attempt.totalCents)} en efectivo y entrega el cambio correspondiente.`}</p>}
      <p className="text-sm text-muted">No repitas el movimiento si ya pudo ocurrir. Resuelve este mismo intento.</p>
      {cashPayment && <><label>Efectivo recibido<input inputMode="decimal" value={received} onChange={e => setReceived(e.target.value)} disabled={disabled} /></label><p>Cambio: {receivedCents !== null && receivedCents >= attempt.totalCents ? money(receivedCents - attempt.totalCents) : 'Revisa el efectivo recibido'}</p></>}
      <label className="ops-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={disabled} /><span>He comprobado si {refund ? 'se entregó la devolución' : 'se recibió el pago'}.</span></label>
      <label>Motivo o referencia<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={disabled} /></label>
      <button className="pos-button pos-primary" disabled={disabled || !confirmed || !sufficient} onClick={() => void resolve('complete')}>{refund ? 'Confirmar devolución entregada' : 'Confirmar pago recibido'}</button>
      <button className="pos-button pos-secondary" disabled={disabled || !confirmed || !reason.trim()} onClick={() => void resolve('abort')}>Confirmar que no hubo movimiento</button>
      {attempt.status !== 'uncertain' && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => void uncertain()}>Dejar pendiente de verificar</button>}
    </> : <p role="status">{attempt.status === 'completed' ? refund ? 'Devolución registrada.' : 'Pago registrado.' : 'Intento cancelado sin movimiento de dinero.'}{attempt.resolverName ? ` Resolvió: ${attempt.resolverName}.` : ''}</p>}
  </section>
}
