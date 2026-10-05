import { expect, test } from 'vitest'
import { amountInput, amountPlan } from '../../src/lib/checkout-amounts'
import { parseAccountRequest } from '../../supabase/functions/account/validation'

test('the final person receives the exact remaining cents', () => {
  expect(amountPlan(76068, ['500', '40'])).toEqual([50000, 4000, 22068])
  expect(amountPlan(3, ['0.01', '0,01'])).toEqual([1, 1, 1])
  expect(amountInput(22068)).toBe('220.68')
  expect(amountPlan(76068, [])).toEqual([76068])
})
test('amount plans reject nonpositive, invalid, excessive and overprecision amounts', () => {
  for (const inputs of [[''], ['0'], ['-1'], ['760.68'], ['760.69'], ['1.001'], ['1e2'], ['Infinity'], ['500', '260.68'], Array(20).fill('0.01')]) expect(amountPlan(76068, inputs)).toBeNull()
  for (const balance of [0, -1, 1.5, 10_000_000_000]) expect(amountPlan(balance, [])).toBeNull()
})
test('both HTTP transports accept exact integer amount reservations and reject mixed item selection', () => {
  const id = 'a937be42-142d-4eb0-9915-899b289fb552'
  const personal = { action: 'pos', businessId: id, operatorToken: 'ab'.repeat(32) }
  const device = { action: 'device_pos', deviceToken: 'cd'.repeat(32), operatorToken: personal.operatorToken }
  const command = { command: 'prepare_checkout', operationId: id, orderId: id, expectedRevision: 1, items: [], amountsCents: [50000, 4000, 22068], paymentMethod: 'cash' }
  for (const access of [personal, device]) {
    expect(parseAccountRequest({ ...access, ...command })).toMatchObject(command)
    for (const patch of [{ items: [{ lineId: id, quantity: 1 }] }, { amountsCents: [] }, { amountsCents: [0] }, { amountsCents: [-1] }, { amountsCents: [1.5] }, { amountsCents: ['50000'] }, { amountsCents: Array(21).fill(1) }, { amountsCents: [9_999_999_999, 1] }, { extra: true }]) expect(() => parseAccountRequest({ ...access, ...command, ...patch })).toThrow()
    const { orderId: _orderId, ...fields } = command
    expect(parseAccountRequest({ ...access, ...fields, command: 'update_checkout', attemptId: id })).toMatchObject({ amountsCents: command.amountsCents })
    expect(() => parseAccountRequest({ ...access, ...command, command: 'record_payment', confirmed: true })).toThrow()
  }
})
