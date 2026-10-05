import { signEmployeeDeviceRequest } from './employee-device'
import type { AccountEnvelope, AccountErrorCode, AccountRequest, AccountResponses } from './contracts'
import { supabase, supabasePublishableKey, supabaseUrl } from './supabase'

export const accountErrorMessages: Record<AccountErrorCode, string> = {
  POINT_DISABLED: 'El cobro integrado está desactivado para este negocio.',
  POINT_CONNECTION_REQUIRED: 'Conecta y verifica Mercado Pago antes de cobrar.',
  POINT_TERMINAL_NOT_READY: 'Verifica la caja y el modo PDV de esta terminal.',
  POINT_TERMINAL_BUSY: 'La terminal tiene otra operación pendiente. Revisa su resultado.',
  POINT_CHECKOUT_NOT_FOUND: 'No encontramos este cobro integrado.',
  POINT_RESULT_UNCERTAIN: 'Estamos verificando el cobro. Conserva este intento sin cobrar de nuevo.',
  POINT_STATE_INVALID: 'Revisa el estado actual antes de continuar.',
  POINT_AMOUNT_INVALID: 'El importe está fuera del rango admitido por esta terminal.',
  POINT_FACT_MISMATCH: 'Los datos del proveedor requieren revisión. No confirmamos este cobro.',
  POINT_REFUND_LIMIT: 'El importe supera el saldo disponible para devolución.',
  POINT_REFUND_ALLOCATION_REQUIRED: 'Indica la mercancía y propina de la devolución con su evidencia.',
  POINT_ADMIN_DENIED: 'No tienes acceso a la administración de SASORI.',
  POINT_PERIOD_CLOSED: 'El periodo está cerrado. Los ajustes se registran en el siguiente periodo.',
  POINT_LEASE_LOST: 'La conciliación está en proceso. Revisa el estado actualizado.',
  POINT_OAUTH_INVALID: 'La autorización venció o ya se utilizó. Inicia la conexión nuevamente.',
  POINT_CONFIGURATION_REQUIRED: 'Falta configurar la aplicación de Mercado Pago para este entorno.',
  POINT_SERVICE_UNAVAILABLE: 'El proveedor no pudo confirmar el resultado. Conserva el intento para revisión.',
  POINT_REFRESH_BUSY: 'Estamos renovando la conexión. Espera y vuelve a consultar.',
  POINT_IDEMPOTENCY_WINDOW_EXPIRED: 'La garantía de recuperación venció. Este intento requiere revisión sin cobrar de nuevo.',
  PRODUCT_CHANGED: 'El producto cambió. Revisa la cuenta antes de cobrar.',
  PRODUCT_UNAVAILABLE: 'Un producto ya no está disponible. Revisa los productos de la cuenta.',
  SALE_NOT_FOUND: 'No encontramos esta venta.',
  PAYMENT_METHOD_DISABLED: 'Este método de pago está desactivado. Elige otro método disponible.',
  AUTH_REQUIRED: 'Tu sesión venció. Vuelve a entrar con Google.', GOOGLE_REQUIRED: 'Entra con Google para continuar.',
  VALIDATION_ERROR: 'Revisa los datos e intenta de nuevo.', BUSINESS_ACCESS_DENIED: 'No tienes acceso a este negocio.',
  PERMISSION_DENIED: 'No tienes permiso para esta acción. Solicita ayuda al dueño.',
  OPERATIONS_DISABLED: 'El dueño debe activar la operación con turnos desde Caja.',
  LEGACY_CHECKOUT_DISABLED: 'Esta caja usa el nuevo cobro con turnos. Actualiza la app y revisa los registros pendientes.',
  SHIFT_REQUIRED: 'Abre un turno en Caja antes de cobrar.',
  SHIFT_CHANGED: 'El turno cambió. Revisa la información actual.',
  SHIFT_NOT_OPEN: 'La caja está en cierre. Reanuda el turno antes de mover dinero.',
  SHIFT_ALREADY_OPEN: 'Ya hay un turno abierto en este negocio.',
  PENDING_COLLECTION: 'Resuelve los cobros o devoluciones pendientes antes de cerrar.',
  ORDER_CHANGED: 'La cuenta cambió en otro dispositivo. Revisa la versión actual.',
  ORDER_NOT_FOUND: 'No encontramos esta cuenta.',
  ORDER_LOCKED: 'La cuenta tiene un cobro pendiente o pagado. Revisa sus saldos.',
  ORDER_HAS_PAYMENTS: 'Esta cuenta tiene pagos. Conserva las ventas y resuelve el saldo restante.',
  ATTEMPT_NOT_FOUND: 'No encontramos este cobro o devolución.',
  ATTEMPT_CHANGED: 'Este cobro cambió. Revisa el estado actual.',
  ATTEMPT_STATE_INVALID: 'Revisa el estado del cobro antes de continuar.',
  TABLE_CHANGED: 'La mesa cambió. Revisa la lista actual.',
  TABLE_OCCUPIED: 'Esta mesa ya tiene una cuenta abierta.',
  BATCH_CHANGED: 'La comanda cambió en otro dispositivo. Revisa la cola actual.',
  WAIVER_CHANGED: 'La condonación cambió. Revisa el saldo actual.',
  SALE_ALREADY_REVERSED: 'Esta venta ya tiene una devolución registrada.',
  INVITATION_INVALID: 'La invitación venció, fue revocada o ya no es válida. Pide una nueva al dueño.',
  PAIRING_INVALID: 'El código de conexión venció o ya no es válido. Pide uno nuevo al dueño.',
  DEVICE_LINK_REQUIRED: 'Usa tu acceso personal con Google desde Entrar como empleado. Permite el almacenamiento del navegador para vincularlo.',
  DEVICE_APPROVAL_REQUIRED: 'Este dispositivo no está autorizado. Revisa la solicitud con el dueño. Si fue rechazada, espera 10 minutos antes de intentar de nuevo.',
  DEVICE_PROOF_INVALID: 'No pudimos verificar este dispositivo. Revisa la fecha y hora del equipo.',
  DEVICE_REVOKED: 'Este dispositivo fue revocado. Vuelve a conectarlo con el dueño.',
  EMPLOYEE_INACTIVE: 'Tu acceso fue desactivado. Contacta al dueño.',
  REAUTH_REQUIRED: 'Vuelve a verificar tu cuenta con Google para cambiar el PIN.',
  PIN_INVALID: 'PIN incorrecto. Intenta de nuevo.', PIN_LOCKED: 'Demasiados intentos. Espera antes de volver a ingresar tu PIN.',
  PIN_SETUP_INVALID: 'El código de PIN venció o ya no está disponible. Pide uno nuevo al dueño.',
  PIN_SETUP_ACCOUNT_MISMATCH: 'Entra con la cuenta Google del empleado a quien pertenece este código.',
  RECOVERY_INVALID: 'El enlace venció o ya fue utilizado. Solicita uno nuevo.',
  RECOVERY_LOCKED: 'Demasiados intentos de recuperación. Espera antes de volver a intentar.',
  RECOVERY_UNAVAILABLE: 'Esta persona aún no tiene un correo vinculado. Pide al dueño que vincule su cuenta desde Empleados.',
  EMAIL_UNAVAILABLE: 'No pudimos enviar el correo. Intenta de nuevo más tarde.',
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

  let deviceProof
  try { deviceProof = await signEmployeeDeviceRequest(request) }
  catch {
    // Owners remain able to sign in when persistent storage is unavailable.
    // The server rejects all employee access without a verified device proof.
  }
  return sendRequest<A>({ ...request, ...(deviceProof ? { deviceProof } : {}) } as Extract<AccountRequest, { action: A }>, accessToken)
}

/** Device credentials are independently checked by the server; no owner identity is forwarded. */
export async function deviceRequest<A extends Extract<AccountRequest, { action: `device_${string}` }>['action']>(
  request: Extract<AccountRequest, { action: A }>,
): Promise<AccountResponses[A]> {
  if (!supabase) throw new AccountClientError('SERVER_ERROR', 'La aplicación aún no está configurada.')
  return sendRequest(request)
}

/** An email link authorizes only this PIN reset, without an identity or operator session. */
export async function recoveryRequest<A extends 'pin_email_details' | 'confirm_pin_email'>(
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
    throw new AccountClientError(envelope.error.code, accountErrorMessages[envelope.error.code] ?? envelope.error.message, envelope.error.retryAfterSeconds)
  }
  if (!response.ok || !('data' in envelope)) {
    throw new AccountClientError('SERVER_ERROR', 'No pudimos completar la solicitud. Intenta de nuevo.')
  }
  return envelope.data
}
