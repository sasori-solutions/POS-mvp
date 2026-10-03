import { useState } from 'react'
import { ArrowRight, Banknote, CreditCard, RefreshCw, Smartphone } from 'lucide-react'
import type { ReportPeriod } from '../../lib/operations-contracts'
import { money, type PosAccess } from '../../lib/pos'
import { businessDate, averageTicket, changePercent, paymentPercent } from '../../lib/reporting'
import { paymentLabels } from '../../components/PosShared'
import type { AccountClientError } from '../../lib/account'
import { usePeriodReport } from './usePeriodReport'

export default function ReportDashboard({ access, timezone, onSessionError, detailed = false, onSale, onCash, onTeam }: {
  access: PosAccess; timezone: string; onSessionError?: (error: AccountClientError) => void; detailed?: boolean
  onSale?: () => void; onCash?: () => void; onTeam?: () => void
}) {
  const [date, setDate] = useState(() => businessDate(timezone))
  const [period, setPeriod] = useState<ReportPeriod>('day')
  const { report, error, loading, refresh } = usePeriodReport(access, date, period, onSessionError)
  const total = report?.totals
  const average = total ? averageTicket(total.salesCents, total.saleCount) : null
  const growth = report?.comparisonComparable ? changePercent(report.totals.netCents, report.previous.netCents) : null
  const future = report ? businessDate(report.timezone, new Date(report.asOf)) < report.startDate : false
  const products = total ? [...total.products].filter(p => p.quantity > 0 || detailed && p.reversalQuantity > 0).sort((a,b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'es')) : []
  const max = Math.max(1, ...(report?.series.map(p => p.salesCents) ?? []))
  const timestamp = (value: string) => new Date(value).toLocaleString('es-MX', { timeZone: timezone, timeZoneName: 'shortOffset', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const chartLabel = (value: string, hour: string) => period === 'day' ? hour : new Date(value).toLocaleDateString('es-MX', { timeZone: timezone, day: 'numeric' })
  return <div className="report-dashboard">
    <div className="report-toolbar">
      <div className="report-periods" role="group" aria-label="Período del reporte">
        {([['day','Día'],['week','Semana'],['month','Mes']] as const).map(([value,label]) => <button key={value} aria-pressed={period===value} onClick={()=>setPeriod(value)}>{label}</button>)}
      </div>
      <label className="report-date"><span className="sr-only">Fecha del reporte</span><input type="date" min="2000-01-01" max="2100-12-31" value={date} onChange={e=>{if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(e.target.value)) setDate(e.target.value)}} /></label>
      <button className="pos-icon-button" aria-label="Actualizar reporte" disabled={loading} onClick={()=>void refresh()}><RefreshCw size={20} /></button>
    </div>
    {error && <div className="report-error" role="alert"><p>{error}</p>{report && <p>Se muestra el último informe recibido; no está actualizado.</p>}<button onClick={()=>void refresh()} disabled={loading}>Reintentar</button></div>}
    {!report && loading && <p role="status">Cargando resumen del negocio…</p>}
    {report && total && <>
      <p className="report-context">{report.startDate} {report.startDate!==report.endDate && `— ${report.endDate}`} · {future ? 'Período futuro' : report.partial ? 'Período en curso' : 'Período completo'} · {report.timezone}</p>
      <section className="report-kpis" aria-label="Resumen de ventas">
        <div className="report-kpi report-kpi-main"><span>Ventas netas</span><strong>{money(total.netCents)}</strong><small>Cobrado {money(total.salesCents)} · Devoluciones {money(total.reversalCents)}</small>
          <span className="report-comparison">{growth ?? (future ? 'Este período aún no inicia' : report.comparisonComparable ? 'Sin base de comparación' : 'Períodos sin ventana equivalente')}<small>{report.comparisonComparable && report.partial ? 'Hasta la misma hora y avance del período anterior' : 'Período anterior'} · {report.comparisonStartDate} — {report.comparisonEndDate}</small></span>
        </div>
        <div className="report-kpi"><span>Cobros</span><strong>{total.saleCount}</strong><small>Ventas registradas</small></div>
        <div className="report-kpi"><span>Ticket promedio</span><strong>{average === null ? '—' : money(average)}</strong><small>Después de descuentos, con IVA</small></div>
      </section>
      <section className="report-card"><h2>{period==='day' ? 'Cobros por hora' : 'Cobros por día'}</h2>
        {total.saleCount===0 && <p>Sin cobros registrados en este período.</p>}
        <div className="report-chart" role="img" aria-label={`${period==='day' ? 'Cobros por hora' : 'Cobros por día'}: ${money(total.salesCents)}`}>
          {report.series.map((point,i)=><div className={`report-bar-column ${point.future ? 'future' : ''}`} key={point.start} title={`${timestamp(point.start)}: ${money(point.salesCents)}`}>
            <div className="report-bar-track"><span style={{height:point.salesCents ? `${Math.max(2,point.salesCents/max*100)}%` : '2px'}} /></div>
            <small>{i===0 || i===report.series.length-1 || i%Math.ceil(report.series.length/6)===0 ? chartLabel(point.start,point.label) : ''}</small>
          </div>)}
        </div>
        <details className="report-chart-data"><summary>Ver datos del gráfico</summary><ul>{report.series.map(point=><li key={point.start}><span>{timestamp(point.start)}</span><strong>{point.future ? 'Pendiente' : money(point.salesCents)}</strong></li>)}</ul></details>
      </section>
      <div className="report-columns">
        <section className="report-card"><h2>Métodos de pago</h2><ul className="report-list">{total.payments.map(p=>{
          const Icon=p.paymentMethod==='cash'?Banknote:p.paymentMethod==='card_external'?CreditCard:Smartphone
          return <li key={p.paymentMethod}><Icon size={21}/><span>{paymentLabels[p.paymentMethod]}<small>{paymentPercent(p.salesCents,total.salesCents)} de lo cobrado{p.reversalCents>0 && ` · Devuelto ${money(p.reversalCents)}`}</small></span><strong>{money(p.salesCents)}</strong></li>
        })}</ul></section>
        <section className="report-card"><h2>{detailed ? 'Productos vendidos y devueltos' : 'Productos más vendidos'}</h2><ul className="report-list">{products.slice(0,detailed?undefined:5).map(p=><li key={`${p.productId}:${p.name}`}><span>{p.name}<small>{p.quantity} vendidos{p.reversalQuantity>0 && ` · ${p.reversalQuantity} devueltos`}{detailed && ` · Cobrado ${money(p.salesCents)} · Devuelto ${money(p.reversalCents)}`}</small></span><strong>{money(detailed ? p.netCents : p.salesCents)}</strong></li>)}</ul>{!products.length && <p>Sin productos vendidos.</p>}</section>
      </div>
      {detailed && <>
        <section className="report-card"><h2>Detalle financiero</h2><dl className="report-financials">{[['Ventas brutas',total.grossCents],['Descuentos',total.discountCents],['Cobrado',total.salesCents],['Devoluciones',total.reversalCents],['Ventas netas',total.netCents],['IVA conocido de ventas',total.taxCents],['IVA conocido devuelto',total.reversalTaxCents],['Saldo condonado',total.waivedCents]].map(([label,cents])=><div key={label}><dt>{label}</dt><dd>{money(Number(cents))}</dd></div>)}</dl><p>Las cuentas sin pagar y los saldos condonados quedan fuera de ingresos. Los pagos electrónicos son registros del operador.</p></section>
        <section className="report-card"><h2>Cobros por nombre de operador</h2><ul className="report-list">{total.operators.map((p,i)=><li key={`${p.name}:${i}`}><span>{p.name}<small>Cobrado {money(p.salesCents)} · Devuelto {money(p.reversalCents)}</small></span><strong>{money(p.netCents)}</strong></li>)}</ul><p>Se agrupa por el nombre guardado en la venta; nombres iguales pueden pertenecer a personas distintas.</p></section>
        <section className="report-card"><h2>Diferencias de caja</h2><ul className="report-list">{total.cashDifferences.map(s=><li key={s.shiftId}><span>{timestamp(s.closedAt)}<small>Esperado {money(s.expectedCents)} · Contado {money(s.countedCents)}</small></span><strong>{money(s.differenceCents)}</strong></li>)}</ul>{!total.cashDifferences.length && <p>Sin cierres en este período.</p>}</section>
      </>}
      <p className="report-updated">Actualizado {timestamp(report.asOf)}</p>
    </>}
    {(onSale || onCash || onTeam) && <div className="report-shortcuts">{[[onSale,'Ir a venta'],[onCash,'Caja'],[onTeam,'Empleados']].map(([action,label])=>action && <button key={String(label)} onClick={action as ()=>void}>{String(label)}<ArrowRight size={18}/></button>)}</div>}
  </div>
}
