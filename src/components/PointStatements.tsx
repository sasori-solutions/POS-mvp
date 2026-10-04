import { useEffect, useRef, useState } from 'react'
import type { CommissionStatement } from '../lib/point-contracts'
import { AccountClientError } from '../lib/account'
import { downloadPointCsv, pointRequest } from '../lib/point-client'
import { money, priceInput, type PosAccess } from '../lib/pos'
import { parseOperationalMoney } from '../lib/operational-money'
import { accessErrorCodes } from './useCatalog'
import { pointStatementKey, readPointStatement, type PointStatementCommand } from '../lib/point-pending'

export default function PointStatements(props: Parameters<typeof PointStatementsSession>[0]) {
  return <PointStatementsSession key={`${props.access.businessId}:${props.access.operatorToken}:${props.access.deviceToken ?? ''}:${props.actorId}`} {...props} />
}

function PointStatementsSession({ access, actorId, onSessionError }: { access: PosAccess; actorId: string; onSessionError?: (error: AccountClientError) => void }) {
  const [statements, setStatements] = useState<CommissionStatement[]>([]), [selected, setSelected] = useState<CommissionStatement | null>(null)
  const [period, setPeriod] = useState(''), [evidence, setEvidence] = useState(''), [amount, setAmount] = useState(''), [paidAt, setPaidAt] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const alive = useRef(true), running = useRef(false)
  const [pending, setPending] = useState<PointStatementCommand | null>(null)
  const storageKey = pointStatementKey(access.businessId, actorId)
  useEffect(() => {
    alive.current = true
    const restore = () => { try { setPending(readPointStatement(storageKey)) } catch (caught) { failure(caught) } }
    const stored = (event: StorageEvent) => { if (event.key === storageKey && !running.current) restore() }
    restore(); void load(); window.addEventListener('storage', stored)
    return () => { alive.current = false; window.removeEventListener('storage', stored) }
  }, [])
  function failure(caught: unknown) { if (!alive.current) return; setError(caught instanceof Error ? caught.message : 'No pudimos guardar el estado de cuenta.'); if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught) }
  async function load() { try { const result = await pointRequest(access, { command: 'statements' }); if (alive.current) setStatements(result.statements) } catch (caught) { failure(caught) } }
  async function execute(input: PointStatementCommand, message: string) {
    if (running.current || !alive.current) return
    const command = JSON.parse(JSON.stringify(input)) as PointStatementCommand
    const current = () => { if (!alive.current) throw new Error('La sesión cambió. La solicitud permanece guardada.') }
    const clear = async () => {
      if (!navigator.locks) return
      await navigator.locks.request(storageKey, () => {
        current()
        if (readPointStatement(storageKey)?.operationId === command.operationId) localStorage.removeItem(storageKey)
        setPending(readPointStatement(storageKey))
      })
    }
    running.current = true; setBusy(true); setError(''); setNotice('')
    try {
      if (!navigator.onLine) throw new AccountClientError('NETWORK_ERROR', 'Sin conexión. Reintenta cuando vuelva la conexión.')
      if (!navigator.locks) throw new Error('Actualiza el navegador para proteger los reintentos entre pestañas.')
      await navigator.locks.request(storageKey, () => {
        current()
        const stored = readPointStatement(storageKey)
        if (stored && JSON.stringify(stored) !== JSON.stringify(command)) { setPending(stored); throw new Error('Resuelve la solicitud pendiente antes de iniciar otra.') }
        localStorage.setItem(storageKey, JSON.stringify(command)); setPending(command)
      })
      current()
      await pointRequest(access, command)
      current(); await clear(); current()
      setNotice(message); await load()
      if (alive.current) { setSelected(null); setEvidence('') }
    } catch (caught) {
      if (!alive.current) return
      if (caught instanceof AccountClientError && !['NETWORK_ERROR', 'SERVER_ERROR', 'OPERATION_CONFLICT', ...accessErrorCodes].includes(caught.code)) {
        try { await clear() } catch { /* Preserve a recovery command if durable cleanup fails. */ }
      }
      failure(caught)
    } finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const cents = parseOperationalMoney(amount)
  return <details className="analytics-card"><summary>Estados mensuales de comisión</summary><div className="ops-form mt-4">
    <p>El cierre conserva un snapshot. Las devoluciones tardías ajustan el siguiente periodo. Estos documentos no son CFDI.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {pending && <div role="status"><p>Hay una solicitud pendiente. El reintento conserva los mismos datos.</p><button className="pos-button pos-primary" disabled={busy} onClick={() => void execute(pending, 'Solicitud recuperada.')}>Reintentar solicitud guardada</button></div>}
    <label>Periodo para cerrar<input type="month" value={period} onChange={event => setPeriod(event.target.value)} disabled={busy || Boolean(pending)} /></label>
    <button className="pos-button pos-secondary" disabled={busy || Boolean(pending) || !period} onClick={() => void execute({ command: 'close_statement', operationId: crypto.randomUUID(), period }, 'Estado mensual cerrado.')}>Cerrar periodo mensual</button>
    <ul className="ops-list">{statements.map(statement => <li key={statement.id}><span>{statement.period}<small>{statement.status === 'invoiced' ? 'Facturado con evidencia' : 'Cerrado, pendiente de facturar'}</small><small>Comisión {money(statement.netCents)} / IVA {money(statement.vatCents)}</small></span><span>{money(statement.totalCents)}<small>Saldo: {money(statement.remainingCents)}</small><button className="pos-button pos-secondary" disabled={busy || Boolean(pending)} onClick={() => { setSelected(statement); setAmount(priceInput(statement.remainingCents)); setEvidence('') }}>Ver movimientos</button></span></li>)}</ul>
    <button className="pos-button pos-secondary" onClick={() => downloadPointCsv('comision-mensual.csv', [['Periodo', 'Estado', 'Numerador exacto', 'Comision centavos', 'IVA centavos', 'Total centavos', 'Cobrado centavos', 'Pendiente centavos'], ...statements.map(s => [s.period, s.status, s.exactNumerator, s.netCents, s.vatCents, s.totalCents, s.collectedCents, s.remainingCents])])}>Exportar estados mensuales</button>
    {selected && <section className="ops-card"><h3>{selected.period}</h3><p>Saldo pendiente: {money(selected.remainingCents)}</p>
      <label>Evidencia o referencia<input value={evidence} maxLength={200} onChange={event => setEvidence(event.target.value)} disabled={busy || Boolean(pending)} /></label>
      {selected.status === 'closed' && <button className="pos-button pos-secondary" disabled={busy || Boolean(pending) || !evidence.trim()} onClick={() => void execute({ command: 'mark_statement_invoiced', operationId: crypto.randomUUID(), statementId: selected.id, evidence: evidence.trim() }, 'Estado marcado con evidencia de facturación.')}>Registrar evidencia de facturación</button>}
      <label>Abono recibido MXN<input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)} disabled={busy || Boolean(pending)} /></label>
      <label>Fecha y hora del abono<input type="datetime-local" value={paidAt} onChange={event => setPaidAt(event.target.value)} disabled={busy || Boolean(pending)} /></label>
      <p className="text-sm">La fecha usa la zona del dispositivo y se guarda en UTC. Registra sólo dinero recibido con evidencia.</p>
      <button className="pos-button pos-primary" disabled={busy || Boolean(pending) || !evidence.trim() || !paidAt || cents === null || cents <= 0 || cents > selected.remainingCents} onClick={() => { if (cents !== null) void execute({ command: 'record_commission_payment', operationId: crypto.randomUUID(), statementId: selected.id, amountCents: cents, paidAt: new Date(paidAt).toISOString(), evidence: evidence.trim() }, 'Abono registrado con evidencia.') }}>Registrar abono recibido</button>
    </section>}
  </div></details>
}
