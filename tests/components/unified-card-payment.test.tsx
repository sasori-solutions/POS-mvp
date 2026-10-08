// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import PaymentMethodPicker from '../../src/components/PaymentMethodPicker'
import OrderDetail from '../../src/features/operations/OrderDetail'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { OperationalOrder } from '../../src/lib/operations-contracts'
import type { BusinessContext, PaymentMethod } from '../../src/lib/contracts'
import type { PointSettings } from '../../src/lib/point-contracts'
import { posRequest } from '../../src/lib/pos'
import { pointRequest } from '../../src/lib/point-client'
import { pointAccess, pointCheckout, pointId, pointSettings } from '../fixtures/point'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
const allMethods: PaymentMethod[] = ['cash', 'card_external', 'card_integrated', 'transfer']
const business = { id: pointAccess.businessId, name: 'Negocio sintético', role: 'owner', profile: { paymentMethods: allMethods } } as BusinessContext
const prepared = pointCheckout().checkout
const order: OperationalOrder = {
  id: prepared.orderId!, revision: 1, name: 'Cuenta sintética', tableId: null, status: 'open', phase: 'checkout', frozen: false,
  createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z', operatorName: 'Persona sintética',
  items: [{ lineId: pointId(3), productId: pointId(4), version: 1, name: 'Café', kitchenName: 'Café', category: '', selectionLabel: '', note: '', quantity: 2, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 5000, grossCents: 10000, discountCents: 0, totalCents: 10000, taxCents: 1379, taxBps: 1600, taxTreatment: 'vat_16' }],
  discount: null, grossCents: 10000, discountCents: 0, totalCents: 10000, taxCents: 1379, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 10000,
}
function mutation(): OperationalMutation {
  return { execute: vi.fn(async command => ({ ...prepared, revision: 2, paymentMethod: 'paymentMethod' in command ? command.paymentMethod : prepared.paymentMethod })), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } as OperationalMutation
}
function checkout(methods = allMethods, settings: PointSettings | null = pointSettings(), attempt = { ...prepared, paymentMethod: 'cash' as PaymentMethod }, context = business) {
  const request = mutation()
  vi.mocked(posRequest).mockImplementation(async () => attempt)
  render(<OrderDetail checkoutView access={pointAccess} order={order} business={context} methods={methods} attempts={[attempt]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn(async () => {})} collectionAllowed pointSettings={settings} />)
  return request
}
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('external and integrated cards are separate configured collection choices', () => {
  const change = vi.fn()
  render(<PaymentMethodPicker methods={allMethods} value="cash" onChange={change} disabled={false} name="payment" />)
  expect(screen.getAllByRole('radio')).toHaveLength(4)
  const card = screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }) as HTMLInputElement
  expect(card.value).toBe('card_integrated')
  expect((screen.getByRole('radio', { name: 'Tarjeta externa' }) as HTMLInputElement).value).toBe('card_external')
  fireEvent.click(card)
  expect(change).toHaveBeenCalledWith('card_integrated')
})

test.each(['missing', 'paused', 'revoked', 'unverified', 'permission'] as const)('card stays visible but cannot collect with %s readiness', async condition => {
  const settings = pointSettings()
  if (condition === 'paused') settings.chargesEnabled = false
  if (condition === 'revoked') settings.connection!.status = 'revoked'
  if (condition === 'unverified') settings.terminals[0].verified = false
  if (condition === 'permission') settings.permissions.charge = false
  const request = checkout(allMethods, condition === 'missing' ? null : settings)
  const card = screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }) as HTMLInputElement
  expect(card.disabled).toBe(true)
  fireEvent.click(card)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
  expect(request.execute).not.toHaveBeenCalled()
  expect(screen.queryByText('Cobra en tu terminal externa.')).toBeNull()
})

