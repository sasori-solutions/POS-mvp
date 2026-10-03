// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import CashScreen from '../../src/features/operations/CashScreen'
import OrderDetail from '../../src/features/operations/OrderDetail'
import SalesScreen from '../../src/components/SalesScreen'
import { useCurrentAttempt } from '../../src/features/operations/useCurrentAttempt'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import { AccountClientError } from '../../src/lib/account'
import type { BusinessContext } from '../../src/lib/contracts'
import type { CashShift, CheckoutAttempt, OperationalOrder, OperationsSnapshot } from '../../src/lib/operations-contracts'
import type { Sale } from '../../src/lib/pos-contracts'
import { posRequest, type PosAccess } from '../../src/lib/pos'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access: PosAccess = { businessId: 'business', operatorToken: 'synthetic-memory-only' }
const business: BusinessContext = { id: access.businessId, name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner', createdAt: '2026-10-02T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] } }
const shift: CashShift = { id: 'shift', revision: 1, status: 'closing', openedAt: business.createdAt, closedAt: null, openedBy: 'Persona sintética', closedBy: null, openingCents: 99_999_999, countedCents: null, expectedCents: null, differenceCents: null, movements: [] }
const payment: CheckoutAttempt = { id: 'payment', revision: 2, kind: 'payment', status: 'collection_started', orderId: 'order', shiftId: shift.id, saleId: null, originalSaleId: null, paymentMethod: 'cash', totalCents: 1001, taxCents: 0, discountCents: 0, operatorName: 'Persona sintética', resolverName: null, createdAt: business.createdAt, resolvedAt: null, reason: '', items: [] }
const sale: Sale = { id: 'sale', totalCents: 1001, paymentMethod: 'cash', operatorName: payment.operatorName, createdAt: business.createdAt, timezone: business.timezone, itemCount: 1, items: [] }
const refund: CheckoutAttempt = { ...payment, id: 'refund', kind: 'reversal', orderId: null, originalSaleId: sale.id, reason: 'Devolución sintética' }
const order: OperationalOrder = { id: 'order', revision: 2, name: 'Cuenta sintética', tableId: null, status: 'open', phase: 'checkout', frozen: false, createdAt: business.createdAt, updatedAt: business.createdAt, operatorName: payment.operatorName, items: [{ lineId: 'line', productId: 'product', version: 1, name: 'Café', kitchenName: 'Café', category: '', selectionLabel: '', note: '', quantity: 2, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 1001, grossCents: 2002, discountCents: 0, totalCents: 2002, taxCents: 0, taxBps: 0, taxTreatment: 'unconfigured' }], discount: null, grossCents: 2002, discountCents: 0, totalCents: 2002, taxCents: 0, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 2002 }
function mutation(): OperationalMutation { return { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose })

test('a drawer count above the product-price limit reaches the command as exact cents', async () => {
  vi.mocked(posRequest).mockResolvedValue({ shifts: [] })
  const request = mutation(), snapshot: OperationsSnapshot = { enabled: true, shift, orders: [], tables: [], attempts: [] }
  vi.mocked(request.execute).mockResolvedValue({ ...shift, status: 'closed', countedCents: 100_000_001, expectedCents: 100_000_001, differenceCents: 0 })
  render(<CashScreen business={business} access={access} snapshot={snapshot} mutation={request} refresh={vi.fn().mockResolvedValue(undefined)} />)
  fireEvent.change(screen.getByLabelText('Efectivo contado'), { target: { value: '1000000.01' } })
  fireEvent.click(screen.getByRole('button', { name: 'Guardar conteo y cerrar' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'close_shift', countedCents: 100_000_001 })))
})

