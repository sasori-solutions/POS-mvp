// @vitest-environment jsdom
import { useCallback, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OrderDetail from '../../src/features/operations/OrderDetail'
import PointPayment from '../../src/components/PointPayment'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { CheckoutAttempt, OperationalOrder, OperationsCommand } from '../../src/lib/operations-contracts'
import type { BusinessContext, PaymentMethod } from '../../src/lib/contracts'
import { posRequest } from '../../src/lib/pos'
import { pointRequest } from '../../src/lib/point-client'
import { pointAccess, pointCheckout, pointPaid, pointSettings } from '../fixtures/point'

vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
vi.mock('../../src/components/PosShared', async original => ({ ...await original<object>(), SaleDetail: () => <p>Recibo sintético</p> }))
const methods: PaymentMethod[] = ['cash', 'transfer', 'card_integrated']
const business = { id: pointAccess.businessId, name: 'Negocio sintético', role: 'owner', permissions: [], profile: { paymentMethods: methods } } as unknown as BusinessContext
const prepared = pointCheckout().checkout
const order: OperationalOrder = {
  id: prepared.orderId!, revision: 1, name: 'Cuenta sintética', orderKind: 'counter', tableId: null, status: 'open', phase: 'checkout', frozen: false,
  createdAt: prepared.createdAt, updatedAt: prepared.createdAt, operatorName: 'Persona sintética',
  items: [{ ...prepared.items[0], version: 1, kitchenName: 'Café', category: '', selectionLabel: '', note: '', paidQuantity: 0, sentQuantity: 0, grossCents: 10000, taxBps: 1600, taxTreatment: 'vat_16' }],
  discount: null, grossCents: 10000, discountCents: 0, totalCents: 10000, taxCents: 1379, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 10000,
}
const emptyAttempts: CheckoutAttempt[] = []
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
type OperationsCommandPayload = Extract<OperationsCommand, { operationId: string }>
type Run = (command: OperationsCommandPayload) => Promise<unknown>
function Harness({ initialAttempt, run, recovered = false }: { initialAttempt: CheckoutAttempt; run: Run; recovered?: boolean }) {
  const [snapshot, setSnapshot] = useState(order), [blocked, setBlocked] = useState(false)
  const [activity, setActivity] = useState<{ busy: boolean; pending: OperationsCommandPayload | null }>({ busy: false, pending: null })
  const execute = useCallback(async (command: OperationsCommandPayload) => {
    setActivity({ busy: true, pending: command })
    try { return await run(command) } finally { setActivity({ busy: false, pending: null }) }
  }, [run])
  const mutation = { ...activity, execute, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } as OperationalMutation
  return <><output data-testid="blocked">{String(blocked)}</output><OrderDetail checkoutView access={pointAccess} order={snapshot} business={business} methods={methods} attempts={recovered ? emptyAttempts : [initialAttempt]} draft={recovered ? { orderId: order.id, split: false, quantities: {}, method: initialAttempt.paymentMethod } : undefined} mutation={mutation} onSaved={setSnapshot} onPaymentRecorded={setSnapshot} onEdit={vi.fn()} refresh={vi.fn(async () => {})} collectionAllowed pointSettings={pointSettings()} onPointBlocked={setBlocked} /></>
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('method switches preserve the summary/pickers and focus while only the selected action is present', async () => {
  let quote = { ...prepared, paymentMethod: 'cash' as PaymentMethod }
  const delayed = deferred<CheckoutAttempt>()
  const run = vi.fn(async (command: OperationsCommandPayload) => {
    if (command.command !== 'update_checkout') throw new Error('Unexpected payment')
    if (command.paymentMethod === 'card_integrated') return delayed.promise
    quote = { ...quote, revision: command.expectedRevision + 1, paymentMethod: command.paymentMethod }; return quote
  })
  vi.mocked(posRequest).mockImplementation(async () => quote)
  render(<Harness initialAttempt={quote} run={run} />)
  const summary = document.querySelector('.checkout-summary'), picker = screen.getByRole('group', { name: 'Método de pago' })
  const cash = screen.getByRole('radio', { name: 'Efectivo' }), card = screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }), transfer = screen.getByRole('radio', { name: 'Transferencia' })
  const registrar = screen.getByRole('button', { name: 'Registrar pago' })
  transfer.focus(); fireEvent.click(transfer)
  expect(screen.getByRole('button', { name: 'Registrar pago' })).toBe(registrar)
  expect(registrar).toHaveProperty('disabled', true)
  await waitFor(() => expect(registrar).toHaveProperty('disabled', false))
  card.focus(); fireEvent.click(card)
  expect(screen.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Enviar a terminal' })).toHaveProperty('disabled', true)
  expect(document.activeElement).toBe(card)
  await waitFor(() => expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'update_checkout', paymentMethod: 'card_integrated' })))
  cash.focus(); fireEvent.click(cash)
  expect(screen.queryByRole('button', { name: /Enviar a terminal/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  expect(screen.getByRole('button', { name: 'Registrar pago' })).toHaveProperty('disabled', true)
  quote = { ...quote, revision: quote.revision + 1, paymentMethod: 'card_integrated' }
  await act(async () => { delayed.resolve(quote) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Registrar pago' })).toHaveProperty('disabled', false))
  expect(screen.queryByRole('button', { name: /Enviar a terminal/ })).toBeNull()
  expect(screen.getByRole('group', { name: 'Método de pago' })).toBe(picker)
  expect(document.querySelector('.checkout-summary')).toBe(summary)
  expect(document.activeElement).toBe(cash)
  expect(document.querySelector('.ui-placeholder')).toBeNull()
  expect(run.mock.calls.every(([command]) => command.command === 'update_checkout')).toBe(true)
  expect(pointRequest).not.toHaveBeenCalled()
})

test('the card quote becoming ready does not steal focus, and terminal initiation keeps disabled pickers mounted', async () => {
  let quote = { ...prepared, paymentMethod: 'cash' as PaymentMethod }
  const providerPrepare = deferred<ReturnType<typeof pointCheckout>>()
  const run = vi.fn(async (command: OperationsCommandPayload) => {
    if (command.command !== 'update_checkout') throw new Error('Unexpected mutation')
    quote = { ...quote, revision: command.expectedRevision + 1, paymentMethod: command.paymentMethod }; return quote
  })
  vi.mocked(posRequest).mockImplementation(async () => quote)
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => command.command === 'prepare' ? providerPrepare.promise : pointCheckout({ checkout: quote, state: 'pending', remoteOrderId: 'SYNTHETIC' }))
  render(<Harness initialAttempt={quote} run={run} />)
  const card = screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' }), cash = screen.getByRole('radio', { name: 'Efectivo' }), split = screen.getByRole('radio', { name: 'Dividir por cantidad' })
  const picker = screen.getByRole('group', { name: 'Método de pago' })
  card.focus(); fireEvent.click(card)
  await waitFor(() => expect(screen.getByRole('button', { name: /Enviar a terminal/ })).toHaveProperty('disabled', false))
  expect(document.activeElement).toBe(card)
  fireEvent.click(screen.getByRole('button', { name: /Enviar a terminal/ }))
  expect(cash).toHaveProperty('disabled', true); expect(split).toHaveProperty('disabled', true)
  expect(screen.getByRole('group', { name: 'Método de pago' })).toBe(picker)
  fireEvent.click(cash)
  expect(card).toHaveProperty('checked', true)
  expect(screen.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  await act(async () => { providerPrepare.resolve(pointCheckout({ checkout: quote })) })
  await screen.findByText('El cobro está en camino a la terminal.')
  expect(cash).toHaveProperty('disabled', true)
  expect(screen.getByTestId('blocked').textContent).toBe('true')
  await waitFor(() => expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['prepare', 'start', 'status']))
})

test('a late initiated-card response restores card recovery before any manual action can collect', async () => {
  const quote = { ...prepared }, lookup = deferred<CheckoutAttempt>()
  vi.mocked(posRequest).mockImplementation(async () => lookup.promise)
  const request: OperationalMutation = { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() }
  // A disappeared known quote must be verified before either method can collect.
  const attempts = [quote]
  const view = render(<OrderDetail checkoutView access={pointAccess} order={order} business={business} methods={methods} attempts={attempts} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn(async () => {})} collectionAllowed pointSettings={pointSettings()} />)
  view.rerender(<OrderDetail checkoutView access={pointAccess} order={order} business={business} methods={methods} attempts={[]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn(async () => {})} collectionAllowed pointSettings={pointSettings()} />)
  const cash = screen.getByRole('radio', { name: 'Efectivo' })
  fireEvent.click(cash)
  expect(screen.getByRole('button', { name: 'Registrar pago' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'Registrar pago' }))
  await act(async () => { lookup.resolve({ ...quote, revision: 2, status: 'collection_started' }) })
  expect(screen.getByRole('radio', { name: 'Tarjeta Mercado Pago' })).toHaveProperty('checked', true)
  expect(cash).toHaveProperty('disabled', true)
  expect(screen.queryByRole('button', { name: 'Registrar pago' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Enviar a terminal/ })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Pago por confirmar' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Consultar estado' })).toBeTruthy()
  expect(request.execute).not.toHaveBeenCalled(); expect(pointRequest).not.toHaveBeenCalled()
})

