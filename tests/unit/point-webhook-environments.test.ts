import { describe, expect, it } from 'vitest'
import { verifySignature, webhookSecrets } from '../../supabase/functions/point/webhook'

async function signed(secret: string) {
  const manifest = 'id:ord-fixture;request-id:request-fixture;ts:1700000000;'
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  const hex = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
  return new Request('https://example.test/point-webhook?data.id=ORD-FIXTURE&type=order', {
    method: 'POST', headers: { 'x-request-id': 'request-fixture', 'x-signature': `ts=1700000000,v1=${hex}` },
    body: JSON.stringify({ type: 'order', data: { id: 'ORD-FIXTURE' } }),
  })
}
describe('test and live webhook coexistence', () => {
  const configuration = { MP_WEBHOOK_SECRET: 'synthetic-main-signature', MP_WEBHOOK_TEST_SECRET: 'synthetic-test-signature', MP_WEBHOOK_PREVIOUS_SECRET: 'synthetic-old-signature' }
  const secrets = webhookSecrets(name => configuration[name as keyof typeof configuration])
  it.each(Object.values(configuration))('verifies configured application or rotation key %s', async secret => {
    expect(await verifySignature(await signed(secret), secrets)).toMatchObject({ remoteOrderId: 'ORD-FIXTURE' })
  })
  it('rejects unrelated keys and never treats an environment flag as a signature', async () => {
    await expect(verifySignature(await signed('unknown-signature'), secrets)).rejects.toThrow()
    expect(webhookSecrets(() => undefined)).toEqual([])
    expect(webhookSecrets(() => 'same-key')).toEqual(['same-key'])
  })
})
