// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import PointPayment from '../../src/components/PointPayment'
import PointSetup from '../../src/components/PointSetup'
import { AccountClientError } from '../../src/lib/account'
import type { PointController } from '../../src/components/usePoint'
import { pointRequest } from '../../src/lib/point-client'
import type { PointCheckout, PointSettings, PointSimulationStatus } from '../../src/lib/point-contracts'
import { pointAccess, pointCheckout, pointPaid, pointSettings } from '../fixtures/point'

vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
vi.mock('../../src/components/PosShared', () => ({ SaleDetail: () => <p>Recibo sintético</p> }))

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function settings(changes: Partial<PointSettings> = {}): PointSettings {
  return { ...pointSettings(), sandbox: { official: true, available: true, testBusiness: true }, ...changes }
}
function pending(): PointCheckout { return pointCheckout({ state: 'pending', remoteOrderId: 'ORDER-SYNTHETIC', cancelCapability: 'backend' }) }
function controller(value: PointSettings): PointController { return { settings: value, loading: false, error: '', refresh: vi.fn(async () => {}), setSettings: vi.fn() } }
function SetupHarness({ initial }: { initial: PointSettings }) {
  const [value, setValue] = useState<PointSettings | null>(initial)
  return <PointSetup access={pointAccess} controller={{ settings: value, setSettings: setValue, loading: false, error: '', refresh: vi.fn(async () => {}) }} />
}
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('accepting a simulation event never registers a payment before independent status verification and materialization', async () => {
  const event = deferred<{ accepted: true }>(), initial = pending(), onResolved = vi.fn(), onDone = vi.fn()
  let status = initial
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'simulate') return event.promise
    if (command.command === 'status') return status
    throw new Error('Unexpected request')
  })
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={settings()} onResolved={onResolved} onDone={onDone} />)
  const send = screen.getByRole('button', { name: 'Simular resultado' })
  fireEvent.click(send); fireEvent.click(send)
  expect(pointRequest).toHaveBeenCalledExactlyOnceWith(pointAccess, { command: 'simulate', checkoutId: initial.id, status: 'processed' })
  await act(async () => { event.resolve({ accepted: true }); await event.promise })
  expect((screen.getByRole('button', { name: 'Resultado solicitado' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('heading', { name: 'Esperando la terminal' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Pago aprobado' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull()
  expect(screen.queryByText('Recibo sintético')).toBeNull()
  expect(onResolved).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled()

  status = { ...initial, state: 'approved_verified', updatedAt: '2026-10-03T12:00:01Z' }
  fireEvent.click(screen.getByRole('button', { name: 'Consultar estado' }))
  await screen.findByText('Guardando el pago en tu cuenta.')
  expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull()
  expect(screen.queryByText('Recibo sintético')).toBeNull()
  expect(onResolved).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled()

  status = { ...pointPaid(), remoteOrderId: initial.remoteOrderId, updatedAt: '2026-10-03T12:00:02Z' }
  fireEvent.click(screen.getByRole('button', { name: 'Consultar estado' }))
  await screen.findByRole('button', { name: 'Continuar' })
  expect(onResolved).toHaveBeenCalledExactlyOnceWith(status)
  expect(screen.getByText('El pago quedó registrado.')).toBeTruthy()
  expect(onDone).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
  expect(onDone).toHaveBeenCalledExactlyOnceWith(status)
})

test.each<PointSimulationStatus>(['processed', 'failed', 'canceled', 'expired', 'action_required'])('simulation submits only the requested provider status: %s', async status => {
  const initial = pending()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'simulate' ? { accepted: true } : initial)
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={settings()} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Resultado de prueba' }), { target: { value: status } })
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  await screen.findByRole('button', { name: 'Resultado solicitado' })
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'simulate')).toEqual([[pointAccess, { command: 'simulate', checkoutId: initial.id, status }]])
  await waitFor(() => expect(pointRequest).toHaveBeenCalledWith(pointAccess, { command: 'status', checkoutId: initial.id }))
  expect(screen.getByRole('heading', { name: 'Esperando la terminal' })).toBeTruthy()
})

test.each(['employee', 'regular-business', 'local-simulator', 'live', 'shared-device', 'not-dispatched', 'resolved'] as const)('official simulation controls are absent for %s', reason => {
  const value = settings()
  const access = reason === 'shared-device' ? { ...pointAccess, deviceToken: 'synthetic-device' } : pointAccess
  let initial = pending()
  if (reason === 'employee') value.permissions.manage = false
  if (reason === 'regular-business') value.sandbox!.testBusiness = false
  if (reason === 'local-simulator') value.sandbox!.official = false
  if (reason === 'live') value.connection!.environment = 'live'
  if (reason === 'not-dispatched') initial = { ...initial, remoteOrderId: null }
  if (reason === 'resolved') initial = pointPaid()
  render(<PointPayment access={access} initialCheckout={initial} settings={value} />)
  expect(screen.queryByRole('combobox', { name: 'Resultado de prueba' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Simular resultado' })).toBeNull()
  expect(pointRequest).not.toHaveBeenCalled()
})

test('missing official sandbox configuration disables virtual linking and never asks for provider credentials', () => {
  const value = settings({ connection: null, terminals: [], enabled: false, availableEnvironment: null, sandbox: { official: true, available: false, testBusiness: false } })
  const { container } = render(<PointSetup access={pointAccess} controller={controller(value)} />)
  const connect = screen.getByRole('button', { name: 'Vincular terminal virtual' })
  expect((connect as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Cobros reales' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(connect)
  expect(pointRequest).not.toHaveBeenCalled()
  expect(screen.getByRole('link', { name: 'Crear aplicación de Mercado Pago' }).getAttribute('href')).toBe('https://www.mercadopago.com.mx/developers/es/docs/mp-point/create-application')
  expect(screen.queryByRole('button', { name: 'Conectar Mercado Pago' })).toBeNull()
  expect(container.querySelectorAll('input,textarea')).toHaveLength(0)
})

test('virtual linking uses one scoped server operation and goes directly to activation without OAuth or token inputs', async () => {
  const connection = deferred<PointSettings>()
  const connected = settings({ enabled: false })
  const initial = settings({ enabled: false, connection: null, terminals: [], sandbox: { official: true, available: true, testBusiness: false } })
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'connect_sandbox') return connection.promise
    if (command.command === 'resources') return { terminals: connected.terminals, branches: [], registers: [] }
    throw new Error('Unexpected request')
  })
  const { container } = render(<SetupHarness initial={initial} />)
  expect(container.querySelectorAll('input,textarea')).toHaveLength(0)
  const connect = screen.getByRole('button', { name: 'Vincular terminal virtual' })
  fireEvent.click(connect); fireEvent.click(connect)
  expect(pointRequest).toHaveBeenCalledTimes(1)
  expect(pointRequest).toHaveBeenCalledWith(pointAccess, { command: 'connect_sandbox', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  await act(async () => { connection.resolve(connected); await connection.promise })
  await screen.findByRole('heading', { name: 'Activa tu terminal' })
  expect(screen.getByRole('button', { name: 'Activar modo prueba' })).toBeTruthy()
  expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['connect_sandbox', 'resources'])
  expect(container.querySelectorAll('input,textarea')).toHaveLength(0)
})

test('a failed virtual connection preserves its operation ID when retried', async () => {
  vi.mocked(pointRequest).mockRejectedValue(new Error('Conexión interrumpida'))
  const value = settings({ connection: null, terminals: [], enabled: false })
  render(<PointSetup access={pointAccess} controller={controller(value)} />)
  fireEvent.click(screen.getByRole('button', { name: 'Vincular terminal virtual' }))
  await screen.findByRole('alert')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Vincular terminal virtual' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Vincular terminal virtual' }))
  await waitFor(() => expect(pointRequest).toHaveBeenCalledTimes(2))
  expect(vi.mocked(pointRequest).mock.calls[1]).toEqual(vi.mocked(pointRequest).mock.calls[0])
})

test('virtual linking explains the test-business requirement and offers the existing business creation flow', async () => {
  vi.mocked(pointRequest).mockRejectedValue(new AccountClientError('POINT_STATE_INVALID', 'Revisa el estado actual antes de continuar.'))
  const value = settings({ connection: null, terminals: [], enabled: false, sandbox: { official: true, available: true, testBusiness: false } })
  const current = controller(value), onSessionError = vi.fn()
  render(<PointSetup access={pointAccess} controller={current} onSessionError={onSessionError} />)
  fireEvent.click(screen.getByRole('button', { name: 'Vincular terminal virtual' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Usa un negocio nuevo, sin ventas previas, para vincular la terminal virtual.')
  expect(screen.getByRole('link', { name: 'Crear negocio de pruebas' }).getAttribute('href')).toBe('/business/new')
  expect(screen.queryByText('Revisa el estado actual antes de continuar.')).toBeNull()
  expect(current.setSettings).not.toHaveBeenCalled()
  expect(onSessionError).not.toHaveBeenCalled()

  vi.mocked(pointRequest).mockRejectedValue(new Error('Conexión interrumpida'))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Vincular terminal virtual' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Vincular terminal virtual' }))
  await screen.findByText('Conexión interrumpida')
  expect(screen.queryByRole('link', { name: 'Crear negocio de pruebas' })).toBeNull()
})

test('virtual linking still reports expired access to the session controller', async () => {
  const denied = new AccountClientError('SESSION_EXPIRED', 'Tu sesión venció.'), onSessionError = vi.fn()
  vi.mocked(pointRequest).mockRejectedValue(denied)
  render(<PointSetup access={pointAccess} controller={controller(settings({ connection: null, terminals: [], enabled: false }))} onSessionError={onSessionError} />)
  fireEvent.click(screen.getByRole('button', { name: 'Vincular terminal virtual' }))
  await screen.findByRole('alert')
  expect(onSessionError).toHaveBeenCalledExactlyOnceWith(denied)
  expect(screen.queryByRole('link', { name: 'Crear negocio de pruebas' })).toBeNull()
})

test('other terminal state errors do not suggest creating a test business', async () => {
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'resources') return { terminals: [], branches: [], registers: [] }
    throw new AccountClientError('POINT_STATE_INVALID', 'Revisa el estado actual antes de continuar.')
  })
  render(<PointSetup access={pointAccess} controller={controller(settings({ enabled: false }))} />)
  fireEvent.click(screen.getByRole('button', { name: 'Activar modo prueba' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Revisa el estado actual antes de continuar.')
  expect(screen.queryByRole('link', { name: 'Crear negocio de pruebas' })).toBeNull()
})

test('employees cannot start virtual terminal linking', () => {
  const value = settings({ connection: null, terminals: [], enabled: false })
  value.permissions.manage = false
  render(<PointSetup access={pointAccess} controller={controller(value)} />)
  expect(screen.queryByRole('button', { name: 'Vincular terminal virtual' })).toBeNull()
  expect(screen.getByText('El dueño del negocio puede vincular una terminal.')).toBeTruthy()
  expect(pointRequest).not.toHaveBeenCalled()
})

test('the simulator accepts a follow-up result only after observing a new provider state for the same checkout', async () => {
  const initial = pending(), onResolved = vi.fn()
  let status = initial
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'simulate') return { accepted: true }
    if (command.command === 'status') return status
    throw new Error('Unexpected request')
  })
  render(<PointPayment access={pointAccess} initialCheckout={initial} settings={settings()} onResolved={onResolved} />)
  fireEvent.change(screen.getByRole('combobox', { name: 'Resultado de prueba' }), { target: { value: 'action_required' } })
  fireEvent.click(screen.getByRole('button', { name: 'Simular resultado' }))
  await screen.findByRole('button', { name: 'Resultado solicitado' })
  fireEvent.click(screen.getByRole('button', { name: 'Consultar estado' }))
  await waitFor(() => expect(pointRequest).toHaveBeenCalledTimes(3))
  expect((screen.getByRole('button', { name: 'Resultado solicitado' }) as HTMLButtonElement).disabled).toBe(true)
  expect(onResolved).not.toHaveBeenCalled()

  status = { ...initial, state: 'unknown_review', updatedAt: '2026-10-03T12:00:01Z' }
  fireEvent.click(screen.getByRole('button', { name: 'Consultar estado' }))
  await screen.findByRole('heading', { name: 'Pago por confirmar' })
  const send = await screen.findByRole('button', { name: 'Simular resultado' })
  expect((send as HTMLButtonElement).disabled).toBe(false)
  fireEvent.change(screen.getByRole('combobox', { name: 'Resultado de prueba' }), { target: { value: 'processed' } })
  fireEvent.click(send)
  await screen.findByRole('button', { name: 'Resultado solicitado' })
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'simulate').map(([, command]) => command)).toEqual([
    { command: 'simulate', checkoutId: initial.id, status: 'action_required' },
    { command: 'simulate', checkoutId: initial.id, status: 'processed' },
  ])
  expect(onResolved).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: 'Pago por confirmar' })).toBeTruthy()
})

test('a dedicated test business cannot reconnect for real collections', () => {
  const value = settings({ connection: null, terminals: [], enabled: false, availableEnvironment: 'live' })
  render(<PointSetup access={pointAccess} controller={controller(value)} />)
  const live = screen.getByRole('button', { name: 'Cobros reales' })
  expect((live as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(live)
  expect(screen.getByRole('button', { name: 'Pruebas' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Vincular terminal virtual' })).toBeTruthy()
  expect(pointRequest).not.toHaveBeenCalled()
})
