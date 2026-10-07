// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import ServiceOrderPanel from '../../src/features/operations/ServiceOrderPanel'
import ServiceReservations from '../../src/features/operations/ServiceReservations'
import type { BusinessContext } from '../../src/lib/contracts'
import type { OperationalOrder } from '../../src/lib/operations-contracts'
import type { ServiceMutation, ServiceOrderState } from '../../src/lib/service-contracts'
import { posRequest } from '../../src/lib/pos'
import { AccountClientError } from '../../src/lib/account'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const access = { businessId: 'business', operatorToken: 'memory-only-token' }
const business = { id: 'business', name: 'Sintético', role: 'owner', timezone: 'America/Mexico_City', permissions: [], profile: { accountsEnabled: true, paymentMethods: ['cash'] } } as unknown as BusinessContext
const order: OperationalOrder = { id: 'order', revision: 1, name: 'Cuenta', orderKind: 'service', tableId: null, status: 'open', phase: 'service', frozen: false, createdAt: '2026-10-07T12:00:00Z', updatedAt: '2026-10-07T12:00:00Z', operatorName: 'Sintético', items: [{ lineId: 'line', productId: 'product', version: 1, name: 'Café', kitchenName: 'Café', category: '', selectionLabel: 'Grande', note: '', quantity: 3, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 1001, grossCents: 3003, discountCents: 0, totalCents: 3003, taxCents: 0, taxBps: 0, taxTreatment: 'none' }], discount: null, grossCents: 3003, discountCents: 0, totalCents: 3003, taxCents: 0, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 3003 }
const mutation = (): ServiceMutation => ({ busy: false, pending: null, error: '', execute: vi.fn() })
const state: ServiceOrderState = { visit: null, courses: [{ id: 'course', orderId: order.id, name: 'Entradas', status: 'held', items: [{ lineId: 'line', quantity: 2 }], batchId: null, createdAt: '2026-10-07T12:00:00Z', sentAt: null }] }
const props = () => ({ business, access, order, tables: [], mutation: mutation(), onSaved: vi.fn(), onContinue: vi.fn() })

test('keeps held-state unknown until real service data and sends only the chosen course with one submission', async () => {
  let resolveRead!: (value: ServiceOrderState) => void, resolveSend!: (value: unknown) => void
  vi.mocked(posRequest).mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }) as never)
  const input = props(), onHeldChange = vi.fn()
  vi.mocked(input.mutation.execute).mockImplementationOnce(() => new Promise(resolve => { resolveSend = resolve }) as never)
  render(<ServiceOrderPanel {...input} onHeldChange={onHeldChange} />)
  expect(onHeldChange).toHaveBeenCalledWith(order.id, order.revision, null)
  expect(screen.queryByRole('button', { name: 'Añadir tiempo' })).toBeNull()
  await act(async () => resolveRead(state))
  expect(onHeldChange).toHaveBeenLastCalledWith(order.id, order.revision, 1)
  expect(screen.getByText(/Quitar del tiempo libera el envío/)).toBeTruthy()
  const send = screen.getByRole('button', { name: 'Enviar entradas' })
  fireEvent.click(send); fireEvent.click(send)
  expect(input.mutation.execute).toHaveBeenCalledOnce()
  expect(input.mutation.execute).toHaveBeenCalledWith({ command: 'send_service_course', operationId: expect.any(String), orderId: order.id, expectedRevision: order.revision, courseId: 'course' })
  await act(async () => resolveSend({ order: { ...order, revision: 2 }, courses: [{ ...state.courses[0], status: 'sent', batchId: 'batch' }] }))
  expect(input.onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }))
})

test('late reads from a replaced actor never restore the former visit and callback identity does not refetch', async () => {
  let resolveOld!: (value: ServiceOrderState) => void
  vi.mocked(posRequest).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }) as never).mockResolvedValueOnce({ visit: null, courses: [] } as never)
  const input = props(), oldCallback = vi.fn(), newCallback = vi.fn()
  const view = render(<ServiceOrderPanel {...input} onHeldChange={oldCallback} />)
  view.rerender(<ServiceOrderPanel {...input} access={{ ...access, operatorToken: 'new-memory-token' }} onHeldChange={newCallback} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Añadir tiempo' })).toBeTruthy())
  await act(async () => resolveOld(state))
  expect(screen.queryByText('Entradas')).toBeNull()
  view.rerender(<ServiceOrderPanel {...input} access={{ ...access, operatorToken: 'new-memory-token' }} onHeldChange={vi.fn()} />)
  expect(posRequest).toHaveBeenCalledTimes(2)
})

