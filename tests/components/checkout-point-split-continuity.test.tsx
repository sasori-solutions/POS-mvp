// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import HomeScreen from '../../src/components/HomeScreen'
import { useCatalog } from '../../src/components/useCatalog'
import { accountRequest } from '../../src/lib/account'
import { posRequest, money } from '../../src/lib/pos'
import { pointRequest } from '../../src/lib/point-client'
import { checkoutAmountTotals } from '../../src/lib/checkout-amounts'
import { checkoutTotals } from '../../src/lib/checkout-selection'
import type { BusinessContext } from '../../src/lib/contracts'
import type { CheckoutAttempt, OperationalOrder, OperationsSnapshot } from '../../src/lib/operations-contracts'
import type { PointCheckout } from '../../src/lib/point-contracts'
import type { Product, Sale } from '../../src/lib/pos-contracts'
import { pointAccess, pointCheckout, pointId, pointSettings } from '../fixtures/point'

// Keep Home's payment callback, checkout, mutation storage and snapshot refresh real.
// Synthetic API boundaries do not claim a provider, terminal or HTTP integration.
vi.mock('../../src/lib/pos', async original => ({ ...await original<object>(), posRequest: vi.fn() }))
vi.mock('../../src/lib/point-client', async original => ({ ...await original<object>(), pointRequest: vi.fn() }))
vi.mock('../../src/lib/account', async original => ({ ...await original<object>(), accountRequest: vi.fn() }))
vi.mock('../../src/components/useCatalog', async original => ({ ...await original<object>(), useCatalog: vi.fn() }))
vi.mock('../../src/components/PosShared', async original => ({ ...await original<object>(), SaleDetail: () => <p>Recibo sintético</p> }))

const business: BusinessContext = { id: pointAccess.businessId, name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Mexico_City', currency: 'MXN', role: 'owner', createdAt: '2026-10-05T12:00:00Z', profile: { branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['card_integrated'] } }
const showModal = HTMLDialogElement.prototype.showModal, close = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
beforeEach(() => {
  localStorage.clear(); vi.resetAllMocks()
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('prefers-reduced-motion: reduce'), addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_name: string, options: unknown, callback?: () => unknown) => (callback ?? options as () => unknown)() } })
  vi.mocked(accountRequest).mockResolvedValue({ business, expiresAt: '2026-10-05T20:00:00Z' })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })
afterAll(() => { HTMLDialogElement.prototype.showModal = showModal; HTMLDialogElement.prototype.close = close })

