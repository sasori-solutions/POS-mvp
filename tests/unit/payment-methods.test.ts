import { expect, test } from 'vitest'
import { collectionPaymentMethod, collectionPaymentMethods, isManualCollectionMethod, pointCardReady } from '../../src/lib/payment-methods'
import { pointSettings } from '../fixtures/point'

test('collection display preserves external and integrated identities independently without mutating persisted input', () => {
  const stored = ['cash', 'card_external', 'transfer', 'card_integrated'] as const
  expect(collectionPaymentMethods(stored)).toEqual(['cash', 'card_external', 'transfer', 'card_integrated'])
  expect(stored).toEqual(['cash', 'card_external', 'transfer', 'card_integrated'])
  expect(collectionPaymentMethod('card_external')).toBe('card_external')
  expect(collectionPaymentMethods(['card_external', 'cash', 'card_external'])).toEqual(['card_external', 'cash'])
})

test.each(['card_integrated'] as const)('%s cannot be newly collected manually', method => {
  expect(isManualCollectionMethod(method)).toBe(false)
})

test.each(['cash', 'transfer', 'card_external'] as const)('%s is an explicitly recorded collection', method => {
  expect(isManualCollectionMethod(method)).toBe(true)
})

test('card requires the integrated method in persisted settings, even with an otherwise verified terminal', () => {
  expect(pointCardReady(['card_external'], pointSettings())).toBe(false)
  expect(pointCardReady(['card_integrated'], pointSettings())).toBe(true)
})

test.each(['off', 'paused', 'denied', 'disconnected', 'unverified-account', 'inactive', 'unverified-terminal', 'standalone', 'physical-pending'] as const)('card cannot start with %s readiness', condition => {
  const settings = pointSettings()
  if (condition === 'off') settings.enabled = false
  if (condition === 'paused') settings.chargesEnabled = false
  if (condition === 'denied') settings.permissions.charge = false
  if (condition === 'disconnected') settings.connection = null
  if (condition === 'unverified-account') settings.connection!.verifiedAt = null
  if (condition === 'inactive') settings.terminals[0].active = false
  if (condition === 'unverified-terminal') settings.terminals[0].verified = false
  if (condition === 'standalone') settings.terminals[0].mode = 'STANDALONE'
  if (condition === 'physical-pending') settings.terminals[0].physicalStepsPending = true
  expect(pointCardReady(['card_integrated'], settings)).toBe(false)
})

test('one verified active terminal is sufficient even when other terminals are still being configured', () => {
  const settings = pointSettings()
  settings.terminals.unshift({ ...settings.terminals[0], id: 'OTHER_SYNTHETIC', verified: false, physicalStepsPending: true })
  expect(pointCardReady(['card_integrated'], settings)).toBe(true)
})