test('continuation opens a new account only after acceptance and never reopens a paid order', async () => {
  vi.mocked(posRequest).mockResolvedValue({ visit: null, courses: [] } as never)
  let accept!: (value: unknown) => void
  const input = props(), paid = { ...order, status: 'closed' as const, phase: 'checkout' as const, frozen: true, paidCents: 3003, balanceCents: 0, items: [{ ...order.items[0], paidQuantity: 3, sentQuantity: 3 }] }
  vi.mocked(input.mutation.execute).mockImplementation(() => new Promise(resolve => { accept = resolve }) as never)
  const view = render(<ServiceOrderPanel {...input} order={paid} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Añadir consumo después del pago' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Añadir consumo después del pago' }))
  fireEvent.click(screen.getByRole('button', { name: 'Abrir cuenta y añadir consumos' }))
  expect(input.onContinue).not.toHaveBeenCalled()
  expect(input.mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'continue_service_order', sourceOrderId: paid.id, orderId: expect.any(String) }))
  view.unmount()
  await act(async () => accept({ order: { ...order, id: 'new-order', items: [] }, visit: {} }))
  expect(input.onContinue).not.toHaveBeenCalled()
})

test('reservation form uses the business timezone and persists exact seating-independent fields', async () => {
  vi.mocked(posRequest).mockResolvedValue({ date: '2026-10-09', timezone: 'America/Mexico_City', reservations: [], visits: [] } as never)
  const request = mutation(); vi.mocked(request.execute).mockResolvedValue({} as never)
  render(<ServiceReservations business={business} access={access} orders={[]} tables={[]} mutation={request} />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'Añadir reservación' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Añadir reservación' }))
  fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: '  Reserva sintética  ' } })
  fireEvent.change(screen.getByLabelText('Inicio · horario del negocio'), { target: { value: '2026-10-09T12:00' } })
  fireEvent.change(screen.getByLabelText('Fin · horario del negocio'), { target: { value: '2026-10-09T13:30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Guardar reservación' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'save_service_reservation', name: 'Reserva sintética', startsAt: '2026-10-09T18:00:00.000Z', endsAt: '2026-10-09T19:30:00.000Z', tableIds: [], expectedRevision: null })))
})

test('agenda failures cannot display a former actor’s contact data', async () => {
  let resolveOld!: (value: unknown) => void
  vi.mocked(posRequest).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }) as never).mockRejectedValueOnce(new Error('Connection lost'))
  const request = mutation(), input = { business, access, orders: [], tables: [], mutation: request }
  const view = render(<ServiceReservations {...input} />)
  view.rerender(<ServiceReservations {...input} access={{ ...access, operatorToken: 'new-operator' }} />)
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  await act(async () => resolveOld({ date: '2026-10-09', timezone: business.timezone, reservations: [{ id: 'reservation', name: 'Former contact', contact: 'Private synthetic contact' }], visits: [] }))
  expect(screen.queryByText('Private synthetic contact')).toBeNull()
})

test('malformed service reads remain an error with unknown holds instead of crashing or enabling checkout', async () => {
  vi.mocked(posRequest).mockResolvedValue({ batches: [] } as never)
  const input = props(), onHeldChange = vi.fn()
  render(<ServiceOrderPanel {...input} onHeldChange={onHeldChange} />)
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(onHeldChange).toHaveBeenLastCalledWith(order.id, order.revision, null)
  expect(screen.queryByRole('button', { name: 'Añadir tiempo' })).toBeNull()
  expect(input.mutation.execute).not.toHaveBeenCalled()
})

