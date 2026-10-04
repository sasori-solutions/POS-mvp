// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import CashScreen from '../../src/features/operations/CashScreen'
import OrdersScreen from '../../src/features/operations/OrdersScreen'
import SalesScreen from '../../src/components/SalesScreen'
import AttemptPanel from '../../src/features/operations/AttemptPanel'
import OrderEditor from '../../src/features/operations/OrderEditor'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import { AccountClientError } from '../../src/lib/account'
import type { BusinessContext } from '../../src/lib/contracts'
import type { CashShift, CheckoutAttempt, OperationsSnapshot } from '../../src/lib/operations-contracts'
import type { SaleSummary } from '../../src/lib/pos-contracts'
import { posRequest, type PosAccess } from '../../src/lib/pos'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
const access: PosAccess = { businessId: 'synthetic-business', operatorToken: 'synthetic-memory-only' }
const business: BusinessContext = { id: access.businessId, name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner', createdAt: '2026-10-03T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] } }
const empty: OperationsSnapshot = { enabled: true, shift: null, orders: [], tables: [], attempts: [] }
const closed: CashShift = { id: 'synthetic-shift', revision: 3, status: 'closed', openedAt: business.createdAt, closedAt: '2026-10-03T14:00:00Z', openedBy: 'Persona sintética', closedBy: 'Persona sintética', openingCents: 20000, countedCents: 40509, expectedCents: 40500, differenceCents: 9, movements: [] }
const sale: SaleSummary = { id: 'synthetic-sale', totalCents: 1001, createdAt: business.createdAt, timezone: business.timezone, operatorName: 'Persona sintética', paymentMethod: 'cash', itemCount: 1 }
const paymentAttempt: CheckoutAttempt = { id: 'synthetic-attempt', revision: 2, kind: 'payment', status: 'collection_started', orderId: 'synthetic-order', shiftId: closed.id, saleId: null, originalSaleId: null, paymentMethod: 'cash', totalCents: 1001, taxCents: 0, discountCents: 0, operatorName: 'Persona sintética', resolverName: null, createdAt: business.createdAt, resolvedAt: null, reason: '', items: [] }
function mutation(): OperationalMutation { return { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
afterEach(() => { cleanup(); vi.resetAllMocks() })

test('cash history uses a placeholder until loaded and keeps its last valid close while refreshing', async () => {
  const first = deferred<{ shifts: CashShift[] }>(), next = deferred<{ shifts: CashShift[] }>()
  vi.mocked(posRequest).mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
  const props = { business, access, snapshot: empty, mutation: mutation(), refresh: vi.fn() }
  const { rerender } = render(<CashScreen {...props} />)
  expect(screen.getByRole('status', { name: 'Cargando turnos' })).toBeTruthy()
  expect(screen.queryByText('Sin turnos anteriores.')).toBeNull()
  await act(async () => first.resolve({ shifts: [closed] }))
  expect(screen.getByRole('heading', { name: 'Último turno' })).toBeTruthy()
  expect(screen.getAllByText('$405.09')).toHaveLength(1)
  rerender(<CashScreen {...props} snapshot={{ ...empty }} />)
  expect(screen.queryByRole('status', { name: 'Cargando turnos' })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Último turno' })).toBeTruthy()
  await act(async () => next.resolve({ shifts: [closed] }))
})

test('a staff member with close permission receives the actual result without cash-history permission', async () => {
  const request = mutation()
  vi.mocked(request.execute).mockResolvedValue(closed)
  render(<CashScreen business={{ ...business, role: 'cashier', permissions: ['cash.close'] }} access={access} snapshot={{ ...empty, shift: { ...closed, status: 'closing', closedAt: null, revision: 2 } }} mutation={request} refresh={vi.fn().mockResolvedValue(undefined)} />)
  fireEvent.change(screen.getByLabelText('Efectivo contado'), { target: { value: '405.09' } })
  fireEvent.click(screen.getByRole('button', { name: 'Guardar conteo y cerrar' }))
  await screen.findByRole('heading', { name: 'Último turno' })
  expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'close_shift', countedCents: 40509 }))
  expect(posRequest).not.toHaveBeenCalled()
})

test('the kitchen waits for its first result before showing an empty state', async () => {
  const query = deferred<{ batches: [] }>()
  vi.mocked(posRequest).mockReturnValue(query.promise)
  render(<OrdersScreen business={{ ...business, role: 'cashier', permissions: ['kitchen.read'] }} access={access} snapshot={empty} mutation={mutation()} onOrder={vi.fn()} onNew={vi.fn()} refresh={vi.fn()} />)
  expect(screen.getByRole('status', { name: 'Cargando comandas' })).toBeTruthy()
  expect(screen.queryByText('No hay comandas pendientes.')).toBeNull()
  await act(async () => query.resolve({ batches: [] }))
  expect(screen.queryByRole('status', { name: 'Cargando comandas' })).toBeNull()
  expect(screen.getByText('No hay comandas pendientes.')).toBeTruthy()
})

test('sales refresh on focus without replacing valid rows by placeholders or adding a refresh button', async () => {
  const next = deferred<{ sales: SaleSummary[]; nextCursor: null }>()
  vi.mocked(posRequest).mockResolvedValueOnce({ sales: [sale], nextCursor: null }).mockReturnValueOnce(next.promise)
  render(<SalesScreen access={access} ownOnly={false} />)
  expect(screen.getByRole('status', { name: 'Cargando ventas' })).toBeTruthy()
  await screen.findByRole('button', { name: /^Ver venta/ })
  expect(screen.queryByRole('button', { name: /Actualizar/ })).toBeNull()
  fireEvent.focus(window)
  expect(screen.getByRole('button', { name: /^Ver venta/ })).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Cargando ventas' })).toBeNull()
  await act(async () => next.resolve({ sales: [sale], nextCursor: null }))
  expect(posRequest).toHaveBeenCalledTimes(2)
})

