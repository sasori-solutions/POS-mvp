import type { PosCommand, PosResponses, PosErrorCode } from './pos-contracts'

export type BusinessType = 'cafe' | 'restaurant' | 'other'
export type BusinessRole = 'owner' | 'manager' | 'cashier' | 'kitchen'
export type EmployeeRole = Exclude<BusinessRole, 'owner'>
export type PaymentMethod = 'cash' | 'card_external' | 'transfer'

/** Progressive setup: fiscal and bank credentials never belong in this profile. */
export interface BusinessProfile {
  branchName: string
  registerName: string
  address: string
  city: string
  state: string
  contactPhone: string
  paymentMethods: PaymentMethod[]
}

/** The only business data available before a successful PIN unlock. */
export interface BusinessSummary {
  id: string
  name: string
  businessType: BusinessType
  canRecoverPin?: boolean
  recoveryReady?: boolean
}

export interface PinSetupAuthorization {
  setupCode: string
  setupId: string
  expiresAt: string
}
export interface EmployeePinSetupDetails {
  business: BusinessSummary
  employee: EmployeeSummary
  expiresAt?: string
}
export interface InvitationDetails extends EmployeePinSetupDetails { expiresAt: string }

export interface EmployeeSummary {
  id: string
  name: string
  role: BusinessRole
  active: boolean
  googleLinked?: boolean
  pinReady?: boolean
  deletedAt?: string | null
}
export interface EmployeeCreation extends EmployeeSummary {
  invitation?: { invitationCode: string; invitationId: string; expiresAt: string }
  pinSetup?: PinSetupAuthorization
}
export interface InvitationSummary {
  employeeId?: string
  id: string
  name: string
  role: EmployeeRole
  expiresAt: string
  active: boolean
  status: 'pending' | 'accepted' | 'revoked' | 'expired' | 'unavailable'
  acceptedAt: string | null
  revokedAt: string | null
  revokeReason: 'user_cancelled' | 'replaced' | 'employee_deleted' | 'employee_deactivated' | 'employee_linked' | null
}
export interface DeviceSummary {
  id: string
  name: string
  registerName: string
  active: boolean
}
export interface BusinessContext extends BusinessSummary {
  timezone: string
  currency: 'MXN'
  role: BusinessRole
  createdAt: string
  /** Owner-only details; blank projection for employees. */
  profile: BusinessProfile
  employee?: { id: string; name: string; role: BusinessRole }
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
export interface TeamContext {
  employees: EmployeeSummary[]
  deletedEmployees?: EmployeeSummary[]
  invitations: InvitationSummary[]
  devices: DeviceSummary[]
}
export interface DeviceStatus {
  business: BusinessSummary
  employees: EmployeeSummary[]
  registerName: string
}
export interface PairedDevice {
  deviceId: string
  /** Restricted device credential; does not replace a PIN operator session. */
  deviceToken: string
  business: BusinessSummary
  registerName: string
}

type OwnerRequest = { businessId: string; operatorToken: string }
export type AccountRequest =
  | ({ action: 'pos' } & OwnerRequest & PosCommand)
  | ({ action: 'device_pos'; deviceToken: string; operatorToken: string } & PosCommand)
  | { action: 'status' }
  | { action: 'create_business'; name: string; businessType: BusinessType; timezone: string; operationId: string; pin: string; profile?: BusinessProfile }
  | ({ action: 'update_business'; name: string; businessType: BusinessType; timezone: string; profile: BusinessProfile } & OwnerRequest)
  | { action: 'unlock'; businessId: string; pin: string }
  | ({ action: 'context' } & OwnerRequest)
  | ({ action: 'lock' } & OwnerRequest)
  | { action: 'revoke_sessions' }
  | ({ action: 'team' } & OwnerRequest)
  | ({ action: 'create_employee'; name: string; role: EmployeeRole; pin: null; inviteWithGoogle?: boolean; operationId: string } & OwnerRequest)
  | ({ action: 'update_employee'; employeeId: string; name: string; role: EmployeeRole; active: boolean; pin: null } & OwnerRequest)
  | ({ action: 'create_pin_setup'; employeeId: string; operationId: string } & OwnerRequest)
  | { action: 'employee_pin_setup_details'; setupCode: string }
  | { action: 'set_employee_pin'; setupCode: string; pin: string; operationId: string }
  | ({ action: 'delete_employee' | 'restore_employee'; employeeId: string; operationId: string } & OwnerRequest)
  | ({ action: 'create_invitation'; operationId: string } & OwnerRequest & ({ employeeId: string } | { name: string; role: EmployeeRole }))
  | ({ action: 'revoke_invitation'; invitationId: string } & OwnerRequest)
  | { action: 'invitation_details'; invitationCode: string }
  | { action: 'accept_invitation'; invitationCode: string; name?: string; pin: string; operationId: string }
  | ({ action: 'create_pairing_code'; operationId: string } & OwnerRequest)
  | ({ action: 'revoke_device'; deviceId: string } & OwnerRequest)
  | ({ action: 'create_recovery_code'; currentPin: string; operationId: string } & OwnerRequest)
  | ({ action: 'change_pin'; currentPin: string; pin: string; operationId: string } & OwnerRequest)
  | { action: 'reset_pin'; businessId: string; recoveryCode: string; pin: string; operationId: string }
  | { action: 'device_pair'; pairingCode: string; deviceName: string; operationId: string }
  | { action: 'device_status'; deviceToken: string }
  | { action: 'device_forget'; deviceToken: string }
  | { action: 'device_unlock'; deviceToken: string; employeeId: string; pin: string }
  | { action: 'device_pin_setup_details'; deviceToken: string; setupCode: string }
  | { action: 'device_set_employee_pin'; deviceToken: string; setupCode: string; pin: string; operationId: string }
  | { action: 'device_context'; deviceToken: string; operatorToken: string }
  | { action: 'device_lock'; deviceToken: string; operatorToken: string }

export interface AccountResponses {
  pos: PosResponses[keyof PosResponses]
  device_pos: PosResponses[keyof PosResponses]
  status: { businesses: BusinessSummary[] }
  create_business: OperatorSession
  update_business: BusinessContext
  unlock: OperatorSession
  context: AccountContext
  lock: { locked: true }
  revoke_sessions: { revoked: true }
  team: TeamContext
  create_employee: EmployeeCreation
  update_employee: EmployeeSummary
  create_pin_setup: PinSetupAuthorization
  employee_pin_setup_details: EmployeePinSetupDetails
  set_employee_pin: OperatorSession
  delete_employee: { id: string; deleted: true }
  restore_employee: EmployeeSummary
  create_invitation: { invitationCode: string; invitationId: string; expiresAt: string }
  revoke_invitation: { revoked: true }
  invitation_details: InvitationDetails
  accept_invitation: OperatorSession
  create_pairing_code: { pairingCode: string; expiresAt: string }
  revoke_device: { revoked: true }
  create_recovery_code: { recoveryCode: string }
  change_pin: OperatorSession
  reset_pin: OperatorSession & { recoveryCode: string }
  device_pair: PairedDevice
  device_status: DeviceStatus
  device_unlock: OperatorSession
  device_pin_setup_details: EmployeePinSetupDetails
  device_set_employee_pin: OperatorSession
  device_context: AccountContext
  device_lock: { locked: true }
  device_forget: { revoked: true }
}
export type AccountErrorCode =
  | PosErrorCode
  | 'AUTH_REQUIRED' | 'GOOGLE_REQUIRED' | 'VALIDATION_ERROR' | 'BUSINESS_ACCESS_DENIED'
  | 'PERMISSION_DENIED' | 'INVITATION_INVALID' | 'PAIRING_INVALID' | 'DEVICE_REVOKED'
  | 'REAUTH_REQUIRED' | 'EMPLOYEE_INACTIVE' | 'PIN_INVALID' | 'PIN_LOCKED'
  | 'PIN_SETUP_INVALID' | 'PIN_SETUP_ACCOUNT_MISMATCH' | 'RECOVERY_INVALID' | 'RECOVERY_LOCKED' | 'RECOVERY_UNAVAILABLE'
  | 'SESSION_INVALID' | 'SESSION_EXPIRED' | 'OPERATION_CONFLICT' | 'ORIGIN_FORBIDDEN'
  | 'METHOD_NOT_ALLOWED' | 'PAYLOAD_TOO_LARGE' | 'SERVER_ERROR'
export interface AccountError { code: AccountErrorCode; message: string; retryAfterSeconds?: number }
export type AccountEnvelope<T> = { data: T } | { error: AccountError }
