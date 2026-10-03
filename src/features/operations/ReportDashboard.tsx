import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronDown, Info, RefreshCw } from 'lucide-react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import type { BusinessDayReport, BusinessPeriodReport } from '../../lib/operations-contracts'
import { money } from '../../lib/pos'
import { averageTicket, businessDate, changePercent } from '../../lib/reporting'
import { paymentLabels } from '../../components/PosShared'
import type { ReportController } from './usePeriodReport'

gsap.registerPlugin(useGSAP)
const charts = () => import('./AnalyticsCharts')
const TemporalChart = lazy(() => charts().then(module => ({ default: module.TemporalChart })))
const PaymentMixChart = lazy(() => charts().then(module => ({ default: module.PaymentMixChart })))
const RankedBars = lazy(() => charts().then(module => ({ default: module.RankedBars })))
const PaymentNetChart = lazy(() => charts().then(module => ({ default: module.PaymentNetChart })))
const FinancialWaterfall = lazy(() => charts().then(module => ({ default: module.FinancialWaterfall })))
const TaxChart = lazy(() => charts().then(module => ({ default: module.TaxChart })))
const CashDifferenceChart = lazy(() => charts().then(module => ({ default: module.CashDifferenceChart })))
export type ReportTab = 'sales' | 'products' | 'finances'
type Metric = 'salesCents' | 'netCents' | 'saleCount'
type ProductSort = 'quantity' | 'reversalQuantity' | 'netCents'
const periods = [['day', 'Día'], ['week', 'Semana'], ['month', 'Mes']] as const
const tabs = [['sales', 'Ventas'], ['products', 'Productos'], ['finances', 'Finanzas']] as const
const colors = { cash: '#0F766E', card_external: '#2563EB', transfer: '#7C3AED' }
const quantity = (value: number) => value.toLocaleString('es-MX')

function Help({ label, children }: { label: string; children: ReactNode }) {
  return <details className="analytics-help"><summary aria-label={`Información sobre ${label}`}><Info size={16} aria-hidden="true" /></summary><div role="note">{children}</div></details>
}

