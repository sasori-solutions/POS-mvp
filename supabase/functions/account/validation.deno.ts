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

Deno.test('accepts progressive business profile and rejects injection', () => {
  const profile = { branchName: 'Principal', registerName: 'Caja 1', address: '', city: 'Guadalajara', state: 'Jalisco', contactPhone: '', paymentMethods: ['cash', 'card_external'] }
  assert.deepEqual(parseAccountRequest({ ...validCreate, profile }), { ...validCreate, name: 'Café Norte', profile })
  assert.throws(() => parseAccountRequest({ ...validCreate, profile: { ...profile, bankPassword: 'never' } }))
})

Deno.test('validates employee invitation and restricted device actions', () => {
  const token = 'a'.repeat(64)
  assert.deepEqual(parseAccountRequest({ action: 'device_unlock', deviceToken: token, employeeId: validCreate.operationId, pin: '015827' }), { action: 'device_unlock', deviceToken: token, employeeId: validCreate.operationId, pin: '015827' })
  assert.throws(() => parseAccountRequest({ action: 'create_employee', businessId: validCreate.operationId, operatorToken: token, name: 'Cajero', role: 'owner', pin: '015827', operationId: validCreate.operationId }))
  assert.throws(() => parseAccountRequest({ action: 'device_status', deviceToken: token, userId: validCreate.operationId }))
})

Deno.test('unified staff creation supports optional Google without a redundant PIN', () => {
  const base = { action: 'create_employee', businessId: validCreate.operationId, operatorToken: 'a'.repeat(64), name: 'Empleado', role: 'cashier', operationId: validCreate.operationId }
  assert.deepEqual(parseAccountRequest({ ...base, pin: null, inviteWithGoogle: true }), { ...base, pin: null, inviteWithGoogle: true })
  assert.deepEqual(parseAccountRequest({ ...base, pin: null }), { ...base, pin: null })
  assert.deepEqual(parseAccountRequest({ ...base, pin: null, inviteWithGoogle: false }), { ...base, pin: null, inviteWithGoogle: false })
  for (const patch of [{ pin: '123456' }, { pin: '123456', inviteWithGoogle: true }, { pin: null, inviteWithGoogle: 'true' }]) assert.throws(() => parseAccountRequest({ ...base, ...patch }))
})
Deno.test('targets an existing employee explicitly and accepts without asking the name twice', () => {
  const invitation = { action: 'create_invitation', businessId: validCreate.operationId, operatorToken: 'a'.repeat(64), employeeId: validCreate.operationId, operationId: validCreate.operationId }
  assert.deepEqual(parseAccountRequest(invitation), invitation)
  assert.throws(() => parseAccountRequest({ ...invitation, name: 'Empleado', role: 'cashier' }))
  const acceptance = { action: 'accept_invitation', invitationCode: 'a'.repeat(64), pin: '024680', operationId: validCreate.operationId }
  assert.deepEqual(parseAccountRequest(acceptance), acceptance)
})

Deno.test('requires explicit owner-scoped employee lifecycle identifiers without injected state', () => {
  for (const action of ['delete_employee', 'restore_employee']) {
    const request = { action, businessId: validCreate.operationId, operatorToken: 'a'.repeat(64), employeeId: validCreate.operationId, operationId: validCreate.operationId }
    assert.deepEqual(parseAccountRequest(request), request)
    for (const patch of [{ employeeId: 'invalid' }, { operationId: 'invalid' }, { active: true }, { deletedAt: null }, { userId: validCreate.operationId }]) assert.throws(() => parseAccountRequest({ ...request, ...patch }))
    const { operationId: _operationId, ...missingOperation } = request
    assert.throws(() => parseAccountRequest(missingOperation))
  }
})

Deno.test('owner staff commands cannot choose or overwrite an employee PIN', () => {
  const base = { businessId: validCreate.operationId, operatorToken: 'a'.repeat(64), name: 'Empleado', role: 'cashier' }
  assert.throws(() => parseAccountRequest({ action: 'create_employee', ...base, pin: '024680', operationId: validCreate.operationId }))
  assert.throws(() => parseAccountRequest({ action: 'update_employee', ...base, employeeId: validCreate.operationId, active: true, pin: '024680' }))
})

Deno.test('owner recovery cannot be requested with Google and a new PIN alone', () => {
  assert.throws(() => parseAccountRequest({ action: 'reset_pin', businessId: validCreate.operationId, pin: '024680' }))
})

Deno.test('PIN setup, recovery enrollment and change require explicit scoped authorization', () => {
  const owner = { businessId: validCreate.operationId, operatorToken: 'a'.repeat(64) }
  const operationId = validCreate.operationId
  const requests = [
    { action: 'create_pin_setup', ...owner, employeeId: validCreate.operationId, operationId },
    { action: 'employee_pin_setup_details', setupCode: 'b'.repeat(64) },
    { action: 'set_employee_pin', setupCode: 'b'.repeat(64), pin: '024680', operationId },
    { action: 'device_pin_setup_details', deviceToken: 'a'.repeat(64), setupCode: 'b'.repeat(64) },
    { action: 'device_set_employee_pin', deviceToken: 'a'.repeat(64), setupCode: 'b'.repeat(64), pin: '024680', operationId },
    { action: 'create_recovery_code', ...owner, currentPin: '015827', operationId },
    { action: 'change_pin', ...owner, currentPin: '015827', pin: '024680', operationId },
    { action: 'reset_pin', businessId: validCreate.operationId, recoveryCode: 'b'.repeat(64), pin: '024680', operationId },
  ]
  for (const request of requests) {
    assert.deepEqual(parseAccountRequest(request), request)
    assert.throws(() => parseAccountRequest({ ...request, userId: validCreate.operationId }))
    if ('operationId' in request) assert.throws(() => parseAccountRequest({ ...request, operationId: 'invalid' }))
    if ('currentPin' in request) assert.throws(() => parseAccountRequest({ ...request, currentPin: '12345' }))
    if ('setupCode' in request) assert.throws(() => parseAccountRequest({ ...request, setupCode: 'b'.repeat(63) }))
    if ('recoveryCode' in request) assert.throws(() => parseAccountRequest({ ...request, recoveryCode: 'b'.repeat(63) }))
  }
})
