import type { AccountEnvelope, AccountErrorCode, AccountRequest, AccountResponses } from './contracts'
import { supabase, supabasePublishableKey, supabaseUrl } from './supabase'

export class AccountClientError extends Error {
  constructor(
    readonly code: AccountErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'AccountClientError'
  }
}

export async function accountRequest<A extends AccountRequest['action']>(
  request: Extract<AccountRequest, { action: A }>,
  capturedAccessToken?: string,
): Promise<AccountResponses[A]> {
  if (!supabase) throw new AccountClientError('SERVER_ERROR', 'La aplicación aún no está configurada.')
  let accessToken = capturedAccessToken
  if (!accessToken) {
    const { data: identity, error } = await supabase.auth.getSession()
    if (error || !identity.session) throw new AccountClientError('AUTH_REQUIRED', 'Vuelve a entrar con Google.')
    accessToken = identity.session.access_token
  }

  let response: Response
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: supabasePublishableKey,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(15_000),
      credentials: 'omit',
      cache: 'no-store',
    })
  } catch {
    throw new AccountClientError('NETWORK_ERROR', 'No pudimos conectar. Revisa tu conexión e intenta de nuevo.')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new AccountClientError('SERVER_ERROR', 'No pudimos completar la solicitud. Intenta de nuevo.')
  }
  if (!body || typeof body !== 'object') {
    throw new AccountClientError('SERVER_ERROR', 'No pudimos completar la solicitud. Intenta de nuevo.')
  }
  const envelope = body as AccountEnvelope<AccountResponses[A]>
  if ('error' in envelope) {
    throw new AccountClientError(envelope.error.code, envelope.error.message, envelope.error.retryAfterSeconds)
  }
  if (!response.ok || !('data' in envelope)) {
    throw new AccountClientError('SERVER_ERROR', 'No pudimos completar la solicitud. Intenta de nuevo.')
  }
  return envelope.data
}
