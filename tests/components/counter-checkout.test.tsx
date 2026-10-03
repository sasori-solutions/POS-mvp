// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import HomeScreen from '../../src/components/HomeScreen'
import { posRequest } from '../../src/lib/pos'
import { useCatalog, type CatalogState } from '../../src/components/useCatalog'
import { useOperations, useOperationalMutation, type OperationalMutation } from '../../src/features/operations/useOperations'
import type { BusinessContext } from '../../src/lib/contracts'
import type { OperationalOrder, OperationsSnapshot, CheckoutAttempt } from '../../src/lib/operations-contracts'
import type { Product } from '../../src/lib/pos-contracts'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
vi.mock('../../src/components/useCatalog', async original => ({ ...await original<object>(), useCatalog: vi.fn() }))
vi.mock('../../src/features/operations/useOperations', async original => ({ ...await original<object>(), useOperations: vi.fn(), useOperationalMutation: vi.fn() }))
const business: BusinessContext = { id: 'business', name: 'Mostrador sintético', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner', createdAt: '2026-10-02T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] } }
const product: Product = { id: 'product', name: 'Café', category: 'Bebidas', priceCents: 3500, version: 1, active: true }
const order: OperationalOrder = { id: 'saved-order', revision: 1, name: 'Mostrador', tableId: null, status: 'open', phase: 'service', frozen: false, createdAt: business.createdAt, updatedAt: business.createdAt, operatorName: 'Persona sintética', items: [{ lineId: 'accepted-line', productId: product.id, version: 1, name: product.name, kitchenName: product.name, category: product.category, selectionLabel: 'Chico', note: '', quantity: 1, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 3500, grossCents: 3500, discountCents: 0, totalCents: 3500, taxCents: 483, taxBps: 1600, taxTreatment: 'vat_16' }], discount: null, grossCents: 3500, discountCents: 0, totalCents: 3500, taxCents: 483, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 3500 }
let catalog: CatalogState, snapshot: OperationsSnapshot, mutation: OperationalMutation
const refresh = vi.fn().mockResolvedValue(undefined)
const props = { destination: 'Venta' as const, business, operatorToken: 'synthetic-memory-only', onLock: vi.fn(), onLogout: vi.fn(), busy: false, error: '' }
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
beforeEach(() => {
  localStorage.clear()
  catalog = { products: [product], paymentMethods: ['cash'], loaded: true, loading: false, error: '', refresh, upsert: vi.fn(), remove: vi.fn() }
  snapshot = { enabled: true, shift: null, orders: [], tables: [], attempts: [] }
  mutation = { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() }
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command === 'prepare_checkout') {
      const quote = {id:'reserved-attempt',revision:1,kind:'payment',status:'prepared',orderId:command.orderId,shiftId:'shift',paymentMethod:command.paymentMethod,totalCents:3500,taxCents:483,discountCents:0,items:command.items,createdAt:business.createdAt} as CheckoutAttempt;
      vi.mocked(posRequest).mockResolvedValue(quote);
      return quote;
    }
    if (command.command !== 'save_order') throw new Error('Unexpected mutation')
    return { ...order, id: command.orderId }
  })
  vi.mocked(useCatalog).mockImplementation(() => catalog)
  vi.mocked(useOperations).mockImplementation(() => ({ snapshot, loading: false, error: '', refresh }))
  vi.mocked(useOperationalMutation).mockImplementation(() => mutation)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })
