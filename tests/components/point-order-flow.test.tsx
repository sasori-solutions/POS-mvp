// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import OrderDetail from '../../src/features/operations/OrderDetail'
import type { OperationalMutation } from '../../src/features/operations/useOperations'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { BusinessContext } from '../../src/lib/contracts'
import { posRequest } from '../../src/lib/pos'
import { pointRequest } from '../../src/lib/point-client'
import { checkoutTotals } from '../../src/lib/checkout-selection'
import { pointAccess, pointCheckout, pointId, pointSettings } from '../fixtures/point'
vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
vi.mock('../../src/components/PosShared', async original => ({ ...await original<object>(), SaleDetail: () => <p>Recibo sintético</p> }))
const business = { id: pointAccess.businessId, name: 'Negocio sintético', role: 'owner', permissions: [], profile: { paymentMethods: ['cash', 'card_integrated'] } } as unknown as BusinessContext
const original: OperationalOrder = { id: pointId(6), revision: 1, name: 'Cuenta sintética', tableId: null, status: 'open', phase: 'checkout', frozen: false,
  createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z', operatorName: 'Persona sintética',
  items: [{ lineId: pointId(3), productId: pointId(4), version: 1, name: 'Café', kitchenName: 'Café', category: '', selectionLabel: '', note: '', quantity: 3, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 1001, grossCents: 3003, discountCents: 2, totalCents: 3001, taxCents: 414, taxBps: 1600, taxTreatment: 'vat_16' }],
  discount: { kind: 'fixed', value: 2, reason: 'Cortesía' }, grossCents: 3003, discountCents: 2, totalCents: 3001, taxCents: 414, paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 3001 }
const emptyAttempts: CheckoutAttempt[] = []
const refresh = vi.fn(async () => {})
function quote(quantity = 3, revision = 1): CheckoutAttempt {
  const totals = checkoutTotals(original, [{ lineId: original.items[0].lineId, quantity }])
  return { ...pointCheckout().checkout, revision, ...totals, items: [{ ...original.items[0], quantity, ...totals }], paymentMethod: 'card_integrated' }
}
function mutation(): OperationalMutation { return { execute: vi.fn(), pending: null, busy: false, error: '', notice: '', lastResult: null, clearNotice: vi.fn() } }
function Harness({ request, initialAttempt, collectionAllowed = true }: { request: OperationalMutation; initialAttempt?: CheckoutAttempt; collectionAllowed?: boolean }) {
  const [order, setOrder] = useState(original), [blocked, setBlocked] = useState(false)
  const [attempts] = useState(initialAttempt ? [initialAttempt] : emptyAttempts)
  return <><output data-testid="parent-blocked">{String(blocked)}</output><OrderDetail checkoutView access={pointAccess} order={order} business={business} methods={['card_integrated', 'cash']} attempts={attempts} mutation={request} onSaved={setOrder} onPaymentRecorded={setOrder} onEdit={vi.fn()} refresh={refresh} collectionAllowed={collectionAllowed} pointSettings={pointSettings()} onPointBlocked={setBlocked} /></>
}
beforeEach(() => { vi.stubGlobal('navigator', { onLine: true }); vi.resetAllMocks() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('Point starts from the selected reservation even when onBlocked rerenders the parent', async () => {
  const request = mutation(); let reservation = quote()
  vi.mocked(request.execute).mockImplementation(async command => {
    if (command.command !== 'prepare_checkout' && command.command !== 'update_checkout') throw new Error('Unexpected mutation')
    reservation = quote(command.items[0].quantity, reservation.revision + 1); return reservation
  })
  vi.mocked(posRequest).mockImplementation(async () => reservation)
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => ({ ...pointCheckout(), checkout: reservation, items: reservation.items, totalCents: reservation.totalCents, state: command.command === 'start' ? 'pending' : 'prepared' }))
  render(<Harness request={request} />)
  await waitFor(() => expect((screen.getByRole('button', { name: /^Enviar a terminal/ }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: /^Enviar a terminal/ }))
  await waitFor(() => expect(vi.mocked(pointRequest).mock.calls.map(([, command]) => command.command)).toEqual(['prepare', 'start']))
  expect(screen.getByTestId('parent-blocked').textContent).toBe('true')
  expect(vi.mocked(pointRequest).mock.calls[0][1]).toMatchObject({ checkoutAttemptId: reservation.id })
})

test('a verified partial Point payment keeps the remaining account and clears the previous selection', async () => {
  const request = mutation(); let reservation = quote(1)
  const paidOrder = { ...original, revision: 2, frozen: true, paidCents: reservation.totalCents, balanceCents: original.totalCents - reservation.totalCents, items: [{ ...original.items[0], paidQuantity: 1, sentQuantity: 1 }] }
  vi.mocked(posRequest).mockImplementation(async (_access, command) => command.command === 'order' ? paidOrder : reservation)
  vi.mocked(request.execute).mockImplementation(async command => {
    if (command.command !== 'prepare_checkout' && command.command !== 'update_checkout') throw new Error('Unexpected mutation')
    reservation = quote(command.items[0].quantity, reservation.revision + 1); return reservation
  })
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command !== 'start') return { ...pointCheckout(), checkout: reservation, items: reservation.items, totalCents: reservation.totalCents }
    return { ...pointCheckout(), state: 'approved_verified', saleState: 'materialized', checkout: { ...reservation, status: 'completed', revision: reservation.revision + 1, saleId: pointId(12) }, items: reservation.items, totalCents: reservation.totalCents, sale: { id: pointId(12) } }
  })
  render(<Harness request={request} initialAttempt={reservation} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Enviar a terminal/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continuar' }))
  await screen.findByText(/Pago registrado ·/)
  expect(screen.getByTestId('parent-blocked').textContent).toBe('false')
  expect((screen.getByRole('spinbutton', { name: 'Cantidad a cobrar de Café' }) as HTMLInputElement).value).toBe('0')
  expect(screen.getByText('Queda pendiente').parentElement?.textContent).toContain('$20.00')
  expect(screen.queryByRole('button', { name: 'Continuar' })).toBeNull()
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'start')).toHaveLength(1)
  expect(vi.mocked(request.execute).mock.calls.filter(([command]) => command.command === 'record_checkout')).toHaveLength(0)
})

test('selection debounce, discount editing and a closed shift cannot send the old Point amount', async () => {
  const request = mutation(), reservation = quote()
  vi.mocked(posRequest).mockResolvedValue(reservation)
  const view = render(<Harness request={request} initialAttempt={reservation} />)
  const start = await screen.findByRole('button', { name: /^Enviar a terminal/ })
  expect((start as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('radio', { name: 'Dividir cuenta' }))
  expect((start as HTMLButtonElement).disabled).toBe(true); fireEvent.click(start)
  fireEvent.click(screen.getByRole('button', { name: 'Añadir Café a este cobro' }))
  expect((start as HTMLButtonElement).disabled).toBe(true); fireEvent.click(start)
  fireEvent.click(screen.getByRole('button', { name: /Editar descuento/ }))
  expect((start as HTMLButtonElement).disabled).toBe(true); fireEvent.click(start)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
  expect(pointRequest).not.toHaveBeenCalled(); expect(request.execute).not.toHaveBeenCalled()
  view.unmount()
  render(<Harness request={request} initialAttempt={reservation} collectionAllowed={false} />)
  expect((screen.getByRole('button', { name: /^Enviar a terminal/ }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /^Enviar a terminal/ }))
  expect(pointRequest).not.toHaveBeenCalled()
})
