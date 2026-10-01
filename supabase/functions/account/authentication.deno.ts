import assert from 'node:assert/strict'
import { verifiedGoogleAuthentication } from './authentication.ts'
const now = 1_800_000_000
const google = { email_confirmed_at: '2026-10-01T00:00:00Z', identities: [{ provider: 'google' }] }
Deno.test('linked Google identity cannot turn password/magiclink/recovery into Google authentication', () => {
  for (const method of ['password', 'magiclink', 'otp', 'recovery', 'invite', 'sso/saml']) {
    assert.equal(verifiedGoogleAuthentication(google, { amr: [{ method, timestamp: now }] }), false)
  }
  assert.equal(verifiedGoogleAuthentication(google, {}), false)
})
Deno.test('OAuth must belong to a Google-only provider set', () => {
  assert.equal(verifiedGoogleAuthentication(google, { amr: [{ method: 'oauth', timestamp: now }] }), true)
  assert.equal(verifiedGoogleAuthentication({ ...google, identities: [{ provider: 'google' }, { provider: 'email' }] }, { amr: [{ method: 'oauth', timestamp: now }] }), true)
  assert.equal(verifiedGoogleAuthentication({ ...google, identities: [{ provider: 'google' }, { provider: 'github' }] }, { amr: [{ method: 'oauth', timestamp: now }] }), false)
  assert.equal(verifiedGoogleAuthentication({ ...google, email_confirmed_at: undefined }, { amr: [{ method: 'oauth', timestamp: now }] }), false)
})
Deno.test('fresh Google proof uses original OAuth AMR time, not JWT issue or refresh time', () => {
  assert.equal(verifiedGoogleAuthentication(google, { amr: [{ method: 'oauth', timestamp: now - 60 }] }, now), true)
  assert.equal(verifiedGoogleAuthentication(google, { amr: [{ method: 'oauth', timestamp: now - 301 }] }, now), false)
  assert.equal(verifiedGoogleAuthentication(google, { iat: now, amr: [{ method: 'oauth', timestamp: now - 3600 }, { method: 'token_refresh', timestamp: now }] }, now), false)
  assert.equal(verifiedGoogleAuthentication(google, { amr: [{ method: 'oauth', timestamp: now + 61 }] }, now), false)
})
