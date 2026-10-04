import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Pie, PieChart,
  ReferenceLine, Tooltip, XAxis, YAxis, matchByDataKey,
} from 'recharts'
import type { BusinessDayReport, BusinessPeriodReport } from '../../lib/operations-contracts'
import { money as formatMoney, number as formatNumber } from '../../lib/format'
import { buildFinancialWaterfallData, buildTemporalChartData, type TemporalDatum, type TemporalMetric, type WaterfallDatum } from './analytics-model'

type Payment = BusinessDayReport['payments'][number]
type CashDifference = BusinessDayReport['cashDifferences'][number]
type TooltipPayload = { active?: boolean; payload?: readonly { payload?: unknown }[] }

const colors = { cash: '#0F766E', card_external: '#2563EB', card_integrated: '#111111', transfer: '#7C3AED', tax: '#B45309', refund: '#DC2626', ink: '#111111', previous: '#8B8B8B' }
const paymentLabels: Record<Payment['paymentMethod'], string> = { cash: 'Efectivo', card_external: 'Tarjeta externa', card_integrated: 'Tarjeta integrada', transfer: 'Transferencia' }
const metricLabels: Record<TemporalMetric, string> = { netCents: 'Ventas netas', salesCents: 'Cobrado', saleCount: 'Cobros' }
const compactCurrency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 1 })
const compactNumber = new Intl.NumberFormat('es-MX', { notation: 'compact', maximumFractionDigits: 1 })
const percentage = new Intl.NumberFormat('es-MX', { style: 'percent', maximumFractionDigits: 1 })
const animation = { animationDuration: 400, animationEasing: 'ease-out' as const }
const axisTick = { fill: '#626262', fontSize: 11, fontFamily: 'IBM Plex Sans, sans-serif' }

