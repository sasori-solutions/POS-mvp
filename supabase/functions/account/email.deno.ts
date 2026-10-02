import assert from 'node:assert/strict'
import { mailConfiguration, sendPinRecovery } from './email.ts'
const env = (values: Record<string, string>) => (key: string) => values[key]
Deno.test('email delivery requires configured sender/origin and never enables a local transport in production', () => {
  assert.equal(mailConfiguration(env({})), null)
  assert.equal(mailConfiguration(env({ APP_ORIGIN: 'https://pos.example.test', PIN_RECOVERY_FROM: 'acceso@example.test', TEST_MAILPIT_URL: 'http://localhost:8025', ALLOW_TEST_PASSWORD_AUTH: 'true' })), null)
  assert.equal(mailConfiguration(env({ APP_ORIGIN: 'https://pos.example.test/path', PIN_RECOVERY_FROM: 'acceso@example.test', RESEND_API_KEY: 'synthetic-key' })), null)
  assert.equal(mailConfiguration(env({ APP_ORIGIN: 'http://127.0.0.1:5173', PIN_RECOVERY_FROM: 'acceso@example.test', TEST_MAILPIT_URL: 'https://untrusted.example', ALLOW_TEST_PASSWORD_AUTH: 'true' })), null)
  assert.deepEqual(mailConfiguration(env({ APP_ORIGIN: 'http://127.0.0.1:5173', PIN_RECOVERY_FROM: 'acceso@example.test', TEST_MAILPIT_URL: 'http://localhost:8025', ALLOW_TEST_PASSWORD_AUTH: 'true' })), { appOrigin: 'http://127.0.0.1:5173', from: 'acceso@example.test', localMailpit: 'http://localhost:8025' })
})
Deno.test('provider errors do not claim success; the mail uses a scoped link and one recipient', async () => {
  const previous = globalThis.fetch
  const config = { from: 'acceso@example.test', appOrigin: 'https://pos.example.test', apiKey: 'synthetic-key' }
  const mail = { id: 'synthetic-id', email: 'recipient@example.test', token: 'a'.repeat(64) }
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, 'https://api.resend.com/emails')
      const payload = JSON.parse(init!.body as string)
      assert.deepEqual(payload.to, [mail.email])
      assert(payload.text.includes(`/recover-pin#recovery=${mail.token}`))
      assert(!payload.text.includes('Google'))
      assert.equal((init!.headers as Record<string, string>)['Idempotency-Key'], 'pin-recovery/synthetic-id')
      return new Response(JSON.stringify({ id: 'accepted' }), { status: 200 })
    }
    assert.equal(await sendPinRecovery(mail, config), true)
    globalThis.fetch = async () => new Response('{}', { status: 403 })
    assert.equal(await sendPinRecovery(mail, config), false)
    globalThis.fetch = async () => new Response('{}', { status: 200 })
    assert.equal(await sendPinRecovery(mail, config), false)
    globalThis.fetch = async () => { throw new Error('Transport unavailable') }
    assert.equal(await sendPinRecovery(mail, config), false)
  } finally { globalThis.fetch = previous }
})