test('parent callback changes retain the open course draft without reloading the same order', async () => {
  vi.mocked(posRequest).mockResolvedValue({ visit: null, courses: [] } as never)
  const input = props(), firstHandler = vi.fn(), nextHandler = vi.fn()
  const view = render(<ServiceOrderPanel {...input} onSessionError={firstHandler} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Añadir tiempo' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Añadir tiempo' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Postres sintéticos' } })
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Cantidad de Café' }), { target: { value: '2' } })
  view.rerender(<ServiceOrderPanel {...input} onSessionError={nextHandler} />)
  expect(screen.getByRole('dialog', { name: 'Añadir tiempo' })).toBeTruthy()
  expect((screen.getByRole('textbox', { name: 'Nombre' }) as HTMLInputElement).value).toBe('Postres sintéticos')
  expect((screen.getByRole('spinbutton', { name: 'Cantidad de Café' }) as HTMLInputElement).value).toBe('2')
  expect(posRequest).toHaveBeenCalledOnce()
  expect(firstHandler).not.toHaveBeenCalled()
  expect(nextHandler).not.toHaveBeenCalled()
})

test.each(['order', 'reservations'] as const)('a current %s read failure uses the latest session handler without a new request', async kind => {
  let rejectRead!: (reason: unknown) => void
  vi.mocked(posRequest).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject }) as never)
  const firstHandler = vi.fn(), nextHandler = vi.fn(), input = props(), request = mutation()
  const panel = (handler: (error: AccountClientError) => void) => kind === 'order'
    ? <ServiceOrderPanel {...input} onSessionError={handler} />
    : <ServiceReservations business={business} access={access} orders={[]} tables={[]} mutation={request} onSessionError={handler} />
  const view = render(panel(firstHandler))
  view.rerender(panel(nextHandler))
  expect(posRequest).toHaveBeenCalledOnce()
  const failure = new AccountClientError('SESSION_INVALID', 'Sesión sintética vencida')
  await act(async () => rejectRead(failure))
  expect(firstHandler).not.toHaveBeenCalled()
  expect(nextHandler).toHaveBeenCalledExactlyOnceWith(failure)
})

test('changing the actor closes a course draft and discards acceptance from the former actor', async () => {
  vi.mocked(posRequest).mockResolvedValue({ visit: null, courses: [] } as never)
  let accept!: (value: unknown) => void
  const input = props(), firstHandler = vi.fn(), nextHandler = vi.fn()
  vi.mocked(input.mutation.execute).mockImplementationOnce(() => new Promise(resolve => { accept = resolve }) as never)
  const view = render(<ServiceOrderPanel {...input} onSessionError={firstHandler} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Añadir tiempo' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Añadir tiempo' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Borrador privado sintético' } })
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Cantidad de Café' }), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Retener estos consumos' }))
  expect(input.mutation.execute).toHaveBeenCalledOnce()
  view.rerender(<ServiceOrderPanel {...input} access={{ ...access, operatorToken: 'new-actor-memory-token' }} onSessionError={nextHandler} />)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Añadir tiempo' })).toBeNull())
  await act(async () => accept({ order: { ...order, revision: 2 }, courses: state.courses }))
  expect(input.onSaved).not.toHaveBeenCalled()
  expect(screen.queryByText('Retenido')).toBeNull()
  expect(posRequest).toHaveBeenCalledTimes(2)
  expect(firstHandler).not.toHaveBeenCalled()
  expect(nextHandler).not.toHaveBeenCalled()
})

test('reservation draft survives a parent callback change but closes when the actor changes', async () => {
  vi.mocked(posRequest).mockResolvedValue({ date: '2026-10-09', timezone: business.timezone, reservations: [], visits: [] } as never)
  const input = { business, access, orders: [], tables: [], mutation: mutation() }, firstHandler = vi.fn()
  const view = render(<ServiceReservations {...input} onSessionError={firstHandler} />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'Añadir reservación' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Añadir reservación' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Nombre' }), { target: { value: 'Reserva en captura' } })
  view.rerender(<ServiceReservations {...input} onSessionError={vi.fn()} />)
  expect((screen.getByRole('textbox', { name: 'Nombre' }) as HTMLInputElement).value).toBe('Reserva en captura')
  expect(posRequest).toHaveBeenCalledOnce()
  view.rerender(<ServiceReservations {...input} access={{ ...access, operatorToken: 'next-actor-token' }} onSessionError={vi.fn()} />)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Añadir reservación' })).toBeNull())
  expect(posRequest).toHaveBeenCalledTimes(2)
})
