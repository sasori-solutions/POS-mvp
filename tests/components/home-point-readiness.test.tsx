// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import HomeScreen from '../../src/components/HomeScreen'
import { usePoint } from '../../src/components/usePoint'
import { businessDate } from '../../src/lib/reporting'
import type { BusinessContext } from '../../src/lib/contracts'
import { pointAccess, pointSettings } from '../fixtures/point'

vi.mock('../../src/components/usePoint', () => ({ usePoint: vi.fn() }))
vi.mock('../../src/components/WorkspaceShell', () => ({ default: ({ children }: { children: ReactNode }) => <main>{children}</main> }))
vi.mock('../../src/components/SaleScreen', () => ({ default: () => <section aria-label="Venta sintética" /> }))
vi.mock('../../src/components/useCatalog', async original => ({ ...await original<object>(), useCatalog: () => ({ products: [], paymentMethods: ['cash'], loaded: true, loading: false, error: '', refresh: vi.fn(async () => {}), upsert: vi.fn(), remove: vi.fn() }) }))
vi.mock('../../src/features/operations/useOperations', () => ({
  useOperations: () => ({ snapshot: null, error: '', loading: false, refresh: vi.fn(async () => {}) }),
  useOperationalMutation: () => ({ execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() }),
}))
vi.mock('../../src/features/operations/usePeriodReport', () => ({ useReportController: (_access: unknown, timezone: string) => ({ date: businessDate(timezone), period: 'day', setDate: vi.fn(), setPeriod: vi.fn(), report: null, loading: false, initialLoading: false, refresh: vi.fn(async () => {}) }) }))
const business: BusinessContext = {
  id: pointAccess.businessId, name: 'Negocio sintético', businessType: 'cafe', role: 'owner', timezone: 'America/Mexico_City', currency: 'MXN', createdAt: '2026-10-03T12:00:00Z',
  profile: { branchName: 'Sucursal', registerName: 'Caja', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash', 'card_external'] },
}
const pointRefresh = vi.fn(async () => {})
const props = { business, operatorToken: pointAccess.operatorToken, destination: 'Venta' as const, onLock: vi.fn(), onLogout: vi.fn(), busy: false, error: '' }
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear()
  vi.stubGlobal('navigator', { onLine: true })
  vi.mocked(usePoint).mockReturnValue({ settings: { ...pointSettings(), enabled: false }, loading: false, error: '', refresh: pointRefresh, setSettings: vi.fn() })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('returning from settings reads current terminal readiness before relying on the thirty-second background refresh', () => {
  const view = render(<HomeScreen {...props} managementContent={<p>Configuración sintética</p>} managementKey="settings" />)
  expect(pointRefresh).not.toHaveBeenCalled()
  view.rerender(<HomeScreen {...props} />)
  expect(pointRefresh).toHaveBeenCalledOnce()
  view.rerender(<HomeScreen {...props} unreadCount={1} />)
  expect(pointRefresh).toHaveBeenCalledOnce()
})

test('a saved payment-method change requests fresh readiness exactly once without writing provider settings', () => {
  const view = render(<HomeScreen {...props} />)
  expect(pointRefresh).not.toHaveBeenCalled()
  const updated = { ...business, profile: { ...business.profile, paymentMethods: ['cash', 'card_integrated'] as BusinessContext['profile']['paymentMethods'] } }
  view.rerender(<HomeScreen {...props} business={updated} />)
  expect(pointRefresh).toHaveBeenCalledOnce()
  view.rerender(<HomeScreen {...props} business={updated} notice="Aviso sintético" />)
  expect(pointRefresh).toHaveBeenCalledOnce()
  expect(vi.mocked(usePoint).mock.results.at(-1)?.value.setSettings).not.toHaveBeenCalled()
})

test('saving while inside settings defers Home readiness to the return, using the persisted profile', () => {
  const content = <p>Configuración sintética</p>
  const view = render(<HomeScreen {...props} managementContent={content} managementKey="settings" />)
  const updated = { ...business, profile: { ...business.profile, paymentMethods: ['cash', 'card_integrated'] as BusinessContext['profile']['paymentMethods'] } }
  view.rerender(<HomeScreen {...props} business={updated} managementContent={content} managementKey="settings" />)
  expect(pointRefresh).not.toHaveBeenCalled()
  view.rerender(<HomeScreen {...props} business={updated} />)
  expect(pointRefresh).toHaveBeenCalledOnce()
})

test('changing the operator while leaving settings relies on the new scoped controller and never refreshes the previous one', () => {
  const view = render(<HomeScreen {...props} managementContent={<p>Configuración sintética</p>} />)
  view.rerender(<HomeScreen {...props} operatorToken="next-synthetic-session" />)
  expect(pointRefresh).not.toHaveBeenCalled()
})
