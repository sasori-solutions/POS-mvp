import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseAccountRequest, RequestValidationError } from '../../supabase/functions/account/validation'
import { businessAccountsEnabled, businessDefaultVat, newBusinessProfile } from '../../src/lib/business-profile'

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

describe('business operation defaults and image HTTP boundary', () => {
  it('offers accounts for restaurants, direct payment for other new businesses and preserves legacy defaults', () => {
    expect(newBusinessProfile('restaurant').accountsEnabled).toBe(true)
    expect(newBusinessProfile('cafe').accountsEnabled).toBe(false)
    expect(newBusinessProfile('other').accountsEnabled).toBe(false)
    expect(businessAccountsEnabled(profile as never)).toBe(true)
    expect(businessDefaultVat({})).toBe('vat_16')
    expect(businessDefaultVat({ defaultVatTreatment: 'exempt' })).toBe('exempt')
  })
  it('accepts only typed known preferences and leaves seven-key payloads untouched', () => {
    const request = requests[0]
    expect(parseAccountRequest({ ...request, profile })).toEqual({ ...request, profile })
    const preferences = { ...profile, accountsEnabled: false, defaultVatTreatment: 'vat_0', logoImageId: null }
    expect(parseAccountRequest({ ...request, profile: preferences })).toEqual({ ...request, profile: preferences })
    for (const patch of [{ accountsEnabled: 'false' }, { defaultVatTreatment: 'standard' }, { logoImageId: 'https://example.test/logo' }, { logoImageId: 3 }])
      expect(() => parseAccountRequest({ ...request, profile: { ...profile, ...patch } })).toThrow(RequestValidationError)
  })
  it('keeps chunk requests below the HTTP bound and rejects arbitrary URLs, subjects and malformed parts', () => {
    const image = { action: 'upload_profile_image', businessId: randomUUID(), operatorToken: 'a'.repeat(64), subject: 'account', imageId: randomUUID(), operationId: randomUUID(), part: 0, parts: 1, data: '/9j/4AAQ/9k=' }
    expect(parseAccountRequest(image)).toEqual(image)
    expect(JSON.stringify({ ...image, data: 'A'.repeat(4096) }).length).toBeLessThan(8192)
    for (const patch of [{ data: 'A'.repeat(4100) }, { data: 'AAA' }, { data: '<svg>' }, { parts: 61 }, { part: 1 }, { part: 0.5 }, { subject: 'another-user' }, { url: 'https://example.test/image' }, { deviceToken: 'b'.repeat(64) }])
      expect(() => parseAccountRequest({ ...image, ...patch })).toThrow(RequestValidationError)
    expect(parseAccountRequest({ action: 'remove_profile_image', businessId: image.businessId, operatorToken: image.operatorToken, subject: 'account', operationId: image.operationId })).toMatchObject({ subject: 'account' })
  })
})
