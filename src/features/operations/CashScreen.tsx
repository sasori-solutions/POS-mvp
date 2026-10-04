import { useEffect, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, Wallet } from 'lucide-react'
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
import LoadingPlaceholder from '../../components/LoadingPlaceholder'
import './operations-polish.css'

export default function CashScreen({ business, access, snapshot, mutation, refresh, onSessionError }: { business: BusinessContext; access: PosAccess; snapshot: OperationsSnapshot; mutation: OperationalMutation; refresh: () => Promise<void>; onSessionError?: (error: AccountClientError) => void }) {
  const [opening, setOpening] = useState('')
  const [counted, setCounted] = useState('')
  const [amount, setAmount] = useState('')
  const [kind, setKind] = useState<'in' | 'out'>('out')
  const [reason, setReason] = useState('')
  const [cutover, setCutover] = useState(false)
  const [history, setHistory] = useState<CashShift[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [historyRetry, setHistoryRetry] = useState(0)
  const [historyError, setHistoryError] = useState('')
  const [result, setResult] = useState<CashShift | null>(null)
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null)
  const current = useCurrentAttempt(access, attempt, snapshot.attempts, onSessionError)
  const shift = snapshot.shift
  const disabled = mutation.busy || Boolean(mutation.pending)
  const allowed = (key: Parameters<typeof hasPermission>[1]) => hasPermission(business, key)
  const canRead = allowed('cash.read')
  const showHistory = (canRead && snapshot.enabled) || result?.status === 'closed'
  const historySequence = useRef(0)
  const dates = new Intl.DateTimeFormat('es-MX', { dateStyle: 'short', timeStyle: 'short', timeZone: business.timezone })
  const closedShifts = history.filter(s => s.status === 'closed').sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
  const lastShift = result?.status === 'closed' ? result : !shift ? closedShifts[0] : null
  const olderShifts = closedShifts.filter(s => s.id !== lastShift?.id)
  const enteredCents = shift?.movements.filter(m => m.kind === 'in').reduce((sum, m) => sum + m.amountCents, 0) ?? 0
  const withdrawnCents = shift?.movements.filter(m => m.kind === 'out').reduce((sum, m) => sum + m.amountCents, 0) ?? 0
  useEffect(() => { setCounted('') }, [shift?.id, shift?.status])
  useEffect(() => {
    const request = ++historySequence.current
    if (snapshot.enabled && canRead) void posRequest(access, { command: 'shifts' }).then(r => { if (historySequence.current === request) { setHistory(r.shifts); setHistoryLoaded(true); setHistoryError('') } }).catch(e => { if (historySequence.current === request) { setHistoryError(e instanceof Error ? e.message : 'No pudimos cargar los turnos.'); if (e instanceof AccountClientError && accessErrorCodes.includes(e.code)) onSessionError?.(e) } })
    return () => { historySequence.current++ }
  }, [snapshot, access.businessId, access.operatorToken, access.deviceToken, canRead, historyRetry])
  async function open() { const cents = parseOperationalMoney(opening); if (cents === null) return; try { await mutation.execute({ command: 'open_shift', operationId: crypto.randomUUID(), openingCents: cents }); setOpening(''); setResult(null); await refresh() } catch { /* Shell recovery. */ } }
  async function movement() { const cents = parseOperationalMoney(amount); if (!shift || cents === null || cents === 0 || !reason.trim()) return; try { await mutation.execute({ command: 'cash_movement', operationId: crypto.randomUUID(), shiftId: shift.id, expectedRevision: shift.revision, kind, amountCents: cents, reason: reason.trim() }); setAmount(''); setReason(''); await refresh() } catch { /* Shell recovery. */ } }
  async function close() { const cents = parseOperationalMoney(counted); if (!shift || cents === null) return; try { setResult(await mutation.execute({ command: 'close_shift', operationId: crypto.randomUUID(), shiftId: shift.id, expectedRevision: shift.revision, countedCents: cents })); await refresh() } catch { /* Shell recovery. */ } }
  async function transition(command: 'begin_shift_close' | 'abort_shift_close') {
    if (!shift) return
    try { if (command === 'begin_shift_close') await mutation.execute({ command, operationId: crypto.randomUUID(), shiftId: shift.id, expectedRevision: shift.revision }); else await mutation.execute({ command, operationId: crypto.randomUUID(), shiftId: shift.id, expectedRevision: shift.revision }); await refresh() } catch { /* Shell recovery. */ }
  }
  return <div className={`ops-section operations-polish cash-workspace${showHistory ? '' : ' cash-workspace-no-history'}`}>
    <div className="cash-main">
      {!snapshot.enabled ? <section className="ops-card cash-setup">
        <div className="operations-heading"><Wallet size={24} aria-hidden="true" /><h2>Activar turnos</h2></div>
        <p className="operations-caption">Cada cobro se registrará en el turno abierto.</p>
        {business.role === 'owner' ? <><label className="ops-check"><input type="checkbox" checked={cutover} disabled={disabled} onChange={e => setCutover(e.target.checked)} /><span>Dispositivos actualizados y ventas pendientes conciliadas.</span></label><button className="pos-button pos-primary" disabled={disabled || !cutover} onClick={() => { void (async () => { try { await mutation.execute({ command: 'activate_operations', operationId: crypto.randomUUID() }); await refresh() } catch { /* Shell recovery. */ } })() }}>Activar turnos</button></> : <p className="operations-caption">El dueño debe activar los turnos.</p>}
      </section> : !shift ? <section className="ops-card cash-setup">
        <div className="cash-status-heading"><span className="operations-icon"><Wallet size={24} aria-hidden="true" /></span><div><span className="operations-status">Cerrado</span><h2>Abrir turno</h2></div></div>
        {allowed('cash.open') ? <><label className="cash-money-field">Efectivo inicial<MoneyInput autoComplete="off" placeholder="$0.00" maxCents={maxOperationalMoneyCents} value={opening} onValueChange={setOpening} disabled={disabled} /></label><button className="pos-button pos-primary" disabled={disabled || parseOperationalMoney(opening) === null} onClick={() => void open()}>Abrir turno</button></> : <p className="operations-caption">Sin turno abierto.</p>}
      </section> : <>
        <section className="ops-card cash-current">
          <div className="cash-status-heading"><span className="operations-icon"><Wallet size={24} aria-hidden="true" /></span><div><span className={`operations-status ${shift.status === 'open' ? 'operations-status-active' : ''}`}>{shift.status === 'closing' ? 'En cierre' : 'Abierto'}</span><h2>{shift.status === 'closing' ? 'Conteo de caja' : 'Turno actual'}</h2><p className="operations-caption">{shift.openedBy} · {dates.format(new Date(shift.openedAt))}</p></div></div>
          <dl className="cash-metrics"><div><dt>Fondo inicial</dt><dd>{money(shift.openingCents)}</dd></div><div><dt>Entradas</dt><dd>{money(enteredCents)}</dd></div><div><dt>Retiros</dt><dd>{money(withdrawnCents)}</dd></div></dl>
          {shift.status === 'closing' ? <div className="cash-count-form">
            <p className="operations-caption">Cobros y movimientos pausados durante el conteo.</p>
            {allowed('cash.close') && <><label className="cash-money-field">Efectivo contado<MoneyInput autoComplete="off" placeholder="$0.00" maxCents={maxOperationalMoneyCents} value={counted} onValueChange={setCounted} disabled={disabled} /></label><button className="pos-button pos-primary" disabled={disabled || parseOperationalMoney(counted) === null} onClick={() => void close()}>Guardar conteo y cerrar</button><button className="pos-button pos-secondary" disabled={disabled} onClick={() => void transition('abort_shift_close')}>Cancelar cierre</button></>}
          </div> : <>
            {allowed('cash.move') && <details className="cash-movement-form"><summary><span>Registrar movimiento</span><ChevronDown size={18} aria-hidden="true" /></summary><div className="ops-form"><div className="operations-segments" role="group" aria-label="Movimiento"><button type="button" aria-pressed={kind === 'in'} disabled={disabled} onClick={() => setKind('in')}><ArrowDownLeft size={18} aria-hidden="true" />Entrada</button><button type="button" aria-pressed={kind === 'out'} disabled={disabled} onClick={() => setKind('out')}><ArrowUpRight size={18} aria-hidden="true" />Retiro</button></div><label>Importe<MoneyInput placeholder="$0.00" maxCents={maxOperationalMoneyCents} value={amount} onValueChange={setAmount} disabled={disabled} /></label><label>Motivo<input value={reason} placeholder="Ej. compra de insumos" maxLength={160} onChange={e => setReason(e.target.value)} disabled={disabled} /></label><button className="pos-button pos-primary" disabled={disabled || !reason.trim() || !parseOperationalMoney(amount)} onClick={() => void movement()}>Guardar movimiento</button></div></details>}
            {allowed('cash.close') && <button className="pos-button pos-primary" disabled={disabled} onClick={() => void transition('begin_shift_close')}>Iniciar cierre</button>}
          </>}
        </section>
        <section className="ops-card cash-movements"><div className="operations-heading"><h2>Movimientos</h2><span className="operations-count">{shift.movements.length}</span></div>
          {shift.movements.length ? <ul className="operations-records">{[...shift.movements].reverse().map(m => <li key={m.id}><span className="operations-record-icon">{m.kind === 'in' ? <ArrowDownLeft size={20} aria-hidden="true" /> : <ArrowUpRight size={20} aria-hidden="true" />}</span><div><strong>{m.reason}</strong><small>{m.actorName} · {dates.format(new Date(m.createdAt))}</small></div><span className="operations-record-money"><small>{m.kind === 'in' ? 'Entrada' : 'Retiro'}</small><strong>{m.kind === 'in' ? '+' : '−'}{money(m.amountCents)}</strong></span></li>)}</ul> : <p className="operations-empty-inline">Sin entradas ni retiros.</p>}
        </section>
      </>}
      {snapshot.attempts.length > 0 && <section className="ops-card cash-pending"><div className="operations-heading"><h2>Por resolver</h2><span className="operations-count">{snapshot.attempts.length}</span></div><p className="operations-caption">Verifica el movimiento original antes de cerrar.</p><ul className="operations-records">{snapshot.attempts.map(a => <li key={a.id}><button className="operations-record-button" onClick={() => setAttempt(a)}><div><strong>{a.kind === 'reversal' ? 'Devolución' : 'Cobro'}<span className="operations-record-state">{a.status === 'prepared' ? 'Sin iniciar' : 'Por verificar'}</span></strong><small>{a.operatorName}</small></div><strong>{money(a.totalCents)}</strong><ChevronRight size={18} aria-hidden="true" /></button></li>)}</ul></section>}
      {current.loading && !current.attempt && <LoadingPlaceholder variant="form" rows={2} label="Consultando el cobro" />}
      {current.error && <div className="operations-error" role="alert"><p>{current.error}</p><button className="pos-button pos-secondary" onClick={current.retry}>Reintentar consulta</button></div>}
      {current.attempt && <div aria-busy={current.loading}><AttemptPanel attempt={current.attempt} mutation={{ ...mutation, busy: mutation.busy || current.blocked }} collectionAllowed={shift?.status === 'open'} onSaved={a => { setAttempt(a); void refresh() }} /></div>}
    </div>
    {showHistory && <aside className="cash-history">
      {lastShift && <section className="ops-card cash-last-shift" role={result?.id === lastShift.id ? 'status' : undefined}><div className="operations-heading"><h2>Último turno</h2><Check size={20} aria-hidden="true" /></div><p className="operations-caption">{lastShift.closedBy} · {lastShift.closedAt && dates.format(new Date(lastShift.closedAt))}</p><dl className="ops-totals"><div><dt>Esperado</dt><dd>{lastShift.expectedCents === null ? '—' : money(lastShift.expectedCents)}</dd></div><div><dt>Contado</dt><dd>{lastShift.countedCents === null ? '—' : money(lastShift.countedCents)}</dd></div><div className="cash-difference"><dt>Diferencia</dt><dd>{lastShift.differenceCents === null ? '—' : money(lastShift.differenceCents)}</dd></div></dl>{lastShift.differenceCents !== null && lastShift.differenceCents !== 0 && <span className="operations-caption">{lastShift.differenceCents > 0 ? 'Sobrante por revisar' : 'Faltante por revisar'}</span>}</section>}
      {canRead && snapshot.enabled && <section className="ops-card cash-history-card"><div className="operations-heading"><h2>Turnos anteriores</h2>{historyLoaded && <span className="operations-count">{olderShifts.length}</span>}</div>
        {historyError && <div className="operations-error" role="alert"><p>{historyError}</p><button className="pos-button pos-secondary" onClick={() => setHistoryRetry(n => n + 1)}>Reintentar</button></div>}
        {!historyLoaded && !historyError ? <LoadingPlaceholder variant="list" rows={3} label="Cargando turnos" /> : olderShifts.length ? <ul className="cash-history-list">{olderShifts.map(s => <li key={s.id}><details><summary><div><strong>{s.closedAt && dates.format(new Date(s.closedAt))}</strong><small>{s.closedBy}</small></div><span><strong>{s.countedCents === null ? '—' : money(s.countedCents)}</strong><small>{s.differenceCents === 0 ? 'Sin diferencia' : s.differenceCents === null ? '—' : `${s.differenceCents > 0 ? '+' : '−'}${money(Math.abs(s.differenceCents))}`}</small></span><ChevronDown size={16} aria-hidden="true" /></summary><dl className="ops-totals"><div><dt>Fondo inicial</dt><dd>{money(s.openingCents)}</dd></div><div><dt>Esperado</dt><dd>{s.expectedCents === null ? '—' : money(s.expectedCents)}</dd></div><div><dt>Contado</dt><dd>{s.countedCents === null ? '—' : money(s.countedCents)}</dd></div><div><dt>Diferencia</dt><dd>{s.differenceCents === null ? '—' : money(s.differenceCents)}</dd></div></dl></details></li>)}</ul> : historyLoaded && <p className="operations-empty-inline">Sin turnos anteriores.</p>}
      </section>}
    </aside>}
  </div>
}
