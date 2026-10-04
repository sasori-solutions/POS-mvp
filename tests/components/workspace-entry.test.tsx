// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import HomeScreen from '../../src/components/HomeScreen'
import { useCatalog } from '../../src/components/useCatalog'
import { useOperations } from '../../src/features/operations/useOperations'
import ReportDashboard from '../../src/features/operations/ReportDashboard'
import { useReportController } from '../../src/features/operations/usePeriodReport'
import type { ReportController } from '../../src/features/operations/usePeriodReport'
import type { AccountContext, BusinessContext } from '../../src/lib/contracts'
import { accountRequest } from '../../src/lib/account'

vi.mock('gsap', () => ({ gsap: { registerPlugin: vi.fn(), fromTo: vi.fn() } }))
vi.mock('@gsap/react', () => ({ useGSAP: vi.fn() }))
vi.mock('../../src/lib/account', async original => ({ ...await original<object>(), accountRequest: vi.fn() }))

vi.mock('../../src/components/useCatalog', () => ({ accessErrorCodes: [], useCatalog: vi.fn(() => ({ products: [], paymentMethods: ['cash'] })) }))
vi.mock('../../src/features/operations/useOperations', () => ({
  useOperations: vi.fn(() => ({ snapshot: { enabled: true, shift: { status: 'open' }, orders: [], tables: [], attempts: [], pendingKitchenCount: 3 }, refresh: vi.fn(), error: '' })),
  useOperationalMutation: () => ({ busy: false, pending: null, error: '', execute: vi.fn() }),
}))
vi.mock('../../src/features/operations/usePeriodReport', () => ({ useReportController: vi.fn() }))
vi.mock('../../src/features/operations/ReportDashboard', () => ({ default: vi.fn(({ controller, detailed, onOpenReport }: { controller: ReportController; detailed?: boolean; onOpenReport?: (tab: 'products') => void }) => <div><p>{detailed ? 'Reporte real autorizado' : 'Resumen real autorizado'}</p><span>Período {controller.period}</span>{onOpenReport && <button onClick={() => onOpenReport('products')}>Analizar productos</button>}</div>) }))
vi.mock('../../src/components/SaleScreen', () => ({ default: () => <p>Tomar venta</p> }))
vi.mock('../../src/features/operations/OrdersScreen', () => ({ default: () => <p>Preparación de comandas</p> }))
vi.mock('../../src/components/SalesScreen', () => ({ default: ({ collectionAllowed }: { collectionAllowed: boolean }) => <p>{collectionAllowed ? 'Devoluciones disponibles' : 'Sin turno'}</p> }))
const owner = { id: 'synthetic-business', name: 'Café sintético', role: 'owner', timezone: 'America/Mexico_City', profile: { paymentMethods: ['cash'] } } as BusinessContext
const props = { business: owner, operatorToken: 'memory-only', busy: false, error: '', onLock: vi.fn(), onLogout: vi.fn() }
const originalDialogClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
const controller = { report: null, date: '2026-10-03', period: 'week', requestedQuery: { date: '2026-10-03', period: 'week' }, displayedQuery: null, loading: false, initialLoading: false, error: '', stale: false, setDate: vi.fn(), setPeriod: vi.fn(), refresh: vi.fn(async () => {}), retry: vi.fn(async () => {}) } satisfies ReportController
beforeEach(() => {
  vi.mocked(accountRequest).mockReset().mockResolvedValue({ business: { ...owner, connectedEmployees: [] }, expiresAt: '2026-10-04T00:00:00Z' })
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('64rem') || query.includes('reduced-motion'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn() })
  vi.mocked(useReportController).mockReturnValue(controller)
})
afterEach(() => {
  cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
  if (originalDialogClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', originalDialogClose)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})

test('owner enters Inicio without loading the catalog or operational snapshots, then can sell', () => {
  render(<HomeScreen {...props} />)
  expect(screen.getByRole('heading', { name: 'Inicio' })).toBeTruthy()
  expect(vi.mocked(useCatalog).mock.lastCall?.[1]).toBe(false)
  expect(vi.mocked(useOperations).mock.lastCall?.[1]).toBe(false)
  expect(vi.mocked(useReportController).mock.calls.slice(-2).map(call => call[3])).toEqual([true, false])
  expect(vi.mocked(useReportController).mock.lastCall?.[4]).toBe(true)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Navegación del dueño' })).getByRole('button', { name: 'Ventas' }))
  expect(vi.mocked(useOperations).mock.lastCall?.[1]).toBe(true)
  expect(vi.mocked(useReportController).mock.lastCall?.[3]).toBe(false)
  expect(screen.getByText('Devoluciones disponibles')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Punto de Venta' })[0])
  expect(screen.getByRole('heading', { name: 'Venta' })).toBeTruthy()
  expect(vi.mocked(useCatalog).mock.lastCall?.[1]).toBe(true)
})

test('read-only kitchen staff enter Comandas with a pending bubble and cannot navigate to owner management', () => {
  const business = { ...owner, role: 'cashier', permissions: ['kitchen.read'] } as BusinessContext
  render(<HomeScreen {...props} business={business} destination="Inicio" />)
  expect(screen.getByRole('heading', { name: 'Comandas' })).toBeTruthy()
  const nav = within(screen.getByRole('navigation', { name: 'Navegación principal' }))
  expect(nav.getAllByRole('button').map(b => b.textContent)).toEqual(['3Comandas', 'Más'])
  expect(vi.mocked(useCatalog).mock.lastCall?.[1]).toBe(false)
  expect(screen.queryByRole('button', { name: 'Empleados' })).toBeNull()
})

test('employee permissions alone expose history and refund recovery, never owner Inicio', () => {
  const business = { ...owner, role: 'manager', permissions: ['sales.read_all', 'sales.reverse'] } as BusinessContext
  render(<HomeScreen {...props} business={business} />)
  expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy()
  expect(vi.mocked(useOperations).mock.lastCall?.[1]).toBe(true)
  expect(screen.queryByRole('button', { name: 'Inicio' })).toBeNull()
  expect(vi.mocked(useReportController).mock.lastCall?.[3]).toBe(false)
})

test('Inicio and Reportes share the controller and overview links choose the report tab', () => {
  render(<HomeScreen {...props} />)
  expect(vi.mocked(ReportDashboard).mock.lastCall?.[0].controller).toBe(controller)
  fireEvent.click(screen.getByRole('button', { name: 'Analizar productos' }))
  expect(screen.getByRole('heading', { name: 'Reportes' })).toBeTruthy()
  expect(vi.mocked(ReportDashboard).mock.lastCall?.[0]).toMatchObject({ controller, detailed: true, tab: 'products' })
  expect(vi.mocked(useReportController).mock.lastCall?.[3]).toBe(true)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Navegación del dueño' })).getByRole('button', { name: 'Inicio' }))
  expect(vi.mocked(ReportDashboard).mock.lastCall?.[0].controller).toBe(controller)
  expect(screen.getByText('Período week')).toBeTruthy()
})

test('a reports-only employee activates analytics without loading operational snapshots', () => {
  const business = { ...owner, role: 'manager', permissions: ['reports.read'] } as BusinessContext
  render(<HomeScreen {...props} business={business} />)
  expect(screen.getByRole('heading', { name: 'Reportes' })).toBeTruthy()
  expect(vi.mocked(useReportController).mock.lastCall?.[3]).toBe(true)
  expect(vi.mocked(useOperations).mock.lastCall?.[1]).toBe(false)
  expect(vi.mocked(useReportController).mock.lastCall?.[4]).toBe(true)
  expect(screen.getByText('Reporte real autorizado')).toBeTruthy()
})

test('an unauthorized Reportes destination does not activate analytics for an employee', () => {
  const business = { ...owner, role: 'cashier', permissions: ['sales.read_own'] } as BusinessContext
  render(<HomeScreen {...props} business={business} destination="Reportes" />)
  expect(screen.getByRole('heading', { name: 'Historial' })).toBeTruthy()
  expect(vi.mocked(useReportController).mock.lastCall?.[3]).toBe(false)
  expect(vi.mocked(useReportController).mock.lastCall?.[4]).toBe(false)
  expect(screen.queryByText('Reporte real autorizado')).toBeNull()
})

test('owner management content suspends analytics while keeping the controller mounted', () => {
  render(<HomeScreen {...props} managementContent={<p>Configuración sintética</p>} managementTitle="Configuración" />)
  expect(screen.getByText('Configuración sintética')).toBeTruthy()
  expect(vi.mocked(useReportController).mock.lastCall?.[3]).toBe(false)
  expect(vi.mocked(useReportController).mock.lastCall?.[4]).toBe(true)
  expect(screen.queryByText('Resumen real autorizado')).toBeNull()
})

function deferredContext() {
  let resolve!: (context: AccountContext) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<AccountContext>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const connected = (id: string): NonNullable<BusinessContext['connectedEmployees']> => [{ id, name: `Persona ${id}`, role: 'cashier', lastSeenAt: '2026-10-03T18:00:00Z' }]
const context = (id: string): AccountContext => ({ business: { ...owner, connectedEmployees: connected(id) }, expiresAt: '2026-10-04T00:00:00Z' })
const lastHome = () => vi.mocked(ReportDashboard).mock.lastCall?.[0]

test('fresh connected employees replace the entry context and focus requests are coalesced', async () => {
  const first = deferredContext(), second = deferredContext()
  vi.mocked(accountRequest).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  render(<HomeScreen {...props} business={{ ...owner, connectedEmployees: connected('previous') }} />)
  expect(lastHome()?.presence?.[0].id).toBe('previous')
  await act(async () => first.resolve(context('current')))
  expect(lastHome()?.presence?.[0].id).toBe('current')
  fireEvent(window, new Event('focus'))
  fireEvent(window, new Event('online'))
  expect(accountRequest).toHaveBeenCalledTimes(2)
  await act(async () => second.resolve(context('latest')))
  expect(lastHome()?.presence?.[0].id).toBe('latest')
})

test('presence errors keep the last valid people and stay marked stale until retry succeeds', async () => {
  const failure = deferredContext(), retry = deferredContext()
  vi.mocked(accountRequest).mockReturnValueOnce(failure.promise).mockReturnValueOnce(retry.promise)
  render(<HomeScreen {...props} business={{ ...owner, connectedEmployees: connected('previous') }} />)
  await act(async () => failure.reject(new Error('Sin conexión')))
  expect(lastHome()?.presence?.[0].id).toBe('previous')
  expect(lastHome()?.presenceError).toBe('No pudimos actualizar los empleados.')
  act(() => lastHome()?.onPresenceRetry?.())
  expect(lastHome()?.presenceError).toBe('No pudimos actualizar los empleados.')
  await act(async () => retry.resolve(context('current')))
  expect(lastHome()?.presence?.[0].id).toBe('current')
  expect(lastHome()?.presenceError).toBe('')
})

test('connected employees update every thirty seconds while Inicio is visible', async () => {
  vi.useFakeTimers()
  vi.mocked(accountRequest).mockResolvedValueOnce(context('first')).mockResolvedValueOnce(context('second'))
  render(<HomeScreen {...props} />)
  await act(async () => {})
  expect(lastHome()?.presence?.[0].id).toBe('first')
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(lastHome()?.presence?.[0].id).toBe('second')
  expect(accountRequest).toHaveBeenCalledTimes(2)
})

test('a late presence response from an earlier operator cannot overwrite the new session', async () => {
  const old = deferredContext(), current = deferredContext()
  vi.mocked(accountRequest).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const view = render(<HomeScreen {...props} />)
  view.rerender(<HomeScreen {...props} operatorToken="new-synthetic-session" />)
  await act(async () => current.resolve(context('new-session')))
  await act(async () => old.resolve(context('old-session')))
  expect(lastHome()?.presence?.[0].id).toBe('new-session')
})
