// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import CheckoutPanel from '../../src/components/CheckoutPanel'
import OrderDetail from '../../src/features/operations/OrderDetail'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { BusinessContext } from '../../src/lib/contracts'
import { checkoutTotals } from '../../src/lib/checkout-selection'
import { posRequest } from '../../src/lib/pos'
import { orderDiscountPreview } from '../../src/features/operations/order-discount-model'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const operationalRead = vi.fn<typeof posRequest>()
const business = { id: 'synthetic-business', name: 'Café sintético', role: 'owner', permissions: [], profile: { paymentMethods: ['cash', 'transfer'] } } as unknown as BusinessContext
const order: OperationalOrder = {
  id: 'synthetic-order', revision: 1, name: 'Cuenta sintética', tableId: null, status: 'open', phase: 'checkout', frozen: false,
  createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z', operatorName: 'Persona sintética',
  items: [{ lineId: 'synthetic-line', productId: 'synthetic-product', version: 1, name: 'Café', kitchenName: 'Café', category: '', selectionLabel: '', note: '', quantity: 3, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 1001, grossCents: 3003, discountCents: 0, totalCents: 3003, taxCents: 0, taxBps: 0, taxTreatment: 'vat_0' }],
  discount: null, grossCents: 3003, discountCents: 0, totalCents: 3003, taxCents: 0, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 3003,
}
function quoteFor(value = order, quantity = 3): CheckoutAttempt {
  const items = [{ lineId: value.items[0].lineId, quantity }]
  const totals = checkoutTotals(value, items)
  return { id: 'synthetic-quote', revision: 1, kind: 'payment', status: 'prepared', orderId: value.id, shiftId: 'synthetic-shift', paymentMethod: 'transfer', ...totals, items: [{ ...value.items[0], ...items[0], ...totals }], saleId: null, originalSaleId: null, operatorName: 'Persona sintética', resolverName: null, createdAt: value.createdAt, resolvedAt: null, reason: '' }
}
function mutation(): OperationalMutation { return { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } }
const access = { businessId: business.id, operatorToken: 'synthetic-memory-only' }
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  // Library reads must never consume an order/attempt response or its lost-response error.
  vi.mocked(posRequest).mockImplementation((currentAccess, command) => command.command === 'promotions'
    ? Promise.resolve({ promotions: [] }) as never : operationalRead(currentAccess, command))
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })
function Harness({ request, attempts = [], initial = order, onSaved = vi.fn(), collectionAllowed = true }: { request: OperationalMutation; attempts?: CheckoutAttempt[]; initial?: OperationalOrder; onSaved?: (value: OperationalOrder) => void; collectionAllowed?: boolean }) {
  const [value, setValue] = useState(initial)
  return <OrderDetail checkoutView order={value} business={business} methods={['cash', 'transfer']} attempts={attempts} mutation={request} access={access} onSaved={saved => { setValue(saved); onSaved(saved) }} onEdit={vi.fn()} refresh={vi.fn().mockResolvedValue(undefined)} collectionAllowed={collectionAllowed} />
}
function fillDiscount() {
  fireEvent.click(screen.getByRole('button', { name: 'Añadir descuento' }))
  fireEvent.click(screen.getByRole('button', { name: '10%' }))
  fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Cortesía sintética' } })
}
async function confirmTransfer() {
  const confirmation = await screen.findByRole('checkbox', { name: 'Confirmo que el comercio recibió esta transferencia.' }) as HTMLInputElement
  await waitFor(() => expect(confirmation.disabled).toBe(false))
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(confirmation)
}