function fixture(unitPriceCents: number) {
  const product: Product = { id: pointId(4), name: 'Consumo', category: '', priceCents: unitPriceCents, version: 1, active: true }
  let order: OperationalOrder | null = null, sequence = 30, result: 'processing' | 'approved' | 'rejected' = 'processing'
  let quote: CheckoutAttempt | null = null, remote: PointCheckout | null = null
  const quotes = new Map<string, CheckoutAttempt>(), sales: Sale[] = []
  const mutations: unknown[] = []
  const settings = () => ({ ...pointSettings(), pending: remote && remote.saleState !== 'materialized' ? [remote] : [] })
  const snapshot = (): OperationsSnapshot => ({ enabled: true, shift: { id: pointId(7), revision: 1, status: 'open', openedAt: business.createdAt, closedAt: null, openedBy: 'Sintético', closedBy: null, openingCents: 0, countedCents: null, expectedCents: null, differenceCents: null, movements: [] }, orders: order ? [order] : [], tables: [], attempts: quote?.status === 'prepared' ? [quote] : [] })
  vi.mocked(useCatalog).mockReturnValue({ products: [product], paymentMethods: ['card_integrated'], loaded: true, loading: false, error: '', refresh: vi.fn(async () => {}), upsert: vi.fn(), remove: vi.fn() })
  vi.mocked(posRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'operations') return snapshot()
    if (command.command === 'order') return order!
    if (command.command === 'attempt') return quotes.get(command.attemptId)!
    if (command.command === 'save_order') {
      mutations.push(command)
      order = { id: command.orderId, revision: 1, name: command.name, orderKind: command.orderKind, tableId: null, status: 'open', phase: 'service', frozen: false, createdAt: business.createdAt, updatedAt: business.createdAt, operatorName: 'Sintético', discount: null, paidCents: 0, waivedCents: 0, cancelledCents: 0,
        items: command.items.map(line => ({ ...line, name: product.name, kitchenName: product.name, category: '', selectionLabel: '', paidQuantity: 0, sentQuantity: 0, grossCents: line.quantity * line.unitPriceCents, discountCents: 0, totalCents: line.quantity * line.unitPriceCents, taxCents: 0, taxBps: 0, taxTreatment: 'unconfigured', paidTotalCents: 0, paidDiscountCents: 0, paidTaxCents: 0 })),
        grossCents: command.items.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0), discountCents: 0, taxCents: 0, totalCents: command.items.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0), balanceCents: command.items.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0) }
      return order
    }
    if (command.command === 'prepare_checkout' || command.command === 'update_checkout') {
      mutations.push(command)
      const totals = command.amountsCents ? checkoutAmountTotals(order!, command.amountsCents[0]) : checkoutTotals(order!, command.items)
      const lines = command.amountsCents ? checkoutAmountTotals(order!, command.amountsCents[0]).items : command.items.map(item => ({ ...item, ...checkoutTotals(order!, [item]) }))
      quote = { ...pointCheckout().checkout, id: command.command === 'update_checkout' ? command.attemptId : pointId(++sequence), revision: command.command === 'update_checkout' ? command.expectedRevision + 1 : 1, orderId: order!.id, paymentMethod: command.paymentMethod, ...totals, amountsCents: command.amountsCents,
        items: lines.map(line => ({ ...line, productId: product.id, name: product.name, unitPriceCents })) }
      quotes.set(quote.id, quote)
      order = { ...order!, revision: order!.revision + 1, phase: 'checkout' }
      return quote
    }
    throw new Error(`Unexpected POS command ${command.command}`)
  })
  function materialize() {
    if (!remote || !quote || !order) throw new Error('No synthetic reservation')
    if (remote.saleState === 'materialized') return remote
    const saleId = pointId(++sequence), paidQuote = { ...quote, status: 'completed' as const, revision: quote.revision + 1, saleId }
    quotes.set(quote.id, paidQuote); quote = paidQuote
    const paid = order.paidCents + paidQuote.totalCents, balance = order.totalCents - paid
    order = { ...order, revision: order.revision + 1, frozen: true, paidCents: paid, balanceCents: balance, status: balance === 0 ? 'closed' : 'open', ...(paidQuote.amountsCents ? { amountSplit: true, amountParts: paidQuote.amountsCents.slice(1), amountPaidParts: (order.amountPaidParts ?? 0) + 1 } : {}),
      items: order.items.map(line => { const allocation = paidQuote.items.find(item => item.lineId === line.lineId); return allocation ? { ...line, paidQuantity: line.paidQuantity + allocation.quantity, sentQuantity: line.sentQuantity + allocation.quantity, paidTotalCents: line.paidTotalCents! + allocation.totalCents, paidDiscountCents: line.paidDiscountCents! + allocation.discountCents, paidTaxCents: line.paidTaxCents! + allocation.taxCents } : line }) }
    const sale: Sale = { id: saleId, totalCents: paidQuote.totalCents, paymentMethod: 'card_integrated', operatorName: 'Sintético', createdAt: business.createdAt, timezone: business.timezone, itemCount: paidQuote.items.reduce((sum, line) => sum + line.quantity, 0), items: paidQuote.items }
    sales.push(sale)
    remote = { ...remote, checkout: paidQuote, state: 'approved_verified', saleState: 'materialized', sale, updatedAt: `2026-10-05T12:00:${String(sequence).padStart(2, '0')}Z` }
    return remote
  }
  function reject() {
    if (!remote || !quote || !order) throw new Error('No synthetic reservation')
    if (remote.state === 'rejected') return remote
    quote = { ...quote, status: 'aborted', revision: quote.revision + 1 }
    quotes.set(quote.id, quote)
    order = { ...order, revision: order.revision + 1 }
    remote = { ...remote, checkout: quote, state: 'rejected', updatedAt: `2026-10-05T12:01:${String(++sequence).padStart(2, '0')}Z` }
    return remote
  }
  vi.mocked(pointRequest).mockImplementation(async (_access, command) => {
    if (command.command === 'settings') return settings()
    if (command.command === 'prepare') {
      quote = quotes.get(command.checkoutAttemptId)!
      remote = pointCheckout({ id: pointId(++sequence), checkout: quote, totalCents: quote.totalCents, items: quote.items, updatedAt: business.createdAt })
      return remote
    }
    if (command.command === 'start') { result = 'processing'; remote = { ...remote!, state: 'processing', remoteOrderId: 'SYNTHETIC' }; return remote }
    if (command.command === 'status') return result === 'approved' ? materialize() : result === 'rejected' ? reject() : remote!
    if (command.command === 'recover') return { checkouts: remote ? [remote] : [] }
    throw new Error(`Unexpected Point command ${command.command}`)
  })
  const refreshWithoutPayment = () => {
    if (order) order = { ...order, revision: order.revision + 1 }
    fireEvent(window, new Event('focus'))
  }
  const outcome = (value: typeof result) => { result = value; fireEvent(window, new Event('focus')) }
  return { product, mutations, sales, get order() { return order! }, get quote() { return quote! }, approve: () => outcome('approved'), reject: () => outcome('rejected'), refreshWithoutPayment }
}
function checkout() { return within(screen.getByRole('dialog', { name: 'Cobrar', exact: true })) }
async function openSale(count: number, backend: ReturnType<typeof fixture>) {
  render(<HomeScreen destination="Venta" business={business} operatorToken={pointAccess.operatorToken} onLock={vi.fn()} onLogout={vi.fn()} busy={false} error="" />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cobrar', exact: true })).toHaveProperty('disabled', true))
  for (let i = 0; i < count; i++) fireEvent.click(screen.getByRole('button', { name: `Agregar Consumo, ${money(backend.product.priceCents)}` }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cobrar', exact: true })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: 'Cobrar', exact: true }))
  await screen.findByRole('dialog', { name: 'Cobrar', exact: true })
  await waitFor(() => expect(checkout().getByRole('button', { name: /^Enviar a terminal/ })).toHaveProperty('disabled', false))
}
async function sendAndApprove(backend: ReturnType<typeof fixture>, amountCents: number) {
  await waitFor(() => expect(checkout().getByRole('button', { name: /^Enviar a terminal/ })).toHaveProperty('disabled', false))
  expect(backend.quote.totalCents).toBe(amountCents)
  const before = backend.order.balanceCents
  fireEvent.click(checkout().getByRole('button', { name: /^Enviar a terminal/ }))
  await checkout().findByText('El cliente está pagando en la terminal.')
  expect(backend.order.balanceCents).toBe(before)
  backend.approve()
  await checkout().findByRole('button', { name: 'Continuar', exact: true })
  await waitFor(() => expect(checkout().getByText('Pagado').parentElement?.textContent).toContain(money(backend.order.paidCents)))
  expect(backend.order.balanceCents).toBe(before - amountCents)
  expect(checkout().getByRole('heading', { name: 'Pago aprobado' })).toBeTruthy()
  expect(checkout().getByRole('region', { name: 'Cobro con Mercado Pago' }).querySelector('.point-payment-amount')?.textContent).toContain(money(amountCents))
  expect(checkout().getByText('Ver recibo')).toBeTruthy()
  expect(checkout().queryByRole('button', { name: /^Enviar a terminal/ })).toBeNull()
  expect(checkout().queryByRole('button', { name: 'Registrar pago' })).toBeNull()
}

test('Point amount splitting keeps valid pending parts when Home refreshes the paid order before Continue', async () => {
  const backend = fixture(76068)
  await openSale(1, backend)
  fireEvent.click(checkout().getByRole('radio', { name: 'Dividir por cantidad' }))
  fireEvent.change(checkout().getByLabelText('Persona 1'), { target: { value: '500' } })
  fireEvent.click(checkout().getByRole('button', { name: 'Añadir persona' }))
  fireEvent.change(checkout().getByLabelText('Persona 2'), { target: { value: '40' } })
  await waitFor(() => expect(backend.quote.amountsCents).toEqual([50000, 4000, 22068]))
  const firstReservationCount = backend.mutations.filter(command => (command as { command: string }).command === 'prepare_checkout').length
  await sendAndApprove(backend, 50000)
  // Soft assertions let the full continuation demonstrate that no money was lost.
  expect.soft(checkout().queryByText('Usa importes positivos y deja saldo para la última persona.')).toBeNull()
  expect.soft(checkout().getByLabelText('Persona 2')).toHaveProperty('value', '40.00')
  expect.soft(checkout().getByText('Restante automático').parentElement?.parentElement?.textContent).toContain('$220.68')
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'start')).toHaveLength(1)
  expect(backend.mutations.filter(command => (command as { command: string }).command === 'prepare_checkout')).toHaveLength(firstReservationCount)
  fireEvent.click(checkout().getByRole('button', { name: 'Continuar', exact: true }))
  await checkout().findByText('Pago registrado · $500.00')
  await waitFor(() => expect(backend.quote.amountsCents).toEqual([4000, 22068]))
  expect(screen.getByRole('dialog', { name: 'Cobrar', exact: true })).toBeTruthy()
  expect(checkout().getByLabelText('Persona 2')).toHaveProperty('value', '40.00')

  fireEvent.change(checkout().getByLabelText('Persona 2'), { target: { value: '35' } })
  await waitFor(() => expect(backend.quote.amountsCents).toEqual([3500, 22568]))
  await act(async () => { backend.refreshWithoutPayment() })
  expect(checkout().getByLabelText('Persona 2')).toHaveProperty('value', '35')
  expect(checkout().queryByText('Usa importes positivos y deja saldo para la última persona.')).toBeNull()
  fireEvent.change(checkout().getByLabelText('Persona 2'), { target: { value: '40' } })
  await waitFor(() => expect(backend.quote.amountsCents).toEqual([4000, 22068]))

  await sendAndApprove(backend, 4000)
  expect.soft(checkout().queryByText('Usa importes positivos y deja saldo para la última persona.')).toBeNull()
  expect.soft(checkout().queryByLabelText('Persona 2')).toBeNull()
  expect.soft(checkout().getByText('Restante automático').parentElement?.parentElement?.textContent).toContain('$220.68')
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'start')).toHaveLength(2)
  fireEvent.click(checkout().getByRole('button', { name: 'Continuar', exact: true }))
  await checkout().findByText('Pago registrado · $40.00')
  await waitFor(() => expect(backend.quote.amountsCents).toEqual([22068]))
  await sendAndApprove(backend, 22068)
  fireEvent.click(checkout().getByRole('button', { name: 'Continuar', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cobrar', exact: true })).toBeNull())
  expect(backend.sales.map(sale => sale.totalCents)).toEqual([50000, 4000, 22068])
  expect(backend.order.balanceCents).toBe(0)
  expect(backend.order.items[0].paidQuantity).toBe(1)
  expect(backend.order.items[0].paidTotalCents).toBe(76068)
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'start')).toHaveLength(3)
  expect(backend.mutations.some(command => (command as { command: string }).command === 'record_checkout')).toBe(false)
  expect(Object.keys(localStorage).filter(key => key.startsWith('pos-operations:'))).toEqual([])
})

