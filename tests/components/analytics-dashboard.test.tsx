// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import ReportDashboard, { type ReportTab } from '../../src/features/operations/ReportDashboard'
import type { ReportController } from '../../src/features/operations/usePeriodReport'
import type { BusinessDayReport, BusinessPeriodReport } from '../../src/lib/operations-contracts'
import { money } from '../../src/lib/format'

vi.mock('gsap', () => ({ gsap: { registerPlugin: vi.fn(), fromTo: vi.fn(), timeline: vi.fn() } }))
// Leaving the outgoing layer mounted exercises revocation while a transition is unfinished.
vi.mock('@gsap/react', () => ({ useGSAP: vi.fn() }))

function totals(): BusinessDayReport {
  return {
    date: '2026-10-03', timezone: 'America/Mexico_City', grossCents: 125000, discountCents: 5000,
    salesCents: 120000, taxCents: 16552, reversalCents: 20000, reversalTaxCents: 2759,
    netCents: 100000, waivedCents: 50000, saleCount: 6,
    payments: [
      { paymentMethod: 'cash', salesCents: 70000, reversalCents: 15000, netCents: 55000 },
      { paymentMethod: 'card_external', salesCents: 50000, reversalCents: 5000, netCents: 45000 },
    ],
    operators: [
      { name: 'Operador sintético A', salesCents: 70000, reversalCents: 15000, netCents: 55000 },
      { name: 'Operador sintético B', salesCents: 50000, reversalCents: 5000, netCents: 45000 },
    ],
    products: [
      { productId: 'synthetic-espresso', name: 'Espresso sintético', quantity: 2, salesCents: 70000, taxCents: 9655, reversalQuantity: 1, reversalCents: 10000, reversalTaxCents: 1379, netCents: 60000, netTaxCents: 8276 },
      { productId: 'synthetic-pan', name: 'Pan sintético', quantity: 8, salesCents: 50000, taxCents: 6897, reversalQuantity: 4, reversalCents: 10000, reversalTaxCents: 1380, netCents: 40000, netTaxCents: 5517 },
    ],
    cashDifferences: [{ shiftId: 'synthetic-shift', closedAt: '2026-10-03T17:00:00Z', expectedCents: 20000, countedCents: 19000, differenceCents: -1000 }],
  }
}

function report(overrides: Partial<BusinessPeriodReport> = {}): BusinessPeriodReport {
  const current = totals()
  return {
    period: 'day', startDate: '2026-10-03', endDate: '2026-10-03', timezone: 'America/Mexico_City', partial: true,
    comparisonStartDate: '2026-10-02', comparisonEndDate: '2026-10-02', comparisonComparable: true,
    asOf: '2026-10-03T18:00:00Z', cutoff: '2026-10-03T18:00:00Z', previousCutoff: '2026-10-02T18:00:00Z',
    totals: current, previous: { ...totals(), salesCents: 100000, netCents: 100000, saleCount: 4 },
    series: [{ start: '2026-10-03T17:00:00Z', end: '2026-10-03T18:00:00Z', slot: '11', label: '11:00', salesCents: 120000, reversalCents: 20000, netCents: 100000, saleCount: 6, future: false }],
    previousSeries: [{ start: '2026-10-02T17:00:00Z', end: '2026-10-02T18:00:00Z', slot: '11', label: '11:00', salesCents: 100000, reversalCents: 0, netCents: 100000, saleCount: 4, future: false }],
    ...overrides,
  }
}

function controller(overrides: Partial<ReportController> = {}): ReportController {
  return {
    report: report(), date: '2026-10-03', period: 'day', requestedQuery: { date: '2026-10-03', period: 'day' },
    displayedQuery: { date: '2026-10-03', period: 'day' }, loading: false, initialLoading: false, error: '', stale: false,
    setDate: vi.fn(), setPeriod: vi.fn(), refresh: vi.fn(async () => {}), retry: vi.fn(async () => {}),
    ...overrides,
  }
}

const card = (title: string) => within(screen.getByRole('heading', { name: title }).closest('section')!)
const rangeLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0))
  vi.stubGlobal('cancelAnimationFrame', (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.id === 'recharts_measurement_span' ? (this.textContent?.length ?? 0) * 7 : 600
    const height = this.id === 'recharts_measurement_span' ? 14 : 260
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() {} }
  })
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false } })))
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.getElementById('recharts_measurement_span')?.remove()
})

