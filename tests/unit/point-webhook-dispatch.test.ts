import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  admin: { rpc: vi.fn() },
  createClient: vi.fn(),
  rpc: vi.fn(),
  wake: vi.fn(),
}))
vi.mock('npm:@supabase/supabase-js@2.117.2', () => ({ createClient: mocks.createClient }))
vi.mock('../../supabase/functions/point/service.ts', () => ({ serviceRpc: mocks.rpc }))
vi.mock('../../supabase/functions/point/background.ts', () => ({ backgroundPointWork: mocks.wake }))

const businessId = '00000000-0000-4000-8000-000000000001'
const attemptId = '00000000-0000-4000-8000-000000000002'
const secret = 'synthetic-webhook-signature'
let environment: Record<string, string>

async function signed(body: unknown = { type: 'order', data: { id: 'ORD-FIXTURE' } }, keySecret = secret) {
  const manifest = 'id:ord-fixture;request-id:request-fixture;ts:1700000000;'
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(keySecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  const signature = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return new Request('https://example.test/point-webhook?data.id=ORD-FIXTURE&type=order', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'request-fixture', 'x-signature': `ts=1700000000,v1=${signature}` },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  environment = { MP_WEBHOOK_TEST_SECRET: secret, SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-only-key' }
  vi.stubGlobal('Deno', { env: { get: (name: string) => environment[name] }, serve: vi.fn() })
  mocks.createClient.mockReturnValue(mocks.admin)
  mocks.rpc.mockResolvedValue({ accepted: true, matched: true, businessId, attemptId })
  mocks.wake.mockReturnValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

async function handle(request: Request) {
  const { handleWebhook } = await import('../../supabase/functions/point-webhook/index.ts')
  return handleWebhook(request)
}

describe('signed webhook dispatch', () => {
  it('persists the signed locator before waking only its server-matched attempt', async () => {
    let persist!: (value: unknown) => void
    mocks.rpc.mockReturnValue(new Promise(resolve => { persist = resolve }))
    const response = handle(await signed({ type: 'order', businessId: 'untrusted-business', data: { id: 'ORD-FIXTURE', status: 'processed', total_paid_amount: '9999' } }))
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce())
    expect(mocks.wake).not.toHaveBeenCalled()
    expect(mocks.rpc.mock.calls[0]).toEqual([mocks.admin, 'webhook_enqueue', expect.objectContaining({ remoteOrderId: 'ORD-FIXTURE', signatureTimestamp: '1700000000' })])
    expect(mocks.rpc.mock.calls[0][2]).not.toHaveProperty('businessId')
    persist({ accepted: true, matched: true, businessId, attemptId })
    const result = await response
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ received: true })
    expect(mocks.wake).toHaveBeenCalledExactlyOnceWith(mocks.admin, { businessId, attemptId })
  })

  it('acknowledges durable receipt without waiting for provider reconciliation', async () => {
    mocks.wake.mockReturnValue(new Promise(() => {}))
    const result = await handle(await signed())
    expect(result.status).toBe(200)
    expect(mocks.wake).toHaveBeenCalledOnce()
    expect(result.headers.get('cache-control')).toBe('no-store')
  })

  it.each([
    { accepted: true, matched: false },
    { accepted: true, matched: true },
    { accepted: false, matched: true, businessId, attemptId },
    { accepted: true, matched: true, businessId: '', attemptId },
    { accepted: true, matched: true, businessId: 'untrusted-business', attemptId },
    { accepted: true, matched: true, businessId, attemptId: 'untrusted-attempt' },
    { accepted: true, matched: true, businessId, attemptId: null },
  ])('does not wake an unmatched or incomplete server result %#', async result => {
    mocks.rpc.mockResolvedValue(result)
    expect((await handle(await signed())).status).toBe(200)
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('does not acknowledge or wake when durable enqueue fails', async () => {
    mocks.rpc.mockRejectedValue(new Error('synthetic persistence failure'))
    expect((await handle(await signed())).status).toBe(503)
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('rejects unrelated signatures without enqueue or worker activity', async () => {
    expect((await handle(await signed(undefined, 'unrelated-test-signature'))).status).toBe(401)
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(mocks.admin, 'webhook_invalid_signature', {})
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('does not wake when the invalid-signature counter cannot be persisted', async () => {
    mocks.rpc.mockRejectedValue(new Error('synthetic counter write failure'))
    expect((await handle(await signed(undefined, 'unrelated-test-signature'))).status).toBe(503)
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('rejects oversized signed payloads before durable enqueue or worker activity', async () => {
    expect((await handle(await signed({ type: 'order', data: { id: 'ORD-FIXTURE' }, extra: 'x'.repeat(8192) }))).status).toBe(413)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it.each([
    { type: 'payment', data: { id: 'ORD-FIXTURE' } },
    { type: 'order', data: { id: 'ORD-OTHER' } },
    { type: 'order', data: { id: 123 } },
    [],
  ])('rejects a signed request whose body does not match its locator %#', async body => {
    expect((await handle(await signed(body))).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('rejects missing configuration without creating database clients or waking a worker', async () => {
    delete environment.MP_WEBHOOK_TEST_SECRET
    expect((await handle(await signed())).status).toBe(503)
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('rejects non-POST requests before reading configuration or dispatching work', async () => {
    expect((await handle(new Request('https://example.test/point-webhook'))).status).toBe(405)
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.wake).not.toHaveBeenCalled()
  })
})