test('Point item splitting clears the paid selection after Home refresh without reserving another payment before Continue', async () => {
  const backend = fixture(10000)
  await openSale(3, backend)
  fireEvent.click(checkout().getByRole('radio', { name: 'Dividir cuenta' }))
  fireEvent.change(checkout().getByRole('spinbutton', { name: 'Cantidad a cobrar de Consumo' }), { target: { value: '2' } })
  await waitFor(() => expect(backend.quote.totalCents).toBe(20000))
  await sendAndApprove(backend, 20000)
  expect.soft(checkout().getByRole('spinbutton', { name: 'Cantidad a cobrar de Consumo' })).toHaveProperty('value', '0')
  expect(checkout().getByText('1 disponible')).toBeTruthy()
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'start')).toHaveLength(1)
  const previousQuoteId = backend.quote.id
  await act(async () => { backend.refreshWithoutPayment() })
  expect(backend.quote.id).toBe(previousQuoteId)
  fireEvent.click(checkout().getByRole('button', { name: 'Continuar', exact: true }))
  await checkout().findByText('Pago registrado · $200.00')
  expect(checkout().getByRole('spinbutton', { name: 'Cantidad a cobrar de Consumo' })).toHaveProperty('value', '0')
  expect(checkout().getByRole('button', { name: /^Enviar a terminal/ })).toHaveProperty('disabled', true)
  fireEvent.click(checkout().getByRole('button', { name: 'Añadir Consumo a este cobro' }))
  await waitFor(() => expect(backend.quote.totalCents).toBe(10000))
  await sendAndApprove(backend, 10000)
  fireEvent.click(checkout().getByRole('button', { name: 'Continuar', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cobrar', exact: true })).toBeNull())
  expect(backend.sales.map(sale => sale.totalCents)).toEqual([20000, 10000])
  expect(backend.order.balanceCents).toBe(0)
  expect(backend.order.items[0].paidQuantity).toBe(3)
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'start')).toHaveLength(2)
  expect(backend.mutations.some(command => (command as { command: string }).command === 'record_checkout')).toBe(false)
})

