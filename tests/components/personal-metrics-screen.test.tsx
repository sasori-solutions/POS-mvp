// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import PersonalMetricsScreen from '../../src/features/operations/PersonalMetricsScreen'
import { useReportController, type ReportController } from '../../src/features/operations/usePeriodReport'
import { AccountClientError } from '../../src/lib/account'
import { money } from '../../src/lib/format'
import type { BusinessDayReport, BusinessPeriodReport } from '../../src/lib/operations-contracts'
import { posRequest, type PosAccess } from '../../src/lib/pos'
import { businessDate } from '../../src/lib/reporting'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
// Chart geometry and SVG keyboard/touch behavior have their own AnalyticsCharts tests.
// Keeping this figure mounted makes controller transitions observable without a browser.
vi.mock('../../src/features/operations/AnalyticsCharts', () => ({
  TemporalChart: ({ report, metric }: { report: BusinessPeriodReport; metric: string }) => <figure role="img" aria-label="Tendencia personal" data-metric={metric} data-net={report.totals.netCents} data-date={report.startDate} />,
}))

const access: PosAccess = { businessId: 'synthetic-business', operatorToken: 'synthetic-own-operator' }
const calendarLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
function product(productId = 'synthetic-product', name = 'Mi producto sintético', quantity = 2): BusinessDayReport['products'][number] {
  return { productId, name, quantity, salesCents: 11600, taxCents: 1600, reversalQuantity: 0, reversalCents: 0, reversalTaxCents: 0, netCents: 11600, netTaxCents: 1600 }
}
function report(date = businessDate('UTC'), overrides: Partial<BusinessPeriodReport> = {}, totalOverrides: Partial<BusinessDayReport> = {}): BusinessPeriodReport {
  const totals: BusinessDayReport = {
    date, timezone: 'UTC', grossCents: 11600, discountCents: 0, salesCents: 11600, taxCents: 1600,
    reversalCents: 0, reversalTaxCents: 0, netCents: 11600, waivedCents: 0, saleCount: 2,
    payments: [{ paymentMethod: 'cash', salesCents: 11600, reversalCents: 0, netCents: 11600 }],
    operators: [], cashDifferences: [], products: [product()], ...totalOverrides,
  }
  return {
    period: 'day', startDate: date, endDate: date, timezone: 'UTC', partial: true,
    comparisonStartDate: '2026-10-02', comparisonEndDate: '2026-10-02', comparisonComparable: true,
    asOf: `${date}T12:00:00Z`, cutoff: `${date}T12:00:00Z`, previousCutoff: '2026-10-02T12:00:00Z',
    totals, previous: { ...totals, salesCents: 5800, netCents: 5800, saleCount: 1 },
    series: [{ start: `${date}T11:00:00Z`, end: `${date}T12:00:00Z`, slot: '11', label: '11:00', salesCents: totals.salesCents, reversalCents: totals.reversalCents, netCents: totals.netCents, saleCount: totals.saleCount, future: false }],
    previousSeries: [], ...overrides,
  }
}
function deferred() {
  let resolve!: (value: BusinessPeriodReport) => void, reject!: (reason: Error) => void
  const promise = new Promise<BusinessPeriodReport>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
interface HarnessProps { currentAccess?: PosAccess; timezone?: string; authorized?: boolean; active?: boolean }
function renderPersonal(initialProps: HarnessProps = {}, onSessionError = vi.fn()) {
  let controller!: ReportController
  function Harness({ currentAccess = access, timezone = 'UTC', authorized = true, active = true }: HarnessProps) {
    controller = useReportController(currentAccess, timezone, onSessionError, active, authorized, 'own')
    return <PersonalMetricsScreen controller={controller} />
  }
  const view = render(<Harness {...initialProps} />)
  return { controller: () => controller, onSessionError, rerender: (props: HarnessProps) => view.rerender(<Harness {...props} />) }
}
const kpi = (label: string) => within(screen.getByText(label, { selector: '.analytics-kpi-label' }).closest('section')!)
const sales = () => kpi('Mis ventas')
const ranking = () => within(screen.getByRole('heading', { name: 'Más vendidos por mí' }).closest('section')!)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks() })

