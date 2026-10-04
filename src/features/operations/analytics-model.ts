import type { BusinessDayReport, BusinessPeriodReport } from '../../lib/operations-contracts'

export type TemporalMetric = 'netCents' | 'salesCents' | 'saleCount'
type TemporalPoint = BusinessPeriodReport['series'][number]

export interface TemporalDatum {
  slot: string
  label: string
  current: number | null
  previous: number | null
  currentPoint: TemporalPoint | null
  previousPoint: TemporalPoint | null
  currentPartial: boolean
  previousPartial: boolean
}

function observedValue(point: TemporalPoint | undefined, cutoff: string, metric: TemporalMetric): number | null {
  // SQL marks exact boundaries; Date truncates the cutoff's microseconds.
  if (!point || point.future || new Date(point.start).getTime() > new Date(cutoff).getTime()) return null
  return point[metric]
}

function partialPoint(point: TemporalPoint | undefined, cutoff: string): boolean {
  if (!point || point.future) return false
  const instant = new Date(cutoff).getTime()
  return new Date(point.start).getTime() < instant && instant < new Date(point.end).getTime()
}

export function buildTemporalChartData(report: BusinessPeriodReport, metric: TemporalMetric): TemporalDatum[] {
  const current = new Map(report.series.map(point => [point.slot, point]))
  const previous = new Map(report.comparisonComparable ? report.previousSeries.map(point => [point.slot, point]) : [])
  const slots = [...new Set([...current.keys(), ...previous.keys()])].sort((a, b) => a.localeCompare(b))
  const repeatedHours = new Set(slots.filter(slot => slot.startsWith('hour:') && !slot.endsWith(':0')).map(slot => slot.slice(0, -2)))
  const dayLabel = new Intl.DateTimeFormat('es-MX', { timeZone: report.timezone, weekday: 'short' })
  const offsetLabel = new Intl.DateTimeFormat('es-MX', { timeZone: report.timezone, timeZoneName: 'shortOffset' })
  return slots.map(slot => {
    const point = current.get(slot)
    const comparison = previous.get(slot)
    const labelPoint = point ?? comparison
    let label = labelPoint?.label ?? slot
    if (report.period === 'week' && labelPoint) label = dayLabel.format(new Date(labelPoint.start)).replace('.', '')
    if (report.period === 'month') label = String(Number(slot.replace('day:', '')))
    if (report.period === 'day' && repeatedHours.has(slot.slice(0, -2)) && labelPoint) {
      const offset = offsetLabel.formatToParts(new Date(labelPoint.start)).find(part => part.type === 'timeZoneName')?.value
      if (offset) label = `${label} ${offset}`
    }
    return {
      slot, label,
      current: observedValue(point, report.cutoff, metric),
      previous: report.comparisonComparable ? observedValue(comparison, report.previousCutoff, metric) : null,
      currentPoint: point ?? null,
      previousPoint: comparison ?? null,
      currentPartial: partialPoint(point, report.cutoff),
      previousPartial: partialPoint(comparison, report.previousCutoff),
    }
  })
}

/** Inicio follows today's observed activity; unobserved hours are never drawn as zero. */
export function buildDailySalesChartData(report: BusinessPeriodReport): TemporalDatum[] {
  return buildTemporalChartData(report, 'netCents').filter(point => point.currentPoint && point.current !== null)
}

export function temporalTicks(data: TemporalDatum[], width: number): string[] {
  if (data.length < 2) return data.map(point => point.slot)
  const count = Math.min(data.length, Math.max(2, Math.min(6, Math.floor(width / 110))))
  return Array.from({ length: count }, (_, index) => data[Math.round(index * (data.length - 1) / (count - 1))].slot)
}

export interface WaterfallDatum {
  key: string
  label: string
  value: number
  range: [number, number]
  subtotal: boolean
}

export function buildFinancialWaterfallData(totals: BusinessDayReport): WaterfallDatum[] {
  const entries = [
    { key: 'gross', label: 'Bruto', value: totals.grossCents, from: 0, to: totals.grossCents, subtotal: true },
    { key: 'discounts', label: 'Descuentos', value: -totals.discountCents, from: totals.grossCents, to: totals.grossCents - totals.discountCents, subtotal: false },
    { key: 'collected', label: 'Cobrado', value: totals.salesCents, from: 0, to: totals.salesCents, subtotal: true },
    { key: 'refunds', label: 'Devoluciones', value: -totals.reversalCents, from: totals.salesCents, to: totals.salesCents - totals.reversalCents, subtotal: false },
    { key: 'net', label: 'Neto', value: totals.netCents, from: 0, to: totals.netCents, subtotal: true },
  ]
  return entries.map(({ from, to, ...entry }) => ({ ...entry, range: [Math.min(from, to), Math.max(from, to)] }))
}
