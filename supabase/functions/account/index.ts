import { DeviceProofError, verifiedDeviceRequest } from './device-proof.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import type { AccountError, AccountErrorCode, AccountRequest } from '../../../src/lib/contracts.ts'
import { isUuid, parseAccountRequest, RequestValidationError } from './validation.ts'
import { mailConfiguration, sendPinRecovery } from './email.ts'
import { claimsFromVerifiedJwt, verifiedGoogleAuthentication } from './authentication.ts'
import { processPointResult } from '../point/service.ts'

const maxBodyBytes = 8192
const errorDefinitions: Record<AccountErrorCode, { status: number; message: string }> = {
  POINT_DISABLED: { status: 409, message: 'Integrated collections are disabled.' },
  POINT_CONNECTION_REQUIRED: { status: 409, message: 'Verify a provider connection first.' },
  POINT_TERMINAL_NOT_READY: { status: 409, message: 'The terminal configuration is unverified.' },
  POINT_TERMINAL_BUSY: { status: 409, message: 'The terminal has an unresolved operation.' },
  POINT_CHECKOUT_NOT_FOUND: { status: 404, message: 'The integrated checkout is unavailable.' },
  POINT_RESULT_UNCERTAIN: { status: 409, message: 'The original payment still requires reconciliation.' },
  POINT_STATE_INVALID: { status: 409, message: 'The payment transition is unavailable.' },
  POINT_AMOUNT_INVALID: { status: 422, message: 'The amount is outside the terminal range.' },
  POINT_FACT_MISMATCH: { status: 409, message: 'The provider evidence requires review.' },
  POINT_REFUND_LIMIT: { status: 409, message: 'The refund exceeds the available balance.' },
  POINT_REFUND_ALLOCATION_REQUIRED: { status: 409, message: 'The refund allocation requires evidence.' },
  POINT_ADMIN_DENIED: { status: 403, message: 'Independent administrative authorization is required.' },
  POINT_PERIOD_CLOSED: { status: 409, message: 'The financial period is closed.' },
  POINT_LEASE_LOST: { status: 409, message: 'The worker lease is unavailable.' },
  POINT_OAUTH_INVALID: { status: 400, message: 'The provider authorization is unavailable or expired.' },
  POINT_CONFIGURATION_REQUIRED: { status: 503, message: 'The integration requires server configuration.' },
  POINT_SERVICE_UNAVAILABLE: { status: 503, message: 'The provider result remains unconfirmed.' },
  POINT_REFRESH_BUSY: { status: 409, message: 'Provider credentials are being refreshed.' },
  POINT_IDEMPOTENCY_WINDOW_EXPIRED: { status: 409, message: 'The payment requires review outside the recovery guarantee.' },
  OPERATIONS_DISABLED: { status: 409, message: 'The owner must activate operations first.' },
  LEGACY_CHECKOUT_DISABLED: { status: 409, message: 'Use the operational checkout after activation.' },
  SHIFT_REQUIRED: { status: 409, message: 'Open a cash shift to continue.' },
  SHIFT_CHANGED: { status: 409, message: 'The cash shift changed. Refresh and retry.' },
  SHIFT_NOT_OPEN: { status: 409, message: 'The cash shift is not open for collections.' },
  SHIFT_ALREADY_OPEN: { status: 409, message: 'A cash shift is already active.' },
  PENDING_COLLECTION: { status: 409, message: 'Resolve pending collections first.' },
  ORDER_CHANGED: { status: 409, message: 'The order changed. Review its current contents.' },
  ORDER_NOT_FOUND: { status: 404, message: 'The order is unavailable.' },
  ORDER_LOCKED: { status: 409, message: 'The order is frozen for checkout.' },
  ORDER_HAS_PAYMENTS: { status: 409, message: 'The order has recorded payments.' },
  ATTEMPT_NOT_FOUND: { status: 404, message: 'The checkout attempt is unavailable.' },
  ATTEMPT_CHANGED: { status: 409, message: 'The checkout attempt changed. Refresh and retry.' },
  ATTEMPT_STATE_INVALID: { status: 409, message: 'The checkout transition is unavailable.' },
  TABLE_CHANGED: { status: 409, message: 'The table changed. Refresh and retry.' },
  TABLE_OCCUPIED: { status: 409, message: 'The table already has an occupied account.' },
  BATCH_CHANGED: { status: 409, message: 'The kitchen batch changed. Refresh and retry.' },
  WAIVER_CHANGED: { status: 409, message: 'The prepared balance changed. Prepare it again.' },
  SALE_ALREADY_REVERSED: { status: 409, message: 'The sale already has a reversal.' },
  PRODUCT_CHANGED: { status: 409, message: 'The product changed. Review current catalog.' },
  PRODUCT_UNAVAILABLE: { status: 409, message: 'The product is unavailable.' },
  SALE_NOT_FOUND: { status: 404, message: 'The sale is unavailable.' },
  PAYMENT_METHOD_DISABLED: { status: 409, message: 'The payment method is disabled.' },
  AUTH_REQUIRED: { status: 401, message: 'Sign in to continue.' },
  GOOGLE_REQUIRED: { status: 403, message: 'Sign in with Google to continue.' },
  VALIDATION_ERROR: { status: 400, message: 'The request is invalid.' },
  BUSINESS_ACCESS_DENIED: { status: 403, message: 'This business is not available to this account.' },
  PIN_INVALID: { status: 401, message: 'The PIN is incorrect.' },
  PIN_LOCKED: { status: 429, message: 'Too many PIN attempts. Try again later.' },
  SESSION_INVALID: { status: 401, message: 'Unlock the business to continue.' },
  SESSION_EXPIRED: { status: 401, message: 'The PIN session expired. Unlock the business again.' },
  OPERATION_CONFLICT: { status: 409, message: 'The operation was already used with different details.' },
  ORIGIN_FORBIDDEN: { status: 403, message: 'This application origin is not allowed.' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Use POST for this endpoint.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'The request is too large.' },
  PERMISSION_DENIED: { status: 403, message: 'Only the owner can manage this business.' },
  INVITATION_INVALID: { status: 400, message: 'The invitation is unavailable or expired.' },
  PAIRING_INVALID: { status: 400, message: 'The pairing code is unavailable or expired.' },
  DEVICE_LINK_REQUIRED: { status: 403, message: 'Use the employee personal login and link this browser.' },
  DEVICE_APPROVAL_REQUIRED: { status: 403, message: 'This device is not authorized. Ask the owner to review device notifications. Rejected requests can be retried after ten minutes.' },
  DEVICE_PROOF_INVALID: { status: 403, message: 'The device verification expired or is invalid. Try again.' },
  DEVICE_REVOKED: { status: 403, message: 'This device is no longer authorized.' },
  REAUTH_REQUIRED: { status: 401, message: 'Sign in again with Google before changing the PIN.' },
  EMPLOYEE_INACTIVE: { status: 403, message: 'This employee is unavailable.' },
  PIN_SETUP_INVALID: { status: 400, message: 'The PIN setup code is unavailable or expired.' },
  PIN_SETUP_ACCOUNT_MISMATCH: { status: 403, message: 'Sign in as the employee assigned to this PIN setup code.' },
  RECOVERY_INVALID: { status: 401, message: 'The recovery link is invalid or unavailable.' },
  RECOVERY_LOCKED: { status: 429, message: 'Too many recovery attempts. Try again later.' },
  RECOVERY_UNAVAILABLE: { status: 409, message: 'Email recovery is not available for this account.' },
  EMAIL_UNAVAILABLE: { status: 503, message: 'The recovery email could not be sent.' },
  SERVER_ERROR: { status: 500, message: 'The request could not be completed. Try again.' },
}

