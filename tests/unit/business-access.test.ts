// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'
import { invitationFromLink, preferredBusiness, rememberBusiness } from '../../src/lib/business-access'
import type { BusinessSummary } from '../../src/lib/contracts'

const own: BusinessSummary = { id: 'own', name: 'Mi negocio', businessType: 'cafe', role: 'owner' }
const staff: BusinessSummary = { id: 'staff', name: 'Negocio del equipo', businessType: 'cafe', role: 'cashier' }
afterEach(() => localStorage.clear())

test('business preference cannot select an inaccessible business or another account preference', () => {
  rememberBusiness('person', 'staff')
  expect(preferredBusiness([own, staff], 'person', false)).toEqual(staff)
  expect(preferredBusiness([own, staff], 'other-person', false)).toBeNull()
  expect(preferredBusiness([own, { ...staff, id: 'replacement' }], 'person', false)).toBeNull()
})

test('employee entry never falls back to an owned or unclassified business', () => {
  rememberBusiness('person', 'own')
  expect(preferredBusiness([own, staff], 'person', true)).toEqual(staff)
  expect(preferredBusiness([own], 'person', true)).toBeNull()
  expect(preferredBusiness([{ ...own, role: undefined }], 'person', true)).toBeNull()
})

test('multiple employee businesses require a choice unless a current one was remembered', () => {
  const other = { ...staff, id: 'second', role: 'manager' as const }
  expect(preferredBusiness([own, staff, other], 'person', true)).toBeNull()
  rememberBusiness('person', 'second')
  expect(preferredBusiness([own, staff, other], 'person', true)).toEqual(other)
})

test('invitation links accept only complete codes from this application origin', () => {
  const origin = 'https://pos.example.test'
  const code = 'ab'.repeat(32)
  expect(invitationFromLink(`${origin}/#invite=${code}`, origin)).toBe(code)
  for (const value of [`https://foreign.example.test/#invite=${code}`, `${origin}/#invite=short`, `${origin}/#pair=${code}`, 'javascript:alert(1)', 'invalid']) {
    expect(invitationFromLink(value, origin)).toBeNull()
  }
})
