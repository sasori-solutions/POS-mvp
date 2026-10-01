export type BusinessType = 'cafe' | 'restaurant' | 'other'

/** The only business data available before a successful PIN unlock. */
export interface BusinessSummary {
  id: string
  name: string
  businessType: BusinessType
}

export interface BusinessContext extends BusinessSummary {
  timezone: string
  currency: 'MXN'
  role: 'owner'
  createdAt: string
}

/** Keep operatorToken in memory; never persist it in browser storage. */
export interface OperatorSession {
  business: BusinessContext
  operatorToken: string
  expiresAt: string
}

export interface AccountContext {
  business: BusinessContext
  expiresAt: string
}

export type AccountRequest =
  | { action: 'status' }
  | {
      action: 'create_business'
      name: string
      businessType: BusinessType
      timezone: string
      operationId: string
      pin: string
    }
  | { action: 'unlock'; businessId: string; pin: string }
  | { action: 'context'; businessId: string; operatorToken: string }
  | { action: 'lock'; businessId: string; operatorToken: string }
  | { action: 'revoke_sessions' }

export interface AccountResponses {
  status: { businesses: BusinessSummary[] }
  create_business: OperatorSession
  unlock: OperatorSession
  context: AccountContext
  lock: { locked: true }
  revoke_sessions: { revoked: true }
}

export type AccountErrorCode =
  | 'AUTH_REQUIRED'
  | 'GOOGLE_REQUIRED'
  | 'VALIDATION_ERROR'
  | 'BUSINESS_ACCESS_DENIED'
  | 'PIN_INVALID'
  | 'PIN_LOCKED'
  | 'SESSION_INVALID'
  | 'SESSION_EXPIRED'
  | 'OPERATION_CONFLICT'
  | 'ORIGIN_FORBIDDEN'
  | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'SERVER_ERROR'

export interface AccountError {
  code: AccountErrorCode
  message: string
  retryAfterSeconds?: number
}

export type AccountEnvelope<T> = { data: T } | { error: AccountError }
