import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseAccountRequest, RequestValidationError } from '../../supabase/functions/account/validation'
import { businessAccountsEnabled, businessDefaultVat, newBusinessProfile, detectedBusinessTimezone, validClabe } from '../../src/lib/business-profile'

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
    expect(newBusinessProfile('cafe').defaultVatTreatment).toBe('unconfigured')
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

describe('creation timezone and receiving account boundary', () => {
  it('detects a valid device timezone for creation and keeps defaults explicit', () => {
    expect(() => new Intl.DateTimeFormat('es', { timeZone: detectedBusinessTimezone() })).not.toThrow()
  })
  it('matches the published CLABE check digit example and rejects ASCII/length/checksum errors', () => {
    // Banco de México Circular 12/2018, Annex 4: published calculation example.
    expect(validClabe('002180032240946700')).toBe(true)
    for (const value of ['002180032240946701', '00218003224094670', '002 180 032240946700', '٠'.repeat(18)]) expect(validClabe(value)).toBe(false)
  })
  it.each(requests)('keeps receiving account optional and exact on $action', request => {
    const account = { beneficiary: '  Comercio sintético  ', bank: 'Banco sintético', clabe: '000000000000000000' }
    expect(parseAccountRequest({ ...request, profile: { ...profile, transferAccount: account } })).toMatchObject({ profile: { transferAccount: { ...account, beneficiary: 'Comercio sintético' } } })
    expect(parseAccountRequest({ ...request, profile: { ...profile, transferAccount: null } })).toMatchObject({ profile: { transferAccount: null } })
    for (const transferAccount of [{ ...account, clabe: '000000000000000001' }, { ...account, clabe: 0 }, { ...account, bank: '' }, { ...account, credential: 'forbidden' }, { ...account, beneficiary: 42 }])
      expect(() => parseAccountRequest({ ...request, profile: { ...profile, transferAccount } })).toThrow(RequestValidationError)
  })
})