test('another resolver completing an open bill refreshes the attempt and releases the remaining bill without reopening the dialog', async () => {
  const lookup = deferred<CheckoutAttempt>()
  vi.mocked(posRequest).mockReturnValue(lookup.promise)
  const request = mutation(), refresh = vi.fn().mockResolvedValue(undefined)
  const props = { access, business, order, tables: [], methods: ['cash' as const], attempts: [payment], mutation: request, refresh, collectionAllowed: true, onSaved: vi.fn(), onEdit: vi.fn() }
  const { rerender } = render(<OrderDetail {...props} />)
  fireEvent.click(screen.getByLabelText('He comprobado si se recibió el pago.'))
  expect((screen.getByRole('button', { name: 'Confirmar pago recibido' }) as HTMLButtonElement).disabled).toBe(false)
  const remaining = { ...order, revision: 3, frozen: true, paidCents: 1001, balanceCents: 1001, items: [{ ...order.items[0], paidQuantity: 1 }] }
  rerender(<OrderDetail {...props} order={remaining} attempts={[]} />)
  expect(screen.getByText('Consultando el estado del intento…')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Confirmar pago recibido' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => lookup.resolve({ ...payment, status: 'completed', revision: 3, resolverName: 'Otra persona sintética', saleId: sale.id, resolvedAt: business.createdAt }))
  expect(await screen.findByText(/Pago registrado\./)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Confirmar pago recibido' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Continuar con la cuenta' }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Preparar cobro completo' }) as HTMLButtonElement).disabled).toBe(false))
  expect(posRequest).toHaveBeenCalledWith(access, { command: 'attempt', attemptId: payment.id })
})

test('a remotely aborted refund can prepare a new attempt for the same sale', async () => {
  const lookup = deferred<CheckoutAttempt>(), newer = { ...refund, id: 'new-refund', revision: 1, status: 'prepared' as const }
  vi.mocked(posRequest).mockImplementation(async (_access, command) => command.command === 'sales' ? { sales: [sale], nextCursor: null } : command.command === 'sale' ? sale : command.attemptId === refund.id ? lookup.promise : newer)
  const request = mutation(), props = { access, ownOnly: false, canReverse: true, attempts: [refund], mutation: request, collectionAllowed: true, onOperationSaved: vi.fn().mockResolvedValue(undefined) }
  vi.mocked(request.execute).mockResolvedValue(newer)
  const { rerender } = render(<SalesScreen {...props} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Ver venta/ }))
  await screen.findByRole('button', { name: 'Confirmar devolución entregada' })
  rerender(<SalesScreen {...props} attempts={[]} />)
  await act(async () => lookup.resolve({ ...refund, status: 'aborted', revision: 3, resolvedAt: business.createdAt }))
  fireEvent.click(await screen.findByRole('button', { name: 'Preparar otra devolución' }))
  fireEvent.change(await screen.findByLabelText('Motivo'), { target: { value: 'Nuevo intento después de verificar ausencia de devolución' } })
  fireEvent.click(screen.getByRole('button', { name: 'Preparar devolución completa' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'prepare_reversal', saleId: sale.id })))
  expect(await screen.findByRole('button', { name: 'Iniciar devolución' })).toBeTruthy()
})

function Harness({ access: currentAccess, known, attempts, onSessionError }: { access: PosAccess; known: CheckoutAttempt; attempts: CheckoutAttempt[]; onSessionError: (error: AccountClientError) => void }) {
  const current = useCurrentAttempt(currentAccess, known, attempts, onSessionError)
  return <><p>{current.attempt?.id}:{current.attempt?.status}</p>{current.loading && <p>Consultando</p>}{current.error && <p>{current.error}</p>}</>
}

test('an old lookup cannot overwrite the next operator response or invalidate that session', async () => {
  const old = deferred<CheckoutAttempt>(), onSessionError = vi.fn(), attempts: CheckoutAttempt[] = [], next = { ...refund, id: 'next-attempt', status: 'prepared' as const, revision: 1 }
  vi.mocked(posRequest).mockImplementation(async currentAccess => currentAccess.operatorToken === access.operatorToken ? old.promise : { ...next, status: 'completed', revision: 3 })
  const { rerender } = render(<Harness access={access} known={refund} attempts={attempts} onSessionError={onSessionError} />)
  rerender(<Harness access={{ ...access, operatorToken: 'new-synthetic-memory-only' }} known={next} attempts={attempts} onSessionError={onSessionError} />)
  expect(await screen.findByText('next-attempt:completed')).toBeTruthy()
  await act(async () => old.reject(new AccountClientError('SESSION_INVALID', 'Sesión anterior terminada')))
  expect(screen.getByText('next-attempt:completed')).toBeTruthy()
  expect(onSessionError).not.toHaveBeenCalled()
})

test('unmounting a pending lookup suppresses its later session failure', async () => {
  const lookup = deferred<CheckoutAttempt>(), onSessionError = vi.fn()
  vi.mocked(posRequest).mockReturnValue(lookup.promise)
  const { unmount } = render(<Harness access={access} known={payment} attempts={[]} onSessionError={onSessionError} />)
  unmount()
  await act(async () => lookup.reject(new AccountClientError('SESSION_INVALID', 'Sesión terminada')))
  expect(onSessionError).not.toHaveBeenCalled()
})

test.each(['attempt', 'cash-history'])('a current %s permission refusal uses the session error callback', async source => {
  const refused = new AccountClientError('PERMISSION_DENIED', 'Acceso retirado'), onSessionError = vi.fn()
  vi.mocked(posRequest).mockRejectedValue(refused)
  if (source === 'attempt') render(<Harness access={access} known={payment} attempts={[]} onSessionError={onSessionError} />)
  else render(<CashScreen business={business} access={access} snapshot={{ enabled: true, shift, attempts: [], orders: [], tables: [] }} mutation={mutation()} refresh={vi.fn()} onSessionError={onSessionError} />)
  await waitFor(() => expect(onSessionError).toHaveBeenCalledOnce())
  expect(onSessionError).toHaveBeenCalledWith(refused)
})
