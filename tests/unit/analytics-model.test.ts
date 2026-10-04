import { expect, test } from 'vitest'
import type { BusinessDayReport, BusinessPeriodReport, ReportSeriesPoint } from '../../src/lib/operations-contracts'
import { buildDailySalesChartData, buildFinancialWaterfallData, buildTemporalChartData, temporalTicks } from '../../src/features/operations/analytics-model'

const totals: BusinessDayReport = {
  date: '2026-02-01', timezone: 'America/Chicago', grossCents: 0, discountCents: 0, salesCents: 0,
  taxCents: 0, reversalCents: 0, reversalTaxCents: 0, netCents: 0, waivedCents: 0, saleCount: 0,
  payments: [], operators: [], products: [], cashDifferences: [],
}

function point(slot: string, start: string, values: Partial<ReportSeriesPoint> = {}): ReportSeriesPoint {
  return { slot, start, end: new Date(new Date(start).getTime() + 3_600_000).toISOString(), label: '01:00', salesCents: 0, reversalCents: 0, netCents: 0, saleCount: 0, future: false, ...values }
}

function report(values: Partial<BusinessPeriodReport> = {}): BusinessPeriodReport {
  return {
    period: 'month', startDate: '2026-02-01', endDate: '2026-02-28', timezone: 'America/Chicago', partial: false,
    comparisonStartDate: '2026-01-01', comparisonEndDate: '2026-01-31', comparisonComparable: true,
    asOf: '2026-03-01T06:00:00Z', cutoff: '2026-03-01T06:00:00Z', previousCutoff: '2026-02-01T06:00:00Z',
    totals, previous: totals, series: [], previousSeries: [], ...values,
  }
}

test('temporal alignment preserves observed zero and distinguishes missing and future buckets', () => {
  const data = buildTemporalChartData(report({
    series: [point('day:01', '2026-02-01T06:00:00Z'), point('day:03', '2026-02-03T06:00:00Z', { future: true })],
    previousSeries: [point('day:02', '2026-01-02T06:00:00Z', { salesCents: 500 })],
  }), 'salesCents')
  expect(data.map(item => [item.slot, item.current, item.previous])).toEqual([
    ['day:01', 0, null], ['day:02', null, 500], ['day:03', null, null],
  ])
})

test('incomparable periods do not contribute previous values or buckets', () => {
  const data = buildTemporalChartData(report({
    comparisonComparable: false,
    series: [point('day:01', '2026-02-01T06:00:00Z', { saleCount: 2 })],
    previousSeries: [point('day:02', '2026-01-02T06:00:00Z', { saleCount: 7 })],
  }), 'saleCount')
  expect(data).toHaveLength(1)
  expect(data[0].current).toBe(2)
  expect(data[0].previous).toBeNull()
  expect(data[0].previousPoint).toBeNull()
})

test('the server future flag preserves submillisecond observed intervals at a cutoff boundary', () => {
  const series = [point('hour:00:00:0', '2026-02-01T06:00:00Z')]
  const observed = buildTemporalChartData(report({ period: 'day', cutoff: '2026-02-01T06:00:00.000001Z', series }), 'netCents')
  const future = buildTemporalChartData(report({ period: 'day', cutoff: '2026-02-01T06:00:00Z', series: [{ ...series[0], future: true }] }), 'netCents')
  expect(observed[0].current).toBe(0)
  expect(future[0].current).toBeNull()
})

test('cutoff retains partial intervals, negative net values, and ignores later intervals', () => {
  const data = buildTemporalChartData(report({
    period: 'day', cutoff: '2026-02-01T06:30:00Z', previousCutoff: '2026-01-01T06:30:00Z',
    series: [point('hour:00:00:0', '2026-02-01T06:00:00Z', { netCents: -400 }), point('hour:01:00:0', '2026-02-01T07:00:00Z', { netCents: 900 })],
    previousSeries: [point('hour:00:00:0', '2026-01-01T06:00:00Z', { netCents: 600 })],
  }), 'netCents')
  expect(data[0].current).toBe(-400)
  expect(data[0].previous).toBe(600)
  expect(data[0].currentPartial).toBe(true)
  expect(data[0].previousPartial).toBe(true)
  expect(data[1].current).toBeNull()
})

test('unequal month lengths leave extra previous days absent in the current series', () => {
  const data = buildTemporalChartData(report({
    series: [point('day:28', '2026-02-28T06:00:00Z', { salesCents: 100 })],
    previousSeries: [point('day:31', '2026-01-31T06:00:00Z', { salesCents: 200 })],
  }), 'salesCents')
  expect(data.map(item => [item.label, item.current, item.previous])).toEqual([['28', 100, null], ['31', null, 200]])
})

test('repeated local hours remain separate and include offsets in chart labels', () => {
  const data = buildTemporalChartData(report({
    period: 'day', cutoff: '2026-11-02T06:00:00Z',
    series: [point('hour:01:00:0', '2026-11-01T06:00:00Z', { salesCents: 100 }), point('hour:01:00:1', '2026-11-01T07:00:00Z', { salesCents: 200 })],
  }), 'salesCents')
  expect(data.map(item => item.current)).toEqual([100, 200])
  expect(data[0].label).toContain('GMT-5')
  expect(data[1].label).toContain('GMT-6')
})

test('financial waterfall keeps exact cents and includes refunds crossing below zero', () => {
  const data = buildFinancialWaterfallData({ ...totals, grossCents: 900, discountCents: 200, salesCents: 700, reversalCents: 1000, netCents: -300 })
  expect(data.map(item => item.value)).toEqual([900, -200, 700, -1000, -300])
  expect(data.find(item => item.key === 'refunds')?.range).toEqual([-300, 700])
  expect(data.find(item => item.key === 'net')?.range).toEqual([-300, 0])
})

test('today shows observed hours, exact negative net and zero without future or previous-only slots', () => {
  const data = buildDailySalesChartData(report({
    period: 'day', cutoff: '2026-02-01T07:30:00Z',
    series: [
      point('hour:00:00:0', '2026-02-01T06:00:00Z', { netCents: -400 }),
      point('hour:01:00:0', '2026-02-01T07:00:00Z'),
      point('hour:02:00:0', '2026-02-01T08:00:00Z', { future: true }),
    ],
    previousSeries: [point('hour:03:00:0', '2026-01-01T09:00:00Z', { netCents: 800 })],
  }))
  expect(data.map(item => [item.slot, item.current])).toEqual([['hour:00:00:0', -400], ['hour:01:00:0', 0]])
  expect(data[1].currentPartial).toBe(true)
})

test('axis ticks adapt to available width and preserve the first and last real intervals', () => {
  const data = buildDailySalesChartData(report({ period: 'day', series: Array.from({ length: 12 }, (_, hour) => point(`hour:${String(hour).padStart(2, '0')}:00:0`, `2026-02-01T${String(hour + 6).padStart(2, '0')}:00:00Z`)) }))
  const small = temporalTicks(data, 240), large = temporalTicks(data, 900)
  expect(small).toEqual([data[0].slot, data[data.length - 1].slot])
  expect(large).toHaveLength(6)
  expect(new Set(large).size).toBe(6)
  expect(large[0]).toBe(data[0].slot)
  expect(large.at(-1)).toBe(data.at(-1)?.slot)
  expect(temporalTicks([], 400)).toEqual([])
  expect(temporalTicks(data.slice(0, 1), 400)).toEqual([data[0].slot])
})