test('initial personal metrics load uses placeholders with accessible filters and no invented figures', async () => {
  const pending = deferred()
  vi.mocked(posRequest).mockReturnValueOnce(pending.promise)
  renderPersonal()
  expect(screen.getByRole('status', { name: 'Cargando mis métricas' }).textContent).toBe('')
  expect(screen.queryByText('Mis ventas', { selector: '.analytics-kpi-label' })).toBeNull()
  expect(screen.queryByText('Sin cobros en este período.')).toBeNull()
  expect(screen.queryByText(money(0))).toBeNull()
  expect(screen.getByRole('group', { name: 'Período de mis métricas' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Día' }).getAttribute('aria-pressed')).toBe('true')
  const date = screen.getByLabelText('Fecha de mis métricas') as HTMLInputElement
  expect(date.type).toBe('date')
  expect(date.min).toBe('2000-01-01')
  expect(date.max).toBe('2100-12-31')
  expect(posRequest).toHaveBeenCalledExactlyOnceWith(access, { command: 'report_own_period', date: businessDate('UTC'), period: 'day' })
  await act(async () => pending.resolve(report()))
  expect(sales().getByText(money(11600))).toBeTruthy()
  expect(kpi('Cobros').getByText('2')).toBeTruthy()
  expect(kpi('Ticket promedio').getByText(money(5800))).toBeTruthy()
  await waitFor(() => expect(screen.getByRole('img', { name: 'Tendencia personal' }).getAttribute('data-metric')).toBe('netCents'))
  expect(screen.queryByRole('status', { name: 'Cargando mis métricas' })).toBeNull()
})

test('same-query refresh keeps mounted figures and only commits exact confirmed values', async () => {
  const next = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report()).mockReturnValueOnce(next.promise)
  const view = renderPersonal()
  await waitFor(() => expect(screen.getByRole('img', { name: 'Tendencia personal' })).toBeTruthy())
  const figure = screen.getByRole('img', { name: 'Tendencia personal' })
  const amount = sales().getByText(money(11600))
  act(() => { void view.controller().refresh() })
  expect(sales().getByText(money(11600))).toBe(amount)
  expect(screen.getByRole('img', { name: 'Tendencia personal' })).toBe(figure)
  expect(screen.getByRole('status', { name: 'Actualizando mis métricas' }).textContent).toBe('')
  expect(screen.queryByRole('status', { name: 'Cargando mis métricas' })).toBeNull()
  await act(async () => next.resolve(report(undefined, {}, { salesCents: 12001, grossCents: 12001, netCents: 12001 })))
  expect(sales().getByText(money(12001))).toBeTruthy()
  expect(kpi('Ticket promedio').getByText(money(6001))).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Tendencia personal' })).toBe(figure)
  expect(figure.getAttribute('data-net')).toBe('12001')
  expect(screen.queryByRole('status', { name: 'Actualizando mis métricas' })).toBeNull()
})

test('rapid period selections keep the confirmed period until the latest response commits', async () => {
  const week = deferred(), month = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report()).mockReturnValueOnce(week.promise).mockReturnValueOnce(month.promise)
  renderPersonal()
  await waitFor(() => expect(sales().getByText(money(11600))).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Semana' }))
  expect(screen.getByRole('button', { name: 'Día' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Semana' }).getAttribute('data-pending')).toBe('true')
  expect(sales().getByText(money(11600))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Mes' }))
  expect(screen.getByRole('button', { name: 'Mes' }).getAttribute('data-pending')).toBe('true')
  await act(async () => month.resolve(report('2026-10-01', { period: 'month', endDate: '2026-10-31' }, { salesCents: 76068, netCents: 76068 })))
  expect(screen.getByRole('button', { name: 'Mes' }).getAttribute('aria-pressed')).toBe('true')
  expect(sales().getByText(money(76068))).toBeTruthy()
  await act(async () => week.resolve(report('2026-09-28', { period: 'week', endDate: '2026-10-04' }, { netCents: 99999 })))
  expect(sales().getByText(money(76068))).toBeTruthy()
  expect(screen.queryByText(money(99999))).toBeNull()
  expect(screen.getByLabelText('Período de las cifras visibles').textContent).toBe(`${calendarLabel('2026-10-01')} – ${calendarLabel('2026-10-31')}`)
})

test('a pending date identifies the selection while retaining the range of visible figures', async () => {
  const next = deferred(), today = businessDate('UTC')
  vi.mocked(posRequest).mockResolvedValueOnce(report(today)).mockReturnValueOnce(next.promise)
  renderPersonal()
  await waitFor(() => expect(sales().getByText(money(11600))).toBeTruthy())
  const input = screen.getByLabelText('Fecha de mis métricas') as HTMLInputElement
  fireEvent.change(input, { target: { value: '2026-10-01' } })
  expect(input.value).toBe('2026-10-01')
  expect(input.getAttribute('aria-busy')).toBe('true')
  expect(input.closest('label')?.getAttribute('data-pending')).toBe('true')
  expect(screen.getByLabelText('Período de las cifras visibles').textContent).toBe(calendarLabel(today))
  expect(sales().getByText(money(11600))).toBeTruthy()
  await act(async () => next.resolve(report('2026-10-01', {}, { netCents: 2800 })))
  expect(screen.getByLabelText('Período de las cifras visibles').textContent).toBe(calendarLabel('2026-10-01'))
  expect(input.getAttribute('aria-busy')).toBe('false')
  expect(sales().getByText(money(2800))).toBeTruthy()
})

test('failed selection restores confirmed filters and retries the failed query without a skeleton', async () => {
  const failed = deferred(), retry = deferred(), today = businessDate('UTC')
  vi.mocked(posRequest).mockResolvedValueOnce(report(today)).mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise)
  renderPersonal()
  await waitFor(() => expect(sales().getByText(money(11600))).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Semana' }))
  await act(async () => failed.reject(new Error('Sin conexión sintética')))
  expect(screen.getByRole('alert').textContent).toContain('Tus cifras pueden estar desactualizadas.')
  expect(screen.getByRole('button', { name: 'Día' }).getAttribute('aria-pressed')).toBe('true')
  expect(sales().getByText(money(11600))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
  expect(posRequest).toHaveBeenLastCalledWith(access, { command: 'report_own_period', date: today, period: 'week' })
  expect(screen.queryByRole('status', { name: 'Cargando mis métricas' })).toBeNull()
  await act(async () => retry.resolve(report(today, { period: 'week' }, { netCents: 23000 })))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: 'Semana' }).getAttribute('aria-pressed')).toBe('true')
  expect(sales().getByText(money(23000))).toBeTruthy()
})

test('first-load failure presents recovery and never reports zero sales', async () => {
  vi.mocked(posRequest).mockRejectedValueOnce(new Error('No pudimos consultar tus cifras.'))
  renderPersonal()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No pudimos consultar tus cifras.'))
  expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy()
  expect(screen.queryByText(money(0))).toBeNull()
  expect(screen.queryByText('Sin cobros en este período.')).toBeNull()
  expect(screen.queryByRole('status', { name: 'Cargando mis métricas' })).toBeNull()
})

test('permission revocation clears personal figures and does not render other operators or cash data', async () => {
  const revoked = new AccountClientError('PERMISSION_DENIED', 'Permiso revocado'), next = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report(undefined, {}, {
    operators: [{ name: 'Otro operador sintético', salesCents: 70000, reversalCents: 0, netCents: 70000 }],
    cashDifferences: [{ shiftId: 'other-synthetic-shift', closedAt: '2026-10-04T12:00:00Z', expectedCents: 87000, countedCents: 70000, differenceCents: -17000 }],
  })).mockReturnValueOnce(next.promise)
  const view = renderPersonal()
  await waitFor(() => expect(sales().getByText(money(11600))).toBeTruthy())
  expect(screen.queryByText('Otro operador sintético')).toBeNull()
  expect(screen.queryByText(money(-17000))).toBeNull()
  act(() => { void view.controller().refresh() })
  await act(async () => next.reject(revoked))
  expect(view.onSessionError).toHaveBeenCalledExactlyOnceWith(revoked)
  expect(screen.queryByText(money(11600))).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Más vendidos por mí' })).toBeNull()
  expect(screen.queryByRole('img', { name: 'Tendencia personal' })).toBeNull()
})

test('changing operator or business hides previous figures immediately and rejects late session responses', async () => {
  const old = deferred(), own = deferred(), nextBusiness = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report()).mockReturnValueOnce(old.promise).mockReturnValueOnce(own.promise).mockReturnValueOnce(nextBusiness.promise)
  const view = renderPersonal()
  await waitFor(() => expect(sales().getByText(money(11600))).toBeTruthy())
  act(() => { void view.controller().refresh() })
  const nextAccess = { ...access, operatorToken: 'synthetic-next-operator' }
  view.rerender({ currentAccess: nextAccess })
  expect(screen.queryByText(money(11600))).toBeNull()
  expect(screen.getByRole('status', { name: 'Cargando mis métricas' })).toBeTruthy()
  await act(async () => own.resolve(report(undefined, {}, { netCents: 4300, products: [product('own-b', 'Producto de operador nuevo', 1)] })))
  await act(async () => old.reject(new AccountClientError('SESSION_INVALID', 'Sesión anterior')))
  expect(view.onSessionError).not.toHaveBeenCalled()
  expect(sales().getByText(money(4300))).toBeTruthy()
  expect(screen.queryByText('Mi producto sintético')).toBeNull()
  view.rerender({ currentAccess: { ...nextAccess, businessId: 'synthetic-next-business' } })
  expect(screen.queryByText(money(4300))).toBeNull()
  expect(screen.queryByText('Producto de operador nuevo')).toBeNull()
  await act(async () => nextBusiness.resolve(report(undefined, {}, { netCents: 8000, products: [] })))
  expect(sales().getByText(money(8000))).toBeTruthy()
})

test('permission loss while inactive prevents an in-flight response restoring the private snapshot', async () => {
  const next = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report()).mockReturnValueOnce(next.promise)
  const view = renderPersonal()
  await waitFor(() => expect(sales().getByText(money(11600))).toBeTruthy())
  act(() => { void view.controller().refresh() })
  view.rerender({ active: false, authorized: false })
  expect(screen.queryByText(money(11600))).toBeNull()
  expect(screen.queryByText('Mi producto sintético')).toBeNull()
  await act(async () => next.resolve(report(undefined, {}, { netCents: 90000 })))
  expect(screen.queryByText(money(90000))).toBeNull()
  expect(view.controller().report).toBeNull()
})

test('timezone changes reset to the business day and cannot reuse a previous calendar snapshot', async () => {
  const next = deferred()
  vi.mocked(posRequest).mockResolvedValueOnce(report(businessDate('UTC'))).mockReturnValueOnce(next.promise)
  const view = renderPersonal()
  await waitFor(() => expect(sales().getByText(money(11600))).toBeTruthy())
  view.rerender({ timezone: 'Pacific/Kiritimati' })
  expect(screen.queryByText(money(11600))).toBeNull()
  expect(screen.getByRole('status', { name: 'Cargando mis métricas' })).toBeTruthy()
  expect(posRequest).toHaveBeenLastCalledWith(access, { command: 'report_own_period', date: businessDate('Pacific/Kiritimati'), period: 'day' })
  await act(async () => next.resolve(report(businessDate('Pacific/Kiritimati'), { timezone: 'Pacific/Kiritimati' }, { netCents: 8700 })))
  expect(sales().getByText(money(8700))).toBeTruthy()
})

test('rankings preserve historical product identity, order by units and exclude refund-only rows', async () => {
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.mocked(posRequest).mockResolvedValueOnce(report(undefined, {}, { products: [
    product('historical-a', 'Nombre histórico compartido', 3), product('refund-only', 'Producto sólo devuelto', 0),
    product('highest', 'Más unidades', 7), product('historical-b', 'Nombre histórico compartido', 4),
    product('fourth', 'Cuarto', 2), product('fifth', 'Quinto', 1), product('sixth', 'Fuera de los cinco', 0.5),
  ] }))
  renderPersonal()
  await waitFor(() => expect(ranking().getAllByRole('listitem')).toHaveLength(5))
  expect(ranking().getAllByRole('listitem').map(row => row.textContent)).toEqual([
    'Más unidades7 ud.', 'Nombre histórico compartido4 ud.', 'Nombre histórico compartido3 ud.', 'Cuarto2 ud.', 'Quinto1 ud.',
  ])
  expect(ranking().getAllByRole('img')[0].querySelector('span')?.style.transform).toBe('scaleX(1)')
  expect(ranking().queryByText('Producto sólo devuelto')).toBeNull()
  expect(ranking().queryByText('Fuera de los cinco')).toBeNull()
  expect(warning.mock.calls.flat().join(' ')).not.toContain('same key')
})

test('refund-only periods retain negative net sales and no ticket or fake popular products', async () => {
  vi.mocked(posRequest).mockResolvedValueOnce(report(undefined, { comparisonComparable: false }, {
    grossCents: 0, salesCents: 0, taxCents: 0, reversalCents: 11600, reversalTaxCents: 1600,
    netCents: -11600, saleCount: 0, products: [{ ...product('older-sale', 'Producto anterior', 0), reversalQuantity: 1, reversalCents: 11600, netCents: -11600 }],
  }))
  renderPersonal()
  await waitFor(() => expect(sales().getByText(money(-11600))).toBeTruthy())
  expect(kpi('Ticket promedio').getByText('—')).toBeTruthy()
  expect(screen.queryByText('Sin cobros en este período.')).toBeNull()
  expect(ranking().getByText('Sin productos vendidos.')).toBeTruthy()
  expect(ranking().queryByText('Producto anterior')).toBeNull()
  expect(sales().queryByText(/vs\. anterior/)).toBeNull()
})
