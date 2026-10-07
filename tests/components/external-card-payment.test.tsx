// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OrderDetail from '../../src/features/operations/OrderDetail'
import AttemptPanel from '../../src/features/operations/AttemptPanel'
import CashScreen from '../../src/features/operations/CashScreen'
import PaymentMethodPicker from '../../src/components/PaymentMethodPicker'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { BusinessContext } from '../../src/lib/contracts'
import type { CashShift, CheckoutAttempt, OperationalOrder, OperationsSnapshot } from '../../src/lib/operations-contracts'
import { posRequest } from '../../src/lib/pos'
import { pointRequest } from '../../src/lib/point-client'
import { pointAccess, pointCheckout, pointId } from '../fixtures/point'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
const prepared: CheckoutAttempt = { ...pointCheckout().checkout, paymentMethod: 'card_external' }
const business = { id: pointAccess.businessId, name: 'Comercio sintético', role: 'owner', profile: { paymentMethods: ['cash', 'card_external', 'card_integrated', 'transfer'] } } as BusinessContext
const order: OperationalOrder = { id: prepared.orderId!, revision: 1, name: 'Cuenta sintética', tableId: null, status: 'open', phase: 'checkout', frozen: false, createdAt: '2026-10-06T12:00:00Z', updatedAt: '2026-10-06T12:00:00Z', operatorName: 'Persona sintética', items: [{ lineId: pointId(3), productId: pointId(4), version: 1, name: 'Café', kitchenName: 'Café', category: '', selectionLabel: '', note: '', quantity: 2, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 5000, grossCents: 10000, discountCents: 0, totalCents: 10000, taxCents: 1379, taxBps: 1600, taxTreatment: 'vat_16' }], discount: null, grossCents: 10000, discountCents: 0, totalCents: 10000, taxCents: 1379, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 10000 }
function mutation(): OperationalMutation {
  return { execute: vi.fn(async command => {
    if (command.command === 'record_checkout') return { order: { ...order, status: 'closed', paidCents: 10000, balanceCents: 0 }, attempt: { ...prepared, status: 'completed', revision: 2 } }
    return { ...prepared, paymentMethod: 'paymentMethod' in command ? command.paymentMethod : prepared.paymentMethod, revision: 2 }
  }), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } as OperationalMutation
}
function checkout(context = business, collectionAllowed = true) {
  const request = mutation()
  vi.mocked(posRequest).mockResolvedValue(prepared)
  const props = { checkoutView: true, access: pointAccess, order, business: context, methods: context.profile.paymentMethods, attempts: [prepared], mutation: request, onSaved: vi.fn(), onEdit: vi.fn(), refresh: vi.fn(async () => {}), collectionAllowed, pointSettings: null }
  return { ...render(<OrderDetail {...props} />), request, props }
}
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('navigator', { onLine: true }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('external cards and Point remain separate choices even when Point is unavailable', () => {
  const change = vi.fn()
  render(<PaymentMethodPicker name="methods" value="cash" methods={business.profile.paymentMethods} onChange={change} disabled={false} disabledMethods={['card_integrated']} />)
  expect(screen.getAllByRole('radio')).toHaveLength(4)
  expect((screen.getByRole('radio', { name: 'Tarjeta externa' }) as HTMLInputElement).disabled).toBe(false)
  expect((screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }) as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: 'Tarjeta externa' }))
  expect(change).toHaveBeenCalledExactlyOnceWith('card_external')
})

test('an external prepared payment requires explicit terminal approval and records the original quote without Point', async () => {
  const view = checkout()
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  expect(view.request.execute).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' }))
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(view.request.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: 'record_checkout', attemptId: prepared.id, expectedRevision: prepared.revision, confirmed: true })))
  expect(pointRequest).not.toHaveBeenCalled()
})

test('changing a payment method clears approval before returning to the terminal method', async () => {
  const view = checkout()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Efectivo' }))
  await waitFor(() => expect(view.request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'update_checkout', paymentMethod: 'cash' })))
  fireEvent.click(screen.getByRole('radio', { name: 'Tarjeta externa' }))
  await waitFor(() => expect(view.request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'update_checkout', paymentMethod: 'card_external' })))
  expect((screen.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
})

test.each([['shift', false], ['permission', true]] as const)('%s blocks an external registration after confirmation', (condition, collectionAllowed) => {
  const context = condition === 'permission' ? { ...business, role: 'cashier', permissions: ['catalog.read'] } as BusinessContext : business
  const view = checkout(context, collectionAllowed)
  const confirm = screen.queryByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' })
  if (confirm) fireEvent.click(confirm)
  const register = screen.queryByRole('button', { name: 'Registrar pago' })
  if (register) fireEvent.click(register)
  expect(view.request.execute).not.toHaveBeenCalled()
  expect(pointRequest).not.toHaveBeenCalled()
})