function currentSale() { return within(screen.getByRole('complementary', { name: 'Venta actual' })) }
async function saveAndClose() {
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  const dialog = await screen.findByRole('dialog', { name: 'Cobrar' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
}

test('opening checkout shows payment methods immediately and has no manual edit, kitchen or finalization steps', async () => {
  render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
  expect((dialog.getByRole('radio', { name: 'Efectivo' }) as HTMLInputElement).checked).toBe(true)
  for (const name of ['Editar artículos', 'Enviar nuevos artículos a cocina', 'Finalizar cuenta para cobrar']) expect(dialog.queryByRole('button', { name })).toBeNull()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
  expect(vi.mocked(mutation.execute).mock.calls[0][0].command).toBe('save_order')
})

test('one click registers payment and returns to an empty sale without preparation or confirmation steps', async () => {
  snapshot = { ...snapshot, shift: { id: 'shift', status: 'open' } as OperationsSnapshot['shift'] }
  render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const paid = { ...saved, status: 'closed' as const, revision: 4, frozen: true, paidCents: 3500, balanceCents: 0 }
  await waitFor(() => expect((dialog.getByRole('button', {name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
  vi.mocked(mutation.execute).mockResolvedValueOnce({ order: paid, attempt: { status: 'completed' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cobrar' })).toBeNull())
  expect(mutation.execute).toHaveBeenCalledTimes(3)
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'record_checkout', attemptId: 'reserved-attempt', expectedRevision: 1, confirmed: true }))
  expect(screen.queryByRole('button', { name: 'Iniciar cobro' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Confirmar pago recibido' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Continuar con la cuenta' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Aumentar Café' })).toBeNull()
})

test('a lost registration response retains the account and retries the same payment operation', async () => {
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  await screen.findByRole('dialog', { name: 'Cobrar' })
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const pending = { command: 'record_payment' as const, operationId: 'original-operation', orderId: saved.id, expectedRevision: 1, paymentMethod: 'cash' as const, confirmed: true as const, items: [{ lineId: saved.items[0].lineId, quantity: 1 }] }
  mutation = { ...mutation, pending, error: 'No pudimos confirmar la solicitud.' }
  view.rerender(<HomeScreen {...props} />)
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
  vi.mocked(mutation.execute).mockResolvedValueOnce({ order: { ...saved, status: 'closed', revision: 4, paidCents: 3500, balanceCents: 0 }, attempt: { status: 'completed' } })
  const dialog = within(screen.getByRole('dialog', { name: 'Cobrar' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Reintentar solicitud guardada' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cobrar' })).toBeNull())
  expect(mutation.execute).toHaveBeenLastCalledWith(pending)
})

test('the back arrow releases an unpaid prepared attempt and returns to the editable account', async () => {
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  const dialog = await screen.findByRole('dialog', { name: 'Cobrar' })
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const prepared: CheckoutAttempt = { id: 'prepared-attempt', revision: 1, kind: 'payment', status: 'prepared', orderId: saved.id, shiftId: 'shift', saleId: null, originalSaleId: null, paymentMethod: 'cash', totalCents: 3500, taxCents: 483, discountCents: 0, operatorName: saved.operatorName, resolverName: null, createdAt: business.createdAt, resolvedAt: null, reason: '', items: [] }
  snapshot = { ...snapshot, orders: [{ ...saved, phase: 'checkout', revision: 2 }], attempts: [prepared] }
  view.rerender(<HomeScreen {...props} />)
  vi.mocked(mutation.execute).mockResolvedValueOnce({ ...prepared, status: 'aborted', revision: 2 })
  refresh.mockImplementationOnce(async () => { snapshot = { ...snapshot, orders: [{ ...saved, revision: 3, phase: 'service' }], attempts: [] } })
  vi.mocked(posRequest).mockResolvedValueOnce(prepared)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
  expect(await screen.findByRole('dialog', {name:'¿Volver a la cuenta?'})).toBeTruthy()
  expect(mutation.execute).not.toHaveBeenLastCalledWith(expect.objectContaining({command:'resolve_checkout'}))
  fireEvent.click(screen.getByRole('button', {name:'Volver sin haber recibido pago'}))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  view.rerender(<HomeScreen {...props} />)
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'resolve_checkout', attemptId: prepared.id, expectedRevision: 1, resolution: 'abort', confirmed: true }))
  expect((currentSale().getByRole('button', { name: 'Aumentar Café' }) as HTMLButtonElement).disabled).toBe(false)
})

test('closing the collection panel preserves the order and reopening it never creates another account', async () => {
  render(<HomeScreen {...props} />)
  await saveAndClose()
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  expect(currentSale().getByLabelText('Cantidad de Café').textContent).toBe('1')
  expect(currentSale().queryByText('Tu cuenta está vacía')).toBeNull()
  fireEvent.click(currentSale().getByRole('button', { name: 'Cobrar' }))
  expect(await screen.findByRole('dialog', { name: 'Cobrar' })).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
})

test('a saved account keeps its accepted selections, discount and IVA when the catalog changes', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const discounted = { ...saved, revision: 2, discount: { kind: 'fixed' as const, value: 500, reason: 'Descuento sintético' }, discountCents: 500, totalCents: 3000, taxCents: 414, balanceCents: 3000, items: saved.items.map(line => ({ ...line, discountCents: 500, totalCents: 3000, taxCents: 414 })) }
  snapshot = { ...snapshot, orders: [discounted] }
  catalog = { ...catalog, products: [] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByText('Chico')).toBeTruthy()
  expect(currentSale().getByText('$4.14')).toBeTruthy()
  expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy()
  expect(currentSale().queryByText('Tu cuenta está vacía')).toBeNull()
})

test('partial payment retains the account; only its resolved status clears it', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const partial: OperationalOrder = { ...saved, revision: 2, phase: 'checkout', frozen: true, grossCents: 7000, totalCents: 7000, taxCents: 966, paidCents: 3500, balanceCents: 3500, items: saved.items.map(line => ({ ...line, quantity: 2, paidQuantity: 1, grossCents: 7000, totalCents: 7000, taxCents: 966 })) }
  snapshot = { ...snapshot, orders: [{ ...saved, id: 'another-account', status: 'paid' }, partial] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy()
  snapshot = { ...snapshot, orders: [{ ...partial, revision: 3, status: 'paid', paidCents: 7000, balanceCents: 0, items: partial.items.map(line => ({ ...line, paidQuantity: 2 })) }] }
  view.rerender(<HomeScreen {...props} />)
  await waitFor(() => expect(currentSale().getByText('Tu cuenta está vacía')).toBeTruthy())
  snapshot = { ...snapshot, orders: [] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByText('Tu cuenta está vacía')).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
})

test('the draft survives management screens and clearing asks for confirmation', () => {
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  view.rerender(<HomeScreen {...props} managementTitle="Empleados" managementKey="team" managementContent={<p>Gestión del equipo</p>} />)
  expect(screen.queryByRole('button', { name: 'Aumentar Café' })).toBeNull()
  expect(screen.getByText('Gestión del equipo')).toBeTruthy()
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  expect(currentSale().queryByRole('button', { name: 'Nueva cuenta' })).toBeNull()
  fireEvent.click(currentSale().getByRole('button', { name: 'Borrar cuenta' }))
  const confirmation = within(screen.getByRole('dialog', { name: 'Borrar cuenta' }))
  fireEvent.click(confirmation.getByRole('button', { name: 'Cancelar' }))
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  fireEvent.click(currentSale().getByRole('button', { name: 'Borrar cuenta' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Borrar cuenta' })).getByRole('button', { name: 'Borrar cuenta' }))
  expect(currentSale().getByText('Tu cuenta está vacía')).toBeTruthy()
})

test('an exact retry after a lost save response restores the accepted account and can resume it', async () => {
  const command = { command: 'save_order' as const, operationId: 'original-operation', orderId: order.id, expectedRevision: null, name: 'Mostrador', tableId: null, items: [] }
  mutation = { ...mutation, pending: command }
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud guardada' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledWith(command))
  mutation = { ...mutation, pending: null, lastResult: { command: 'save_order', result: order } }
  view.rerender(<HomeScreen {...props} />)
  const dialog = await screen.findByRole('dialog', { name: 'Cobrar' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
  fireEvent.click(currentSale().getByRole('button', { name: 'Cobrar' }))
  expect(await screen.findByRole('dialog', { name: 'Cobrar' })).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
})

test('a zero-balance open account remains visible until its status is explicitly resolved', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  snapshot = { ...snapshot, orders: [{ ...saved, revision: 2, totalCents: 0, balanceCents: 0, discount: { kind: 'percent', value: 10000, reason: 'Cortesía sintética' }, discountCents: 3500, taxCents: 0, items: saved.items.map(line => ({ ...line, totalCents: 0, discountCents: 3500, taxCents: 0 })) }] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy()
})

test('saving another counter account does not replace a draft being entered in Venta', () => {
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  mutation = { ...mutation, lastResult: { command: 'save_order', result: order } }
  view.rerender(<HomeScreen {...props} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(currentSale().getByRole('button', { name: 'Aumentar Café' })).toBeTruthy()
  expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy()
})

test('after closing collection, additions and quantity changes update the same account without reopening the panel', async () => {
  render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command === 'prepare_checkout') {
      const quote = {id:'reserved-attempt',revision:1,kind:'payment',status:'prepared',orderId:command.orderId,shiftId:'shift',paymentMethod:command.paymentMethod,totalCents:3500,taxCents:483,discountCents:0,items:command.items,createdAt:business.createdAt} as CheckoutAttempt;
      vi.mocked(posRequest).mockResolvedValue(quote);
      return quote;
    }
    if (command.command !== 'save_order') throw new Error('Unexpected mutation')
    const quantity = command.items[0].quantity, totalCents = quantity * 3500
    return { ...saved, revision: (command.expectedRevision ?? 0) + 1, totalCents, grossCents: totalCents, balanceCents: totalCents, items: saved.items.map(line => ({ ...line, quantity, totalCents, grossCents: totalCents })) }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  await waitFor(() => expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy())
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 1, items: [expect.objectContaining({ lineId: saved.items[0].lineId, quantity: 2, unitPriceCents: 3500, version: 1 })] }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(currentSale().getByRole('button', { name: 'Disminuir Café' }))
  await waitFor(() => expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy())
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 2, items: [expect.objectContaining({ lineId: saved.items[0].lineId, quantity: 1 })] }))
})

test('adding a different product preserves accepted line IDs, prices, notes and selections', async () => {
  const water = { ...product, id: 'water', name: 'Agua', priceCents: 2500 }
  catalog = { ...catalog, products: [product, water] }
  render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Agua, $25.00' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledTimes(2))
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 1, items: [expect.objectContaining({ lineId: saved.items[0].lineId, productId: product.id, quantity: 1, unitPriceCents: 3500, version: 1, note: '' }), expect.objectContaining({ productId: water.id, quantity: 1, unitPriceCents: 2500, version: 1 })] }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

function acceptCounterEdits(saved: OperationalOrder) {
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command === 'prepare_checkout') {
      const quote = {id:'reserved-attempt',revision:1,kind:'payment',status:'prepared',orderId:command.orderId,shiftId:'shift',paymentMethod:command.paymentMethod,totalCents:3500,taxCents:483,discountCents:0,items:command.items,createdAt:business.createdAt} as CheckoutAttempt;
      vi.mocked(posRequest).mockResolvedValue(quote);
      return quote;
    }
    if (command.command !== 'save_order') throw new Error('Unexpected mutation')
    const items = command.items.map(input => {
      const original = saved.items.find(line => line.lineId === input.lineId)
      const product = catalog.products.find(product => product.id === input.productId)!
      const totalCents = input.quantity * input.unitPriceCents
      return { ...order.items[0], ...original, ...input, name: original?.name ?? product.name, selectionLabel: original?.selectionLabel ?? '', grossCents: totalCents, discountCents: 0, totalCents, taxCents: 0 }
    })
    const totalCents = items.reduce((sum, line) => sum + line.totalCents, 0)
    return { ...saved, revision: command.expectedRevision! + 1, items, discount: null, grossCents: totalCents, discountCents: 0, totalCents, taxCents: 0, balanceCents: totalCents }
  })
}

test('removing the original item preserves newer items and the same account identity', async () => {
  const water = { ...product, id: 'water', name: 'Agua', priceCents: 2500 }
  catalog = { ...catalog, products: [product, water] }
  render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  acceptCounterEdits(saved)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Agua, $25.00' }))
  await waitFor(() => expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy())
  const addition = vi.mocked(mutation.execute).mock.calls[1][0]
  if (addition.command !== 'save_order') throw new Error('Expected save')
  const waterLine = addition.items.find(line => line.productId === water.id)!
  fireEvent.click(currentSale().getByRole('button', { name: 'Quitar Café' }))
  await waitFor(() => expect(currentSale().queryByText('Café')).toBeNull())
  expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy()
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 2, items: [waterLine] }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test.each(['Quitar Café', 'Disminuir Café'])('the last item can be removed with %s and the account refilled without reviving the draft', async action => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  acceptCounterEdits(saved)
  fireEvent.click(currentSale().getByRole('button', { name: action }))
  await waitFor(() => expect(currentSale().getByText('Tu cuenta está vacía')).toBeTruthy())
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 1, items: [] }))
  expect((currentSale().getByRole('button', { name: 'Cobrar' }) as HTMLButtonElement).disabled).toBe(true)
  snapshot = { ...snapshot, orders: [saved] } // A delayed old snapshot must not restore removed items.
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().queryByText('Café')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  await waitFor(() => expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy())
  const refill = vi.mocked(mutation.execute).mock.calls[2][0]
  expect(refill).toMatchObject({ orderId: saved.id, expectedRevision: 2, items: [{ quantity: 1, productId: product.id }] })
  if (refill.command !== 'save_order') throw new Error('Expected save')
  expect(refill.items[0].lineId).not.toBe(saved.items[0].lineId)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('retrying a lost removal response keeps the same operation and restores the empty account without reopening collection', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  vi.mocked(mutation.execute).mockRejectedValueOnce(new Error('No pudimos confirmar la solicitud.'))
  fireEvent.click(currentSale().getByRole('button', { name: 'Quitar Café' }))
  await currentSale().findByText('No pudimos confirmar la solicitud.')
  const remove = vi.mocked(mutation.execute).mock.calls[1][0]
  if (remove.command !== 'save_order') throw new Error('Expected save')
  mutation = { ...mutation, pending: remove }
  acceptCounterEdits(saved)
  view.rerender(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud guardada' }))
  await waitFor(() => expect(currentSale().getByText('Tu cuenta está vacía')).toBeTruthy())
  expect(mutation.execute).toHaveBeenLastCalledWith(remove)
  expect(screen.queryByRole('dialog')).toBeNull()
  mutation = { ...mutation, pending: null }
  view.rerender(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  await waitFor(() => expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy())
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 2, items: [expect.objectContaining({ quantity: 1 })] }))
})

test('sent items cannot be removed or reduced below their sent quantity', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  snapshot = { ...snapshot, orders: [{ ...saved, revision: 2, items: saved.items.map(line => ({ ...line, sentQuantity: 1 })) }] }
  view.rerender(<HomeScreen {...props} />)
  expect((currentSale().getByRole('button', { name: 'Quitar Café' }) as HTMLButtonElement).disabled).toBe(true)
  expect((currentSale().getByRole('button', { name: 'Disminuir Café' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(currentSale().getByRole('button', { name: 'Quitar Café' }))
  expect(mutation.execute).toHaveBeenCalledTimes(1)
})

test('back refreshes a remotely aborted attempt and restores editing without aborting it twice', async () => {
  const view=render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button',{name:'Agregar Café, $35.00'}))
  fireEvent.click(screen.getByRole('button',{name:'Cobrar'}))
  const dialog=await screen.findByRole('dialog',{name:'Cobrar'})
  const saved=await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const prepared={id:'remote-attempt',kind:'payment',status:'prepared',revision:1,orderId:saved.id,items:[{lineId:saved.items[0].lineId,quantity:1}],paymentMethod:'cash',createdAt:business.createdAt} as CheckoutAttempt
  snapshot={...snapshot,orders:[{...saved,phase:'checkout',revision:2}],attempts:[prepared]}
  view.rerender(<HomeScreen {...props} />)
  vi.mocked(posRequest).mockResolvedValueOnce({...prepared,status:'aborted',revision:2})
  refresh.mockImplementationOnce(async()=>{snapshot={...snapshot,orders:[{...saved,phase:'service',revision:3}],attempts:[]}})
  fireEvent.click(within(dialog).getByRole('button',{name:'Cerrar'}))
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
  expect(vi.mocked(mutation.execute).mock.calls.filter(([command])=>command.command==='resolve_checkout')).toHaveLength(0)
  view.rerender(<HomeScreen {...props} />)
  expect((currentSale().getByRole('button',{name:'Aumentar Café'}) as HTMLButtonElement).disabled).toBe(false)
})
