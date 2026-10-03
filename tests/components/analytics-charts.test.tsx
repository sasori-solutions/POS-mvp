// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { BusinessDayReport, BusinessPeriodReport, ReportSeriesPoint } from '../../src/lib/operations-contracts'
import { PaymentMixChart, TemporalChart } from '../../src/features/operations/AnalyticsCharts'

const totals: BusinessDayReport = {
  date: '2026-10-03', timezone: 'UTC', grossCents: 0, discountCents: 0, salesCents: 0,
  taxCents: 0, reversalCents: 0, reversalTaxCents: 0, netCents: 0, waivedCents: 0, saleCount: 0,
  payments: [], operators: [], products: [], cashDifferences: [],
}
const point = (slot: string, start: string, values: Partial<ReportSeriesPoint> = {}): ReportSeriesPoint => ({
  slot, start, end: new Date(new Date(start).getTime() + 3_600_000).toISOString(), label: slot.slice(5, -2),
  salesCents: 0, reversalCents: 0, netCents: 0, saleCount: 0, future: false, ...values,
})
const report = (values: Partial<BusinessPeriodReport> = {}): BusinessPeriodReport => ({
  period: 'day', startDate: '2026-10-03', endDate: '2026-10-03', timezone: 'UTC', partial: true,
  comparisonStartDate: '2026-10-02', comparisonEndDate: '2026-10-02', comparisonComparable: false,
  asOf: '2026-10-03T03:00:00Z', cutoff: '2026-10-03T03:00:00Z', previousCutoff: '2026-10-02T03:00:00Z',
  totals, previous: totals, series: [], previousSeries: [], ...values,
})

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0))
  vi.stubGlobal('cancelAnimationFrame', (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 260, width: 600, height: 260, toJSON() {} })
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } })))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

test('chart data table preserves negative cents, observed zero and absence of future values', async () => {
  const view = render(<TemporalChart metric="netCents" report={report({ series: [
    point('hour:00:00:0', '2026-10-03T00:00:00Z', { netCents: -123 }),
    point('hour:01:00:0', '2026-10-03T01:00:00Z'),
    point('hour:04:00:0', '2026-10-03T04:00:00Z', { future: true }),
  ] })} />)
  fireEvent.click(screen.getByText('Ver datos'))
  expect(screen.getByText('-$1.23')).toBeTruthy()
  expect(screen.getByText('$0.00')).toBeTruthy()
  expect(screen.getByText('—')).toBeTruthy()
  expect(screen.queryByRole('columnheader', { name: 'Anterior' })).toBeNull()
  await waitFor(() => expect(view.container.querySelector('svg.recharts-surface')).toBeTruthy())
  expect(view.container.querySelector('svg.recharts-surface')?.getAttribute('tabindex')).toBe('0')
})

test('keyboard chart navigation exposes an exact monetary tooltip', async () => {
  const view = render(<TemporalChart metric="netCents" report={report({ series: [
    point('hour:00:00:0', '2026-10-03T00:00:00Z', { netCents: 1234 }),
    point('hour:01:00:0', '2026-10-03T01:00:00Z', { netCents: 5678 }),
  ] })} />)
  const chart = await screen.findByRole('application')
  fireEvent.focus(chart)
  fireEvent.keyDown(chart, { key: 'ArrowRight' })
  await waitFor(() => expect(view.container.querySelector('.analytics-tooltip')?.textContent).toContain('$56.78'))
})

test('touch interaction exposes a persistent tooltip without requiring hover', async () => {
  vi.mocked(window.matchMedia).mockImplementation(query => ({ matches: query.includes('prefers-reduced-motion') || query.includes('pointer: coarse'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false }, onchange: null }))
  const view = render(<TemporalChart metric="salesCents" report={report({ series: [
    point('hour:00:00:0', '2026-10-03T00:00:00Z', { salesCents: 1234 }),
    point('hour:01:00:0', '2026-10-03T01:00:00Z', { salesCents: 5678 }),
  ] })} />)
  const chart = await screen.findByRole('application')
  fireEvent.click(chart, { clientX: 560, clientY: 60 })
  await waitFor(() => expect(view.container.querySelector('.analytics-tooltip')?.textContent).toContain('$56.78'))
  fireEvent.mouseLeave(chart)
  expect(view.container.querySelector('.analytics-tooltip')?.textContent).toContain('$56.78')
})

test('one observed interval remains visible even when the rest of the day is future', async () => {
  const view = render(<TemporalChart metric="netCents" report={report({ series: [
    point('hour:00:00:0', '2026-10-03T00:00:00Z', { netCents: 1234 }),
    point('hour:04:00:0', '2026-10-03T04:00:00Z', { future: true }),
  ] })} />)
  await waitFor(() => expect(view.container.querySelector('.recharts-area-dots circle')).toBeTruthy())
})

test('isolated observations on either side of a missing bucket remain visible', async () => {
  const view = render(<TemporalChart metric="netCents" report={report({ comparisonComparable: true, series: [
    point('hour:00:00:0', '2026-10-03T00:00:00Z', { netCents: 1234 }),
    point('hour:02:00:0', '2026-10-03T02:00:00Z', { netCents: 5678 }),
  ], previousSeries: [point('hour:01:00:0', '2026-10-02T01:00:00Z', { netCents: 2500 })] })} />)
  await waitFor(() => expect(view.container.querySelectorAll('.analytics-current-dot[r="3"]')).toHaveLength(2))
})

test('a refund-only payment mix does not invent a collection share or chart', () => {
  const view = render(<PaymentMixChart payments={[{ paymentMethod: 'cash', salesCents: 0, reversalCents: 200, netCents: -200 }]} />)
  expect(screen.getByText('Sin cobros')).toBeTruthy()
  expect(view.container.querySelector('svg')).toBeNull()
})

test('payment shares retain exact amounts and the established method colors', () => {
  const view = render(<PaymentMixChart payments={[
    { paymentMethod: 'cash', salesCents: 1250, reversalCents: 0, netCents: 1250 },
    { paymentMethod: 'card_external', salesCents: 3750, reversalCents: 0, netCents: 3750 },
  ]} />)
  expect(screen.getByText('25%')).toBeTruthy()
  expect(screen.getByText('75%')).toBeTruthy()
  expect(screen.getByText('$12.50')).toBeTruthy()
  expect(screen.getByText('$37.50')).toBeTruthy()
  expect(view.container.querySelector('.analytics-mix-summary .analytics-color-dot')?.getAttribute('style')).toContain('rgb(15, 118, 110)')
})