test.each(['collection_started', 'uncertain'] as const)('recovery of %s requires checking the original external payment without creating another collection', async status => {
  const request = mutation(), attempt = { ...prepared, status }
  vi.mocked(request.execute).mockResolvedValue({ ...attempt, status: 'completed', revision: 2 })
  render(<AttemptPanel attempt={attempt} mutation={request} onSaved={vi.fn()} />)
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' }))
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'resolve_checkout', attemptId: attempt.id, resolution: 'complete', confirmed: true })))
  expect(pointRequest).not.toHaveBeenCalled()
})

test.each(['payment', 'reversal'] as const)('reading an external %s does not offer recovery mutations without its permission', kind => {
  const request = mutation(), attempt = { ...prepared, kind, status: 'collection_started' as const }
  render(<AttemptPanel attempt={attempt} mutation={request} onSaved={vi.fn()} actionAllowed={false} />)
  expect(screen.getByText(kind === 'payment' ? 'No tienes permiso para registrar pagos.' : 'No tienes permiso para registrar devoluciones.')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(request.execute).not.toHaveBeenCalled()
})

test('an account with a recovered external payment remains readable without sales.create', () => {
  const context = { ...business, role: 'cashier', permissions: ['orders.read'] } as BusinessContext
  const request = mutation(), attempt = { ...prepared, status: 'collection_started' as const }
  render(<OrderDetail checkoutView access={pointAccess} order={order} business={context} methods={context.profile.paymentMethods} attempts={[attempt]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn(async () => {})} collectionAllowed />)
  expect(screen.getByText('No tienes permiso para registrar pagos.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  expect(screen.queryByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' })).toBeNull()
  expect(request.execute).not.toHaveBeenCalled()
})

