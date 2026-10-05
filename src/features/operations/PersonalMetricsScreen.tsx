import { lazy, Suspense } from 'react'
import LoadingPlaceholder, { Skeleton } from '../../components/LoadingPlaceholder'
import { money, number } from '../../lib/format'
import { averageTicket, changePercent } from '../../lib/reporting'
import type { ReportController } from './usePeriodReport'
import './analytics-polish.css'
import './personal-metrics.css'

const TemporalChart = lazy(() => import('./AnalyticsCharts').then(module => ({ default: module.TemporalChart })))
const periods = [['day', 'Día'], ['week', 'Semana'], ['month', 'Mes']] as const
const calendarDate = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const dateLabel = (date: string) => calendarDate.format(new Date(`${date}T12:00:00Z`))

/** All data comes from report_own_period, scoped to the live actor on the server. */
export default function PersonalMetricsScreen({ controller }: { controller: ReportController }) {
  const { report, initialLoading, loading, error, stale, date, period, setDate, setPeriod, retry } = controller
  const totals = report?.totals
  const ticket = totals ? averageTicket(totals.salesCents, totals.saleCount) : null
  const delta = report?.comparisonComparable ? changePercent(report.totals.netCents, report.previous.netCents) : null
  const products = (totals?.products ?? []).filter(product => product.quantity > 0).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'es')).slice(0, 5)
  const maximum = Math.max(1, ...products.map(product => product.quantity))
  const datePending = loading && !!controller.displayedQuery && controller.displayedQuery.date !== date
  const range = report ? report.startDate === report.endDate ? dateLabel(report.startDate) : `${dateLabel(report.startDate)} – ${dateLabel(report.endDate)}` : null
  return <div className="analytics-dashboard personal-metrics" aria-busy={loading}>
    <div className="personal-metrics-filters">
      <div role="group" aria-label="Período de mis métricas" className="analytics-periods">{periods.map(([value, label]) => <button type="button" aria-pressed={(controller.displayedQuery?.period ?? period) === value} data-pending={loading && period === value && controller.displayedQuery?.period !== value || undefined} key={value} onClick={() => setPeriod(value)}>{label}</button>)}</div>
      <label className="personal-metrics-date" data-pending={datePending || undefined}><span className="sr-only">Fecha de mis métricas</span><input type="date" aria-busy={datePending} min="2000-01-01" max="2100-12-31" value={date} onChange={event => setDate(event.target.value)} /></label>
    </div>
    {range && <p className="personal-metrics-range" aria-label="Período de las cifras visibles">{range}</p>}
    {error && <div role="alert" className="analytics-error"><span>{stale ? 'Tus cifras pueden estar desactualizadas.' : error}</span><button type="button" onClick={() => void retry()}>Reintentar</button></div>}
    {initialLoading ? <div role="status" aria-label="Cargando mis métricas"><LoadingPlaceholder variant="cards" rows={3} /><section className="analytics-card mt-5"><LoadingPlaceholder variant="chart" /></section></div> : report && totals ? <>
      <div className="personal-metrics-kpis">
        <section className="analytics-kpi"><span className="analytics-kpi-label">Mis ventas</span><strong>{money(totals.netCents)}</strong>{delta && <small>{delta} vs. anterior</small>}</section>
        <section className="analytics-kpi"><span className="analytics-kpi-label">Cobros</span><strong>{number(totals.saleCount)}</strong></section>
        <section className="analytics-kpi"><span className="analytics-kpi-label">Ticket promedio</span><strong>{ticket === null ? '—' : money(ticket)}</strong></section>
      </div>
      <section className="analytics-card personal-metrics-trend"><header className="analytics-card-heading"><h2>Mis ventas</h2>{loading && <span role="status" aria-label="Actualizando mis métricas" className="personal-metrics-updating" />}</header>
        <Suspense fallback={<Skeleton width="100%" height={260} />}><TemporalChart report={report} metric="netCents" /></Suspense>
        {totals.saleCount === 0 && totals.reversalCents === 0 && <p className="analytics-empty">Sin cobros en este período.</p>}
      </section>
      <section className="analytics-card"><header className="analytics-card-heading"><h2>Más vendidos por mí</h2></header>{products.length ? <ol className="analytics-daily-products">{products.map(product => <li key={`${product.productId}:${product.name}`}>
        <div className="analytics-daily-product-label"><span>{product.name}</span><strong>{number(product.quantity)} <small>ud.</small></strong></div>
        <div className="analytics-daily-product-track" role="img" aria-label={`${product.name}: ${number(product.quantity)} unidades`}><span style={{ transform: `scaleX(${product.quantity / maximum})` }} /></div>
      </li>)}</ol> : <p className="analytics-empty">Sin productos vendidos.</p>}</section>
    </> : null}
  </div>
}
