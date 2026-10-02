import assert from 'node:assert/strict'
import { DeviceProofError, verifiedDeviceRequest } from './device-proof.ts'
import { parseAccountRequest } from './validation.ts'
const base64 = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
async function signed(request: Record<string, unknown>, offset = 0) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const publicKey = base64(await crypto.subtle.exportKey('spki', keys.publicKey))
  const nonce = crypto.randomUUID(), issuedAt = Date.now() + offset
  const signature = base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(JSON.stringify({ request, nonce, issuedAt }))))
  return { ...request, deviceProof: { publicKey, nonce, issuedAt, signature } }
}
Deno.test('accepts a P-256 proof over the exact wire payload and returns only hash/nonce', async () => {
  const input = await signed({ action: 'unlock', businessId: crypto.randomUUID(), pin: '024680', deviceName: '  Teléfono   personal ' })
  const result = await verifiedDeviceRequest(input)
  assert.match(result.keyHash!, /^[0-9a-f]{64}$/)
  assert.equal(result.nonce, input.deviceProof.nonce)
  assert.equal(result.request.deviceProof, undefined)
  assert.equal((parseAccountRequest(result.request) as { deviceName: string }).deviceName, 'Teléfono personal')
})
Deno.test('rejects payload, nonce and time tampering with an otherwise valid signature', async () => {
  const input = await signed({ action: 'unlock', businessId: crypto.randomUUID(), pin: '024680' })
  await assert.rejects(verifiedDeviceRequest({ ...input, pin: '123456' }), DeviceProofError)
  await assert.rejects(verifiedDeviceRequest({ ...input, deviceProof: { ...input.deviceProof, nonce: crypto.randomUUID() } }), DeviceProofError)
  await assert.rejects(verifiedDeviceRequest({ ...input, deviceProof: { ...input.deviceProof, issuedAt: input.deviceProof.issuedAt - 1000 } }), DeviceProofError)
})
Deno.test('rejects stale/future signed requests and malformed proof encodings', async () => {
  await assert.rejects(verifiedDeviceRequest(await signed({ action: 'status' }, -121_000)), DeviceProofError)
  await assert.rejects(verifiedDeviceRequest(await signed({ action: 'status' }, 121_000)), DeviceProofError)
  const input = await signed({ action: 'status' })
  for (const override of [{ signature: 'AAAA' }, { publicKey: 'AAAA' }, { nonce: 'not-a-uuid' }, { issuedAt: 1.2 }, { extra: true }]) {
    await assert.rejects(verifiedDeviceRequest({ ...input, deviceProof: { ...input.deviceProof, ...override } }), DeviceProofError)
  }
})
Deno.test('preserves unsigned compatibility so SQL can enforce employee-only binding', async () => {
  assert.deepEqual(await verifiedDeviceRequest({ action: 'status' }), { request: { action: 'status' }, keyHash: null, nonce: null })
  const owner = { businessId: crypto.randomUUID(), operatorToken: 'a'.repeat(64) }
  assert.equal(parseAccountRequest({ action: 'notifications', ...owner }).action, 'notifications')
  assert.equal(parseAccountRequest({ action: 'review_employee_device', ...owner, notificationId: crypto.randomUUID(), decision: 'approve' }).action, 'review_employee_device')
  assert.throws(() => parseAccountRequest({ action: 'review_employee_device', ...owner, notificationId: crypto.randomUUID(), decision: 'anything' }))
})
