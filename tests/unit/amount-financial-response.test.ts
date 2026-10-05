import { expect, test } from 'vitest'
import { AccountClientError } from '../../src/lib/account'
import { checkoutAmountTotals } from '../../src/lib/checkout-amounts'
import { assertFinancialResponse } from '../../src/lib/financial-response'
import type { CheckoutAttempt, OperationalOrder } from '../../src/lib/operations-contracts'
import type { Sale } from '../../src/lib/pos-contracts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function order(): OperationalOrder {
  return { id: id(1), orderKind: 'counter', revision: 1, name: 'Venta directa', tableId: null, status: 'open', phase: 'checkout', frozen: false,
    createdAt: '2026-10-04T12:00:00Z', updatedAt: '2026-10-04T12:00:00Z', operatorName: 'Operador sintético',
    items: [{ lineId: id(2), productId: id(3), version: 1, name: 'Producto sintético', kitchenName: 'Producto sintético', category: '', selectionLabel: '', note: '',
      quantity: 3, paidQuantity: 0, sentQuantity: 0, paidTotalCents: 0, paidDiscountCents: 0, paidTaxCents: 0,
      unitPriceCents: 101, grossCents: 303, discountCents: 101, totalCents: 202, taxCents: 28, taxBps: 1600, taxTreatment: 'vat_16' }],
    discount: { kind: 'fixed', value: 101, reason: 'Cortesía' }, grossCents: 303, discountCents: 101, totalCents: 202, taxCents: 28,
    paidCents: 0, waivedCents: 0, cancelledCents: 0, balanceCents: 202, amountSplit: false, amountPaidParts: 0, amountParts: [] }
}
function quote(source: OperationalOrder, parts: number[]): CheckoutAttempt {
  const totals = checkoutAmountTotals(source, parts[0])
  return { id: id(4), revision: 1, kind: 'payment', status: 'prepared', orderId: source.id, shiftId: id(5), saleId: null, originalSaleId: null,
    paymentMethod: 'cash', totalCents: totals.totalCents, discountCents: totals.discountCents, taxCents: totals.taxCents, amountsCents: parts,
    operatorName: 'Operador sintético', resolverName: null, createdAt: source.createdAt, resolvedAt: null, reason: '',
    items: totals.items.map(item => ({ ...item, productId: id(3), name: 'Producto sintético', unitPriceCents: 101, taxBps: 1600, taxTreatment: 'vat_16' })) }
}
function confirm(source: OperationalOrder, attempt: CheckoutAttempt): OperationalOrder {
  const next = structuredClone(source)
  next.revision++; next.frozen = true; next.paidCents += attempt.totalCents; next.balanceCents -= attempt.totalCents
  next.amountSplit = true; next.amountPaidParts = (next.amountPaidParts ?? 0) + 1; next.amountParts = attempt.amountsCents!.slice(1)
  if (!next.balanceCents) next.status = 'paid'
  for (const slice of attempt.items) {
    const line = next.items.find(item => item.lineId === slice.lineId)!
    line.paidQuantity += slice.quantity; line.paidTotalCents! += slice.totalCents; line.paidDiscountCents! += slice.discountCents; line.paidTaxCents! += slice.taxCents
  }
  return next
}
const command = { command: 'record_checkout' as const, operationId: id(7), attemptId: id(4), expectedRevision: 1, confirmed: true as const }
test('confirmed amount parts preserve exact discount, IVA and units through every remaining balance', () => {
  let current = order()
  const parts = [50, 50, 102], receipts: CheckoutAttempt[] = []
  for (let index = 0; index < parts.length; index++) {
    const attempt = quote(current, parts.slice(index))
    assertFinancialResponse({ command: 'prepare_checkout', operationId: id(8), orderId: current.id, expectedRevision: current.revision, items: [], amountsCents: parts.slice(index), paymentMethod: 'cash' }, attempt)
    const next = confirm(current, attempt), completed = { ...attempt, revision: 2, status: 'completed' as const, saleId: id(9), resolvedAt: current.createdAt }
    assertFinancialResponse(command, { order: next, attempt: completed })
    const receipt: Sale = { id: id(9), createdAt: current.createdAt, timezone: 'America/Mexico_City', paymentMethod: 'cash', totalCents: attempt.totalCents,
      itemCount: attempt.items.reduce((sum, item) => sum + item.quantity, 0), operatorName: current.operatorName, items: attempt.items.map(item => ({ ...item, category: '' })) }
    assertFinancialResponse({ command: 'sale', saleId: receipt.id }, receipt)
    expect(current.balanceCents).toBe(202 - parts.slice(0, index).reduce((sum, part) => sum + part, 0))
    expect(next.balanceCents).toBe(current.balanceCents - parts[index])
    receipts.push(attempt); current = next
  }
  expect(receipts.map(receipt => receipt.items[0].quantity)).toEqual([0, 0, 3])
  expect(receipts.reduce((sum, receipt) => sum + receipt.discountCents, 0)).toBe(101)
  expect(receipts.reduce((sum, receipt) => sum + receipt.taxCents, 0)).toBe(28)
  expect(current).toMatchObject({ paidCents: 202, balanceCents: 0, amountParts: [], amountPaidParts: 3 })
})
test('amount response boundary rejects corrupt pending plans, person counts and cent allocations', () => {
  const attempt = quote(order(), [50, 152]), next = confirm(order(), attempt)
  const completed = { ...attempt, status: 'completed' as const, saleId: id(9) }
  for (const patch of [{ amountParts: [151] }, { amountParts: [0, 152] }, { amountParts: undefined }, { amountPaidParts: -1 }, { amountPaidParts: 0.5 }, { amountPaidParts: undefined }, { amountSplit: false }]) {
    expect(() => assertFinancialResponse(command, { order: { ...next, ...patch }, attempt: completed })).toThrow(AccountClientError)
  }
  const bad = structuredClone(completed)
  bad.taxCents++; bad.items[0].taxCents++
  const badOrder = structuredClone(next); badOrder.items[0].paidTaxCents!++
  expect(() => assertFinancialResponse(command, { order: badOrder, attempt: bad })).toThrow(AccountClientError)
  expect(() => assertFinancialResponse({ command: 'prepare_checkout', operationId: id(8), orderId: next.id, expectedRevision: 1, items: [], amountsCents: [51, 151], paymentMethod: 'cash' }, attempt)).toThrow(AccountClientError)
})
test('integer amount allocation closes all rounding remainders, including every one-cent payment', () => {
  for (const parts of [[1, 201], [67, 67, 68], Array(202).fill(1)]) {
    let current = order(), discount = 0, tax = 0, quantity = 0
    for (const part of parts) {
      const totals = checkoutAmountTotals(current, part)
      discount += totals.discountCents; tax += totals.taxCents; quantity += totals.items[0].quantity
      current = confirm(current, quote(current, current.balanceCents === part ? [part] : [part, current.balanceCents - part]))
    }
    expect([current.balanceCents, discount, tax, quantity]).toEqual([0, 101, 28, 3])
  }
})
