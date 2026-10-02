import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import type { AccountError, AccountErrorCode, AccountRequest } from '../../../src/lib/contracts.ts'
import { isUuid, parseAccountRequest, RequestValidationError } from './validation.ts'
import { claimsFromVerifiedJwt, verifiedGoogleAuthentication } from './authentication.ts'

const maxBodyBytes = 8192
const errorDefinitions: Record<AccountErrorCode, { status: number; message: string }> = {
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
  DEVICE_REVOKED: { status: 403, message: 'This device is no longer authorized.' },
  REAUTH_REQUIRED: { status: 401, message: 'Sign in again with Google before changing the PIN.' },
  EMPLOYEE_INACTIVE: { status: 403, message: 'This employee is unavailable.' },
  PIN_SETUP_INVALID: { status: 400, message: 'The PIN setup code is unavailable or expired.' },
  PIN_SETUP_ACCOUNT_MISMATCH: { status: 403, message: 'Sign in as the employee assigned to this PIN setup code.' },
  RECOVERY_INVALID: { status: 401, message: 'The recovery code is invalid or unavailable.' },
  RECOVERY_LOCKED: { status: 429, message: 'Too many recovery attempts. Try again later.' },
  RECOVERY_UNAVAILABLE: { status: 409, message: 'An owner recovery code has not been prepared.' },
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
    case 'pos':
      return { name: 'pos_execute', args: { p_business_id: request.businessId, p_operator_token: request.operatorToken, p_payload: request } }
    case 'device_pos':
      return { name: 'pos_device', args: { p_device_token: request.deviceToken, p_operator_token: request.operatorToken, p_payload: request } }
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
    const action = parseAccountRequest(await boundedJson(request))
    const deviceAction = action.action.startsWith('device_')
    const authorization = request.headers.get('authorization')
    const jwt = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i)?.[1]
    if (!deviceAction && (!jwt || jwt.length > 16384)) return errorResponse('AUTH_REQUIRED', headers)
    const url = Deno.env.get('SUPABASE_URL')
    const key = serverKey()
    if (!url || !key) return errorResponse('SERVER_ERROR', headers)
    const admin = createClient(url, key, { auth: {
      persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
    } })
    const rpc = rpcFor(action)
    let identityArgs: Record<string, string> = {}
    if (!deviceAction) {
      // An API key or caller-supplied user ID never establishes identity.
      const { data: authData, error: authError } = await admin.auth.getUser(jwt!)
      if (authError || !authData.user || authData.user.is_anonymous) return errorResponse('AUTH_REQUIRED', headers)
      const claims = claimsFromVerifiedJwt(jwt!)
      if (!claims || !isUuid(claims.session_id)) return errorResponse('AUTH_REQUIRED', headers)
      const authSessionId = claims.session_id
      const testOnlyPassword = localPasswordTesting(url)
      if (!testOnlyPassword && !verifiedGoogleAuthentication(authData.user, claims)) return errorResponse('GOOGLE_REQUIRED', headers)
      if (action.action === 'reset_pin' && !testOnlyPassword
        && !verifiedGoogleAuthentication(authData.user, claims, Date.now() / 1000)) return errorResponse('REAUTH_REQUIRED', headers)

      identityArgs = { p_user_id: authData.user.id, p_auth_session_id: authSessionId }
    }
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
    return new Response(JSON.stringify(data), { status: 200, headers })
  } catch (error) {
    if (error instanceof RequestValidationError) return errorResponse('VALIDATION_ERROR', headers)
    if (error instanceof BodyTooLargeError) return errorResponse('PAYLOAD_TOO_LARGE', headers)
    console.error(JSON.stringify({ event: 'account_request_failed', code: 'SERVER_ERROR' }))
    return errorResponse('SERVER_ERROR', headers)
  }
})