test('Inicio presents today, active employees and popular products with matching detail links', async () => {
  const onOpenReport = vi.fn(), onOpenTeam = vi.fn()
  render(<ReportDashboard controller={controller()} presence={[]} onOpenReport={onOpenReport} onOpenTeam={onOpenTeam} />)
  expect(card('Ventas de hoy').getByText(money(100000))).toBeTruthy()
  expect(card('Ventas de hoy').getByText('6 ventas')).toBeTruthy()
  expect(card('Más vendidos hoy').getAllByRole('listitem').map(row => row.textContent)).toEqual(['Pan sintético8 ud.', 'Espresso sintético2 ud.'])
  const productBars = card('Más vendidos hoy').getAllByRole('img')
  expect(productBars[0].querySelector('span')?.style.transform).toBe('scaleX(1)')
  expect(productBars[1].querySelector('span')?.style.transform).toBe('scaleX(0.25)')
  expect(productBars[1].querySelector('span')?.style.width).toBe('100%')
  await waitFor(() => expect(screen.getByLabelText('Ventas por hora de hoy')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Ver ventas detalladas' }))
  fireEvent.click(screen.getByRole('button', { name: 'Ver empleados' }))
  fireEvent.click(screen.getByRole('button', { name: 'Ver detalle de productos' }))
  expect(onOpenReport.mock.calls.map(([tab]) => tab)).toEqual(['sales', 'products'])
  expect(onOpenTeam).toHaveBeenCalledOnce()
  expect(screen.queryByRole('tablist')).toBeNull()
  expect(screen.queryByText('netos')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Actualizar reporte' })).toBeNull()
})

test('unknown presence uses a placeholder and only confirmed absence is shown as empty', () => {
  const state = controller(), view = render(<ReportDashboard controller={state} />)
  expect(card('Empleados conectados').getByRole('status', { name: 'Cargando empleados conectados' })).toBeTruthy()
  expect(screen.queryByText('Sin empleados conectados.')).toBeNull()
  view.rerender(<ReportDashboard controller={state} presence={[]} />)
  expect(card('Empleados conectados').getByText('Sin empleados conectados.')).toBeTruthy()
  expect(card('Empleados conectados').queryByRole('status')).toBeNull()
  view.rerender(<ReportDashboard controller={state} presence={[{ id: 'synthetic-cashier', name: 'Cajero Sintético', role: 'cashier', lastSeenAt: '2026-10-03T18:00:00Z' }]} />)
  expect(card('Empleados conectados').getByText('Cajero Sintético')).toBeTruthy()
  expect(card('Empleados conectados').getByText('Cajero')).toBeTruthy()
  expect(card('Empleados conectados').getByText('Activo')).toBeTruthy()
})

test('presence failure without a snapshot replaces the placeholder with recovery and no zero count', () => {
  const retry = vi.fn()
  render(<ReportDashboard controller={controller()} presenceError="No pudimos consultar empleados." onPresenceRetry={retry} />)
  const employees = card('Empleados conectados')
  expect(employees.getByRole('alert').textContent).toContain('No pudimos consultar empleados.')
  expect(employees.queryByRole('status', { name: 'Cargando empleados conectados' })).toBeNull()
  expect(employees.queryByText('Sin empleados conectados.')).toBeNull()
  expect(employees.queryByText('0')).toBeNull()
  fireEvent.click(employees.getByRole('button', { name: 'Reintentar empleados conectados' }))
  expect(retry).toHaveBeenCalledOnce()
})

test('a failed presence refresh preserves the last people and identifies stale badges', () => {
  const state = controller(), presence = [{ id: 'synthetic-cashier', name: 'Cajero Sintético', role: 'cashier' as const, lastSeenAt: '2026-10-03T18:00:00Z' }]
  const view = render(<ReportDashboard controller={state} presence={presence} />)
  expect(card('Empleados conectados').getByText('Activo')).toBeTruthy()
  view.rerender(<ReportDashboard controller={state} presence={presence} presenceError="No pudimos actualizar empleados." />)
  expect(card('Empleados conectados').getByText('Cajero Sintético')).toBeTruthy()
  expect(card('Empleados conectados').getByText('Sin actualizar')).toBeTruthy()
  expect(card('Empleados conectados').queryByText('Activo')).toBeNull()
  expect(card('Empleados conectados').queryByRole('status', { name: 'Cargando empleados conectados' })).toBeNull()
  view.rerender(<ReportDashboard controller={state} presence={[]} presenceError="No pudimos actualizar empleados." />)
  expect(card('Empleados conectados').getByText('Último estado: sin empleados conectados.')).toBeTruthy()
})

test('Reportes supports three accessible tabs with arrows, Home and End', () => {
  const changed = vi.fn()
  function Harness() {
    const [tab, setTab] = useState<ReportTab>('sales')
    return <ReportDashboard controller={controller()} detailed tab={tab} onTabChange={next => { changed(next); setTab(next) }} />
  }
  render(<Harness />)
  const list = within(screen.getByRole('tablist', { name: 'Secciones de Reportes' }))
  const sales = list.getByRole('tab', { name: 'Ventas' }), products = list.getByRole('tab', { name: 'Productos' }), finances = list.getByRole('tab', { name: 'Finanzas' })
  expect(list.getAllByRole('tab')).toHaveLength(3)
  fireEvent.keyDown(sales, { key: 'ArrowRight' })
  expect(products.getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(products)
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(products.id)
  fireEvent.keyDown(products, { key: 'End' })
  expect(finances.getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(finances, { key: 'ArrowRight' })
  expect(sales.getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(sales, { key: 'ArrowLeft' })
  expect(finances.getAttribute('aria-selected')).toBe('true')
  fireEvent.keyDown(finances, { key: 'Home' })
  expect(sales.getAttribute('aria-selected')).toBe('true')
  expect(sales.tabIndex).toBe(0)
  expect(products.tabIndex).toBe(-1)
  expect(changed.mock.calls.map(([tab]) => tab)).toEqual(['products', 'finances', 'sales', 'finances', 'sales'])
})

test('product details sort by net, units and returns without mutating the server report', async () => {
  const state = controller()
  render(<ReportDashboard controller={state} detailed tab="products" />)
  const table = card('Detalle de productos').getByRole('table')
  const names = () => within(table).getAllByRole('row').slice(1).map(row => within(row).getByRole('rowheader').textContent)
  expect(names()).toEqual(['Espresso sintético', 'Pan sintético'])
  fireEvent.click(within(table).getByRole('button', { name: 'Vendidos' }))
  expect(names()).toEqual(['Pan sintético', 'Espresso sintético'])
  expect(within(table).getByRole('columnheader', { name: 'Vendidos' }).getAttribute('aria-sort')).toBe('descending')
  fireEvent.click(within(table).getByRole('button', { name: 'Vendidos' }))
  expect(names()).toEqual(['Espresso sintético', 'Pan sintético'])
  expect(within(table).getByRole('columnheader', { name: 'Vendidos' }).getAttribute('aria-sort')).toBe('ascending')
  fireEvent.click(within(table).getByRole('button', { name: 'Devueltos' }))
  expect(names()).toEqual(['Pan sintético', 'Espresso sintético'])
  fireEvent.change(screen.getByRole('combobox', { name: 'Ordenar por' }), { target: { value: 'netCents' } })
  expect(names()).toEqual(['Espresso sintético', 'Pan sintético'])
  expect(state.report?.totals.products.map(product => product.name)).toEqual(['Espresso sintético', 'Pan sintético'])
  await waitFor(() => expect(screen.getByLabelText('Ranking por importe')).toBeTruthy())
  fireEvent.click(within(screen.getByRole('group', { name: 'Métrica de productos' })).getByRole('button', { name: 'Unidades' }))
  const chart = await screen.findByLabelText('Ranking por cantidad')
  const pan = await within(chart).findByText('Pan sintético'), espresso = await within(chart).findByText('Espresso sintético')
  expect(pan.compareDocumentPosition(espresso) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(within(chart).getByText('8')).toBeTruthy()
})

test('Finanzas separates included IVA, waived balances and cash differences from net income', async () => {
  render(<ReportDashboard controller={controller()} detailed tab="finances" />)
  const tax = card('IVA registrado'), waivers = card('Condonaciones'), bridge = card('Del bruto al neto')
  expect(tax.getByText(money(16552))).toBeTruthy()
  expect(tax.getByText(money(2759))).toBeTruthy()
  expect(tax.getByText(money(13793))).toBeTruthy()
  expect(waivers.getByText(money(50000))).toBeTruthy()
  expect(waivers.getByText('Fuera de ingresos')).toBeTruthy()
  expect(bridge.getByText(money(100000))).toBeTruthy()
  await waitFor(() => expect(screen.getByLabelText('De ventas brutas a ventas netas')).toBeTruthy())
  expect(within(card('Diferencias de caja').getByRole('table')).getByText(money(-1000))).toBeTruthy()
  expect(screen.queryByText(/beneficio/i, { selector: 'h2' })).toBeNull()
})

test('background refresh retains figures without a refresh button or initial skeleton', async () => {
  const state = controller(), view = render(<ReportDashboard controller={state} detailed />)
  await waitFor(() => expect(screen.getByLabelText('Cobrado por hora')).toBeTruthy())
  view.rerender(<ReportDashboard controller={{ ...state, loading: true }} detailed />)
  expect(screen.queryByRole('button', { name: 'Actualizar reporte' })).toBeNull()
  expect(screen.getByLabelText('Actualizando reporte')).toBeTruthy()
  expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByText('Actualizando…')).toBeNull()
  expect(within(screen.getByLabelText('Resumen de ventas')).getAllByText(money(100000))).toHaveLength(1)
  expect(screen.queryByRole('status', { name: 'Cargando información del negocio' })).toBeNull()
})

test('initial loading uses a labeled skeleton and an initial failure never invents zero-valued figures', () => {
  const state = controller({ report: null, displayedQuery: null, loading: true, initialLoading: true })
  const view = render(<ReportDashboard controller={state} detailed />)
  expect(screen.getByRole('status', { name: 'Cargando información del negocio' }).getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByLabelText('Resumen de ventas')).toBeNull()
  view.rerender(<ReportDashboard controller={{ ...state, loading: false, initialLoading: false, error: 'Sin conexión' }} detailed />)
  expect(screen.getByRole('alert').textContent).toContain('Sin conexión')
  expect(screen.queryByRole('status', { name: 'Cargando información del negocio' })).toBeNull()
  expect(within(view.container).queryByText(/\$/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
  expect(state.retry).toHaveBeenCalledOnce()
})

test('a pending filter preserves the confirmed range and period alongside the current figures', async () => {
  const state = controller({ date: '2026-09-01', period: 'month', requestedQuery: { date: '2026-09-01', period: 'month' }, loading: true })
  render(<ReportDashboard controller={state} detailed />)
  expect(screen.getByText(rangeLabel('2026-10-03'))).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Día' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Mes' }).getAttribute('data-pending')).toBe('true')
  expect(screen.getByLabelText('Cambiando período')).toBeTruthy()
  await waitFor(() => expect(screen.getByLabelText('Cobrado por hora')).toBeTruthy())
  expect(screen.queryByRole('status', { name: 'Cargando información del negocio' })).toBeNull()
})

test('stale failures retain the confirmed figures with an explicit recovery action', () => {
  const state = controller({ error: 'No pudimos actualizar', stale: true })
  render(<ReportDashboard controller={state} detailed />)
  expect(screen.getByText('Desactualizado')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('No pudimos actualizar')
  expect(within(screen.getByLabelText('Resumen de ventas')).getByText(money(100000))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
  expect(state.retry).toHaveBeenCalledOnce()
})

test('revocation removes both new and outgoing private figures during an unfinished data transition', async () => {
  vi.mocked(window.matchMedia).mockImplementation(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false }, onchange: null }))
  const first = controller(), view = render(<ReportDashboard controller={first} detailed />)
  await waitFor(() => expect(screen.getByLabelText('Cobrado por hora')).toBeTruthy())
  const nextReport = report({ period: 'week', startDate: '2026-09-28', endDate: '2026-10-04', totals: { ...totals(), netCents: 200000 } })
  const next = controller({ report: nextReport, period: 'week', displayedQuery: { date: '2026-10-03', period: 'week' }, requestedQuery: { date: '2026-10-03', period: 'week' } })
  view.rerender(<ReportDashboard controller={next} detailed />)
  const outgoing = view.container.querySelector('.analytics-outgoing')
  expect(outgoing?.getAttribute('aria-hidden')).toBe('true')
  expect(outgoing?.textContent).toContain(money(100000))
  view.rerender(<ReportDashboard controller={controller({ report: null, displayedQuery: null, error: 'Permiso revocado' })} detailed />)
  expect(screen.getByRole('alert').textContent).toContain('Permiso revocado')
  expect(view.container.querySelector('.analytics-outgoing')).toBeNull()
  expect(screen.queryByLabelText('Resumen de ventas')).toBeNull()
  expect(screen.queryByText(money(100000))).toBeNull()
  expect(screen.queryByText(money(200000))).toBeNull()
})

test('period and date controls delegate valid selections to the shared controller', () => {
  const state = controller()
  render(<ReportDashboard controller={state} detailed />)
  fireEvent.click(screen.getByRole('button', { name: 'Semana' }))
  expect(state.setPeriod).toHaveBeenCalledWith('week')
  const date = screen.getByLabelText('Fecha del reporte')
  fireEvent.change(date, { target: { value: '2026-09-12' } })
  expect(state.setDate).toHaveBeenCalledExactlyOnceWith('2026-09-12')
  fireEvent.change(date, { target: { value: '' } })
  expect(state.setDate).toHaveBeenCalledOnce()
})


test('amount-only Point refunds do not invent product allocation or a complete net VAT', async () => {
  const current = report()
  current.totals.unallocatedRefundCents = 1234
  current.totals.unknownReversalTaxCents = 1234
  const state = controller({ report: current })
  const view = render(<ReportDashboard controller={state} detailed tab="finances" onTabChange={vi.fn()} />)
  expect(card('IVA registrado').getByText('—')).toBeTruthy()
  expect(card('IVA registrado').getByText('$12.34 devueltos por Point sin desglose de IVA.')).toBeTruthy()
  view.rerender(<ReportDashboard controller={state} detailed tab="products" onTabChange={vi.fn()} />)
  expect(card('Detalle de productos').getByText('$12.34 devueltos por Point sin asignación a productos. El neto general sí los incluye.')).toBeTruthy()
})
