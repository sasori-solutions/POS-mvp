// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountRequest, AccountClientError, deviceRequest } from '../../src/lib/account'
import { assertFinancialResponse } from '../../src/lib/financial-response'
import { posRequest } from '../../src/lib/pos'
import { useOperationalMutation } from '../../src/features/operations/useOperations'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { PosCommand, Sale } from '../../src/lib/pos-contracts'

vi.mock('../../src/lib/account', async original => ({ ...await original<object>(), accountRequest: vi.fn(), deviceRequest: vi.fn() }))
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const access = { businessId: id(1), operatorToken: 'synthetic-memory-only' }
const recordCommand: Extract<PosCommand, { command: 'record_checkout' }> = { command: 'record_checkout', operationId: id(9), attemptId: id(4), expectedRevision: 1, confirmed: true }
function account(): OperationalOrder {
  return { id: id(2), revision: 1, name: 'Cuenta', tableId: null, status: 'open', phase: 'checkout', frozen: false,
    createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z', operatorName: 'Persona sintética',
    items: [{ lineId: id(3), productId: id(5), version: 1, name: 'Producto', kitchenName: 'Producto', category: '', selectionLabel: '', note: '',
      quantity: 3, paidQuantity: 0, sentQuantity: 0, unitPriceCents: 101, grossCents: 303, discountCents: 101, totalCents: 202, taxCents: 28, taxBps: 1600, taxTreatment: 'vat_16' }],
    discount: { kind: 'fixed', value: 101, reason: 'Cortesía' }, grossCents: 303, discountCents: 101, totalCents: 202, taxCents: 28,
    paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 202 }
}
function attempt(): CheckoutAttempt {
  return { id: id(4), revision: 1, kind: 'payment', status: 'prepared', orderId: id(2), shiftId: id(6), saleId: null, originalSaleId: null,
    paymentMethod: 'cash', totalCents: 68, taxCents: 9, discountCents: 33, operatorName: 'Persona sintética', resolverName: null,
    createdAt: '2026-10-03T12:00:00Z', resolvedAt: null, reason: '',
    items: [{ lineId: id(3), productId: id(5), name: 'Producto', quantity: 1, unitPriceCents: 101, totalCents: 68, discountCents: 33, taxCents: 9 }] }
}
function accepted() {
  const order = account()
  order.revision = 2; order.frozen = true; order.paidCents = 68; order.balanceCents = 134
  order.items[0].paidQuantity = 1; order.items[0].sentQuantity = 1
  return { order, attempt: { ...attempt(), revision: 3, status: 'completed' as const, saleId: id(7), resolvedAt: '2026-10-03T12:01:00Z' } }
}
function serverError(command: PosCommand, value: unknown) {
  expect(() => assertFinancialResponse(command, value)).toThrow(AccountClientError)
  try { assertFinancialResponse(command, value) } catch (caught) { expect((caught as AccountClientError).code).toBe('SERVER_ERROR') }
}
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', { onLine: true, locks: { request: vi.fn(async (_name: string, callback: () => unknown) => callback()) } })
})
afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals() })

