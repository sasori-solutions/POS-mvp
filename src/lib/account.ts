import type { AccountEnvelope, AccountErrorCode, AccountRequest, AccountResponses } from './contracts'
import { supabase, supabasePublishableKey, supabaseUrl } from './supabase'

const messages: Record<AccountErrorCode, string> = {
  PRODUCT_CHANGED: 'El producto cambió. Actualiza el catálogo y revisa la venta antes de cobrar.',
  PRODUCT_UNAVAILABLE: 'Un producto ya no está disponible. Actualiza el catálogo y retíralo de la venta.',
  SALE_NOT_FOUND: 'No encontramos esta venta.',
  PAYMENT_METHOD_DISABLED: 'Este método de pago está desactivado. Actualiza el catálogo y elige otro.',
  AUTH_REQUIRED: 'Tu sesión venció. Vuelve a entrar con Google.', GOOGLE_REQUIRED: 'Entra con Google para continuar.',
  VALIDATION_ERROR: 'Revisa los datos e intenta de nuevo.', BUSINESS_ACCESS_DENIED: 'No tienes acceso a este negocio.',
  PERMISSION_DENIED: 'Tu rol no permite esta acción. Solicita ayuda al dueño.',
  INVITATION_INVALID: 'La invitación venció, fue revocada o ya no es válida. Pide una nueva al dueño.',
  PAIRING_INVALID: 'El código de conexión venció o ya no es válido. Pide uno nuevo al dueño.',
  DEVICE_REVOKED: 'Este dispositivo fue revocado. Vuelve a conectarlo con el dueño.',
  EMPLOYEE_INACTIVE: 'Tu acceso fue desactivado. Contacta al dueño.',
  REAUTH_REQUIRED: 'Vuelve a verificar tu cuenta con Google para cambiar el PIN.',
  PIN_INVALID: 'PIN incorrecto. Intenta de nuevo.', PIN_LOCKED: 'Demasiados intentos. Espera antes de volver a ingresar tu PIN.',
  PIN_SETUP_INVALID: 'El código de PIN venció o ya no está disponible. Pide uno nuevo al dueño.',
  PIN_SETUP_ACCOUNT_MISMATCH: 'Entra con la cuenta Google del empleado a quien pertenece este código.',
  RECOVERY_INVALID: 'El código de recuperación no es válido o ya fue utilizado.',
  RECOVERY_LOCKED: 'Demasiados intentos de recuperación. Espera antes de volver a intentar.',
  RECOVERY_UNAVAILABLE: 'Este negocio no tiene un código de recuperación preparado. Se genera al entrar con el PIN del dueño.',
  SESSION_INVALID: 'La app está bloqueada. Ingresa tu PIN para continuar.', SESSION_EXPIRED: 'Tu sesión de trabajo venció. Ingresa tu PIN para continuar.',
  OPERATION_CONFLICT: 'Esta solicitud cambió. Revisa los datos e intenta de nuevo.',
  ORIGIN_FORBIDDEN: 'Abre el enlace oficial de POS México para entrar.',
  METHOD_NOT_ALLOWED: 'No pudimos completar la solicitud. Intenta de nuevo.',
  PAYLOAD_TOO_LARGE: 'Revisa los datos e intenta de nuevo.',
  SERVER_ERROR: 'No pudimos completar la solicitud. Intenta de nuevo.',
}

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

  return sendRequest(request, accessToken)
}

/** Device credentials are independently checked by the server; no owner identity is forwarded. */
export async function deviceRequest<A extends Extract<AccountRequest, { action: `device_${string}` }>['action']>(
  request: Extract<AccountRequest, { action: A }>,
): Promise<AccountResponses[A]> {
  if (!supabase) throw new AccountClientError('SERVER_ERROR', 'La aplicación aún no está configurada.')
  return sendRequest(request)
}

async function sendRequest<A extends AccountRequest['action']>(
  request: Extract<AccountRequest, { action: A }>, accessToken?: string,
): Promise<AccountResponses[A]> {
  let response: Response
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
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
    throw new AccountClientError(envelope.error.code, messages[envelope.error.code] ?? envelope.error.message, envelope.error.retryAfterSeconds)
  }
  if (!response.ok || !('data' in envelope)) {
    throw new AccountClientError('SERVER_ERROR', 'No pudimos completar la solicitud. Intenta de nuevo.')
  }
  return envelope.data
}
