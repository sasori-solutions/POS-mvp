// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import HomeScreen from '../../src/components/HomeScreen'
import { useCatalog } from '../../src/components/useCatalog'
import { useOperations } from '../../src/features/operations/useOperations'
import type { BusinessContext } from '../../src/lib/contracts'

vi.mock('../../src/components/useCatalog', () => ({ accessErrorCodes: [], useCatalog: vi.fn(() => ({ products: [], paymentMethods: ['cash'] })) }))
vi.mock('../../src/features/operations/useOperations', () => ({
  useOperations: vi.fn(() => ({ snapshot: { enabled: true, shift: { status: 'open' }, orders: [], tables: [], attempts: [], pendingKitchenCount: 3 }, refresh: vi.fn(), error: '' })),
  useOperationalMutation: () => ({ busy: false, pending: null, error: '', execute: vi.fn() }),
}))
vi.mock('../../src/features/operations/ReportDashboard', () => ({ default: () => <p>Resumen real autorizado</p> }))
vi.mock('../../src/components/SaleScreen', () => ({ default: () => <p>Tomar venta</p> }))
vi.mock('../../src/features/operations/OrdersScreen', () => ({ default: () => <p>Preparación de comandas</p> }))
vi.mock('../../src/components/SalesScreen', () => ({ default: ({ collectionAllowed }: { collectionAllowed: boolean }) => <p>{collectionAllowed ? 'Devoluciones disponibles' : 'Sin turno'}</p> }))
const owner = { id: 'synthetic-business', name: 'Café sintético', role: 'owner', timezone: 'America/Mexico_City', profile: { paymentMethods: ['cash'] } } as BusinessContext
const props = { business: owner, operatorToken: 'memory-only', busy: false, error: '', onLock: vi.fn(), onLogout: vi.fn() }
afterEach(() => { cleanup(); vi.clearAllMocks() })

test('owner enters Inicio without loading the catalog or operational snapshots, then can sell', () => {
  render(<HomeScreen {...props} />)
  expect(screen.getByRole('heading', { name: 'Inicio' })).toBeTruthy()
  expect(vi.mocked(useCatalog).mock.lastCall?.[1]).toBe(false)
  expect(vi.mocked(useOperations).mock.lastCall?.[1]).toBe(false)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Navegación principal' })).getByRole('button', { name: 'Ventas' }))
  expect(vi.mocked(useOperations).mock.lastCall?.[1]).toBe(true)
  expect(screen.getByText('Devoluciones disponibles')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Ir a venta' })[0])
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
})
