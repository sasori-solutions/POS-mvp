import { afterEach, expect, test, vi } from 'vitest'
import { accountRequest, AccountClientError } from '../../src/lib/account'
import { assertFinancialAttempt, assertFinancialSale } from '../../src/lib/financial-response'
import { assertPointResponse } from '../../src/lib/point-response'
import { pointRequest } from '../../src/lib/point-client'
import { pointAccess, pointCheckout, pointId, pointPaid, pointSettings } from '../fixtures/point'
vi.mock('../../src/lib/account', async original => ({ ...await original<object>(), accountRequest: vi.fn(), deviceRequest: vi.fn() }))
afterEach(() => vi.resetAllMocks())

test('integrated reservations and receipts preserve the exact financial contract', async () => {
  const quote = pointCheckout(), paid = pointPaid()
  expect(() => assertFinancialAttempt(quote.checkout)).not.toThrow()
  expect(() => assertFinancialSale(paid.sale)).not.toThrow()
  assertPointResponse({ command: 'prepare', operationId: pointId(50), checkoutAttemptId: quote.checkout.id, terminalId: quote.terminal.id }, quote)
  assertPointResponse({ command: 'status', checkoutId: paid.id }, paid)
  assertPointResponse({ command: 'settings' }, pointSettings())
  vi.mocked(accountRequest).mockResolvedValue(paid)
  expect(await pointRequest(pointAccess, { command: 'status', checkoutId: paid.id })).toBe(paid)
})

test.each([
  { totalCents: 10001 }, { refundedCents: 10001 }, { state: 'approved' }, { id: pointId(98) },
  { checkout: { ...pointCheckout().checkout, paymentMethod: 'cash' } },
  { items: [{ ...pointCheckout().items[0], totalCents: 9999 }] },
  { saleState: 'materialized', sale: null }, { refundRequests: undefined },
])('malformed Point success %j remains uncertain and cannot be rendered as confirmed', async change => {
  vi.mocked(accountRequest).mockResolvedValue({ ...pointCheckout(), ...change })
  await expect(pointRequest(pointAccess, { command: 'status', checkoutId: pointCheckout().id })).rejects.toMatchObject({ code: 'SERVER_ERROR' })
})

test('receipt line substitutions cannot pass by preserving only aggregate money', () => {
  const paid = pointPaid(); paid.sale!.items = [{ ...paid.sale!.items[0], productId: pointId(80) }]
  expect(() => assertPointResponse({ command: 'status', checkoutId: paid.id }, paid)).toThrow(AccountClientError)
})

test('a refund response must include the exact request identity, amount and allocation', () => {
  const command = { command: 'refund' as const, operationId: pointId(90), checkoutId: pointPaid().id, amountCents: 2000, merchandiseCents: 2000, tipCents: 0, reason: 'Corrección' }
  const request = { id: pointId(91), operationId: command.operationId, status: 'pending' as const, amountCents: 2000, merchandiseCents: 2000, tipCents: 0, reason: command.reason, remoteRefundId: null, firstSentAt: null }
  assertPointResponse(command, { ...pointPaid(), refundRequests: [request] })
  for (const changes of [{ operationId: pointId(92) }, { amountCents: 3000, merchandiseCents: 3000 }, { status: 'done' }, { amountCents: 2001 }]) {
    expect(() => assertPointResponse(command, { ...pointPaid(), refundRequests: [{ ...request, ...changes }] })).toThrow(AccountClientError)
  }
})

test('refund context must belong to the selected receipt', () => {
  expect(() => assertPointResponse({ command: 'refund_context', saleId: pointId(98) }, pointPaid())).toThrow(AccountClientError)
})


test('commission payment success must preserve statement arithmetic before recovery can be cleared', async () => {
  const command = { command: 'record_commission_payment' as const, operationId: pointId(60), statementId: pointId(61), amountCents: 100, paidAt: '2026-10-03T12:00:00Z', evidence: 'Abono sintético' }
  const statement = { id: pointId(61), period: '2026-09', status: 'invoiced', exactNumerator: '10000000', netCents: 1000, vatCents: 160, totalCents: 1160, collectedCents: 100, remainingCents: 1060, closedAt: '2026-10-01T12:00:00Z' }
  assertPointResponse(command, statement)
  for (const change of [{ totalCents: 1100 }, { remainingCents: 1160 }, { id: pointId(62) }, { collectedCents: 0, remainingCents: 1160 }]) {
    vi.mocked(accountRequest).mockResolvedValue({ ...statement, ...change })
    await expect(pointRequest(pointAccess, command)).rejects.toMatchObject({ code: 'SERVER_ERROR' })
  }
  assertPointResponse({ command: 'statements' }, { statements: [{ ...statement, totalCents: -1160, netCents: -1000, vatCents: -160, collectedCents: 0, remainingCents: -1160 }] })
})


test('a verified full refund can coexist with its still uncorrelated uncertain request', () => {
  const paid = pointPaid()
  const pending = { id: pointId(91), operationId: pointId(90), status: 'unknown_review', amountCents: paid.totalCents, merchandiseCents: paid.totalCents, tipCents: 0, reason: 'Devolución total', remoteRefundId: null, firstSentAt: '2026-10-03T12:01:00Z' }
  const result = { ...paid, state: 'refunded', refundedCents: paid.totalCents, refundRequests: [pending] }
  assertPointResponse({ command: 'refund_context', saleId: paid.sale!.id }, result)
  assertPointResponse({ command: 'status', checkoutId: paid.id }, result)
  expect(() => assertPointResponse({ command: 'status', checkoutId: paid.id }, { ...result, refundedCents: paid.totalCents + 1 })).toThrow(AccountClientError)
  expect(() => assertPointResponse({ command: 'status', checkoutId: paid.id }, { ...result, refundRequests: [{ ...pending, amountCents: paid.totalCents + 1, merchandiseCents: paid.totalCents + 1 }] })).toThrow(AccountClientError)
})