describe('authoritative financial response boundary', () => {
  it('accepts intact orders, reservations, snapshots and a completed partial payment without transforming data', async () => {
    const order = account(), reservation = attempt(), result = accepted()
    assertFinancialResponse({ command: 'order', orderId: order.id }, order)
    assertFinancialResponse({ command: 'operations' }, { orders: [order], attempts: [reservation] })
    assertFinancialResponse({ command: 'prepare_checkout', operationId: id(8), orderId: order.id, expectedRevision: 1, paymentMethod: 'cash', items: [{ lineId: id(3), quantity: 1 }] }, reservation)
    vi.mocked(accountRequest).mockResolvedValue(result)
    expect(await posRequest(access, recordCommand)).toBe(result)
  })

  it('accepts cancellation and waiver with retained financial line snapshots', () => {
    for (const status of ['cancelled', 'waived'] as const) {
      const order = accepted().order
      order.status = status; order.balanceCents = 0; order[status === 'cancelled' ? 'cancelledCents' : 'waivedCents'] = 134
      assertFinancialResponse({ command: 'order', orderId: order.id }, order)
    }
  })

  it('accepts an existing empty service order and a zero-total paid account', () => {
    const empty = account()
    Object.assign(empty, { phase: 'service', items: [], discount: null, grossCents: 0, discountCents: 0, totalCents: 0, taxCents: 0, balanceCents: 0 })
    assertFinancialResponse({ command: 'order', orderId: empty.id }, empty)
    const free = account()
    Object.assign(free, { status: 'paid', frozen: true, discount: { kind: 'percent', value: 10000, reason: 'Cortesía' }, discountCents: 303, totalCents: 0, taxCents: 0, balanceCents: 0 })
    Object.assign(free.items[0], { paidQuantity: 3, sentQuantity: 3, discountCents: 303, totalCents: 0, taxCents: 0 })
    assertFinancialResponse({ command: 'order', orderId: free.id }, free)
  })

  it.each([
    { grossCents: 304 }, { discountCents: 100 }, { totalCents: 203 }, { taxCents: 29 }, { balanceCents: 201 },
    { paidCents: 1, balanceCents: 201 }, { waivedCents: -1 }, { cancelledCents: 1 }, { balanceCents: Number.MAX_SAFE_INTEGER + 1 },
    { discount: { kind: 'percent', value: 10001 } }, { discount: null },
  ])('rejects inconsistent order money %j', change => {
    serverError({ command: 'order', orderId: id(2) }, { ...account(), ...change })
  })

  it('rejects duplicate or impossible lines and ambiguous list identities', () => {
    const order = account()
    serverError({ command: 'order', orderId: order.id }, { ...order, items: [order.items[0], order.items[0]] })
    serverError({ command: 'order', orderId: order.id }, { ...order, items: [{ ...order.items[0], sentQuantity: 4 }] })
    serverError({ command: 'orders' }, { orders: [order, order] })
    serverError({ command: 'operations' }, { orders: [], attempts: [attempt(), attempt()] })
  })

  it('accepts recorded legacy reversal tax with no classification and never infers IVA', () => {
    const refund = { ...attempt(), kind: 'reversal' as const, orderId: null, originalSaleId: id(7), totalCents: 101, discountCents: 0, taxCents: 0,
      items: [{ ...attempt().items[0], totalCents: 101, discountCents: 0, taxCents: 0, taxBps: null, taxTreatment: 'legacy' }] }
    assertFinancialResponse({ command: 'prepare_reversal', operationId: id(8), saleId: id(7), reason: 'Corrección' }, refund)
    serverError({ command: 'attempt', attemptId: refund.id }, { ...refund, taxCents: 14 })
    serverError({ command: 'attempt', attemptId: refund.id }, { ...refund, items: [{ ...refund.items[0], taxCents: null }] })
  })

  it('rejects mismatched method, quantity, amount and identity in reservations', () => {
    const command: Extract<PosCommand, { command: 'prepare_checkout' }> = { command: 'prepare_checkout', operationId: id(8), orderId: id(2), expectedRevision: 1, paymentMethod: 'cash', items: [{ lineId: id(3), quantity: 1 }] }
    for (const change of [{ paymentMethod: 'transfer' }, { orderId: id(10) }, { totalCents: 69 }, { taxCents: 10 }]) serverError(command, { ...attempt(), ...change })
    serverError({ ...command, items: [{ lineId: id(3), quantity: 2 }] }, attempt())
    serverError({ command: 'attempt', attemptId: id(10) }, attempt())
  })

  it('rejects incomplete payment results, broken sale linkage and inconsistent paid slices', () => {
    serverError(recordCommand, { accepted: true })
    serverError(recordCommand, { ...accepted(), attempt: { ...accepted().attempt, id: id(10) } })
    serverError(recordCommand, { ...accepted(), attempt: { ...accepted().attempt, orderId: id(10) } })
    serverError(recordCommand, { ...accepted(), attempt: { ...accepted().attempt, saleId: null } })
    // Individually valid totals still cannot replace this paid prefix with another cent allocation.
    const result = accepted()
    Object.assign(result.attempt, { totalCents: 67, discountCents: 34 })
    Object.assign(result.attempt.items[0], { totalCents: 67, discountCents: 34 })
    serverError(recordCommand, result)
  })

  it('applies the same boundary for personal and paired-register requests', async () => {
    vi.mocked(accountRequest).mockResolvedValue({ accepted: true })
    vi.mocked(deviceRequest).mockResolvedValue({ accepted: true })
    await expect(posRequest(access, recordCommand)).rejects.toMatchObject({ code: 'SERVER_ERROR' })
    await expect(posRequest({ ...access, deviceToken: 'synthetic-device-only' }, recordCommand)).rejects.toMatchObject({ code: 'SERVER_ERROR' })
  })

  it('checks legacy receipt totals and counts while preserving absent or null tax metadata', () => {
    const sale: Sale = { id: id(7), createdAt: '2026-10-03T12:00:00Z', timezone: 'America/Mexico_City', paymentMethod: 'cash', totalCents: 202, itemCount: 3, operatorName: 'Persona sintética',
      items: [{ productId: id(5), name: 'Producto', category: '', quantity: 3, unitPriceCents: 101, totalCents: 202, discountCents: 101 }] }
    assertFinancialResponse({ command: 'sale', saleId: sale.id }, sale)
    assertFinancialResponse({ command: 'sale', saleId: sale.id }, { ...sale, items: [{ ...sale.items[0], taxCents: null, taxBps: null }] })
    serverError({ command: 'sale', saleId: sale.id }, { ...sale, itemCount: 4 })
    serverError({ command: 'sale', saleId: sale.id }, { ...sale, totalCents: 203 })
    serverError({ command: 'sale', saleId: sale.id }, { ...sale, items: [{ ...sale.items[0], taxCents: 203 }] })
  })

  it('checks exact complete_sale results without confusing repeated products with duplicate line identities', () => {
    const command: Extract<PosCommand, { command: 'complete_sale' }> = { command: 'complete_sale', operationId: id(9), paymentMethod: 'cash', totalCents: 303,
      items: [{ productId: id(5), quantity: 1, unitPriceCents: 101, version: 1 }, { productId: id(5), quantity: 2, unitPriceCents: 101, version: 1 }] }
    const sale = { id: id(7), paymentMethod: 'cash', totalCents: 303, itemCount: 3,
      items: command.items.map(line => ({ ...line, totalCents: line.quantity * line.unitPriceCents })) }
    assertFinancialResponse(command, sale)
    serverError(command, { ...sale, paymentMethod: 'transfer' })
    serverError(command, { ...sale, items: [{ ...sale.items[0], quantity: 3, totalCents: 303 }] })
  })

  it('rejects aggregate receipt gross above the order bound even when each line and aggregate net fit', () => {
    const sale = { id: id(7), paymentMethod: 'cash', totalCents: 199_999_898, itemCount: 102,
      items: [id(5), id(12)].map(productId => ({ productId, quantity: 51, unitPriceCents: 99_999_999,
        totalCents: 99_999_949, discountCents: 5_000_000_000 })) }
    expect(sale.items.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0)).toBe(10_199_999_898)
    serverError({ command: 'sale', saleId: sale.id }, sale)
  })

  it('rejects a saved order or discount that does not correspond to the accepted command', () => {
    const order = account(), line = order.items[0]
    const command: Extract<PosCommand, { command: 'save_order' }> = { command: 'save_order', operationId: id(9), orderId: order.id, expectedRevision: 1, name: order.name, tableId: null,
      items: [{ lineId: line.lineId, productId: line.productId, quantity: line.quantity, unitPriceCents: line.unitPriceCents, version: line.version, note: '' }] }
    assertFinancialResponse(command, order)
    serverError({ ...command, items: [{ ...command.items[0], quantity: 2 }] }, order)
    serverError({ command: 'set_order_discount', operationId: id(9), orderId: order.id, expectedRevision: 1, discount: null }, order)
  })

  it('retains the original durable payment after malformed success and clears it only after an intact exact retry', async () => {
    const employee = id(11), key = `pos-operations:${access.businessId}:${employee}`
    vi.mocked(accountRequest).mockResolvedValueOnce({ ...accepted(), order: { ...accepted().order, balanceCents: 133 } }).mockResolvedValueOnce(accepted())
    const view = renderHook(() => useOperationalMutation(access, employee))
    await act(async () => { await expect(view.result.current.execute(recordCommand)).rejects.toMatchObject({ code: 'SERVER_ERROR' }) })
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(recordCommand)
    expect(view.result.current.pending).toEqual(recordCommand)
    expect(view.result.current.lastResult).toBeNull()
    await act(async () => { await view.result.current.execute(recordCommand) })
    expect(localStorage.getItem(key)).toBeNull()
    expect(view.result.current.pending).toBeNull()
    expect(vi.mocked(accountRequest).mock.calls[0][0]).toEqual(vi.mocked(accountRequest).mock.calls[1][0])
    expect(view.result.current.lastResult?.command).toBe('record_checkout')
  })
})