function serverKey(): string | undefined {
  const direct = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')
  if (direct) return direct
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    return typeof keys.default === 'string' ? keys.default : undefined
  } catch {
    return undefined
  }
}

function configuredOrigins(): Set<string> {
  const origins = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  for (const origin of origins) {
    const url = new URL(origin)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.origin !== origin || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
      throw new Error('Invalid origin configuration')
    }
  }
  if (origins.length === 0) throw new Error('Missing origin configuration')
  return new Set(origins)
}

function responseHeaders(origin: string | null): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
  })
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info')
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    headers.set('Access-Control-Max-Age', '600')
  }
  return headers
}

function errorResponse(code: AccountErrorCode, headers: Headers, retryAfterSeconds?: number): Response {
  const definition = errorDefinitions[code]
  const error: AccountError = { code, message: definition.message }
  if ((code === 'PIN_LOCKED' || code === 'RECOVERY_LOCKED') && retryAfterSeconds && Number.isFinite(retryAfterSeconds)) {
    error.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds))
    headers.set('Retry-After', String(error.retryAfterSeconds))
  }
  if (code === 'METHOD_NOT_ALLOWED') headers.set('Allow', 'POST, OPTIONS')
  return new Response(JSON.stringify({ error }), { status: definition.status, headers })
}

