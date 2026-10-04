import { useEffect, useRef, useState } from 'react'
import type { CommissionStatement, PointCommand } from '../lib/point-contracts'
import { AccountClientError } from '../lib/account'
import { downloadPointCsv, pointRequest } from '../lib/point-client'
import { money, priceInput, type PosAccess } from '../lib/pos'
import { parseOperationalMoney } from '../lib/operational-money'
import { accessErrorCodes } from './useCatalog'

export default function PointStatements({ access, onSessionError }: { access: PosAccess; onSessionError?: (error: AccountClientError) => void }) {
  const [statements, setStatements] = useState<CommissionStatement[]>([]), [selected, setSelected] = useState<CommissionStatement | null>(null)
  const [period, setPeriod] = useState(''), [evidence, setEvidence] = useState(''), [amount, setAmount] = useState(''), [paidAt, setPaidAt] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const alive = useRef(true), running = useRef(false), operation = useRef<{ command: PointCommand; fingerprint: string } | null>(null)
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [])
  function failure(caught: unknown) { if (!alive.current) return; setError(caught instanceof Error ? caught.message : 'No pudimos guardar el estado de cuenta.'); if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught) }
  async function load() { try { const result = await pointRequest(access, { command: 'statements' }); if (alive.current) setStatements(result.statements) } catch (caught) { failure(caught) } }
  async function execute(command: PointCommand, message: string) {
    if (running.current) return
    const fingerprint = JSON.stringify({ ...command, operationId: '' })
    if (!operation.current) operation.current = { command, fingerprint }
    else if (operation.current.fingerprint !== fingerprint) { setError('Primero confirma la solicitud pendiente con los mismos datos.'); return }
    running.current = true; setBusy(true); setError(''); setNotice('')
    try { await pointRequest(access, operation.current.command); if (!alive.current) return; operation.current = null; setNotice(message); await load(); setSelected(null); setEvidence('') }
    catch (caught) { failure(caught) }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const cents = parseOperationalMoney(amount)
  return <details className="analytics-card"><summary>Estados mensuales de comisión</summary><div className="ops-form mt-4">
    <p>El cierre conserva un snapshot. Las devoluciones tardías ajustan el siguiente periodo. Estos documentos no son CFDI.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <label>Periodo para cerrar<input type="month" value={period} onChange={event => setPeriod(event.target.value)} disabled={busy || Boolean(operation.current)} /></label>
    <button className="pos-button pos-secondary" disabled={busy || !period} onClick={() => void execute({ command: 'close_statement', operationId: crypto.randomUUID(), period }, 'Estado mensual cerrado.')}>{operation.current?.command.command === 'close_statement' ? 'Reintentar el mismo cierre' : 'Cerrar periodo mensual'}</button>
    <ul className="ops-list">{statements.map(statement => <li key={statement.id}><span>{statement.period}<small>{statement.status === 'invoiced' ? 'Facturado con evidencia' : 'Cerrado, pendiente de facturar'}</small><small>Comisión {money(statement.netCents)} / IVA {money(statement.vatCents)}</small></span><span>{money(statement.totalCents)}<small>Saldo: {money(statement.remainingCents)}</small><button className="pos-button pos-secondary" disabled={busy || Boolean(operation.current)} onClick={() => { setSelected(statement); setAmount(priceInput(statement.remainingCents)); setEvidence('') }}>Ver movimientos</button></span></li>)}</ul>
    <button className="pos-button pos-secondary" onClick={() => downloadPointCsv('comision-mensual.csv', [['Periodo', 'Estado', 'Numerador exacto', 'Comision centavos', 'IVA centavos', 'Total centavos', 'Cobrado centavos', 'Pendiente centavos'], ...statements.map(s => [s.period, s.status, s.exactNumerator, s.netCents, s.vatCents, s.totalCents, s.collectedCents, s.remainingCents])])}>Exportar estados mensuales</button>
    {selected && <section className="ops-card"><h3>{selected.period}</h3><p>Saldo pendiente: {money(selected.remainingCents)}</p>
      <label>Evidencia o referencia<input value={evidence} maxLength={200} onChange={event => setEvidence(event.target.value)} disabled={busy || Boolean(operation.current)} /></label>
      {selected.status === 'closed' && <button className="pos-button pos-secondary" disabled={busy || !evidence.trim()} onClick={() => void execute({ command: 'mark_statement_invoiced', operationId: crypto.randomUUID(), statementId: selected.id, evidence: evidence.trim() }, 'Estado marcado con evidencia de facturación.')}>Registrar evidencia de facturación</button>}
      <label>Abono recibido MXN<input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value)} disabled={busy || Boolean(operation.current)} /></label>
      <label>Fecha y hora del abono<input type="datetime-local" value={paidAt} onChange={event => setPaidAt(event.target.value)} disabled={busy || Boolean(operation.current)} /></label>
      <p className="text-sm">La fecha usa la zona del dispositivo y se guarda en UTC. Registra sólo dinero recibido con evidencia.</p>
      <button className="pos-button pos-primary" disabled={busy || !evidence.trim() || !paidAt || cents === null || cents <= 0 || cents > selected.remainingCents} onClick={() => { if (cents !== null) void execute({ command: 'record_commission_payment', operationId: crypto.randomUUID(), statementId: selected.id, amountCents: cents, paidAt: new Date(paidAt).toISOString(), evidence: evidence.trim() }, 'Abono registrado con evidencia.') }}>Registrar abono recibido</button>
    </section>}
  </div></details>
}