test('editing pauses the pending reservation and applies the discount through the required order phases', async () => {
  const request = mutation()
  let server = order
  vi.mocked(request.execute).mockImplementation(async command => {
    if (command.command === 'prepare_checkout') return { ...quoteFor(server), paymentMethod: command.paymentMethod }
    if (command.command === 'resume_order_service') { server = { ...server, revision: server.revision + 1, phase: 'service' }; return server }
    if (command.command === 'set_order_discount') {
      expect(command.expectedRevision).toBe(server.revision)
      expect(server.phase).toBe('service')
      const totals = command.discount ? orderDiscountPreview(server.grossCents, command.discount.kind, command.discount.value)! : { totalCents: server.grossCents, discountCents: 0 }
      server = { ...server, revision: server.revision + 1, discount: command.discount, ...totals, balanceCents: totals.totalCents, items: [{ ...server.items[0], ...totals }] }
      return server
    }
    if (command.command === 'begin_order_checkout') { server = { ...server, revision: server.revision + 1, phase: 'checkout' }; return server }
    throw new Error('Unexpected command')
  })
  operationalRead.mockImplementation(async () => ({ ...quoteFor(server), paymentMethod: 'cash' }))
  render(<Harness request={request} />)
  fillDiscount()
  expect(screen.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  expect(screen.getByText('$27.03')).toBeTruthy()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
  expect(request.execute).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' }))
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Aplicar descuento' })).toBeNull())
  expect(vi.mocked(request.execute).mock.calls.slice(0, 2).map(([command]) => command.command)).toEqual(['resume_order_service', 'set_order_discount'])
  await waitFor(() => expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(false))
  expect(screen.getByText('Editar descuento')).toBeTruthy()
})

test('a reserved discount applies directly and retries a failed read without aborting twice', async () => {
  const request = mutation(), quote = quoteFor()
  let server = order
  vi.mocked(request.execute).mockImplementation(async command => {
    if (command.command === 'resolve_checkout') { server = { ...server, revision: 2, phase: 'service' }; return { ...quote, revision: 2, status: 'aborted' } }
    if (command.command === 'set_order_discount') {
      expect(command.expectedRevision).toBe(2)
      server = { ...server, revision: 3, discount: command.discount, discountCents: 300, totalCents: 2703, balanceCents: 2703, items: [{ ...server.items[0], discountCents: 300, totalCents: 2703 }] }
      return server
    }
    if (command.command === 'begin_order_checkout') { server = { ...server, phase: 'checkout', revision: 4 }; return server }
    if (command.command === 'prepare_checkout') return { ...quoteFor(server), id: 'synthetic-new-quote' }
    throw new Error('Unexpected command')
  })
  operationalRead.mockRejectedValueOnce(new Error('Sin conexión. Inténtalo de nuevo.')).mockImplementation(async (_access, command) => command.command === 'order' ? server : { ...quoteFor(server), id: 'synthetic-new-quote' })
  render(<Harness request={request} attempts={[quote]} />)
  fillDiscount()
  expect((screen.getByRole('button', { name: 'Aplicar descuento' }) as HTMLButtonElement).disabled).toBe(false)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByText(/recibí|recibiste|confirma/i)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Sin conexión. Inténtalo de nuevo.')
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' }))
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Aplicar descuento' })).toBeNull())
  expect(vi.mocked(request.execute).mock.calls.filter(([command]) => command.command === 'resolve_checkout')).toHaveLength(1)
  expect(vi.mocked(posRequest).mock.calls.filter(([, command]) => command.command === 'order')).toHaveLength(2)
  expect(server.discount?.value).toBe(1000)
})

test('removing a reserved discount directly replaces its quote using the fresh order revision', async () => {
  const request = mutation()
  let server: OperationalOrder = {
    ...order, revision: 3, discount: { kind: 'percent', value: 1000, reason: 'Cortesía sintética' },
    discountCents: 300, totalCents: 2703, balanceCents: 2703,
    items: [{ ...order.items[0], discountCents: 300, totalCents: 2703 }],
  }
  const quote = quoteFor(server)
  vi.mocked(request.execute).mockImplementation(async command => {
    if (command.command === 'resolve_checkout') {
      expect(command).toMatchObject({ attemptId: quote.id, expectedRevision: quote.revision, resolution: 'abort', confirmed: true })
      server = { ...server, revision: 4, phase: 'service' }
      return { ...quote, revision: 2, status: 'aborted' }
    }
    if (command.command === 'set_order_discount') {
      expect(command).toMatchObject({ expectedRevision: 4, discount: null })
      server = { ...server, revision: 5, discount: null, discountCents: 0, totalCents: 3003, balanceCents: 3003, items: [{ ...server.items[0], discountCents: 0, totalCents: 3003 }] }
      return server
    }
    if (command.command === 'prepare_checkout') return { ...quoteFor(server), id: 'synthetic-undiscounted-quote', paymentMethod: command.paymentMethod }
    throw new Error('Unexpected command')
  })
  operationalRead.mockImplementation(async (_access, command) => command.command === 'order' ? server : { ...quoteFor(server), id: 'synthetic-undiscounted-quote' })
  render(<Harness request={request} initial={server} attempts={[quote]} />)
  fireEvent.click(screen.getByRole('button', { name: /Editar descuento/ }))
  expect(screen.queryByRole('checkbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Quitar descuento' }))
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Editar descuento' })).toBeNull())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText(/recibí|recibiste|confirma/i)).toBeNull()
  expect(vi.mocked(request.execute).mock.calls.filter(([command]) => command.command === 'resolve_checkout')).toHaveLength(1)
  expect(vi.mocked(request.execute).mock.calls.filter(([command]) => command.command === 'set_order_discount')).toHaveLength(1)
  await confirmTransfer()
  await waitFor(() => expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(false))
  expect(server.totalCents).toBe(3003)
})

