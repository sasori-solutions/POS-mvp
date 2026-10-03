// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest'
import { readOperation } from '../../src/features/operations/useOperations'
import { businessDate } from '../../src/features/operations/ReportsScreen'

beforeEach(() => localStorage.clear())
test('retains the exact resolving operation across reload without storing session credentials', () => {
  const key = 'fixture-operation'
  const command = { command: 'resolve_checkout', operationId: 'b5191d90-60b1-4b61-830b-cec58d2a22ac', attemptId: 'ce0c7299-123e-4b55-bdb6-af8c842e9902', expectedRevision: 2, resolution: 'complete', confirmed: true, reason: 'Pago verificado' }
  localStorage.setItem(key, JSON.stringify(command))
  expect(readOperation(key)).toEqual(command)
  localStorage.setItem(key, JSON.stringify({ ...command, operatorToken: 'secret-not-a-fixture-token' }))
  expect(() => readOperation(key)).toThrow()
  expect(localStorage.getItem(key)).toBeTruthy()
})
test('damaged and unfamiliar recovery records are retained for deliberate review', () => {
  for (const value of ['{broken', '{}', '{"command":"device_unlock","operationId":"b5191d90-60b1-4b61-830b-cec58d2a22ac","pin":"024680"}']) {
    localStorage.setItem('fixture-operation', value)
    expect(() => readOperation('fixture-operation')).toThrow()
    expect(localStorage.getItem('fixture-operation')).toBe(value)
  }
})
test('chooses the business calendar date across midnight rather than the browser UTC date', () => {
  expect(businessDate('America/Mexico_City', new Date('2026-10-03T04:00:00Z'))).toBe('2026-10-02')
  expect(businessDate('America/Cancun', new Date('2026-10-03T05:00:00Z'))).toBe('2026-10-03')
})