test('a late history error from the previous operator cannot hide sales or invalidate the next operator', async () => {
  const old = deferred<{ sales: SaleSummary[]; nextCursor: null }>(), onSessionError = vi.fn()
  vi.mocked(posRequest).mockImplementation(async currentAccess => currentAccess.operatorToken === access.operatorToken ? old.promise : { sales: [{ ...sale, id: 'next-sale' }], nextCursor: null })
  const { rerender } = render(<SalesScreen access={access} ownOnly={false} onSessionError={onSessionError} />)
  rerender(<SalesScreen access={{ ...access, operatorToken: 'next-synthetic-memory-only' }} ownOnly={false} onSessionError={onSessionError} />)
  await screen.findByRole('button', { name: /Ver venta next-sal/ })
  await act(async () => old.reject(new AccountClientError('SESSION_INVALID', 'Sesión anterior terminada')))
  expect(screen.getByRole('button', { name: /Ver venta next-sal/ })).toBeTruthy()
  expect(onSessionError).not.toHaveBeenCalled()
})

test('cash received keeps exact cents and records directly without a receipt checkbox', async () => {
  const attempt = paymentAttempt
  const request = mutation()
  vi.mocked(request.execute).mockResolvedValue({ ...attempt, status: 'completed', revision: 3 })
  render(<AttemptPanel attempt={attempt} mutation={request} onSaved={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Efectivo recibido'), { target: { value: '100.09' } })
  expect(screen.getByText('$90.08')).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'resolve_checkout', confirmed: true, resolution: 'complete', expectedRevision: attempt.revision, reason: 'Registro de pago' })))
})

test('insufficient cash still blocks direct registration', () => {
  const request = mutation()
  render(<AttemptPanel attempt={paymentAttempt} mutation={request} onSaved={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Efectivo recibido'), { target: { value: '10.00' } })
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  expect(request.execute).not.toHaveBeenCalled()
})

test('transfers and refunds use direct registration with factual audit reasons', async () => {
  const request = mutation(), attempt = { ...paymentAttempt, paymentMethod: 'transfer' as const }
  vi.mocked(request.execute).mockResolvedValue({ ...attempt, status: 'completed', revision: 3 })
  const { rerender } = render(<AttemptPanel attempt={attempt} mutation={request} onSaved={vi.fn()} />)
  expect(screen.queryByText(/Verifica que recibiste/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'resolve_checkout', resolution: 'complete', reason: 'Registro de pago' })))
  const refund = { ...attempt, id: 'synthetic-refund', kind: 'reversal' as const, orderId: null, originalSaleId: sale.id }
  vi.mocked(request.execute).mockResolvedValue({ ...refund, status: 'completed', revision: 3 })
  rerender(<AttemptPanel attempt={refund} mutation={request} onSaved={vi.fn()} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Registrar devolución' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'resolve_checkout', attemptId: refund.id, resolution: 'complete', confirmed: true, reason: 'Registro de devolución' })))
})

test('an uncertain attempt retains its original-operation warning and cancellation reason', async () => {
  const request = mutation(), attempt = { ...paymentAttempt, status: 'uncertain' as const }
  vi.mocked(request.execute).mockResolvedValue({ ...attempt, status: 'aborted', revision: 3 })
  render(<AttemptPanel attempt={attempt} mutation={request} onSaved={vi.fn()} />)
  expect(screen.getByText('No repitas el cobro o la devolución.')).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect((screen.getByRole('button', { name: 'Cancelar intento' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Motivo o referencia'), { target: { value: 'Intento duplicado' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar intento' }))
  await waitFor(() => expect(request.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'resolve_checkout', attemptId: attempt.id, expectedRevision: attempt.revision, resolution: 'abort', confirmed: true, reason: 'Intento duplicado' })))
})

test('a closed shift still blocks direct recovery actions', () => {
  const request = mutation()
  render(<AttemptPanel attempt={paymentAttempt} mutation={request} onSaved={vi.fn()} collectionAllowed={false} />)
  expect((screen.getByRole('button', { name: 'Registrar pago' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Cancelar intento' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  expect(request.execute).not.toHaveBeenCalled()
})

test('the account editor keeps its draft while the independent catalog loads or retries', () => {
  const props = { products: [], mutation: mutation(), onSaved: vi.fn(), onCancel: vi.fn() }
  const retry = vi.fn()
  const { rerender } = render(<OrderEditor {...props} catalogLoading />)
  fireEvent.change(screen.getByLabelText('Nombre de la cuenta'), { target: { value: 'Mesa sintética' } })
  expect(screen.getByRole('status', { name: 'Cargando productos' })).toBeTruthy()
  expect(screen.queryByText('Sin productos disponibles.')).toBeNull()
  rerender(<OrderEditor {...props} catalogError="Sin conexión" onRetryCatalog={retry} />)
  expect((screen.getByLabelText('Nombre de la cuenta') as HTMLInputElement).value).toBe('Mesa sintética')
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar catálogo' }))
  expect(retry).toHaveBeenCalledOnce()
  rerender(<OrderEditor {...props} />)
  expect((screen.getByLabelText('Nombre de la cuenta') as HTMLInputElement).value).toBe('Mesa sintética')
})
