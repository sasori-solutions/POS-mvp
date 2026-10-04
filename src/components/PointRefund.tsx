import { useEffect, useRef, useState } from 'react'
import { AccountClientError } from '../lib/account'
import type { PointCheckout } from '../lib/point-contracts'
import { pointRequest, pointStateLabels } from '../lib/point-client'
import { money, priceInput, type PosAccess } from '../lib/pos'
import { parseOperationalMoney } from '../lib/operational-money'
import { accessErrorCodes } from './useCatalog'

export default function PointRefund({ access, saleId, onSessionError }: { access: PosAccess; saleId: string; onSessionError?: (error: AccountClientError) => void }) {
  const [checkout, setCheckout] = useState<PointCheckout | null>(null), [amount, setAmount] = useState(''), [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false)
  const alive = useRef(true), running = useRef(false), command = useRef<{ operationId: string; checkoutId: string; amountCents: number; merchandiseCents: number; tipCents: number; reason: string } | null>(null)
  const expectedRefunded = useRef(0)
  function failure(caught: unknown) { if (!alive.current) return; setError(caught instanceof Error ? caught.message : 'La devolución sigue pendiente de verificar.'); if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught) }
  useEffect(() => {
    alive.current = true
    void pointRequest(access, { command: 'refund_context', saleId }).then(value => { if (alive.current) { setCheckout(value); setAmount(priceInput(value.totalCents - value.refundedCents)) } }).catch(failure)
    return () => { alive.current = false }
  }, [saleId])
  const cents = parseOperationalMoney(amount), remaining = checkout ? checkout.totalCents - checkout.refundedCents : 0
  async function refund() {
    if (!checkout || running.current || cents === null || cents <= 0 || cents > remaining || !reason.trim()) return
    // Existing sales have no tip component. Allocation is evidenced by the immutable merchandise snapshot.
    if (!command.current) { command.current = { operationId: crypto.randomUUID(), checkoutId: checkout.id, amountCents: cents, merchandiseCents: cents, tipCents: 0, reason: reason.trim() }; expectedRefunded.current = checkout.refundedCents + cents }
    running.current = true; setBusy(true); setError('')
    try {
      const result = await pointRequest(access, { command: 'refund', ...command.current })
      if (alive.current) { setCheckout(result); const confirmed = result.refundedCents >= expectedRefunded.current; setUncertain(!confirmed); if (confirmed) { command.current = null; setReason(''); setAmount(priceInput(result.totalCents - result.refundedCents)) } }
    } catch (caught) { failure(caught); setUncertain(true) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function consult() {
    if (!checkout || running.current) return
    running.current = true; setBusy(true)
    try { const result = await pointRequest(access, { command: 'status', checkoutId: checkout.id }); if (alive.current) { setCheckout(result); if (command.current && result.refundedCents >= expectedRefunded.current) { command.current = null; setUncertain(false); setError(''); setReason(''); setAmount(priceInput(result.totalCents - result.refundedCents)) } } } catch (caught) { failure(caught) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="ops-form mt-6" aria-label="Devolución bancaria integrada"><h3>Devolución de tarjeta integrada</h3>
    <p>La venta original permanece intacta. La devolución bancaria no repone inventario.</p>
    {error && <p role="alert">{error}</p>}
    {checkout && <><p role="status">{pointStateLabels[checkout.state]}. Confirmado devuelto: {money(checkout.refundedCents)}. Saldo reembolsable: {money(remaining)}.</p>
      {remaining > 0 && <><label>Importe a devolver MXN<input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)} disabled={busy || uncertain} /></label><label>Motivo<input value={reason} maxLength={160} onChange={event => setReason(event.target.value)} disabled={busy || uncertain} /></label>
      <button className="pos-button pos-primary" disabled={busy || cents === null || cents <= 0 || cents > remaining || !reason.trim()} onClick={() => void refund()}>{uncertain ? 'Reintentar la misma devolución' : cents === remaining ? 'Solicitar devolución total' : 'Solicitar devolución parcial'}</button></>}
      {uncertain && <p>No solicites otra devolución. Conserva este importe y referencia hasta verificar el resultado remoto.</p>}
      <button className="pos-button pos-secondary" disabled={busy} onClick={() => void consult()}>Consultar devolución</button>
    </>}
  </section>
}
