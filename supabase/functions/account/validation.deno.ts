import assert from 'node:assert/strict'
import { parseAccountRequest } from './validation.ts'

const validCreate = {
  action: 'create_business',
  name: ' Café Norte ',
  businessType: 'cafe',
  timezone: 'America/Mexico_City',
  operationId: 'b6f4475c-5c39-4b1b-a38f-93c67755bf45',
  pin: '015827',
}

Deno.test('rejects PINs that are not exactly six ASCII digits', () => {
  for (const pin of ['12345', '1234567', '１２３４５６', 123456, '12345 ']) {
    assert.throws(() => parseAccountRequest({ ...validCreate, pin }))
  }
})

Deno.test('normalizes whitespace without losing leading PIN zeros', () => {
  assert.deepEqual(parseAccountRequest({ ...validCreate, name: '  Café\t Norte  ' }), {
    ...validCreate,
    name: 'Café Norte',
  })
})

Deno.test('rejects invalid names, timezones, types and operation identifiers', () => {
  for (const patch of [
    { name: ' ' }, { name: 'a' }, { name: 'x'.repeat(101) },
    { name: 'Café\u0000Norte' }, { timezone: 'Not/A_Timezone' },
    { timezone: '+02:00' }, { businessType: 'shop' }, { operationId: 'invalid' },
  ]) {
    assert.throws(() => parseAccountRequest({ ...validCreate, ...patch }))
  }
})

Deno.test('rejects injected identity fields and unknown actions', () => {
  for (const body of [
    { action: 'status', userId: 'someone-else' },
    { ...validCreate, userId: 'someone-else' },
    { action: 'admin' }, [], null,
  ]) {
    assert.throws(() => parseAccountRequest(body))
  }
})

Deno.test('requires a business UUID and full random token for PIN context access', () => {
  assert.throws(() => parseAccountRequest({ action: 'context', businessId: 'bad', operatorToken: 'a'.repeat(64) }))
  assert.throws(() => parseAccountRequest({ action: 'context', businessId: validCreate.operationId, operatorToken: 'a'.repeat(63) }))
  assert.deepEqual(parseAccountRequest({ action: 'lock', businessId: validCreate.operationId, operatorToken: 'a'.repeat(64) }), {
    action: 'lock', businessId: validCreate.operationId, operatorToken: 'a'.repeat(64),
  })
})
