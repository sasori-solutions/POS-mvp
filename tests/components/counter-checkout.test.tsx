// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import HomeScreen from '../../src/components/HomeScreen'
import { posRequest } from '../../src/lib/pos'
import { accountRequest, deviceRequest } from '../../src/lib/account'
import { useCatalog, type CatalogState } from '../../src/components/useCatalog'
import { useOperations, useOperationalMutation, type OperationalMutation } from '../../src/features/operations/useOperations'
import type { BusinessContext } from '../../src/lib/contracts'
import type { OperationalOrder, OperationsSnapshot, CheckoutAttempt } from '../../src/lib/operations-contracts'
import type { Product } from '../../src/lib/pos-contracts'
import { checkoutTotals } from '../../src/lib/checkout-selection'

vi.mock('../../src/lib/account', async original => ({ ...await original<object>(), accountRequest: vi.fn(), deviceRequest: vi.fn() }))
vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
vi.mock('../../src/components/useCatalog', async original => ({ ...await original<object>(), useCatalog: vi.fn() }))
vi.mock('../../src/features/operations/useOperations', async original => ({ ...await original<object>(), useOperations: vi.fn(), useOperationalMutation: vi.fn() }))
const business: BusinessContext = { id: 'business', name: 'Mostrador sintético', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner', createdAt: '2026-10-02T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'], accountsEnabled: false } }
const product: Product = { id: 'product', name: 'Café', category: 'Bebidas', priceCents: 3500, version: 1, active: true }
const order: OperationalOrder = { id: 'saved-order', revision: 1, name: 'Mostrador', orderKind: 'counter', tableId: null, status: 'open', phase: 'service', frozen: false, createdAt: business.createdAt, updatedAt: business.createdAt, operatorName: 'Persona sintética', items: [{ lineId: 'accepted-line', productId: product.id, version: 1, name: product.name, kitchenName: product.name, category: product.category, selectionLabel: 'Chico', note: '', quantity: 1, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 3500, grossCents: 3500, discountCents: 0, totalCents: 3500, taxCents: 483, taxBps: 1600, taxTreatment: 'vat_16' }], discount: null, grossCents: 3500, discountCents: 0, totalCents: 3500, taxCents: 483, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 3500 }
let catalog: CatalogState, snapshot: OperationsSnapshot, mutation: OperationalMutation
const refresh = vi.fn().mockResolvedValue(undefined)
const props = { destination: 'Venta' as const, business, operatorToken: 'synthetic-memory-only', onLock: vi.fn(), onLogout: vi.fn(), busy: false, error: '' }
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(query => ({matches:query === '(prefers-reduced-motion: reduce)',addEventListener:vi.fn(),removeEventListener:vi.fn()})))
  localStorage.clear()
  vi.mocked(accountRequest).mockResolvedValue({business, expiresAt:'2026-10-03T22:00:00Z'})
  vi.mocked(deviceRequest).mockResolvedValue({business, expiresAt:'2026-10-03T22:00:00Z'})
  catalog = { products: [product], paymentMethods: ['cash'], loaded: true, loading: false, error: '', refresh, upsert: vi.fn(), remove: vi.fn() }
  snapshot = { enabled: true, shift: { id: 'shift', status: 'open' } as OperationsSnapshot['shift'], orders: [], tables: [], attempts: [] }
  mutation = { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() }
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command === 'prepare_checkout') {
      const quote = {id:'reserved-attempt',revision:1,kind:'payment',status:'prepared',orderId:command.orderId,shiftId:'shift',paymentMethod:command.paymentMethod,totalCents:3500,taxCents:483,discountCents:0,items:command.items,createdAt:business.createdAt} as CheckoutAttempt;
      vi.mocked(posRequest).mockResolvedValue(quote);
      return quote;
    }
    if (command.command !== 'save_order') throw new Error('Unexpected mutation')
    return { ...order, id: command.orderId, orderKind: command.orderKind ?? null }
  })
  vi.mocked(useCatalog).mockImplementation(() => catalog)
  vi.mocked(useOperations).mockImplementation(() => ({ snapshot, loading: false, error: '', refresh }))
  vi.mocked(useOperationalMutation).mockImplementation(() => mutation)
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })
function currentSale() { return within(screen.getByRole('complementary', { name: 'Venta actual' })) }
async function saveAndClose() {
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  const dialog = await screen.findByRole('dialog', { name: 'Cobrar' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Cobrar'})).toBeNull())
}

test('Home refreshes personal presence with the personal context endpoint', async () => {
  render(<HomeScreen {...props} destination="Inicio" />)
  await waitFor(() => expect(accountRequest).toHaveBeenCalledWith({ action: 'context', businessId: business.id, operatorToken: props.operatorToken }))
  expect(deviceRequest).not.toHaveBeenCalled()
})

test('Home refreshes a shared owner device with device_context without sending its token to personal context', async () => {
  render(<HomeScreen {...props} destination="Inicio" deviceToken="synthetic-device-memory-only" />)
  await waitFor(() => expect(deviceRequest).toHaveBeenCalledWith({ action: 'device_context', deviceToken: 'synthetic-device-memory-only', operatorToken: props.operatorToken }))
  expect(accountRequest).not.toHaveBeenCalled()
})

test('opening checkout shows payment methods immediately and has no manual edit, kitchen or finalization steps', async () => {
  render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
  expect((dialog.getByRole('radio', { name: 'Efectivo' }) as HTMLInputElement).checked).toBe(true)
  for (const name of ['Editar artículos', 'Enviar nuevos artículos a cocina', 'Enviar a cocina', 'Finalizar cuenta para cobrar']) expect(dialog.queryByRole('button', { name })).toBeNull()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
  expect(vi.mocked(mutation.execute).mock.calls[0][0].command).toBe('save_order')
})

test('Venta opens an editable service account before payment when accounts are configured', async () => {
  const accountBusiness = { ...business, profile: { ...business.profile, accountsEnabled: true } }
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command !== 'save_order') throw new Error('No collection before checkout')
    return { ...order, id: command.orderId, name: command.name, orderKind: command.orderKind ?? null }
  })
  render(<HomeScreen {...props} business={accountBusiness} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.change(currentSale().getByRole('textbox', { name: 'Nombre de la cuenta' }), { target: { value: 'Mesa 7' } })
  fireEvent.click(currentSale().getByRole('button', { name: 'Abrir cuenta' }))
  const service = within(await screen.findByRole('dialog', { name: 'Mesa 7' }))
  expect(mutation.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: 'save_order', name: 'Mesa 7', orderKind: 'service' }), 'service')
  expect(service.getByRole('button', { name: 'Enviar a cocina' })).toBeTruthy()
  expect(service.getByRole('button', { name: 'Editar artículos' })).toBeTruthy()
  expect(service.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  fireEvent.click(service.getByRole('button', { name: 'Cerrar' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mesa 7' })).toBeNull())
  expect(currentSale().queryByText('1 × Café')).toBeNull()
})

test('accounts mode accepts an order with the drawer closed but still prevents collecting', async () => {
  snapshot = { ...snapshot, shift: null }
  render(<HomeScreen {...props} business={{ ...business, profile: { ...business.profile, accountsEnabled: true } }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  const open = currentSale().getByRole('button', { name: 'Abrir cuenta' }) as HTMLButtonElement
  expect(open.disabled).toBe(false)
  fireEvent.click(open)
  const service = within(await screen.findByRole('dialog', { name: 'Mostrador' }))
  expect(service.getByRole('button', { name: 'Enviar a cocina' })).toBeTruthy()
  expect((service.getByRole('button', { name: 'Cobrar $35.00' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mutation.execute).toHaveBeenCalledOnce()
})

test('a saved mode change alters the next Venta action while preserving its draft', () => {
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy()
  view.rerender(<HomeScreen {...props} business={{ ...business, profile: { ...business.profile, accountsEnabled: true } }} />)
  expect(currentSale().getByRole('button', { name: 'Abrir cuenta' })).toBeTruthy()
  expect(currentSale().queryByRole('button', { name: 'Cobrar' })).toBeNull()
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  expect(mutation.execute).not.toHaveBeenCalled()
})

test('a cold catalog failure permits amount-only counter checkout with the business payment methods', async () => {
  catalog = { ...catalog, products: [], loaded: false, error: 'No pudimos cargar el catálogo.', paymentMethods: [] }
  let accepted: OperationalOrder | undefined
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command === 'save_order') {
      const input = command.items[0]
      if (input.kind !== 'amount') throw new Error('Expected an amount without a catalog product')
      accepted = { ...order, id: command.orderId, orderKind: command.orderKind ?? null, grossCents: 1001, totalCents: 1001, taxCents: 138, balanceCents: 1001,
        items: [{ lineId: input.lineId, kind: 'amount', productId: null, version: 1, selection: null, name: 'Importe libre', kitchenName: '', category: '', selectionLabel: '', note: '', quantity: 1, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 1001, grossCents: 1001, discountCents: 0, totalCents: 1001, taxCents: 138, taxBps: 1600, taxTreatment: 'vat_16' }] }
      return accepted
    }
    if (command.command !== 'prepare_checkout' || !accepted) throw new Error('Expected a reservation for the accepted counter')
    const quote: CheckoutAttempt = { id: 'reserved-amount-attempt', revision: 1, kind: 'payment', status: 'prepared', orderId: accepted.id, shiftId: 'shift', saleId: null, originalSaleId: null, paymentMethod: command.paymentMethod, totalCents: 1001, taxCents: 138, discountCents: 0, operatorName: accepted.operatorName, resolverName: null, createdAt: business.createdAt, resolvedAt: null, reason: '',
      items: [{ lineId: accepted.items[0].lineId, kind: 'amount', productId: null, name: 'Importe libre', quantity: 1, unitPriceCents: 1001, discountCents: 0, totalCents: 1001, taxCents: 138 }] }
    vi.mocked(posRequest).mockResolvedValue(quote)
    return quote
  })
  render(<HomeScreen {...props} business={{ ...business, profile: { ...business.profile, paymentMethods: ['cash'], defaultVatTreatment: 'vat_16' } }} />)
  expect(screen.getByRole('alert').textContent).toContain(catalog.error)
  fireEvent.click(screen.getByRole('button', { name: 'Importe para la venta', exact: true }))
  for (const key of ['1', '0', 'Punto decimal', '0', '1']) fireEvent.click(screen.getByRole('button', { name: key, exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Añadir $10.01', exact: true }))
  await waitFor(() => expect(currentSale().getByText('1 × Importe libre')).toBeTruthy())
  fireEvent.click(within(screen.getByRole('group', { name: 'Añadir a la venta' })).getByRole('button', { name: 'Productos para la venta', exact: true }))
  expect(screen.getByRole('alert').textContent).toContain(catalog.error)
  expect(screen.queryByRole('button', { name: 'Agregar Café, $35.00' })).toBeNull()
  const collect = currentSale().getByRole('button', { name: 'Cobrar' }) as HTMLButtonElement
  expect(collect.disabled).toBe(false)
  fireEvent.click(collect)
  const checkout = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
  expect((checkout.getByRole('radio', { name: 'Efectivo' }) as HTMLInputElement).checked).toBe(true)
  await waitFor(() => expect((checkout.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(false))
  expect(mutation.execute).toHaveBeenCalledTimes(2)
  expect(mutation.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'save_order', orderKind: 'counter', items: [{ lineId: expect.any(String), kind: 'amount', name: '', quantity: 1, unitPriceCents: 1001, note: '' }] }), 'counter')
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'prepare_checkout', orderId: accepted!.id, paymentMethod: 'cash', items: [{ lineId: accepted!.items[0].lineId, quantity: 1 }] }))
  expect(checkout.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
})

test('saving and editing a restaurant account opens its service detail to send preparation before collecting', async () => {
  vi.mocked(posRequest).mockResolvedValue({ batches: [] })
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command !== 'save_order') throw new Error('A service account must not reserve collection')
    return { ...order, id: command.orderId, name: command.name, orderKind: command.orderKind ?? null, revision: (command.expectedRevision ?? 0) + 1 }
  })
  render(<HomeScreen {...props} destination="Comandas" business={{ ...business, businessType: 'restaurant', profile: { ...business.profile, accountsEnabled: true } }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cuentas' }))
  fireEvent.click(screen.getByRole('button', { name: 'Abrir cuenta' }))
  const editor = within(await screen.findByRole('dialog', { name: 'Abrir cuenta' }))
  fireEvent.change(editor.getByRole('textbox', { name: 'Nombre de la cuenta' }), { target: { value: 'Mesa 7' } })
  fireEvent.click(editor.getByRole('button', { name: /Café/ }))
  fireEvent.click(editor.getByRole('button', { name: 'Guardar cuenta' }))
  let service = within(await screen.findByRole('dialog', { name: 'Mesa 7' }))
  expect(service.getByRole('button', { name: 'Enviar a cocina' }).classList.contains('pos-primary')).toBe(true)
  expect(service.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  expect(service.queryByRole('radio', { name: 'Efectivo' })).toBeNull()
  expect(mutation.execute).toHaveBeenCalledOnce()
  fireEvent.click(service.getByRole('button', { name: 'Editar artículos' }))
  const editing = within(await screen.findByRole('dialog', { name: 'Editar cuenta' }))
  fireEvent.click(editing.getByRole('button', { name: 'Guardar cuenta' }))
  service = within(await screen.findByRole('dialog', { name: 'Mesa 7' }))
  expect(service.getByRole('button', { name: 'Enviar a cocina' })).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledTimes(2)
  expect(vi.mocked(mutation.execute).mock.calls.every(([command]) => command.command === 'save_order')).toBe(true)
})

test('a closed shift disables checkout without discarding the draft or registering a payment', () => {
  snapshot = { ...snapshot, shift: null }
  const onDestinationChange = vi.fn()
  const view = render(<HomeScreen {...props} onDestinationChange={onDestinationChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  const checkout = currentSale().getByRole('button', { name: 'Cobrar' }) as HTMLButtonElement
  expect(checkout.disabled).toBe(true)
  fireEvent.click(checkout)
  expect(screen.queryByRole('dialog', { name: 'Cobrar' })).toBeNull()
  expect(mutation.execute).not.toHaveBeenCalled()
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Turno cerrado. Ir a Caja' }))
  expect(onDestinationChange).toHaveBeenCalledWith('Caja')
  snapshot = { ...snapshot, shift: { id: 'shift', status: 'open' } as OperationsSnapshot['shift'] }
  view.rerender(<HomeScreen {...props} onDestinationChange={onDestinationChange} />)
  expect((currentSale().getByRole('button', { name: 'Cobrar' }) as HTMLButtonElement).disabled).toBe(false)
})

test('closing before reservation starts cancels its debounce throughout the exit animation', async () => {
  vi.mocked(matchMedia).mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList))
  render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(currentSale().getByRole('button', { name: 'Cobrar' }))
  const dialog = await screen.findByRole('dialog', { name: 'Cobrar' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cobrar' })).toBeNull())
  expect(mutation.execute).toHaveBeenCalledTimes(1)
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'save_order' }), 'counter')
  expect((currentSale().getByRole('button', { name: 'Aumentar Café' }) as HTMLButtonElement).disabled).toBe(false)
})

test('a failed direct return keeps checkout available without a receipt confirmation dialog', async () => {
  catalog = { ...catalog, paymentMethods: ['cash', 'transfer'] }
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(currentSale().getByRole('button', { name: 'Cobrar' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
  await waitFor(() => expect((dialog.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(false))
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const quote = await vi.mocked(mutation.execute).mock.results[1].value as CheckoutAttempt
  snapshot = { ...snapshot, orders: [{ ...saved, revision: 2, phase: 'checkout' }], attempts: [quote] }
  view.rerender(<HomeScreen {...props} />)
  vi.mocked(mutation.execute).mockRejectedValueOnce(new Error('No pudimos liberar la reserva. Reintenta.'))
  fireEvent.click(dialog.getByRole('button', { name: 'Cerrar' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'No pudimos liberar la reserva. Reintenta.')
  expect(screen.queryByRole('dialog', { name: '¿Volver a la cuenta?' })).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(dialog.getByRole('button', { name: 'Cerrar' })))
  vi.mocked(mutation.execute).mockImplementationOnce(async command => {
    if (command.command !== 'update_checkout') throw new Error('Expected reservation update')
    return { ...quote, revision: 2, paymentMethod: command.paymentMethod }
  })
  fireEvent.click(dialog.getByRole('radio', { name: 'Transferencia' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'update_checkout', paymentMethod: 'transfer' })))
  expect(screen.getByRole('dialog', { name: 'Cobrar' })).toBeTruthy()
  expect(vi.mocked(mutation.execute).mock.calls.some(([command]) => command.command === 'record_checkout')).toBe(false)
})

test.each([true, false])('one click completes payment without an exit reservation (reduced motion: %s)', async reducedMotion => {
  if (!reducedMotion) vi.mocked(matchMedia).mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList))
  snapshot = { ...snapshot, shift: { id: 'shift', status: 'open' } as OperationsSnapshot['shift'] }
  render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const paid = { ...saved, status: 'closed' as const, revision: 4, frozen: true, paidCents: 3500, balanceCents: 0 }
  await waitFor(() => expect((dialog.getByRole('button', {name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
  const quote = await vi.mocked(mutation.execute).mock.results[1].value as CheckoutAttempt
  vi.mocked(mutation.execute).mockResolvedValueOnce({ order: paid, attempt: { ...quote, status: 'completed' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cobrar' })).toBeNull())
  expect(mutation.execute).toHaveBeenCalledTimes(3)
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'record_checkout', attemptId: 'reserved-attempt', expectedRevision: 1, confirmed: true }))
  expect(screen.queryByRole('button', { name: 'Iniciar cobro' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Confirmar pago recibido' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Continuar con la cuenta' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Aumentar Café' })).toBeNull()
})

test('a partial payment leaves only unpaid items and requires a new selection for the next collection',async()=>{
  snapshot={...snapshot,shift:{id:'shift',status:'open'} as OperationsSnapshot['shift']}
  const double={...order,items:order.items.map(line=>({...line,quantity:2,grossCents:7000,totalCents:7000,taxCents:966})),grossCents:7000,totalCents:7000,taxCents:966,balanceCents:7000}
  vi.mocked(mutation.execute).mockImplementationOnce(async command=>{
    if(command.command!=='save_order') throw new Error('Expected save')
    return {...double,id:command.orderId}
  }).mockImplementationOnce(async command=>{
    if(command.command!=='prepare_checkout') throw new Error('Expected preparation')
    const quote={id:'reserved-attempt',revision:1,kind:'payment',status:'prepared',orderId:command.orderId,shiftId:'shift',paymentMethod:command.paymentMethod,...checkoutTotals(double,command.items),items:command.items,createdAt:business.createdAt} as CheckoutAttempt
    vi.mocked(posRequest).mockResolvedValue(quote)
    return quote
  })
  render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button',{name:'Agregar Café, $35.00'}))
  fireEvent.click(screen.getByRole('button',{name:'Agregar Café, $35.00'}))
  fireEvent.click(currentSale().getByRole('button',{name:'Cobrar'}))
  const dialog=within(await screen.findByRole('dialog',{name:'Cobrar'}))
  const saved=await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  await waitFor(()=>expect((dialog.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
  const quote=await vi.mocked(mutation.execute).mock.results[1].value as CheckoutAttempt
  vi.mocked(mutation.execute).mockImplementationOnce(async command=>{
    if(command.command!=='update_checkout') throw new Error('Expected update')
    const selected={...quote,revision:2,...checkoutTotals(saved,command.items),items:command.items}
    vi.mocked(posRequest).mockResolvedValue(selected)
    return selected
  })
  fireEvent.click(dialog.getByRole('radio',{name:'Dividir cuenta'}))
  fireEvent.click(dialog.getByRole('button',{name:'Añadir Café a este cobro'}))
  await waitFor(()=>expect((dialog.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
  const partial={...saved,revision:3,phase:'checkout' as const,frozen:true,paidCents:3500,balanceCents:3500,items:saved.items.map(line=>({...line,paidQuantity:1}))}
  vi.mocked(mutation.execute).mockResolvedValueOnce({order:partial,attempt:{...quote,status:'completed',totalCents:3500,taxCents:483,items:quote.items.map(line=>({...line,quantity:1}))}})
  fireEvent.click(dialog.getByRole('button',{name:'Registrar pago'}))
  await waitFor(()=>expect(dialog.getByText('0 de 1 seleccionados')).toBeTruthy())
  expect(screen.getByRole('dialog',{name:'Cobrar'})).toBeTruthy()
  expect(screen.queryByRole('button',{name:'Aumentar Café'})).toBeNull()
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  expect(currentSale().getByText('$4.83')).toBeTruthy()
  expect(currentSale().queryByText('$70.00')).toBeNull()
  expect((dialog.getByRole('radio',{name:'Dividir cuenta'}) as HTMLInputElement).checked).toBe(true)
  expect(dialog.getByText('Este cobro · MXN')).toBeTruthy()
  expect((dialog.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(true)
  expect((dialog.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('0')
  expect(dialog.getByText('Pago registrado · $35.00')).toBeTruthy()
  const secondQuote:CheckoutAttempt={...quote,id:'second-reservation',revision:1,totalCents:3500,taxCents:483,items:quote.items.map(line=>({...line,quantity:1,totalCents:3500,taxCents:483}))}
  vi.mocked(posRequest).mockResolvedValue(secondQuote)
  vi.mocked(mutation.execute).mockImplementation(async command=>{
    if(command.command==='prepare_checkout') return secondQuote
    if(command.command==='record_checkout') return {order:{...partial,revision:4,status:'closed',balanceCents:0,paidCents:7000,items:partial.items.map(line=>({...line,paidQuantity:2}))},attempt:{...secondQuote,status:'completed'}}
    throw new Error('Unexpected mutation')
  })
  fireEvent.click(dialog.getByRole('button',{name:'Añadir Café a este cobro'}))
  await waitFor(()=>expect((dialog.getByRole('button',{name:'Registrar pago'}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(dialog.getByRole('button',{name:'Registrar pago'}))
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Cobrar'})).toBeNull())
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
  expect(screen.queryByRole('dialog', {name:'¿Volver a la cuenta?'})).toBeNull()
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
  expect(currentSale().queryByText('Cuenta vacía')).toBeNull()
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
  expect(currentSale().queryByText('Cuenta vacía')).toBeNull()
})

test('partial payment retains the account; only its resolved status clears it', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const partial: OperationalOrder = { ...saved, revision: 2, phase: 'checkout', frozen: true, grossCents: 7000, totalCents: 7000, taxCents: 966, paidCents: 3500, balanceCents: 3500, items: saved.items.map(line => ({ ...line, quantity: 2, paidQuantity: 1, grossCents: 7000, totalCents: 7000, taxCents: 966 })) }
  snapshot = { ...snapshot, orders: [{ ...saved, id: 'another-account', status: 'paid' }, partial] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy()
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  expect(currentSale().queryByText('2 × Café')).toBeNull()
  expect(currentSale().getByText('$4.83')).toBeTruthy()
  expect(currentSale().queryByText('$70.00')).toBeNull()
  snapshot = { ...snapshot, orders: [{ ...partial, revision: 3, status: 'paid', paidCents: 7000, balanceCents: 0, items: partial.items.map(line => ({ ...line, paidQuantity: 2 })) }] }
  view.rerender(<HomeScreen {...props} />)
  await waitFor(() => expect(currentSale().getByText('Cuenta vacía')).toBeTruthy())
  snapshot = { ...snapshot, orders: [] }
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByText('Cuenta vacía')).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
})

test('closing the shift during collection and returning from Caja preserves the selected unpaid items', async () => {
  const onDestinationChange=vi.fn()
  catalog={...catalog,paymentMethods:['cash','transfer']}
  vi.mocked(mutation.execute).mockImplementationOnce(async command=>{
    if(command.command!=='save_order') throw new Error('Expected save')
    return {...order,id:command.orderId,items:order.items.map(line=>({...line,quantity:2,grossCents:7000,totalCents:7000,taxCents:966})),grossCents:7000,totalCents:7000,taxCents:966,balanceCents:7000}
  })
  const view=render(<HomeScreen {...props} onDestinationChange={onDestinationChange} />)
  fireEvent.click(screen.getByRole('button',{name:'Agregar Café, $35.00'}))
  fireEvent.click(screen.getByRole('button',{name:'Agregar Café, $35.00'}))
  fireEvent.click(currentSale().getByRole('button',{name:'Cobrar'}))
  const dialog=within(await screen.findByRole('dialog',{name:'Cobrar'}))
  fireEvent.click(dialog.getByRole('radio',{name:'Dividir cuenta'}))
  fireEvent.click(dialog.getByRole('button',{name:'Añadir Café a este cobro'}))
  fireEvent.click(dialog.getByRole('radio',{name:'Transferencia'}))
  snapshot = { ...snapshot, shift: null }
  view.rerender(<HomeScreen {...props} onDestinationChange={onDestinationChange} />)
  fireEvent.click(dialog.getByRole('button',{name:'Ir a Caja'}))
  await waitFor(()=>expect(onDestinationChange).toHaveBeenCalledWith('Caja'))
  expect(screen.queryByRole('dialog',{name:'Cobrar'})).toBeNull()
  expect(mutation.execute).toHaveBeenCalledTimes(1)
  snapshot={...snapshot,shift:{id:'shift',status:'open'} as OperationsSnapshot['shift']}
  view.rerender(<HomeScreen {...props} onDestinationChange={onDestinationChange} />)
  fireEvent.click(currentSale().getByRole('button',{name:'Cobrar'}))
  const returned=within(await screen.findByRole('dialog',{name:'Cobrar'}))
  expect((returned.getByRole('radio',{name:'Dividir cuenta'}) as HTMLInputElement).checked).toBe(true)
  expect((returned.getByRole('spinbutton',{name:'Cantidad a cobrar de Café'}) as HTMLInputElement).value).toBe('1')
  expect((returned.getByRole('radio',{name:'Transferencia'}) as HTMLInputElement).checked).toBe(true)
  await waitFor(()=>expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({command:'prepare_checkout',paymentMethod:'transfer',items:[{lineId:'accepted-line',quantity:1}]})))
})

test('fully paid lines disappear without mixing the remaining item snapshots or IVA',async()=>{
  const view=render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved=await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  snapshot={...snapshot,orders:[{...saved,revision:2,phase:'checkout',frozen:true,grossCents:6500,totalCents:6500,taxCents:897,paidCents:3500,balanceCents:3000,items:[
    {...saved.items[0],paidQuantity:1},
    {...saved.items[0],lineId:'remaining-tea',productId:'tea',name:'Té',selectionLabel:'Grande',unitPriceCents:1500,quantity:2,grossCents:3000,totalCents:3000,taxCents:414},
  ]}]}
  view.rerender(<HomeScreen {...props} />)
  expect(currentSale().getByText('2 × Té')).toBeTruthy()
  expect(currentSale().getByText('Grande')).toBeTruthy()
  expect(currentSale().getByText('$4.14')).toBeTruthy()
  expect(currentSale().queryByText('1 × Café')).toBeNull()
  expect(currentSale().queryByText('Chico')).toBeNull()
  expect(currentSale().queryByText('$65.00')).toBeNull()
})

test('inactive operational checkout explains activation instead of offering a legacy payment without a shift',()=>{
  snapshot={...snapshot,enabled:false}
  render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button',{name:'Agregar Café, $35.00'}))
  expect((currentSale().getByRole('button',{name:'Cobrar'}) as HTMLButtonElement).disabled).toBe(true)
  expect(currentSale().getByText('Activa los turnos en Caja para cobrar y dividir por artículos.')).toBeTruthy()
  expect(currentSale().getByRole('button',{name:'Ir a Caja'})).toBeTruthy()
  expect(mutation.execute).not.toHaveBeenCalled()
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
  expect(currentSale().getByText('Cuenta vacía')).toBeTruthy()
})

test('an exact retry after a lost typed counter response restores the accepted account and can resume it', async () => {
  const command = { command: 'save_order' as const, operationId: 'original-operation', orderId: order.id, expectedRevision: null, name: 'Mostrador', orderKind: 'counter' as const, tableId: null, items: [] }
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

test('a saved service account named Mostrador restores service after a lost response and remount', async () => {
  vi.mocked(posRequest).mockResolvedValue({ batches: [] })
  vi.mocked(mutation.execute).mockRejectedValueOnce(new Error('Respuesta perdida'))
  const accountProps = { ...props, destination: 'Comandas' as const, business: { ...business, businessType: 'restaurant' as const, profile: { ...business.profile, accountsEnabled: true } } }
  const first = render(<HomeScreen {...accountProps} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cuentas' }))
  fireEvent.click(screen.getByRole('button', { name: 'Abrir cuenta' }))
  const editor = within(await screen.findByRole('dialog', { name: 'Abrir cuenta' }))
  fireEvent.change(editor.getByRole('textbox', { name: 'Nombre de la cuenta' }), { target: { value: 'Mostrador' } })
  fireEvent.click(editor.getByRole('button', { name: /Café/ }))
  fireEvent.click(editor.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledOnce())
  const command = vi.mocked(mutation.execute).mock.calls[0][0]
  expect(command).toMatchObject({ command: 'save_order', expectedRevision: null, name: 'Mostrador' })
  expect(vi.mocked(mutation.execute).mock.calls[0][1]).toBe('service')
  const accepted = { ...order, id: command.command === 'save_order' ? command.orderId : '', orderKind: 'service' as const, name: 'Mostrador' }
  first.unmount()
  mutation = { ...mutation, pending: command, pendingOrigin: 'service', error: 'Respuesta perdida' }
  vi.mocked(mutation.execute).mockResolvedValueOnce(accepted)
  const next = render(<HomeScreen {...accountProps} destination="Venta" />)
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud guardada' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledTimes(2))
  expect(vi.mocked(mutation.execute).mock.calls[1]).toEqual([command, 'service'])
  mutation = { ...mutation, pending: null, pendingOrigin: null, error: '', lastResult: { command: 'save_order', result: accepted } }
  next.rerender(<HomeScreen {...accountProps} destination="Venta" />)
  const service = within(await screen.findByRole('dialog', { name: 'Mostrador' }))
  expect(service.getByRole('button', { name: 'Enviar a cocina' })).toBeTruthy()
  expect(service.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  expect(screen.queryByRole('dialog', { name: 'Cobrar' })).toBeNull()
  expect(currentSale().queryByText('1 × Café')).toBeNull()
})

test('editing a known direct counter preserves its type after a lost response and remount without exposing preparation', async () => {
  const first = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  snapshot = { ...snapshot, orders: [saved] }
  vi.mocked(posRequest).mockResolvedValue({ batches: [] })
  first.rerender(<HomeScreen {...props} destination="Comandas" />)
  fireEvent.click(screen.getByRole('button', { name: 'Cuentas' }))
  fireEvent.click(screen.getByRole('button', { name: /Mostrador.*Por cobrar/ }))
  const service = within(await screen.findByRole('dialog', { name: 'Mostrador' }))
  expect(service.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
  fireEvent.click(service.getByRole('button', { name: 'Editar artículos' }))
  const editor = within(await screen.findByRole('dialog', { name: 'Editar cuenta' }))
  fireEvent.click(editor.getByRole('button', { name: 'Añadir Café' }))
  vi.mocked(mutation.execute).mockRejectedValueOnce(new Error('Respuesta perdida'))
  fireEvent.click(editor.getByRole('button', { name: 'Guardar cuenta' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledTimes(2))
  const command = vi.mocked(mutation.execute).mock.calls[1][0]
  expect(command).toMatchObject({ command: 'save_order', orderId: saved.id, expectedRevision: saved.revision, items: [expect.objectContaining({ lineId: saved.items[0].lineId, quantity: 2 })] })
  expect(vi.mocked(mutation.execute).mock.calls[1][1]).toBe('counter')
  first.unmount()
  const accepted = { ...saved, revision: saved.revision + 1, grossCents: 7000, totalCents: 7000, balanceCents: 7000, taxCents: 966, items: [{ ...saved.items[0], quantity: 2, grossCents: 7000, totalCents: 7000, taxCents: 966 }] }
  mutation = { ...mutation, pending: command, pendingOrigin: 'counter', error: 'Respuesta perdida' }
  vi.mocked(mutation.execute).mockResolvedValueOnce(accepted)
  const next = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud guardada' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledTimes(3))
  expect(vi.mocked(mutation.execute).mock.calls[2]).toEqual([command, 'counter'])
  mutation = { ...mutation, pending: null, pendingOrigin: null, error: '', lastResult: { command: 'save_order', result: accepted } }
  next.rerender(<HomeScreen {...props} />)
  await waitFor(() => expect(currentSale().getByText('2 × Café')).toBeTruthy())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
  fireEvent.click(currentSale().getByRole('button', { name: 'Cobrar' }))
  const checkout = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
  expect(checkout.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
})

test('a canonical counter remains direct through repeated remounts, editing and returning from collection without local hints', async () => {
  const persisted = { ...order, name: 'Venta guardada' }
  snapshot = { ...snapshot, orders: [persisted] }
  vi.mocked(posRequest).mockResolvedValue({ batches: [] })
  for (let reload = 0; reload < 3; reload++) {
    const view = render(<HomeScreen {...props} destination="Comandas" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cuentas' }))
    fireEvent.click(screen.getByRole('button', { name: /Venta guardada.*Por cobrar/ }))
    let detail = within(await screen.findByRole('dialog', { name: 'Venta guardada' }))
    expect(detail.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
    expect(mutation.pendingOrigin).toBeUndefined()
    if (reload === 1) {
      vi.mocked(mutation.execute).mockResolvedValueOnce({ ...persisted, revision: 2 })
      fireEvent.click(detail.getByRole('button', { name: 'Editar artículos' }))
      const editor = within(await screen.findByRole('dialog', { name: 'Editar cuenta' }))
      fireEvent.click(editor.getByRole('button', { name: 'Guardar cuenta' }))
      detail = within(await screen.findByRole('dialog', { name: 'Venta guardada' }))
      expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'save_order', orderKind: 'counter', orderId: persisted.id }), 'counter')
      expect(detail.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
    }
    fireEvent.click(detail.getByRole('button', { name: 'Cobrar $35.00' }))
    const checkout = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
    expect(checkout.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
    fireEvent.click(checkout.getByRole('button', { name: 'Cerrar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('textbox', { name: 'Nombre de la cuenta' })).toBeNull()
    view.unmount()
  }
  expect(vi.mocked(posRequest).mock.calls.some(([, command]) => command.command === 'order')).toBe(false)
})

test('a legacy raw save without a durable type is recovered exactly without guessing from Mostrador', async () => {
  const command = { command: 'save_order' as const, operationId: 'legacy-operation', orderId: order.id, expectedRevision: null, name: 'Mostrador', tableId: null, items: [] }
  const legacy = { ...order, orderKind: null }
  mutation = { ...mutation, pending: command }
  vi.mocked(mutation.execute).mockResolvedValueOnce(legacy)
  const view = render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud guardada' }))
  const detail = within(await screen.findByRole('dialog', { name: 'Mostrador' }))
  expect(vi.mocked(mutation.execute).mock.calls[0]).toEqual([command])
  mutation = { ...mutation, pending: null }
  view.rerender(<HomeScreen {...props} />)
  expect(detail.queryByRole('button', { name: 'Enviar a cocina' })).toBeNull()
  expect(detail.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  expect(detail.getByRole('button', { name: 'Cobrar $35.00' })).toBeTruthy()
  fireEvent.click(detail.getByRole('button', { name: 'Editar artículos' }))
  const editor = within(await screen.findByRole('dialog', { name: 'Editar cuenta' }))
  fireEvent.click(editor.getByRole('button', { name: 'Guardar cuenta' }))
  await screen.findByRole('dialog', { name: 'Mostrador' })
  expect(vi.mocked(mutation.execute).mock.calls[1][0]).not.toHaveProperty('orderKind')
})

test('the canonical service response overrides a stale local counter hint', async () => {
  const command = { command: 'save_order' as const, operationId: 'old-operation', orderId: order.id, expectedRevision: null, name: 'Mostrador', tableId: null, items: [] }
  mutation = { ...mutation, pending: command, pendingOrigin: 'counter' }
  vi.mocked(mutation.execute).mockResolvedValueOnce({ ...order, orderKind: 'service' })
  render(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud guardada' }))
  const detail = within(await screen.findByRole('dialog', { name: 'Mostrador' }))
  expect(detail.getByRole('button', { name: 'Enviar a cocina' })).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: 'Cobrar' })).toBeNull()
  expect(currentSale().queryByText('1 × Café')).toBeNull()
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

test('a partial collection with a full discount keeps the checkout open for the remaining units', async () => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  const free = { ...saved, revision: 3, phase: 'checkout' as const, totalCents: 0, balanceCents: 0, grossCents: 7000, discount: { kind: 'percent' as const, value: 10000, reason: 'Cortesía sintética' }, discountCents: 7000, taxCents: 0, items: saved.items.map(line => ({ ...line, quantity: 2, grossCents: 7000, totalCents: 0, discountCents: 7000, taxCents: 0 })) }
  snapshot = { ...snapshot, shift: { id: 'shift', status: 'open' } as OperationsSnapshot['shift'], orders: [free] }
  let quote: CheckoutAttempt
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command !== 'prepare_checkout' && command.command !== 'update_checkout') throw new Error('Unexpected command')
    quote = { id: 'synthetic-free-quote', revision: command.command === 'prepare_checkout' ? 1 : command.expectedRevision + 1, kind: 'payment', status: 'prepared', orderId: free.id, shiftId: 'shift', paymentMethod: command.paymentMethod, ...checkoutTotals(free, command.items), items: command.items, createdAt: business.createdAt } as CheckoutAttempt
    vi.mocked(posRequest).mockResolvedValue(quote)
    return quote
  })
  view.rerender(<HomeScreen {...props} />)
  fireEvent.click(currentSale().getByRole('button', { name: 'Cobrar' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
  await waitFor(() => expect((dialog.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(dialog.getByRole('radio', { name: 'Dividir cuenta' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Añadir Café a este cobro' }))
  await waitFor(() => expect((dialog.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(false))
  const partial = { ...free, revision: 4, frozen: true, items: free.items.map(line => ({ ...line, paidQuantity: 1 })) }
  vi.mocked(mutation.execute).mockResolvedValueOnce({ order: partial, attempt: { ...quote!, status: 'completed' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(dialog.getByText('Pago registrado · $0.00')).toBeTruthy())
  expect(screen.getByRole('dialog', { name: 'Cobrar' })).toBeTruthy()
  expect((dialog.getByRole('spinbutton', { name: 'Cantidad a cobrar de Café' }) as HTMLInputElement).value).toBe('0')
  expect((dialog.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
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
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 1, items: [expect.objectContaining({ lineId: saved.items[0].lineId, quantity: 2, unitPriceCents: 3500, version: 1 })] }), 'counter')
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(currentSale().getByRole('button', { name: 'Disminuir Café' }))
  await waitFor(() => expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy())
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 2, items: [expect.objectContaining({ lineId: saved.items[0].lineId, quantity: 1 })] }), 'counter')
})

test('adding a different product preserves accepted line IDs, prices, notes and selections', async () => {
  const water = { ...product, id: 'water', name: 'Agua', priceCents: 2500 }
  catalog = { ...catalog, products: [product, water] }
  render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Agua, $25.00' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledTimes(2))
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 1, items: [expect.objectContaining({ lineId: saved.items[0].lineId, productId: product.id, quantity: 1, unitPriceCents: 3500, version: 1, note: '' }), expect.objectContaining({ productId: water.id, quantity: 1, unitPriceCents: 2500, version: 1 })] }), 'counter')
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
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 2, items: [waterLine] }), 'counter')
  expect(screen.queryByRole('dialog')).toBeNull()
})

test.each(['Quitar Café', 'Disminuir Café'])('the last item can be removed with %s and the account refilled without reviving the draft', async action => {
  const view = render(<HomeScreen {...props} />)
  await saveAndClose()
  const saved = await vi.mocked(mutation.execute).mock.results[0].value as OperationalOrder
  acceptCounterEdits(saved)
  fireEvent.click(currentSale().getByRole('button', { name: action }))
  await waitFor(() => expect(currentSale().getByText('Cuenta vacía')).toBeTruthy())
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 1, items: [] }), 'counter')
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
  await waitFor(() => expect(currentSale().getByText('Cuenta vacía')).toBeTruthy())
  expect(mutation.execute).toHaveBeenLastCalledWith(remove)
  expect(screen.queryByRole('dialog')).toBeNull()
  mutation = { ...mutation, pending: null }
  view.rerender(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  await waitFor(() => expect(currentSale().getByRole('button', { name: 'Cobrar' })).toBeTruthy())
  expect(mutation.execute).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: saved.id, expectedRevision: 2, items: [expect.objectContaining({ quantity: 1 })] }), 'counter')
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

test('an uncertain Venta account freezes its draft and clears it only after retrying the same service UUID', async () => {
  const accountBusiness = { ...business, profile: { ...business.profile, accountsEnabled: true } }
  vi.mocked(mutation.execute).mockRejectedValueOnce(new Error('Respuesta perdida'))
  const view = render(<HomeScreen {...props} business={accountBusiness} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.change(currentSale().getByRole('textbox', { name: 'Nombre de la cuenta' }), { target: { value: 'Mesa 9' } })
  fireEvent.click(currentSale().getByRole('button', { name: 'Abrir cuenta' }))
  await currentSale().findByText('Respuesta perdida')
  const command = vi.mocked(mutation.execute).mock.calls[0][0]
  if (command.command !== 'save_order') throw new Error('Expected account save')
  expect(command).toMatchObject({ orderKind: 'service', name: 'Mesa 9', expectedRevision: null })
  expect(vi.mocked(mutation.execute).mock.calls[0][1]).toBe('service')
  expect(currentSale().getByText('1 × Café')).toBeTruthy()

  mutation = { ...mutation, pending: command, pendingOrigin: 'service', error: 'Respuesta perdida' }
  view.rerender(<HomeScreen {...props} business={accountBusiness} />)
  for (const button of [screen.getByRole('button', { name: 'Agregar Café, $35.00' }), currentSale().getByRole('button', { name: 'Aumentar Café' }), currentSale().getByRole('button', { name: 'Borrar cuenta' }), currentSale().getByRole('button', { name: 'Abrir cuenta' })]) {
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
  }
  expect((currentSale().getByRole('textbox', { name: 'Nombre de la cuenta' }) as HTMLInputElement).disabled).toBe(true)
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledOnce()
  catalog = { ...catalog, products: [{ ...product, version: 2, priceCents: 4500 }] }
  view.rerender(<HomeScreen {...props} business={accountBusiness} />)
  expect(currentSale().queryByText('$45.00')).toBeNull()
  expect(command.items[0]).toMatchObject({ version: 1, unitPriceCents: 3500 })

  const accepted = { ...order, id: command.orderId, name: command.name, orderKind: 'service' as const }
  vi.mocked(mutation.execute).mockResolvedValueOnce(accepted)
  // A preference change cannot reinterpret the exact request already in flight.
  view.rerender(<HomeScreen {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud guardada' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledTimes(2))
  expect(vi.mocked(mutation.execute).mock.calls[1]).toEqual([command, 'service'])
  mutation = { ...mutation, pending: null, pendingOrigin: null, error: '' }
  view.rerender(<HomeScreen {...props} />)
  const service = within(await screen.findByRole('dialog', { name: 'Mesa 9' }))
  expect(service.getByRole('button', { name: 'Enviar a cocina' })).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: 'Cobrar' })).toBeNull()
  fireEvent.click(service.getByRole('button', { name: 'Cerrar' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mesa 9' })).toBeNull())
  expect(currentSale().getByText('Cuenta vacía')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $45.00' }))
  expect(currentSale().getByText('1 × Café')).toBeTruthy()
  expect(mutation.execute).toHaveBeenCalledTimes(2)
})

test('disabling new accounts leaves existing service accounts available to edit, send and collect', async () => {
  const serviceOrder: OperationalOrder = { ...order, name: 'Mesa existente', orderKind: 'service' }
  snapshot = { ...snapshot, orders: [serviceOrder] }
  vi.mocked(posRequest).mockResolvedValue({ batches: [] })
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command === 'save_order') return { ...serviceOrder, revision: 2, name: command.name }
    if (command.command === 'prepare_checkout') return { id: 'existing-service-checkout', kind: 'payment', revision: 1, status: 'prepared', orderId: serviceOrder.id, shiftId: 'shift', paymentMethod: command.paymentMethod, items: command.items, totalCents: 3500, taxCents: 483, discountCents: 0, createdAt: business.createdAt } as CheckoutAttempt
    throw new Error('Unexpected mutation')
  })
  render(<HomeScreen {...props} destination="Comandas" />)
  fireEvent.click(screen.getByRole('button', { name: 'Cuentas' }))
  expect(screen.queryByRole('button', { name: 'Abrir cuenta' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Mesa existente.*Por cobrar/ }))
  let service = within(await screen.findByRole('dialog', { name: 'Mesa existente' }))
  expect(service.getByRole('button', { name: 'Enviar a cocina' })).toBeTruthy()
  fireEvent.click(service.getByRole('button', { name: 'Editar artículos' }))
  const editor = within(await screen.findByRole('dialog', { name: 'Editar cuenta' }))
  fireEvent.change(editor.getByRole('textbox', { name: 'Nombre de la cuenta' }), { target: { value: 'Mesa conservada' } })
  fireEvent.click(editor.getByRole('button', { name: 'Guardar cuenta' }))
  service = within(await screen.findByRole('dialog', { name: 'Mesa conservada' }))
  expect(mutation.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: 'save_order', orderId: serviceOrder.id, orderKind: 'service', expectedRevision: 1, name: 'Mesa conservada' }), 'service')
  expect(service.getByRole('button', { name: 'Enviar a cocina' })).toBeTruthy()
  fireEvent.click(service.getByRole('button', { name: 'Cobrar $35.00' }))
  const checkout = within(await screen.findByRole('dialog', { name: 'Cobrar' }))
  expect(checkout.getByRole('radio', { name: 'Efectivo' })).toBeTruthy()
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'prepare_checkout', orderId: serviceOrder.id, expectedRevision: 2 })))
})

test('accounts mode prevents a cashier from creating service accounts without orders.manage', () => {
  const cashier: BusinessContext = { ...business, role: 'cashier', employee: { id: 'cashier', name: 'Caja sintética', role: 'cashier' }, permissions: ['catalog.read', 'sales.create', 'orders.read'], profile: { ...business.profile, accountsEnabled: true } }
  render(<HomeScreen {...props} business={cashier} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  const open = currentSale().getByRole('button', { name: 'Abrir cuenta' }) as HTMLButtonElement
  expect(open.disabled).toBe(true)
  expect(currentSale().getByText('Necesitas permiso para administrar cuentas. Pide al dueño que revise tu acceso.')).toBeTruthy()
  expect(currentSale().queryByRole('button', { name: 'Cobrar' })).toBeNull()
  fireEvent.click(open)
  expect(mutation.execute).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a waiter with account permissions can create and send a service account without sales.create', async () => {
  const waiter: BusinessContext = { ...business, role: 'manager', employee: { id: 'waiter', name: 'Servicio sintético', role: 'manager' }, permissions: ['catalog.read', 'orders.read', 'orders.manage'], profile: { ...business.profile, accountsEnabled: true } }
  let saved: OperationalOrder
  vi.mocked(mutation.execute).mockImplementation(async command => {
    if (command.command === 'save_order') {
      saved = { ...order, id: command.orderId, name: command.name, orderKind: 'service' }
      return saved
    }
    if (command.command === 'send_order') return { ...saved, revision: 2, items: saved.items.map(line => ({ ...line, sentQuantity: line.quantity })) }
    throw new Error('A waiter must not reserve or record collection')
  })
  render(<HomeScreen {...props} business={waiter} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agregar Café, $35.00' }))
  fireEvent.click(currentSale().getByRole('button', { name: 'Abrir cuenta' }))
  const service = within(await screen.findByRole('dialog', { name: 'Cuenta' }))
  expect(service.getByRole('button', { name: 'Editar artículos' })).toBeTruthy()
  expect(service.queryByRole('button', { name: /Cobrar/ })).toBeNull()
  expect(service.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  fireEvent.click(service.getByRole('button', { name: 'Enviar a cocina' }))
  await waitFor(() => expect(mutation.execute).toHaveBeenCalledTimes(2))
  expect(vi.mocked(mutation.execute).mock.calls[0]).toEqual([expect.objectContaining({ command: 'save_order', orderKind: 'service' }), 'service'])
  expect(vi.mocked(mutation.execute).mock.calls[1][0]).toMatchObject({ command: 'send_order', orderId: saved!.id, expectedRevision: 1 })
  await waitFor(() => expect(service.getByText('1 enviados · 0 pagados')).toBeTruthy())
})
