import { useEffect, useState } from 'react'
import { Check, CircleAlert, CreditCard, Landmark, Wallet } from 'lucide-react'
import type { CheckoutAttempt } from '../../lib/operations-contracts'
import { money, priceInput } from '../../lib/pos'
import { paymentLabels } from '../../components/PosShared'
import type { OperationalMutation } from './useOperations'
import MoneyInput from '../../components/MoneyInput'
import { maxOperationalMoneyCents, parseOperationalMoney } from '../../lib/operational-money'
import './operations-polish.css'

export default function AttemptPanel({ attempt, mutation, onSaved, collectionAllowed = true }: { attempt: CheckoutAttempt; mutation: OperationalMutation; onSaved: (attempt: CheckoutAttempt) => void; collectionAllowed?: boolean }) {
  const [reason, setReason] = useState('')
  const [received, setReceived] = useState(() => priceInput(attempt.totalCents))
  const disabled = mutation.busy || Boolean(mutation.pending) || !collectionAllowed
  const refund = attempt.kind === 'reversal'
  const cashPayment = !refund && attempt.paymentMethod === 'cash'
  const receivedCents = parseOperationalMoney(received)
  const sufficient = !cashPayment || (receivedCents !== null && receivedCents >= attempt.totalCents)
  useEffect(() => { setReason(''); setReceived(priceInput(attempt.totalCents)) }, [attempt.id, attempt.revision])
  useEffect(() => {
    const value = mutation.lastResult?.result as CheckoutAttempt | undefined
    if (value?.id === attempt.id && ['payment', 'reversal'].includes(value.kind) && value.revision > attempt.revision) onSaved(value)
  }, [mutation.lastResult])
  async function start() {
    try { onSaved(await mutation.execute({ command: 'start_checkout', operationId: crypto.randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision })) } catch { /* Error and exact retry are shown by the shell. */ }
  }
  async function resolve(resolution: 'complete' | 'abort') {
    try { onSaved(await mutation.execute({ command: 'resolve_checkout', operationId: crypto.randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision, resolution, confirmed: true, reason: reason.trim() || (resolution === 'abort' ? 'Cancelación de intento' : refund ? 'Registro de devolución' : 'Registro de pago') })) } catch { /* Recovery remains visible. */ }
  }
  async function uncertain() {
    try { onSaved(await mutation.execute({ command: 'mark_checkout_uncertain', operationId: crypto.randomUUID(), attemptId: attempt.id, expectedRevision: attempt.revision })) } catch { /* Recovery remains visible. */ }
  }
  return <section className="ops-card operations-polish attempt-panel" aria-label={refund ? 'Devolución' : 'Cobro'}>
    <div className="attempt-heading"><div><span className="operations-caption">{refund ? 'Devolución' : 'Cobro'}</span><h3>{money(attempt.totalCents)}</h3></div><span className="operations-icon">{attempt.paymentMethod === 'cash' ? <Wallet size={22} aria-hidden="true" /> : attempt.paymentMethod === 'card_external' ? <CreditCard size={22} aria-hidden="true" /> : <Landmark size={22} aria-hidden="true" />}</span></div>
    <div className="attempt-meta"><span>{paymentLabels[attempt.paymentMethod]} · {attempt.operatorName}</span><span>#{attempt.id.slice(0, 8).toUpperCase()}</span></div>
    {attempt.reason && <p className="operations-caption">{attempt.reason}</p>}
    {!collectionAllowed && !['completed', 'aborted'].includes(attempt.status) && <p className="attempt-warning" role="status">Turno cerrado. Abre o reanuda la caja.</p>}
    {attempt.status === 'prepared' ? <>
      <button className="pos-button pos-primary" disabled={disabled} onClick={() => void start()}>{refund ? 'Iniciar devolución' : 'Iniciar cobro'}</button>
      <button className="pos-button pos-secondary" disabled={disabled} onClick={() => void resolve('abort')}>Cancelar intento</button>
    </> : ['collection_started', 'uncertain'].includes(attempt.status) ? <>
      {attempt.status === 'uncertain' ? <div className="attempt-uncertain" role="status"><CircleAlert size={20} aria-hidden="true" /><div><strong>Verifica el movimiento original</strong><p>No repitas el cobro o la devolución.</p></div></div> : !cashPayment && (refund || attempt.paymentMethod === 'card_external') && <p className="operations-caption">{refund ? `Entrega la devolución por ${paymentLabels[attempt.paymentMethod].toLocaleLowerCase('es')}.` : 'Cobra en tu terminal externa.'}</p>}
      {attempt.status !== 'uncertain' && <p className="operations-caption">Comprueba el movimiento original; no lo repitas.</p>}
      {cashPayment && <div className="attempt-cash"><label>Efectivo recibido<MoneyInput maxCents={maxOperationalMoneyCents} autoComplete="off" value={received} onValueChange={setReceived} disabled={disabled} /></label><dl><dt>Cambio</dt><dd>{receivedCents !== null && receivedCents >= attempt.totalCents ? money(receivedCents - attempt.totalCents) : '—'}</dd></dl></div>}
      <label>Motivo o referencia<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={disabled} /></label>
      <button className="pos-button pos-primary" disabled={disabled || !sufficient} onClick={() => void resolve('complete')}>{refund ? 'Registrar devolución' : 'Registrar pago'}</button>
      <div className="attempt-secondary-actions"><button className="pos-button pos-secondary" disabled={disabled || !reason.trim()} onClick={() => void resolve('abort')}>Cancelar intento</button>
      {attempt.status !== 'uncertain' && <button className="pos-button pos-secondary" disabled={disabled} onClick={() => void uncertain()}>Dejar pendiente de verificar</button>}</div>
    </> : <div className="attempt-result" role="status"><Check size={20} aria-hidden="true" /><div><strong>{attempt.status === 'completed' ? refund ? 'Devolución registrada.' : 'Pago registrado.' : 'Intento cancelado.'}</strong>{attempt.resolverName && <small>{attempt.resolverName}</small>}</div></div>}
  </section>
}