test('a materialized Point result remains available after the order balance becomes zero', async () => {
  const request: OperationalMutation = { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() }
  const settings = { ...pointSettings(), pending: [pointPaid()] }
  vi.mocked(posRequest).mockResolvedValue(pointPaid().checkout)
  const view = render(<OrderDetail checkoutView access={pointAccess} order={order} business={business} methods={methods} attempts={[prepared]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn(async () => {})} collectionAllowed pointSettings={settings} />)
  await screen.findByRole('button', { name: 'Continuar' })
  const payment = screen.getByRole('region', { name: 'Cobro con Mercado Pago' })
  view.rerender(<OrderDetail checkoutView access={pointAccess} order={{ ...order, revision: 2, status: 'closed', paidCents: 10000, balanceCents: 0 }} business={business} methods={methods} attempts={[]} mutation={request} onSaved={vi.fn()} onEdit={vi.fn()} refresh={vi.fn(async () => {})} collectionAllowed pointSettings={settings} />)
  expect(screen.getByRole('region', { name: 'Cobro con Mercado Pago' })).toBe(payment)
  expect(screen.getByRole('heading', { name: 'Pago aprobado' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continuar' })).toBeTruthy()
  expect(request.execute).not.toHaveBeenCalled()
})

test('standalone payment entry preserves heading focus while embedded method changes never take it', () => {
  const view = render(<PointPayment access={pointAccess} settings={pointSettings()} attempt={prepared} />)
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Mercado Pago' }))
  view.unmount()
  const button = document.createElement('button'); document.body.append(button); button.focus()
  render(<PointPayment embedded access={pointAccess} settings={pointSettings()} attempt={prepared} />)
  expect(document.activeElement).toBe(button)
  button.remove()
})