function AnimatedValue({ value }: { value: string }) {
  const element = useRef<HTMLElement>(null)
  useGSAP(() => {
    if (!element.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    gsap.fromTo(element.current, { opacity: 0.4 }, { opacity: 1, duration: 0.15, clearProps: 'opacity' })
  }, { dependencies: [value], scope: element, revertOnUpdate: true })
  return <strong ref={element}>{value}</strong>
}

function Kpi({ label, value, previous, current, comparable, help, main = false, tone }: {
  label: string; value: string; previous: number | null; current: number | null; comparable: boolean; help: string; main?: boolean; tone?: string
}) {
  const delta = comparable && current !== null && previous !== null ? changePercent(current, previous) : null
  const up = delta?.startsWith('+'), down = delta?.startsWith('-')
  return <section className={`analytics-kpi ${main ? 'analytics-kpi-main' : ''}`}>
    <div className="analytics-kpi-label"><span>{label}</span><Help label={label}>{help}</Help></div>
    <div className="analytics-kpi-number" style={tone ? { color: tone } : undefined}><AnimatedValue value={value} /></div>
    <span className={`analytics-delta ${main && up ? 'positive' : main && down ? 'negative' : ''}`} title={delta ? 'Comparado con el período anterior equivalente' : 'Sin base de comparación equivalente'}>
      {delta && (down ? <ArrowDown size={13} aria-hidden="true" /> : up ? <ArrowUp size={13} aria-hidden="true" /> : null)}{delta ?? '—'}
      {delta && <small>vs. anterior</small>}
    </span>
  </section>
}

function ChartPlaceholder({ height = 260 }: { height?: number }) {
  return <div className="analytics-chart-placeholder analytics-shimmer" style={{ height }} aria-hidden="true"><span /><span /><span /></div>
}

function DashboardSkeleton({ detailed }: { detailed: boolean }) {
  return <div className="analytics-skeleton" role="status" aria-label="Cargando información del negocio" aria-busy="true">
    <div className={`analytics-kpis ${detailed ? 'analytics-kpis-four' : ''}`} aria-hidden="true">
      {Array.from({ length: detailed ? 4 : 3 }, (_, index) => <div className={`analytics-kpi ${!detailed && !index ? 'analytics-kpi-main' : ''}`} key={index}><span className="analytics-skeleton-line analytics-shimmer" /><span className="analytics-skeleton-number analytics-shimmer" /><span className="analytics-skeleton-line short analytics-shimmer" /></div>)}
    </div>
    <section className="analytics-card" aria-hidden="true"><span className="analytics-skeleton-line analytics-shimmer" /><ChartPlaceholder /></section>
    <div className="analytics-columns" aria-hidden="true">{[0, 1].map(index => <section className="analytics-card" key={index}><span className="analytics-skeleton-line analytics-shimmer" /><ChartPlaceholder height={230} /></section>)}</div>
  </div>
}

function Card({ title, help, action, children, className = '' }: { title: string; help?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`analytics-card ${className}`}><header className="analytics-card-heading"><div><h2>{title}</h2>{help && <Help label={title}>{help}</Help>}</div>{action}</header>{children}</section>
}

function ReportLink({ onClick, label }: { onClick?: () => void; label: string }) {
  return onClick ? <button type="button" className="analytics-card-link" aria-label={label} onClick={onClick}><ArrowUpRight size={19} aria-hidden="true" /></button> : null
}

function ProductTable({ products }: { products: BusinessDayReport['products'] }) {
  const [sort, setSort] = useState<ProductSort>('netCents')
  const [descending, setDescending] = useState(true)
  const ordered = [...products].sort((a, b) => (a[sort] - b[sort]) * (descending ? -1 : 1) || a.name.localeCompare(b.name, 'es'))
  function sortBy(column: ProductSort) { setSort(column); setDescending(sort === column ? !descending : true) }
  const columns = [['quantity', 'Vendidos'], ['reversalQuantity', 'Devueltos'], ['netCents', 'Neto']] as const
  if (!products.length) return <p className="analytics-empty">Sin productos en este período.</p>
  return <>
    <div className="analytics-desktop-table"><table className="analytics-table"><thead><tr><th scope="col">Producto</th>{columns.map(([column, label]) => <th scope="col" key={column} aria-sort={sort === column ? descending ? 'descending' : 'ascending' : 'none'}><button type="button" onClick={() => sortBy(column)}>{label}{sort === column && (descending ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}</button></th>)}</tr></thead><tbody>{ordered.map(product => <tr key={`${product.productId}:${product.name}`}><th scope="row">{product.name}</th><td>{quantity(product.quantity)}</td><td>{quantity(product.reversalQuantity)}</td><td>{money(product.netCents)}</td></tr>)}</tbody></table></div>
    <div className="analytics-mobile-table"><label className="analytics-sort">Ordenar por<select value={sort} onChange={event => { setSort(event.target.value as ProductSort); setDescending(true) }}>{columns.map(([column, label]) => <option value={column} key={column}>{label}</option>)}</select></label>{ordered.map(product => <details className="analytics-detail-row" key={`${product.productId}:${product.name}`}><summary><span>{product.name}</span><strong>{sort === 'netCents' ? money(product.netCents) : quantity(product[sort])}</strong><ChevronDown size={16} /></summary><dl><div><dt>Vendidos</dt><dd>{quantity(product.quantity)}</dd></div><div><dt>Devueltos</dt><dd>{quantity(product.reversalQuantity)}</dd></div><div><dt>Cobrado</dt><dd>{money(product.salesCents)}</dd></div><div><dt>Devuelto</dt><dd>{money(product.reversalCents)}</dd></div><div><dt>Neto</dt><dd>{money(product.netCents)}</dd></div></dl></details>)}</div>
  </>
}

function PaymentTable({ payments }: { payments: BusinessDayReport['payments'] }) {
  return <div className="analytics-payment-values">{payments.map(payment => <div key={payment.paymentMethod}><span><i className="analytics-color-dot" style={{ background: colors[payment.paymentMethod] }} />{paymentLabels[payment.paymentMethod]}</span><strong>{money(payment.netCents)}</strong><small>Cobrado {money(payment.salesCents)}</small><small>Devuelto {money(payment.reversalCents)}</small></div>)}</div>
}

function Operators({ operators }: { operators: BusinessDayReport['operators'] }) {
  if (!operators.length) return <p className="analytics-empty">Sin cobros registrados.</p>
  const ordered = [...operators].sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name, 'es'))
  return <><div className="analytics-desktop-table"><table className="analytics-table"><thead><tr><th scope="col">Nombre</th><th scope="col">Cobrado</th><th scope="col">Devuelto</th><th scope="col">Neto</th></tr></thead><tbody>{ordered.map(operator => <tr key={operator.name}><th scope="row">{operator.name}</th><td>{money(operator.salesCents)}</td><td>{money(operator.reversalCents)}</td><td>{money(operator.netCents)}</td></tr>)}</tbody></table></div><div className="analytics-mobile-table">{ordered.map(operator => <details className="analytics-detail-row" key={operator.name}><summary><span>{operator.name}</span><strong>{money(operator.netCents)}</strong><ChevronDown size={16} /></summary><dl><div><dt>Cobrado</dt><dd>{money(operator.salesCents)}</dd></div><div><dt>Devuelto</dt><dd>{money(operator.reversalCents)}</dd></div></dl></details>)}</div></>
}