test('an external-only profile keeps its configured method without requiring Point activation', () => {
  const request = checkout(['card_external'], pointSettings(), { ...prepared, paymentMethod: 'card_external' })
  expect(screen.getAllByRole('radio', { name: /Tarjeta/ })).toHaveLength(1)
  expect(screen.queryByRole('radio', { name: 'Tarjeta Mercado Pago' })).toBeNull()
  expect(screen.queryByText('Activa Mercado Pago Point en Formas de pago.')).toBeNull()
  expect((screen.getByRole('radio', { name: 'Tarjeta externa' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
  expect(request.execute).not.toHaveBeenCalled()
  expect(pointRequest).not.toHaveBeenCalled()
})

test.each(['cashier', 'manager'] as const)('configured external cards are available to a %s with collection permission', role => {
  const employee = { ...business, role, permissions: ['sales.create', 'catalog.read'] as BusinessContext['permissions'] }
  const request = checkout(['card_external'], pointSettings(), { ...prepared, paymentMethod: 'card_external' }, employee)
  expect(screen.queryByText('El dueño debe activar Mercado Pago Point en Formas de pago.')).toBeNull()
  expect(screen.queryByRole('radio', { name: 'Tarjeta Mercado Pago' })).toBeNull()
  expect((screen.getByRole('radio', { name: 'Tarjeta externa' }) as HTMLInputElement).disabled).toBe(false)
  expect(screen.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' })).toBeTruthy()
  expect(request.execute).not.toHaveBeenCalled()
  expect(pointRequest).not.toHaveBeenCalled()
})

test.each(['owner', 'cashier'] as const)('pausing Point leaves external registration available to %s', role => {
  const context = { ...business, role, permissions: ['sales.create', 'catalog.read'] as BusinessContext['permissions'] }
  const settings = { ...pointSettings(), chargesEnabled: false }
  const request = checkout(allMethods, settings, { ...prepared, paymentMethod: 'card_external' }, context)
  expect(screen.getByText('Los cobros con Mercado Pago Point están pausados.')).toBeTruthy()
  expect((screen.getByRole('radio', { name: 'Tarjeta externa' }) as HTMLInputElement).disabled).toBe(false)
  expect((screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }) as HTMLInputElement).disabled).toBe(true)
  expect(request.execute).not.toHaveBeenCalled()
  expect(pointRequest).not.toHaveBeenCalled()
})

test('Point has its own linking hint when its method is configured without a terminal', () => {
  checkout(['cash', 'card_integrated'], null)
  expect(screen.getByText('Vincula una terminal Point para cobrar con Mercado Pago.')).toBeTruthy()
  expect(screen.queryByText(/activar Tarjeta|Activa Tarjeta/)).toBeNull()
})

test('choosing card updates a known prepared legacy quote to Point without manually recording a payment', async () => {
  const request = checkout(allMethods, pointSettings(), { ...prepared, paymentMethod: 'card_external' })
  expect(request.execute).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledOnce())
  expect(vi.mocked(request.execute).mock.calls[0][0]).toMatchObject({ command: 'update_checkout', attemptId: prepared.id, expectedRevision: prepared.revision, paymentMethod: 'card_integrated' })
  expect(screen.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  expect((screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }) as HTMLInputElement).checked).toBe(true)
  expect(pointRequest).not.toHaveBeenCalled()
})

test('card selection uses Point prepare/start and never record_checkout', async () => {
  const request = checkout()
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => ({ ...pointCheckout(), checkout: { ...prepared, revision: 2 }, state: command.command === 'start' ? 'pending' : 'prepared' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }))
  await waitFor(() => expect((screen.getByRole('button', { name: /^Enviar a terminal/ }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: /^Enviar a terminal/ }))
  await waitFor(() => expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['prepare', 'start']))
  expect(vi.mocked(request.execute).mock.calls.every(([command]) => command.command === 'update_checkout')).toBe(true)
})

test.each(['collection_started', 'uncertain'] as const)('historical %s card collection preserves the original attempt for recovery', async status => {
  const request = checkout(allMethods, pointSettings(), { ...prepared, paymentMethod: 'card_external', status })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
  expect(screen.queryByRole('radio', { name: /Tarjeta/ })).toBeNull()
  expect(screen.getByText(/Tarjeta externa · Persona sintética/)).toBeTruthy()
  expect(request.execute).not.toHaveBeenCalled()
  expect(pointRequest).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' }))
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledOnce())
  expect(vi.mocked(request.execute).mock.calls[0][0]).toMatchObject({ command: 'resolve_checkout', attemptId: prepared.id, expectedRevision: prepared.revision, resolution: 'complete', confirmed: true })
  expect(pointRequest).not.toHaveBeenCalled()
})

test('a known prepared legacy card quote can safely switch to configured cash while card is unavailable', async () => {
  const request = checkout(['card_external', 'cash'], null, { ...prepared, paymentMethod: 'card_external' })
  fireEvent.click(screen.getByRole('radio', { name: 'Efectivo' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledOnce())
  expect(vi.mocked(request.execute).mock.calls[0][0]).toMatchObject({ command: 'update_checkout', attemptId: prepared.id, paymentMethod: 'cash' })
  expect(pointRequest).not.toHaveBeenCalled()
})

test('loading readiness cannot hide the card option or prevent a later ready reservation', async () => {
  vi.mocked(posRequest).mockResolvedValue({ ...prepared, revision: 2 })
  const request = mutation(), attributes = { checkoutView: true, access: pointAccess, order, business, methods: ['card_integrated'] as PaymentMethod[], attempts: [], mutation: request, onSaved: vi.fn(), onEdit: vi.fn(), refresh: vi.fn(async () => {}), collectionAllowed: true }
  const view = render(<OrderDetail {...attributes} pointSettings={null} />)
  expect((screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }) as HTMLInputElement).disabled).toBe(true)
  expect(request.execute).not.toHaveBeenCalled()
  view.rerender(<OrderDetail {...attributes} pointSettings={pointSettings()} />)
  await waitFor(() => expect(request.execute).toHaveBeenCalledOnce())
  expect(vi.mocked(request.execute).mock.calls[0][0]).toMatchObject({ command: 'prepare_checkout', paymentMethod: 'card_integrated', orderId: order.id })
  expect((screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }) as HTMLInputElement).disabled).toBe(false)
})
