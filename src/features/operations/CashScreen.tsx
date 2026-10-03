import { useEffect, useState } from 'react'
import type { BusinessContext } from '../../lib/contracts'
import { hasPermission } from '../../lib/business-access'
import type { CashShift, CheckoutAttempt, OperationsSnapshot } from '../../lib/operations-contracts'
import { money, posRequest, type PosAccess } from '../../lib/pos'
import MoneyInput from '../../components/MoneyInput'
import AttemptPanel from './AttemptPanel'
import type { OperationalMutation } from './useOperations'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'
import { maxOperationalMoneyCents, parseOperationalMoney } from '../../lib/operational-money'
import { useCurrentAttempt } from './useCurrentAttempt'

export default function CashScreen({ business, access, snapshot, mutation, refresh, onSessionError }: { business: BusinessContext; access: PosAccess; snapshot: OperationsSnapshot; mutation: OperationalMutation; refresh: () => Promise<void>; onSessionError?: (error: AccountClientError) => void }) {
  const [opening, setOpening] = useState('')
  const [counted, setCounted] = useState('')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<'in' | 'out'>('out')
  const [reason, setReason] = useState('')
  const [cutover, setCutover] = useState(false)
  const [history, setHistory] = useState<CashShift[]>([])
  const [historyError, setHistoryError] = useState('')
  const [result, setResult] = useState<CashShift | null>(null)
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null)
  const current = useCurrentAttempt(access, attempt, snapshot.attempts, onSessionError)
  const shift = snapshot.shift
  const disabled = mutation.busy || Boolean(mutation.pending)
  const allowed = (key: Parameters<typeof hasPermission>[1]) => hasPermission(business, key)
  useEffect(() => { setCounted('') }, [shift?.id, shift?.status])
  useEffect(() => {
    let alive = true
    if (snapshot.enabled && allowed('cash.read')) void posRequest(access, { command: 'shifts' }).then(r => { if (alive) { setHistory(r.shifts); setHistoryError('') } }).catch(e => { if (alive) { setHistoryError(e instanceof Error ? e.message : 'No pudimos cargar los turnos.'); if (e instanceof AccountClientError && accessErrorCodes.includes(e.code)) onSessionError?.(e) } })
    return () => { alive = false }
  }, [snapshot, access.operatorToken])
  async function open() { const cents = parseOperationalMoney(opening); if (cents === null) return; try { await mutation.execute({ command: 'open_shift', operationId: crypto.randomUUID(), openingCents: cents }); setOpening(''); setResult(null); await refresh() } catch { /* Shell recovery. */ } }
  async function movement() { const cents = parseOperationalMoney(amount); if (!shift || cents === null || cents === 0 || !reason.trim()) return; try { await mutation.execute({ command: 'cash_movement', operationId: crypto.randomUUID(), shiftId: shift.id, expectedRevision: shift.revision, kind, amountCents: cents, reason: reason.trim() }); setAmount(''); setReason(''); await refresh() } catch { /* Shell recovery. */ } }
  async function close() { const cents = parseOperationalMoney(counted); if (!shift || cents === null) return; try { setResult(await mutation.execute({ command: 'close_shift', operationId: crypto.randomUUID(), shiftId: shift.id, expectedRevision: shift.revision, countedCents: cents })); await refresh() } catch { /* Shell recovery. */ } }
  async function transition(command: 'begin_shift_close' | 'abort_shift_close') {
    if (!shift) return
    try { if (command === 'begin_shift_close') await mutation.execute({ command, operationId: crypto.randomUUID(), shiftId: shift.id, expectedRevision: shift.revision }); else await mutation.execute({ command, operationId: crypto.randomUUID(), shiftId: shift.id, expectedRevision: shift.revision }); await refresh() } catch { /* Shell recovery. */ }
  }
  return <div className="ops-section">
    {!snapshot.enabled ? <section className="ops-card">
      <h2>Activar turnos compartidos</h2><p>Antes de activar, actualiza las PWAs abiertas, confirma las ventas pendientes y cuenta el efectivo inicial. Después, cada cobro necesita un turno abierto.</p>
      {business.role === 'owner' ? <><label className="ops-check"><input type="checkbox" checked={cutover} onChange={e => setCutover(e.target.checked)} /><span>Los dispositivos están actualizados y los registros pendientes están conciliados.</span></label><button className="pos-button pos-primary" disabled={disabled || !cutover} onClick={() => { void (async () => { try { await mutation.execute({ command: 'activate_operations', operationId: crypto.randomUUID() }); await refresh() } catch { /* Shell recovery. */ } })() }}>Activar turnos</button></> : <p>El dueño debe completar esta activación.</p>}
    </section> : !shift ? <section className="ops-card"><h2>Sin turno abierto</h2><p>Los pedidos pendientes se conservan. El nuevo turno recibe los pagos que registres ahora.</p>{allowed('cash.open') && <><label>Efectivo inicial<MoneyInput maxCents={maxOperationalMoneyCents} value={opening} onValueChange={setOpening} disabled={disabled} /></label><button className="pos-button pos-primary" disabled={disabled || parseOperationalMoney(opening) === null} onClick={() => void open()}>Abrir turno</button></>}</section> : <section className="ops-card">
      <h2>{shift.status === 'closing' ? 'Contar efectivo' : 'Turno abierto'}</h2><p>Abrió {shift.openedBy} · {money(shift.openingCents)} iniciales</p>
      {shift.status === 'closing' ? <><p>Los cobros, devoluciones y movimientos están detenidos. Puedes seguir editando pedidos. Guarda el conteo para conocer la diferencia.</p>{allowed('cash.close') && <><label>Efectivo contado<MoneyInput maxCents={maxOperationalMoneyCents} value={counted} onValueChange={setCounted} disabled={disabled} /></label><button className="pos-button pos-primary" disabled={disabled || parseOperationalMoney(counted) === null} onClick={() => void close()}>Guardar conteo y cerrar</button><button className="pos-button pos-secondary" disabled={disabled} onClick={() => void transition('abort_shift_close')}>Cancelar cierre y reanudar turno</button></>}</> : <>
        {allowed('cash.move') && <details><summary>Entrada o retiro de efectivo</summary><div className="ops-form"><label>Movimiento<select value={kind} onChange={e => setKind(e.target.value as 'in' | 'out')} disabled={disabled}><option value="out">Retiro</option><option value="in">Entrada</option></select></label><label>Importe<MoneyInput maxCents={maxOperationalMoneyCents} value={amount} onValueChange={setAmount} disabled={disabled} /></label><label>Motivo<input value={reason} maxLength={160} onChange={e => setReason(e.target.value)} disabled={disabled} /></label><button className="pos-button pos-primary" disabled={disabled || !reason.trim() || !parseOperationalMoney(amount)} onClick={() => void movement()}>Guardar movimiento</button></div></details>}
        {allowed('cash.close') && <button className="pos-button pos-primary" disabled={disabled} onClick={() => void transition('begin_shift_close')}>Detener caja e iniciar conteo</button>}
      </>}
      {shift.movements.length > 0 && <ul className="ops-list">{shift.movements.map(m => <li key={m.id}><span>{m.kind === 'in' ? 'Entrada' : 'Retiro'} · {m.reason}<small>{m.actorName}</small></span><strong>{money(m.amountCents)}</strong></li>)}</ul>}
    </section>}
    {result?.status === 'closed' && <section className="ops-card" role="status"><h2>Turno cerrado</h2><dl className="ops-totals"><div><dt>Esperado</dt><dd>{money(result.expectedCents ?? 0)}</dd></div><div><dt>Contado</dt><dd>{money(result.countedCents ?? 0)}</dd></div><div><dt>Diferencia</dt><dd>{money(result.differenceCents ?? 0)}</dd></div></dl></section>}
    {snapshot.attempts.length > 0 && <section className="ops-card"><h2>Cobros y devoluciones pendientes</h2><p>Comprueba el movimiento original y resuelve cada intento antes de cerrar.</p><ul className="ops-list">{snapshot.attempts.map(a => <li key={a.id}><button className="ops-row" onClick={() => setAttempt(a)}>{a.kind === 'reversal' ? 'Devolución' : 'Cobro'} · {money(a.totalCents)} · {a.operatorName}<small>{a.status === 'prepared' ? 'Sin iniciar' : 'Por verificar'}</small></button></li>)}</ul></section>}
    {current.loading && <p role="status">Consultando el estado del intento…</p>}
    {current.error && <p role="alert">{current.error}<button className="pos-button pos-secondary" onClick={current.retry}>Reintentar consulta</button></p>}
    {current.attempt && <AttemptPanel attempt={current.attempt} mutation={{ ...mutation, busy: mutation.busy || current.blocked }} collectionAllowed={shift?.status === 'open'} onSaved={a => { setAttempt(a); void refresh() }} />}
    {allowed('cash.read') && <section className="ops-card"><h2>Turnos anteriores</h2>{historyError && <p role="alert">{historyError}</p>}<ul className="ops-list">{history.filter(s => s.status === 'closed').map(s => <li key={s.id}><span>{new Intl.DateTimeFormat('es-MX', { dateStyle: 'short', timeStyle: 'short', timeZone: business.timezone }).format(new Date(s.closedAt!))}<small>{s.closedBy}</small></span><span>Contado {money(s.countedCents ?? 0)}<small>Diferencia {money(s.differenceCents ?? 0)}</small></span></li>)}</ul></section>}
  </div>
}