function CashTable({ items, timezone }: { items: BusinessDayReport['cashDifferences']; timezone: string }) {
  const timestamp = (value: string) => new Date(value).toLocaleString('es-MX', { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return <><div className="analytics-desktop-table"><table className="analytics-table"><thead><tr><th scope="col">Cierre</th><th scope="col">Esperado</th><th scope="col">Contado</th><th scope="col">Diferencia</th></tr></thead><tbody>{items.map(item => <tr key={item.shiftId}><th scope="row">{timestamp(item.closedAt)}</th><td>{money(item.expectedCents)}</td><td>{money(item.countedCents)}</td><td>{money(item.differenceCents)}</td></tr>)}</tbody></table></div><div className="analytics-mobile-table">{items.map(item => <details className="analytics-detail-row" key={item.shiftId}><summary><span>{timestamp(item.closedAt)}</span><strong>{money(item.differenceCents)}</strong><ChevronDown size={16} /></summary><dl><div><dt>Esperado</dt><dd>{money(item.expectedCents)}</dd></div><div><dt>Contado</dt><dd>{money(item.countedCents)}</dd></div></dl></details>)}</div></>
}

function TemporalPanel({ report, metric, setMetric, detailed, onOpenReport }: { report: BusinessPeriodReport; metric: Metric; setMetric: (metric: Metric) => void; detailed: boolean; onOpenReport?: (tab: ReportTab) => void }) {
  const displayMetric = detailed ? metric : 'netCents'
  const animation = useRef<HTMLDivElement>(null)
  const unit = displayMetric === 'saleCount' ? 'count' : 'money'
  useGSAP(() => {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) gsap.fromTo(animation.current, { opacity: 0.3 }, { opacity: 1, duration: 0.2, clearProps: 'opacity' })
  }, { dependencies: [unit], scope: animation, revertOnUpdate: true })
  return <Card title={detailed ? 'Evolución' : 'Ventas netas'} help="Cada punto representa una hora o un día. La comparación usa el período anterior; en períodos en curso, hasta el mismo avance. Neto es cobrado menos devoluciones efectivas." action={detailed ? <div className="analytics-metric-switch" role="group" aria-label="Métrica de evolución">{([['salesCents', 'Cobrado'], ['netCents', 'Neto'], ['saleCount', 'Cobros']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{label}</button>)}</div> : <ReportLink label="Ver evolución en Reportes" onClick={onOpenReport ? () => onOpenReport('sales') : undefined} />}>
    <div className="analytics-trend-caption"><span>{report.period === 'day' ? 'Por hora' : 'Por día'}</span><div className="analytics-legend"><span className="analytics-legend-item"><i className="analytics-color-dot" style={{ background: '#2563EB' }} />Actual</span>{report.comparisonComparable && <span className="analytics-legend-item"><i className="analytics-previous-line" />Anterior</span>}</div></div>
    <div ref={animation}><Suspense fallback={<ChartPlaceholder />}><TemporalChart report={report} metric={displayMetric} /></Suspense></div>
    {report.totals.saleCount === 0 && report.totals.reversalCents === 0 && <p className="analytics-empty">{businessDate(report.timezone, new Date(report.asOf)) < report.startDate ? 'Este período aún no inicia.' : 'Sin cobros.'}</p>}
  </Card>
}

interface ReportPresentation { report: BusinessPeriodReport; detailed: boolean; tab: ReportTab; metric: Metric; productMetric: 'netCents' | 'quantity' }
interface ReportActions { setMetric: (metric: Metric) => void; setProductMetric: (metric: 'netCents' | 'quantity') => void; onOpenReport?: (tab: ReportTab) => void }

function ReportBody({ report, detailed, tab, metric, setMetric, productMetric, setProductMetric, onOpenReport }: ReportPresentation & ReportActions) {
  const total = report.totals, previous = report.previous
  const average = averageTicket(total.salesCents, total.saleCount), previousAverage = averageTicket(previous.salesCents, previous.saleCount)
  const comparable = report.comparisonComparable
  const top = [...total.products].filter(product => product.quantity > 0).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'es')).slice(0, 5)
  const ranking = [...total.products].sort((a, b) => b[productMetric] - a[productMetric] || a.name.localeCompare(b.name, 'es')).slice(0, 10)
  return <div className="analytics-body">
    <div className={`analytics-kpis ${detailed ? 'analytics-kpis-four' : ''}`} aria-label="Resumen de ventas">
      {detailed ? <>
        <Kpi label="Cobrado" value={money(total.salesCents)} current={total.salesCents} previous={previous.salesCents} comparable={comparable} help="Importe registrado después de descuentos, con IVA incluido. Los pagos electrónicos se registran por confirmación del operador." />
        <Kpi label="Neto" value={money(total.netCents)} current={total.netCents} previous={previous.netCents} comparable={comparable} help="Cobrado menos devoluciones efectivas en el período. Puede ser negativo y no representa beneficio." />
        <Kpi label="Devoluciones" value={money(total.reversalCents)} current={total.reversalCents} previous={previous.reversalCents} comparable={comparable} help="Devoluciones en su fecha efectiva, incluidas las de ventas de otros períodos." tone={total.reversalCents > 0 ? '#DC2626' : undefined} />
        <Kpi label="Descuentos" value={money(total.discountCents)} current={total.discountCents} previous={previous.discountCents} comparable={comparable} help="Descuentos asignados a los cobros registrados en el período." />
      </> : <>
        <Kpi label="Ventas netas" value={money(total.netCents)} current={total.netCents} previous={previous.netCents} comparable={comparable} main help="Cobrado menos devoluciones efectivas, con IVA incluido. No representa beneficio." />
        <Kpi label="Cobros" value={quantity(total.saleCount)} current={total.saleCount} previous={previous.saleCount} comparable={comparable} help="Cantidad de recibos registrados. Un cobro no equivale a un cliente." />
        <Kpi label="Ticket promedio" value={average === null ? '—' : money(average)} current={average} previous={previousAverage} comparable={comparable} help="Cobrado después de descuentos, con IVA incluido, dividido entre los cobros registrados." />
      </>}
    </div>
    {!detailed ? <>
      <TemporalPanel report={report} metric="netCents" setMetric={setMetric} detailed={false} onOpenReport={onOpenReport} />
      <div className="analytics-columns analytics-home-columns"><Card title="Métodos de pago" help="Distribución del importe cobrado, antes de devoluciones. Las porciones suman el cobrado del período." action={<ReportLink label="Ver métodos de pago en Reportes" onClick={onOpenReport ? () => onOpenReport('sales') : undefined} />}><Suspense fallback={<ChartPlaceholder height={230} />}><PaymentMixChart payments={total.payments} /></Suspense></Card><Card title="Más vendidos" help="Unidades vendidas según el nombre guardado en el recibo." action={<ReportLink label="Ver productos en Reportes" onClick={onOpenReport ? () => onOpenReport('products') : undefined} />}><Suspense fallback={<ChartPlaceholder height={230} />}><RankedBars items={top.map(product => ({ key: `${product.productId}:${product.name}`, label: product.name, value: product.quantity }))} /></Suspense></Card></div>
    </> : tab === 'sales' ? <>
      <TemporalPanel report={report} metric={metric} setMetric={setMetric} detailed />
      <div className="analytics-columns"><Card title="Neto por método" help="Cobrado menos devoluciones de cada método. Una devolución de una venta anterior puede producir un neto negativo."><Suspense fallback={<ChartPlaceholder />}><PaymentNetChart payments={total.payments} /></Suspense><PaymentTable payments={total.payments} /></Card><Card title="Operadores" help="Agrupación por el nombre registrado en la venta. Nombres iguales pueden pertenecer a personas distintas; no mide desempeño laboral."><Operators operators={total.operators} /></Card></div>
    </> : tab === 'products' ? <>
      <Card title="Productos" action={<div className="analytics-metric-switch" role="group" aria-label="Métrica de productos">{([['netCents', 'Neto'], ['quantity', 'Unidades']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={productMetric === value} onClick={() => setProductMetric(value)}>{label}</button>)}</div>}><Suspense fallback={<ChartPlaceholder />}><RankedBars items={ranking.map(product => ({ key: `${product.productId}:${product.name}`, label: product.name, value: product[productMetric] }))} money={productMetric === 'netCents'} /></Suspense></Card>
      <Card title="Detalle de productos" help="Los nombres corresponden al momento de la venta. Las devoluciones aparecen en su fecha efectiva."><ProductTable products={total.products} /></Card>
    </> : <>
      <Card title="Del bruto al neto" help="Bruto menos descuentos es cobrado. Cobrado menos devoluciones es neto. El IVA ya está incluido."><Suspense fallback={<ChartPlaceholder />}><FinancialWaterfall totals={total} /></Suspense><div className="analytics-financial-values">{[['Bruto', total.grossCents], ['Descuentos', total.discountCents], ['Cobrado', total.salesCents], ['Devoluciones', total.reversalCents], ['Neto', total.netCents]].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{money(Number(value))}</strong></div>)}</div></Card>
      <div className="analytics-columns"><Card title="IVA registrado" help="IVA conservado en los recibos, incluido en las ventas. El historial anterior puede no tener un desglose fiscal completo. No se vuelve a restar del neto."><Suspense fallback={<ChartPlaceholder height={180} />}><TaxChart totals={total} /></Suspense><dl className="analytics-stat-list"><div><dt>Cobrado</dt><dd>{money(total.taxCents)}</dd></div><div><dt>Devuelto</dt><dd>{money(total.reversalTaxCents)}</dd></div><div><dt>Neto</dt><dd>{money(total.taxCents - total.reversalTaxCents)}</dd></div></dl></Card><Card title="Condonaciones" help="Saldo perdonado en cuentas, sin dinero cobrado. No se incorpora a ingresos."><div className="analytics-single-number"><AnimatedValue value={money(total.waivedCents)} /><span>Fuera de ingresos</span></div></Card></div>
      <Card title="Diferencias de caja" help="Contado menos esperado por cierre. Tanto faltantes como sobrantes requieren revisión y no representan ingresos.">{total.cashDifferences.length ? <><Suspense fallback={<ChartPlaceholder />}><CashDifferenceChart items={total.cashDifferences} timezone={report.timezone} /></Suspense><CashTable items={total.cashDifferences} timezone={report.timezone} /></> : <p className="analytics-empty">Sin cierres en este período.</p>}</Card>
    </>}
  </div>
}