test.each(['amounts', 'items'] as const)('processing and rejected Point %s payments preserve the unpaid selection and balance', async selection => {
  const backend = fixture(selection === 'amounts' ? 76068 : 10000)
  await openSale(selection === 'amounts' ? 1 : 3, backend)
  if (selection === 'amounts') {
    fireEvent.click(checkout().getByRole('radio', { name: 'Dividir por cantidad' }))
    fireEvent.change(checkout().getByLabelText('Persona 1'), { target: { value: '500' } })
    fireEvent.click(checkout().getByRole('button', { name: 'Añadir persona' }))
    fireEvent.change(checkout().getByLabelText('Persona 2'), { target: { value: '40' } })
    await waitFor(() => expect(backend.quote.amountsCents).toEqual([50000, 4000, 22068]))
  } else {
    fireEvent.click(checkout().getByRole('radio', { name: 'Dividir cuenta' }))
    fireEvent.change(checkout().getByRole('spinbutton', { name: 'Cantidad a cobrar de Consumo' }), { target: { value: '2' } })
    await waitFor(() => expect(backend.quote.totalCents).toBe(20000))
  }
  const before = backend.order.balanceCents
  fireEvent.click(checkout().getByRole('button', { name: /^Enviar a terminal/ }))
  await checkout().findByText('El cliente está pagando en la terminal.')
  await act(async () => { backend.refreshWithoutPayment() })
  const assertUnpaidSelection = () => {
    expect(backend.order.balanceCents).toBe(before)
    expect(backend.order.paidCents).toBe(0)
    expect(backend.order.amountPaidParts ?? 0).toBe(0)
    expect(backend.sales).toEqual([])
    if (selection === 'amounts') {
      expect(checkout().getByLabelText('Persona 1')).toHaveProperty('value', '500')
      expect(checkout().getByLabelText('Persona 2')).toHaveProperty('value', '40')
      expect(checkout().getByText('Restante automático').parentElement?.parentElement?.textContent).toContain('$220.68')
    } else expect(checkout().getByRole('spinbutton', { name: 'Cantidad a cobrar de Consumo' })).toHaveProperty('value', '2')
    expect(checkout().queryByText('Usa importes positivos y deja saldo para la última persona.')).toBeNull()
    expect(checkout().queryByText(/Pago registrado/)).toBeNull()
  }
  assertUnpaidSelection()
  expect(checkout().queryByRole('button', { name: /^Enviar a terminal/ })).toBeNull()
  backend.reject()
  await checkout().findByRole('heading', { name: 'Pago rechazado' })
  assertUnpaidSelection()
  fireEvent.click(checkout().getByRole('button', { name: 'Volver a la cuenta', exact: true }))
  await waitFor(() => expect(checkout().getByRole('button', { name: /^Enviar a terminal/ })).toHaveProperty('disabled', false))
  assertUnpaidSelection()
  expect(vi.mocked(pointRequest).mock.calls.filter(([, command]) => command.command === 'start')).toHaveLength(1)
  expect(backend.mutations.some(command => (command as { command: string }).command === 'record_checkout')).toBe(false)
})
