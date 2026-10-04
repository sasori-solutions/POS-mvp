import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseAccountRequest, RequestValidationError } from '../../supabase/functions/account/validation'

const profile = { branchName: 'Principal', registerName: 'Caja 1', address: '', city: '', state: '', contactPhone: '', paymentMethods: ['cash'] }
const details = { name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Mexico_City' }
const requests = [
  { action: 'create_business', ...details, operationId: randomUUID(), pin: '092837' },
  { action: 'update_business', ...details, businessId: randomUUID(), operatorToken: 'a'.repeat(64) },
]

describe.each(requests)('$action payment method configuration', request => {
  it.each([
    ['card_integrated'],
    ['cash', 'card_integrated'],
    ['cash', 'card_external', 'transfer', 'card_integrated'],
    ['cash', 'card_external', 'transfer'],
  ])('accepts the supported methods: %j', (...paymentMethods) => {
    const input = { ...request, profile: { ...profile, paymentMethods } }
    expect(parseAccountRequest(input)).toEqual(input)
  })

  it.each([
    [], ['card_integrated', 'card_integrated'], ['cash', 'unknown'],
    ['cash', 'card_external', 'transfer', 'card_integrated', 'crypto'],
    [null], [42], ['CARD_INTEGRATED'],
  ])('rejects invalid methods: %j', (...paymentMethods) => {
    expect(() => parseAccountRequest({ ...request, profile: { ...profile, paymentMethods } })).toThrow(RequestValidationError)
  })

  it('keeps exact keys and operator authentication requirements', () => {
    const input = { ...request, profile: { ...profile, paymentMethods: ['card_integrated'] } }
    expect(() => parseAccountRequest({ ...input, profile: { ...input.profile, terminalApproved: true } })).toThrow(RequestValidationError)
    if (request.action === 'update_business') {
      expect(() => parseAccountRequest({ ...input, operatorToken: undefined })).toThrow(RequestValidationError)
      expect(() => parseAccountRequest({ ...input, businessId: 'unknown' })).toThrow(RequestValidationError)
    }
  })
})
