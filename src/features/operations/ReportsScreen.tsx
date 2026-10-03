import { useEffect, useRef, useState } from 'react'
import type { BusinessDayReport } from '../../lib/operations-contracts'
import { money, posRequest, type PosAccess } from '../../lib/pos'
import { paymentLabels } from '../../components/PosShared'
import { AccountClientError } from '../../lib/account'
import { accessErrorCodes } from '../../components/useCatalog'

export function businessDate(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)!.value).join('-')
}

export default function ReportsScreen({ access, timezone, onSessionError }: { access: PosAccess; timezone: string; onSessionError?: (error: AccountClientError) => void }) {
  const [date, setDate] = useState(() => businessDate(timezone))
  const [report, setReport] = useState<BusinessDayReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  async function load() {
    const request = ++sequence.current; setLoading(true); setError('')
    try { const r = await posRequest(access, { command: 'report', date }); if (request === sequence.current) setReport(r) } catch (e) { if (request === sequence.current) { setError(e instanceof Error ? e.message : 'No pudimos cargar el reporte.'); if (e instanceof AccountClientError && accessErrorCodes.includes(e.code)) onSessionError?.(e) } } finally { if (request === sequence.current) setLoading(false) }
  }
  useEffect(() => { setReport(null); void load(); return () => { sequence.current++ } }, [date, access.businessId, access.operatorToken])
  return <div className="ops-section"><label>Día del negocio<input type="date" value={date} onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setDate(e.target.value) }} /></label><p className="text-sm text-muted">Zona horaria: {timezone}. Los pagos electrónicos son registros confirmados por el operador.</p><button className="pos-button pos-secondary" disabled={loading} onClick={() => void load()}>Actualizar reporte</button>{loading && <p role="status">Cargando reporte…</p>}{error && <p role="alert">{error}</p>}{report && <>
    <section className="ops-card"><h2>Ventas del día</h2><dl className="ops-totals">{[['Ventas brutas', report.grossCents], ['Descuentos', report.discountCents], ['Ventas cobradas', report.salesCents], ['Devoluciones', report.reversalCents], ['Ventas netas', report.netCents], ['IVA conocido de ventas', report.taxCents], ['IVA conocido devuelto', report.reversalTaxCents], ['Saldo condonado', report.waivedCents]].map(([name, cents]) => <div key={name}><dt>{name}</dt><dd>{money(Number(cents))}</dd></div>)}</dl><p>{report.saleCount} ventas. Las cuentas sin pagar quedan fuera de los ingresos. Las devoluciones aparecen el día en que se registran.</p></section>
    <section className="ops-card"><h2>Métodos de pago</h2><ul className="ops-list">{report.payments.map(p => <li key={p.paymentMethod}><span>{paymentLabels[p.paymentMethod]}<small>Cobrado {money(p.salesCents)} · Devuelto {money(p.reversalCents)}</small></span><strong>{money(p.netCents)}</strong></li>)}</ul></section>
    <section className="ops-card"><h2>Operadores</h2><ul className="ops-list">{report.operators.map((p, i) => <li key={`${p.name}:${i}`}><span>{p.name}<small>Cobrado {money(p.salesCents)} · Devuelto {money(p.reversalCents)}</small></span><strong>{money(p.netCents)}</strong></li>)}</ul></section>
    <section className="ops-card"><h2>Productos</h2><ul className="ops-list">{report.products.map((p, i) => <li key={`${p.productId}:${i}`}><span>{p.name}<small>{p.quantity} vendidos · {p.reversalQuantity ?? 0} devueltos</small><small>Cobrado {money(p.salesCents)} · Devuelto {money(p.reversalCents ?? 0)} · IVA neto conocido {money(p.netTaxCents ?? p.taxCents)}</small></span><strong>{money(p.netCents ?? p.salesCents)}</strong></li>)}</ul></section>
    <section className="ops-card"><h2>Diferencias de caja</h2><ul className="ops-list">{report.cashDifferences.map(s => <li key={s.shiftId}><span>Turno {s.shiftId.slice(0, 8)}<small>Esperado {money(s.expectedCents)} · Contado {money(s.countedCents)}</small></span><strong>{money(s.differenceCents)}</strong></li>)}</ul>{!report.cashDifferences.length && <p>Sin cierres registrados en este día.</p>}</section>
  </>}</div>
}
