// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import PointSetup from '../../src/components/PointSetup'
import { pointRequest } from '../../src/lib/point-client'
import type { PointController } from '../../src/components/usePoint'
import type { PointSettings } from '../../src/lib/point-contracts'
import { pointAccess, pointSettings } from '../fixtures/point'

vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
function controller(changes: Partial<PointSettings> = {}): PointController {
  return { settings: { ...pointSettings(), ...changes }, loading: false, error: '', refresh: vi.fn(async () => {}), setSettings: vi.fn() }
}
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('a dedicated test business explains the real-payment boundary without offering a conversion', () => {
  render(<PointSetup access={pointAccess} controller={controller({ connection: null, terminals: [], enabled: false, availableEnvironment: 'live', sandbox: { official: true, available: true, testBusiness: true } })} />)
  expect(screen.getByText('Este negocio conserva las pruebas. Para cobros reales, usa un negocio aparte.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Cobros reales' }) as HTMLButtonElement).disabled).toBe(true)
  expect(pointRequest).not.toHaveBeenCalled()
})

test('a real business explains why production authorization is not available yet', () => {
  render(<PointSetup access={pointAccess} controller={controller({ connection: null, terminals: [], enabled: false, availableEnvironment: null, sandbox: { official: true, available: true, testBusiness: false } })} />)
  expect(screen.getByText('Los cobros reales todavía no están habilitados.')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Cobros reales' }) as HTMLButtonElement).disabled).toBe(true)
})

test('a connected test business offers a separate real business and preserves its current connection', async () => {
  vi.mocked(pointRequest).mockResolvedValue({ branches: [], registers: [], terminals: [] } as never)
  render(<PointSetup access={pointAccess} controller={controller({ availableEnvironment: 'live', sandbox: { official: true, available: true, testBusiness: true } })} />)
  const link = screen.getByRole('link', { name: 'Crear negocio real' })
  expect(link.getAttribute('href')).toBe('/business/new')
  expect(screen.getByText('Este negocio conserva las pruebas. Para cobros reales, usa un negocio aparte.')).toBeTruthy()
  await waitFor(() => expect(pointRequest).toHaveBeenCalledExactlyOnceWith(pointAccess, { command: 'resources' }))
})

test.each([true, false])('the server charge gate overrides business enabled=%s without blocking recovery', async enabled => {
  vi.mocked(pointRequest).mockResolvedValue({ branches: [], registers: [], terminals: [] } as never)
  const onStartSale = vi.fn()
  render(<PointSetup access={pointAccess} controller={controller({ enabled, chargesEnabled: false })} onStartSale={onStartSale} />)
  expect(screen.getByRole('heading', { name: 'Cobros pausados' })).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Cobros pausados' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Los cobros con terminal están pausados. Los pagos pendientes se siguen consultando.')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Todo listo para cobrar' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Activar modo prueba' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Probar un cobro' })).toBeNull()
  expect(onStartSale).not.toHaveBeenCalled()
  await waitFor(() => expect(pointRequest).toHaveBeenCalledExactlyOnceWith(pointAccess, { command: 'resources' }))
})

test('a lost register response keeps the same operation on retry and changes it only for a new payload', async () => {
  let creates = 0
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'resources') return { branches: [{ id: '1001', name: 'Sucursal sintética' }], registers: [], terminals: [] }
    if (command.command === 'create_register') { creates++; throw new Error('Sin respuesta. Intenta de nuevo.') }
    throw new Error('Unexpected request')
  })
  render(<PointSetup access={pointAccess} controller={controller({ terminals: [], enabled: false })} />)
  await waitFor(() => expect(pointRequest).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre de la nueva caja' }), { target: { value: 'Caja sintética' } })
  const create = screen.getByRole('button', { name: 'Crear caja' })
  fireEvent.click(create)
  await screen.findByRole('alert')
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(create)
  await waitFor(() => expect(creates).toBe(2))
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
  const initial = vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'create_register').map(([, command]) => command)
  expect(initial[1]).toEqual(initial[0])
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre de la nueva caja' }), { target: { value: 'Otra caja' } })
  fireEvent.click(create)
  await waitFor(() => expect(creates).toBe(3))
  const third = vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'create_register')[2][1]
  expect(third).toMatchObject({ command: 'create_register', name: 'Otra caja' })
  expect('operationId' in third && third.operationId).not.toBe('operationId' in initial[0] && initial[0].operationId)
})

test('a lost store response preserves the operation identity until its name or location changes', async () => {
  let creates = 0
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'resources') return { branches: [], registers: [], terminals: [] }
    if (command.command === 'create_branch') { creates++; throw new Error('Sin respuesta. Intenta de nuevo.') }
    throw new Error('Unexpected request')
  })
  render(<PointSetup access={pointAccess} controller={controller({ terminals: [], enabled: false })} />)
  await waitFor(() => expect(pointRequest).toHaveBeenCalledTimes(1))
  const fields = { 'Nombre de la sucursal': 'Sucursal sintética', Calle: 'Calle sintética', Número: '10', Ciudad: 'Ciudad de México', Estado: 'Ciudad de México', Latitud: '19.43', Longitud: '-99.13' }
  for (const [name, value] of Object.entries(fields)) fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
  const create = screen.getByRole('button', { name: 'Crear sucursal' })
  fireEvent.click(create)
  await screen.findByRole('alert')
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(create)
  await waitFor(() => expect(creates).toBe(2))
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
  const initial = vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'create_branch').map(([, command]) => command)
  expect(initial[1]).toEqual(initial[0])
  fireEvent.change(screen.getByRole('textbox', { name: 'Número' }), { target: { value: '11' } })
  fireEvent.click(create)
  await waitFor(() => expect(creates).toBe(3))
  const third = vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'create_branch')[2][1]
  expect(third).toMatchObject({ command: 'create_branch', location: { street_number: '11', latitude: 19.43, longitude: -99.13 } })
  expect('operationId' in third && third.operationId).not.toBe('operationId' in initial[0] && initial[0].operationId)
})