function moneyTick(value: number): string { return compactCurrency.format(value / 100) }
function countTick(value: number): string { return compactNumber.format(value) }
function metricValue(value: number | null, metric: TemporalMetric): string { return value === null ? '—' : metric === 'saleCount' ? formatNumber(value) : formatMoney(value) }
function intervalLabel(point: TemporalDatum['currentPoint'], timezone: string): string {
  if (!point) return 'Sin dato'
  const formatter = new Intl.DateTimeFormat('es-MX', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' })
  return `${formatter.format(new Date(point.start))} – ${formatter.format(new Date(point.end))}`
}

function isolatedPointDot(data: TemporalDatum[], series: 'current' | 'previous', color: string) {
  return ({ cx, cy, payload }: { cx?: number; cy?: number; payload?: unknown }) => {
    const point = payload as TemporalDatum | undefined
    const index = data.findIndex(item => item.slot === point?.slot)
    const isolated = index >= 0 && data[index][series] !== null &&
      (index === 0 || data[index - 1][series] === null) &&
      (index === data.length - 1 || data[index + 1][series] === null)
    return <circle className={`analytics-${series}-dot`} cx={cx} cy={cy} r={isolated ? 3 : 0} fill={color} />
  }
}

function ChartFrame({ fingerprint, revision, identity = '', animateInitial = false, height = 260, children, label }: {
  fingerprint: string; revision: unknown; identity?: string; animateInitial?: boolean; height?: number; label: string; children: (width: number, height: number, animate: boolean) => ReactNode
}) {
  const element = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const motion = useRef({ fingerprint, revision, identity, width: 0, height, animate: animateInitial })
  useLayoutEffect(() => {
    const container = element.current
    if (!container) return
    const measure = () => setWidth(previous => {
      const next = Math.round(container.getBoundingClientRect().width)
      return previous === next ? previous : next
    })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(preference.matches)
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])
  if (motion.current.identity !== identity) motion.current = { fingerprint, revision, identity, width, height, animate: false }
  else if (motion.current.fingerprint !== fingerprint) motion.current = { fingerprint, revision, identity, width, height, animate: true }
  else if (motion.current.width !== width || motion.current.height !== height) motion.current = { fingerprint, revision, identity, width, height, animate: motion.current.width === 0 && animateInitial }
  else if (motion.current.revision !== revision) motion.current = { fingerprint, revision, identity, width, height, animate: false }
  return <div ref={element} className="analytics-chart" style={{ width: '100%', minWidth: 0, height }} aria-label={label}>
    {width > 0 && children(width, height, motion.current.animate && !reducedMotion)}
  </div>
}

function TooltipBox({ title, children }: { title: string; children: ReactNode }) {
  return <div className="analytics-tooltip"><p className="analytics-tooltip-title">{title}</p>{children}</div>
}

function TooltipLine({ label, value, color }: { label: string; value: string; color?: string }) {
  return <div className="analytics-tooltip-line"><span>{color && <span className="analytics-color-dot" style={{ background: color }} aria-hidden="true" />}{label}</span><strong>{value}</strong></div>
}

function TemporalTooltip({ active, payload, metric, timezone }: TooltipPayload & { metric: TemporalMetric; timezone: string }) {
  const datum = payload?.[0]?.payload as TemporalDatum | undefined
  if (!active || !datum) return null
  return <TooltipBox title={metricLabels[metric]}>
    <TooltipLine label={intervalLabel(datum.currentPoint, timezone)} value={metricValue(datum.current, metric)} color={colors.card_external} />
    {datum.currentPartial && <small>Intervalo en curso</small>}
    {datum.previousPoint && <TooltipLine label={intervalLabel(datum.previousPoint, timezone)} value={metricValue(datum.previous, metric)} color={colors.previous} />}
    {datum.previousPartial && <small>Comparación hasta el mismo avance</small>}
  </TooltipBox>
}

export const TemporalChart = memo(function TemporalChart({ report, metric, animateInitial = false }: { report: BusinessPeriodReport; metric: TemporalMetric; animateInitial?: boolean }) {
  const data = useMemo(() => buildTemporalChartData(report, metric), [report, metric])
  const fingerprint = JSON.stringify(data.map(point => [point.slot, point.current, point.previous]))
  const monetary = metric !== 'saleCount'
  const hasCurrent = data.some(point => point.current !== null)
  const hasPrevious = report.comparisonComparable && data.some(point => point.previous !== null)
  const currentDot = isolatedPointDot(data, 'current', colors.card_external)
  const previousDot = isolatedPointDot(data, 'previous', colors.previous)
  const ticks = useMemo(() => data.filter((_, index) => index === 0 || index === data.length - 1 || index % Math.max(1, Math.ceil(data.length / 6)) === 0).map(point => point.slot), [data])
  const labels = useMemo(() => new Map(data.map(point => [point.slot, point.label])), [data])
  const identity = `${report.period}:${report.startDate}:${report.endDate}:${report.timezone}:${monetary ? 'money' : 'count'}`
  return <>
    <ChartFrame fingerprint={fingerprint} revision={data} identity={identity} animateInitial={animateInitial} label={`${metricLabels[metric]} ${report.period === 'day' ? 'por hora' : 'por día'}`}>
      {(width, height, animate) => <AreaChart key={identity} width={width} height={height} data={data} accessibilityLayer margin={{ top: 16, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid vertical={false} stroke="#E4E4E4" strokeDasharray="3 5" />
        <XAxis dataKey="slot" ticks={ticks} tickFormatter={(slot: string) => labels.get(slot) ?? slot} tick={axisTick} axisLine={false} tickLine={false} minTickGap={12} />
        <YAxis tickFormatter={monetary ? moneyTick : countTick} tick={axisTick} axisLine={false} tickLine={false} width={58} domain={[(minimum: number) => Math.min(0, minimum), (maximum: number) => Math.max(maximum, 1)]} allowDecimals={monetary} />
        <ReferenceLine y={0} stroke="#C9C9C9" />
        <Tooltip content={props => <TemporalTooltip active={props.active} payload={props.payload} metric={metric} timezone={report.timezone} />} trigger={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? 'click' : 'hover'} isAnimationActive={false} cursor={{ stroke: '#B8B8B8', strokeDasharray: '4 4' }} />
        {hasPrevious && <Area<TemporalDatum, number | null> className="analytics-previous-series" dataKey="previous" name="Período anterior" type="linear" stroke={colors.previous} strokeWidth={1.5} strokeDasharray="5 5" fill="transparent" connectNulls={false} dot={previousDot} activeDot={{ r: 4 }} {...animation} animationMatchBy={matchByDataKey('slot')} isAnimationActive={animate} />}
        <Area<TemporalDatum, number | null> className="analytics-current-series" dataKey="current" name={metricLabels[metric]} type="linear" stroke={colors.card_external} strokeWidth={2.5} fill={colors.card_external} fillOpacity={0.055} connectNulls={false} dot={currentDot} activeDot={{ r: 5, stroke: '#FFFFFF', strokeWidth: 2 }} {...animation} animationMatchBy={matchByDataKey('slot')} isAnimationActive={animate} />
      </AreaChart>}
    </ChartFrame>
    {!hasCurrent && <p className="analytics-chart-empty">Sin datos en este período</p>}
    <details className="analytics-chart-data"><summary>Ver datos</summary><table><caption className="sr-only">{metricLabels[metric]} por intervalo</caption><thead><tr><th scope="col">Intervalo</th><th scope="col">Actual</th>{hasPrevious && <th scope="col">Anterior</th>}</tr></thead><tbody>{data.map(point => <tr key={point.slot}><th scope="row">{intervalLabel(point.currentPoint ?? point.previousPoint, report.timezone)}{point.currentPartial && ' · En curso'}</th><td>{metricValue(point.current, metric)}</td>{hasPrevious && <td><span>{metricValue(point.previous, metric)}</span><small>{intervalLabel(point.previousPoint, report.timezone)}{point.previousPartial && ' · Parcial'}</small></td>}</tr>)}</tbody></table></details>
  </>
})

function PaymentTooltip({ active, payload, net = false }: TooltipPayload & { net?: boolean }) {
  const payment = payload?.[0]?.payload as Payment | undefined
  if (!active || !payment) return null
  return <TooltipBox title={paymentLabels[payment.paymentMethod]}>
    <TooltipLine label="Cobrado" value={formatMoney(payment.salesCents)} color={colors[payment.paymentMethod]} />
    {net && <><TooltipLine label="Devoluciones" value={formatMoney(payment.reversalCents)} color={colors.refund} /><TooltipLine label="Neto" value={formatMoney(payment.netCents)} /></>}
  </TooltipBox>
}

export const PaymentMixChart = memo(function PaymentMixChart({ payments }: { payments: Payment[] }) {
  const data = useMemo(() => payments.filter(payment => payment.salesCents > 0), [payments])
  const total = data.reduce((sum, payment) => sum + payment.salesCents, 0)
  if (total === 0) return <p className="analytics-chart-empty">Sin cobros</p>
  return <>
    <ChartFrame height={180} fingerprint={JSON.stringify(data)} revision={data} label="Distribución de cobros por método de pago">
      {(width, height, animate) => <PieChart width={width} height={height} accessibilityLayer>
        <Pie<Payment> data={data} dataKey="salesCents" nameKey="paymentMethod" innerRadius={56} outerRadius={76} paddingAngle={data.length > 1 ? 3 : 0} cornerRadius={3} stroke="none" {...animation} animationMatchBy={matchByDataKey('paymentMethod')} isAnimationActive={animate}>
          {data.map(payment => <Cell key={payment.paymentMethod} fill={colors[payment.paymentMethod]} />)}
        </Pie>
        <Tooltip content={props => <PaymentTooltip active={props.active} payload={props.payload} />} trigger={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? 'click' : 'hover'} isAnimationActive={false} />
      </PieChart>}
    </ChartFrame>
    <ul className="analytics-mix-summary">{data.map(payment => <li key={payment.paymentMethod}><span><span className="analytics-color-dot" style={{ background: colors[payment.paymentMethod] }} aria-hidden="true" />{paymentLabels[payment.paymentMethod]}</span><span>{percentage.format(payment.salesCents / total)}</span><strong>{formatMoney(payment.salesCents)}</strong></li>)}</ul>
  </>
})

export const PaymentNetChart = memo(function PaymentNetChart({ payments }: { payments: Payment[] }) {
  const data = useMemo(() => payments.map(payment => ({ ...payment, label: paymentLabels[payment.paymentMethod] })), [payments])
  if (!data.length) return <p className="analytics-chart-empty">Sin movimientos</p>
  return <ChartFrame height={200} fingerprint={JSON.stringify(data)} revision={data} label="Cobros netos por método de pago">
    {(width, height, animate) => <BarChart width={width} height={height} data={data} layout="vertical" accessibilityLayer margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
      <CartesianGrid horizontal={false} stroke="#E4E4E4" strokeDasharray="3 5" />
      <XAxis type="number" tickFormatter={moneyTick} tick={axisTick} axisLine={false} tickLine={false} domain={[(minimum: number) => Math.min(0, minimum), (maximum: number) => Math.max(maximum, 1)]} />
      <YAxis type="category" dataKey="label" width={100} tick={axisTick} axisLine={false} tickLine={false} />
      <ReferenceLine x={0} stroke="#C9C9C9" />
      <Tooltip content={props => <PaymentTooltip active={props.active} payload={props.payload} net />} trigger={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? 'click' : 'hover'} isAnimationActive={false} cursor={{ fill: '#F6F6F6' }} />
      <Bar dataKey="netCents" name="Neto" maxBarSize={24} radius={3} {...animation} animationMatchBy={matchByDataKey('paymentMethod')} isAnimationActive={animate}>{data.map(payment => <Cell key={payment.paymentMethod} fill={colors[payment.paymentMethod]} />)}</Bar>
    </BarChart>}
  </ChartFrame>
})

export interface RankedBarItem { key: string; label: string; value: number }
function RankTooltip({ active, payload, monetary }: TooltipPayload & { monetary: boolean }) {
  const item = payload?.[0]?.payload as RankedBarItem | undefined
  if (!active || !item) return null
  return <TooltipBox title={item.label}><TooltipLine label={monetary ? 'Importe' : 'Cantidad'} value={monetary ? formatMoney(item.value) : formatNumber(item.value)} /></TooltipBox>
}

export const RankedBars = memo(function RankedBars({ items, money = false }: { items: RankedBarItem[]; money?: boolean }) {
  if (!items.length) return <p className="analytics-chart-empty">Sin datos</p>
  const identity = money ? 'money' : 'count'
  return <ChartFrame height={Math.max(180, items.length * 42 + 38)} fingerprint={JSON.stringify(items)} revision={items} identity={identity} label={money ? 'Ranking por importe' : 'Ranking por cantidad'}>
    {(width, height, animate) => <BarChart key={identity} width={width} height={height} data={items} layout="vertical" accessibilityLayer margin={{ top: 8, right: money ? 84 : 48, left: 0, bottom: 8 }}>
      <XAxis type="number" hide domain={[(minimum: number) => Math.min(0, minimum), (maximum: number) => Math.max(maximum, 1)]} />
      <YAxis type="category" dataKey="label" width={Math.min(140, Math.round(width * 0.36))} tickFormatter={(label: string) => label.length > 22 ? `${label.slice(0, 21)}…` : label} tick={axisTick} axisLine={false} tickLine={false} />
      <ReferenceLine x={0} stroke="#E4E4E4" />
      <Tooltip content={props => <RankTooltip active={props.active} payload={props.payload} monetary={money} />} trigger={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? 'click' : 'hover'} isAnimationActive={false} cursor={{ fill: '#F6F6F6' }} />
      <Bar dataKey="value" name={money ? 'Importe' : 'Cantidad'} maxBarSize={18} radius={3} {...animation} animationMatchBy={matchByDataKey('key')} isAnimationActive={animate}>
        {items.map(item => <Cell key={item.key} fill={item.value < 0 ? colors.refund : colors.ink} />)}
        <LabelList dataKey="value" position="right" formatter={(value: unknown) => money ? moneyTick(Number(value)) : countTick(Number(value))} style={{ ...axisTick, fill: colors.ink }} />
      </Bar>
    </BarChart>}
  </ChartFrame>
})

function FinancialTooltip({ active, payload }: TooltipPayload) {
  const item = payload?.[0]?.payload as WaterfallDatum | undefined
  if (!active || !item) return null
  return <TooltipBox title={item.label}><TooltipLine label={item.subtotal ? 'Total' : 'Ajuste'} value={formatMoney(item.value)} /></TooltipBox>
}

export const FinancialWaterfall = memo(function FinancialWaterfall({ totals }: { totals: BusinessDayReport }) {
  const data = useMemo(() => buildFinancialWaterfallData(totals), [totals])
  return <ChartFrame fingerprint={JSON.stringify(data)} revision={data} label="De ventas brutas a ventas netas">
    {(width, height, animate) => <BarChart width={width} height={height} data={data} accessibilityLayer margin={{ top: 24, right: 8, bottom: 12, left: 0 }}>
      <CartesianGrid vertical={false} stroke="#E4E4E4" strokeDasharray="3 5" />
      <XAxis dataKey="label" tick={{ ...axisTick, fontSize: width < 480 ? 9 : 11 }} interval={0} axisLine={false} tickLine={false} />
      <YAxis tickFormatter={moneyTick} tick={axisTick} width={58} axisLine={false} tickLine={false} domain={[(minimum: number) => Math.min(0, minimum), (maximum: number) => Math.max(maximum, 1)]} />
      <ReferenceLine y={0} stroke="#C9C9C9" />
      <Tooltip content={props => <FinancialTooltip active={props.active} payload={props.payload} />} trigger={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? 'click' : 'hover'} isAnimationActive={false} cursor={{ fill: '#F6F6F6' }} />
      <Bar dataKey="range" name="Importe" maxBarSize={56} radius={3} {...animation} animationMatchBy={matchByDataKey('key')} isAnimationActive={animate}>{data.map(item => <Cell key={item.key} fill={item.subtotal ? item.key === 'net' ? colors.cash : colors.ink : colors.refund} />)}</Bar>
    </BarChart>}
  </ChartFrame>
})

export const TaxChart = memo(function TaxChart({ totals }: { totals: BusinessDayReport }) {
  const items = useMemo(() => [
    { key: 'sales', label: 'IVA ventas', value: totals.taxCents, color: colors.tax },
    { key: 'returns', label: 'IVA devuelto', value: -totals.reversalTaxCents, color: colors.refund },
    { key: 'net', label: 'IVA neto', value: totals.taxCents - totals.reversalTaxCents, color: colors.tax },
  ], [totals.taxCents, totals.reversalTaxCents])
  return <ChartFrame height={200} fingerprint={JSON.stringify(items)} revision={items} label="IVA conocido de ventas y devoluciones">
    {(width, height, animate) => <BarChart width={width} height={height} data={items} layout="vertical" accessibilityLayer margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
      <CartesianGrid horizontal={false} stroke="#E4E4E4" strokeDasharray="3 5" />
      <XAxis type="number" tickFormatter={moneyTick} tick={axisTick} axisLine={false} tickLine={false} domain={[(minimum: number) => Math.min(0, minimum), (maximum: number) => Math.max(maximum, 1)]} />
      <YAxis type="category" dataKey="label" tick={axisTick} width={100} axisLine={false} tickLine={false} />
      <ReferenceLine x={0} stroke="#C9C9C9" />
      <Tooltip content={props => <RankTooltip active={props.active} payload={props.payload} monetary />} trigger={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? 'click' : 'hover'} isAnimationActive={false} cursor={{ fill: '#F6F6F6' }} />
      <Bar dataKey="value" name="IVA conocido" maxBarSize={24} radius={3} {...animation} animationMatchBy={matchByDataKey('key')} isAnimationActive={animate}>{items.map(item => <Cell key={item.key} fill={item.color} />)}</Bar>
    </BarChart>}
  </ChartFrame>
})

function CashTooltip({ active, payload, timezone }: TooltipPayload & { timezone: string }) {
  const item = payload?.[0]?.payload as CashDifference | undefined
  if (!active || !item) return null
  const timestamp = new Intl.DateTimeFormat('es-MX', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.closedAt))
  return <TooltipBox title={timestamp}><TooltipLine label="Esperado" value={formatMoney(item.expectedCents)} /><TooltipLine label="Contado" value={formatMoney(item.countedCents)} /><TooltipLine label="Diferencia" value={formatMoney(item.differenceCents)} color={item.differenceCents < 0 ? colors.refund : colors.tax} /></TooltipBox>
}

export const CashDifferenceChart = memo(function CashDifferenceChart({ items, timezone }: { items: CashDifference[]; timezone: string }) {
  const data = useMemo(() => [...items].sort((a, b) => a.closedAt.localeCompare(b.closedAt) || a.shiftId.localeCompare(b.shiftId)), [items])
  const formatter = useMemo(() => new Intl.DateTimeFormat('es-MX', { timeZone: timezone, day: 'numeric', month: 'short' }), [timezone])
  if (!data.length) return <p className="analytics-chart-empty">Sin cierres</p>
  return <ChartFrame fingerprint={JSON.stringify(data)} revision={data} label="Diferencias entre efectivo esperado y contado por cierre">
    {(width, height, animate) => <BarChart width={width} height={height} data={data} accessibilityLayer margin={{ top: 16, right: 8, bottom: 8, left: 0 }}>
      <CartesianGrid vertical={false} stroke="#E4E4E4" strokeDasharray="3 5" />
      <XAxis dataKey="closedAt" tickFormatter={(value: string) => formatter.format(new Date(value))} tick={axisTick} axisLine={false} tickLine={false} minTickGap={20} />
      <YAxis tickFormatter={moneyTick} tick={axisTick} width={58} axisLine={false} tickLine={false} domain={[(minimum: number) => Math.min(0, minimum), (maximum: number) => Math.max(maximum, 1)]} />
      <ReferenceLine y={0} stroke="#C9C9C9" />
      <Tooltip content={props => <CashTooltip active={props.active} payload={props.payload} timezone={timezone} />} trigger={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches ? 'click' : 'hover'} isAnimationActive={false} cursor={{ fill: '#F6F6F6' }} />
      <Bar dataKey="differenceCents" name="Diferencia" maxBarSize={32} radius={3} {...animation} animationMatchBy={matchByDataKey('shiftId')} isAnimationActive={animate}>{data.map(item => <Cell key={item.shiftId} fill={item.differenceCents < 0 ? colors.refund : colors.tax} />)}</Bar>
    </BarChart>}
  </ChartFrame>
})