class BodyTooLargeError extends Error {}

async function boundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxBodyBytes) throw new BodyTooLargeError()
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new RequestValidationError()
  if (!request.body) throw new RequestValidationError()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maxBodyBytes) {
        await reader.cancel()
        throw new BodyTooLargeError()
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new RequestValidationError()
  }
}

function localPasswordTesting(url: string): boolean {
  const hostname = new URL(url).hostname
  return Deno.env.get('ALLOW_TEST_PASSWORD_AUTH') === 'true'
    && ['localhost', '127.0.0.1', '[::1]', 'kong', 'host.docker.internal'].includes(hostname)
}

function rpcFor(request: AccountRequest): { name: string; args: Record<string, unknown> } {
  switch (request.action) {
    case 'device_point':
      return { name: 'point_device', args: { p_device_token: request.deviceToken, p_operator_token: request.operatorToken, p_payload: request } }
    case 'device_pos':
      return { name: 'pos_device', args: { p_device_token: request.deviceToken, p_operator_token: request.operatorToken, p_payload: request } }
    case 'device_request_pin_email':
      return { name: 'account_device_request_pin_email', args: { p_device_token: request.deviceToken, p_employee_id: request.employeeId } }
    case 'request_pin_email':
      return { name: 'account_request_pin_email', args: { p_business_id: request.businessId } }
    case 'pin_email_details': case 'confirm_pin_email':
      return { name: 'account_confirm_pin_email', args: { p_action: request.action, p_payload: request } }
    case 'status':
      return { name: 'account_status', args: {} }
    case 'create_business':
      return { name: 'account_create_business', args: {
        p_name: request.name, p_business_type: request.businessType, p_timezone: request.timezone,
        p_operation_id: request.operationId, p_pin: request.pin, p_profile: request.profile ?? null,
      } }
    case 'unlock':
      return { name: 'account_unlock', args: { p_business_id: request.businessId, p_pin: request.pin } }
    case 'context':
    case 'lock':
      return { name: `account_${request.action}`, args: { p_business_id: request.businessId, p_operator_token: request.operatorToken } }
    case 'revoke_sessions':
      return { name: 'account_revoke_sessions', args: {} }
    case 'device_pair': case 'device_status': case 'device_unlock': case 'device_context': case 'device_lock': case 'device_forget': case 'device_pin_setup_details': case 'device_set_employee_pin':
      return { name: 'account_device', args: { p_action: request.action, p_payload: request } }
    default:
      return { name: 'account_manage', args: { p_action: request.action, p_payload: request } }
  }
}