test('the checkout stays locked during a discount read and a late reply after unmount never continues the workflow', async () => {
  const request = mutation(), quote = quoteFor(), onClose = vi.fn(), onSaved = vi.fn()
  let complete!: (value: OperationalOrder) => void
  operationalRead.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  vi.mocked(request.execute).mockResolvedValue({ ...quote, revision: 2, status: 'aborted' })
  const view = render(<CheckoutPanel onClose={onClose}><Harness request={request} attempts={[quote]} onSaved={onSaved} /></CheckoutPanel>)
  fillDiscount()
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' }))
  await waitFor(() => expect(operationalRead).toHaveBeenCalledWith(access, { command: 'order', orderId: order.id }))
  const close = document.querySelector<HTMLButtonElement>('.checkout-back')!
  expect(close.disabled).toBe(true)
  fireEvent.click(close)
  expect(onClose).not.toHaveBeenCalled()
  view.unmount()
  await act(async () => complete({ ...order, revision: 2, phase: 'service' }))
  expect(request.execute).toHaveBeenCalledOnce()
  expect(onSaved).not.toHaveBeenCalled()
})

test('quantities, mode and method stay fixed while a payment is being recorded', async () => {
  const request = mutation(), quote = quoteFor(order, 1)
  let complete!: (value: unknown) => void
  vi.mocked(request.execute).mockImplementation(() => new Promise(resolve => { complete = resolve }) as never)
  render(<Harness request={request} attempts={[quote]} />)
  await confirmTransfer()
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  expect((screen.getByRole('button', { name: 'Añadir Café a este cobro' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('radio', { name: 'Cobrar todo' }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('radio', { name: 'Efectivo' }) as HTMLInputElement).disabled).toBe(true)
  const partial = { ...order, revision: 2, frozen: true, paidCents: 1001, balanceCents: 2002, items: [{ ...order.items[0], paidQuantity: 1 }] }
  await act(async () => complete({ order: partial, attempt: { ...quote, status: 'completed' } }))
  expect((screen.getByRole('spinbutton', { name: 'Cantidad a cobrar de Café' }) as HTMLInputElement).value).toBe('0')
  expect((screen.getByRole('radio', { name: 'Transferencia' }) as HTMLInputElement).checked).toBe(true)
  expect(screen.getByText('Pago registrado · $10.01')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
})

test('a reservation with a different accepted amount cannot enable payment beside outdated figures', () => {
  const request = mutation()
  render(<Harness request={request} attempts={[{ ...quoteFor(), totalCents: 3002 }]} />)
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
})

test('recovering the exact discount request accepts the saved amount and closes the editor without applying twice', async () => {
  const request = mutation(), onSaved = vi.fn()
  const serviceOrder: OperationalOrder = { ...order, revision: 2, phase: 'service' }
  const discount = { kind: 'percent' as const, value: 1000, reason: 'Cortesía sintética' }
  const discounted: OperationalOrder = {
    ...serviceOrder, revision: 3, discount, discountCents: 300, totalCents: 2703, balanceCents: 2703,
    items: [{ ...order.items[0], discountCents: 300, totalCents: 2703 }],
  }
  vi.mocked(request.execute).mockImplementation(async command => {
    if (command.command === 'resume_order_service') return serviceOrder
    if (command.command === 'set_order_discount') throw new Error('Respuesta perdida del descuento')
    if (command.command === 'prepare_checkout') return { ...quoteFor(discounted), paymentMethod: command.paymentMethod }
    throw new Error('Unexpected command')
  })
  operationalRead.mockImplementation(async (_access, command) => command.command === 'order' ? discounted : quoteFor(discounted))
  const view = render(<Harness request={request} onSaved={onSaved} />)
  fillDiscount()
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Respuesta perdida del descuento')
  const original = vi.mocked(request.execute).mock.calls.find(([command]) => command.command === 'set_order_discount')![0]
  view.rerender(<Harness request={{ ...request, pending: original }} onSaved={onSaved} />)
  expect((screen.getByRole('button', { name: 'Aplicar descuento' }) as HTMLButtonElement).disabled).toBe(true)
  // HomeScreen retries the original UUID and exposes its accepted result through lastResult.
  view.rerender(<Harness request={{ ...request, lastResult: { command: 'set_order_discount', result: discounted } }} onSaved={onSaved} />)
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Aplicar descuento' })).toBeNull())
  expect(onSaved).toHaveBeenCalledWith(discounted)
  expect(screen.queryByText('Respuesta perdida del descuento')).toBeNull()
  expect(screen.getByText('Editar descuento')).toBeTruthy()
  expect(vi.mocked(request.execute).mock.calls.filter(([command]) => command.command === 'set_order_discount')).toHaveLength(1)
})

test('recovering resume service keeps the discount draft and uses the recovered revision on the next apply', async () => {
  const request = mutation(), onSaved = vi.fn()
  const serviceOrder: OperationalOrder = { ...order, revision: 2, phase: 'service' }
  const discounted: OperationalOrder = {
    ...serviceOrder, revision: 3, discount: { kind: 'percent', value: 1000, reason: 'Cortesía sintética' },
    discountCents: 300, totalCents: 2703, balanceCents: 2703,
    items: [{ ...order.items[0], discountCents: 300, totalCents: 2703 }],
  }
  vi.mocked(request.execute).mockImplementation(async command => {
    if (command.command === 'resume_order_service') throw new Error('Respuesta perdida al editar')
    if (command.command === 'set_order_discount') return discounted
    if (command.command === 'prepare_checkout') return { ...quoteFor(discounted), paymentMethod: command.paymentMethod }
    throw new Error('Unexpected command')
  })
  operationalRead.mockImplementation(async (_access, command) => command.command === 'order' ? serviceOrder : quoteFor(discounted))
  const view = render(<Harness request={request} onSaved={onSaved} />)
  fillDiscount()
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Respuesta perdida al editar')
  const original = vi.mocked(request.execute).mock.calls.find(([command]) => command.command === 'resume_order_service')![0]
  view.rerender(<Harness request={{ ...request, pending: original }} onSaved={onSaved} />)
  view.rerender(<Harness request={{ ...request, lastResult: { command: 'resume_order_service', result: serviceOrder } }} onSaved={onSaved} />)
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(serviceOrder))
  expect(screen.queryByText('Respuesta perdida al editar')).toBeNull()
  expect((screen.getByLabelText('Motivo') as HTMLInputElement).value).toBe('Cortesía sintética')
  expect((screen.getByLabelText('Porcentaje') as HTMLInputElement).value).toBe('10%')
  fireEvent.click(screen.getByRole('button', { name: 'Aplicar descuento' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'set_order_discount', expectedRevision: 2 })))
  expect(vi.mocked(request.execute).mock.calls.filter(([command]) => command.command === 'resume_order_service')).toHaveLength(1)
})

test('reopening a saved discount does not treat a preexisting accepted result as a new application', async () => {
  const request = mutation(), onSaved = vi.fn()
  const discounted: OperationalOrder = {
    ...order, revision: 3, phase: 'service', discount: { kind: 'percent', value: 1000, reason: 'Cortesía sintética' },
    discountCents: 300, totalCents: 2703, balanceCents: 2703,
    items: [{ ...order.items[0], discountCents: 300, totalCents: 2703 }],
  }
  request.lastResult = { command: 'set_order_discount', result: discounted }
  // The saved result survives checkout closure; a closed shift does not replace it with an automatic reservation.
  render(<Harness request={request} initial={discounted} collectionAllowed={false} onSaved={onSaved} />)
  fireEvent.click(screen.getByRole('button', { name: /Editar descuento/ }))
  expect(screen.getByRole('form', { name: 'Editar descuento' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '15%' }))
  expect((screen.getByLabelText('Porcentaje') as HTMLInputElement).value).toBe('15%')
  expect((screen.getByRole('button', { name: 'Guardar descuento' }) as HTMLButtonElement).disabled).toBe(false)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
  expect(screen.getByRole('form', { name: 'Editar descuento' })).toBeTruthy()
  expect(onSaved).not.toHaveBeenCalled()
  expect(request.execute).not.toHaveBeenCalled()
})
