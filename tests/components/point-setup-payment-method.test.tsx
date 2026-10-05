// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import PointSetup from '../../src/components/PointSetup'
import BusinessSettings from '../../src/components/BusinessSettings'
import { usePoint, type PointController } from '../../src/components/usePoint'
import { pointRequest } from '../../src/lib/point-client'
import { accountRequest } from '../../src/lib/account'
import type { BusinessContext } from '../../src/lib/contracts'
import type { PointSettings } from '../../src/lib/point-contracts'
import { parseAccountRequest } from '../../supabase/functions/account/validation'
import { pointAccess, pointSettings } from '../fixtures/point'

vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
vi.mock('../../src/lib/account', async original => ({ ...await original<object>(), accountRequest: vi.fn() }))
vi.mock('../../src/components/usePoint', () => ({ usePoint: vi.fn() }))

const business: BusinessContext = {
  id: pointAccess.businessId, name: 'Café sintético', businessType: 'cafe', role: 'owner',
  timezone: 'America/Mexico_City', currency: 'MXN', createdAt: '2026-10-03T12:00:00Z',
  profile: { branchName: 'Sucursal', registerName: 'Caja', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] },
}
function controller(value = pointSettings()): PointController {
  return { settings: value, loading: false, error: '', refresh: vi.fn(async () => {}), setSettings: vi.fn() }
}
function ActivationHarness() {
  const [settings, setSettings] = useState<PointSettings | null>({ ...pointSettings(), enabled: false })
  return <PointSetup access={pointAccess} controller={{ ...controller(), settings, setSettings }} paymentMethodEnabled={false} onOpenPaymentMethods={vi.fn()} onStartSale={vi.fn()} />
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('navigator', { onLine: true })
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'resources') return { terminals: [], branches: [], registers: [] }
    if (command.command === 'activate') return pointSettings()
    throw new Error('Unexpected request')
  })
  vi.mocked(usePoint).mockReturnValue(controller())
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test.each(['sandbox', 'live'] as const)('enabled %s terminal still requires the saved payment method before offering a sale', async environment => {
  const value = pointSettings(), configure = vi.fn(), sell = vi.fn(), cash = vi.fn()
  value.connection!.environment = environment
  render(<PointSetup access={pointAccess} controller={controller(value)} paymentMethodEnabled={false} readyToCharge={false} onOpenPaymentMethods={configure} onStartSale={sell} onOpenCash={cash} />)
  expect(screen.getByRole('heading', { name: 'Habilita Tarjeta' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Todo listo para cobrar' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Probar un cobro|Ir a Venta|Ir a Caja/ })).toBeNull()
  const steps = within(screen.getByRole('list', { name: 'Pasos para vincular una terminal' })).getAllByRole('listitem')
  expect(steps[2].getAttribute('data-complete')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Configurar formas de pago' }))
  expect(configure).toHaveBeenCalledOnce()
  expect(sell).not.toHaveBeenCalled(); expect(cash).not.toHaveBeenCalled()
  await waitFor(() => expect(pointRequest).toHaveBeenCalledTimes(1))
  expect(vi.mocked(pointRequest).mock.calls[0][1]).toEqual({ command: 'resources' })
  expect(accountRequest).not.toHaveBeenCalled()
})

test('missing settings navigation does not offer a false ready state or an inert enabled action', () => {
  render(<PointSetup access={pointAccess} controller={controller()} paymentMethodEnabled={false} onStartSale={vi.fn()} />)
  expect((screen.getByRole('button', { name: 'Configurar formas de pago' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Probar un cobro' })).toBeNull()
})

test('saved payment method unlocks the sale action and completed activation step', () => {
  const props = { access: pointAccess, controller: controller(), onOpenPaymentMethods: vi.fn(), onStartSale: vi.fn() }
  const view = render(<PointSetup {...props} paymentMethodEnabled={false} />)
  view.rerender(<PointSetup {...props} paymentMethodEnabled />)
  expect(screen.getByRole('heading', { name: 'Todo listo para cobrar' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Configurar formas de pago' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Probar un cobro' }))
  expect(props.onStartSale).toHaveBeenCalledOnce()
  const steps = within(screen.getByRole('list', { name: 'Pasos para vincular una terminal' })).getAllByRole('listitem')
  expect(steps[2].getAttribute('data-complete')).toBe('true')
})

test('activating a terminal never silently enables the business payment method', async () => {
  render(<ActivationHarness />)
  fireEvent.click(screen.getByRole('button', { name: 'Activar modo prueba' }))
  await screen.findByRole('heading', { name: 'Habilita Tarjeta' })
  expect(screen.queryByRole('button', { name: 'Probar un cobro' })).toBeNull()
  expect(pointRequest).toHaveBeenCalledWith(pointAccess, { command: 'activate', enabled: true })
  expect(accountRequest).not.toHaveBeenCalled()
})

test('settings shortcut focuses Tarjeta without checking or saving it; an unsaved check is not readiness', async () => {
  render(<BusinessSettings business={business} operatorToken={pointAccess.operatorToken} onSaved={vi.fn()} onBack={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Vincular una terminal' }))
  expect(screen.getByRole('heading', { name: 'Habilita Tarjeta' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Configurar formas de pago' }))
  const method = screen.getByRole('checkbox', { name: 'Tarjeta' }) as HTMLInputElement
  expect(document.activeElement).toBe(method)
  expect(method.checked).toBe(false)
  expect(accountRequest).not.toHaveBeenCalled()
  fireEvent.click(method)
  expect(method.checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Vincular una terminal' }))
  expect(screen.getByRole('heading', { name: 'Habilita Tarjeta' })).toBeTruthy()
  expect(accountRequest).not.toHaveBeenCalled()
  await waitFor(() => expect(pointRequest).toHaveBeenCalledTimes(2))
})

test('entering settings from the dashboard shortcut focuses the payment method', () => {
  render(<BusinessSettings business={business} operatorToken={pointAccess.operatorToken} focusPaymentMethods onSaved={vi.fn()} onBack={vi.fn()} />)
  expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Tarjeta' }))
  expect(accountRequest).not.toHaveBeenCalled()
})

test('saving the three methods sends a valid HTTP profile and returns the persisted configuration', async () => {
  const saved = vi.fn()
  vi.mocked(accountRequest).mockImplementation(async request => {
    const parsed = parseAccountRequest(request)
    if (parsed.action !== 'update_business') throw new Error('Unexpected request')
    return { ...business, profile: parsed.profile } as never
  })
  render(<BusinessSettings business={business} operatorToken={'a'.repeat(64)} onSaved={saved} onBack={vi.fn()} />)
  for (const label of ['Transferencia', 'Tarjeta']) fireEvent.click(screen.getByRole('checkbox', { name: label }))
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(saved.mock.calls[0][0].profile.paymentMethods).toEqual(['cash', 'transfer', 'card_integrated'])
  expect(vi.mocked(accountRequest).mock.calls[0][0]).toMatchObject({ action: 'update_business', profile: { paymentMethods: ['cash', 'transfer', 'card_integrated'] } })
})

test('a legacy external-card preference converts only when the owner explicitly saves', async () => {
  const saved = vi.fn()
  const legacy = { ...business, profile: { ...business.profile, paymentMethods: ['cash', 'card_external', 'card_integrated'] as BusinessContext['profile']['paymentMethods'] } }
  vi.mocked(accountRequest).mockImplementation(async request => {
    const parsed = parseAccountRequest(request)
    if (parsed.action !== 'update_business') throw new Error('Unexpected request')
    return { ...business, profile: parsed.profile } as never
  })
  render(<BusinessSettings business={legacy} operatorToken={'a'.repeat(64)} onSaved={saved} onBack={vi.fn()} />)
  expect((screen.getByRole('checkbox', { name: 'Tarjeta' }) as HTMLInputElement).checked).toBe(true)
  expect(screen.getAllByRole('checkbox')).toHaveLength(3)
  expect(screen.queryByRole('checkbox', { name: 'Tarjeta externa' })).toBeNull()
  expect(accountRequest).not.toHaveBeenCalled()
  expect(legacy.profile.paymentMethods).toEqual(['cash', 'card_external', 'card_integrated'])
  fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }))
  await waitFor(() => expect(saved).toHaveBeenCalledOnce())
  expect(vi.mocked(accountRequest).mock.calls[0][0]).toMatchObject({ profile: { paymentMethods: ['cash', 'card_integrated'] } })
  expect(saved.mock.calls[0][0].profile.paymentMethods).toEqual(['cash', 'card_integrated'])
})