function DataTransition({ report, identity, detailed, tab, metric, productMetric, setMetric, setProductMetric, onOpenReport }: ReportPresentation & ReportActions & { identity: string }) {
  const [display, setDisplay] = useState({ report, identity, detailed, tab, metric, productMetric })
  const [previous, setPrevious] = useState<ReportPresentation | null>(null)
  const container = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (display.report === report && display.identity === identity && display.metric === metric && display.productMetric === productMetric && display.tab === tab && display.detailed === detailed) return
    setPrevious(display.identity !== identity && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? display : null)
    setDisplay({ report, identity, detailed, tab, metric, productMetric })
  }, [report, identity, display, metric, productMetric, detailed, tab])
  useGSAP(() => {
    if (!previous || !container.current) return
    const incoming = container.current.querySelector('.analytics-incoming'), outgoing = container.current.querySelector('.analytics-outgoing')
    const timeline = gsap.timeline({ onComplete: () => setPrevious(null) })
    timeline.fromTo(incoming, { opacity: 0 }, { opacity: 1, duration: 0.2, clearProps: 'opacity' }, 0)
    timeline.to(outgoing, { opacity: 0, duration: 0.2 }, 0)
  }, { dependencies: [display.identity, previous], scope: container, revertOnUpdate: true })
  return <div className="analytics-data-transition" ref={container}>
    {previous && <div className="analytics-outgoing" aria-hidden="true" inert><ReportBody {...previous} setMetric={setMetric} setProductMetric={setProductMetric} /></div>}
    <div className="analytics-incoming"><ReportBody {...display} setMetric={setMetric} setProductMetric={setProductMetric} onOpenReport={onOpenReport} /></div>
  </div>
}