test('revoking recovery permission removes actions and clears earlier terminal approval', () => {
  const request = mutation(), saved = vi.fn(), attempt = { ...prepared, status: 'collection_started' as const }
  const props = { attempt, mutation: request, onSaved: saved }
  const view = render(<AttemptPanel {...props} actionAllowed />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' }))
  view.rerender(<AttemptPanel {...props} actionAllowed={false} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(saved).not.toHaveBeenCalled()
  expect(request.execute).not.toHaveBeenCalled()
  view.rerender(<AttemptPanel {...props} actionAllowed />)
  expect((screen.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' }) as HTMLInputElement).checked).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  expect(saved).not.toHaveBeenCalled()
  expect(request.execute).not.toHaveBeenCalled()
})

test.each(['payment', 'reversal'] as const)('cash readers need the correct %s permission before resolving an external attempt', async kind => {
  const request = mutation(), attempt = { ...prepared, kind, status: 'collection_started' as const }
  const context = { ...business, timezone: 'America/Mexico_City', role: 'cashier', permissions: ['cash.read', kind === 'payment' ? 'sales.reverse' : 'sales.create'] } as BusinessContext
  const shift: CashShift = { id: prepared.shiftId, revision: 1, status: 'open', openedAt: order.createdAt, closedAt: null, openedBy: 'Persona sintética', closedBy: null, openingCents: 10000, countedCents: null, expectedCents: null, differenceCents: null, movements: [] }
  const snapshot: OperationsSnapshot = { enabled: true, shift, orders: [], tables: [], attempts: [attempt] }
  vi.mocked(posRequest).mockResolvedValue({ shifts: [] })
  render(<CashScreen business={context} access={pointAccess} snapshot={snapshot} mutation={request} refresh={vi.fn(async () => {})} />)
  fireEvent.click(screen.getByRole('button', { name: kind === 'payment' ? /^Cobro/ : /^Devolución/ }))
  await screen.findByText(kind === 'payment' ? 'No tienes permiso para registrar pagos.' : 'No tienes permiso para registrar devoluciones.')
  expect(screen.queryByRole('button', { name: /Registrar pago|Registrar devolución|Cancelar intento/ })).toBeNull()
  expect(request.execute).not.toHaveBeenCalled()
})

test('external refunds require factual confirmation and keep the linked original sale', async () => {
  const request = mutation(), attempt = { ...prepared, id: 'refund-attempt', kind: 'reversal' as const, status: 'collection_started' as const, originalSaleId: 'original-sale', orderId: null }
  vi.mocked(request.execute).mockResolvedValue({ ...attempt, status: 'completed', revision: 2 })
  const props = { attempt, mutation: request, onSaved: vi.fn() }
  const view = render(<AttemptPanel {...props} />)
  expect((screen.getByRole('button', { name: 'Registrar devolución' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirmo que la devolución se realizó en la terminal externa.' }))
  fireEvent.click(screen.getByRole('button', { name: 'Registrar devolución' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'resolve_checkout', attemptId: attempt.id, expectedRevision: 1, resolution: 'complete', confirmed: true })))
  view.rerender(<AttemptPanel {...props} attempt={{ ...attempt, revision: 3 }} />)
  expect((screen.getByRole('checkbox', { name: 'Confirmo que la devolución se realizó en la terminal externa.' }) as HTMLInputElement).checked).toBe(false)
  expect(pointRequest).not.toHaveBeenCalled()
})

test('a pending external registration retains its UUID and prevents creating a second payment', async () => {
  const view = checkout()
  const pending = { command: 'record_checkout' as const, operationId: 'original-operation', attemptId: prepared.id, expectedRevision: prepared.revision, confirmed: true as const }
  view.rerender(<OrderDetail {...view.props} mutation={{ ...view.request, pending }} />)
  const confirm = screen.queryByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' })
  if (confirm) fireEvent.click(confirm)
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
  expect(view.request.execute).not.toHaveBeenCalled()
  expect(pending.operationId).toBe('original-operation')
  expect(pointRequest).not.toHaveBeenCalled()
})

test('a completed registration and its accepted retry notify the same receipt only once', async () => {
  const view = checkout(), recorded = vi.fn(), receipt = vi.fn()
  const completed = { ...prepared, status: 'completed' as const, revision: 2, saleId: pointId(12) }
  const saved = { ...order, status: 'closed' as const, revision: 3, paidCents: order.totalCents, balanceCents: 0, items: order.items.map(line => ({ ...line, paidQuantity: line.quantity })) }
  const result = { order: saved, attempt: completed }
  vi.mocked(view.request.execute).mockResolvedValue(result)
  view.rerender(<OrderDetail {...view.props} onPaymentRecorded={recorded} onReceipt={receipt} />)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirmo que la terminal externa aprobó este pago.' }))
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(recorded).toHaveBeenCalledExactlyOnceWith(saved, completed.saleId))
  view.rerender(<OrderDetail {...view.props} order={saved} onPaymentRecorded={recorded} onReceipt={receipt} mutation={{ ...view.request, lastResult: { command: 'record_checkout', result } }} />)
  expect(recorded).toHaveBeenCalledOnce()
  expect(receipt).not.toHaveBeenCalled()
  expect(view.request.execute).toHaveBeenCalledOnce()
  expect(pointRequest).not.toHaveBeenCalled()
})

test('a recovered partial registration exposes its original receipt through an explicit action', async () => {
  const view = checkout(), recorded = vi.fn(), receipt = vi.fn()
  const partial = { ...order, revision: 3, frozen: true, paidCents: 5000, balanceCents: 5000, items: order.items.map(line => ({ ...line, paidQuantity: 1 })) }
  const completed = { ...prepared, status: 'completed' as const, revision: 2, totalCents: 5000, saleId: pointId(13), items: prepared.items.map(line => ({ ...line, quantity: 1, totalCents: 5000 })) }
  view.rerender(<OrderDetail {...view.props} order={partial} onPaymentRecorded={recorded} onReceipt={receipt} attempts={[]} mutation={{ ...view.request, lastResult: { command: 'record_checkout', result: { order: partial, attempt: completed } } }} />)
  await waitFor(() => expect(recorded).toHaveBeenCalledExactlyOnceWith(partial, completed.saleId))
  expect(receipt).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Ver comprobante' }))
  expect(receipt).toHaveBeenCalledExactlyOnceWith(completed.saleId)
  expect(view.request.execute).not.toHaveBeenCalled()
  expect(pointRequest).not.toHaveBeenCalled()
})

test('a completed external recovery retries its account read without repeating payment', async () => {
  const request = mutation(), recorded = vi.fn(), receipt = vi.fn()
  const completed = { ...prepared, status: 'completed' as const, revision: 2, saleId: pointId(14) }
  const saved = { ...order, status: 'closed' as const, revision: 3, paidCents: order.totalCents, balanceCents: 0, items: order.items.map(line => ({ ...line, paidQuantity: line.quantity })) }
  vi.mocked(posRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'checkout') return completed as never
    throw new Error('No pudimos consultar la cuenta sintética.')
  })
  render(<OrderDetail checkoutView access={pointAccess} order={saved} business={business} methods={business.profile.paymentMethods} attempts={[completed]} mutation={request} onSaved={vi.fn()} onPaymentRecorded={recorded} onReceipt={receipt} onEdit={vi.fn()} refresh={vi.fn(async () => {})} collectionAllowed />)
  await screen.findByRole('button', { name: 'Reintentar consulta del pago' })
  expect(recorded).not.toHaveBeenCalled()
  vi.mocked(posRequest).mockImplementation(async (_access, command) => command.command === 'order' ? saved as never : completed as never)
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar consulta del pago' }))
  await waitFor(() => expect(recorded).toHaveBeenCalledExactlyOnceWith(saved, completed.saleId))
  expect(receipt).not.toHaveBeenCalled()
  expect(request.execute).not.toHaveBeenCalled()
  expect(pointRequest).not.toHaveBeenCalled()
})