Deno.serve(async (request: Request) => {
  let headers = responseHeaders(null)
  try {
    const allowedOrigins = configuredOrigins()
    const origin = request.headers.get('origin')
    if (origin && !allowedOrigins.has(origin)) return errorResponse('ORIGIN_FORBIDDEN', headers)
    headers = responseHeaders(origin)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', headers)

    // Restricted device commands validate their own credential in SQL; the public API key grants no tenant access.
    const verifiedDevice = await verifiedDeviceRequest(await boundedJson(request))
    const action = parseAccountRequest(verifiedDevice.request)
    if ((action.action === 'point' || action.action === 'device_point') && action.command === 'start' && Deno.env.get('POINT_CHARGES_ENABLED') !== 'true') return errorResponse('POINT_DISABLED', headers)
    const deviceAction = action.action.startsWith('device_')
    const emailConfirmation = action.action === 'pin_email_details' || action.action === 'confirm_pin_email'
    const publicCredentialAction = deviceAction || emailConfirmation
    const authorization = request.headers.get('authorization')
    const jwt = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i)?.[1]
    if (!publicCredentialAction && (!jwt || jwt.length > 16384)) return errorResponse('AUTH_REQUIRED', headers)
    const url = Deno.env.get('SUPABASE_URL')
    const key = serverKey()
    if (!url || !key) return errorResponse('SERVER_ERROR', headers)
    const admin = createClient(url, key, { auth: {
      persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    } })
    const rpc = publicCredentialAction ? rpcFor(action) : { name: 'account_secure', args: {
      p_action: action.action, p_payload: action, p_device_key_hash: verifiedDevice.keyHash, p_proof_nonce: verifiedDevice.nonce,
    } }
    let identityArgs: Record<string, string> = {}
    if (!publicCredentialAction) {
      // An API key or caller-supplied user ID never establishes identity.
      const { data: authData, error: authError } = await admin.auth.getUser(jwt!)
      if (authError || !authData.user || authData.user.is_anonymous) return errorResponse('AUTH_REQUIRED', headers)
      const claims = claimsFromVerifiedJwt(jwt!)
      if (!claims || !isUuid(claims.session_id)) return errorResponse('AUTH_REQUIRED', headers)
      const authSessionId = claims.session_id
      const testOnlyPassword = localPasswordTesting(url)
      if (!testOnlyPassword && !verifiedGoogleAuthentication(authData.user, claims)) return errorResponse('GOOGLE_REQUIRED', headers)

      identityArgs = { p_user_id: authData.user.id, p_auth_session_id: authSessionId }
    }
    const requestingEmail = action.action === 'request_pin_email' || action.action === 'device_request_pin_email'
    const emailConfig = requestingEmail ? mailConfiguration(name => Deno.env.get(name)) : null
    if (requestingEmail && !emailConfig) return errorResponse('EMAIL_UNAVAILABLE', headers)
    const { data, error } = await admin.rpc(rpc.name, {
      ...rpc.args, ...identityArgs,
    })
    if (error) {
      const code = Object.hasOwn(errorDefinitions, error.message) ? error.message as AccountErrorCode : 'SERVER_ERROR'
      // Never log RPC arguments, PINs, JWTs, tokens, raw database errors, or user identities.
      if (code === 'SERVER_ERROR') console.error(JSON.stringify({ event: 'account_rpc_failed', action: action.action, code: error.code }))
      return errorResponse(code, headers)
    }
    if (!data || typeof data !== 'object') return errorResponse('SERVER_ERROR', headers)
    if (data.error) {
      const code = Object.hasOwn(errorDefinitions, data.error.code) ? data.error.code as AccountErrorCode : 'SERVER_ERROR'
      return errorResponse(code, headers, data.error.retryAfterSeconds)
    }
    if (!Object.hasOwn(data, 'data')) return errorResponse('SERVER_ERROR', headers)
    if (requestingEmail) {
      const sent = await sendPinRecovery(data.data, emailConfig!)
      const delivery = await admin.rpc('account_pin_email_delivery', { p_id: data.data.id, p_delivered: sent })
      if (!sent || delivery.error) return errorResponse('EMAIL_UNAVAILABLE', headers)
      return new Response(JSON.stringify({ data: { sent: true, retryAfterSeconds: 60 } }), { status: 200, headers })
    }
    if (action.action === 'point' || action.action === 'device_point') {
      let result = await processPointResult(admin, action, data.data,
        identityArgs.p_user_id ? { userId: identityArgs.p_user_id, authSessionId: identityArgs.p_auth_session_id } : undefined)
      if (['connect_sandbox','oauth_callback','verify_connection','link_terminal','test_terminal'].includes(action.command)) {
        const refreshed = action.action === 'point'
          ? await admin.rpc('point_execute', { ...identityArgs, p_business_id: action.businessId, p_operator_token: action.operatorToken, p_payload: { command: 'settings' } })
          : await admin.rpc('point_device', { p_device_token: action.deviceToken, p_operator_token: action.operatorToken, p_payload: { command: 'settings' } })
        if (refreshed.error || !refreshed.data?.data) return errorResponse('SERVER_ERROR', headers)
        result = await processPointResult(admin, { ...action, command: 'settings' }, refreshed.data.data)
      }
      return new Response(JSON.stringify({ data: result }), { status: 200, headers })
    }
    return new Response(JSON.stringify(data), { status: 200, headers })
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(errorDefinitions, error.message) && error.message.startsWith('POINT_')) return errorResponse(error.message as AccountErrorCode, headers)
    if (error instanceof DeviceProofError) return errorResponse('DEVICE_PROOF_INVALID', headers)
    if (error instanceof RequestValidationError) return errorResponse('VALIDATION_ERROR', headers)
    if (error instanceof BodyTooLargeError) return errorResponse('PAYLOAD_TOO_LARGE', headers)
    console.error(JSON.stringify({ event: 'account_request_failed', code: 'SERVER_ERROR' }))
    return errorResponse('SERVER_ERROR', headers)
  }
})