export default function ReportDashboard({ controller, detailed = false, tab = 'sales', onTabChange, onOpenReport }: {
  controller: ReportController; detailed?: boolean; tab?: ReportTab; onTabChange?: (tab: ReportTab) => void; onOpenReport?: (tab: ReportTab) => void
}) {
  const { report, date, period, displayedQuery, loading, error, stale, setDate, setPeriod, refresh, retry } = controller
  const panelId = useId()
  const [metric, setMetric] = useState<Metric>('salesCents')
  const [productMetric, setProductMetric] = useState<'netCents' | 'quantity'>('netCents')
  useEffect(() => { void charts() }, [])
  const pending = loading && displayedQuery && (displayedQuery.date !== date || displayedQuery.period !== period)
  const range = report ? (() => {
    const format = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
    return report.startDate === report.endDate ? format(report.startDate) : `${format(report.startDate)} — ${format(report.endDate)}`
  })() : ''
  function onTabKey(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (next === null) return
    event.preventDefault(); onTabChange?.(tabs[next][0]); document.getElementById(`${panelId}-${tabs[next][0]}`)?.focus()
  }
  return <div className="analytics-dashboard">
    <div className="analytics-toolbar"><div className="analytics-periods" role="group" aria-label="Período del reporte">{periods.map(([value, label]) => <button type="button" key={value} aria-pressed={(displayedQuery?.period ?? period) === value} data-pending={loading && period === value && displayedQuery?.period !== value || undefined} onClick={() => setPeriod(value)}>{label}</button>)}</div><div className="analytics-date-actions"><label className="analytics-date"><span className="sr-only">Fecha del reporte</span><input type="date" min="2000-01-01" max="2100-12-31" value={date} onChange={event => { if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(event.target.value)) setDate(event.target.value) }} /></label><button type="button" className="pos-icon-button analytics-refresh" aria-label="Actualizar reporte" aria-busy={loading} disabled={loading} onClick={() => void refresh()}><RefreshCw size={20} className={loading ? 'is-loading' : ''} aria-hidden="true" /></button></div></div>
    <div className="analytics-context"><span>{range || ' '}</span>{report && <span className={`analytics-status ${stale ? 'stale' : ''}`}>{stale ? 'Desactualizado' : pending ? 'Cambiando período…' : loading ? 'Actualizando…' : report.partial ? 'En curso' : businessDate(report.timezone, new Date(report.asOf)) < report.startDate ? 'Pendiente' : ''}</span>}<span className="sr-only" role="status" aria-live="polite">{loading ? report ? 'Actualizando información; se conserva el último reporte.' : 'Cargando información.' : ''}</span></div>
    {detailed && <div className="analytics-tabs" role="tablist" aria-label="Secciones de Reportes">{tabs.map(([value, label], index) => <button type="button" id={`${panelId}-${value}`} key={value} role="tab" aria-selected={tab === value} aria-controls={`${panelId}-panel`} tabIndex={tab === value ? 0 : -1} onClick={() => onTabChange?.(value)} onKeyDown={event => onTabKey(event, index)}>{label}</button>)}</div>}
    {error && <div className="analytics-error" role="alert"><span>{error}</span><button type="button" onClick={() => void retry()} disabled={loading}>Reintentar</button></div>}
    {!report && loading && <DashboardSkeleton detailed={detailed} />}
    {report && <div id={detailed ? `${panelId}-panel` : undefined} role={detailed ? 'tabpanel' : undefined} aria-labelledby={detailed ? `${panelId}-${tab}` : undefined} aria-busy={loading}><DataTransition report={report} identity={`${displayedQuery?.date}:${displayedQuery?.period}:${detailed ? `${tab}:${metric === 'saleCount' ? 'count' : 'money'}:${productMetric}` : 'home'}`} detailed={detailed} tab={tab} metric={metric} productMetric={productMetric} setMetric={setMetric} setProductMetric={setProductMetric} onOpenReport={onOpenReport} /><footer className="analytics-updated">Actualizado {new Date(report.asOf).toLocaleString('es-MX', { timeZone: report.timezone, hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' })}</footer></div>}
  </div>
}
