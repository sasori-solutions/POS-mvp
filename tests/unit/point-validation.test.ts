import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseAccountRequest, RequestValidationError } from '../../supabase/functions/account/validation'

const owner = { action: 'point', businessId: randomUUID(), operatorToken: 'a'.repeat(64) }
describe('Point HTTP trust boundary', () => {
  it('requires authenticated tenant and full operator credentials with exact keys', () => {
    expect(parseAccountRequest({ ...owner, command: 'settings' })).toEqual({ ...owner, command: 'settings' })
    for (const request of [
      { ...owner, command: 'settings', userId: randomUUID() },
      { ...owner, command: 'settings', accessToken: 'provider-secret' },
      { ...owner, businessId: 'arbitrary-business', command: 'settings' },
      { ...owner, operatorToken: 'short', command: 'settings' },
      { ...owner, command: 'provider_fact', state: 'approved_verified' },
    ]) expect(() => parseAccountRequest(request)).toThrow(RequestValidationError)
    expect(parseAccountRequest({ action: 'device_point', deviceToken: 'd'.repeat(64), operatorToken: 'e'.repeat(64), command: 'recover' })).toMatchObject({ action: 'device_point', command: 'recover' })
  })
  it('uses IDs for charging, never client amounts, payloads or URLs', () => {
    const request = { ...owner, command: 'start', operationId: randomUUID(), checkoutId: randomUUID() }
    expect(parseAccountRequest(request)).toEqual(request)
    for (const extra of [{ amountCents: 100 }, { url: 'https://example.test' }, { token: 'secret' }, { remoteOrderId: 'fake' }]) {
      expect(() => parseAccountRequest({ ...request, ...extra })).toThrow(RequestValidationError)
    }
  })
  it('requires exact positive money and evidence-compatible allocation for refunds', () => {
    const request = { ...owner, command: 'refund', operationId: randomUUID(), checkoutId: randomUUID(), amountCents: 101, merchandiseCents: 101, tipCents: 0, reason: 'Solicitud del cliente' }
    expect(parseAccountRequest(request)).toEqual(request)
    for (const changed of [{ amountCents: 1.01 }, { amountCents: 0 }, { amountCents: Number.MAX_SAFE_INTEGER }, { merchandiseCents: 100 }, { reason: '' }, { tipCents: -1 }]) {
      expect(() => parseAccountRequest({ ...request, ...changed })).toThrow(RequestValidationError)
    }
  })
  it('bounds reports by full range and validates real dates before aggregation', () => {
    const request = { ...owner, command: 'merchant_report', from: '2026-01-01', to: '2026-02-01' }
    expect(parseAccountRequest(request)).toEqual(request)
    expect(parseAccountRequest({ ...request, to: request.from })).toMatchObject({ from: request.from, to: request.from })
    for (const changed of [{ from: '2026-02-30' }, { to: '2025-12-31' }, { to: '2028-01-01' }, { pageSize: 999999 }, { businessIds: [randomUUID()] }]) {
      expect(() => parseAccountRequest({ ...request, ...changed })).toThrow(RequestValidationError)
    }
  })
  it('accepts scoped official simulation commands but rejects tokens and unsupported state', () => {
    const connect = { ...owner, command: 'connect_sandbox', operationId: randomUUID() }
    expect(parseAccountRequest(connect)).toEqual(connect)
    expect(() => parseAccountRequest({ ...connect, accessToken: 'secret' })).toThrow(RequestValidationError)
    for (const status of ['processed', 'failed', 'canceled', 'expired', 'action_required']) {
      const request = { ...owner, command: 'simulate', checkoutId: randomUUID(), status }
      expect(parseAccountRequest(request)).toEqual(request)
      expect(() => parseAccountRequest({ ...request, remoteOrderId: 'guessed' })).toThrow(RequestValidationError)
    }
    expect(() => parseAccountRequest({ ...owner, command: 'simulate', checkoutId: randomUUID(), status: 'refunded' })).toThrow(RequestValidationError)
  })
  it('cannot manually declare an integrated payment successful', () => {
    const request = { action: 'pos', businessId: owner.businessId, operatorToken: owner.operatorToken, command: 'record_payment', operationId: randomUUID(), orderId: randomUUID(), expectedRevision: 1, paymentMethod: 'card_integrated', confirmed: true, items: [{ lineId: randomUUID(), quantity: 1 }] }
    expect(() => parseAccountRequest(request)).toThrow(RequestValidationError)
  })
})
