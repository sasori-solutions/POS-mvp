/** Consume claims only AFTER auth.getUser verified this exact JWT. These helpers do not verify JWTs. */
export interface VerifiedAuthClaims {
  session_id?: unknown
  amr?: unknown
  [key: string]: unknown
}
interface VerifiedUser { email_confirmed_at?: string; identities?: { provider?: string }[] }

/** Supabase AMR says "oauth", without identifying the provider. This Google-only application
 * therefore rejects accounts linked to any other OAuth provider rather than guessing its provenance.
 * Email may be linked, but its password/magiclink/OTP method cannot satisfy OAuth authentication.
 */
export function verifiedGoogleAuthentication(user: VerifiedUser, claims: VerifiedAuthClaims, freshAtSeconds?: number): boolean {
  const providers = user.identities?.map(identity => identity.provider) ?? []
  if (!user.email_confirmed_at || !providers.includes('google') || providers.some(provider => provider !== 'google' && provider !== 'email')) return false
  if (!Array.isArray(claims.amr)) return false
  const oauth = claims.amr.filter(entry => entry && typeof entry === 'object' && entry.method === 'oauth')
  if (oauth.length === 0 || claims.amr.some(entry => !entry || typeof entry !== 'object' || !['oauth', 'totp', 'token_refresh'].includes(entry.method))) return false
  if (freshAtSeconds !== undefined) return oauth.some(entry => typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
    && entry.timestamp >= freshAtSeconds - 300 && entry.timestamp <= freshAtSeconds + 60)
  return true
}

export function claimsFromVerifiedJwt(jwt: string): VerifiedAuthClaims | null {
  try {
    const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(atob(payload))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}
